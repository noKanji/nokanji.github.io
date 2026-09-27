import { defaultProgress } from "./scheduler.js?v=15";

const PROGRESS_KEY = "kanji-trainer-progress-v1";
const DATA_CACHE_KEY = "kanji-trainer-data-cache-v1";
const SETTINGS_KEY = "kanji-trainer-settings-v1";

const DEFAULT_SETTINGS = Object.freeze({
  dailyNewLimit: 10
});

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn("Повреждённые локальные данные проигнорированы.", error);
    return fallback;
  }
}

export function readAllProgress() {
  const value = safeParse(localStorage.getItem(PROGRESS_KEY), {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function getProgress(id) {
  const saved = readAllProgress()[id];
  const progress = {
    ...defaultProgress(id),
    ...(saved && typeof saved === "object" ? saved : {}),
    id: String(id)
  };
  if (progress.status !== "new" && progress.difficulty !== "hard" && Number(progress.intervalDays || 0) >= 21) {
    progress.status = "mastered";
  }
  if (progress.status === "mastered" && progress.difficulty === "hard") {
    progress.status = "learning";
  }
  return progress;
}

export function saveProgress(progress) {
  const all = readAllProgress();
  all[progress.id] = { ...defaultProgress(progress.id), ...progress };
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  return all[progress.id];
}

export function toggleFavorite(id) {
  const progress = getProgress(id);
  progress.favorite = !progress.favorite;
  return saveProgress(progress);
}

export function clearProgress() {
  localStorage.removeItem(PROGRESS_KEY);
}

export function exportProgress() {
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    settings: readSettings(),
    progress: readAllProgress()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `kanji-progress-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export async function importProgress(file) {
  const parsed = safeParse(await file.text(), null);
  const source = parsed?.progress ?? parsed;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Файл не содержит корректного прогресса.");
  }

  const clean = {};
  Object.entries(source).forEach(([id, value]) => {
    if (!id || !value || typeof value !== "object") return;
    const progress = { ...defaultProgress(id), ...value, id: String(id) };
    if (progress.status !== "new" && progress.difficulty !== "hard" && Number(progress.intervalDays || 0) >= 21) {
      progress.status = "mastered";
    }
    clean[id] = progress;
  });
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(clean));

  if (parsed?.settings && typeof parsed.settings === "object") {
    saveSettings(parsed.settings);
  }
  return clean;
}

export function readSettings() {
  const saved = safeParse(localStorage.getItem(SETTINGS_KEY), {});
  const dailyNewLimit = Number(saved?.dailyNewLimit);
  return {
    ...DEFAULT_SETTINGS,
    ...(saved && typeof saved === "object" ? saved : {}),
    dailyNewLimit: [5, 10, 15, 20].includes(dailyNewLimit) ? dailyNewLimit : DEFAULT_SETTINGS.dailyNewLimit
  };
}

export function saveSettings(nextSettings) {
  const settings = { ...readSettings(), ...nextSettings };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

export function cacheLearningData(items) {
  localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({
    savedAt: new Date().toISOString(),
    items
  }));
}

export function readCachedLearningData() {
  const cached = safeParse(localStorage.getItem(DATA_CACHE_KEY), null);
  return cached?.items && (Array.isArray(cached.items) ||
    (Array.isArray(cached.items.kanji) && (cached.items.words === null || Array.isArray(cached.items.words)))) ? cached : null;
}
