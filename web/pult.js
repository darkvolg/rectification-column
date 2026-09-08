/* ============================================================
   Пульт колонны — общая логика трёх страниц

   Данные идут напрямую с ESP32 через Server-Sent Events,
   Home Assistant для этого не нужен.

   История копится в браузере и переживает переход между
   страницами и перезагрузку: иначе, уйдя на «Графики»,
   ты бы каждый раз смотрел на пустые оси.

   Никаких библиотек: страницы обязаны открываться у колонны,
   где интернета может не быть.
   ============================================================ */
(function(){
"use strict";

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

/* ============================================================
   КАНАЛЫ
   Ключи — id, которые отдаёт web_server ESPHome: "sensor-<object_id>".
   object_id строится из name латиницей, поэтому в конфиге
   названия английские.

   norm — зона нормы, серая на полосе отклонения
   hiAlarm / loAlarm / hiWarn — пороги, при которых появляется цвет
   ============================================================ */
const CH = {
  'sensor/Power':        {k:'pwr',   n:'Мощность',        i:'по току',  u:'Вт',   d:0, lo:0,   hi:2000, norm:[700,1300], hiWarn:1300},
  'sensor/T2 Carga':     {k:'carga', n:'Температура 2/3',       i:'T2',       u:'°C',   d:2, lo:60,  hi:90,   norm:[74,79]},
  'sensor/T3 Otbor':     {k:'otbor', n:'Температура отбора',    i:'T3',       u:'°C',   d:2, lo:60,  hi:90,   norm:[77,79]},
  'sensor/T1 Kub':       {k:'kub',   n:'Куб',             i:'T1',       u:'°C',   d:2, lo:20,  hi:100,  norm:[70,98.5], hiAlarm:98.5},
  'sensor/Water Flow':   {k:'flow',  n:'Проток',          i:'вход',     u:'л/мин',d:2, lo:0,   hi:5,    norm:[0.8,4],   loAlarm:0.3},
  'sensor/Delta T':      {k:'delta', n:'ΔT отбор − 2/3',   i:'',         u:'°C',   d:3, lo:0,   hi:6,    norm:[1.5,4]},
  'sensor/Trend T2':     {k:'trend', n:'Скорость роста 2/3', i:'',      u:'°C/мин',     d:3, lo:-.05,hi:.15,  norm:[-0.01,0.01], hiWarn:0.01},
  'sensor/T4 Voda':      {k:'voda',  n:'Вода, выход',     i:'T4',       u:'°C',   d:1, lo:10,  hi:80,   norm:[20,55],   hiAlarm:55},
  'sensor/T5 Voda Vhod': {k:'vodaIn',n:'Вода, вход',      i:'T5',       u:'°C',   d:1, lo:0,   hi:40,   norm:[5,25]},
  'sensor/Power Water':  {k:'pwrW',  n:'Мощность',        i:'по воде',  u:'Вт',   d:0, lo:0,   hi:2000, norm:[700,1300]},
  'sensor/Water Total':  {k:'wtot',  n:'Расход за партию',i:'',         u:'л',    d:1, lo:0,   hi:1500, norm:[0,1500]},
  'sensor/Voltage':      {k:'volt',  n:'Сеть',            i:'',         u:'В',    d:1, lo:180, hi:260,  norm:[205,240]},
  'sensor/Current':      {k:'amp',   n:'Ток ТЭНа',        i:'',         u:'А',    d:2, lo:0,   hi:20,   norm:[0,16]},
  'sensor/Pressure mmHg':{k:'press', n:'Давление',        i:'',         u:'мм',   d:1, lo:720, hi:790,  norm:[730,780]},
  'sensor/Otbor Rate':   {k:'rate',  n:'Скорость отбора', i:'модуль 2', u:'мл/ч', d:0, lo:0,   hi:1500, norm:[100,140]},
  'sensor/Log Rows':     {k:'logrows',n:'Журнал контроллера',i:'',u:'зап.', d:0, lo:0,   hi:2000, norm:[0,2000]},
  'sensor/Otbor Volume': {k:'vol',   n:'Отобрано',        i:'модуль 2', u:'мл',   d:0, lo:0,   hi:1200, norm:[0,400]}
};

/* Порядок в объекте задаёт порядок на экране: сначала то,
   на что реагируют немедленно. */
const AL = {
  'binary_sensor/ALARM No Flow':     {c:'a', sym:'▲', t:'Вода встала',
    d:'Протока нет, а куб горячий. Гасить ТЭН, потом искать причину.'},
  'binary_sensor/ALARM Cooling':     {c:'a', sym:'▲', t:'Нет охлаждения',
    d:'Вода на выходе выше 55 °C. Пары спирта пойдут в комнату.'},
  'binary_sensor/ALARM Kub Hot':     {c:'a', sym:'▲', t:'Куб 98.5 °C',
    d:'Тело закончилось. Закрыть отбор, выключить ТЭН.'},
  'binary_sensor/ALARM Sensor Fault':{c:'a', sym:'▲', t:'Обрыв датчика',
    d:'Один из DS18B20 не отвечает. Показания недостоверны.'},
  'binary_sensor/WARN Power':        {c:'w', sym:'◆', t:'Мощность у порога захлёба',
    d:'Выше 1300 Вт. Расчётный порог для Ø33 РПН — около 1370 Вт.'},
  'binary_sensor/WARN Front':        {c:'w', sym:'●', t:'Фронт тронулся',
    d:'Тренд на 2/3 пошёл вверх. Смотреть ΔT, готовиться срезать скорость.'}
};

/* Цвет линии на графиках. Привязан к КАНАЛУ, а не к номеру линии:
   царга всегда одного цвета, на каком бы графике ни оказалась.
   Значение — имя токена темы; пользователь может подменить его
   своим hex в настройках. */
const CLR = {
  carga:'--trace', otbor:'--trace-2', delta:'--trace',  trend:'--trace-2',
  kub:'--trace',   pwr:'--warn',      flow:'--alarm',   voda:'--trace',
  vodaIn:'--trace-2', pwrW:'--trace-2', wtot:'--trace', rate:'--trace-2',
  volt:'--trace',  press:'--trace-2', amp:'--warn', vol:'--trace'
};

/* Уставки в КОНТРОЛЛЕРЕ — те, по которым орёт сирена.
   Живут в прошивке (number: с restore_value), а не в браузере:
   роутер выключен, вкладка закрыта — ESP32 всё равно знает свои пороги. */
/* Назначение датчиков: какая роль сидит на каком слоте.
   Роль живёт в контроллере (select с restore_value), поэтому переживает
   перезагрузку и одинакова для всех, кто откроет пульт. */
const ROLES = [
  {sel:'SLOT T1 Kub',       t:'Куб · T1'},
  {sel:'SLOT T2 Carga',     t:'Царга 2/3 · T2'},
  {sel:'SLOT T3 Otbor',     t:'Отбор · T3'},
  {sel:'SLOT T4 Voda',      t:'Вода выход · T4'},
  {sel:'SLOT T5 Voda Vhod', t:'Вода вход · T5'}
];
const SEL = {};    // 'SLOT T1 Kub' -> {state, options}
const SLOT = {};   // 1..6 -> градусы, чтобы видеть, какой датчик греется

const NUM = {
  'number/SET Voda Max':  {k:'vodaMax',  n:'Вода на выходе, авария',  u:'°C',    d:1, min:40,  max:75,   step:0.5},
  'number/SET Flow Min':  {k:'flowMin',  n:'Проток, авария ниже',     u:'л/мин', d:2, min:0.1, max:2,    step:0.05},
  'number/SET Kub Max':   {k:'kubMax',   n:'Куб, конец тела',         u:'°C',    d:1, min:90,  max:100,  step:0.1},
  'number/SET Kub Arm':   {k:'kubArm',   n:'Куб горячий (взвод)',     u:'°C',    d:0, min:30,  max:80,   step:1},
  'number/SET Pwr Warn':  {k:'pwrWarn',  n:'Мощность, порог захлёба', u:'Вт',    d:0, min:800, max:2000, step:10},
  'number/SET Trend Warn':{k:'trendWarn',n:'Скорость роста 2/3, внимание',   u:'°C/мин',d:3, min:0.002,max:0.1, step:0.001}
};

/* Состояния оборудования — не аварии, а «что сейчас включено».
   ESPHome шлёт их теми же событиями, что и датчики. */
const SW = {'switch/Siren':'siren'};

const V = {}, H = {}, A = {}, S = {}, N = {};

/* ---------- Спиртуозность кубовой жидкости по температуре кипения ----------
   Таблица равновесия вода-этанол при 760 мм рт.ст.
   Проверена по показаниям серийного АРД-403: 88.3 °C → 18.0 % против их 18.6 %.

   ⚠️ Цифра расчётная. На первом погоне сверить с ареометром и, если надо,
   поправить смещением температуры. */
const ABV_T = [
  [100.0, 0], [95.5, 5], [92.0, 10], [89.5, 15], [87.5, 20], [86.0, 25],
  [85.0, 30], [84.0, 35], [83.1, 40], [82.5, 45], [82.0, 50], [81.0, 60],
  [80.2, 70], [79.3, 80], [78.5, 90], [78.15, 96]
];
function kubAbv(t, mmhg){
  if (!isFinite(t)) return NaN;
  // Точка кипения плывёт ~0.037 °C на мм рт.ст. Без поправки смена погоды
  // выглядит как изменение крепости.
  const tc = isFinite(mmhg) ? t - (mmhg - 760) * 0.037 : t;
  if (tc >= ABV_T[0][0]) return 0;
  if (tc <= ABV_T[ABV_T.length - 1][0]) return 96;
  for (let i = 0; i < ABV_T.length - 1; i++){
    const [t1, a1] = ABV_T[i], [t2, a2] = ABV_T[i + 1];
    if (tc <= t1 && tc >= t2) return a1 + (t1 - tc) / (t1 - t2) * (a2 - a1);
  }
  return NaN;
}
const KEEP = 12 * 3600 * 1000;   // держим 12 часов
const STEP = 30000;              // одна точка в 30 секунд — на 10-часовой процесс с запасом
const HKEY = 'kol_hist_v2';

/* ---------- История ---------- */
function loadHist(){
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(HKEY) || 'null'); } catch(_){}
  if (!raw || typeof raw !== 'object') return;
  const from = Date.now() - KEEP;
  for (const k in raw){
    if (!Array.isArray(raw[k])) continue;
    H[k] = raw[k].filter(p => Array.isArray(p) && p[0] >= from);
    const last = H[k][H[k].length - 1];
    /* Показание считается текущим только пока оно свежее. Иначе после
       открытия страницы на плашке висела бы цифра из архива — например,
       температура датчика, который с тех пор отключили. */
    if (last && Date.now() - last[0] < 60000) V[k] = last[1];
  }
}
let saveAt = 0;
function saveHist(force){
  const now = Date.now();
  if (!force && now - saveAt < STEP) return;
  saveAt = now;
  try { localStorage.setItem(HKEY, JSON.stringify(H)); }
  catch(_){
    // Место кончилось — режем историю вдвое и пробуем ещё раз
    for (const k in H) H[k] = H[k].slice(Math.floor(H[k].length / 2));
    try { localStorage.setItem(HKEY, JSON.stringify(H)); } catch(_){}
  }
}
function push(k, v){
  const a = H[k] = H[k] || [];
  const now = Date.now();
  const last = a[a.length - 1];
  if (last && now - last[0] < STEP){ last[1] = v; return; }   // уплотняем до шага сетки
  a.push([now, v]);
  const from = now - KEEP;
  while (a.length && a[0][0] < from) a.shift();
}
function slice(k, minutes){
  const a = H[k]; if (!a || !a.length) return [];
  const from = Date.now() - minutes * 60000;
  let i = 0; while (i < a.length && a[i][0] < from) i++;
  return a.slice(Math.max(0, i - 1));
}
function histInfo(){
  let pts = 0, oldest = Infinity;
  for (const k in H){ pts += H[k].length; if (H[k][0]) oldest = Math.min(oldest, H[k][0][0]); }
  return {points:pts, hours: isFinite(oldest) ? (Date.now() - oldest) / 3600000 : 0};
}
function clearHist(){
  for (const k in H) delete H[k];
  try { localStorage.removeItem(HKEY); } catch(_){}
}
addEventListener('pagehide', () => saveHist(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveHist(true);
});

/* ============================================================
   УСТАВКИ ПУЛЬТА
   Это пороги ПОКАЗА: когда плашка на схеме станет жёлтой или красной
   и где на полосе отклонения лежит серая зона нормы.
   Сирену они не трогают — та слушает только уставки в контроллере.

   Хранятся по ключу канала: {n0, n1, thr}.
   thr — единственный порог канала; какой именно (верхний аварийный,
   нижний аварийный, предупредительный) — известно из CH, поэтому
   в настройках достаточно одного поля вместо трёх.
   ============================================================ */
const LKEY = 'kol_lim_v1', PKEY = 'kol_pal_v1';
let LIMS = {}, PAL = {};
try { LIMS = JSON.parse(localStorage.getItem(LKEY) || '{}') || {}; } catch(_){}
try { PAL  = JSON.parse(localStorage.getItem(PKEY) || '{}') || {}; } catch(_){}

/* Какой порог у канала настраивается и как он называется по-русски */
function thrKind(c){
  if (c.hiAlarm !== undefined) return {f:'hiAlarm', n:'Авария выше', dflt:c.hiAlarm};
  if (c.loAlarm !== undefined) return {f:'loAlarm', n:'Авария ниже', dflt:c.loAlarm};
  if (c.hiWarn  !== undefined) return {f:'hiWarn',  n:'Внимание выше', dflt:c.hiWarn};
  return null;
}

/* Эффективные пороги: заводские из CH, поверх — правки пользователя */
function lim(c){
  const u = LIMS[c.k] || {};
  const o = {norm:[c.norm[0], c.norm[1]],
             hiAlarm:c.hiAlarm, loAlarm:c.loAlarm, hiWarn:c.hiWarn};
  if (isFinite(u.n0)) o.norm[0] = u.n0;
  if (isFinite(u.n1)) o.norm[1] = u.n1;
  if (o.norm[0] > o.norm[1]) o.norm = [o.norm[1], o.norm[0]];
  const t = thrKind(c);
  if (t && isFinite(u.thr)) o[t.f] = u.thr;
  return o;
}
function setLim(key, field, val){
  const o = LIMS[key] = LIMS[key] || {};
  if (val === null || !isFinite(val)) delete o[field];
  else o[field] = val;
  if (!Object.keys(o).length) delete LIMS[key];
  try { localStorage.setItem(LKEY, JSON.stringify(LIMS)); } catch(_){}
  subs.forEach(f => f('lim'));
}
function resetLim(){
  LIMS = {};
  try { localStorage.removeItem(LKEY); } catch(_){}
  subs.forEach(f => f('lim'));
}
function limUser(key){ return LIMS[key] || {}; }

/* ---------- Палитра графиков ---------- */
function lineColor(k){
  if (PAL[k]) return PAL[k];
  return col(CLR[k] || '--trace');
}
function setPal(k, hex){
  if (hex) PAL[k] = hex; else delete PAL[k];
  try { localStorage.setItem(PKEY, JSON.stringify(PAL)); } catch(_){}
  subs.forEach(f => f('pal'));
}
function resetPal(){
  PAL = {};
  try { localStorage.removeItem(PKEY); } catch(_){}
  subs.forEach(f => f('pal'));
}
function palUser(k){ return PAL[k] || ''; }

/* ---------- Пороги показа ---------- */
function severity(c, v){
  if (v === undefined || !isFinite(v)) return '';
  const L = lim(c);
  if (L.hiAlarm !== undefined && v >= L.hiAlarm) return 'a';
  if (L.loAlarm !== undefined && v <= L.loAlarm) return 'a';
  if (L.hiWarn  !== undefined && v >= L.hiWarn)  return 'w';
  return '';
}
const col = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ---------- Запись уставки в контроллер ----------
   ESPHome 2026.8 адресует каналы человеческим именем, а не object_id:
   POST /number/SET%20Voda%20Max/set?value=<x>. Проверено на живой плате —
   вариант с object_id отвечает 404.
   Число ложится в NVS (restore_value), поэтому переживает перезагрузку. */
async function setNumber(objId, val){
  if (!ip){ toast('Сначала задать адрес ESP32'); return false; }
  try{
    // Имя канала идёт в адресе как есть, с пробелами — кодируем.
    const r = await fetch('http://' + ip + '/number/' + encodeURIComponent(objId) +
                          '/set?value=' + encodeURIComponent(val),
                          {method:'POST', body:''});
    toast(r.ok ? 'Уставка записана в контроллер' : 'Контроллер не принял уставку');
    return r.ok;
  }catch(_){ toast('Нет связи с контроллером'); return false; }
}

/* ---------- Назначение роли на слот ----------
   POST /select/<имя>/set?option=<значение>. Тело обязательно: fetch без него
   не шлёт Content-Length, а веб-сервер ESPHome отвечает 411. */
async function setSelect(name, option){
  if (!ip){ toast('Сначала задать адрес ESP32'); return false; }
  try{
    const r = await fetch('http://' + ip + '/select/' + encodeURIComponent(name) +
                          '/set?option=' + encodeURIComponent(option),
                          {method:'POST', body:''});
    toast(r.ok ? 'Назначение записано в контроллер'
               : 'Контроллер не принял назначение (' + r.status + ')');
    return r.ok;
  }catch(_){ toast('Нет связи с контроллером'); return false; }
}

/* ============================================================
   СВЯЗЬ
   ============================================================ */
let es = null, ip = '', lastMsg = 0, state = 'idle';
const subs = [];

function setLink(s, txt){
  state = s;
  const el = $('#link'); if (!el) return;
  el.dataset.s = s;
  $('#linktxt', el).textContent = txt;
}
function connect(addr){
  if (!addr) { setLink('idle', 'нет адреса'); return; }
  ip = addr;
  try { localStorage.setItem('kol_ip', ip); } catch(_){}
  if (es) es.close();
  setLink('wait', 'подключаюсь');
  es = new EventSource('http://' + ip + '/events');
  es.onopen  = () => { lastMsg = Date.now(); setLink('live', 'связь есть'); };
  es.onerror = () => setLink('lost', 'нет связи');
  es.addEventListener('state', e => {
    lastMsg = Date.now();
    if (state !== 'live') setLink('live', 'связь есть');
    let d; try { d = JSON.parse(e.data); } catch(_) { return; }

    if (AL[d.id]){
      const on = (d.value === true || d.state === 'ON');
      if (A[d.id] !== on){ A[d.id] = on; subs.forEach(f => f('alarm')); }
      return;
    }
    if (SW[d.id]){
      S[SW[d.id]] = (d.value === true || d.state === 'ON');
      subs.forEach(f => f('sw'));
      return;
    }
    if (NUM[d.id]){
      const nv = parseFloat(d.value);
      if (isFinite(nv)){ N[NUM[d.id].k] = nv; subs.forEach(f => f('num')); }
      return;
    }
    if (d.id.indexOf('select/') === 0){
      const nm = d.id.slice(7);
      SEL[nm] = {state: d.state, options: d.option || (SEL[nm] || {}).options};
      subs.forEach(f => f('role'));
      return;
    }
    if (d.id.indexOf('sensor/Slot ') === 0){
      const n = parseInt(d.id.slice(12), 10);
      const sv = parseFloat(d.value);
      SLOT[n] = isFinite(sv) ? sv : null;
      subs.forEach(f => f('slot'));
      return;
    }
    const c = CH[d.id]; if (!c) return;
    const v = parseFloat(d.value);
    if (!isFinite(v)){
      /* Канал пуст: роль не назначена или датчик отвалился. Раньше здесь
         стоял простой return, и на плашке навсегда застывало последнее
         живое число — экран показывал температуру датчика, которого нет.
         Это то же враньё, что и заглушка адреса в прошивке, только в вебе. */
      if (V[c.k] !== undefined){
        delete V[c.k];
        subs.forEach(f => f('val'));
      }
      return;
    }
    V[c.k] = v; push(c.k, v); saveHist(false);
  });
}

/* EventSource умеет молча зависнуть, не сообщив об ошибке.
   Поэтому отдельный сторож: 30 секунд тишины — связь потеряна. */
setInterval(() => {
  if (!ip) return;
  if (state === 'live'){
    const s = Math.round((Date.now() - lastMsg) / 1000);
    if (s > 30) setLink('lost', 'нет данных');
    else setLink('live', s < 3 ? 'связь есть' : s + ' с назад');
  }
}, 1000);

/* Квитирование сирены: ESPHome принимает POST на кнопку.
   Звук глохнет, карточка аварии остаётся, пока причина не ушла. */
async function ack(btn){
  // Сначала глушим звук здесь: это местное дело и оно обязано
  // сработать всегда, даже если до платы не достучаться.
  muteHere();

  if (!ip){ toast('Звук заглушен. Адрес ESP32 не задан'); return; }
  if (btn) btn.disabled = true;
  try{
    // body обязателен, хотя телу тут взяться неоткуда: fetch без него
    // не шлёт Content-Length, а веб-сервер ESPHome отвечает 411.
    const r = await fetch('http://' + ip + '/button/' +
                          encodeURIComponent('Ack Siren') + '/press',
                          {method:'POST', body:''});
    toast(r.ok ? 'Заглушено, сирена на колонне тоже'
               : 'Звук заглушен. Плата ответила ' + r.status);
  }catch(e){
    toast('Звук заглушен. До платы не достучались');
  }
  if (btn) setTimeout(() => { btn.disabled = false; }, 1500);
}

/* ============================================================
   ТЕМА
   ============================================================ */
const SUN  = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
const AUTO = '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>';
const TNAME = {auto:'Оформление: как в системе', light:'Оформление: день', dark:'Оформление: ночь'};

function theme(){ return localStorage.getItem('kol_theme') || 'auto'; }
function applyTheme(t){
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('kol_theme', t); } catch(_){}
  const b = $('#themeBtn');
  if (b){
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
                  (t === 'light' ? SUN : t === 'dark' ? MOON : AUTO) + '</svg>';
    b.title = TNAME[t]; b.setAttribute('aria-label', TNAME[t]);
  }
  $$('[data-theme-set]').forEach(x =>
    x.setAttribute('aria-pressed', String(x.dataset.themeSet === t)));
  subs.forEach(f => f('theme'));
}

/* ---------- Не гасить экран ---------- */
let wl = null;
async function wake(on){
  try { localStorage.setItem('kol_wake', on ? '1' : ''); } catch(_){}
  if (!('wakeLock' in navigator)){ if (on) toast('Браузер не умеет держать экран'); return; }
  try{
    if (on) wl = await navigator.wakeLock.request('screen');
    else if (wl){ await wl.release(); wl = null; }
  }catch(_){ if (on) toast('Не дали держать экран'); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && localStorage.getItem('kol_wake')) wake(true);
});

/* ---------- Сообщение ---------- */
let tt;
function toast(msg){
  let t = $('#toast');
  if (!t){ t = document.createElement('div'); t.id = 'toast'; t.className = 'toast';
           t.setAttribute('role','status'); t.setAttribute('aria-live','polite');
           document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 3200);
}

/* ============================================================
   АВТОЗАПИСЬ ЖУРНАЛА
   Живёт здесь, а не на странице «Журнал», потому что журнал должен
   вестись сам. Таймер на покинутой странице умирает вместе с ней:
   ушёл смотреть графики — журнал встал. Здесь он тикает на любой
   странице пульта.
   Момент последней записи лежит в localStorage: раньше отсчёт был
   в памяти страницы и обнулялся при каждом переходе, поэтому 30 минут
   не набегали никогда и записи не появлялись вообще.
   Первую строку ставит человек: пока журнал пуст, погон не начат и
   писать нечего. Дальше прибор пишет сам.
   ============================================================ */
const JKEY = 'kol_zhurnal_v1', JLAST = 'kol_zhurnal_last';

function jrnLoad(){
  let J = null;
  try { J = JSON.parse(localStorage.getItem(JKEY)); } catch(_){}
  if (!J || typeof J !== 'object') J = {};
  if (!J.head || typeof J.head !== 'object') J.head = {};
  if (!Array.isArray(J.rows)) J.rows = [];
  return J;
}
function jrnSave(J){ try { localStorage.setItem(JKEY, JSON.stringify(J)); } catch(_){} }
function jrnLast(){
  const v = parseInt(localStorage.getItem(JLAST), 10);
  return isFinite(v) ? v : 0;
}
function jrnMark(ts){ try { localStorage.setItem(JLAST, String(ts || 0)); } catch(_){} }

/* Пустое поле интервала значит «как в подсказке» — 30 минут. */
function jrnEvery(J){
  const raw = (J || jrnLoad()).head.auto;
  const v = parseFloat(String(raw === undefined || raw === '' ? 30 : raw).replace(',', '.'));
  return isFinite(v) ? v : 30;
}

/* Строка журнала: то, что прибор знает сам. Фазу, объём отбора и
   примечание пишет человек — их прибор знать не может. */
function jrnRow(){
  const d = new Date();
  const f = (v, n) => (v === undefined || !isFinite(v)) ? '' : v.toFixed(n);
  return {
    ts: Math.round(d.getTime() / 1000),   // по ней строки из разных источников сходятся
    src: 'pult',
    t: String(d.getHours()).padStart(2, '0') + ':' +
       String(d.getMinutes()).padStart(2, '0'),
    ph: '',
    otbor: f(V.otbor, 2),
    carga: f(V.carga, 2),
    voda:  f(V.voda, 2),
    volt:  f(V.volt, 0),
    ml:    '',
    rate:  f(V.rate, 0),
    note:  ''
  };
}

function jrnAdd(row){
  const J = jrnLoad();
  J.rows.push(row || jrnRow());
  jrnSave(J);
  jrnMark(Date.now());
  subs.forEach(f => f('jrn'));
  return J;
}

/* Запись привязана к стенным часам, а не к моменту первой строки.
   При интервале 30 минут строки ложатся на 12:00, 12:30, 13:00 — как в
   бумажном журнале. Отсчёт «через 30 минут после предыдущей» давал
   11:43, 12:13, 12:43: время уезжало от того, когда нажали кнопку. */
function jrnTick(){
  const J = jrnLoad();
  if (!J.rows.length){ jrnMark(0); return; }   // погон не начат
  const m = jrnEvery(J);
  if (!(m > 0)) return;                        // 0 — автозапись выключена
  const now = Date.now(), last = jrnLast();
  if (!last){ jrnMark(now); return; }

  const step = m * 60000;
  // Граница текущего получаса (или другого интервала) по часам.
  const slot = Math.floor(now / step);
  if (slot <= Math.floor(last / step)) return;   // в этот слот уже писали

  const r = jrnRow();
  // Строка без единого числа — не запись, а мусор: связи ещё нет либо
  // прибор молчит. Время не отмечаем, попробуем через десять секунд,
  // и запись случится в тот момент, когда данные появятся.
  if (!r.otbor && !r.carga && !r.voda && !r.volt && !r.rate) return;

  // Метку ставим ДО записи: две открытые вкладки не задвоят строку.
  jrnMark(now);
  jrnAdd(r);
}

/* ============================================================
   СЛИЯНИЕ ИСТОЧНИКОВ
   Строка журнала может прийти из трёх мест: с карты самой платы,
   из истории Home Assistant или от открытого пульта. Старшинство
   именно в этом порядке — карта пишет мгновенные значения, HA отдаёт
   пятиминутные средние, пульт держит только то, что застал.
   Железное правило: измерения даёт источник, пометки человека
   (фаза, объём отбора, примечание) не трогает никто. Иначе повторная
   перекачка стирает то, что вписано руками.
   ============================================================ */
const JRANK  = {pult: 1, ha: 2, sd: 3};
const JMEAS  = ['otbor', 'carga', 'voda', 'volt', 'rate'];   // меряет прибор
const JHUMAN = ['ph', 'ml', 'note'];                          // пишет человек

/* Число из внешнего источника округляем так же, как своё: иначе в одной
   колонке рядом стоят 40 и 40.30 и таблица выглядит как набор опечаток. */
function jrnFmtVal(key, v){
  if (v === undefined || v === null || v === '') return '';
  const n = parseFloat(v);
  if (!isFinite(n)) return '';
  let d = 2;
  for (const id in CH) if (CH[id].k === key){ d = CH[id].d; break; }
  return n.toFixed(d);
}

function jrnSrcName(src){
  return src === 'sd' ? 'карта' : src === 'ha' ? 'HA' : 'пульт';
}

/* Строки сходятся не по секундам, а по корзине шириной в интервал журнала:
   плата пишет в 20:00:07, HA отдаёт 20:00:00 — это одна и та же строка. */
function jrnBucket(ts, everyMin){
  const w = Math.max(60, Math.round((everyMin || 30) * 60));
  return Math.floor(ts / w) * w;
}

function jrnHHMM(ts){
  const d = new Date(ts * 1000);
  return String(d.getHours()).padStart(2, '0') + ':' +
         String(d.getMinutes()).padStart(2, '0');
}

/* rows: [{ts, otbor, carga, voda, volt, rate}], значения строками или числами.
   Возвращает {added, filled} — сколько строк добавлено и сколько дополнено. */
function jrnMergeRows(rows, src){
  if (!Array.isArray(rows) || !rows.length) return {added: 0, filled: 0};
  const rank = JRANK[src] || 1;
  const J = jrnLoad();
  const every = jrnEvery(J);

  const byBucket = {};
  J.rows.forEach(r => {
    if (r.ts) byBucket[jrnBucket(r.ts, every)] = r;
  });

  let added = 0, filled = 0;
  rows.forEach(inc => {
    if (!inc || !inc.ts) return;
    const b = jrnBucket(inc.ts, every);
    const cur = byBucket[b];

    if (!cur){
      const row = {ts: inc.ts, src: src, t: jrnHHMM(inc.ts),
                   ph: '', ml: '', note: ''};
      JMEAS.forEach(f => { row[f] = jrnFmtVal(f, inc[f]); });
      J.rows.push(row);
      byBucket[b] = row;
      added++;
      return;
    }

    // Строка уже есть. Заполняем пустые поля всегда, занятые — только если
    // источник старше того, что их заполнил.
    const curRank = JRANK[cur.src] || 1;
    let touched = false;
    JMEAS.forEach(f => {
      const v = inc[f];
      if (v === undefined || v === null || v === '') return;
      const empty = cur[f] === undefined || cur[f] === '';
      if (empty || rank > curRank){ cur[f] = jrnFmtVal(f, v); touched = true; }
    });
    if (touched){
      if (rank >= curRank) cur.src = src;
      filled++;
    }
    // JHUMAN не трогаем никогда — это к вопросу о том, зачем здесь этот список.
    void JHUMAN;
  });

  J.rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  jrnSave(J);
  subs.forEach(f => f('jrn'));
  return {added: added, filled: filled};
}

function jrnInfo(){
  const J = jrnLoad();
  return {rows: J.rows.length, every: jrnEvery(J), last: jrnLast()};
}

/* ============================================================
   HOME ASSISTANT — запасной источник журнала
   Карта платы главнее, но её может не быть: не куплена, не вставлена,
   отвалилась. HA при этом пишет те же датчики к себе сам, без единой
   строчки кода с нашей стороны — надо только уметь оттуда прочитать.
   Адрес и токен живут в браузере, в Настройках.
   ВНИМАНИЕ: токен HA даёт полный доступ ко всему дому. Заводить под
   колонну отдельного пользователя, не администратора.
   ============================================================ */
const HA_KEY = 'kol_ha';

function haCfg(){
  try { return JSON.parse(localStorage.getItem(HA_KEY)) || {}; } catch(_){ return {}; }
}
function setHaCfg(url, token){
  const c = {url: (url || '').trim().replace(/\/+$/, ''), token: (token || '').trim()};
  try { localStorage.setItem(HA_KEY, JSON.stringify(c)); } catch(_){}
  return c;
}

/* Почему WebSocket, а не обычный REST.
   HA включает CORS только тем эндпоинтам, которые сами это разрешают:
   /auth/token заголовок отдаёт, а /api/states нет — и никакая настройка
   cors_allowed_origins этого не меняет. Проверено на живом сервере.
   На WebSocket же правило одного источника не распространяется вовсе,
   и там есть history/history_during_period: вся история одним запросом
   вместо десятков. */
function haWsUrl(){
  const c = haCfg();
  if (!c.url)   throw new Error('не задан адрес Home Assistant');
  if (!c.token) throw new Error('не задан токен');
  return c.url.replace(/^http/, 'ws') + '/api/websocket';
}

/* Одно соединение на операцию: открыли, представились, спросили, закрыли.
   Держать его постоянно незачем — пульт живёт от платы, а не от HA. */
function haConnect(){
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(haWsUrl()); }
    catch(e){ reject(new Error('плохой адрес Home Assistant')); return; }

    const guard = setTimeout(() => {
      try { ws.close(); } catch(_){}
      reject(new Error('HA не отвечает'));
    }, 20000);

    let id = 0;
    const waiting = {};

    ws.onerror = () => {
      clearTimeout(guard);
      reject(new Error('HA не отвечает (адрес или сеть)'));
    };
    ws.onclose = () => {
      clearTimeout(guard);
      Object.keys(waiting).forEach(k => waiting[k].reject(new Error('HA закрыл соединение')));
    };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch(_){ return; }

      if (m.type === 'auth_required'){
        ws.send(JSON.stringify({type: 'auth', access_token: haCfg().token}));
        return;
      }
      if (m.type === 'auth_invalid'){
        clearTimeout(guard);
        try { ws.close(); } catch(_){}
        reject(new Error('токен не принят'));
        return;
      }
      if (m.type === 'auth_ok'){
        clearTimeout(guard);
        resolve({
          ask(type, extra){
            return new Promise((res, rej) => {
              const mid = ++id;
              waiting[mid] = {resolve: res, reject: rej};
              ws.send(JSON.stringify(Object.assign({id: mid, type: type}, extra || {})));
            });
          },
          close(){ try { ws.close(); } catch(_){} }
        });
        return;
      }
      if (m.type === 'result' && waiting[m.id]){
        const w = waiting[m.id];
        delete waiting[m.id];
        if (m.success) w.resolve(m.result);
        else w.reject(new Error((m.error && m.error.message) || 'HA отказал'));
      }
    };
  });
}

/* Имена вроде voltage, current, power есть у половины дома: у розетки,
   у стиральной машины, у чего угодно. Поэтому сначала находим префикс
   НАШЕГО устройства по именам, которых больше нет ни у кого
   (t1_kub, otbor_rate, pressure_mmhg), и только потом сопоставляем
   каналы — строго внутри этого префикса. Иначе напряжение колонны
   приезжает из розетки в коридоре: проверено, приезжало.
   Префикс не зашит: имя устройства у каждого своё. */
const HA_ANCHORS = ['t1_kub', 't2_carga', 't3_otbor', 'otbor_rate',
                    'pressure_mmhg', 'power_water', 'trend_t2', 'delta_t'];

/* «T3 Otbor» из ESPHome превращается в HA в t3_otbor. */
function haSlug(name){
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function haMapStates(states){
  const want = {};   // хвост имени -> наш ключ канала
  Object.keys(CH).forEach(id => {
    if (id.indexOf('sensor/') !== 0) return;
    want[haSlug(id.slice(7))] = CH[id].k;
  });

  const sensors = states.filter(st => (st.entity_id || '').indexOf('sensor.') === 0);

  const score = {};
  sensors.forEach(st => {
    const tail = st.entity_id.slice(7);
    HA_ANCHORS.forEach(a => {
      if (tail === a || tail.endsWith('_' + a)){
        const pref = tail.slice(0, tail.length - a.length);
        score[pref] = (score[pref] || 0) + 1;
      }
    });
  });
  const prefixes = Object.keys(score).sort((a, b) => score[b] - score[a]);
  if (!prefixes.length) return {};
  const prefix = prefixes[0];

  const map = {};
  sensors.forEach(st => {
    const tail = st.entity_id.slice(7);
    if (tail.indexOf(prefix) !== 0) return;
    const rest = tail.slice(prefix.length);
    if (want[rest]) map[want[rest]] = st.entity_id;
  });
  return map;
}

async function haEntities(){
  const ha = await haConnect();
  try {
    return haMapStates(await ha.ask('get_states'));
  } finally { ha.close(); }
}

/* История приходит массивами точек на сущность. Раскладываем их по
   корзинам журнала: в строку идёт последнее значение, известное на её
   момент, — так же, как человек списывает показания на круглый час. */
function haBucketize(hist, map, first, last, step){
  const keys = Object.keys(map);
  const pos = {}, cur = {};
  keys.forEach(k => { pos[k] = 0; });

  const rows = [];
  for (let b = first; b <= last; b += step){
    keys.forEach(k => {
      const arr = hist[map[k]] || [];
      let i = pos[k];
      while (i < arr.length && (arr[i].lu || 0) <= b + 30){
        const v = parseFloat(arr[i].s);
        cur[k] = isFinite(v) ? v : undefined;
        i++;
      }
      pos[k] = i;
    });

    const row = {ts: b};
    keys.forEach(k => { if (cur[k] !== undefined) row[k] = cur[k]; });

    // Строка журнала имеет смысл, только если известна хоть одна
    // температура или напряжение. Одна скорость отбора, да ещё нулевая,
    // — это простой, а не погон: такие строки не пишем.
    if (['otbor', 'carga', 'voda', 'volt'].some(f => row[f] !== undefined)) rows.push(row);
  }
  return rows;
}

async function haPull(startTs, endTs, onStep){
  const ha = await haConnect();
  try {
    if (onStep) onStep('ищу датчики');
    const map = haMapStates(await ha.ask('get_states'));
    const keys = Object.keys(map);
    if (!keys.length) throw new Error('в Home Assistant не видно датчиков колонны');

    if (onStep) onStep('тяну историю');
    const hist = await ha.ask('history/history_during_period', {
      start_time: new Date(startTs * 1000).toISOString(),
      end_time:   new Date(endTs * 1000).toISOString(),
      entity_ids: keys.map(k => map[k]),
      minimal_response: true,
      no_attributes: true
    });

    if (onStep) onStep('раскладываю');
    const every = jrnEvery();
    const step = Math.max(60, Math.round(every * 60));
    const rows = haBucketize(hist || {}, map, jrnBucket(startTs, every), endTs, step);
    return jrnMergeRows(rows, 'ha');
  } finally { ha.close(); }
}

/* ============================================================
   ЗАПУСК — общий для всех трёх страниц
   ============================================================ */
function start(){
  // текущий пункт навигации
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  $$('nav a').forEach(a => {
    if ((a.getAttribute('href') || '').toLowerCase() === here)
      a.setAttribute('aria-current', 'page');
  });

  applyTheme(theme());
  const tb = $('#themeBtn');
  if (tb) tb.onclick = () => {
    const o = ['auto','light','dark'];
    applyTheme(o[(o.indexOf(theme()) + 1) % 3]);
  };

  loadHist();
  jrnTick();
  setInterval(jrnTick, 10000);
  if (localStorage.getItem('kol_wake')) wake(true);

  // Адрес: из ссылки (её можно положить в закладки), иначе из памяти
  const urlIp = new URLSearchParams(location.search).get('ip');
  const saved = urlIp || localStorage.getItem('kol_ip');
  if (saved) connect(saved);
  else setLink('idle', 'нет адреса');
  return !!saved;
}

/* ============================================================
   РЕДАКТОР КАНАЛА
   Открывается щелчком по плашке на схеме, по карточке под ней
   или по строке легенды на графиках. Настройка живёт там же,
   где параметр: не надо помнить, как канал называется в общем списке.

   Одно окно на все три страницы — иначе пороги правились бы
   в двух местах и рано или поздно разъехались.
   ============================================================ */
const BYK = {};
for (const id in CH) BYK[CH[id].k] = CH[id];

/* Какая уставка КОНТРОЛЛЕРА относится к этому каналу.
   Не у каждого канала она есть: ΔT и отбор сирену не поднимают. */
const NUMOF = {
  voda:'SET Voda Max', flow:'SET Flow Min', kub:'SET Kub Max',
  pwr:'SET Pwr Warn',  trend:'SET Trend Warn'
};

/* Числа, которые вводит человек, а не датчик. Клик по плашке должен
   давать именно их: щёлкнув по «ВОДА ВХОД · ВРУЧНУЮ», ждёшь поле ввода,
   а не таблицу порогов. */
const LOCALOF = {
  // onlyIfBlind: поле нужно, лишь пока датчика нет. Объём куба датчиком
  // не меряется вообще, поэтому у него такого флага нет.
  vodaIn: {key:'kol_t_in', n:'Вода на входе, °C', dflt:'14', min:-5, onlyIfBlind:true,
           h:'Мерить из крана перед погоном обычным термометром. Нужно, чтобы ' +
             'посчитать мощность по воде. Появится датчик T5 — поле само перестанет ' +
             'использоваться.'},
  kub:    {key:'kol_kub_v', n:'Залито в куб, л', dflt:'22', min:0.1,
           h:'Отсюда берутся литры спирта в кубе: крепость считается по температуре ' +
             'кипения, а объём взять неоткуда.'}
};

let dlg = null, dlgKey = null, dlgTick = 0;

function esc(t){
  return String(t).replace(/[&<>"]/g, ch =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}

function editor(key){
  const c = BYK[key];
  if (!c) return;
  dlgKey = key;
  if (!dlg){
    dlg = document.createElement('dialog');
    dlg.className = 'edlg';
    document.body.appendChild(dlg);
    // Щелчок по подложке закрывает: привычнее, чем искать крестик
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  }
  dlg.innerHTML = editorHtml(c);
  bindEditor(c);
  if (!dlg.open) dlg.showModal();
  clearInterval(dlgTick);
  dlgTick = setInterval(() => {
    if (!dlg.open){ clearInterval(dlgTick); return; }
    const now = $('#ed_now', dlg);
    if (now) now.textContent = V[dlgKey] === undefined
      ? 'нет данных' : V[dlgKey].toFixed(c.d) + ' ' + c.u;
    const inC = $('#ed_ctl', dlg);
    if (inC){
      const nk = NUM['number/' + NUMOF[dlgKey]];
      const cur = nk ? N[nk.k] : undefined;
      inC.placeholder = cur === undefined ? 'нет связи' : cur.toFixed(nk.d);
    }
  }, 1000);
}

function editorHtml(c){
  const t = thrKind(c), u = LIMS[c.k] || {};
  const nk = NUMOF[c.k] ? NUM['number/' + NUMOF[c.k]] : null;
  const cur = nk ? N[nk.k] : undefined;

  let h = '<form method="dialog" class="edhead">' +
    '<div><b>' + esc(c.n) + (c.i ? ' <i>' + esc(c.i) + '</i>' : '') + '</b>' +
    '<span id="ed_now">' + (V[c.k] === undefined ? 'нет данных'
        : V[c.k].toFixed(c.d) + ' ' + esc(c.u)) + '</span></div>' +
    '<button class="iconbtn" value="close" aria-label="Закрыть">' +
    '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></form>';

  h += '<div class="edsec"><h4>Показ на пульте</h4>' +
    '<p class="edp">Когда плашка станет жёлтой или красной и где на полосе ' +
    'лежит серая зона нормы. Сирену это не трогает.</p>' +
    '<div class="edgrid">' +
      '<label>Норма от<input type="number" step="any" id="ed_n0" ' +
        'placeholder="' + c.norm[0] + '" value="' + (isFinite(u.n0) ? u.n0 : '') + '"></label>' +
      '<label>Норма до<input type="number" step="any" id="ed_n1" ' +
        'placeholder="' + c.norm[1] + '" value="' + (isFinite(u.n1) ? u.n1 : '') + '"></label>' +
      (t ? '<label>' + esc(t.n) + '<input type="number" step="any" id="ed_thr" ' +
            'placeholder="' + t.dflt + '" value="' + (isFinite(u.thr) ? u.thr : '') + '"></label>'
         : '<label class="off">Порога нет<input type="number" disabled></label>') +
    '</div>' +
    '<div class="edcolor"><label for="ed_col">Цвет линии на графиках</label>' +
      '<input type="color" id="ed_col"><button type="button" class="btn" id="ed_colr">' +
      'Цвет темы</button></div>' +
    '</div>';

  const loc = LOCALOF[c.k];
  if (loc && !(loc.onlyIfBlind && V[c.k] !== undefined)){
    h += '<div class="edsec"><h4>Ввод вручную</h4>' +
      '<p class="edp">' + esc(loc.h) + '</p>' +
      '<div class="edrow"><input type="number" step="any" id="ed_loc" ' +
        'placeholder="' + loc.dflt + '" value="' +
        esc(localStorage.getItem(loc.key) || '') + '" aria-label="' + esc(loc.n) + '">' +
      '<span class="edunit">' + esc(loc.n) + '</span></div></div>';
  }

  if (nk){
    h += '<div class="edsec ctl"><h4>Уставка контроллера</h4>' +
      '<p class="edp"><b>По этому числу орёт сирена.</b> Лежит в ESP32, ' +
      'работает при закрытом браузере. Допустимо от ' + nk.min + ' до ' + nk.max +
      ' ' + esc(nk.u) + '.</p>' +
      '<div class="edrow"><input type="number" id="ed_ctl" step="' + nk.step +
        '" min="' + nk.min + '" max="' + nk.max + '" placeholder="' +
        (cur === undefined ? 'нет связи' : cur.toFixed(nk.d)) + '" aria-label="' +
        esc(nk.n) + '">' +
      '<button type="button" class="btn prim" id="ed_write">Записать в контроллер</button>' +
      '</div>' +
      '<p class="edp small">Серым — что сейчас лежит в контроллере. Уставка ' +
      'запоминается в его памяти и переживает перезагрузку.</p></div>';
  } else {
    h += '<div class="edsec"><p class="edp small">У этого канала нет уставки ' +
      'в контроллере: сирену он не поднимает.</p></div>';
  }

  h += '<div class="edfoot">' +
    '<button type="button" class="btn" id="ed_reset">Заводские</button>' +
    '<form method="dialog"><button class="btn prim" value="ok">Готово</button></form>' +
    '</div>';
  return h;
}

function bindEditor(c){
  const t = thrKind(c);
  const num = el => {
    const raw = String(el.value).replace(',', '.').trim();
    if (raw === '') return null;
    const v = parseFloat(raw);
    return isFinite(v) ? v : undefined;      // undefined = мусор, не трогаем
  };
  [['ed_n0','n0'], ['ed_n1','n1'], ['ed_thr','thr']].forEach(([id, f]) => {
    const el = $('#' + id, dlg);
    if (!el || el.disabled) return;
    el.addEventListener('input', () => {
      const v = num(el);
      if (v !== undefined) setLim(c.k, f, v);
    });
  });

  const col2 = $('#ed_col', dlg);
  col2.value = toHexColor(lineColor(c.k));
  col2.addEventListener('input', () => setPal(c.k, col2.value));
  $('#ed_colr', dlg).onclick = () => {
    setPal(c.k, '');
    col2.value = toHexColor(lineColor(c.k));
  };

  $('#ed_reset', dlg).onclick = () => {
    setLim(c.k, 'n0', null); setLim(c.k, 'n1', null); setLim(c.k, 'thr', null);
    setPal(c.k, '');
    editor(c.k);                              // перерисовать окно с заводскими
    toast('Канал «' + c.n + '» вернулся к заводским');
  };

  const lc = $('#ed_loc', dlg);
  if (lc) lc.addEventListener('input', () => {
    const loc = LOCALOF[c.k];
    const raw = String(lc.value).replace(',', '.').trim();
    if (raw === ''){ try { localStorage.removeItem(loc.key); } catch(_){} }
    else {
      const v = parseFloat(raw);
      if (!isFinite(v) || v < loc.min) return;
      try { localStorage.setItem(loc.key, String(v)); } catch(_){}
    }
    subs.forEach(f => f('local'));
  });

  const w = $('#ed_write', dlg);
  if (w) w.onclick = async () => {
    const nk = NUM['number/' + NUMOF[c.k]];
    const el = $('#ed_ctl', dlg);
    const v = parseFloat(String(el.value).replace(',', '.'));
    if (!isFinite(v)){ toast('Пустое поле'); return; }
    if (v < nk.min || v > nk.max){
      toast('Вне допустимого: от ' + nk.min + ' до ' + nk.max); return;
    }
    w.disabled = true;
    await setNumber(NUMOF[c.k], v);
    setTimeout(() => { w.disabled = false; }, 1200);
  };
}

/* input[type=color] понимает только #rrggbb: токен темы приводим к нему,
   иначе браузер молча покажет чёрный вместо цвета линии */
function toHexColor(cl){
  cl = String(cl).trim();
  if (/^#[0-9a-f]{6}$/i.test(cl)) return cl;
  if (/^#[0-9a-f]{3}$/i.test(cl))
    return '#' + cl.slice(1).split('').map(x => x + x).join('');
  const m = cl.match(/rgba?\(([^)]+)\)/);
  if (!m) return '#808080';
  const a = m[1].split(',').map(x => parseInt(x, 10));
  return '#' + a.slice(0, 3).map(x => (x | 0).toString(16).padStart(2, '0')).join('');
}

/* Плашки схемы и карточки становятся кнопками.
   Разметку не трогаем: роль и подсказка навешиваются здесь,
   поэтому любая новая плашка получает их автоматически. */
function armEditors(){
  document.querySelectorAll('.mimic .chip[id^="ch_"]').forEach(g => {
    const k = g.id.slice(3);
    if (!BYK[k] || g.dataset.armed) return;
    g.dataset.armed = '1';
    g.setAttribute('role', 'button');
    g.setAttribute('tabindex', '0');
    g.setAttribute('aria-label', 'Настроить: ' + BYK[k].n);
    const ttl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    ttl.textContent = 'Настроить: ' + BYK[k].n;
    g.insertBefore(ttl, g.firstChild);
    g.addEventListener('click', () => editor(k));
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); editor(k); }
    });
  });
}

/* ============================================================
   ЗВУК АВАРИИ
   ============================================================
   Сирена на колонне слышна в мастерской, но не в доме. Ноут стоит
   рядом с человеком — значит и он обязан звонить, иначе смысла
   в аварии на экране немного: на экран надо смотреть.

   Тон синтезируется, а не берётся файлом: страница должна работать
   у колонны без интернета и без лишних файлов рядом.
   ============================================================ */
const SND_KEY = 'kol_sound';
let actx = null, buzzTimer = 0;

function soundOn(){ return localStorage.getItem(SND_KEY) !== '0'; }
function setSound(on){
  try { localStorage.setItem(SND_KEY, on ? '1' : '0'); } catch(_){}
  if (!on) stopBuzz();
}

/* Браузер не даёт звучать, пока по странице не щёлкнули: контекст
   создаётся при первом же касании и потом просто будится. */
function ensureCtx(){
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return null;
  if (!actx) actx = new C();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
addEventListener('pointerdown', () => ensureCtx(), {once:true});
addEventListener('keydown',     () => ensureCtx(), {once:true});

function beep(freq, dur, delay){
  const c = ensureCtx(); if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'square';
  o.frequency.value = freq;
  o.connect(g); g.connect(c.destination);
  const t = c.currentTime + delay;
  // Через рампы, а не скачком: резкий старт даёт щелчок в динамике
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
  g.gain.setValueAtTime(0.22, t + dur - 0.04);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t); o.stop(t + dur + 0.03);
}

/* Два тона по очереди. Ровный писк ухо перестаёт замечать через
   минуту, перепад — нет. */
function alarmPattern(){ beep(880, 0.34, 0); beep(660, 0.34, 0.40); }

function startBuzz(){
  if (buzzTimer || !soundOn()) return;
  alarmPattern();
  buzzTimer = setInterval(alarmPattern, 1700);
}
function stopBuzz(){
  if (buzzTimer){ clearInterval(buzzTimer); buzzTimer = 0; }
}
function testSound(){
  const c = ensureCtx();
  if (!c) { toast('Браузер не умеет звук'); return false; }
  alarmPattern();
  return true;
}

/* Уведомление рабочего стола — второй канал: звук можно не услышать
   в наушниках, а плашка Windows останется висеть. */
let lastNotified = '';
function notify(title, text){
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (lastNotified === title) return;          // не сыпать одним и тем же
  lastNotified = title;
  try {
    const n = new Notification('Колонна: ' + title, {body:text, tag:'kolonna', renotify:true});
    n.onclick = () => { window.focus(); n.close(); };
  } catch(_){}
}
function askNotify(){
  if (!('Notification' in window)) return Promise.resolve('unsupported');
  return Notification.requestPermission();
}
function notifyState(){
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/* Аварии, чей звук человек уже заглушил руками. Пока авария висит —
   молчим; уйдёт и вернётся снова (или придёт другая) — зазвоним опять.
   Заглушить намертво нельзя: это защита, а не будильник. */
let mutedIds = [];

function hardActive(){
  return Object.keys(AL).filter(id => A[id] && AL[id].c === 'a');
}

/* Глушит звук ЗДЕСЬ, на этом компьютере. Контроллер и его сирена —
   отдельная история: до платы можно и не достучаться, а пищать
   в ухо она от этого не перестанет. */
function muteHere(){
  mutedIds = hardActive();
  stopBuzz();
}

function refreshBuzz(){
  const hard = hardActive();
  const unmuted = hard.filter(id => mutedIds.indexOf(id) < 0);
  if (unmuted.length){
    startBuzz();
    const a = AL[unmuted[0]];
    notify(a.t, a.d);
  } else {
    stopBuzz();
    if (!hard.length){ mutedIds = []; lastNotified = ''; }
  }
}

subs.push(what => { if (what === 'alarm') refreshBuzz(); });

/* Выключатель звука на странице настроек — другая вкладка того же
   браузера. Без этого пульт продолжал бы гудеть до перезагрузки. */
addEventListener('storage', e => {
  if (e.key === SND_KEY){
    if (soundOn()) refreshBuzz(); else stopBuzz();
  }
});

window.PULT = {
  CH, AL, CLR, NUM, V, H, A, S, N,
  start, connect, ack, toast, wake, applyTheme, theme,
  push, slice, severity, col, saveHist, clearHist, histInfo, kubAbv,
  lim, setLim, resetLim, limUser, thrKind, editor, armEditors, NUMOF, toHexColor,
  lineColor, setPal, resetPal, palUser, setNumber,
  ROLES, SEL, SLOT, setSelect,
  jrnLoad, jrnSave, jrnRow, jrnAdd, jrnMark, jrnInfo, jrnEvery,
  jrnMergeRows, jrnSrcName, jrnBucket, jrnHHMM, jrnFmtVal,
  haCfg, setHaCfg, haEntities, haPull, haConnect, haBucketize,
  soundOn, setSound, testSound, stopBuzz, muteHere, askNotify, notifyState,
  get ip(){ return ip; },
  get state(){ return state; },
  onUpdate(f){ subs.push(f); }
};
})();
