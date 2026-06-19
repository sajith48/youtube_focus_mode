/**
 * YouTube Focus Mode - popup script
 * --------------------------------------------------------------
 * Reads/writes the single boolean toggle (focusModeEnabled) in
 * chrome.storage.local. No message-passing to content.js is
 * needed: content.js listens to chrome.storage.onChanged directly,
 * so writing here is enough to apply the change live, on every
 * open YouTube tab, instantly.
 *
 * Also renders the productivity time tracker's "Today" / "This
 * Week" totals, written by background.js under the yfmWatchStats
 * key. The popup only ever reads this key - all writes happen in
 * background.js so concurrent YouTube tabs can't race each other.
 * --------------------------------------------------------------
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'focusModeEnabled';
  const STATS_KEY = 'yfmWatchStats';
  const DEFAULT_STATS = { dateKey: '', todayMs: 0, weekKey: '', weekMs: 0 };

  const toggleBtn = document.getElementById('toggleBtn');
  const statusEl = document.getElementById('status');
  const todayTimeEl = document.getElementById('todayTime');
  const weekTimeEl = document.getElementById('weekTime');

  /** Reflect the given enabled state onto the popup UI. */
  function render(enabled) {
    toggleBtn.textContent = enabled ? 'Focus Mode ON' : 'Focus Mode OFF';
    toggleBtn.classList.toggle('on', enabled);
    toggleBtn.classList.toggle('off', !enabled);
    statusEl.textContent = enabled
      ? 'Shorts hidden, videos filtered, intros skipped.'
      : 'All Focus Mode features are paused.';
  }

  // ---- Watch-time stats helpers ---------------------------------
  // These date-key helpers intentionally mirror the ones in
  // background.js, so the popup can tell - just from the stored
  // dateKey/weekKey - whether the saved totals are stale (e.g. the
  // popup is opened the morning after, before background.js has had
  // a chance to roll the counters over on a fresh watch event).

  function getLocalDateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function getWeekStartKey(d) {
    const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dayOfWeek = date.getDay(); // 0 = Sunday ... 6 = Saturday
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    date.setDate(date.getDate() + diffToMonday);
    return getLocalDateKey(date);
  }

  function formatDuration(ms) {
    const totalMinutes = Math.floor(Math.max(0, ms) / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  /** Paint the Today / This Week values, zeroing out anything stale. */
  function renderStats(stats) {
    const safe = stats || DEFAULT_STATS;
    const now = new Date();
    const todayKey = getLocalDateKey(now);
    const weekKey = getWeekStartKey(now);

    const todayMs = safe.dateKey === todayKey ? safe.todayMs || 0 : 0;
    const weekMs = safe.weekKey === weekKey ? safe.weekMs || 0 : 0;

    todayTimeEl.textContent = formatDuration(todayMs);
    weekTimeEl.textContent = formatDuration(weekMs);
  }

  /** Load the current state from storage and paint the popup. */
  function init() {
    chrome.storage.local.get(
      { [STORAGE_KEY]: true, [STATS_KEY]: DEFAULT_STATS },
      (result) => {
        render(result[STORAGE_KEY] !== false);
        renderStats(result[STATS_KEY]);
      }
    );
  }

  /** Flip the stored state; content.js reacts via storage.onChanged. */
  function handleToggleClick() {
    chrome.storage.local.get({ [STORAGE_KEY]: true }, (result) => {
      const newValue = !(result[STORAGE_KEY] !== false);
      chrome.storage.local.set({ [STORAGE_KEY]: newValue }, () => {
        render(newValue);
      });
    });
  }

  toggleBtn.addEventListener('click', handleToggleClick);

  // Keep the popup live if it's left open while background.js writes
  // a new checkpoint (e.g. inspected via "Inspect popup" in DevTools).
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
      render(changes[STORAGE_KEY].newValue !== false);
    }
    if (Object.prototype.hasOwnProperty.call(changes, STATS_KEY)) {
      renderStats(changes[STATS_KEY].newValue);
    }
  });

  init();
})();
