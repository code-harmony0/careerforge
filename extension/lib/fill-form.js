// extension/lib/fill-form.js
// Companion to extract-form.js: takes the drafted answers from the side panel
// and fills them into the real form fields on the page. The key challenge is
// event dispatching — simply setting .value doesn't trigger React/Angular/Vue
// change detection, so we dispatch the same events a real keystroke would.
//
// NEVER submits the form. Only fills fields. The user reviews and submits.
//
// NOTE: deliberately NOT an ES module — see lib/extract.js's header for why.
// Loaded as a content script alongside extract-form.js.

function fillFormFields(doc, answersMap) {
  doc = doc || document;
  // answersMap: { co0: { value, label, type }, co1: ... }
  // The co* keys match the sequential IDs extract-form.js assigns. We re-walk
  // the DOM in the same order to find matching elements by position, with
  // fallbacks for nativeId / nativeName / label text if the DOM shifted.

  const results = { filled: 0, skipped: 0, errors: [] };

  // ── helpers ──────────────────────────────────────────────────────────────
  // Dispatch events that React 16+, Angular, and Vue all listen for.
  // React uses a synthetic event layer that reads from the native input event,
  // so we need InputEvent (not just Event) with the right inputType.
  function dispatchInputEvents(el) {
    // Focus first — some frameworks listen on focus to initialize.
    el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    // The InputEvent is what React 17+ relies on for controlled inputs.
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    // change + blur finalize the value for Angular's (change) and general
    // blur-based validators.
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  }

  // React 15–18 controlled inputs store internal state via a property
  // descriptor on the prototype. Simply setting .value bypasses it, so
  // React's onChange never fires. The workaround: use the native setter
  // from HTMLInputElement.prototype directly, then dispatch an input event.
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const descriptor =
      Object.getOwnPropertyDescriptor(proto, "value") ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value") ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value") ||
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function fillInput(el, value) {
    setNativeValue(el, value);
    dispatchInputEvents(el);
  }

  function fillSelect(el, value) {
    // Try exact match first, then case-insensitive, then partial.
    const options = Array.from(el.options);
    const match =
      options.find((o) => o.value === value || o.textContent.trim() === value) ||
      options.find((o) => o.value.toLowerCase() === value.toLowerCase() || o.textContent.trim().toLowerCase() === value.toLowerCase()) ||
      options.find((o) => o.textContent.trim().toLowerCase().includes(value.toLowerCase()) || value.toLowerCase().includes(o.textContent.trim().toLowerCase()));
    if (match) {
      el.value = match.value;
      dispatchInputEvents(el);
      return true;
    }
    return false;
  }

  function fillRadio(doc, name, value) {
    const radios = Array.from(doc.querySelectorAll(`input[type=radio][name="${CSS.escape(name)}"]`));
    // Match by value, then by label text.
    const match =
      radios.find((r) => r.value === value) ||
      radios.find((r) => {
        const label = r.closest("label")?.textContent?.trim() || "";
        return label.toLowerCase() === value.toLowerCase() || label.toLowerCase().includes(value.toLowerCase());
      });
    if (match) {
      match.checked = true;
      match.dispatchEvent(new Event("change", { bubbles: true }));
      match.dispatchEvent(new Event("input", { bubbles: true }));
      match.click(); // Some frameworks only listen on click for radios.
      return true;
    }
    return false;
  }

  function fillCheckbox(el, value) {
    const wantChecked = ["true", "yes", "1", "on"].includes(String(value).toLowerCase());
    if (el.checked !== wantChecked) {
      el.checked = wantChecked;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.click(); // Toggle + fire React's onClick handler.
    }
  }

  function fillCombobox(el, value) {
    // A combobox (React Select, Headless UI, etc.) — type the value and hope
    // the dropdown opens. We can't guarantee a match, but typing + dispatching
    // the input event is the closest we get without framework-specific code.
    fillInput(el, value);
    // Give the dropdown time to open, then press Enter to select the first match.
    setTimeout(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    }, 300);
  }

  // ── main walk ────────────────────────────────────────────────────────────
  // Re-extract form elements in the same order extract-form.js uses, so co0
  // maps to the first real field, co1 the second, etc.
  const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
  const isGenericPh = (s) => /^(start typing|select\b|choose|search\b|type\b|--|please select|e\.?g\.?)/i.test(s.trim());

  const els = Array.from(doc.querySelectorAll("input, textarea, select"));
  const seenRadio = new Set();
  let n = 0;

  for (const el of els) {
    const tag = el.tagName.toLowerCase();
    const itype = (el.type || "").toLowerCase();

    // Skip the same elements extract-form.js skips.
    if (tag === "input" && ["hidden", "submit", "button", "image", "reset"].includes(itype)) continue;
    if (el.offsetParent === null && itype !== "radio" && itype !== "checkbox") continue;
    if (el.closest('[class*="autofill" i]')) continue;

    const inReactSelect = el.closest('[class*="select__"], .select-shell');
    const isComboboxRole = el.getAttribute("role") === "combobox";
    if (inReactSelect && tag === "input" && !isComboboxRole) continue;

    const fid = `co${n++}`;
    const answer = answersMap[fid];

    if (!answer || !answer.value || String(answer.value).trim() === "") {
      continue; // No drafted answer for this field.
    }

    const value = String(answer.value).trim();

    try {
      // Combobox (React Select, etc.)
      if (isComboboxRole) {
        fillCombobox(el, value);
        results.filled++;
        continue;
      }

      // Radio group
      if (itype === "radio") {
        const name = el.name;
        if (name && seenRadio.has(name)) {
          n--; // Same adjustment extract-form.js does.
          continue;
        }
        if (name) seenRadio.add(name);
        if (fillRadio(doc, name, value)) {
          results.filled++;
        } else {
          results.skipped++;
          results.errors.push({ id: fid, label: answer.label || name, reason: `No matching radio option for "${value}"` });
        }
        continue;
      }

      // Select dropdown
      if (tag === "select") {
        if (fillSelect(el, value)) {
          results.filled++;
        } else {
          results.skipped++;
          results.errors.push({ id: fid, label: answer.label || el.name, reason: `No matching option for "${value}"` });
        }
        continue;
      }

      // Checkbox
      if (itype === "checkbox") {
        fillCheckbox(el, value);
        results.filled++;
        continue;
      }

      // File input — can't fill programmatically (browser security).
      if (itype === "file") {
        results.skipped++;
        results.errors.push({ id: fid, label: answer.label || el.name, reason: "File inputs can't be filled automatically" });
        continue;
      }

      // Text, textarea, email, tel, url, number, date — all use fillInput.
      fillInput(el, value);
      results.filled++;
    } catch (e) {
      results.skipped++;
      results.errors.push({ id: fid, label: answer.label || "", reason: String(e?.message || e) });
    }
  }

  return results;
}

globalThis.careerOpsExtract = globalThis.careerOpsExtract || {};
globalThis.careerOpsExtract.fillFormFields = fillFormFields;
