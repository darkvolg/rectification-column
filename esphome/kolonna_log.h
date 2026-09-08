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
//   кольцо в памяти — подстраховка на десять часов при шаге 30 секунд.
//              Работает, когда карты нет или она отвалилась. Стирается
//              при перезагрузке.
//
// Пишется всегда в оба. Карта появилась посреди погона — в файл сольётся
// и то, что уже накопилось в памяти: терять начало погона нельзя.
//
// Отдаётся по сети:
//   GET /log.csv?from=<строка>&n=<сколько>   журнал из памяти, страницами
//   GET /logs.json                           что лежит на карте
//   GET /logs/<имя>?off=<байт>&len=<байт>    файл погона, кусками
//   GET /logs                                тот же список, но глазами
//
// Почему страницами. Веб-сервер ESPHome под ESP-IDF отдаёт ответ целиком
// из памяти: потоковой выдачи у него нет. Пятнадцатичасовой журнал — это
// мегабайты, их некуда положить. Поэтому клиент забирает по куску и сам
// решает, когда остановиться.
//
// ПОРТ НА ESP-IDF (08.09.2026). Раньше файл был написан под Arduino:
// SD.h, SPI.h, beginChunkedResponse. ESPHome 2026.8 собирает ESP32 через
// ESP-IDF, и Arduino-библиотек в путях компилятора нет — их и не ищем.
// Карта поднимается родными esp_vfs_fat_sdspi_mount + fopen, что надёжнее
// и не тянет за собой пол-Arduino.
//
// РАСПИНОВКА КАРТЫ (модуль microSD-SPI), верхний ряд платы:
//   MOSI → GPIO13     SCK  → GPIO14
//   MISO → GPIO27     CS   → GPIO26
//   VCC  → 5 В (у модулей со стабилизатором) либо 3.3 В
//   GND  → GND
// Пины выбраны из свободных: 4, 16-19, 21-23 заняты датчиками, сиреной
// и PZEM.

#include "esphome/core/log.h"
#include "esphome/core/hal.h"   // millis(); ESPHome подменяет его
                               // макросом в main.cpp, квалификатор не писать
#include "esphome/components/web_server_base/web_server_base.h"

#include "driver/spi_common.h"
#include "driver/sdspi_host.h"
#include "esp_vfs_fat.h"
#include "sdmmc_cmd.h"

#include <dirent.h>
#include <sys/stat.h>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <ctime>
#include <string>
#include <vector>
#include <algorithm>
#include <functional>
#include <strings.h>   // strcasecmp

namespace kolonna_log {

static const char *const TAG = "kolonna_log";

static const gpio_num_t SD_MOSI = GPIO_NUM_13;
static const gpio_num_t SD_SCK  = GPIO_NUM_14;
static const gpio_num_t SD_MISO = GPIO_NUM_27;
static const gpio_num_t SD_CS   = GPIO_NUM_26;
static const char *const MOUNT = "/sd";

// Глубина кольца в памяти. Старое затирается новым: подстраховка — это
// про «последние десять часов», а не про «первые после перезагрузки».
// 1200 строк по 40 байт — 48 КБ. Больше брать нельзя: у ESP32 с WiFi,
// API и веб-сервером свободной кучи остаётся около сотни килобайт.
static const size_t CAP = 1200;
static const uint8_t NCH = 17;

// Ответ собирается в памяти целиком, поэтому кусок ограничен. 16 КБ —
// это около 130 строк журнала: и клиенту не мелко, и куче не больно.
static const size_t CHUNK_MAX = 16 * 1024;
static const size_t ROWS_MAX = 130;

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
static char fname[64] = "";   // имя файла текущего погона, без /sd
static uint32_t sd_rows = 0;  // сколько строк ушло на карту
static sdmmc_card_t *card_info = nullptr;

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

inline const Row &at(size_t i) {
  size_t start = (count == CAP) ? head : 0;
  return buf[(start + i) % CAP];
}

// ---------------------------------------------------------------------------
//  Строка CSV
// ---------------------------------------------------------------------------
inline size_t render(const Row &r, char *out, size_t max) {
  size_t n = 0;
  if (r.ts > 0) {
    time_t t = (time_t) r.ts;
    struct tm tmv;
    localtime_r(&t, &tmv);
    n += strftime(out + n, max - n, "%d.%m.%Y %H:%M:%S", &tmv);
  } else {
    // Времени ещё не было — пишем секунды с включения, чтобы строка
    // не потерялась. Пустая ячейка в этом столбце честнее нуля.
    n += snprintf(out + n, max - n, "+%u", (unsigned) (millis() / 1000));
  }

  for (uint8_t i = 0; i < NCH && n < max; i++) {
    if (r.v[i] == NODATA) {
      n += snprintf(out + n, max - n, ";");
      continue;
    }
    float f = r.v[i] / SCALE[i];
    int dec = SCALE[i] >= 10000.0f ? 4 : SCALE[i] >= 1000.0f ? 3
            : SCALE[i] >= 100.0f  ? 2 : SCALE[i] >= 10.0f   ? 1 : 0;
    // Разделитель дробной части — запятая: русский Excel иначе
    // прочитает число как текст.
    char num[24];
    snprintf(num, sizeof(num), "%.*f", dec, f);
    for (char *p = num; *p; p++)
      if (*p == '.') *p = ',';
    n += snprintf(out + n, max - n, ";%s", num);
  }
  n += snprintf(out + n, max - n, ";%u\r\n", (unsigned) r.alarms);
  return n;
}

// ---------------------------------------------------------------------------
//  Карта
// ---------------------------------------------------------------------------
inline bool sd_mount() {
  spi_bus_config_t bus = {};
  bus.mosi_io_num = SD_MOSI;
  bus.miso_io_num = SD_MISO;
  bus.sclk_io_num = SD_SCK;
  bus.quadwp_io_num = -1;
  bus.quadhd_io_num = -1;
  bus.max_transfer_sz = 4000;

  // Шину поднимаем один раз: повторный вызов вернёт INVALID_STATE, и это
  // не ошибка — просто она уже поднята прошлой попыткой примонтировать.
  esp_err_t err = spi_bus_initialize(SPI3_HOST, &bus, SPI_DMA_CH_AUTO);
  if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
    ESP_LOGW(TAG, "шина SPI не поднялась: %s", esp_err_to_name(err));
    return false;
  }

  sdmmc_host_t host = SDSPI_HOST_DEFAULT();
  host.slot = SPI3_HOST;
  // 20 МГц: длинные провода до модуля на большей частоте начинают врать
  host.max_freq_khz = 20000;

  sdspi_device_config_t slot = SDSPI_DEVICE_CONFIG_DEFAULT();
  slot.gpio_cs = SD_CS;
  slot.host_id = SPI3_HOST;

  esp_vfs_fat_sdmmc_mount_config_t mcfg = {};
  mcfg.format_if_mount_failed = false;   // чужую карту не форматируем
  mcfg.max_files = 3;
  mcfg.allocation_unit_size = 16 * 1024;

  err = esp_vfs_fat_sdspi_mount(MOUNT, &host, &slot, &mcfg, &card_info);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "карта не найдена (%s), пишу только в память",
             esp_err_to_name(err));
    card_info = nullptr;
    return false;
  }
  uint64_t mb = ((uint64_t) card_info->csd.capacity) * card_info->csd.sector_size
                / (1024ULL * 1024ULL);
  ESP_LOGI(TAG, "карта на месте, %llu МБ", (unsigned long long) mb);
  return true;
}

inline std::string full_path(const char *name) {
  std::string p = MOUNT;
  if (name[0] != '/') p += '/';
  p += name;
  return p;
}

// Файл создаётся, когда стало известно время: имя с датой — это половина
// смысла архива. Пока времени нет, копим только в кольцо и ничего не теряем.
inline void sd_open_file(uint32_t ts) {
  if (!sd_ok || fname[0] || ts == 0) return;
  time_t t = (time_t) ts;
  struct tm tmv;
  localtime_r(&t, &tmv);
  // 8.3 не требуется, но короткое имя надёжнее на любых картах
  snprintf(fname, sizeof(fname), "kol_%04d%02d%02d_%02d%02d.csv",
           tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
           tmv.tm_hour, tmv.tm_min);

  std::string path = full_path(fname);
  FILE *f = fopen(path.c_str(), "w");
  if (!f) {
    ESP_LOGE(TAG, "не открыть %s", path.c_str());
    sd_ok = false;
    fname[0] = 0;
    return;
  }
  fwrite(BOM, 1, strlen(BOM), f);
  fwrite(HEAD, 1, strlen(HEAD), f);

  // Сливаем в файл то, что успело накопиться до появления времени
  // или до того, как воткнули карту. Начало погона — самое ценное.
  char line[256];
  for (size_t i = 0; i < count; i++) {
    size_t n = render(at(i), line, sizeof(line));
    fwrite(line, 1, n, f);
    sd_rows++;
  }
  fclose(f);
  ESP_LOGI(TAG, "журнал: %s, слито из памяти %u строк", fname,
           (unsigned) sd_rows);
}

inline void sd_append(const Row &r) {
  if (!sd_ok || !fname[0]) return;
  std::string path = full_path(fname);
  FILE *f = fopen(path.c_str(), "a");
  if (!f) {
    // Карту выдернули посреди погона — не паникуем, кольцо в памяти
    // продолжает писаться, и это видно в диагностике.
    ESP_LOGW(TAG, "запись не удалась, карта потеряна");
    sd_ok = false;
    return;
  }
  char line[256];
  size_t n = render(r, line, sizeof(line));
  fwrite(line, 1, n, f);
  // Закрываем каждый раз: выдернули питание — потеряна последняя строка,
  // а не весь файл. fflush+fsync ниже дожимают то, что кэшировала FATFS.
  fflush(f);
  fsync(fileno(f));
  fclose(f);
  sd_rows++;
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
class LogHandler : public AsyncWebHandler {
 public:
  bool canHandle(AsyncWebServerRequest *req) const override {
    if (req->method() != HTTP_GET) return false;
    char b[AsyncWebServerRequest::URL_BUF_SIZE];
    std::string u(req->url_to(b));
    return u == "/log.csv" || u == "/logs" || u == "/logs.json" ||
           u.rfind("/logs/", 0) == 0;
  }

  void handleRequest(AsyncWebServerRequest *req) override {
    char b[AsyncWebServerRequest::URL_BUF_SIZE];
    std::string u(req->url_to(b));

    if (u == "/logs")            { list_html(req); return; }
    if (u == "/logs.json")       { list_json(req); return; }
    if (u.rfind("/logs/", 0) == 0) { file(req, u.substr(6)); return; }
    ring(req);
  }

 private:
  static long num_arg(AsyncWebServerRequest *req, const char *name, long dflt) {
    if (!req->hasArg(name)) return dflt;
    std::string s = req->arg(name);
    if (s.empty()) return dflt;
    char *end = nullptr;
    long v = strtol(s.c_str(), &end, 10);
    return (end && *end == 0) ? v : dflt;
  }

  static void common(AsyncWebServerResponse *r) {
    // Access-Control-Allow-Origin здесь НЕ ставим: его уже добавляет сам
    // веб-сервер ESPHome. Два одинаковых заголовка браузер считает
    // ошибкой («contains multiple values») и режет ответ — а пульт могут
    // открыть и копией файла с компьютера, там это важно.
    r->addHeader("Cache-Control", "no-store");
    // Без этой строки страница с другого адреса НЕ ВИДИТ наших заголовков:
    // браузер отдаёт скрипту лишь горстку стандартных. Пульт из-за этого
    // думал, что строк прислали ноль, и останавливал перекачку после
    // первой страницы — журнал приходил обрезанным до 130 строк и выглядел
    // при этом целым. Поймано 08.09.2026.
    r->addHeader("Access-Control-Expose-Headers",
                 "X-Rows-Total, X-Rows-Sent, X-File-Size");
  }

  // Журнал из кольца в памяти, страницами по строкам
  void ring(AsyncWebServerRequest *req) {
    long from = num_arg(req, "from", 0);
    long n    = num_arg(req, "n", (long) ROWS_MAX);
    if (from < 0) from = 0;
    if (n < 1) n = 1;
    if (n > (long) ROWS_MAX) n = ROWS_MAX;

    std::string out;
    out.reserve(CHUNK_MAX);
    if (from == 0) { out += BOM; out += HEAD; }

    char line[256];
    long sent = 0;
    for (long i = from; i < (long) count && sent < n; i++, sent++) {
      size_t len = render(at((size_t) i), line, sizeof(line));
      if (out.size() + len > CHUNK_MAX) break;
      out.append(line, len);
    }

    auto *resp = req->beginResponse(200, "text/csv; charset=utf-8", out);
    common(resp);
    // По этим двум заголовкам клиент понимает, сколько ещё осталось,
    // и не гадает по размеру ответа.
    // Буферы ОБЯЗАТЕЛЬНО локальные и живут до send: httpd_resp_set_hdr
    // строки не копирует, а запоминает указатель. С std::to_string(...)
    // .c_str() указывал на уже уничтоженный временный объект, и клиент
    // получал мусор — «всего строк: 1» при четырёх в кольце.
    char h_total[16], h_sent[16];
    snprintf(h_total, sizeof(h_total), "%u", (unsigned) count);
    snprintf(h_sent, sizeof(h_sent), "%ld", sent);
    resp->addHeader("X-Rows-Total", h_total);
    resp->addHeader("X-Rows-Sent", h_sent);
    req->send(resp);
  }

  // Файл с карты, кусками по байтам
  void file(AsyncWebServerRequest *req, const std::string &name) {
    if (!sd_ok) {
      req->send(404, "text/plain; charset=utf-8", "карта не установлена");
      return;
    }
    // Наружу пускаем только имя файла в корне карты: с «..» в пути
    // можно уйти куда не следует.
    if (name.empty() || name.find('/') != std::string::npos ||
        name.find("..") != std::string::npos) {
      req->send(400, "text/plain; charset=utf-8", "плохое имя файла");
      return;
    }

    std::string path = full_path(name.c_str());
    struct stat st;
    if (stat(path.c_str(), &st) != 0) {
      req->send(404, "text/plain; charset=utf-8", "нет такого файла");
      return;
    }

    long off = num_arg(req, "off", 0);
    long len = num_arg(req, "len", (long) CHUNK_MAX);
    if (off < 0) off = 0;
    if (len < 1) len = 1;
    if (len > (long) CHUNK_MAX) len = CHUNK_MAX;

    std::string out;
    if (off < (long) st.st_size) {
      FILE *f = fopen(path.c_str(), "r");
      if (!f) {
        req->send(500, "text/plain; charset=utf-8", "файл не открылся");
        return;
      }
      fseek(f, off, SEEK_SET);
      out.resize((size_t) len);
      size_t got = fread(&out[0], 1, (size_t) len, f);
      out.resize(got);
      fclose(f);
    }

    auto *resp = req->beginResponse(200, "text/csv; charset=utf-8", out);
    common(resp);
    // Буфер локальный и живёт до send — см. пояснение в ring().
    char h_size[24];
    snprintf(h_size, sizeof(h_size), "%ld", (long) st.st_size);
    resp->addHeader("X-File-Size", h_size);
    req->send(resp);
  }

  static void each_csv(const std::function<void(const char *, long)> &fn) {
    DIR *d = opendir(MOUNT);
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d)) != nullptr) {
      const char *nm = e->d_name;
      size_t l = strlen(nm);
      if (l < 5 || strcasecmp(nm + l - 4, ".csv") != 0) continue;
      std::string p = full_path(nm);
      struct stat st;
      long size = (stat(p.c_str(), &st) == 0) ? (long) st.st_size : 0;
      fn(nm, size);
    }
    closedir(d);
  }

  // Список погонов для пульта
  void list_json(AsyncWebServerRequest *req) {
    std::string j = "{\"card\":";
    j += sd_ok ? "true" : "false";
    j += ",\"current\":\"";
    j += fname;
    j += "\",\"rows\":";
    j += std::to_string(count);
    j += ",\"rows_sd\":";
    j += std::to_string(sd_rows);
    j += ",\"files\":[";
    bool first = true;
    if (sd_ok) {
      each_csv([&](const char *nm, long size) {
        if (!first) j += ',';
        first = false;
        j += "{\"name\":\"";
        j += nm;
        j += "\",\"size\":";
        j += std::to_string(size);
        j += '}';
      });
    }
    j += "]}";

    auto *resp = req->beginResponse(200, "application/json; charset=utf-8", j);
    common(resp);
    req->send(resp);
  }

  // Тот же список, но для человека с телефоном
  void list_html(AsyncWebServerRequest *req) {
    std::string h = "<meta charset=utf-8><meta name=viewport "
                    "content=\"width=device-width,initial-scale=1\">"
                    "<style>body{font:16px/1.5 system-ui;margin:24px;max-width:640px}"
                    "a{display:block;padding:10px 0;border-bottom:1px solid #ddd}"
                    "</style><h2>Журналы погонов</h2>";
    if (!sd_ok) {
      h += "<p>Карта не установлена. Журнал пишется только в память: "
           "<a href=\"/log.csv\">скачать последние строки</a>.";
    } else {
      int n = 0;
      each_csv([&](const char *nm, long size) {
        h += "<a href=\"/logs/";
        h += nm;
        h += "\">";
        h += nm;
        h += " — ";
        h += std::to_string(size / 1024);
        h += " КБ</a>";
        n++;
      });
      if (!n) h += "<p>Пока пусто.";
    }
    auto *resp = req->beginResponse(200, "text/html; charset=utf-8", h);
    common(resp);
    req->send(resp);
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
