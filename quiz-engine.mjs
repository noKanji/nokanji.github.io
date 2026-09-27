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

function parseGroupedEntries(value) {
  if (!clean(value)) return [];
  return String(value).split(";").map(entry => entry.trim()).filter(Boolean).map(entry => {
    const [form = "", reading = "", ...meaningParts] = entry.split("|").map(part => part.trim());
    return { form: clean(form), reading: clean(reading), meaning: clean(meaningParts.join("|")) };
  }).filter(entry => entry.form);
}

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

function makeReadingVariants(item, vocabulary) {
  const variants = item.onyomi
    .filter(reading => reading && key(reading) !== key(item.form))
    .map(reading => ({ mode: "onyomi", form: item.form, reading }));

  for (const reading of item.kunyomi) {
    const matches = vocabulary
      .filter(word => key(word.reading) === key(reading))
      .filter(word => key(word.displayForm) !== key(word.reading))
      .filter(word => word.displayForm.includes(item.form));

    const seenForms = new Set();
    for (const word of matches) {
      const formKey = key(word.displayForm);
      if (seenForms.has(formKey)) continue;
      seenForms.add(formKey);
      variants.push({ mode: "kunyomi", form: word.displayForm, reading, vocabularyId: word.id });
    }
  }

  return variants;
}

export function normalizeQuizData(kanjiRows = [], vocabularyRows = []) {
  const kanjiBase = kanjiRows.filter(row => active(row.active)).map(row => {
    const onyomi = parseReadings(row.onyomi);
    const kunyomi = parseReadings(row.kunyomi);
    return {
      kind: "kanji", id: clean(row.id || row.kanji), form: clean(row.kanji),
      meaning: clean(row.meaning), meaningExtra: clean(row.meaning_extra),
      meanings: unique([...meaningParts(row.meaning), ...meaningParts(row.meaning_extra)]),
      onyomi, kunyomi, readings: unique([...kunyomi, ...onyomi]),
      words: parseGroupedEntries(row.words),
      examples: parseGroupedEntries(row.examples),
      lesson: clean(row.lesson)
    };
  }).filter(row => row.id && row.form);

  const known = new Set(kanjiBase.filter(row => [...row.form].length === 1).map(row => row.form));
  const vocabulary = vocabularyRows.filter(row => active(row.active)).map(row => ({
    kind: "vocabulary", id: clean(row.id || `${row.japanese}|${row.reading}`),
    japanese: clean(row.japanese), reading: clean(row.reading),
    meaning: clean(row.meaning_ru), meanings: meaningParts(row.meaning_ru),
    displayForm: getDisplayForm(row, known), lesson: clean(row.lesson),
    exampleJp: clean(row.example_jp),
    exampleReading: clean(row.example_reading),
    exampleRu: clean(row.example_ru)
  })).filter(row => row.id && row.displayForm);

  const kanji = kanjiBase.map(item => ({
    ...item,
    readingVariants: makeReadingVariants(item, vocabulary)
  }));

  return { kanji, vocabulary };
}

function overlaps(a, b) {
  return a.some(value => b.some(other => key(value) === key(other)));
}

function definitions(item) {
  return item.meanings || [];
}

function candidateKey(candidate) {
  const variant = candidate.variant
    ? `${candidate.variant.mode}:${candidate.variant.form}:${candidate.variant.reading}`
    : "base";
  return `${candidate.item.kind}:${candidate.item.id}:${candidate.type}:${variant}`;
}

function spec(candidate) {
  const { item, type, variant = null } = candidate;
  const isKanji = item.kind === "kanji";
  const form = isKanji ? (variant?.form || item.form) : item.displayForm;
  const reading = isKanji ? variant?.reading : item.reading;

  if (type.endsWith("_from_meaning") && form && item.meaning) {
    return { prompt: item.meaning, answer: form, domain: "form" };
  }
  if (type.endsWith("_from_reading") && form && reading && key(form) !== key(reading)) {
    const label = type.startsWith("kanji_onyomi_") ? "Выберите кандзи по онъёми"
      : type.startsWith("kanji_kunyomi_") ? "Выберите слово"
        : undefined;
    return { prompt: reading, answer: form, domain: "form", label };
  }
  if (type.endsWith("_meaning") && form && item.meaning) {
    return { prompt: form, answer: item.meaning, domain: "meaning" };
  }
  if (type.endsWith("_reading") && form && reading && key(form) !== key(reading)) {
    const label = type.startsWith("kanji_onyomi_") ? "Онъёми"
      : type.startsWith("kanji_kunyomi_") ? "Как читается слово?"
        : undefined;
    return { prompt: form, answer: reading, domain: "reading", label };
  }
  return null;
}

function buildCandidates(data) {
  const candidates = [];

  for (const item of data.kanji) {
    for (const type of ["kanji_meaning", "kanji_from_meaning"]) {
      candidates.push({ item, type, variant: null });
    }
    for (const variant of item.readingVariants) {
      const stem = variant.mode === "onyomi" ? "kanji_onyomi" : "kanji_kunyomi";
      candidates.push({ item, type: `${stem}_reading`, variant });
      candidates.push({ item, type: `${stem}_from_reading`, variant });
    }
  }

  for (const item of data.vocabulary) {
    for (const type of ["vocabulary_meaning", "vocabulary_reading", "vocabulary_from_meaning", "vocabulary_from_reading"]) {
      const candidate = { item, type, variant: null };
      if (spec(candidate)) candidates.push(candidate);
    }
  }

  return candidates.filter(candidate => spec(candidate));
}

function compatible(sourceCandidate, peerCandidate, sourceQuestion) {
  const candidate = spec(peerCandidate);
  if (!candidate || key(candidate.answer) === key(sourceQuestion.answer)) return false;
  if (sourceCandidate.type.endsWith("_meaning") || sourceCandidate.type.endsWith("_from_meaning")) {
    if (overlaps(definitions(sourceCandidate.item), definitions(peerCandidate.item))) return false;
  }
  return true;
}

function validateQuestion(question, choices) {
  if (!question || choices.length !== 4 || new Set(choices.map(key)).size !== 4) return false;
  if (choices.filter(choice => key(choice) === key(question.answer)).length !== 1) return false;
  return true;
}

function feedbackFor(candidate, data) {
  const item = candidate.item;
  if (item.kind === "kanji") {
    const focusWord = candidate.variant?.vocabularyId
      ? data.vocabulary.find(word => word.id === candidate.variant.vocabularyId)
      : null;
    return {
      kind: "kanji",
      kanji: item.form,
      meaning: item.meaning,
      meaningExtra: item.meaningExtra,
      onyomi: [...item.onyomi],
      kunyomi: [...item.kunyomi],
      focusWord: focusWord ? {
        form: focusWord.displayForm,
        reading: focusWord.reading,
        meaning: focusWord.meaning,
        exampleJp: focusWord.exampleJp,
        exampleReading: focusWord.exampleReading,
        exampleRu: focusWord.exampleRu
      } : null,
      words: item.words.slice(0, 3),
      examples: item.examples.slice(0, 1)
    };
  }

  return {
    kind: "vocabulary",
    form: item.displayForm,
    japanese: item.japanese,
    reading: item.reading,
    meaning: item.meaning,
    exampleJp: item.exampleJp,
    exampleReading: item.exampleReading,
    exampleRu: item.exampleRu
  };
}

export function createQuizEngine(kanjiRows, vocabularyRows, random = Math.random) {
  const data = normalizeQuizData(kanjiRows, vocabularyRows);
  const candidates = buildCandidates(data);
  const byType = new Map();
  for (const candidate of candidates) {
    const list = byType.get(candidate.type) || [];
    list.push(candidate);
    byType.set(candidate.type, list);
  }

  function build(candidate, correctIndex) {
    const question = spec(candidate);
    if (!question) return null;
    const peersOfType = byType.get(candidate.type) || [];

    // If the same visible prompt has more than one valid answer, the question is ambiguous.
    if (peersOfType.some(peer => peer !== candidate && (() => {
      const peerQuestion = spec(peer);
      return peerQuestion && key(peerQuestion.prompt) === key(question.prompt) && key(peerQuestion.answer) !== key(question.answer);
    })())) return null;

    // Meanings such as synonyms/near-duplicates can also make reverse questions ambiguous.
    if (candidate.type.endsWith("_from_meaning") && peersOfType.some(peer => peer !== candidate &&
      overlaps(definitions(candidate.item), definitions(peer.item)))) return null;

    const peers = peersOfType.filter(peer => peer !== candidate && compatible(candidate, peer, question));
    const seen = new Set([key(question.answer)]);
    const distractors = [];
    for (const peer of shuffle(peers, random)) {
      const peerQuestion = spec(peer);
      const value = peerQuestion?.answer;
      if (!value || seen.has(key(value))) continue;
      seen.add(key(value));
      distractors.push(value);
      if (distractors.length === 3) break;
    }
    if (distractors.length < 3) return null;

    const choices = [...distractors];
    choices.splice(correctIndex, 0, question.answer);
    if (!validateQuestion(question, choices)) return null;

    const sourceForm = candidate.item.kind === "kanji"
      ? (candidate.variant?.form || candidate.item.form)
      : candidate.item.displayForm;
    const sourceReading = candidate.item.kind === "kanji"
      ? (candidate.variant?.reading || candidate.item.readings.join(" / "))
      : candidate.item.reading;

    return {
      candidateId: candidateKey(candidate),
      sourceId: candidate.item.id,
      kind: candidate.item.kind,
      type: candidate.type,
      prompt: question.prompt,
      label: question.label,
      choices,
      correctIndex,
      answer: question.answer,
      source: { form: sourceForm, reading: sourceReading, meaning: candidate.item.meaning },
      feedback: feedbackFor(candidate, data)
    };
  }

  function generateQuiz(count = 30, onlyMistakes = null) {
    const available = onlyMistakes
      ? candidates.filter(candidate => onlyMistakes.some(mistake =>
        mistake.candidateId === candidateKey(candidate) ||
        (!mistake.candidateId && mistake.sourceId === candidate.item.id && mistake.kind === candidate.item.kind)))
      : candidates;
    const chosen = [];
    const used = new Set();
    const sourceUses = new Map();
    const typeUses = new Map();
    const kindUses = new Map();
    const positions = shuffle(Array.from({ length: count }, (_, index) => index % 4), random);

    while (chosen.length < count) {
      const options = shuffle(available.filter(candidate => !used.has(candidateKey(candidate))), random)
        .sort((a, b) => {
          const score = candidate => (sourceUses.get(`${candidate.item.kind}:${candidate.item.id}`) || 0) * 100
            + (kindUses.get(candidate.item.kind) || 0) * 10 + (typeUses.get(candidate.type) || 0);
          return score(a) - score(b);
        });
      let next = null;
      for (const candidate of options) {
        const built = build(candidate, positions[chosen.length]);
        used.add(candidateKey(candidate));
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
      const exact = mistake.candidateId
        ? candidates.find(candidate => candidateKey(candidate) === mistake.candidateId)
        : null;
      const sameSource = candidates.filter(candidate =>
        candidate.item.id === mistake.sourceId && candidate.item.kind === mistake.kind && candidate !== exact);
      const options = [exact, ...shuffle(sameSource, random)].filter(Boolean);
      const question = options.map(candidate => build(candidate, positions[index])).find(Boolean);
      if (question) questions.push(question);
    });
    return shuffle(questions, random);
  }

  return { data, generateQuiz, generateMistakeQuiz };
}
