import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "../helpers/web-ts-alias-loader.mjs";

const codeRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataRoot = mkdtempSync(join(tmpdir(), "co-report-route-"));
const tracker = join(dataRoot, "data", "applications.md");
const ENV_KEYS = ["CAREER_OPS_CODE_ROOT", "CAREER_OPS_ROOT", "CAREER_OPS_DATA_DIR", "CAREER_OPS_TRACKER"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

before(() => {
  process.env.CAREER_OPS_CODE_ROOT = codeRoot;
  process.env.CAREER_OPS_ROOT = dataRoot;
  process.env.CAREER_OPS_DATA_DIR = "";
  process.env.CAREER_OPS_TRACKER = tracker;

  mkdirSync(join(dataRoot, "data"), { recursive: true });
  mkdirSync(join(dataRoot, "reports"), { recursive: true });
  writeFileSync(
    tracker,
    [
      "# Applications Tracker",
      "",
      "| # | Date | Company | Role | Score | Status | PDF | Report | Notes |",
      "|---|---|---|---|---|---|---|---|---|",
      "| 1 | 2026-02-01 | TestCo | Engineer | 4.5/5 | Evaluated | ❌ | [001](../reports/001-testco-2026-02-01.md) | |",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dataRoot, "reports", "001-testco-2026-02-01.md"), "# Evaluation: TestCo\n\nScore: 4.5\n");
});

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dataRoot, { recursive: true, force: true });
});

test("GET /api/report returns application and report data", async () => {
  const { GET } = await import("@/app/api/report/route.ts");
  const req = new Request("http://127.0.0.1/api/report?n=1");
  const res = await GET(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.app.company, "TestCo");
  assert.equal(data.report.file, "001-testco-2026-02-01.md");
  assert.equal(typeof data.content, "string");

  // Also supports ?id= query param
  const reqId = new Request("http://127.0.0.1/api/report?id=1");
  const resId = await GET(reqId);
  assert.equal(resId.status, 200);
  const dataId = await resId.json();
  assert.equal(dataId.app.company, "TestCo");
  assert.equal(dataId.report.file, "001-testco-2026-02-01.md");
});

test("GET /api/report validates missing or invalid n", async () => {
  const { GET } = await import("@/app/api/report/route.ts");
  const res1 = await GET(new Request("http://127.0.0.1/api/report"));
  assert.equal(res1.status, 400);

  const res2 = await GET(new Request("http://127.0.0.1/api/report?n=abc"));
  assert.equal(res2.status, 400);
});

test("GET /api/report returns 404 for unknown report", async () => {
  const { GET } = await import("@/app/api/report/route.ts");
  const res = await GET(new Request("http://127.0.0.1/api/report?n=999"));
  assert.equal(res.status, 404);
});
