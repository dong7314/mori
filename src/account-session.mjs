// Account refreshes have their own lifetime; opening a sheet must not cancel one.
export function createAccountLoader({ request, state, onSettings = () => {}, onChange = () => {} }) {
  let generation = 0;
  async function load() {
    const current = ++generation;
    const startingOwner = state.liveUser?.id, startingSettingsRevision = state.settingsRevision;
    const isCurrent = () => current === generation;
    const failedSession = () => {
      Object.assign(state, { liveUser: null, accountState: 'error', settingsRevision: 0, settingsState: 'idle' });
      onChange();
      return false;
    };

    let session;
    try { session = await request('/session'); }
    catch {
      if (!isCurrent()) return null;
      return failedSession();
    }
    if (!isCurrent()) return null;

    const user = session.user || null;
    let settings = null, settingsState = 'idle';
    if (user) {
      try {
        settings = await request('/settings');
        settingsState = 'ready';
      } catch (error) {
        if (!isCurrent()) return null;
        if (error?.status === 401) return failedSession();
        // A settings outage does not erase the authenticated session.
        settingsState = 'error';
      }
    }
    if (!isCurrent()) return null;

    // A write may finish after this refresh starts. Keep its newer revision while
    // allowing this refresh to finish normally, so account sheets leave loading.
    const sameOwner = Boolean(user && user.id === state.liveUser?.id);
    const newerProfile = sameOwner && state.liveUser.revision > user.revision;
    const newerSettings = sameOwner && state.settingsState === 'ready' && (settings
      ? state.settingsRevision > settings.revision
      : startingOwner === user.id && state.settingsRevision > startingSettingsRevision);
    Object.assign(state, {
      liveUser: newerProfile ? state.liveUser : user,
      accountState: user ? 'signed-in' : 'guest',
      settingsRevision: newerSettings ? state.settingsRevision : settings?.revision ?? 0,
      settingsState: newerSettings ? 'ready' : settingsState,
    });
    if (settings && !newerSettings) onSettings(settings);
    if (!isCurrent()) return null;
    onChange();
    return true;
  }
  load.invalidate = () => { generation++; };
  return load;
}
