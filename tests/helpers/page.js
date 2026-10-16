// Загружает страницу расширения (popup/review/report/setup): настоящий HTML в jsdom
// + ES-модуль страницы, импортированный в Node с глобальными window/document/chrome.
import { readFileSync } from 'node:fs';
import { mock } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { installEnv, PNG } from './env.js';
import { EXTENSION_ID } from './chrome.js';
import * as folder from '../../lib/folder.js';

const ROOT = new URL('../../', import.meta.url);
let loads = 0;
let current = null;

const GLOBALS = ['window', 'document', 'location', 'history', 'navigator', 'Event', 'KeyboardEvent', 'MouseEvent', 'HTMLElement', 'Node', 'getComputedStyle'];

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// <dialog> в jsdom без showModal/close и без form[method=dialog].
function polyfillDialog(window) {
  const proto = window.HTMLDialogElement.prototype;
  proto.showModal = function () {
    this.open = true;
    if (this.__drcBound) return;
    this.__drcBound = true;
    this.addEventListener('click', (e) => {
      const btn = e.target.closest('button[value]');
      if (btn && this.contains(btn)) {
        e.preventDefault();
        this.close(btn.value);
      }
    });
  };
  proto.close = function (value) {
    if (!this.open) return;
    if (value !== undefined) this.returnValue = value;
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
  };
}

// Длинные таймеры страниц (например, revokeObjectURL через 60 с после скачивания) не должны
// держать процесс тестов: в браузере вкладка просто живёт дальше.
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function (fn, ms, ...args) {
  const t = nativeSetTimeout(fn, ms, ...args);
  if (ms >= 10_000) t.unref?.();
  return t;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} page   'popup/popup' | 'pages/review' | 'pages/report' | 'pages/setup'
 * @param {object} opts   query — строка запроса; setup(env) — подготовить данные до запуска скрипта
 */
export async function loadPage(page, { query = '', hash = '', setup, tabs = [{ url: 'https://shop.example.com/cart' }] } = {}) {
  closePage();
  const env = installEnv({ tabs });
  const html = readFileSync(new URL(`${page}.html`, ROOT), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  // jsdom считает chrome-extension:// непрозрачным origin и запрещает history.replaceState — берём http.
  const url = `http://${EXTENSION_ID}.test/${page}.html${query}${hash}`;
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const { window } = dom;
  polyfillDialog(window);
  // В браузере form.<name> возвращает поле формы (в т.ч. form.title — [LegacyOverrideBuiltIns]);
  // jsdom именованный доступ к полям формы не поддерживает.
  const titleDesc = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'title');
  for (const name of ['title', 'author', 'devTicketUrl', 'designTicketUrl']) {
    Object.defineProperty(window.HTMLFormElement.prototype, name, {
      configurable: true,
      get() {
        return this.elements.namedItem(name) || titleDesc.get.call(this);
      },
      set(v) {
        titleDesc.set.call(this, v);
      },
    });
  }
  window.Element.prototype.scrollIntoView = function () {};
  // jsdom не грузит картинки: data:-скриншоты в браузере готовы сразу.
  Object.defineProperty(window.HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
  window.close = mock.fn();
  window.print = mock.fn();
  for (const name of GLOBALS) setGlobal(name, name === 'window' ? window : window[name]);
  setGlobal('chrome', env.chrome);
  window.chrome = env.chrome;

  const downloads = [];
  const clickMock = mock.method(window.HTMLAnchorElement.prototype, 'click', function () {
    if (this.download) downloads.push({ name: this.download, href: this.href });
  });

  if (setup) await setup(env);
  await import(new URL(`${page}.js?load=${++loads}`, ROOT).href);
  await sleep(30);

  const { document } = window;
  current = { dom, clickMock };
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const input = (el, value) => {
    el.value = value;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const key = (el, k, init = {}) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  return { ...env, dom, window, document, $, $$, input, key, downloads, sleep };
}

export function closePage() {
  if (!current) return;
  current.clickMock.mock.restore();
  current.dom.window.close();
  current = null;
}

// Подключённая папка результатов с выданным разрешением.
export async function connectFolder(MemDir, { permission = 'granted', name = 'reviews-results' } = {}) {
  const root = new MemDir(name, { permission });
  await folder.setDir(root);
  await folder.setStatus({ state: 'ok', dirName: name, project: '', error: '' });
  return root;
}

export { PNG };
