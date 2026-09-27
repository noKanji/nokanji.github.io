// Shared card schema for the Google Sheets response.
export const DATA_FIELDS = Object.freeze([
  "id", "kanji", "meaning", "meaning_extra", "onyomi", "kunyomi",
  "components", "stroke_count", "words", "examples", "lesson", "jlpt",
  "image_url", "active", "date_added"
]);

const clean = value => value === null || value === undefined ? "" : String(value).trim();

export function parseGroupedEntries(value) {
  if (!clean(value)) return [];
  return String(value).split(";").map(entry => entry.trim()).filter(Boolean).reduce((items, entry) => {
    const [main = "", reading = "", ...translationParts] = entry.split("|").map(part => part.trim());
    if (!main) return items;
    items.push({ main, reading, translation: translationParts.join("|").trim() });
    return items;
  }, []);
}

export function normalizeCardData(source) {
  const card = {};
  DATA_FIELDS.forEach(field => card[field] = clean(source?.[field]));
  if (!card.id || !card.kanji) return null;
  card.wordItems = parseGroupedEntries(card.words);
  card.exampleItems = parseGroupedEntries(card.examples);
  return card;
}
