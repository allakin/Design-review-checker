// Хранилище ревью в chrome.storage.local.
//   reviewIndex     — [{ id, title, author, createdAt, updatedAt, issueCount }]
//   review:<id>     — полный объект ревью вместе с замечаниями и скриншотами
//   activeReviewId  — ревью, в которое попадают новые замечания

const KEY_INDEX = 'reviewIndex';
const KEY_ACTIVE = 'activeReviewId';
const reviewKey = (id) => `review:${id}`;

// Сериализуем записи внутри одного контекста, чтобы параллельные
// read-modify-write не затирали друг друга.
let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export function uid() {
  return crypto.randomUUID();
}

export async function listReviews() {
  const { [KEY_INDEX]: index = [] } = await chrome.storage.local.get(KEY_INDEX);
  return [...index].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getAllReviews() {
  const metas = await listReviews();
  return (await Promise.all(metas.map((m) => getReview(m.id)))).filter(Boolean);
}

export async function getReview(id) {
  if (!id) return null;
  const key = reviewKey(id);
  const { [key]: review } = await chrome.storage.local.get(key);
  return review || null;
}

// Текст для поиска в списке ревью: без скриншотов, чтобы не загружать ревью целиком.
function searchText(review) {
  return [
    review.title,
    review.author,
    review.devTicketUrl,
    review.designTicketUrl,
    ...review.issues.flatMap((i) => [i.title, i.page?.title, i.page?.url]),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
    .slice(0, 4000);
}

function metaOf(review) {
  return {
    id: review.id,
    title: review.title,
    author: review.author || '',
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    issueCount: review.issues.length,
    search: searchText(review),
  };
}

async function writeReview(review, { touch = true } = {}) {
  if (touch) review.updatedAt = Date.now();
  const { [KEY_INDEX]: index = [] } = await chrome.storage.local.get(KEY_INDEX);
  const meta = metaOf(review);
  const i = index.findIndex((r) => r.id === review.id);
  if (i >= 0) index[i] = meta;
  else index.push(meta);
  await chrome.storage.local.set({ [reviewKey(review.id)]: review, [KEY_INDEX]: index });
  return review;
}

// Ревью, созданные до появления поиска, дополняем поисковым текстом (дата изменения не трогается).
export function reindexIfNeeded() {
  return exclusive(async () => {
    const { [KEY_INDEX]: index = [] } = await chrome.storage.local.get(KEY_INDEX);
    const stale = index.filter((m) => m.search === undefined);
    if (!stale.length) return;
    for (const m of stale) {
      const review = await getReview(m.id);
      if (review) Object.assign(m, metaOf(review));
    }
    await chrome.storage.local.set({ [KEY_INDEX]: index });
  });
}

export function createReview({ title, author = '', devTicketUrl = '', designTicketUrl = '' }) {
  return exclusive(async () => {
    const now = Date.now();
    const review = {
      id: uid(),
      title: title.trim() || 'Дизайн-ревью',
      author: author.trim(),
      devTicketUrl,
      designTicketUrl,
      createdAt: now,
      updatedAt: now,
      issues: [],
    };
    await writeReview(review);
    await chrome.storage.local.set({ [KEY_ACTIVE]: review.id });
    return review;
  });
}

// Восстановление ревью из папки на диске (например, после переустановки расширения):
// сохраняется как есть, с исходными датами. Ревью с таким id уже есть — не трогаем, возвращаем false.
export function importReview(review) {
  return exclusive(async () => {
    if (await getReview(review.id)) return false;
    await writeReview(review, { touch: false });
    return true;
  });
}

export function updateReview(id, patch) {
  return exclusive(async () => {
    const review = await getReview(id);
    if (!review) throw new Error('Ревью не найдено');
    Object.assign(review, patch);
    return writeReview(review);
  });
}

export function deleteReview(id) {
  return exclusive(async () => {
    const { [KEY_INDEX]: index = [], [KEY_ACTIVE]: active } = await chrome.storage.local.get([KEY_INDEX, KEY_ACTIVE]);
    await chrome.storage.local.set({ [KEY_INDEX]: index.filter((r) => r.id !== id) });
    await chrome.storage.local.remove(reviewKey(id));
    if (active === id) await chrome.storage.local.remove(KEY_ACTIVE);
  });
}

export async function getActiveReviewId() {
  const { [KEY_ACTIVE]: id } = await chrome.storage.local.get(KEY_ACTIVE);
  return id || null;
}

export async function setActiveReviewId(id) {
  if (id) await chrome.storage.local.set({ [KEY_ACTIVE]: id });
  else await chrome.storage.local.remove(KEY_ACTIVE);
}

export async function getActiveReview() {
  const review = await getReview(await getActiveReviewId());
  return review;
}

// Текущее ревью, а если его нет (восстановили ревью из папки, удалили текущее) — последнее изменённое,
// которое и становится текущим. null — ревью нет совсем.
export async function activeOrLatestReview() {
  const active = await getActiveReview();
  if (active) return active;
  const [latest] = await listReviews();
  if (!latest) return null;
  await setActiveReviewId(latest.id);
  return getReview(latest.id);
}

export function addIssue(reviewId, issue) {
  return exclusive(async () => {
    const review = await getReview(reviewId);
    if (!review) throw new Error('Ревью не найдено — создайте новое в окне расширения');
    const full = { id: uid(), createdAt: Date.now(), ...issue };
    review.issues.push(full);
    await writeReview(review);
    return { issue: full, number: review.issues.length };
  });
}

export function updateIssue(reviewId, issueId, patch) {
  return exclusive(async () => {
    const review = await getReview(reviewId);
    const issue = review?.issues.find((x) => x.id === issueId);
    if (!issue) throw new Error('Замечание не найдено');
    Object.assign(issue, patch, { updatedAt: Date.now() });
    await writeReview(review);
    return issue;
  });
}

export function deleteIssue(reviewId, issueId) {
  return exclusive(async () => {
    const review = await getReview(reviewId);
    if (!review) return;
    review.issues = review.issues.filter((x) => x.id !== issueId);
    await writeReview(review);
  });
}

export function moveIssue(reviewId, issueId, delta) {
  return exclusive(async () => {
    const review = await getReview(reviewId);
    if (!review) return;
    const from = review.issues.findIndex((x) => x.id === issueId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= review.issues.length) return;
    const [item] = review.issues.splice(from, 1);
    review.issues.splice(to, 0, item);
    await writeReview(review);
  });
}

export function onReviewsChanged(callback) {
  const listener = (changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => k === KEY_INDEX || k === KEY_ACTIVE || k.startsWith('review:'))) callback();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
