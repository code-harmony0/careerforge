// extension/background.js
// host_permissions in manifest.json restricts this worker to localhost/127.0.0.1
// — it is structurally unable to fetch or relay data to any other host.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "career-ops:capture") return false;
  const tabId = sender.tab?.id;
  if (tabId == null) {
    sendResponse({ ok: false, error: "no source tab" });
    return false;
  }

  // Must be called synchronously in the gesture-triggered listener, before any
  // await, or Chrome refuses it as "not a user gesture" (side panel API quirk).
  chrome.sidePanel.open({ tabId }).catch(() => {
    /* already open, or user gesture window closed — non-fatal */
  });

  chrome.storage.session
    .set({ pendingCapture: { ...msg.capture, capturedAt: Date.now() } })
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));

  return true; // keep the message channel open for the async sendResponse above
});

// Toolbar-icon click also opens the panel (without a capture) for ad-hoc chat.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});
