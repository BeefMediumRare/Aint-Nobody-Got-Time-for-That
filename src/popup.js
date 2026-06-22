// popup.js — per-video track picker.
//
// Tracks are JSON documents persisted in storage.local and matched to the page's
// video by id. The popup lists the tracks for the current video, applies a chosen
// one (resolving its codes through the user's speed prefs into segments for the
// playback engine), saves new recordings, and imports/exports track JSON.

(function () {
  'use strict';

  var browserApi = (typeof browser !== 'undefined') ? browser : chrome;

  var recordBtn = document.getElementById('record');
  var statusEl = document.getElementById('status');

  var saveForm = document.getElementById('save-form');
  var titleInput = document.getElementById('save-title');
  var descInput = document.getElementById('save-desc');
  var saveBtn = document.getElementById('save-track');

  var headingEl = document.getElementById('tracks-heading');
  var listEl = document.getElementById('track-list');
  var emptyEl = document.getElementById('tracks-empty');
  var noticesEl = document.getElementById('source-notices');

  var refreshBtn = document.getElementById('refresh-repos');
  var optionsBtn = document.getElementById('open-options');
  var autoApplyToggle = document.getElementById('auto-apply');

  var recording = false;
  var videoId = null;
  var speedLevels = null;     // code->rate prefs, loaded once on open
  var pendingCues = null;     // cues from a just-ended recording, awaiting a title
  var editingId = null;       // id of the track being edited (null = saving a new one)
  var appliedId = null;       // id of the track currently driving playback, for the active marker
  var currentDuration = null; // current video's duration, for sizing the preview strips
  var currentTracks = [];     // [{ track, writable }] for the current video

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function show(el, on) {
    el.classList.toggle('hidden', !on);
  }

  function activeTab() {
    return browserApi.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      return tabs && tabs[0];
    });
  }

  function setRecording(on) {
    recording = on;
    // The dot and shortcut chip are static markup; only swap the label and toggle
    // the pulsing-dot state.
    recordBtn.classList.toggle('recording', on);
    var label = recordBtn.querySelector('.rec-label');
    if (label) label.textContent = on ? 'End recording' : 'Start recording';
  }

  function smallButton(label, onClick) {
    var b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // A thin preview of the track's speed shape, colored from the shared ramp — the
  // same bands the on-page timeline draws, so a glance here matches the bar there.
  // Each cue opens a band running to the next (the last runs to the video's end).
  // Without a known duration (no <video> yet), the trailing band gets an average-
  // gap tail so the shape still reads, just not to scale.
  function renderStrip(track) {
    var strip = document.createElement('div');
    strip.className = 'track-strip';
    var theme = window.SpeedTrackTheme;
    var cues = SpeedTrack.trackToCues(track);
    if (!theme || !cues || !cues.length) return strip;
    cues = cues.slice().sort(function (a, b) { return a.t - b.t; });

    var first = cues[0].t, last = cues[cues.length - 1].t;
    var haveDuration = currentDuration && isFinite(currentDuration) && currentDuration > 0;
    var tail = cues.length > 1 ? (last - first) / (cues.length - 1) : Math.max(last * 0.1, 1);
    var total = haveDuration ? currentDuration : (last + tail);
    if (total <= 0) return strip;

    for (var i = 0; i < cues.length; i++) {
      var start = cues[i].t;
      var end = (i + 1 < cues.length) ? cues[i + 1].t : (haveDuration ? currentDuration : last + tail);
      if (end <= start) continue;
      var piece = document.createElement('span');
      piece.style.left = Math.max(0, start / total) * 100 + '%';
      piece.style.width = Math.min(1, (end - start) / total) * 100 + '%';
      piece.style.background = theme.speed[cues[i].code] || theme.speedDefault;
      if (speedLevels && speedLevels[cues[i].code] != null) piece.title = speedLevels[cues[i].code] + 'x';
      strip.appendChild(piece);
    }
    return strip;
  }

  // The payoff under the strip: how much watch time this track trims at the user's
  // current speeds, against the loaded video's length. Leads with the duration (a
  // mono figure, like the badges), percentage second. Hidden until both the speeds
  // and the video duration are known (timeSaved needs the duration to size the last
  // band). A track that only sets normal speed saves nothing — say so plainly.
  function renderSavings(track) {
    if (!speedLevels) return null;
    var saved = SpeedTrack.timeSaved(track, speedLevels, currentDuration);
    if (saved == null) return null;

    var row = document.createElement('div');
    row.className = 'track-savings';

    if (saved < 1 && saved > -1) {
      row.textContent = 'No time saved';
      return row;
    }

    var saves = saved >= 1;
    row.classList.add(saves ? 'track-savings--saves' : 'track-savings--adds');
    var pct = Math.round(Math.abs(saved) / currentDuration * 100);

    var lead = document.createElement('span');
    lead.textContent = saves ? 'Saves' : 'Adds';
    var time = document.createElement('span');
    time.className = 'track-savings-time';
    time.textContent = SpeedTrack.formatTimestamp(Math.abs(saved));
    var pctEl = document.createElement('span');
    pctEl.textContent = '· ' + pct + '%';

    row.appendChild(lead);
    row.appendChild(time);
    row.appendChild(pctEl);
    return row;
  }

  // ---- Render the matching tracks -------------------------------------------

  function renderTracks() {
    listEl.textContent = '';
    noticesEl.textContent = '';
    if (!videoId) {
      currentTracks = [];
      headingEl.textContent = 'Tracks';
      emptyEl.textContent = 'Open a YouTube video to record a track or apply one.';
      show(emptyEl, true);
      refreshSaveButton();
      return Promise.resolve();
    }
    headingEl.textContent = 'Tracks for this video';
    // Local tracks are writable; tracks synced from a repo are read-only
    // (Apply/Download only) and carry the source label for display.
    return SpeedTrackSources.listTracksForVideo(videoId).then(function (result) {
      currentTracks = result.entries.map(function (e) {
        return { track: e.track, writable: e.writable, sourceLabel: e.sourceLabel, sourceUrl: e.sourceUrl };
      });
      emptyEl.textContent = 'No tracks for this video yet. Record one, or add a repository in settings.';
      show(emptyEl, currentTracks.length === 0);
      currentTracks.forEach(function (e) {
        listEl.appendChild(renderTrackItem(e.track, e.writable, e.sourceLabel, e.sourceUrl));
      });
      if (result.notices && result.notices.length) noticesEl.textContent = result.notices.join(' ');
      refreshSaveButton();
    });
  }

  // The existing track (if any) for the current video matching a title. When
  // editing, the track being edited is excluded so its own (unchanged) title
  // isn't read as a clash with itself.
  function findTrackEntry(title, excludeId) {
    for (var i = 0; i < currentTracks.length; i++) {
      var entry = currentTracks[i];
      if (entry.track.title !== title) continue;
      if (excludeId && entry.track.id === excludeId) continue;
      return entry;
    }
    return null;
  }

  // The Save button reflects what saving the current title would do:
  // - editing, no title clash -> "Update track" (updates in place by id)
  // - editing, title now owned by a different local track -> blocked (titles stay unique)
  // - new track, title matches a local one -> "Overwrite track"
  // - any title that matches a read-only repo track -> blocked
  function refreshSaveButton() {
    var match = findTrackEntry(titleInput.value.trim(), editingId);
    if (match && !match.writable) {
      saveBtn.textContent = "Can't overwrite a read-only track";
      saveBtn.disabled = true;
    } else if (editingId) {
      saveBtn.textContent = match ? 'Title already taken' : 'Update track';
      saveBtn.disabled = !!match;
    } else {
      saveBtn.textContent = match ? 'Overwrite track' : 'Save track';
      saveBtn.disabled = false;
    }
  }

  function renderTrackItem(track, writable, sourceLabel, sourceUrl) {
    var li = document.createElement('li');
    li.className = 'track';
    // Tint the user's own (local, authored) tracks so they stand apart from the
    // read-only ones synced from a repo.
    li.classList.add(writable ? 'track--local' : 'track--repo');
    // Mark the track currently driving playback so it's obvious which one is live.
    var isActive = !!(appliedId && track.id === appliedId);
    if (isActive) li.classList.add('track--active');

    var title = document.createElement('div');
    title.className = 'track-title';
    title.textContent = track.title || '(untitled)';
    if (isActive) {
      var badge = document.createElement('span');
      badge.className = 'track-active-badge';
      badge.textContent = 'Active';
      title.appendChild(badge);
    } else if (writable) {
      // Local tracks are an author's work-in-progress until committed to a repo;
      // flag them so they're not mistaken for a published one. (The active glow
      // takes the title's chip slot when the track is live.)
      var draft = document.createElement('span');
      draft.className = 'track-draft-badge';
      draft.textContent = 'Draft';
      title.appendChild(draft);
    }
    li.appendChild(title);

    if (track.description) {
      var desc = document.createElement('div');
      desc.className = 'track-desc';
      desc.textContent = track.description;
      li.appendChild(desc);
    }

    // Read-only tracks come from a repo; show where so it's clear they can't be
    // edited or overwritten here.
    if (!writable && sourceLabel) {
      var src = document.createElement('div');
      src.className = 'muted';
      src.appendChild(document.createTextNode('from '));
      if (sourceUrl) {
        // Link to the repo folder it was synced from, opened in a new tab.
        var link = document.createElement('a');
        link.href = sourceUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = sourceLabel;
        src.appendChild(link);
      } else {
        src.appendChild(document.createTextNode(sourceLabel));
      }
      li.appendChild(src);
    }

    li.appendChild(renderStrip(track));
    var savings = renderSavings(track);
    if (savings) li.appendChild(savings);

    var actions = document.createElement('div');
    actions.className = 'track-actions';
    // The live track's primary button stops playback; every other row's applies.
    // That keeps one transport control, always sitting on the track it affects.
    var primary = isActive
      ? smallButton('Stop', function () { stopTrack(); })
      : smallButton('Apply', function () { applyTrack(track); });
    primary.className = 'primary';
    actions.appendChild(primary);
    if (writable) actions.appendChild(smallButton('Edit', function () { editTrack(track); }));
    // Clone forks any track into a new, editable local copy. For repo tracks it's
    // the only way to make them editable; for local tracks it's how you fork a
    // variant without overwriting the original (since Edit now updates in place).
    actions.appendChild(smallButton('Clone', function () { cloneTrack(track); }));
    actions.appendChild(smallButton('Download', function () { downloadTrack(track); }));
    if (writable) {
      var del = smallButton('Delete', function () { deleteTrack(track); });
      del.className = 'danger';
      actions.appendChild(del);
    }
    li.appendChild(actions);

    return li;
  }

  // ---- Actions --------------------------------------------------------------

  function applyTrack(track) {
    var segments = SpeedTrack.trackToSegments(track, speedLevels);
    if (!segments.length) { setStatus('Track has no usable cues.', 'error'); return; }
    activeTab().then(function (tab) {
      if (!tab) { setStatus('No active tab.', 'error'); return; }
      return browserApi.tabs.sendMessage(tab.id, { type: 'applyTrack', segments: segments, id: track.id });
    }).then(function (resp) {
      if (resp && resp.ok) {
        appliedId = track.id;
        renderTracks();
        var note = resp.videoFound ? '' : ' (no video on the page yet)';
        setStatus('Applied "' + track.title + '", ' + resp.segmentCount + ' segment(s).' + note, 'ok');
      } else if (resp !== undefined) {
        setStatus("Applied, but the page didn't respond.", 'ok');
      }
    }).catch(function (err) {
      setStatus("Couldn't reach the page. Is this a YouTube tab?\n" + err.message, 'error');
    });
  }

  // Stop the live track and reset the page to 1×. Invoked from the active row's
  // primary button (which reads "Stop" while that track is playing).
  function stopTrack() {
    activeTab().then(function (tab) {
      if (!tab) { setStatus('No active tab.', 'error'); return; }
      return browserApi.tabs.sendMessage(tab.id, { type: 'stopTrack' }).then(function (resp) {
        if (resp && resp.ok) {
          appliedId = null;
          renderTracks();
          setStatus('Stopped. Speed back to 1×.', 'ok');
        }
      });
    }).catch(function (err) {
      setStatus("Couldn't reach the page. Is this a YouTube tab?\n" + err.message, 'error');
    });
  }

  function downloadTrack(track) {
    var name = (track.youtubeVideoId || 'video') + '_' + SpeedTrack.slugifyTitle(track.title) + SpeedTrack.TRACK_EXT;
    var blob = new Blob([JSON.stringify(track, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setStatus('Downloaded ' + name + '. Commit it to a track repo.', 'ok');
  }

  function deleteTrack(track) {
    SpeedTrackStore.deleteTrack(track.youtubeVideoId, track.id).then(function () {
      setStatus('Deleted "' + track.title + '".', 'ok');
      return renderTracks();
    });
  }

  // Clone a read-only repo track into an editable local copy. No page round-trip
  // is needed — the repo track already carries its cues, so we just prime the save
  // dialog (prefilled, title suffixed " (clone)") and let the normal save path mint
  // a fresh local track.
  function cloneTrack(track) {
    pendingCues = SpeedTrack.trackToCues(track);
    if (!pendingCues.length) { setStatus('Track has no usable cues to clone.', 'error'); return; }
    editingId = null;
    titleInput.value = (track.title || 'Untitled') + ' (clone)';
    descInput.value = track.description || '';
    show(saveForm, true);
    refreshSaveButton();
    titleInput.focus();
    titleInput.select();
    setStatus('Cloning "' + track.title + '" to a local copy. Adjust, then Save.', 'ok');
  }

  // Reopen a saved track as a recording, seeded with its cues. Ending the session
  // brings back the save dialog prefilled with the original title/description:
  // keep the title to overwrite, change it to save as a separate track. Editing
  // only the title/description (without touching cues) is a valid use.
  function editTrack(track) {
    var cues = SpeedTrack.trackToCues(track);
    activeTab().then(function (tab) {
      if (!tab) { setStatus('No active tab.', 'error'); return; }
      return browserApi.tabs.sendMessage(tab.id, {
        type: 'editTrack', cues: cues, id: track.id, title: track.title, description: track.description
      }).then(function (resp) {
        if (resp && resp.ok) {
          setRecording(true);
          show(saveForm, false);
          setStatus('Editing "' + track.title + '". Adjust cues, then End recording.', 'ok');
        }
      });
    }).catch(function (err) {
      setStatus("Couldn't reach the page. Is this a YouTube tab?\n" + err.message, 'error');
    });
  }

  // ---- Recording / saving ---------------------------------------------------

  recordBtn.addEventListener('click', function () {
    activeTab().then(function (tab) {
      if (!tab) { setStatus('No active tab.', 'error'); return; }
      if (!recording) {
        return browserApi.tabs.sendMessage(tab.id, { type: 'startRecording' }).then(function () {
          editingId = null;
          setRecording(true);
          show(saveForm, false);
          setStatus('Recording. Press 1-4 to set the speed at any point.', 'ok');
        });
      }
      return browserApi.tabs.sendMessage(tab.id, { type: 'stopRecording' }).then(function (resp) {
        setRecording(false);
        if (resp && resp.videoId) videoId = resp.videoId;
        offerSave(resp && resp.cues, resp && resp.edit);
      });
    }).catch(function (err) {
      setStatus("Couldn't reach the page. Is this a YouTube tab?\n" + err.message, 'error');
    });
  });

  // Show the title/description form for recorded cues. When editing, meta carries
  // the original title/description to prefill (keep title = overwrite).
  function offerSave(cues, meta) {
    pendingCues = (cues && cues.length) ? cues : null;
    editingId = (meta && meta.id) || null;
    if (!pendingCues) {
      show(saveForm, false);
      setStatus('Recording ended (nothing recorded).', 'ok');
      return;
    }
    titleInput.value = (meta && meta.title) || '';
    descInput.value = (meta && meta.description) || '';
    show(saveForm, true);
    refreshSaveButton();
    titleInput.focus();
    setStatus(editingId
      ? 'Editing "' + meta.title + '". Save to update it. Rename if you like; it stays the same track.'
      : 'Recording ended. Name it and Save.', 'ok');
  }

  saveBtn.addEventListener('click', function () {
    var title = titleInput.value.trim();
    if (!title) { setStatus('Give the track a title.', 'error'); titleInput.focus(); return; }
    if (!videoId) { setStatus('No video on this page. Open a video first.', 'error'); return; }
    if (!pendingCues || !pendingCues.length) { setStatus('Nothing recorded to save.', 'error'); return; }

    var match = findTrackEntry(title, editingId);
    if (match && !match.writable) {
      setStatus('"' + title + '" is read-only. Change the title to save a local copy.', 'error');
      titleInput.focus();
      return;
    }
    if (match && editingId) {
      setStatus('Another track already uses "' + title + '". Pick a different title.', 'error');
      titleInput.focus();
      return;
    }

    var track = SpeedTrack.cuesToTrack(pendingCues, {
      videoId: videoId, title: title, description: descInput.value.trim()
    });
    if (editingId) track.id = editingId;
    SpeedTrackStore.saveTrack(track).then(function () {
      pendingCues = null;
      editingId = null;
      show(saveForm, false);
      setStatus('Saved "' + title + '". Apply it, or Download to commit to a repo.', 'ok');
      // Forget the take on the page so reopening the popup won't re-offer to save.
      activeTab().then(function (tab) {
        if (tab) browserApi.tabs.sendMessage(tab.id, { type: 'clearRecording' }).catch(function () {});
      });
      return renderTracks();
    }).catch(function (err) {
      setStatus("Couldn't save: " + err.message, 'error');
    });
  });

  titleInput.addEventListener('input', refreshSaveButton);

  // ---- Repositories ---------------------------------------------------------

  optionsBtn.addEventListener('click', function () {
    if (browserApi.runtime.openOptionsPage) browserApi.runtime.openOptionsPage();
  });

  // Auto-apply preference. The background owns applying it on future video opens;
  // here we just persist it, and when it's switched on we apply this video's top
  // track right away so the popup reflects it without waiting for a reload.
  autoApplyToggle.addEventListener('change', function () {
    var on = autoApplyToggle.checked;
    SpeedTrackStore.setAutoApply(on).then(function () {
      if (on && !appliedId && currentTracks.length) {
        applyTrack(currentTracks[0].track);
      } else {
        setStatus(on ? 'Auto-applying the top track when a video opens.' : 'Auto-apply off.', 'ok');
      }
    });
  });

  refreshBtn.addEventListener('click', function () {
    setStatus('Refreshing repositories…');
    SpeedTrackSources.refreshAll().then(function (results) {
      // refreshAll rebuilds the path index and clears the content cache, so the
      // current video's tracks need re-fetching before they'll render — otherwise
      // they only reappear next time the popup opens (init fetches them).
      var fetched = videoId ? SpeedTrackSources.ensureTracksForVideo(videoId).catch(function () {})
                            : Promise.resolve();
      return fetched.then(renderTracks).then(function () {
        var errs = (results || []).filter(function (r) { return r.error; });
        if (errs.length) {
          setStatus('Refreshed with ' + errs.length + ' problem(s): ' +
            errs.map(function (e) { return e.error.message; }).join(' '), 'error');
        } else {
          setStatus('Repositories refreshed.', 'ok');
        }
      });
    }).catch(function (err) {
      setStatus('Refresh failed: ' + err.message, 'error');
    });
  });

  // Only offer Refresh once at least one GitHub repository is configured.
  SpeedTrackStore.getSources().then(function (sources) {
    show(refreshBtn, sources.some(function (s) { return s.type === 'github'; }));
  });

  // ---- Init -----------------------------------------------------------------

  var versionEl = document.getElementById('version');
  if (versionEl && browserApi.runtime.getManifest) {
    versionEl.textContent = 'v' + browserApi.runtime.getManifest().version;
  }

  SpeedTrackStore.ensureSeeded();
  // If the speeds land after the first render (they load in parallel with the tab
  // round-trips), re-render so the savings figures appear. Usually they're ready
  // first and this is a no-op.
  SpeedTrackStore.getSpeedLevels().then(function (m) {
    speedLevels = m;
    if (currentTracks.length) renderTracks();
  });
  SpeedTrackStore.getAutoApply().then(function (on) { autoApplyToggle.checked = on; });

  activeTab().then(function (tab) {
    if (!tab) return renderTracks();
    // Reflect whether a track is currently driving playback, so the active row
    // shows its Stop button. Resolve this before the first render so it shows.
    return browserApi.tabs.sendMessage(tab.id, { type: 'getPlaybackStatus' }).then(function (resp) {
      appliedId = (resp && resp.appliedId) || null;
      currentDuration = (resp && resp.duration) || null;
    }).catch(function () { appliedId = null; }).then(function () {
      return browserApi.tabs.sendMessage(tab.id, { type: 'getStatus' });
    }).then(function (resp) {
      setRecording(!!(resp && resp.recording));
      if (resp && resp.videoId) videoId = resp.videoId;
      // Render first so the save form's Overwrite/Save label knows the existing
      // tracks; a session ended via the keyboard leaves cues waiting to save.
      return renderTracks().then(function () {
        if (resp && !resp.recording && resp.cues && resp.cues.length) offerSave(resp.cues, resp.edit);
        // The background fetches repo tracks on video open, but if it hasn't yet
        // (or this video pre-dates that), fetch now and re-render when any land.
        if (videoId) {
          SpeedTrackSources.ensureTracksForVideo(videoId).then(function (n) {
            if (n) renderTracks();
          }).catch(function () {});
        }
      });
    });
  }).catch(function () {
    // Not a YouTube tab (or content script not present): no video, just render empty.
    renderTracks();
  });
})();
