import * as store from './lib/store.js';
import { syncReview, getDir } from './lib/folder.js';

// captureVisibleTab ограничен ~2 вызовами в секунду — держим интервал с запасом.
const CAPTURE_INTERVAL_MS = 600;
let lastCaptureAt = 0;
let captureChain = Promise.resolve();

function captureVisible(windowId) {
  const run = captureChain.then(async () => {
    const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } finally {
      lastCaptureAt = Date.now();
    }
  });
  captureChain = run.catch(() => {});
  return run;
}

function reviewMeta(review) {
  return { id: review.id, title: review.title, count: review.issues.length };
}

async function ensureActiveReview(tab) {
  const active = await store.getActiveReview();
  if (active) return active;
  let host = '';
  try {
    host = new URL(tab.url).hostname;
  } catch {}
  const date = new Date().toLocaleDateString('ru-RU');
  return store.createReview({ title: `Ревью ${host || 'страницы'} от ${date}` });
}

// Страница первичной настройки: выбор папки проекта, в которой создаётся reviews-results.
async function openSetup() {
  const url = chrome.runtime.getURL('pages/setup.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function startPick(tabId, { autoCreate = false, delay = 0 } = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^(https?|file):/i.test(tab.url || '')) {
    throw new Error('На служебных страницах браузера выбор элементов недоступен. Откройте сайт.');
  }
  // При первом ревью обязательно подключить папку reviews-results.
  if (!(await getDir())) {
    await openSetup();
    throw new Error('Сначала подключите папку reviews-results — открыла страницу настройки.');
  }
  const review = autoCreate ? await ensureActiveReview(tab) : await store.getActiveReview();
  if (!review) throw new Error('Сначала создайте ревью');

  // Если контент-скрипт уже есть на странице — не внедряем повторно.
  let alive = false;
  try {
    alive = (await chrome.tabs.sendMessage(tabId, { type: 'drc:ping' }))?.pong === true;
  } catch {}
  if (!alive) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/icons.js', 'content/content.js'] });
    } catch (e) {
      const hint = tab.url.startsWith('file:')
        ? ' Для локальных файлов включите «Разрешить доступ к адресам файлов» в настройках расширения.'
        : '';
      throw new Error(`Не удалось подключиться к странице: ${e.message}.${hint}`);
    }
  }
  await chrome.tabs.sendMessage(tabId, { type: 'drc:start', review: reviewMeta(review), delay });
  return {};
}

async function handle(msg, sender) {
  switch (msg.type) {
    case 'drc:startPick':
      return startPick(msg.tabId, { autoCreate: msg.autoCreate, delay: msg.delay });

    case 'drc:capture':
      return { dataUrl: await captureVisible(sender.tab.windowId) };

    case 'drc:saveIssue': {
      const { number } = await store.addIssue(msg.reviewId, msg.issue);
      const review = await store.getReview(msg.reviewId);
      return { number, review: reviewMeta(review) };
    }

    case 'drc:openReview':
      await chrome.tabs.create({ url: chrome.runtime.getURL(`pages/review.html?id=${encodeURIComponent(msg.reviewId)}`) });
      return {};

    default:
      throw new Error(`Неизвестное сообщение: ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type?.startsWith('drc:') || msg.type === 'drc:ping') return false;
  handle(msg, sender).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: error?.message || String(error) }),
  );
  return true;
});

// Автосохранение в папку на диске: любое изменение ревью (новое замечание, правка, удаление)
// через секунду записывается в выбранную папку.
const syncTimers = new Map();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (!key.startsWith('review:') || !newValue) continue;
    clearTimeout(syncTimers.get(newValue.id));
    syncTimers.set(
      newValue.id,
      setTimeout(async () => {
        syncTimers.delete(newValue.id);
        const review = await store.getReview(newValue.id);
        if (review) await syncReview(review);
      }, 1000),
    );
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'start-pick') return;
  const target = tab?.id ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target) return;
  try {
    await startPick(target.id, { autoCreate: true });
  } catch (e) {
    console.warn('[Design Review]', e.message);
  }
});
