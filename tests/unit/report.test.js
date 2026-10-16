import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { makeIssue, makeReview, PNG, JPEG } from '../helpers/env.js';
import {
  escapeHtml,
  formatDate,
  reportFileName,
  specsHtml,
  buildReportBody,
  buildReportDocument,
  lightboxIcons,
  installLightbox,
  REPORT_CSS,
  SPECS_CSS,
} from '../../lib/report.js';
import { SEVERITIES } from '../../lib/constants.js';
import { ICONS } from '../../lib/icons.js';

const XSS = `<img src=x onerror="alert('x')">&`;
const parse = (html) => new JSDOM(html).window.document;
const bodyDoc = (review) => parse(`<!doctype html><body>${buildReportBody(review)}</body>`);

describe('escapeHtml', () => {
  test('экранирует все спецсимволы HTML', () => {
    assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
  test('null/undefined → пустая строка, числа → строка', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
  });
  test('не экранирует повторно безопасный текст', () => {
    assert.equal(escapeHtml('Кнопка — 12px'), 'Кнопка — 12px');
  });
});

describe('formatDate', () => {
  test('формат ДД.ММ.ГГГГ, ЧЧ:ММ', () => {
    assert.match(formatDate(Date.UTC(2026, 9, 16, 12, 5)), /^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/);
  });
});

describe('reportFileName', () => {
  test('имя с названием, сегодняшней датой и расширением', () => {
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(reportFileName({ title: 'Оплата' }, 'html'), `Дизайн-ревью — Оплата — ${today}.html`);
    assert.ok(reportFileName({ title: 'x' }, 'pdf').endsWith('.pdf'));
  });
  test('убирает символы, запрещённые в именах файлов', () => {
    const name = reportFileName({ title: 'a/b\\c:d*e?f"g<h>i|j' }, 'html');
    assert.ok(!/[\\/:*?"<>|]/.test(name.replace(/\.html$/, '')), name);
  });
  test('пустое название → «review», длинное обрезается до 80 символов', () => {
    assert.match(reportFileName({ title: '' }, 'html'), /^Дизайн-ревью — review — /);
    const long = reportFileName({ title: 'я'.repeat(200) }, 'html');
    assert.ok(long.includes('я'.repeat(80)) && !long.includes('я'.repeat(81)));
  });
});

describe('specsHtml', () => {
  test('пусто, если нет стилей, контраста и атрибутов', () => {
    assert.equal(specsHtml({}), '');
    assert.equal(specsHtml({ styles: { groups: [] }, element: { attributes: {} } }), '');
  });

  test('группы стилей с образцами цветов, атрибуты и заметки', () => {
    const html = specsHtml({
      styles: {
        groups: [{ title: 'Цвета', rows: [['color', '#1D1530'], ['background', 'linear-gradient(#FFFFFF, #000000AA)']] }],
        notes: ['2 табл. стилей недоступны'],
      },
      element: { attributes: { 'data-testid': 'buy' } },
    });
    const doc = parse(html);
    assert.equal(doc.querySelector('details.specs').open, true);
    assert.equal(doc.querySelectorAll('.spec-group').length, 2);
    assert.equal(doc.querySelectorAll('.sw').length, 3);
    assert.equal(doc.querySelector('.sw').style.background, 'rgb(29, 21, 48)');
    assert.match(doc.body.textContent, /Атрибуты/);
    assert.match(doc.body.textContent, /data-testid/);
    assert.match(doc.querySelector('.spec-note').textContent, /недоступны/);
  });

  test('open:false — блок свёрнут', () => {
    const html = specsHtml({ element: { attributes: { id: 'x' } } }, { open: false });
    assert.equal(parse(html).querySelector('details.specs').open, false);
  });

  test('контраст: коэффициент, бейджи AA/AAA, приблизительность', () => {
    const c = { ratio: 3.2, aa: false, aaa: false, large: true, text: '#777777', background: '#FFFFFF', approx: true, sample: 'Купить' };
    const doc = parse(specsHtml({ styles: { groups: [], contrast: c } }));
    assert.match(doc.querySelector('.contrast b').textContent, /3\.2:1/);
    assert.equal(doc.querySelectorAll('.fail').length, 2);
    assert.match(doc.body.textContent, /крупный текст/);
    assert.match(doc.body.textContent, /«Купить»/);
    assert.match(doc.body.textContent, /градиент или картинка/);
    const ok = parse(specsHtml({ styles: { contrast: { ...c, aa: true, aaa: true, large: false, approx: false, sample: '' } } }));
    assert.equal(ok.querySelectorAll('.pass').length, 2);
    assert.match(ok.body.textContent, /обычный текст/);
  });

  test('экранирует пользовательские значения', () => {
    const html = specsHtml({ styles: { groups: [{ title: XSS, rows: [[XSS, XSS]] }], notes: [XSS] }, element: { attributes: { [XSS]: XSS } } });
    assert.equal(parse(html).querySelector('img'), null);
  });
});

describe('buildReportBody', () => {
  test('шапка: название, автор, число замечаний со склонением', () => {
    for (const [n, word] of [
      [0, 'замечаний'],
      [1, 'замечание'],
      [2, 'замечания'],
      [4, 'замечания'],
      [5, 'замечаний'],
      [11, 'замечаний'],
      [12, 'замечаний'],
      [14, 'замечаний'],
      [21, 'замечание'],
      [22, 'замечания'],
      [101, 'замечание'],
      [111, 'замечаний'],
    ]) {
      const review = makeReview({ issues: Array.from({ length: n }, () => makeIssue()) });
      const doc = bodyDoc(review);
      assert.equal(doc.querySelector('.r-total b').textContent, String(n));
      assert.equal(doc.querySelector('.r-total span').textContent, word, `n=${n}`);
    }
  });

  test('пустое ревью — заглушка без сводки', () => {
    const doc = bodyDoc(makeReview());
    assert.match(doc.querySelector('.empty-state').textContent, /пока нет замечаний/);
    assert.equal(doc.querySelector('table.toc'), null);
  });

  test('сводка и карточки замечаний с якорями и критичностью', () => {
    const issues = SEVERITIES.map((s) => makeIssue({ severity: s.id }));
    const doc = bodyDoc(makeReview({ issues }));
    const rows = doc.querySelectorAll('table.toc tbody tr');
    assert.equal(rows.length, 4);
    rows.forEach((tr, k) => {
      assert.equal(tr.querySelector('a').getAttribute('href'), `#issue-${k + 1}`);
      assert.equal(tr.querySelector('.chip').textContent, SEVERITIES[k].label);
      assert.ok(doc.getElementById(`issue-${k + 1}`));
    });
  });

  test('неизвестная критичность отображается как «Средняя»', () => {
    const doc = bodyDoc(makeReview({ issues: [makeIssue({ severity: 'weird' })] }));
    assert.equal(doc.querySelector('.toc .chip').textContent, 'Средняя');
  });

  test('автор в шапке необязателен', () => {
    assert.match(bodyDoc(makeReview({ author: 'Анна' })).querySelector('.r-meta').textContent, /Автор: Анна/);
    assert.doesNotMatch(bodyDoc(makeReview({ author: '' })).querySelector('.r-meta').textContent, /Автор/);
  });

  test('тикеты: кликабельные ссылки или «не указан»', () => {
    const doc = bodyDoc(makeReview({ devTicketUrl: 'https://st.example.com/DEV-1/', designTicketUrl: '' }));
    const [dev, design] = doc.querySelectorAll('.r-tasks:not(.r-pages) > *');
    assert.equal(dev.tagName, 'A');
    assert.equal(dev.getAttribute('href'), 'https://st.example.com/DEV-1/');
    assert.equal(dev.querySelector('.task-link').textContent, 'st.example.com/DEV-1');
    assert.equal(design.tagName, 'DIV');
    assert.ok(design.classList.contains('empty'));
    assert.equal(design.querySelector('.task-link').textContent, 'не указан');
  });

  test('проверенные страницы: по одной карточке на URL, без дублей', () => {
    const issues = [
      makeIssue({ page: { url: 'https://shop.ru/cart?x=1', title: 'Корзина' } }),
      makeIssue({ page: { url: 'https://shop.ru/cart?x=1', title: 'Корзина (повтор)' } }),
      makeIssue({ page: { url: 'https://shop.ru/pay/', title: '' } }),
      makeIssue({ page: { url: 'javascript:alert(1)', title: 'XSS' } }),
      makeIssue({ page: undefined }),
    ];
    const cards = bodyDoc(makeReview({ issues })).querySelectorAll('.r-pages .task');
    assert.equal(cards.length, 2);
    assert.equal(cards[0].querySelector('.task-link').textContent, 'Корзина');
    assert.equal(cards[0].querySelector('.task-sub').textContent, 'shop.ru/cart');
    assert.equal(cards[1].querySelector('.task-link').textContent, 'shop.ru/pay');
    assert.equal(cards[1].querySelector('.task-sub'), null);
  });

  test('нет страниц — нет блока страниц', () => {
    assert.equal(bodyDoc(makeReview({ issues: [makeIssue({ page: null })] })).querySelector('.r-pages'), null);
  });

  test('карточка замечания: описание, макет, страница, элемент, окно, дата', () => {
    const issue = makeIssue({ description: 'Строка 1\nСтрока 2' });
    const doc = bodyDoc(makeReview({ issues: [issue] }));
    const card = doc.getElementById('issue-1');
    assert.equal(card.querySelector('h3').textContent, issue.title);
    assert.equal(card.querySelector('.desc').textContent, 'Строка 1\nСтрока 2');
    const links = [...card.querySelectorAll('.props a')];
    assert.deepEqual(links.map((a) => a.getAttribute('href')), [issue.mockupUrl, issue.page.url]);
    links.forEach((a) => assert.equal(a.getAttribute('rel'), 'noopener'));
    assert.equal(card.querySelector('.props code').textContent, 'main > .card');
    assert.match(card.textContent, /320×200px/);
    assert.match(card.textContent, /1440×900, DPR 2/);
    assert.match(card.style.cssText, /--fg/);
  });

  test('пустое описание и отсутствующие ссылки', () => {
    const doc = bodyDoc(makeReview({ issues: [makeIssue({ description: '', mockupUrl: '', page: null, element: null, viewport: null })] }));
    const card = doc.getElementById('issue-1');
    assert.ok(card.querySelector('.desc').classList.contains('empty'));
    assert.equal(card.querySelector('.desc').textContent, 'Без описания');
    assert.equal(card.querySelectorAll('.props a').length, 0);
    assert.doesNotMatch(card.textContent, /Элемент|Окно/);
  });

  test('скриншот: только data:image/png|jpeg, с подписью и пометками', () => {
    const doc = bodyDoc(
      makeReview({
        issues: [
          makeIssue({ screenshot: PNG, screenshotTruncated: true, screenshotNote: 'Снимок области экрана' }),
          makeIssue({ screenshot: JPEG }),
          makeIssue({ screenshot: 'https://evil.example/x.png' }),
          makeIssue({ screenshot: 'data:image/svg+xml;base64,PHN2Zz4=' }),
          makeIssue({ screenshot: '' }),
        ],
      }),
    );
    const imgs = doc.querySelectorAll('.shot img');
    assert.equal(imgs.length, 2);
    assert.equal(imgs[0].getAttribute('data-caption'), `#1 · ${doc.querySelector('#issue-1 h3').textContent}`);
    const notes = [...doc.querySelectorAll('#issue-1 .shot-note')].map((n) => n.textContent);
    assert.deepEqual(notes, ['Элемент слишком большой — снят не целиком', 'Снимок области экрана']);
  });

  test('XSS: пользовательские данные экранированы, опасные ссылки отброшены', () => {
    const review = makeReview({
      title: XSS,
      author: XSS,
      devTicketUrl: 'javascript:alert(1)',
      designTicketUrl: 'data:text/html,<script>1</script>',
      issues: [
        makeIssue({
          title: XSS,
          description: XSS,
          mockupUrl: 'javascript:alert(1)',
          page: { url: 'javascript:alert(2)', title: XSS },
          element: { selector: XSS, width: 1, height: 1, attributes: { [XSS]: XSS } },
          screenshotNote: XSS,
          styles: { groups: [{ title: XSS, rows: [[XSS, XSS]] }] },
        }),
      ],
    });
    const doc = bodyDoc(review);
    assert.equal(doc.querySelectorAll('img[onerror], script').length, 0);
    assert.equal(doc.querySelectorAll('a[href^="javascript"], a[href^="data"]').length, 0);
    assert.equal(doc.querySelectorAll('.r-tasks .task.empty').length, 2);
    assert.equal(doc.querySelector('h1').textContent, XSS);
  });
});

describe('buildReportDocument', () => {
  test('полноценный HTML-документ с заголовком, стилями и скриптом просмотрщика', () => {
    const review = makeReview({ title: 'Оплата', issues: [makeIssue()] });
    const html = buildReportDocument(review);
    assert.match(html, /^<!doctype html>/);
    const doc = parse(html);
    assert.equal(doc.documentElement.lang, 'ru');
    assert.equal(doc.title, 'Дизайн-ревью — Оплата');
    assert.ok(doc.querySelector('meta[charset="utf-8"]'));
    assert.ok(doc.querySelector('style').textContent.includes('.issue'));
    assert.equal(doc.querySelectorAll('script').length, 1);
    assert.ok(doc.querySelector('main.report'));
  });

  test('самодостаточный: никаких внешних ресурсов', () => {
    const html = buildReportDocument(makeReview({ issues: [makeIssue()] }));
    const doc = parse(html);
    assert.equal(doc.querySelectorAll('link[rel=stylesheet], script[src], img[src^=http]').length, 0);
    assert.doesNotMatch(html, /@import|url\(https?:/);
  });

  test('заголовок документа экранирован', () => {
    const doc = parse(buildReportDocument(makeReview({ title: '</title><script>alert(1)</script>' })));
    assert.equal(doc.querySelectorAll('script').length, 1);
    assert.match(doc.title, /<\/title>/);
  });

  test('встроенные иконки не могут закрыть тег <script>', () => {
    const html = buildReportDocument(makeReview());
    const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
    assert.doesNotMatch(script, /<\/script/i);
    assert.doesNotMatch(script.slice(script.indexOf('(document, ')), /</);
  });

  test('скрипт просмотрщика исполняется в открытом с диска файле', () => {
    const dom = new JSDOM(buildReportDocument(makeReview({ issues: [makeIssue()] })), { runScripts: 'dangerously', pretendToBeVisual: true });
    assert.ok(dom.window.document.querySelector('.lb[hidden]'));
    dom.window.close();
  });
});

describe('стили', () => {
  test('REPORT_CSS включает общий блок SPECS_CSS и стили печати', () => {
    assert.ok(REPORT_CSS.includes(SPECS_CSS));
    assert.match(REPORT_CSS, /@media print/);
    assert.match(REPORT_CSS, /@page \{ size: A4/);
  });
});

describe('lightboxIcons', () => {
  test('все нужные просмотрщику иконки существуют', () => {
    const icons = lightboxIcons();
    assert.deepEqual(Object.keys(icons).sort(), ['chevronLeft', 'chevronRight', 'expand', 'xmark', 'zoomIn', 'zoomOut']);
    for (const [name, svg] of Object.entries(icons)) assert.equal(svg, ICONS[name], name);
  });
});

describe('installLightbox (просмотр скриншотов)', () => {
  function setup(n = 3) {
    const review = makeReview({ issues: Array.from({ length: n }, () => makeIssue()) });
    const dom = new JSDOM(`<!doctype html><body>${buildReportBody(review)}</body>`, { pretendToBeVisual: true });
    const { document: doc } = dom.window;
    installLightbox(doc, lightboxIcons());
    const box = doc.querySelector('.lb');
    const imgs = [...doc.querySelectorAll('.report .shot img')];
    const key = (k) => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    return { dom, doc, box, imgs, key, click, review };
  }

  test('изначально скрыт', () => {
    const { box } = setup();
    assert.equal(box.hidden, true);
  });

  test('клик по скриншоту открывает его с подписью и счётчиком', () => {
    const { doc, box, imgs, click, review } = setup();
    click(imgs[1]);
    assert.equal(box.hidden, false);
    assert.ok(doc.documentElement.classList.contains('lb-open'));
    assert.equal(box.querySelector('.lb-cap').textContent, `#2 · ${review.issues[1].title}`);
    assert.equal(box.querySelector('.lb-count').textContent, '2 / 3');
    assert.equal(box.querySelector('.lb-stage img').src, imgs[1].src);
  });

  test('стрелки листают по кругу', () => {
    const { box, imgs, click, key } = setup();
    click(imgs[0]);
    key('ArrowLeft');
    assert.equal(box.querySelector('.lb-count').textContent, '3 / 3');
    key('ArrowRight');
    key('ArrowRight');
    assert.equal(box.querySelector('.lb-count').textContent, '2 / 3');
  });

  test('кнопки ‹ › работают как стрелки', () => {
    const { box, imgs, click } = setup();
    click(imgs[0]);
    click(box.querySelector('[data-lb=next]'));
    assert.equal(box.querySelector('.lb-count').textContent, '2 / 3');
    click(box.querySelector('[data-lb=prev]'));
    assert.equal(box.querySelector('.lb-count').textContent, '1 / 3');
  });

  test('Z и кнопка масштаба переключают «вписать» / «100%» (и в русской раскладке)', () => {
    const { box, imgs, click, key } = setup();
    click(imgs[0]);
    assert.equal(box.classList.contains('actual'), false);
    key('z');
    assert.equal(box.classList.contains('actual'), true);
    assert.match(box.querySelector('[data-lb=zoom]').textContent, /Вписать/);
    key('я');
    assert.equal(box.classList.contains('actual'), false);
    click(box.querySelector('[data-lb=zoom]'));
    assert.equal(box.classList.contains('actual'), true);
    click(box.querySelector('.lb-stage img'));
    assert.equal(box.classList.contains('actual'), false);
  });

  test('Esc, крестик и клик по фону закрывают', () => {
    const { doc, box, imgs, click, key } = setup();
    click(imgs[0]);
    key('Escape');
    assert.equal(box.hidden, true);
    assert.equal(doc.documentElement.classList.contains('lb-open'), false);
    click(imgs[0]);
    click(box.querySelector('[data-lb=close]'));
    assert.equal(box.hidden, true);
    click(imgs[0]);
    click(box.querySelector('.lb-stage'));
    assert.equal(box.hidden, true);
  });

  test('с одним скриншотом навигация скрыта, счётчика нет', () => {
    const { box, imgs, click } = setup(1);
    click(imgs[0]);
    assert.equal(box.querySelector('.lb-count').textContent, '');
    box.querySelectorAll('.lb-nav').forEach((b) => assert.equal(b.hidden, true));
  });

  test('клавиши не перехватываются, пока просмотрщик закрыт', () => {
    const { doc, dom } = setup();
    const ev = new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true });
    doc.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
  });

  test('перед печатью раскрывает «Стили и данные элемента», после — сворачивает обратно', () => {
    const review = makeReview({ issues: [makeIssue({ element: { attributes: { id: 'a' } } })] });
    const dom = new JSDOM(`<!doctype html><body>${buildReportBody(review)}</body>`);
    installLightbox(dom.window.document, lightboxIcons());
    const d = dom.window.document.querySelector('details.specs');
    assert.equal(d.open, false);
    dom.window.dispatchEvent(new dom.window.Event('beforeprint'));
    assert.equal(d.open, true);
    dom.window.dispatchEvent(new dom.window.Event('afterprint'));
    assert.equal(d.open, false);
  });

  test('работает без иконок (ic = undefined)', () => {
    const dom = new JSDOM(`<!doctype html><body>${buildReportBody(makeReview({ issues: [makeIssue()] }))}</body>`);
    assert.doesNotThrow(() => installLightbox(dom.window.document));
  });
});
