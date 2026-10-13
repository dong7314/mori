// Each recognition event contains the current session's whole transcript. Keep
// the previous sessions separate so interim updates don't repeat or erase them.
export function appendTranscript(previous, session) {
  const addition = session.trim();
  if (!addition) return previous;
  return previous.trim() ? `${previous.trimEnd()}\n${addition}` : addition;
}
