// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/check-regexp-byte-identity.mjs — byte-identity proof for refactors of
// the standalone RegExp engine (#7369 R0).
//
// WHY THIS EXISTS
// ---------------
// The RegExp engine is hand-authored Wasm: a refactor that moves an emitter can
// reorder a type, a global or a function registration without failing a single
// test, and the drift then shows up as an unrelated verdict flip weeks later.
// The only proof that a "no behaviour change" move changed nothing is that the
// compiler emits the same bytes before and after, for every program that can
// reach the engine. This script is that proof, and it compares two source
// TREES rather than a stored baseline, so there is no artefact to go stale.
//
// WHAT IT DOES
// ------------
//   1. Finds every test262 file (`<head>/test262/test/**/*.js`, no `_FIXTURE`)
//      whose TypeScript AST contains a RegularExpressionLiteral or an identifier
//      named `RegExp` — i.e. every program that can touch the engine.
//   2. Compiles each one with `compile()` from `<tree>/src/index.ts`, for both
//      trees and for each target in {default, standalone, linear}, with
//      `{ allowJs: true, fileName: "t.js", skipSemanticDiagnostics: true }`.
//   3. Compares the sha1 of `binary`, or the error text when the compile fails.
//   4. Prints the counts and EVERY difference; exits 1 on any difference.
//
// USAGE
//   node scripts/check-regexp-byte-identity.mjs --base <tree> --head <tree> \
//        [--jobs N] [--files <list>] [--print-files]
//
//   --base / --head   two checkouts of this repo, each with `node_modules` and
//                     (for discovery, head only) `test262/test`. A base is
//                     usually `git worktree add --detach <path> origin/main`
//                     with `node_modules` symlinked in.
//   --jobs N          concurrent compiler processes (default 2).
//   --files <list>    newline-separated test262 paths (absolute, or relative to
//                     `<head>`) to use INSTEAD of discovery — for a quick
//                     partial run while iterating. A partial run proves nothing
//                     about the files it skipped, and says so.
//   --print-files     print the discovered list and exit (feed it to --files).
//
// EXIT CODES: 0 identical · 1 at least one difference · 2 usage or a compiler
// process died (nothing can be concluded).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TARGETS = ["default", "standalone", "linear"];
// A compiler process is recycled after this many files so its heap stays bounded.
const CHUNK_SIZE = 150;

function usage(message) {
  if (message) console.error(`check-regexp-byte-identity: ${message}`);
  console.error(
    "usage: node scripts/check-regexp-byte-identity.mjs --base <tree> --head <tree> [--jobs N] [--files <list>] [--print-files]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { jobs: 2 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--print-files") args.printFiles = true;
    else if (flag === "--base" || flag === "--head" || flag === "--files" || flag === "--jobs") {
      const value = argv[++i];
      if (value === undefined) usage(`${flag} needs a value`);
      args[flag.slice(2)] = value;
    } else usage(`unknown argument ${flag}`);
  }
  args.jobs = Number(args.jobs);
  if (!Number.isInteger(args.jobs) || args.jobs < 1) usage("--jobs must be a positive integer");
  if (!args.head) usage("--head is required");
  if (!args.base && !args.printFiles) usage("--base is required");
  return args;
}

// ── Worker: compile one chunk of files with one tree ────────────────────────

async function runWorker(tree, chunkPath, outPath) {
  const { compile } = await import(pathToFileURL(join(tree, "src/index.ts")).href);
  const lines = [];
  for (const { rel, path } of JSON.parse(readFileSync(chunkPath, "utf8"))) {
    const source = readFileSync(path, "utf8");
    for (const target of TARGETS) {
      const options = { allowJs: true, fileName: "t.js", skipSemanticDiagnostics: true };
      if (target !== "default") options.target = target;
      let outcome;
      try {
        const result = await compile(source, options);
        outcome =
          result.success && result.binary
            ? `ok ${createHash("sha1").update(result.binary).digest("hex")}`
            : `error ${result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join(" | ")}`;
      } catch (error) {
        outcome = `throw ${error instanceof Error ? error.message : String(error)}`;
      }
      // An error message may quote a path inside the tree; that is not a difference.
      lines.push(JSON.stringify({ rel, target, outcome: outcome.split(tree).join("<tree>") }));
    }
  }
  writeFileSync(outPath, lines.join("\n") + "\n");
}

// ── Parent: discovery, scheduling, comparison ───────────────────────────────

function walkJs(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) stack.push(path);
      else if (name.endsWith(".js") && !name.includes("_FIXTURE")) out.push(path);
    }
  }
  return out.sort();
}

async function discover(headTree) {
  const { default: ts } = await import("typescript");
  const mentionsRegExp = (node) =>
    node.kind === ts.SyntaxKind.RegularExpressionLiteral ||
    (ts.isIdentifier(node) && node.text === "RegExp") ||
    ts.forEachChild(node, mentionsRegExp) === true;
  return walkJs(join(headTree, "test262/test")).filter((path) =>
    mentionsRegExp(
      ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS),
    ),
  );
}

function runPool(tasks, jobs, self) {
  return new Promise((resolvePool, rejectPool) => {
    let next = 0;
    let running = 0;
    let done = 0;
    const launch = () => {
      if (next === tasks.length && running === 0) return resolvePool();
      while (running < jobs && next < tasks.length) {
        const task = tasks[next++];
        running++;
        const child = spawn(
          process.execPath,
          ["--import", "tsx", self, "--worker", task.tree, task.chunkPath, task.outPath],
          { stdio: ["ignore", "inherit", "inherit"] },
        );
        child.on("exit", (code) => {
          if (code !== 0) return rejectPool(new Error(`compiler process for ${task.tree} exited with ${code}`));
          running--;
          done++;
          process.stderr.write(`\r  ${done}/${tasks.length} chunks`);
          launch();
        });
      }
    };
    launch();
  });
}

function readOutcomes(tasks, tree) {
  const outcomes = new Map();
  for (const task of tasks) {
    if (task.tree !== tree) continue;
    for (const line of readFileSync(task.outPath, "utf8").split("\n")) {
      if (line === "") continue;
      const { rel, target, outcome } = JSON.parse(line);
      outcomes.set(`${target}\t${rel}`, outcome);
    }
  }
  return outcomes;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const head = resolve(args.head);
  const partial = args.files !== undefined;
  const paths = partial
    ? readFileSync(args.files, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => (isAbsolute(line) ? line : join(head, line)))
    : await discover(head);
  if (args.printFiles) {
    for (const path of paths) console.log(relative(head, path));
    return;
  }
  const base = resolve(args.base);
  const files = paths.map((path) => ({ rel: relative(head, path), path }));
  console.log(
    `check-regexp-byte-identity: ${files.length} files x ${TARGETS.length} targets` +
      (partial ? ` (PARTIAL: --files ${args.files})` : " (every RegExp-mentioning test262 file)"),
  );
  console.log(`  base ${base}\n  head ${head}`);

  const scratch = mkdtempSync(join(tmpdir(), "regexp-byte-identity-"));
  const tasks = [];
  for (const tree of [base, head]) {
    for (let start = 0; start < files.length; start += CHUNK_SIZE) {
      const id = `${tree === base ? "base" : "head"}-${start}`;
      const chunkPath = join(scratch, `${id}.chunk.json`);
      writeFileSync(chunkPath, JSON.stringify(files.slice(start, start + CHUNK_SIZE)));
      tasks.push({ tree, chunkPath, outPath: join(scratch, `${id}.jsonl`) });
    }
  }
  await runPool(tasks, args.jobs, fileURLToPath(import.meta.url));
  process.stderr.write("\n");

  const baseOutcomes = readOutcomes(tasks, base);
  const headOutcomes = readOutcomes(tasks, head);
  rmSync(scratch, { recursive: true, force: true });

  let differences = 0;
  for (const target of TARGETS) {
    let compiled = 0;
    let failed = 0;
    let differing = 0;
    for (const { rel } of files) {
      const key = `${target}\t${rel}`;
      const before = baseOutcomes.get(key);
      const after = headOutcomes.get(key);
      if (before.startsWith("ok ")) compiled++;
      else failed++;
      if (before === after) continue;
      differing++;
      console.log(`DIFF [${target}] ${rel}\n  base: ${before}\n  head: ${after}`);
    }
    console.log(`  ${target}: ${compiled} compiled + ${failed} failed on base, ${differing} differ on head`);
    differences += differing;
  }
  const comparisons = files.length * TARGETS.length;
  console.log(
    differences === 0
      ? `check-regexp-byte-identity: IDENTICAL — 0 differences over ${comparisons} comparisons`
      : `check-regexp-byte-identity: FAILED — ${differences} differences over ${comparisons} comparisons`,
  );
  process.exit(differences === 0 ? 0 : 1);
}

if (process.argv[2] === "--worker") {
  await runWorker(process.argv[3], process.argv[4], process.argv[5]);
} else {
  await main().catch((error) => {
    console.error(`check-regexp-byte-identity: ${error.message}`);
    process.exit(2);
  });
}
