const HTML = 'http://www.w3.org/1999/xhtml';
const runtimeClasses = new Set(['overlay-scroll-target', 'motion-pending']);
const controlTags = new Set(['input', 'textarea', 'select', 'option']);
const localName = node => node.localName || node.tagName?.toLowerCase() || '';
const runtimeNode = node => node.nodeType === 1 && node.hasAttribute('data-overlay-scrollbar');
const classes = node => (node.getAttribute('class') || '').split(/\s+/).filter(Boolean);

function key(node) {
  if (node.nodeType !== 1) return String(node.nodeType);
  const tag = localName(node), prefix = [node.namespaceURI, tag];
  const attr = name => node.getAttribute(name);
  if (attr('id')) return JSON.stringify([...prefix, 'id', attr('id')]);
  if (attr('data-ref') !== null) return JSON.stringify([...prefix, 'ref', attr('data-ref'), attr('data-occurrence'), attr('data-date')]);
  if (attr('data-action') !== null) return JSON.stringify([...prefix, 'action', attr('data-action'),
    ...['data-id', 'data-value', 'data-hours', 'data-index', 'data-date', 'data-time', 'data-minutes'].map(attr)]);
  if (attr('data-date') !== null) return JSON.stringify([...prefix, 'date', attr('data-date')]);
  if (controlTags.has(tag) && attr('name')) return JSON.stringify([...prefix, 'control', attr('name'), attr('type')]);
  if (attr('aria-labelledby')) return JSON.stringify([...prefix, 'labelledby', attr('aria-labelledby')]);
  // Repeated unkeyed siblings retain their relative position within the same
  // semantic kind; transient presentation classes never change that identity.
  return JSON.stringify([...prefix, 'position', classes(node).find(value =>
    !runtimeClasses.has(value) && !/^(is-|has-)|^(selected|active)$/.test(value)) || '']);
}

function attributeValue(node, attribute) {
  return attribute.namespaceURI
    ? node.getAttributeNS(attribute.namespaceURI, attribute.localName)
    : node.getAttribute(attribute.name);
}

function sameStyle(node, next) {
  const live = node.style, desired = next.style;
  return Boolean(live && desired && live.length === desired.length && [...desired].every(property =>
    live.getPropertyValue(property) === desired.getPropertyValue(property) &&
    live.getPropertyPriority(property) === desired.getPropertyPriority(property)));
}

function syncAttributes(node, next, focusedControl) {
  const preserve = name => focusedControl && /^(value|checked|selected)$/.test(name);
  const desired = new Map([...next.attributes].map(attribute => [
    `${attribute.namespaceURI || ''}:${attribute.localName || attribute.name}`, attribute,
  ]));
  const keptClasses = classes(node).filter(value => runtimeClasses.has(value));
  for (const attribute of [...node.attributes]) {
    if (preserve(attribute.name)) continue;
    if (desired.has(`${attribute.namespaceURI || ''}:${attribute.localName || attribute.name}`)) continue;
    if (attribute.name === 'class' && keptClasses.length) {
      const value = keptClasses.join(' ');
      if (attribute.value !== value) node.setAttribute('class', value);
    } else if (attribute.namespaceURI) node.removeAttributeNS(attribute.namespaceURI, attribute.localName);
    else node.removeAttribute(attribute.name);
  }
  for (const attribute of desired.values()) {
    if (preserve(attribute.name)) continue;
    const value = attribute.name === 'class'
      ? [...new Set([...attribute.value.split(/\s+/).filter(Boolean), ...keptClasses])].join(' ')
      : attribute.value;
    if (attributeValue(node, attribute) === value) continue;
    // CSSOM serializes declarations differently from generated markup. Equal
    // calendar variables must not be rewritten during a fold already in flight.
    if (attribute.name === 'style' && sameStyle(node, next)) continue;
    if (attribute.namespaceURI) node.setAttributeNS(attribute.namespaceURI, attribute.name, value);
    else node.setAttribute(attribute.name, value);
  }
}

function syncControl(node, next, focused) {
  if (focused || node.namespaceURI !== HTML) return;
  const tag = localName(node);
  if (['input', 'textarea', 'select'].includes(tag) && !(tag === 'select' && node.multiple) && node.value !== next.value) node.value = next.value;
  if (tag === 'input' && node.checked !== next.checked) node.checked = next.checked;
  if (tag === 'option' && node.selected !== next.selected) node.selected = next.selected;
}

function syncNode(node, next, active) {
  if (node.nodeType !== 1) {
    if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
    return;
  }
  const tag = localName(node), focused = node === active;
  syncAttributes(node, next, focused && controlTags.has(tag));
  // Changing a focused select's options or a textarea's text changes its live
  // selection even when the control's value property is left untouched.
  if (!(focused && (tag === 'textarea' || tag === 'select' || node.isContentEditable))) syncChildren(node, next, active);
  syncControl(node, next, focused);
}

function nextContentSibling(node) {
  let next = node.nextSibling;
  while (next && runtimeNode(next)) next = next.nextSibling;
  return next;
}

function syncChildren(root, next, active) {
  const oldChildren = [...root.childNodes].filter(node => !runtimeNode(node));
  const available = new Map();
  for (const node of oldChildren) {
    const identity = key(node);
    if (!available.has(identity)) available.set(identity, []);
    available.get(identity).push(node);
  }
  const used = new Set();
  const desired = [...next.childNodes].filter(node => !runtimeNode(node)).map(candidate => {
    const node = available.get(key(candidate))?.shift();
    if (!node) return candidate;
    used.add(node);
    syncNode(node, candidate, active);
    return node;
  });
  for (const node of oldChildren) if (!used.has(node)) root.removeChild(node);

  const placeBefore = (node, anchor) => {
    if (node.parentNode !== root || nextContentSibling(node) !== anchor) root.insertBefore(node, anchor);
  };
  const focusedIndex = desired.findIndex(node => node === active || node.contains?.(active));
  // Keep the focused branch attached. Moving its siblings around it preserves
  // browser focus, IME state and caret even when keyed results change order.
  if (focusedIndex >= 0 && desired[focusedIndex].parentNode === root) {
    let anchor = null;
    for (let i = desired.length - 1; i > focusedIndex; i--) { placeBefore(desired[i], anchor); anchor = desired[i]; }
    anchor = desired[focusedIndex];
    for (let i = focusedIndex - 1; i >= 0; i--) { placeBefore(desired[i], anchor); anchor = desired[i]; }
  } else {
    let anchor = null;
    for (let i = desired.length - 1; i >= 0; i--) { placeBefore(desired[i], anchor); anchor = desired[i]; }
  }
}

// Only children are patched: the caller owns the live page host and its motion.
// Existing elements keep listeners, scroll offsets and running Web Animations.
export function patchLiveView(root, next) {
  syncChildren(root, next, root.ownerDocument?.activeElement);
  return root;
}
