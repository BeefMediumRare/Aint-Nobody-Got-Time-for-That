// tracks.js — track sources: the local device plus read-only GitHub repos.
//
// A "source" is either the implicit local device or a public GitHub repository
// folder. Adding or refreshing a repo lists its tree and stores a lightweight
// *index* of track-file paths (the video id is in each filename), tagged with the
// repo's source id. Content is fetched lazily — ensureTracksForVideo pulls the
// files for a video the first time it's opened and caches them in storage.local,
// where they're read back like local tracks. GitHub is contacted only here.
//
// Listing strategy (one rate-limited request per repo, regardless of depth):
//   GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1   -> the whole tree
//   raw.githubusercontent.com/...                              -> file content (CDN, free)
// Conditional refresh stores the tree's ETag and sends If-None-Match; a 304 is
// free and means "no new tracks".
//
// The pure helpers (parseRepoUrl, isTrackFile, ...) are unit-tested; the network
// methods are exercised manually. Exposed as the global SpeedTrackSources.

(function (root) {
  'use strict';

  var browserApi = (typeof browser !== 'undefined') ? browser :
                   (typeof chrome !== 'undefined' ? chrome : null);

  // Resolved from SpeedTrack when present (browser), else the same literal.
  var TRACK_EXT = (typeof SpeedTrack !== 'undefined' && SpeedTrack.TRACK_EXT) || '.json';

  var API_BASE = 'https://api.github.com';
  var RAW_BASE = 'https://raw.githubusercontent.com';

  var MAX_FILES = 500;            // per repo, per sync — guard against abuse
  var MAX_FILE_BYTES = 256 * 1024;
  var FETCH_CONCURRENCY = 4;

  // ---- Pure helpers (tested) ------------------------------------------------

  // Parse a GitHub repo-folder URL into { owner, repo, branch, path }. branch and
  // path are null when the URL doesn't carry them (a bare repo URL). Returns null
  // for anything that isn't a github.com repo URL. A missing scheme is tolerated.
  function parseRepoUrl(url) {
    if (url == null) return null;
    var str = String(url).trim();
    if (!str) return null;

    var u = null;
    try { u = new URL(str); }
    catch (e) {
      try { u = new URL('https://' + str); }
      catch (e2) { return null; }
    }

    var host = u.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return null;

    var segs = u.pathname.split('/').filter(function (s) { return s.length > 0; });
    if (segs.length < 2) return null;

    var owner = decodeURIComponent(segs[0]);
    var repo = decodeURIComponent(segs[1]).replace(/\.git$/, '');
    if (!owner || !repo) return null;

    if (segs.length === 2) return { owner: owner, repo: repo, branch: null, path: null };

    // Only the /tree/<branch>/<path...> form carries a folder. (Slashed branch
    // names are ambiguous in this form and treated as branch = segs[3].)
    if (segs[2] !== 'tree') return null;
    var branch = segs[3] ? decodeURIComponent(segs[3]) : null;
    if (!branch) return null;

    var pathSegs = segs.slice(4).map(function (s) { return decodeURIComponent(s); });
    return { owner: owner, repo: repo, branch: branch, path: pathSegs.length ? pathSegs.join('/') : null };
  }

  function treeApiUrl(parsed) {
    return API_BASE + '/repos/' + parsed.owner + '/' + parsed.repo +
      '/git/trees/' + encodeURIComponent(parsed.branch) + '?recursive=1';
  }

  function rawUrl(parsed, filePath) {
    var encoded = String(filePath).split('/').map(encodeURIComponent).join('/');
    return RAW_BASE + '/' + parsed.owner + '/' + parsed.repo + '/' +
      encodeURIComponent(parsed.branch) + '/' + encoded;
  }

  // Does this tree path look like a track file within the configured folder?
  //   - under basePath (prefix match on a folder boundary, so 'tracks' != 'tracksX')
  //   - within maxDepth folders below basePath (0 = directly in it; <0/null = any)
  //   - basename is "<id>_<...><ext>", id being 8+ id-chars (matches video-id.js)
  // Content is still validated separately; this is just a cheap pre-filter.
  function isTrackFile(path, basePath, maxDepth) {
    if (!path) return false;
    var base = basePath ? String(basePath).replace(/^\/+|\/+$/g, '') : '';
    var prefix = base ? base + '/' : '';
    if (prefix && path.indexOf(prefix) !== 0) return false;

    var rel = path.slice(prefix.length);
    if (!rel) return false;

    if (maxDepth != null && maxDepth >= 0) {
      var depth = rel.split('/').length - 1;
      if (depth > maxDepth) return false;
    }

    var name = rel.split('/').pop();
    return /^[A-Za-z0-9_-]{8,}_.+/.test(name) &&
      name.slice(-TRACK_EXT.length).toLowerCase() === TRACK_EXT;
  }

  // From a git-tree listing, the blob paths that look like track files.
  function filterTreeForTracks(treeEntries, basePath, maxDepth) {
    var out = [];
    var entries = treeEntries || [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || e.type !== 'blob' || !e.path) continue;
      if (isTrackFile(e.path, basePath, maxDepth)) out.push(e.path);
    }
    return out;
  }

  // Group validated tracks into { [videoId]: Track[] }.
  function groupByVideo(tracks) {
    var out = {};
    var list = tracks || [];
    for (var i = 0; i < list.length; i++) {
      var vid = list[i] && list[i].youtubeVideoId;
      if (!vid) continue;
      (out[vid] = out[vid] || []).push(list[i]);
    }
    return out;
  }

  // The video id a track file belongs to, read from its filename "<videoId>_<...>".
  // isTrackFile already guarantees the basename starts with 8+ id chars then "_".
  function videoIdFromPath(path) {
    if (!path) return null;
    var name = String(path).split('/').pop();
    var us = name.indexOf('_');
    return us > 0 ? name.slice(0, us) : null;
  }

  // The sync output: track-file paths grouped by their filename video id. This is
  // all a sync stores — content is fetched lazily when a matching video is opened.
  function buildIndex(paths) {
    var out = {};
    (paths || []).forEach(function (p) {
      var vid = videoIdFromPath(p);
      if (!vid) return;
      (out[vid] = out[vid] || []).push(p);
    });
    return out;
  }

  function countIndex(index) {
    var n = 0;
    Object.keys(index || {}).forEach(function (vid) { n += index[vid].length; });
    return n;
  }

  // ---- Internal (browser) helpers -------------------------------------------

  function genId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
      : ('rt-' + Date.now() + '-' + Math.round(Math.random() * 1e9));
  }

  function formatReset(resetSeconds) {
    try { return new Date(Number(resetSeconds) * 1000).toLocaleTimeString(); }
    catch (e) { return ''; }
  }

  // Fetch the recursive git tree, using the stored ETag for a free 304 when
  // nothing changed. Resolves { unchanged } or { tree, truncated, etag }.
  function getTree(source) {
    var parsed = { owner: source.owner, repo: source.repo, branch: source.branch };
    return SpeedTrackStore.getRepoTracksMeta(source.id).then(function (meta) {
      var headers = { 'Accept': 'application/vnd.github+json' };
      if (meta && meta.etag) headers['If-None-Match'] = meta.etag;
      return fetch(treeApiUrl(parsed), { cache: 'no-cache', headers: headers });
    }).then(function (res) {
      if (res.status === 304) return { unchanged: true };
      if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
        var reset = formatReset(res.headers.get('x-ratelimit-reset'));
        var err = new Error('GitHub rate limit reached' + (reset ? ' (resets ' + reset + ')' : '') + '.');
        err.code = 'RATE_LIMITED';
        throw err;
      }
      if (res.status === 404) {
        throw new Error('Repository or branch not found. Only public repos are supported — ' +
          'check the URL and make sure the repository isn’t private.');
      }
      if (!res.ok) throw new Error('GitHub listing failed (' + res.status + ').');
      var etag = res.headers.get('etag');
      return res.json().then(function (json) {
        return { unchanged: false, tree: json.tree || [], truncated: !!json.truncated, etag: etag };
      });
    });
  }

  function fetchText(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('fetch failed (' + res.status + ')');
      var len = res.headers.get('content-length');
      if (len && Number(len) > MAX_FILE_BYTES) throw new Error('file too large');
      return res.text();
    }).then(function (text) {
      if (text.length > MAX_FILE_BYTES) throw new Error('file too large');
      return text;
    });
  }

  // Fetch many files with a bounded pool. A failed file resolves to text:null.
  function fetchAll(items) {
    var results = new Array(items.length);
    var next = 0;
    function worker() {
      if (next >= items.length) return Promise.resolve();
      var i = next++;
      return fetchText(items[i].url).then(function (text) {
        results[i] = { path: items[i].path, text: text };
      }, function () {
        results[i] = { path: items[i].path, text: null };
      }).then(worker);
    }
    var workers = [];
    var n = Math.min(FETCH_CONCURRENCY, items.length);
    for (var w = 0; w < n; w++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }


  // Sync one GitHub source: list the tree and store an index of track-file paths
  // (one rate-limited request, no content downloads — files are fetched on demand
  // when a matching video is opened). A 304 leaves the index untouched. Resolves
  // { unchanged, count, notices }, count being the number of indexed (available)
  // tracks.
  function syncSource(source) {
    var notices = [];
    return Promise.all([getTree(source), SpeedTrackStore.getAllRepoTracks()]).then(function (arr) {
      var tree = arr[0];
      var priorEntry = arr[1][source.id];

      if (tree.unchanged) {
        return SpeedTrackStore.touchRepoTracks(source.id, { syncedAt: Date.now() }).then(function () {
          return { unchanged: true, count: priorEntry ? countIndex(priorEntry.index) : 0, notices: notices };
        });
      }

      if (tree.truncated) {
        notices.push('Repository tree was too large to list fully; some tracks may be missing.');
      }

      var paths = filterTreeForTracks(tree.tree, source.path, source.maxDepth);
      if (paths.length > MAX_FILES) {
        notices.push('Found ' + paths.length + ' track files; indexed only the first ' + MAX_FILES + '.');
        paths = paths.slice(0, MAX_FILES);
      }

      var index = buildIndex(paths);
      return SpeedTrackStore.setRepoIndex(source.id, index, { syncedAt: Date.now(), etag: tree.etag })
        .then(function () { return { unchanged: false, count: paths.length, notices: notices }; });
    });
  }

  // Lazily fetch and cache the tracks for one video, across every repo source.
  // Only files in the index that aren't already cached are fetched (the cache is
  // keyed by the file's own video id, so a re-fetch is skipped even if a file's
  // filename id and content id disagree). Network only — safe to call repeatedly.
  // Resolves the number of newly cached tracks.
  function ensureTracksForVideo(videoId) {
    if (!videoId) return Promise.resolve(0);
    return Promise.all([SpeedTrackStore.getSources(), SpeedTrackStore.getAllRepoTracks()]).then(function (arr) {
      var bySource = {};
      arr[0].forEach(function (s) { bySource[s.id] = s; });
      var repoAll = arr[1];

      var items = [];          // { source, path, url }
      var priorIdByKey = {};   // sourceId\npath -> stable track id
      Object.keys(repoAll).forEach(function (sid) {
        var entry = repoAll[sid];
        var cached = {};
        Object.keys(entry.byVideo || {}).forEach(function (vid) {
          entry.byVideo[vid].forEach(function (t) {
            if (t.sourcePath) { cached[t.sourcePath] = true; priorIdByKey[sid + '\n' + t.sourcePath] = t.id; }
          });
        });
        var src = bySource[sid];
        if (!src || src.type !== 'github') return;
        var paths = entry.index && entry.index[videoId];
        if (!paths) return;
        paths.forEach(function (p) {
          if (cached[p]) return;
          items.push({ source: src, path: p, url: rawUrl({ owner: src.owner, repo: src.repo, branch: src.branch }, p) });
        });
      });

      if (!items.length) return 0;

      return fetchAll(items).then(function (results) {
        var bySrc = {};
        results.forEach(function (r, i) {
          if (!r || r.text == null) return;
          var item = items[i];
          var v = SpeedTrack.validateTrack(r.text);
          if (v.errors.length || !v.track) return;
          var t = v.track;
          t.id = priorIdByKey[item.source.id + '\n' + item.path] || genId();
          t.sourceId = item.source.id;
          t.sourcePath = item.path;
          (bySrc[item.source.id] = bySrc[item.source.id] || []).push(t);
        });

        var now = Date.now();
        return Object.keys(bySrc).reduce(function (p, sid) {
          return p.then(function (acc) {
            return SpeedTrackStore.addRepoCacheTracks(sid, bySrc[sid], now).then(function (n) { return acc + (n || 0); });
          });
        }, Promise.resolve(0));
      });
    });
  }

  // Resolve a repo's default branch when the URL didn't pin one.
  function resolveBranch(parsed) {
    if (parsed.branch) return Promise.resolve(parsed.branch);
    return fetch(API_BASE + '/repos/' + parsed.owner + '/' + parsed.repo, {
      cache: 'no-cache', headers: { 'Accept': 'application/vnd.github+json' }
    }).then(function (res) {
      if (res.status === 404) {
        throw new Error('Repository not found. Only public repos are supported — ' +
          'check the URL and make sure the repository isn’t private.');
      }
      if (!res.ok) throw new Error('Could not read the repository (' + res.status + ').');
      return res.json();
    }).then(function (j) {
      if (!j.default_branch) throw new Error('Repository has no default branch.');
      return j.default_branch;
    });
  }

  // Add a GitHub source and sync it once. Rolls the source back if the first
  // sync fails, so a broken repo isn't left half-configured.
  function addAndSync(opts) {
    var parsed = opts.parsed;
    return resolveBranch(parsed).then(function (branch) {
      var source = {
        type: 'github',
        label: opts.label || (parsed.owner + '/' + parsed.repo),
        url: opts.url || '',
        owner: parsed.owner,
        repo: parsed.repo,
        branch: branch,
        path: parsed.path || null,
        maxDepth: (opts.maxDepth == null ? 0 : opts.maxDepth)
      };
      return SpeedTrackStore.addSource(source).then(function (stored) {
        return syncSource(stored).then(function (result) {
          return { source: stored, count: result.count, notices: result.notices };
        }, function (err) {
          return SpeedTrackStore.deleteSource(stored.id).then(function () { throw err; }, function () { throw err; });
        });
      });
    });
  }

  function findSource(id) {
    return SpeedTrackStore.getSources().then(function (sources) {
      for (var i = 0; i < sources.length; i++) if (sources[i].id === id) return sources[i];
      return null;
    });
  }

  function refreshSource(id) {
    return findSource(id).then(function (s) {
      if (!s || s.type !== 'github') return null;
      return syncSource(s);
    });
  }

  // Refresh all GitHub sources sequentially (gentle on the rate limit). Oldest-
  // synced first, so if a later repo trips the rate limit the most overdue ones
  // have already refreshed (a never-synced source sorts oldest). Resolves an array
  // of { source, result } / { source, error } — never rejects per-source.
  function refreshAll() {
    return Promise.all([SpeedTrackStore.getSources(), SpeedTrackStore.getAllRepoTracks()]).then(function (arr) {
      var sources = arr[0], repoAll = arr[1];
      var gh = sources.filter(function (s) { return s.type === 'github'; });
      gh.sort(function (a, b) {
        var ta = (repoAll[a.id] && repoAll[a.id].syncedAt) || 0;
        var tb = (repoAll[b.id] && repoAll[b.id].syncedAt) || 0;
        return ta - tb;
      });
      return gh.reduce(function (p, s) {
        return p.then(function (acc) {
          return syncSource(s).then(
            function (r) { acc.push({ source: s, result: r }); return acc; },
            function (err) { acc.push({ source: s, error: err }); return acc; }
          );
        });
      }, Promise.resolve([]));
    });
  }

  // Tracks for a video across all sources (storage only, no network). Local
  // tracks are writable; repo tracks are read-only and carry their source label.
  // On a title clash for the same video, the local copy wins.
  function listTracksForVideo(videoId) {
    if (!videoId) return Promise.resolve({ entries: [], notices: [] });
    return Promise.all([
      SpeedTrackStore.getTracksForVideo(videoId),
      SpeedTrackStore.getRepoTracksForVideo(videoId),
      SpeedTrackStore.getSources()
    ]).then(function (arr) {
      var local = arr[0], repo = arr[1], sources = arr[2];
      var labelById = {};
      sources.forEach(function (s) { labelById[s.id] = s.label; });

      var entries = [];
      var localTitles = {};
      local.forEach(function (t) {
        localTitles[t.title] = true;
        entries.push({ track: t, writable: true, sourceId: 'local', sourceLabel: 'This device' });
      });
      repo.forEach(function (t) {
        if (localTitles[t.title]) return;
        entries.push({ track: t, writable: false, sourceId: t.sourceId, sourceLabel: labelById[t.sourceId] || 'Repository' });
      });
      return { entries: entries, notices: [] };
    });
  }

  var api = {
    parseRepoUrl: parseRepoUrl,
    treeApiUrl: treeApiUrl,
    rawUrl: rawUrl,
    isTrackFile: isTrackFile,
    filterTreeForTracks: filterTreeForTracks,
    groupByVideo: groupByVideo,
    videoIdFromPath: videoIdFromPath,
    buildIndex: buildIndex,
    syncSource: syncSource,
    ensureTracksForVideo: ensureTracksForVideo,
    resolveBranch: resolveBranch,
    addAndSync: addAndSync,
    refreshSource: refreshSource,
    refreshAll: refreshAll,
    listTracksForVideo: listTracksForVideo
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SpeedTrackSources = api;
  }
})(typeof self !== 'undefined' ? self : this);
