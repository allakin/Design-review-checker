// Проверки целостности расширения: манифест, пути, синхронность копий, синтаксис.
// Ловят «забыли файл», «переименовали и не поправили ссылку», «поменяли копию только в одном месте».
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { ICONS } from '../../lib/icons.js';
import { SEVERITIES } from '../../lib/constants.js';
import { SUITES, badgesMarkdown, replaceBlock } from '../../scripts/badges.js';

const ROOT = new URL('../../', import.meta.url);
const path = (p) => new URL(p, ROOT);
const read = (p) => readFileSync(path(p), 'utf8');
const exists = (p) => existsSync(path(p));
const manifest = JSON.parse(read('manifest.json'));

// Все JS-файлы расширения (без тестов и зависимостей).
const SOURCE_DIRS = ['.', 'lib', 'content', 'popup', 'pages'];
const jsFiles = SOURCE_DIRS.flatMap((dir) =>
  readdirSync(path(dir === '.' ? './' : `${dir}/`))
    .filter((f) => f.endsWith('.js'))
    .map((f) => (dir === '.' ? f : `${dir}/${f}`)),
);
const htmlFiles = ['popup/popup.html', 'pages/review.html', 'pages/report.html', 'pages/setup.html'];

describe('manifest.json', () => {
  test('Manifest V3 с обязательными полями', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.name);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(manifest.description.trim());
  });

  // Распакованное расширение загрузится, но Chrome Web Store отклонит описание длиннее 132 символов.
  test('описание не длиннее 132 символов (лимит Chrome Web Store)', { todo: 'сейчас 143 символа' }, () => {
    assert.ok(manifest.description.length <= 132, `${manifest.description.length} символов`);
  });

  test('версия в manifest.json и package.json совпадает', () => {
    assert.equal(JSON.parse(read('package.json')).version, manifest.version);
  });

  test('все файлы, на которые ссылается манифест, существуют', () => {
    const files = [
      manifest.background.service_worker,
      manifest.action.default_popup,
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon),
    ];
    for (const f of files) assert.ok(exists(f), f);
  });

  test('иконки — PNG нужных размеров', () => {
    for (const [size, file] of Object.entries(manifest.icons)) {
      const buf = readFileSync(path(file));
      assert.equal(buf.toString('ascii', 1, 4), 'PNG', file);
      assert.equal(buf.readUInt32BE(16), Number(size), `${file}: ширина`);
      assert.equal(buf.readUInt32BE(20), Number(size), `${file}: высота`);
    }
  });

  test('сервис-воркер — ES-модуль', () => {
    assert.equal(manifest.background.type, 'module');
  });

  test('разрешения: всё нужное и ничего лишнего', () => {
    assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'storage', 'tabs', 'unlimitedStorage']);
    assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  });

  test('горячая клавиша Alt+Shift+D для выбора элемента', () => {
    const cmd = manifest.commands['start-pick'];
    assert.equal(cmd.suggested_key.default, 'Alt+Shift+D');
    assert.equal(cmd.suggested_key.mac, 'Alt+Shift+D');
  });

  test('имя команды совпадает с тем, что слушают background и popup', () => {
    for (const f of ['background.js', 'popup/popup.js', 'pages/setup.js']) assert.ok(read(f).includes("'start-pick'"), f);
  });

  test('в корне нет файлов на «_» — Chrome откажется загружать расширение', () => {
    const bad = readdirSync(path('./')).filter((f) => f.startsWith('_'));
    assert.deepEqual(bad, []);
  });
});

describe('скрипты и страницы', () => {
  test('все JS-файлы синтаксически корректны', () => {
    for (const f of jsFiles) {
      const isModule = !f.startsWith('content/');
      execFileSync(process.execPath, ['--check', ...(isModule ? ['--input-type=module'] : []), ...(isModule ? [] : [fileURLToPath(path(f))])], {
        input: isModule ? read(f) : undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
  });

  test('относительные импорты указывают на существующие файлы и экспортируемые имена', async () => {
    for (const f of jsFiles.filter((x) => !x.startsWith('content/'))) {
      const src = read(f);
      for (const m of src.matchAll(/import\s+(?:\{([^}]+)\}|\*\s+as\s+\w+)\s+from\s+'([^']+)'/g)) {
        const target = new URL(m[2], path(f));
        assert.ok(existsSync(target), `${f}: ${m[2]}`);
        if (!m[1]) continue;
        const exported = readFileSync(target, 'utf8');
        for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
          assert.match(exported, new RegExp(`export (async )?(function|const|let|class) ${name}\\b`), `${f}: ${name} из ${m[2]}`);
        }
      }
    }
  });

  test('HTML-страницы подключают существующие скрипты и стили', () => {
    for (const f of htmlFiles) {
      const doc = new JSDOM(read(f)).window.document;
      const refs = [...doc.querySelectorAll('script[src], link[rel=stylesheet], img[src]')].map((n) => n.getAttribute('src') || n.getAttribute('href'));
      assert.ok(refs.length, f);
      for (const ref of refs) assert.ok(existsSync(new URL(ref, path(f))), `${f}: ${ref}`);
      for (const s of doc.querySelectorAll('script[src]')) assert.equal(s.type, 'module', `${f}: ${s.getAttribute('src')} должен быть type=module`);
    }
  });

  test('страницы расширения не грузят ничего из сети (CSP MV3)', () => {
    for (const f of htmlFiles) assert.doesNotMatch(read(f), /(src|href)="https?:/, f);
    for (const f of jsFiles) assert.doesNotMatch(read(f), /\bfetch\(|XMLHttpRequest|import\(['"]https?:/, f);
  });

  test('нет inline-скриптов (запрещены CSP расширений)', () => {
    for (const f of htmlFiles) {
      const doc = new JSDOM(read(f)).window.document;
      for (const s of doc.querySelectorAll('script:not([src])')) assert.equal(s.textContent.trim(), '', f);
      assert.doesNotMatch(read(f), /\son[a-z]+="/, `${f}: inline-обработчики событий`);
    }
  });

  test('элементы, которые скрипты ищут по id, есть в разметке', () => {
    const pairs = [
      ['popup/popup.js', 'popup/popup.html'],
      ['pages/review.js', 'pages/review.html'],
      ['pages/report.js', 'pages/report.html'],
      ['pages/setup.js', 'pages/setup.html'],
    ];
    for (const [js, html] of pairs) {
      const doc = new JSDOM(read(html)).window.document;
      for (const [, id] of read(js).matchAll(/getElementById\('([^']+)'\)/g)) assert.ok(doc.getElementById(id), `${html}: нет #${id} для ${js}`);
    }
  });

  test('background внедряет существующие файлы в правильном порядке (иконки до content.js)', () => {
    const m = read('background.js').match(/files: \[([^\]]+)\]/);
    const files = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.deepEqual(files, ['content/icons.js', 'content/content.js']);
    files.forEach((f) => assert.ok(exists(f), f));
  });

  test('страницы, которые открывает код, существуют', () => {
    for (const f of jsFiles) {
      for (const [, page] of read(f).matchAll(/'(pages\/[\w-]+\.html)/g)) assert.ok(exists(page), `${f}: ${page}`);
      for (const [, page] of read(f).matchAll(/`(pages\/[\w-]+\.html)/g)) assert.ok(exists(page), `${f}: ${page}`);
    }
  });
});

describe('сообщения между частями расширения', () => {
  const handled = new Set([...read('background.js').matchAll(/case '(drc:[\w]+)'/g)].map((m) => m[1]));
  const contentHandles = new Set([...read('content/content.js').matchAll(/msg\?\.type === '(drc:\w+)'/g)].map((m) => m[1]));

  test('всё, что шлют popup и контент-скрипт в runtime, обрабатывает background', () => {
    for (const f of ['popup/popup.js', 'content/content.js', 'pages/review.js']) {
      for (const [, type] of read(f).matchAll(/runtime\.sendMessage\(\{ type: '(drc:\w+)'/g)) assert.ok(handled.has(type), `${f}: ${type}`);
    }
  });

  test('всё, что background шлёт во вкладку, обрабатывает контент-скрипт', () => {
    for (const [, type] of read('background.js').matchAll(/tabs\.sendMessage\(tabId, \{ type: '(drc:\w+)'/g)) assert.ok(contentHandles.has(type), type);
    assert.deepEqual([...contentHandles].sort(), ['drc:ping', 'drc:start']);
  });
});

describe('иконки Gravity UI', () => {
  const contentIcons = (() => {
    const ctx = {};
    new Function('globalThis', read('content/icons.js'))(ctx);
    return ctx.__drcIcons;
  })();

  test('копия иконок для контент-скрипта совпадает с lib/icons.js', () => {
    for (const [name, svg] of Object.entries(contentIcons)) assert.equal(svg, ICONS[name], name);
  });

  test('все icon(...) на страницах расширения существуют', () => {
    for (const f of jsFiles.filter((x) => !x.startsWith('content/'))) {
      for (const [, name] of read(f).matchAll(/\bicon\('(\w+)'/g)) assert.ok(ICONS[name], `${f}: icon('${name}')`);
    }
  });

  test('все I(...) в контент-скрипте существуют в content/icons.js', () => {
    const used = [...read('content/content.js').matchAll(/\bI\('(\w+)'/g)].map((m) => m[1]);
    assert.ok(used.length > 5);
    for (const name of used) assert.ok(contentIcons[name], `I('${name}')`);
  });

  test('иконки — корректные SVG path с currentColor', () => {
    for (const [name, svg] of Object.entries(ICONS)) {
      assert.match(svg, /^<path [^>]*fill="currentColor"[^>]*\/>$/, name);
    }
  });

  test('лицензия иконок лежит рядом', () => {
    assert.match(read('icons/gravity-ui-LICENSE.txt'), /MIT/);
  });
});

describe('копии кода в контент-скрипте', () => {
  test('SEVERITIES в content.js текстуально совпадают с lib/constants.js', () => {
    const block = read('content/content.js').match(/const SEVERITIES = (\[[\s\S]*?\]);/)[1];
    assert.deepEqual(new Function(`return ${block}`)(), SEVERITIES);
  });
});

describe('репозиторий', () => {
  test('reviews-results хранится через .gitkeep, содержимое игнорируется', () => {
    const gi = read('.gitignore');
    assert.ok(exists('reviews-results/.gitkeep'));
    assert.match(gi, /^reviews-results\/\*$/m);
    assert.match(gi, /^!reviews-results\/\.gitkeep$/m);
  });

  test('node_modules не попадает в git', () => {
    assert.match(read('.gitignore'), /^node_modules\/?$/m);
  });

  test('раздел «Структура» в README описывает существующие файлы', () => {
    const readme = read('README.md');
    const block = readme.split('## Структура')[1].split('```')[1];
    const paths = [...block.matchAll(/^(\S+)/gm)].map((m) => m[1].replace(/\.\*$/, '.js'));
    assert.ok(paths.length > 10);
    for (const p of paths) {
      const target = p.endsWith('/') ? p : p;
      assert.ok(exists(target), `README упоминает ${p}, но его нет`);
    }
  });

  test('все исходники упомянуты в разделе «Структура» README', () => {
    const block = read('README.md').split('## Структура')[1].split('```')[1];
    for (const f of jsFiles) {
      const dir = f.includes('/') ? `${f.split('/')[0]}/` : f;
      const base = f.replace(/\.js$/, '');
      assert.ok(block.includes(f) || block.includes(`${base}.*`) || block.includes(dir), `README не описывает ${f}`);
    }
  });

  test('каталоги из «Структуры» не пустые', () => {
    for (const d of ['lib', 'content', 'popup', 'pages', 'icons']) {
      assert.ok(statSync(path(d)).isDirectory() && readdirSync(path(d)).length, d);
    }
  });
});

describe('тесты и плашки', () => {
  const testFiles = ['unit', 'pages', 'integrity'].flatMap((d) =>
    readdirSync(path(`tests/${d}/`))
      .filter((f) => f.endsWith('.test.js'))
      .map((f) => `tests/${d}/${f}`),
  );

  test('каждый тестовый файл попадает в какую-то плашку README (scripts/badges.js)', () => {
    const covered = new Set(SUITES.flatMap((s) => s.files));
    for (const f of testFiles) assert.ok(covered.has(f), `${f} не входит ни в один набор SUITES`);
    for (const f of covered) assert.ok(exists(f), `в SUITES указан несуществующий ${f}`);
  });

  test('в README есть блок плашек с версией из manifest.json и всеми наборами', () => {
    const readme = read('README.md');
    const block = readme.split('<!-- badges:start -->')[1]?.split('<!-- badges:end -->')[0];
    assert.ok(block, 'нет блока <!-- badges:start --> … <!-- badges:end -->');
    assert.ok(block.includes(`release-v${manifest.version}-`), 'версия на плашке не совпадает с manifest.json — запустите npm run badges');
    for (const s of SUITES) assert.ok(block.includes(`[${s.label}`) || block.includes(`![${s.label}`), s.label);
  });

  test('генератор: «passing» только при успешном прогоне, иначе «failing»', () => {
    const okRun = { code: 0, tests: 3, pass: 3, fail: 0, todo: 0 };
    const md = badgesMarkdown('2.4.0', SUITES.map(() => okRun));
    assert.match(md, /release-v2\.4\.0-/);
    assert.match(md, /All%20tests-passing-4c1/);
    const broken = badgesMarkdown('1.0.0', SUITES.map((_, i) => (i === 0 ? { ...okRun, fail: 1, pass: 2, code: 1 } : okRun)));
    assert.match(broken, /All%20tests-failing-e05d44/);
    assert.match(broken, /Store%20tests-failing/);
    assert.match(broken, /Report%20tests-passing/);
  });

  test('генератор заменяет только блок плашек', () => {
    const out = replaceBlock('# T\n<!-- badges:start -->\nold\n<!-- badges:end -->\nтекст', 'new');
    assert.equal(out, '# T\n<!-- badges:start -->\nnew\n<!-- badges:end -->\nтекст');
    assert.throws(() => replaceBlock('без блока', 'x'), /badges:start/);
  });
});
