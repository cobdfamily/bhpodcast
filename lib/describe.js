// bhpodcast describe -- synthesise a short
// description WAV from text via the newsline TTS
// service. The output is sized to fit the 12s
// description slot the `produce` subcommand uses:
// the description plays from t=8s (after 8s of
// silence prefix) and must finish before the
// content's spoken portion comes in around t=28s.
// 12s gives ~8s of breathing room between the
// description and the content.
//
// The service contract:
//   GET / POST  https://newsline.apps.blindhub.ca/v1/speak?text=...
//   -> 200 audio/wav (16-bit mono 16kHz currently)
//
// The endpoint also accepts ssml=, url=, voice=,
// rate=, pitch=, engine=, source=, language=,
// offset=, part= -- only text and voice are
// surfaced here for now. Add the rest as
// dedicated flags when a workflow actually needs
// them; YAGNI for v0.2.
//
// "Must obviously fit": after fetching the audio,
// we probe its duration with soxi and reject
// anything longer than --max-duration (default
// 12s, the produce-step slot length). The CLI
// exits non-zero in that case so a pipeline
// calling `bhpodcast describe` followed by
// `bhpodcast produce` fails fast rather than
// producing an episode where the description
// bleeds into the content.

import {
    existsSync, readFileSync, writeFileSync,
    statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";


const DEFAULT_SERVICE =
    "https://newsline.apps.blindhub.ca/v1/speak";
const DEFAULT_MAX_DURATION = 12;


const HELP = `bhpodcast describe -- TTS a short description

Usage:
  bhpodcast describe --text "<words>" --output <wav>
  bhpodcast describe --text-file <path> --output <wav>

Required (one of):
  --text,        -t  <str>   The text to speak.
  --text-file,   -T  <path>  Read the text from a file.

Required:
  --output,      -o  <path>  Output WAV.

Optional:
  --voice,       -v  <name>  Voice name passed to the
                             TTS service.
  --service-url,     <url>   Override the TTS endpoint.
                             Default: ${DEFAULT_SERVICE}
  --max-duration,    <secs>  Reject the result if longer
                             than this. Default: 12s
                             (the produce subcommand's
                             description slot).
  --help,        -h          Show this message.

Notes:
  * The newsline service returns 16-bit mono 16kHz
    WAV. The 'produce' subcommand's sox -m mix
    will resample as needed; if you want 48kHz
    stereo on disk, pipe through 'sox in.wav -r
    48000 -c 2 out.wav' after.
  * Descriptions should be short. The default max
    of 12s is the produce step's description-slot
    length: the description plays from t=8s after
    the intro starts, and the content's spoken
    portion comes in around t=28s.
`;


function parseDescribeArgs(argv) {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            options: {
                text:           { type: "string", short: "t" },
                "text-file":    { type: "string", short: "T" },
                output:         { type: "string", short: "o" },
                voice:          { type: "string", short: "v" },
                "service-url":  { type: "string" },
                "max-duration": { type: "string" },
                help:           { type: "boolean", short: "h" },
            },
            strict: true,
            allowPositionals: false,
        });
    } catch (err) {
        throw new Error(
            `${err.message}\n\nRun "bhpodcast describe `
            + `--help" for usage.`,
        );
    }
    return parsed.values;
}


function resolveText(opts) {
    if (opts.text && opts["text-file"]) {
        throw new Error(
            "supply --text OR --text-file, not both",
        );
    }
    if (opts.text) return opts.text;
    if (opts["text-file"]) {
        if (!existsSync(opts["text-file"])) {
            throw new Error(
                `text file not found: ${opts["text-file"]}`,
            );
        }
        return readFileSync(opts["text-file"], "utf8")
            .trim();
    }
    throw new Error(
        "missing --text or --text-file\n\nRun "
        + `"bhpodcast describe --help" for usage.`,
    );
}


function probeDuration(wav) {
    return new Promise((ok, fail) => {
        const child = spawn("soxi", ["-D", wav], {
            stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        child.stdout.on("data", (c) => { out += c; });
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
                    `soxi non-numeric duration: ${out}`,
                ));
            }
            ok(n);
        });
    });
}


async function fetchSpeech({ text, voice, serviceUrl }) {
    // The newsline /v1/speak endpoint accepts the
    // text + voice via either query OR JSON body.
    // GET-with-query keeps the call trivially
    // cache-friendly + is what newsline's own /docs
    // examples use; descriptions are short enough
    // that URL-length isn't a concern.
    const url = new URL(serviceUrl);
    url.searchParams.set("text", text);
    if (voice) {
        url.searchParams.set("voice", voice);
    }
    let resp;
    try {
        resp = await fetch(url, {
            method: "GET",
            headers: { "Accept": "audio/wav" },
        });
    } catch (err) {
        throw new Error(
            `cannot reach TTS service at ${serviceUrl}: `
            + `${err.message}`,
        );
    }
    if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(
            `TTS service returned ${resp.status} `
            + `${resp.statusText}`
            + (detail ? `: ${detail.slice(0, 200)}`
                      : ""),
        );
    }
    const ct = resp.headers.get("content-type") || "";
    if (!ct.startsWith("audio/")) {
        const peek = await resp.text().catch(() => "");
        throw new Error(
            `TTS service returned non-audio response `
            + `(content-type: ${ct}): `
            + peek.slice(0, 200),
        );
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf;
}


async function run(argv) {
    const opts = parseDescribeArgs(argv);
    if (opts.help) {
        process.stdout.write(HELP);
        return 0;
    }
    if (!opts.output) {
        throw new Error(
            "missing --output\n\nRun \"bhpodcast "
            + "describe --help\" for usage.",
        );
    }

    const text = resolveText(opts);
    if (!text) {
        throw new Error(
            "description text is empty",
        );
    }

    const serviceUrl = opts["service-url"]
                       || DEFAULT_SERVICE;
    const maxDuration = Number(
        opts["max-duration"] ?? DEFAULT_MAX_DURATION,
    );
    if (!Number.isFinite(maxDuration) || maxDuration <= 0) {
        throw new Error(
            `--max-duration must be a positive number, `
            + `got ${opts["max-duration"]}`,
        );
    }

    const audio = await fetchSpeech({
        text,
        voice: opts.voice,
        serviceUrl,
    });
    writeFileSync(opts.output, audio);

    // Probe the produced WAV's duration. If it
    // exceeds --max-duration, leave the file on
    // disk (so the operator can listen to what
    // landed) but exit non-zero so a pipeline
    // calling produce next fails fast.
    let duration;
    try {
        duration = await probeDuration(opts.output);
    } catch (err) {
        // Probably soxi isn't installed; the audio
        // landed fine, just no duration check. Warn
        // but don't fail -- the audio is the
        // primary output.
        process.stderr.write(
            `bhpodcast describe: warning -- could `
            + `not probe duration (${err.message}); `
            + `proceeding without the fit check.\n`,
        );
        const size = statSync(opts.output).size;
        process.stdout.write(
            `bhpodcast describe: wrote `
            + `${size} bytes to ${opts.output}\n`,
        );
        return 0;
    }

    process.stdout.write(
        `bhpodcast describe: wrote `
        + `${duration.toFixed(2)}s to `
        + `${opts.output}\n`,
    );
    if (duration > maxDuration) {
        process.stderr.write(
            `bhpodcast describe: ERROR -- output is `
            + `${duration.toFixed(2)}s, which exceeds `
            + `--max-duration ${maxDuration}s. The `
            + `description won't fit in the produce `
            + `slot. Shorten the text and rerun.\n`,
        );
        return 3;
    }
    return 0;
}


export default {
    describe: "TTS a short description from text via newsline.",
    usage:    "bhpodcast describe --text \"...\" "
              + "--output <wav>",
    run,
};


export const _internals = {
    parseDescribeArgs, resolveText, fetchSpeech,
    DEFAULT_SERVICE, DEFAULT_MAX_DURATION,
};
