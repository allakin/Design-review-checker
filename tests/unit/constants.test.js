import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEVERITIES, DEFAULT_SEVERITY, severityOf } from '../../lib/constants.js';

test('четыре уровня критичности в порядке убывания', () => {
  assert.deepEqual(
    SEVERITIES.map((s) => s.id),
    ['critical', 'high', 'medium', 'low'],
  );
});

test('у каждого уровня есть подпись и цвета в HEX', () => {
  for (const s of SEVERITIES) {
    assert.ok(s.label.trim(), `пустая подпись у ${s.id}`);
    assert.match(s.color, /^#[0-9a-f]{6}$/i);
    assert.match(s.bg, /^#[0-9a-f]{6}$/i);
  }
});

test('id и подписи уникальны', () => {
  assert.equal(new Set(SEVERITIES.map((s) => s.id)).size, SEVERITIES.length);
  assert.equal(new Set(SEVERITIES.map((s) => s.label)).size, SEVERITIES.length);
});

test('критичность по умолчанию — «Средняя» и она есть в списке', () => {
  assert.equal(DEFAULT_SEVERITY, 'medium');
  assert.ok(SEVERITIES.some((s) => s.id === DEFAULT_SEVERITY));
});

test('severityOf находит уровень по id', () => {
  for (const s of SEVERITIES) assert.equal(severityOf(s.id), s);
});

test('severityOf для неизвестного/пустого id возвращает уровень по умолчанию', () => {
  for (const id of [undefined, null, '', 'blocker', 'CRITICAL', 42]) {
    assert.equal(severityOf(id).id, DEFAULT_SEVERITY, `id=${id}`);
  }
});
