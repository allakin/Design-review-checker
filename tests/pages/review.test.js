import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, closePage, connectFolder, sleep } from '../helpers/page.js';
import { MemDir } from '../helpers/fs.js';
import { makeIssue, PNG } from '../helpers/env.js';
import { readFileSync } from 'node:fs';
import * as store from '../../lib/store.js';
import * as folder from '../../lib/folder.js';
import { editorHtml, mountEditor } from '../../pages/md-editor.js';

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

describe('сверка с папкой при открытии', () => {
  // Все ревью сохранены в папку, затем папку очистили вручную.
  async function cleared() {
    const ctx = {};
    const page = await loadPage('pages/review', {
      setup: async () => {
        ctx.root = await connectFolder(MemDir);
        ctx.alpha = await store.createReview({ title: 'Альфа' });
        await sleep(3);
        ctx.beta = await store.createReview({ title: 'Бета' });
        await folder.flushUnsaved();
        ctx.root.children.clear();
      },
    });
    return { ...page, ...ctx };
  }

  test('папку очистили — окно со списком пропавших ревью', async () => {
    const page = await cleared();
    assert.equal(page.$('#danger').open, true);
    assert.equal(page.$('.danger-q').textContent, 'Папка «reviews-results» пуста');
    assert.deepEqual(page.$$('.danger-alert li').map((li) => li.textContent).sort(), ['Альфа — 0 зам.', 'Бета — 0 зам.']);
  });

  test('«Удалить из расширения» — ревью удаляются, страница показывает пустое состояние', async () => {
    const page = await cleared();
    page.$('#danger button[value=ok]').click();
    await sleep(60);
    assert.deepEqual(await store.listReviews(), []);
    assert.match(page.$('#main .empty').textContent, /Ревью не выбрано/);
    assert.match(page.$('#review-list').textContent, /Ревью пока нет/);
  });

  test('«Сохранить заново» — ревью снова в папке', async () => {
    const page = await cleared();
    page.$('#danger [data-act=extra]').click();
    await sleep(80);
    assert.equal(page.root.list().length, 2);
    assert.equal((await store.listReviews()).length, 2);
  });

  test('«Решить позже» — ничего не меняется', async () => {
    const page = await cleared();
    page.$('#danger button[value=cancel]').click();
    await sleep(40);
    assert.equal((await store.listReviews()).length, 2);
    assert.deepEqual(page.root.list(), []);
  });

  test('папка на месте — окно не появляется', async () => {
    const page = await seed();
    assert.equal(page.$('#danger').open, false);
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

  test('блок папки — последний в боковой панели, под растягивающимся списком ревью', async () => {
    const page = await seed();
    assert.equal(page.$('.side').lastElementChild, page.$('#folder'));
    assert.equal(page.$('#folder').previousElementSibling, page.$('#list-wrap'));
    const css = readFileSync(new URL('../../pages/review.css', import.meta.url), 'utf8');
    assert.match(css, /\.side > \.list-wrap \{[^}]*flex: 1 1 auto;/);
  });

  test('боковая панель закреплена на всю высоту окна и не уезжает при прокрутке страницы', () => {
    const css = readFileSync(new URL('../../pages/review.css', import.meta.url), 'utf8');
    assert.match(css, /\.side \{[^}]*position: sticky; top: 0; height: 100vh;/);
    // sticky не выходит за родителя: body высотой в один экран увёл бы панель (и блок папки) вверх после первого экрана
    const body = css.match(/(?:^|\n)(?:html, )?body \{[^}]*\}/g).join('\n');
    assert.doesNotMatch(body, /(?<!-)height: 100%/);
    assert.match(body, /min-height: 100%/);
  });
});

describe('навигация «В этом ревью»', () => {
  async function alphaPage() {
    const page = await seed();
    await openReview(page, page.alpha);
    return page;
  }
  const card = (page, issue) => page.$(`[data-issue="${issue.id}"]`);

  test('навигация «В этом ревью»: сводка и все замечания со ссылками на карточки', async () => {
    const page = await alphaPage();
    const nav = page.$('.rv-layout > nav.r-nav');
    assert.ok(nav);
    assert.equal(nav.querySelector('.r-nav-title').textContent, 'В этом ревью:');
    const links = [...nav.querySelectorAll('a')];
    assert.deepEqual(links.map((a) => a.getAttribute('href')), ['#summary', '#issues', `#${page.a1.id}`, `#${page.a2.id}`]);
    for (const a of links) assert.ok(page.window.document.getElementById(a.getAttribute('href').slice(1)), a.getAttribute('href'));
    assert.deepEqual(links.slice(2).map((a) => a.textContent), ['#1 Кнопка', '#2 Шапка']);
    assert.equal(nav.querySelectorAll('a.active').length, 1);
  });

  test('навигация: клик подсвечивает пункт; порядок и названия следуют за замечаниями', async () => {
    const page = await alphaPage();
    const link = (issue) => [...page.$$('.r-nav a')].find((a) => a.getAttribute('href') === `#${issue.id}`);
    link(page.a2).click();
    assert.deepEqual(page.$$('.r-nav a.active').map((a) => a.getAttribute('href')), [`#${page.a2.id}`]);
    page.input(card(page, page.a1).querySelector('[data-field=title]'), 'Кнопка «Купить»');
    assert.equal(link(page.a1).textContent, '#1 Кнопка «Купить»');
    page.input(card(page, page.a1).querySelector('[data-field=title]'), '  ');
    assert.equal(link(page.a1).textContent, '#1 Без названия');
    await sleep(500);
    card(page, page.a2).querySelector('[data-act=up]').click();
    await sleep(40);
    assert.deepEqual(page.$$('.r-nav ul ul a').map((a) => a.textContent), ['#1 Шапка', '#2 Без названия']);
  });

  test('ревью без замечаний — без навигации', async () => {
    const page = await seed();
    assert.equal(page.$('.r-nav'), null);
  });

  test('навигация закреплена при прокрутке, на узком окне скрыта', () => {
    const css = readFileSync(new URL('../../pages/review.css', import.meta.url), 'utf8');
    assert.match(css, /\.r-nav-inner \{[^}]*position: sticky;/);
    assert.match(css, /@media \(max-width: 1360px\) \{ \.r-nav \{ display: none; \} \}/);
    // Прокручивающийся .main стал бы контейнером для sticky — и навигация уехала бы вместе со страницей
    assert.doesNotMatch(css.match(/\.main \{[^}]*\}/)[0], /overflow: (auto|scroll|hidden)/);
  });
});

describe('«Визуальные пояснения»', () => {
  async function alphaPage() {
    const page = await seed();
    await openReview(page, page.alpha);
    return page;
  }
  const block = (page, issue) => page.$(`[data-issue="${issue.id}"] [data-fix]`);
  const pngFile = (page, name = 'fix.png') => new page.window.File([Buffer.from(PNG.split(',')[1], 'base64')], name, { type: 'image/png' });
  const fixesOf = async (page, issue) => (await store.getReview(page.alpha.id)).issues.find((i) => i.id === issue.id).fixImages || [];
  const withData = (page, type, prop, data, target) => {
    const e = new page.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, prop, { value: data });
    target.dispatchEvent(e);
    return e;
  };

  test('без картинок — приглашение добавить', async () => {
    const page = await alphaPage();
    const b = block(page, page.a1);
    assert.ok(b.querySelector('.fix-empty[data-act=fix-add]'));
    assert.equal(page.$(`[data-issue="${page.a1.id}"] .shot-wrap .field-label`).textContent, 'Скриншот области с сайта');
    assert.equal(b.querySelector('[data-lb-group]'), null);
    assert.equal(b.querySelector('.fix-count'), null);
  });

  test('выбор файлов: картинки сохраняются и показываются, остальные файлы игнорируются', async () => {
    const page = await alphaPage();
    const input = block(page, page.a1).querySelector('[data-fix-input]');
    assert.equal(input.multiple, true);
    const text = new page.window.File(['x'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [pngFile(page, 'a.png'), text, pngFile(page, 'b.png')], configurable: true });
    input.dispatchEvent(new page.window.Event('change'));
    await sleep(80);
    const saved = await fixesOf(page, page.a1);
    assert.deepEqual(saved.map((i) => [i.name, i.src]), [['a.png', PNG], ['b.png', PNG]]);
    const b = block(page, page.a1);
    assert.equal(b.querySelector('.fix-count').textContent, '2');
    assert.equal(b.querySelectorAll('[data-lb-group] .fix-thumb img').length, 2);
    assert.ok(b.querySelector('.fix-tile-add'));
    assert.equal((await fixesOf(page, page.a2)).length, 0, 'другое замечание не задето');
  });

  test('перетаскивание файлов в блок', async () => {
    const page = await alphaPage();
    const b = block(page, page.a2);
    const dt = { types: ['Files'], files: [pngFile(page)], dropEffect: 'none' };
    withData(page, 'dragenter', 'dataTransfer', dt, b);
    assert.ok(b.classList.contains('drop'));
    const e = withData(page, 'drop', 'dataTransfer', dt, b);
    assert.equal(e.defaultPrevented, true);
    await sleep(80);
    assert.equal((await fixesOf(page, page.a2)).length, 1);
  });

  test('файл, брошенный мимо блока, не открывается вместо страницы', async () => {
    const page = await alphaPage();
    const e = withData(page, 'drop', 'dataTransfer', { types: ['Files'], files: [] }, page.$('.summary'));
    assert.equal(e.defaultPrevented, true);
  });

  test('вставка из буфера — в замечание, где стоит фокус; текст не перехватывается', async () => {
    const page = await alphaPage();
    page.$(`[data-issue="${page.a2.id}"] [data-field=title]`).focus();
    const textPaste = withData(page, 'paste', 'clipboardData', { files: [] }, page.document.activeElement);
    assert.equal(textPaste.defaultPrevented, false);
    const e = withData(page, 'paste', 'clipboardData', { files: [pngFile(page)] }, page.document.activeElement);
    assert.equal(e.defaultPrevented, true, 'отменяется сразу — иначе картинка попала бы в редактор описания');
    await sleep(80);
    assert.equal((await fixesOf(page, page.a2)).length, 1);
    assert.equal((await fixesOf(page, page.a1)).length, 0);
  });

  test('удаление картинки — только после подтверждения', async () => {
    const page = await alphaPage();
    await store.addFixImages(page.alpha.id, page.a1.id, [{ src: PNG, name: '1' }, { src: PNG, name: '2' }]);
    await sleep(1100); // запись не со страницы → перерисовка
    block(page, page.a1).querySelector('[data-act=fix-del]').click();
    await sleep(20);
    assert.match(page.$('#danger .danger-q').textContent, /Удалить картинку/);
    page.$('#danger button[value=cancel]').click();
    await sleep(30);
    assert.equal((await fixesOf(page, page.a1)).length, 2);
    block(page, page.a1).querySelector('[data-act=fix-del]').click();
    await sleep(20);
    page.$('#danger button[value=ok]').click();
    await sleep(40);
    assert.deepEqual((await fixesOf(page, page.a1)).map((i) => i.name), ['2']);
    assert.equal(block(page, page.a1).querySelectorAll('.fix-thumb').length, 1);
  });

  test('клик по картинке открывает слайдшоу по картинкам этого замечания', async () => {
    const page = await alphaPage();
    await store.addFixImages(page.alpha.id, page.a1.id, [{ src: PNG }, { src: PNG }, { src: PNG }]);
    await store.addFixImages(page.alpha.id, page.a2.id, [{ src: PNG }]);
    await sleep(1100);
    block(page, page.a1).querySelectorAll('.fix-thumb img')[1].click();
    const lb = page.$('.lb');
    assert.equal(lb.hidden, false);
    assert.equal(lb.querySelector('.lb-count').textContent, '2 / 3');
    assert.equal(lb.querySelector('.lb-cap').textContent, '#1 · Визуальные пояснения · 2 из 3');
    page.key(page.document, 'ArrowRight');
    assert.equal(lb.querySelector('.lb-count').textContent, '3 / 3');
    page.key(page.document, 'Escape');
    assert.equal(lb.hidden, true);
  });

  test('высота блока фиксирована — картинки прокручиваются внутри', () => {
    const css = readFileSync(new URL('../../pages/review.css', import.meta.url), 'utf8');
    assert.match(css, /\.fix-body \{[^}]*height: 236px;[^}]*overflow-y: auto/);
  });
});

describe('редактор описания (Markdown)', () => {
  async function alphaPage() {
    const page = await seed();
    await openReview(page, page.alpha);
    return page;
  }
  const ed = (page, issue) => page.$(`[data-issue="${issue.id}"] [data-md]`);

  test('описание показывается отформатированным; исходный Markdown — в режиме разметки', async () => {
    let rid, issue;
    const page = await loadPage('pages/review', {
      setup: async () => {
        rid = (await store.createReview({ title: 'R' })).id;
        issue = (await store.addIssue(rid, makeIssue({ description: '**Важно**\n\n- отступ 16px\n- [x] цвет' }))).issue;
      },
    });
    const e = ed(page, issue);
    assert.equal(e.dataset.mode, 'visual');
    assert.equal(e.querySelector('.md-visual strong').textContent, 'Важно');
    assert.equal(e.querySelectorAll('.md-visual li').length, 2);
    assert.equal(e.querySelector('.md-visual li.todo').dataset.checked, 'true');
    assert.equal(e.querySelector('.md-source').value, '**Важно**\n\n- отступ 16px\n- [x] цвет');
    assert.equal(e.querySelector('.md-source').hidden, true);
  });

  test('переключение «Markdown» — для всех карточек и запоминается', async () => {
    const page = await alphaPage();
    ed(page, page.a1).querySelector('[data-cmd=mode]').click();
    for (const issue of [page.a1, page.a2]) {
      assert.equal(ed(page, issue).dataset.mode, 'source');
      assert.equal(ed(page, issue).querySelector('.md-source').hidden, false);
      assert.equal(ed(page, issue).querySelector('.md-visual').hidden, true);
    }
    assert.equal(page.window.localStorage.getItem('drc-md-mode'), 'source');
    ed(page, page.a1).querySelector('[data-cmd=mode]').click();
    assert.equal(ed(page, page.a2).dataset.mode, 'visual');
  });

  test('правка в визуальном режиме сохраняется как Markdown', async () => {
    const page = await alphaPage();
    const visual = ed(page, page.a1).querySelector('.md-visual');
    visual.innerHTML = '<p>Нужен <b>отступ</b> 16px</p><ul><li>слева</li><li>справа</li></ul>';
    visual.dispatchEvent(new page.window.InputEvent('input', { bubbles: true }));
    await sleep(500);
    assert.equal((await store.getReview(page.alpha.id)).issues[0].description, 'Нужен **отступ** 16px\n\n- слева\n- справа');
    assert.equal(ed(page, page.a1).querySelector('.md-source').value, 'Нужен **отступ** 16px\n\n- слева\n- справа');
  });

  test('кнопки панели в режиме Markdown оборачивают выделение разметкой', async () => {
    const page = await alphaPage();
    const e = ed(page, page.a1);
    e.querySelector('[data-cmd=mode]').click();
    const ta = e.querySelector('.md-source');
    page.input(ta, 'сделать жирным');
    ta.setSelectionRange(8, 14);
    e.querySelector('[data-cmd=bold]').click();
    assert.equal(ta.value, 'сделать **жирным**');
    ta.setSelectionRange(0, 0);
    e.querySelector('[data-cmd=ul]').click();
    assert.equal(ta.value, '- сделать **жирным**');
    await sleep(500);
    assert.equal((await store.getReview(page.alpha.id)).issues[0].description, '- сделать **жирным**');
  });

  // Так редактор работает в форме на сайте (content/content.js): localStorage там — хранилище сайта,
  // а клавиатуру контент-скрипт перехватывает раньше редактора и передаёт через handleKeydown.
  test('rememberMode: false — режим не читается и не пишется в localStorage', async () => {
    const page = await alphaPage();
    page.window.localStorage.setItem('drc-md-mode', 'source');
    const box = page.document.createElement('div');
    box.innerHTML = editorHtml({ placeholder: 'x' });
    page.document.body.append(box);
    const root = box.firstElementChild;
    mountEditor(root, { value: 'a', rememberMode: false });
    assert.equal(root.dataset.mode, 'visual');
    root.querySelector('[data-cmd=mode]').click();
    assert.equal(root.dataset.mode, 'source');
    page.window.localStorage.removeItem('drc-md-mode');
    root.querySelector('[data-cmd=mode]').click();
    assert.equal(page.window.localStorage.getItem('drc-md-mode'), null);
  });

  test('handleKeydown: нажатие, перехваченное до редактора, обрабатывается только в визуальном поле', async () => {
    const page = await alphaPage();
    const box = page.document.createElement('div');
    box.innerHTML = editorHtml({ placeholder: 'x' });
    page.document.body.append(box);
    const asked = [];
    const editor = mountEditor(box.firstElementChild, { value: 'текст', rememberMode: false, askLink: async (url) => (asked.push(url), null) });
    // Как контент-скрипт: перехват на window в фазе захвата, дальше событие не идёт.
    const intercept = (e) => {
      e.stopImmediatePropagation();
      editor.handleKeydown(e);
    };
    page.window.addEventListener('keydown', intercept, true);
    const press = (el) => el.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
    try {
      const visual = box.querySelector('.md-visual');
      visual.focus();
      assert.equal(press(visual), false, '⌘/Ctrl+K в визуальном поле обработан');
      await sleep(5);
      assert.deepEqual(asked, ['']);
      assert.equal(press(box.querySelector('.md-source')), true, 'в режиме разметки — не трогаем');
      await sleep(5);
      assert.equal(asked.length, 1);
    } finally {
      page.window.removeEventListener('keydown', intercept, true);
    }
  });

  test('HTML в описании не исполняется', async () => {
    let issue;
    const page = await loadPage('pages/review', {
      setup: async () => {
        const rid = (await store.createReview({ title: 'R' })).id;
        issue = (await store.addIssue(rid, makeIssue({ description: '<img src=x onerror=alert(1)> [x](javascript:alert(1))' }))).issue;
      },
    });
    const visual = ed(page, issue).querySelector('.md-visual');
    assert.equal(visual.querySelectorAll('img, a').length, 0);
    assert.match(visual.textContent, /<img src=x onerror=alert\(1\)>/);
  });

  test('номер замечания — ярлык в левом верхнем углу карточки', async () => {
    const page = await alphaPage();
    const num = page.$(`[data-issue="${page.a2.id}"] > .issue-num`);
    assert.equal(num.textContent, '#2');
    const css = readFileSync(new URL('../../pages/review.css', import.meta.url), 'utf8');
    assert.match(css, /\.issue-num \{[^}]*position: absolute; top: -15px; left: 22px;/);
  });
});

describe('фоновый скрипт на старом коде', () => {
  async function pageWith(t, reply) {
    t.mock.method(globalThis, 'fetch', async () => new Response('код'));
    return loadPage('pages/review', {
      setup: async (env) => {
        await store.createReview({ title: 'R' });
        env.chrome.runtime.sendMessage = t.mock.fn(async () => reply);
        env.chrome.runtime.reload = t.mock.fn();
      },
    });
  }

  test('старый фоновый скрипт (не знает drc:codeVersion) → предупреждение с перезагрузкой', async (t) => {
    const page = await pageWith(t, { ok: false, error: 'Неизвестное сообщение: drc:codeVersion' });
    await sleep(30);
    const bar = page.$('.stale-bg');
    assert.ok(bar, 'есть предупреждение');
    assert.match(bar.textContent, /не перезагружено/);
    await page.chrome.storage.local.set({ folderSynced: { x: { at: 1, v: 2 } } });
    bar.querySelector('[data-act=reload-ext]').click();
    await sleep(20);
    assert.equal(page.chrome.runtime.reload.mock.callCount(), 1);
    assert.equal(page.chrome.storage.local.data.get('reopenAfterReload'), page.window.location.href);
    assert.equal(page.chrome.storage.local.data.has('folderSynced'), false, 'всё перезапишется новым кодом');
  });

  test('другой отпечаток кода → предупреждение; тот же → нет', async (t) => {
    let page = await pageWith(t, { ok: true, fingerprint: '0000000000000000' });
    await sleep(30);
    assert.ok(page.$('.stale-bg'));
    const { codeFingerprint } = await import('../../lib/code-version.js');
    const same = await codeFingerprint();
    page = await pageWith(t, { ok: true, fingerprint: same });
    await sleep(30);
    assert.equal(page.$('.stale-bg'), null);
  });
});
