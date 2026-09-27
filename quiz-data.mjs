export async function loadLearningData(apiUrl, fetcher = fetch) {
  const url = new URL(apiUrl);
  url.searchParams.set("type", "all");
  const response = await fetcher(url.href, { cache: "no-cache", redirect: "follow" });
  if (!response.ok) throw new Error(`API вернул код ${response.status}.`);
  const payload = await response.json();
  if (!payload?.success || !Array.isArray(payload.kanji) || !Array.isArray(payload.words)) {
    throw new Error(payload?.error || "API должен возвращать Kanji и «Слова» через type=all.");
  }
  return { kanji: payload.kanji, words: payload.words };
}
