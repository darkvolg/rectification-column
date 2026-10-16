import asyncio, json, re, sys
import websockets

CRED = r"C:\Users\Dark\Desktop\Проекты\Password\credentials.md"
tok = re.search(r"long-lived token \(192\.168\.0\.74:8123, выдан 08\.09\.2026\): (\S+)",
                open(CRED, encoding="utf-8").read()).group(1)

def tile(name, sensor, color, digits, limit=None, unit="°C", ref=False):
    """Табло как в правой колонке TempMeter: название, крупная цифра, порог и кружок."""
    s = f"sensor.kolonna_{sensor}"
    t = (
        f"{{% set st = states.{s} %}}"
        f"{{% set fresh = st is not none and st.state | is_number"
        f" and (now() - st.last_reported).total_seconds() < 120 %}}"
        f'<center><b>{name}</b></center>\n\n'
        f"{{% if fresh %}}"
        f'<h1><center><font color="{color}">'
        f"{{{{ ('%.{digits}f' | format(st.state | float)).replace('.', ',') }}}} {unit}"
        f"</font></center></h1>\n"
    )
    if limit:
        t += (
            f"{{% set lim = states('input_number.kolonna_{limit}') | float(0) %}}"
            f"<h4><center>{{% if lim > 0 %}}"
            f"{{{{ '🔴' if st.state | float > lim else '🟢' }}}} порог "
            f"{{{{ ('%g' | format(lim)).replace('.', ',') }}}}"
            f"{{% else %}}⚪ порог выключен{{% endif %}}</center></h4>\n"
        )
    if ref:
        t += (
            "{% set r = states('sensor.kolonna_par_ref') %}"
            "{% if r | is_number %}<center>от точки: "
            "{{ ('%+.2f' | format(st.state | float - r | float)).replace('.', ',') }}</center>{% endif %}\n"
        )
    t += '{% else %}<h2><center><font color="gray">нет данных</font></center></h2>{% endif %}'
    return {"type": "markdown", "grid_options": {"columns": 6}, "content": t}


CONFIG = {
    "title": "Колонна",
    "views": [{
        "title": "Колонна",
        "path": "main",
        "icon": "mdi:glass-mug-variant",
        "type": "sections",
        "max_columns": 4,
        "sections": [
            # главный график на всю ширину. Одно поле, как в TempMeter, но у каждой линии
            # своя шкала и своя полоса по высоте: Пар сверху, Пар 2/3 посередине, вода снизу.
            # Иначе на общей оси 57–78 Пар расплющивается в прямую, а на одинаковых осях
            # линии ложатся друг на друга. Полосы задаются запасом шкалы над/под данными.
            # блок на всю строку: сетка 12 × 4 = 48 колонок — 42 графику, 6 узкому
            # столбику табло справа, как в TempMeter. На узком экране табло уйдут вниз
            {"type": "grid", "column_span": 4, "cards": [
                {"type": "custom:apexcharts-card", "graph_span": "1h",
                 "grid_options": {"columns": 42},
                 "header": {"show": True, "title": "Колонна, последний час", "show_states": False},
                 "yaxis": [
                     {"id": "par", "min": "|-0.6|", "max": "|+0.05|", "decimals": 2,
                      "apex_config": {"tickAmount": 6, "labels": {"style": {"colors": "#e53935"}}}},
                     {"id": "par23", "min": "|-0.3|", "max": "|+0.35|", "decimals": 2,
                      "apex_config": {"tickAmount": 6, "labels": {"style": {"colors": "#fb8c00"}}}},
                     {"id": "voda", "opposite": True, "min": "|-0.5|", "max": "|+8|", "decimals": 1,
                      "apex_config": {"tickAmount": 6, "labels": {"style": {"colors": "#1e88e5"}}}},
                 ],
                 "series": [
                     {"entity": "sensor.kolonna_par", "name": "Пар", "yaxis_id": "par", "color": "#e53935",
                      "stroke_width": 3, "curve": "straight", "extend_to": "now"},
                     {"entity": "sensor.kolonna_par23", "name": "Пар 2/3", "yaxis_id": "par23",
                      "color": "#fb8c00", "stroke_width": 3, "curve": "straight", "extend_to": "now"},
                     {"entity": "sensor.kolonna_voda", "name": "Вода", "yaxis_id": "voda", "color": "#1e88e5",
                      "stroke_width": 3, "curve": "straight", "extend_to": "now"},
                 ],
                 "apex_config": {"chart": {"height": 480}, "legend": {"show": True, "fontSize": "14px"},
                                 "tooltip": {"x": {"format": "HH:mm:ss"}}}},
                {"type": "vertical-stack", "grid_options": {"columns": 6}, "cards": [
                    tile("Пар", "par", "#e53935", 2, limit="par_max"),
                    tile("Пар 2/3", "par23", "#fb8c00", 2, limit="par23_max"),
                    tile("Вода", "voda", "#1e88e5", 1, limit="voda_max"),
                    tile("Атм. давление", "davl", "#fdd835", 1, unit="мм"),
                ]},
            ]},
            {"type": "grid", "cards": [
                # тревога: видна только пока ждёт «Принял», HA повторяет её раз в минуту
                {"type": "conditional", "grid_options": {"columns": "full"},
                 "conditions": [{"condition": "state", "entity": "input_boolean.kolonna_alarm_active",
                                 "state": "on"}],
                 "card": {"type": "vertical-stack", "cards": [
                     {"type": "markdown", "content":
                         '<h3><font color="#e53935">🔔 '
                         "{{ states('input_text.kolonna_alarm_text') }}</font></h3>"},
                     {"type": "button", "entity": "input_button.kolonna_ack", "name": "ПРИНЯЛ",
                      "icon": "mdi:check-bold", "show_state": False, "icon_height": "48px",
                      "tap_action": {"action": "perform-action", "perform_action": "input_button.press",
                                     "target": {"entity_id": "input_button.kolonna_ack"}}},
                 ]}},
                # подсказка «похоже, пошло тело»: Пар час стоит и голов не меньше нормы
                {"type": "conditional", "grid_options": {"columns": "full"},
                 "conditions": [{"condition": "state", "entity": "sensor.kolonna_hint",
                                 "state_not": ["нет", "unknown", "unavailable"]}],
                 "card": {"type": "markdown", "content":
                          '<h3><font color="#43a047">💡 {{ states("sensor.kolonna_hint") }}</font></h3>'}},
                {"type": "entities", "grid_options": {"columns": "full"},
                 "title": "Погон",
                 "entities": [
                     # на «Тело» программа сама запоминает точку отсчёта и начинает
                     # следить за уходом Пара; на прогреве и головах не дёргает
                     {"entity": "input_select.kolonna_faza", "name": "Фаза"},
                     {"entity": "sensor.kolonna_golovy", "name": "Голов отобрано (из журнала)"},
                     {"type": "attribute", "entity": "sensor.kolonna_golovy", "attribute": "plan",
                      "name": "Норма голов", "suffix": " мл"},
                     {"entity": "sensor.kolonna_telo", "name": "Тела отобрано (из журнала)"},
                     {"type": "attribute", "entity": "sensor.kolonna_telo", "attribute": "plan",
                      "name": "Норма тела", "suffix": " мл"},
                     {"type": "attribute", "entity": "sensor.kolonna_golovy", "attribute": "saved",
                      "name": "Журнал сохранён в"},
                     {"type": "button", "name": "Весь погон — История HA", "icon": "mdi:chart-timeline-variant",
                      "action_name": "Открыть",
                      "tap_action": {"action": "navigate", "navigation_path":
                                     "/history?entity_id=sensor.kolonna_par%2Csensor.kolonna_par23"
                                     "%2Csensor.kolonna_voda%2Csensor.kolonna_davl"}},
                 ]},
            ]},
            {"type": "grid", "cards": [
                {"type": "entities", "grid_options": {"columns": "full"},
                 "title": "Пороги (0 = выключен)",
                 "entities": [
                     {"entity": "input_number.kolonna_par_max", "name": "Пар выше"},
                     {"entity": "input_number.kolonna_par23_max", "name": "Пар 2/3 выше"},
                     {"entity": "input_number.kolonna_voda_max", "name": "Вода выше"},
                     {"type": "divider"},
                     {"entity": "input_boolean.kolonna_alarms", "name": "Тревоги по порогам"},
                     {"entity": "input_boolean.kolonna_voice_mini", "name": "Голос — Станция Мини"},
                     {"entity": "input_boolean.kolonna_voice_lite", "name": "Голос — Яндекс Лайт"},
                 ]},
            ]},
            {"type": "grid", "cards": [
                {"type": "custom:apexcharts-card", "graph_span": "1h",
                 "grid_options": {"columns": "full"},
                 "header": {"show": True, "title": "Давление", "show_states": True},
                 "yaxis": [{"min": "|-0.5|", "max": "|+0.5|", "decimals": 1,
                            "apex_config": {"tickAmount": 4}}],
                 "series": [{"entity": "sensor.kolonna_davl", "name": "Давление", "color": "#fdd835",
                             "stroke_width": 2, "curve": "stepline", "extend_to": "now"}],
                 "apex_config": {"chart": {"height": 180}, "tooltip": {"x": {"format": "HH:mm:ss"}}}},
            ]},
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
