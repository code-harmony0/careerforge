// Tests for runJob's liveness contract.
//
// Run:  node --test tests/run-job.test.mjs
//
// The bug these exist for: a `pdf` run on a CLI with no structured event stream
// (6 of the 8 supported CLIs) emits NOTHING but keepalives for minutes — the
// agent phase produces no tool/status events, and cvFilter swallows the
// <<cv-html>> envelope that would otherwise arrive as text. Measured on a live
// run: 80 seconds, 8 keepalives, zero other events. The side panel sat on
// "Starting…" the whole time, indistinguishable from a hang.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob } from "../lib/run-job.js";

/** Stub global fetch with a body that emits the given NDJSON events. */
function stubFetch(events) {
  globalThis.fetch = async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const e of events) controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        controller.close();
      },
    }),
  });
}

const base = { serverUrl: "http://x", cliId: "antigravity", kind: "pdf", input: "039" };

test("a keepalive-only run still reports progress — it is not a hang", async () => {
  stubFetch([{ type: "keepalive" }, { type: "keepalive" }, { type: "done" }]);
  const labels = [];
  await runJob({ ...base, onStatus: (l) => labels.push(l), onDone: () => {}, onError: () => {} });
  assert.ok(labels.length > 0, "keepalives must produce a visible status update");
});

test("keepalive labels carry elapsed time, so the panel visibly advances", async () => {
  stubFetch([{ type: "keepalive" }, { type: "done" }]);
  const labels = [];
  await runJob({ ...base, onStatus: (l) => labels.push(l), onDone: () => {}, onError: () => {} });
  assert.match(labels[0], /\d+s/, `expected an elapsed reading, got ${JSON.stringify(labels[0])}`);
});

test("a keepalive keeps the last real status rather than overwriting it", async () => {
  stubFetch([{ type: "status", label: "Rendering PDF…" }, { type: "keepalive" }, { type: "done" }]);
  const labels = [];
  await runJob({ ...base, onStatus: (l) => labels.push(l), onDone: () => {}, onError: () => {} });
  assert.equal(labels[0], "Rendering PDF…");
  assert.match(labels[1], /Rendering PDF…/, "the phase must survive the keepalive");
});

test("real events still drive the label", async () => {
  stubFetch([{ type: "tool", name: "Read" }, { type: "status", label: "Working…" }, { type: "done" }]);
  const labels = [];
  await runJob({ ...base, onStatus: (l) => labels.push(l), onDone: () => {}, onError: () => {} });
  assert.deepEqual(labels, ["Reading Read…", "Working…"]);
});

test("done still fires and carries accumulated text", async () => {
  stubFetch([{ type: "text", text: "hello " }, { type: "text", text: "world" }, { type: "done", tokens: 5 }]);
  let result;
  await runJob({ ...base, onStatus: () => {}, onDone: (d) => (result = d), onError: () => {} });
  assert.equal(result.text, "hello world");
  assert.equal(result.tokens, 5);
});

test("an error event still surfaces and stops the run", async () => {
  stubFetch([{ type: "keepalive" }, { type: "error", msg: "boom" }, { type: "done" }]);
  let err;
  let done = false;
  await runJob({ ...base, onStatus: () => {}, onDone: () => (done = true), onError: (m) => (err = m) });
  assert.equal(err, "boom");
  assert.equal(done, false, "error must return, not fall through to done");
});

test("a decisions event is surfaced, not reported as a finished CV", async () => {
  // The run stopped to ask; no PDF exists. Routing this to onDone would tell the
  // user their tailored CV is ready when nothing was rendered.
  stubFetch([
    { type: "decisions", reportNum: "041", format: "letter", items: ["SOLID Engineering Principles"] },
    { type: "done", awaitingDecisions: true },
  ]);
  let asked;
  let done = false;
  await runJob({
    ...base,
    onStatus: () => {},
    onDecisions: (d) => (asked = d),
    onDone: () => (done = true),
    onError: () => {},
  });
  assert.deepEqual(asked?.items, ["SOLID Engineering Principles"]);
  assert.equal(asked.reportNum, "041");
  assert.equal(done, true, "the run itself still ends");
});

test("a clean run never asks", async () => {
  stubFetch([{ type: "status", label: "Rendering PDF…" }, { type: "done" }]);
  let asked = null;
  await runJob({ ...base, onStatus: () => {}, onDecisions: (d) => (asked = d), onDone: () => {}, onError: () => {} });
  assert.equal(asked, null);
});

test("a driver with no onDecisions handler does not crash", async () => {
  // Older side-panel code, or the evaluate path, passes no handler.
  stubFetch([{ type: "decisions", items: ["X"] }, { type: "done" }]);
  await assert.doesNotReject(
    runJob({ ...base, onStatus: () => {}, onDone: () => {}, onError: () => {} }),
  );
});
