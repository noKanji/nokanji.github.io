const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();
const kanji = ["日", "本", "山", "川"].map((form, i) => ({ id: `k${i}`, kanji: form, meaning: `значение ${i}`, kunyomi: `よみ${i}`, active: true }));
http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1:8767").pathname;
  if (pathname === "/api") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ success: true, items: kanji })); return; }
  if (pathname === "/config-live.js") { res.setHeader("Content-Type", "text/javascript"); res.end('globalThis.CONFIG = { API_URL: "http://127.0.0.1:8767/api", CACHE_VERSION: "smoke14" };'); return; }
  const filename = path.join(root, pathname === "/" ? "index.html" : pathname);
  if (!filename.startsWith(root) || !fs.existsSync(filename)) { res.writeHead(404).end(); return; }
  const type = filename.endsWith(".js") || filename.endsWith(".mjs") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".html") ? "text/html" : "application/octet-stream";
  res.setHeader("Content-Type", `${type}; charset=utf-8`);
  fs.createReadStream(filename).pipe(res);
}).listen(8767, "127.0.0.1", () => console.log("ready"));
