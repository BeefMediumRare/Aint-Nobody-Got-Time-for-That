# Ain't Nobody Got Time for That

> **Note:** This whole project is purely vibe-coded. Every line was produced by prompting an AI assistant in conversation, not written by hand. Keep that in mind before relying on it.

A Firefox extension that controls YouTube playback speed from a list of timestamps. Watch most of a video sped up and have it drop back to normal speed automatically for the parts you want to see at full detail, without holding a key down or adjusting the speed by hand.

## Load it (temporary)

1. Go to `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** and pick `manifest.json` in this folder
3. Open a YouTube video and click the toolbar icon
4. Paste a track (see below) or record one, hit **Apply to this video**, and press play

The add-on unloads when Firefox closes, so reload it the same way next session.

## Record a track (authoring mode)

Rather than typing timestamps by hand, record them while watching:

1. Press **`Alt+Shift+R`** (or use the toolbar icon and **Start recording**) to begin. The icon shows a red badge. The chord keeps this always-on shortcut from firing while you type.
2. Press a digit **`1`–`4`** to set a speed: `1`=normal, `2`=fast, `3`=faster, `4`=skip. The first press sets the baseline at `0:00` wherever you are; every press after that uses the current playback time, so you can jump around freely. The badge count goes up each time.
3. Press **`Alt+Shift+R`** again (or the icon and **End recording**) to stop.
4. Open the toolbar icon. The track, sorted by timestamp, is in the textarea. Hit **Apply to this video** and check it.

Each entry is a **cue** (a timestamp plus a speed). To fix a cue, press a digit again near it: a press within **±2s** of the nearest existing cue updates that cue's speed instead of adding a duplicate (`MERGE_WINDOW_SEC` in `src/author.js`). Because of this, two distinct cues have to be more than ~4s apart (twice the window). Lower it if you need tighter segments.

**Deleting a cue:** a cue that matches the speed of the cue right before it does nothing, so it isn't created when adding or is removed when editing. To delete a cue, set it to the same speed as the segment before it. Normal playback keys (space, `k`, `j`, `l`, arrows) keep working throughout.

## Track format

One `<timestamp> <code>` entry per line (roughly `\d+:\d{2} [1-4]`). A speed applies from its timestamp until the next entry.

```
# code: 1=normal (1x), 2=fast (2x), 3=faster (2.5x), 4=skip (10x)
0:00 2     # whole video at 2x from the start
1:23 1     # slow down for this part
1:31 2     # back up to speed
3:05 4     # skip past something
```

- Timestamps: `h:mm:ss`, `mm:ss`, or raw seconds (`90.5`).
- Code: a speed level (see `SPEED_LEVELS` in `src/parser.js`, the future home for per-user speed preferences, and where slower codes `-1..-4` would go).
- Before the first entry, the rate is left untouched (add a `0:00` line for a baseline from the start).

## Tip

If you also run the **videospeed** extension, disable it on YouTube while testing. Both write `playbackRate` and will fight each other.

## Tests

```
node test/parser.test.js
```
