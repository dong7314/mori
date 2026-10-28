import { esc } from './experience.mjs';
import { CUSTOM_ICON_IDS } from './custom-icons.mjs';

const ICONS = new Set([...CUSTOM_ICON_IDS, 'repeat', 'check']);
const KINDS = new Set(['parking', 'news', 'stock', 'note', 'schedule', 'reminder']);
const icon = name => `<svg class="icon" focusable="false"><use href="#i-${ICONS.has(name) ? name : 'repeat'}"/></svg>`;
const compact = (value, limit, fallback = '') => {
  const text = Array.from(String(value ?? '').trim().replace(/\s+/g, ' '));
  return esc(text.length > limit ? `${text.slice(0, limit - 1).join('')}…` : text.join('') || fallback);
};
const clock = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : '';
const countdown = value => typeof value === 'string' && /^\d{2,6}:[0-5]\d$/.test(value) ? value : '';
const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : null;
const text = (x, y, content, cls = 'scene-label', attributes = '') => `<text x="${x}" y="${y}" class="${cls}"${attributes ? ` ${attributes}` : ''}>${content}</text>`;
const paper = '<rect class="scene-back" x="24" y="8" width="145" height="125" rx="13"/><rect class="scene-paper" x="12" y="14" width="145" height="123" rx="12"/>';

function parkingScene(p) {
  const hasRecord = Boolean(String(p.spot ?? '').trim());
  const longSpot = Array.from(String(p.spot ?? '').trim()).length >= 4;
  const bays = [21, 44, 67, 98, 121, 144].map(x => `<path class="parking-bay" d="M${x} 48v24h17V48M${x} 121V99h17v22"/>`).join('');
  // A schematic location memo, not a surveyed floor plan or directions.
  return `<rect class="scene-map-ground parking-ground" x="7" y="12" width="166" height="121" rx="17"/>
    <path class="parking-boundary" d="M18 43h144M18 125h144"/>
    <rect class="parking-aisle" x="15" y="76" width="150" height="20" rx="5"/>
    <path class="parking-lane" d="M21 86h94M148 86h12"/>
    ${bays}
    <rect class="parking-column" x="86" y="52" width="6" height="14" rx="2"/>
    <rect class="parking-column" x="86" y="104" width="6" height="13" rx="2"/>
    <g class="parking-vehicle parking-vehicle--quiet">
      <rect x="48" y="50" width="10" height="19" rx="3.5"/>
      <path class="parking-window" d="M50 54h6l.6 4h-7.2ZM50 65h6l.4-2h-6.8Z"/>
    </g>
    <g class="parking-vehicle parking-vehicle--quiet parking-vehicle--distant">
      <rect x="25" y="101" width="10" height="18" rx="3.5"/>
      <path class="parking-window" d="M27 105h6l.6 4h-7.2Z"/>
    </g>
    <rect class="parking-floor-pill" x="17" y="20" width="65" height="18" rx="9"/>
    ${text(25, 32, compact(p.floor, 6, '주차 위치'), 'scene-label scene-medium parking-floor-text')}
    ${hasRecord ? `<rect class="parking-selected-bay" x="119" y="97" width="22" height="27" rx="5"/>
    <g class="parking-vehicle parking-vehicle--saved">
      <path class="parking-car-wheels" d="M123 105v4m14-4v4m-14 5v4m14-4v4"/>
      <rect x="124" y="101" width="12" height="20" rx="4"/>
      <path class="parking-window" d="M126 105h8l.5 4h-9ZM126 117h8l.5-3h-9Z"/>
      <path class="parking-car-roof" d="M125.5 110h9v3h-9Z"/>
      <path class="parking-headlights" d="M126 102h2m4 0h2"/>
    </g>
    <path class="scene-pin parking-pin" d="M130 96c-2.6-3.4-8-8.2-8-13a8 8 0 0 1 16 0c0 4.8-5.4 9.6-8 13Z"/>
    <circle class="scene-pin-center parking-pin-center" cx="130" cy="82.5" r="2.8"/>
    <rect class="scene-position-label parking-position-label" x="110" y="19" width="53" height="20" rx="10"/>
    ${text(136.5, 33, compact(p.spot, 4, '위치'), `scene-position-text${longSpot ? ' is-long' : ''}`, 'text-anchor="middle"')}` : ''}
    ${text(20, 131, '위치 메모', 'scene-tiny parking-caption')}`;
}

function newsScene(p) {
  const count = whole(p.articleCount, 0, 999);
  const status = ['loading', 'failed', 'scheduled'].includes(p.status) ? p.status : 'ready';
  const ready = status === 'ready';
  const caption = ({ loading: '수집 중', failed: '다시 보기', scheduled: '예약됨' })[status] || (count !== null && count > 0 ? `${count}개 소식` : '브리핑');
  const lead = ready
    ? '<rect class="scene-accent-soft news-lead-image" x="25" y="52" width="46" height="33" rx="5"/><circle class="scene-accent-fill" cx="59" cy="61" r="5"/><path class="scene-image-shape" d="m27 82 13-16 11 10 8-7 10 13Z"/><path class="scene-heading-rule" d="M81 57h61M81 64h48"/><path class="scene-rule" d="M81 75h54M81 82h40"/><path class="news-body-rule" d="M25 97h48M25 104h46M25 111h34M93 97h49M93 104h47M93 111h36"/><path class="news-column-divider" d="M83 94v19"/>'
    : `<rect class="scene-soft" x="25" y="52" width="46" height="33" rx="5"/><path class="scene-rule scene-rule--quiet" d="M81 57h61M81 66h48M25 99h117M25 109h85"/>${text(81, 84, status === 'failed' ? '연결 확인' : status === 'scheduled' ? '수집 예정' : '준비하고 있어요', 'scene-tiny')}`;
  return `${paper}${text(25, 34, compact(p.topic, 9, '뉴스 브리핑'), 'scene-heading')}
    <circle class="${status === 'failed' ? 'scene-warning-fill' : 'scene-accent-fill'}" cx="144" cy="30" r="3"/>
    <path class="scene-divider news-masthead-rule" d="M25 42h119M25 46h119"/>${lead}
    ${text(25, 128, caption, 'scene-label scene-medium')}
    <path class="scene-bookmark" d="M137 119h7v10l-3.5-2-3.5 2Z"/>`;
}

// Normalized, illustrative OHLC values. These are not a quote feed or a price history.
const CANDLE_EXAMPLES = Object.freeze(Object.fromEntries([
  ['1일', [52, 56, 54, 60, 59, 63, 57, 50, 53, 44, 39, 45, 43, 52, 61, 57, 68, 74, 71, 84, 91, 87, 80, 83, 73, 78, 76, 82, 79, 88]],
  ['1주', [52, 56, 54, 59, 57, 62, 64, 58, 53, 55, 46, 41, 44, 36, 42, 40, 50, 58, 55, 67, 73, 70, 83, 88, 95, 89, 82, 86, 78, 75, 73, 79, 76, 84, 88, 91]],
  ['1달', [52, 55, 53, 59, 57, 62, 60, 65, 61, 56, 58, 49, 43, 46, 39, 34, 40, 37, 46, 53, 50, 62, 68, 64, 76, 81, 77, 89, 86, 98, 93, 87, 90, 82, 77, 80, 74, 79, 76, 85, 90, 94]],
].map(([period, closes]) => {
  let open = 50;
  const candles = closes.map((close, index) => {
    const candle = Object.freeze([
      open,
      Math.max(open, close) + 2 + index % 4,
      Math.min(open, close) - 3 - index * 3 % 4,
      close,
    ]);
    open = close;
    return candle;
  });
  return [period, Object.freeze(candles)];
})));
const candlePeriod = period => Object.hasOwn(CANDLE_EXAMPLES, period) ? period : '1일';
const coordinate = value => Number(value.toFixed(2));

function candlesticks(period, { x, y, width, height, volumeY, volumeHeight = 0 }) {
  const candles = CANDLE_EXAMPLES[candlePeriod(period)];
  const low = Math.min(...candles.map(candle => candle[2]));
  const high = Math.max(...candles.map(candle => candle[1]));
  const scale = value => coordinate(y + height * (high - value) / (high - low));
  const step = width / candles.length;
  const bodyWidth = coordinate(step * .6);
  const baseline = `<path class="candle-reference" d="M${x} ${scale(candles[0][0])}H${coordinate(x + width)}"/>`;
  const volumes = volumeHeight > 0 && Number.isFinite(volumeY)
    ? candles.map(([open, peak, trough, close], index) => {
      const center = coordinate(x + step * (index + .5));
      const barHeight = coordinate(volumeHeight * Math.min(1, .2 + (peak - trough + Math.abs(close - open)) / (high - low)));
      return `<rect class="candle-volume candle--${close >= open ? 'up' : 'down'}" x="${coordinate(center - bodyWidth / 2)}" y="${coordinate(volumeY + volumeHeight - barHeight)}" width="${bodyWidth}" height="${barHeight}" rx=".35"/>`;
    }).join('')
    : '';
  return baseline + candles.map(([open, peak, trough, close], index) => {
    const center = coordinate(x + step * (index + .5));
    const top = scale(Math.max(open, close));
    const bodyHeight = coordinate(Math.abs(scale(open) - scale(close)));
    const direction = close >= open ? 'up' : 'down';
    return `<g class="candle candle--${direction}"><line class="candle-wick" x1="${center}" y1="${scale(peak)}" x2="${center}" y2="${scale(trough)}"/><rect class="candle-body" x="${coordinate(center - bodyWidth / 2)}" y="${top}" width="${bodyWidth}" height="${bodyHeight}" rx=".35"/></g>`;
  }).join('') + volumes;
}

export function stockCandlestickChart(period = '1일') {
  const range = candlePeriod(period);
  return `<svg class="sparkline candle-chart" viewBox="0 0 300 110" aria-hidden="true" focusable="false" data-period="${range}"><path class="candle-chart-grid" d="M0 7H300M0 35H300M0 63H300M0 91H300"/>${candlesticks(range, { x: 0, y: 4, width: 300, height: 87, volumeY: 98, volumeHeight: 9 })}</svg>`;
}

function stockScene(p) {
  const example = p.isExample !== false;
  return `<rect class="scene-paper" x="8" y="9" width="164" height="130" rx="14"/>
    ${text(21, 30, compact(p.symbol, 8, '관심 주가'), 'scene-heading')}
    <rect class="scene-stock-badge" x="134" y="18" width="26" height="16" rx="7"/>
    ${text(147, 29, example ? '예시' : '시세', 'scene-tiny', 'text-anchor="middle"')}
    <path class="scene-chart-grid" d="M22 45h136M22 66h136M22 87h136M22 108h136"/>
    ${example ? candlesticks('1일', { x: 22, y: 43, width: 136, height: 64, volumeY: 112, volumeHeight: 8 }) : ''}
    ${text(22, 131, example ? '예시 시세' : '시세 연결 후 표시', 'scene-tiny')}
    ${example ? text(157, 131, '1일', 'scene-stock-period', 'text-anchor="end"') : ''}`;
}

function noteScene(p) {
  const count = whole(p.count, 0, 999);
  const hasNote = Boolean(String(p.title ?? '').trim());
  return `<rect class="planning-note-shadow" x="34" y="22" width="113" height="111" rx="9" transform="rotate(5 90 77)"/>
    <path class="planning-notebook" d="M36 15h94l17 17v94a8 8 0 0 1-8 8H36a8 8 0 0 1-8-8V23a8 8 0 0 1 8-8Z"/>
    <path class="planning-note-spine" d="M41 16v117"/>
    <path class="planning-note-fold" d="M130 15v12a5 5 0 0 0 5 5h12"/>
    <path class="planning-note-page-edge" d="M45 130h85"/>
    <path class="planning-note-binding" d="M25 34h11M25 57h11M25 80h11M25 103h11M25 124h11"/>
    ${text(51, 36, '메모', 'planning-note-label')}
    ${text(51, 59, compact(p.title, 8, '새 메모'), 'planning-note-title')}
    <path class="planning-note-rule" d="M51 74h76M51 87h68M51 100h47"/>
    ${text(51, 121, count !== null ? `${count}개 메모` : hasNote ? '저장한 기록' : '아직 비어 있어요', 'planning-note-count')}
    <g class="planning-pencil" transform="rotate(31 141 104)">
      <rect class="planning-pencil-body" x="136" y="73" width="10" height="49" rx="3"/>
      <path class="planning-pencil-highlight" d="M139 80v36"/>
      <path class="planning-pencil-tip" d="m136 120 5 12 5-12Z"/>
      <path class="planning-pencil-point" d="m139 128 2 4 2-4Z"/>
      <rect class="planning-pencil-ferrule" x="136" y="79" width="10" height="4" rx=".6"/>
      <path class="planning-pencil-cap" d="M136 80h10"/>
    </g>`;
}

function scheduleScene(p) {
  const month = whole(p.month, 1, 12), day = whole(p.day, 1, 31), at = clock(p.time);
  const hasDate = month !== null && day !== null;
  // Without a year, the small grid is a neutral calendar cue, not a fabricated
  // weekday layout. Only the supplied date and time carry actual event data.
  const cells = Array.from({ length: 12 }, (_, i) => `<rect class="planning-calendar-cell" x="${106 + i % 4 * 11}" y="${56 + Math.floor(i / 4) * 13}" width="6" height="6" rx="2"/>`).join('');
  return `<rect class="planning-calendar-shadow" x="24" y="30" width="140" height="104" rx="16"/>
    <path class="planning-calendar-page-edge" d="M31 134h119"/>
    <rect class="planning-calendar" x="17" y="21" width="145" height="109" rx="15"/>
    <path class="planning-calendar-header" d="M32 21h115a15 15 0 0 1 15 15v8H17v-8a15 15 0 0 1 15-15Z"/>
    <path class="planning-calendar-binding" d="M48 13v17M131 13v17"/>
    ${text(30, 39, hasDate ? `${month}월` : '스케줄', 'planning-calendar-month')}
    <rect class="planning-calendar-date-ground" x="28" y="51" width="53" height="44" rx="9"/>
    ${hasDate ? text(54, 90, String(day), 'planning-calendar-date', 'text-anchor="middle"') : '<path class="planning-calendar-empty" d="M39 75h31"/>'}
    ${cells}<path class="planning-calendar-divider" d="M30 101h119"/>
    <circle class="planning-calendar-clock" cx="36" cy="116" r="5"/>
    <path class="planning-calendar-clock" d="M36 113v3l2 1"/>
    ${text(48, 120, at || '예정 없음', 'planning-calendar-time')}`;
}

function reminderScene(p) {
  const at = clock(p.time), left = countdown(p.remaining);
  const fraction = Number.isFinite(p.fraction) ? Math.max(0, Math.min(1, p.fraction)) : null;
  const id = typeof p.reminderId === 'string' && p.reminderId.length <= 128 ? esc(p.reminderId) : '';
  return `<path class="reminder-clock-legs" d="m65 110-5 9m55-9 5 9"/>
    <path class="reminder-bell-brackets" d="m66 31 7 10m41-10-7 10"/>
    <g class="reminder-clock-bell" transform="rotate(-24 62 30)">
      <path class="reminder-bell-dome" d="M47 31a15 10 0 0 1 30 0Z"/>
    </g>
    <g class="reminder-clock-bell" transform="rotate(24 118 30)">
      <path class="reminder-bell-dome" d="M103 31a15 10 0 0 1 30 0Z"/>
    </g>
    <circle class="reminder-dial-ground" cx="90" cy="73" r="44"/>
    <circle class="reminder-dial-face" cx="90" cy="73" r="40"/>
    <circle class="scene-timer-track" cx="90" cy="73" r="35"/>
    ${fraction !== null ? `<circle class="scene-timer-progress" cx="90" cy="73" r="35" pathLength="100" transform="rotate(-90 90 73)" stroke-dasharray="100" stroke-dashoffset="${100 * (1 - fraction)}"${id ? ` data-timer-preview="${id}"` : ''}/>` : ''}
    ${text(90, 77, left || at || '알림', left || at ? `scene-timer-value${left.length > 5 ? ' is-long' : ''}${left.length > 7 ? ' is-extra-long' : ''}` : 'reminder-empty-title', `text-anchor="middle"${id && left ? ` data-countdown="${id}"` : ''}`)}
    ${text(90, 92, left ? '남은 시간' : at ? '목표 시각' : '시간 설정', 'scene-timer-caption', 'text-anchor="middle"')}
    ${at ? text(90, 135, `${at} 알림`, 'reminder-time-label', 'text-anchor="middle"') : ''}`;
}

const SCENES = Object.freeze({ parking: parkingScene, news: newsScene, stock: stockScene, note: noteScene, schedule: scheduleScene, reminder: reminderScene });

// Reusable miniature feature screens. No defs/IDs, external URLs, foreignObject,
// or user-generated SVG paths: repeated cards cannot collide or inject markup.
export function featureArt(kind, params = {}) {
  if (!KINDS.has(kind)) return '';
  return `<span class="feature-art feature-art--${kind}" aria-hidden="true"><svg class="feature-scene feature-scene--${kind}" viewBox="0 0 180 144" focusable="false">${SCENES[kind](params)}</svg></span>`;
}

export function cardVisual(kind, params = {}) {
  if (KINDS.has(kind)) return `<span class="card-visual card-visual--${kind}" data-card-part="art" aria-hidden="true">${featureArt(kind, params)}</span>`;
  if (kind === 'custom') return `<span class="card-visual card-visual--custom" data-card-part="art" aria-hidden="true"><span class="card-visual__symbol">${icon(params.icon)}</span><span class="card-visual__caption">${clock(params.time) || '반복 요청'}</span></span>`;
  return '';
}
