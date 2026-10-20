// Картинки «Визуальные пояснения»: файл → data URL, который хранит store и встраивает отчёт.
// Общий для страницы ревью и формы замечания на сайте (контент-скрипт подключает модуль через import()).

const MAX_IMAGE_SIDE = 2400; // большие картинки уменьшаем: они хранятся в расширении и встраиваются в отчёт

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Файл → data URL PNG/JPEG (только такие отчёт встраивает). Другие форматы (WebP, GIF…) перерисовываем в PNG,
// слишком большие — уменьшаем.
export async function imageFileToDataUrl(file) {
  const src = await readAsDataUrl(file);
  const native = /^data:image\/(png|jpeg);base64,/.test(src);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (native) return src;
    throw new Error(`не удалось прочитать картинку «${file.name || 'без имени'}»`);
  }
  const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  if (native && k === 1) {
    bitmap.close?.();
    return src;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * k));
  canvas.height = Math.max(1, Math.round(bitmap.height * k));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.92);
}

// Файлы → [{ src, name }] для store.addFixImages / нового замечания. Не картинки пропускаются,
// ошибки чтения собираются в failed, чтобы показать их пользователю разом.
export async function readImageFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  const added = [];
  const failed = [];
  for (const file of images) {
    try {
      added.push({ src: await imageFileToDataUrl(file), name: file.name || '' });
    } catch (e) {
      failed.push(e.message);
    }
  }
  return { added, failed, skipped: files.length - images.length };
}
