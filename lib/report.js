// Сборка отчёта по ревью. Один и тот же HTML используется
// для скачивания (самодостаточный файл со встроенными скриншотами) и для печати в PDF.
import { severityOf } from './constants.js';
import { safeHref } from './url.js';
import { icon, ICONS } from './icons.js';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}


export function formatDate(ts) {
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function reportFileName(review, ext) {
  const date = new Date().toISOString().slice(0, 10);
  const name = (review.title || 'review').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `Дизайн-ревью — ${name} — ${date}.${ext}`;
}

// Блок «Стили и данные элемента» — общий для отчёта и страницы ревью.
export const SPECS_CSS = `
  .specs { margin: 12px 0 0; border: 1px solid #e7e2f1; border-radius: 10px; background: #fcfbfe; font-size: 12px; }
  .specs > summary { cursor: pointer; padding: 8px 12px; font-weight: 700; color: #4a4060; }
  .specs-body { padding: 2px 12px 12px; display: grid; gap: 10px; }
  .contrast { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; color: #4a4060; }
  .contrast b { font-size: 15px; color: #1d1530; }
  .contrast .muted { color: #8a819c; }
  .pass, .fail { font-weight: 700; font-size: 11px; padding: 1px 8px; border-radius: 999px; }
  .pass { background: #dcfce7; color: #166534; }
  .fail { background: #fee2e2; color: #991b1b; }
  .spec-groups { display: flex; flex-direction: column; gap: 8px; }
  .spec-group { background: #fff; border: 1px solid #eee9f6; border-radius: 8px; padding: 8px 12px; break-inside: avoid; }
  .spec-group h4 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #8a819c; }
  .spec-group dl { display: grid; grid-template-columns: 220px 1fr; gap: 3px 16px; margin: 0; }
  .spec-group dt { color: #6f6684; font: 11px/1.5 ui-monospace, Menlo, monospace; }
  .spec-group dd { margin: 0; font: 11px/1.5 ui-monospace, Menlo, monospace; word-break: break-word; color: #1d1530; }
  .spec-note { color: #8a819c; font-size: 11px; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; border: 1px solid rgba(0,0,0,.25); vertical-align: -1px; margin-right: 4px; }
`;

const HEX = /#[0-9A-F]{6}(?:[0-9A-F]{2})?\b/gi;
// Значение уже экранировано; добавляем образец цвета перед каждым HEX.
const withSwatches = (escaped) => escaped.replace(HEX, (h) => `<span class="sw" style="background:${h}"></span>${h}`);

export function specsHtml(issue, { open = true } = {}) {
  const st = issue.styles;
  const attrs = issue.element?.attributes || {};
  const groups = st?.groups || [];
  if (!groups.length && !st?.contrast && !Object.keys(attrs).length) return '';
  const c = st?.contrast;
  const badge = (label, ok) => `<span class="${ok ? 'pass' : 'fail'}">${label} ${icon(ok ? 'check' : 'xmark', 12)}</span>`;
  const contrast = c
    ? `<div class="contrast"><span>Контраст текста</span><b>${c.ratio}:1</b>${badge('AA', c.aa)}${badge('AAA', c.aaa)}
        <span>${withSwatches(escapeHtml(c.text))} на ${withSwatches(escapeHtml(c.background))}</span>
        <span class="muted">${c.large ? 'крупный текст' : 'обычный текст'}${c.sample ? ` · «${escapeHtml(c.sample)}»` : ''}</span>
        ${c.approx ? '<span class="muted">≈ под текстом градиент или картинка — проверьте вручную</span>' : ''}</div>`
    : '';
  const dl = (rows) => `<dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${withSwatches(escapeHtml(v))}</dd>`).join('')}</dl>`;
  const blocks = groups.map((g) => `<div class="spec-group"><h4>${escapeHtml(g.title)}</h4>${dl(g.rows)}</div>`);
  const attrRows = Object.entries(attrs);
  if (attrRows.length) blocks.push(`<div class="spec-group"><h4>Атрибуты</h4>${dl(attrRows)}</div>`);
  for (const note of st?.notes || []) blocks.push(`<div class="spec-note">${icon('warning', 12)} ${escapeHtml(note)}</div>`);
  return `<details class="specs"${open ? ' open' : ''}><summary>Стили и данные элемента</summary>
    <div class="specs-body">${contrast}<div class="spec-groups">${blocks.join('')}</div></div></details>`;
}

export const REPORT_CSS = `
  :root { --ink: #1d1530; --muted: #6f6684; --line: #e7e2f1; --accent: #7c3aed; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; background: #f6f4fa; color: var(--ink); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "YS Text", Roboto, Arial, sans-serif; }
  .report { max-width: 980px; margin: 0 auto; padding: 40px 32px 64px; }
  a { color: var(--accent); }
  .r-head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-end; padding-bottom: 20px; border-bottom: 2px solid var(--ink); }
  .r-kicker { text-transform: uppercase; letter-spacing: .08em; font-size: 11px; font-weight: 700; color: var(--accent); }
  .r-head h1 { margin: 4px 0 6px; font-size: 28px; line-height: 1.2; }
  .r-meta { color: var(--muted); font-size: 13px; }
  .r-total { text-align: right; white-space: nowrap; }
  .r-total b { display: block; font-size: 36px; line-height: 1; }
  .r-total span { color: var(--muted); font-size: 12px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--bg); color: var(--fg); border: 1px solid color-mix(in srgb, var(--fg) 30%, transparent); white-space: nowrap; }
  .chip i { width: 8px; height: 8px; border-radius: 50%; background: var(--fg); }
  .r-tasks { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 16px 0 6px; }
  .task { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: #fff; border: 1px solid var(--line); border-radius: 10px; color: inherit; text-decoration: none; min-width: 0; }
  a.task:hover { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124, 58, 237, .12); }
  .task-icon { flex: none; width: 34px; height: 34px; border-radius: 8px; display: grid; place-items: center; font-size: 16px; background: #f1eefa; }
  .task-text { min-width: 0; display: flex; flex-direction: column; }
  .task-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .task-link { font-size: 14px; font-weight: 600; color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task.empty .task-link { color: var(--muted); font-weight: 400; font-style: italic; }
  .task.empty .task-icon { opacity: .5; }
  .r-tasks.r-pages { margin-top: 0; }
  .r-pages .task:only-child { grid-column: 1 / -1; }
  .task-sub { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  h2.r-section { font-size: 16px; margin: 32px 0 12px; }
  table.toc { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; font-size: 13px; }
  .toc th, .toc td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .toc th { background: #faf9fc; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .toc tr:last-child td { border-bottom: 0; }
  .toc td.num { width: 44px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .toc a { color: inherit; text-decoration: none; }
  .issue { background: #fff; border: 1px solid var(--line); border-left: 4px solid var(--fg); border-radius: 12px; padding: 20px 22px; margin: 0 0 18px; break-inside: avoid; page-break-inside: avoid; }
  .issue-head { display: flex; gap: 12px; align-items: flex-start; }
  .issue-num { font-weight: 800; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 34px; font-size: 18px; line-height: 1.3; }
  .issue-head h3 { margin: 0; font-size: 18px; line-height: 1.3; flex: 1; }
  .shot { margin: 14px 0; background: repeating-conic-gradient(#f4f2f8 0 25%, #fff 0 50%) 0 0 / 16px 16px; border: 1px solid var(--line); border-radius: 8px; padding: 12px; text-align: center; }
  .shot img { max-width: 100%; max-height: 640px; height: auto; display: inline-block; box-shadow: 0 1px 4px rgba(20,10,40,.12); cursor: zoom-in; }
  .shot-hint { font-size: 11px; color: var(--muted); margin-top: 6px; }
  .shot-note { font-size: 11px; color: var(--muted); margin-top: 6px; }
  .desc { white-space: pre-wrap; margin: 0 0 12px; }
  .desc.empty { color: var(--muted); font-style: italic; }
  dl.props { display: grid; grid-template-columns: 140px 1fr; gap: 4px 12px; margin: 0; font-size: 12px; }
  .props dt { color: var(--muted); }
  .props dd { margin: 0; word-break: break-all; }
  .props code { font: 11px ui-monospace, Menlo, monospace; background: #f4f2f8; padding: 1px 5px; border-radius: 4px; }
  .empty-state { text-align: center; color: var(--muted); padding: 60px 0; }
  .r-foot { margin-top: 32px; color: var(--muted); font-size: 11px; text-align: center; }
  html.lb-open { overflow: hidden; }
  .lb { position: fixed; inset: 0; z-index: 1000; background: rgba(12, 8, 24, .94); display: flex; flex-direction: column; color: #fff; }
  .lb[hidden] { display: none; }
  .lb-bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; flex: none; }
  .lb-cap { flex: 1; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lb-count { opacity: .6; font-size: 13px; margin-right: 6px; }
  .gi { display: inline-block; flex: none; vertical-align: -2px; }
  .lb button, .pass, .fail, .spec-note { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .spec-note { justify-content: flex-start; }
  .task-icon { color: #6d28d9; }
  .lb button { font: 600 13px/1 sans-serif; font-family: inherit; color: #fff; background: rgba(255,255,255,.12); border: 0; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
  .lb button:hover { background: rgba(255,255,255,.22); }
  .lb-stage { flex: 1; overflow: auto; display: flex; padding: 0 64px 24px; cursor: zoom-out; }
  .lb-stage img { margin: auto; display: block; background: #fff; box-shadow: 0 20px 60px rgba(0,0,0,.5); cursor: zoom-in; max-width: none; }
  .lb.actual .lb-stage img { cursor: zoom-out; }
  .lb .lb-nav { position: fixed; top: 50%; transform: translateY(-50%); width: 44px; height: 64px; font-size: 28px; padding: 0; }
  .lb-prev { left: 10px; }
  .lb-next { right: 10px; }
  .lb .lb-nav[hidden] { display: none; }
  ${SPECS_CSS}
  @page { size: A4; margin: 12mm; }
  @media print {
    body { background: #fff; font-size: 12px; }
    .report { padding: 0; max-width: none; }
    .issue { box-shadow: none; }
    .shot img { max-height: 150mm; cursor: default; }
    .shot-hint, .lb { display: none !important; }
    .task { break-inside: avoid; }
    .specs > summary { list-style: none; }
    /* В PDF стили всегда раскрыты, на экране — свёрнуты */
    .specs::details-content { content-visibility: visible; display: block; }
    h2.r-section.issues-title { break-before: page; }
    a { text-decoration: none; }
  }
`;

function chip(sev, text) {
  return `<span class="chip" style="--fg:${sev.color};--bg:${sev.bg}"><i></i>${escapeHtml(text)}</span>`;
}

function issueHtml(issue, n) {
  const sev = severityOf(issue.severity);
  const mockup = safeHref(issue.mockupUrl);
  const page = safeHref(issue.page?.url);
  const el = issue.element || {};
  const vp = issue.viewport;
  return `
  <article class="issue" id="issue-${n}" style="--fg:${sev.color}">
    <div class="issue-head">
      <div class="issue-num">#${n}</div>
      <h3>${escapeHtml(issue.title)}</h3>
    </div>
    ${
      /^data:image\/(png|jpeg);base64,/.test(issue.screenshot || '')
        ? `<div class="shot"><img src="${escapeHtml(issue.screenshot)}" alt="Скриншот: ${escapeHtml(issue.title)}" data-caption="#${n} · ${escapeHtml(issue.title)}" title="Открыть на весь экран">${
            issue.screenshotTruncated ? '<div class="shot-note">Элемент слишком большой — снят не целиком</div>' : ''
          }${issue.screenshotNote ? `<div class="shot-note">${escapeHtml(issue.screenshotNote)}</div>` : ''}<div class="shot-hint">Нажмите на скриншот, чтобы открыть на весь экран</div></div>`
        : ''
    }
    <p class="desc${issue.description ? '' : ' empty'}">${escapeHtml(issue.description || 'Без описания')}</p>
    <dl class="props">
      <dt>Макет</dt><dd>${mockup ? `<a href="${escapeHtml(mockup)}" target="_blank" rel="noopener">${escapeHtml(mockup)}</a>` : '—'}</dd>
      <dt>Страница</dt><dd>${page ? `<a href="${escapeHtml(page)}" target="_blank" rel="noopener">${escapeHtml(issue.page?.title || page)}</a>` : '—'}</dd>
      ${el.selector ? `<dt>Элемент</dt><dd><code>${escapeHtml(el.selector)}</code> · ${el.width}×${el.height}px</dd>` : ''}
      ${vp ? `<dt>Окно</dt><dd>${vp.width}×${vp.height}, DPR ${vp.dpr}</dd>` : ''}
      <dt>Добавлено</dt><dd>${formatDate(issue.createdAt)}</dd>
    </dl>
    ${specsHtml(issue, { open: false })}
  </article>`;
}

export function buildReportBody(review) {
  const issues = review.issues || [];
  const meta = [`Создано ${formatDate(review.createdAt)}`, review.author ? `Автор: ${escapeHtml(review.author)}` : '', `Отчёт от ${formatDate(Date.now())}`]
    .filter(Boolean)
    .join(' · ');

  return `
  <main class="report">
    <header class="r-head">
      <div>
        <div class="r-kicker">Дизайн-ревью</div>
        <h1>${escapeHtml(review.title)}</h1>
        <div class="r-meta">${meta}</div>
      </div>
      <div class="r-total"><b>${issues.length}</b><span>${plural(issues.length, 'замечание', 'замечания', 'замечаний')}</span></div>
    </header>
    ${ticketsHtml(review)}
    ${pagesHtml(issues)}
    ${
      issues.length
        ? `
    <h2 class="r-section">Сводка</h2>
    <table class="toc">
      <thead><tr><th>№</th><th>Замечание</th><th>Критичность</th></tr></thead>
      <tbody>${issues
        .map((i, k) => `<tr><td class="num">${k + 1}</td><td><a href="#issue-${k + 1}">${escapeHtml(i.title)}</a></td><td>${chip(severityOf(i.severity), severityOf(i.severity).label)}</td></tr>`)
        .join('')}</tbody>
    </table>
    <h2 class="r-section issues-title">Замечания</h2>
    ${issues.map((i, k) => issueHtml(i, k + 1)).join('')}`
        : '<div class="empty-state">В этом ревью пока нет замечаний</div>'
    }
    <footer class="r-foot">Сформировано расширением Design Review Checker</footer>
  </main>`;
}

function ticketsHtml(review) {
  const tasks = [
    [icon('code', 18), 'Тикет разработки', safeHref(review.devTicketUrl)],
    [icon('palette', 18), 'Тикет дизайна', safeHref(review.designTicketUrl)],
  ];
  return `<section class="r-tasks">${tasks
    .map(([icon, label, href]) => {
      const inner = `<span class="task-icon">${icon}</span><span class="task-text"><span class="task-label">${label}</span><span class="task-link">${
        href ? escapeHtml(href.replace(/^https?:\/\//, '').replace(/\/$/, '')) : 'не указан'
      }</span></span>`;
      return href
        ? `<a class="task" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="${escapeHtml(href)}">${inner}</a>`
        : `<div class="task empty">${inner}</div>`;
    })
    .join('')}</section>`;
}

// Карточки проверенных страниц — в том же стиле, что тикеты.
function pagesHtml(issues) {
  const pages = new Map(); // url -> title
  for (const issue of issues) {
    const href = safeHref(issue.page?.url);
    if (href && !pages.has(href)) pages.set(href, (issue.page?.title || '').trim());
  }
  if (!pages.size) return '';
  return `<section class="r-tasks r-pages">${[...pages]
    .map(([href, title]) => {
      const u = new URL(href);
      const short = (u.host + u.pathname).replace(/\/$/, '');
      return `<a class="task" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="${escapeHtml(href)}">
        <span class="task-icon">${icon('globe', 18)}</span>
        <span class="task-text"><span class="task-label">Проверенная страница</span>
          <span class="task-link">${escapeHtml(title || short)}</span>
          ${title ? `<span class="task-sub">${escapeHtml(short)}</span>` : ''}
        </span></a>`;
    })
    .join('')}</section>`;
}

// Иконки, которые нужны просмотрщику: в скачанный HTML они попадают вместе со скриптом.
export function lightboxIcons() {
  const names = ['zoomIn', 'zoomOut', 'expand', 'xmark', 'chevronLeft', 'chevronRight'];
  return Object.fromEntries(names.map((n) => [n, ICONS[n]]));
}

// Просмотр скриншотов на весь экран. Функция самодостаточна: в скачанный HTML она
// встраивается как текст (installLightbox.toString()), на странице отчёта вызывается напрямую.
export function installLightbox(doc, ic) {
  const svg = (name, size) =>
    '<svg class="gi" width="' + size + '" height="' + size + '" viewBox="0 0 16 16" fill="none" aria-hidden="true">' + ((ic && ic[name]) || '') + '</svg>';
  const zoomLabel = (actual) => (actual ? svg('zoomOut', 14) + ' Вписать' : svg('zoomIn', 14) + ' 100%');
  const fsLabel = (on) => svg('expand', 14) + (on ? ' Выйти из полноэкранного' : ' Во весь экран');
  // Перед печатью/PDF раскрываем свёрнутые «Стили и данные элемента», после — возвращаем как было.
  // (Дублирует CSS ::details-content для браузеров, где он не поддерживается.)
  let reopened = [];
  doc.defaultView.addEventListener('beforeprint', () => {
    reopened = Array.prototype.filter.call(doc.querySelectorAll('details.specs'), (d) => !d.open);
    reopened.forEach((d) => (d.open = true));
  });
  doc.defaultView.addEventListener('afterprint', () => {
    reopened.forEach((d) => (d.open = false));
    reopened = [];
  });

  const box = doc.createElement('div');
  box.className = 'lb';
  box.hidden = true;
  box.innerHTML =
    '<div class="lb-bar"><span class="lb-cap"></span><span class="lb-count"></span>' +
    '<button type="button" data-lb="zoom" title="Масштаб (Z или клик по картинке)">' + zoomLabel(false) + '</button>' +
    '<button type="button" data-lb="fs" title="Полноэкранный режим (F)">' + fsLabel(false) + '</button>' +
    '<button type="button" data-lb="close" title="Закрыть (Esc)">' + svg('xmark', 16) + '</button></div>' +
    '<div class="lb-stage"><img alt=""></div>' +
    '<button type="button" class="lb-nav lb-prev" data-lb="prev" title="Предыдущий (←)">' + svg('chevronLeft', 24) + '</button>' +
    '<button type="button" class="lb-nav lb-next" data-lb="next" title="Следующий (→)">' + svg('chevronRight', 24) + '</button>';
  doc.body.appendChild(box);
  const stage = box.querySelector('.lb-stage');
  const img = stage.querySelector('img');
  const zoomBtn = box.querySelector('[data-lb=zoom]');
  const fsBtn = box.querySelector('[data-lb=fs]');
  let index = -1;
  let actual = false;
  const shots = () => Array.prototype.slice.call(doc.querySelectorAll('.report .shot img'));

  function layout() {
    if (box.hidden || !img.naturalWidth) return;
    if (actual) {
      img.style.width = img.naturalWidth + 'px';
      return;
    }
    const w = stage.clientWidth - 128;
    const h = stage.clientHeight - 24;
    const k = Math.min(w / img.naturalWidth, h / img.naturalHeight, 4); // вписываем, увеличивая не больше чем в 4 раза
    img.style.width = Math.max(1, Math.floor(img.naturalWidth * k)) + 'px';
  }
  function setActual(on) {
    actual = on;
    box.classList.toggle('actual', on);
    zoomBtn.innerHTML = zoomLabel(on);
    layout();
    if (on) {
      stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
      stage.scrollTop = 0;
    }
  }
  function show(i) {
    const list = shots();
    if (!list.length) return;
    index = (i + list.length) % list.length;
    const src = list[index];
    box.hidden = false;
    doc.documentElement.classList.add('lb-open');
    img.style.width = '';
    img.src = src.src;
    box.querySelector('.lb-cap').textContent = src.getAttribute('data-caption') || src.alt || '';
    box.querySelector('.lb-count').textContent = list.length > 1 ? index + 1 + ' / ' + list.length : '';
    box.querySelectorAll('.lb-nav').forEach((b) => (b.hidden = list.length < 2));
    setActual(false);
    stage.scrollTop = 0;
  }
  function close() {
    if (doc.fullscreenElement) doc.exitFullscreen();
    box.hidden = true;
    doc.documentElement.classList.remove('lb-open');
  }
  function toggleFullscreen() {
    if (doc.fullscreenElement) doc.exitFullscreen();
    else if (box.requestFullscreen) box.requestFullscreen();
  }

  img.addEventListener('load', layout);
  doc.defaultView.addEventListener('resize', layout);
  doc.addEventListener('fullscreenchange', () => {
    fsBtn.innerHTML = fsLabel(!!doc.fullscreenElement);
    setTimeout(layout, 50);
  });
  doc.addEventListener('click', (e) => {
    const t = e.target;
    if (box.hidden) {
      if (t.matches && t.matches('.report .shot img')) {
        e.preventDefault();
        show(shots().indexOf(t));
      }
      return;
    }
    const btn = t.closest && t.closest('[data-lb]');
    const act = btn && btn.getAttribute('data-lb');
    if (act === 'close') close();
    else if (act === 'prev') show(index - 1);
    else if (act === 'next') show(index + 1);
    else if (act === 'zoom') setActual(!actual);
    else if (act === 'fs') toggleFullscreen();
    else if (t === img) setActual(!actual);
    else if (t === stage) close();
  });
  doc.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
    else if (e.key === 'z' || e.key === 'я') setActual(!actual);
    else if (e.key === 'f' || e.key === 'а') toggleFullscreen();
    else return;
    e.preventDefault();
  });
}

export function buildReportDocument(review) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Дизайн-ревью — ${escapeHtml(review.title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>${buildReportBody(review)}
<script>(${installLightbox.toString()})(document, ${JSON.stringify(lightboxIcons()).replace(/</g, '\\u003c')});</script>
</body>
</html>`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
