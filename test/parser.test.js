// Minimal test runner — `node test/parser.test.js`. Exits non-zero on failure.
const { parseTrack, rateAt, parseTimestamp, formatTimestamp, formatTrack, mergeCue, SPEED_LEVELS } = require('../src/parser.js');

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
eq('speed levels', SPEED_LEVELS, { 1: 1, 2: 2, 3: 2.5, 4: 10 });

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
  { start: 91, rate: 2.5 }
]);

// out-of-order input is sorted
eq('sorted', parseTrack('2:00 2\n0:30 1').segments.map(x => x.start), [30, 120]);

// rateAt boundaries
eq('before first -> null', rateAt(r.segments, -1), null);
eq('at exact start', rateAt(r.segments, 83), 1);
eq('between', rateAt(r.segments, 85), 1);
eq('after last', rateAt(r.segments, 1000), 2.5);

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

console.log(failed ? `\n${failed} failed` : '\nAll passed');
process.exit(failed ? 1 : 0);
