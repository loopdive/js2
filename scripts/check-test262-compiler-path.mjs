#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireTest262CompilerPath, test262CompilerPathStatus } from "./test262-compiler-path.mjs";

const args = process.argv.slice(2);
let requested = process.env.TEST262_COMPILER_PATH;
let statusPath;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--compiler-path") {
    requested = args[++index];
    if (!requested) throw new Error("--compiler-path requires legacy or ir");
  } else if (args[index] === "--status") {
    statusPath = args[++index];
    if (!statusPath) throw new Error("--status requires a path");
  } else throw new Error(`Unknown compiler path option: ${args[index]}`);
}
try {
  const status = test262CompilerPathStatus(requested);
  if (status.state === "unavailable" && statusPath) {
    mkdirSync(dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  }
  requireTest262CompilerPath(requested);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
