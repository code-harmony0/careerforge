/**
 * explore-targeting.mjs — extracts candidate location, authorization, and portal
 * targeting constraints to guide AI job search.
 *
 * Ensures AI search strictly respects candidate work authorization (e.g. India,
 * Dubai/UAE, Saudi Arabia, Worldwide remote) and rejects geo-restricted US/Canada
 * roles before surfacing them to the user.
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { getProfilePath } from "./core/profile-path.mjs";

function resolveOverride(value, root) {
  return path.resolve(root, value);
}

export function resolvePortalsPath(root, { env = process.env } = {}) {
  const override = env.CAREER_OPS_PORTALS?.trim();
  return override ? resolveOverride(override, root) : path.join(root, "portals.yml");
}

export function loadTargetingContext(root, { env = process.env } = {}) {
  let profile = null;
  try {
    const profileFile = getProfilePath(root, { env });
    if (fs.existsSync(profileFile)) {
      profile = yaml.load(fs.readFileSync(profileFile, "utf8"));
    }
  } catch {
    profile = null;
  }

  let portals = null;
  try {
    const portalsFile = resolvePortalsPath(root, { env });
    if (fs.existsSync(portalsFile)) {
      portals = yaml.load(fs.readFileSync(portalsFile, "utf8"));
    }
  } catch {
    portals = null;
  }

  const cand = (profile && typeof profile === "object" ? profile.candidate : null) || {};
  const loc = (profile && typeof profile === "object" ? profile.location : null) || {};
  const country = (typeof loc.country === "string" && loc.country.trim()) || "India";
  const city =
    (typeof loc.current_city === "string" && loc.current_city.trim()) ||
    (typeof loc.city === "string" && loc.city.trim() !== "Anywhere" ? loc.city.trim() : "");
  const timezone = typeof loc.timezone === "string" ? loc.timezone.trim() : "";
  const visaStatus = typeof loc.visa_status === "string" ? loc.visa_status.trim() : "";
  const authorizedIn = Array.isArray(loc.authorized_in)
    ? loc.authorized_in.filter((x) => typeof x === "string" && x.trim())
    : [country];
  const needsSponsorship = typeof loc.needs_sponsorship === "boolean" ? loc.needs_sponsorship : true;
  const willingToRelocate = typeof loc.willing_to_relocate === "boolean" ? loc.willing_to_relocate : true;

  const lf = (portals && typeof portals === "object" ? portals.location_filter : null) || {};
  const allowedLocations = Array.isArray(lf.allow)
    ? lf.allow.filter((x) => typeof x === "string" && x.trim())
    : [];
  const blockedLocations = Array.isArray(lf.block)
    ? lf.block.filter((x) => typeof x === "string" && x.trim())
    : [];
  const blockedHard = Array.isArray(lf.block_hard)
    ? lf.block_hard.filter((x) => typeof x === "string" && x.trim())
    : [];

  const roles = (profile && typeof profile === "object" ? profile.target_roles : null) || {};
  const primaryRoles = Array.isArray(roles.primary)
    ? roles.primary.filter((x) => typeof x === "string" && x.trim())
    : [];
  const archetypes = Array.isArray(roles.archetypes)
    ? roles.archetypes
        .map((a) => (a && typeof a === "object" && typeof a.name === "string" ? a.name.trim() : ""))
        .filter(Boolean)
    : [];

  return {
    candidate: {
      name: typeof cand.full_name === "string" ? cand.full_name.trim() : "",
      country,
      city,
      timezone,
      visaStatus: visaStatus || (needsSponsorship ? `Citizen of ${country}; requires visa sponsorship for roles outside ${country}` : ""),
      authorizedIn: authorizedIn.length > 0 ? authorizedIn : [country],
      needsSponsorship,
      willingToRelocate,
    },
    allowedLocations,
    blockedLocations: Array.from(new Set([...blockedLocations, ...blockedHard])),
    targetRoles: Array.from(new Set([...primaryRoles, ...archetypes])),
  };
}

export function formatTargetingBlock(targeting) {
  if (!targeting) return "";
  const { candidate, allowedLocations, blockedLocations, targetRoles } = targeting;
  const lines = [
    "\n--- CANDIDATE TARGETING & ELIGIBILITY CONSTRAINTS (STRICT) ---",
  ];

  const locationBits = [candidate.country, candidate.city, candidate.timezone ? `(${candidate.timezone})` : ""].filter(Boolean);
  if (locationBits.length > 0) {
    lines.push(`- Candidate Home Base: ${locationBits.join(" · ")}`);
  }
  if (candidate.authorizedIn.length > 0) {
    lines.push(`- Authorized to work in: ${candidate.authorizedIn.join(", ")}`);
  }
  if (candidate.visaStatus) {
    lines.push(`- Visa / Work Authorization Status: ${candidate.visaStatus}`);
  }

  lines.push(`- Permitted Work Arrangements & Locations:`);
  lines.push(`  * Worldwide Remote / Contractor: Fully open to global remote openings, international B2B / contractor agreements, or employers hiring in ${candidate.country}. (Must NOT be geo-fenced to North America, US, Canada, or UK residents).`);
  if (allowedLocations.length > 0) {
    lines.push(`  * Allowed On-site / Regional Hubs: ${allowedLocations.join(", ")}`);
  }
  if (candidate.willingToRelocate) {
    lines.push(`  * Relocation: Open to relocating if the employer provides visa sponsorship and relocation.`);
  }

  lines.push(`- CONTRACT & FREELANCE SPECIFICS (CRITICAL):`);
  lines.push(`  * Distinguish GLOBAL / INTERNATIONAL contractors from DOMESTIC geo-fenced contractors.`);
  lines.push(`  * ACCEPT: Roles explicitly open to Worldwide / Global contractors, B2B international contracts (e.g. via Deel, Remote.com, Oyster, or direct invoicing), or contracts in the candidate's allowed regions (${allowedLocations.length > 0 ? allowedLocations.join(", ") : candidate.country}).`);
  lines.push(`  * REJECT: Any contract/freelance role restricted to domestic tax residents (e.g. "US only", "Canada only", "Must reside in North America", "W-2 only", "1099 US-citizens/Green Card only", "UK IR35 only"). Even if labeled "contract" or "freelance", if it requires North American or UK residence/authorization, DISCARD IT.`);

  lines.push(`- HARD DISQUALIFIERS (DISCARD IMMEDIATELY — NEVER PROPOSE):`);
  lines.push(`  * Postings geo-restricted to US, Canada, UK, or EU-citizens only (e.g. "US Remote only", "Must reside in Canada", "US Citizenship or Green Card required", "W-2 only", "Right to work in UK without sponsorship").`);
  if (blockedLocations.length > 0) {
    lines.push(`  * Blocked locations / countries: ${blockedLocations.join(", ")}.`);
  }
  lines.push(`  * On-site or hybrid roles in countries where candidate has no work authorization and no visa sponsorship is mentioned.`);
  lines.push(`  * Aggregated job board search URLs, search result lists (e.g. LinkedIn /jobs/search/, Indeed query pages), or expired/closed listings. ONLY propose direct job opening application links.`);

  if (targetRoles.length > 0) {
    lines.push(`- Candidate Stack & Target Profiles: ${targetRoles.slice(0, 6).join(", ")}`);
  }

  return lines.join("\n") + "\n";
}

export function extractSearchTokens(query) {
  return (query || "")
    .replace(/[^\p{L}\p{N}\s+-]/gu, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

export function formatSearchGuidance(query, targeting) {
  const allowedHubs = targeting?.allowedLocations?.length
    ? targeting.allowedLocations.slice(0, 4).join('" OR "')
    : "Dubai\" OR \"UAE\" OR \"Saudi\" OR \"India";
  const tokens = extractSearchTokens(query);
  const cleanQ = tokens.join(" ");

  // Formulate high-signal search query examples without punctuation
  const sampleAtsQuery = tokens.length > 0
    ? `"${tokens[0]}" ${tokens.slice(1).join(" ")} ("worldwide remote" OR "contractor" OR "${allowedHubs}") (site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com OR site:myworkdayjobs.com)`
    : `("worldwide remote" OR "${allowedHubs}") (site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com)`;

  return `--- SEARCH STRATEGY & REASONING GUIDANCE ---
Target Search Intent: "${cleanQ || query}"
When searching the web:
1. TARGETED QUERIES (NO RAW PUNCTUATION): Formulate clean search queries without commas, e.g.:
   ${sampleAtsQuery}
2. VERIFY LOCATION & WORK RIGHTS BEFORE EMITTING:
   Check the job snippet or JD text for location restrictions. If it says "Canada only", "US only", or "Must be authorized to work in US without sponsorship", DISCARD it immediately and keep looking.
3. CONTRACT ROLES:
   If the search mentions "freelance" or "contract", verify it is open to international / worldwide contractors or remote from India/Gulf. Reject US W-2 or Canadian domestic contractor openings.
4. DIRECT JOB POSTINGS ONLY:
   Emit links pointing to single, live job requisitions on ATS portals (Greenhouse, Lever, Ashby, Workday, etc.) or company career sites.
5. EXPLAIN COMPATIBILITY:
   In the "why" field, state how it matches the user's intent AND why the candidate is eligible (e.g. "Worldwide remote contractor role", "Dubai on-site with visa sponsorship", "India remote/onsite").
`;
}
