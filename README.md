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

## Licence

AGPL-3.0. See [LICENSE](./LICENSE).
