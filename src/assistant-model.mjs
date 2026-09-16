// Deterministic PoC behavior. Replace this boundary with the Hermes/API adapter in the product.
export const defaultParkingRule = () => ({
  id: 'commute-parking', enabled: true, weekdays: [1, 2, 3, 4, 5], start: '07:00', end: '09:00',
  prompt: '월요일부터 금요일, 오전 7시부터 9시까지 출근 전에 최신 주차 위치를 대시보드 첫 카드로 보여준다. 새 주차 기록이 생기면 같은 카드에 반영하고 기록 시각을 함께 표시한다.',
  source: '반복된 출근길 주차 조회에서 배운 예시',
});
export const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const minutes = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
export function selectContext({ parking, events, parkingRule }, now) {
  const clock = now.getHours() * 60 + now.getMinutes();
  const rule = parkingRule;
  if (rule?.enabled && rule.weekdays.includes(now.getDay()) && clock >= minutes(rule.start) && clock < minutes(rule.end)) {
    return { kind: 'parking', title: parking?.location || '오늘 주차한 곳을 알려주세요', subtitle: parking?.place || '말해주시면 다음 출근길에도 꺼내드릴게요.', reason: `${rule.weekdays.length === 7 ? '매일' : rule.weekdays.length === 2 ? '주말' : '평일'} ${rule.start}–${rule.end} · 출근 전에 찾는 기억`, parking };
  }
  const next = events.filter(e => e.date === dateKey(now) && minutes(e.time) >= clock).sort((a, b) => a.time.localeCompare(b.time))[0];
  if (next) return { kind: 'event', title: next.title, subtitle: `${next.time} · ${next.place || '장소 미정'}`, reason: minutes(next.time) - clock <= 90 ? '곧 시작하는 약속을 먼저 챙겨요' : '오늘 남은 약속을 미리 챙겨요', event: next };
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const first = events.filter(e => e.date === dateKey(tomorrow)).sort((a, b) => a.time.localeCompare(b.time))[0];
  if (clock >= 18 * 60 && first) return { kind: 'tomorrow', title: first.title, subtitle: `내일 ${first.time} · ${first.place || '장소 미정'}`, reason: '내일의 첫 약속을 준비해요', event: first };
  return { kind: 'rest', title: now.getDay() === 0 || now.getDay() === 6 ? '주말은 조금 느긋하게.' : '지금은 잠깐 쉬어가도 좋아요.', subtitle: '생각나는 일은 말로 남겨주세요. 모리가 기억할게요.', reason: '지금 챙길 약속이 없어요' };
}
export function readTime(text) {
  const match = text.match(/(?:(오전|오후|아침|저녁|밤)\s*)?(\d{1,2})(?:\s*시(?:\s*(반|\d{1,2})\s*분?)?|:(\d{2}))/);
  if (!match) return null;
  let hour = Number(match[2]); const minute = match[3] === '반' ? 30 : Number(match[3] || match[4] || 0);
  if (hour > 23 || minute > 59 || (match[1] && (hour < 1 || hour > 12))) return null;
  if (['오후', '저녁', '밤'].includes(match[1]) && hour < 12) hour += 12;
  if (['오전', '아침'].includes(match[1]) && hour === 12) hour = 0;
  if (!match[1] && hour >= 1 && hour <= 12 && !match[4]) return { ambiguous: true, hour, minute };
  return { value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}
export function readDate(text, now) {
  const result = new Date(now);
  const numeric = text.match(/(?:(\d{4})[-./년]\s*)?(\d{1,2})[-./월]\s*(\d{1,2})일?/);
  if (numeric) {
    const year = Number(numeric[1] || now.getFullYear()), month = Number(numeric[2]), day = Number(numeric[3]);
    result.setFullYear(year, month - 1, day);
    return result.getFullYear() === year && result.getMonth() === month - 1 && result.getDate() === day ? dateKey(result) : null;
  }
  if (/모레/.test(text)) result.setDate(result.getDate() + 2);
  else if (/내일/.test(text)) result.setDate(result.getDate() + 1);
  else if (!/오늘/.test(text)) {
    const weekday = text.match(/(월|화|수|목|금|토|일)요일/);
    if (!weekday) return null;
    let delta = ('일월화수목금토'.indexOf(weekday[1]) - now.getDay() + 7) % 7;
    if (/다음\s*주/.test(text)) delta = (7 - now.getDay()) % 7 + '일월화수목금토'.indexOf(weekday[1]);
    result.setDate(result.getDate() + delta);
  }
  return dateKey(result);
}
export function classify(text, now = new Date()) {
  const location = text.match(/(?:지하\s*\d+\s*층|지상\s*\d+\s*층|B\d+\s*층?)\s*(?:[A-Z]\s*[-]?\s*\d+)?/i);
  if (/주차|내 차/.test(text) && /매일|평일|주말|월화수목금|출근|아침마다/.test(text) && /보여|챙겨|알려|기억|띄워/.test(text)) return { kind: 'rule', text };
  if (/주차|내 차/.test(text) && location && !/어디|어딨/.test(text)) return { kind: 'parking-save', location: location[0].trim() };
  if (/주차|내 차|자동차/.test(text)) return { kind: 'parking-read' };
  if (/여행/.test(text)) {
    const destination = text.match(/([가-힣A-Za-z]+?)(?:으로|로|에서|에)?\s*(?:\d+박\s*\d+일|\d+일|여행)/)?.[1];
    const days = Number(text.match(/(\d+)\s*일/)?.[1] || 3);
    return { kind: 'trip', destination: destination && !['가족', '우리', '이번', '다음'].includes(destination) ? destination : null, days };
  }
  if (/pdf|엑셀|excel|문서|보고서|표로|파일/i.test(text)) return { kind: 'document', format: /엑셀|excel|표로/i.test(text) ? 'sheet' : 'pdf', text };
  if (/일정|약속|미팅|회의/.test(text)) {
    if (/알려|보여|뭐|조회/.test(text) && !/등록|추가|잡|저장/.test(text)) return { kind: 'events-read' };
    const time = readTime(text), date = readDate(text, now);
    return { kind: 'event', text, date, time: time?.value, ambiguous: time?.ambiguous, hour: time?.hour, minute: time?.minute };
  }
  if (/기억|메모/.test(text)) return { kind: 'note', text };
  return { kind: 'general', text };
}

export function updateParkingRule(text, previous) {
  const rule = { ...previous, enabled: true, weekdays: /매일/.test(text) ? [0,1,2,3,4,5,6] : /주말/.test(text) ? [0,6] : [1,2,3,4,5] };
  const start = readTime(text);
  if (start?.value) {
    rule.start = start.value;
    const rawEnd = text.split(/부터|~/)[1];
    let end = rawEnd ? readTime(rawEnd) : null;
    if (end?.ambiguous) {
      let hour = end.hour;
      if (minutes(start.value) >= 720 && hour < 12) hour += 12;
      end = { value: `${String(hour).padStart(2,'0')}:${String(end.minute).padStart(2,'0')}` };
    }
    const endMinute = end?.value && minutes(end.value) > minutes(rule.start) ? minutes(end.value) : Math.min(1439, minutes(rule.start) + 120);
    rule.end = `${String(Math.floor(endMinute / 60)).padStart(2,'0')}:${String(endMinute % 60).padStart(2,'0')}`;
  }
  rule.prompt = `${rule.weekdays.length === 7 ? '매일' : rule.weekdays.length === 2 ? '주말' : '월요일부터 금요일'} ${rule.start}부터 ${rule.end}까지 최신 주차 위치를 대시보드 첫 카드에 보여준다. 주차 위치가 바뀌면 새 기록과 기록 시각을 표시한다.`;
  rule.source = '대화에서 부탁한 방식';
  return rule;
}
