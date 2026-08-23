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
    // tabId lets the panel read this SAME tab's live form fields directly
    // later (draftFormForUrl's tab-read path) instead of falling back to a
    // fresh, session-less browser for a URL it could otherwise just re-read.
    .set({ pendingCapture: { ...msg.capture, tabId, capturedAt: Date.now() } })
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));

  return true; // keep the message channel open for the async sendResponse above
});

// Toolbar-icon click also opens the panel (without a capture) for ad-hoc chat.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// Screen capture: chrome.tabs.captureVisibleTab needs the "activeTab" grant,
// which Chrome only issues for a genuine top-level user gesture (the action
// icon, a keyboard command, or — this — a context menu selection). A button
// click INSIDE the already-open side panel page does NOT qualify, so the
// panel can't capture directly; this menu item is the real entry point.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "career-ops-screenshot",
    title: "career-ops: attach a screenshot of this page",
    contexts: ["page", "selection", "image"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "career-ops-screenshot" || tab?.id == null) return;
  // Both calls fire synchronously within this gesture-triggered handler —
  // same constraint as the capture listener above.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  chrome.tabs
    .captureVisibleTab(tab.windowId, { format: "png" })
    .then((dataUrl) => chrome.storage.session.set({ pendingScreenshot: { dataUrl, url: tab.url, tabId: tab.id, capturedAt: Date.now() } }))
    .catch(() => {
      /* denied, or the tab navigated away mid-capture — non-fatal, panel just gets nothing */
    });
});
