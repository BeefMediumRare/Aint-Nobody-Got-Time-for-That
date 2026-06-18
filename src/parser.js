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
  var SPEED_LEVELS = { 1: 1, 2: 2, 3: 2.5, 4: 10 };

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
    SPEED_LEVELS: SPEED_LEVELS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SpeedTrack = api;
  }
})(typeof self !== 'undefined' ? self : this);
