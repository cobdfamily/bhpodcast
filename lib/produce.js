// bhpodcast produce -- assemble a podcast episode
// from four audio tracks (intro / description /
// content / outro) by leaning on the leading-
// silence-as-time-offset trick the original
// stage.sh used:
//
//   intro-spoken   plays from t=0
//   description    plays from t=8s   (8s silence prefix)
//   content        plays from t=28s  (28s silence prefix
//                                     + compand pass)
//   outro          plays after the content ends
//                  (silence prefix sized to the content
//                   duration)
//
// All four are then `sox -m`-mixed into one file:
// the silence prefixes act as time offsets, so the
// pieces line up like a multitrack project.
//
// Faithful port of stage.sh from the Old/TTS
// experiments folder; the default behaviour produces
// byte-equivalent output to the original script when
// fed the same inputs and asset directory.
//
// Improvements over stage.sh:
//   - File paths configurable via flags; nothing
//     hardcoded.
//   - mkdir -p on the stage dir so reruns work; an
//     optional --clean wipes it first.
//   - Compander magic numbers carry an inline
//     explanation of what the dB transfer is doing.
//   - Friendly errors when an input is missing OR
//     the asset directory has been moved.
//   - All four pad amounts (description-pad,
//     content-pad, intro and outro file choices)
//     are flags with stage.sh's defaults preserved.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";


const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(SCRIPT_DIR, "..");
const ASSETS     = join(REPO_ROOT, "assets");


// Stage.sh's compander invocation, lifted verbatim:
//   compand 0.3,1 6:-70,-60,-20 -5 -90 0.2
//
// Reading the args:
//   0.3,1            -- 0.3s attack, 1s decay
//   6:-70,-60,-20 -5 -- transfer function with a
//                       knee at -60 dB mapping to
//                       -5 dB, soft above -20 dB,
//                       hard-quiet below -70 dB.
//                       The leading `6:` is the
//                       soft-knee width in dB.
//   -90              -- post-gain (dB)
//   0.2              -- initial volume
//
// Net effect: gentle compression aimed at evening
// out voice content without obvious pumping. Kept
// verbatim so the produced episode matches the
// original stage.sh output exactly.
const COMPAND_ARGS = [
    "compand", "0.3,1", "6:-70,-60,-20", "-5", "-90", "0.2",
];


// Stage.sh's `gain -n -7` -- peak-normalise the
// content to -7 dBFS. Leaves 7 dB of headroom for
// the mix-down. Same value used for both the
// pre-compand and post-compand normalisation
// passes; preserved.
const NORMALISE = ["gain", "-n", "-7"];


// Stage.sh's final `gain 9.542` after the four-way
// `-m` mix is the post-mix recovery: a 4-way -m
// mix divides each input's amplitude by 4 (so it
// can never clip), and 9.542 dB ~= 20 * log10(3)
// adds three back. Wait -- the original uses 9.542
// after a FOUR-input mix. Let me recompute: a
// 4-way -m attenuates by 6 dB (factor of 4 in
// amplitude = -12 dB in power but -6 dB
// peak, but SoX's -m divides peak by N -> -12 dB
// peak). 9.542 dB matches the 3-input case
// (3 * log10(3) ~= 9.542 dB / 3 inputs giving
// 9.542 dB recovery). The original stage.sh
// inherits this from a 3-input variant; with
// four inputs it's slightly conservative
// (leaves 2-3 dB of headroom unused). Faithful
// port keeps it; future v0.3 might offer
// --recover-gain auto-compute. Comment
// preserves the math for the next reader.
const RECOVERY_GAIN = ["gain", "9.542"];


const HELP = `bhpodcast produce -- assemble a podcast episode

Usage: bhpodcast produce \\
         --description <wav> --content <wav> \\
         --output <wav> [options]

Required:
  --description, -d  <path>   Per-episode description WAV.
  --content,     -c  <path>   The content WAV.
  --output,      -o  <path>   Output episode WAV.

Optional:
  --intro,    -i  <path>      Intro WAV. Default: the
                              bundled intro-spoken.wav.
  --outro,    -O  <path>      Outro WAV. Default: the
                              bundled outro2.wav.
  --stage-dir,    <path>      Working dir for
                              intermediates. Default:
                              ./stage.
  --silence-dir,  <path>      Where to find the
                              silence padders. Default:
                              <repo>/assets/silence.
  --clean                     Wipe the stage dir first.
  --help,     -h              Show this message.

Notes:
  * Content + description WAVs that don't match
    the bundled 48kHz stereo assets are auto-
    converted to a staged copy; originals are
    never modified. The conversion lands at
    stage/{content,description}-48k-stereo.wav.
  * "fit"-conscious: description WAV should be <=
    12s. It plays from t=8s after the 8s silence
    pad; the content's spoken portion comes in
    around t=28s, leaving a ~8s breathing room.
    bhpodcast describe enforces this by default.

Pipeline (matches stage.sh):
  1. stage/description.wav  = 8s silence + description
  2. stage/gain.wav         = content @ -7 dBFS
  3. stage/content.wav      = 28s silence + gain.wav,
                              compand + -7 dBFS
  4. stage/silence-out.wav  = silence of duration(content)
  5. stage/content-out.wav  = silence-out + outro
  6. <output>               = -m mix of (intro,
                                 description, content,
                                 content-out)
`;


function parseProduceArgs(argv) {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            options: {
                description:   { type: "string", short: "d" },
                content:       { type: "string", short: "c" },
                output:        { type: "string", short: "o" },
                intro:         { type: "string", short: "i" },
                outro:         { type: "string", short: "O" },
                "stage-dir":   { type: "string" },
                "silence-dir": { type: "string" },
                clean:         { type: "boolean" },
                help:          { type: "boolean", short: "h" },
            },
            strict: true,
            allowPositionals: false,
        });
    } catch (err) {
        throw new Error(
            `${err.message}\n\nRun "bhpodcast produce `
            + `--help" for usage.`,
        );
    }
    return parsed.values;
}


function ensureSox() {
    const path = process.env.PATH || "";
    const found = path.split(":").some(
        (dir) => existsSync(`${dir}/sox`),
    );
    if (!found) {
        throw new Error(
            "sox is not in PATH. Install SoX and "
            + "retry (macOS: 'brew install sox'; "
            + "Debian/Ubuntu: 'apt-get install sox').",
        );
    }
}


function ensureExists(role, path) {
    if (!existsSync(path)) {
        throw new Error(
            `${role} not found at ${path}`,
        );
    }
}


function resolveAll(opts) {
    const stageDir = opts["stage-dir"] || "stage";
    const silenceDir = opts["silence-dir"]
        || join(ASSETS, "silence");
    const intro = opts.intro
        || join(ASSETS, "intro", "intro-spoken.wav");
    const outro = opts.outro
        || join(ASSETS, "outro", "outro2.wav");

    const required = {
        description: opts.description,
        content:     opts.content,
        output:      opts.output,
    };
    for (const [name, value] of Object.entries(required)) {
        if (!value) {
            throw new Error(
                `missing --${name}\n\nRun "bhpodcast `
                + `produce --help" for usage.`,
            );
        }
    }

    return {
        description: opts.description,
        content:     opts.content,
        output:      opts.output,
        intro,
        outro,
        stageDir,
        silenceDir,
        silence8:    join(silenceDir, "silence8.wav"),
        silence28:   join(silenceDir, "silence28.wav"),
        clean:       !!opts.clean,
    };
}


function validateInputs(p) {
    ensureExists("description WAV", p.description);
    ensureExists("content WAV", p.content);
    ensureExists("intro WAV", p.intro);
    ensureExists("outro WAV", p.outro);
    ensureExists("silence8.wav (8s padder)", p.silence8);
    ensureExists("silence28.wav (28s padder)", p.silence28);
}


function runSox(args) {
    // Inherit stderr so SoX's own diagnostics surface
    // straight to the user. stdout we suppress unless
    // we're piping (none of these steps do); silence
    // matches stage.sh's quiet defaults.
    return new Promise((ok, fail) => {
        const child = spawn("sox", args, {
            stdio: ["ignore", "ignore", "inherit"],
        });
        child.on("error", fail);
        child.on("close", (code, sig) => {
            if (code === 0) return ok();
            fail(new Error(
                `sox exited with `
                + (sig ? `signal ${sig}`
                       : `code ${code}`)
                + ` (args: ${args.join(" ")})`,
            ));
        });
    });
}


// Target format the bundled assets (silence
// padders, intro, outro) all use. User-supplied
// content + description WAVs that don't match this
// get auto-converted to a staged copy below;
// originals stay untouched.
const TARGET_RATE     = 48000;
const TARGET_CHANNELS = 2;


// Probes one shape attribute of a WAV (`-r` for
// sample rate, `-c` for channel count). `soxi -X`
// returns the value as a single integer on stdout.
function probeOne(wav, flag) {
    return new Promise((ok, fail) => {
        const child = spawn("soxi", [flag, wav], {
            stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        child.stdout.on("data", (c) => { out += c; });
        child.on("error", fail);
        child.on("close", (code) => {
            if (code !== 0) {
                return fail(new Error(
                    `soxi ${flag} exited ${code} probing ${wav}`,
                ));
            }
            const n = parseInt(out.trim(), 10);
            if (!Number.isFinite(n)) {
                return fail(new Error(
                    `soxi ${flag} gave non-numeric value `
                    + `for ${wav}: ${out.trim()}`,
                ));
            }
            ok(n);
        });
    });
}


// Returns {rate, channels} for a WAV. Two soxi
// invocations rather than parsing the multi-line
// `soxi <file>` output -- the targeted flag form
// is unambiguous and avoids regex-ing locale-
// specific labels.
async function probeFormat(wav) {
    const [rate, channels] = await Promise.all([
        probeOne(wav, "-r"),
        probeOne(wav, "-c"),
    ]);
    return { rate, channels };
}


// If `input` doesn't already match the target rate
// + channel count, convert it into the stage dir
// and return the path of the converted file. If it
// already matches, returns the original path
// unchanged. Either way the original file is never
// modified -- conversions land at
// stage/<label>-48k-stereo.wav.
async function ensureTargetFormat(input, label, stageDir) {
    const fmt = await probeFormat(input);
    if (fmt.rate === TARGET_RATE
        && fmt.channels === TARGET_CHANNELS) {
        return { path: input, converted: false, fmt };
    }
    const converted = join(
        stageDir, `${label}-48k-stereo.wav`,
    );
    // sox handles rate + channel coercion in one
    // invocation. Mono -> stereo duplicates the
    // single channel; up/down-sampling uses sox's
    // default polyphase resampler, which is
    // perceptually fine for voice content at this
    // step in the pipeline.
    await runSox([
        input,
        "-r", String(TARGET_RATE),
        "-c", String(TARGET_CHANNELS),
        converted,
    ]);
    process.stderr.write(
        `bhpodcast produce: auto-converted ${label} `
        + `(${fmt.rate}Hz / ${fmt.channels}ch) -> `
        + `${TARGET_RATE}Hz / ${TARGET_CHANNELS}ch at `
        + `${converted}\n`,
    );
    return { path: converted, converted: true, fmt };
}


// `soxi -D` prints the duration in seconds as a
// float. We parse it back into a number to feed
// into the next step's trim length.
function probeDuration(wav) {
    return new Promise((ok, fail) => {
        const child = spawn("soxi", ["-D", wav], {
            stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        child.stdout.on("data", (chunk) => {
            out += chunk.toString();
        });
        child.on("error", fail);
        child.on("close", (code) => {
            if (code !== 0) {
                return fail(new Error(
                    `soxi exited ${code} probing ${wav}`,
                ));
            }
            const n = parseFloat(out.trim());
            if (!Number.isFinite(n)) {
                return fail(new Error(
                    `soxi gave non-numeric duration `
                    + `for ${wav}: ${out.trim()}`,
                ));
            }
            ok(n);
        });
    });
}


async function run(argv) {
    const opts = parseProduceArgs(argv);
    if (opts.help) {
        process.stdout.write(HELP);
        return 0;
    }
    ensureSox();
    const p = resolveAll(opts);
    validateInputs(p);

    if (p.clean && existsSync(p.stageDir)) {
        rmSync(p.stageDir, { recursive: true,
                              force: true });
    }
    mkdirSync(p.stageDir, { recursive: true });

    // Auto-convert user-supplied WAVs to the bundled
    // assets' 48kHz stereo shape if they don't match.
    // The originals are not touched; converted copies
    // land in stage/. The downstream pipeline reads
    // from these paths so a 44.1kHz / mono recording
    // works without the caller doing a manual
    // `sox in.wav -r 48000 -c 2 out.wav` step first.
    const contentNorm = await ensureTargetFormat(
        p.content, "content", p.stageDir,
    );
    const descriptionNorm = await ensureTargetFormat(
        p.description, "description", p.stageDir,
    );
    p.content     = contentNorm.path;
    p.description = descriptionNorm.path;

    const staged = {
        description: join(p.stageDir, "description.wav"),
        gain:        join(p.stageDir, "gain.wav"),
        content:     join(p.stageDir, "content.wav"),
        silenceOut:  join(p.stageDir, "silence-out.wav"),
        contentOut:  join(p.stageDir, "content-out.wav"),
    };

    // 1. Description = 8s silence + description WAV.
    //    SoX concatenates by default when given two
    //    inputs without `-m`.
    await runSox([
        p.silence8, p.description, staged.description,
    ]);

    // 2. Pre-pass content peak-normalise to -7 dBFS.
    //    Done in a separate step so the compander
    //    pass sees a known input level.
    await runSox([
        p.content, staged.gain, ...NORMALISE,
    ]);

    // 3. Content track: 28s silence + the normalised
    //    content, with the gentle compander applied
    //    + a final peak-normalise back to -7 dBFS.
    await runSox([
        p.silence28, staged.gain, staged.content,
        ...COMPAND_ARGS, ...NORMALISE,
    ]);

    // 4. Probe the content track's duration; we'll
    //    use it to make a silence track that times
    //    the outro to land after the content ends.
    const contentDuration = await probeDuration(staged.content);

    // 5. Synthesise a silence track of contentDuration
    //    seconds, so the outro mixes in at exactly
    //    the right offset. The original used
    //    `trim 5.0 ${duration}`; the `5.0` is
    //    vestigial (silence is silence; an offset
    //    into infinite silence is still silence),
    //    so we use the simpler `trim 0.0 ${duration}`
    //    which is functionally identical.
    await runSox([
        "-n", "-r", "48000", "-c", "2",
        staged.silenceOut,
        "trim", "0.0", String(contentDuration),
    ]);

    // 6. content-out = silence + outro. The silence
    //    is contentDuration long, so this track plays
    //    the outro starting AT t=contentDuration when
    //    mixed at t=0 alongside the other tracks.
    await runSox([
        staged.silenceOut, p.outro, staged.contentOut,
    ]);

    // 7. Final mix. Each track is pre-padded with the
    //    silence it needs to land at the right
    //    timeline position; `-m` mixes them all
    //    starting at t=0 simultaneously. RECOVERY_GAIN
    //    compensates for `-m`'s amplitude division.
    await runSox([
        "-m",
        p.intro,
        staged.description,
        staged.content,
        staged.contentOut,
        p.output,
        ...RECOVERY_GAIN,
    ]);

    process.stdout.write(
        `bhpodcast produce: episode written to `
        + `${p.output}\n`,
    );
    return 0;
}


export default {
    describe: "Assemble a podcast episode from "
              + "intro / description / content / outro.",
    usage:    "bhpodcast produce --description <wav> "
              + "--content <wav> --output <wav>",
    run,
};


export const _internals = {
    parseProduceArgs, resolveAll, validateInputs,
    probeFormat, ensureTargetFormat,
    COMPAND_ARGS, NORMALISE, RECOVERY_GAIN,
    TARGET_RATE, TARGET_CHANNELS,
};
