// content.js — the playback engine.
// Holds the active segments in memory and, on every animation frame, sets the
// video's playbackRate to match the timeline. Receives segments from the popup
// via runtime messaging.

(function () {
  'use strict';

  var segments = [];   // [{start, rate}], sorted ascending by start
  var running = false; // rAF loop active?

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
    // Don't fight the recorder: leave playback alone while authoring.
    if (video && segments.length && !window.__speedTrackRecording) {
      var want = rateAt(video.currentTime);
      // null => before the first entry: leave the rate untouched.
      if (want !== null && Math.abs(video.playbackRate - want) > 1e-3) {
        video.playbackRate = want;
      }
    }
    requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    requestAnimationFrame(tick);
  }

  var browserApi = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  if (browserApi && browserApi.runtime && browserApi.runtime.onMessage) {
    browserApi.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.type !== 'applyTrack') return;
      segments = Array.isArray(msg.segments) ? msg.segments.slice() : [];
      segments.sort(function (a, b) { return a.start - b.start; });
      start();
      var video = getVideo();
      sendResponse({ ok: true, segmentCount: segments.length, videoFound: !!video });
      return true;
    });
  }
})();
