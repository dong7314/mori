import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CUSTOM_ICON_GROUPS, CUSTOM_ICONS, CUSTOM_ICON_IDS, normalizeCustomIcon } from '../src/custom-icons.mjs';
import { customPreview, recordsOf } from '../src/experience-library.mjs';
import { cardVisual } from '../src/card-visuals.mjs';

test('every offered custom icon has a unique label and an existing app symbol', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const symbols = new Set([...html.matchAll(/<symbol id="i-([^"]+)"/g)].map(match => match[1]));
  assert.equal(new Set(CUSTOM_ICON_IDS).size, CUSTOM_ICONS.length);
  assert.equal(new Set(CUSTOM_ICONS.map(icon => icon.label)).size, CUSTOM_ICONS.length);
  assert.ok(CUSTOM_ICON_GROUPS.every(group => group.id && group.label && group.icons.length));
  for (const { value, label } of CUSTOM_ICONS) {
    assert.ok(label.trim(), `${value} needs an accessible name`);
    assert.ok(symbols.has(value), `${value} needs a rendered symbol, not an empty preview`);
  }
});

test('all picker choices survive preview, saved result listing and dashboard artwork', () => {
  for (const { value } of CUSTOM_ICONS) {
    const values = { title: '나의 기능', work: '메모 정리', description: '', time: '', repeat: '필요할 때', icon: value };
    const saved = customPreview(values);
    assert.equal(saved.icon, value);
    assert.match(cardVisual('custom', { icon: saved.icon, time: '19:00' }), new RegExp(`href="#i-${value}"`));
    const state = { notes: [], documents: [], customs: [{ ...saved, id: 'custom', result: { at: 1, items: [] } }] };
    assert.equal(recordsOf(state)[0].icon, value);
    assert.equal(values.icon, value);
  }
});

test('existing icon values remain valid and unsupported persisted values use a safe fallback', () => {
  for (const icon of ['spark', 'note', 'leaf', 'news', 'bell', 'compass']) assert.equal(normalizeCustomIcon(icon), icon);
  for (const icon of [undefined, null, '', 'unknown', 'constructor', '__proto__', '"><script>bad()</script>']) {
    assert.equal(normalizeCustomIcon(icon), 'spark');
    const state = { notes: [], documents: [], customs: [{ id: 'invalid', icon, result: { at: 1, items: [] } }] };
    assert.equal(recordsOf(state)[0].icon, 'spark');
  }
});
