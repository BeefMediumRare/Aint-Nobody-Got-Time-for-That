// content.js — the playback engine.
// Holds the active segments in memory and, on every animation frame, sets the
// video's playbackRate to match the timeline. Receives segments from the popup
// via runtime messaging.
//
// YouTube is an SPA: clicking a different video in the same tab doesn't reload
// the content script. We watch for that and drop the previous video's track so
// it can't keep driving the new one (and so its ticks and badge don't linger).

(function () {
  'use strict';

  var segments = [];   // [{start, rate, code}], sorted ascending by start
  var running = false; // rAF loop active?
  var appliedId = null; // id of the track currently driving playback (for the popup's marker)
  var showSegments = true; // draw the colored speed bands? (Settings preference)

  var browserApi = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);

  function getVideo() {
    return document.querySelector('video');
  }

  // Rate active at time t: last segment whose start <= t, else null.
  function rateAt(t) {
    var rate = null;
    for (var i = 0; i < segments.length; i++) {
      if (segments[i].start <= t) rate = segments[i].rate;
      else break;
    }
    return rate;
  }

  function tick() {
    if (!running) return;
    var video = getVideo();
    // Don't fight the recorder: leave playback (and its ticks) alone while authoring.
    if (video && segments.length && !window.__speedTrackRecording) {
      var want = rateAt(video.currentTime);
      // null => before the first entry: leave the rate untouched.
      if (want !== null && Math.abs(video.playbackRate - want) > 1e-3) {
        video.playbackRate = want;
      }
      // Keep the bands on the bar; cheap no-op unless YouTube re-rendered it.
      if (showSegments && window.SpeedTrackTimeline) window.SpeedTrackTimeline.refreshSegments(segments);
    }
    requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    requestAnimationFrame(tick);
  }

  // Stop driving playback: drop the track, reset to normal speed, clear the ticks.
  function stop() {
    running = false;
    segments = [];
    appliedId = null;
    var video = getVideo();
    if (video) video.playbackRate = 1;
    if (window.SpeedTrackTimeline) window.SpeedTrackTimeline.clear();
    reportActive(false);
  }

  // ---- In-tab video changes -------------------------------------------------

  function currentId() {
    return (typeof SpeedTrackVideo !== 'undefined') ? SpeedTrackVideo.extractVideoId(location) : null;
  }

  var activeVideoId = currentId();

  // Tell the background which video this tab is on, for the track-count badge.
  function reportVideoId(id) {
    if (browserApi && browserApi.runtime) {
      browserApi.runtime.sendMessage({ type: 'videoId', videoId: id });
    }
  }

  // Tell the background whether a track is currently driving playback, so the
  // toolbar badge can flag it — the on-page cue that survives hiding the bands.
  function reportActive(on) {
    if (browserApi && browserApi.runtime) {
      browserApi.runtime.sendMessage({ type: 'active', on: !!on });
    }
  }

  function handleVideoChange(newId) {
    activeVideoId = newId;
    // Leave an in-progress recording alone; its cues belong to that session.
    if (!window.__speedTrackRecording) {
      var hadTrack = segments.length > 0;
      running = false;
      segments = [];
      appliedId = null;
      // YouTube reuses the same <video> element, so a rate we set would carry
      // over to the new video. Undo it (but only one we actually set).
      var video = getVideo();
      if (hadTrack && video) video.playbackRate = 1;
      if (window.SpeedTrackTimeline) window.SpeedTrackTimeline.clear();
      if (hadTrack) reportActive(false);
    }
    reportVideoId(newId);
  }

  function checkVideoChange() {
    var id = currentId();
    if (id !== activeVideoId) handleVideoChange(id);
  }

  if (browserApi && browserApi.runtime && browserApi.runtime.onMessage) {
    browserApi.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg) return;
      if (msg.type === 'applyTrack') {
        segments = Array.isArray(msg.segments) ? msg.segments.slice() : [];
        segments.sort(function (a, b) { return a.start - b.start; });
        appliedId = msg.id || null;
        start();
        // Show the track's bands straight away (the rAF loop keeps them in sync).
        if (showSegments && window.SpeedTrackTimeline && !window.__speedTrackRecording) {
          window.SpeedTrackTimeline.renderSegments(segments);
        }
        reportActive(segments.length > 0);
        var video = getVideo();
        sendResponse({ ok: true, segmentCount: segments.length, videoFound: !!video });
        return true;
      }
      if (msg.type === 'stopTrack') {
        stop();
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === 'getPlaybackStatus') {
        // Hand back the duration too: the popup normalizes each track's preview
        // strip against it (the tracks it lists are all for this video).
        var v = getVideo();
        sendResponse({
          applied: segments.length > 0,
          appliedId: appliedId,
          duration: (v && isFinite(v.duration)) ? v.duration : null
        });
        return true;
      }
    });
  }

  // ---- Show-segments preference ---------------------------------------------
  //
  // Read once on load, then track live changes from the Settings page: toggling
  // mid-playback adds or clears the bands without touching the playback rate.
  if (typeof SpeedTrackStore !== 'undefined') {
    SpeedTrackStore.getShowSegments().then(function (on) {
      showSegments = on;
      if (!on && window.SpeedTrackTimeline) window.SpeedTrackTimeline.clear();
    });
  }
  if (browserApi && browserApi.storage && browserApi.storage.onChanged) {
    var SHOW_KEY = (typeof SpeedTrackStore !== 'undefined') ? SpeedTrackStore.KEYS.showSegments : 'speedTrack.showSegments';
    browserApi.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[SHOW_KEY]) return;
      showSegments = changes[SHOW_KEY].newValue !== false;
      if (!window.SpeedTrackTimeline || window.__speedTrackRecording) return;
      if (showSegments) window.SpeedTrackTimeline.renderSegments(segments);
      else window.SpeedTrackTimeline.clear();
    });
  }

  // Initial badge sync, then watch for in-tab navigation. yt-navigate-finish is
  // YouTube's SPA "done navigating" event (snappy); the interval is a robust
  // fallback that doesn't depend on YouTube internals. Both funnel through the
  // id comparison, so firing twice is harmless.
  reportVideoId(activeVideoId);
  window.addEventListener('yt-navigate-finish', checkVideoChange);
  document.addEventListener('yt-navigate-finish', checkVideoChange);
  setInterval(checkVideoChange, 1000);
})();
