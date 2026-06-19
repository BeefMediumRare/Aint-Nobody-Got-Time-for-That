# Ain't Nobody Got Time for That

> **Note:** This whole project is purely vibe-coded. Every line was produced by prompting an AI assistant in conversation, not written by hand. Keep that in mind before relying on it.

A Firefox extension that speeds YouTube up and drops it back to normal for the parts worth watching. You give it a list of timestamps with speeds, and it changes the playback rate as the video plays. No holding a key down, no nudging the speed by hand. Watch the filler at 3x and let it slow down on its own for the bits that matter.

That list of timestamps is called a **track**. Record your own, or sync read-only tracks other people have published.

## A few assumptions

I built this for myself. I'm a father of two with not much spare time right now, and I wanted to squeeze in more disc golf content. That shaped a few things:

- **It's for YouTube.** That's where the videos are.
- **It assumes YouTube Premium.** There's no handling for ad breaks. I've never tested what one does to the tracks playback.
- **No Chrome version is planned for now.** Firefox is what I use.

## For viewers

### Install

Get it from [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/aint-nobody-got-time-for-that/), then pin the toolbar icon.

### Use it

1. Open a YouTube video and click the toolbar icon.
2. The popup lists every track for that video: yours, plus any synced from repositories. Pick one and hit **Apply**, then play.
3. The video now follows the track on its own. The progress bar shows colored segments for where it speeds up and slows down.
4. To go back to plain playback, hit **Stop** on the active track. The speed returns to 1x.

The toolbar icon carries a small badge with the number of tracks available for the current video, so you can tell at a glance whether anyone's made one.

### Settings

Click the gear icon at the bottom of the popup. From there you can:

- Set how fast each mode plays. A track stores a *mode* (normal, fast, faster, skip), not a fixed speed, so these are your speeds for every track. The defaults are 1x, 2x, and 3x. Skip has no speed: it jumps straight to the end of the section.
- Turn the colored speed segments on the progress bar on or off.

### Add a repository

People publish tracks in public GitHub folders. To pull them in:

1. Open the settings and find **Add a GitHub repository**.
2. Paste a folder URL like `https://github.com/owner/repo/tree/main/tracks`, add a label if you want, and hit **Add repository**.
3. Firefox asks for permission to reach GitHub the first time. Allow it, and the folder syncs.

Synced tracks are read-only and sit next to your own on any matching video. They work offline after the first sync. Use **Refresh** to pull updates and **Delete** to drop a repo and its tracks. To tweak someone else's track, **Clone** it into a local copy you can edit.

## For authors

You make a track by recording it while you watch, not by typing timestamps.

1. Press **`Alt+Shift+R`** (or open the popup and hit **Start recording**). The badge turns red.
2. As the video plays, press a digit to set the speed from that point on: **`1`** normal, **`2`** fast, **`3`** faster, **`4`** skip (jumps to the end of the section). The first press also drops a baseline at `0:00`. Jump around the video freely; each press uses the current time.
3. Press **`Alt+Shift+R`** again (or **End recording**) to finish.
4. Open the popup, give it a title (description optional), and **Save**. It's now tied to this video and comes back whenever you open it.

A few things worth knowing:

- **Fixing a cue:** press a digit again within about 2 seconds of an existing one to change it instead of adding a new one. Two separate cues need to be more than ~4 seconds apart.
- **Removing a cue:** set it to the same speed as the segment right before it, and it drops out.
- **Editing later:** hit **Edit** on one of your tracks to reopen it as a recording. Change the cues, title, or description, then end the session to save. Keep the title to overwrite it, or rename it to save a separate track.

### Sharing your tracks

Hit **Download** on a track to save it as a JSON file named `<videoId>_<title>.json`. Commit that into a public GitHub repo and anyone can add the folder as a repository. Organize the files however you like; they're matched to videos by the id in the filename, so a folder per channel is one tidy option.

## Contributing

This repo is the extension only, not a place for tracks.

Pull requests are welcome; anyone can open one, and the maintainers handle merging.

What matters most is a clear PR description: what you set out to do and what you changed to do it. Write it for someone seeing the change cold.

## Releasing

Pushing a `v*` tag publishes a release. That tag push is the only trigger; commits and pull requests on their own do nothing.

The `version` in `manifest.json` at the tagged commit must match the tag, or the run fails. So you tag whatever the manifest already says (`v1.2.3` for manifest `1.2.3`). Firefox Add-ons also rejects a version it has already accepted, so to publish again, set the manifest to a new version first.

1. Check that `manifest.json`'s `version` is the one you want to publish, and is committed.
2. Tag that commit and push: `git tag v1.2.3 -m v1.2.3 && git push --tags`. The repo signs tags, so the message is required.

The tag push runs `.github/workflows/release.yml`, which checks the tag against the manifest version, runs the tests, builds the package, and submits to Firefox Add-ons once you approve the run.

Signing uses two repository secrets, `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`, from an add-on API key.

## License

[MIT](LICENSE). Do what you like with it.
