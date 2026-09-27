import test from "node:test";
import assert from "node:assert/strict";
import { createQuizEngine, getDisplayForm, normalizeQuizData, parseReadings } from "./quiz-engine.mjs";
import { loadLearningData } from "./quiz-data.mjs";

const kanji = (form, id, extra = {}) => ({ id, kanji: form, meaning: `значение ${id}`, kunyomi: `よみ${id}`, active: true, ...extra });
const word = (id, extra = {}) => ({ id, japanese: `単語${id}`, reading: `たんご${id}`, meaning_ru: `слово ${id}`, active: true, ...extra });
const activeKanji = chars => new Set([...chars]);

test("getDisplayForm follows active kanji and manual override", () => {
  assert.equal(getDisplayForm({ japanese: "日本", reading: "にほん" }, activeKanji("日本")), "日本");
  assert.equal(getDisplayForm({ japanese: "美味しい", reading: "おいしい" }, activeKanji("")), "おいしい");
  assert.equal(getDisplayForm({ japanese: "食べる", reading: "たべる" }, activeKanji("食")), "食べる");
  assert.equal(getDisplayForm({ japanese: "食べる", reading: "たべる" }, activeKanji("")), "たべる");
  assert.equal(getDisplayForm({ japanese: "たぶん", reading: "たぶん" }, activeKanji("")), "たぶん");
  assert.equal(getDisplayForm({ japanese: "美味しい", reading: "おいしい", display_override: "おいしい" }, activeKanji("美味")), "おいしい");
  assert.equal(getDisplayForm({ japanese: "時々", reading: "ときどき" }, activeKanji("時")), "時々");
});

test("only active rows can enter the source and distractor pools", () => {
  const rows = Array.from({ length: 8 }, (_, i) => kanji(String.fromCodePoint(0x4e00 + i), `k${i}`));
  const words = Array.from({ length: 8 }, (_, i) => word(`w${i}`, { japanese: `ことば${i}`, reading: `ことば${i}` }));
  rows[7].active = false;
  words[7].active = false;
  const engine = createQuizEngine(rows, words, () => 0.37);
  assert.equal(engine.data.kanji.length, 7);
  assert.equal(engine.data.vocabulary.length, 7);
  const quiz = engine.generateQuiz(30);
  assert.equal(quiz.length, 30);
  assert.ok(quiz.some(q => q.kind === "kanji"));
  assert.ok(quiz.some(q => q.kind === "vocabulary"));
  assert.equal(new Set(quiz.map(q => q.correctIndex)).size, 4);
  const activeForms = new Set(rows.slice(0, 7).map(row => row.kanji));
  const activeWordForms = new Set(words.slice(0, 7).map(row => row.japanese));
  for (const q of quiz) {
    assert.equal(q.choices.length, 4);
    assert.equal(new Set(q.choices).size, 4);
    assert.equal(q.choices[q.correctIndex], q.answer);
    assert.notEqual(q.sourceId, "k7");
    assert.notEqual(q.sourceId, "w7");
    assert.ok(!q.choices.some(c => c.includes("k7") || c.includes("w7")));
    if (q.type.endsWith("_from_meaning") || q.type.endsWith("_from_reading")) {
      const forms = q.kind === "kanji" ? activeForms : activeWordForms;
      assert.ok(q.choices.every(choice => forms.has(choice)));
      assert.equal(q.answer, q.source.form);
    } else if (q.type.endsWith("_meaning")) {
      assert.equal(q.answer, q.source.meaning);
    } else {
      assert.ok(q.source.reading.split(" / ").includes(q.answer));
    }
  }
  assert.equal(new Set(quiz.map(q => `${q.kind}:${q.sourceId}:${q.type}`)).size, 30);
  const mistakes = [quiz[1], quiz[3], quiz[5]];
  const retry = engine.generateMistakeQuiz(mistakes);
  assert.equal(retry.length, 3);
  assert.deepEqual(new Set(retry.map(q => `${q.kind}:${q.sourceId}`)), new Set(mistakes.map(q => `${q.kind}:${q.sourceId}`)));
});

test("kana-only word participates in meaning directions, not reading itself", () => {
  const words = Array.from({ length: 6 }, (_, i) => word(`w${i}`, { japanese: `ことば${i}`, reading: `ことば${i}` }));
  const quiz = createQuizEngine([], words).generateQuiz(30);
  assert.ok(quiz.length > 0);
  assert.ok(quiz.every(q => !q.type.endsWith("_reading")));
  assert.ok(quiz.every(q => !q.type.endsWith("_from_reading")));
});

test("multiple readings split and ambiguous reverse reading is omitted", () => {
  assert.deepEqual(parseReadings("ニチ、 ジツ;ひ, か"), ["ニチ", "ジツ", "ひ", "か"]);
  const rows = Array.from({ length: 6 }, (_, i) => kanji(String.fromCodePoint(0x4e00 + i), `k${i}`));
  rows[0].kunyomi = "ひ、か";
  rows[1].kunyomi = "ひ";
  const quiz = createQuizEngine(rows, []).generateQuiz(30);
  assert.ok(!quiz.some(q => q.sourceId === "k0" && q.type === "kanji_from_reading"));
  assert.ok(!quiz.some(q => q.sourceId === "k1" && q.type === "kanji_from_reading"));
});

test("duplicate meanings make reverse questions ambiguous", () => {
  const rows = Array.from({ length: 6 }, (_, i) => kanji(String.fromCodePoint(0x4e00 + i), `k${i}`));
  rows[0].meaning = "общий";
  rows[1].meaning = "общий";
  const quiz = createQuizEngine(rows, []).generateQuiz(30);
  assert.ok(!quiz.some(q => ["k0", "k1"].includes(q.sourceId) && q.type === "kanji_from_meaning"));
});

test("duplicate display forms cannot create forward questions", () => {
  const words = Array.from({ length: 6 }, (_, i) => word(`w${i}`, { japanese: `ことば${i}`, reading: `ことば${i}` }));
  words[1].japanese = words[0].japanese;
  words[1].reading = words[0].reading;
  const quiz = createQuizEngine([], words).generateQuiz(30);
  assert.ok(!quiz.some(q => ["w0", "w1"].includes(q.sourceId) && q.type === "vocabulary_meaning"));
});

test("small base and incomplete rows do not crash", () => {
  assert.deepEqual(createQuizEngine([kanji("日", "one")], []).generateQuiz(), []);
  const data = normalizeQuizData([kanji("日", "one", { meaning: "" })], [word("w", { meaning_ru: "" })]);
  assert.equal(data.kanji[0].meaning, "");
  assert.equal(data.vocabulary[0].meaning, "");
});

test("new active row becomes eligible on next load and changes display form", () => {
  const base = [kanji("日", "sun")];
  const words = [word("nippon", { japanese: "日本", reading: "にほん" })];
  assert.equal(createQuizEngine(base, words).data.vocabulary[0].displayForm, "にほん");
  assert.equal(createQuizEngine([...base, kanji("本", "book")], words).data.vocabulary[0].displayForm, "日本");
});

test("API all contract uses the existing Sheets response", async () => {
  let requested;
  const data = await loadLearningData("https://example.test/exec", async url => {
    requested = new URL(url).searchParams.get("type");
    return { ok: true, json: async () => ({ success: true, kanji: [], words: [] }) };
  });
  assert.equal(requested, "all");
  assert.deepEqual(data, { kanji: [], words: [] });
});
