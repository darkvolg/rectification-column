#pragma once
// ============================================================
//  ЖУРНАЛ ПОГОНА ВНУТРИ КОНТРОЛЛЕРА
// ============================================================
// Журнал ведёт то устройство, которое включено весь погон по определению.
// Это контроллер: он же и меряет, без него колонна не работает. Браузер
// закроют, ноут уснёт, сервер есть не у каждого.
//
// Два хранилища, работают вместе:
//
//   microSD  — основное. Переживает перезагрузку и обесточивание,
//              хранит все погоны, карту можно вынуть и вставить в компьютер.
//   кольцо в памяти — подстраховка на 11 часов. Работает, когда карты нет
//              или она отвалилась. Стирается при перезагрузке.
//
// Пишется всегда в оба. Карта появилась посреди погона — в файл сольётся
// и то, что уже накопилось в памяти: терять начало погона нельзя.
//
// Отдаётся по сети готовым CSV для Excel:
//   http://<ip>/log.csv        текущий погон
//   http://<ip>/logs           список файлов на карте
//   http://<ip>/logs/<имя>     любой прошлый погон
//
// РАСПИНОВКА КАРТЫ (модуль microSD-SPI):
//   CS   → GPIO5      MOSI → GPIO13
//   SCK  → GPIO14     MISO → GPIO27
//   VCC  → 5 В (у модулей со стабилизатором) либо 3.3 В
//   GND  → GND
// Пины выбраны из свободных: 4, 16-19, 21-23 заняты датчиками и сиреной.

#include "esphome/core/log.h"
#include "esphome/components/web_server_base/web_server_base.h"
#include <SPI.h>
#include <SD.h>
#include <vector>
#include <memory>
#include <cmath>
#include <cstdio>
#include <ctime>

namespace kolonna_log {

static const char *const TAG = "kolonna_log";

static const int SD_CS = 5, SD_SCK = 14, SD_MOSI = 13, SD_MISO = 27;

// Глубина кольца в памяти. Старое затирается новым: подстраховка — это
// про «последние одиннадцать часов», а не про «первые после перезагрузки».
static const size_t CAP = 2000;
static const uint8_t NCH = 17;

// Значения храним целыми со своей ценой деления на канал — вдвое экономнее
// float, а точности хватает: 0.01 °C при шаге датчика 0.0625 °C.
static const float SCALE[NCH] = {
  100.0f,   // 0  куб, °C
  100.0f,   // 1  температура 2/3, °C
  100.0f,   // 2  температура отбора, °C
  1000.0f,  // 3  ΔT, °C
  10000.0f, // 4  скорость роста 2/3, °C/мин
  10.0f,    // 5  спирт в кубе, %
  1.0f,     // 6  мощность по току, Вт
  1.0f,     // 7  мощность по воде, Вт
  100.0f,   // 8  ток, А
  10.0f,    // 9  напряжение, В
  100.0f,   // 10 проток, л/мин
  10.0f,    // 11 расход воды, л
  100.0f,   // 12 вода выход, °C
  100.0f,   // 13 вода вход, °C
  10.0f,    // 14 давление, мм рт.ст.
  1.0f,     // 15 скорость отбора, мл/ч
  1.0f      // 16 отобрано, мл
};

// BOM в начале — без него русский Excel покажет кракозябры
static const char *const BOM = "\xEF\xBB\xBF";
static const char *const HEAD =
  "Время;Куб T1, °C;Температура 2/3 T2, °C;Температура отбора T3, °C;"
  "ΔT отбор-2/3, °C;Скорость роста 2/3, °C/мин;Спирт в кубе, %;"
  "Мощность по току, Вт;Мощность по воде, Вт;Ток, А;Напряжение, В;"
  "Проток, л/мин;Расход воды, л;Вода выход T4, °C;Вода вход T5, °C;"
  "Давление, мм рт.ст.;Скорость отбора, мл/ч;Отобрано, мл;Аварии\r\n";

// Нет данных — отдельное значение, а не ноль: пропуск в журнале должен
// быть виден, иначе по нему сделают неверный вывод.
static const int16_t NODATA = INT16_MIN;

struct Row {
  uint32_t ts;
  int16_t v[NCH];
  uint16_t alarms;
};

static std::vector<Row> buf;
static size_t head = 0;       // куда писать следующую
static size_t count = 0;      // сколько накоплено в кольце

static bool sd_ok = false;    // карта на месте и пишется
static bool sd_tried = false;
static char fname[48] = "";   // имя файла текущего погона
static uint32_t sd_rows = 0;  // сколько строк ушло на карту

inline void reserve() {
  if (buf.size() < CAP) {
    buf.reserve(CAP);
    buf.resize(CAP);
  }
}

inline size_t rows() { return count; }
inline uint32_t rows_sd() { return sd_rows; }
inline bool card() { return sd_ok; }
inline const char *filename() { return fname; }

// Индекс i-й по времени записи в кольце (0 — самая старая)
inline const Row &at(size_t i) {
  size_t start = (count == CAP) ? head : 0;
  return buf[(start + i) % CAP];
}

// ---------------------------------------------------------------------------
//  Одна строка CSV
// ---------------------------------------------------------------------------
// Разделитель «;» и десятичная запятая: русский Excel открывает такой файл
// двойным щелчком, без мастера импорта.
inline size_t render(const Row &r, char *out, size_t max) {
  size_t n = 0;
  if (r.ts > 0) {
    time_t t = (time_t) r.ts;
    struct tm tmv;
    localtime_r(&t, &tmv);
    n += snprintf(out + n, max - n, "%04d-%02d-%02d %02d:%02d:%02d",
                  tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
                  tmv.tm_hour, tmv.tm_min, tmv.tm_sec);
  } else {
    // Время не синхронизировалось — говорим об этом прямо, а не ставим
    // 1970 год, который потом примут за настоящий.
    n += snprintf(out + n, max - n, "без времени");
  }
  for (uint8_t i = 0; i < NCH && n < max; i++) {
    if (r.v[i] == NODATA) {
      n += snprintf(out + n, max - n, ";");
      continue;
    }
    float f = r.v[i] / SCALE[i];
    int dec = SCALE[i] >= 10000.0f ? 4 : SCALE[i] >= 1000.0f ? 3
            : SCALE[i] >= 100.0f ? 2 : SCALE[i] >= 10.0f ? 1 : 0;
    char tmp[24];
    snprintf(tmp, sizeof(tmp), "%.*f", dec, f);
    for (char *p = tmp; *p; p++)
      if (*p == '.') *p = ',';
    n += snprintf(out + n, max - n, ";%s", tmp);
  }
  n += snprintf(out + n, max - n, ";%u\r\n", (unsigned) r.alarms);
  return n;
}

// ---------------------------------------------------------------------------
//  Карта
// ---------------------------------------------------------------------------
inline bool sd_mount() {
  SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  // 20 МГц: длинные провода до модуля на большей частоте начинают врать
  if (!SD.begin(SD_CS, SPI, 20000000)) {
    ESP_LOGW(TAG, "карта не найдена, пишу только в память");
    return false;
  }
  uint64_t mb = SD.cardSize() / (1024ULL * 1024ULL);
  ESP_LOGI(TAG, "карта на месте, %llu МБ", mb);
  return true;
}

// Файл создаётся, когда стало известно время: имя с датой — это половина
// смысла архива. Пока времени нет, копим только в кольцо и ничего не теряем.
inline void sd_open_file(uint32_t ts) {
  if (!sd_ok || fname[0] || ts == 0) return;
  time_t t = (time_t) ts;
  struct tm tmv;
  localtime_r(&t, &tmv);
  snprintf(fname, sizeof(fname), "/kolonna_%04d-%02d-%02d_%02d-%02d.csv",
           tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
           tmv.tm_hour, tmv.tm_min);

  File f = SD.open(fname, FILE_WRITE);
  if (!f) {
    ESP_LOGE(TAG, "не открыть %s", fname);
    sd_ok = false;
    fname[0] = 0;
    return;
  }
  f.print(BOM);
  f.print(HEAD);

  // Сливаем в файл то, что успело накопиться до появления времени
  // или до того, как воткнули карту. Начало погона — самое ценное.
  char line[256];
  for (size_t i = 0; i < count; i++) {
    size_t n = render(at(i), line, sizeof(line));
    f.write((const uint8_t *) line, n);
    sd_rows++;
  }
  f.close();
  ESP_LOGI(TAG, "журнал: %s, слито из памяти %u строк", fname, (unsigned) sd_rows);
}

inline void sd_append(const Row &r) {
  if (!sd_ok || !fname[0]) return;
  File f = SD.open(fname, FILE_APPEND);
  if (!f) {
    // Карту выдернули посреди погона — не паникуем, кольцо в памяти
    // продолжает писаться, и это видно в диагностике.
    ESP_LOGW(TAG, "запись не удалась, карта потеряна");
    sd_ok = false;
    return;
  }
  char line[256];
  size_t n = render(r, line, sizeof(line));
  f.write((const uint8_t *) line, n);
  f.close();               // закрываем каждый раз: выдернули питание —
  sd_rows++;               // потеряна последняя строка, а не весь файл
}

// ---------------------------------------------------------------------------
//  Приём значений
// ---------------------------------------------------------------------------
inline void push(uint32_t ts, const float *vals, uint16_t alarms) {
  reserve();
  Row &r = buf[head];
  r.ts = ts;
  r.alarms = alarms;
  for (uint8_t i = 0; i < NCH; i++) {
    float f = vals[i];
    if (std::isnan(f)) { r.v[i] = NODATA; continue; }
    float s = f * SCALE[i];
    if (s > 32767.0f) s = 32767.0f;
    if (s < -32767.0f) s = -32767.0f;
    r.v[i] = (int16_t) lroundf(s);
  }
  head = (head + 1) % CAP;
  if (count < CAP) count++;

  // Карту могли воткнуть уже после включения — пробуем ещё раз
  if (!sd_ok && sd_tried && (count % 15) == 0) sd_ok = sd_mount();
  sd_open_file(ts);
  sd_append(buf[(head + CAP - 1) % CAP]);
}

// Новый погон — новый файл. Кольцо чистим, старые файлы на карте не трогаем:
// стирать чужой архив кнопкой на экране нельзя.
inline void clear() {
  head = 0;
  count = 0;
  sd_rows = 0;
  fname[0] = 0;
  ESP_LOGI(TAG, "журнал очищен, следующая запись начнёт новый файл");
}

// ---------------------------------------------------------------------------
//  Раздача по сети
// ---------------------------------------------------------------------------
// Отдаём кусками: собрать журнал в памяти целиком нельзя — он и так
// занимает почти всю свободную кучу.
class LogHandler : public AsyncWebHandler {
 public:
  bool canHandle(AsyncWebServerRequest *req)
#ifdef ASYNCWEBSERVER_VERSION
      const
#endif
      override {
    if (req->method() != HTTP_GET) return false;
    const String &u = req->url();
    return u == "/log.csv" || u == "/logs" || u.startsWith("/logs/");
  }

  void handleRequest(AsyncWebServerRequest *req) override {
    const String u = req->url();
    if (u == "/logs")            { list(req); return; }
    if (u.startsWith("/logs/"))  { file(req, u.substring(5)); return; }

    // Текущий погон: с карты, если она пишется, иначе из памяти
    if (sd_ok && fname[0]) { file(req, String(fname)); return; }
    ring(req);
  }

 private:
  static void attach(AsyncWebServerResponse *r, const String &name) {
    r->addHeader("Content-Disposition",
                 "attachment; filename=\"" + name + "\"");
    r->addHeader("Access-Control-Allow-Origin", "*");
  }

  // Журнал из кольца в памяти
  void ring(AsyncWebServerRequest *req) {
    auto pos = std::make_shared<size_t>(0);
    auto hdr = std::make_shared<bool>(false);
    size_t total = count;

    AsyncWebServerResponse *resp = req->beginChunkedResponse(
        "text/csv; charset=utf-8",
        [pos, hdr, total](uint8_t *b, size_t maxLen, size_t) -> size_t {
          if (!*hdr) {
            size_t n = strlen(BOM) + strlen(HEAD);
            if (n > maxLen) return 0;
            memcpy(b, BOM, strlen(BOM));
            memcpy(b + strlen(BOM), HEAD, strlen(HEAD));
            *hdr = true;
            return n;
          }
          size_t n = 0;
          while (*pos < total && maxLen - n > 260) {
            n += render(at(*pos), (char *) b + n, maxLen - n);
            (*pos)++;
          }
          return n;                       // 0 — конец
        });
    attach(resp, "kolonna_memory.csv");
    req->send(resp);
  }

  // Файл с карты
  void file(AsyncWebServerRequest *req, const String &path) {
    String p = path.startsWith("/") ? path : "/" + path;
    if (!sd_ok || !SD.exists(p)) {
      req->send(404, "text/plain; charset=utf-8",
                sd_ok ? "нет такого файла" : "карта не установлена");
      return;
    }
    AsyncWebServerResponse *resp = req->beginResponse(SD, p, "text/csv; charset=utf-8");
    String name = p;
    name.remove(0, 1);
    attach(resp, name);
    req->send(resp);
  }

  // Список погонов на карте
  void list(AsyncWebServerRequest *req) {
    if (!sd_ok) {
      req->send(200, "text/html; charset=utf-8",
                "<meta charset=utf-8><p>Карта не установлена. "
                "Журнал пишется только в память: "
                "<a href=\"/log.csv\">скачать</a>.");
      return;
    }
    String h = "<meta charset=utf-8><meta name=viewport "
               "content=\"width=device-width,initial-scale=1\">"
               "<style>body{font:16px/1.5 system-ui;margin:24px;max-width:640px}"
               "a{display:block;padding:10px 0;border-bottom:1px solid #ddd}"
               "</style><h2>Журналы погонов</h2>";
    File dir = SD.open("/");
    File f;
    int n = 0;
    while ((f = dir.openNextFile())) {
      String nm = f.name();
      if (nm.startsWith("/")) nm.remove(0, 1);
      if (nm.endsWith(".csv")) {
        h += "<a href=\"/logs/" + nm + "\">" + nm + " — " +
             String((uint32_t) (f.size() / 1024)) + " КБ</a>";
        n++;
      }
      f.close();
    }
    dir.close();
    if (!n) h += "<p>Пока пусто.";
    req->send(200, "text/html; charset=utf-8", h);
  }
};

inline void setup(esphome::web_server_base::WebServerBase *base) {
  reserve();
  sd_ok = sd_mount();
  sd_tried = true;
  base->add_handler(new LogHandler());
  ESP_LOGI(TAG, "журнал готов: карта %s, кольцо %u записей (%u байт)",
           sd_ok ? "есть" : "нет", (unsigned) CAP,
           (unsigned) (CAP * sizeof(Row)));
}

}  // namespace kolonna_log
