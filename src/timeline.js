// timeline.js — speed-segment overlay on YouTube's progress bar (content script).
//
// Each speed change opens a segment that runs until the next change (the last one
// runs to the end of the video). We draw a colored band over the bar for each
// segment, colored by its speed, so the whole timeline reads as bands of speed.
// Two callers:
//   - author.js (recording): render(cues) on every cue change, clear() at the end.
//     Colored by cue code. Pins the controls visible so the bands don't auto-hide.
//   - content.js (playback): renderSegments(segments) when a track is applied, then
//     refreshSegments(segments) from its rAF loop to redraw if YouTube re-renders
//     the bar. Colored by rate. Controls are NOT pinned — the bands ride the bar's
//     normal show/hide.
//
// Positions are percentage-based against video.duration, so bands survive a resize.

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

  function levels() {
    return (typeof SpeedTrack !== 'undefined') ? SpeedTrack.SPEED_LEVELS : null;
  }

  // Playback gives us a rate, not a code. Reverse-map through SPEED_LEVELS (rates
  // are distinct) so the same colors mean the same speeds as while recording.
  function rateColor(rate) {
    var map = levels();
    if (map) for (var k in map) if (map[k] === rate) return codeColor(Number(k));
    return '#9e9e9e';
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

  // Draw a normalized list of speed-change points [{ t, color, title }] as bands.
  // Each point opens a band that runs to the next point (the last runs to the end
  // of the video), colored by that point's speed. Idempotent: clears + redraws.
  function paint(items) {
    var overlay = ensureOverlay();
    if (!overlay) return;
    overlay.textContent = '';

    if (!items || !items.length) return;

    var video = document.querySelector('video');
    var duration = video && video.duration;
    if (!duration) return; // NaN/0 right after load — nothing sensible to position yet

    // Defensive: spans assume ascending order. Callers already sort, but a stray
    // order would draw overlapping/negative-width bands.
    var points = items.slice().sort(function (a, b) { return a.t - b.t; });

    for (var i = 0; i < points.length; i++) {
      var startT = Math.max(0, Math.min(duration, points[i].t));
      var endT = (i + 1 < points.length) ? points[i + 1].t : duration;
      endT = Math.max(0, Math.min(duration, endT));
      if (endT <= startT) continue;

      var leftPct = (startT / duration) * 100;
      var widthPct = ((endT - startT) / duration) * 100;

      // Sit a little above the thin progress bar (a touch thicker than the bar) so
      // the bands read as a speed legend without hiding YouTube's played-fill.
      var band = document.createElement('div');
      band.style.cssText =
        'position:absolute;bottom:calc(50% + 3px);height:5px;' +
        'pointer-events:none;' +
        'left:' + leftPct + '%;width:' + widthPct + '%;background:' + points[i].color + ';';
      if (points[i].title) band.title = points[i].title;
      overlay.appendChild(band);
    }
  }

  // Recording: cues are { t, code }, colored by code.
  function render(cues) {
    var map = levels();
    paint((cues || []).map(function (cue) {
      return {
        t: cue.t,
        color: codeColor(cue.code),
        title: (map && map[cue.code] != null) ? map[cue.code] + 'x' : ''
      };
    }));
  }

  // Playback: segments are { start, rate }, colored by rate.
  function renderSegments(segments) {
    paint((segments || []).map(function (seg) {
      return { t: seg.start, color: rateColor(seg.rate), title: seg.rate + 'x' };
    }));
  }

  // Cheap to call every frame: only redraws if our overlay vanished (YouTube
  // re-rendered the bar) or hasn't been drawn yet (e.g. duration wasn't ready).
  function refreshSegments(segments) {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay && overlay.isConnected && overlay.firstChild) return;
    renderSegments(segments);
  }

  // Remove the overlay entirely so nothing lingers after the session.
  function clear() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  // Keep YouTube's bottom controls (and thus the progress bar + bands) from
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

  window.SpeedTrackTimeline = {
    render: render,
    renderSegments: renderSegments,
    refreshSegments: refreshSegments,
    clear: clear,
    pin: pin,
    unpin: unpin
  };
})();
