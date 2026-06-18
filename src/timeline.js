// timeline.js — recording-aid overlay (content script).
//
// While a recording session is active, draws a colored tick on YouTube's progress
// bar for each recorded cue, positioned at the cue's timestamp and color-coded by
// speed. This is purely live authoring feedback: author.js calls render(cues) on
// every cue change and clear() when the session ends. Ticks are never shown during
// normal playback.
//
// We lean on the session-scoped assumptions (no resize, video unchanged) so positions
// are percentage-based against video.duration and the bar is found lazily per render.

(function () {
  'use strict';

  var OVERLAY_ID = 'speed-track-tick-overlay';
  var PIN_STYLE_ID = 'speed-track-pin-style';
  var PIN_CLASS = 'speed-track-pin';

  // code -> tick color (1 normal, 2 fast, 3 faster, 4 skip). Kept eyeball-simple.
  function codeColor(code) {
    switch (code) {
      case 1: return '#2e7d32'; // green
      case 2: return '#1565c0'; // blue
      case 3: return '#ef6c00'; // orange
      case 4: return '#c62828'; // red
      default: return '#9e9e9e';
    }
  }

  // The overlay container, lazily (re)created inside the progress bar. Returns null
  // if the progress bar isn't in the DOM yet.
  function ensureOverlay() {
    var existing = document.getElementById(OVERLAY_ID);
    if (existing && existing.isConnected) return existing;

    // Prefer the container: same horizontal extent as the bar, but it won't clip
    // ticks that protrude above/below the thin bar.
    var bar = document.querySelector('.ytp-progress-bar-container') ||
              document.querySelector('.ytp-progress-bar');
    if (!bar) return null;

    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:1000;';
    bar.appendChild(overlay);
    return overlay;
  }

  // Draw all ticks from the full current cue list. Idempotent: clears and redraws.
  function render(cues) {
    var overlay = ensureOverlay();
    if (!overlay) return;
    overlay.textContent = '';

    if (!cues || !cues.length) return;

    var video = document.querySelector('video');
    var duration = video && video.duration;
    if (!duration) return; // NaN/0 right after load — nothing sensible to position yet

    var levels = (typeof SpeedTrack !== 'undefined') ? SpeedTrack.SPEED_LEVELS : null;

    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var pct = Math.max(0, Math.min(100, (cue.t / duration) * 100));

      // Protrude above/below the thin progress bar so ticks are easy to see and
      // their colors are distinguishable; a dark outline keeps them visible against
      // both the red played-fill and the gray track.
      var tick = document.createElement('div');
      tick.style.cssText =
        'position:absolute;top:-7px;height:18px;width:3px;margin-left:-1.5px;border-radius:1px;' +
        'pointer-events:none;box-shadow:0 0 0 1px rgba(0,0,0,0.5);' +
        'left:' + pct + '%;background:' + codeColor(cue.code) + ';';
      if (levels && levels[cue.code] != null) tick.title = levels[cue.code] + 'x';
      overlay.appendChild(tick);
    }
  }

  // Remove the overlay entirely so nothing lingers after the session.
  function clear() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  // Keep YouTube's bottom controls (and thus the progress bar + ticks) from
  // auto-hiding while idle: !important overrides the .ytp-autohide opacity fade,
  // scoped to a class we add to the player only during the session.
  function pin() {
    if (!document.getElementById(PIN_STYLE_ID)) {
      var style = document.createElement('style');
      style.id = PIN_STYLE_ID;
      style.textContent =
        '.html5-video-player.' + PIN_CLASS + ' .ytp-chrome-bottom{opacity:1 !important;}' +
        '.html5-video-player.' + PIN_CLASS + ' .ytp-gradient-bottom{opacity:1 !important;}';
      (document.head || document.documentElement).appendChild(style);
    }
    var player = document.querySelector('.html5-video-player');
    if (player) player.classList.add(PIN_CLASS);
  }

  function unpin() {
    var player = document.querySelector('.html5-video-player');
    if (player) player.classList.remove(PIN_CLASS);
  }

  window.SpeedTrackTimeline = { render: render, clear: clear, pin: pin, unpin: unpin };
})();
