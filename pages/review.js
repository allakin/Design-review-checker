import * as store from '../lib/store.js';
import { SEVERITIES, severityOf } from '../lib/constants.js';
import { escapeHtml, formatDate, specsHtml, SPECS_CSS } from '../lib/report.js';
import * as folder from '../lib/folder.js';
import { normalizeUrl, safeHref } from '../lib/url.js';
import { icon } from '../lib/icons.js';

const main = document.getElementById('main');
document.head.append(Object.assign(document.createElement('style'), { textContent: SPECS_CSS }));
document.getElementById('btn-new').innerHTML = `${icon('plus', 14)} Новое ревью`;
const list = document.getElementById('review-list');
const lightbox = document.getElementById('lightbox');
const savedEl = Object.assign(document.createElement('div'), { className: 'saved', textContent: 'Сохранено' });
document.body.append(savedEl);

let currentId = new URLSearchParams(location.search).get('id');
let lastLocalWrite = 0;
let savedTimer = 0;

function flashSaved() {
  savedEl.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove('show'), 1000);
}

async function write(fn) {
  lastLocalWrite = Date.now();
  await fn();
  lastLocalWrite = Date.now();
  flashSaved();
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function chip(sev, text = sev.label) {
  return `<span class="chip" style="--fg:${sev.color};--bg:${sev.bg}"><i></i>${escapeHtml(text)}</span>`;
}


function setUrl(id) {
  const url = new URL(location.href);
  url.searchParams.set('id', id);
  url.hash = '';
  history.replaceState(null, '', url);
}

// ---------- Список ревью: поиск, сортировка, удаление ----------

const searchEl = document.getElementById('search');
const sortEl = document.getElementById('sort');
const foundEl = document.getElementById('found');
document.getElementById('search-icon').innerHTML = icon('magnifier', 14);

const SORTS = {
  'updated-desc': (a, b) => b.updatedAt - a.updatedAt,
  'created-desc': (a, b) => b.createdAt - a.createdAt,
  'created-asc': (a, b) => a.createdAt - b.createdAt,
  'title-asc': (a, b) => a.title.localeCompare(b.title, 'ru', { numeric: true }),
  'issues-desc': (a, b) => b.issueCount - a.issueCount || b.updatedAt - a.updatedAt,
};

function matches(meta, query) {
  if (!query) return true;
  const hay = meta.search ?? `${meta.title}\n${meta.author}`.toLowerCase();
  return query.split(/\s+/).every((word) => hay.includes(word)); // все слова запроса, в любом порядке
}

async function renderList(activeId) {
  const all = await store.listReviews();
  const query = searchEl.value.trim().toLowerCase();
  const reviews = all.filter((r) => matches(r, query)).sort(SORTS[sortEl.value] || SORTS['updated-desc']);
  foundEl.textContent = query ? `Найдено: ${reviews.length} из ${all.length}` : all.length > 1 ? `Всего: ${all.length}` : '';
  list.innerHTML = reviews.length
    ? reviews
        .map(
          (r) => `<li data-id="${r.id}" class="${r.id === currentId ? 'current' : ''}">
        <div class="li-main">
          <div class="t"></div>
          <small>${r.issueCount} зам. · ${formatDate(r.updatedAt)}</small>${r.id === activeId ? '<span class="badge">текущее</span>' : ''}
        </div>
        <button class="li-del" data-act="delete" title="Удалить ревью">${icon('trash', 14)}</button>
      </li>`,
        )
        .join('')
    : `<li class="empty-list">${all.length ? 'Ничего не найдено' : 'Ревью пока нет'}</li>`;
  list.querySelectorAll('li[data-id]').forEach((li, k) => {
    const meta = reviews[k];
    li.querySelector('.t').textContent = meta.title;
    li.addEventListener('click', () => {
      currentId = meta.id;
      setUrl(currentId);
      render();
    });
    li.querySelector('[data-act=delete]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await deleteReviewFlow(meta) && currentId === meta.id) currentId = null;
      render();
    });
  });
  list.querySelector('li.current')?.scrollIntoView({ block: 'nearest' });
  updateSideShades();
  return all;
}

// Тени у краёв списка: подсказывают, что ревью больше, чем помещается.
const listWrap = document.getElementById('list-wrap');
function updateSideShades() {
  listWrap.classList.toggle('shade-top', list.scrollTop > 2);
  listWrap.classList.toggle('shade-bottom', list.scrollTop + list.clientHeight < list.scrollHeight - 2);
}
list.addEventListener('scroll', updateSideShades, { passive: true });
window.addEventListener('resize', updateSideShades);

// ---------- Окна подтверждения (вместо системных confirm/alert/prompt с заголовком «Confirm action on <id>») ----------

// Возвращает Promise<{ ok, value }>. ok=true — нажата основная кнопка.
function showDialog({
  label = 'Предупреждение',
  labelIcon = 'warning',
  question,
  alertTitle = '',
  alertItems = [], // строки (текст) или { text, code }
  note = '',
  input = null, // { value, placeholder }
  confirmText = 'OK',
  confirmIcon = '',
  confirmClass = 'btn-delete',
  cancelText = 'Отмена', // null — без кнопки отмены (информационное окно)
  extra = null, // { text, icon, onClick }
}) {
  const dlg = document.getElementById('danger');
  dlg.classList.toggle('info', labelIcon !== 'warning');
  dlg.innerHTML = `
    <form method="dialog">
      <div class="danger-head">${icon(labelIcon, 18)}<span class="danger-label"></span></div>
      <h2 class="danger-q"></h2>
      ${alertTitle || alertItems.length ? `<div class="danger-alert">${alertTitle ? '<b></b>' : ''}<ul></ul></div>` : ''}
      ${note ? '<p class="danger-note"></p>' : ''}
      ${input ? '<input class="danger-input" type="text" maxlength="200">' : ''}
      <div class="danger-actions">
        ${extra ? `<button type="button" class="btn btn-light" data-act="extra">${extra.icon ? icon(extra.icon, 14) : ''} <span></span></button>` : ''}
        <span class="spacer"></span>
        ${cancelText ? `<button value="cancel" class="btn btn-light" ${input ? '' : 'autofocus'}></button>` : ''}
        <button value="ok" class="btn ${confirmClass}" ${cancelText || input ? '' : 'autofocus'}>${confirmIcon ? icon(confirmIcon, 14) : ''} <span></span></button>
      </div>
    </form>`;
  // Пользовательский текст — только через textContent.
  dlg.querySelector('.danger-label').textContent = label;
  dlg.querySelector('.danger-q').textContent = question;
  if (alertTitle) dlg.querySelector('.danger-alert b').textContent = alertTitle;
  const ul = dlg.querySelector('.danger-alert ul');
  for (const item of alertItems) {
    const li = document.createElement('li');
    if (typeof item === 'string') li.textContent = item;
    else {
      const code = document.createElement('code');
      code.textContent = item.code;
      li.append(item.before || '', code, item.after || '');
    }
    ul.append(li);
  }
  if (ul && !ul.children.length) ul.remove();
  if (note) dlg.querySelector('.danger-note').textContent = note;
  if (cancelText) dlg.querySelector('button[value=cancel]').textContent = cancelText;
  dlg.querySelector('button[value=ok] span').textContent = confirmText;
  if (extra) {
    dlg.querySelector('[data-act=extra] span').textContent = extra.text;
    dlg.querySelector('[data-act=extra]').addEventListener('click', extra.onClick);
  }
  const field = dlg.querySelector('.danger-input');
  if (field) {
    field.value = input.value || '';
    field.placeholder = input.placeholder || '';
    // Enter в поле — основная кнопка (по умолчанию форма отправилась бы первой кнопкой, «Отмена»)
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        dlg.close('ok');
      }
    });
  }
  dlg.returnValue = '';
  dlg.showModal();
  if (field) {
    field.focus();
    field.select();
  }
  return new Promise((resolve) =>
    dlg.addEventListener('close', () => resolve({ ok: dlg.returnValue === 'ok', value: field?.value ?? '' }), { once: true }),
  );
}

const notify = (question, note = '') => showDialog({ question, note, confirmText: 'Понятно', confirmClass: 'btn-primary', cancelText: null });

// Удаление ревью вместе с его папкой в reviews-results. Возвращает true, если удалили.
async function confirmReviewDeletion({ id, title, count, diskPath }) {
  const { ok } = await showDialog({
    question: `Удалить ревью «${title}»?`,
    alertTitle: 'Будут удалены без возможности восстановления:',
    alertItems: [
      count ? `${count} ${plural(count, 'замечание', 'замечания', 'замечаний')} со скриншотами, описаниями и стилями` : 'ревью и все его данные',
      ...(diskPath ? [{ before: 'папка ', code: diskPath, after: ' на диске — Отчёт.html, review.json и скриншоты' }] : []),
    ],
    note: 'Данные не сохранятся. Если отчёт ещё нужен — сначала скачайте его.',
    confirmText: 'Удалить навсегда',
    confirmIcon: 'trash',
    extra: { text: 'Скачать отчёт', icon: 'download', onClick: () => openReport(id, 'html') },
  });
  return ok;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

async function deleteReviewFlow({ id, title, createdAt, issueCount, issues }) {
  const dir = await folder.getDir();
  const sub = dir ? await folder.reviewFolderName({ id, title, createdAt }) : null;
  const count = issueCount ?? issues?.length ?? 0;
  if (!(await confirmReviewDeletion({ id, title, count, diskPath: sub ? `${dir.name}/${sub}` : '' }))) return false;
  // Сначала удаляем ревью — тогда отложенное автосохранение уже не пересоздаст его папку.
  await store.deleteReview(id);
  let result = { deleted: false };
  try {
    result = await folder.deleteReviewFolder({ id, title, createdAt }, { request: true });
  } catch (e) {
    result = { deleted: false, name: sub, reason: e.message };
  }
  if (sub && !result.deleted) {
    const why = result.reason === 'no-permission' ? 'нет разрешения на запись в папку' : result.reason;
    await notify('Ревью удалено, но папка на диске осталась', `Папку «${sub}» удалить не удалось (${why}). Удалите её вручную в ${dir.name}.`);
  }
  return true;
}

let searchTimer = 0;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => renderList(await store.getActiveReviewId()), 120);
});
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchEl.value) {
    searchEl.value = '';
    searchEl.dispatchEvent(new Event('input'));
  }
});
sortEl.addEventListener('change', async () => {
  await chrome.storage.local.set({ reviewSort: sortEl.value });
  renderList(await store.getActiveReviewId());
});

async function render() {
  const activeId = await store.getActiveReviewId();
  if (!currentId) currentId = activeId;
  const reviews = await renderList(activeId);
  if (!currentId && reviews.length) {
    currentId = reviews[0].id;
    return render();
  }
  const review = await store.getReview(currentId);
  if (!review) {
    main.innerHTML = `<div class="empty"><b>Ревью не выбрано</b>Создайте новое ревью или выберите его слева.</div>`;
    return;
  }

  // Сохраняем фокус и позицию курсора, чтобы перерисовка не мешала вводу.
  const focused = document.activeElement;
  const focusKey = focused?.dataset?.field ? [focused.closest('[data-issue]')?.dataset.issue, focused.dataset.field, focused.selectionStart, focused.selectionEnd] : null;

  const issues = review.issues;
  const counts = SEVERITIES.map((s) => ({ s, n: issues.filter((i) => severityOf(i.severity).id === s.id).length })).filter((x) => x.n);

  main.innerHTML = `
    <div class="top">
      <div class="fields">
        <input class="title-input" data-field="review-title" maxlength="200">
        <input class="author-input" data-field="review-author" maxlength="100" placeholder="Ревьюер">
        <div class="tickets">
          <label>Тикет разработки <input type="text" data-field="review-devTicketUrl" maxlength="500" placeholder="Ссылка"></label>
          <a data-open="devTicketUrl" target="_blank" rel="noopener" title="Открыть">${icon('external', 14)}</a>
          <label>Тикет дизайна <input type="text" data-field="review-designTicketUrl" maxlength="500" placeholder="Ссылка"></label>
          <a data-open="designTicketUrl" target="_blank" rel="noopener" title="Открыть">${icon('external', 14)}</a>
        </div>
        <div class="meta">Создано ${formatDate(review.createdAt)} · ${issues.length} зам.</div>
      </div>
      <div class="actions">
        <button class="btn btn-light" data-act="html" ${issues.length ? '' : 'disabled'}>${icon('download', 14)} Экспорт HTML</button>
        <button class="btn btn-primary" data-act="pdf" ${issues.length ? '' : 'disabled'}>${icon('download', 14)} Экспорт PDF</button>
      </div>
    </div>
    <div class="summary">
      ${counts.map(({ s, n }) => chip(s, `${s.label}: ${n}`)).join('')}
      <span style="flex:1"></span>
      ${
        review.id === activeId
          ? '<span class="active-note">Новые замечания попадают в это ревью</span>'
          : '<button class="btn btn-light" data-act="activate">Сделать текущим</button>'
      }
      <button class="btn btn-danger" data-act="delete-review">${icon('trash', 14)} Удалить ревью</button>
    </div>
    ${
      issues.length
        ? issues.map((i, k) => issueHtml(i, k, issues.length)).join('')
        : `<div class="empty"><b>Замечаний пока нет</b>Откройте сайт, нажмите на иконку расширения → «Выбрать элемент», наведите курсор на блок и кликните.</div>`
    }`;

  const titleInput = main.querySelector('[data-field=review-title]');
  const authorInput = main.querySelector('[data-field=review-author]');
  const ticketInputs = ['devTicketUrl', 'designTicketUrl'].map((name) => [name, main.querySelector(`[data-field=review-${name}]`)]);
  titleInput.value = review.title;
  authorInput.value = review.author || '';
  const syncTicketLink = (name, url) => {
    const a = main.querySelector(`[data-open=${name}]`);
    a.hidden = !safeHref(url);
    a.href = safeHref(url) || '#';
  };
  for (const [name, input] of ticketInputs) {
    input.value = review[name] || '';
    syncTicketLink(name, review[name]);
  }
  const saveReviewMeta = debounce(() => {
    const patch = { title: titleInput.value.trim() || 'Дизайн-ревью', author: authorInput.value.trim() };
    for (const [name, input] of ticketInputs) {
      const link = normalizeUrl(input.value);
      input.classList.toggle('invalid', !link.ok);
      if (!link.ok) continue; // некорректную ссылку не сохраняем, пока её не исправят
      patch[name] = link.url;
      syncTicketLink(name, link.url);
    }
    write(() => store.updateReview(review.id, patch));
  }, 400);
  for (const input of [titleInput, authorInput, ...ticketInputs.map(([, i]) => i)]) input.addEventListener('input', saveReviewMeta);

  main.querySelector('[data-act=html]').addEventListener('click', () => openReport(review.id, 'html'));
  main.querySelector('[data-act=pdf]').addEventListener('click', () => openReport(review.id, 'pdf'));
  main.querySelector('[data-act=activate]')?.addEventListener('click', async () => {
    await store.setActiveReviewId(review.id);
    render();
  });
  main.querySelector('[data-act=delete-review]').addEventListener('click', async () => {
    if (!(await deleteReviewFlow(review))) return;
    currentId = null;
    render();
  });

  for (const card of main.querySelectorAll('[data-issue]')) bindIssue(card, review, issues.find((i) => i.id === card.dataset.issue));

  if (focusKey) {
    const [issueId, field, s, e] = focusKey;
    const el = issueId
      ? main.querySelector(`[data-issue="${issueId}"] [data-field="${field}"]`)
      : main.querySelector(`[data-field="${field}"]`);
    if (el) {
      el.focus();
      try {
        el.setSelectionRange(s, e);
      } catch {}
    }
  }

  if (location.hash && !render.scrolled) {
    render.scrolled = true;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }
}

function issueHtml(issue, k, total) {
  const sev = severityOf(issue.severity);
  const page = safeHref(issue.page?.url);
  const el = issue.element || {};
  return `
  <article class="issue" id="${issue.id}" data-issue="${issue.id}" style="--fg:${sev.color}">
    <div>
      ${issue.screenshot ? `<div class="shot" data-act="zoom"><img src="${escapeHtml(issue.screenshot)}" alt=""></div>` : ''}
      ${issue.screenshotTruncated ? '<div class="shot-note">Элемент снят не целиком — он слишком большой</div>' : ''}
      ${issue.screenshotNote ? `<div class="shot-note">${escapeHtml(issue.screenshotNote)}</div>` : ''}
    </div>
    <div class="form">
      <div class="form-head">
        <span class="num">#${k + 1}</span>
        <input type="text" data-field="title" maxlength="200" placeholder="Название">
        <button class="icon-btn" data-act="up" title="Выше" ${k === 0 ? 'disabled' : ''}>${icon('up')}</button>
        <button class="icon-btn" data-act="down" title="Ниже" ${k === total - 1 ? 'disabled' : ''}>${icon('down')}</button>
        <button class="icon-btn danger" data-act="delete" title="Удалить">${icon('trash')}</button>
      </div>
      <div class="field">
        <div class="field-label">Критичность</div>
        <div class="sev">${SEVERITIES.map(
          (s) => `<button data-sev="${s.id}" style="--fg:${s.color};--bg:${s.bg}" aria-pressed="${s.id === sev.id}">${s.label}</button>`,
        ).join('')}</div>
      </div>
      <div class="field">
        <div class="field-label">Описание</div>
        <textarea data-field="description" placeholder="Что не так и как должно быть"></textarea>
      </div>
      <div class="field">
        <div class="field-label">Ссылка на макет</div>
        <input type="url" data-field="mockupUrl" placeholder="Ссылка">
      </div>
      <div class="props">
        <span>Страница</span><span>${page ? `<a href="${escapeHtml(page)}" target="_blank" rel="noopener">${escapeHtml(issue.page?.title || page)}</a>` : '—'}</span>
        ${el.selector ? `<span>Элемент</span><span class="el"><code>${escapeHtml(el.selector)}</code><span class="el-size">${el.width}×${el.height}px</span></span>` : ''}
        <span>Добавлено</span><span>${formatDate(issue.createdAt)}</span>
      </div>
      ${specsHtml(issue, { open: false })}
    </div>
  </article>`;
}


function bindIssue(card, review, issue) {
  const f = (name) => card.querySelector(`[data-field=${name}]`);
  f('title').value = issue.title;
  f('description').value = issue.description || '';
  f('mockupUrl').value = issue.mockupUrl || '';

  const save = debounce(() => {
    const link = normalizeUrl(f('mockupUrl').value);
    f('mockupUrl').classList.toggle('invalid', !link.ok);
    const patch = { title: f('title').value.trim() || 'Без названия', description: f('description').value.trim() };
    if (link.ok) patch.mockupUrl = link.url;
    write(() => store.updateIssue(review.id, issue.id, patch));
  }, 400);
  for (const name of ['title', 'description', 'mockupUrl']) f(name).addEventListener('input', save);

  card.querySelectorAll('[data-sev]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await write(() => store.updateIssue(review.id, issue.id, { severity: btn.dataset.sev }));
      render();
    }),
  );
  card.querySelector('[data-act=up]').addEventListener('click', async () => {
    await write(() => store.moveIssue(review.id, issue.id, -1));
    render();
  });
  card.querySelector('[data-act=down]').addEventListener('click', async () => {
    await write(() => store.moveIssue(review.id, issue.id, 1));
    render();
  });
  card.querySelector('[data-act=delete]').addEventListener('click', async () => {
    const sub = (await folder.getDir()) ? await folder.reviewFolderName(review) : null;
    const { ok } = await showDialog({
      question: `Удалить замечание «${issue.title}»?`,
      alertTitle: 'Будет удалено без возможности восстановления:',
      alertItems: [
        'замечание со скриншотом, описанием и стилями',
        ...(sub ? [{ before: 'его скриншот и запись в ', code: sub, after: ' на диске' }] : []),
      ],
      note: 'Данные не сохранятся. Остальные замечания будут перенумерованы.',
      confirmText: 'Удалить',
      confirmIcon: 'trash',
    });
    if (!ok) return;
    await write(() => store.deleteIssue(review.id, issue.id));
    render();
  });
  card.querySelector('[data-act=zoom]')?.addEventListener('click', () => {
    lightbox.querySelector('img').src = issue.screenshot;
    lightbox.hidden = false;
  });
}

function openReport(id, action) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`pages/report.html?id=${id}&action=${action}`) });
}

lightbox.addEventListener('click', () => (lightbox.hidden = true));
document.addEventListener('keydown', (e) => e.key === 'Escape' && (lightbox.hidden = true));

// ---------- Папка для результатов ----------

const folderEl = document.getElementById('folder');
let restored = null; // итог восстановления ревью из выбранной папки — показываем в блоке папки
let regainResult = null; // ответ браузера на запрос доступа по клику, если доступ не дали

// restore=true — сначала подтянуть ревью, сохранённые в папке раньше (например, до переустановки расширения).
async function saveAllToFolder(dir, { restore = false } = {}) {
  folderEl.querySelector('.folder-state').textContent = restore ? 'Ищу сохранённые ревью…' : 'Сохраняю…';
  try {
    if (restore) restored = await folder.importFromFolder(dir);
    await folder.writeAll(dir, await store.getAllReviews());
  } catch (e) {
    await folder.setStatus({ state: 'error', error: e.message });
  }
}

function restoredHtml() {
  if (!restored) return '';
  if (!restored.found) {
    return '<div class="folder-state warn">В этой папке нет сохранённых ревью. Сохраняли в другом месте? Нажмите «Сменить» и укажите ту папку</div>';
  }
  const summary = folder.importSummary(restored);
  const warn = restored.failed.length || restored.missingShots;
  return summary ? `<div class="folder-state ${warn ? 'warn' : 'ok'}">${escapeHtml(summary)}</div>` : '';
}

async function renderFolder() {
  const dir = await folder.getDir();
  const { [folder.KEY_FOLDER_STATUS]: status = {} } = await chrome.storage.local.get(folder.KEY_FOLDER_STATUS);
  const perm = dir ? await folder.permission(dir).catch(() => 'prompt') : null;

  let state;
  let buttons;
  if (!dir) {
    state = '<div class="folder-state warn">Не подключена. Выберите reviews-results в папке расширения или папку, где уже лежат ваши ревью</div>';
    buttons = `<button class="btn btn-primary" data-act="pick">${icon('folder', 14)} Выбрать reviews-results</button>`;
  } else if (perm !== 'granted') {
    state = regainResult
      ? `<div class="folder-state err">Браузер не дал доступ по клику (${escapeHtml(regainResult.error || `ответ: ${regainResult.state}`)}). Нажмите «Разрешить доступ»</div>`
      : '<div class="folder-state warn">Нет доступа к папке. Кликните в любом месте страницы — доступ вернётся (или браузер спросит разрешение)</div>';
    buttons = `<button class="btn btn-primary" data-act="grant">Разрешить доступ</button><button class="btn btn-light" data-act="pick">${icon('folderOpen', 14)} Сменить</button><button class="btn btn-danger" data-act="disconnect">${icon('linkSlash', 14)} Отключить</button>`;
  } else {
    state =
      status.state === 'error'
        ? `<div class="folder-state err">Ошибка записи: ${escapeHtml(status.error)}</div>`
        : `<div class="folder-state ok">Сохраняется автоматически${status.lastSyncAt ? ` · ${formatDate(status.lastSyncAt)}` : ''}</div>
           <div class="folder-state">Не закрывайте эту страницу: пока она открыта, ревью сохраняются в папку. После закрытия браузер забирает разрешение на запись.</div>`;
    buttons = `<button class="btn btn-light" data-act="save">${icon('save', 14)} Сохранить сейчас</button><button class="btn btn-light" data-act="pick">${icon('folderOpen', 14)} Сменить</button><button class="btn btn-danger" data-act="disconnect">${icon('linkSlash', 14)} Отключить</button>`;
  }
  folderEl.innerHTML = `
    <div class="folder-title">Папка для результатов</div>
    ${dir ? `<div class="folder-name">${icon('folder')} ${escapeHtml(folder.folderLabel(dir, status))}/</div>` : ''}
    ${state}
    ${dir ? restoredHtml() : ''}
    <div class="row">${buttons}</div>`;
  folderEl.classList.toggle('attention', !dir || perm !== 'granted');
  updateSideShades();

  folderEl.querySelector('[data-act=pick]')?.addEventListener('click', async () => {
    let dir;
    try {
      ({ dir } = await folder.pickResultsFolder());
    } catch (e) {
      if (e.name !== 'AbortError') await notify('Не удалось выбрать папку', e.message);
      return;
    }
    await saveAllToFolder(dir, { restore: true });
    renderFolder();
  });
  folderEl.querySelector('[data-act=disconnect]')?.addEventListener('click', async () => {
    const name = folder.folderLabel(dir, status);
    const { ok } = await showDialog({
      question: `Отключить папку «${name}»?`,
      alertItems: ['новые изменения ревью больше не будут записываться на диск', 'выбирать элементы на сайтах можно будет только после повторного подключения'],
      note: 'Уже сохранённые файлы останутся на диске.',
      confirmText: 'Отключить',
      confirmIcon: 'linkSlash',
    });
    if (!ok) return;
    await folder.disconnectFolder();
    restored = null;
    renderFolder();
  });
  folderEl.querySelector('[data-act=grant]')?.addEventListener('click', async () => {
    if ((await folder.permission(dir, true)) === 'granted') await saveAllToFolder(dir, { restore: true });
    renderFolder();
  });
  folderEl.querySelector('[data-act=save]')?.addEventListener('click', async () => {
    await saveAllToFolder(dir);
    renderFolder();
  });
}

chrome.storage.onChanged.addListener((changes, area) => area === 'local' && folder.KEY_FOLDER_STATUS in changes && renderFolder());
// Дописываем изменения, сделанные без открытой страницы (например, замечания с сайта). Если доступа нет —
// просим его при первом клике на странице: с «Разрешать всегда» браузер отдаёт его молча.
folder.flushUnsaved().finally(async () => {
  renderFolder();
  const dir = await folder.getDir();
  if (dir && (await folder.permission(dir).catch(() => 'prompt')) === 'prompt') {
    folder.regainAccessOnClick(document, dir, { ignore: '#folder, #danger' }).then((result) => {
      regainResult = result.state === 'granted' ? null : result;
      renderFolder();
    });
  }
});

document.getElementById('btn-new').addEventListener('click', async () => {
  const { ok, value: title } = await showDialog({
    label: 'Новое ревью',
    labelIcon: 'plus',
    question: 'Как назвать ревью?',
    input: { value: 'Дизайн-ревью', placeholder: 'Например: Ревью страницы оплаты' },
    confirmText: 'Создать',
    confirmClass: 'btn-primary',
  });
  if (!ok) return;
  const author = (await store.getReview(currentId))?.author || '';
  const review = await store.createReview({ title, author });
  currentId = review.id;
  setUrl(currentId);
  render();
});

// Новые замечания из контент-скрипта появляются сразу; собственные правки не перерисовываем.
store.onReviewsChanged(() => {
  if (Date.now() - lastLocalWrite > 1000) render();
  else store.getActiveReviewId().then(renderList);
});

(async () => {
  const { reviewSort } = await chrome.storage.local.get('reviewSort');
  if (reviewSort && SORTS[reviewSort]) sortEl.value = reviewSort;
  await store.reindexIfNeeded();
  render();
})();

