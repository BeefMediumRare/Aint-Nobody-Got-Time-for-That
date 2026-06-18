// popup.js — parse the textarea and push segments to the active tab.

(function () {
  'use strict';

  var browserApi = (typeof browser !== 'undefined') ? browser : chrome;
  var textarea = document.getElementById('track');
  var applyBtn = document.getElementById('apply');
  var recordBtn = document.getElementById('record');
  var statusEl = document.getElementById('status');

  var recording = false;

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function activeTab() {
    return browserApi.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      return tabs && tabs[0];
    });
  }

  function setRecording(on) {
    recording = on;
    recordBtn.textContent = (on ? 'End recording' : 'Start recording') + ' (⌥⇧R)';
  }

  // Reflect any in-progress session when the popup opens.
  activeTab().then(function (tab) {
    if (!tab) return;
    return browserApi.tabs.sendMessage(tab.id, { type: 'getStatus' }).then(function (resp) {
      setRecording(!!(resp && resp.recording));
      // Pre-fill with the latest recorded track (e.g. a session ended via `r`).
      if (resp && resp.track) textarea.value = resp.track;
    });
  }).catch(function () { /* not a YouTube tab; ignore */ });

  recordBtn.addEventListener('click', function () {
    activeTab().then(function (tab) {
      if (!tab) { setStatus('No active tab.', 'error'); return; }
      if (!recording) {
        return browserApi.tabs.sendMessage(tab.id, { type: 'startRecording' }).then(function () {
          setRecording(true);
          setStatus('Recording. Press 1-4 at any moment to set the speed there.', 'ok');
        });
      }
      return browserApi.tabs.sendMessage(tab.id, { type: 'stopRecording' }).then(function (resp) {
        setRecording(false);
        var track = (resp && resp.track) || '';
        textarea.value = track;
        setStatus(track ? 'Recording ended. Review and Apply.' : 'Recording ended (nothing recorded).', 'ok');
      });
    }).catch(function (err) {
      setStatus('Could not reach the page. Is this a YouTube tab?\n' + err.message, 'error');
    });
  });

  applyBtn.addEventListener('click', function () {
    var result = SpeedTrack.parseTrack(textarea.value);

    if (result.errors.length) {
      var lines = result.errors.map(function (e) { return 'Line ' + e.line + ': ' + e.message; });
      setStatus(lines.join('\n'), 'error');
      return;
    }
    if (!result.segments.length) {
      setStatus('No timeline entries found.', 'error');
      return;
    }

    activeTab().then(function (tab) {
      if (!tab) { setStatus('No active tab.', 'error'); return; }
      return browserApi.tabs.sendMessage(tab.id, {
        type: 'applyTrack',
        segments: result.segments
      }).then(function (resp) {
        if (resp && resp.ok) {
          var note = resp.videoFound ? '' : ' (no <video> on page yet)';
          setStatus('Applied ' + resp.segmentCount + ' segment(s).' + note, 'ok');
        } else {
          setStatus('Applied, but no response from page.', 'ok');
        }
      });
    }).catch(function (err) {
      setStatus('Could not reach the page. Is this a YouTube tab?\n' + err.message, 'error');
    });
  });
})();
