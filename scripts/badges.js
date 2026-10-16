// Прогоняет наборы тестов и обновляет плашки в README.md между
// <!-- badges:start --> и <!-- badges:end -->. Плашка «passing» появляется только после реального прогона.
// Запуск: npm run badges
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const README = `${ROOT}README.md`;

export const SUITES = [
  { label: 'Store tests', files: ['tests/unit/store.test.js'] },
  { label: 'Report tests', files: ['tests/unit/report.test.js'] },
  { label: 'Folder tests', files: ['tests/unit/folder.test.js'] },
  { label: 'Background tests', files: ['tests/unit/background.test.js'] },
  { label: 'Content script tests', files: ['tests/unit/content.test.js'] },
  { label: 'Utils tests', files: ['tests/unit/constants.test.js', 'tests/unit/url.test.js'] },
  { label: 'Popup tests', files: ['tests/pages/popup.test.js'] },
  { label: 'Pages tests', files: ['tests/pages/review.test.js', 'tests/pages/report-setup.test.js'] },
  { label: 'Integrity tests', files: ['tests/integrity/project.test.js'] },
];

function run(files) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      const num = (name) => Number(out.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0);
      resolve({ code, tests: num('tests'), pass: num('pass'), fail: num('fail'), todo: num('todo') });
    });
  });
}

// shields.io: «-» → «--», «_» → «__», пробелы → %20.
const enc = (s) => encodeURIComponent(String(s).replace(/-/g, '--').replace(/_/g, '__'));
const badge = (alt, label, message, color, logo, link = '') => {
  const img = `![${alt}](https://img.shields.io/badge/${enc(label)}-${enc(message)}-${color}?logo=${logo}&logoColor=white)`;
  return link ? `[${img}](${link})` : img;
};

export function badgesMarkdown(version, results) {
  const ok = (r) => r.code === 0 && r.fail === 0 && r.tests > 0;
  const total = results.reduce((n, r) => n + r.tests, 0);
  const allOk = results.every(ok);
  const lines = [
    badge('Browser extension', 'Browser', 'extension', 'e05d44', 'googlechrome', '#установка'),
    badge('Manifest V3', 'Manifest', 'V3', '4285f4', 'googlechrome'),
    badge('Release', 'release', `v${version}`, '2ea44f', 'github'),
    badge(`All tests: ${total}`, 'All tests', allOk ? 'passing' : 'failing', allOk ? '4c1' : 'e05d44', 'github', '#тесты'),
    ...SUITES.map((s, i) => {
      const r = results[i];
      return badge(`${s.label}: ${r.pass}/${r.tests - r.todo}`, s.label, ok(r) ? 'passing' : 'failing', ok(r) ? '4c1' : 'e05d44', 'github', '#тесты');
    }),
  ];
  return lines.join('\n');
}

export function replaceBlock(readme, block) {
  const start = '<!-- badges:start -->';
  const end = '<!-- badges:end -->';
  const a = readme.indexOf(start);
  const b = readme.indexOf(end);
  if (a < 0 || b < a) throw new Error('В README.md нет блока <!-- badges:start --> … <!-- badges:end -->');
  return `${readme.slice(0, a + start.length)}\n${block}\n${readme.slice(b)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(`${ROOT}manifest.json`, 'utf8'));
  const results = await Promise.all(SUITES.map((s) => run(s.files)));
  SUITES.forEach((s, i) => {
    const r = results[i];
    console.log(`${r.fail || r.code ? '✖' : '✔'} ${s.label.padEnd(22)} ${r.pass}/${r.tests - r.todo}${r.todo ? ` (todo: ${r.todo})` : ''}`);
  });
  writeFileSync(README, replaceBlock(readFileSync(README, 'utf8'), badgesMarkdown(version, results)));
  console.log('Плашки в README.md обновлены.');
  if (results.some((r) => r.fail || r.code)) process.exit(1);
}
