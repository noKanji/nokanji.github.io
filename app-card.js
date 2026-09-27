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
  saveSettings
} from "./storage.js";
import {
  scheduleReview,
  isDue,
  isDifficult,
  isMastered,
  buildReviewQueue,
  RESULTS
} from "./scheduler.js";
import { normalizeCardData } from "./data.js";
import { createQuizEngine } from "./quiz-engine.mjs";
import { loadLearningData } from "./quiz-data.mjs";

const state = {
  cards: [],
  route: "today",
  session: null,
  quiz: null,
  quizEngine: null,
  quizError: "",
  usingCache: false,
  settings: readSettings(),
  words: {
    items: [],
    deck: [],
    index: 0,
    moving: false,
    cycle: 0,
    viewed: 0
  }
};

const $ = id => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const has = value => value !== null && value !== undefined && String(value).trim() !== "";
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function normalizeItem(source) {
  const card = normalizeCardData(source);
  if (!card) return null;
  card.progress = getProgress(card.id);
  return card;
}

function normalizeItems(items) {
  const seen = new Set();
  return items.reduce((list, source) => {
    const card = normalizeItem(source);
    if (!card) return list;
    if (seen.has(card.id)) {
      console.warn(`Дублирующийся id «${card.id}» пропущен.`);
      return list;
    }
    seen.add(card.id);
    list.push(card);
    return list;
  }, []);
}

function validImageUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value, location.href);
    return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")
      ? url.href
      : null;
  } catch {
    return null;
  }
}

async function loadCards() {
  showView("loading");
  const configured = CONFIG.API_URL && CONFIG.API_URL !== "PASTE_GOOGLE_APPS_SCRIPT_URL_HERE";
  try {
    if (!configured) throw new Error("Укажите URL Google Apps Script в config-live.js.");
    const data = await loadLearningData(CONFIG.API_URL);
    state.cards = normalizeItems(data.kanji);
    state.quizEngine = createQuizEngine(data.kanji, data.words);
    state.quizError = "";
    state.usingCache = false;
    cacheLearningData(data);
    setBanner("");
  } catch (error) {
    const cached = readCachedLearningData();
    if (cached) {
      const cachedData = Array.isArray(cached.items) ? { kanji: cached.items, words: null } : cached.items;
      state.cards = normalizeItems(cachedData.kanji || []);
      state.quizEngine = cachedData.words ? createQuizEngine(cachedData.kanji, cachedData.words) : null;
      state.quizError = state.quizEngine ? "" : "Квиз недоступен без данных листа «Слова».";
      state.usingCache = true;
      setBanner(`Источник временно недоступен. Показана сохранённая версия от ${formatDate(cached.savedAt)}.`);
      console.warn(error);
    } else {
      state.cards = [];
      state.quizEngine = null;
      state.quizError = error.message;
      setBanner(error.message, true);
    }
  }

  initializeWordDeck();
  populateFilters();
  syncSettingsControls();
  routeTo("today");
}

function setBanner(message, isError = false) {
  const banner = $("offline-banner");
  banner.hidden = !message;
  banner.textContent = message;
  banner.classList.toggle("error", isError);
}

function showView(name) {
  document.querySelectorAll(".view").forEach(view => {
    view.classList.toggle("active", view.id === `${name}-view`);
  });
}

function routeTo(route) {
  state.route = route;
  document.body.classList.toggle("session-active", route === "session");
  document.body.classList.toggle("words-active", route === "words");
  document.querySelectorAll(".bottom-nav button").forEach(button => {
    button.classList.toggle("active", button.dataset.route === route);
  });

  if (route === "today") {
    showView("today");
    renderToday();
  } else if (route === "library") {
    showView("library");
    renderLibrary();
  } else if (route === "words") {
    showView("words");
    renderWords();
  } else if (route === "quiz") {
    showView("quiz");
    renderQuiz();
  } else if (route === "progress") {
    showView("progress");
    renderProgress();
  } else if (route === "session") {
    showView("session");
  }

  window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
}

function populateSelect(select, values, firstLabel) {
  const current = select.value;
  select.replaceChildren(new Option(firstLabel, ""));
  [...new Set(values.filter(has))]
    .sort((a, b) => a.localeCompare(b, "ru"))
    .forEach(value => select.add(new Option(value, value)));
  select.value = [...select.options].some(option => option.value === current) ? current : "";
}

function populateFilters() {
  const jlpt = state.cards.map(card => card.jlpt);
  const lessons = state.cards.map(card => card.lesson);
  populateSelect($("jlpt-filter"), jlpt, "Все JLPT");
  populateSelect($("lesson-filter"), lessons, "Все уроки");
}


function buildWordItems(cards) {
  const grouped = new Map();

  cards.forEach(card => {
    card.wordItems.forEach(item => {
      if (!has(item.main)) return;
      const main = String(item.main).trim();
      const reading = String(item.reading || "").trim();
      const translation = String(item.translation || "").trim();
      const key = [main, reading, translation].join("\u241f").toLocaleLowerCase("ja");

      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          main,
          reading,
          translation,
          lessons: new Set(),
          jlpt: new Set(),
          sources: new Set()
        });
      }

      const word = grouped.get(key);
      if (has(card.lesson)) word.lessons.add(card.lesson);
      if (has(card.jlpt)) word.jlpt.add(card.jlpt);
      if (has(card.kanji)) word.sources.add(card.kanji);
    });
  });

  return [...grouped.values()].map(word => ({
    ...word,
    lessons: [...word.lessons],
    jlpt: [...word.jlpt],
    sources: [...word.sources]
  }));
}

function shuffled(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function initializeWordDeck() {
  const items = buildWordItems(state.cards);
  state.words.items = items;
  state.words.deck = shuffled(items);
  state.words.index = 0;
  state.words.moving = false;
  state.words.cycle = 0;
  state.words.viewed = 0;
}

function currentWord(offset = 0) {
  const deck = state.words.deck;
  if (!deck.length) return null;
  return deck[(state.words.index + offset) % deck.length];
}

function wordCountLabel(count) {
  const remainder100 = count % 100;
  const remainder10 = count % 10;
  if (remainder100 >= 11 && remainder100 <= 14) return `${count} слов`;
  if (remainder10 === 1) return `${count} слово`;
  if (remainder10 >= 2 && remainder10 <= 4) return `${count} слова`;
  return `${count} слов`;
}

function wordMeta(word) {
  return [word.lessons[0], word.jlpt[0]].filter(has).join(" · ");
}

function createWordStackCard(word, depth) {
  const card = el("article", `word-stack-card word-depth-${depth}`);
  card.dataset.depth = String(depth);
  card.style.setProperty("--depth", String(depth));
  card.setAttribute(
    "aria-label",
    [word.main, word.reading, word.translation].filter(has).join(", ")
  );

  const top = el("div", "word-card-top");
  const jlpt = word.jlpt[0] || "単語";
  top.append(el("span", "word-level-badge", jlpt));
  const meta = word.lessons[0] || "";
  if (meta) top.append(el("span", "word-lesson", meta));
  card.append(top);

  const content = el("div", "word-card-content");
  if (word.reading) content.append(el("span", "word-card-reading", word.reading));

  const mainClass = word.main.length >= 9
    ? "word-card-main word-card-main-long"
    : word.main.length >= 6
      ? "word-card-main word-card-main-medium"
      : "word-card-main";
  content.append(el("strong", mainClass, word.main));

  if (word.translation) {
    content.append(el("span", "word-card-translation", word.translation));
  } else {
    content.append(el("span", "word-card-translation word-card-empty", "Без перевода"));
  }
  card.append(content);

  const footer = el("div", "word-card-footer");
  const source = word.sources.slice(0, 3).join(" · ");
  footer.append(
    el("span", "", source ? `Кандзи: ${source}` : "Из словаря карточек"),
    el("span", "word-up-mark", "↑")
  );
  card.append(footer);

  return card;
}

function renderWords() {
  const stack = $("word-stack");
  const count = state.words.items.length;
  $("words-count").textContent = wordCountLabel(count);
  $("words-viewed").textContent = `пролистано ${state.words.viewed}`;

  if (!count) {
    stack.replaceChildren(el("div", "empty-state word-empty", "В карточках пока нет примеров слов."));
    $("words-next").disabled = true;
    $("words-shuffle").disabled = true;
    return;
  }

  $("words-next").disabled = false;
  $("words-shuffle").disabled = count < 2;

  const visibleCount = Math.min(3, count);
  const cards = [];
  for (let depth = visibleCount - 1; depth >= 0; depth -= 1) {
    const word = currentWord(depth);
    if (!word) continue;
    cards.push(createWordStackCard(word, depth));
  }

  stack.replaceChildren(...cards);
  const stage = $("word-stack-stage");
  stage.classList.remove("advancing");
  stage.style.setProperty("--word-progress", "0");

  const topCard = stack.querySelector('.word-stack-card[data-depth="0"]');
  if (topCard) attachWordStackSwipe(topCard);
}

function resetWordDrag(card) {
  const stage = $("word-stack-stage");
  card.style.transition = reducedMotion()
    ? "none"
    : "transform .34s cubic-bezier(.22,.8,.25,1), opacity .25s ease, box-shadow .25s ease";
  card.style.transform = "";
  card.style.opacity = "";
  card.classList.remove("dragging");
  stage.style.setProperty("--word-progress", "0");
  window.setTimeout(() => {
    if (card.isConnected) card.style.transition = "";
  }, reducedMotion() ? 0 : 360);
}

function advanceWordStack(card = null, driftX = 0) {
  if (state.words.moving || !state.words.deck.length) return;
  state.words.moving = true;

  const stage = $("word-stack-stage");
  const activeCard = card || $("word-stack").querySelector('.word-stack-card[data-depth="0"]');
  stage.classList.add("advancing");
  stage.style.setProperty("--word-progress", "1");

  if (activeCard) {
    const exitX = Math.max(-70, Math.min(70, driftX * 1.35));
    const rotation = Math.max(-7, Math.min(7, driftX / 14));
    activeCard.classList.remove("dragging");
    activeCard.style.transition = reducedMotion()
      ? "none"
      : "transform .34s cubic-bezier(.32,.02,.2,1), opacity .26s ease";
    requestAnimationFrame(() => {
      activeCard.style.transform = `translate3d(${exitX}px, -115vh, 0) rotate(${rotation}deg) scale(.97)`;
      activeCard.style.opacity = "0";
    });
  }

  const delay = reducedMotion() ? 20 : 330;
  window.setTimeout(() => {
    const lastWord = currentWord(0);
    state.words.index += 1;
    state.words.viewed += 1;

    if (state.words.index >= state.words.deck.length) {
      const lastKey = lastWord?.key;
      state.words.deck = shuffled(state.words.items);
      if (
        state.words.deck.length > 1 &&
        state.words.deck[0]?.key === lastKey
      ) {
        [state.words.deck[0], state.words.deck[1]] = [state.words.deck[1], state.words.deck[0]];
      }
      state.words.index = 0;
      state.words.cycle += 1;
    }

    state.words.moving = false;
    if (state.route === "words") renderWords();
  }, delay);
}

function attachWordStackSwipe(card) {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let deltaX = 0;
  let deltaY = 0;
  let vertical = false;

  card.addEventListener("pointerdown", event => {
    if (state.words.moving) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startTime = performance.now();
    deltaX = 0;
    deltaY = 0;
    vertical = false;
    card.classList.add("dragging");
    card.setPointerCapture?.(pointerId);
  });

  card.addEventListener("pointermove", event => {
    if (event.pointerId !== pointerId || state.words.moving) return;
    const rawX = event.clientX - startX;
    const rawY = event.clientY - startY;

    if (!vertical && Math.max(Math.abs(rawX), Math.abs(rawY)) > 8) {
      vertical = Math.abs(rawY) >= Math.abs(rawX) * .78;
    }
    if (!vertical) return;

    event.preventDefault();
    deltaX = Math.max(-42, Math.min(42, rawX * .22));
    deltaY = rawY < 0
      ? Math.max(-280, rawY)
      : Math.min(42, rawY * .24);

    const progress = Math.max(0, Math.min(1, -deltaY / 150));
    const rotation = deltaX / 18;
    const scale = 1 - progress * .025;
    card.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0) rotate(${rotation}deg) scale(${scale})`;
    card.style.opacity = String(1 - progress * .12);
    $("word-stack-stage").style.setProperty("--word-progress", String(progress));
  });

  const finish = event => {
    if (event.pointerId !== pointerId) return;
    card.releasePointerCapture?.(pointerId);
    pointerId = null;

    const elapsed = Math.max(1, performance.now() - startTime);
    const velocityY = deltaY / elapsed;
    const shouldAdvance = vertical && (deltaY <= -76 || velocityY <= -.48);

    if (shouldAdvance) {
      advanceWordStack(card, deltaX);
    } else {
      resetWordDrag(card);
    }
  };

  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);
}

function shuffleWords() {
  if (state.words.items.length < 2 || state.words.moving) return;
  const currentKey = currentWord(0)?.key;
  state.words.deck = shuffled(state.words.items);
  if (state.words.deck[0]?.key === currentKey) {
    [state.words.deck[0], state.words.deck[1]] = [state.words.deck[1], state.words.deck[0]];
  }
  state.words.index = 0;
  state.words.cycle += 1;
  state.words.viewed = 0;
  renderWords();
  showToast("Стопка перемешана");
}

function primaryReading(card) {
  const value = card.kunyomi || card.onyomi || "";
  return value.split(/[、,・,/]/).map(part => part.trim()).filter(Boolean)[0] || "";
}

function statusFor(card) {
  if (isDifficult(card.progress)) return ["hard", "Сложная"];
  if (isMastered(card.progress)) return ["mastered", "Выучена"];
  if (card.progress.status === "learning") return ["learning", "Изучается"];
  return ["new", "Новая"];
}

function createMiniCard(card) {
  const [status, label] = statusFor(card);
  const button = el("button", "mini-card");
  button.type = "button";
  button.setAttribute("aria-label", `${card.kanji}: ${card.meaning || "без значения"}. ${label}`);

  const top = el("div", "mini-card-top");
  top.append(el("span", `status-badge ${status}`, label));
  if (card.progress.favorite) top.append(el("span", "favorite-mark", "★"));

  button.append(top, el("span", "mini-kanji", card.kanji), el("strong", "mini-meaning", card.meaning || "Без значения"));
  const reading = primaryReading(card);
  if (reading) button.append(el("small", "mini-reading", reading));

  const meta = [card.lesson, card.jlpt].filter(has).join(" · ");
  if (meta) button.append(el("em", "mini-meta", meta));

  button.addEventListener("click", () => openCard(card));
  return button;
}

function filteredCards() {
  const query = $("search-input").value.trim().toLocaleLowerCase("ru");
  const jlpt = $("jlpt-filter").value;
  const lesson = $("lesson-filter").value;
  const status = $("status-filter").value;
  const searchFields = ["kanji", "meaning", "meaning_extra", "onyomi", "kunyomi", "lesson", "jlpt"];

  return state.cards.filter(card => {
    const matchesQuery = !query || searchFields.some(field =>
      String(card[field] || "").toLocaleLowerCase("ru").includes(query)
    );
    const matchesStatus = !status || (
      status === "hard" ? isDifficult(card.progress) :
      status === "favorite" ? card.progress.favorite :
      status === "mastered" ? isMastered(card.progress) :
      card.progress.status === status
    );
    return matchesQuery && (!jlpt || card.jlpt === jlpt) && (!lesson || card.lesson === lesson) && matchesStatus;
  });
}

function currentCounts() {
  const due = state.cards.filter(card => isDue(card.progress)).length;
  const fresh = state.cards.filter(card => card.progress.status === "new");
  const newToday = Math.min(fresh.length, state.settings.dailyNewLimit);
  return {
    total: state.cards.length,
    due,
    newToday,
    newTotal: fresh.length,
    learning: state.cards.filter(card => card.progress.status === "learning").length,
    mastered: state.cards.filter(card => isMastered(card.progress)).length,
    hard: state.cards.filter(card => isDifficult(card.progress)).length
  };
}

function buildTodayQueue() {
  const reviews = buildReviewQueue(state.cards);
  const used = new Set(reviews.map(card => card.id));
  const fresh = state.cards
    .filter(card => card.progress.status === "new" && !used.has(card.id))
    .slice(0, state.settings.dailyNewLimit);
  return [...reviews, ...fresh];
}

function renderToday() {
  const counts = currentCounts();
  const totalToday = counts.due + counts.newToday;
  const hero = $("today-hero");
  hero.replaceChildren();

  const copy = el("div", "today-copy");
  copy.append(
    el("p", "eyebrow", "План на день"),
    el("h2", "", totalToday ? `${totalToday} карточек` : "На сегодня всё"),
    el("p", "today-description", totalToday
      ? `${counts.due} на повторение · ${counts.newToday} новых`
      : "Повторения выполнены. Можно открыть библиотеку или квиз.")
  );

  const start = el("button", "primary-button today-start", totalToday ? "Начать занятие" : "Открыть библиотеку");
  start.type = "button";
  start.addEventListener("click", () => totalToday ? startDailySession() : routeTo("library"));
  hero.append(copy, start);

  const stats = [
    [counts.due, "На сегодня", "due"],
    [counts.mastered, "Выучено", "mastered"],
    [counts.learning, "Изучается", "learning"],
    [counts.hard, "Сложные", "hard"]
  ];
  $("today-stats").replaceChildren(...stats.map(([value, label, tone]) => {
    const node = el("div", `stat stat-${tone}`);
    node.append(el("strong", "", String(value)), el("span", "", label));
    return node;
  }));

  $("today-new-limit").textContent = `${state.settings.dailyNewLimit} новых в день`;
  $("today-new-limit").title = "Изменить дневной лимит";
}

function renderLibrary() {
  const counts = currentCounts();
  const values = [
    [counts.total, "Всего"],
    [counts.mastered, "Выучено"],
    [counts.learning, "Изучается"],
    [counts.hard, "Сложные"]
  ];
  $("stats").replaceChildren(...values.map(([value, label]) => {
    const node = el("div", "stat");
    node.append(el("strong", "", String(value)), el("span", "", label));
    return node;
  }));

  const cards = filteredCards();
  $("library-grid").replaceChildren(...cards.map(createMiniCard));
  const empty = $("library-empty");
  empty.hidden = cards.length > 0;
  if (!cards.length) {
    empty.textContent = state.cards.length
      ? "По этим условиям ничего не найдено."
      : "В таблице пока нет активных карточек.";
  }
}

function addDetailsSection(parent, title, className, build, open = false) {
  const section = el("details", `card-section card-details ${className}`.trim());
  section.dataset.section = className.replace("card-", "");
  section.open = open;
  section.append(el("summary", "", title));
  build(section);
  parent.append(section);
  return section;
}

function addInfoDetails(parent, title, pairs, className, open = false) {
  const visible = pairs.filter(([, value]) => has(value));
  if (!visible.length) return;
  addDetailsSection(parent, title, className, section => {
    const grid = el("div", "info-grid");
    visible.forEach(([label, value]) => {
      const pair = el("div", "info-pair");
      pair.append(el("span", "", label), el("strong", "", value));
      grid.append(pair);
    });
    section.append(grid);
  }, open);
}

function addExamples(parent, title, items, { sentence = false, open = false, className = "" } = {}) {
  const visible = items.filter(item => has(item.main));
  if (!visible.length) return;
  addDetailsSection(parent, title, className, section => {
    const list = el("div", sentence ? "sentence-list" : "word-strip");
    visible.forEach(item => {
      const row = el("div", sentence ? "sentence" : "word-row");
      row.append(el("span", "word-main", item.main));
      if (item.reading) row.append(el("span", "reading", item.reading));
      if (item.translation) row.append(el("span", "translation", item.translation));
      list.append(row);
    });
    section.append(list);
  }, open);
}

function createFullCard(card, { interactive = true } = {}) {
  const root = el("article", "full-card");
  root.dataset.cardId = card.id;

  const hero = el("header", "kanji-hero");
  hero.append(el("div", "kanji-glyph", card.kanji));
  const reading = primaryReading(card);
  if (reading) hero.append(el("span", "hero-reading", reading));
  hero.append(el("h3", "", card.meaning || "Без значения"));
  if (card.meaning_extra) hero.append(el("p", "", card.meaning_extra));
  root.append(hero);

  const imageUrl = validImageUrl(card.image_url);
  if (imageUrl) {
    addDetailsSection(root, "Мнемоника", "card-mnemonic", section => {
      const figure = el("figure", "mnemonic-figure");
      const frame = el("div", "image-frame");
      frame.append(el("span", "", "Загрузка изображения…"));
      const img = el("img");
      img.src = imageUrl;
      img.alt = `Мнемоника и происхождение: ${card.kanji}`;
      img.loading = "lazy";
      img.width = 1200;
      img.height = 900;
      img.addEventListener("load", () => frame.classList.add("loaded"));
      img.addEventListener("error", () => {
        frame.classList.add("failed");
        frame.firstChild.textContent = "Изображение временно недоступно.";
      });
      frame.append(img);
      figure.append(frame);
      section.append(figure);
    }, true);
  }

  addExamples(root, "Примеры слов", card.wordItems, {
    open: true,
    className: "card-words"
  });
  addExamples(root, "Примеры предложений", card.exampleItems, {
    sentence: true,
    open: true,
    className: "card-examples"
  });
  addInfoDetails(root, "Все чтения", [
    ["Онъёми", card.onyomi],
    ["Кунъёми", card.kunyomi]
  ], "card-readings", true);
  addInfoDetails(root, "Строение", [
    ["Компоненты", card.components],
    ["Количество черт", card.stroke_count]
  ], "card-structure");

  const footer = el("section", "card-section card-footer");
  const tags = el("div", "card-meta");
  [card.lesson, card.jlpt, card.date_added ? `Добавлено: ${formatDate(card.date_added, { dateOnly: true })}` : ""]
    .filter(has)
    .forEach(value => tags.append(el("span", "tag", value)));
  footer.append(tags);

  if (interactive) {
    const favorite = el(
      "button",
      "secondary-button favorite-button",
      card.progress.favorite ? "★ В избранном" : "☆ В избранное"
    );
    favorite.type = "button";
    favorite.addEventListener("click", () => {
      card.progress = toggleFavorite(card.id);
      favorite.textContent = card.progress.favorite ? "★ В избранном" : "☆ В избранное";
      if (state.route === "library") renderLibrary();
    });
    footer.append(favorite);
  }

  footer.append(el("p", "progress-copy", progressText(card.progress)));
  root.append(footer);
  return root;
}

function progressText(progress) {
  if (!progress.reviews) return "Карточка ещё не изучалась.";
  const rate = Math.round((Number(progress.correct || 0) / Number(progress.reviews || 1)) * 100);
  const status = isMastered(progress) ? "Выучена" : isDifficult(progress) ? "Сложная" : "Изучается";
  return `${status} · Повторений: ${progress.reviews} · Успешность: ${rate}% · Следующее: ${formatDate(progress.nextReview)}`;
}

function openCard(card) {
  $("dialog-content").replaceChildren(createFullCard(card));
  $("dialog-title").textContent = `${card.kanji} · ${card.meaning || "Карточка"}`;
  openDialog($("card-dialog"));
}

function openDialog(dialog) {
  document.body.style.overflow = "hidden";
  dialog.showModal();
}

function closeDialog(dialog) {
  dialog.close();
  document.body.style.overflow = "";
}

function startDailySession() {
  startSession("daily", buildTodayQueue());
}

function startSession(mode, cards) {
  const queue = [...cards];
  state.session = {
    mode,
    queue,
    index: 0,
    revealed: false,
    locked: false,
    originalCount: queue.length,
    requeued: {},
    stats: { again: 0, good: 0 }
  };

  const titles = {
    daily: ["Сегодня", "Ежедневное занятие"],
    review: ["Повторение", "Карточки на сегодня"],
    learn: ["Новые карточки", "Знакомство"],
    hard: ["Сложные карточки", "Особое внимание"]
  };
  const [title, kicker] = titles[mode] || ["Занятие", "Учебная сессия"];
  $("session-title").textContent = title;
  $("session-kicker").textContent = kicker;
  routeTo("session");
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
    const shell = el("div", "session-card-shell session-prompt-shell");
    const prompt = el("div", "study-prompt");
    prompt.append(
      el("span", "study-label", "Вспомните значение и чтение"),
      el("div", "study-kanji", card.kanji),
      el("p", "study-hint", "Ответьте вслух или напишите кандзи, затем откройте карточку.")
    );
    const reveal = el("button", "primary-button reveal-button", "Показать ответ");
    reveal.type = "button";
    reveal.addEventListener("click", revealCurrentCard);
    prompt.append(reveal);
    shell.append(prompt);
    content.replaceChildren(shell);
    reveal.focus({ preventScroll: true });
    return;
  }

  const shell = el("div", "session-card-shell revealed");
  shell.append(createFullCard(card, { interactive: false }));
  attachSwipe(shell, card);

  const ratings = el("div", "rating-buttons rating-buttons-two");
  const again = createRatingButton("again", "← Не помню", "вернётся в занятие", card);
  const good = createRatingButton("good", "Помню →", nextIntervalLabel(card.progress), card);
  ratings.append(again, good);

  const hint = el("p", "swipe-hint", "Можно смахнуть карточку: влево — не помню, вправо — помню");
  content.replaceChildren(shell, hint, ratings);
  window.scrollTo({ top: 0, behavior: "auto" });
}

function revealCurrentCard() {
  if (!state.session || state.session.locked) return;
  state.session.revealed = true;
  renderSession();
}

function createRatingButton(result, label, sublabel, card) {
  const button = el("button", `rating-button rating-${result}`);
  button.type = "button";
  button.dataset.result = result;
  button.append(el("strong", "", label), el("small", "", sublabel));
  button.addEventListener("click", () => rateCard(card, result));
  return button;
}

function nextIntervalLabel(progress) {
  const interval = Number(progress.intervalDays) || 0;
  if (interval >= 11) return "примерно через месяц";
  if (interval >= 4) return "примерно через 2 недели";
  if (interval > 0) return "примерно через неделю";
  return "через 3 дня";
}

function attachSwipe(shell, card) {
  let startX = 0;
  let startY = 0;
  let deltaX = 0;
  let dragging = false;
  let horizontal = false;

  shell.addEventListener("pointerdown", event => {
    if (state.session?.locked || event.button !== 0) return;
    dragging = true;
    horizontal = false;
    startX = event.clientX;
    startY = event.clientY;
    deltaX = 0;
    shell.classList.add("dragging");
    shell.setPointerCapture?.(event.pointerId);
  });

  shell.addEventListener("pointermove", event => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!horizontal && Math.abs(dx) > 10) horizontal = Math.abs(dx) > Math.abs(dy);
    if (!horizontal) return;
    deltaX = dx;
    const limited = Math.max(-150, Math.min(150, dx));
    shell.style.transform = `translateX(${limited}px) rotate(${limited / 35}deg)`;
    shell.style.setProperty("--swipe-strength", String(Math.min(1, Math.abs(limited) / 100)));
    shell.dataset.swipe = limited < 0 ? "again" : "good";
  });

  const finish = event => {
    if (!dragging) return;
    dragging = false;
    shell.classList.remove("dragging");
    shell.releasePointerCapture?.(event.pointerId);
    if (horizontal && Math.abs(deltaX) >= 76) {
      rateCard(card, deltaX < 0 ? "again" : "good", shell);
      return;
    }
    shell.style.transform = "";
    shell.style.removeProperty("--swipe-strength");
    delete shell.dataset.swipe;
  };

  shell.addEventListener("pointerup", finish);
  shell.addEventListener("pointercancel", finish);
}

function rateCard(card, result, shell = null) {
  const session = state.session;
  if (!session || session.locked || !["again", "good"].includes(result)) return;
  session.locked = true;
  document.querySelectorAll(".rating-buttons button").forEach(button => { button.disabled = true; });

  card.progress = scheduleReview(card.progress, result);
  saveProgress(card.progress);
  session.stats[result] += 1;

  if (result === "again") {
    const times = Number(session.requeued[card.id] || 0);
    if (times < 1) {
      const insertionIndex = Math.min(session.index + 6, session.queue.length);
      session.queue.splice(insertionIndex, 0, card);
      session.requeued[card.id] = times + 1;
    }
  }

  const activeShell = shell || $("session-content").querySelector(".session-card-shell");
  if (activeShell) {
    activeShell.style.transform = "";
    activeShell.style.removeProperty("--swipe-strength");
    delete activeShell.dataset.swipe;
    activeShell.classList.add(result === "again" ? "leave-left" : "leave-right");
  }
  showToast(result === "again" ? "Вернём эту карточку ещё раз" : "Сохранено: помню");

  const delay = reducedMotion() ? 20 : 320;
  setTimeout(() => {
    session.index += 1;
    session.revealed = false;
    session.locked = false;
    renderSession();
  }, delay);
}

function renderCompletion() {
  const session = state.session;
  $("session-progress").textContent = "";
  const box = el("div", "completion");
  const remembered = session?.stats.good || 0;
  const forgotten = session?.stats.again || 0;
  const totalAnswers = remembered + forgotten;
  const rate = totalAnswers ? Math.round((remembered / totalAnswers) * 100) : 0;

  box.append(
    el("span", "completion-mark", "完"),
    el("h3", "", session?.originalCount ? "Занятие завершено" : "На сегодня всё"),
    el("p", "", session?.originalCount
      ? `Основных карточек: ${session.originalCount}. Успешность ответов: ${rate}%.`
      : "Нет карточек, которые нужно повторить или изучить сегодня.")
  );

  if (session?.originalCount) {
    const stats = el("div", "completion-stats");
    stats.append(
      completionStat(remembered, "Помню"),
      completionStat(forgotten, "Не помню")
    );
    box.append(stats);
  }

  const back = el("button", "primary-button", "На главный экран");
  back.type = "button";
  back.addEventListener("click", () => routeTo("today"));
  box.append(back);
  $("session-content").replaceChildren(box);
}

function completionStat(value, label) {
  const node = el("span", "");
  node.append(el("strong", "", String(value)), el("small", "", label));
  return node;
}

function startQuiz(mistakes = null) {
  if (!state.quizEngine) { routeTo("quiz"); return; }
  const questions = mistakes
    ? state.quizEngine.generateMistakeQuiz(mistakes)
    : state.quizEngine.generateQuiz(30);
  state.quiz = questions.length ? { questions, index: 0, correct: 0, selected: null, mistakes: [] } : null;
  routeTo("quiz");
}

function renderQuiz() {
  const content = $("quiz-content");
  content.replaceChildren();
  const quiz = state.quiz;
  if (!quiz) {
    const box = el("div", "empty-state", state.quizError || "Недостаточно активного материала для квиза. Добавьте или активируйте ещё слова и кандзи.");
    content.append(box);
    if (state.quizEngine) {
      const start = el("button", "primary-button quiz-action", "Начать квиз");
      start.type = "button";
      start.addEventListener("click", () => startQuiz());
      content.append(start);
    }
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
  const promptLabel = question.type.endsWith("_from_meaning") ? `Выберите ${question.kind === "kanji" ? "кандзи" : "слово"}`
    : question.type.endsWith("_from_reading") ? `Выберите ${question.kind === "kanji" ? "кандзи" : "слово"}`
    : question.type.endsWith("_meaning") ? "Что означает?" : "Как читается?";
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
    const feedback = el("div", `quiz-feedback ${correct ? "correct" : "incorrect"}`);
    feedback.append(el("strong", "", correct ? "✅ Правильно" : "❌ Неправильно"));
    feedback.append(el("p", "", `Правильный ответ: ${question.answer}`));
    feedback.append(el("small", "", [question.source.form, question.source.reading, question.source.meaning].filter(has).join(" · ")));
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
  if (index === question.correctIndex) quiz.correct += 1;
  else quiz.mistakes.push({ ...question, selectedAnswer: question.choices[index] });
  renderQuiz();
}

function renderQuizResult() {
  const quiz = state.quiz;
  const total = quiz.questions.length;
  const box = el("div", "completion quiz-result");
  box.append(el("span", "completion-mark", `${Math.round(quiz.correct / total * 100)}%`), el("h3", "", "Квиз завершён"), el("p", "", `${quiz.correct} / ${total}`));
  const stats = el("div", "completion-stats");
  stats.append(completionStat(quiz.correct, "Правильно"), completionStat(quiz.mistakes.length, "Ошибок"));
  box.append(stats);
  if (quiz.mistakes.length) {
    const heading = el("h4", "", "Ошибки");
    box.append(heading);
    quiz.mistakes.forEach(mistake => {
      const row = el("div", "quiz-mistake");
      row.append(el("strong", "", mistake.prompt), el("span", "", `Ваш ответ: ${mistake.selectedAnswer}`), el("span", "", `Правильно: ${mistake.answer}`), el("small", "", [mistake.source.form, mistake.source.reading, mistake.source.meaning].filter(has).join(" · ")));
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
  const counts = currentCounts();
  const stats = [
    [counts.mastered, "Выучено"],
    [counts.learning, "Изучается"],
    [counts.newTotal, "Новые"],
    [counts.hard, "Сложные"]
  ];
  $("progress-stats").replaceChildren(...stats.map(([value, label]) => {
    const node = el("div", "stat");
    node.append(el("strong", "", String(value)), el("span", "", label));
    return node;
  }));

  const grouped = new Map();
  state.cards.forEach(card => {
    const lesson = card.lesson || "Без урока";
    if (!grouped.has(lesson)) grouped.set(lesson, []);
    grouped.get(lesson).push(card);
  });

  const lessonList = $("lesson-progress");
  lessonList.replaceChildren(...[...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "ru", { numeric: true }))
    .map(([lesson, cards]) => {
      const mastered = cards.filter(card => isMastered(card.progress)).length;
      const percent = cards.length ? Math.round((mastered / cards.length) * 100) : 0;
      const row = el("div", "lesson-row");
      const heading = el("div", "lesson-row-heading");
      heading.append(el("strong", "", lesson), el("span", "", `${mastered} из ${cards.length}`));
      const track = el("div", "progress-track");
      const fill = el("span", "progress-fill");
      fill.style.width = `${percent}%`;
      track.append(fill);
      row.append(heading, track);
      return row;
    }));

  const hardCards = state.cards.filter(card => isDifficult(card.progress));
  $("hard-grid").replaceChildren(...hardCards.map(createMiniCard));
  $("hard-empty").hidden = hardCards.length > 0;
  $("practice-hard").disabled = !hardCards.length;
}

function syncSettingsControls() {
  $("new-limit-select").value = String(state.settings.dailyNewLimit);
}

function formatDate(value, { dateOnly = false } = {}) {
  if (!value) return "не назначено";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: !dateOnly && String(value).includes("T") ? "short" : undefined
  }).format(date);
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 1600);
}

function handleKeyboard(event) {
  if (event.key === "Escape") {
    const activeDialog = document.querySelector("dialog[open]");
    if (activeDialog) {
      event.preventDefault();
      closeDialog(activeDialog);
      return;
    }
    if (state.route === "session") routeTo("today");
    return;
  }

  const interactiveTarget = event.target instanceof Element &&
    event.target.closest("input, select, textarea, button, dialog");

  if (
    state.route === "words" &&
    !interactiveTarget &&
    (event.key === "ArrowUp" || event.key === " " || event.key === "Enter")
  ) {
    event.preventDefault();
    advanceWordStack();
    return;
  }

  if (state.route !== "session" || !state.session || state.session.locked) return;
  const card = state.session.queue[state.session.index];
  if (!card) return;

  if (!state.session.revealed && (event.key === " " || event.key === "Enter")) {
    event.preventDefault();
    revealCurrentCard();
  } else if (state.session.revealed && (event.key === "ArrowLeft" || event.key === "1")) {
    event.preventDefault();
    rateCard(card, "again");
  } else if (state.session.revealed && (event.key === "ArrowRight" || event.key === "2" || event.key === "3")) {
    event.preventDefault();
    rateCard(card, "good");
  }
}

// Navigation and main actions
document.querySelectorAll(".bottom-nav button").forEach(button => {
  button.addEventListener("click", () => routeTo(button.dataset.route));
});

$("today-review-only").addEventListener("click", () => startSession("review", buildReviewQueue(state.cards)));
$("today-quiz").addEventListener("click", () => startQuiz());
$("quiz-exit").addEventListener("click", () => routeTo("today"));
$("today-new-only").addEventListener("click", () => {
  const cards = state.cards
    .filter(card => card.progress.status === "new")
    .slice(0, state.settings.dailyNewLimit);
  startSession("learn", cards);
});

["search-input", "jlpt-filter", "lesson-filter", "status-filter"].forEach(id => {
  $(id).addEventListener(id === "search-input" ? "input" : "change", renderLibrary);
});

$("words-next").addEventListener("click", () => advanceWordStack());
$("words-shuffle").addEventListener("click", shuffleWords);
$("refresh-button").addEventListener("click", () => loadCards());
$("session-exit").addEventListener("click", () => {
  const session = state.session;
  const started = session && (session.index > 0 || session.revealed);
  const unfinished = session && session.index < session.queue.length;
  if (started && unfinished && !confirm("Завершить занятие до конца? Прогресс уже отвеченных карточек сохранится.")) return;
  routeTo("today");
});
$("practice-hard").addEventListener("click", () => {
  startSession("hard", state.cards.filter(card => isDifficult(card.progress)));
});

$("dialog-close").addEventListener("click", () => closeDialog($("card-dialog")));
$("settings-button").addEventListener("click", () => {
  syncSettingsControls();
  openDialog($("settings-dialog"));
});
$("today-new-limit").addEventListener("click", () => {
  syncSettingsControls();
  openDialog($("settings-dialog"));
});
$("settings-close").addEventListener("click", () => closeDialog($("settings-dialog")));
[$("card-dialog"), $("settings-dialog")].forEach(dialog => {
  dialog.addEventListener("close", () => { document.body.style.overflow = ""; });
});

document.addEventListener("keydown", handleKeyboard);

$("new-limit-select").addEventListener("change", event => {
  state.settings = saveSettings({ dailyNewLimit: Number(event.target.value) });
  renderToday();
  $("settings-message").textContent = `Лимит сохранён: ${state.settings.dailyNewLimit} новых карточек в день.`;
});

$("export-button").addEventListener("click", exportProgress);
$("import-input").addEventListener("change", async event => {
  try {
    await importProgress(event.target.files[0]);
    state.settings = readSettings();
    await loadCards();
    $("settings-message").textContent = "Прогресс и настройки импортированы.";
  } catch (error) {
    $("settings-message").textContent = error.message;
  }
  event.target.value = "";
});

$("clear-button").addEventListener("click", () => {
  if (!confirm("Удалить весь локальный прогресс? Это действие нельзя отменить.")) return;
  clearProgress();
  state.cards.forEach(card => { card.progress = getProgress(card.id); });
  renderToday();
  $("settings-message").textContent = "Прогресс очищен.";
});

window.addEventListener("online", () => {
  setBanner(state.usingCache ? "Соединение восстановлено. Нажмите «Обновить», чтобы получить свежие данные." : "");
});
window.addEventListener("offline", () => {
  setBanner("Нет сети. Доступна сохранённая версия приложения и ранее загруженные данные.");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js")
      .catch(error => console.warn("Service Worker не зарегистрирован", error));
  });
}

loadCards();
