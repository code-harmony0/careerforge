// tests/extension/history-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  saveSession,
  loadSessions,
  getSession,
  deleteSession,
  clearAllSessions,
  getActiveSessionId,
  setActiveSessionId,
  deriveTitle,
  formatSessionTime,
  isMeaningfulSession,
  MAX_SESSIONS,
  SESSIONS_KEY,
  normalizeJobUrl,
  isSameJobUrl,
  findEvaluatedSession,
  findSessionByUrl,
} from "../../extension/lib/history-store.js";

function createMemoryStorage(initial = {}) {
  const store = { ...initial };
  return {
    async get(keys) {
      if (typeof keys === "string") return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        const res = {};
        for (const k of keys) res[k] = store[k];
        return res;
      }
      return { ...store };
    },
    async set(items) {
      Object.assign(store, items);
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete store[k];
    },
  };
}

test("empty sessions with no action/evaluation are NOT saved to history", async () => {
  const storage = createMemoryStorage();

  // Blank session with no messages and no evalResult
  const s1 = await saveSession({ title: "New Conversation", messages: [], history: [] }, storage);
  assert.equal(isMeaningfulSession(s1), false);
  const loaded1 = await loadSessions(storage);
  assert.equal(loaded1.length, 0, "blank session must not appear in history list");

  // Idle capture that was never evaluated or chatted with
  const s2 = await saveSession(
    {
      capture: { title: "Job Page", url: "https://example.com" },
      messages: [],
      history: [],
      evalResult: null,
    },
    storage,
  );
  assert.equal(isMeaningfulSession(s2), false);
  const loaded2 = await loadSessions(storage);
  assert.equal(loaded2.length, 0, "unevaluated capture must not appear in history list");
});

test("saveSession creates a new session with an ID and saves when meaningful", async () => {
  const storage = createMemoryStorage();
  const session = await saveSession(
    {
      capture: { title: "Algoworks — React Native Developer", url: "https://example.com/job" },
      evalResult: { score: 2.9, summary: "Skip due to exp" },
      messages: [{ role: "user", text: "What about the salary?" }],
      history: [{ role: "user", content: "What about the salary?" }],
    },
    storage,
  );

  assert.ok(session.id);
  assert.equal(session.title, "Algoworks");
  assert.ok(session.createdAt);
  assert.ok(session.updatedAt);

  const loaded = await loadSessions(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, session.id);

  const activeId = await getActiveSessionId(storage);
  assert.equal(activeId, session.id);
});

test("saveSession updates an existing session without creating duplicates", async () => {
  const storage = createMemoryStorage();
  const s1 = await saveSession(
    { title: "First title", evalResult: { score: 4.0, summary: "Good fit" }, messages: [] },
    storage,
  );
  assert.equal((await loadSessions(storage)).length, 1);

  await saveSession(
    { ...s1, title: "Updated title", messages: [{ role: "user", text: "hello" }] },
    storage,
  );
  const loaded = await loadSessions(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, s1.id);
  assert.equal(loaded[0].title, "Updated title");
  assert.equal(loaded[0].messages.length, 1);
});

test("loadSessions automatically cleans up pre-existing empty sessions from storage", async () => {
  // Simulate older storage containing an empty session
  const storage = createMemoryStorage({
    [SESSIONS_KEY]: [
      { id: "empty-1", title: "New Conversation", messages: [], history: [] },
      { id: "valid-1", title: "Job Evaluation", evalResult: { score: 3.5 } },
    ],
  });

  const loaded = await loadSessions(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "valid-1");

  // Verify that the empty one was pruned from storage
  const raw = await storage.get(SESSIONS_KEY);
  assert.equal(raw[SESSIONS_KEY].length, 1);
});

test("loadSessions returns sessions sorted by updatedAt descending", async () => {
  const storage = createMemoryStorage();
  const s1 = await saveSession({ title: "Older", evalResult: { score: 3.0 }, updatedAt: 1000 }, storage);
  const s2 = await saveSession({ title: "Newer", evalResult: { score: 4.0 }, updatedAt: 5000 }, storage);

  const loaded = await loadSessions(storage);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].id, s2.id);
  assert.equal(loaded[1].id, s1.id);
});

test("deleteSession removes session and resets activeSessionId if matched", async () => {
  const storage = createMemoryStorage();
  const s1 = await saveSession({ title: "Session 1", evalResult: { score: 3.0 } }, storage);
  const s2 = await saveSession({ title: "Session 2", evalResult: { score: 4.0 } }, storage);

  await setActiveSessionId(s2.id, storage);
  assert.equal(await getActiveSessionId(storage), s2.id);

  const res = await deleteSession(s2.id, storage);
  assert.equal(res, true);
  const loaded = await loadSessions(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, s1.id);
  assert.equal(await getActiveSessionId(storage), null);
});

test("deleteSession leaves activeSessionId intact when deleting an inactive session", async () => {
  const storage = createMemoryStorage();
  const s1 = await saveSession({ title: "Session 1", evalResult: { score: 3.0 } }, storage);
  const s2 = await saveSession({ title: "Session 2", evalResult: { score: 4.0 } }, storage);

  await setActiveSessionId(s1.id, storage);
  assert.equal(await getActiveSessionId(storage), s1.id);

  const res = await deleteSession(s2.id, storage);
  assert.equal(res, true);
  const loaded = await loadSessions(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, s1.id);
  // Active session id should STILL be s1.id
  assert.equal(await getActiveSessionId(storage), s1.id);
});

test("deleteSession handles invalid or non-existent IDs gracefully", async () => {
  const storage = createMemoryStorage();
  const s1 = await saveSession({ title: "Session 1", evalResult: { score: 3.0 } }, storage);

  assert.equal(await deleteSession(null, storage), false);
  assert.equal(await deleteSession("", storage), false);
  assert.equal(await deleteSession("non-existent-id", storage), true);

  const loaded = await loadSessions(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, s1.id);
});

test("clearAllSessions removes all sessions and active id", async () => {
  const storage = createMemoryStorage();
  await saveSession({ title: "Session 1", evalResult: { score: 3.0 } }, storage);
  await saveSession({ title: "Session 2", evalResult: { score: 4.0 } }, storage);

  const res = await clearAllSessions(storage);
  assert.equal(res, true);
  assert.equal((await loadSessions(storage)).length, 0);
  assert.equal(await getActiveSessionId(storage), null);
});

test("clearAllSessions on empty storage succeeds without error", async () => {
  const storage = createMemoryStorage();
  const res = await clearAllSessions(storage);
  assert.equal(res, true);
  assert.equal((await loadSessions(storage)).length, 0);
});

test("deriveTitle uses capture title, summary, or first user message", () => {
  const t1 = deriveTitle({ capture: { title: "RockED — Staff Mobile Developer" } });
  assert.equal(t1, "RockED");

  const t2 = deriveTitle({ evalResult: { summary: "Algoworks hiring React Native lead" } });
  assert.equal(t2, "Algoworks hiring React Native lead");

  const t3 = deriveTitle({ messages: [{ role: "user", text: "Can you help evaluate this role?" }] });
  assert.equal(t3, "Can you help evaluate this role?");
});

test("formatSessionTime formats timestamps cleanly", () => {
  const now = Date.now();
  assert.match(formatSessionTime(now), /^Today, \d+:\d+/);

  const yesterday = now - 24 * 3600 * 1000;
  assert.match(formatSessionTime(yesterday), /^Yesterday, \d+:\d+/);
});

test("saveSession caps at MAX_SESSIONS", async () => {
  const storage = createMemoryStorage();
  for (let i = 0; i < MAX_SESSIONS + 5; i++) {
    await saveSession({ title: `Session ${i}`, evalResult: { score: 3.0 } }, storage);
  }
  const loaded = await loadSessions(storage);
  assert.equal(loaded.length, MAX_SESSIONS);
});

test("normalizeJobUrl and isSameJobUrl match variants of the same job posting", () => {
  // Trailing slash
  assert.ok(isSameJobUrl("https://example.com/jobs/123/", "https://example.com/jobs/123"));

  // Scheme case & host case
  assert.ok(isSameJobUrl("HTTP://EXAMPLE.COM/jobs/123", "https://example.com/jobs/123"));

  // Tracking query parameters
  const withTracking = "https://boards.greenhouse.io/rocked/jobs/123?utm_source=linkedin&utm_medium=job_board&utm_campaign=hiring&gh_src=xyz";
  const clean = "https://boards.greenhouse.io/rocked/jobs/123";
  assert.ok(isSameJobUrl(withTracking, clean));

  // Query parameter sorting
  assert.ok(isSameJobUrl("https://example.com/job?a=1&b=2", "https://example.com/job?b=2&a=1"));

  // Hash fragments
  assert.ok(isSameJobUrl("https://jobs.lever.co/acme/123#overview", "https://jobs.lever.co/acme/123"));

  // Markdown link syntax in tracker
  assert.ok(isSameJobUrl("[greenhouse](https://boards.greenhouse.io/rocked/jobs/123)", clean));

  // LinkedIn job URLs with job id
  const liView = "https://www.linkedin.com/jobs/view/4123456789/";
  const liSlug = "https://www.linkedin.com/jobs/view/staff-mobile-developer-at-rocked-4123456789?refId=abc&trackingId=xyz";
  const liSearch = "https://www.linkedin.com/jobs/search/?currentJobId=4123456789&f_AL=true";
  assert.ok(isSameJobUrl(liView, liSlug));
  assert.ok(isSameJobUrl(liSlug, liSearch));

  // Different jobs must NOT match
  assert.equal(isSameJobUrl("https://example.com/jobs/123", "https://example.com/jobs/456"), false);
  assert.equal(isSameJobUrl("https://www.linkedin.com/jobs/view/111111", "https://www.linkedin.com/jobs/view/222222"), false);
  assert.equal(isSameJobUrl("", "https://example.com"), false);
  assert.equal(isSameJobUrl(null, undefined), false);
});

test("findEvaluatedSession returns existing completed evaluation and ignores un-evaluated sessions", async () => {
  const storage = createMemoryStorage();

  // Session A: un-evaluated capture (evalResult null)
  await saveSession(
    {
      capture: { url: "https://example.com/jobs/pending" },
      evalResult: null,
      messages: [{ role: "user", text: "pending job" }],
    },
    storage,
  );

  // Session B: completed evaluation
  const sB = await saveSession(
    {
      capture: { url: "https://boards.greenhouse.io/rocked/jobs/123" },
      evalResult: { score: 4.2, summary: "Strong match for mobile lead" },
      messages: [],
    },
    storage,
  );

  // Searching for pending job should return null because it's not evaluated
  const foundPending = await findEvaluatedSession("https://example.com/jobs/pending", storage);
  assert.equal(foundPending, null);

  // Searching for rocked job with tracking params should find sB
  const foundRocked = await findEvaluatedSession(
    "https://boards.greenhouse.io/rocked/jobs/123?utm_source=linkedin&utm_campaign=winter",
    storage,
  );
  assert.ok(foundRocked);
  assert.equal(foundRocked.id, sB.id);
  assert.equal(foundRocked.evalResult.score, 4.2);
});

test("findSessionByUrl finds sessions by URL even with slight query/slash variations", async () => {
  const storage = createMemoryStorage();
  const session = await saveSession(
    {
      capture: { url: "https://jobs.ashbyhq.com/company/abc-123/" },
      evalResult: { score: 3.5 },
      messages: [],
    },
    storage,
  );

  const matched = await findSessionByUrl("https://jobs.ashbyhq.com/company/abc-123?utm_source=email", storage);
  assert.ok(matched);
  assert.equal(matched.id, session.id);
});

test("saveSession prevents persisting transient 'evaluating' state to storage", async () => {
  const storage = createMemoryStorage();
  const session = await saveSession(
    {
      capture: { url: "https://example.com/job" },
      evalState: "evaluating",
      evalResult: { score: 4.1 },
      messages: [],
    },
    storage,
  );
  assert.equal(session.evalState, "captured", "transient 'evaluating' state must be saved as captured to avoid zombie spinner");

  const sessionNoCapture = await saveSession(
    {
      evalState: "evaluating",
      evalResult: { score: 4.1 },
      messages: [],
    },
    storage,
  );
  assert.equal(sessionNoCapture.evalState, "idle", "transient 'evaluating' without capture must be saved as idle");
});
