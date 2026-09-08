#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Логгер погона: пишет показания колонны в CSV, не завися от браузера.

Зачем: страница пульта копит историю в самом браузере. Закрыл вкладку,
уснул ноут, обновил страницу не вовремя — в истории дыра. Контроллер
своей истории не хранит вообще: он отдаёт «сейчас» и всё.

Этот скрипт подключается к ESP32 напрямую и пишет строку раз в N секунд,
сбрасывая её на диск сразу. Выдернули питание — потеряна последняя строка,
а не весь погон.

Запуск:
    python logger.py 192.168.0.55
    python logger.py 192.168.0.55 --step 5 --dir C:\\logs

Остановка: Ctrl+C. Файл остаётся дописанным и валидным.

Зависимостей нет — только стандартная библиотека.
"""

__version__ = "1.0.0"

import argparse
import csv
import json
import os
import signal
import sys
import time
from datetime import datetime
from urllib.request import urlopen
from urllib.error import URLError

# ---------------------------------------------------------------------------
# Каналы. Ключ — id, который отдаёт web_server ESPHome, значение — заголовок
# колонки в CSV. Порядок здесь задаёт порядок колонок в файле.
# ---------------------------------------------------------------------------
CHANNELS = [
    ("sensor-t1_kub",        "Куб T1, °C"),
    ("sensor-t2_carga",      "Температура 2/3 T2, °C"),
    ("sensor-t3_otbor",      "Температура отбора T3, °C"),
    ("sensor-delta_t",       "ΔT отбор-2/3, °C"),
    ("sensor-trend_t2",      "Скорость роста 2/3, °C/мин"),
    ("sensor-kub_abv",       "Спирт в кубе, %"),
    ("sensor-power",         "Мощность по току, Вт"),
    ("sensor-power_water",   "Мощность по воде, Вт"),
    ("sensor-current",       "Ток, А"),
    ("sensor-voltage",       "Напряжение, В"),
    ("sensor-water_flow",    "Проток, л/мин"),
    ("sensor-water_total",   "Расход воды, л"),
    ("sensor-t4_voda",       "Вода выход T4, °C"),
    ("sensor-t5_voda_vhod",  "Вода вход T5, °C"),
    ("sensor-pressure_mmhg", "Давление, мм рт.ст."),
    ("sensor-otbor_rate",    "Скорость отбора, мл/ч"),
    ("sensor-otbor_volume",  "Отобрано, мл"),
]

# Аварии пишем отдельными колонками 0/1: по логу должно быть видно
# не только что творилось, но и что прибор об этом думал.
ALARMS = [
    ("binary_sensor-alarm_no_flow",      "АВАРИЯ вода встала"),
    ("binary_sensor-alarm_cooling",      "АВАРИЯ нет охлаждения"),
    ("binary_sensor-alarm_kub_hot",      "АВАРИЯ куб горячий"),
    ("binary_sensor-alarm_sensor_fault", "АВАРИЯ обрыв датчика"),
    ("binary_sensor-warn_power",         "ВНИМАНИЕ мощность"),
    ("binary_sensor-warn_front",         "ВНИМАНИЕ фронт"),
]

IDS = [c[0] for c in CHANNELS]
ALARM_IDS = [a[0] for a in ALARMS]
HEADERS = ["Время"] + [c[1] for c in CHANNELS] + [a[1] for a in ALARMS] + ["Связь"]

stop = False


def on_signal(_sig, _frm):
    global stop
    stop = True


def num(v):
    """Число из строки события. Русский Excel ждёт запятую."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return ""
    return ("%.4f" % f).rstrip("0").rstrip(".").replace(".", ",")


def open_log(directory):
    """Новый файл на каждый запуск: один запуск — один погон."""
    os.makedirs(directory, exist_ok=True)
    name = "kolonna_%s.csv" % datetime.now().strftime("%Y-%m-%d_%H-%M")
    path = os.path.join(directory, name)
    # utf-8-sig — BOM, без него русский Excel покажет кракозябры
    fh = open(path, "w", encoding="utf-8-sig", newline="")
    wr = csv.writer(fh, delimiter=";", quoting=csv.QUOTE_MINIMAL)
    wr.writerow(HEADERS)
    fh.flush()
    return path, fh, wr


def stream(ip, state, on_event):
    """Читает SSE с контроллера. Возвращает управление при обрыве."""
    url = "http://%s/events" % ip
    with urlopen(url, timeout=30) as r:
        for raw in r:
            if stop:
                return
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            try:
                d = json.loads(line[5:].strip())
            except ValueError:
                continue
            i = d.get("id")
            if i in state:
                state[i] = d.get("value")
            elif i in ALARM_IDS:
                v = d.get("value")
                state[i] = 1 if (v is True or d.get("state") == "ON") else 0
            on_event()


def main():
    ap = argparse.ArgumentParser(description="Логгер погона колонны")
    ap.add_argument("ip", help="адрес ESP32, например 192.168.0.55")
    ap.add_argument("--step", type=int, default=10,
                    help="шаг записи в секундах (по умолчанию 10)")
    ap.add_argument("--dir", default="logs", help="куда писать (по умолчанию ./logs)")
    a = ap.parse_args()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    path, fh, wr = open_log(a.dir)
    print("Пишу в %s, шаг %d с. Ctrl+C — остановить." % (path, a.step))

    state = {}
    for i in IDS:
        state[i] = None
    for i in ALARM_IDS:
        state[i] = 0

    last_write = 0.0
    last_msg = [0.0]
    rows = [0]

    def write_row(link):
        row = [datetime.now().strftime("%Y-%m-%d %H:%M:%S")]
        row += [num(state[i]) for i in IDS]
        row += [str(state[i]) for i in ALARM_IDS]
        row.append(link)
        wr.writerow(row)
        fh.flush()          # на диск сразу: свет мигнул — лог уцелел
        os.fsync(fh.fileno())
        rows[0] += 1

    def tick():
        nonlocal last_write
        last_msg[0] = time.time()
        now = time.time()
        if now - last_write >= a.step:
            last_write = now
            write_row("есть")
            print("\r%s строк, куб %s   " % (rows[0], state.get("sensor-t1_kub")),
                  end="", flush=True)

    try:
        while not stop:
            try:
                stream(a.ip, state, tick)
                if not stop:
                    raise URLError("поток закрылся")
            except (URLError, OSError, TimeoutError) as e:
                if stop:
                    break
                # Обрыв — не повод терять погон. Пишем строку с пометкой
                # и ждём: пропуск в логе должен быть виден, а не подделан
                # последним известным значением.
                write_row("НЕТ СВЯЗИ")
                print("\nНет связи (%s), повтор через 5 с" % e)
                for _ in range(5):
                    if stop:
                        break
                    time.sleep(1)
    finally:
        fh.close()
        print("\nГотово. %s, строк: %d" % (path, rows[0]))


if __name__ == "__main__":
    main()
