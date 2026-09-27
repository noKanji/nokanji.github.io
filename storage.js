import { defaultProgress } from "./scheduler.js?v=16";

const PROGRESS_KEY = "kanji-trainer-progress-v1";
const DATA_CACHE_KEY = "kanji-words-data-cache-v2";
const SETTINGS_KEY = "kanji-words-settings-v1";
const DAILY_KEY_PREFIX = "kanji-words-daily-v1";

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); }
  catch (error) {
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
  return { ...defaultProgress(id), ...(saved && typeof saved === "object" ? saved : {}), id: String(id) };
}

export function saveProgress(progress) {
  const all = readAllProgress();
  all[progress.id] = { ...defaultProgress(progress.id), ...progress, id: String(progress.id) };
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
  Object.keys(localStorage).filter(key => key.startsWith(DAILY_KEY_PREFIX)).forEach(key => localStorage.removeItem(key));
}

export function exportProgress() {
  const blob = new Blob([JSON.stringify({
    version: 2,
    exportedAt: new Date().toISOString(),
    progress: readAllProgress(),
    settings: readSettings()
  }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `japanese-progress-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export async function importProgress(file) {
  if (!file) throw new Error("Файл не выбран.");
  const parsed = safeParse(await file.text(), null);
  const source = parsed?.progress ?? parsed;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Файл не содержит корректного прогресса.");
  }
  const clean = {};
  Object.entries(source).forEach(([id, value]) => {
    if (!id || !value || typeof value !== "object") return;
    clean[id] = { ...defaultProgress(id), ...value, id: String(id) };
  });
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(clean));
  if (parsed?.settings && typeof parsed.settings === "object") saveSettings(parsed.settings);
  return clean;
}

export function cacheLearningData(payload) {
  localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), payload }));
}

export function readCachedLearningData() {
  const cached = safeParse(localStorage.getItem(DATA_CACHE_KEY), null);
  return cached?.payload ? cached : null;
}

export function readSettings() {
  const saved = safeParse(localStorage.getItem(SETTINGS_KEY), {});
  return {
    deck: saved.deck === "words" ? "words" : "kanji",
    dailyLimit: [20, 25, 30].includes(Number(saved.dailyLimit)) ? Number(saved.dailyLimit) : 25,
    autoAudio: Boolean(saved.autoAudio)
  };
}

export function saveSettings(patch) {
  const next = { ...readSettings(), ...(patch || {}) };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededOrder(ids, seed) {
  return [...ids].sort((a, b) => hashString(`${seed}:${a}`) - hashString(`${seed}:${b}`));
}

export function getDailyNewIds(deck, availableIds, limit, date = new Date()) {
  const dateKey = localDateKey(date);
  const key = `${DAILY_KEY_PREFIX}:${deck}:${dateKey}`;
  const allowed = new Set(availableIds.map(String));
  const stored = safeParse(localStorage.getItem(key), []);
  const validStored = Array.isArray(stored) ? stored.map(String).filter(id => allowed.has(id)) : [];
  const target = Math.max(0, Number(limit) || 0);
  if (validStored.length >= target) return validStored.slice(0, target);
  const used = new Set(validStored);
  const additions = seededOrder([...allowed].filter(id => !used.has(id)), `${deck}:${dateKey}`).slice(0, target - validStored.length);
  const result = [...validStored, ...additions];
  localStorage.setItem(key, JSON.stringify(result));
  return result;
}
