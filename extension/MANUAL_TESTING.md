# Manual End-to-End Testing Checklist

**Status: not yet executed — run these before considering the feature done.**

These scenarios require a real Chrome browser with the unpacked extension
loaded (`chrome://extensions` → "Load unpacked" → select `extension/`) and
the `web/` dev server running locally. They cannot be executed by an
automated agent and must be run by a human.

- [ ] LinkedIn job posting (logged in): click pill → side panel opens →
      capture banner shows the job title → auto-evaluates → score line
      appears with a working `/pipeline/{n}` link.
- [ ] A Greenhouse-hosted posting: same flow.
- [ ] A generic company careers page that is NOT a single posting: click
      pill anyway — evaluation should complete (likely a low/skip verdict,
      not a crash) — confirms no JD-detection heuristic is required.
- [ ] Ask the side panel chat "apply to this" after a capture: assistant
      emits an `apply` envelope → side panel shows "Open in career-ops →
      /apply?url=..." link → clicking it opens/focuses a tab that lands in
      the existing apply flow.
- [ ] Ask "draft a short message to the recruiter for this role": assistant
      replies with plain prose (no envelope needed) grounded in
      cv.md/profile — confirm no fabricated claims per the
      Source-of-Truth Boundary.
- [ ] Stop `web/`'s dev server, click the pill: side panel shows the
      "isn't reachable" message instead of hanging or throwing.
- [ ] In `chrome://extensions`, confirm the extension's permissions
      listing shows only `storage`, `tabs`, `sidePanel`, `activeTab` and
      host access restricted to `localhost`/`127.0.0.1`.
