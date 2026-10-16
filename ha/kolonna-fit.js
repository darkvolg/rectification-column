// Страница HA «Колонна» (/kolonna-pult) сама уменьшается под узкое окно:
// ноутбук, окно рядом с TempMeter. Меню HA слева не трогает — только содержимое.
// Ставится в /config/www/, подключается ресурсом дашборда (module).

const PATH = "/kolonna-pult";
const DESIGN_W = 1400; // ширина, при которой табло ещё стоят справа от графика
const DESIGN_H = 880;  // высота всего содержимого страницы
const MIN_ZOOM = 0.5;  // мельче уже не прочитать — дальше пусть HA перестраивает сам

let current = null;

function findView() {
  try {
    const main = document.querySelector("home-assistant").shadowRoot
      .querySelector("home-assistant-main").shadowRoot;
    const root = main.querySelector("ha-panel-lovelace").shadowRoot
      .querySelector("hui-root").shadowRoot;
    return root.querySelector("hui-view");
  } catch (e) {
    return null;
  }
}

function fit() {
  if (!location.pathname.startsWith(PATH)) {
    if (current) { current.style.zoom = ""; current = null; }
    return;
  }
  const view = findView();
  if (!view || !view.parentElement) return;
  const box = view.parentElement.getBoundingClientRect();
  const z = Math.max(MIN_ZOOM,
    Math.min(1, box.width / DESIGN_W, (window.innerHeight - box.top) / DESIGN_H));
  const val = z >= 0.999 ? "" : z.toFixed(3);
  if (view.style.zoom !== val) view.style.zoom = val;
  current = view;
}

window.addEventListener("resize", fit);
window.addEventListener("location-changed", () => setTimeout(fit, 300));
// HA пересоздаёт вид при переходах и обновлениях — подстраховка раз в 2 секунды
setInterval(fit, 2000);
fit();
