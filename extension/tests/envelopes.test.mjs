// extension/tests/envelopes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvelopes, actionToPath } from "../lib/envelopes.js";

test("parseEnvelopes finds a single complete envelope", () => {
  const text = 'Sure, scoring it now.\n<<act:evaluate {"url":"https://x.com/job"}>>\nDone.';
  const { complete } = parseEnvelopes(text);
  assert.equal(complete.length, 1);
  assert.equal(complete[0].id, "evaluate");
  assert.deepEqual(JSON.parse(complete[0].argsJson), { url: "https://x.com/job" });
});

test("parseEnvelopes ignores envelopes inside code fences", () => {
  const text = "```\n<<act:evaluate {\"url\":\"x\"}>>\n```";
  const { complete } = parseEnvelopes(text);
  assert.equal(complete.length, 0);
});

test("parseEnvelopes returns no complete envelopes for an unterminated one", () => {
  const text = '<<act:evaluate {"url":"https://x.com/job"';
  const { complete } = parseEnvelopes(text);
  assert.equal(complete.length, 0);
});

test("actionToPath maps setStatus to the report page", () => {
  assert.equal(actionToPath("setStatus", { n: "42" }), "/pipeline/42");
});

test("actionToPath maps navigate to its own path arg", () => {
  assert.equal(actionToPath("navigate", { path: "/analytics" }), "/analytics");
});

test("actionToPath falls back to home for an unknown action id", () => {
  assert.equal(actionToPath("somethingNew", {}), "/");
});
