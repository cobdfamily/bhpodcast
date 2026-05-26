// bhpodcast duck -- "punch a hole" of reduced
// gain in a music track between two timestamps,
// with short fade transitions on both edges.
//
// The classic broadcast ducking pattern: the
// background music dips during a voice-over so
// the listener can hear the speech clearly,
// then the music returns to full volume. This
// subcommand produces the ducked-music output
// only; mixing the voice on top is a separate
// step (a future `bhpodcast mix` subcommand).
//
// Implementation faithfully ports the original
// experiment at blindhub.experiments/Attempt 4 -
// Mix/mix.js, just wrapped in proper CLI argument
// parsing + input validation + helpful errors.
//
// SoX command structure:
//
//   sox -m
//     -t wav |sox -V1 IN -t wav - fade t 0 START 0.4
//     -t wav |sox -V1 IN -t wav - trim START-0.4
//                  fade t 0.4 (END-START+0.4) 0.4
//                  gain GAIN
//                  pad START-0.4
//     -t wav |sox -V1 IN -t wav - trim END-0.4
//                  fade t 0.4 0 0
//                  pad END-0.4
//     OUT gain 9.542
//
// Three sub-mixes are produced from the same input
// (full-volume pre-segment with a fade-out, ducked
// middle segment, full-volume post-segment with a
// fade-in) and `-m` mixes them together into a
// single output. The trailing `gain 9.542` is a
// SoX trick: the -m mix divides amplitude by N,
// and 9.542 dB is +3 * log10(3) -- exactly the
// gain needed to undo the three-way attenuation
// without clipping.

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";


const HELP = `bhpodcast duck -- duck a region of a music track

Usage: bhpodcast duck --input <file> --start <sec>
                      --end <sec> [options] --output <file>

Required:
  --input,  -i  <path>    Source WAV file.
  --start,  -s  <secs>    When the duck starts (sec).
  --end,    -e  <secs>    When the duck ends (sec).
  --output, -o  <path>    Output WAV.

Options:
  --gain,   -g  <dB>      Gain reduction during the
                          ducked region. Negative
                          number. Default: -6.
  --fade,   -f  <secs>    Length of the fade-in /
                          fade-out at each duck
                          edge. Default: 0.4.
  --help,   -h            Show this message.

Example:
  bhpodcast duck \\
    --input music.wav \\
    --start 12 --end 47 --gain=-12 \\
    --output ducked.wav

Notes:
  * Times are seconds (decimals allowed).
  * For negative numbers (e.g. --gain), use the
    "--name=-value" form. Plain "--gain -12" is
    rejected as ambiguous by Node's argv parser.
  * Requires sox in PATH. Install via your package
    manager: 'brew install sox' on macOS,
    'apt-get install sox' on Debian/Ubuntu.
`;


function parseDuckArgs(argv) {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            options: {
                input:   { type: "string", short: "i" },
                start:   { type: "string", short: "s" },
                end:     { type: "string", short: "e" },
                output:  { type: "string", short: "o" },
                gain:    { type: "string", short: "g",
                           default: "-6" },
                fade:    { type: "string", short: "f",
                           default: "0.4" },
                help:    { type: "boolean", short: "h" },
            },
            strict: true,
            allowPositionals: false,
        });
    } catch (err) {
        throw new Error(
            `${err.message}\n\nRun "bhpodcast duck --help" `
            + `for usage.`,
        );
    }
    return parsed.values;
}


function ensureSox() {
    // We could shell out to `which sox` but a missing
    // binary surfaces clearly on spawn-failure anyway;
    // this is just a friendlier upfront error than
    // "ENOENT: spawn sox" deep in the stack.
    const path = process.env.PATH || "";
    const found = path.split(":").some((dir) => {
        return existsSync(`${dir}/sox`);
    });
    if (!found) {
        throw new Error(
            "sox is not in PATH. Install SoX and "
            + "retry (macOS: 'brew install sox'; "
            + "Debian/Ubuntu: 'apt-get install sox').",
        );
    }
}


function validate(opts) {
    const required = ["input", "start", "end", "output"];
    for (const name of required) {
        if (!opts[name]) {
            throw new Error(
                `missing --${name}\n\nRun "bhpodcast `
                + `duck --help" for usage.`,
            );
        }
    }
    if (!existsSync(opts.input)) {
        throw new Error(
            `input file not found: ${opts.input}`,
        );
    }
    const start = Number(opts.start);
    const end   = Number(opts.end);
    const gain  = Number(opts.gain);
    const fade  = Number(opts.fade);
    if (!Number.isFinite(start) || start < 0) {
        throw new Error(
            `--start must be a non-negative number, `
            + `got ${opts.start}`,
        );
    }
    if (!Number.isFinite(end) || end <= start) {
        throw new Error(
            `--end (${opts.end}) must be a number `
            + `greater than --start (${opts.start})`,
        );
    }
    if (!Number.isFinite(gain) || gain >= 0) {
        throw new Error(
            `--gain must be a negative dB value, `
            + `got ${opts.gain}`,
        );
    }
    if (!Number.isFinite(fade) || fade <= 0) {
        throw new Error(
            `--fade must be a positive duration, `
            + `got ${opts.fade}`,
        );
    }
    // Sanity-check that the duck region is long
    // enough for two fades to fit without
    // overlapping. If start + fade >= end - fade
    // the middle "ducked" portion has zero or
    // negative length; SoX would either complain
    // or produce a broken file. Catching it here
    // is a clearer error.
    if (start + fade >= end - fade) {
        throw new Error(
            `duck region (${start}..${end}s) is too `
            + `short for two ${fade}s fades. Either `
            + `widen the region or shorten --fade.`,
        );
    }
    return { input: opts.input, output: opts.output,
             start, end, gain, fade };
}


function buildSoxArgs({ input, output, start, end, gain, fade }) {
    // Three sub-pipelines piped through `|sox ...`
    // tokens. SoX recognises these as nested inputs
    // when fed via `-t wav |sox ...`. The classic
    // mix.js layout, kept faithful so anyone
    // comparing the output byte-for-byte against the
    // experiment sees the same audio.
    const seg1 = (
        `|sox -V1 ${input} -t wav - `
        + `fade t 0 ${start} ${fade}`
    );
    const seg2 = (
        `|sox -V1 ${input} -t wav - `
        + `trim ${start - fade} `
        + `fade t ${fade} ${end - start + fade} ${fade} `
        + `gain ${gain} `
        + `pad ${start - fade}`
    );
    const seg3 = (
        `|sox -V1 ${input} -t wav - `
        + `trim ${end - fade} `
        + `fade t ${fade} 0 0 `
        + `pad ${end - fade}`
    );
    // The trailing `gain 9.542` undoes the
    // three-way attenuation -m introduces: log10(3)
    // dB * 3 ~= 9.542. See module docstring.
    return [
        "-m",
        "-t", "wav", seg1,
        "-t", "wav", seg2,
        "-t", "wav", seg3,
        output,
        "gain", "9.542",
    ];
}


function runSox(args) {
    return new Promise((resolve, reject) => {
        const child = spawn("sox", args, {
            stdio: ["ignore", "inherit", "inherit"],
        });
        child.on("error", reject);
        child.on("close", (code, signal) => {
            if (code === 0) return resolve(0);
            reject(new Error(
                `sox exited with `
                + (signal ? `signal ${signal}`
                          : `code ${code}`),
            ));
        });
    });
}


async function run(argv) {
    const opts = parseDuckArgs(argv);
    if (opts.help) {
        process.stdout.write(HELP);
        return 0;
    }
    ensureSox();
    const validated = validate(opts);
    const soxArgs = buildSoxArgs(validated);
    await runSox(soxArgs);
    return 0;
}


export default {
    describe: "Duck a region of a music track.",
    usage:    "bhpodcast duck --input <f> --start <s> "
              + "--end <s> --output <f>",
    run,
};


// Exported for tests; not part of the CLI contract.
export const _internals = {
    parseDuckArgs, validate, buildSoxArgs,
};
