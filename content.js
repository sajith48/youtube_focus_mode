/**
 * YouTube Focus Mode
 * --------------------------------------------------------------
 * - Removes all YouTube Shorts (shelves, links, sidebar entry,
 *   and direct /shorts/ navigation).
 * - Hides any video card whose title does not match one of the
 *   configured educational keywords (cards are hidden via CSS,
 *   never removed from the DOM, so YouTube's own logic keeps
 *   working).
 * - Auto-skips the first 5 seconds of every video once per load.
 * - Works on YouTube's SPA navigation via MutationObserver +
 *   the `yt-navigate-finish` event, with a small rAF-based
 *   debounce so heavy scrolling doesn't cause repeated full
 *   DOM scans.
 * - ON/OFF TOGGLE: state lives in chrome.storage.local under the
 *   key "focusModeEnabled". When OFF, the MutationObserver is
 *   disconnected, all scanning stops, and a single <html> attribute
 *   (data-yfm-mode) flips the CSS rules in styles.css off, instantly
 *   restoring every hidden element with no per-node DOM work.
 * - PRODUCTIVITY TIME TRACKER: measures real watch time (video
 *   actually playing + tab actually active) and reports it to
 *   background.js, which persists "today" / "this week" totals to
 *   chrome.storage.local for the popup to display. Runs independently
 *   of the ON/OFF toggle above - see Feature 4 below for details.
 * - HIDE RECOMMENDATIONS: hides the watch-page "Up Next" / related
 *   videos list and the Home / Trending / Explore recommended-video
 *   feeds, while leaving Search Results untouched. Implemented as a
 *   second single-attribute CSS switch (data-yfm-page) exactly like
 *   the ON/OFF toggle above, so - like the Shorts-shelf and sidebar
 *   rules - it costs zero MutationObserver work: content.js only ever
 *   writes one attribute per navigation, and styles.css does 100% of
 *   the actual hiding. See Feature 5 below for details.
 * --------------------------------------------------------------
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------
  // Initialization guard - YouTube SPA navigation does NOT reload
  // the content script, so make sure we only ever set this up once.
  // ---------------------------------------------------------------
  if (window.__ytFocusModeInitialized) {
    return;
  }
  window.__ytFocusModeInitialized = true;

  // =================================================================
  // Configuration
  // =================================================================

  const EDUCATIONAL_KEYWORDS = [
    'learn',
    'tutorial',
    'course',
    'programming',
    'coding',
    'science',
    'math',
    'education',
    'lecture',
    'explained',
  ];

  const INTRO_SKIP_SECONDS = 5;

  // Key used in chrome.storage.local to persist the ON/OFF toggle.
  const STORAGE_KEY = 'focusModeEnabled';

  // Attributes used to mark elements we've already inspected, so we
  // never re-run expensive work on the same node twice.
  const ATTR_SHORTS_CHECKED = 'data-yfm-shorts-checked';
  const ATTR_EDU_CHECKED = 'data-yfm-edu-checked';
  const ATTR_HIDDEN = 'data-yfm-hidden';

  // Attribute set on <html> - the single master switch every CSS
  // hiding rule in styles.css is scoped under.
  const ATTR_MODE = 'data-yfm-mode';

  // Attribute set on <html> identifying the current YouTube "surface"
  // (home / trending / explore / watch / search / other), purely from
  // location.pathname. Feature 5 (Hide Recommendations) below is the
  // only thing that reads this - it lets styles.css target "the
  // recommendation feeds" without depending on any of YouTube's own
  // internal page-structure markup, which has changed shape several
  // times over the years.
  const ATTR_PAGE = 'data-yfm-page';

  // Selectors for "video card" containers across all the surfaces
  // YouTube uses (home feed, search results, sidebar, channel pages).
  const VIDEO_ITEM_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
  ].join(',');

  // Selectors for things that can represent a "Shorts shelf".
  const SHORTS_SHELF_SELECTOR = [
    'ytd-reel-shelf-renderer',
    'ytd-rich-shelf-renderer',
    'ytd-rich-section-renderer',
  ].join(',');

  // =================================================================
  // Toggle state
  // =================================================================

  // Optimistically assume ON before chrome.storage resolves. ON is
  // the default/most common state and storage reads are effectively
  // instant, so this avoids a flash of un-filtered content on load.
  let focusModeEnabled = true;
  let isObserving = false;

  // =================================================================
  // Small utilities
  // =================================================================

  /** Hide an element without removing it from the DOM. */
  function hideElement(el) {
    if (!el) return;
    el.setAttribute(ATTR_HIDDEN, 'true');
  }

  /** Get the lower-cased title text of a video card, or '' if not loaded yet. */
  function getCardTitleText(card) {
    const titleEl = card.querySelector(
      '#video-title, #video-title-link, yt-formatted-string#video-title'
    );
    return titleEl ? titleEl.textContent.trim().toLowerCase() : '';
  }

  /** True if the given text contains one of the educational keywords. */
  function isEducational(text) {
    if (!text) return false;
    return EDUCATIONAL_KEYWORDS.some((keyword) => text.includes(keyword));
  }

  // =================================================================
  // Feature 1: Remove Shorts
  // =================================================================

  /**
   * Decide whether a "shelf" container is actually a Shorts shelf.
   * Covers the home feed reel shelf, the rich-shelf variant, and the
   * generic rich-section wrapper that sometimes contains a shelf.
   */
  function isShortsShelf(el) {
    const tag = el.tagName;

    if (tag === 'YTD-REEL-SHELF-RENDERER') return true;

    if (tag === 'YTD-RICH-SHELF-RENDERER') {
      if (el.hasAttribute('is-shorts')) return true;
    }

    // If the shelf contains reel items anywhere inside it, treat it
    // as a Shorts shelf regardless of its outer tag name.
    if (el.querySelector('ytd-reel-item-renderer, ytd-reel-shelf-renderer')) {
      return true;
    }

    // Fall back to checking the visible shelf title text.
    const titleEl = el.querySelector(
      '#title, .title, span#title, yt-formatted-string#title'
    );
    if (titleEl && /shorts/i.test(titleEl.textContent)) {
      return true;
    }

    return false;
  }

  /** Hide the closest "card" container for a given anchor element. */
  function hideCardForLink(anchor) {
    const container = anchor.closest(
      [
        'ytd-rich-item-renderer',
        'ytd-video-renderer',
        'ytd-grid-video-renderer',
        'ytd-compact-video-renderer',
        'ytd-guide-entry-renderer',
        'ytd-mini-guide-entry-renderer',
        'ytd-reel-item-renderer',
      ].join(',')
    );
    hideElement(container || anchor);
  }

  /**
   * Scan (a portion of) the page and hide every trace of Shorts:
   *  - Shelves on the home / subscriptions feed
   *  - Individual video cards that link to /shorts/...
   *  - The "Shorts" entry in the left-hand guide / mini-guide
   *  - Direct navigation to a /shorts/... URL
   */
  function removeShorts(root) {
    // 1) Shorts shelves.
    root.querySelectorAll(`${SHORTS_SHELF_SELECTOR}`).forEach((el) => {
      if (el.hasAttribute(ATTR_SHORTS_CHECKED)) return;
      el.setAttribute(ATTR_SHORTS_CHECKED, 'true');
      if (isShortsShelf(el)) hideElement(el);
    });

    // 2) Any card/link pointing at /shorts/.
    root.querySelectorAll('a[href^="/shorts/"]').forEach((anchor) => {
      if (anchor.hasAttribute(ATTR_SHORTS_CHECKED)) return;
      anchor.setAttribute(ATTR_SHORTS_CHECKED, 'true');
      hideCardForLink(anchor);
    });

    // 3) "Shorts" entry in the sidebar / mini-guide (no href match needed).
    root
      .querySelectorAll('ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer')
      .forEach((entry) => {
        if (entry.hasAttribute(ATTR_SHORTS_CHECKED)) return;
        entry.setAttribute(ATTR_SHORTS_CHECKED, 'true');

        const label =
          entry.querySelector('yt-formatted-string, .title, .item-title')?.textContent?.trim() ||
          entry.querySelector('a')?.getAttribute('title') ||
          entry.querySelector('a')?.getAttribute('aria-label') ||
          '';

        if (/^shorts$/i.test(label)) hideElement(entry);
      });

    // 4) If the user lands directly on a /shorts/<id> URL, bounce them
    //    to the home page so Shorts can never be watched directly.
    if (location.pathname.startsWith('/shorts/')) {
      location.replace('https://www.youtube.com/');
    }
  }

  // =================================================================
  // Feature 2: Educational content filter
  // =================================================================

  /**
   * Hide any video card whose title doesn't contain an educational
   * keyword. Cards with no title yet (lazy-rendered) are left
   * unmarked so they get re-checked on the next pass.
   */
  function filterEducationalContent(root) {
    root.querySelectorAll(VIDEO_ITEM_SELECTOR).forEach((card) => {
      if (card.hasAttribute(ATTR_EDU_CHECKED)) return;

      const title = getCardTitleText(card);
      if (!title) return; // title not rendered yet - try again next pass

      card.setAttribute(ATTR_EDU_CHECKED, 'true');

      if (!isEducational(title)) {
        hideElement(card);
      }
    });
  }

  // =================================================================
  // Feature 3: Auto-skip the first N seconds of every video
  // =================================================================

  // Tracks which video "src" we've already skipped the intro for,
  // so we don't fight the user if they manually seek back near 0:00.
  const skippedSources = new WeakMap();

  function setupAutoSkipIntro() {
    const video = document.querySelector('video.html5-main-video, video');
    if (!video) return;

    // Attach listeners only once per <video> element.
    if (video.dataset.yfmSkipAttached === 'true') return;
    video.dataset.yfmSkipAttached = 'true';

    const trySkip = () => {
      if (!focusModeEnabled) return; // toggle gate - no-op while OFF

      const src = video.currentSrc || video.src;
      if (!src) return;
      if (skippedSources.get(video) === src) return; // already handled this video

      if (video.currentTime >= 0 && video.currentTime < INTRO_SKIP_SECONDS) {
        try {
          video.currentTime = INTRO_SKIP_SECONDS;
        } catch (e) {
          // Some video states throw if seeking too early - ignore and retry on next event.
          return;
        }
        skippedSources.set(video, src);
      }
    };

    video.addEventListener('loadedmetadata', trySkip);
    video.addEventListener('playing', trySkip);
    video.addEventListener('timeupdate', trySkip);
  }

  // =================================================================
  // Feature 4: Productivity Time Tracker
  // =================================================================
  // Measures how long the user actually *watches* video on YouTube
  // and reports elapsed time to background.js, which owns the
  // "today" / "this week" totals in chrome.storage.local (see
  // background.js - centralizing the writes there is what prevents
  // multiple open YouTube tabs from racing each other).
  //
  // This feature intentionally runs independently of the Focus Mode
  // ON/OFF toggle above: it's a passive stats collector, not a
  // content filter, so it keeps measuring watch time even while the
  // toggle is OFF. Flip the flag below if you'd rather it only track
  // while Focus Mode is ON.
  const TRACK_ONLY_WHEN_FOCUS_MODE_ON = false;

  // Message type used to talk to background.js.
  const TRACK_TIME_MESSAGE = 'YFM_TRACK_TIME';

  // <video> events that should trigger a re-check of whether a watch
  // "segment" should be running.
  const WATCH_TRACK_EVENTS = ['playing', 'pause', 'ended', 'waiting', 'emptied'];

  // How often (ms) the in-progress segment is checkpointed to
  // storage. Bounds how much watch time a refresh/crash could lose.
  const TIME_FLUSH_INTERVAL_MS = 10000;

  // Timestamp (Date.now()) the current watch segment started, or
  // null when no segment is running. This single variable is the
  // entire state machine: start/stop are both no-ops when they'd be
  // redundant, which is what guarantees we can never end up with two
  // overlapping segments (and therefore never double-count time, or
  // spin up a second ticking timer).
  let watchSegmentStartMs = null;

  // The <video> element currently wired up for tracking, so we can
  // detect if YouTube swaps in a different player element.
  let timeTrackingVideoEl = null;

  /** True if the tab is the visible, focused one (i.e. not backgrounded). */
  function isTabActive() {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  /** True if `video` is actually advancing right now (not paused/ended/stalled). */
  function isVideoActivelyPlaying(video) {
    return !!video && !video.paused && !video.ended && video.readyState > 2;
  }

  /** Begin a watch segment. No-op if one is already running. */
  function startWatchSegment() {
    if (watchSegmentStartMs !== null) return;
    watchSegmentStartMs = Date.now();
  }

  /** End the current watch segment (if any) and flush its duration. */
  function stopWatchSegment() {
    if (watchSegmentStartMs === null) return;
    const elapsedMs = Date.now() - watchSegmentStartMs;
    watchSegmentStartMs = null;
    sendElapsedTime(elapsedMs);
  }

  /** Send elapsed watch time to background.js for persistence. */
  function sendElapsedTime(elapsedMs) {
    if (!elapsedMs || elapsedMs <= 0) return;
    try {
      chrome.runtime.sendMessage({ type: TRACK_TIME_MESSAGE, elapsedMs }, () => {
        // Touch lastError so a sleeping/restarting service worker
        // never surfaces as an "Unchecked runtime.lastError" warning.
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // Extension was reloaded/updated while this tab was still open.
      // The next periodic tick or navigation will simply try again.
    }
  }

  /** Re-evaluate, from current state, whether a segment should be running. */
  function refreshWatchTracking() {
    if (TRACK_ONLY_WHEN_FOCUS_MODE_ON && !focusModeEnabled) {
      stopWatchSegment();
      return;
    }

    const shouldTrack = isVideoActivelyPlaying(timeTrackingVideoEl) && isTabActive();
    if (shouldTrack) {
      startWatchSegment();
    } else {
      stopWatchSegment();
    }
  }

  /**
   * Make sure tracking listeners are attached to whichever <video>
   * element is currently on the page. Safe to call repeatedly - it
   * uses the same "attach once, guarded by a dataset flag" pattern as
   * setupAutoSkipIntro() above, so re-running it never adds duplicate
   * listeners to the same element.
   */
  function setupWatchTimeTracking() {
    const video = document.querySelector('video.html5-main-video, video');

    if (!video) {
      // No video on this page right now (e.g. the homepage) - don't
      // leave a segment dangling for a video element that's gone.
      timeTrackingVideoEl = null;
      stopWatchSegment();
      return;
    }

    if (video !== timeTrackingVideoEl) {
      timeTrackingVideoEl = video;
      if (video.dataset.yfmTimeTrackAttached !== 'true') {
        video.dataset.yfmTimeTrackAttached = 'true';
        WATCH_TRACK_EVENTS.forEach((evt) => video.addEventListener(evt, refreshWatchTracking));
      }
    }

    refreshWatchTracking();
  }

  /**
   * Runs every TIME_FLUSH_INTERVAL_MS, regardless of the Focus Mode
   * toggle. Re-attaches to the video if needed (a safety net for the
   * rare case where neither yt-navigate-finish nor
   * yt-page-data-updated fired) and checkpoints the in-progress
   * segment so a refresh or crash never loses more than one
   * interval's worth of watch time.
   */
  function timeTrackerTick() {
    setupWatchTimeTracking();

    if (watchSegmentStartMs === null) return;
    const now = Date.now();
    const elapsedMs = now - watchSegmentStartMs;
    watchSegmentStartMs = now; // roll the segment forward instead of stopping it
    sendElapsedTime(elapsedMs);
  }

  // =================================================================
  // Feature 5: Hide Recommendations
  // =================================================================
  // Unlike Features 1-2 (which inspect individual cards via JS because
  // they depend on rendered title text), this feature needs no DOM
  // scanning at all. The only thing that varies is *which page* the
  // user is on, and styles.css already encodes exactly which elements
  // to hide for each page type - so the only job here is keeping a
  // single <html data-yfm-page="..."> attribute in sync with
  // location.pathname. Every actual show/hide is pure CSS, gated
  // under the same html[data-yfm-mode="on"] master switch as the rest
  // of the extension, so turning Focus Mode OFF restores
  // recommendations instantly, with no JS work, exactly like Shorts
  // and the sidebar entry already do.

  /**
   * Classify the current URL into the page "surface" styles.css needs
   * to know about. Pure pathname check - no DOM access - so this is
   * effectively free to call on every navigation.
   */
  function getPageType() {
    const path = location.pathname;
    if (path === '/') return 'home';
    if (path === '/feed/trending') return 'trending';
    if (path === '/feed/explore') return 'explore';
    if (path.startsWith('/watch')) return 'watch';
    if (path.startsWith('/results')) return 'search';
    return 'other';
  }

  /**
   * Reflect the current page type onto <html>. Guarded by a value
   * check so repeated calls (e.g. from both yt-navigate-finish and
   * yt-page-data-updated firing back-to-back) never trigger a
   * redundant attribute write or style recalculation.
   */
  function updatePageType() {
    const type = getPageType();
    if (document.documentElement.getAttribute(ATTR_PAGE) !== type) {
      document.documentElement.setAttribute(ATTR_PAGE, type);
    }
  }

  // =================================================================
  // Orchestration / SPA stability
  // =================================================================

  function runAllFeatures() {
    // Master gate - when the toggle is OFF, this function (and
    // therefore every feature) does nothing at all.
    if (!focusModeEnabled) return;

    removeShorts(document);
    filterEducationalContent(document);
    setupAutoSkipIntro();
  }

  // Debounce repeated DOM mutations (e.g. fast scrolling triggers many
  // mutations) into a single processing pass per animation frame.
  let scheduled = false;
  function scheduleRun() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      runAllFeatures();
    });
  }

  // Watch the whole document for DOM changes (infinite scroll, new
  // recommendations loading, player swaps, etc.). Only active while
  // Focus Mode is ON - see startObserving()/stopObserving().
  const observer = new MutationObserver(() => {
    scheduleRun();
  });

  function startObserving() {
    if (isObserving) return;
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    isObserving = true;
  }

  function stopObserving() {
    if (!isObserving) return;
    observer.disconnect();
    isObserving = false;
  }

  // =================================================================
  // Toggle application
  // =================================================================

  /**
   * Reflects the current focusModeEnabled state onto the page:
   *  - Sets data-yfm-mode="on|off" on <html>. Every hiding rule in
   *    styles.css is scoped under data-yfm-mode="on", so flipping
   *    this single attribute instantly shows/hides everything -
   *    no need to walk the DOM and undo individual hide attributes.
   *  - Starts/stops the MutationObserver so zero DOM scanning happens
   *    while the extension is OFF.
   */
  function applyMode() {
    document.documentElement.setAttribute(ATTR_MODE, focusModeEnabled ? 'on' : 'off');
    updatePageType();

    if (focusModeEnabled) {
      startObserving();
      scheduleRun(); // re-scan immediately to catch anything that loaded while OFF
    } else {
      stopObserving();
    }
  }

  // React live to toggle changes made from the popup (or any other
  // YouTube tab) - chrome.storage.onChanged fires in every extension
  // context, so this keeps all open tabs in sync without messaging.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
      focusModeEnabled = changes[STORAGE_KEY].newValue !== false;
      applyMode();
    }
  });

  // YouTube fires this custom event after every SPA navigation
  // (clicking a video, going back/forward, etc.). runAllFeatures()
  // is a no-op while OFF, so it's safe to leave this listener active
  // unconditionally. setupWatchTimeTracking() and updatePageType()
  // run unconditionally too, since the time tracker and the
  // recommendations page-type attribute are both independent of the
  // toggle (updatePageType() is just an attribute write - it's
  // styles.css's html[data-yfm-mode="on"] scoping, not this call,
  // that actually gates whether anything gets hidden).
  document.addEventListener('yt-navigate-finish', () => {
    scheduleRun();
    setupWatchTimeTracking();
    updatePageType();
  });

  // Some YouTube SPA transitions also fire this event before the
  // navigation completes - harmless to also schedule a pass here.
  document.addEventListener('yt-page-data-updated', () => {
    scheduleRun();
    setupWatchTimeTracking();
    updatePageType();
  });

  // The watch-time tracker (Feature 4) cares about tab/window focus
  // independently of any YouTube event, since a video can keep
  // playing while the tab is backgrounded. These listeners are
  // intentionally unconditional - refreshWatchTracking() is a cheap
  // no-op whenever there's nothing to start or stop.
  document.addEventListener('visibilitychange', refreshWatchTracking);
  window.addEventListener('focus', refreshWatchTracking);
  window.addEventListener('blur', refreshWatchTracking);

  // Best-effort final checkpoint before the page is torn down (tab
  // close, refresh, or navigating off-domain). pagehide fires before
  // unload and also covers bfcache cases beforeunload can miss.
  window.addEventListener('pagehide', () => {
    stopWatchSegment();
  });

  // =================================================================
  // Boot
  // =================================================================

  function init() {
    // Apply the optimistic default immediately so there's no flash
    // of un-filtered content while we wait on chrome.storage.
    applyMode();

    chrome.storage.local.get({ [STORAGE_KEY]: true }, (result) => {
      focusModeEnabled = result[STORAGE_KEY] !== false;
      applyMode();
    });

    // Boot the watch-time tracker. This runs independently of the
    // toggle above. setInterval is created exactly once here, since
    // init() itself only ever runs once per page (the guard at the
    // very top of this file prevents YouTube's SPA navigation from
    // re-running it) - so there is no risk of a second, duplicate
    // ticking timer ever being created.
    setupWatchTimeTracking();
    setInterval(timeTrackerTick, TIME_FLUSH_INTERVAL_MS);
  }

  if (document.documentElement) {
    init();
  } else {
    // Extremely defensive fallback - documentElement always exists
    // by the time content scripts run, but guard just in case.
    document.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();
