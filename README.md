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

All inputs must share sample rate + channel
count (the bundled assets are 48kHz stereo).

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
(default 7.5s, leaving 0.5s of headroom against
the produce step's 8s slot). If the synthesised
audio is longer the command writes the WAV
anyway so you can hear what landed, but exits
non-zero -- a downstream `produce` call in the
same shell pipeline fails fast.

Service responds with 16-bit mono 16kHz WAV;
the produce step's `sox -m` will up-mix to
48kHz stereo automatically.

## Licence

AGPL-3.0. See [LICENSE](./LICENSE).
