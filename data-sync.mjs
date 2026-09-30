export const REFRESH_INTERVAL = 24 * 60 * 60 * 1000;

export function createDataSync({ readCache, saveCache, request, apply, isBusy,
  status = () => {}, now = Date.now, online = () => true }) {
  let pending = null;
  let inFlight = null;
  let hasData = false;

  function commit(payload) {
    apply(payload);
    hasData = true;
  }

  function applyPending() {
    if (!pending || isBusy()) return false;
    const payload = pending;
    pending = null;
    commit(payload);
    status("updated");
    return true;
  }

  function refresh(force = false) {
    if (inFlight) return inFlight;
    if (!online() && !force) {
      status(hasData ? "offline" : "error", new Error("Нет подключения к интернету."));
      return Promise.resolve(false);
    }
    status(hasData ? "refreshing" : "loading");
    inFlight = Promise.resolve().then(() => request(force)).then(payload => {
      if (!payload?.success || !(Array.isArray(payload.kanji) || Array.isArray(payload.words) || Array.isArray(payload.items))) {
        throw new Error(payload?.error || "Источник вернул некорректные данные.");
      }
      // Saving is optional: a full device storage must not hide valid data.
      try { saveCache(payload); } catch (error) { console.warn("Не удалось сохранить базу", error); }
      if (isBusy()) {
        pending = payload;
        status("pending");
      } else {
        commit(payload);
        status("updated");
      }
      return true;
    }).catch(error => {
      status(hasData ? "offline" : "error", error);
      return false;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function start() {
    let cached;
    try { cached = readCache(); } catch { cached = null; }
    if (cached?.payload?.success && (Array.isArray(cached.payload.kanji) || Array.isArray(cached.payload.words) || Array.isArray(cached.payload.items))) {
      commit(cached.payload);
      status("cached", cached.savedAt);
      const age = now() - Date.parse(cached.savedAt);
      if (!Number.isFinite(age) || age < 0 || age >= REFRESH_INTERVAL) void refresh();
      return Promise.resolve(true);
    }
    return refresh();
  }

  return { start, refresh, applyPending };
}
