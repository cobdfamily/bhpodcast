// bhpodcast chapters -- given an .m3u playlist
// where each entry has an EXTINF title, stitch the
// parts into one content WAV AND emit chapter
// metadata in three formats so every downstream
// tool finds the shape it expects.
//
// Inputs:
//   .m3u file, e.g.
//       #EXTM3U
//       #EXTINF:-1,Welcome and housekeeping
//       intro.wav
//       #EXTINF:-1,Interview with Sam Hofstein
//       interview-pt1.wav
//       #EXTINF:-1,Music break
//       break.wav
//       #EXTINF:-1,More with Sam
//       interview-pt2.wav
//
//   Plain `# Title` comments before a filename also
//   work as a friendlier fallback for users who
//   don't know the EXTINF syntax.
//
// Outputs (next to --output):
//   <output>                 stitched WAV
//   <output>.chapters.json   Podcasting 2.0 format
//   <output>.chapters.txt    show-notes lines
//   <output>.chapters.cue    CUE sheet
//
// Chapter timestamps are RELATIVE TO THE STITCHED
// CONTENT (chapter 1 = 00:00). The `produce`
// subcommand re-shifts them by the content-pad
// (default 28s) when it assembles the final
// episode, so the listener's podcast app sees
// offsets that match what they hear.
//
// Bridge: --bridge <wav> is optional. When set,
// the bridge audio is inserted BETWEEN every pair
// of parts (not before the first or after the
// last). Its duration counts toward the next
// chapter's start offset.

import {
    existsSync, readFileSync, writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve, basename } from "node:path";
import { parseArgs } from "node:util";


const HELP = `bhpodcast chapters -- stitch + emit chapter timestamps

Usage:
  bhpodcast chapters --playlist <m3u> --output <wav> [options]

Required:
  --playlist, -p  <path>    EXTM3U playlist file
                            (parts listed with
                            #EXTINF titles).
  --output,   -o  <path>    Output stitched WAV.

Options:
  --bridge,   -b  <wav>     Insert this audio
                            between each pair of
                            parts. Counts toward
                            the next chapter's
                            offset.
  --help,     -h            Show this message.

Output files (next to <output>):
  <output>                  stitched WAV
  <output>.chapters.json    Podcasting 2.0 shape
  <output>.chapters.txt     show-notes lines
  <output>.chapters.cue     CUE sheet

EXTM3U format example:

  #EXTM3U
  #EXTINF:-1,Welcome and housekeeping
  intro.wav
  #EXTINF:-1,Interview with Sam
  interview-pt1.wav

The -1 duration is a "unknown" sentinel. Real
durations are probed from the audio files with
soxi.

Plain '# Title' comments before a filename work
too as a friendlier alternative to EXTINF.

Chapter timestamps in the output are relative to
the stitched content (chapter 1 = 00:00). When
'bhpodcast produce' is run next on this content
WAV, it shifts every offset by the content pad
(default 28s) so the listener's podcast app sees
offsets matching the final episode timeline.
`;


function parseChaptersArgs(argv) {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            options: {
                playlist: { type: "string", short: "p" },
                output:   { type: "string", short: "o" },
                bridge:   { type: "string", short: "b" },
                help:     { type: "boolean", short: "h" },
            },
            strict: true,
            allowPositionals: false,
        });
    } catch (err) {
        throw new Error(
            `${err.message}\n\nRun "bhpodcast chapters `
            + `--help" for usage.`,
        );
    }
    return parsed.values;
}


// EXTM3U parser. Walks line by line. Tracks the
// "pending title" surfaced by the most recent
// #EXTINF or `# ...` comment; the next non-comment
// line is taken as the audio file and paired with
// that title. Resets the pending title after each
// pairing. Tolerant of:
//   - Blank lines (skipped)
//   - #EXTM3U header (skipped)
//   - Other #-prefixed extension comments
//     (skipped; only #EXTINF + plain `# Title` are
//     treated as title-bearing)
//   - Relative paths (resolved against the m3u's
//     directory, the m3u convention)
//   - Absolute paths (passed through)
function parsePlaylist(m3uPath) {
    const text = readFileSync(m3uPath, "utf8");
    const baseDir = dirname(resolve(m3uPath));
    const lines = text.split(/\r?\n/);
    const parts = [];
    let pendingTitle = null;

    for (const raw of lines) {
        const line = raw.trim();
        if (line === "") continue;
        if (line === "#EXTM3U") continue;

        if (line.startsWith("#EXTINF")) {
            // #EXTINF:<duration>,<title>
            const comma = line.indexOf(",");
            if (comma > 0) {
                pendingTitle = line.slice(comma + 1).trim();
            }
            continue;
        }

        if (line.startsWith("#")) {
            // Plain `# Title` form -- treat the
            // text after the # as a title. Any
            // other extension comments we don't
            // recognise also fall here; if they
            // happen to look like titles, the
            // user gets what they asked for. We
            // strip the leading "# " and any
            // residual whitespace.
            const rest = line.replace(/^#+\s*/, "").trim();
            if (rest) pendingTitle = rest;
            continue;
        }

        // Non-comment -> this is the audio file.
        // Pair with whatever title is pending; if
        // none, fall back to the bare filename
        // (without extension) so we still get a
        // useful chapter label.
        const absPath = resolve(baseDir, line);
        const title = pendingTitle
            || basename(line).replace(/\.[^.]+$/, "");
        parts.push({ title, path: absPath });
        pendingTitle = null;
    }
    return parts;
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
                    `soxi non-numeric duration for `
                    + `${wav}: ${out.trim()}`,
                ));
            }
            ok(n);
        });
    });
}


function runSox(args) {
    return new Promise((ok, fail) => {
        const child = spawn("sox", args, {
            stdio: ["ignore", "ignore", "inherit"],
        });
        child.on("error", fail);
        child.on("close", (code, sig) => {
            if (code === 0) return ok();
            fail(new Error(
                `sox exited ${sig ? `signal ${sig}`
                                  : `code ${code}`}`,
            ));
        });
    });
}


// HH:MM:SS format for the .txt + .cue outputs.
// Podcast players that read text chapters
// recognise this shape AND the simpler MM:SS one;
// always emitting HH:MM:SS is safer for episodes
// longer than 59 minutes.
function formatTimestamp(secs) {
    const total = Math.floor(secs);
    const hh = Math.floor(total / 3600);
    const mm = Math.floor((total % 3600) / 60);
    const ss = total % 60;
    return `${String(hh).padStart(2, "0")}:`
         + `${String(mm).padStart(2, "0")}:`
         + `${String(ss).padStart(2, "0")}`;
}


// CUE sheets count in 75-frame-per-second units
// (a CD-DA artefact). MM:SS:FF with FF = 0..74.
function formatCueIndex(secs) {
    const total = secs;
    const mm = Math.floor(total / 60);
    const ss = Math.floor(total % 60);
    const ff = Math.round((total - Math.floor(total)) * 75);
    return `${String(mm).padStart(2, "0")}:`
         + `${String(ss).padStart(2, "0")}:`
         + `${String(Math.min(ff, 74)).padStart(2, "0")}`;
}


function writeChaptersJson(chapters, outPath) {
    const json = {
        version:  "1.2.0",
        chapters: chapters.map(
            (c) => ({ startTime: c.startTime, title: c.title }),
        ),
    };
    writeFileSync(outPath, JSON.stringify(json, null, 2) + "\n");
}


function writeChaptersTxt(chapters, outPath) {
    const lines = chapters.map(
        (c) => `${formatTimestamp(c.startTime)} ${c.title}`,
    );
    writeFileSync(outPath, lines.join("\n") + "\n");
}


function writeChaptersCue(chapters, outPath, audioPath) {
    // FILE name uses just the basename so the .cue
    // works when both files are kept side-by-side.
    // Quote escaping in titles: replace any
    // double-quote with a single-quote so the CUE
    // syntax stays valid (the CUE format doesn't
    // define an escape sequence).
    const file = basename(audioPath);
    const lines = [`FILE "${file}" WAVE`];
    chapters.forEach((c, i) => {
        const trackNo = String(i + 1).padStart(2, "0");
        const safeTitle = c.title.replace(/"/g, "'");
        lines.push(`  TRACK ${trackNo} AUDIO`);
        lines.push(`    TITLE "${safeTitle}"`);
        lines.push(`    INDEX 01 ${formatCueIndex(c.startTime)}`);
    });
    writeFileSync(outPath, lines.join("\n") + "\n");
}


async function run(argv) {
    const opts = parseChaptersArgs(argv);
    if (opts.help) {
        process.stdout.write(HELP);
        return 0;
    }
    if (!opts.playlist) {
        throw new Error(
            "missing --playlist\n\nRun \"bhpodcast "
            + "chapters --help\" for usage.",
        );
    }
    if (!opts.output) {
        throw new Error(
            "missing --output\n\nRun \"bhpodcast "
            + "chapters --help\" for usage.",
        );
    }
    if (!existsSync(opts.playlist)) {
        throw new Error(
            `playlist not found: ${opts.playlist}`,
        );
    }
    if (opts.bridge && !existsSync(opts.bridge)) {
        throw new Error(
            `bridge WAV not found: ${opts.bridge}`,
        );
    }

    const parts = parsePlaylist(opts.playlist);
    if (parts.length === 0) {
        throw new Error(
            `no audio entries found in `
            + `${opts.playlist}`,
        );
    }
    for (const p of parts) {
        if (!existsSync(p.path)) {
            throw new Error(
                `playlist references missing file: `
                + `${p.path}`,
            );
        }
    }

    // Probe durations + accumulate chapter offsets.
    // The bridge (if set) adds to the running
    // offset between parts but doesn't get its own
    // chapter entry -- bridges are transitions,
    // not chapters.
    let bridgeDuration = 0;
    if (opts.bridge) {
        bridgeDuration = await probeDuration(opts.bridge);
    }

    const chapters = [];
    let cursor = 0;
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const dur = await probeDuration(p.path);
        chapters.push({
            startTime: Number(cursor.toFixed(3)),
            title:     p.title,
        });
        cursor += dur;
        // Bridge between parts (not after the last).
        if (i < parts.length - 1) {
            cursor += bridgeDuration;
        }
    }

    // Stitch via a single sox invocation: feed
    // every part interleaved with the bridge (if
    // any) then the output. SoX concatenates by
    // default when given multiple inputs without
    // `-m`. Requires matching format across all
    // inputs; users with mismatched parts should
    // pre-convert OR rely on the auto-convert
    // path in `produce` (which works on the
    // single stitched output, not on individual
    // parts -- so for chapters we keep things
    // simple by requiring matching formats here).
    const soxInputs = [];
    for (let i = 0; i < parts.length; i++) {
        soxInputs.push(parts[i].path);
        if (opts.bridge && i < parts.length - 1) {
            soxInputs.push(opts.bridge);
        }
    }
    await runSox([...soxInputs, opts.output]);

    // Emit the three chapter formats. The .json
    // form is what podcast players consume; .txt
    // is for show-notes copy-paste; .cue covers
    // non-podcast players (foobar2000, Quod Libet,
    // VLC). All three carry the same timeline
    // relative to the stitched WAV.
    writeChaptersJson(chapters, opts.output + ".chapters.json");
    writeChaptersTxt(chapters,  opts.output + ".chapters.txt");
    writeChaptersCue(chapters,  opts.output + ".chapters.cue",
                                opts.output);

    process.stdout.write(
        `bhpodcast chapters: stitched `
        + `${parts.length} parts -> `
        + `${opts.output} `
        + `(${formatTimestamp(cursor)} total)\n`,
    );
    process.stdout.write(
        `bhpodcast chapters: wrote `
        + `chapters.{json,txt,cue} alongside.\n`,
    );
    return 0;
}


export default {
    describe: "Stitch an m3u playlist + emit chapters.",
    usage:    "bhpodcast chapters --playlist <m3u> "
              + "--output <wav>",
    run,
};


export const _internals = {
    parsePlaylist, formatTimestamp, formatCueIndex,
    writeChaptersJson, writeChaptersTxt, writeChaptersCue,
};
