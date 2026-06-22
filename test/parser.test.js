// Minimal test runner — `node test/parser.test.js`. Exits non-zero on failure.
const { parseTrack, rateAt, parseTimestamp, formatTimestamp, formatTrack, mergeCue,
  slugifyTitle, cuesToTrack, trackToCues, trackToSegments, timeSaved, validateTrack, SCHEMA_VERSION, SPEED_LEVELS } = require('../src/parser.js');

let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label +
    (ok ? '' : '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)));
}

// timestamp formats
eq('ts mm:ss', parseTimestamp('1:23'), 83);
eq('ts h:mm:ss', parseTimestamp('1:02:03'), 3723);
eq('ts raw seconds', parseTimestamp('90.5'), 90.5);
eq('ts invalid', parseTimestamp('1:2:3:4'), null);

// speed-level table: 1=normal, 2=fast, 3=faster, 4=skip
eq('speed levels', SPEED_LEVELS, { 1: 1, 2: 2, 3: 3, 4: 10 });

// full parse: numeric codes, comments
const r = parseTrack([
  '# a comment',
  '0:00  2',
  '1:23  1   # slow part',
  '1:31  3',
  '90    4'
].join('\n'));
eq('no errors', r.errors, []);
eq('segments', r.segments, [
  { start: 0, rate: 2 },
  { start: 83, rate: 1 },
  { start: 90, rate: 10 },
  { start: 91, rate: 3 }
]);

// out-of-order input is sorted
eq('sorted', parseTrack('2:00 2\n0:30 1').segments.map(x => x.start), [30, 120]);

// rateAt boundaries
eq('before first -> null', rateAt(r.segments, -1), null);
eq('at exact start', rateAt(r.segments, 83), 1);
eq('between', rateAt(r.segments, 85), 1);
eq('after last', rateAt(r.segments, 1000), 3);

// error reporting: bad timestamp, unknown code, missing code
const errs = parseTrack('nope:nope 1\n0:00 5\n0:00').errors;
eq('error count', errs.length, 3);
eq('unknown code reported', /Unknown speed code/.test(errs[1].message), true);
eq('zero is no longer valid', parseTrack('0:00 0').errors.length, 1);

// formatTimestamp
eq('fmt mm:ss', formatTimestamp(83), '1:23');
eq('fmt zero', formatTimestamp(0), '0:00');
eq('fmt pad seconds', formatTimestamp(65), '1:05');
eq('fmt h:mm:ss', formatTimestamp(3725), '1:02:05');
eq('fmt rounds', formatTimestamp(83.6), '1:24');

// formatTrack: sorts by t, renders "<ts> <code>"
eq('formatTrack',
  formatTrack([{ t: 91, code: 2 }, { t: 0, code: 2 }, { t: 83, code: 1 }]),
  '0:00 2\n1:23 1\n1:31 2');

// round-trip: formatted track parses back to matching segments
const rt = parseTrack(formatTrack([{ t: 0, code: 2 }, { t: 83, code: 1 }]));
eq('round-trip errors', rt.errors, []);
eq('round-trip segments', rt.segments, [{ start: 0, rate: 2 }, { start: 83, rate: 1 }]);

// mergeCue: empty -> adds
eq('merge into empty', mergeCue([], 10, 2, 5), [{ t: 10, code: 2 }]);
// far from existing -> adds a new cue
eq('merge far adds', mergeCue([{ t: 10, code: 1 }], 20, 2, 5), [{ t: 10, code: 1 }, { t: 20, code: 2 }]);
// within window -> updates code, keeps timestamp, no new cue
eq('merge near updates', mergeCue([{ t: 10, code: 1 }], 13, 2, 5), [{ t: 10, code: 2 }]);
// exactly at window edge -> still merges (<=)
eq('merge at edge', mergeCue([{ t: 10, code: 1 }], 15, 3, 5), [{ t: 10, code: 3 }]);
// just past window edge -> adds
eq('merge past edge adds', mergeCue([{ t: 10, code: 1 }], 15.1, 3, 5).length, 2);
// picks the NEAREST existing cue within range
eq('merge nearest',
  mergeCue([{ t: 10, code: 1 }, { t: 14, code: 1 }], 13, 4, 5),
  [{ t: 10, code: 1 }, { t: 14, code: 4 }]);

// add with same speed as the preceding cue -> not created
eq('add redundant skipped', mergeCue([{ t: 0, code: 1 }], 60, 1, 2), [{ t: 0, code: 1 }]);
// edit a cue to match the cue before it -> dropped (the "delete" gesture)
eq('edit to preceding drops cue',
  mergeCue([{ t: 0, code: 1 }, { t: 60, code: 2 }], 60, 1, 2),
  [{ t: 0, code: 1 }]);
// the first cue (no predecessor) is never dropped, just updated
eq('baseline never dropped',
  mergeCue([{ t: 0, code: 1 }, { t: 60, code: 2 }], 0, 2, 2),
  [{ t: 0, code: 2 }, { t: 60, code: 2 }]);

// ---- Track documents ------------------------------------------------------

// slugifyTitle: lowercase, non-alphanumerics collapse to '-', trimmed
eq('slug basic', slugifyTitle('My Track'), 'my-track');
eq('slug punctuation', slugifyTitle('Skip the!! intro?'), 'skip-the-intro');
eq('slug trims edges', slugifyTitle('  --Hi--  '), 'hi');
eq('slug empty', slugifyTitle(''), 'untitled');

// cuesToTrack: recorder cues -> JSON document (sorted, timestamps + code strings)
eq('cuesToTrack', cuesToTrack([{ t: 83, code: 1 }, { t: 0, code: 2 }],
  { videoId: 'abc12345', title: 'T', description: 'D' }),
  {
    schemaVersion: SCHEMA_VERSION,
    youtubeVideoId: 'abc12345',
    title: 'T',
    description: 'D',
    cues: [{ timestamp: '0:00', speed: '2' }, { timestamp: '1:23', speed: '1' }]
  });

// trackToSegments: resolve codes through the speed map (default = SPEED_LEVELS)
const trk = { youtubeVideoId: 'x', title: 't', cues: [
  { timestamp: '1:23', speed: '1' }, { timestamp: '0:00', speed: '2' }
] };
eq('trackToSegments default', trackToSegments(trk),
  [{ start: 0, rate: 2, code: 2 }, { start: 83, rate: 1, code: 1 }]);
// custom prefs change the resolved rate (the code still rides along for coloring)
eq('trackToSegments custom prefs', trackToSegments(trk, { 1: 1, 2: 1.5 }),
  [{ start: 0, rate: 1.5, code: 2 }, { start: 83, rate: 1, code: 1 }]);
// unknown code / bad timestamp are skipped
eq('trackToSegments skips bad cues',
  trackToSegments({ cues: [{ timestamp: '0:00', speed: '9' }, { timestamp: 'nope', speed: '2' }, { timestamp: '0:30', speed: '2' }] }),
  [{ start: 30, rate: 2, code: 2 }]);

// trackToCues: Track document -> recorder cues [{t, code}] (inverse of cuesToTrack)
eq('trackToCues', trackToCues({ cues: [
  { timestamp: '1:23', speed: '1' }, { timestamp: '0:00', speed: '2' }
] }), [{ t: 0, code: 2 }, { t: 83, code: 1 }]);
// skips bad cues
eq('trackToCues skips bad', trackToCues({ cues: [
  { timestamp: 'x', speed: '2' }, { timestamp: '0:00', speed: '9' }, { timestamp: '0:30', speed: '1' }
] }), [{ t: 30, code: 1 }]);
// round-trips with cuesToTrack
const cuesEdit = [{ t: 0, code: 2 }, { t: 83, code: 1 }, { t: 91, code: 4 }];
eq('cues round-trip via track', trackToCues(cuesToTrack(cuesEdit, { videoId: 'v', title: 't' })), cuesEdit);

// round-trip: cuesToTrack -> trackToSegments matches parseTrack(formatTrack(...)).
// parseTrack carries no code, so compare on start/rate only.
const cuesRt = [{ t: 0, code: 2 }, { t: 83, code: 1 }, { t: 91, code: 3 }];
eq('track round-trip segments',
  trackToSegments(cuesToTrack(cuesRt, { videoId: 'v', title: 't' }))
    .map(function (s) { return { start: s.start, rate: s.rate }; }),
  parseTrack(formatTrack(cuesRt)).segments);

// validateTrack: a good object normalizes and reports no errors
const okv = validateTrack({ youtubeVideoId: 'v', title: '  Hi  ', cues: [{ timestamp: '0:00', speed: '2' }] });
eq('validate ok no errors', okv.errors, []);
eq('validate trims title', okv.track.title, 'Hi');
eq('validate fills description', okv.track.description, '');
eq('validate stamps schema', okv.track.schemaVersion, SCHEMA_VERSION);

// validateTrack: accepts a JSON string
eq('validate from json string',
  validateTrack('{"youtubeVideoId":"v","title":"t","cues":[{"timestamp":"0:00","speed":"1"}]}').errors, []);
eq('validate bad json', validateTrack('{not json').errors.length, 1);

// validateTrack: missing/invalid fields are reported, track is null
eq('validate missing id+title', validateTrack({ cues: [] }).errors.length, 2);
eq('validate missing id+title null', validateTrack({ cues: [] }).track, null);
eq('validate bad cue ts', validateTrack({ youtubeVideoId: 'v', title: 't', cues: [{ timestamp: 'x', speed: '1' }] }).errors.length, 1);
eq('validate unknown code', validateTrack({ youtubeVideoId: 'v', title: 't', cues: [{ timestamp: '0:00', speed: '7' }] }).errors.length, 1);
eq('validate missing cues array', validateTrack({ youtubeVideoId: 'v', title: 't' }).errors.length, 1);

// timeSaved: watch time trimmed at the user's speeds, against a known duration.
const sv = (cues, dur, levels) => timeSaved({ cues }, levels, dur);
// one 2x band over the whole video saves half
eq('saved 2x whole', sv([{ timestamp: '0:00', speed: '2' }], 100), 50);
// a skip is seeked past, saving the whole stretch (not just rate-scaled)
eq('saved skip to end', sv([{ timestamp: '0:00', speed: '4' }], 100), 100);
// the stretch before the first cue plays at 1x and contributes nothing
eq('saved head at 1x', sv([{ timestamp: '0:20', speed: '2' }], 120), 50);
// mixed: 2x for the first minute (saves 30), then skip the rest (saves 60)
eq('saved mixed', sv([{ timestamp: '0:00', speed: '2' }, { timestamp: '1:00', speed: '4' }], 120), 90);
// a sub-1x speed makes the video longer -> negative ("adds time")
eq('saved negative slow', sv([{ timestamp: '0:00', speed: '1' }], 100, { 1: 0.5 }), -100);
// no cues -> nothing saved
eq('saved no cues', sv([], 100), 0);
// duration unknown -> null (the last band can't be sized)
eq('saved no duration', sv([{ timestamp: '0:00', speed: '2' }], undefined), null);
eq('saved zero duration', sv([{ timestamp: '0:00', speed: '2' }], 0), null);

console.log(failed ? `\n${failed} failed` : '\nAll passed');
process.exit(failed ? 1 : 0);
