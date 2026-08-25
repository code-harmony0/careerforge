# CV template gallery — design

**Date:** 2026-08-25
**Problem:** career-ops ships 7 CV templates. None of them are reachable from the web UI. `/cv` renders `cv.md` as styled HTML in its right pane — not a PDF, not themed. Picking a template means hand-editing `cv.template` into `config/profile.yml`.

## Decisions

1. **Previews render the user's real CV**, not sample data. One LLM pass turns `cv.md` into a payload; all templates render from that same payload.
2. **`/cv` becomes tabbed** — `Edit` (the existing editor, unchanged) and `Templates` (the gallery). Each surface gets the full viewport.

## Pipeline

```
cv.md ──(1 CLI pass)──> <<cv-payload>> JSON envelope
                                │
              ┌─────────────────┼─────────────────┐
       build-cv-html.mjs   build-cv-html.mjs   … per template
              │                 │
       generate-pdf.mjs    generate-pdf.mjs
              │                 │
    .career-ops-web/cv-previews/{name}.pdf
```

`node build-cv-html.mjs <payload.json> <out.html> [template.html]` already accepts exactly this shape, so N templates cost N deterministic renders and **one** agent pass.

## Why a JSON payload envelope, not the existing `<<cv-html>>` one

The `pdf` worker's `<<cv-html>>` envelope carries fully-filled HTML for one specific template — it cannot be re-rendered into a second theme. A payload envelope is template-agnostic by construction, which is the whole point of a gallery.

The envelope keeps `cv-envelope.mjs`'s fail-closed rules verbatim: markers own their line, the first closer wins, more than one envelope is refused rather than guessed at. Same reasoning — the alternative to a clean failure is the backend building from attacker-influenced input and reporting success.

## Why a dedicated route, not a new `api/run` kind

`api/run` is a 499-line streaming route whose `pdf` branch is wound through the envelope filter, the tracker write-token, and a two-phase kill timer. Threading a 7-render loop through it risks the CV path that already works. `POST /api/cv-preview` spawns the CLI itself, collects stdout, parses one envelope and renders — no streaming, because the gallery polls a manifest instead.

## Routes

| Route | Behavior |
|---|---|
| `GET /api/cv-templates` | Spawns `cv-templates.mjs list cv`; returns each template plus the selected one and its preview freshness |
| `POST /api/cv-templates` | `{ name }` validated against the discovered set, then merged into `config/profile.yml` as `cv.template` via the same deep-merge + `atomicWriteWithBackup` path `api/profile` uses |
| `GET /api/cv-preview?template=` | Serves the cached PDF inline; 404 when not generated |
| `POST /api/cv-preview` | Runs the payload pass, then renders every template |

## Cache

`.career-ops-web/cv-previews/manifest.json` stores the sha256 of `cv.md` at generation time. Editing the CV makes previews stale and the gallery offers a regenerate bar rather than silently showing an old face.

## Failure modes

No `cv.md` → gallery points at the Edit tab. One template failing → that card shows failed, the rest still render. Concurrent generation → refused while a run is in flight.

## Data contract

`config/profile.yml` is user-layer: the POST merges only the `cv.template` key and never rewrites neighbouring keys. Previews live under `.career-ops-web/` (scratch), not `output/`, so they never mix with real tailored CVs the user sends to employers.
