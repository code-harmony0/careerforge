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
