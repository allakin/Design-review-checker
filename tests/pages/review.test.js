import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, closePage, connectFolder, sleep } from '../helpers/page.js';
import { MemDir } from '../helpers/fs.js';
import { makeIssue } from '../helpers/env.js';
import * as store from '../../lib/store.js';
import * as folder from '../../lib/folder.js';

after(closePage);

// Три ревью: «Альфа» (2 замечания), «Бета» (текущее, 0), «Гамма» (1). Создаются по очереди.
async function seed({ withFolder = true, permission = 'granted' } = {}) {
  const ctx = {};
  const page = await loadPage('pages/review', {
    setup: async () => {
      if (withFolder) ctx.root = await connectFolder(MemDir, { permission });
      ctx.alpha = await store.createReview({ title: 'Альфа', author: 'Анна', devTicketUrl: 'https://st.example.com/DEV-1' });
      ctx.a1 = (await store.addIssue(ctx.alpha.id, makeIssue({ title: 'Кнопка', severity: 'low', page: { url: 'https://shop.ru/cart', title: 'Корзина' } }))).issue;
      ctx.a2 = (await store.addIssue(ctx.alpha.id, makeIssue({ title: 'Шапка', severity: 'critical' }))).issue;
      await sleep(3);
      ctx.gamma = await store.createReview({ title: 'Гамма' });
      await store.addIssue(ctx.gamma.id, makeIssue({ title: 'Футер' }));
      await sleep(3);
      ctx.beta = await store.createReview({ title: 'Бета' });
    },
  });
  return { ...page, ...ctx };
}

const titles = ($$) => $$('#review-list li[data-id] .t').map((t) => t.textContent);
const openReview = async (page, review) => {
  page.$(`#review-list li[data-id="${review.id}"]`).click();
  await sleep(30);
};

describe('список ревью', () => {
  test('по умолчанию — недавно изменённые, открыто текущее ревью', async () => {
    const { $$, $ } = await seed();
    assert.deepEqual(titles($$), ['Бета', 'Гамма', 'Альфа']);
    assert.equal($('#review-list li.current .t').textContent, 'Бета');
    assert.ok($('#review-list li.current .badge'));
    assert.equal($('.title-input').value, 'Бета');
    assert.equal($('#found').textContent, 'Всего: 3');
  });

  test('сортировки: новые, старые, по названию, по числу замечаний; выбор запоминается', async () => {
    const { $, $$, window, chrome } = await seed();
    const sort = async (v) => {
      $('#sort').value = v;
      $('#sort').dispatchEvent(new window.Event('change'));
      await sleep(30);
      return titles($$);
    };
    assert.deepEqual(await sort('created-asc'), ['Альфа', 'Гамма', 'Бета']);
    assert.deepEqual(await sort('created-desc'), ['Бета', 'Гамма', 'Альфа']);
    assert.deepEqual(await sort('title-asc'), ['Альфа', 'Бета', 'Гамма']);
    assert.deepEqual(await sort('issues-desc'), ['Альфа', 'Гамма', 'Бета']);
    assert.equal(chrome.storage.local.data.get('reviewSort'), 'issues-desc');
  });

  test('сохранённая сортировка применяется при открытии', async () => {
    const page = await loadPage('pages/review', {
      setup: async (env) => {
        await env.chrome.storage.local.set({ reviewSort: 'title-asc' });
        await store.createReview({ title: 'Я' });
        await store.createReview({ title: 'А' });
      },
    });
    assert.equal(page.$('#sort').value, 'title-asc');
    assert.deepEqual(titles(page.$$), ['А', 'Я']);
  });

  test('поиск по названию, ревьюеру, тикетам, замечаниям и страницам; несколько слов; Esc очищает', async () => {
    const { $, $$, input, key } = await seed();
    const search = async (q) => {
      input($('#search'), q);
      await sleep(160);
      return titles($$);
    };
    assert.deepEqual(await search('гам'), ['Гамма']);
    assert.equal($('#found').textContent, 'Найдено: 1 из 3');
    assert.deepEqual(await search('АННА'), ['Альфа']);
    assert.deepEqual(await search('dev-1'), ['Альфа']);
    assert.deepEqual(await search('футер'), ['Гамма']);
    assert.deepEqual(await search('корзина'), ['Альфа']);
    assert.deepEqual(await search('кнопка шапка'), ['Альфа']);
    assert.deepEqual(await search('кнопка футер'), []);
    assert.equal($('#review-list .empty-list').textContent, 'Ничего не найдено');
    key($('#search'), 'Escape');
    await sleep(160);
    assert.equal($('#search').value, '');
    assert.equal(titles($$).length, 3);
  });

  test('переход по ревью меняет адрес и содержимое', async () => {
    const page = await seed();
    await openReview(page, page.alpha);
    assert.equal(page.$('.title-input').value, 'Альфа');
    assert.equal(new URL(page.window.location.href).searchParams.get('id'), page.alpha.id);
    assert.equal(page.$$('article.issue').length, 2);
  });

  test('без ревью — заглушка', async () => {
    const { $ } = await loadPage('pages/review');
    assert.equal($('#review-list .empty-list').textContent, 'Ревью пока нет');
    assert.match($('#main').textContent, /Ревью не выбрано/);
  });

  test('id из адреса открывает нужное ревью, даже если оно не текущее', async () => {
    const page = await loadPage('pages/review', {
      query: '?id=from-link',
      setup: async (env) => {
        await store.createReview({ title: 'Текущее' });
        const now = Date.now();
        await env.chrome.storage.local.set({
          'review:from-link': { id: 'from-link', title: 'Из ссылки', author: '', createdAt: now, updatedAt: now, issues: [] },
          reviewIndex: [...(await store.listReviews()), { id: 'from-link', title: 'Из ссылки', author: '', createdAt: now, updatedAt: now, issueCount: 0 }],
        });
      },
    });
    assert.equal(page.$('.title-input').value, 'Из ссылки');
    assert.ok(page.$('[data-act=activate]'));
  });
});

describe('редактирование ревью', () => {
  test('название, ревьюер и тикеты сохраняются автоматически', async () => {
    const page = await seed();
    const { $, input } = page;
    input($('.title-input'), 'Бета 2');
    input($('.author-input'), 'Олег');
    input($('[data-field=review-designTicketUrl]'), 'figma.com/file/1');
    await sleep(500);
    const r = await store.getReview(page.beta.id);
    assert.equal(r.title, 'Бета 2');
    assert.equal(r.author, 'Олег');
    assert.equal(r.designTicketUrl, 'https://figma.com/file/1');
    const open = $('[data-open=designTicketUrl]');
    assert.equal(open.hidden, false);
    assert.equal(open.href, 'https://figma.com/file/1');
  });

  test('пустое название → «Дизайн-ревью»; некорректный тикет не сохраняется и подсвечен', async () => {
    const page = await seed();
    const { $, input } = page;
    input($('.title-input'), '   ');
    input($('[data-field=review-devTicketUrl]'), 'не ссылка');
    await sleep(500);
    const r = await store.getReview(page.beta.id);
    assert.equal(r.title, 'Дизайн-ревью');
    assert.equal(r.devTicketUrl, '');
    assert.ok($('[data-field=review-devTicketUrl]').classList.contains('invalid'));
  });

  test('«Сделать текущим» переключает ревью для новых замечаний', async () => {
    const page = await seed();
    await openReview(page, page.alpha);
    page.$('[data-act=activate]').click();
    await sleep(30);
    assert.equal(await store.getActiveReviewId(), page.alpha.id);
    assert.match(page.$('.active-note').textContent, /Новые замечания попадают в это ревью/);
  });

  test('экспорт HTML/PDF открывает страницу отчёта; без замечаний кнопки неактивны', async () => {
    const page = await seed();
    assert.equal(page.$('[data-act=html]').disabled, true);
    await openReview(page, page.alpha);
    page.$('[data-act=pdf]').click();
    assert.equal(page.chrome.tabs.create.mock.calls.at(-1).arguments[0].url, page.chrome.runtime.getURL(`pages/report.html?id=${page.alpha.id}&action=pdf`));
    page.$('[data-act=html]').click();
    assert.match(page.chrome.tabs.create.mock.calls.at(-1).arguments[0].url, /action=html$/);
  });

  test('«Новое ревью» через диалог: название и ревьюер текущего', async () => {
    const page = await seed();
    await openReview(page, page.alpha);
    page.$('#btn-new').click();
    const field = page.$('#danger .danger-input');
    assert.equal(page.$('#danger').open, true);
    assert.equal(field.value, 'Дизайн-ревью');
    field.value = 'Новое из диалога';
    page.key(field, 'Enter');
    await sleep(40);
    const active = await store.getActiveReview();
    assert.equal(active.title, 'Новое из диалога');
    assert.equal(active.author, 'Анна');
    assert.equal(page.$('.title-input').value, 'Новое из диалога');
  });

  test('отмена диалога нового ревью ничего не создаёт', async () => {
    const page = await seed();
    page.$('#btn-new').click();
    page.$('#danger button[value=cancel]').click();
    await sleep(30);
    assert.equal((await store.listReviews()).length, 3);
  });
});

describe('замечания', () => {
  async function alphaPage() {
    const page = await seed();
    await openReview(page, page.alpha);
    return page;
  }
  const card = (page, issue) => page.$(`[data-issue="${issue.id}"]`);

  test('карточки: номер, поля, страница, селектор, критичность', async () => {
    const page = await alphaPage();
    const c = card(page, page.a1);
    assert.equal(c.querySelector('.num').textContent, '#1');
    assert.equal(c.querySelector('[data-field=title]').value, 'Кнопка');
    assert.equal(c.querySelector('[data-field=mockupUrl]').value, page.a1.mockupUrl);
    assert.equal(c.querySelector('[data-sev][aria-pressed=true]').dataset.sev, 'low');
    assert.equal(c.querySelector('.props a').textContent, 'Корзина');
    assert.equal(c.querySelector('.props code').textContent, 'main > .card');
    assert.equal(c.querySelector('[data-act=up]').disabled, true);
    assert.equal(card(page, page.a2).querySelector('[data-act=down]').disabled, true);
    assert.deepEqual(page.$$('.summary .chip').map((x) => x.textContent), ['Критическая: 1', 'Низкая: 1']);
  });

  test('правка полей сохраняется; некорректная ссылка на макет — нет', async () => {
    const page = await alphaPage();
    const c = card(page, page.a1);
    page.input(c.querySelector('[data-field=title]'), 'Кнопка «Купить»');
    page.input(c.querySelector('[data-field=description]'), '  Нужен отступ 16px  ');
    page.input(c.querySelector('[data-field=mockupUrl]'), 'это не ссылка');
    await sleep(500);
    const saved = (await store.getReview(page.alpha.id)).issues[0];
    assert.equal(saved.title, 'Кнопка «Купить»');
    assert.equal(saved.description, 'Нужен отступ 16px');
    assert.equal(saved.mockupUrl, page.a1.mockupUrl);
    assert.ok(c.querySelector('[data-field=mockupUrl]').classList.contains('invalid'));
    assert.ok(page.$('.saved').classList.contains('show'));
  });

  test('пустое название замечания → «Без названия»', async () => {
    const page = await alphaPage();
    page.input(card(page, page.a1).querySelector('[data-field=title]'), '');
    await sleep(500);
    assert.equal((await store.getReview(page.alpha.id)).issues[0].title, 'Без названия');
  });

  test('смена критичности', async () => {
    const page = await alphaPage();
    card(page, page.a1).querySelector('[data-sev=high]').click();
    await sleep(40);
    assert.equal((await store.getReview(page.alpha.id)).issues[0].severity, 'high');
    assert.equal(card(page, page.a1).querySelector('[data-sev][aria-pressed=true]').dataset.sev, 'high');
  });

  test('перестановка вверх/вниз', async () => {
    const page = await alphaPage();
    card(page, page.a2).querySelector('[data-act=up]').click();
    await sleep(40);
    assert.deepEqual((await store.getReview(page.alpha.id)).issues.map((i) => i.title), ['Шапка', 'Кнопка']);
    assert.equal(card(page, page.a2).querySelector('.num').textContent, '#1');
    card(page, page.a2).querySelector('[data-act=down]').click();
    await sleep(40);
    assert.deepEqual((await store.getReview(page.alpha.id)).issues.map((i) => i.title), ['Кнопка', 'Шапка']);
  });

  test('удаление замечания — только после подтверждения', async () => {
    const page = await alphaPage();
    card(page, page.a1).querySelector('[data-act=delete]').click();
    await sleep(20);
    assert.match(page.$('#danger .danger-q').textContent, /Удалить замечание «Кнопка»\?/);
    page.$('#danger button[value=cancel]').click();
    await sleep(30);
    assert.equal((await store.getReview(page.alpha.id)).issues.length, 2);
    card(page, page.a1).querySelector('[data-act=delete]').click();
    await sleep(20);
    page.$('#danger button[value=ok]').click();
    await sleep(40);
    assert.deepEqual((await store.getReview(page.alpha.id)).issues.map((i) => i.title), ['Шапка']);
    assert.equal(page.$$('article.issue').length, 1);
  });

  test('клик по скриншоту открывает его крупно, клик/Esc закрывает', async () => {
    const page = await alphaPage();
    card(page, page.a1).querySelector('[data-act=zoom]').click();
    assert.equal(page.$('#lightbox').hidden, false);
    assert.equal(page.$('#lightbox img').src, page.a1.screenshot);
    page.key(page.document, 'Escape');
    assert.equal(page.$('#lightbox').hidden, true);
  });

  test('HTML в данных замечания выводится текстом', async () => {
    let rid;
    const page = await loadPage('pages/review', {
      setup: async () => {
        rid = (await store.createReview({ title: '<b>R</b>' })).id;
        await store.addIssue(rid, makeIssue({ title: '<img src=x onerror=alert(1)>', screenshotNote: '<script>x</script>', element: { selector: '<i>', width: 1, height: 1 } }));
      },
    });
    assert.equal(page.$('[data-field=title]').value, '<img src=x onerror=alert(1)>');
    assert.equal(page.document.querySelectorAll('#main img[onerror], #main script').length, 0);
    assert.equal(page.$('#main .props code').textContent, '<i>');
    assert.equal(page.$('#review-list .t').textContent, '<b>R</b>');
  });

  test('новые замечания из контент-скрипта появляются без перезагрузки', async () => {
    const page = await seed();
    await store.addIssue(page.beta.id, makeIssue({ title: 'Только что' }));
    await sleep(1100);
    await store.addIssue(page.beta.id, makeIssue({ title: 'Ещё одно' }));
    await sleep(40);
    assert.deepEqual(page.$$('article.issue [data-field=title]').map((i) => i.value), ['Только что', 'Ещё одно']);
  });
});

describe('удаление ревью', () => {
  test('из шапки: подтверждение со списком того, что удалится, включая папку на диске', async () => {
    const page = await seed();
    await openReview(page, page.alpha);
    const sub = await folder.writeReview(page.root, await store.getReview(page.alpha.id));
    page.$('[data-act=delete-review]').click();
    await sleep(30);
    const dlg = page.$('#danger');
    assert.match(dlg.querySelector('.danger-q').textContent, /Удалить ревью «Альфа»\?/);
    const items = [...dlg.querySelectorAll('.danger-alert li')].map((li) => li.textContent);
    assert.match(items[0], /^2 замечания со скриншотами/);
    assert.equal(items[1], `папка reviews-results/${sub} на диске — Отчёт.html, review.json и скриншоты`);
    dlg.querySelector('button[value=ok]').click();
    await sleep(60);
    assert.equal(await store.getReview(page.alpha.id), null);
    assert.ok(!page.root.has(sub));
    assert.deepEqual(titles(page.$$), ['Бета', 'Гамма']);
  });

  test('отмена ничего не удаляет', async () => {
    const page = await seed();
    page.$('[data-act=delete-review]').click();
    await sleep(30);
    page.$('#danger button[value=cancel]').click();
    await sleep(30);
    assert.equal((await store.listReviews()).length, 3);
  });

  test('корзина в списке удаляет ревью, не открывая его', async () => {
    const page = await seed();
    page.$(`#review-list li[data-id="${page.gamma.id}"] [data-act=delete]`).click();
    await sleep(30);
    assert.match(page.$('#danger .danger-q').textContent, /«Гамма»/);
    assert.match(page.$('#danger .danger-alert li').textContent, /^1 замечание/);
    page.$('#danger button[value=ok]').click();
    await sleep(60);
    assert.deepEqual(titles(page.$$), ['Бета', 'Альфа']);
    assert.equal(page.$('.title-input').value, 'Бета');
  });

  test('если папку на диске удалить не удалось — ревью удалено, пользователь предупреждён', async () => {
    const page = await seed();
    await openReview(page, page.alpha);
    const sub = await folder.writeReview(page.root, await store.getReview(page.alpha.id));
    page.root.removeEntry = async () => {
      throw Object.assign(new Error('Файл занят'), { name: 'NoModificationAllowedError' });
    };
    page.$('[data-act=delete-review]').click();
    await sleep(30);
    page.$('#danger button[value=ok]').click();
    await sleep(60);
    assert.equal(await store.getReview(page.alpha.id), null);
    assert.match(page.$('#danger .danger-q').textContent, /папка на диске осталась/);
    assert.match(page.$('#danger .danger-note').textContent, new RegExp(`«${sub}».*Файл занят`));
  });

  test('«Скачать отчёт» в диалоге открывает экспорт HTML', async () => {
    const page = await seed();
    await openReview(page, page.alpha);
    page.$('[data-act=delete-review]').click();
    await sleep(30);
    page.$('#danger [data-act=extra]').click();
    assert.equal(page.chrome.tabs.create.mock.calls.at(-1).arguments[0].url, page.chrome.runtime.getURL(`pages/report.html?id=${page.alpha.id}&action=html`));
  });
});

describe('папка для результатов', () => {
  test('не подключена — предупреждение и кнопка выбора; выбор сохраняет все ревью', async () => {
    const page = await seed({ withFolder: false });
    const box = page.$('#folder');
    assert.ok(box.classList.contains('attention'));
    assert.match(box.textContent, /Не подключена/);
    const ext = new MemDir('Design review checker');
    globalThis.showDirectoryPicker = async () => ext;
    try {
      box.querySelector('[data-act=pick]').click();
      await sleep(150);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.equal(ext.list('reviews-results').length, 3);
    assert.match(page.$('#folder .folder-name').textContent, /Design review checker\/reviews-results\//);
    assert.match(page.$('#folder').textContent, /Сохраняется автоматически/);
  });

  test('выбор папки подтягивает сохранённые в ней ревью и показывает итог', async () => {
    const page = await seed({ withFolder: false });
    const saved = new MemDir('reviews-results');
    await folder.writeReview(saved, { id: 'disk-1', title: 'С диска', createdAt: Date.UTC(2026, 0, 1), updatedAt: Date.UTC(2026, 0, 1), issues: [] });
    saved.put('Битое/review.json', '{');
    globalThis.showDirectoryPicker = async () => saved;
    try {
      page.$('#folder [data-act=pick]').click();
      await sleep(200);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.ok(titles(page.$$).includes('С диска'));
    assert.match(page.$('#folder .folder-state.warn').textContent, /Восстановлено ревью из папки: 1\. Не удалось прочитать review\.json в папках: Битое\./);
  });

  test('в выбранной папке нет сохранённых ревью — подсказка указать другую', async () => {
    const page = await seed({ withFolder: false });
    globalThis.showDirectoryPicker = async () => new MemDir('reviews-results');
    try {
      page.$('#folder [data-act=pick]').click();
      await sleep(150);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.match(page.$('#folder').textContent, /нет сохранённых ревью.*«Сменить»/);
  });

  test('отмена системного диалога выбора — без сообщений', async () => {
    const page = await seed({ withFolder: false });
    globalThis.showDirectoryPicker = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    try {
      page.$('#folder [data-act=pick]').click();
      await sleep(30);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.equal(page.$('#danger').open, false);
  });

  test('нет разрешения — «Разрешить доступ» запрашивает его и сохраняет ревью', async () => {
    const page = await seed({ permission: 'prompt' });
    assert.match(page.$('#folder').textContent, /Нет доступа к папке\. Кликните в любом месте страницы/);
    page.$('#folder [data-act=grant]').click();
    await sleep(100);
    assert.equal(page.root.permission, 'granted');
    assert.equal(page.root.list().length, 3);
  });

  test('нет разрешения — первый клик в любом месте страницы молча возвращает доступ и дописывает несохранённое', async () => {
    const page = await seed({ permission: 'prompt' });
    await sleep(30);
    assert.deepEqual(page.root.list(), [], 'до клика ничего не пишется и не запрашивается');
    assert.equal(page.root.permission, 'prompt');
    page.$('#main').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await sleep(120);
    assert.equal(page.root.permission, 'granted');
    assert.equal(page.root.list().length, 3);
    assert.deepEqual(await folder.unsavedReviews(), []);
    assert.match(page.$('#folder').textContent, /Сохраняется автоматически/);
  });

  test('браузер не дал доступ по клику — блок папки показывает его ответ', async () => {
    const page = await seed({ permission: 'prompt' });
    page.root.grantOnRequest = false;
    await sleep(30);
    page.$('#main').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await sleep(80);
    assert.match(page.$('#folder .folder-state.err').textContent, /Браузер не дал доступ по клику \(ответ: prompt\)/);
  });

  test('клик по блоку папки не запускает фоновый запрос доступа (там свои кнопки)', async () => {
    const page = await seed({ permission: 'prompt' });
    await sleep(30);
    page.$('#folder').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    assert.equal(page.root.permission, 'prompt');
  });

  test('с доступом блок папки просит не закрывать страницу', async () => {
    const page = await seed();
    assert.match(page.$('#folder').textContent, /Не закрывайте эту страницу: пока она открыта, ревью сохраняются в папку/);
  });

  test('«Сохранить сейчас» пишет все ревью', async () => {
    const page = await seed();
    page.$('#folder [data-act=save]').click();
    await sleep(100);
    assert.equal(page.root.list().length, 3);
  });

  test('«Отключить» после подтверждения отвязывает папку, файлы остаются', async () => {
    const page = await seed();
    page.root.put('keep.txt', 'x');
    page.$('#folder [data-act=disconnect]').click();
    await sleep(20);
    assert.match(page.$('#danger .danger-q').textContent, /Отключить папку «reviews-results»\?/);
    page.$('#danger button[value=ok]').click();
    await sleep(60);
    assert.equal(await folder.getDir(), undefined);
    assert.ok(page.root.has('keep.txt'));
    assert.match(page.$('#folder').textContent, /Не подключена/);
  });

  test('ошибка записи показывается в блоке папки', async () => {
    const page = await seed();
    await folder.setStatus({ state: 'error', error: 'Нет места' });
    await sleep(40);
    assert.match(page.$('#folder .folder-state.err').textContent, /Ошибка записи: Нет места/);
  });
});
