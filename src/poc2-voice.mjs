import { createVoiceSession } from './voice-session.mjs';

let active;
const voice = createVoiceSession({ limit: 1000 });

export function cancelVoiceInput() {
  if (!active) return;
  const current = active;
  active = null;
  voice.cancel();
  current.button.setAttribute('aria-pressed', 'false');
  current.button.setAttribute('aria-label', '음성 입력');
  current.recognition.abort();
}

export function toggleVoiceInput(button, input, announce) {
  if (!input) return;
  if (active?.button === button) {
    voice.processing(active.id);
    active.recognition.stop();
    return;
  }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    announce('이 브라우저에서는 음성 입력이 지원되지 않아요.');
    input.focus();
    return;
  }

  cancelVoiceInput();
  const recognition = new Recognition();
  const id = voice.begin(input.value);
  active = { id, recognition, button };
  recognition.lang = 'ko-KR';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.onstart = () => {
    if (active?.id !== id) return;
    voice.listening(id);
    button.setAttribute('aria-pressed', 'true');
    button.setAttribute('aria-label', '음성 입력 끝내기');
    announce('듣고 있어요. 말씀해 주세요.');
  };
  recognition.onresult = event => voice.update(id, Array.from(event.results, result => ({
    text: result[0]?.transcript,
    final: result.isFinal,
  })));
  recognition.onerror = event => {
    if (active?.id !== id) return;
    voice.fail(id, event.error);
    announce(event.error === 'not-allowed' ? '마이크 권한이 필요해요. 계속 입력할 수도 있어요.' : '음성을 받아 적지 못했어요.');
  };
  recognition.onend = () => {
    if (active?.id !== id) return;
    active = null;
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', '음성 입력');
    let result = voice.finish(id);
    if (result.transcript && input.value !== result.base && ['ready', 'error'].includes(result.phase) && (!result.error || result.error === 'limit')) {
      result = voice.accept(result.transcript, input.value);
    }
    if (result.phase === 'ready' && input.isConnected) {
      input.value = result.draft;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    } else if (result.error === 'no-speech') {
      announce('음성이 들리지 않았어요. 다시 말하거나 직접 입력해 주세요.');
    } else if (result.error === 'limit') {
      announce('음성을 더하면 입력할 수 있는 길이를 넘어요.');
    }
  };

  try { recognition.start(); }
  catch {
    active = null;
    voice.fail(id, 'unavailable');
    announce('지금은 음성 입력을 시작할 수 없어요.');
  }
}
