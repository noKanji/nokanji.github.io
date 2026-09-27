const clean = value => String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
const key = value => clean(value).toLocaleLowerCase("ru")
  .replace(/[、，；;]+/gu, ",").replace(/\s*,\s*/gu, ",")
  .replace(/[。．.]+$/u, "");
const active = value => ["true", "1", "yes", "да"].includes(String(value).trim().toLowerCase());
const shuffle = (items, random) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};
const unique = values => [...new Map(values.filter(Boolean).map(value => [key(value), clean(value)])).values()];
const meaningParts = value => unique(clean(value).split(/[;,、，；/]|\s+или\s+/iu));

export function parseReadings(value) {
  return unique(String(value ?? "").normalize("NFKC").split(/[、，,;；/・\n\r]+/u).map(clean));
}

export function getDisplayForm(row, activeKanji) {
  const override = clean(row?.display_override ?? row?.displayOverride);
  if (override) return override;
  const japanese = clean(row?.japanese);
  const reading = clean(row?.reading);
  const chars = [...japanese.matchAll(/\p{Script=Han}/gu)].map(match => match[0]).filter(char => char !== "々");
  return chars.every(char => activeKanji.has(char)) ? japanese : reading;
}

export function normalizeQuizData(kanjiRows = [], vocabularyRows = []) {
  const kanji = kanjiRows.filter(row => active(row.active)).map(row => ({
    kind: "kanji", id: clean(row.id || row.kanji), form: clean(row.kanji),
    meaning: clean(row.meaning), meaningExtra: clean(row.meaning_extra),
    meanings: unique([...meaningParts(row.meaning), ...meaningParts(row.meaning_extra)]),
    readings: unique([...parseReadings(row.kunyomi), ...parseReadings(row.onyomi)]),
    lesson: clean(row.lesson)
  })).filter(row => row.id && row.form);
  const known = new Set(kanji.filter(row => [...row.form].length === 1).map(row => row.form));
  const vocabulary = vocabularyRows.filter(row => active(row.active)).map(row => ({
    kind: "vocabulary", id: clean(row.id || `${row.japanese}|${row.reading}`),
    japanese: clean(row.japanese), reading: clean(row.reading),
    meaning: clean(row.meaning_ru), meanings: meaningParts(row.meaning_ru),
    displayForm: getDisplayForm(row, known), lesson: clean(row.lesson)
  })).filter(row => row.id && row.displayForm);
  return { kanji, vocabulary };
}

function overlaps(a, b) {
  return a.some(value => b.some(other => key(value) === key(other)));
}

function definitions(item) {
  return item.meanings || [];
}

function spec(item, type) {
  const isKanji = item.kind === "kanji";
  const form = isKanji ? item.form : item.displayForm;
  const reading = isKanji ? item.readings[0] : item.reading;
  if (type.endsWith("_from_meaning") && form && item.meaning) return { prompt: item.meaning, answer: form, domain: "form" };
  if (type.endsWith("_from_reading") && form && reading && key(form) !== key(reading)) return { prompt: reading, answer: form, domain: "form" };
  if (type.endsWith("_meaning") && form && item.meaning) return { prompt: form, answer: item.meaning, domain: "meaning" };
  if (type.endsWith("_reading") && form && reading && key(form) !== key(reading)) return { prompt: form, answer: reading, domain: "reading" };
  return null;
}

const TYPES = {
  kanji: ["kanji_meaning", "kanji_reading", "kanji_from_meaning", "kanji_from_reading"],
  vocabulary: ["vocabulary_meaning", "vocabulary_reading", "vocabulary_from_meaning", "vocabulary_from_reading"]
};

function compatible(source, peer, type, answer) {
  const candidate = spec(peer, type);
  if (!candidate || key(candidate.answer) === key(answer)) return false;
  if (type.endsWith("_meaning") || type.endsWith("_from_meaning")) {
    if (overlaps(definitions(source), definitions(peer))) return false;
  }
  if (type.endsWith("_reading") || type.endsWith("_from_reading")) {
    const sourceReadings = source.kind === "kanji" ? source.readings : [source.reading];
    const peerReadings = peer.kind === "kanji" ? peer.readings : [peer.reading];
    if (overlaps(sourceReadings, peerReadings)) return false;
  }
  return true;
}

function validateQuestion(question, source, choices) {
  if (!question || choices.length !== 4 || new Set(choices.map(key)).size !== 4) return false;
  if (choices.filter(choice => key(choice) === key(question.answer)).length !== 1) return false;
  return true;
}

export function createQuizEngine(kanjiRows, vocabularyRows, random = Math.random) {
  const data = normalizeQuizData(kanjiRows, vocabularyRows);
  const pool = { kanji: data.kanji, vocabulary: data.vocabulary };
  const candidates = [];
  for (const kind of ["kanji", "vocabulary"]) for (const item of pool[kind]) {
    for (const type of TYPES[kind]) if (spec(item, type)) candidates.push({ item, type });
  }

  function build(item, type, correctIndex) {
    const question = spec(item, type);
    if (!question) return null;
    if (!type.includes("_from_") && pool[item.kind].some(peer => peer !== item &&
      key(peer.kind === "kanji" ? peer.form : peer.displayForm) === key(item.kind === "kanji" ? item.form : item.displayForm))) return null;
    if (type.endsWith("_from_meaning") && pool[item.kind].some(peer => peer !== item && peer.meaning && overlaps(definitions(item), definitions(peer)))) return null;
    if (type.endsWith("_from_reading") && pool[item.kind].some(peer => peer !== item && compatible(item, peer, type, question.answer) === false &&
      overlaps(item.kind === "kanji" ? item.readings : [item.reading], peer.kind === "kanji" ? peer.readings : [peer.reading]))) return null;
    const peers = pool[item.kind].filter(peer => peer !== item && compatible(item, peer, type, question.answer));
    const seen = new Set([key(question.answer)]);
    const distractors = [];
    for (const peer of shuffle(peers, random)) {
      const value = spec(peer, type).answer;
      if (seen.has(key(value))) continue;
      seen.add(key(value));
      distractors.push(value);
      if (distractors.length === 3) break;
    }
    if (distractors.length < 3) return null;
    const choices = [...distractors];
    choices.splice(correctIndex, 0, question.answer);
    if (!validateQuestion({ ...question, type }, item, choices)) return null;
    return {
      sourceId: item.id, kind: item.kind, type, prompt: question.prompt,
      choices, correctIndex, answer: question.answer,
      source: item.kind === "kanji"
        ? { form: item.form, reading: item.readings.join(" / "), meaning: item.meaning }
        : { form: item.displayForm, reading: item.reading, meaning: item.meaning }
    };
  }

  function generateQuiz(count = 30, onlyMistakes = null) {
    const available = onlyMistakes
      ? candidates.filter(candidate => onlyMistakes.some(mistake => mistake.sourceId === candidate.item.id && mistake.kind === candidate.item.kind))
      : candidates;
    const chosen = [];
    const used = new Set();
    const sourceUses = new Map();
    const typeUses = new Map();
    const kindUses = new Map();
    const positions = shuffle(Array.from({ length: count }, (_, index) => index % 4), random);
    while (chosen.length < count) {
      const options = shuffle(available.filter(candidate => !used.has(`${candidate.item.kind}:${candidate.item.id}:${candidate.type}`)), random)
        .sort((a, b) => {
          const score = candidate => (sourceUses.get(`${candidate.item.kind}:${candidate.item.id}`) || 0) * 100
            + (kindUses.get(candidate.item.kind) || 0) * 10 + (typeUses.get(candidate.type) || 0);
          return score(a) - score(b);
        });
      let next = null;
      for (const candidate of options) {
        const built = build(candidate.item, candidate.type, positions[chosen.length]);
        used.add(`${candidate.item.kind}:${candidate.item.id}:${candidate.type}`);
        if (built) { next = built; break; }
      }
      if (!next) break;
      chosen.push(next);
      const sourceKey = `${next.kind}:${next.sourceId}`;
      sourceUses.set(sourceKey, (sourceUses.get(sourceKey) || 0) + 1);
      typeUses.set(next.type, (typeUses.get(next.type) || 0) + 1);
      kindUses.set(next.kind, (kindUses.get(next.kind) || 0) + 1);
    }
    return chosen;
  }

  function generateMistakeQuiz(mistakes) {
    const questions = [];
    const positions = shuffle(mistakes.map((_, index) => index % 4), random);
    mistakes.forEach((mistake, index) => {
      const item = pool[mistake.kind]?.find(row => row.id === mistake.sourceId);
      if (!item) return;
      const types = [mistake.type, ...shuffle(TYPES[item.kind].filter(type => type !== mistake.type), random)];
      const question = types.map(type => build(item, type, positions[index])).find(Boolean);
      if (question) questions.push(question);
    });
    return shuffle(questions, random);
  }

  return { data, generateQuiz, generateMistakeQuiz };
}
