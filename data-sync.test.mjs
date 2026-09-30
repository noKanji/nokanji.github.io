import test from "node:test";
import assert from "node:assert/strict";
import { createDataSync, REFRESH_INTERVAL } from "./data-sync.mjs";

const payload = { success: true, kanji: [], words: [{ id: "new" }] };
const old = { success: true, kanji: [], words: [{ id: "old" }] };
const NOW = Date.parse("2026-09-30T15:00:00Z");
function setup(options = {}) {
  const applied = [], statuses = [], requests = [], saved = [];
  const sync = createDataSync({ readCache: () => null,
    saveCache: p => saved.push(p), request: async force => { requests.push(force); return payload; },
    apply: p => applied.push(p), isBusy: () => false,
    status: s => statuses.push(s), now: () => NOW, ...options });
  return { sync, applied, statuses, requests, saved };
}

test("fresh cached data opens synchronously without a network request", async () => {
  const x = setup({ readCache: () => ({ payload: old, savedAt: new Date(NOW - 1000).toISOString() }) });
  const started = x.sync.start();
  assert.deepEqual(x.applied, [old]);
  await started;
  assert.deepEqual(x.requests, []);
});

test("stale cache opens before a slow background request resolves", async () => {
  let resolve;
  const x = setup({ readCache: () => ({ payload: old, savedAt: new Date(NOW - REFRESH_INTERVAL).toISOString() }),
    request: () => new Promise(r => { resolve = r; }) });
  await x.sync.start();
  assert.deepEqual(x.applied, [old]);
  resolve(payload);
  await x.sync.refresh();
  assert.deepEqual(x.applied, [old, payload]);
});

test("first run fetches and saves data", async () => {
  const x = setup();
  assert.equal(await x.sync.start(), true);
  assert.deepEqual(x.applied, [payload]);
  assert.deepEqual(x.saved, [payload]);
});

test("manual refresh ignores the fresh-cache interval; concurrent requests coalesce", async () => {
  let resolve;
  let calls = 0;
  const x = setup({ request: force => { assert.equal(force, true); calls++; return new Promise(r => { resolve = r; }); } });
  const a = x.sync.refresh(true), b = x.sync.refresh(true);
  assert.equal(a, b);
  await Promise.resolve();
  resolve(payload);
  await a;
  assert.equal(calls, 1);
});

test("updates wait for the quiz or card session to end", async () => {
  let busy = true;
  const x = setup({ isBusy: () => busy });
  await x.sync.refresh(true);
  assert.deepEqual(x.applied, []);
  assert.deepEqual(x.saved, [payload]);
  assert.equal(x.sync.applyPending(), false);
  busy = false;
  assert.equal(x.sync.applyPending(), true);
  assert.equal(x.sync.applyPending(), false);
  assert.deepEqual(x.applied, [payload]);
});

test("failed request preserves cached data and permits retry", async () => {
  let fail = true;
  const x = setup({ readCache: () => ({ payload: old, savedAt: new Date(NOW).toISOString() }),
    request: async () => { if (fail) throw new Error("Offline"); return payload; } });
  await x.sync.start();
  assert.equal(await x.sync.refresh(true), false);
  assert.deepEqual(x.applied, [old]);
  assert.deepEqual(x.saved, []);
  fail = false;
  assert.equal(await x.sync.refresh(true), true);
});

test("invalid source data never overwrites the saved base", async () => {
  const x = setup({ request: async () => ({ success: true }) });
  assert.equal(await x.sync.refresh(), false);
  assert.deepEqual(x.saved, []);
  assert.deepEqual(x.applied, []);
});

test("offline launch uses stale cache without waiting for a request", async () => {
  const x = setup({ online: () => false, readCache: () => ({ payload: old, savedAt: "invalid" }) });
  await x.sync.start();
  assert.deepEqual(x.applied, [old]);
  assert.deepEqual(x.requests, []);
  assert.equal(x.statuses.at(-1), "offline");
});

test("storage read failure falls back to initial fetch", async () => {
  const x = setup({ readCache: () => { throw new Error("Storage unavailable"); } });
  await x.sync.start();
  assert.deepEqual(x.applied, [payload]);
});
