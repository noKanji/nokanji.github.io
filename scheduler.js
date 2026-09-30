export const RESULTS = Object.freeze({
  again: { label: "Повторить", hint: "свайп вниз", tone: "danger" },
  later: { label: "Повторить позже", hint: "свайп вверх", tone: "success" }
});

const TEN_MINUTES_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STAGE_DELAYS = [1, 3, 7, 14];

export function defaultProgress(id) {
  return {
    id: String(id),
    status: "new",
    favorite: false,
    difficulty: "normal",
    reviews: 0,
    correct: 0,
    mistakes: 0,
    streak: 0,
    stage: 0,
    lastResult: null,
    lastReviewed: null,
    nextReview: null,
    intervalDays: 0,
    learnedAt: null,
    controlPassed: false
  };
}

function inferStage(progress) {
  const explicit = Number(progress.stage);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.min(4, Math.floor(explicit));
  const interval = Number(progress.intervalDays) || 0;
  if (interval >= 14) return 4;
  if (interval >= 7) return 3;
  if (interval >= 3) return 2;
  if (interval >= 1) return 1;
  return 0;
}

export function scheduleReview(progress, result, now = new Date()) {
  const current = { ...defaultProgress(progress.id), ...progress };
  const next = {
    ...current,
    reviews: Number(current.reviews || 0) + 1,
    lastResult: result,
    lastReviewed: now.toISOString()
  };

  if (result === "again") {
    next.status = "learning";
    next.mistakes = Number(current.mistakes || 0) + 1;
    next.streak = 0;
    next.difficulty = "hard";
    next.stage = Math.max(0, inferStage(current) - 1);
    next.intervalDays = 0;
    next.nextReview = new Date(now.getTime() + TEN_MINUTES_MS).toISOString();
    next.controlPassed = false;
    return next;
  }

  if (result !== "later") throw new Error(`Неизвестный результат: ${result}`);

  const stage = inferStage(current);
  next.correct = Number(current.correct || 0) + 1;
  next.streak = Number(current.streak || 0) + 1;
  next.difficulty = current.difficulty === "hard" && next.streak >= 3 ? "normal" : current.difficulty;

  if (stage >= 4) {
    next.status = "learned";
    next.stage = 4;
    next.intervalDays = 0;
    next.nextReview = null;
    next.controlPassed = true;
    next.learnedAt = current.learnedAt || now.toISOString();
    return next;
  }

  const delayDays = STAGE_DELAYS[stage];
  const nextStage = stage + 1;
  next.stage = nextStage;
  next.intervalDays = delayDays;
  next.status = nextStage >= 4 ? "learned" : "learning";
  next.nextReview = new Date(now.getTime() + delayDays * DAY_MS).toISOString();
  next.learnedAt = nextStage >= 4 ? (current.learnedAt || now.toISOString()) : current.learnedAt;
  next.controlPassed = false;
  return next;
}

export function isDue(progress, now = new Date()) {
  if (!progress?.nextReview) return false;
  const timestamp = Date.parse(progress.nextReview);
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

export function isDifficult(progress) {
  if (!progress) return false;
  const reviews = Number(progress.reviews) || 0;
  const correct = Number(progress.correct) || 0;
  const successRate = reviews ? correct / reviews : 1;
  return progress.difficulty === "hard" || Number(progress.mistakes) >= 2 || (reviews >= 4 && successRate < 0.6);
}

export function buildReviewQueue(cards, now = new Date()) {
  return [...cards]
    .filter(card => isDue(card.progress, now))
    .sort((a, b) => {
      const dateA = Date.parse(a.progress.nextReview) || 0;
      const dateB = Date.parse(b.progress.nextReview) || 0;
      if (dateA !== dateB) return dateA - dateB;
      return (Number(b.progress.mistakes) || 0) - (Number(a.progress.mistakes) || 0);
    });
}
