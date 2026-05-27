#!/usr/bin/env node
// bhpodcast -- BlindHub podcasting helpers.
//
// Thin subcommand dispatcher over a small set of
// SoX-backed audio tools used in COBD's podcast
// assembly pipeline. Each subcommand lives in its
// own file under lib/<name>.js exporting:
//
//   export default {
//     describe: "one-line description",
//     usage:    "bhpodcast <name> [options]",
//     run(args): async-or-sync function that
//                consumes the post-subcommand
//                argv and returns an exit code,
//   };
//
// The dispatcher itself stays subcommand-agnostic;
// add new tools by dropping a file in lib/ and
// registering it in SUBCOMMANDS below.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Registry of available subcommands. Keys are the
// names users type; values are the relative path of
// the file under lib/. Keep the list short and the
// names verb-shaped so `bhpodcast <verb>` reads as
// an action.
const SUBCOMMANDS = {
    duck:     "lib/duck.js",
    produce:  "lib/produce.js",
    describe: "lib/describe.js",
    chapters: "lib/chapters.js",
};

function printRootHelp() {
    process.stdout.write([
        "bhpodcast -- BlindHub podcasting helpers",
        "",
        "Usage: bhpodcast <subcommand> [options]",
        "",
        "Subcommands:",
        ...Object.keys(SUBCOMMANDS).sort().map(
            (name) => `  ${name.padEnd(12)} run "bhpodcast ${name} --help" for details`,
        ),
        "",
    ].join("\n"));
}

async function main(argv) {
    // argv has already had `node bhpodcast.js` stripped
    // -- it's whatever the user typed AFTER the program
    // name.
    const [subname, ...rest] = argv;

    if (!subname || subname === "--help" || subname === "-h") {
        printRootHelp();
        return 0;
    }
    if (subname === "--version" || subname === "-v") {
        // Read version from the sibling package.json so
        // we don't ship two copies of the string.
        const { readFileSync } = await import("node:fs");
        const pkg = JSON.parse(readFileSync(
            join(SCRIPT_DIR, "package.json"), "utf8",
        ));
        process.stdout.write(`bhpodcast ${pkg.version}\n`);
        return 0;
    }

    const subpath = SUBCOMMANDS[subname];
    if (!subpath) {
        process.stderr.write(
            `bhpodcast: unknown subcommand '${subname}'\n`
            + "Run 'bhpodcast --help' for the list.\n",
        );
        return 2;
    }

    const subfile = join(SCRIPT_DIR, subpath);
    if (!existsSync(subfile)) {
        // Defensive: registry pointed at a missing file.
        // Shouldn't happen in a packaged install but
        // surfaces a clear error during development.
        process.stderr.write(
            `bhpodcast: internal error: ${subpath} is `
            + `registered but missing on disk.\n`,
        );
        return 70;
    }
    const mod = await import(subfile);
    return await mod.default.run(rest);
}

main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => {
        process.stderr.write(`bhpodcast: ${err.message ?? err}\n`);
        process.exit(1);
    },
);
