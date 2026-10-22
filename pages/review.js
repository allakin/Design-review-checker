import * as store from '../lib/store.js';
import { SEVERITIES, severityOf } from '../lib/constants.js';
import { escapeHtml, formatDate, specsHtml, SPECS_CSS, LIGHTBOX_CSS, MD_CSS, fixImagesOf, installLightbox, lightboxIcons, navHtml, installToc } from '../lib/report.js';
import * as folder from '../lib/folder.js';
import { normalizeUrl, safeHref } from '../lib/url.js';
import { icon } from '../lib/icons.js';
import { editorHtml, mountEditor } from './md-editor.js';
import { readImageFiles } from '../lib/images.js';
import { codeFingerprint, REOPEN_KEY } from '../lib/code-version.js';

const main = document.getElementById('main');
document.head.append(Object.assign(document.createElement('style'), { textContent: SPECS_CSS + LIGHTBOX_CSS + MD_CSS }));
// Слайдшоу по картинкам «Визуальные пояснения» — тот же просмотрщик, что в HTML-отчёте.
installLightbox(document, lightboxIcons(), { selector: '.fix-thumb img' });
document.getElementById('btn-new').innerHTML = `${icon('plus', 14)} Новое ревью`;
const list = document.getElementById('review-list');
const lightbox = document.getElementById('lightbox');
const savedEl = Object.assign(document.createElement('div'), { className: 'saved', textContent: 'Сохранено' });
document.body.append(savedEl);

let currentId = new URLSearchParams(location.search).get('id');
let lastLocalWrite = 0;
let savedTimer = 0;
let disposeToc = null; // снимает обработчики навигации «В этом ревью» прошлой отрисовки

function flashSaved() {
  savedEl.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove('show'), 1000);
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Страховка автосохранения: в папку пишет фоновый скрипт (через секунду после изменения), но браузер может
// остановить его посреди записи. Через пару секунд дописываем отсюда то, что так и не попало на диск;
// уже сохранённое не трогается, а записи с фоновым скриптом идут по очереди (lib/folder.js).
const flushSoon = debounce(() => folder.flushUnsaved(), 2500);

async function write(fn) {
  lastLocalWrite = Date.now();
  await fn();
  lastLocalWrite = Date.now();
  flashSaved();
  flushSoon();
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

// Возвращает Promise<{ ok, value, action }>. ok=true — нажата основная кнопка; action — 'ok' | 'cancel' | 'extra' | ''.
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
  extra = null, // { text, icon, onClick } или { text, icon, close: true } — закрыть окно с action 'extra'
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
    dlg.querySelector('[data-act=extra]').addEventListener('click', extra.close ? () => dlg.close('extra') : extra.onClick);
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
    dlg.addEventListener('close', () => resolve({ ok: dlg.returnValue === 'ok', value: field?.value ?? '', action: dlg.returnValue }), { once: true }),
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
  disposeToc?.();
  disposeToc = null;
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
    <div class="rv-layout">
    <div class="rv-body">
    <div class="top" id="summary">
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
        ? `<section id="issues">${issues.map((i, k) => issueHtml(i, k, issues.length)).join('')}</section>`
        : `<div class="empty"><b>Замечаний пока нет</b>Откройте сайт, нажмите на иконку расширения → «Выбрать элемент», наведите курсор на блок и кликните.</div>`
    }
    </div>
    ${navHtml(issues, { title: 'В этом ревью:', label: 'Навигация по ревью', anchor: (i) => i.id })}
    </div>`;

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
  disposeToc = installToc(document);

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
    <span class="num issue-num" title="Замечание №${k + 1}">#${k + 1}</span>
    <div class="aside">
      <div class="shot-wrap">
        ${issue.screenshot ? `<div class="field-label">Скриншот области с сайта</div><div class="shot" data-act="zoom"><img src="${escapeHtml(issue.screenshot)}" alt=""></div>` : ''}
        ${issue.screenshotTruncated ? '<div class="shot-note">Элемент снят не целиком — он слишком большой</div>' : ''}
        ${issue.screenshotNote ? `<div class="shot-note">${escapeHtml(issue.screenshotNote)}</div>` : ''}
      </div>
      ${fixBlockHtml(issue, k)}
    </div>
    <div class="form">
      <div class="form-head">
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
        ${editorHtml({ placeholder: 'Что не так и как должно быть. Поддерживается Markdown: **жирный**, _курсив_, - список, # заголовок' })}
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


// Блок «Визуальные пояснения»: высота фиксирована, картинки прокручиваются внутри; клик — слайдшоу.
function fixBlockHtml(issue, k) {
  const images = fixImagesOf(issue);
  const caption = (j) => `#${k + 1} · Визуальные пояснения · ${j + 1} из ${images.length}`;
  return `
      <section class="fix" data-fix>
        <div class="fix-head">
          <span class="field-label">Визуальные пояснения</span>
          ${images.length ? `<span class="fix-count">${images.length}</span>` : ''}
          <span class="spacer"></span>
          <button class="fix-add-btn" data-act="fix-add" title="Добавить картинки">${icon('plus', 14)} Добавить</button>
          <input type="file" accept="image/*" multiple hidden data-fix-input>
        </div>
        ${
          images.length
            ? `<div class="fix-body" data-lb-group>${images
                .map(
                  (img, j) => `<div class="fix-thumb" data-fix-id="${escapeHtml(img.id)}">
              <img src="${escapeHtml(img.src)}" alt="" data-caption="${escapeHtml(caption(j))}" title="Открыть слайдшоу">
              <button class="fix-del" data-act="fix-del" title="Удалить картинку">${icon('xmark', 14)}</button>
            </div>`,
                )
                .join('')}<button class="fix-tile-add" data-act="fix-add" title="Добавить картинки">${icon('plus', 20)}</button></div>`
            : `<button class="fix-body fix-empty" data-act="fix-add">${icon('camera', 22)}<b>Добавьте картинки</b><span>Перетащите сюда, вставьте из буфера (${PASTE_KEY}) или выберите файлы</span></button>`
        }
        <div class="fix-drop">${icon('download', 20)} Отпустите, чтобы добавить</div>
      </section>`;
}

const PASTE_KEY = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? '⌘V' : 'Ctrl+V';

async function addFixFiles(review, issue, files) {
  const { added, failed, skipped } = await readImageFiles(files);
  if (!added.length && !failed.length) {
    if (skipped) await notify('Это не картинки', 'В блок «Визуальные пояснения» можно добавить PNG, JPEG, WebP, GIF и другие изображения.');
    return;
  }
  if (added.length) await write(() => store.addFixImages(review.id, issue.id, added));
  render();
  if (failed.length) await notify('Не все картинки добавлены', failed.join('\n'));
}

// Вставка из буфера: картинка попадает в замечание, где стоит фокус, а если фокуса нет — над которым курсор.
let hoveredIssue = null;
main.addEventListener('pointerover', (e) => (hoveredIssue = e.target.closest?.('[data-issue]')?.dataset.issue || null));
main.addEventListener('pointerleave', () => (hoveredIssue = null));
document.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  const issueId = document.activeElement?.closest?.('[data-issue]')?.dataset.issue || hoveredIssue;
  if (!issueId) return;
  e.preventDefault(); // сразу: иначе картинка вставится в редактор описания
  const review = await store.getReview(currentId);
  const issue = review?.issues.find((i) => i.id === issueId);
  if (issue) addFixFiles(review, issue, files);
});
// Картинку, брошенную мимо блока, браузер открыл бы вместо страницы ревью.
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files') && !e.target.closest?.('[data-fix]')) e.preventDefault();
  });
}

// Адрес ссылки для редактора описания. null — отмена, '' — убрать ссылку.
async function askLink(current) {
  const { ok, value } = await showDialog({
    label: 'Ссылка',
    labelIcon: 'link',
    question: current ? 'Изменить ссылку' : 'Добавить ссылку',
    note: 'Оставьте поле пустым, чтобы убрать ссылку.',
    input: { value: current, placeholder: 'https://…' },
    confirmText: 'Готово',
    confirmClass: 'btn-primary',
  });
  if (!ok) return null;
  if (!value.trim()) return '';
  const link = normalizeUrl(value);
  if (link.ok && link.url) return link.url;
  await notify('Некорректная ссылка', 'Нужен адрес вида https://…');
  return null;
}

function bindFix(card, review, issue) {
  const block = card.querySelector('[data-fix]');
  const input = block.querySelector('[data-fix-input]');
  block.querySelectorAll('[data-act=fix-add]').forEach((btn) => btn.addEventListener('click', () => input.click()));
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    addFixFiles(review, issue, files);
  });

  let depth = 0; // dragenter/dragleave приходят и от вложенных элементов
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  block.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    block.classList.add('drop');
  });
  block.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  block.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      block.classList.remove('drop');
    }
  });
  block.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    block.classList.remove('drop');
    addFixFiles(review, issue, e.dataTransfer.files);
  });

  block.querySelectorAll('[data-act=fix-del]').forEach((btn) =>
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const imageId = btn.closest('[data-fix-id]').dataset.fixId;
      const { ok } = await showDialog({
        question: 'Удалить картинку из визуальных пояснений?',
        note: 'Картинка пропадёт из замечания, отчёта и папки на диске. Восстановить её не получится — только добавить заново.',
        confirmText: 'Удалить',
        confirmIcon: 'trash',
      });
      if (!ok) return;
      await write(() => store.deleteFixImage(review.id, issue.id, imageId));
      render();
    }),
  );
}

function bindIssue(card, review, issue) {
  bindFix(card, review, issue);
  const f = (name) => card.querySelector(`[data-field=${name}]`);
  f('title').value = issue.title;
  f('mockupUrl').value = issue.mockupUrl || '';

  const save = debounce(() => {
    const link = normalizeUrl(f('mockupUrl').value);
    f('mockupUrl').classList.toggle('invalid', !link.ok);
    const patch = { title: f('title').value.trim() || 'Без названия', description: editor.getValue().trim() };
    if (link.ok) patch.mockupUrl = link.url;
    write(() => store.updateIssue(review.id, issue.id, patch));
  }, 400);
  for (const name of ['title', 'mockupUrl']) f(name).addEventListener('input', save);
  // Название в навигации «В этом ревью» меняется сразу, без перерисовки страницы
  const navText = [...main.querySelectorAll('.r-nav a')].find((a) => a.getAttribute('href') === `#${issue.id}`)?.querySelector('.r-nav-text');
  f('title').addEventListener('input', () => navText && (navText.textContent = f('title').value.trim() || 'Без названия'));
  const editor = mountEditor(card.querySelector('[data-md]'), { value: issue.description || '', onChange: save, askLink });

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

// ---------- Фоновый скрипт на старом коде ----------
// Автосохранение в папку делает фоновый скрипт. Если файлы расширения обновили, а само расширение не
// перезагрузили, он продолжает работать на старом коде и пишет на диск данные в старом формате.
async function checkBackgroundCode() {
  const mine = await codeFingerprint();
  if (!mine) return;
  const reply = await chrome.runtime.sendMessage({ type: 'drc:codeVersion' }).catch(() => null);
  if (!reply || reply.fingerprint === mine) return;
  // Старый фоновый скрипт этого сообщения не знает и отвечает ошибкой — это тоже старый код.
  if (reply.ok !== false && !reply.fingerprint) return;
  const bar = document.createElement('div');
  bar.className = 'stale-bg';
  bar.setAttribute('role', 'alert');
  bar.innerHTML = `${icon('warning', 18)}
    <div class="stale-text"><b>Расширение обновилось, но не перезагружено</b>
      <span>Фоновая часть работает на старой версии, поэтому автосохранение может записывать в папку неполные данные. Перезагрузите расширение — страница откроется снова.</span></div>
    <button class="btn btn-primary" data-act="reload-ext">Перезагрузить расширение</button>`;
  bar.querySelector('[data-act=reload-ext]').addEventListener('click', async () => {
    // Всё, что записал старый код, после перезагрузки перезапишется заново.
    await chrome.storage.local.remove('folderSynced');
    await chrome.storage.local.set({ [REOPEN_KEY]: location.href });
    chrome.runtime.reload();
  });
  document.body.append(bar);
}
checkBackgroundCode();

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

// Только из обработчика клика: браузер открывает выбор папки в ответ на действие пользователя.
async function pickFolder() {
  let dir;
  try {
    ({ dir } = await folder.pickResultsFolder());
  } catch (e) {
    if (e.name !== 'AbortError') await notify('Не удалось выбрать папку', e.message);
    return;
  }
  await saveAllToFolder(dir, { restore: true });
  renderFolder();
}

// Сверка с папкой: ревью, которые сохранялись в неё раньше, но их файлов там больше нет (папку очистили,
// удалили или перенесли из неё ревью вручную). Без доступа к папке проверить нельзя — тогда молчим.
async function checkMissing() {
  const check = await folder.checkFolderContents().catch(() => null);
  // Уже открыто другое окно (например, клик, вернувший доступ, был по «Удалить») — спросим при следующем открытии.
  if (!check?.missing.length || document.getElementById('danger').open) return;
  const { missing, found, folderGone, dirName } = check;
  const n = missing.length;
  const { action } = await showDialog({
    label: 'Папка для результатов',
    question: folderGone ? `Папки «${dirName}» больше нет` : found ? `В папке «${dirName}» нет ${n} ревью` : `Папка «${dirName}» пуста`,
    alertTitle: `${n === 1 ? 'Это ревью сохранялось' : 'Эти ревью сохранялись'} в папку раньше, но ${folderGone ? 'папку удалили или переместили' : 'файлы удалили или переместили'}:`,
    alertItems: missing.map((m) => `${m.title} — ${m.issueCount} зам.`),
    note: 'Удаление из расширения необратимо: замечания, скриншоты и описания пропадут. Если ревью ещё нужны — сохраните их заново.',
    confirmText: 'Удалить из расширения',
    confirmIcon: 'trash',
    cancelText: 'Решить позже',
    extra: folderGone ? { text: 'Выбрать папку заново', icon: 'folderOpen', close: true } : { text: 'Сохранить заново', icon: 'save', close: true },
  });
  const ids = missing.map((m) => m.id);
  if (action === 'ok') {
    await folder.forgetMissing(ids);
    if (ids.includes(currentId)) currentId = null;
  } else if (action === 'extra') {
    if (folderGone) await pickFolder();
    else await folder.resaveMissing(ids);
  } else return;
  render();
  renderFolder();
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

  folderEl.querySelector('[data-act=pick]')?.addEventListener('click', pickFolder);
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
// Затем сверяемся с папкой: вдруг её очистили вручную, а ревью в расширении остались.
folder.flushUnsaved().finally(async () => {
  renderFolder();
  checkMissing();
  const dir = await folder.getDir();
  if (dir && (await folder.permission(dir).catch(() => 'prompt')) === 'prompt') {
    folder.regainAccessOnClick(document, dir, { ignore: '#folder, #danger' }).then((result) => {
      regainResult = result.state === 'granted' ? null : result;
      renderFolder();
      if (result.state === 'granted') checkMissing();
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

