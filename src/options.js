// options.js — the Settings page: playback preferences plus track repositories
// (add / refresh / delete).
//
// Repos are immutable once added: to change a URL or depth, delete and re-add.
// Adding requests GitHub host access on the click (a user gesture), then syncs.

(function () {
  'use strict';

  var browserApi = (typeof browser !== 'undefined') ? browser : chrome;
  var GH_ORIGINS = ['https://api.github.com/*', 'https://raw.githubusercontent.com/*'];

  var speed1 = document.getElementById('speed-1');
  var speed2 = document.getElementById('speed-2');
  var speed3 = document.getElementById('speed-3');
  var showSegments = document.getElementById('show-segments');
  var cacheExpiry = document.getElementById('cache-expiry');
  var refreshAllBtn = document.getElementById('refresh-all');
  var clearCacheBtn = document.getElementById('clear-cache');
  var repoStats = document.getElementById('repo-stats');
  var listEl = document.getElementById('source-list');
  var labelInput = document.getElementById('add-label');
  var urlInput = document.getElementById('add-url');
  var deepToggle = document.getElementById('add-deep');
  var depthWarning = document.getElementById('depth-warning');
  var addBtn = document.getElementById('add-btn');
  var statusEl = document.getElementById('status');

  // The loaded speed map, kept so saving can preserve modes we don't edit (Skip).
  var speedLevels = null;

  // Whether the This device track list is expanded — remembered across re-renders.
  var localExpanded = false;

  // Shallow (default) scans only the chosen folder (maxDepth 0); deep scans
  // every subfolder (maxDepth -1). Warn only for the deep case.
  function syncDepthWarning() {
    depthWarning.classList.toggle('hidden', !deepToggle.checked);
  }
  deepToggle.addEventListener('change', syncDepthWarning);

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function depthLabel(d) {
    if (d == null || d < 0) return 'all subfolders';
    if (d === 0) return 'this folder only';
    return d + ' level(s) deep';
  }

  function noticeText(r) {
    return (r && r.notices && r.notices.length) ? ' ' + r.notices.join(' ') : '';
  }

  function button(label, fn) {
    var b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  // Sum the lengths of the arrays in a { key: [] } map.
  function sumLists(map) {
    var n = 0;
    Object.keys(map || {}).forEach(function (k) { n += map[k].length; });
    return n;
  }

  // Available tracks for a source: the index size (every track file listed),
  // falling back to the cache for legacy entries synced before the index existed.
  function countOf(entry) {
    if (!entry) return 0;
    return sumLists(entry.index || entry.byVideo);
  }

  // Approximate bytes a stored value occupies, measured from its JSON form. (We
  // don't use storage.getBytesInUse — it isn't supported across our targets.)
  function byteLength(value) {
    var str = JSON.stringify(value) || '';
    return (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(str).length : str.length;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function renderSources() {
    return Promise.all([
      SpeedTrackStore.getSources(),
      SpeedTrackStore.getAllRepoTracks(),
      SpeedTrackStore.getAllTracks()
    ]).then(function (arr) {
      var sources = arr[0], repoAll = arr[1], localAll = arr[2];

      listEl.textContent = '';
      sources.forEach(function (s) {
        listEl.appendChild(renderSourceItem(s, repoAll[s.id], localAll));
      });

      // Roll up repo storage: tracks listed (available), tracks actually fetched
      // (cached), and the space the whole repo-tracks store occupies.
      var available = 0, cached = 0;
      Object.keys(repoAll).forEach(function (sid) {
        available += countOf(repoAll[sid]);
        cached += sumLists(repoAll[sid] && repoAll[sid].byVideo);
      });
      repoStats.textContent = sources.some(function (s) { return s.type === 'github'; })
        ? (available + ' available · ' + cached + ' cached · ' + formatBytes(byteLength(repoAll)) + ' in storage')
        : '';
    });
  }

  function renderSourceItem(s, repoEntry, localAll) {
    var li = document.createElement('li');
    li.className = 'track';

    var title = document.createElement('div');
    title.className = 'track-title';
    title.textContent = s.label || (s.type === 'local' ? 'This device' : (s.owner + '/' + s.repo));
    li.appendChild(title);

    if (s.type === 'local') {
      var localMap = localAll || {};
      // Delete all sits in the header, outside the collapse, so it's reachable
      // without expanding the list (it clears every local track regardless).
      var localTotal = sumLists(localMap);
      if (localTotal) {
        title.classList.add('local-head');
        var delAll = button('Delete all', function () { onDeleteAllLocal(localTotal); });
        delAll.className = 'danger';
        title.appendChild(delAll);
      }
      li.appendChild(renderLocalBody(localMap));
      return li;
    }

    var meta = document.createElement('div');
    meta.className = 'source-meta';
    if (s.url) {
      // Clickable, opening the repo folder in a new tab.
      var link = document.createElement('a');
      link.href = s.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = s.url;
      meta.appendChild(link);
    } else {
      meta.textContent = s.owner + '/' + s.repo + ' @ ' + s.branch + (s.path ? '/' + s.path : '');
    }
    li.appendChild(meta);

    var count = countOf(repoEntry);
    var when = (repoEntry && repoEntry.syncedAt) ? new Date(repoEntry.syncedAt).toLocaleString() : 'never';
    var meta2 = document.createElement('div');
    meta2.className = 'source-meta';
    meta2.textContent = count + ' track(s) · ' + depthLabel(s.maxDepth) + ' · synced ' + when;
    li.appendChild(meta2);

    var actions = document.createElement('div');
    actions.className = 'track-actions';
    actions.appendChild(button('Refresh', function () { onRefresh(s); }));
    var del = button('Delete', function () { onDelete(s, count); });
    del.className = 'danger';
    actions.appendChild(del);
    li.appendChild(actions);

    return li;
  }

  function onRefresh(s) {
    var name = s.label || s.repo;
    setStatus('Syncing "' + name + '"…');
    SpeedTrackSources.refreshSource(s.id).then(function (r) {
      if (r && r.unchanged) setStatus('"' + name + '" is already up to date.', 'ok');
      else setStatus('Synced "' + name + '", ' + (r ? r.count : 0) + ' track(s).' + noticeText(r), 'ok');
      return renderSources();
    }).catch(function (err) {
      setStatus('Couldn\'t sync "' + name + '": ' + err.message, 'error');
    });
  }

  function onDelete(s, count) {
    var name = s.label || s.repo;
    if (!window.confirm('Remove "' + name + '" and its ' + count + ' synced track(s)?')) return;
    SpeedTrackStore.deleteSource(s.id).then(function () {
      setStatus('Removed "' + name + '".', 'ok');
      return renderSources();
    }).catch(function (err) {
      setStatus('Couldn\'t remove "' + name + '": ' + err.message, 'error');
    });
  }

  // The This device source body: an expandable list of every saved track grouped
  // by video id, with per-track and delete-all controls. Expansion is remembered
  // (localExpanded) so deleting a track doesn't collapse the list on re-render.
  function renderLocalBody(localAll) {
    var vids = Object.keys(localAll).sort();
    var total = sumLists(localAll);

    if (!total) {
      var empty = document.createElement('div');
      empty.className = 'source-meta';
      empty.textContent = 'No tracks saved on this device.';
      return empty;
    }

    var details = document.createElement('details');
    details.open = localExpanded;
    details.addEventListener('toggle', function () { localExpanded = details.open; });

    var summary = document.createElement('summary');
    summary.textContent = total + ' track(s) saved on this device.';
    details.appendChild(summary);

    var groups = document.createElement('ul');
    groups.className = 'subtrack-list';
    vids.forEach(function (vid) {
      var group = document.createElement('li');

      // The video id links to its YouTube watch page, opened in a new tab.
      var head = document.createElement('a');
      head.className = 'subtrack-vid';
      head.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(vid);
      head.target = '_blank';
      head.rel = 'noopener noreferrer';
      head.textContent = vid;
      group.appendChild(head);

      localAll[vid].forEach(function (t) {
        var row = document.createElement('div');
        row.className = 'subtrack';
        var name = document.createElement('span');
        name.className = 'subtrack-title';
        name.textContent = t.title || '(untitled)';
        row.appendChild(name);
        var del = button('Delete', function () { onDeleteLocalTrack(vid, t); });
        del.className = 'danger';
        row.appendChild(del);
        group.appendChild(row);
      });
      groups.appendChild(group);
    });
    details.appendChild(groups);

    return details;
  }

  function onDeleteLocalTrack(videoId, t) {
    var name = t.title || 'untitled';
    if (!window.confirm('Delete "' + name + '"?')) return;
    SpeedTrackStore.deleteTrack(videoId, t.id).then(function () {
      setStatus('Deleted "' + name + '".', 'ok');
      return renderSources();
    }).catch(function (err) {
      setStatus('Couldn\'t delete "' + name + '": ' + err.message, 'error');
    });
  }

  function onDeleteAllLocal(total) {
    if (!window.confirm('Delete all ' + total + ' track(s) on this device? This can\'t be undone.')) return;
    SpeedTrackStore.clearLocalTracks().then(function () {
      setStatus('Deleted all ' + total + ' local track(s).', 'ok');
      return renderSources();
    }).catch(function (err) {
      setStatus("Couldn't delete tracks: " + err.message, 'error');
    });
  }

  // ---- Playback preferences -------------------------------------------------

  function loadPlaybackPrefs() {
    SpeedTrackStore.getSpeedLevels().then(function (m) {
      speedLevels = m;
      speed1.value = m['1'];
      speed2.value = m['2'];
      speed3.value = m['3'];
    });
    SpeedTrackStore.getShowSegments().then(function (on) { showSegments.checked = on; });
    SpeedTrackStore.getCacheExpiryDays().then(function (d) { cacheExpiry.value = d; });
  }

  function saveSpeeds() {
    var vals = [speed1.value, speed2.value, speed3.value].map(parseFloat);
    if (!vals.every(function (v) { return v > 0; })) {
      setStatus('Speeds must be positive numbers.', 'error');
      return;
    }
    // Skip (code 4) has no speed input — it seeks past the section. Carry its
    // stored value through unchanged so the segment still resolves to a rate.
    var skip = (speedLevels && speedLevels['4'] != null) ? speedLevels['4'] : 10;
    var map = { '1': vals[0], '2': vals[1], '3': vals[2], '4': skip };
    SpeedTrackStore.setSpeedLevels(map).then(function () {
      speedLevels = map;
      setStatus('Saved playback speeds.', 'ok');
    }).catch(function (err) {
      setStatus("Couldn't save speeds: " + err.message, 'error');
    });
  }
  // No Save button — each mode persists as soon as you change it (storage.local is
  // cheap). 'change' (not 'input') fires on blur/enter/step, so we don't write on
  // every keystroke mid-edit.
  [speed1, speed2, speed3].forEach(function (el) {
    el.addEventListener('change', saveSpeeds);
  });

  // The content script picks this up live via storage.onChanged.
  showSegments.addEventListener('change', function () {
    SpeedTrackStore.setShowSegments(showSegments.checked).then(function () {
      setStatus(showSegments.checked
        ? 'Showing speed segments.'
        : 'Hiding speed segments.', 'ok');
    });
  });

  cacheExpiry.addEventListener('change', function () {
    var d = parseInt(cacheExpiry.value, 10);
    if (!(d >= 1)) { setStatus('Expiry must be at least 1 day.', 'error'); return; }
    SpeedTrackStore.setCacheExpiryDays(d).then(function () {
      setStatus('Cached repo tracks now expire after ' + d + ' day(s).', 'ok');
    });
  });

  // ---- Refresh all repositories ---------------------------------------------
  //
  // Delegates to SpeedTrackSources.refreshAll, which syncs sequentially (gentle on
  // the rate limit) and oldest-synced first.
  function refreshAll() {
    var noun = function (n) { return n + (n === 1 ? ' repository' : ' repositories'); };
    SpeedTrackStore.getSources().then(function (sources) {
      var repos = sources.filter(function (s) { return s.type === 'github'; });
      if (!repos.length) { setStatus('No repositories to refresh.', 'ok'); return; }
      setStatus('Refreshing ' + noun(repos.length) + '…');
      return SpeedTrackSources.refreshAll().then(function (results) {
        var updated = 0, failed = 0;
        results.forEach(function (r) {
          if (r.error) failed++;
          else if (r.result && !r.result.unchanged) updated++;
        });
        var msg = 'Refreshed ' + noun(results.length) + '.';
        if (updated) msg += ' ' + updated + ' updated.';
        if (failed) msg += ' ' + failed + ' failed.';
        setStatus(msg, failed ? 'error' : 'ok');
        return renderSources();
      });
    });
  }
  refreshAllBtn.addEventListener('click', refreshAll);

  // Drop the fetched-track cache (indexes stay). Tracks re-fetch on demand the next
  // time you open their video — handy for reclaiming space or watching lazy loading.
  clearCacheBtn.addEventListener('click', function () {
    SpeedTrackStore.clearRepoCache().then(function (removed) {
      setStatus(removed
        ? 'Cleared ' + removed + ' cached repo track(s). They re-download next time you open them.'
        : 'No cached repo tracks to clear.', 'ok');
      return renderSources();
    }).catch(function (err) {
      setStatus("Couldn't clear cache: " + err.message, 'error');
    });
  });

  // ---- Add a repository -----------------------------------------------------

  addBtn.addEventListener('click', function () {
    var url = urlInput.value.trim();
    var label = labelInput.value.trim();
    var depth = deepToggle.checked ? -1 : 0;

    // Parse synchronously so the permission request stays in the user gesture.
    var parsed = SpeedTrackSources.parseRepoUrl(url);
    if (!parsed) {
      setStatus("That doesn't look like a GitHub folder URL.", 'error');
      urlInput.focus();
      return;
    }

    setStatus('Requesting access to GitHub…');
    browserApi.permissions.request({ origins: GH_ORIGINS }).then(function (granted) {
      if (!granted) {
        setStatus("GitHub access denied, so the repository can't sync.", 'error');
        return;
      }
      setStatus('Adding and syncing…');
      return SpeedTrackSources.addAndSync({ parsed: parsed, label: label, maxDepth: depth, url: url })
        .then(function (res) {
          labelInput.value = '';
          urlInput.value = '';
          setStatus('Added "' + res.source.label + '", synced ' + res.count + ' track(s).' + noticeText(res), 'ok');
          return renderSources();
        });
    }).catch(function (err) {
      setStatus("Couldn't add repository: " + err.message, 'error');
    });
  });

  var versionEl = document.getElementById('version');
  if (versionEl && browserApi.runtime.getManifest) {
    versionEl.textContent = 'v' + browserApi.runtime.getManifest().version;
  }

  SpeedTrackStore.ensureSeeded();
  syncDepthWarning();
  loadPlaybackPrefs();
  renderSources();
})();
