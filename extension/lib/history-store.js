// extension/lib/history-store.js
// Persistent local session & evaluation history for career-ops sidepanel.
// Stores sessions in chrome.storage.local so closing the panel never loses
// the ongoing chat, evaluations, or past conversations.

export const SESSIONS_KEY = "career-ops:chat-sessions";
export const ACTIVE_SESSION_ID_KEY = "career-ops:active-session-id";
export const MAX_SESSIONS = 50;

export function getStorage(customStorage) {
  if (customStorage) return customStorage;
  if (typeof chrome !== "undefined" && chrome?.storage?.local) {
    return chrome.storage.local;
  }
  return null;
}

export function createSessionId() {
  return "session-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

export function formatSessionTime(timestamp) {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (isToday) return `Today, ${timeStr}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${timeStr}`;

  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${timeStr}`;
}

export function deriveTitle({ capture, evalResult, messages }) {
  if (capture?.title && capture.title !== "(untitled page)") {
    return capture.title.replace(/\s*[-—|].*$/, "").trim() || capture.title.slice(0, 40);
  }
  if (evalResult?.summary) {
    const m = evalResult.summary.match(/^([^—–\n.]+)/);
    if (m) return m[1].trim().slice(0, 40);
  }
  const firstUserMsg = messages?.find((m) => m.role === "user");
  if (firstUserMsg?.text) {
    const clean = firstUserMsg.text.trim();
    return clean.slice(0, 36) + (clean.length > 36 ? "…" : "");
  }
  return "Chat " + new Date().toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * A session is only meaningful (worth showing in history) if an evaluation
 * was actually completed or the user engaged in a chat conversation.
 * Empty capture slates or blank idle conversations with no action are excluded.
 */
export function isMeaningfulSession(session) {
  if (!session) return false;
  // Has completed an evaluation with a score
  if (session.evalResult && typeof session.evalResult.score === "number" && !Number.isNaN(session.evalResult.score) && session.evalResult.score > 0) {
    return true;
  }
  // Has user chat messages
  if (Array.isArray(session.messages) && session.messages.some((m) => m.role === "user" && (m.text?.trim() || m.imageDataUrl))) {
    return true;
  }
  // Has LLM history containing user messages
  if (Array.isArray(session.history) && session.history.some((h) => h.role === "user" && h.content?.trim())) {
    return true;
  }
  return false;
}

export async function loadSessions(customStorage) {
  const store = getStorage(customStorage);
  if (!store) return [];
  try {
    const res = await store.get([SESSIONS_KEY]);
    const list = res?.[SESSIONS_KEY];
    if (!Array.isArray(list)) return [];

    // Filter out empty sessions with no evaluation or user chat
    const meaningful = list.filter(isMeaningfulSession).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // Prune existing empty entries from persistent storage if found
    if (meaningful.length !== list.length) {
      await store.set({ [SESSIONS_KEY]: meaningful });
    }

    return meaningful;
  } catch {
    return [];
  }
}

export async function getActiveSessionId(customStorage) {
  const store = getStorage(customStorage);
  if (!store) return null;
  try {
    const res = await store.get([ACTIVE_SESSION_ID_KEY]);
    return res?.[ACTIVE_SESSION_ID_KEY] || null;
  } catch {
    return null;
  }
}

export async function setActiveSessionId(id, customStorage) {
  const store = getStorage(customStorage);
  if (!store) return;
  try {
    if (id) {
      await store.set({ [ACTIVE_SESSION_ID_KEY]: id });
    } else {
      await store.remove([ACTIVE_SESSION_ID_KEY]);
    }
  } catch {}
}

export async function saveSession(session, customStorage) {
  const store = getStorage(customStorage);
  if (!store || !session) return session;
  try {
    const id = session.id || createSessionId();
    // 'evaluating' is an in-memory active state tied to a live abort controller.
    // It must never be written to storage as 'evaluating', which creates zombie
    // spinning states on panel reopen.
    const safeEvalState = session.evalState === "evaluating"
      ? (session.capture?.isListingUrl ? "listing-warning" : (session.capture ? "captured" : "idle"))
      : session.evalState;

    const updated = {
      ...session,
      evalState: safeEvalState,
      id,
      updatedAt: Date.now(),
      createdAt: session.createdAt || Date.now(),
      title: session.title || deriveTitle(session),
    };

    // Only save into the persistent SESSIONS_KEY list if meaningful
    if (isMeaningfulSession(updated)) {
      const sessions = await loadSessions(customStorage);
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx >= 0) {
        sessions[idx] = updated;
      } else {
        sessions.unshift(updated);
      }

      const trimmed = sessions.slice(0, MAX_SESSIONS);
      await store.set({
        [SESSIONS_KEY]: trimmed,
        [ACTIVE_SESSION_ID_KEY]: id,
      });
    } else {
      // Empty sessions are tracked as active ID only, never in history
      await store.set({ [ACTIVE_SESSION_ID_KEY]: id });
    }

    return updated;
  } catch {
    return session;
  }
}

export async function getSession(id, customStorage) {
  if (!id) return null;
  const sessions = await loadSessions(customStorage);
  return sessions.find((s) => s.id === id) || null;
}

export async function deleteSession(id, customStorage) {
  const store = getStorage(customStorage);
  if (!store || !id) return false;
  try {
    const sessions = await loadSessions(customStorage);
    const filtered = sessions.filter((s) => s.id !== id);
    await store.set({ [SESSIONS_KEY]: filtered });

    const activeId = await getActiveSessionId(customStorage);
    if (activeId === id) {
      await setActiveSessionId(null, customStorage);
    }
    return true;
  } catch {
    return false;
  }
}

export async function clearAllSessions(customStorage) {
  const store = getStorage(customStorage);
  if (!store) return false;
  try {
    await store.remove([SESSIONS_KEY, ACTIVE_SESSION_ID_KEY]);
    return true;
  } catch {
    return false;
  }
}

export function extractUrl(str) {
  if (!str) return "";
  const s = String(str).trim();
  const m = s.match(/\[.*?\]\((https?:\/\/[^\s)]+)\)/i);
  if (m) return m[1].trim();
  return s;
}

export function normalizeJobUrl(raw) {
  if (typeof raw !== "string") return "";
  const unwrapped = extractUrl(raw);
  if (!unwrapped) return "";

  try {
    const u = new URL(unwrapped);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";

    // LinkedIn normalization
    if (/(^|\.)linkedin\.com$/i.test(u.hostname)) {
      const match = u.pathname.match(/^\/(?:jobs\/view\/(?:.*-)?|comm\/jobs\/view\/)(\d+)\/?$/i);
      const jobId = match ? match[1] : u.searchParams.get("currentJobId");
      if (jobId) {
        return `https://www.linkedin.com/jobs/view/${jobId}`;
      }
    }

    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase();
    if (u.hostname.endsWith(".") && !u.hostname.endsWith("..")) {
      u.hostname = u.hostname.slice(0, -1);
    }
    u.hash = "";

    // Strip tracking parameters
    const TRACKING_PARAMS = [
      /^utm_/i, /^gh_src$/i, /^fbclid$/i, /^gclid$/i,
      /^mc_cid$/i, /^mc_eid$/i, /^igshid$/i, /^_hsenc$/i, /^_hsmi$/i, /^trk$/i, /^trackingid$/i,
      /^refId$/i, /^trackingId$/i, /^source$/i, /^ref$/i, /^f_AL$/i
    ];

    const keep = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (!TRACKING_PARAMS.some((re) => re.test(k))) {
        keep.push([k, v]);
      }
    }
    keep.sort((a, b) => a[0].localeCompare(b[0]));
    u.search = "";
    for (const [k, v] of keep) {
      u.searchParams.append(k, v);
    }

    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }

    return u.toString();
  } catch {
    return unwrapped.toLowerCase().replace(/\/+$/, "");
  }
}

export function isSameJobUrl(url1, url2) {
  if (!url1 || !url2) return false;
  if (url1 === url2) return true;
  const n1 = normalizeJobUrl(url1);
  const n2 = normalizeJobUrl(url2);
  return Boolean(n1 && n2 && n1 === n2);
}

export async function findSessionByUrl(url, customStorage) {
  if (!url) return null;
  const sessions = await loadSessions(customStorage);
  return sessions.find((s) => s.capture?.url && isSameJobUrl(s.capture.url, url)) || null;
}

export async function findEvaluatedSession(url, customStorage) {
  if (!url) return null;
  const sessions = await loadSessions(customStorage);
  return sessions.find((s) => {
    if (!s.evalResult || typeof s.evalResult.score !== "number" || Number.isNaN(s.evalResult.score) || s.evalResult.score <= 0) return false;
    if (s.capture?.url && isSameJobUrl(s.capture.url, url)) return true;
    return false;
  }) || null;
}
