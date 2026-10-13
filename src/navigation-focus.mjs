// Remember a control by its stable identity before its surrounding view rerenders.
// aria-pressed and other state attributes are deliberately not part of that identity.
export function captureControl(element) {
  if (!element) return null;
  const names = element.id ? ['id'] : [...element.attributes].map(attribute => attribute.name)
    .filter(name => name.startsWith('data-') || ['name', 'type'].includes(name));
  if (!names.length && element.hasAttribute('aria-label')) names.push('aria-label');
  return { element, tag: element.tagName, attributes: names.map(name => [name, element.getAttribute(name)]) };
}

export function isAvailableControl(element) {
  return Boolean(element?.isConnected && !element.disabled &&
    !element.closest('[hidden], [inert], dialog:not([open])') && element.getClientRects().length);
}

export function resolveControl(root, bookmark, { visible = false } = {}) {
  if (!root || !bookmark) return null;
  const usable = element => root.contains(element) && (!visible || isAvailableControl(element));
  if (bookmark.element?.isConnected && usable(bookmark.element)) return bookmark.element;
  if (!bookmark.attributes.length) return null;
  return [...root.querySelectorAll('button, input, textarea, select, [tabindex]')].find(element =>
    element.tagName === bookmark.tag && bookmark.attributes.every(([name, value]) => element.getAttribute(name) === value) && usable(element)) || null;
}
