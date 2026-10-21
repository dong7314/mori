import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverScrollAreas, scrollbarGeometry, scrollOffsetForThumb } from '../src/overlay-scrollbars.mjs';

test('unnamed detail pages, dialogs and nested lists are discovered before they overflow', () => {
  const area = overflowY => ({ namespaceURI: 'http://www.w3.org/1999/xhtml', closest: () => null, overflowY });
  const detail = area('auto'), dialog = area('scroll'), nested = area('overlay');
  const clippedArt = area('hidden'), ordinaryText = area('visible');
  const indicator = { ...area('auto'), closest: () => ({}) };
  const svg = { ...area('auto'), namespaceURI: 'http://www.w3.org/2000/svg' };
  const elements = [detail, dialog, nested, clippedArt, ordinaryText, indicator, svg];
  const doc = { querySelectorAll: () => elements, defaultView: { getComputedStyle: el => el } };
  assert.deepEqual(discoverScrollAreas(doc), [detail, dialog, nested]);
  // A responsive/inline style change and a newly inserted dialog need no IDs
  // or selector registry updates. An area that stops scrolling is removed.
  dialog.overflowY = 'hidden'; ordinaryText.overflowY = 'auto';
  const newDialog = area('auto'); elements.push(newDialog);
  assert.deepEqual(discoverScrollAreas(doc), [detail, nested, ordinaryText, newDialog]);
});

test('short content and a closed panel never expose an unusable scrollbar', () => {
  assert.equal(scrollbarGeometry(200, 200, 0, 188).visible, false);
  assert.equal(scrollbarGeometry(200, 140, 0, 188).visible, false);
  assert.equal(scrollbarGeometry(0, 140, 0, 0).visible, false);
});

test('a thumb reaches both ends and overscroll never moves it beyond the track', () => {
  const middle = scrollbarGeometry(100, 400, 150, 100);
  assert.equal(middle.length, 25);
  assert.equal(middle.position, 37.5);
  assert.equal(scrollbarGeometry(100, 400, -80, 100).position, 0);
  assert.equal(scrollbarGeometry(100, 400, 500, 100).position, 75);
  assert.equal(scrollOffsetForThumb(0, middle), 0);
  assert.equal(scrollOffsetForThumb(75, middle), 300);
});

test('very long documents retain a usable thumb and dragging accounts for its minimum size', () => {
  const geometry = scrollbarGeometry(100, 10000, 4950, 100);
  assert.equal(geometry.length, 24);
  assert.equal(geometry.position, 38);
  assert.equal(scrollOffsetForThumb(38, geometry), 4950);
  assert.equal(scrollOffsetForThumb(1000, geometry), 9900);
});

test('a tiny viewport stays finite and resizing preserves the proportional reading position', () => {
  const tiny = scrollbarGeometry(12, 500, 200, 6);
  assert.equal(tiny.length, 6);
  assert.equal(tiny.position, 0);
  assert.equal(scrollOffsetForThumb(6, tiny), 0);
  const resized = scrollbarGeometry(200, 1000, 400, 188);
  assert.equal(scrollOffsetForThumb(resized.position, resized), 400);
});
