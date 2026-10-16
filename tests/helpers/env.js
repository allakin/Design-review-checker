// Общая подготовка окружения для модулей из lib/: глобальные chrome и indexedDB.
import { createChrome } from './chrome.js';
import { createIndexedDB } from './idb.js';

export function installEnv(options = {}) {
  const chrome = createChrome(options);
  const indexedDB = createIndexedDB();
  globalThis.chrome = chrome;
  globalThis.indexedDB = indexedDB;
  return { chrome, indexedDB };
}

// 1×1 PNG и JPEG в виде data URL.
export const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const PNG_2 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYPj/n4GBgYGJAQoAKgAE/SfSPQAAAABJRU5ErkJggg==';
export const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

let seq = 0;
export function makeIssue(overrides = {}) {
  seq++;
  return {
    id: crypto.randomUUID(),
    createdAt: Date.UTC(2026, 9, 16, 10, 0, seq),
    title: `Замечание ${seq}`,
    description: 'Отступ не совпадает с макетом',
    severity: 'high',
    mockupUrl: 'https://www.figma.com/file/abc',
    screenshot: PNG,
    screenshotSize: { width: 1, height: 1 },
    screenshotTruncated: false,
    screenshotNote: '',
    styles: null,
    page: { url: 'https://example.com/catalog?utm=1', title: 'Каталог' },
    element: { selector: 'main > .card', name: 'div.card', text: 'Текст', width: 320, height: 200, attributes: { class: 'card' } },
    viewport: { width: 1440, height: 900, dpr: 2 },
    ...overrides,
  };
}

export function makeReview(overrides = {}) {
  seq++;
  return {
    id: `review-${seq}`,
    title: 'Ревью страницы оплаты',
    author: 'Анна',
    devTicketUrl: 'https://tracker.example.com/DEV-1',
    designTicketUrl: 'https://tracker.example.com/DESIGN-2',
    createdAt: Date.UTC(2026, 9, 16, 9, 0, 0),
    updatedAt: Date.UTC(2026, 9, 16, 9, 30, 0),
    issues: [],
    ...overrides,
  };
}
