import test from 'node:test';
import assert from 'node:assert/strict';
import { cardVisual, featureArt, stockCandlestickChart } from '../src/card-visuals.mjs';

const candleGeometry = mark => [...mark.matchAll(/<g class="candle candle--(up|down)"><line class="candle-wick" ([^>]+)\/><rect class="candle-body" ([^>]+)\/><\/g>/g)].map(([, direction, wick, body]) => {
  const attributes = markup => Object.fromEntries([...markup.matchAll(/([\w]+)="([\d.]+)"/g)].map(([, name, value]) => [name, Number(value)]));
  return { direction, wick: attributes(wick), body: attributes(body) };
});

test('parking uses the saved floor and bay, escapes markup and abbreviates only the decorative value', () => {
  const mark = cardVisual('parking', { floor: '지하 3층', spot: 'B16' });
  assert.match(mark, /지하 3층/);
  assert.match(mark, />B16</);
  assert.match(mark, /aria-hidden="true"/);
  assert.match(mark, /scene-pin/);
  assert.doesNotMatch(cardVisual('parking'), /class="scene-pin"/);
  const untrusted = cardVisual('parking', { floor: '<script>', spot: '"<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(untrusted, /<script>|src=x|onerror=/);
  assert.doesNotMatch(untrusted, /<img /);
  assert.match(untrusted, /&lt;/);
  assert.match(untrusted, /…/);
});

test('news count appears only when supplied from actual articles, with loading and failure taking priority', () => {
  assert.match(cardVisual('news', { articleCount: 3 }), />3개 소식</);
  assert.match(cardVisual('news'), />브리핑</);
  assert.match(cardVisual('news', { articleCount: -1 }), />브리핑</);
  assert.match(cardVisual('news', { status: 'loading', articleCount: 3 }), />수집 중</);
  assert.match(cardVisual('news', { status: 'failed' }), />다시 보기</);
  assert.match(cardVisual('news', { status: 'scheduled', articleCount: 3 }), />예약됨</);
  assert.doesNotMatch(cardVisual('news', { status: 'scheduled', articleCount: 3 }), />3개 소식</);
  assert.doesNotMatch(cardVisual('news', { status: 'loading', articleCount: 3 }), /scene-image-shape/);
});

test('schedule and timer accept real date/time fields and fall back for invalid values', () => {
  const schedule = cardVisual('schedule', { month: 10, day: 21, time: '14:30' });
  assert.match(schedule, />10월</);
  assert.match(schedule, />21</);
  assert.match(schedule, />14:30</);
  assert.match(cardVisual('schedule', { month: 14, day: 21 }), />예정 없음</);
  assert.match(cardVisual('reminder', { time: '08:30' }), />08:30</);
  assert.match(cardVisual('reminder', { time: '25:99' }), />알림</);
  const timer = cardVisual('reminder', { time: '08:30', remaining: '100000:01', fraction: Infinity, reminderId: '\"><script>' });
  assert.match(timer, /is-extra-long/);
  assert.doesNotMatch(timer, /<script>|stroke-dashoffset="(?:NaN|Infinity)/);
});

test('unknown icon/kind values cannot inject markup and stock art identifies example data', () => {
  const mark = cardVisual('custom', { icon: '\"><script>bad()</script>', time: '19:00' });
  assert.match(mark, /href="#i-repeat"/);
  assert.doesNotMatch(mark, /<script>/);
  assert.match(mark, />19:00</);
  assert.match(cardVisual('stock'), />예시 시세</);
  assert.equal(cardVisual('unknown'), '');
  assert.equal(featureArt('__proto__'), '');
  assert.equal(featureArt('\"><script>bad()</script>'), '');
  for (const kind of ['parking', 'news', 'stock', 'note', 'schedule', 'reminder']) {
    assert.match(featureArt(kind), new RegExp(`feature-scene--${kind}`));
    assert.match(featureArt(kind), /aria-hidden="true"/);
    assert.doesNotMatch(featureArt(kind), /<img|<image|foreignObject|\bid=|url\(#|src=|https?:/);
  }
  assert.match(featureArt('schedule', { month: 10, day: 21 }), />21</);
  assert.doesNotMatch(featureArt('schedule', { month: '<script>', day: 21 }), /<script>|>21</);
});

test('stock preview uses rising/falling candles with high/low wicks and keeps disconnected data empty', () => {
  const preview = cardVisual('stock', { symbol: '삼성전자' });
  const candles = candleGeometry(preview);
  assert.ok(candles.length >= 28 && candles.length <= 32);
  assert.deepEqual(new Set(candles.map(candle => candle.direction)), new Set(['up', 'down']));
  for (const { wick, body } of candles) {
    assert.equal(wick.x1, wick.x2);
    assert.ok(Math.abs(wick.x1 - (body.x + body.width / 2)) < .02);
    assert.ok(wick.y1 < body.y, 'high wick extends above the open/close body');
    assert.ok(wick.y2 > body.y + body.height, 'low wick extends below the open/close body');
    assert.ok(body.height > 0 && body.width > 0);
    assert.ok(wick.y1 >= 43 && wick.y2 <= 107);
  }
  assert.doesNotMatch(preview, /scene-chart-line|scene-chart-area/);
  const disconnected = cardVisual('stock', { isExample: false });
  assert.equal(candleGeometry(disconnected).length, 0);
  assert.match(disconnected, />시세 연결 후 표시</);
  assert.doesNotMatch(disconnected, /예시 시세/);
});

test('detail candles have distinct period examples, bounded geometry and safe fallback', () => {
  const periods = ['1일', '1주', '1달'].map(period => stockCandlestickChart(period));
  assert.equal(new Set(periods).size, 3);
  assert.equal(new Set(periods.map(chart => candleGeometry(chart).length)).size, 3);
  for (const chart of periods) {
    assert.match(chart, /class="sparkline candle-chart"/);
    assert.match(chart, /viewBox="0 0 300 110" aria-hidden="true" focusable="false"/);
    assert.doesNotMatch(chart, /chart-line|chart-fill|<image|<img|\bid=|NaN|Infinity|https?:/);
    for (const { wick, body } of candleGeometry(chart)) {
      assert.ok(body.x >= 0 && body.x + body.width <= 300);
      assert.ok(wick.y1 >= 4 && wick.y2 <= 91);
      assert.ok(wick.y1 < body.y && wick.y2 > body.y + body.height);
    }
  }
  assert.equal(stockCandlestickChart(), periods[0]);
  assert.equal(stockCandlestickChart('__proto__'), periods[0]);
  assert.equal(stockCandlestickChart('\"><script>bad()</script>'), periods[0]);
});
