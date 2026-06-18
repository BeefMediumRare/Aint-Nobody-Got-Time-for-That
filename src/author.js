// author.js — authoring mode recorder (content script).
//
//   1. Alt+Shift+R (or the popup button) toggles a session on/off. This shortcut
//      is always live, so the Alt+Shift chord keeps it from firing while typing.
//   2. While recording, bare 1-4 record a cue at the CURRENT playback time with
//      that speed code (1=normal, 2=fast, 3=faster, 4=skip; the first cue anchors
//      at 0:00). Seek freely; the track is sorted by timestamp. The session is a
//      deliberate mode, so plain digits are unambiguous — no focus detection.
//   3. Alt+Shift+R again ends it. The popup fetches the resulting track on open.
//
// A press within MERGE_WINDOW_SEC of the nearest existing cue updates that cue's
// speed (keeping its timestamp) instead of adding a near-duplicate. This window
// therefore also sets the minimum gap between distinct cues.
//
// A cue that matches the speed of the cue right before it is a no-op, so it isn't
// created (on add) or is dropped (on edit) — so pressing the previous segment's
// speed onto a cue is a quick way to delete it.
//
// Keys are detected via e.code and swallowed so the page never acts on them
// (1-4 natively seek YouTube to 10-40%).

(function () {
  'use strict';

  var browserApi = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);

  var KEY_TO_CODE = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4 };
  var MERGE_WINDOW_SEC = 2;  // ±snap-to-existing tolerance (min gap between cues is 2×this)

  var recording = false;
  var cues = [];             // [{ t, code }]

  function getVideo() {
    return document.querySelector('video');
  }

  function sendBadge() {
    if (!browserApi || !browserApi.runtime) return;
    browserApi.runtime.sendMessage({ type: 'badge', recording: recording, count: cues.length });
  }

  function renderTicks() {
    if (window.SpeedTrackTimeline) window.SpeedTrackTimeline.render(cues);
  }

  function clearTicks() {
    if (window.SpeedTrackTimeline) window.SpeedTrackTimeline.clear();
  }

  function startRecording() {
    recording = true;
    cues = [];
    window.__speedTrackRecording = true;
    clearTicks();
    if (window.SpeedTrackTimeline) window.SpeedTrackTimeline.pin();
    sendBadge();
  }

  function stopRecording() {
    recording = false;
    window.__speedTrackRecording = false;
    clearTicks();
    if (window.SpeedTrackTimeline) window.SpeedTrackTimeline.unpin();
    sendBadge();
    return currentTrack();
  }

  function currentTrack() {
    return (typeof SpeedTrack !== 'undefined') ? SpeedTrack.formatTrack(cues) : '';
  }

  function currentVideoId() {
    return (typeof SpeedTrackVideo !== 'undefined') ? SpeedTrackVideo.extractVideoId(location) : null;
  }

  // What the popup needs to build/save a Track: the recorded cues, a formatted
  // text version (legacy/preview), and the video this page is showing.
  function statusResponse() {
    return {
      recording: recording,
      track: currentTrack(),
      cues: cues.slice(),
      videoId: currentVideoId()
    };
  }

  function recordCue(code) {
    // First cue is the baseline -> anchor at 0:00; later ones use real time.
    var video = getVideo();
    var t = cues.length === 0 ? 0 : (video ? video.currentTime : 0);
    SpeedTrack.mergeCue(cues, t, code, MERGE_WINDOW_SEC);
    renderTicks();
    sendBadge();
  }

  function onKeyDown(e) {
    // Alt+Shift+R toggles the session regardless of current state. The chord
    // keeps this always-live shortcut from firing while typing.
    if (e.code === 'KeyR' && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (recording) {
        stopRecording();
        // Ended from the page: ask the background to open the popup so the save
        // dialog is right there (its init shows it when cues are waiting).
        if (browserApi && browserApi.runtime) browserApi.runtime.sendMessage({ type: 'sessionEnded' });
      } else {
        startRecording();
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // During a session, bare 1-4 record speed cues (no modifiers).
    if (!recording) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

    if (Object.prototype.hasOwnProperty.call(KEY_TO_CODE, e.code)) {
      recordCue(KEY_TO_CODE[e.code]);
      e.preventDefault();
      e.stopPropagation();
    }
  }

  window.addEventListener('keydown', onKeyDown, true);

  if (browserApi && browserApi.runtime && browserApi.runtime.onMessage) {
    browserApi.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg) return;
      if (msg.type === 'startRecording') {
        startRecording();
        sendResponse({ ok: true });
      } else if (msg.type === 'stopRecording') {
        stopRecording();
        sendResponse(Object.assign({ ok: true }, statusResponse()));
      } else if (msg.type === 'getStatus') {
        sendResponse(statusResponse());
      }
    });
  }
})();
