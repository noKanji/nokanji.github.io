import {
  getProgress,
  saveProgress,
  toggleFavorite,
  exportProgress,
  importProgress,
  clearProgress,
  cacheLearningData,
  readCachedLearningData,
  readSettings,
  saveSettings,
  getDailyNewIds,
  readQuizProgress,
  recordQuizAnswer
} from "./storage.js?v=22";
import { scheduleReview, isDue, isDifficult, buildReviewQueue, RESULTS } from "./scheduler.js?v=22";
import { createQuizEngine } from "./quiz-engine.mjs?v=22";
import { createDataSync } from "./data-sync.mjs?v=22";

const state = {
  kanji: [],
  words: [],
  deck: readSettings().deck,
  route: "today",
  session: null,
  quizEngine: null,
  quiz: null,
  usingCache: false
};

const $ = id => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const clean = value => value === null || value === undefined ? "" : String(value).trim();
const has = value => clean(value) !== "";

function kanaPronunciationKey(value) {
  const text = clean(value).normalize("NFKC");
  if (!text || !/^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(text)) return "";
  return [...text].map(char => {
    const code = char.codePointAt(0);
    return code >= 0x30A1 && code <= 0x30F6 ? String.fromCodePoint(code - 0x60) : char;
  }).join("");
}

function sameKanaPronunciation(left, right) {
  const a = kanaPronunciationKey(left);
  const b = kanaPronunciationKey(right);
  return Boolean(a && b && a === b);
}

function quizSourceSummary(source) {
  if (!source) return "";
  const parts = [];
  if (has(source.form)) parts.push(clean(source.form));
  if (has(source.reading)
    && clean(source.reading) !== clean(source.form)
    && !sameKanaPronunciation(source.form, source.reading)) parts.push(clean(source.reading));
  if (has(source.meaning)) parts.push(clean(source.meaning));
  return parts.join(" · ");
}

function progressId(type, id) {
  return type === "word" ? `word:${id}` : String(id);
}

function normalizeKanji(source) {
  const id = clean(source?.id);
  const kanji = clean(source?.kanji);
  if (!id || !kanji) return null;
  const item = {
    type: "kanji",
    id,
    storageId: progressId("kanji", id),
    kanji,
    meaning: clean(source.meaning),
    meaningExtra: clean(source.meaning_extra),
    onyomi: clean(source.onyomi),
    kunyomi: clean(source.kunyomi),
    components: clean(source.components),
    strokeCount: clean(source.stroke_count),
    words: parseGroupedEntries(source.words),
    examples: parseGroupedEntries(source.examples),
    lesson: clean(source.lesson),
    jlpt: clean(source.jlpt),
    imageUrl: validImageUrl(source.image_url),
    dateAdded: clean(source.date_added)
  };
  item.progress = getProgress(item.storageId);
  return item;
}

function audioFileUrl(fileName) {
  const raw = clean(fileName);
  if (!raw) return "";
  if (/^(?:https?:)?\/\//i.test(raw) || raw.startsWith("./") || raw.startsWith("/")) return raw;
  const withoutFolder = raw.replace(/^genki_audio[\/\\]/i, "");
  return `./genki_audio/${withoutFolder.split(/[\/\\]/).map(encodeURIComponent).join("/")}`;
}

function normalizeWord(source) {
  const id = clean(source?.id);
  const japanese = clean(source?.japanese);
  if (!id || !japanese) return null;

  const sourceAudio = source?.audio && typeof source.audio === "object" ? source.audio : {};
  const wordFile = clean(
    sourceAudio.wordFile || sourceAudio.word_file ||
    source.audio_word_source || source.audio_word_file
  );
  const exampleFile = clean(
    sourceAudio.exampleFile || sourceAudio.example_file ||
    source.audio_sentence_source || source.audio_sentence_file
  );

  const item = {
    type: "word",
    id,
    storageId: progressId("word", id),
    japanese,
    reading: clean(source.reading),
    meaning: clean(source.meaning_ru),
    partOfSpeech: clean(source.part_of_speech),
    exampleJp: clean(source.example_jp),
    exampleReading: clean(source.example_reading),
    exampleRu: clean(source.example_ru),
    lesson: clean(source.lesson),
    jlpt: clean(source.jlpt),
    audio: {
      language: clean(sourceAudio.language) || "ja-JP",
      wordFile,
      exampleFile,
      wordUrl: clean(sourceAudio.wordUrl || sourceAudio.word_url) || audioFileUrl(wordFile),
      exampleUrl: clean(sourceAudio.exampleUrl || sourceAudio.example_url) || audioFileUrl(exampleFile)
    }
  };
  item.progress = getProgress(item.storageId);
  return item;
}

function parseGroupedEntries(value) {
  if (!has(value)) return [];
  return String(value).split(";").map(entry => entry.trim()).filter(Boolean).reduce((items, entry) => {
    const [main = "", reading = "", ...translationParts] = entry.split("|").map(part => part.trim());
    if (main) items.push({ main, reading, translation: translationParts.join("|").trim() });
    return items;
  }, []);
}

function normalizeUnique(items, normalizer) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).reduce((list, source) => {
    if (source && Object.prototype.hasOwnProperty.call(source, "active")
      && !["true", "1", "yes", "да"].includes(String(source.active).trim().toLowerCase())) return list;
    const item = normalizer(source);
    if (!item || seen.has(item.storageId)) return list;
    seen.add(item.storageId);
    list.push(item);
    return list;
  }, []);
}

function validImageUrl(value) {
  if (!has(value)) return null;
  try {
    const url = new URL(value, location.href);
    return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost") ? url.href : null;
  } catch {
    return null;
  }
}

function apiUrl(type = "all", force = false) {
  const url = new URL(CONFIG.API_URL);
  url.searchParams.set("type", type);
  if (force) url.searchParams.set("_", String(Date.now()));
  return url.href;
}

function studyInProgress() {
  return Boolean((state.quiz && state.quiz.index < state.quiz.questions.length)
    || (state.session && state.session.index < state.session.queue.length));
}

const dataSync = createDataSync({
  readCache: readCachedLearningData,
  saveCache: cacheLearningData,
  online: () => navigator.onLine !== false,
  isBusy: studyInProgress,
  request: async force => {
    if (!CONFIG.API_URL || CONFIG.API_URL === "PASTE_GOOGLE_APPS_SCRIPT_URL_HERE") {
      throw new Error("Укажите URL источника в config-live.js.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(apiUrl("all", force), {
        cache: force ? "reload" : "no-cache", redirect: "follow", signal: controller.signal
      });
      if (!response.ok) throw new Error(`Источник вернул код ${response.status}.`);
      return await response.json();
    } finally { clearTimeout(timeout); }
  },
  apply: payload => {
    // Keep completed results available after replacing the underlying catalog.
    const completedQuiz = state.quiz;
    applyPayload(payload);
    state.quiz = completedQuiz;
    updateDeckSwitch();
    populateFilters();
    routeTo(state.route || "today", false);
    if (state.route === "session") renderSession();
  },
  status: (status, detail) => {
    state.usingCache = ["cached", "refreshing", "offline", "pending"].includes(status);
    $("refresh-button").disabled = status === "loading" || status === "refreshing";
    if (status === "loading") { showView("loading"); setBanner(""); }
    else if (status === "refreshing") setBanner("Проверяем обновления в фоне. Можно продолжать заниматься.");
    else if (status === "pending") setBanner("Новая база загружена. Применим её после завершения занятия.");
    else if (status === "offline") setBanner("Не удалось обновить базу. Можно заниматься по сохранённым данным.");
    else if (status === "error") { setBanner(detail?.message || "Не удалось загрузить базу.", true); routeTo("today", false); }
    else setBanner("");
  }
});

function loadCards(force = false) {
  return force ? dataSync.refresh(true) : dataSync.start();
}

function applyPayload(payload) {
  if (Array.isArray(payload.kanji) || Array.isArray(payload.words)) {
    state.kanji = normalizeUnique(payload.kanji, normalizeKanji);
    state.words = normalizeUnique(payload.words, normalizeWord);
    state.quizEngine = createQuizEngine(payload.kanji || [], payload.words || []);
    state.quiz = null;
    return;
  }
  if (Array.isArray(payload.items)) {
    state.kanji = normalizeUnique(payload.items, normalizeKanji);
    state.words = [];
    state.quizEngine = createQuizEngine(payload.items, []);
    state.quiz = null;
    return;
  }
  throw new Error("API вернул неверный формат данных.");
}

function currentCards() {
  return state.deck === "words" ? state.words : state.kanji;
}

function setBanner(message, isError = false) {
  const banner = $("offline-banner");
  banner.hidden = !message;
  banner.textContent = message;
  banner.classList.toggle("error", Boolean(isError));
}

function showView(name) {
  document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === `${name}-view`));
}

function routeTo(route, scroll = true) {
  state.route = route;
  document.querySelectorAll(".bottom-nav button").forEach(button => button.classList.toggle("active", button.dataset.route === route));
  if (route === "today") { showView("today"); renderToday(); }
  else if (route === "library") { showView("library"); renderLibrary(); }
  else if (route === "quiz") { showView("quiz"); renderQuiz(); }
  else if (route === "progress") { showView("progress"); renderProgress(); }
  else if (route === "quiz-progress") { showView("quiz-progress"); renderQuizProgress(); }
  else if (route === "session") showView("session");
  if (scroll) window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function setDeck(deck) {
  if (!['kanji', 'words'].includes(deck) || state.deck === deck) return;
  if (state.session && state.route === "session") {
    if (!confirm("Завершить текущую сессию и переключить карточки?")) return;
    state.session = null;
  }
  state.deck = deck;
  saveSettings({ deck });
  updateDeckSwitch();
  populateFilters();
  routeTo(state.route === "session" ? "today" : state.route);
}

function updateDeckSwitch() {
  $("kanji-count").textContent = String(state.kanji.length);
  $("words-count").textContent = String(state.words.length);
  document.querySelectorAll("[data-deck]").forEach(button => {
    const active = button.dataset.deck === state.deck;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.body.dataset.deck = state.deck;
  const placeholder = state.deck === "words" ? "Слово, чтение, перевод…" : "Кандзи, значение, чтение…";
  if ($("search-input")) $("search-input").placeholder = placeholder;
}

function populateSelect(select, values, firstLabel) {
  const current = select.value;
  select.replaceChildren(new Option(firstLabel, ""));
  [...new Set(values.filter(has))]
    .sort((a, b) => numericLesson(a) - numericLesson(b) || a.localeCompare(b, "ru"))
    .forEach(value => select.add(new Option(formatLesson(value), value)));
  select.value = [...select.options].some(option => option.value === current) ? current : "";
}

function numericLesson(value) {
  const match = String(value).match(/\d+/);
  return match ? Number(match[0]) : 999;
}

function formatLesson(value) {
  if (!has(value)) return "";
  const number = String(value).match(/\d+/)?.[0];
  return number !== undefined ? `Урок ${number}` : String(value);
}

function populateFilters() {
  const lessons = currentCards().map(card => card.lesson);
  populateSelect($("lesson-filter"), lessons, "Все уроки");
}

function statusFor(card) {
  if (isDifficult(card.progress)) return ["hard", "Сложная"];
  if (card.progress.favorite) return ["favorite", "Избранная"];
  if (card.progress.status === "learned") return ["learned", "Выучена"];
  if (card.progress.status === "learning") return ["learning", "Изучается"];
  return ["new", "Новая"];
}

function filteredCards() {
  const query = $("search-input").value.trim().toLocaleLowerCase("ru");
  const lesson = $("lesson-filter").value;
  const status = $("status-filter").value;
  return currentCards().filter(card => {
    const fields = card.type === "word"
      ? [card.japanese, card.reading, card.meaning, card.partOfSpeech, card.exampleJp, card.exampleReading, card.exampleRu]
      : [card.kanji, card.meaning, card.meaningExtra, card.onyomi, card.kunyomi, card.components];
    const matchesQuery = !query || fields.some(value => clean(value).toLocaleLowerCase("ru").includes(query));
    const matchesStatus = !status ||
      (status === "hard" ? isDifficult(card.progress) :
        status === "favorite" ? card.progress.favorite : card.progress.status === status);
    return matchesQuery && (!lesson || card.lesson === lesson) && matchesStatus;
  });
}

function renderStats(cards) {
  const due = cards.filter(card => isDue(card.progress)).length;
  const values = [
    [cards.length, "Всего"],
    [cards.filter(card => card.progress.status === "new").length, "Новые"],
    [due, "На сегодня"],
    [cards.filter(card => card.progress.status === "learned").length, "Выучено"]
  ];
  $("stats").replaceChildren(...values.map(([value, label]) => {
    const node = el("div", "stat");
    node.append(el("strong", "", String(value)), el("span", "", label));
    return node;
  }));
}

function createMiniCard(card) {
  return card.type === "word" ? createWordMiniCard(card) : createKanjiMiniCard(card);
}

function createKanjiMiniCard(card) {
  const [status, label] = statusFor(card);
  const button = el("button", "mini-card kanji-mini-card");
  button.type = "button";
  button.setAttribute("aria-label", `${card.kanji}: ${card.meaning || "без значения"}`);
  const dot = el("span", `status-dot ${status}`);
  dot.title = label;
  button.append(dot, el("span", "mini-kanji", card.kanji), el("strong", "", card.meaning || "Без значения"));
  if (card.kunyomi) button.append(el("small", "", card.kunyomi));
  if (card.lesson || card.jlpt) button.append(el("em", "", [formatLesson(card.lesson), card.jlpt].filter(has).join(" · ")));
  button.addEventListener("click", () => openCard(card));
  return button;
}

function createWordMiniCard(card) {
  const [status, label] = statusFor(card);
  const button = el("button", "mini-card word-mini-card");
  button.type = "button";
  button.setAttribute("aria-label", `${card.japanese}: ${card.meaning || "без значения"}`);
  const top = el("div", "word-mini-top");
  const dot = el("span", `status-dot ${status}`);
  dot.title = label;
  const audio = createAudioButton(card.audio.wordUrl, "Озвучить слово", "small-audio");
  audio.addEventListener("click", event => event.stopPropagation());
  top.append(dot, audio);
  button.append(top, el("span", "mini-word", card.japanese));
  if (card.reading && card.reading !== card.japanese) button.append(el("span", "mini-reading", card.reading));
  button.append(el("strong", "", card.meaning || "Без перевода"));
  if (card.lesson || card.jlpt) button.append(el("em", "", [formatLesson(card.lesson), card.jlpt].filter(has).join(" · ")));
  button.addEventListener("click", () => openCard(card));
  return button;
}

function renderLibrary() {
  const cards = currentCards();
  renderStats(cards);
  const filtered = filteredCards();
  $("library-total").textContent = String(filtered.length);
  const grid = $("library-grid");
  grid.classList.toggle("word-grid", state.deck === "words");
  grid.replaceChildren(...filtered.map(createMiniCard));
  const empty = $("library-empty");
  empty.hidden = filtered.length > 0;
  if (!filtered.length) empty.textContent = cards.length ? "По этим условиям ничего не найдено." : `В таблице пока нет активных ${state.deck === "words" ? "слов" : "кандзи"}.`;
}

function getTodayQueue() {
  const cards = currentCards();
  const reviews = buildReviewQueue(cards);
  const settings = readSettings();
  const newCards = cards.filter(card => card.progress.status === "new" && !card.progress.reviews);
  const ids = getDailyNewIds(state.deck, newCards.map(card => card.storageId), settings.dailyLimit);
  const selected = new Set(ids);
  const dailyNew = newCards.filter(card => selected.has(card.storageId));
  const reviewIds = new Set(reviews.map(card => card.storageId));
  return [...reviews, ...dailyNew.filter(card => !reviewIds.has(card.storageId))];
}

function renderToday() {
  const cards = currentCards();
  const queue = getTodayQueue();
  const reviewCount = queue.filter(card => card.progress.status !== "new" || card.progress.reviews).length;
  const newCount = queue.length - reviewCount;
  const learned = cards.filter(card => card.progress.status === "learned").length;
  const summary = $("today-summary");
  summary.replaceChildren(
    summaryTile(queue.length, "Всего сегодня", "今日"),
    summaryTile(reviewCount, "Повторить", "復習"),
    summaryTile(newCount, "Новые", "新しい"),
    summaryTile(learned, "Выучено", "習得")
  );
  const start = $("start-today");
  const empty = $("today-empty");
  start.disabled = !queue.length;
  start.textContent = queue.length ? `Начать · ${queue.length}` : "На сегодня всё";
  empty.hidden = queue.length > 0;
  if (!queue.length) empty.textContent = "Отлично! На сегодня карточек больше нет.";
  renderLessonOverview(cards);
}

function summaryTile(value, label, jp) {
  const node = el("div", "today-tile");
  node.append(el("small", "", jp), el("strong", "", String(value)), el("span", "", label));
  return node;
}

function renderLessonOverview(cards) {
  const groups = groupByLesson(cards);
  const container = $("lesson-overview");
  container.replaceChildren();
  if (!groups.length) return;
  container.append(el("h3", "", "По урокам"));
  groups.slice(0, 5).forEach(group => {
    const row = el("div", "lesson-row");
    const heading = el("div", "lesson-row-head");
    heading.append(el("strong", "", formatLesson(group.lesson)), el("span", "", `${group.learned} из ${group.total}`));
    const track = el("div", "progress-track");
    const fill = el("span", "progress-fill");
    fill.style.width = `${group.total ? Math.round(group.learned / group.total * 100) : 0}%`;
    track.append(fill);
    row.append(heading, track);
    container.append(row);
  });
}

function groupByLesson(cards) {
  const map = new Map();
  cards.forEach(card => {
    const key = card.lesson || "Без урока";
    const group = map.get(key) || { lesson: key, total: 0, learned: 0, learning: 0, newCount: 0 };
    group.total += 1;
    if (card.progress.status === "learned") group.learned += 1;
    else if (card.progress.status === "learning") group.learning += 1;
    else group.newCount += 1;
    map.set(key, group);
  });
  return [...map.values()].sort((a, b) => numericLesson(a.lesson) - numericLesson(b.lesson));
}

function addInfoSection(parent, title, pairs) {
  const visible = pairs.filter(([, value]) => has(value));
  if (!visible.length) return;
  const section = el("section", "card-section");
  section.append(el("h4", "", title));
  const grid = el("div", "info-grid");
  visible.forEach(([label, value]) => {
    const pair = el("div", "info-pair");
    pair.append(el("span", "", label), el("strong", "", value));
    grid.append(pair);
  });
  section.append(grid);
  parent.append(section);
}

function addEntryList(parent, title, items, sentence = false) {
  const visible = items.filter(item => has(item.main));
  if (!visible.length) return;
  const section = el("section", "card-section");
  section.append(el("h4", "", title));
  const list = el("div", sentence ? "sentence-list" : "word-strip");
  visible.forEach(item => {
    const row = el("div", sentence ? "sentence" : "word-row");
    row.append(el("span", "word-main", item.main));
    if (item.reading) row.append(el("span", "reading", item.reading));
    if (item.translation) row.append(el("span", "translation", item.translation));
    list.append(row);
  });
  section.append(list);
  parent.append(section);
}

function createFullCard(card, { interactive = true, session = false } = {}) {
  return card.type === "word" ? createWordFullCard(card, { interactive, session }) : createKanjiFullCard(card, { interactive, session });
}

function createKanjiFullCard(card, { interactive = true, session = false } = {}) {
  const root = el("article", `full-card kanji-full-card${session ? " session-card" : ""}`);
  const hero = el("header", "kanji-hero swipe-handle");
  hero.append(el("div", "kanji-glyph", card.kanji));
  if (card.kunyomi) hero.append(el("span", "hero-reading", card.kunyomi.split(/[、,・]/)[0]));
  hero.append(el("h3", "", card.meaning || "Без значения"));
  if (card.meaningExtra) hero.append(el("p", "", card.meaningExtra));
  root.append(hero);
  addInfoSection(root, "Чтения", [["Онъёми", card.onyomi], ["Кунъёми", card.kunyomi]]);
  addEntryList(root, "Примеры слов", card.words);
  if (card.imageUrl) {
    const section = el("section", "card-section");
    section.append(el("h4", "", "Мнемоника и происхождение"));
    const frame = el("div", "image-frame");
    frame.append(el("span", "", "Загрузка изображения…"));
    const img = el("img");
    img.src = card.imageUrl;
    img.alt = `Мнемоника и происхождение: ${card.kanji}`;
    img.loading = "lazy";
    img.addEventListener("load", () => frame.classList.add("loaded"));
    img.addEventListener("error", () => { frame.classList.add("failed"); frame.firstChild.textContent = "Изображение временно недоступно."; });
    frame.append(img);
    section.append(frame);
    root.append(section);
  }
  addEntryList(root, "Примеры предложений", card.examples, true);
  addInfoSection(root, "Справка", [["Компоненты", card.components], ["Количество черт", card.strokeCount]]);
  root.append(createCardFooter(card, interactive));
  return root;
}

function createWordFullCard(card, { interactive = true, session = false } = {}) {
  const root = el("article", `full-card word-full-card${session ? " session-card" : ""}`);
  const hero = el("header", "word-hero swipe-handle");
  const audio = createAudioButton(card.audio.wordUrl, "Озвучить слово", "hero-audio");
  hero.append(audio, el("div", "word-glyph", card.japanese));
  if (card.reading && card.reading !== card.japanese) hero.append(el("span", "word-reading", card.reading));
  hero.append(el("h3", "", card.meaning || "Без перевода"));
  if (card.partOfSpeech) hero.append(el("p", "", card.partOfSpeech));
  root.append(hero);

  if (card.exampleJp) {
    const section = el("section", "card-section example-card-section");
    const heading = el("div", "section-title-row");
    heading.append(el("h4", "", "Пример"), createAudioButton(card.audio.exampleUrl || card.audio.example || card.exampleReading || card.exampleJp, "Озвучить пример", "small-audio"));
    section.append(heading, el("p", "example-jp", card.exampleJp));
    if (card.exampleReading && card.exampleReading !== card.exampleJp) section.append(el("p", "example-reading", card.exampleReading));
    if (card.exampleRu) section.append(el("p", "example-ru", card.exampleRu));
    root.append(section);
  }

  root.append(createCardFooter(card, interactive));
  return root;
}

function createCardFooter(card, interactive) {
  const footer = el("section", "card-section card-footer");
  const tags = el("div", "card-meta");
  [formatLesson(card.lesson), card.jlpt].filter(has).forEach(value => tags.append(el("span", "tag", value)));
  footer.append(tags);
  if (interactive) {
    const fav = el("button", "secondary-button favorite-button", card.progress.favorite ? "★ В избранном" : "☆ В избранное");
    fav.type = "button";
    fav.addEventListener("click", () => {
      card.progress = toggleFavorite(card.storageId);
      fav.textContent = card.progress.favorite ? "★ В избранном" : "☆ В избранное";
      if (state.route === "library") renderLibrary();
    });
    footer.append(fav);
  }
  footer.append(el("p", "progress-copy", progressText(card.progress)));
  return footer;
}

function progressText(progress) {
  if (!progress.reviews) return "Карточка ещё не изучалась.";
  if (progress.controlPassed) return "Контроль пройден. Карточка закреплена.";
  if (progress.status === "learned") return `Выучено · контроль ${formatDate(progress.nextReview)}`;
  const rate = Math.round((Number(progress.correct || 0) / Number(progress.reviews || 1)) * 100);
  return `Повторений: ${progress.reviews} · Успешность: ${rate}% · Следующее: ${formatDate(progress.nextReview)}`;
}

function openCard(card) {
  $("dialog-content").replaceChildren(createFullCard(card));
  $("dialog-title").textContent = card.type === "word" ? card.japanese : `${card.kanji} · ${card.meaning || "Карточка"}`;
  openDialog($("card-dialog"));
}

function openDialog(dialog) {
  document.body.style.overflow = "hidden";
  dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
  document.body.style.overflow = "";
}

function startTodaySession() {
  startSession("today", getTodayQueue());
}

function startSession(mode, cards) {
  if (!cards.length) return;
  state.session = {
    mode,
    queue: [...cards],
    index: 0,
    revealed: false,
    locked: false,
    repeatedThisRun: new Set(),
    stats: { again: 0, later: 0 }
  };
  routeTo("session");
  $("session-title").textContent = mode === "hard" ? "Сложные" : "Сегодня";
  $("session-kicker").textContent = state.deck === "words" ? "Слова" : "Кандзи";
  renderSession();
}

function renderSession() {
  const session = state.session;
  const content = $("session-content");
  if (!session || session.index >= session.queue.length) {
    renderCompletion();
    return;
  }
  const card = session.queue[session.index];
  $("session-progress").textContent = `${session.index + 1} из ${session.queue.length}`;
  if (!session.revealed) {
    const prompt = el("div", `study-prompt ${card.type === "word" ? "word-study-prompt" : ""}`);
    const label = el("span", "prompt-label", card.type === "word" ? formatLesson(card.lesson) : "Кандзи");
    const glyph = el("div", card.type === "word" ? "study-word" : "study-kanji", card.type === "word" ? card.japanese : card.kanji);
    prompt.append(label, glyph);
    if (card.type === "word") prompt.append(createAudioButton(card.audio.wordUrl, "Озвучить слово", "prompt-audio"));
    prompt.append(el("p", "", card.type === "word" ? "Вспомните чтение и перевод" : "Назовите значение и чтение"));
    const reveal = el("button", "primary-button reveal-button", "Показать ответ");
    reveal.type = "button";
    reveal.addEventListener("click", () => { session.revealed = true; renderSession(); });
    prompt.append(reveal);
    content.replaceChildren(prompt);
    return;
  }

  const cardNode = createFullCard(card, { interactive: false, session: true });
  addSwipeHandling(cardNode, card);
  const actions = el("div", "answer-bar");
  Object.entries(RESULTS).forEach(([result, meta]) => {
    const button = el("button", `answer-button ${meta.tone}`);
    button.type = "button";
    button.dataset.result = result;
    button.append(el("strong", "", meta.label), el("small", "", meta.hint));
    button.addEventListener("click", () => rateCard(card, result));
    actions.append(button);
  });
  const swipeNote = el("p", "swipe-note", "На карточке: вниз — повторить, вверх — повторить позже");
  content.replaceChildren(cardNode, swipeNote, actions);

  if (readSettings().autoAudio && card.type === "word" && has(card.audio.wordUrl)) {
    setTimeout(() => speakJapanese(card.audio.wordUrl), 180);
  }
}

function addSwipeHandling(cardNode, card) {
  const handle = cardNode.querySelector(".swipe-handle");
  if (!handle) return;
  let startY = null;
  let startX = null;
  handle.addEventListener("touchstart", event => {
    const touch = event.touches[0];
    startY = touch.clientY;
    startX = touch.clientX;
    cardNode.classList.add("swiping");
  }, { passive: true });
  handle.addEventListener("touchmove", event => {
    if (startY === null) return;
    const touch = event.touches[0];
    const deltaY = touch.clientY - startY;
    const deltaX = touch.clientX - startX;
    if (Math.abs(deltaY) > Math.abs(deltaX)) {
      const limited = Math.max(-110, Math.min(110, deltaY));
      cardNode.style.transform = `translateY(${limited * 0.18}px) rotate(${limited * 0.015}deg)`;
    }
  }, { passive: true });
  handle.addEventListener("touchend", event => {
    if (startY === null) return;
    const touch = event.changedTouches[0];
    const deltaY = touch.clientY - startY;
    const deltaX = touch.clientX - startX;
    cardNode.style.transform = "";
    cardNode.classList.remove("swiping");
    startY = null;
    startX = null;
    if (Math.abs(deltaY) < 85 || Math.abs(deltaY) < Math.abs(deltaX)) return;
    rateCard(card, deltaY > 0 ? "again" : "later");
  }, { passive: true });
}

function rateCard(card, result) {
  const session = state.session;
  if (!session || session.locked) return;
  session.locked = true;
  document.querySelectorAll(".answer-button").forEach(button => { button.disabled = true; });
  card.progress = scheduleReview(card.progress, result);
  saveProgress(card.progress);
  session.stats[result] += 1;
  if (result === "again" && !session.repeatedThisRun.has(card.storageId)) {
    const insertAt = Math.min(session.queue.length, session.index + 4);
    session.queue.splice(insertAt, 0, card);
    session.repeatedThisRun.add(card.storageId);
  }
  showToast(`Сохранено: ${RESULTS[result].label}`);
  setTimeout(() => {
    session.index += 1;
    session.revealed = false;
    session.locked = false;
    renderSession();
  }, 360);
}

function renderCompletion() {
  if (dataSync.applyPending()) return;
  const session = state.session;
  $("session-progress").textContent = "";
  const box = el("div", "completion");
  box.append(el("div", "completion-mark", "✓"), el("h3", "", "Сессия завершена"));
  const originalCount = session ? session.queue.length : 0;
  box.append(el("p", "", `Просмотрено карточек: ${originalCount}`));
  const stats = el("div", "completion-stats");
  stats.append(el("span", "", `Повторить: ${session?.stats.again || 0}`), el("span", "", `Позже: ${session?.stats.later || 0}`));
  const back = el("button", "primary-button", "На главный экран");
  back.type = "button";
  back.addEventListener("click", () => { state.session = null; routeTo("today"); });
  box.append(stats, back);
  $("session-content").replaceChildren(box);
}

function startQuiz(mistakes = null) {
  dataSync.applyPending();
  const questions = state.quizEngine
    ? mistakes ? state.quizEngine.generateMistakeQuiz(mistakes) : state.quizEngine.generateQuiz(30, null, readQuizProgress())
    : [];
  state.quiz = questions.length ? { questions, index: 0, correct: 0, selected: null, mistakes: [] } : null;
  routeTo("quiz");
}

function addQuizFact(parent, label, value) {
  if (!has(value)) return;
  const row = el("div", "quiz-fact");
  row.append(el("span", "quiz-fact-label", label), el("strong", "quiz-fact-value", value));
  parent.append(row);
}

function uniqueFeedbackExamples(feedback) {
  const result = [];
  const seen = new Set();
  const add = entry => {
    if (!entry || !has(entry.form)) return;
    const id = `${clean(entry.form)}|${clean(entry.reading)}`;
    if (seen.has(id)) return;
    seen.add(id);
    result.push(entry);
  };
  if (feedback?.focusWord) add(feedback.focusWord);
  (feedback?.words || []).forEach(add);
  return result.slice(0, 2);
}

function renderQuizFeedback(question, correct) {
  const feedback = el("div", `quiz-feedback ${correct ? "correct" : "incorrect"}`);
  feedback.append(el("strong", "quiz-feedback-status", correct ? "✅ Правильно" : "❌ Неправильно"));
  feedback.append(el("p", "quiz-correct-answer", `Правильный ответ: ${question.answer}`));

  const info = question.feedback;
  if (!info) {
    feedback.append(el("small", "", quizSourceSummary(question.source)));
    return feedback;
  }

  if (info.kind === "kanji") {
    const overview = el("div", "quiz-learning-block");
    const title = el("div", "quiz-learning-title");
    title.append(el("strong", "quiz-learning-form", info.kanji));
    if (info.meaning) title.append(el("span", "quiz-learning-meaning", info.meaning));
    overview.append(title);

    const readings = el("div", "quiz-reading-grid");
    addQuizFact(readings, "Онъёми · справка", (info.onyomi || []).join("・") || "—");
    addQuizFact(readings, "Кунъёми · справка", (info.kunyomi || []).join("・") || "—");
    overview.append(readings);

    const examples = uniqueFeedbackExamples(info);
    if (!examples.length) overview.append(el("p", "quiz-learning-caption", "Чтение закрепим, когда изучим слово с этим кандзи."));
    if (examples.length) {
      overview.append(el("div", "quiz-learning-caption", "Примеры"));
      const list = el("div", "quiz-feedback-examples");
      examples.forEach(example => {
        const row = el("div", "quiz-feedback-example");
        const jp = example.reading && clean(example.reading) !== clean(example.form)
          ? `${example.form}（${example.reading}）`
          : example.form;
        row.append(el("strong", "", jp));
        if (example.meaning) row.append(el("span", "", example.meaning));
        list.append(row);
      });
      overview.append(list);
    }

    const sentence = info.focusWord?.exampleJp
      ? { form: info.focusWord.exampleJp, reading: info.focusWord.exampleReading, meaning: info.focusWord.exampleRu }
      : (info.examples || [])[0];
    if (sentence?.form) {
      overview.append(el("div", "quiz-learning-caption", "В контексте"));
      const sentenceNode = el("div", "quiz-feedback-sentence");
      sentenceNode.append(el("strong", "", sentence.form));
      if (sentence.reading && clean(sentence.reading) !== clean(sentence.form)) sentenceNode.append(el("span", "quiz-example-reading", sentence.reading));
      if (sentence.meaning) sentenceNode.append(el("span", "quiz-example-meaning", sentence.meaning));
      overview.append(sentenceNode);
    }
    feedback.append(overview);
    return feedback;
  }

  const overview = el("div", "quiz-learning-block");
  const title = el("div", "quiz-word-summary");
  const showReading = info.reading
    && clean(info.reading) !== clean(info.form)
    && !sameKanaPronunciation(info.form, info.reading);
  const form = showReading ? `${info.form}（${info.reading}）` : info.form;
  title.append(el("strong", "quiz-word-form", form));
  if (info.meaning) title.append(el("span", "quiz-learning-meaning", info.meaning));
  overview.append(title);

  if (info.exampleJp) {
    overview.append(el("div", "quiz-learning-caption", "Пример"));
    const sentence = el("div", "quiz-feedback-sentence");
    sentence.append(el("strong", "", info.exampleJp));
    if (info.exampleReading && clean(info.exampleReading) !== clean(info.exampleJp)) sentence.append(el("span", "quiz-example-reading", info.exampleReading));
    if (info.exampleRu) sentence.append(el("span", "quiz-example-meaning", info.exampleRu));
    overview.append(sentence);
  }
  feedback.append(overview);
  return feedback;
}

function renderQuiz() {
  const content = $("quiz-content");
  content.replaceChildren();
  const quiz = state.quiz;
  $("quiz-kicker").textContent = quiz ? `${quiz.questions.length} вопросов` : "30 вопросов";
  if (!quiz) {
    content.append(el("div", "empty-state", "Недостаточно активных карточек для квиза. Добавьте или активируйте ещё кандзи и слова."));
    const start = el("button", "primary-button quiz-action", "Начать квиз");
    start.type = "button";
    start.addEventListener("click", () => startQuiz());
    content.append(start);
    return;
  }
  const total = quiz.questions.length;
  if (quiz.index >= total) { renderQuizResult(); return; }
  const question = quiz.questions[quiz.index];
  const top = el("div", "quiz-top");
  top.append(el("strong", "", `${quiz.index + 1} / ${total}`), el("span", "", `Правильно: ${quiz.correct}`));
  const progress = el("div", "quiz-progress");
  const fill = el("span", "");
  fill.style.width = `${(quiz.index / total) * 100}%`;
  progress.append(fill);
  const card = el("div", "quiz-question");
  const promptLabel = question.label || (question.type.endsWith("_from_meaning") || question.type.endsWith("_from_reading")
    ? `Выберите ${question.kind === "kanji" ? "кандзи" : "слово"}`
    : question.type.endsWith("_meaning") ? "Что означает?" : "Как читается?");
  card.append(el("p", "eyebrow", promptLabel), el("strong", "quiz-prompt", question.prompt));
  const answers = el("div", "quiz-answers");
  question.choices.forEach((choice, index) => {
    const button = el("button", "quiz-answer");
    button.type = "button";
    button.append(el("span", "quiz-letter", "ABCD"[index]), el("span", "", choice));
    if (quiz.selected !== null) {
      button.disabled = true;
      if (index === question.correctIndex) button.classList.add("correct");
      else if (index === quiz.selected) button.classList.add("incorrect");
    }
    button.addEventListener("click", () => answerQuiz(index));
    answers.append(button);
  });
  content.append(top, progress, card, answers);
  if (quiz.selected !== null) {
    const correct = quiz.selected === question.correctIndex;
    const feedback = renderQuizFeedback(question, correct);
    const next = el("button", "primary-button quiz-action", quiz.index === total - 1 ? "Посмотреть результат" : "Следующий вопрос");
    next.type = "button";
    next.addEventListener("click", () => { quiz.index += 1; quiz.selected = null; renderQuiz(); window.scrollTo(0, 0); });
    content.append(feedback, next);
  }
}

function answerQuiz(index) {
  const quiz = state.quiz;
  if (!quiz || quiz.selected !== null) return;
  const question = quiz.questions[quiz.index];
  quiz.selected = index;
  const correct = index === question.correctIndex;
  recordQuizAnswer(question, correct);
  if (correct) quiz.correct += 1;
  else quiz.mistakes.push({ ...question, selectedAnswer: question.choices[index] });
  renderQuiz();
}

function renderQuizResult() {
  if (dataSync.applyPending()) return;
  const quiz = state.quiz;
  const total = quiz.questions.length;
  const box = el("div", "completion quiz-result");
  box.append(el("span", "completion-mark", `${Math.round(quiz.correct / total * 100)}%`), el("h3", "", "Квиз завершён"), el("p", "", `${quiz.correct} / ${total}`));
  const stats = el("div", "completion-stats");
  stats.append(el("span", "", `Правильно: ${quiz.correct}`), el("span", "", `Ошибок: ${quiz.mistakes.length}`));
  box.append(stats);
  if (quiz.mistakes.length) {
    box.append(el("h4", "", "Ошибки"));
    quiz.mistakes.forEach(mistake => {
      const row = el("div", "quiz-mistake");
      row.append(el("strong", "", mistake.prompt), el("span", "", `Ваш ответ: ${mistake.selectedAnswer}`), el("span", "", `Правильно: ${mistake.answer}`), el("small", "", quizSourceSummary(mistake.source)));
      box.append(row);
    });
    const retry = el("button", "secondary-button quiz-action", "Повторить ошибки");
    retry.type = "button";
    retry.addEventListener("click", () => startQuiz(quiz.mistakes));
    box.append(retry);
  } else box.append(el("p", "", "Все ответы правильные 🎉"));
  const restart = el("button", "primary-button quiz-action", "Начать новый квиз");
  restart.type = "button";
  restart.addEventListener("click", () => startQuiz());
  box.append(restart);
  $("quiz-content").append(box);
}

function renderProgress() {
  const cards = currentCards();
  const learned = cards.filter(card => card.progress.status === "learned").length;
  const learning = cards.filter(card => card.progress.status === "learning").length;
  const newCount = cards.filter(card => card.progress.status === "new").length;
  const difficult = cards.filter(card => isDifficult(card.progress)).length;
  const values = [[learned, "Выучено"], [learning, "Изучается"], [newCount, "Новые"], [difficult, "Сложные"]];
  $("progress-summary").replaceChildren(...values.map(([value, label]) => {
    const node = el("div", "stat");
    node.append(el("strong", "", String(value)), el("span", "", label));
    return node;
  }));
  const container = $("progress-lessons");
  container.replaceChildren(...groupByLesson(cards).map(group => {
    const card = el("div", "progress-lesson-card");
    const top = el("div", "progress-lesson-top");
    const percent = group.total ? Math.round(group.learned / group.total * 100) : 0;
    top.append(el("div", "", formatLesson(group.lesson)), el("strong", "", `${percent}%`));
    const track = el("div", "progress-track large");
    const fill = el("span", "progress-fill");
    fill.style.width = `${percent}%`;
    track.append(fill);
    const meta = el("div", "progress-lesson-meta");
    meta.append(el("span", "", `Выучено ${group.learned}`), el("span", "", `Изучается ${group.learning}`), el("span", "", `Новые ${group.newCount}`));
    card.append(top, track, meta);
    return card;
  }));
}

function quizMastered(stats) {
  const correct = Number(stats?.correct || 0);
  const mistakes = Number(stats?.mistakes || 0);
  return correct >= 2 && correct >= mistakes * 2;
}

function renderQuizProgress() {
  const catalog = state.quizEngine?.catalog || [];
  const history = readQuizProgress();
  const rows = catalog.map(item => {
    const stats = history.sources[item.coverageId] || {};
    return { ...item, seen: Number(stats.seen || 0), correct: Number(stats.correct || 0), mistakes: Number(stats.mistakes || 0) };
  });
  const total = rows.length;
  const seen = rows.filter(row => row.seen > 0);
  const unseen = rows.filter(row => row.seen === 0);
  const mastered = rows.filter(row => quizMastered(row));
  const inProgress = seen.filter(row => !quizMastered(row));
  const withMistakes = rows.filter(row => row.mistakes > 0);
  const percent = total ? Math.round(seen.length / total * 100) : 0;

  const hero = $("quiz-coverage-hero");
  hero.replaceChildren();
  const heroTop = el("div", "quiz-coverage-head");
  const main = el("div", "quiz-coverage-main");
  main.append(el("strong", "", `${seen.length} / ${total}`), el("span", "", "уже встречались в квизе"));
  heroTop.append(main, el("strong", "quiz-coverage-percent", `${percent}%`));
  const track = el("div", "progress-track large quiz-coverage-track");
  const fill = el("span", "progress-fill");
  fill.style.width = `${percent}%`;
  track.append(fill);
  hero.append(heroTop, track, el("p", "quiz-coverage-note", "Новые карточки теперь идут раньше повторов, чтобы постепенно охватить всю базу."));

  const values = [
    [mastered.length, "Освоено"],
    [inProgress.length, "В процессе"],
    [unseen.length, "Ещё не было"],
    [withMistakes.length, "С ошибками"]
  ];
  $("quiz-progress-summary").replaceChildren(...values.map(([value, label]) => {
    const node = el("div", "stat");
    node.append(el("strong", "", String(value)), el("span", "", label));
    return node;
  }));

  const kindBox = $("quiz-progress-kinds");
  kindBox.replaceChildren();
  [["kanji", "Кандзи"], ["vocabulary", "Слова"]].forEach(([kind, label]) => {
    const items = rows.filter(row => row.kind === kind);
    const kindSeen = items.filter(row => row.seen > 0).length;
    const card = el("div", "quiz-kind-card");
    const head = el("div", "quiz-kind-head");
    head.append(el("strong", "", label), el("span", "", `${kindSeen} / ${items.length}`));
    const line = el("div", "progress-track");
    const lineFill = el("span", "progress-fill");
    lineFill.style.width = `${items.length ? Math.round(kindSeen / items.length * 100) : 0}%`;
    line.append(lineFill);
    card.append(head, line);
    kindBox.append(card);
  });

  const unseenBox = $("quiz-unseen-list");
  unseenBox.replaceChildren();
  const unseenPreview = unseen.slice(0, 24);
  if (!unseenPreview.length) {
    unseenBox.append(el("div", "quiz-progress-empty", "Вся текущая база уже хотя бы раз встретилась 🎉"));
  } else {
    unseenPreview.forEach(item => {
      const chip = el("span", "quiz-source-chip");
      chip.append(el("strong", "", item.form), el("small", "", item.meaning || (item.kind === "kanji" ? "кандзи" : "слово")));
      unseenBox.append(chip);
    });
    if (unseen.length > unseenPreview.length) unseenBox.append(el("span", "quiz-source-more", `+ ещё ${unseen.length - unseenPreview.length}`));
  }

  const weakBox = $("quiz-weak-list");
  weakBox.replaceChildren();
  const weak = withMistakes.sort((a, b) => b.mistakes - a.mistakes || a.correct - b.correct).slice(0, 12);
  if (!weak.length) weakBox.append(el("div", "quiz-progress-empty", "Пока нет накопленных ошибок."));
  else weak.forEach(item => {
    const row = el("div", "quiz-weak-row");
    const text = el("div", "");
    text.append(el("strong", "", item.form), el("small", "", item.meaning || ""));
    row.append(text, el("span", "", `${item.correct} ✓ · ${item.mistakes} ✕`));
    weakBox.append(row);
  });

  const start = $("quiz-progress-start");
  start.disabled = !total;
  start.textContent = unseen.length ? `Продолжить охват · ${Math.min(30, total)} вопросов` : "Новый квиз · повторение";
}

function createAudioButton(text, label, className = "audio-button") {
  const button = el("button", `audio-button ${className}`);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = "🔊";
  button.disabled = !/\.mp3(?:$|[?#])/i.test(clean(text));
  if (button.disabled) button.title = "Озвучка пока не готова";
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    speakJapanese(text, button);
  });
  return button;
}


let currentAudio = null;

function speakJapanese(source, button = null) {
  const value = clean(source);
  if (!/\.mp3(?:$|[?#])/i.test(value)) return;

  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
  }

  const audio = new Audio(value);
  currentAudio = audio;
  audio.preload = "auto";
  if (button) button.classList.add("speaking");

  const finish = () => {
    if (button) button.classList.remove("speaking");
    if (currentAudio === audio) currentAudio = null;
  };

  audio.onended = finish;
  audio.onerror = () => {
    finish();
    showToast("MP3-файл не найден в папке genki_audio.");
  };
  audio.play().catch(() => {
    finish();
    showToast("Не удалось воспроизвести MP3.");
  });
}
function formatDate(value) {
  if (!value) return "не назначено";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: String(value).includes("T") ? "short" : undefined
  }).format(date);
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 1600);
}

function syncSettingsDialog() {
  const settings = readSettings();
  $("daily-limit").value = String(settings.dailyLimit);
  $("auto-audio").checked = settings.autoAudio;
}

function refreshProgressObjects() {
  [...state.kanji, ...state.words].forEach(card => { card.progress = getProgress(card.storageId); });
}

document.querySelectorAll("[data-deck]").forEach(button => button.addEventListener("click", () => setDeck(button.dataset.deck)));
document.querySelectorAll(".bottom-nav button").forEach(button => button.addEventListener("click", () => {
  if (button.dataset.route === "quiz" && !state.quiz) startQuiz();
  else routeTo(button.dataset.route);
}));
["search-input", "lesson-filter", "status-filter"].forEach(id => $(id).addEventListener(id === "search-input" ? "input" : "change", renderLibrary));
$("quiz-exit").addEventListener("click", () => { state.quiz = null; dataSync.applyPending(); routeTo("today"); });
$("refresh-button").addEventListener("click", () => loadCards(true));
$("start-today").addEventListener("click", startTodaySession);
$("session-exit").addEventListener("click", () => { state.session = null; dataSync.applyPending(); routeTo("today"); });
$("quiz-progress-start").addEventListener("click", () => startQuiz());
$("dialog-close").addEventListener("click", () => closeDialog($("card-dialog")));
$("settings-button").addEventListener("click", () => { syncSettingsDialog(); openDialog($("settings-dialog")); });
$("settings-close").addEventListener("click", () => closeDialog($("settings-dialog")));
[$("card-dialog"), $("settings-dialog")].forEach(dialog => dialog.addEventListener("close", () => { document.body.style.overflow = ""; }));
$("daily-limit").addEventListener("change", event => { saveSettings({ dailyLimit: Number(event.target.value) }); if (state.route === "today") renderToday(); });
$("auto-audio").addEventListener("change", event => saveSettings({ autoAudio: event.target.checked }));
$("export-button").addEventListener("click", exportProgress);
$("import-input").addEventListener("change", async event => {
  try {
    await importProgress(event.target.files[0]);
    refreshProgressObjects();
    syncSettingsDialog();
    routeTo(state.route === "session" ? "today" : state.route, false);
    $("settings-message").textContent = "Прогресс импортирован.";
  } catch (error) {
    $("settings-message").textContent = error.message;
  }
  event.target.value = "";
});
$("clear-button").addEventListener("click", () => {
  if (!confirm("Удалить весь локальный прогресс кандзи, слов и квизов? Это действие нельзя отменить.")) return;
  clearProgress();
  refreshProgressObjects();
  routeTo("today", false);
  $("settings-message").textContent = "Прогресс очищен.";
});

document.addEventListener("keydown", event => {
  const dialog = document.querySelector("dialog[open]");
  if (event.key === "Escape" && dialog) {
    event.preventDefault();
    closeDialog(dialog);
    return;
  }
  if (state.route !== "session" || !state.session) return;
  if (!state.session.revealed && (event.key === " " || event.key === "Enter")) {
    event.preventDefault();
    state.session.revealed = true;
    renderSession();
    return;
  }
  if (!state.session.revealed) return;
  const card = state.session.queue[state.session.index];
  if (event.key === "ArrowDown" || event.key === "1") rateCard(card, "again");
  if (event.key === "ArrowUp" || event.key === "2") rateCard(card, "later");
});

window.addEventListener("online", () => setBanner(state.usingCache ? "Соединение восстановлено. Нажмите «Обновить», чтобы получить свежие данные." : ""));
window.addEventListener("offline", () => setBanner("Нет сети. Доступна сохранённая версия приложения и ранее загруженные данные."));
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js?v=22").catch(error => console.warn("Service Worker не зарегистрирован", error)));

updateDeckSwitch();
loadCards();
