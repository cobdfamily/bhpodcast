# bhpodcast

BlindHub podcasting helpers. Small CLI subcommands
wrapping SoX for the broadcast / podcast assembly
pipeline.

## Install

```sh
cd cli/bhpodcast
npm install -g .
```

Requires Node 22+ and `sox` in PATH:

- macOS: `brew install sox`
- Debian/Ubuntu: `apt-get install sox`

## Subcommands

| Name | What it does |
|------|--------------|
| `duck` | Punches a hole of reduced gain in a music track between two timestamps, with short fades on the edges. |
| `produce` | Assembles a podcast episode from intro / description / content / outro tracks, mirroring the cobd staging pipeline. |
| `describe` | Synthesises a short description WAV from text via the newsline TTS service, with a duration check to keep it in the produce slot. |
| `chapters` | Stitches an EXTM3U playlist into one content WAV and emits chapter markers (Podcasting 2.0 JSON + show-notes TXT + CUE sheet). `produce` auto-shifts the offsets when it sees a sibling chapters.json. |

Run `bhpodcast <name> --help` for the options each
subcommand accepts.

## duck

Classic broadcast ducking: the background music
dips during a voice-over so the listener hears
speech clearly, then returns to full volume. This
subcommand produces the ducked-music output only;
overlaying a voice track is a separate step (a
future `bhpodcast mix` subcommand).

```sh
bhpodcast duck \
  --input music.wav \
  --start 12 --end 47 \
  --gain=-12 \
  --output ducked.wav
```

> Negative numbers (`--gain`, etc.) require the
> `--name=-value` form. Plain `--gain -12` is
> rejected as ambiguous by Node's argv parser.

Options:

| Flag             | Default | Meaning |
|------------------|---------|---------|
| `--input` / `-i` | (required) | Source WAV. |
| `--start` / `-s` | (required) | When the duck begins (seconds). |
| `--end` / `-e`   | (required) | When the duck ends (seconds). |
| `--output` / `-o`| (required) | Output WAV. |
| `--gain` / `-g`  | `-6` | dB reduction during the duck. Negative. |
| `--fade` / `-f`  | `0.4` | Fade length at each duck edge (seconds). |

### How it works

SoX is invoked with three sub-pipelines mixed
together (`-m`):

1. The pre-duck region at full volume, fading out
   over `--fade` seconds at the duck's start.
2. The duck region at `--gain` dB, fading in on
   the left edge and out on the right edge.
3. The post-duck region at full volume, fading
   in over `--fade` seconds at the duck's end.

A trailing `gain 9.542` dB compensates for `-m`'s
three-way amplitude attenuation
(`3 * log10(3) ≈ 9.542`).

Ported faithfully from `blindhub.experiments/
Attempt 4 - Mix/mix.js` -- byte-equivalent output
when given matching inputs.

## produce

Assembles a podcast episode by mixing four
audio tracks. Faithful port of the old TTS
folder's `stage.sh`: the four tracks are pre-
padded with leading silence so they line up
when `sox -m`-mixed at t=0 simultaneously --
intro at t=0, description at t=8s, content at
t=28s, outro positioned to land after the
content ends.

```sh
bhpodcast produce \
  --description ep1-desc.wav \
  --content ep1-content.wav \
  --output episode.wav
```

Defaults pick up the bundled `assets/intro/
intro-spoken.wav` and `assets/outro/outro2.wav`
and the silence padders under
`assets/silence/`. Override any of them with
`--intro`, `--outro`, `--silence-dir`.

Working files land in `./stage/` by default;
override with `--stage-dir`, or pass `--clean`
to wipe before producing.

Pipeline (matches `stage.sh`):

1. `stage/description.wav`  = 8s silence + description
2. `stage/gain.wav`         = content @ -7 dBFS
3. `stage/content.wav`      = 28s silence + gain.wav,
                              with compand + -7 dBFS
4. `stage/silence-out.wav`  = silence of duration(content)
5. `stage/content-out.wav`  = silence-out + outro
6. `<output>`               = -m mix of (intro,
                              description, content,
                              content-out)

Content + description WAVs that don't already
match the bundled assets' 48kHz stereo shape are
auto-converted on the fly into the stage dir;
the originals are never modified. A `--clean`
run will rebuild those converted copies next
time.

## describe

Synthesises a short description WAV from text
via the newsline TTS service at
`https://newsline.apps.blindhub.ca/v1/speak`.
Designed to feed straight into `produce`'s
`--description` flag.

```sh
bhpodcast describe \
  --text "Today on the show we cover accessibility on the web." \
  --output ep1-desc.wav
```

Or from a file:

```sh
bhpodcast describe --text-file ep1-blurb.txt \
                   --output ep1-desc.wav
```

The output is checked against `--max-duration`
(default 12s, the produce step's description-slot
length). If the synthesised audio is longer the
command writes the WAV anyway so you can hear
what landed, but exits non-zero -- a downstream
`produce` call in the same shell pipeline fails
fast.

Service responds with 16-bit mono 16kHz WAV;
the produce step's `sox -m` will up-mix to
48kHz stereo automatically.

## chapters

For multi-part episodes (interview part 1, music
break, interview part 2, etc.), `chapters` reads
an EXTM3U playlist, stitches the parts into one
content WAV, and writes chapter markers in three
formats next to it.

```
#EXTM3U
#EXTINF:-1,Welcome and housekeeping
intro.wav
#EXTINF:-1,Interview with Sam Hofstein
interview-pt1.wav
#EXTINF:-1,Music break
break.wav
#EXTINF:-1,More with Sam
interview-pt2.wav
```

Run:

```sh
bhpodcast chapters \
  --playlist episode-7.m3u \
  --output content.wav
```

(Add `--bridge assets/bridge.wav` to insert the
bundled bridge audio between every pair of
parts; its duration is included in the chapter
offsets of everything that follows.)

Plain `# Title` comments before a filename also
work as a friendlier alternative to EXTINF.

The `-1` after `EXTINF:` is the spec's
"unknown-duration" sentinel; real durations are
probed from each audio file with `soxi`.

### Output files

Alongside `content.wav`, three chapter manifests
land:

| File                          | Read by |
|-------------------------------|---------|
| `content.wav.chapters.json`   | Podcasting 2.0 clients (Apple Podcasts, Overcast, Pocket Casts) |
| `content.wav.chapters.txt`    | Show-notes box (one `HH:MM:SS Title` per line; Apple Podcasts auto-detects) |
| `content.wav.chapters.cue`    | Foobar2000, Quod Libet, VLC |

Offsets are relative to `content.wav` -- chapter
1 starts at `00:00:00`.

### produce auto-shifts the offsets

When `produce` runs against a content WAV that
has a sibling `.chapters.json`, it shifts every
offset by the content-pad (28s, the silence28
prepend) and writes the shifted shape next to
the final episode:

```
content.wav.chapters.json         -> chapter 1 @ 00:00
episode.wav.chapters.json         -> chapter 1 @ 00:28
episode.wav.chapters.txt
episode.wav.chapters.cue
```

The listener's podcast app reads the episode-
level chapters, so the timing matches what they
hear. The content-level chapters stay on disk
unchanged for reference.

### End-to-end workflow

```sh
bhpodcast chapters \
  --playlist episode-7.m3u \
  --output content.wav \
  --bridge assets/bridge.wav

bhpodcast describe \
  --text-file ep7-blurb.txt \
  --output desc.wav

bhpodcast produce \
  --description desc.wav \
  --content content.wav \
  --output episode-7.wav
```

Three commands, three concerns: chapter timing,
description, full assembly.

## Licence

AGPL-3.0. See [LICENSE](./LICENSE).
