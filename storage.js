import { defaultProgress } from "./scheduler.js?v=21";

const PROGRESS_KEY = "kanji-trainer-progress-v1";
const DATA_CACHE_KEY = "kanji-words-data-cache-v2";
const SETTINGS_KEY = "kanji-words-settings-v1";
const DAILY_KEY_PREFIX = "kanji-words-daily-v1";
const QUIZ_PROGRESS_KEY = "kanji-words-quiz-progress-v1";

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

export function readQuizProgress() {
  const saved = safeParse(localStorage.getItem(QUIZ_PROGRESS_KEY), null);
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return { version: 1, sources: {}, candidates: {} };
  return {
    version: 1,
    sources: saved.sources && typeof saved.sources === "object" && !Array.isArray(saved.sources) ? saved.sources : {},
    candidates: saved.candidates && typeof saved.candidates === "object" && !Array.isArray(saved.candidates) ? saved.candidates : {}
  };
}

export function recordQuizAnswer(question, correct, now = new Date()) {
  if (!question?.kind || !question?.sourceId) return readQuizProgress();
  const all = readQuizProgress();
  const coverageId = String(question.coverageId || `${question.kind}:${question.sourceId}`);
  const candidateId = String(question.candidateId || `${coverageId}:${question.type || "question"}`);
  const update = current => ({
    seen: Number(current?.seen || 0) + 1,
    correct: Number(current?.correct || 0) + (correct ? 1 : 0),
    mistakes: Number(current?.mistakes || 0) + (correct ? 0 : 1),
    lastSeenAt: now.toISOString()
  });
  all.sources[coverageId] = update(all.sources[coverageId]);
  all.candidates[candidateId] = update(all.candidates[candidateId]);
  localStorage.setItem(QUIZ_PROGRESS_KEY, JSON.stringify(all));
  return all;
}

export function clearProgress() {
  localStorage.removeItem(PROGRESS_KEY);
  localStorage.removeItem(QUIZ_PROGRESS_KEY);
  Object.keys(localStorage).filter(key => key.startsWith(DAILY_KEY_PREFIX)).forEach(key => localStorage.removeItem(key));
}

export function exportProgress() {
  const blob = new Blob([JSON.stringify({
    version: 3,
    exportedAt: new Date().toISOString(),
    progress: readAllProgress(),
    quizProgress: readQuizProgress(),
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
  if (parsed?.quizProgress && typeof parsed.quizProgress === "object" && !Array.isArray(parsed.quizProgress)) {
    localStorage.setItem(QUIZ_PROGRESS_KEY, JSON.stringify({
      version: 1,
      sources: parsed.quizProgress.sources && typeof parsed.quizProgress.sources === "object" ? parsed.quizProgress.sources : {},
      candidates: parsed.quizProgress.candidates && typeof parsed.quizProgress.candidates === "object" ? parsed.quizProgress.candidates : {}
    }));
  }
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
