// Прогоняет наборы тестов и обновляет плашки в README.md между
// <!-- badges:start --> и <!-- badges:end -->. Плашка «passing» появляется только после реального прогона.
// Версия на плашке «release» — последний опубликованный релиз из списка релизов на GitHub;
// если релизов нет или GitHub недоступен — версия из manifest.json.
// Запуск: npm run badges (в CI можно передать GITHUB_TOKEN, чтобы не упереться в лимит запросов API)
import { spawn, execFileSync } from 'node:child_process';
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
  { label: 'Release tests', files: ['tests/unit/changelog.test.js'] },
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

// «owner/repo» из GITHUB_REPOSITORY (CI) или из адреса origin: https://github.com/o/r.git, git@github.com:o/r.git.
export function repoSlug(remote = process.env.GITHUB_REPOSITORY) {
  if (!remote) {
    try {
      remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' });
    } catch {
      return null;
    }
  }
  return remote.trim().match(/^(?:.*github\.com[:/])?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}

// «v1.2.3» / «1.2.3-rc.1» → { version, parts: [1, 2, 3], pre }; не semver → null.
export function parseVersion(tag) {
  const m = String(tag).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  return m && { version: m[0].replace(/^v/, ''), parts: m.slice(1, 4).map(Number), pre: m[4] ?? '' };
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1; // 1.0.0 старше 1.0.0-rc.1
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre, 'en', { numeric: true });
}

// Самый старший релиз из ответа GET /repos/{owner}/{repo}/releases.
// Черновики, пре-релизы и теги не в формате semver пропускаются. Нет подходящих — null.
export function pickLatestRelease(releases) {
  let best = null;
  for (const r of releases ?? []) {
    if (r.draft || r.prerelease) continue;
    const v = parseVersion(r.tag_name);
    if (v && (!best || compareVersions(v, best) > 0)) best = { ...v, url: r.html_url };
  }
  return best && { version: best.version, url: best.url };
}

export async function fetchReleases(repo, { token = process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const releases = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub API: ${res.status} ${res.statusText}`);
    const batch = await res.json();
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

// Версия для плашки: последний релиз с GitHub, иначе — manifest.json.
export async function resolveRelease(fallbackVersion, { repo = repoSlug(), ...opts } = {}) {
  if (!repo) return { version: fallbackVersion, url: '', source: 'manifest.json (не удалось определить репозиторий GitHub)' };
  try {
    const latest = pickLatestRelease(await fetchReleases(repo, opts));
    if (latest) return { ...latest, source: `GitHub Releases (${repo})` };
    return { version: fallbackVersion, url: `https://github.com/${repo}/releases`, source: `manifest.json (в ${repo} нет опубликованных релизов)` };
  } catch (e) {
    return { version: fallbackVersion, url: `https://github.com/${repo}/releases`, source: `manifest.json (${e.message})` };
  }
}

export function badgesMarkdown(version, results, releaseUrl = '') {
  const ok = (r) => r.code === 0 && r.fail === 0 && r.tests > 0;
  const total = results.reduce((n, r) => n + r.tests, 0);
  const allOk = results.every(ok);
  const lines = [
    badge('Browser extension', 'Browser', 'extension', 'e05d44', 'googlechrome', '#установка'),
    badge('Manifest V3', 'Manifest', 'V3', '4285f4', 'googlechrome'),
    badge('Release', 'release', `v${version}`, '2ea44f', 'github', releaseUrl),
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
  const { version: manifestVersion } = JSON.parse(readFileSync(`${ROOT}manifest.json`, 'utf8'));
  const [release, results] = await Promise.all([resolveRelease(manifestVersion), Promise.all(SUITES.map((s) => run(s.files)))]);
  console.log(`Релиз на плашке: v${release.version} — ${release.source}`);
  SUITES.forEach((s, i) => {
    const r = results[i];
    console.log(`${r.fail || r.code ? '✖' : '✔'} ${s.label.padEnd(22)} ${r.pass}/${r.tests - r.todo}${r.todo ? ` (todo: ${r.todo})` : ''}`);
  });
  writeFileSync(README, replaceBlock(readFileSync(README, 'utf8'), badgesMarkdown(release.version, results, release.url)));
  console.log('Плашки в README.md обновлены.');
  if (results.some((r) => r.fail || r.code)) process.exit(1);
}
