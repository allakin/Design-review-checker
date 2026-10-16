// Общие константы. Список критичностей продублирован в content/content.js
// (контент-скрипт не может импортировать ES-модули) — меняйте синхронно.
export const SEVERITIES = [
  { id: 'critical', label: 'Критическая', color: '#c4320a', bg: '#fee4e2' },
  { id: 'high', label: 'Высокая', color: '#d9480f', bg: '#ffecd9' },
  { id: 'medium', label: 'Средняя', color: '#a15c07', bg: '#fef3c7' },
  { id: 'low', label: 'Низкая', color: '#1d5fc4', bg: '#dbeafe' },
];

export const DEFAULT_SEVERITY = 'medium';

export function severityOf(id) {
  return SEVERITIES.find((s) => s.id === id) || SEVERITIES.find((s) => s.id === DEFAULT_SEVERITY);
}
