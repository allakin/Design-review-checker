// Контент-скрипт: подсветка и выбор элемента, скриншот, форма замечания.
// Внедряется по запросу из background.js (chrome.scripting.executeScript).
(() => {
  // После перезагрузки расширения старый скрипт на странице «осиротевает»: убираем его и ставим новый.
  const prev = globalThis.__drcInstance;
  if (prev?.alive()) return;
  prev?.destroy();
  // Интерфейс старых версий, которые не умеют убирать за собой (нет __drcInstance.destroy), тоже убираем.
  document.querySelectorAll('drc-review-root').forEach((n) => n.remove());
  const cleanups = [];
  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  // Синхронно с lib/constants.js
  const SEVERITIES = [
    { id: 'critical', label: 'Критическая', color: '#c4320a', bg: '#fee4e2' },
    { id: 'high', label: 'Высокая', color: '#d9480f', bg: '#ffecd9' },
    { id: 'medium', label: 'Средняя', color: '#a15c07', bg: '#fef3c7' },
    { id: 'low', label: 'Низкая', color: '#1d5fc4', bg: '#dbeafe' },
  ];
  const DEFAULT_SEVERITY = 'medium';
  // Иконки Gravity UI из content/icons.js (внедряется перед этим файлом).
  const I = (name, size = 14) =>
    `<svg class="gi" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true">${globalThis.__drcIcons?.[name] || ''}</svg>`;
  const MAX_SHOT_PX = 30000; // предел высоты canvas
  const MAX_SEGMENTS = 25;

  const STYLES = `
    :host { all: initial; }
    /* Тёмная тема — та же палитра, что в popup.css и pages/review.css */
    * { box-sizing: border-box; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "YS Text", Roboto, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
    .bar, .panel, .toast, .countdown, .busy {
      color-scheme: dark;
      --surface: rgba(255, 255, 255, .035); --surface-2: rgba(255, 255, 255, .06); --surface-hover: rgba(255, 255, 255, .09);
      --line: rgba(255, 255, 255, .08); --line-strong: rgba(255, 255, 255, .14);
      --text: #ededed; --text-2: #a3a3a3; --text-3: #737373;
      --accent: #3ecf8e; --accent-soft: #5fe3a7; --ring: 0 0 0 3px rgba(62, 207, 142, .22);
      --danger: #fb8f84; --ok: #6ee7a6;
      --glass: radial-gradient(120% 80% at 50% -20%, rgba(62, 207, 142, .10), transparent 60%), rgba(28, 28, 28, .92);
      --glass-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(255, 255, 255, .09), 0 24px 60px rgba(0, 0, 0, .55);
    }
    [hidden] { display: none !important; }
    .gi { display: inline-block; flex: none; vertical-align: -2px; }
    .bar > span:first-child, .busy span, .countdown span, button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    ::placeholder { color: #737373; }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .12); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }

    .hl { position: fixed; pointer-events: none; border: 2px solid #3ecf8e; background: rgba(62, 207, 142, .12);
          border-radius: 3px; transition: top .06s, left .06s, width .06s, height .06s; box-shadow: 0 0 0 1px rgba(255, 255, 255, .35), 0 0 24px rgba(62, 207, 142, .35); }
    .hl.selected { border: 1.5px solid #5fe3a7; background: transparent; transition: none;
                   box-shadow: 0 0 0 100vmax rgba(0, 0, 0, .55), 0 0 0 4px rgba(62, 207, 142, .15), 0 0 30px rgba(62, 207, 142, .22); }
    /* Маркеры по углам выделения */
    .hl.selected::after { content: ''; position: absolute; inset: -5px; pointer-events: none;
      background: linear-gradient(#ededed, #ededed) left top / 6px 6px no-repeat, linear-gradient(#ededed, #ededed) right top / 6px 6px no-repeat,
                  linear-gradient(#ededed, #ededed) left bottom / 6px 6px no-repeat, linear-gradient(#ededed, #ededed) right bottom / 6px 6px no-repeat; }
    .hl-label { position: absolute; left: -2px; bottom: 100%; margin-bottom: 6px; white-space: nowrap; max-width: 70vw; overflow: hidden; text-overflow: ellipsis;
                background: linear-gradient(180deg, #0d7a4b, #006239); color: #fff; font: 600 11px/1 ui-monospace, Menlo, monospace; padding: 5px 8px; border-radius: 6px;
                box-shadow: inset 0 1px 0 rgba(255, 255, 255, .22), 0 6px 16px rgba(0, 0, 0, .4); }
    .hl-label.below { bottom: auto; top: 100%; margin: 6px 0 0; }
    .hl-label b { font-weight: 400; opacity: .8; margin-left: 6px; }

    .bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); pointer-events: auto; display: flex; gap: 14px; align-items: center;
           background: var(--glass); backdrop-filter: blur(18px); color: var(--text); padding: 8px 8px 8px 16px; border-radius: 14px; font-size: 13px; line-height: 1.3;
           box-shadow: var(--glass-shadow); width: max-content; max-width: calc(100vw - 24px); }
    .bar > span:first-child { white-space: nowrap; font-weight: 500; }
    .bar > span:first-child .gi { color: var(--accent-soft); }
    .bar.bottom { top: auto; bottom: 12px; }
    .bar kbd { font: 11px ui-monospace, Menlo, monospace; color: var(--text); background: rgba(255, 255, 255, .08); box-shadow: inset 0 0 0 1px var(--line); border-radius: 5px; padding: 2px 6px; }
    .bar .muted { color: var(--text-3); }

    button { cursor: pointer; border: 0; border-radius: 10px; font-size: 13px; font-weight: 600; padding: 8px 12px; color: inherit; transition: background .15s, box-shadow .15s, color .15s; }
    .btn-primary { background: linear-gradient(180deg, #0d7a4b, #006239); color: #fff;
                   box-shadow: inset 0 1px 0 rgba(255, 255, 255, .22), 0 0 0 1px rgba(62, 207, 142, .55), 0 8px 22px rgba(62, 207, 142, .19); }
    .btn-primary:hover { background: linear-gradient(180deg, #11905a, #00744a); }
    .btn-primary:disabled { background: rgba(62, 207, 142, .18); box-shadow: none; cursor: progress; }
    .btn-ghost { background: transparent; color: var(--text-2); }
    .btn-ghost:hover { background: var(--surface-2); color: var(--text); }
    .btn-light { background: var(--surface-2); color: var(--text); box-shadow: inset 0 0 0 1px var(--line); }
    .btn-light:hover { background: var(--surface-hover); box-shadow: inset 0 0 0 1px var(--line-strong); }

    .panel { position: fixed; top: 16px; right: 16px; width: 380px; max-height: calc(100vh - 32px); pointer-events: auto;
             display: flex; flex-direction: column; background: var(--glass); backdrop-filter: blur(24px); color: var(--text); border-radius: 18px;
             box-shadow: var(--glass-shadow); font-size: 13px; }
    .panel.left { right: auto; left: 16px; }
    .panel-head { display: flex; align-items: center; gap: 8px; padding: 14px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .panel-head h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -.01em; flex: 1; }
    .panel-head .sub { font-size: 12px; color: var(--text-3); font-weight: 400; display: block; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
    .icon-btn { width: 30px; height: 30px; padding: 0; display: grid; place-items: center; font-size: 15px; color: var(--text-3); background: transparent; }
    .icon-btn:hover { background: var(--surface-2); color: var(--text); }
    .panel-body { padding: 14px 18px; overflow: auto; display: flex; flex-direction: column; gap: 14px; }
    .panel-body > * { flex-shrink: 0; }
    .shot { border: 1px solid var(--line); border-radius: 12px; background: repeating-conic-gradient(rgba(255, 255, 255, .045) 0 25%, transparent 0 50%) 0 0 / 16px 16px, rgba(0, 0, 0, .25);
            display: grid; place-items: center; max-height: 220px; overflow: hidden; padding: 6px; }
    .shot canvas { max-width: 100%; max-height: 206px; display: block; object-fit: contain; border-radius: 3px; }
    .shot-meta { font: 11px ui-monospace, Menlo, monospace; color: var(--text-3); margin-top: -6px; word-break: break-all; }
    label { display: flex; flex-direction: column; gap: 6px; font-weight: 500; font-size: 12px; color: var(--text-2); }
    label .req { color: var(--danger); }
    input[type=text], input[type=url], textarea { font: 400 13px/1.4 sans-serif; font-family: inherit; color: var(--text); background: rgba(255, 255, 255, .04); border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; outline: none; width: 100%; transition: border-color .15s, box-shadow .15s; }
    input:hover, textarea:hover { border-color: var(--line-strong); }
    input:focus, textarea:focus { border-color: var(--accent); box-shadow: var(--ring); background: rgba(255, 255, 255, .06); }
    textarea { resize: vertical; min-height: 84px; }
    .invalid { border-color: #f04438 !important; box-shadow: 0 0 0 3px rgba(240, 68, 56, .18) !important; }
    .err { color: var(--danger); font-weight: 400; font-size: 11px; }
    .sev { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .sev button { padding: 7px 4px; font-size: 12px; font-weight: 600; background: var(--surface-2); color: var(--text-2); border: 1px solid var(--line); }
    .sev button:hover { background: var(--surface-hover); color: var(--text); }
    /* Яркая версия цвета критичности (--sev — обводка, точка, подложка; --sev-text — светлее, для текста) — только для интерфейса; в отчёте (HTML/PDF) остаются исходные цвета из lib/constants.js */
    .sev button { --sev: color-mix(in srgb, var(--fg) 70%, #fff); --sev-text: color-mix(in srgb, var(--fg) 30%, #fff); }
    @supports (color: oklch(from red l c h)) {
      .sev button { --sev: oklch(from var(--fg) calc(l + .2) calc(c * 1.3) h); --sev-text: oklch(from var(--fg) .87 calc(c * .65) h); }
    }
    .sev button[aria-pressed=true] { background: color-mix(in srgb, var(--sev) 18%, transparent); color: var(--sev-text);
                                     border-color: var(--sev); box-shadow: 0 0 16px color-mix(in srgb, var(--sev) 40%, transparent); }
    .panel-foot { display: flex; gap: 8px; padding: 12px 18px 16px; border-top: 1px solid var(--line); align-items: center; }
    .panel-foot .spacer { flex: 1; }
    .hint { font-size: 11px; color: var(--text-3); }

    .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); pointer-events: auto; display: flex; gap: 10px; align-items: center;
             background: var(--glass); backdrop-filter: blur(18px); color: var(--text); padding: 8px 8px 8px 16px; border-radius: 14px; font-size: 13px; box-shadow: var(--glass-shadow); max-width: calc(100vw - 24px); }
    .toast.error { background: radial-gradient(120% 80% at 50% -20%, rgba(240, 68, 56, .25), transparent 60%), rgba(42, 18, 18, .92); color: #fecdca; }
    .hl.region { border-style: dashed; border-color: #3ecf8e; background: rgba(62, 207, 142, .1); transition: none; }
    .countdown { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); pointer-events: none; background: var(--glass); backdrop-filter: blur(18px); color: var(--text);
                 padding: 10px 16px; border-radius: 14px; font-size: 13px; box-shadow: var(--glass-shadow); display: flex; gap: 12px; align-items: center; }
    .countdown span .gi { color: var(--accent-soft); }
    .countdown b { font-size: 18px; min-width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; color: #fff;
                   background: linear-gradient(180deg, #0d7a4b, #006239); box-shadow: inset 0 1px 0 rgba(255, 255, 255, .22), 0 6px 16px rgba(62, 207, 142, .20); }
    .contrast { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; color: var(--text-2); }
    .contrast b { font-size: 14px; color: var(--text); }
    .pass, .fail { font-weight: 700; font-size: 11px; padding: 1px 7px; border-radius: 999px; }
    .pass { background: rgba(110, 231, 166, .14); color: var(--ok); }
    .fail { background: rgba(240, 68, 56, .16); color: var(--danger); }
    .muted { color: var(--text-3); }
    details.specs { border: 1px solid var(--line); border-radius: 12px; background: rgba(255, 255, 255, .025); }
    details.specs > summary { cursor: pointer; padding: 8px 10px 8px 12px; font-weight: 600; font-size: 12px; color: var(--text-2); display: flex; align-items: center; gap: 8px; }
    details.specs > summary:hover { color: var(--text); }
    details.specs[open] > summary { border-bottom: 1px solid var(--line); }
    details.specs > summary .spacer { flex: 1; }
    details.specs > summary button { padding: 4px 9px; font-size: 11px; border-radius: 8px; }
    .specs-body { padding: 10px 10px 10px; display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow: auto; }
    .spec-group { background: rgba(0, 0, 0, .22); border: 1px solid var(--line); border-radius: 9px; padding: 7px 10px; }
    .spec-group h4 { margin: 0 0 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--text-3); }
    .spec-group dl { display: grid; grid-template-columns: minmax(90px, max-content) 1fr; gap: 1px 10px; margin: 0; }
    .spec-group dt, .spec-group dd { font: 11px/1.5 ui-monospace, Menlo, monospace; margin: 0; }
    .spec-group dt { color: var(--text-3); }
    .spec-group dd { color: var(--text); word-break: break-word; }
    .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, .3); vertical-align: -1px; margin-right: 4px; }
    .discard { position: absolute; left: 12px; right: 12px; bottom: 12px; border-radius: 14px;
               background: radial-gradient(120% 80% at 50% -20%, rgba(240, 68, 56, .16), transparent 60%), #241b1b; border: 1px solid rgba(240, 68, 56, .3);
               box-shadow: 0 16px 40px rgba(0, 0, 0, .6); padding: 14px 14px 12px; display: flex; flex-direction: column; gap: 6px; }
    .discard-head { display: flex; align-items: center; gap: 6px; color: var(--danger); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
    .discard-q { font-size: 14px; font-weight: 600; }
    .discard-note { font-size: 12px; color: var(--text-2); }
    .discard-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
    .btn-danger { background: linear-gradient(180deg, #f04438, #d92d20); color: #fff; box-shadow: inset 0 1px 0 rgba(255, 255, 255, .2), 0 6px 18px rgba(217, 45, 32, .35); }
    .btn-danger:hover { background: linear-gradient(180deg, #f6604f, #e0392b); }
    .busy { position: fixed; inset: 0; display: grid; place-items: center; pointer-events: auto; cursor: progress; }
    .busy span { background: var(--glass); backdrop-filter: blur(18px); color: var(--text); padding: 11px 18px; border-radius: 12px; font-size: 13px; box-shadow: var(--glass-shadow); }
  `;

  const state = {
    mode: 'idle', // idle | picking | capturing | form
    review: null,
    hovered: null,
    selected: null,
    elementInfo: null,
    styles: null,
    region: null, // выделенная область в координатах документа
    drag: null,
    countdownTimer: 0,
    childStack: [],
    shot: null,
    severity: DEFAULT_SEVERITY,
    panelLeft: false,
    toastTimer: 0,
    rafId: 0,
  };

  let host = null;
  let ui = null;

  // ---------- UI root (Shadow DOM, чтобы стили страницы и наши не пересекались) ----------

  function ensureUi() {
    if (host && host.isConnected) return;
    host = document.createElement('drc-review-root');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${STYLES}</style>
      <div class="hl" hidden><div class="hl-label"></div></div>
      <div class="bar" hidden>
        <span>${I('target', 16)} Наведите на блок и кликните</span>
        <span class="muted">протяните мышью — область · <kbd>↑</kbd> родитель <kbd>↓</kbd> дочерний <kbd>Esc</kbd> отмена</span>
        <button class="btn-ghost" data-act="cancel-pick">Отмена</button>
      </div>
      <div class="busy" hidden><span>${I('camera', 16)} Делаю скриншот…</span></div>
      <div class="countdown" hidden><span>${I('stopwatch', 16)} Откройте нужное меню или состояние — выбор начнётся через</span><b></b></div>
      <div class="panel" hidden></div>
      <div class="toast" hidden></div>
    `;
    ui = {
      root,
      hl: root.querySelector('.hl'),
      label: root.querySelector('.hl-label'),
      bar: root.querySelector('.bar'),
      busy: root.querySelector('.busy'),
      panel: root.querySelector('.panel'),
      toast: root.querySelector('.toast'),
      countdown: root.querySelector('.countdown'),
    };
    ui.bar.querySelector('[data-act=cancel-pick]').addEventListener('click', () => cancel());

    // Клики и прочие события внутри нашего UI не должны доходить до обработчиков страницы.
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'wheel']) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    document.documentElement.appendChild(host);
  }

  const isOurs = (e) => !!host && e.composedPath().includes(host);

  // ---------- Подсветка ----------

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) s += '.' + cls.slice(0, 2).join('.');
    return s;
  }

  function drawHighlight(el, selected = false) {
    if (!el || !el.isConnected) {
      ui.hl.hidden = true;
      return;
    }
    drawRect(el.getBoundingClientRect(), describe(el), { selected });
  }

  function drawRect(r, name, { selected = false, region = false } = {}) {
    ui.hl.hidden = false;
    ui.hl.classList.toggle('selected', selected);
    ui.hl.classList.toggle('region', region);
    Object.assign(ui.hl.style, {
      left: `${r.left - 2}px`,
      top: `${r.top - 2}px`,
      width: `${r.width + 4}px`,
      height: `${r.height + 4}px`,
    });
    ui.label.innerHTML = '';
    ui.label.append(name);
    const size = document.createElement('b');
    size.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
    ui.label.append(size);
    ui.label.classList.toggle('below', r.top < 30);
    // Плашку с подсказкой уводим вниз, если она закрывает подсвеченный блок.
    if (state.mode === 'picking') ui.bar.classList.toggle('bottom', r.top < 70 && r.bottom > 0);
  }

  function trackSelected() {
    cancelAnimationFrame(state.rafId);
    const loop = () => {
      if (state.mode !== 'form') return;
      if (state.region) {
        const g = state.region;
        drawRect({ left: g.left - window.scrollX, top: g.top - window.scrollY, width: g.width, height: g.height, bottom: g.top - window.scrollY + g.height },
          'Область', { selected: true, region: true });
      } else if (state.selected) drawHighlight(state.selected, true);
      else return;
      state.rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  // ---------- Режим выбора ----------

  function startPicking(review) {
    if (review) state.review = review;
    ensureUi();
    closePanel();
    hideToast();
    state.mode = 'picking';
    state.hovered = null;
    state.childStack = [];
    ui.bar.hidden = false;
    ui.hl.hidden = true;
    state.drag = null;
    state.region = null;
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onDragMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('click', onClick, true);
    for (const t of BLOCKED) window.addEventListener(t, block, true);
  }

  // Нажатия не пропускаем к странице — иначе открытые меню и попапы закроются. Рамку области ведём
  // на pointer-событиях: после отменённого pointerdown браузер не присылает mousedown/mousemove/mouseup.
  const BLOCKED = ['mousedown', 'mouseup', 'dblclick', 'contextmenu', 'auxclick', 'touchstart', 'touchend', 'submit'];

  function stopPicking() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointermove', onDragMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('click', onClick, true);
    for (const t of BLOCKED) window.removeEventListener(t, block, true);
    if (ui) ui.bar.hidden = true;
  }

  // Клик, который браузер сгенерирует после mouseup, тоже не должен дойти до страницы.
  function swallowNextClick() {
    const fn = (e) => block(e);
    window.addEventListener('click', fn, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', fn, { capture: true }), 400);
  }

  function onDown(e) {
    if (isOurs(e)) return;
    block(e);
    if (e.button === 0) state.drag = { x: e.clientX, y: e.clientY, active: false };
  }

  function dragRect(e, d = state.drag) {
    const left = Math.min(d.x, e.clientX), top = Math.min(d.y, e.clientY);
    const width = Math.abs(e.clientX - d.x), height = Math.abs(e.clientY - d.y);
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  function onUp(e) {
    if (isOurs(e)) return;
    block(e);
    const d = state.drag;
    state.drag = null;
    if (!d?.active) return; // обычный клик — обработает onClick
    swallowNextClick();
    selectRegion(dragRect(e, d));
  }

  function block(e) {
    if (isOurs(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onDragMove(e) {
    if (!state.drag || isOurs(e)) return;
    block(e);
    if (!state.drag.active && Math.hypot(e.clientX - state.drag.x, e.clientY - state.drag.y) > 6) state.drag.active = true;
    if (state.drag.active) drawRect(dragRect(e), 'Область', { region: true });
  }

  function onMove(e) {
    if (isOurs(e) || state.drag?.active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host || el === state.hovered) return;
    if (state.childStack.length && state.hovered?.contains(el)) return; // пользователь поднялся к родителю — не сбрасываем
    state.hovered = el;
    state.childStack = [];
    drawHighlight(el);
  }

  function onClick(e) {
    if (isOurs(e)) return;
    block(e);
    const el = state.hovered || document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== host) select(el);
  }

  // Клавиатура: перехватываем на window в фазе захвата, раньше обработчиков страницы.
  listen(
    window,
    'keydown',
    (e) => {
      if (state.mode === 'picking') {
        if (e.key === 'Escape') cancel();
        else if (e.key === 'ArrowUp' && state.hovered?.parentElement && state.hovered !== document.body) {
          state.childStack.push(state.hovered);
          state.hovered = state.hovered.parentElement;
          drawHighlight(state.hovered);
        } else if (e.key === 'ArrowDown' && state.childStack.length) {
          state.hovered = state.childStack.pop();
          drawHighlight(state.hovered);
        } else if (e.key === 'Enter' && state.hovered) select(state.hovered);
        else return;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (state.mode === 'form' && isOurs(e)) {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (ui.panel.querySelector('.discard')) hideDiscard();
          else requestClose();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
        // Горячие клавиши сайта не должны срабатывать, пока пользователь печатает в форме.
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  for (const type of ['keyup', 'keypress', 'focusin', 'focusout']) {
    listen(window, type, (e) => state.mode === 'form' && isOurs(e) && e.stopImmediatePropagation(), true);
  }

  async function select(el) {
    stopPicking();
    state.mode = 'capturing';
    state.selected = el;
    state.region = null;
    state.elementInfo = elementInfo(el);
    state.styles = collectStyles(el);
    ui.hl.hidden = true;
    ui.busy.hidden = false;
    let list = null;
    try {
      if (isDropdownSelect(el)) {
        // Список нативного select рисует ОС — его нельзя снять. Показываем такой же список прямо на странице.
        list = openSelectList(el);
        const union = () => unionRect(el.getBoundingClientRect(), list.getBoundingClientRect());
        state.shot = await captureElement(el, { rectOf: union });
        state.shot.note = 'Список select раскрыт расширением: нативный выпадающий список рисует система, поэтому показана его копия';
      } else {
        state.shot = await captureElement(el);
      }
      list?.remove();
      list = null;
      openForm(el);
    } catch (err) {
      reset();
      showToast(`Не удалось сделать скриншот: ${err.message}`, { error: true });
    } finally {
      list?.remove();
      ui.busy.hidden = true;
    }
  }

  async function selectRegion(r) {
    stopPicking();
    state.mode = 'capturing';
    const anchor = commonAncestor(r);
    state.selected = null;
    state.region = { left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height };
    state.elementInfo = {
      ...(anchor ? elementInfo(anchor) : {}),
      name: `Область ${Math.round(r.width)}×${Math.round(r.height)}`,
      region: true,
      attributes: {}, // в области много элементов — атрибуты общего предка сбивали бы с толку
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
    state.styles = null; // в области много элементов — стили одного были бы обманчивы
    ui.hl.hidden = true;
    ui.busy.hidden = false;
    try {
      state.shot = await captureRegion(r);
      state.shot.note = 'Снимок области экрана';
      openForm(null);
    } catch (err) {
      reset();
      showToast(`Не удалось сделать скриншот: ${err.message}`, { error: true });
    } finally {
      ui.busy.hidden = true;
    }
  }

  // Ближайший общий предок элементов по углам и центру области.
  function commonAncestor(r) {
    const pts = [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2], [r.left + r.width / 2, r.top + r.height / 2]];
    const els = pts.map(([x, y]) => document.elementFromPoint(x, y)).filter((e) => e && e !== host);
    if (!els.length) return null;
    let anc = els[0];
    while (anc && !els.every((e) => anc.contains(e))) anc = anc.parentElement;
    return anc && anc !== document.documentElement ? anc : document.body;
  }

  function cancel() {
    reset();
  }

  function reset() {
    stopPicking();
    cancelAnimationFrame(state.rafId);
    state.mode = 'idle';
    state.hovered = null;
    state.selected = null;
    state.region = null;
    state.drag = null;
    state.shot = null;
    clearInterval(state.countdownTimer);
    if (ui) {
      ui.hl.hidden = true;
      ui.busy.hidden = true;
      ui.countdown.hidden = true;
      closePanel();
    }
  }

  // ---------- Скриншот элемента ----------

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function settle() {
    await nextFrame();
    await nextFrame();
    await sleep(120);
  }

  async function grab() {
    const res = await chrome.runtime.sendMessage({ type: 'drc:capture' });
    if (!res?.ok) throw new Error(res?.error || 'нет ответа от расширения');
    const b64 = res.dataUrl.slice(res.dataUrl.indexOf(',') + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // createImageBitmap из Blob не зависит от CSP страницы (в отличие от <img src="data:...">).
    return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  }

  // Фиксированные/липкие элементы (шапки, чаты, баннеры) перекрывают блок при прокрутке — прячем на время съёмки.
  function hideOverlays(target) {
    const hidden = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      if (node === host || node.contains(target) || target.contains(node)) continue;
      const pos = getComputedStyle(node).position;
      if (pos === 'fixed' || pos === 'sticky') {
        hidden.push([node, node.style.getPropertyValue('visibility'), node.style.getPropertyPriority('visibility')]);
        node.style.setProperty('visibility', 'hidden', 'important');
      }
    }
    return () => {
      for (const [node, value, prio] of hidden) {
        if (value) node.style.setProperty('visibility', value, prio);
        else node.style.removeProperty('visibility');
      }
    };
  }

  function unionRect(a, b) {
    const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top);
    const right = Math.max(a.right, b.right), bottom = Math.max(a.bottom, b.bottom);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  // Снимок прямоугольника экрана как есть: без прокрутки и без скрытия оверлеев (меню, попапы остаются).
  async function captureRegion(r) {
    host.style.display = 'none';
    try {
      await settle();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      const bmp = await grab();
      const scale = bmp.width / window.innerWidth;
      const x0 = Math.max(0, r.left), x1 = Math.min(vw, r.right);
      const y0 = Math.max(0, r.top), y1 = Math.min(vh, r.bottom);
      if (x1 - x0 < 2 || y1 - y0 < 2) throw new Error('слишком маленькая область');
      const canvas = document.createElement('canvas');
      canvas.width = Math.round((x1 - x0) * scale);
      canvas.height = Math.round((y1 - y0) * scale);
      canvas.getContext('2d').drawImage(bmp, x0 * scale, y0 * scale, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      bmp.close();
      return finish(canvas, false);
    } finally {
      host.style.display = 'block';
    }
  }

  async function captureElement(el, { rectOf = () => el.getBoundingClientRect() } = {}) {
    const startX = window.scrollX;
    const startY = window.scrollY;
    const html = document.documentElement;
    const prevScrollBehavior = html.style.scrollBehavior;
    html.style.scrollBehavior = 'auto';
    host.style.display = 'none';
    let restoreOverlays = () => {};

    try {
      const vw = html.clientWidth || window.innerWidth;
      const vh = html.clientHeight || window.innerHeight;
      let r = rectOf();
      if (r.width < 1 || r.height < 1) throw new Error('у элемента нулевой размер');

      restoreOverlays = hideOverlays(el);

      // Блок помещается в экран — один снимок.
      if (r.height <= vh) {
        if (r.top < 0 || r.bottom > vh || r.left < 0 || r.right > vw) {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          // Снимаемая область может быть больше самого элемента (раскрытый список) — докручиваем.
          const u = rectOf();
          if (u.bottom > vh) window.scrollBy({ top: u.bottom - vh + 4, behavior: 'instant' });
          else if (u.top < 0) window.scrollBy({ top: u.top - 4, behavior: 'instant' });
        }
        await settle();
        r = rectOf();
        const bmp = await grab();
        const scale = bmp.width / window.innerWidth;
        const x0 = Math.max(0, r.left), x1 = Math.min(vw, r.right);
        const y0 = Math.max(0, r.top), y1 = Math.min(vh, r.bottom);
        if (x1 <= x0 || y1 <= y0) throw new Error('элемент вне видимой области');
        const canvas = document.createElement('canvas');
        canvas.width = Math.round((x1 - x0) * scale);
        canvas.height = Math.round((y1 - y0) * scale);
        canvas.getContext('2d').drawImage(bmp, x0 * scale, y0 * scale, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        bmp.close();
        return finish(canvas, false);
      }

      // Блок выше экрана — прокручиваем и склеиваем несколько снимков.
      const docTop = r.top + window.scrollY;
      let canvas = null;
      let ctx = null;
      let scale = 1;
      let x0 = 0, x1 = 0;
      let captured = 0; // сколько CSS-пикселей блока уже снято
      let truncated = false;
      let totalHeight = r.height;

      for (let i = 0; captured < totalHeight - 0.5; i++) {
        if (i >= MAX_SEGMENTS) {
          truncated = true;
          break;
        }
        if (i === 0) el.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
        else window.scrollTo({ left: window.scrollX, top: docTop + captured, behavior: 'instant' });
        await settle();
        const cr = rectOf();
        const visBottomLocal = Math.min(cr.bottom, vh) - cr.top; // нижняя видимая граница в координатах блока
        if (visBottomLocal <= captured + 0.5) {
          truncated = true; // страница не прокручивается дальше (блок во внутреннем скролл-контейнере)
          break;
        }
        const bmp = await grab();
        if (!canvas) {
          scale = bmp.width / window.innerWidth;
          x0 = Math.max(0, cr.left);
          x1 = Math.min(vw, cr.right);
          totalHeight = Math.min(cr.height, MAX_SHOT_PX / scale);
          canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round((x1 - x0) * scale));
          canvas.height = Math.max(1, Math.round(totalHeight * scale));
          ctx = canvas.getContext('2d');
        }
        const fromLocal = Math.max(captured, -cr.top); // верхняя видимая граница
        const toLocal = Math.min(visBottomLocal, totalHeight);
        const sy = (cr.top + fromLocal) * scale;
        const h = (toLocal - fromLocal) * scale;
        ctx.drawImage(bmp, x0 * scale, sy, canvas.width, h, 0, fromLocal * scale, canvas.width, h);
        bmp.close();
        captured = toLocal;
      }
      if (!canvas) throw new Error('не удалось снять элемент');
      if (captured < totalHeight - 0.5) {
        // обрезаем пустой хвост
        const cut = document.createElement('canvas');
        cut.width = canvas.width;
        cut.height = Math.max(1, Math.round(captured * scale));
        cut.getContext('2d').drawImage(canvas, 0, 0);
        canvas = cut;
      }
      return finish(canvas, truncated || totalHeight < r.height);
    } finally {
      restoreOverlays();
      window.scrollTo({ left: startX, top: startY, behavior: 'instant' });
      html.style.scrollBehavior = prevScrollBehavior;
      host.style.display = 'block';
    }
  }

  function finish(canvas, truncated) {
    let dataUrl = canvas.toDataURL('image/png');
    // Большие PNG раздувают хранилище и отчёт — для них используем JPEG.
    if (dataUrl.length > 2.5 * 1024 * 1024) dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    return { dataUrl, width: canvas.width, height: canvas.height, canvas, truncated };
  }

  // ---------- Форма замечания ----------

  // ---------- Стили и данные элемента ----------

  function parseColor(str) {
    const m = String(str).match(/^rgba?\(([^)]+)\)$/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  function hex({ r, g, b, a = 1 }) {
    const h = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}${a < 1 ? h(a * 255) : ''}`.toUpperCase();
  }

  // rgb()/rgba() внутри любых значений (тени, градиенты, рамки) → HEX.
  const hexify = (v) =>
    String(v)
      .replace(/rgba?\([^)]+\)/g, (m) => (parseColor(m) ? hex(parseColor(m)) : m))
      // #abc → #AABBCC, регистр единый — чтобы у всех цветов был образец
      .replace(/#([0-9a-f]{3,8})\b/gi, (m, h) => (h.length === 3 || h.length === 4 ? `#${[...h].map((c) => c + c).join('')}` : m).toUpperCase());
  const clip = (v, n = 160) => (v.length > n ? v.slice(0, n) + '…' : v);

  function shorthand(values) {
    const [t, r, b, l] = values;
    if (r === l) return t === b ? (t === r ? t : `${t} ${r}`) : `${t} ${r} ${b}`;
    return values.join(' ');
  }

  const sides = (cs, fmt) => ['top', 'right', 'bottom', 'left'].map((s) => cs.getPropertyValue(fmt(s)));

  function blend(top, bottom) {
    const a = top.a + bottom.a * (1 - top.a);
    if (!a) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (k) => (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / a;
    return { r: mix('r'), g: mix('g'), b: mix('b'), a };
  }

  function luminance({ r, g, b }) {
    const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  // Фон, который реально виден под элементом: смешиваем полупрозрачные фоны предков до первого непрозрачного.
  function effectiveBackground(el) {
    const layers = [];
    let approx = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== 'none') approx = true;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let color = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) color = blend(layers[i], color);
    return { color, approx };
  }

  // Первый видимый текст внутри элемента — для него считаем контраст.
  function textHost(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.textContent.trim() && n.parentElement?.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const t = walker.nextNode();
    return t ? { node: t.parentElement, sample: t.textContent.trim().replace(/\s+/g, ' ').slice(0, 40) } : null;
  }

  function contrastInfo(el) {
    const t = textHost(el);
    if (!t) return null;
    const cs = getComputedStyle(t.node);
    const fg0 = parseColor(cs.color);
    if (!fg0) return null;
    const { color: bg, approx } = effectiveBackground(t.node);
    const fg = blend(fg0, bg);
    const l1 = luminance(fg), l2 = luminance(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    return {
      ratio: Math.round(ratio * 100) / 100,
      aa: ratio >= (large ? 3 : 4.5),
      aaa: ratio >= (large ? 4.5 : 7),
      large,
      text: hex(fg),
      background: hex(bg),
      approx,
      sample: t.sample,
    };
  }

  function collectStyles(el) {
    const cs = getComputedStyle(el);
    const v = (p) => cs.getPropertyValue(p).trim();
    const groups = [];
    const add = (title, rows) => {
      rows = rows.filter(([, value]) => value);
      if (rows.length) groups.push({ title, rows: rows.map(([k, value]) => [k, clip(hexify(value))]) });
    };
    const rect = el.getBoundingClientRect();
    const not = (value, ...skip) => (skip.includes(value) ? '' : value);
    const hasText = !!textHost(el);
    const flex = /flex/.test(v('display'));
    const grid = /grid/.test(v('display'));

    add('Размер', [
      ['width', `${Math.round(rect.width * 100) / 100}px`],
      ['height', `${Math.round(rect.height * 100) / 100}px`],
      ['min-width', not(v('min-width'), 'auto', '0px')],
      ['max-width', not(v('max-width'), 'none')],
      ['min-height', not(v('min-height'), 'auto', '0px')],
      ['max-height', not(v('max-height'), 'none')],
    ]);
    add('Отступы', [
      ['padding', not(shorthand(sides(cs, (s) => `padding-${s}`)), '0px')],
      ['margin', not(shorthand(sides(cs, (s) => `margin-${s}`)), '0px')],
      ['gap', flex || grid ? not(v('gap'), 'normal', 'normal normal') : ''],
    ]);
    if (hasText) {
      add('Типографика', [
        ['font-family', v('font-family')],
        ['font-size', v('font-size')],
        ['font-weight', v('font-weight')],
        ['line-height', v('line-height')],
        ['letter-spacing', not(v('letter-spacing'), 'normal')],
        ['font-style', not(v('font-style'), 'normal')],
        ['text-align', not(v('text-align'), 'start')],
        ['text-transform', not(v('text-transform'), 'none')],
        ['text-decoration', not(v('text-decoration-line'), 'none')],
      ]);
    }
    const bgColor = parseColor(v('background-color'));
    add('Цвета', [
      ['color', hasText ? v('color') : ''],
      ['background-color', bgColor && bgColor.a > 0 ? v('background-color') : ''],
      ['background-image', not(v('background-image'), 'none').replace(/url\("?data:[^)]*\)/g, 'url(data:…)')],
      ['opacity', not(v('opacity'), '1')],
    ]);
    const widths = sides(cs, (s) => `border-${s}-width`);
    const styles = sides(cs, (s) => `border-${s}-style`);
    const colors = sides(cs, (s) => `border-${s}-color`);
    const hasBorder = widths.some((w, i) => parseFloat(w) > 0 && styles[i] !== 'none');
    const uniform = new Set(widths).size === 1 && new Set(styles).size === 1 && new Set(colors).size === 1;
    const radius = shorthand(['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((c) => v(`border-${c}-radius`)));
    add('Рамка', [
      ['border', hasBorder && uniform ? `${widths[0]} ${styles[0]} ${colors[0]}` : ''],
      ['border-width', hasBorder && !uniform ? shorthand(widths) : ''],
      ['border-style', hasBorder && !uniform ? shorthand(styles) : ''],
      ['border-color', hasBorder && !uniform ? shorthand(colors) : ''],
      ['border-radius', not(radius, '0px')],
      ['outline', v('outline-style') !== 'none' && parseFloat(v('outline-width')) > 0 ? `${v('outline-width')} ${v('outline-style')} ${v('outline-color')}` : ''],
    ]);
    add('Эффекты', [
      ['box-shadow', not(v('box-shadow'), 'none')],
      ['filter', not(v('filter'), 'none')],
      ['backdrop-filter', not(v('backdrop-filter'), 'none')],
      ['transform', not(v('transform'), 'none')],
      ['cursor', not(v('cursor'), 'auto')],
    ]);
    add('Раскладка', [
      ['display', v('display')],
      ['position', not(v('position'), 'static')],
      ['flex-direction', flex ? v('flex-direction') : ''],
      ['flex-wrap', flex ? not(v('flex-wrap'), 'nowrap') : ''],
      ['justify-content', flex || grid ? not(v('justify-content'), 'normal') : ''],
      ['align-items', flex || grid ? not(v('align-items'), 'normal') : ''],
      ['grid-template-columns', grid ? not(v('grid-template-columns'), 'none') : ''],
      ['z-index', not(v('z-index'), 'auto')],
      ['overflow', not(v('overflow'), 'visible', 'visible visible')],
    ]);
    const variables = collectVariables(el);
    if (variables.used.length) groups.push({ title: 'Свойства через переменные', kind: 'vars', rows: variables.used.map(([k, a, r]) => [k, arrow(a, r)]) });
    if (variables.defined.length) groups.push({ title: 'Переменные элемента', kind: 'vars', rows: variables.defined.map(([k, a, r]) => [k, arrow(a, r)]) });
    if (variables.inherited.length) groups.push({ title: 'Переменные из родителей', kind: 'vars', rows: variables.inherited });
    const notes = [];
    if (variables.blocked) notes.push(`${variables.blocked} табл. стилей с другого домена недоступны браузеру — переменные из них не видны`);
    if (variables.truncated) notes.push('Показаны не все переменные — их слишком много');
    return { groups, contrast: contrastInfo(el), variables, notes };
  }

  const arrow = (authored, resolved) => (!resolved || authored === resolved ? authored : `${authored} → ${resolved}`);

  // ---------- CSS-переменные ----------
  // Значения var(...) видны только в исходных правилах — вычисленные стили их уже подставили.
  // Поэтому проходим по таблицам стилей, берём правила, подходящие элементу, и разворачиваем переменные через getComputedStyle.

  const VAR_RE = /var\(\s*(--[\w-]+)/g;
  const MAX_VARS = 60;

  // «a: b; c: var(--x, rgb(1, 2, 3))» → [{ prop, value, important }] с учётом скобок и кавычек.
  function parseDeclarations(cssText) {
    const out = [];
    let depth = 0, quote = '', start = 0;
    const push = (chunk) => {
      const i = chunk.indexOf(':');
      if (i < 1) return;
      let value = chunk.slice(i + 1).trim();
      const important = /!\s*important$/i.test(value);
      if (important) value = value.replace(/!\s*important$/i, '').trim();
      out.push({ prop: chunk.slice(0, i).trim(), value, important });
    };
    for (let i = 0; i < cssText.length; i++) {
      const ch = cssText[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ';' && depth === 0) {
        push(cssText.slice(start, i));
        start = i + 1;
      }
    }
    push(cssText.slice(start));
    return out;
  }

  function matchedDeclarations(el) {
    const decls = [];
    let blocked = 0;
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          let ok = false;
          try {
            ok = el.matches(rule.selectorText);
          } catch {}
          if (ok) decls.push(...parseDeclarations(rule.style.cssText));
          if (rule.cssRules?.length) visit(rule.cssRules); // CSS nesting
        } else if (rule.cssRules) {
          if (rule instanceof CSSMediaRule && !matchMedia(rule.media.mediaText).matches) continue;
          if (rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue;
          visit(rule.cssRules); // @layer, @container, @scope и т.п.
        }
      }
    };
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
    const root = el.getRootNode();
    if (root instanceof ShadowRoot) sheets.push(...root.styleSheets, ...(root.adoptedStyleSheets || []));
    for (const sheet of sheets) {
      if (sheet.disabled || (sheet.media?.mediaText && !matchMedia(sheet.media.mediaText).matches)) continue;
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        blocked++; // CSS с другого домена без CORS
        continue;
      }
      visit(rules);
    }
    decls.push(...parseDeclarations(el.getAttribute('style') || '')); // inline-стили — последними
    return { decls, blocked };
  }

  function collectVariables(el) {
    const { decls, blocked } = matchedDeclarations(el);
    const cs = getComputedStyle(el);
    // Каскад упрощённо: побеждает последнее объявление, !important — сильнее (специфичность не учитываем).
    const win = new Map();
    for (const d of decls) {
      const prev = win.get(d.prop);
      if (!prev || d.important || !prev.important) win.set(d.prop, d);
    }
    const used = [], defined = [], refs = new Set();
    for (const [prop, d] of win) {
      const resolved = hexify(cs.getPropertyValue(prop).trim());
      if (prop.startsWith('--')) defined.push([prop, clip(d.value), clip(resolved)]);
      else if (d.value.includes('var(')) used.push([prop, clip(d.value), clip(resolved)]);
      else continue;
      for (const m of d.value.matchAll(VAR_RE)) refs.add(m[1]);
    }
    const own = new Set(defined.map(([name]) => name));
    const inherited = [...refs].filter((name) => !own.has(name)).map((name) => [name, clip(hexify(cs.getPropertyValue(name).trim()) || '— не задана')]);
    const truncated = used.length > MAX_VARS || defined.length > MAX_VARS || inherited.length > MAX_VARS;
    return { used: used.slice(0, MAX_VARS), defined: defined.slice(0, MAX_VARS), inherited: inherited.slice(0, MAX_VARS), blocked, truncated };
  }

  const ATTR_KEEP = /^(id|class|role|title|alt|href|src|type|name|placeholder|for|target|disabled|tabindex|aria-.+|data-(testid|test-id|test|qa|cy|qa-id)[\w-]*)$/;
  function attributesOf(el) {
    const out = {};
    for (const a of el.attributes) if (ATTR_KEEP.test(a.name)) out[a.name] = clip(a.value, 200);
    return out;
  }

  // ---------- Нативный select: эмуляция раскрытого списка ----------

  const isDropdownSelect = (el) => el.tagName === 'SELECT' && !el.multiple && el.size <= 1 && el.options.length > 0;

  function openSelectList(sel) {
    const r = sel.getBoundingClientRect();
    const cs = getComputedStyle(sel);
    const list = document.createElement('div');
    list.setAttribute('data-drc-select-list', '');
    list.style.cssText = `position:absolute;z-index:2147483646;left:${r.left + window.scrollX}px;top:${r.bottom + window.scrollY + 2}px;
      min-width:${r.width}px;max-width:${Math.max(r.width, 480)}px;box-sizing:border-box;background:#fff;color:#111;
      border:1px solid rgba(0,0,0,.18);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px 0;
      font-family:${cs.fontFamily};font-size:${cs.fontSize};line-height:1.35;text-align:left;`;
    const MAX = 15;
    let shown = 0;
    for (const child of sel.children) {
      if (shown >= MAX) break;
      const items = child.tagName === 'OPTGROUP' ? [child, ...child.children] : [child];
      for (const item of items) {
        if (shown >= MAX) break;
        const row = document.createElement('div');
        row.textContent = item.tagName === 'OPTGROUP' ? item.label : item.text;
        let css = 'padding:4px 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        if (item.tagName === 'OPTGROUP') css += 'font-weight:700;color:#555;';
        else {
          if (child.tagName === 'OPTGROUP') css += 'padding-left:24px;';
          if (item.selected) css += 'background:#0a64d8;color:#fff;';
          if (item.disabled) css += 'color:#999;';
          shown++;
        }
        row.style.cssText = css;
        list.append(row);
      }
    }
    if (sel.options.length > shown) {
      const more = document.createElement('div');
      more.textContent = `… ещё ${sel.options.length - shown}`;
      more.style.cssText = 'padding:4px 12px;color:#888;font-style:italic;';
      list.append(more);
    }
    document.body.append(list);
    return list;
  }

  function cssPath(el) {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter((c) => c && !/\d{3,}|[:[\]]/.test(c)) : [];
      if (cls.length) part += '.' + cls.slice(0, 2).map((c) => CSS.escape(c)).join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function elementInfo(el) {
    const rect = el.getBoundingClientRect();
    return {
      selector: cssPath(el),
      name: describe(el),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      attributes: attributesOf(el),
    };
  }

  function formHasInput() {
    return [...ui.panel.querySelectorAll('input, textarea')].some((f) => f.value.trim());
  }

  function normalizeUrl(value) {
    const v = value.trim();
    if (!v) return { ok: true, url: '' };
    for (const candidate of [v, `https://${v}`]) {
      try {
        const u = new URL(candidate);
        if (/^https?:$/.test(u.protocol) && u.hostname.includes('.')) return { ok: true, url: u.href };
      } catch {}
    }
    return { ok: false };
  }

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  const swatches = (escaped) => escaped.replace(/#[0-9A-F]{6}(?:[0-9A-F]{2})?\b/gi, (h) => `<span class="sw" style="background:${h}"></span>${h}`);

  function contrastHtml(c) {
    if (!c) return '';
    const badge = (label, ok) => `<span class="${ok ? 'pass' : 'fail'}">${label} ${I(ok ? 'check' : 'xmark', 12)}</span>`;
    return `<div class="contrast"><span>Контраст</span><b>${c.ratio}:1</b>${badge('AA', c.aa)}${badge('AAA', c.aaa)}
      <span>${swatches(esc(c.text))} на ${swatches(esc(c.background))}</span>${c.approx ? '<span class="muted">≈ фон — градиент/картинка</span>' : ''}</div>`;
  }

  function specsHtml(styles, attrs) {
    const dl = (rows) => `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${swatches(esc(v))}</dd>`).join('')}</dl>`;
    const blocks = (styles?.groups || []).map((g) => `<div class="spec-group"><h4>${esc(g.title)}</h4>${dl(g.rows)}</div>`);
    const attrRows = Object.entries(attrs || {});
    if (attrRows.length) blocks.push(`<div class="spec-group"><h4>Атрибуты</h4>${dl(attrRows)}</div>`);
    for (const note of styles?.notes || []) blocks.push(`<div class="muted">${I('warning', 12)} ${esc(note)}</div>`);
    if (!blocks.length) return '';
    return `<details class="specs"><summary>Стили и данные элемента<span class="spacer"></span><button type="button" class="btn-light" data-act="copy-css">${I('copy', 12)} Копировать CSS</button></summary>
      <div class="specs-body">${blocks.join('')}</div></details>`;
  }

  // Вычисленные значения; для свойств через переменные — авторское var(...), чтобы сразу видеть токены.
  function stylesAsCss(styles) {
    const viaVar = new Map((styles?.variables?.used || []).map(([k, authored]) => [k, authored]));
    const lines = (styles?.groups || [])
      .filter((g) => !g.kind)
      .flatMap((g) => g.rows.map(([k, v]) => `  ${k}: ${viaVar.get(k) || v};`));
    for (const [k, authored] of styles?.variables?.used || []) {
      if (!lines.some((l) => l.startsWith(`  ${k}:`))) lines.push(`  ${k}: ${authored};`);
    }
    const vars = styles?.variables;
    if (vars?.defined.length) lines.push('', '  /* Переменные элемента */', ...vars.defined.map(([k, a, r]) => `  ${k}: ${a};${r && r !== a ? ` /* = ${r} */` : ''}`));
    if (vars?.inherited.length) lines.push('', '  /* Из родителей */', ...vars.inherited.map(([k, r]) => `  /* ${k}: ${r} */`));
    return lines.join('\n');
  }

  function openForm(el) {
    state.mode = 'form';
    state.severity = DEFAULT_SEVERITY;
    const g = state.region;
    const r = el ? el.getBoundingClientRect() : { left: g.left - window.scrollX, width: g.width, height: g.height };
    state.panelLeft = r.left + r.width / 2 > window.innerWidth / 2 && r.left > 420;

    const p = ui.panel;
    p.classList.toggle('left', state.panelLeft);
    p.innerHTML = `
      <div class="panel-head">
        <h2>Новое замечание<span class="sub"></span></h2>
        <button class="icon-btn" data-act="side" title="Переместить панель">${I('swap', 16)}</button>
        <button class="icon-btn" data-act="cancel" title="Отмена (Esc)">${I('xmark', 16)}</button>
      </div>
      <div class="panel-body">
        <div class="shot"></div>
        <div class="shot-meta"></div>
        ${contrastHtml(state.styles?.contrast)}
        ${specsHtml(state.styles, state.elementInfo?.attributes)}
        <label><span>Название <span class="req">*</span></span>
          <input type="text" name="title" maxlength="200" placeholder="Например: Отступ кнопки не совпадает с макетом">
          <span class="err" data-err="title" hidden>Укажите название</span>
        </label>
        <label>Описание
          <textarea name="description" placeholder="Что не так, как должно быть, шаги воспроизведения"></textarea>
        </label>
        <label>Критичность
          <div class="sev">${SEVERITIES.map(
            (s) => `<button type="button" data-sev="${s.id}" style="--fg:${s.color};--bg:${s.bg}" aria-pressed="${s.id === DEFAULT_SEVERITY}">${s.label}</button>`,
          ).join('')}</div>
        </label>
        <label>Ссылка на макет
          <input type="url" name="mockup" placeholder="Ссылка">
          <span class="err" data-err="mockup" hidden>Похоже, это не ссылка</span>
        </label>
      </div>
      <div class="panel-foot">
        <button class="btn-light" data-act="repick">Другой элемент</button>
        <span class="spacer"></span>
        <span class="hint">⌘/Ctrl+Enter</span>
        <button class="btn-primary" data-act="save">Сохранить</button>
      </div>
    `;
    p.querySelector('.sub').textContent = `Ревью: ${state.review?.title || '—'}`;
    const shotBox = p.querySelector('.shot');
    shotBox.append(state.shot.canvas);
    p.querySelector('.shot-meta').textContent =
      (el ? `${describe(el)} · ${Math.round(r.width)}×${Math.round(r.height)}` : state.elementInfo.name) +
      (state.shot.truncated ? ' · снят не целиком' : '') +
      (state.shot.note && el ? ' · список раскрыт расширением' : '');
    p.querySelector('[data-act=copy-css]')?.addEventListener('click', async (e) => {
      e.preventDefault(); // не сворачивать <details>
      const btn = e.currentTarget;
      const css = `${state.elementInfo?.selector || describe(el)} {\n${stylesAsCss(state.styles)}\n}`;
      try {
        await navigator.clipboard.writeText(css);
        btn.innerHTML = `${I('check', 12)} Скопировано`;
      } catch {
        btn.textContent = 'Не удалось';
      }
      setTimeout(() => (btn.innerHTML = `${I('copy', 12)} Копировать CSS`), 1500);
    });

    p.querySelector('[data-act=cancel]').addEventListener('click', requestClose);
    p.querySelector('[data-act=side]').addEventListener('click', () => {
      state.panelLeft = !state.panelLeft;
      p.classList.toggle('left', state.panelLeft);
    });
    p.querySelector('[data-act=repick]').addEventListener('click', () => startPicking());
    p.querySelector('[data-act=save]').addEventListener('click', save);
    p.querySelectorAll('[data-sev]').forEach((btn) =>
      btn.addEventListener('click', () => {
        state.severity = btn.dataset.sev;
        p.querySelectorAll('[data-sev]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      }),
    );
    p.hidden = false;
    trackSelected();
    setTimeout(() => p.querySelector('[name=title]').focus(), 0);
  }

  // Закрытие формы: если что-то введено — предупреждение прямо в панели (системный confirm показал бы «Confirm action on <id>»).
  function requestClose() {
    if (!formHasInput()) return cancel();
    if (ui.panel.querySelector('.discard')) return;
    const box = document.createElement('div');
    box.className = 'discard';
    box.innerHTML = `
      <div class="discard-head">${I('warning', 16)} Предупреждение</div>
      <div class="discard-q">Закрыть замечание без сохранения?</div>
      <div class="discard-note">Введённые название, описание и ссылка не сохранятся.</div>
      <div class="discard-actions">
        <button type="button" class="btn-light" data-act="stay">Остаться</button>
        <button type="button" class="btn-danger" data-act="discard">Закрыть без сохранения</button>
      </div>`;
    box.querySelector('[data-act=stay]').addEventListener('click', hideDiscard);
    box.querySelector('[data-act=discard]').addEventListener('click', cancel);
    ui.panel.append(box);
    box.querySelector('[data-act=stay]').focus();
  }

  function hideDiscard() {
    ui.panel.querySelector('.discard')?.remove();
    ui.panel.querySelector('[name=title]')?.focus();
  }

  function closePanel() {
    if (!ui) return;
    ui.panel.hidden = true;
    ui.panel.innerHTML = '';
  }

  async function save() {
    if (state.mode !== 'form') return;
    const p = ui.panel;
    const titleEl = p.querySelector('[name=title]');
    const mockupEl = p.querySelector('[name=mockup]');
    const title = titleEl.value.trim();
    const link = normalizeUrl(mockupEl.value);

    titleEl.classList.toggle('invalid', !title);
    p.querySelector('[data-err=title]').hidden = !!title;
    mockupEl.classList.toggle('invalid', !link.ok);
    p.querySelector('[data-err=mockup]').hidden = link.ok;
    if (!title) return titleEl.focus();
    if (!link.ok) return mockupEl.focus();

    const issue = {
      title,
      description: p.querySelector('[name=description]').value.trim(),
      severity: state.severity,
      mockupUrl: link.url,
      screenshot: state.shot.dataUrl,
      screenshotSize: { width: state.shot.width, height: state.shot.height },
      screenshotTruncated: state.shot.truncated,
      screenshotNote: state.shot.note || '',
      styles: state.styles,
      page: { url: location.href, title: document.title },
      element: state.elementInfo,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    };

    const btn = p.querySelector('[data-act=save]');
    btn.disabled = true;
    btn.textContent = 'Сохраняю…';
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'drc:saveIssue', reviewId: state.review.id, issue });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!res?.ok) {
      btn.disabled = false;
      btn.textContent = 'Сохранить';
      showToast(`Не сохранилось: ${res?.error || 'расширение недоступно — обновите страницу'}`, { error: true });
      return;
    }
    state.review = res.review;
    reset();
    showToast(`Замечание №${res.number} сохранено в «${res.review.title}»`, {
      actions: [
        { label: 'Ещё элемент', primary: true, run: () => startPicking() },
        { label: 'Открыть ревью', run: () => chrome.runtime.sendMessage({ type: 'drc:openReview', reviewId: state.review.id }) },
      ],
    });
  }

  // ---------- Уведомления ----------

  function showToast(text, { error = false, actions = [] } = {}) {
    ensureUi();
    clearTimeout(state.toastTimer);
    const t = ui.toast;
    t.className = `toast${error ? ' error' : ''}`;
    t.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = text;
    t.append(span);
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = a.primary ? 'btn-primary' : 'btn-ghost';
      b.textContent = a.label;
      b.addEventListener('click', () => {
        hideToast();
        a.run();
      });
      t.append(b);
    }
    const close = document.createElement('button');
    close.className = 'btn-ghost';
    close.innerHTML = I('xmark', 14);
    close.title = 'Закрыть';
    close.addEventListener('click', hideToast);
    t.append(close);
    t.hidden = false;
    state.toastTimer = setTimeout(hideToast, error ? 8000 : 7000);
  }

  function hideToast() {
    clearTimeout(state.toastTimer);
    if (ui) ui.toast.hidden = true;
  }

  // ---------- Таймер перед выбором: успеть открыть меню, попап, hover-состояние ----------

  function startCountdown(seconds, review) {
    if (review) state.review = review;
    ensureUi();
    reset();
    hideToast();
    state.mode = 'countdown';
    let left = seconds;
    const tick = () => {
      if (left <= 0) {
        clearInterval(state.countdownTimer);
        ui.countdown.hidden = true;
        startPicking();
        return;
      }
      ui.countdown.querySelector('b').textContent = String(left);
      left--;
    };
    ui.countdown.hidden = false;
    tick();
    state.countdownTimer = setInterval(tick, 1000);
  }

  // ---------- Сообщения от расширения ----------

  function onMessage(msg, _sender, sendResponse) {
    if (msg?.type === 'drc:ping') {
      sendResponse({ pong: true });
      return;
    }
    if (msg?.type === 'drc:start') {
      if (state.mode === 'form' || state.mode === 'capturing') {
        // Форма уже открыта — не теряем введённое.
        sendResponse({ ok: true, busy: true });
        return;
      }
      if (msg.delay > 0) startCountdown(msg.delay, msg.review);
      else startPicking(msg.review);
      sendResponse({ ok: true });
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);

  globalThis.__drcInstance = {
    alive() {
      try {
        return !!chrome.runtime?.id;
      } catch {
        return false;
      }
    },
    destroy() {
      try {
        reset();
        hideToast();
      } catch {}
      cleanups.forEach((fn) => fn());
      host?.remove();
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {}
    },
  };
})();
