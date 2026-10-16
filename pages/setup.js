import * as store from '../lib/store.js';
import * as folder from '../lib/folder.js';
import { icon } from '../lib/icons.js';

const stateEl = document.getElementById('state');

async function shortcut() {
  const cmds = await chrome.commands.getAll();
  return cmds.find((c) => c.name === 'start-pick')?.shortcut || '';
}

async function render(error = '') {
  const dir = await folder.getDir();
  const { [folder.KEY_FOLDER_STATUS]: status = {} } = await chrome.storage.local.get(folder.KEY_FOLDER_STATUS);
  if (!dir) {
    stateEl.innerHTML = `<button class="btn btn-primary btn-big" data-act="pick">${icon('folder', 18)} Выбрать папку reviews-results</button>
      ${error ? `<div class="error"></div>` : ''}`;
    if (error) stateEl.querySelector('.error').textContent = error;
  } else {
    const keys = await shortcut();
    stateEl.innerHTML = `<div class="done">
        <h2>${icon('check', 18)} Папка подключена</h2>
        <p>Результаты сохраняются в <code class="path"></code></p>
        <p>Вернитесь на вкладку с сайтом и нажмите на иконку расширения → «🎯 Выбрать элемент»${keys ? ` или <code>${keys}</code>` : ''}.</p>
        <div class="actions">
          <button class="btn btn-primary" data-act="close">Начать ревью</button>
          <button class="btn btn-light" data-act="pick">${icon('folderOpen', 14)} Сменить папку</button>
        </div>
      </div>`;
    stateEl.querySelector('.path').textContent = `${folder.folderLabel(dir, status)}/`;
    stateEl.querySelector('[data-act=close]').addEventListener('click', async () => {
      const tab = await chrome.tabs.getCurrent();
      chrome.tabs.remove(tab.id);
    });
  }
  stateEl.querySelector('[data-act=pick]').addEventListener('click', pick);
}

async function pick() {
  let dir;
  try {
    ({ dir } = await folder.pickResultsFolder());
  } catch (e) {
    if (e.name !== 'AbortError') render(`Не удалось подключить папку: ${e.message}`);
    return;
  }
  try {
    await folder.writeAll(dir, await store.getAllReviews()); // сразу сохраняем уже существующие ревью
  } catch (e) {
    await folder.setStatus({ state: 'error', error: e.message });
  }
  render();
}

render();
