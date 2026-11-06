"""Журнал платы колонны по сети (API ESPHome), без пересборки прошивки.

Запуск:  python tools/esp_logs.py [секунд]      (по умолчанию 12)
Печатает отчёт платы о себе (версия, дата сборки) и предупреждения:
кого не нашла на шинах 1-Wire и I2C, что с картой.
Ключ берёт из esphome/secrets.yaml (в git не попадает). Плата: 192.168.0.55.
Нужен пакет aioesphomeapi (ставится вместе с esphome).
"""
import asyncio
import os
import re
import sys

from aioesphomeapi import APIClient, LogLevel

HOST = "192.168.0.55"
HERE = os.path.dirname(os.path.abspath(__file__))
sec = open(os.path.join(HERE, "..", "esphome", "secrets.yaml"), encoding="utf-8").read()
key = re.search(r'^api_encryption_key:\s*"?([^"\s]+)"?', sec, re.M).group(1)
ANSI = re.compile(r"\x1b\[[0-9;]*m")


async def main(seconds: float) -> None:
    cli = APIClient(HOST, 6053, None, noise_psk=key)
    await cli.connect(login=True)

    def on_log(msg):
        t = msg.message.decode("utf-8", "replace") if isinstance(msg.message, bytes) else msg.message
        print(ANSI.sub("", t), flush=True)

    cli.subscribe_logs(on_log, log_level=LogLevel.LOG_LEVEL_DEBUG, dump_config=True)
    await asyncio.sleep(seconds)
    await cli.disconnect()


if __name__ == "__main__":
    asyncio.run(main(float(sys.argv[1]) if len(sys.argv) > 1 else 12))
