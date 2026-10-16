import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, closePage, connectFolder, sleep } from '../helpers/page.js';
import { MemDir } from '../helpers/fs.js';
import { makeIssue } from '../helpers/env.js';
import * as store from '../../lib/store.js';
import * as folder from '../../lib/folder.js';

after(closePage);

async function withReview({ issues = [], folderPerm = 'granted', review = {}, ...opts } = {}) {
  let created;
  const page = await loadPage('popup/popup', {
    ...opts,
    setup: async (env) => {
      if (folderPerm) await connectFolder(MemDir, { permission: folderPerm });
      created = await store.createReview({ title: 'Оплата', author: 'Анна', devTicketUrl: 'https://st.example.com/DEV-1', designTicketUrl: '', ...review });
      for (const i of issues) await store.addIssue(created.id, i);
      await opts.setup?.(env);
    },
  });
  return { ...page, review: created };
}

describe('popup: создание ревью', () => {
  test('без ревью сразу показывает форму создания с подсказкой по хосту вкладки', async () => {
    const { $ } = await loadPage('popup/popup');
    assert.ok($('form#create'));
    assert.equal($('#btn-all').hidden, true);
    assert.equal($('[name=title]').placeholder, 'Например: Ревью shop.example.com');
    assert.equal($('[data-act=back]'), null, 'отмены нет, если ревью ещё не было');
  });

  test('некорректная ссылка на тикет не даёт создать ревью', async () => {
    const { $, window } = await loadPage('popup/popup');
    $('[name=devTicketUrl]').value = 'просто текст';
    $('form#create').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await sleep(20);
    assert.ok($('[name=devTicketUrl]').classList.contains('invalid'));
    assert.equal($('[name=devTicketUrl]').nextElementSibling.hidden, false);
    assert.deepEqual(await store.listReviews(), []);
  });

  test('создаёт ревью; первый запуск без папки ведёт на страницу настройки', async () => {
    const { $, window, chrome } = await loadPage('popup/popup');
    $('[name=title]').value = 'Корзина';
    $('[name=author]').value = 'Олег';
    $('[name=devTicketUrl]').value = 'st.example.com/DEV-5';
    $('form#create').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await sleep(40);
    const r = await store.getActiveReview();
    assert.equal(r.title, 'Корзина');
    assert.equal(r.author, 'Олег');
    assert.equal(r.devTicketUrl, 'https://st.example.com/DEV-5');
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, chrome.runtime.getURL('pages/setup.html'));
    assert.equal(window.close.mock.callCount(), 1);
  });

  test('пустое название берётся из подсказки', async () => {
    const { $, window } = await loadPage('popup/popup', { setup: () => connectFolder(MemDir) });
    $('form#create').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await sleep(40);
    assert.equal((await store.getActiveReview()).title, 'Ревью shop.example.com');
  });

  test('с папкой после создания показывает ревью, а не настройку', async () => {
    const { $, window, chrome } = await loadPage('popup/popup', { setup: () => connectFolder(MemDir) });
    $('[name=title]').value = 'X';
    $('form#create').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await sleep(60);
    assert.equal(chrome.tabs.create.mock.callCount(), 0);
    assert.equal($('.review-card .title').textContent, 'X');
  });
});

describe('popup: текущее ревью', () => {
  test('показывает название, счётчики по критичности и список замечаний', async () => {
    const { $, $$ } = await withReview({
      issues: [makeIssue({ severity: 'critical', title: 'A' }), makeIssue({ severity: 'critical', title: 'B' }), makeIssue({ severity: 'low', title: 'C' })],
    });
    assert.equal($('.review-card .title').textContent, 'Оплата');
    assert.match($('.review-card .meta').textContent, /^3 зам\. · создано .+ · Анна$/);
    assert.deepEqual($$('.review-card .chip').map((c) => c.textContent), ['Критическая: 2', 'Низкая: 1']);
    assert.deepEqual($$('.issues li .t div').map((d) => d.textContent), ['A', 'B', 'C']);
    assert.equal($$('.issues li img').length, 3);
    assert.equal($('.issues li small').textContent, 'example.com');
  });

  test('пустое ревью: подсказка и неактивный экспорт', async () => {
    const { $ } = await withReview();
    assert.match($('.empty').textContent, /Пока пусто/);
    assert.equal($('[data-act=export]').disabled, true);
  });

  test('ссылки на тикеты: только заданные и безопасные', async () => {
    const { $$ } = await withReview({ review: { devTicketUrl: 'https://st.example.com/DEV-1', designTicketUrl: 'javascript:alert(1)' } });
    const links = $$('.tickets a');
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'https://st.example.com/DEV-1');
    assert.equal(links[0].rel, 'noopener');
  });

  test('без тикетов — кнопка «Добавить ссылки на тикеты» ведёт на страницу ревью', async () => {
    const { $, chrome, review } = await withReview({ review: { devTicketUrl: '' } });
    $('[data-act=tickets]').click();
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, chrome.runtime.getURL(`pages/review.html?id=${review.id}`));
  });

  test('HTML в названиях выводится текстом', async () => {
    const { $, document } = await withReview({ review: { title: '<img src=x onerror=alert(1)>' }, issues: [makeIssue({ title: '<b>жирный</b>' })] });
    assert.equal($('.review-card .title').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(document.querySelectorAll('.review-card img, .issues b').length, 0);
  });

  test('«Выбрать элемент» запускает выбор на активной вкладке и закрывает окно', async () => {
    const { $, chrome, window } = await withReview();
    $('[data-act=pick]').click();
    await sleep(20);
    assert.deepEqual(chrome.runtime.sendMessage.mock.calls[0].arguments[0], { type: 'drc:startPick', tabId: 1, delay: 0 });
    assert.equal(window.close.mock.callCount(), 1);
  });

  test('«3 с» запускает выбор с задержкой', async () => {
    const { $, chrome } = await withReview();
    $('[data-act=pick-delay]').click();
    await sleep(20);
    assert.equal(chrome.runtime.sendMessage.mock.calls[0].arguments[0].delay, 3);
  });

  test('ошибка запуска выбора показывается в окне', async () => {
    const { $, chrome, window } = await withReview();
    chrome.runtime.sendMessage.mock.mockImplementation(async () => ({ ok: false, error: 'На служебных страницах браузера выбор элементов недоступен.' }));
    $('[data-act=pick]').click();
    await sleep(20);
    assert.equal($('#error').hidden, false);
    assert.match($('#error').textContent, /служебных страницах/);
    assert.equal(window.close.mock.callCount(), 0);
  });

  test('горячая клавиша показывается на кнопке; без неё — предупреждение «Назначить»', async () => {
    const withKey = await withReview();
    assert.equal(withKey.$('[data-act=pick] kbd').textContent, '⌥⇧D');
    assert.equal(withKey.$('.shortcut-warn'), null);
    const noKey = await withReview({ setup: (env) => env.chrome.commands.getAll.mock.mockImplementation(async () => [{ name: 'start-pick', shortcut: '' }]) });
    assert.ok(noKey.$('.shortcut-warn'));
    assert.equal(noKey.$('[data-act=pick] kbd'), null);
  });

  test('«Изменить горячую клавишу» открывает страницу сочетаний; при неудаче — подсказка', async () => {
    const { $, chrome } = await withReview();
    $('[data-act=shortcut]').click();
    await sleep(10);
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, 'chrome://extensions/shortcuts');
    chrome.tabs.create.mock.mockImplementation(async () => {
      throw new Error('нельзя');
    });
    $('[data-act=shortcut]').click();
    await sleep(10);
    assert.match($('#error').textContent, /browser:\/\/extensions\/shortcuts/);
  });

  test('без папки вместо выбора — блок «Подключить reviews-results»', async () => {
    const { $, chrome } = await withReview({ folderPerm: null });
    assert.equal($('[data-act=pick]'), null);
    $('[data-act=setup]').click();
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, chrome.runtime.getURL('pages/setup.html'));
  });

  test('экспорт открывает отчёт в выбранном формате и запоминает формат', async () => {
    const { $, chrome, review, window } = await withReview({ issues: [makeIssue()] });
    const pdf = $('input[name=fmt][value=pdf]');
    pdf.checked = true;
    pdf.dispatchEvent(new window.Event('change'));
    await sleep(5);
    assert.equal(chrome.storage.local.data.get('exportFormat'), 'pdf');
    $('[data-act=export]').click();
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, chrome.runtime.getURL(`pages/report.html?id=${review.id}&action=pdf`));
  });

  test('сохранённый формат экспорта выбран по умолчанию', async () => {
    const { $ } = await withReview({ issues: [makeIssue()], setup: (env) => env.chrome.storage.local.set({ exportFormat: 'pdf' }) });
    assert.equal($('input[name=fmt]:checked').value, 'pdf');
  });

  test('клик по замечанию открывает его на странице ревью', async () => {
    const { $, chrome, review } = await withReview({ issues: [makeIssue()] });
    const li = $('.issues li');
    li.click();
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, chrome.runtime.getURL(`pages/review.html?id=${review.id}#${li.dataset.id}`));
  });

  test('строка папки отражает состояние: сохраняется / нет доступа / ошибка / не подключена', async () => {
    const ok = await withReview();
    assert.match(ok.$('.folder-line').textContent, /Сохраняется в «reviews-results»/);
    const prompt = await withReview({ folderPerm: 'prompt' });
    assert.match(prompt.$('.folder-line').textContent, /Нет доступа к «reviews-results»: разрешить/);
    assert.ok(prompt.$('.folder-line').classList.contains('warn'));
    const err = await withReview({ setup: () => folder.setStatus({ state: 'error', error: 'boom' }) });
    assert.match(err.$('.folder-line').textContent, /Ошибка записи/);
    const none = await withReview({ folderPerm: null });
    assert.match(none.$('.folder-line').textContent, /подключить reviews-results/);
  });

  test('новое замечание из контент-скрипта сразу появляется в окне', async () => {
    const { $$, review } = await withReview();
    await store.addIssue(review.id, makeIssue({ title: 'Свежее' }));
    await sleep(30);
    assert.deepEqual($$('.issues li .t div').map((d) => d.textContent), ['Свежее']);
  });
});

describe('popup: все ревью', () => {
  test('список ревью и переключение текущего', async () => {
    let first;
    const { $, $$ } = await loadPage('popup/popup', {
      setup: async () => {
        await connectFolder(MemDir);
        first = await store.createReview({ title: 'Первое' });
        await sleep(2);
        await store.createReview({ title: 'Второе' });
      },
    });
    assert.equal($('#btn-all').hidden, false);
    $('#btn-all').click();
    await sleep(20);
    assert.deepEqual($$('.review-list li div div').map((d) => d.textContent), ['Второе', 'Первое']);
    assert.ok($$('.review-list li')[0].classList.contains('active'));
    $$('.review-list li')[1].click();
    await sleep(30);
    assert.equal(await store.getActiveReviewId(), first.id);
    assert.equal($('.review-card .title').textContent, 'Первое');
  });

  test('«Новое ревью» из списка открывает форму с отменой; ревьюер подставляется', async () => {
    const { $ } = await withReview();
    $('[data-act=new]').click();
    await sleep(20);
    assert.ok($('form#create'));
    assert.equal($('[name=author]').value, 'Анна');
    $('[data-act=back]').click();
    await sleep(20);
    assert.equal($('.review-card .title').textContent, 'Оплата');
  });
});
