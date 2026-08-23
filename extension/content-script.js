// extension/content-script.js
// Relies on lib/extract.js having run first (declared before this file in
// manifest.json's content_scripts.js array) and set self.careerOpsExtract.
(function () {
  if (document.getElementById("career-ops-pill")) return; // frames / re-injection guard

  const pill = document.createElement("div");
  pill.id = "career-ops-pill";
  pill.textContent = "career-ops";
  document.documentElement.appendChild(pill);

  pill.addEventListener("click", () => {
    if (pill.classList.contains("co-busy")) return;
    pill.classList.add("co-busy");
    pill.textContent = "capturing…";
    const capture = self.careerOpsExtract.capturePage(document);
    chrome.runtime.sendMessage({ type: "career-ops:capture", capture }, (resp) => {
      pill.classList.remove("co-busy");
      pill.textContent = chrome.runtime.lastError || !resp?.ok ? "capture failed" : "career-ops";
      if (!chrome.runtime.lastError && resp?.ok) {
        setTimeout(() => {
          pill.textContent = "career-ops";
        }, 1500);
      }
    });
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
