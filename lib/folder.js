// Сохранение результатов ревью в папку на диске (File System Access API).
// Пользователь один раз выбирает папку на странице ревью; дескриптор хранится в IndexedDB,
// дальше background.js после каждого изменения записывает ревью в эту папку:
//   <папка>/<Название ревью — дата>/Отчёт.html      — самодостаточный отчёт со скриншотами
//   <папка>/<Название ревью — дата>/review.json     — данные ревью
//   <папка>/<Название ревью — дата>/screenshots/*.png  — скриншоты и картинки «Визуальные пояснения»
// При подключении папки ревью, сохранённые в ней раньше, подтягиваются обратно (importFromFolder) —
// так переживается переустановка расширения, при которой chrome.storage очищается.

import { buildReportDocument, fixImagesOf } from './report.js';
import { severityOf } from './constants.js';
import * as store from './store.js';

const DB_NAME = 'drc-folder';
const STORE = 'kv';
const DIR_KEY = 'resultsDir';
const KEY_FOLDER_NAMES = 'folderNames'; // { [reviewId]: имя подпапки }
const KEY_FOLDER_SYNCED = 'folderSynced'; // { [reviewId]: { at: updatedAt версии на диске, v: WRITER_VERSION } }
// Версия формата записи на диск. Меняйте при любом изменении того, что и как пишется в папку: ревью, записанные
// прежним форматом (или старым кодом фонового скрипта), тогда перезапишутся сами.
// 2 — визуальные пояснения отдельными файлами, Markdown-описание в отчёте.
export const WRITER_VERSION = 2;
export const KEY_FOLDER_STATUS = 'folderStatus';
export const REPORT_FILE = 'Отчёт.html';
export const DATA_FILE = 'review.json';
const FORMAT = 'design-review-checker';
const SHOT_SUFFIX = /— [0-9a-f]{6}\.(png|jpg)$/;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const getDir = () => idb('readonly', (s) => s.get(DIR_KEY));
export const setDir = (handle) => idb('readwrite', (s) => s.put(handle, DIR_KEY));
export const clearDir = () => idb('readwrite', (s) => s.delete(DIR_KEY));

export const RESULTS_DIR = 'reviews-results';

// Отвязывает папку: расширение перестаёт писать на диск, уже сохранённые файлы остаются.
export async function disconnectFolder() {
  await clearDir();
  await chrome.storage.local.set({ [KEY_FOLDER_STATUS]: { state: 'no-folder' } });
}

// Подключает папку результатов. Обычно выбирают reviews-results из папки расширения.
// Папка с другим именем, в которой уже лежат сохранённые ревью, используется как есть —
// это папка, куда пользователь сохранял результаты раньше. Иначе считаем, что выбрали
// родительскую папку (саму папку расширения), и берём reviews-results внутри неё, создавая при необходимости.
// readOnly — папку открыли только для чтения (восстановление): reviews-results не создаём,
// если её нет — берём выбранную папку как есть.
export async function connectResultsFolder(picked, { readOnly = false } = {}) {
  const isResults = picked.name === RESULTS_DIR || (await hasSavedReviews(picked));
  let dir = picked;
  let project = '';
  if (!isResults) {
    try {
      dir = await picked.getDirectoryHandle(RESULTS_DIR, { create: !readOnly });
      project = picked.name;
    } catch (e) {
      if (!readOnly || e.name !== 'NotFoundError') throw e;
    }
  }
  await setDir(dir);
  await setStatus({ state: 'ok', dirName: dir.name, project, error: '' });
  return { dir, project };
}

// Только из обработчика клика на странице расширения (не в popup — он закрывается при открытии диалога).
// readOnly — для восстановления: браузер спрашивает только про чтение. Запись он всё равно забудет, как только
// закроется вкладка, поэтому её разрешают позже, в окне расширения (там можно выбрать «Разрешать всегда»).
export async function pickResultsFolder({ readOnly = false } = {}) {
  const picked = await showDirectoryPicker({ id: 'drc-results', mode: readOnly ? 'read' : 'readwrite' });
  return connectResultsFolder(picked, { readOnly });
}

// «my-project/reviews-results» или просто «reviews-results», если проект неизвестен.
export function folderLabel(dir, status = {}) {
  return status.project ? `${status.project}/${dir.name}` : dir.name;
}

// 'granted' | 'prompt' | 'denied'. request=true — только из обработчика клика на странице.
export async function permission(dir, request = false) {
  const opts = { mode: 'readwrite' };
  let state = await dir.queryPermission(opts);
  if (state === 'prompt' && request) state = await dir.requestPermission(opts);
  return state;
}

// Доступ к выбранной папке браузер помнит, пока открыта хоть одна вкладка расширения; потом спрашивает заново
// (в этом запросе можно выбрать «Разрешать всегда»). Только из обработчика клика на странице расширения:
// из popup запрос не показывается.
// После разрешения дописывает ревью, изменения которых копились без доступа. Возвращает 'granted' | 'prompt' | 'denied'.
export async function requestAccess(dir) {
  const state = await permission(dir, true);
  if (state !== 'granted') return state;
  try {
    await writeAll(dir, await store.getAllReviews());
  } catch (e) {
    await setStatus({ state: 'error', error: e.message });
  }
  return state;
}

export async function setStatus(patch) {
  const { [KEY_FOLDER_STATUS]: prev = {} } = await chrome.storage.local.get(KEY_FOLDER_STATUS);
  await chrome.storage.local.set({ [KEY_FOLDER_STATUS]: { ...prev, ...patch } });
}

export function safeName(value, max = 60) {
  const s = String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, max)
    .trim();
  return s || 'Без названия';
}

// Словарь «ревью → подпапка» меняем строго по очереди: при одновременном сохранении
// нескольких ревью параллельные read-modify-write затирали записи друг друга.
function serialized(key) {
  let queue = Promise.resolve();
  return (fn) => {
    const run = queue.then(async () => {
      const { [key]: map = {} } = await chrome.storage.local.get(key);
      return fn(map, () => chrome.storage.local.set({ [key]: map }));
    });
    queue = run.catch(() => {});
    return run;
  };
}
const withNames = serialized(KEY_FOLDER_NAMES);
// Какая версия каждого ревью уже на диске. Нужна, потому что доступ к папке браузер даёт только пока открыта
// страница расширения: изменения, сделанные без неё (замечания с сайта), дописываются при следующем открытии.
const withSynced = serialized(KEY_FOLDER_SYNCED);
const markSynced = (reviews) =>
  withSynced(async (synced, save) => {
    for (const r of reviews) synced[r.id] = { at: r.updatedAt, v: WRITER_VERSION };
    await save();
  });

function defaultFolderName(review) {
  return `${safeName(review.title)} — ${new Date(review.createdAt).toISOString().slice(0, 10)}`;
}

// Имя свободно, если его нет в словаре и на диске нет чужой папки с таким именем:
// словарь мог потеряться (переустановка), а писать поверх чужого ревью нельзя — удалятся его скриншоты.
async function freeOnDisk(dir, name, reviewId) {
  let sub;
  try {
    sub = await dir.getDirectoryHandle(name);
  } catch {
    return true;
  }
  return (await readReviewJson(sub))?.id === reviewId;
}

// Имя подпапки ревью. dir — выбранная папка (для проверки чужих подпапок на диске); без неё имя выбирается
// только по словарю.
export function folderNameFor(review, dir = null) {
  return withNames(async (names, save) => {
    if (names[review.id]) return names[review.id];
    const base = defaultFolderName(review);
    const taken = new Set(Object.values(names));
    let name = base;
    for (let i = 2; taken.has(name) || (dir && !(await freeOnDisk(dir, name, review.id))); i++) name = `${base} (${i})`;
    names[review.id] = name;
    await save();
    return name;
  });
}

function dataUrlBytes(dataUrl) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

export function shotFileName(issue, n) {
  const ext = issue.screenshot?.startsWith('data:image/jpeg') ? 'jpg' : 'png';
  return `${String(n).padStart(2, '0')} — ${safeName(issue.title, 50)} — ${issue.id.replace(/-/g, '').slice(0, 6)}.${ext}`;
}

// Картинка из «Визуальных пояснений» замечания n. Имя не зависит от позиции картинки: удаление одной
// не переименовывает (и не переписывает) остальные. Порядок картинок — в review.json.
// Суффикс — из id картинки, чтобы старые файлы удалялись по SHOT_SUFFIX.
export function fixFileName(image, n) {
  const ext = image.src?.startsWith('data:image/jpeg') ? 'jpg' : 'png';
  return `${String(n).padStart(2, '0')} — Визуальное пояснение — ${image.id.replace(/-/g, '').slice(0, 6)}.${ext}`;
}

// Содержимое review.json: данные ревью без base64 — скриншоты лежат рядом файлами.
export function reviewJsonText(review) {
  const json = {
    format: FORMAT,
    version: 1,
    id: review.id,
    title: review.title,
    author: review.author || '',
    devTicketUrl: review.devTicketUrl || '',
    designTicketUrl: review.designTicketUrl || '',
    createdAt: new Date(review.createdAt).toISOString(),
    updatedAt: new Date(review.updatedAt).toISOString(),
    issues: review.issues.map((issue, k) => {
      const { screenshot, fixImages, ...rest } = issue;
      return {
        number: k + 1,
        ...rest,
        severityLabel: severityOf(issue.severity).label,
        createdAt: new Date(issue.createdAt).toISOString(),
        screenshotFile: screenshot ? `screenshots/${shotFileName(issue, k + 1)}` : null,
        fixImages: fixImagesOf(issue).map(({ src, ...img }) => ({ ...img, file: `screenshots/${fixFileName({ src, ...img }, k + 1)}` })),
      };
    }),
  };
  return JSON.stringify(json, null, 2);
}

// Запись на диск — строго по одной, в том числе между фоновым скриптом и страницами расширения (у них общий
// origin, а значит и Web Locks). Параллельные записи разных версий одного ревью удаляли друг у друга свежие
// файлы: после удаления картинки на диске пропадали и остальные, пока не нажмёшь «Сохранить сейчас».
const LOCK = 'drc-folder-write';
let localQueue = Promise.resolve();
function diskLock(fn) {
  if (globalThis.navigator?.locks?.request) return navigator.locks.request(LOCK, fn);
  const run = localQueue.then(fn, fn);
  localQueue = run.catch(() => {});
  return run;
}

// Записывает одно ревью в папку. Возвращает имя подпапки (null — ревью уже удалено, ничего не записано).
// Пишется самая свежая версия из хранилища: пока запись ждала очереди, ревью могли изменить.
// onlyIfStored — не писать ревью, которого нет в хранилище (автосохранение не должно воскрешать удалённое).
export function writeReview(dir, review, { onlyIfStored = false } = {}) {
  return diskLock(async () => {
    const current = await store.getReview(review.id);
    if (!current && onlyIfStored) return null;
    return writeReviewNow(dir, current || review);
  });
}

async function writeReviewNow(dir, review) {
  const folder = await dir.getDirectoryHandle(await folderNameFor(review, dir), { create: true });
  const shots = await folder.getDirectoryHandle('screenshots', { create: true });

  const wanted = new Map();
  review.issues.forEach((issue, k) => {
    if (issue.screenshot) wanted.set(shotFileName(issue, k + 1), issue.screenshot);
    for (const img of fixImagesOf(issue)) wanted.set(fixFileName(img, k + 1), img.src);
  });

  const existing = new Map();
  const stale = [];
  for await (const [name, handle] of shots.entries()) {
    if (handle.kind !== 'file') continue;
    if (wanted.has(name)) existing.set(name, handle);
    else if (SHOT_SUFFIX.test(name)) stale.push(name); // только файлы, созданные расширением
  }
  // Сначала — новые и изменённые файлы, потом данные и отчёт, и только затем удаляем лишнее:
  // если запись прервётся, на диске не окажется ссылок на уже удалённые картинки.
  for (const [name, dataUrl] of wanted) {
    const bytes = dataUrlBytes(dataUrl);
    const old = existing.get(name);
    if (old && (await old.getFile()).size === bytes.length) continue; // не переписываем без изменений
    await writeFile(shots, name, bytes);
  }

  await writeFile(folder, DATA_FILE, reviewJsonText(review));
  await writeFile(folder, REPORT_FILE, buildReportDocument(review));
  for (const name of stale) {
    try {
      await shots.removeEntry(name);
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
  }
  await markSynced([review]);
  return folder.name;
}

// Синхронизация без участия пользователя (из background). Никогда не бросает исключений.
export async function syncReview(review) {
  try {
    const dir = await getDir();
    if (!dir) return setStatus({ state: 'no-folder' });
    if ((await permission(dir)) !== 'granted') return setStatus({ state: 'no-permission', dirName: dir.name });
    const folder = await writeReview(dir, review, { onlyIfStored: true });
    // Доступ есть (открыта страница расширения) — заодно дописываем то, что копилось без него.
    for (const meta of await unsavedReviews()) {
      const other = await store.getReview(meta.id);
      if (other) await writeReview(dir, other, { onlyIfStored: true });
    }
    await setStatus({ state: 'ok', dirName: dir.name, lastFolder: folder, lastSyncAt: Date.now(), error: '' });
  } catch (e) {
    await setStatus({ state: 'error', error: e?.message || String(e) });
  }
}

// Имя подпапки ревью в reviews-results, если ревью уже сохранялось на диск.
// review — { id, title, createdAt }. Если запись в словаре потерялась (ревью, сохранённые до исправления
// гонки), ищем папку по стандартному имени — только если она есть на диске и не принадлежит другому ревью.
export async function reviewFolderName(review) {
  const { [KEY_FOLDER_NAMES]: names = {} } = await chrome.storage.local.get(KEY_FOLDER_NAMES);
  if (names[review.id]) return names[review.id];
  if (!review.title || !review.createdAt) return null;
  const guess = defaultFolderName(review);
  if (Object.values(names).includes(guess)) return null;
  const dir = await getDir();
  if (!dir || (await permission(dir).catch(() => 'prompt')) !== 'granted') return null;
  try {
    await dir.getDirectoryHandle(guess);
    return guess;
  } catch {
    return null;
  }
}

// Удаляет подпапку ревью со всем содержимым. request=true — только из обработчика клика.
// Возвращает { deleted, name, reason: 'not-saved' | 'no-folder' | 'no-permission' }.
export async function deleteReviewFolder(review, { request = false } = {}) {
  const name = await reviewFolderName(review);
  if (!name) return { deleted: false, reason: 'not-saved' };
  const dir = await getDir();
  if (!dir) return { deleted: false, name, reason: 'no-folder' };
  if ((await permission(dir, request)) !== 'granted') return { deleted: false, name, reason: 'no-permission' };
  await diskLock(async () => {
    try {
      await dir.removeEntry(name, { recursive: true });
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e; // папку уже удалили вручную — это не ошибка
    }
  });
  await withNames(async (names, save) => {
    delete names[review.id];
    await save();
  });
  return { deleted: true, name };
}

// Ревью, чья текущая версия ещё не записана на диск.
export async function unsavedReviews() {
  const { [KEY_FOLDER_SYNCED]: synced = {} } = await chrome.storage.local.get(KEY_FOLDER_SYNCED);
  const onDisk = (m) => synced[m.id]?.v === WRITER_VERSION && synced[m.id].at >= m.updatedAt;
  return (await store.listReviews()).filter((m) => !onDisk(m));
}

// Дописывает несохранённые ревью, если доступ к папке уже есть (без запроса — можно звать при открытии страницы).
// Возвращает число записанных ревью; ошибки записи — в статус, наружу не бросает.
export async function flushUnsaved() {
  const dir = await getDir();
  if (!dir || (await permission(dir).catch(() => 'prompt')) !== 'granted') return 0;
  let written = 0;
  try {
    for (const meta of await unsavedReviews()) {
      const review = await store.getReview(meta.id);
      if (!review) continue;
      if (await writeReview(dir, review, { onlyIfStored: true })) written++;
    }
    if (written) await setStatus({ state: 'ok', dirName: dir.name, lastSyncAt: Date.now(), error: '' });
  } catch (e) {
    await setStatus({ state: 'error', error: e?.message || String(e) });
  }
  return written;
}

// Браузер не возвращает доступ к папке сам: нужен requestPermission в ответ на действие пользователя.
// Если раньше выбрали «Разрешать всегда», запрос проходит молча — поэтому просим доступ при первом клике
// на странице расширения (ignore — селектор областей со своими кнопками доступа). Затем дописываем несохранённое.
// Именно click, а не pointerdown: окно запроса браузера, открытое на нажатии, закрывается тем же кликом.
// Возвращает промис { state, error } — чтобы страница могла показать, что ответил браузер.
export function regainAccessOnClick(doc, dir, { ignore = '' } = {}) {
  return new Promise((resolve) => {
    const onClick = async (e) => {
      if (ignore && e.target?.closest?.(ignore)) return;
      doc.removeEventListener('click', onClick, true);
      let state = 'prompt';
      let error = '';
      try {
        state = await permission(dir, true);
        if (state === 'granted') await flushUnsaved();
      } catch (err) {
        error = `${err?.name || 'Error'}: ${err?.message || err}`;
        console.warn('[Design Review] запрос доступа к папке:', err);
      }
      resolve({ state, error });
    };
    doc.addEventListener('click', onClick, true);
  });
}

export async function writeAll(dir, reviews) {
  for (const review of reviews) await writeReview(dir, review);
  await setStatus({ state: 'ok', dirName: dir.name, lastSyncAt: Date.now(), error: '' });
}

// ---------- Восстановление ревью из папки ----------

// review.json подпапки: null — файла нет (это не папка ревью); исключение — файл есть, но прочитать его нельзя.
async function readReviewJson(sub) {
  let file;
  try {
    file = await (await sub.getFileHandle(DATA_FILE)).getFile();
  } catch {
    return null;
  }
  const json = JSON.parse(await file.text());
  if (json?.format !== FORMAT || typeof json.id !== 'string' || !json.id || !Array.isArray(json.issues)) {
    throw new Error('не похоже на данные Design Review Checker');
  }
  if (json.version !== 1) throw new Error(`неизвестная версия формата: ${json.version}`);
  return json;
}

// Есть ли в папке хотя бы одна подпапка с сохранённым ревью.
export async function hasSavedReviews(dir) {
  for await (const [, handle] of dir.entries()) {
    if (handle.kind === 'directory' && (await readReviewJson(handle).catch(() => null))) return true;
  }
  return false;
}

// Все подпапки с review.json. failed — имена подпапок, где review.json есть, но повреждён.
async function scanSavedReviews(dir) {
  const saved = [];
  const failed = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'directory') continue;
    try {
      const json = await readReviewJson(handle);
      if (json) saved.push({ name, handle, json });
    } catch {
      failed.push(name);
    }
  }
  // «Ревью — дата» раньше «Ревью — дата (2)»: при копиях одного ревью побеждает исходная папка.
  saved.sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
  return { saved, failed: failed.sort() };
}

function bytesToDataUrl(bytes, mime) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

// Скриншот по относительному пути из review.json («screenshots/01 — … .png») → data URL.
async function readScreenshot(folder, path) {
  const parts = String(path).split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`Недопустимый путь: ${path}`);
  const name = parts.pop();
  let dir = folder;
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  const file = await (await dir.getFileHandle(name)).getFile();
  return bytesToDataUrl(new Uint8Array(await file.arrayBuffer()), /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png');
}

function toTime(value, fallback) {
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : fallback;
}

// review.json + screenshots/ → объект ревью в том виде, в каком его хранит store.js.
async function reviewFromSaved(folder, json) {
  const createdAt = toTime(json.createdAt, Date.now());
  let missingShots = 0;
  const issues = [];
  for (const raw of json.issues) {
    if (!raw || typeof raw !== 'object') continue;
    const { number, severityLabel, screenshotFile, fixImages, ...issue } = raw;
    issue.id = typeof issue.id === 'string' && issue.id ? issue.id : store.uid();
    issue.createdAt = toTime(raw.createdAt, createdAt);
    if (screenshotFile) {
      try {
        issue.screenshot = await readScreenshot(folder, screenshotFile);
      } catch {
        missingShots++;
      }
    }
    if (Array.isArray(fixImages) && fixImages.length) {
      issue.fixImages = [];
      for (const { file, ...img } of fixImages) {
        if (!img || typeof img !== 'object') continue;
        try {
          issue.fixImages.push({ ...img, id: typeof img.id === 'string' && img.id ? img.id : store.uid(), src: await readScreenshot(folder, file) });
        } catch {
          missingShots++;
        }
      }
    }
    issues.push(issue);
  }
  const review = {
    id: json.id,
    title: String(json.title || '').trim() || 'Дизайн-ревью',
    author: json.author || '',
    devTicketUrl: json.devTicketUrl || '',
    designTicketUrl: json.designTicketUrl || '',
    createdAt,
    updatedAt: toTime(json.updatedAt, createdAt),
    issues,
  };
  return { review, missingShots };
}

// Подтягивает из папки ревью, которых нет в расширении (например, после его переустановки).
// Ревью, которые уже есть, не трогает. Возвращает
// { found, imported, failed: [подпапки с повреждённым review.json], missingShots: не найдено скриншотов }.
export async function importFromFolder(dir) {
  const { saved, failed } = await scanSavedReviews(dir);
  // Словарь «ревью → подпапка» восстанавливаем до записи в хранилище: иначе автосохранение
  // создало бы для восстановленного ревью новую папку «(2)» рядом со старой.
  await withNames(async (names, save) => {
    const taken = new Set(Object.values(names));
    for (const { name, json } of saved) {
      if (names[json.id] || taken.has(name)) continue;
      names[json.id] = name;
      taken.add(name);
    }
    await save();
  });
  const known = new Set((await store.listReviews()).map((m) => m.id));
  let imported = 0;
  let missingShots = 0;
  for (const { handle, json } of saved) {
    if (known.has(json.id)) continue;
    known.add(json.id);
    const result = await reviewFromSaved(handle, json);
    if (await store.importReview(result.review)) {
      await markSynced([result.review]);
      imported++;
      missingShots += result.missingShots;
    }
  }
  if (imported) await store.activeOrLatestReview(); // в окне расширения сразу откроется последнее ревью, а не форма создания
  return { found: saved.length, imported, failed, missingShots };
}

// Текст для пользователя по итогам importFromFolder. Пустая строка — сообщать нечего.
export function importSummary({ imported = 0, failed = [], missingShots = 0 } = {}) {
  const parts = [];
  if (imported) parts.push(`Восстановлено ревью из папки: ${imported}.`);
  if (missingShots) parts.push(`Не найдено скриншотов: ${missingShots} — эти замечания восстановлены без картинок.`);
  if (failed.length) parts.push(`Не удалось прочитать review.json в папках: ${failed.join(', ')}.`);
  return parts.join(' ');
}
