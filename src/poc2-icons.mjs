const paths = {
  mori: '<path d="M7 20h10a4 4 0 0 0 4-4 8 8 0 0 0-8-8h-2a8 8 0 0 0-8 8 4 4 0 0 0 4 4Zm5-12c0-3 1.5-5 4-5 0 2.5-1.5 4-4 5Zm-3 5.5v1m6-1v1m-4 1.5c.5.65 1.5.65 2 0"/>',
  'arrow-up': '<path d="M12 19V5m-5 5 5-5 5 5"/>',
  compose: '<path d="M13 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6m-9 4 1-3 7-7a1.4 1.4 0 0 1 2 2l-7 7-3 1Z"/>',
  home: '<path d="M4 11 12 4l8 7v7a2 2 0 0 1-2 2h-4v-6h-4v6H6a2 2 0 0 1-2-2z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  note: '<rect x="5" y="4" width="14" height="16" rx="3"/><path d="M9 9h6m-6 4h6m-6 4h3"/>',
  settings: '<path d="M5 7h14M5 12h14M5 17h14"/><circle cx="9" cy="7" r="2" fill="var(--icon-fill, currentColor)"/><circle cx="15" cy="12" r="2" fill="var(--icon-fill, currentColor)"/><circle cx="10" cy="17" r="2" fill="var(--icon-fill, currentColor)"/>',
  'arrow-up-right': '<path d="M7 17 17 7M7 7h10v10"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="4" y="6" width="16" height="14" rx="3"/><path d="M8 4v4m8-4v4M4 10h16"/>',
  car: '<path d="m6 9 2-4h8l2 4m-14 1 1-1h14l1 1v6H4zm2 6v3m12-3v3M8 13h1m6 0h1"/>',
  house: '<path d="m4 11 8-7 8 7m-2-1v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-8m4 10v-6h4v6"/>',
  case: '<rect x="5" y="7" width="14" height="13" rx="3"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-5 4v5m4-5v5"/>',
  file: '<path d="M7 4h6l4 4v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm6 0v4h4m-7 4h4m-4 4h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4m0-12.8L17 7M7 17l-1.4 1.4"/>',
  moon: '<path d="M19.5 15.2A8 8 0 0 1 8.8 4.5a8 8 0 1 0 10.7 10.7z"/>',
  monitor: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M12 16v4m-4 0h8"/>',
  reset: '<path d="M4 12a8 8 0 1 1 2.5 5.8M4 12V6m0 6h6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5m0-8h.01"/>',
  spark: '<path d="M12 3c0 5.5 3.5 9 9 9-5.5 0-9 3.5-9 9 0-5.5-3.5-9-9-9 5.5 0 9-3.5 9-9z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  download: '<path d="M12 4v11m-4-4 4 4 4-4m-11 5v4h14v-4"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0m-7 7v3m-3 0h6"/>',
  chat: '<path d="M20 11a8 8 0 0 1-8 8H5l1.3-3.2A8 8 0 1 1 20 11zM8.5 11h7"/>'
};

export function icon(name) {
  const path = Object.hasOwn(paths, name) ? paths[name] : paths.file;
  return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + path + '</svg>';
}
