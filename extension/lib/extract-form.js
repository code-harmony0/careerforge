// extension/lib/extract-form.js
// Ported from web/src/lib/apply/extract.ts's extractForm(), specifically the
// body of its ctx.evaluate(() => {...}) callback — that closure was ALREADY
// pure DOM code with no Playwright API calls inside it (Playwright only
// supplied the evaluate() transport), so it runs unchanged here against the
// tab the user is actually looking at. Keep the two in sync by hand; there is
// no shared module boundary between a Next.js server lib and a content script.
//
// Why this exists at all: the alternative (web/src/lib/apply/session.ts)
// spins up a SEPARATE, isolated Chrome via Playwright to fetch the URL fresh —
// no cookies, no login, none of the user's actual session. For a form the
// user already has open (logged in, mid-flow), that second browser can land
// somewhere completely different. Reading the live DOM directly has none of
// that problem — same tab, same session, zero extra browser.
//
// NOTE: deliberately NOT an ES module — see lib/extract.js's header for why.
function extractFormFields(doc) {
  doc = doc || document;
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
  const isGenericPh = (s) => /^(start typing|select\b|choose|search\b|type\b|--|please select|e\.?g\.?)/i.test(s.trim());
  const ok = (s) => {
    const t = (s || "").trim();
    return t && !isUuid(t) && !isGenericPh(t) ? t : "";
  };
  const pure = (node) => {
    if (!node) return "";
    const c = node.cloneNode(true);
    c.querySelectorAll?.("input, select, textarea, option, button, [role=option], [class*='menu' i]").forEach((n) => n.remove());
    return clean(c.textContent);
  };

  function fieldGroup(el) {
    return el.closest(
      '[class*="field-entry" i], [class*="fieldEntry" i], [class*="form-group" i], [class*="question" i], [class*="field__" i], [class*="__field" i], fieldset, [class*="field" i]',
    );
  }

  function labelFor(el) {
    const aria = el.getAttribute("aria-label");
    if (ok(aria)) return aria;
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || "").join(" ");
      if (ok(t)) return t;
    }
    const id = el.id;
    if (id) {
      const l = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (l && ok(pure(l))) return pure(l);
    }
    const parentLabel = el.closest("label");
    if (parentLabel && ok(pure(parentLabel))) return pure(parentLabel);
    const grp = fieldGroup(el);
    if (grp) {
      const lab = grp.querySelector('label, legend, [class*="question-title" i], [class*="heading" i], [class*="label" i], [class*="title" i]');
      if (lab && ok(pure(lab))) return pure(lab);
    }
    let c = el.parentElement;
    for (let i = 0; i < 4 && c; i++, c = c.parentElement) {
      const lab = c.querySelector('label, legend, [class*="label" i], [class*="title" i], h3, h4, h5');
      if (lab && ok(pure(lab))) return pure(lab);
    }
    const ph = el.placeholder;
    if (ok(ph)) return ph;
    return ok(el.name);
  }

  function groupLabel(firstRadio, options) {
    const rg = firstRadio.closest("[role=radiogroup], fieldset");
    if (rg) {
      const al = rg.getAttribute("aria-label");
      if (al) return al;
      const lb = rg.getAttribute("aria-labelledby");
      if (lb) {
        const t = lb.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || "").join(" ");
        if (t.trim()) return t;
      }
      const legend = rg.querySelector("legend");
      if (legend?.textContent?.trim()) return legend.textContent;
    }
    const optSet = new Set(options.map((o) => o.toLowerCase()));
    const container = fieldGroup(firstRadio) || firstRadio.parentElement?.parentElement || firstRadio.parentElement;
    if (container) {
      const cands = container.querySelectorAll(
        'label, legend, h1, h2, h3, h4, h5, h6, [class*="question-title" i], [class*="heading" i], [class*="label" i], [class*="title" i], [class*="question" i]',
      );
      for (const c of Array.from(cands)) {
        const t = pure(c);
        if (t && t.length > 2 && t.length < 160 && !optSet.has(t.toLowerCase()) && !isUuid(t) && !isGenericPh(t)) return t;
      }
    }
    return "";
  }

  const fields = [];
  const seenRadio = new Set();
  const els = Array.from(doc.querySelectorAll("input, textarea, select"));
  let n = 0;

  for (const el of els) {
    const tag = el.tagName.toLowerCase();
    const itype = (el.type || "").toLowerCase();
    if (tag === "input" && ["hidden", "submit", "button", "image", "reset"].includes(itype)) continue;
    if (el.offsetParent === null && itype !== "radio" && itype !== "checkbox") continue;
    if (el.closest('[class*="autofill" i]')) continue;

    const inReactSelect = el.closest('[class*="select__"], .select-shell');
    const isCombobox = el.getAttribute("role") === "combobox";
    if (inReactSelect && tag === "input" && !isCombobox) continue;

    const required = el.required || el.getAttribute("aria-required") === "true";
    const nativeId = el.id || undefined;
    const nativeName = el.name || undefined;
    const fid = `co${n++}`;

    if (isCombobox) {
      fields.push({ id: fid, type: "select", combobox: true, label: clean(labelFor(el)), required, options: [], nativeId, nativeName });
      continue;
    }

    if (itype === "radio") {
      const name = el.name;
      if (name && seenRadio.has(name)) {
        n--;
        continue;
      }
      if (name) seenRadio.add(name);
      const group = Array.from(doc.querySelectorAll(`input[type=radio][name="${CSS.escape(name)}"]`));
      const options = group.map((r) => clean(labelFor(r) || r.value)).filter(Boolean);
      fields.push({ id: fid, type: "radio", label: clean(groupLabel(el, options)) || name, required, options });
      continue;
    }

    if (tag === "select") {
      const options = Array.from(el.options).map((o) => clean(o.textContent)).filter((o) => o && !/^(select|choose|--)/i.test(o));
      fields.push({ id: fid, type: "select", label: clean(labelFor(el)), required, options, nativeId, nativeName });
      continue;
    }
    const type = tag === "textarea" ? "textarea" : ["email", "tel", "url", "number", "date", "checkbox", "file"].includes(itype) ? itype : "text";
    const ml = el.maxLength;
    fields.push({
      id: fid,
      type,
      label: clean(labelFor(el)),
      required,
      maxLength: ml && ml > 0 ? ml : undefined,
      value: el.value || undefined,
      nativeId,
      nativeName,
    });
  }
  return { title: doc.title || "", url: location.href, fields };
}

globalThis.careerOpsExtract = globalThis.careerOpsExtract || {};
globalThis.careerOpsExtract.extractFormFields = extractFormFields;
