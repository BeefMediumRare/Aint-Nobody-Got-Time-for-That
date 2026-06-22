// parser.js — pure, no DOM. Parses a speed track into sorted segments.
//
// Track format:
//   # comments start with '#'
//   <timestamp> <code>     -> timeline entry, roughly  \d+:\d{2} [1-4]
//
// timestamp: h:mm:ss | mm:ss | raw seconds (float)
// code:      a speed level, looked up in SPEED_LEVELS
//            (1 = normal, 2 = fast, 3 = faster, 4 = skip)
//            Reserved for later: negative codes (-1..-4) for slower speeds.
//
// parseTrack(text) -> { segments: [{start, rate}], errors: [{line, message}] }
//   segments are sorted ascending by start.
// rateAt(segments, t) -> rate of the last segment with start <= t, else null.

(function (root) {
  'use strict';

  // Code -> playback rate. This is where per-user speed preferences will plug
  // in later (and where negative/slower codes would be added).
  var SPEED_LEVELS = { 1: 1, 2: 2, 3: 3, 4: 10 };

  // Parse a timestamp token into seconds. Returns null if invalid.
  function parseTimestamp(token) {
    if (/^\d*\.?\d+$/.test(token)) {
      // raw seconds
      return parseFloat(token);
    }
    var parts = token.split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    var seconds = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      // last part may be fractional; others must be plain integers
      var isLast = i === parts.length - 1;
      if (isLast ? !/^\d*\.?\d+$/.test(p) : !/^\d+$/.test(p)) return null;
      seconds = seconds * 60 + parseFloat(p);
    }
    return seconds;
  }

  function parseTrack(text) {
    var errors = [];
    var segments = [];

    var lines = String(text == null ? '' : text).split(/\r?\n/);

    for (var i = 0; i < lines.length; i++) {
      var lineNo = i + 1;
      var line = lines[i].replace(/#.*$/, '').trim();
      if (!line) continue;

      var parts = line.split(/\s+/);
      if (parts.length !== 2) {
        errors.push({ line: lineNo, message: 'Expected "<timestamp> <code>", got: "' + line + '"' });
        continue;
      }

      var start = parseTimestamp(parts[0]);
      if (start === null) {
        errors.push({ line: lineNo, message: 'Invalid timestamp: "' + parts[0] + '"' });
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(SPEED_LEVELS, parts[1])) {
        errors.push({ line: lineNo, message: 'Unknown speed code "' + parts[1] + '" (valid: ' + Object.keys(SPEED_LEVELS).join(', ') + ')' });
        continue;
      }

      segments.push({ start: start, rate: SPEED_LEVELS[parts[1]] });
    }

    segments.sort(function (a, b) { return a.start - b.start; });

    return { segments: segments, errors: errors };
  }

  // Format seconds as mm:ss (or h:mm:ss when >= 1h), whole seconds.
  function formatTimestamp(seconds) {
    var total = Math.max(0, Math.round(seconds));
    var s = total % 60;
    var m = Math.floor(total / 60) % 60;
    var h = Math.floor(total / 3600);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h > 0 ? h + ':' + pad(m) : m) + ':' + pad(s);
  }

  // Render recorded cues [{t, code}] as a track. Sorted ascending by t.
  function formatTrack(cues) {
    return cues
      .slice()
      .sort(function (a, b) { return a.t - b.t; })
      .map(function (cue) { return formatTimestamp(cue.t) + ' ' + cue.code; })
      .join('\n');
  }

  // Code of the cue in effect just before refT (the latest cue with t < refT),
  // ignoring the cue at excludeIdx. null if there's no earlier cue.
  function precedingCode(cues, refT, excludeIdx) {
    var bestT = -Infinity, code = null;
    for (var i = 0; i < cues.length; i++) {
      if (i === excludeIdx) continue;
      if (cues[i].t < refT && cues[i].t > bestT) { bestT = cues[i].t; code = cues[i].code; }
    }
    return code;
  }

  // Authoring insert. Snap to the NEAREST existing cue within windowSec and update
  // its code (keeping its timestamp); otherwise add a new cue at t.
  // A cue whose speed equals the cue immediately before it is a no-op, so it's
  // dropped (on edit) or not created (on add) — which doubles as a handy way to
  // delete a cue: just set it to the speed of the segment before it. Mutates and
  // returns cues.
  function mergeCue(cues, t, code, windowSec) {
    var nearestIdx = -1, bestDist = Infinity;
    for (var i = 0; i < cues.length; i++) {
      var d = Math.abs(cues[i].t - t);
      if (d <= windowSec && d < bestDist) { bestDist = d; nearestIdx = i; }
    }

    if (nearestIdx >= 0) {
      cues[nearestIdx].code = code;
      if (precedingCode(cues, cues[nearestIdx].t, nearestIdx) === code) cues.splice(nearestIdx, 1);
      return cues;
    }

    if (precedingCode(cues, t, -1) === code) return cues; // redundant: don't create
    cues.push({ t: t, code: code });
    return cues;
  }

  // ---- Track documents (JSON, persisted, linked to a video) -----------------
  //
  // A Track is { schemaVersion, youtubeVideoId, title, description, cues }, where
  // cues are { timestamp: "m:ss" string, speed: "1".."4" code string }. Speed is
  // stored as a code (intent), resolved to a rate through the user's speed levels
  // at playback time — so a shared track honors each viewer's configured speeds.

  var SCHEMA_VERSION = 1;

  // The on-disk track file extension. Centralized so the Download filename, the
  // repo-listing filter, and the filename convention all agree (switching to
  // e.g. '.track' is then a one-line change).
  var TRACK_EXT = '.json';

  // Turn a title into a filesystem-safe, prefix-scannable filename slug.
  function slugifyTitle(title) {
    return String(title == null ? '' : title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled';
  }

  // Build a Track document from recorder cues [{t, code}].
  function cuesToTrack(cues, meta) {
    meta = meta || {};
    var sorted = (cues || []).slice().sort(function (a, b) { return a.t - b.t; });
    return {
      schemaVersion: SCHEMA_VERSION,
      youtubeVideoId: meta.videoId || '',
      title: meta.title || '',
      description: meta.description || '',
      cues: sorted.map(function (cue) {
        return { timestamp: formatTimestamp(cue.t), speed: String(cue.code) };
      })
    };
  }

  // Resolve a Track's cues into playback segments [{start, rate, code}] using a
  // code->rate map (defaults to SPEED_LEVELS). Cues with an unknown code or
  // unparseable timestamp are skipped. Sorted ascending by start. The code rides
  // along so the timeline can color bands by intent (the rate may be customized).
  function trackToSegments(track, speedLevels) {
    var map = speedLevels || SPEED_LEVELS;
    var cues = (track && track.cues) || [];
    var segments = [];
    for (var i = 0; i < cues.length; i++) {
      var start = parseTimestamp(String(cues[i].timestamp));
      var rate = map[cues[i].speed];
      if (start === null || rate == null) continue;
      segments.push({ start: start, rate: rate, code: Number(cues[i].speed) });
    }
    segments.sort(function (a, b) { return a.start - b.start; });
    return segments;
  }

  // Estimate the watch time a track trims at the given speed levels, against a
  // known video duration. Mirrors the playback engine: each cue opens a band that
  // runs to the next cue (the last to `duration`), playing at the cue's rate —
  // except a skip (code 4), which is seeked past, saving the whole band. The
  // stretch before the first cue plays untouched at 1x; it isn't a segment, so it
  // never enters the sum. Returns seconds saved (negative when a sub-1x speed makes
  // the video longer), or null when the duration isn't known yet — the last band
  // can't be sized without it.
  var SKIP_CODE = 4; // mirror of content.js / the "4 = skip" convention
  function timeSaved(track, speedLevels, duration) {
    if (!(duration > 0) || !isFinite(duration)) return null;
    var segments = trackToSegments(track, speedLevels);
    var saved = 0;
    for (var i = 0; i < segments.length; i++) {
      var start = Math.min(Math.max(segments[i].start, 0), duration);
      var nextStart = (i + 1 < segments.length) ? segments[i + 1].start : duration;
      var end = Math.min(Math.max(nextStart, 0), duration);
      var len = end - start;
      if (len <= 0) continue;
      if (segments[i].code === SKIP_CODE) saved += len;            // seeked past entirely
      else if (segments[i].rate > 0) saved += len * (1 - 1 / segments[i].rate);
    }
    return saved;
  }

  // Turn a Track's cues back into recorder cues [{t, code}] so a saved track can
  // be reopened for editing. Inverse of cuesToTrack; bad cues are skipped.
  function trackToCues(track) {
    var cues = (track && track.cues) || [];
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      var t = parseTimestamp(String(cues[i].timestamp));
      var code = Number(cues[i].speed);
      if (t === null || !Object.prototype.hasOwnProperty.call(SPEED_LEVELS, code)) continue;
      out.push({ t: t, code: code });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  // Validate (and normalize) an imported track. Accepts a parsed object or a JSON
  // string. Returns { track, errors:[{message}] }; track is null when errors exist.
  function validateTrack(input) {
    var errors = [];
    var obj = input;
    if (typeof input === 'string') {
      try { obj = JSON.parse(input); }
      catch (e) { return { track: null, errors: [{ message: 'Not valid JSON: ' + e.message }] }; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { track: null, errors: [{ message: 'Expected a track object.' }] };
    }
    if (!obj.youtubeVideoId || typeof obj.youtubeVideoId !== 'string') {
      errors.push({ message: 'Missing "youtubeVideoId".' });
    }
    if (typeof obj.title !== 'string' || !obj.title.trim()) {
      errors.push({ message: 'Missing "title".' });
    }
    if (!Array.isArray(obj.cues)) {
      errors.push({ message: 'Missing "cues" array.' });
    } else {
      for (var i = 0; i < obj.cues.length; i++) {
        var cue = obj.cues[i];
        if (!cue || parseTimestamp(String(cue.timestamp)) === null) {
          errors.push({ message: 'Cue ' + (i + 1) + ': invalid timestamp.' });
        }
        if (!cue || !Object.prototype.hasOwnProperty.call(SPEED_LEVELS, cue.speed)) {
          errors.push({ message: 'Cue ' + (i + 1) + ': unknown speed code "' + (cue && cue.speed) + '".' });
        }
      }
    }
    if (errors.length) return { track: null, errors: errors };
    return {
      track: {
        schemaVersion: SCHEMA_VERSION,
        youtubeVideoId: obj.youtubeVideoId,
        title: obj.title.trim(),
        description: typeof obj.description === 'string' ? obj.description : '',
        cues: obj.cues.map(function (c) {
          return { timestamp: String(c.timestamp), speed: String(c.speed) };
        })
      },
      errors: []
    };
  }

  // Rate active at time t: the last segment whose start <= t. null if none.
  function rateAt(segments, t) {
    var rate = null;
    for (var i = 0; i < segments.length; i++) {
      if (segments[i].start <= t) rate = segments[i].rate;
      else break;
    }
    return rate;
  }

  var api = {
    parseTrack: parseTrack,
    rateAt: rateAt,
    parseTimestamp: parseTimestamp,
    formatTimestamp: formatTimestamp,
    formatTrack: formatTrack,
    mergeCue: mergeCue,
    slugifyTitle: slugifyTitle,
    cuesToTrack: cuesToTrack,
    trackToCues: trackToCues,
    trackToSegments: trackToSegments,
    timeSaved: timeSaved,
    validateTrack: validateTrack,
    SCHEMA_VERSION: SCHEMA_VERSION,
    TRACK_EXT: TRACK_EXT,
    SPEED_LEVELS: SPEED_LEVELS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SpeedTrack = api;
  }
})(typeof self !== 'undefined' ? self : this);
