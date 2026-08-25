// extension/content-script.js
// Relies on lib/extract.js having run first (declared before this file in
// manifest.json's content_scripts.js array) and set self.careerOpsExtract.
(function () {
  if (document.getElementById("career-ops-pill")) return; // frames / re-injection guard

  const pill = document.createElement("div");
  pill.id = "career-ops-pill";
  pill.textContent = "career-ops";
  pill.title = "Click to capture this posting · drag to move";
  document.documentElement.appendChild(pill);

  const IDLE = "career-ops";
  let busy = false;

  /**
   * Return the pill to its resting state.
   *
   * Every exit path routes through here — including the throwing ones. The pill
   * used to set "capturing…" and clear it ONLY in sendMessage's callback, so any
   * synchronous throw before or during that call left it wedged on "capturing…"
   * forever with no way back except a page reload. Two throws are routine, not
   * exotic: capturePage() runs over arbitrary third-party DOM, and
   * chrome.runtime.sendMessage throws "Extension context invalidated" on every
   * page still open from before an extension reload — i.e. immediately after any
   * update.
   */
  function settle(label, revert = true) {
    busy = false;
    pill.classList.remove("co-busy");
    pill.textContent = label;
    if (revert && label !== IDLE) setTimeout(() => (pill.textContent = IDLE), 2000);
  }

  function capture() {
    if (busy) return;
    busy = true;
    pill.classList.add("co-busy");
    pill.textContent = "capturing…";
    let payload;
    try {
      payload = self.careerOpsExtract.capturePage(document);
    } catch {
      settle("couldn't read page");
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "career-ops:capture", capture: payload }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) settle("capture failed");
        else settle(IDLE, false);
      });
    } catch {
      // Almost always "Extension context invalidated" — the extension was
      // reloaded while this page stayed open. Say so, because "capture failed"
      // sends people hunting for a bug when the fix is to reload the tab.
      settle("reload this tab");
    }
  }

  // --- drag ----------------------------------------------------------------
  // Pointer events, not mouse events: one code path covers mouse, touch and pen,
  // and setPointerCapture keeps the drag alive when the pointer crosses an
  // iframe or leaves the window — both of which silently drop a mousemove-based
  // drag partway and strand the pill under the cursor.
  const POS_KEY = "career-ops:pill-pos";
  const DRAG_THRESHOLD = 4; // px before a press becomes a drag rather than a click

  function place(left, top) {
    // Clamped on every placement, not only on drop: a window resized smaller
    // after a drag would otherwise leave the pill parked off-screen with no way
    // to reach it.
    const w = pill.offsetWidth || 90;
    const h = pill.offsetHeight || 32;
    const x = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - w));
    const y = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - h));
    pill.style.left = `${x}px`;
    pill.style.top = `${y}px`;
    pill.style.right = "auto";
    pill.style.bottom = "auto";
    return { x, y };
  }

  try {
    chrome.storage?.local?.get(POS_KEY, (v) => {
      const p = v?.[POS_KEY];
      if (p && typeof p.x === "number" && typeof p.y === "number") place(p.x, p.y);
    });
  } catch {
    /* no storage access on this page — the pill just keeps its CSS default */
  }

  let dragging = false;
  let moved = false;
  let originX = 0;
  let originY = 0;
  let startLeft = 0;
  let startTop = 0;

  pill.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    originX = e.clientX;
    originY = e.clientY;
    const r = pill.getBoundingClientRect();
    startLeft = r.left;
    startTop = r.top;
    pill.setPointerCapture(e.pointerId);
  });

  pill.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - originX;
    const dy = e.clientY - originY;
    // Below the threshold this is still a click, so a slightly shaky press does
    // not silently turn "capture this page" into a one-pixel move.
    if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    moved = true;
    pill.classList.add("co-dragging");
    place(startLeft + dx, startTop + dy);
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    pill.classList.remove("co-dragging");
    try {
      pill.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already released */
    }
    if (!moved) {
      capture();
      return;
    }
    const r = pill.getBoundingClientRect();
    try {
      chrome.storage?.local?.set({ [POS_KEY]: { x: r.left, y: r.top } });
    } catch {
      /* position just won't persist across reloads */
    }
  }

  pill.addEventListener("pointerup", endDrag);
  pill.addEventListener("pointercancel", endDrag);
  // A drag that ends over the pill would otherwise also fire a click.
  pill.addEventListener("click", (e) => {
    if (moved) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  window.addEventListener("resize", () => {
    const r = pill.getBoundingClientRect();
    if (pill.style.left) place(r.left, r.top);
  });
})();

// Answers the side panel's request to read THIS tab's form fields directly —
// the whole point being that it's the user's actual, already-authenticated
// tab, not a second browser with no session (see lib/extract-form.js's
// header). Guarded so a re-injected content script doesn't stack listeners.
if (!self.__coFormListenerInstalled) {
  self.__coFormListenerInstalled = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== "career-ops:extract-form") return false;
    try {
      sendResponse({ ok: true, form: self.careerOpsExtract.extractFormFields(document) });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return false; // synchronous response — no keepalive needed
  });
}
