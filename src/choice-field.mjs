import { esc } from './experience.mjs';

// An in-flow listbox keeps long forms and small screens free from clipped popovers.
export function choiceField(label, name, value, options) {
  const items = options.map(option => typeof option === 'string' ? { value: option, label: option } : option);
  const selected = items.find(option => String(option.value) === String(value)) || items[0];
  return `<div class="field choice-field" data-choice>
    <span id="label-${name}">${esc(label)}</span>
    <input type="hidden" name="${name}" value="${esc(selected.value)}">
    <button type="button" class="choice-trigger" aria-labelledby="label-${name} value-${name}" aria-haspopup="listbox" aria-expanded="false" aria-controls="options-${name}">
      <span id="value-${name}" data-choice-value>${esc(selected.label)}</span><svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg>
    </button>
    <div class="choice-options" id="options-${name}" role="listbox" aria-labelledby="label-${name}" hidden>
      ${items.map(option => `<button type="button" role="option" tabindex="-1" aria-selected="${String(option.value) === String(selected.value)}" data-choice-option="${esc(option.value)}"><span>${esc(option.label)}</span><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg></button>`).join('')}
    </div>
  </div>`;
}

export function setChoice(field, value) {
  if (!field) return;
  const option = [...field.querySelectorAll('[role=option]')].find(option => option.dataset.choiceOption === String(value));
  if (!option) return;
  field.querySelector('input').value = value;
  field.querySelector('[data-choice-value]').textContent = option.querySelector('span').textContent;
  field.querySelectorAll('[role=option]').forEach(item => item.setAttribute('aria-selected', String(item === option)));
}

export function installChoices(root = document) {
  const close = (field, focus = false) => {
    field.querySelector('[role=listbox]').hidden = true;
    const trigger = field.querySelector('.choice-trigger');
    trigger.setAttribute('aria-expanded', 'false');
    if (focus) trigger.focus();
  };
  const closeOthers = current => root.querySelectorAll('[data-choice]').forEach(field => { if (field !== current) close(field); });
  const open = field => {
    closeOthers(field);
    field.querySelector('[role=listbox]').hidden = false;
    field.querySelector('.choice-trigger').setAttribute('aria-expanded', 'true');
    field.querySelector('[aria-selected=true]').focus({ preventScroll: true });
  };
  root.addEventListener('click', event => {
    const field = event.target.closest('[data-choice]');
    if (!field) return closeOthers();
    const trigger = event.target.closest('.choice-trigger'), option = event.target.closest('[data-choice-option]');
    if (trigger) trigger.getAttribute('aria-expanded') === 'true' ? close(field) : open(field);
    if (option) {
      setChoice(field, option.dataset.choiceOption);
      close(field, true);
      field.querySelector('input').dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  root.addEventListener('keydown', event => {
    const field = event.target.closest('[data-choice]');
    if (!field) return;
    const expanded = field.querySelector('.choice-trigger').getAttribute('aria-expanded') === 'true';
    if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close(field, true); }
    if (event.key === 'Tab' && expanded) close(field, true);
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!expanded) return open(field);
    const options = [...field.querySelectorAll('[role=option]')], index = options.indexOf(event.target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next].focus();
  });
  root.addEventListener('focusin', event => closeOthers(event.target.closest('[data-choice]')));
}
