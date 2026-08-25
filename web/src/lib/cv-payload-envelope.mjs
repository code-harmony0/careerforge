/**
 * cv-payload-envelope.mjs — the cv-preview agent's output channel.
 *
 * A sibling of cv-envelope.mjs, and deliberately not a reuse of it. That
 * envelope carries fully-filled HTML for ONE resolved template, which cannot be
 * re-rendered into a second theme; the template gallery needs the
 * template-agnostic payload instead, so build-cv-html.mjs can merge the same
 * content into every template in turn. One agent pass, N renders.
 *
 * Every rule here is copied from cv-envelope.mjs on purpose, because the threat
 * is identical: cv.md is user-layer, the agent reading it has no business
 * writing anything, and the alternative to a clean failure is the backend
 * rendering attacker-influenced input and reporting success. So: markers only
 * count on a line of their own, the FIRST closer wins (an injected closer
 * truncates rather than escapes), and more than one envelope is refused outright
 * rather than guessed at.
 *
 * Plain .mjs (same pattern as cv-envelope.mjs / pdf-paths.mjs) so this is
 * unit-testable with `node --test`, no TypeScript build step.
 */

export const OPEN_MARK = "<<cv-payload>>";
export const CLOSE_MARK = "<</cv-payload>>";

// Markers must own their line — otherwise an agent merely *mentioning* the
// syntax in its prose, or a CLI echoing its own prompt back (as `codex exec`
// does), would open or close an envelope.
const OPENER_SRC = String.raw`^<<cv-payload>>[ \t]*$`;
const CLOSER_SRC = String.raw`^<<\/cv-payload>>[ \t]*$`;

// The closer needs two compiled flavours because `exec` on a global regex
// advances `lastIndex` between calls, so the single-shot lookup and the scanning
// one must not share an object.
const OPENER_ALL = new RegExp(OPENER_SRC, "gm");
const CLOSER = new RegExp(CLOSER_SRC, "m");
const CLOSER_ALL = new RegExp(CLOSER_SRC, "gm");

/**
 * The envelope contract as the agent is told it. Lives here beside the parser so
 * the two cannot drift — a rename that updated only the prompt would break every
 * preview run at runtime with the whole suite still green.
 *
 * The markers are described MID-LINE (inside backticks) rather than shown on
 * their own lines, for the `codex exec` prompt-echo reason above.
 */
export const PAYLOAD_ENVELOPE_INSTRUCTION = [
  "Emit the payload inside an envelope: a line containing only `<<cv-payload>>`, then the raw JSON, then a line containing only `<</cv-payload>>`.",
  "Emit it EXACTLY ONCE. Do not wrap the JSON in a markdown code fence. Do not save any file — the platform persists and renders it.",
].join(" ");

/**
 * Parse exactly one `<<cv-payload>>` envelope out of an agent's stdout.
 *
 * Fail-closed at every branch: the caller renders nothing unless `ok` is true.
 *
 * @param {string} text - Everything the CLI wrote to stdout.
 * @returns {{ok: true, payload: object} | {ok: false, error: string}}
 */
export function parseCvPayloadEnvelope(text) {
  if (typeof text !== "string" || !text) {
    return { ok: false, error: "the run produced no output to read a CV payload from" };
  }

  const openers = [...text.matchAll(OPENER_ALL)];
  if (openers.length === 0) {
    return { ok: false, error: "the run emitted no cv-payload envelope" };
  }
  if (openers.length > 1) {
    // Refused rather than "take the last one": two envelopes means either a
    // confused agent or an injected one, and guessing which is authentic is
    // exactly the decision this module exists to avoid making.
    return { ok: false, error: "the run emitted more than one cv-payload envelope" };
  }

  const bodyStart = openers[0].index + openers[0][0].length;
  const rest = text.slice(bodyStart);

  const closer = CLOSER.exec(rest);
  if (!closer) {
    return { ok: false, error: "the cv-payload envelope was never closed" };
  }
  // A second closer is not an error — the FIRST one already won, and anything
  // after it is outside the envelope. Counting them would let injected trailing
  // text fail an otherwise clean run.
  CLOSER_ALL.lastIndex = 0;

  const raw = rest.slice(0, closer.index).trim();
  if (!raw) {
    return { ok: false, error: "the cv-payload envelope was empty" };
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, error: "the cv-payload envelope did not contain valid JSON" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "the cv-payload envelope was not a JSON object" };
  }
  // build-cv-html.mjs reads payload.candidate.name for the header and every
  // template's {{NAME}}. A payload without it renders a nameless CV that looks
  // like a broken template rather than a broken payload, so reject it here.
  const name = payload.candidate && payload.candidate.name;
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, error: "the cv-payload envelope had no candidate.name" };
  }

  return { ok: true, payload };
}
