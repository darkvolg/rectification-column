/* ============================================================
   Колонна — общий скрипт всех страниц проекта

   Делает четыре вещи:
     · тема (авто / день / ночь), общая для всего сайта
     · подсветка текущего пункта навигации
     · чек-листы, которые переживают закрытие вкладки
     · оглавление, следящее за прокруткой

   Никаких библиотек: страницы обязаны открываться двойным
   щелчком у колонны, где интернета может не быть.
   ============================================================ */
(function(){
"use strict";

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

/* ---------- Тема ---------- */
const SUN  = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
const AUTO = '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>';
const ORDER = ['auto','light','dark'];
const TITLE = {auto:'Оформление: как в системе', light:'Оформление: день', dark:'Оформление: ночь'};

function theme(){ return localStorage.getItem('kol_theme') || 'auto'; }
function applyTheme(t){
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('kol_theme', t);
  const b = $('#themeBtn'); if (!b) return;
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
                (t === 'light' ? SUN : t === 'dark' ? MOON : AUTO) + '</svg>';
  b.title = TITLE[t];
  b.setAttribute('aria-label', TITLE[t]);
}
applyTheme(theme());
document.addEventListener('click', e => {
  const b = e.target.closest('#themeBtn'); if (!b) return;
  applyTheme(ORDER[(ORDER.indexOf(theme()) + 1) % 3]);
});

/* ---------- Текущая страница в навигации ---------- */
(function(){
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  $$('nav a').forEach(a => {
    const href = (a.getAttribute('href') || '').toLowerCase();
    if (href === here) a.setAttribute('aria-current', 'page');
  });
})();

/* ---------- Чек-листы ----------
   Ключ хранения = id списка + номер пункта. Поэтому у каждого
   списка на странице должен быть свой id, иначе галочки
   перепутаются между списками.                                */
function initChecks(){
  $$('.check[id]').forEach(list => {
    const key = 'kol_ck_' + list.id;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch(_){}

    const boxes = $$('input[type=checkbox]', list);
    boxes.forEach((box, i) => {
      box.checked = !!saved[i];
      box.addEventListener('change', () => {
        saved[i] = box.checked;
        try { localStorage.setItem(key, JSON.stringify(saved)); } catch(_){}
        paint();
      });
    });

    const bar = list.previousElementSibling;
    const isBar = bar && bar.classList.contains('progress');
    function paint(){
      if (!isBar) return;
      const done = boxes.filter(b => b.checked).length;
      $('.fill', bar).style.width = (100 * done / boxes.length) + '%';
      $('.txt', bar).textContent = done + ' из ' + boxes.length;
    }
    paint();

    const reset = document.querySelector('[data-reset="' + list.id + '"]');
    if (reset) reset.addEventListener('click', () => {
      if (!confirm('Снять все галочки в этом списке?')) return;
      saved = {};
      try { localStorage.removeItem(key); } catch(_){}
      boxes.forEach(b => b.checked = false);
      paint();
    });
  });
}
initChecks();

/* ---------- Оглавление следит за прокруткой ---------- */
(function(){
  const links = $$('aside.toc a'); if (!links.length) return;
  const map = new Map();
  links.forEach(a => {
    const el = document.getElementById(a.getAttribute('href').slice(1));
    if (el) map.set(el, a);
  });
  if (!map.size) return;
  // rootMargin поднимает «линию чтения» под липкую шапку
  const io = new IntersectionObserver(es => {
    es.forEach(e => {
      if (!e.isIntersecting) return;
      links.forEach(a => a.classList.remove('on'));
      map.get(e.target).classList.add('on');
    });
  }, {rootMargin:'-84px 0px -70% 0px', threshold:0});
  map.forEach((_, el) => io.observe(el));
})();

/* ---------- Сообщение ---------- */
let tt;
window.toast = function(msg){
  let t = $('#toast');
  if (!t){ t = document.createElement('div'); t.id = 'toast'; t.className = 'toast';
           t.setAttribute('role','status'); t.setAttribute('aria-live','polite');
           document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 3200);
};

/* ---------- Мелочи для расчётов ---------- */
window.num = function(id){
  const el = document.getElementById(id);
  const v = parseFloat(String(el.value).replace(',', '.'));
  return isFinite(v) ? v : NaN;
};
window.fmt = function(v, d){
  if (!isFinite(v)) return '—';
  return v.toLocaleString('ru-RU', {minimumFractionDigits:d, maximumFractionDigits:d});
};
window.bindCalc = function(ids, fn){
  const run = () => { try { fn(); } catch(_){} };
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', run);
  });
  run();
};
})();
