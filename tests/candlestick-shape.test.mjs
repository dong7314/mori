import test from 'node:test';
import assert from 'node:assert/strict';
import { cardVisual, stockCandlestickChart } from '../src/card-visuals.mjs';

const attributes = markup => Object.fromEntries([...markup.matchAll(/([\w]+)="([\d.]+)"/g)].map(([, key, value]) => [key, Number(value)]));
const candlesOf = markup => [...markup.matchAll(/<g class="candle candle--(up|down)"><line class="candle-wick" ([^>]+)\/><rect class="candle-body" ([^>]+)\/><\/g>/g)].map(([, direction, wick, body]) => ({ direction, wick: attributes(wick), body: attributes(body) }));
const openY = candle => candle.body.y + (candle.direction === 'up' ? candle.body.height : 0);
const closeY = candle => candle.body.y + (candle.direction === 'down' ? candle.body.height : 0);

test('illustrative candles form unequal rises and pullbacks with a later dominant peak and recovering finish', () => {
  for (const period of ['1일', '1주', '1달']) {
    const candles = candlesOf(stockCandlestickChart(period));
    // Negating SVG y coordinates gives a price-like axis without exposing fixture values.
    const closes = candles.map(candle => -closeY(candle));
    const opening = -openY(candles[0]);
    const closeSpan = Math.max(...closes) - Math.min(...closes);
    const span = Math.max(...candles.map(candle => candle.wick.y2)) - Math.min(...candles.map(candle => candle.wick.y1));
    const earlyPeak = closes.indexOf(Math.max(...closes.slice(0, Math.floor(closes.length * .28))));
    const valleyStart = Math.floor(closes.length * .22);
    const valley = valleyStart + closes.slice(valleyStart, Math.floor(closes.length * .48)).indexOf(Math.min(...closes.slice(valleyStart, Math.floor(closes.length * .48))));
    const peak = closes.indexOf(Math.max(...closes));
    const correction = peak + 1 + closes.slice(peak + 1, -2).indexOf(Math.min(...closes.slice(peak + 1, -2)));
    assert.ok(earlyPeak > 0 && earlyPeak < valley && valley < peak && peak < correction && correction < closes.length - 2, `${period}: all five stages appear in order`);
    assert.ok(peak / closes.length >= .58 && peak / closes.length <= .78, `${period}: the dominant high arrives after the midpoint`);
    const firstRise = closes[earlyPeak] - opening;
    const firstDrop = closes[earlyPeak] - closes[valley];
    const mainRise = closes[peak] - closes[valley];
    const finalDrop = closes[peak] - closes[correction];
    assert.ok(firstRise / closeSpan > .12 && firstRise / closeSpan < .4, `${period}: the opening rise stays modest`);
    assert.ok(firstDrop > firstRise * 1.3 && closes[valley] < opening, `${period}: the first pullback is deeper than the opening rise`);
    assert.ok(mainRise > firstRise * 2 && mainRise > firstDrop * 1.5, `${period}: the central climb is the strongest move`);
    assert.ok(finalDrop > closeSpan * .15 && finalDrop < firstDrop * .9, `${period}: the later correction has a different, shallower amplitude`);
    assert.ok(correction - peak < valley - earlyPeak, `${period}: the later correction is shorter than the first pullback`);
    assert.ok(closes.at(-1) > closes[correction] && closes.at(-1) < closes[peak], `${period}: the finish recovers without inventing another dominant peak`);
    assert.ok((closes[peak] - closes.at(-1)) / closeSpan < .15, `${period}: the recovering finish reaches back toward the high`);
    assert.ok(closeSpan / span >= .75, `${period}: closing prices travel across most of the chart height`);
    for (const [from, to, direction] of [[0, earlyPeak, 'up'], [earlyPeak + 1, valley, 'down'], [valley + 1, peak, 'up'], [peak + 1, correction, 'down'], [correction + 1, candles.length - 1, 'up']]) {
      assert.ok(candles.slice(from, to + 1).some(candle => candle.direction !== direction), `${period}: each larger move retains small countertrend candles`);
    }
  }
});

test('illustrative OHLC geometry stays continuous with varied bodies and enclosing wicks', () => {
  for (const period of ['1일', '1주', '1달']) {
    const candles = candlesOf(stockCandlestickChart(period));
    for (const [index, candle] of candles.entries()) {
      assert.ok(Object.values(candle.body).every(Number.isFinite) && Object.values(candle.wick).every(Number.isFinite));
      assert.ok(candle.body.height > 0 && candle.body.width > 0, 'each body has a readable nonzero size');
      assert.ok(candle.wick.y1 < candle.body.y && candle.wick.y2 > candle.body.y + candle.body.height, 'wicks enclose both ends of the body');
      assert.ok(candle.wick.y1 >= 4 && candle.wick.y2 <= 91, 'price geometry stays inside the detail plot');
      if (index) assert.ok(Math.abs(openY(candle) - closeY(candles[index - 1])) < .03, 'adjacent candles have a continuous open/close');
    }
    const bodySizes = new Set(candles.map(candle => candle.body.height.toFixed(1)));
    const upperWicks = new Set(candles.map(candle => (candle.body.y - candle.wick.y1).toFixed(1)));
    const lowerWicks = new Set(candles.map(candle => (candle.wick.y2 - candle.body.y - candle.body.height).toFixed(1)));
    assert.ok(bodySizes.size >= 6, `${period}: rises and falls have visibly different body sizes`);
    assert.ok(upperWicks.size >= 3 && lowerWicks.size >= 3, `${period}: wick lengths also vary`);
  }
});

test('trading volume decoration stays separated from price geometry and disconnected stock stays empty', () => {
  const preview = cardVisual('stock');
  const candles = candlesOf(preview);
  assert.ok(candles.length >= 28 && candles.length <= 32, 'the compact preview has a dense, legible series');
  const volumes = [...preview.matchAll(/<rect class="candle-volume candle--(?:up|down)" ([^>]+)\/>/g)].map(([, markup]) => attributes(markup));
  assert.equal(volumes.length, candles.length);
  const lowestWick = Math.max(...candles.map(candle => candle.wick.y2));
  const highestWick = Math.min(...candles.map(candle => candle.wick.y1));
  assert.ok(lowestWick - highestWick >= 64, 'the preview makes room for a visibly taller price plot');
  assert.ok(volumes.every(bar => bar.y > lowestWick && bar.y + bar.height <= 120.01));
  assert.match(preview, />예시 시세</);
  assert.doesNotMatch(cardVisual('stock', { isExample: false }), /candle-volume|candle-reference|candle-body/);
});

test('dense candlestick bodies retain horizontal gaps in the preview and every detail range', () => {
  const charts = [cardVisual('stock'), ...['1일', '1주', '1달'].map(stockCandlestickChart)];
  for (const chart of charts) {
    const candles = candlesOf(chart);
    for (let index = 1; index < candles.length; index++) {
      const gap = candles[index].body.x - candles[index - 1].body.x - candles[index - 1].body.width;
      assert.ok(gap > candles[index].body.width * .5, 'bodies remain distinct at the higher density');
    }
  }
  const detailCounts = charts.slice(1).map(chart => candlesOf(chart).length);
  assert.ok(detailCounts.every(count => count >= 30 && count <= 48));
  assert.equal(new Set(detailCounts).size, 3);
});
