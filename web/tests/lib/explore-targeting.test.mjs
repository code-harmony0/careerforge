import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadTargetingContext,
  formatTargetingBlock,
  formatSearchGuidance,
  resolvePortalsPath,
} from "../../src/lib/explore-targeting.mjs";

test("loadTargetingContext extracts candidate location and portals allow list", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "targeting-test-"));
  try {
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "config", "profile.yml"),
      `
candidate:
  full_name: Test Candidate
location:
  country: India
  current_city: Bengaluru
  timezone: IST
  visa_status: Indian citizen
  authorized_in:
    - India
  needs_sponsorship: true
target_roles:
  primary:
    - Senior React Native Engineer
  archetypes:
    - name: Mobile Tech Lead
`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(tmp, "portals.yml"),
      `
location_filter:
  allow:
    - India
    - Dubai
    - Saudi Arabia
  block:
    - Nigeria
`,
      "utf8"
    );

    const ctx = loadTargetingContext(tmp);
    assert.equal(ctx.candidate.name, "Test Candidate");
    assert.equal(ctx.candidate.country, "India");
    assert.equal(ctx.candidate.city, "Bengaluru");
    assert.deepEqual(ctx.allowedLocations, ["India", "Dubai", "Saudi Arabia"]);
    assert.deepEqual(ctx.blockedLocations, ["Nigeria"]);
    assert.ok(ctx.targetRoles.includes("Senior React Native Engineer"));
    assert.ok(ctx.targetRoles.includes("Mobile Tech Lead"));

    const block = formatTargetingBlock(ctx);
    assert.match(block, /CANDIDATE TARGETING & ELIGIBILITY/);
    assert.match(block, /India · Bengaluru/);
    assert.match(block, /Worldwide Remote/);
    assert.match(block, /HARD DISQUALIFIERS/);
    assert.match(block, /US Remote only/);

    const guidance = formatSearchGuidance("react native, freelance", ctx);
    assert.match(guidance, /react native, freelance/);
    assert.match(guidance, /worldwide remote/);
    assert.match(guidance, /VERIFY ELIGIBILITY/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadTargetingContext handles empty or missing files gracefully", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "targeting-empty-"));
  try {
    const ctx = loadTargetingContext(tmp);
    assert.equal(ctx.candidate.country, "India");
    assert.deepEqual(ctx.allowedLocations, []);
    assert.deepEqual(ctx.blockedLocations, []);

    const block = formatTargetingBlock(ctx);
    assert.match(block, /CANDIDATE TARGETING & ELIGIBILITY/);
    assert.match(block, /Worldwide Remote/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
