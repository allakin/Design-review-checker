// Сохранение результатов ревью в папку на диске (File System Access API).
// Пользователь один раз выбирает папку на странице ревью; дескриптор хранится в IndexedDB,
// дальше background.js после каждого изменения записывает ревью в эту папку:
//   <папка>/<Название ревью — дата>/Отчёт.html      — самодостаточный отчёт со скриншотами
//   <папка>/<Название ревью — дата>/review.json     — данные ревью
//   <папка>/<Название ревью — дата>/screenshots/*.png

import { buildReportDocument } from './report.js';
import { severityOf } from './constants.js';

const DB_NAME = 'drc-folder';
const STORE = 'kv';
const DIR_KEY = 'resultsDir';
const KEY_FOLDER_NAMES = 'folderNames'; // { [reviewId]: имя подпапки }
export const KEY_FOLDER_STATUS = 'folderStatus';
const REPORT_FILE = 'Отчёт.html';
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

// Подключает папку результатов. Обычно выбирают reviews-results из папки расширения;
// если выбрали родительскую папку (саму папку расширения) — берём reviews-results внутри неё, создавая при необходимости.
export async function connectResultsFolder(picked) {
  const isResults = picked.name === RESULTS_DIR;
  const dir = isResults ? picked : await picked.getDirectoryHandle(RESULTS_DIR, { create: true });
  const project = isResults ? '' : picked.name;
  await setDir(dir);
  await setStatus({ state: 'ok', dirName: dir.name, project, error: '' });
  return { dir, project };
}

// Только из обработчика клика на странице расширения (не в popup — он закрывается при открытии диалога).
export async function pickResultsFolder() {
  return connectResultsFolder(await showDirectoryPicker({ id: 'drc-results', mode: 'readwrite' }));
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
let namesQueue = Promise.resolve();
function withNames(fn) {
  const run = namesQueue.then(async () => {
    const { [KEY_FOLDER_NAMES]: names = {} } = await chrome.storage.local.get(KEY_FOLDER_NAMES);
    return fn(names, () => chrome.storage.local.set({ [KEY_FOLDER_NAMES]: names }));
  });
  namesQueue = run.catch(() => {});
  return run;
}

function defaultFolderName(review) {
  return `${safeName(review.title)} — ${new Date(review.createdAt).toISOString().slice(0, 10)}`;
}

function folderNameFor(review) {
  return withNames(async (names, save) => {
    if (names[review.id]) return names[review.id];
    const base = defaultFolderName(review);
    const taken = new Set(Object.values(names));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;
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

function shotFileName(issue, n) {
  const ext = issue.screenshot?.startsWith('data:image/jpeg') ? 'jpg' : 'png';
  return `${String(n).padStart(2, '0')} — ${safeName(issue.title, 50)} — ${issue.id.replace(/-/g, '').slice(0, 6)}.${ext}`;
}

// Записывает одно ревью в папку. Возвращает имя подпапки.
export async function writeReview(dir, review) {
  const folder = await dir.getDirectoryHandle(await folderNameFor(review), { create: true });
  const shots = await folder.getDirectoryHandle('screenshots', { create: true });

  const wanted = new Map();
  review.issues.forEach((issue, k) => {
    if (issue.screenshot) wanted.set(shotFileName(issue, k + 1), issue.screenshot);
  });

  // Удаляем скриншоты удалённых/переименованных замечаний (только файлы, созданные расширением).
  const existing = new Map();
  for await (const [name, handle] of shots.entries()) {
    if (handle.kind !== 'file') continue;
    if (wanted.has(name)) existing.set(name, handle);
    else if (SHOT_SUFFIX.test(name)) await shots.removeEntry(name);
  }
  for (const [name, dataUrl] of wanted) {
    const bytes = dataUrlBytes(dataUrl);
    const old = existing.get(name);
    if (old && (await old.getFile()).size === bytes.length) continue; // не переписываем без изменений
    await writeFile(shots, name, bytes);
  }

  const json = {
    format: 'design-review-checker',
    version: 1,
    id: review.id,
    title: review.title,
    author: review.author || '',
    devTicketUrl: review.devTicketUrl || '',
    designTicketUrl: review.designTicketUrl || '',
    createdAt: new Date(review.createdAt).toISOString(),
    updatedAt: new Date(review.updatedAt).toISOString(),
    issues: review.issues.map((issue, k) => {
      const { screenshot, ...rest } = issue;
      return {
        number: k + 1,
        ...rest,
        severityLabel: severityOf(issue.severity).label,
        createdAt: new Date(issue.createdAt).toISOString(),
        screenshotFile: screenshot ? `screenshots/${shotFileName(issue, k + 1)}` : null,
      };
    }),
  };
  await writeFile(folder, 'review.json', JSON.stringify(json, null, 2));
  await writeFile(folder, REPORT_FILE, buildReportDocument(review));
  return folder.name;
}

// Синхронизация без участия пользователя (из background). Никогда не бросает исключений.
export async function syncReview(review) {
  try {
    const dir = await getDir();
    if (!dir) return setStatus({ state: 'no-folder' });
    if ((await permission(dir)) !== 'granted') return setStatus({ state: 'no-permission', dirName: dir.name });
    const folder = await writeReview(dir, review);
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
  try {
    await dir.removeEntry(name, { recursive: true });
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e; // папку уже удалили вручную — это не ошибка
  }
  await withNames(async (names, save) => {
    delete names[review.id];
    await save();
  });
  return { deleted: true, name };
}

export async function writeAll(dir, reviews) {
  for (const review of reviews) await writeReview(dir, review);
  await setStatus({ state: 'ok', dirName: dir.name, lastSyncAt: Date.now(), error: '' });
}
