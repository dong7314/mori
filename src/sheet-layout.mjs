// Presentation follows the screen's purpose, never its opener or history.
const SCREEN_SIZES = new Map([
  ['guide-sheet', 'large'],
  ['library-sheet', 'large'],
  ['document-import-sheet', 'large'],
  ['plans-sheet', 'large'],
  ['time-preview-sheet', 'compact'],
  ['theme-sheet', 'compact'],
  ['stock-choice-sheet', 'compact'],
  ['login-sheet', 'compact'],
  ['conversation-options-sheet', 'compact'],
  ['date-jump-sheet', 'compact'],
]);

export function sheetLayout({ formId = '', ref = null, screen = '', hasCardHero = false } = {}) {
  if (hasCardHero) return { surface: 'card', size: 'page' };
  if (['theme-form', 'conversation-form'].includes(formId)) return { surface: 'sheet', size: 'compact' };
  if (formId) return { surface: 'sheet', size: 'large' };
  if (SCREEN_SIZES.has(screen)) return { surface: 'sheet', size: SCREEN_SIZES.get(screen) };
  return { surface: 'sheet', size: ref ? 'page' : 'large' };
}

// Persistent reading and editing belong to navigation, rather than a popup.
// A brief choice stays a sheet only when it starts outside a page flow.
export function sheetPresentation({ screen = '', formId = '', hasCardHero = false, parent = '' } = {}) {
  if (hasCardHero) return 'card';
  if (parent === 'page' || formId) return 'page';
  return ['time-preview-sheet', 'date-jump-sheet', 'stock-choice-sheet'].includes(screen) ? 'sheet' : 'page';
}
