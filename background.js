/**
 * YouTube Focus Mode - background service worker
 * --------------------------------------------------------------
 * Owns all storage writes for the productivity time tracker
 * (Feature 4 in content.js). content.js never touches
 * chrome.storage.local for watch-time data directly - it just
 * reports "I watched for N more ms" via chrome.runtime.sendMessage.
 *
 * Centralizing the read-modify-write here, and serializing it
 * through writeQueue below, means that even with several YouTube
 * tabs open at once, the "today" / "this week" totals can never be
 * corrupted by two tabs racing to read-then-write at the same time.
 *
 * This file intentionally does nothing else - no permissions beyond
 * "storage" (already declared in manifest.json) are required.
 * --------------------------------------------------------------
 */

'use strict';

const STATS_KEY = 'yfmWatchStats';
const TRACK_TIME_MESSAGE = 'YFM_TRACK_TIME';

/** YYYY-MM-DD for `d`, in local time. */
function getLocalDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD of the Monday that starts `d`'s week, in local time. */
function getWeekStartKey(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayOfWeek = date.getDay(); // 0 = Sunday ... 6 = Saturday
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  date.setDate(date.getDate() + diffToMonday);
  return getLocalDateKey(date);
}

/**
 * Read the stored stats, roll "today" / "this week" over if the
 * calendar has moved on since the last write, add the new elapsed
 * time, and write back. Must only ever run one-at-a-time - see
 * writeQueue below.
 */
async function applyElapsed(elapsedMs) {
  if (!elapsedMs || elapsedMs <= 0) return;

  const now = new Date();
  const todayKey = getLocalDateKey(now);
  const weekKey = getWeekStartKey(now);

  const stored = await chrome.storage.local.get({
    [STATS_KEY]: { dateKey: todayKey, todayMs: 0, weekKey, weekMs: 0 },
  });
  const stats = stored[STATS_KEY];

  if (stats.dateKey !== todayKey) {
    stats.dateKey = todayKey;
    stats.todayMs = 0;
  }
  if (stats.weekKey !== weekKey) {
    stats.weekKey = weekKey;
    stats.weekMs = 0;
  }

  stats.todayMs += elapsedMs;
  stats.weekMs += elapsedMs;

  await chrome.storage.local.set({ [STATS_KEY]: stats });
}

// Every elapsed-time update is chained onto this single promise, so
// concurrent messages from multiple YouTube tabs can never interleave
// their get/set pairs (no lost updates, no duplicate-write races).
let writeQueue = Promise.resolve();

function queueElapsed(elapsedMs) {
  writeQueue = writeQueue
    .then(() => applyElapsed(elapsedMs))
    .catch((err) => {
      console.error('[YouTube Focus Mode] Failed to persist watch time:', err);
    });
  return writeQueue;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== TRACK_TIME_MESSAGE) return undefined;

  queueElapsed(Number(message.elapsedMs) || 0).then(() => {
    sendResponse({ ok: true });
  });

  return true; // keep the message channel open until sendResponse fires
});
