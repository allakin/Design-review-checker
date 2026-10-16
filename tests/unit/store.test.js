import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv, makeIssue } from '../helpers/env.js';
import * as store from '../../lib/store.js';

let chrome;
const raw = (key) => chrome.storage.local.data.get(key);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  ({ chrome } = installEnv());
});

describe('createReview', () => {
  test('создаёт ревью, кладёт его в индекс и делает текущим', async () => {
    const r = await store.createReview({ title: '  Оплата  ', author: ' Анна ', devTicketUrl: 'https://t/DEV-1', designTicketUrl: '' });
    assert.equal(r.title, 'Оплата');
    assert.equal(r.author, 'Анна');
    assert.equal(r.devTicketUrl, 'https://t/DEV-1');
    assert.deepEqual(r.issues, []);
    assert.ok(r.id);
    assert.equal(typeof r.createdAt, 'number');
    assert.deepEqual(raw(`review:${r.id}`).title, 'Оплата');
    assert.equal(raw('activeReviewId'), r.id);
    const [meta] = raw('reviewIndex');
    assert.equal(meta.id, r.id);
    assert.equal(meta.issueCount, 0);
    assert.equal(meta.author, 'Анна');
  });

  test('пустое название заменяется на «Дизайн-ревью»', async () => {
    const r = await store.createReview({ title: '   ' });
    assert.equal(r.title, 'Дизайн-ревью');
    assert.equal(r.author, '');
    assert.equal(r.devTicketUrl, '');
    assert.equal(r.designTicketUrl, '');
  });

  test('id уникальны', async () => {
    const ids = new Set();
    for (let i = 0; i < 20; i++) ids.add((await store.createReview({ title: `R${i}` })).id);
    assert.equal(ids.size, 20);
  });
});

describe('чтение', () => {
  test('getReview: null для пустого и неизвестного id', async () => {
    assert.equal(await store.getReview(), null);
    assert.equal(await store.getReview(''), null);
    assert.equal(await store.getReview('nope'), null);
  });

  test('listReviews сортирует по дате изменения, свежие сверху', async () => {
    const a = await store.createReview({ title: 'A' });
    await sleep(3);
    const b = await store.createReview({ title: 'B' });
    await sleep(3);
    await store.updateReview(a.id, { author: 'X' });
    assert.deepEqual((await store.listReviews()).map((m) => m.title), ['A', 'B']);
    assert.ok(b);
  });

  test('listReviews не мутирует сохранённый индекс', async () => {
    await store.createReview({ title: 'A' });
    const list = await store.listReviews();
    list.push({ id: 'fake' });
    assert.equal((await store.listReviews()).length, 1);
  });

  test('getAllReviews возвращает полные объекты и пропускает «битые» записи индекса', async () => {
    const a = await store.createReview({ title: 'A' });
    await store.createReview({ title: 'B' });
    chrome.storage.local.data.delete(`review:${a.id}`);
    const all = await store.getAllReviews();
    assert.deepEqual(all.map((r) => r.title), ['B']);
    assert.ok(Array.isArray(all[0].issues));
  });

  test('пустое хранилище', async () => {
    assert.deepEqual(await store.listReviews(), []);
    assert.deepEqual(await store.getAllReviews(), []);
    assert.equal(await store.getActiveReviewId(), null);
    assert.equal(await store.getActiveReview(), null);
  });
});

describe('updateReview', () => {
  test('меняет поля, обновляет updatedAt и индекс', async () => {
    const r = await store.createReview({ title: 'A' });
    await sleep(2);
    const u = await store.updateReview(r.id, { title: 'B', designTicketUrl: 'https://d/1' });
    assert.equal(u.title, 'B');
    assert.ok(u.updatedAt > r.updatedAt);
    assert.equal(u.createdAt, r.createdAt);
    assert.equal(raw('reviewIndex')[0].title, 'B');
    assert.equal(raw('reviewIndex').length, 1);
  });

  test('бросает ошибку для несуществующего ревью', async () => {
    await assert.rejects(store.updateReview('nope', { title: 'x' }), /Ревью не найдено/);
  });
});

describe('deleteReview', () => {
  test('удаляет ревью и запись в индексе', async () => {
    const a = await store.createReview({ title: 'A' });
    const b = await store.createReview({ title: 'B' });
    await store.deleteReview(a.id);
    assert.equal(raw(`review:${a.id}`), undefined);
    assert.deepEqual(raw('reviewIndex').map((m) => m.id), [b.id]);
  });

  test('сбрасывает текущее ревью, если удалили его', async () => {
    const a = await store.createReview({ title: 'A' });
    await store.deleteReview(a.id);
    assert.equal(await store.getActiveReviewId(), null);
  });

  test('не трогает текущее ревью, если удалили другое', async () => {
    const a = await store.createReview({ title: 'A' });
    const b = await store.createReview({ title: 'B' });
    await store.deleteReview(a.id);
    assert.equal(await store.getActiveReviewId(), b.id);
  });

  test('удаление несуществующего — без ошибок', async () => {
    await store.deleteReview('nope');
  });
});

describe('текущее ревью', () => {
  test('setActiveReviewId / getActiveReview', async () => {
    const a = await store.createReview({ title: 'A' });
    await store.createReview({ title: 'B' });
    await store.setActiveReviewId(a.id);
    assert.equal((await store.getActiveReview()).title, 'A');
  });

  test('setActiveReviewId(null) снимает текущее', async () => {
    await store.createReview({ title: 'A' });
    await store.setActiveReviewId(null);
    assert.equal(raw('activeReviewId'), undefined);
    assert.equal(await store.getActiveReview(), null);
  });

  test('getActiveReview: null, если текущее ревью удалили из хранилища в обход API', async () => {
    const a = await store.createReview({ title: 'A' });
    chrome.storage.local.data.delete(`review:${a.id}`);
    assert.equal(await store.getActiveReview(), null);
  });
});

describe('замечания', () => {
  test('addIssue добавляет замечание с id, датой и номером', async () => {
    const r = await store.createReview({ title: 'A' });
    const { issue, number } = await store.addIssue(r.id, { title: 'Кнопка', severity: 'low' });
    assert.equal(number, 1);
    assert.ok(issue.id);
    assert.equal(typeof issue.createdAt, 'number');
    const { number: n2 } = await store.addIssue(r.id, { title: 'Ещё' });
    assert.equal(n2, 2);
    const saved = await store.getReview(r.id);
    assert.deepEqual(saved.issues.map((i) => i.title), ['Кнопка', 'Ещё']);
    assert.equal(raw('reviewIndex')[0].issueCount, 2);
  });

  test('addIssue в несуществующее ревью — понятная ошибка', async () => {
    await assert.rejects(store.addIssue('nope', { title: 'x' }), /Ревью не найдено — создайте новое/);
  });

  test('addIssue: переданные id/createdAt имеют приоритет (импорт)', async () => {
    const r = await store.createReview({ title: 'A' });
    const { issue } = await store.addIssue(r.id, { id: 'fixed', createdAt: 5, title: 'x' });
    assert.equal(issue.id, 'fixed');
    assert.equal(issue.createdAt, 5);
  });

  test('updateIssue меняет поля и ставит updatedAt', async () => {
    const r = await store.createReview({ title: 'A' });
    const { issue } = await store.addIssue(r.id, { title: 'x', severity: 'low' });
    const u = await store.updateIssue(r.id, issue.id, { severity: 'critical', description: 'd' });
    assert.equal(u.severity, 'critical');
    assert.equal(u.description, 'd');
    assert.equal(typeof u.updatedAt, 'number');
    assert.equal((await store.getReview(r.id)).issues[0].severity, 'critical');
  });

  test('updateIssue: ошибка для неизвестного замечания или ревью', async () => {
    const r = await store.createReview({ title: 'A' });
    await assert.rejects(store.updateIssue(r.id, 'nope', {}), /Замечание не найдено/);
    await assert.rejects(store.updateIssue('nope', 'nope', {}), /Замечание не найдено/);
  });

  test('deleteIssue удаляет только указанное замечание', async () => {
    const r = await store.createReview({ title: 'A' });
    const { issue: a } = await store.addIssue(r.id, { title: 'a' });
    await store.addIssue(r.id, { title: 'b' });
    await store.deleteIssue(r.id, a.id);
    assert.deepEqual((await store.getReview(r.id)).issues.map((i) => i.title), ['b']);
    assert.equal(raw('reviewIndex')[0].issueCount, 1);
  });

  test('deleteIssue в несуществующем ревью — без ошибок', async () => {
    await store.deleteIssue('nope', 'nope');
  });

  test('moveIssue двигает вверх и вниз', async () => {
    const r = await store.createReview({ title: 'A' });
    const ids = [];
    for (const t of ['a', 'b', 'c']) ids.push((await store.addIssue(r.id, { title: t })).issue.id);
    await store.moveIssue(r.id, ids[2], -1);
    assert.deepEqual((await store.getReview(r.id)).issues.map((i) => i.title), ['a', 'c', 'b']);
    await store.moveIssue(r.id, ids[0], 1);
    assert.deepEqual((await store.getReview(r.id)).issues.map((i) => i.title), ['c', 'a', 'b']);
  });

  test('moveIssue за границы списка ничего не меняет и не пишет', async () => {
    const r = await store.createReview({ title: 'A' });
    const { issue: a } = await store.addIssue(r.id, { title: 'a' });
    const { issue: b } = await store.addIssue(r.id, { title: 'b' });
    const before = (await store.getReview(r.id)).updatedAt;
    await sleep(2);
    await store.moveIssue(r.id, a.id, -1);
    await store.moveIssue(r.id, b.id, 1);
    await store.moveIssue(r.id, 'nope', 1);
    await store.moveIssue('nope', a.id, 1);
    const after = await store.getReview(r.id);
    assert.deepEqual(after.issues.map((i) => i.title), ['a', 'b']);
    assert.equal(after.updatedAt, before);
  });
});

describe('параллельные записи', () => {
  test('одновременные addIssue не теряют замечания', async () => {
    const r = await store.createReview({ title: 'A' });
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => store.addIssue(r.id, { title: `#${i}` })));
    assert.deepEqual(results.map((x) => x.number).sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
    assert.equal((await store.getReview(r.id)).issues.length, 25);
    assert.equal(raw('reviewIndex')[0].issueCount, 25);
  });

  test('одновременное создание ревью не теряет записи индекса', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.createReview({ title: `R${i}` })));
    assert.equal(raw('reviewIndex').length, 10);
  });

  test('ошибка в одной операции не ломает очередь', async () => {
    const r = await store.createReview({ title: 'A' });
    const bad = store.updateReview('nope', {});
    const good = store.addIssue(r.id, { title: 'ok' });
    await assert.rejects(bad);
    assert.equal((await good).number, 1);
  });
});

describe('поисковый текст в индексе', () => {
  test('включает название, ревьюера, тикеты, заголовки и страницы замечаний в нижнем регистре', async () => {
    const r = await store.createReview({ title: 'Оплата', author: 'Анна', devTicketUrl: 'https://t/DEV-7', designTicketUrl: 'https://t/DES-9' });
    await store.addIssue(r.id, makeIssue({ title: 'Кнопка КУПИТЬ', page: { url: 'https://shop.ru/cart', title: 'Корзина' } }));
    const { search } = raw('reviewIndex')[0];
    for (const part of ['оплата', 'анна', 'dev-7', 'des-9', 'кнопка купить', 'https://shop.ru/cart', 'корзина']) {
      assert.ok(search.includes(part), part);
    }
    assert.equal(search, search.toLowerCase());
  });

  test('не содержит скриншотов и ограничен 4000 символами', async () => {
    const r = await store.createReview({ title: 'A' });
    for (let i = 0; i < 40; i++) await store.addIssue(r.id, makeIssue({ title: 'x'.repeat(200) }));
    const { search } = raw('reviewIndex')[0];
    assert.ok(search.length <= 4000);
    assert.ok(!search.includes('data:image'));
  });

  test('reindexIfNeeded дополняет старые записи без поиска и не трогает дату', async () => {
    const r = await store.createReview({ title: 'Старое', author: 'Пётр' });
    const index = raw('reviewIndex');
    delete index[0].search;
    index[0].updatedAt = 1;
    chrome.storage.local.data.set('reviewIndex', index);
    await store.reindexIfNeeded();
    const [meta] = raw('reviewIndex');
    assert.ok(meta.search.includes('старое'));
    assert.equal(meta.id, r.id);
    // updatedAt берётся из самого ревью — не меняется на «сейчас»
    assert.equal(meta.updatedAt, (await store.getReview(r.id)).updatedAt);
  });

  test('reindexIfNeeded ничего не пишет, если всё проиндексировано', async () => {
    await store.createReview({ title: 'A' });
    let writes = 0;
    chrome.storage.onChanged.addListener(() => writes++);
    await store.reindexIfNeeded();
    assert.equal(writes, 0);
  });

  test('reindexIfNeeded пропускает записи индекса без ревью', async () => {
    chrome.storage.local.data.set('reviewIndex', [{ id: 'ghost', title: 'G', updatedAt: 1 }]);
    await store.reindexIfNeeded();
    assert.equal(raw('reviewIndex')[0].search, undefined);
  });
});

describe('onReviewsChanged', () => {
  test('вызывается на изменения ревью, индекса и текущего ревью', async () => {
    let calls = 0;
    const off = store.onReviewsChanged(() => calls++);
    await chrome.storage.local.set({ 'review:1': {} });
    await chrome.storage.local.set({ reviewIndex: [] });
    await chrome.storage.local.set({ activeReviewId: '1' });
    assert.equal(calls, 3);
    off();
    await chrome.storage.local.set({ reviewIndex: [] });
    assert.equal(calls, 3);
  });

  test('игнорирует посторонние ключи и другие области хранилища', async () => {
    let calls = 0;
    store.onReviewsChanged(() => calls++);
    await chrome.storage.local.set({ exportFormat: 'pdf', folderStatus: {} });
    chrome.storage.onChanged.dispatch({ reviewIndex: {} }, 'sync');
    assert.equal(calls, 0);
  });
});

test('uid генерирует UUID v4', () => {
  assert.match(store.uid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
