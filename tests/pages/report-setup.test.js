import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, closePage, connectFolder, sleep } from '../helpers/page.js';
import { MemDir } from '../helpers/fs.js';
import { makeIssue } from '../helpers/env.js';
import * as store from '../../lib/store.js';
import * as folder from '../../lib/folder.js';

after(closePage);

async function report({ action = '', withFolder = false, permission = 'granted', byId = true, issues = 2 } = {}) {
  const ctx = {};
  const page = await loadPage('pages/report', {
    setup: async () => {
      if (withFolder) ctx.root = await connectFolder(MemDir, { permission });
      ctx.review = await store.createReview({ title: 'Оплата', author: 'Анна' });
      for (let i = 0; i < issues; i++) await store.addIssue(ctx.review.id, makeIssue());
    },
  });
  // id известен только после setup — перезапускаем страницу с нужным адресом
  const query = `?${byId ? `id=${ctx.review.id}` : ''}${action ? `&action=${action}` : ''}`;
  const reloaded = await loadPage('pages/report', {
    query,
    setup: async (env) => {
      for (const [k, v] of page.chrome.storage.local.data) await env.chrome.storage.local.set({ [k]: v });
      if (ctx.root) await folder.setDir(ctx.root);
    },
  });
  await sleep(action === 'pdf' ? 400 : 60);
  return { ...reloaded, ...ctx };
}

describe('страница отчёта', () => {
  test('показывает отчёт ревью; заголовок вкладки — имя будущего PDF', async () => {
    const { $, $$, document } = await report();
    assert.equal($('h1').textContent, 'Оплата');
    assert.equal($$('article.issue').length, 2);
    assert.match(document.title, /^Дизайн-ревью — Оплата — \d{4}-\d{2}-\d{2}$/);
    assert.ok($('#report-style').textContent.includes('.issue'));
    assert.ok($('.lb'), 'просмотрщик скриншотов подключён');
    assert.match($('#btn-html').textContent, /Скачать HTML/);
  });

  test('без id открывает текущее ревью', async () => {
    const { $ } = await report({ byId: false });
    assert.equal($('h1').textContent, 'Оплата');
  });

  test('неизвестное ревью — сообщение и неактивные кнопки', async () => {
    const page = await loadPage('pages/report', { query: '?id=nope' });
    assert.match(page.$('#report').textContent, /Ревью не найдено/);
    assert.ok(page.$$('.tb-btn').every((b) => b.disabled));
  });

  test('«Скачать HTML» скачивает самодостаточный файл', async () => {
    const { $, downloads } = await report();
    $('#btn-html').click();
    assert.equal(downloads.length, 1);
    assert.match(downloads[0].name, /^Дизайн-ревью — Оплата — \d{4}-\d{2}-\d{2}\.html$/);
    assert.match(downloads[0].href, /^blob:/);
    assert.equal($('#status').textContent, 'HTML-файл скачан');
  });

  test('action=html с подключённой папкой — отчёт пишется в reviews-results, а не в «Загрузки»', async () => {
    const { $, root, downloads } = await report({ action: 'html', withFolder: true });
    const [sub] = root.list();
    assert.ok(root.has(`${sub}/Отчёт.html`));
    assert.equal(downloads.length, 0);
    assert.equal($('#status').textContent, `Сохранено: reviews-results/${sub}/Отчёт.html`);
  });

  test('action=html без доступа к папке — обычное скачивание', async () => {
    const { downloads, root } = await report({ action: 'html', withFolder: true, permission: 'prompt' });
    assert.equal(downloads.length, 1);
    assert.deepEqual(root.list(), []);
  });

  test('action=html: ошибка записи в папку — сообщение и скачивание', async () => {
    const page = await report({ withFolder: true });
    page.root.failWrites = 'Диск переполнен';
    const again = await loadPage('pages/report', {
      query: `?id=${page.review.id}&action=html`,
      setup: async (env) => {
        for (const [k, v] of page.chrome.storage.local.data) await env.chrome.storage.local.set({ [k]: v });
        await folder.setDir(page.root);
      },
    });
    await sleep(60);
    assert.equal(again.downloads.length, 1);
    assert.equal(again.$('#status').textContent, 'HTML-файл скачан');
  });

  test('action=pdf открывает окно печати с подсказкой', async () => {
    const { window, $ } = await report({ action: 'pdf' });
    assert.equal(window.print.mock.callCount(), 1);
    assert.match($('#status').textContent, /Сохранить как PDF/);
  });

  test('«Сохранить в PDF» вызывает печать', async () => {
    const { window, $ } = await report();
    $('#btn-pdf').click();
    await sleep(20);
    assert.equal(window.print.mock.callCount(), 1);
  });
});

describe('страница первичной настройки', () => {
  test('без папки — кнопка выбора', async () => {
    const { $ } = await loadPage('pages/setup');
    assert.match($('[data-act=pick]').textContent, /Выбрать папку reviews-results/);
    assert.equal($('.done'), null);
  });

  test('выбор папки расширения подключает reviews-results внутри и сохраняет существующие ревью', async () => {
    const page = await loadPage('pages/setup', { setup: () => store.createReview({ title: 'Уже было' }) });
    const ext = new MemDir('Design review checker');
    globalThis.showDirectoryPicker = async () => ext;
    try {
      page.$('[data-act=pick]').click();
      await sleep(120);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.match(ext.list('reviews-results')[0], /^Уже было — /);
    assert.match(page.$('.done h2').textContent, /Папка подключена/);
    assert.equal(page.$('.path').textContent, 'Design review checker/reviews-results/');
    assert.match(page.$('.done').textContent, /⌥⇧D/);
  });

  test('отмена системного диалога — без ошибки; прочие ошибки показываются', async () => {
    const page = await loadPage('pages/setup');
    globalThis.showDirectoryPicker = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    page.$('[data-act=pick]').click();
    await sleep(30);
    assert.equal(page.$('.error'), null);
    globalThis.showDirectoryPicker = async () => {
      throw Object.assign(new Error('Системная папка'), { name: 'SecurityError' });
    };
    page.$('[data-act=pick]').click();
    await sleep(30);
    delete globalThis.showDirectoryPicker;
    assert.equal(page.$('.error').textContent, 'Не удалось подключить папку: Системная папка');
  });

  test('уже подключена — путь, «Начать ревью» закрывает вкладку, «Сменить папку» доступна', async () => {
    const page = await loadPage('pages/setup', { setup: () => connectFolder(MemDir) });
    assert.equal(page.$('.path').textContent, 'reviews-results/');
    assert.ok(page.$('[data-act=pick]'));
    page.$('[data-act=close]').click();
    await sleep(20);
    assert.equal(page.chrome.tabs.remove.mock.callCount(), 1);
  });

  test('ошибка первичного сохранения не мешает подключению — статус error', async () => {
    const page = await loadPage('pages/setup', { setup: async () => store.addIssue((await store.createReview({ title: 'R' })).id, makeIssue()) });
    const dir = new MemDir('reviews-results');
    dir.failWrites = 'Только чтение';
    globalThis.showDirectoryPicker = async () => dir;
    try {
      page.$('[data-act=pick]').click();
      await sleep(120);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.ok(page.$('.done'));
    assert.equal(page.chrome.storage.local.data.get(folder.KEY_FOLDER_STATUS).state, 'error');
  });
});
