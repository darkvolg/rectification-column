import asyncio, json, re, sys
import websockets

CRED = r"C:\Users\Dark\Desktop\Проекты\Password\credentials.md"
tok = re.search(r"long-lived token \(192\.168\.0\.74:8123, выдан 08\.09\.2026\): (\S+)",
                open(CRED, encoding="utf-8").read()).group(1)

CONFIG = {
    "title": "Колонна",
    "views": [{
        "title": "Колонна",
        "path": "main",
        "icon": "mdi:glass-mug-variant",
        "cards": [
            {"type": "glance", "title": "Сейчас", "show_state": True, "columns": 4,
             "entities": [
                 {"entity": "sensor.kolonna_par", "name": "Пар"},
                 {"entity": "sensor.kolonna_par23", "name": "Пар 2/3"},
                 {"entity": "sensor.kolonna_voda", "name": "Вода"},
                 {"entity": "sensor.kolonna_davl", "name": "Давление"},
             ]},
            {"type": "entities", "title": "Рабочий уровень (от него следит за уходом Пара)",
             "entities": [
                 {"entity": "sensor.kolonna_par_ref", "name": "Рабочий уровень Пара"},
                 {"entity": "input_button.kolonna_ref", "name": "Запомнить сейчас (перешёл на тело)"},
             ]},
            {"type": "entities", "title": "Пороги — выше порога Алиса скажет (0 = выключен)",
             "entities": [
                 {"entity": "input_number.kolonna_par_max", "name": "Пар выше"},
                 {"entity": "input_number.kolonna_par23_max", "name": "Пар 2/3 выше"},
                 {"entity": "input_number.kolonna_voda_max", "name": "Вода выше"},
                 {"type": "divider"},
                 {"entity": "input_boolean.kolonna_alarms", "name": "Тревоги по порогам"},
                 {"entity": "input_boolean.kolonna_voice", "name": "Голос на станциях"},
             ]},
            # один график, как в TempMeter, но у каждой линии своя шкала: на общей оси
            # 57–78 Пар расплющивается в прямую. Запас ±0,3 °C — шаг 0,0625 виден,
            # а дрожание младшего бита не растягивается на всю высоту («частокол»)
            {"type": "custom:apexcharts-card", "graph_span": "2h",
             "header": {"show": True, "title": "Колонна, 2 часа", "show_states": True, "colorize_states": True},
             "yaxis": [
                 {"id": "par", "min": "|-0.3|", "max": "|+0.3|", "decimals": 2,
                  "apex_config": {"tickAmount": 4, "labels": {"style": {"colors": "#e53935"}}}},
                 {"id": "par23", "min": "|-0.3|", "max": "|+0.3|", "decimals": 2,
                  "apex_config": {"tickAmount": 4, "labels": {"style": {"colors": "#fb8c00"}}}},
                 {"id": "voda", "opposite": True, "min": "|-1|", "max": "|+1|", "decimals": 1,
                  "apex_config": {"tickAmount": 4, "labels": {"style": {"colors": "#1e88e5"}}}},
             ],
             "series": [
                 {"entity": "sensor.kolonna_par", "name": "Пар", "yaxis_id": "par", "color": "#e53935",
                  "stroke_width": 2, "curve": "straight", "extend_to": "now"},
                 {"entity": "sensor.kolonna_par_ref", "name": "Рабочий уровень", "yaxis_id": "par",
                  "color": "#e53935", "stroke_width": 1, "stroke_dash": 6, "curve": "stepline",
                  "extend_to": "now", "show": {"in_header": False}},
                 {"entity": "sensor.kolonna_par23", "name": "Пар 2/3", "yaxis_id": "par23", "color": "#fb8c00",
                  "stroke_width": 2, "curve": "straight", "extend_to": "now"},
                 {"entity": "sensor.kolonna_voda", "name": "Вода", "yaxis_id": "voda", "color": "#1e88e5",
                  "stroke_width": 2, "curve": "straight", "extend_to": "now"},
             ],
             "apex_config": {"chart": {"height": 360}, "legend": {"show": True},
                             "tooltip": {"x": {"format": "HH:mm:ss"}}}},
            {"type": "custom:apexcharts-card", "graph_span": "2h",
             "header": {"show": True, "title": "Давление", "show_states": True},
             "yaxis": [{"min": "|-0.5|", "max": "|+0.5|", "decimals": 1,
                        "apex_config": {"tickAmount": 4}}],
             "series": [{"entity": "sensor.kolonna_davl", "name": "Давление", "color": "#fdd835",
                         "stroke_width": 2, "curve": "stepline", "extend_to": "now"}],
             "apex_config": {"chart": {"height": 160}, "tooltip": {"x": {"format": "HH:mm:ss"}}}},
        ],
    }],
}


async def main():
    async with websockets.connect("ws://192.168.0.74:8123/api/websocket", proxy=None) as ws:
        await ws.recv()
        await ws.send(json.dumps({"type": "auth", "access_token": tok}))
        print("auth:", json.loads(await ws.recv())["type"])
        n = 0

        async def call(msg):
            nonlocal n
            n += 1
            msg["id"] = n
            await ws.send(json.dumps(msg))
            while True:
                r = json.loads(await ws.recv())
                if r.get("id") == n:
                    return r

        lst = await call({"type": "lovelace/dashboards/list"})
        if not any(d["url_path"] == "kolonna-pult" for d in lst["result"]):
            r = await call({"type": "lovelace/dashboards/create", "url_path": "kolonna-pult",
                            "title": "Колонна", "icon": "mdi:glass-mug-variant",
                            "require_admin": False, "show_in_sidebar": True, "mode": "storage"})
            print("create:", r["success"], r.get("error"))
        r = await call({"type": "lovelace/config/save", "url_path": "kolonna-pult", "config": CONFIG})
        print("save:", r["success"], r.get("error"))

asyncio.run(main())
