async function request(url, fetcher) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(url.href, { cache: "no-cache", redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`API вернул код ${response.status}.`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadLearningData(apiUrl, fetcher = fetch) {
  const allUrl = new URL(apiUrl);
  allUrl.searchParams.set("type", "all");
  const all = await request(allUrl, fetcher);
  if (all?.success && Array.isArray(all.kanji) && Array.isArray(all.words)) {
    return { kanji: all.kanji, words: all.words };
  }

  // Older deployments may ignore `type=all`. Keep the existing kanji views usable.
  const kanjiUrl = new URL(apiUrl);
  const kanji = Array.isArray(all?.items) && all.success ? all : await request(kanjiUrl, fetcher);
  if (!kanji?.success || !Array.isArray(kanji.items)) {
    throw new Error(kanji?.error || all?.error || "API не отдаёт лист Kanji.");
  }
  const wordsUrl = new URL(apiUrl);
  wordsUrl.searchParams.set("type", "words");
  try {
    const words = await request(wordsUrl, fetcher);
    const valid = words?.success && Array.isArray(words.items) &&
      (words.type === "words" || words.items.some(item => item && "japanese" in item && "meaning_ru" in item));
    return { kanji: kanji.items, words: valid ? words.items : null };
  } catch {
    return { kanji: kanji.items, words: null };
  }
}
