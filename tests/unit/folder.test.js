import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv, makeIssue, makeReview, PNG, PNG_2, JPEG } from '../helpers/env.js';
import { MemDir } from '../helpers/fs.js';
import * as folder from '../../lib/folder.js';

let chrome;
const status = () => chrome.storage.local.data.get(folder.KEY_FOLDER_STATUS);
const names = () => chrome.storage.local.data.get('folderNames') || {};

beforeEach(() => {
  ({ chrome } = installEnv());
});

async function connected(perm = 'granted') {
  const root = new MemDir('reviews-results', { permission: perm });
  await folder.setDir(root);
  return root;
}

describe('safeName', () => {
  test('заменяет запрещённые символы и управляющие коды на пробел', () => {
    assert.equal(folder.safeName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
    assert.equal(folder.safeName('a\u0000b\nc\td'), 'a b c d');
  });
  test('схлопывает пробелы и обрезает края', () => {
    assert.equal(folder.safeName('   много    пробелов  '), 'много пробелов');
  });
  test('убирает точки в начале (скрытые файлы)', () => {
    assert.equal(folder.safeName('...git'), 'git');
  });
  test('ограничивает длину', () => {
    assert.equal(folder.safeName('я'.repeat(100)).length, 60);
    assert.equal(folder.safeName('я'.repeat(100), 10).length, 10);
    assert.equal(folder.safeName('слово '.repeat(20), 12), 'слово слово');
  });
  test('пустое имя → «Без названия»', () => {
    for (const v of ['', '   ', '...', '///', null, undefined]) assert.equal(folder.safeName(v), 'Без названия', String(v));
  });
});

describe('folderLabel', () => {
  test('с проектом и без', () => {
    const dir = { name: 'reviews-results' };
    assert.equal(folder.folderLabel(dir, { project: 'my-ext' }), 'my-ext/reviews-results');
    assert.equal(folder.folderLabel(dir, {}), 'reviews-results');
    assert.equal(folder.folderLabel(dir), 'reviews-results');
  });
});

describe('хранение дескриптора папки (IndexedDB)', () => {
  test('setDir / getDir / clearDir', async () => {
    assert.equal(await folder.getDir(), undefined);
    const dir = new MemDir('reviews-results');
    await folder.setDir(dir);
    assert.equal(await folder.getDir(), dir);
    await folder.clearDir();
    assert.equal(await folder.getDir(), undefined);
  });
});

describe('connectResultsFolder', () => {
  test('выбрана сама папка reviews-results — используется как есть', async () => {
    const picked = new MemDir('reviews-results');
    const { dir, project } = await folder.connectResultsFolder(picked);
    assert.equal(dir, picked);
    assert.equal(project, '');
    assert.equal(await folder.getDir(), picked);
    assert.deepEqual(status(), { state: 'ok', dirName: 'reviews-results', project: '', error: '' });
  });

  test('выбрана папка расширения — берётся/создаётся reviews-results внутри', async () => {
    const picked = new MemDir('Design review checker');
    const { dir, project } = await folder.connectResultsFolder(picked);
    assert.equal(dir.name, 'reviews-results');
    assert.equal(picked.at('reviews-results'), dir);
    assert.equal(project, 'Design review checker');
    assert.equal(status().project, 'Design review checker');
  });

  test('существующая reviews-results внутри не пересоздаётся', async () => {
    const picked = new MemDir('ext');
    picked.put('reviews-results/.gitkeep', '');
    const { dir } = await folder.connectResultsFolder(picked);
    assert.deepEqual(dir.list(), ['.gitkeep']);
  });

  test('pickResultsFolder открывает системный диалог с режимом записи', async () => {
    let opts;
    globalThis.showDirectoryPicker = async (o) => ((opts = o), new MemDir('reviews-results'));
    try {
      const { dir } = await folder.pickResultsFolder();
      assert.equal(dir.name, 'reviews-results');
      assert.deepEqual(opts, { id: 'drc-results', mode: 'readwrite' });
    } finally {
      delete globalThis.showDirectoryPicker;
    }
  });
});

describe('permission', () => {
  test('без request только проверяет', async () => {
    const dir = new MemDir('d', { permission: 'prompt' });
    assert.equal(await folder.permission(dir), 'prompt');
    assert.equal(dir.permission, 'prompt');
  });
  test('с request запрашивает при состоянии prompt', async () => {
    const dir = new MemDir('d', { permission: 'prompt' });
    assert.equal(await folder.permission(dir, true), 'granted');
  });
  test('denied не перезапрашивается', async () => {
    const dir = new MemDir('d', { permission: 'denied' });
    assert.equal(await folder.permission(dir, true), 'denied');
  });
});

describe('setStatus', () => {
  test('сливает с предыдущим состоянием', async () => {
    await folder.setStatus({ state: 'ok', dirName: 'x', project: 'p' });
    await folder.setStatus({ state: 'error', error: 'boom' });
    assert.deepEqual(status(), { state: 'error', dirName: 'x', project: 'p', error: 'boom' });
  });
});

describe('disconnectFolder', () => {
  test('забывает папку и ставит статус no-folder, файлы на диске остаются', async () => {
    const root = await connected();
    root.put('old/review.json', '{}');
    await folder.disconnectFolder();
    assert.equal(await folder.getDir(), undefined);
    assert.deepEqual(status(), { state: 'no-folder' });
    assert.ok(root.has('old/review.json'));
  });
});

describe('writeReview', () => {
  test('создаёт подпапку «Название — дата» с отчётом, JSON и скриншотами', async () => {
    const root = new MemDir('reviews-results');
    const issues = [makeIssue({ title: 'Кнопка', screenshot: PNG }), makeIssue({ title: 'Без скрина', screenshot: '' }), makeIssue({ title: 'Фото', screenshot: JPEG })];
    const review = makeReview({ title: 'Оплата', createdAt: Date.UTC(2026, 9, 16, 9), issues });
    const sub = await folder.writeReview(root, review);
    assert.equal(sub, 'Оплата — 2026-10-16');
    assert.deepEqual(root.list(sub), ['review.json', 'screenshots', 'Отчёт.html']);
    const shots = root.list(`${sub}/screenshots`);
    assert.equal(shots.length, 2);
    assert.match(shots[0], /^01 — Кнопка — [0-9a-f]{6}\.png$/);
    assert.match(shots[1], /^03 — Фото — [0-9a-f]{6}\.jpg$/);
    // PNG-байты записаны как есть
    const bytes = root.at(`${sub}/screenshots/${shots[0]}`).bytes;
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(bytes.length, Buffer.from(PNG.split(',')[1], 'base64').length);
  });

  test('review.json: формат, ISO-даты, номера, подписи критичности, ссылки на файлы, без base64', async () => {
    const root = new MemDir('reviews-results');
    const issues = [makeIssue({ severity: 'critical' }), makeIssue({ severity: 'unknown', screenshot: '' })];
    const review = makeReview({ author: undefined, devTicketUrl: undefined, issues });
    const sub = await folder.writeReview(root, review);
    const json = JSON.parse(root.at(`${sub}/review.json`).text());
    assert.equal(json.format, 'design-review-checker');
    assert.equal(json.version, 1);
    assert.equal(json.id, review.id);
    assert.equal(json.author, '');
    assert.equal(json.devTicketUrl, '');
    assert.equal(json.designTicketUrl, review.designTicketUrl);
    assert.equal(json.createdAt, new Date(review.createdAt).toISOString());
    assert.equal(json.issues[0].number, 1);
    assert.equal(json.issues[0].severityLabel, 'Критическая');
    assert.equal(json.issues[1].severityLabel, 'Средняя');
    assert.match(json.issues[0].screenshotFile, /^screenshots\/01 — .+\.png$/);
    assert.ok(root.has(`${sub}/${json.issues[0].screenshotFile}`));
    assert.equal(json.issues[1].screenshotFile, null);
    assert.equal(json.issues[0].screenshot, undefined);
    assert.doesNotMatch(root.at(`${sub}/review.json`).text(), /base64/);
    assert.equal(json.issues[0].createdAt, new Date(issues[0].createdAt).toISOString());
    assert.equal(json.issues[0].title, issues[0].title);
    assert.deepEqual(json.issues[0].element, issues[0].element);
  });

  test('Отчёт.html — самодостаточный отчёт ревью', async () => {
    const root = new MemDir('reviews-results');
    const review = makeReview({ title: 'Главная', issues: [makeIssue()] });
    const sub = await folder.writeReview(root, review);
    const html = root.at(`${sub}/Отчёт.html`).text();
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>Дизайн-ревью — Главная<\/title>/);
    assert.match(html, /data:image\/png;base64/);
  });

  test('имя подпапки фиксируется: переименование ревью не плодит папки', async () => {
    const root = new MemDir('reviews-results');
    const review = makeReview({ title: 'Старое' });
    const a = await folder.writeReview(root, review);
    review.title = 'Новое';
    const b = await folder.writeReview(root, review);
    assert.equal(a, b);
    assert.deepEqual(root.list(), [a]);
    assert.equal(names()[review.id], a);
  });

  test('одинаковые названия и даты → «(2)», «(3)»', async () => {
    const root = new MemDir('reviews-results');
    const subs = [];
    for (let i = 0; i < 3; i++) subs.push(await folder.writeReview(root, makeReview({ title: 'Ревью', createdAt: Date.UTC(2026, 0, 2) })));
    assert.deepEqual(subs, ['Ревью — 2026-01-02', 'Ревью — 2026-01-02 (2)', 'Ревью — 2026-01-02 (3)']);
  });

  test('параллельная запись разных ревью не теряет словарь имён и не путает папки', async () => {
    const root = new MemDir('reviews-results');
    const reviews = Array.from({ length: 8 }, () => makeReview({ title: 'Одинаковое', createdAt: Date.UTC(2026, 0, 2) }));
    const subs = await Promise.all(reviews.map((r) => folder.writeReview(root, r)));
    assert.equal(new Set(subs).size, 8);
    assert.equal(Object.keys(names()).length, 8);
    reviews.forEach((r, k) => assert.equal(names()[r.id], subs[k]));
  });

  test('удаляет скриншоты удалённых замечаний, но не чужие файлы', async () => {
    const root = new MemDir('reviews-results');
    const keep = makeIssue({ title: 'Оставить' });
    const drop = makeIssue({ title: 'Удалить' });
    const review = makeReview({ issues: [keep, drop] });
    const sub = await folder.writeReview(root, review);
    root.put(`${sub}/screenshots/моя заметка.png`, 'x');
    root.put(`${sub}/screenshots/вложенная/01 — a — abcdef.png`, 'x');
    review.issues = [keep];
    await folder.writeReview(root, review);
    const shots = root.list(`${sub}/screenshots`);
    assert.equal(shots.filter((n) => n.includes('Оставить')).length, 1);
    assert.equal(shots.filter((n) => n.includes('Удалить')).length, 0);
    assert.ok(shots.includes('моя заметка.png'));
    assert.ok(shots.includes('вложенная'));
  });

  test('перенумерация при перестановке: старые имена удаляются, новые создаются', async () => {
    const root = new MemDir('reviews-results');
    const a = makeIssue({ title: 'A' });
    const b = makeIssue({ title: 'B' });
    const review = makeReview({ issues: [a, b] });
    const sub = await folder.writeReview(root, review);
    review.issues = [b, a];
    await folder.writeReview(root, review);
    const shots = root.list(`${sub}/screenshots`);
    assert.equal(shots.length, 2);
    assert.ok(shots[0].startsWith('01 — B'));
    assert.ok(shots[1].startsWith('02 — A'));
  });

  test('не переписывает скриншот, если размер не изменился', async () => {
    const root = new MemDir('reviews-results');
    const issue = makeIssue({ screenshot: PNG });
    const review = makeReview({ issues: [issue] });
    const sub = await folder.writeReview(root, review);
    const [name] = root.list(`${sub}/screenshots`);
    const file = root.at(`${sub}/screenshots/${name}`);
    await folder.writeReview(root, review);
    assert.equal(file.writes, 1);
    issue.screenshot = PNG_2;
    await folder.writeReview(root, review);
    assert.equal(file.writes, 2);
  });

  test('ошибка записи пробрасывается', async () => {
    const root = new MemDir('reviews-results');
    root.failWrites = 'Диск только для чтения';
    await assert.rejects(folder.writeReview(root, makeReview({ issues: [makeIssue()] })), /только для чтения/);
  });
});

describe('syncReview (фоновое автосохранение)', () => {
  test('нет папки → статус no-folder', async () => {
    await folder.syncReview(makeReview());
    assert.deepEqual(status(), { state: 'no-folder' });
  });

  test('нет разрешения → статус no-permission и ничего не пишется', async () => {
    const root = await connected('prompt');
    await folder.syncReview(makeReview());
    assert.equal(status().state, 'no-permission');
    assert.equal(status().dirName, 'reviews-results');
    assert.deepEqual(root.list(), []);
    assert.equal(root.permission, 'prompt', 'фон не должен запрашивать разрешение');
  });

  test('успех → файлы записаны, статус ok с подпапкой и временем', async () => {
    const root = await connected();
    const before = Date.now();
    await folder.syncReview(makeReview({ title: 'Синк' }));
    const s = status();
    assert.equal(s.state, 'ok');
    assert.match(s.lastFolder, /^Синк — /);
    assert.ok(s.lastSyncAt >= before);
    assert.equal(s.error, '');
    assert.ok(root.has(`${s.lastFolder}/review.json`));
  });

  test('ошибка записи → статус error, исключение не выбрасывается', async () => {
    const root = await connected();
    root.failWrites = 'Нет места на диске';
    await folder.syncReview(makeReview({ issues: [makeIssue()] }));
    assert.deepEqual({ state: status().state, error: status().error }, { state: 'error', error: 'Нет места на диске' });
  });
});

describe('writeAll', () => {
  test('пишет все ревью и обновляет статус', async () => {
    const root = new MemDir('reviews-results');
    await folder.writeAll(root, [makeReview({ title: 'A' }), makeReview({ title: 'B' })]);
    assert.equal(root.list().length, 2);
    assert.equal(status().state, 'ok');
  });
  test('пустой список — только статус', async () => {
    const root = new MemDir('reviews-results');
    await folder.writeAll(root, []);
    assert.deepEqual(root.list(), []);
    assert.equal(status().state, 'ok');
  });
});

describe('reviewFolderName', () => {
  test('берёт имя из словаря', async () => {
    const root = await connected();
    const review = makeReview();
    const sub = await folder.writeReview(root, review);
    assert.equal(await folder.reviewFolderName(review), sub);
  });

  test('без записи в словаре угадывает стандартное имя, если такая папка есть', async () => {
    const root = await connected();
    const review = makeReview({ title: 'Потерянное', createdAt: Date.UTC(2026, 4, 5) });
    root.put('Потерянное — 2026-05-05/review.json', '{}');
    assert.equal(await folder.reviewFolderName(review), 'Потерянное — 2026-05-05');
  });

  test('не угадывает, если папки нет на диске', async () => {
    await connected();
    assert.equal(await folder.reviewFolderName(makeReview()), null);
  });

  test('не угадывает папку, принадлежащую другому ревью', async () => {
    const root = await connected();
    const other = makeReview({ title: 'Двойник', createdAt: Date.UTC(2026, 0, 1) });
    await folder.writeReview(root, other);
    const me = makeReview({ title: 'Двойник', createdAt: Date.UTC(2026, 0, 1) });
    assert.equal(await folder.reviewFolderName(me), null);
  });

  test('без названия/даты, без папки или без разрешения → null', async () => {
    assert.equal(await folder.reviewFolderName({ id: 'x' }), null);
    assert.equal(await folder.reviewFolderName(makeReview()), null);
    const root = await connected('prompt');
    root.put(`${makeReview().title} — 2026-10-16/x`, '');
    assert.equal(await folder.reviewFolderName(makeReview()), null);
  });
});

describe('deleteReviewFolder', () => {
  test('удаляет папку ревью целиком и запись в словаре, соседей не трогает', async () => {
    const root = await connected();
    root.put('.gitkeep', '');
    const a = makeReview({ title: 'A', issues: [makeIssue()] });
    const b = makeReview({ title: 'B' });
    const subA = await folder.writeReview(root, a);
    const subB = await folder.writeReview(root, b);
    const res = await folder.deleteReviewFolder(a);
    assert.deepEqual(res, { deleted: true, name: subA });
    assert.deepEqual(root.list(), ['.gitkeep', subB]);
    assert.equal(names()[a.id], undefined);
    assert.equal(names()[b.id], subB);
  });

  test('ревью не сохранялось → not-saved', async () => {
    await connected();
    assert.deepEqual(await folder.deleteReviewFolder(makeReview()), { deleted: false, reason: 'not-saved' });
  });

  test('папку отключили после сохранения → no-folder, имя подпапки известно', async () => {
    const root = await connected();
    const review = makeReview();
    const sub = await folder.writeReview(root, review);
    await folder.clearDir();
    assert.deepEqual(await folder.deleteReviewFolder(review), { deleted: false, name: sub, reason: 'no-folder' });
  });

  test('нет разрешения → no-permission; с request=true разрешение запрашивается', async () => {
    const root = await connected();
    const review = makeReview();
    const sub = await folder.writeReview(root, review);
    root.permission = 'prompt';
    assert.deepEqual(await folder.deleteReviewFolder(review), { deleted: false, name: sub, reason: 'no-permission' });
    assert.ok(root.has(sub));
    assert.deepEqual(await folder.deleteReviewFolder(review, { request: true }), { deleted: true, name: sub });
    assert.ok(!root.has(sub));
  });

  test('папку уже удалили вручную — это не ошибка', async () => {
    const root = await connected();
    const review = makeReview();
    const sub = await folder.writeReview(root, review);
    await root.removeEntry(sub, { recursive: true });
    assert.deepEqual(await folder.deleteReviewFolder(review), { deleted: true, name: sub });
  });

  test('прочие ошибки удаления пробрасываются', async () => {
    const root = await connected();
    const review = makeReview();
    await folder.writeReview(root, review);
    root.removeEntry = async () => {
      const e = new Error('Файл занят');
      e.name = 'NoModificationAllowedError';
      throw e;
    };
    await assert.rejects(folder.deleteReviewFolder(review), /Файл занят/);
  });
});

test('RESULTS_DIR совпадает с папкой в репозитории', () => {
  assert.equal(folder.RESULTS_DIR, 'reviews-results');
});
