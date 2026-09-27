// Shared by the study session and local progress store.
export const RESULTS = Object.freeze({
  again: { label: "Не помню", tone: "danger", delayLabel: "ещё раз" },
  hard: { label: "Трудно", tone: "warning", delayLabel: "1 день" },
  good: { label: "Помню", tone: "success", delayLabel: "дальше" },
  easy: { label: "Легко", tone: "primary", delayLabel: "надолго" }
});

const DAY_MS = 86_400_000;
const TEN_MINUTES_MS = 600_000;
const MASTERED_INTERVAL_DAYS = 21;

export function defaultProgress(id) {
  return {
    id: String(id),
    status: "new",
    favorite: false,
    difficulty: "normal",
    reviews: 0,
    correct: 0,
    mistakes: 0,
    correctStreak: 0,
    lastResult: null,
    lastReviewed: null,
    nextReview: null,
    intervalDays: 0
  };
}

export function scheduleReview(progress, result, now = new Date()) {
  const current = { ...defaultProgress(progress.id), ...progress };
  const next = {
    ...current,
    status: "learning",
    reviews: Number(current.reviews || 0) + 1,
    lastResult: result,
    lastReviewed: now.toISOString()
  };

  let intervalDays = Number(current.intervalDays) || 0;
  let delayMs;

  if (result === "again") {
    next.mistakes = Number(current.mistakes || 0) + 1;
    next.correctStreak = 0;
    next.difficulty = "hard";
    intervalDays = 0.007;
    delayMs = TEN_MINUTES_MS;
  } else if (result === "hard") {
    next.correctStreak = 0;
    next.difficulty = "hard";
    intervalDays = 1;
    delayMs = DAY_MS;
  } else if (result === "good") {
    next.correct = Number(current.correct || 0) + 1;
    next.correctStreak = Number(current.correctStreak || 0) + 1;
    if (next.correctStreak >= 3) next.difficulty = "normal";
    intervalDays = intervalDays > 0 ? Math.max(3, intervalDays * 2) : 3;
    intervalDays = Math.min(90, Math.round(intervalDays));
    delayMs = intervalDays * DAY_MS;
  } else if (result === "easy") {
    next.correct = Number(current.correct || 0) + 1;
    next.correctStreak = Number(current.correctStreak || 0) + 1;
    next.difficulty = "normal";
    intervalDays = intervalDays > 0 ? Math.max(7, intervalDays * 2.5) : 7;
    intervalDays = Math.min(90, Math.round(intervalDays));
    delayMs = intervalDays * DAY_MS;
  } else {
    throw new Error(`Неизвестный результат: ${result}`);
  }

  next.intervalDays = intervalDays;
  next.status = next.difficulty === "normal" && intervalDays >= MASTERED_INTERVAL_DAYS ? "mastered" : "learning";
  next.nextReview = new Date(now.getTime() + delayMs).toISOString();
  return next;
}

export function isDue(progress, now = new Date()) {
  if (!progress?.nextReview) return false;
  const timestamp = Date.parse(progress.nextReview);
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

export function isMastered(progress) {
  if (!progress) return false;
  return progress.status === "mastered" || (
    progress.difficulty !== "hard" && Number(progress.intervalDays || 0) >= MASTERED_INTERVAL_DAYS
  );
}

export function isDifficult(progress) {
  if (!progress) return false;
  const reviews = Number(progress.reviews) || 0;
  const correct = Number(progress.correct) || 0;
  const correctStreak = Number(progress.correctStreak) || 0;
  const successRate = reviews ? correct / reviews : 1;
  return progress.difficulty === "hard" || (
    reviews >= 3 && correctStreak < 3 && successRate < 0.6
  );
}

export function buildReviewQueue(cards, now = new Date()) {
  return [...cards]
    .filter(card => isDue(card.progress, now))
    .sort((a, b) => {
      const hardA = isDifficult(a.progress) ? 0 : 1;
      const hardB = isDifficult(b.progress) ? 0 : 1;
      if (hardA !== hardB) return hardA - hardB;

      const nextA = Date.parse(a.progress.nextReview) || 0;
      const nextB = Date.parse(b.progress.nextReview) || 0;
      if (nextA !== nextB) return nextA - nextB;

      return (Number(b.progress.mistakes) || 0) - (Number(a.progress.mistakes) || 0);
    });
}
