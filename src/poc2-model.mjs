export const TASK_STATUS_LABELS = Object.freeze({ waiting: '확인 필요', collecting: '모으는 중', ready: '준비 완료' });
export const DEMO_DATE = '2026-11-24';
export const STORAGE_KEY = 'mori.poc2.v1';

const STATUSES = new Set(['waiting', 'collecting', 'ready']);
const ICONS = new Set(['car', 'house', 'case', 'file']);
const KINDS = new Set(['note', 'answer']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function instant(now = Date) {
  const date = now instanceof Date ? now : typeof now === 'function' ? new now() : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError('유효한 날짜가 필요합니다.');
  return date.toISOString();
}

function id(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function isInstant(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : '';
}

function iconFor(value) {
  if (/정비|자동차|차량|차에서|타이어/.test(value)) return 'car';
  if (/집주인|수리|집에서|이사|누수/.test(value)) return 'house';
  if (/여행|짐|출장/.test(value)) return 'case';
  return 'file';
}

export function createDemoState() {
  return {
    tasks: [
      {
        id: 'garage',
        title: '정비소에 보여줄 기록',
        brief: '토요일 정비소에 가져갈 증상 기록을 준비해 주세요. 언제, 어떤 상황에서 소리가 났는지 제가 남긴 내용만 모아 주세요.',
        due: '2026-11-28',
        status: 'waiting',
        icon: 'car',
        observations: [
          { id: 'garage-note-1', text: '비가 온 날 뒷좌석 쪽에서 덜컹거리는 소리가 났어요.', at: '2026-11-22T09:20:00+09:00', kind: 'note' },
          { id: 'garage-note-2', text: '오늘은 방지턱을 넘을 때 뒤쪽에서 같은 소리가 났어요.', at: '2026-11-23T18:40:00+09:00', kind: 'note' },
        ],
        question: '두 번 다 방지턱을 넘을 때였나요?',
        completedAt: null,
        createdAt: '2026-11-21T10:00:00+09:00',
      },
      {
        id: 'home',
        title: '집주인에게 보낼 수리 목록',
        brief: '집에서 고칠 부분을 발견할 때마다 남길게요. 위치와 증상을 정리해서 집주인에게 전달할 수 있게 모아 주세요.',
        due: '2026-11-30',
        status: 'collecting',
        icon: 'house',
        observations: [
          { id: 'home-note-1', text: '주방 싱크대 아래에서 물이 조금씩 떨어져요. 설거지를 한 뒤에 확인했어요.', at: '2026-11-23T20:10:00+09:00', kind: 'note' },
        ],
        question: null,
        completedAt: null,
        createdAt: '2026-11-23T20:00:00+09:00',
      },
      {
        id: 'weekend',
        title: '주말 여행 준비 목록',
        brief: '하룻밤 여행에 가져갈 물건을 빠뜨리지 않게 제가 적어 둔 준비물을 한곳에 정리해 주세요.',
        due: '2026-11-22',
        status: 'ready',
        icon: 'case',
        observations: [
          { id: 'weekend-note-1', text: '충전기, 보조배터리, 세면도구를 챙기기.', at: '2026-11-20T19:00:00+09:00', kind: 'note' },
          { id: 'weekend-note-2', text: '숙소에서 신을 양말과 가벼운 겉옷도 필요해요.', at: '2026-11-21T12:10:00+09:00', kind: 'note' },
        ],
        question: null,
        completedAt: '2026-11-21T20:00:00+09:00',
        createdAt: '2026-11-20T18:50:00+09:00',
      },
    ],
    notes: [
      { id: 'note-1', text: '다음에 장 볼 때 주방 수세미 사기.', createdAt: '2026-11-24T08:30:00+09:00' },
      { id: 'note-2', text: '일요일에 읽은 책, 마지막 문장이 좋았어요. 나중에 다시 찾아보기.', createdAt: '2026-11-22T21:00:00+09:00' },
    ],
  };
}

function validObservation(value) {
  return value && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.text === 'string' && value.text.trim().length > 0 &&
    isInstant(value.at) && KINDS.has(value.kind);
}

function validTask(value) {
  return value && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.title === 'string' && value.title.trim().length > 0 &&
    typeof value.brief === 'string' && (value.due === '' || Boolean(day(value.due))) &&
    STATUSES.has(value.status) && ICONS.has(value.icon) &&
    Array.isArray(value.observations) && value.observations.every(validObservation) &&
    (value.question === null || (typeof value.question === 'string' && value.question.trim().length > 0)) &&
    (value.completedAt === null || isInstant(value.completedAt)) && isInstant(value.createdAt);
}

function validNote(value) {
  return value && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.text === 'string' && value.text.trim().length > 0 && isInstant(value.createdAt);
}

function validState(value) {
  return value && Array.isArray(value.tasks) && value.tasks.every(validTask) &&
    Array.isArray(value.notes) && value.notes.every(validNote) &&
    new Set(value.tasks.map(task => task.id)).size === value.tasks.length &&
    new Set(value.notes.map(note => note.id)).size === value.notes.length;
}

export function loadState(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return createDemoState();
    const value = JSON.parse(raw);
    return validState(value) ? value : createDemoState();
  } catch {
    return createDemoState();
  }
}

export function saveState(storage, state) {
  try {
    if (!storage || typeof storage.setItem !== 'function' || !validState(state)) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function createTask({ title, brief, due } = {}, now = Date) {
  const taskTitle = text(title) || '새로 맡긴 일';
  const taskBrief = text(brief);
  return {
    id: id('task'),
    title: taskTitle,
    brief: taskBrief,
    due: day(due),
    status: 'collecting',
    icon: iconFor(`${taskTitle} ${taskBrief}`),
    observations: [],
    question: null,
    completedAt: null,
    createdAt: instant(now),
  };
}

export function addObservation(task, value, now = Date) {
  const observation = text(value);
  if (!observation) return task;
  return {
    ...task,
    status: task.question ? 'waiting' : 'collecting',
    completedAt: null,
    observations: [...task.observations, { id: id('observation'), text: observation, at: instant(now), kind: 'note' }],
  };
}

export function answerQuestion(task, value, now = Date) {
  const answer = text(value);
  if (!answer || !task.question) return task;
  return {
    ...task,
    status: 'collecting',
    question: null,
    completedAt: null,
    observations: [...task.observations, { id: id('answer'), text: `질문: ${task.question}\n답변: ${answer}`, at: instant(now), kind: 'answer' }],
  };
}

export function completeTask(task, now = Date) {
  return { ...task, status: 'ready', question: null, completedAt: instant(now) };
}

export function createNote(value, now = Date) {
  const body = text(value);
  return body ? { id: id('note'), text: body, createdAt: instant(now) } : null;
}

export function formatDay(value) {
  if (!value) return '날짜 미정';
  const dateOnly = day(value);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !dateOnly) return '날짜 미정';
  const date = new Date(dateOnly ? `${dateOnly}T00:00:00.000Z` : value);
  if (!Number.isFinite(date.getTime())) return '날짜 미정';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'long', day: 'numeric', timeZone: dateOnly ? 'UTC' : 'Asia/Seoul',
  }).format(date);
}

export function documentText(task) {
  const lines = [
    task.title,
    '────────────────────────',
    task.brief || '사용자가 남긴 기록을 모았습니다.',
    '',
    `준비할 날짜: ${formatDay(task.due)}`,
    `상태: ${task.status === 'ready' ? '기록 정리 완료' : '정리 중인 초안'}`,
    '',
    '남긴 기록',
  ];
  if (!task.observations.length) lines.push('아직 남긴 기록이 없습니다.');
  for (const observation of task.observations) {
    lines.push(`- ${formatDay(observation.at)} · ${observation.kind === 'answer' ? '추가로 확인한 내용' : '관찰 기록'}`);
    lines.push(`  ${observation.text}`, '');
  }
  if (task.question) lines.push('아직 확인할 내용', task.question, '');
  if (task.completedAt) lines.push(`정리한 날짜: ${formatDay(task.completedAt)}`, '');
  lines.push('사용자가 입력한 내용만 모은 기록입니다. 원인이나 확인하지 않은 사실을 추정하지 않았습니다.');
  return lines.join('\n');
}
