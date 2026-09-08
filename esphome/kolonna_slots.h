#pragma once
// ============================================================
//  РОЛЬ ДАТЧИКА ПРИВЯЗАНА К АДРЕСУ, А НЕ К МЕСТУ НА ШИНЕ
// ============================================================
// Слот — это позиция на шине 1-Wire, а позиции ESPHome раздаёт по
// возрастанию адресов. Стоило добавить шестой датчик или заменить
// сгоревший — и порядок ехал: «куб» молча оказывался другим железом.
// Молча — потому что показания правдоподобные, разницу на глаз не видно.
//
// Это не косметика. По кубу висит автостоп на 98.5 °C (конец тела), по
// воде — авария охлаждения. Сработать они должны от своего датчика.
//
// Поэтому роль запоминает АДРЕС выбранного датчика (uint64 в NVS платы),
// а при каждом чтении ищет, на каком слоте этот адрес сейчас. Порядок
// поменялся — роль переехала за своим железом сама. Датчик исчез с шины —
// роль отдаёт «нет данных», а не показания соседа.
//
// Слоты остаются в интерфейсе как способ ВЫБРАТЬ датчик: адреса человеку
// ни о чём не говорят, а «зажми в кулаке и смотри, какой слот греется» —
// говорит. Выбрал слот — прошивка тут же запомнила его адрес.

#include "esphome/core/log.h"
#include "esphome/components/dallas_temp/dallas_temp.h"

#include <cstdlib>
#include <string>
#include <vector>
#include <cmath>

namespace kolonna_slots {

using Slot = esphome::dallas_temp::DallasTemperatureSensor;

/// Все слоты по порядку. Заполняется один раз на старте (on_boot), чтобы
/// не переписывать список из шести id в каждой лямбде. Пока пуст —
/// функции честно отвечают «не знаю», а не лезут в пустой вектор.
inline std::vector<Slot *> all;

/// «0x3b0000005209c928» → 0x3b0000005209c928
inline uint64_t parse(const std::string &s) {
  const char *p = s.c_str();
  if (s.size() > 2 && p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) p += 2;
  return (uint64_t) strtoull(p, nullptr, 16);
}

/// Адрес датчика, стоящего сейчас в этом слоте. Ноль — слота нет.
inline uint64_t addr_of(Slot *s) {
  return s ? parse(s->get_address_name()) : 0;
}

/// Номер слота (1..N) с этим адресом. 0 — роль не назначена,
/// -1 — назначена, но такого датчика на шине сейчас нет.
inline int slot_of(uint64_t want, const std::vector<Slot *> &slots) {
  if (!want) return 0;
  for (size_t i = 0; i < slots.size(); i++)
    if (addr_of(slots[i]) == want) return (int) i + 1;
  return -1;
}

/// Показание датчика с нужным адресом. NAN — не назначен или пропал.
inline float by_addr(uint64_t want, const std::vector<Slot *> &slots) {
  if (!want) return NAN;
  for (auto *s : slots)
    if (addr_of(s) == want) return s->state;
  return NAN;
}

/// Адрес датчика в слоте по его номеру из выпадающего списка
/// (0 = «нет», 1..N = слоты). Нужен в момент выбора роли.
inline uint64_t addr_by_index(size_t idx, const std::vector<Slot *> &slots) {
  if (idx == 0 || idx > slots.size()) return 0;
  return addr_of(slots[idx - 1]);
}

/// Что показать человеку про роль: куда она смотрит и жив ли датчик.
inline std::string status(uint64_t want, const std::vector<Slot *> &slots) {
  if (!want) return "не назначен";
  int n = slot_of(want, slots);
  char buf[64];
  if (n > 0) {
    snprintf(buf, sizeof(buf), "слот %d · 0x%016llx", n, (unsigned long long) want);
  } else {
    // Худший случай, и о нём надо знать прямо: датчик был назначен, а
    // сейчас его на шине нет — обрыв, отвалившаяся клемма, замена.
    snprintf(buf, sizeof(buf), "ПРОПАЛ 0x%016llx", (unsigned long long) want);
  }
  return std::string(buf);
}

/* Короткие формы для лямбд в YAML: список слотов берётся из all. */
inline int slot_of(uint64_t want)      { return slot_of(want, all); }
inline float by_addr(uint64_t want)    { return by_addr(want, all); }
inline uint64_t addr_by_index(size_t i){ return addr_by_index(i, all); }
inline std::string status(uint64_t want) { return status(want, all); }

}  // namespace kolonna_slots
