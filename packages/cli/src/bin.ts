#!/usr/bin/env node
import { cac } from "cac";

import { knownBackends } from "./backends.js";
import { runBuildCommand, type BuildFlags } from "./command.js";
import { writeFiles } from "./write.js";

const cli = cac("styx");

cli
  .command("build [input]", "Compile a descriptor or catalog into target-language wrappers")
  .option("-o, --out <dir>", "Output directory")
  .option("--catalog <dir>", "Walk a niwrap-style catalog (project/package/version/app layers)")
  .option(
    "-b, --backend <name>",
    `Backend to emit (repeatable, or comma-separated). Known: ${knownBackends.join(", ")}`,
    { default: "python" },
  )
  .option(
    "-m, --mode <mode>",
    "Which emit tiers run: scripts (app only) | single (+ package) | multi (+ project)",
    { default: "scripts" },
  )
  .action((input: string | undefined, flags: BuildFlags) => {
    const result = runBuildCommand(input, flags);
    for (const line of result.stderr) console.error(line);
    // Write whatever compiled - a catalog build returns partial output alongside
    // a non-zero exit code, and fail-hard paths return an empty file list.
    writeFiles(result.files);
    for (const line of result.stdout) console.log(line);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  });

cli.help();
cli.version("0.0.1");

cli.parse();
