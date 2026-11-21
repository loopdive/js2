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
// MEMORY
//   One compiler process per job, recycled every CHUNK_SIZE files, each with a
//   WORKER_HEAP_MB heap. A process that dies anyway (a full run did hit V8's
//   default heap limit) is restarted on the files it had not finished, the
//   file it died on first and alone, so heap built up by earlier files is not
//   charged to it. A file that kills a fresh process on its own gets the
//   outcome `crash <signal|code>`, compared like any other outcome and listed
//   in the summary.
//
// USAGE
//   node scripts/check-regexp-byte-identity.mjs --base <tree> --head <tree> \
//        [--jobs N] [--files <list>] [--cache <dir>] [--print-files]
//
//   --base / --head   two checkouts of this repo, each with `node_modules` and
//                     (for discovery, head only) `test262/test`. A base is
//                     usually `git worktree add --detach <path> origin/main`
//                     with `node_modules` symlinked in.
//   --jobs N          concurrent compiler processes (default 1).
//   --files <list>    newline-separated test262 paths (absolute, or relative to
//                     `<head>`) to use INSTEAD of discovery — for a quick
//                     partial run while iterating. A partial run proves nothing
//                     about the files it skipped, and says so.
//   --cache <dir>     keep each finished chunk's outcomes in <dir>, keyed by the
//                     content of the tree's `src/` and `package.json`, the
//                     chunk's files and this script. A rerun after a head-only
//                     edit then compiles only the head; nothing stale can be
//                     served, because any edit changes the key.
//   --print-files     print the discovered list and exit (feed it to --files).
//
// EXIT CODES: 0 identical · 1 at least one difference · 2 usage, a compiler
// process could not be started, or a crash outcome (nothing can be concluded).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TARGETS = ["default", "standalone", "linear"];
// A compiler process is recycled after this many files so its heap stays bounded.
const CHUNK_SIZE = 100;
const WORKER_HEAP_MB = 3072;

function usage(message) {
  if (message) console.error(`check-regexp-byte-identity: ${message}`);
  console.error(
    "usage: node scripts/check-regexp-byte-identity.mjs --base <tree> --head <tree> [--jobs N] [--files <list>] [--cache <dir>] [--print-files]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { jobs: 1 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--print-files") args.printFiles = true;
    else if (["--base", "--head", "--files", "--jobs", "--cache"].includes(flag)) {
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

// Each file's lines are appended as soon as its three compiles finish, so a
// process that dies leaves behind exactly the files it completed.
async function runWorker(tree, chunkPath, outPath) {
  const { compile } = await import(pathToFileURL(join(tree, "src/index.ts")).href);
  for (const { rel, path } of JSON.parse(readFileSync(chunkPath, "utf8"))) {
    const source = readFileSync(path, "utf8");
    const lines = [];
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
    appendFileSync(outPath, lines.join("\n") + "\n");
  }
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

/** Resolves to how the process ended: `0`, another exit code, or the signal name. */
function runProcess(self, tree, files, chunkPath, outPath) {
  writeFileSync(chunkPath, JSON.stringify(files));
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${WORKER_HEAP_MB}`, "--import", "tsx", self, "--worker", tree, chunkPath, outPath],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => resolveRun(code ?? signal));
  });
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Compiles one chunk into `task.outPath`. When the process dies, the file it
 * was on is rerun alone in a fresh process, then the rest of the chunk; a file
 * that also kills a fresh process is recorded as `crash`.
 */
async function runChunk(task, self) {
  const partial = `${task.outPath}.partial`;
  rmSync(partial, { force: true });
  let remaining = task.files;
  let alone = false;
  while (remaining.length > 0) {
    const ended = await runProcess(self, task.tree, alone ? remaining.slice(0, 1) : remaining, task.chunkPath, partial);
    const finished = new Set(readLines(partial).map((line) => line.rel));
    remaining = remaining.filter((file) => !finished.has(file.rel));
    if (ended === 0) {
      alone = false;
    } else if (alone) {
      const { rel } = remaining[0];
      const lines = TARGETS.map((target) => JSON.stringify({ rel, target, outcome: `crash ${ended}` }));
      appendFileSync(partial, lines.join("\n") + "\n");
      remaining = remaining.slice(1);
      alone = false;
    } else {
      alone = true;
    }
  }
  renameSync(partial, task.outPath);
}

async function runPool(tasks, jobs, self) {
  const pending = tasks.filter((task) => !existsSync(task.outPath));
  let next = 0;
  let done = tasks.length - pending.length;
  process.stderr.write(`  ${done}/${tasks.length} chunks already in the cache\n`);
  const lane = async () => {
    while (next < pending.length) {
      await runChunk(pending[next++], self);
      process.stderr.write(`\r  ${++done}/${tasks.length} chunks`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, lane));
}

function readOutcomes(tasks, tree) {
  const outcomes = new Map();
  for (const task of tasks) {
    if (task.tree !== tree) continue;
    for (const { rel, target, outcome } of readLines(task.outPath)) outcomes.set(`${target}\t${rel}`, outcome);
  }
  return outcomes;
}

/** sha1 over the content of `<tree>/src` and `<tree>/package.json`: what `compile()` is built from. */
function treeFingerprint(tree) {
  const hash = createHash("sha1");
  const paths = [join(tree, "package.json")];
  const stack = [join(tree, "src")];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) stack.push(path);
      else paths.push(path);
    }
  }
  for (const path of paths.sort()) hash.update(relative(tree, path)).update("\0").update(readFileSync(path));
  return hash.digest("hex");
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

  const self = fileURLToPath(import.meta.url);
  const scratch = mkdtempSync(join(tmpdir(), "regexp-byte-identity-"));
  const outDir = args.cache === undefined ? scratch : resolve(args.cache);
  mkdirSync(outDir, { recursive: true });
  const scriptHash = createHash("sha1").update(readFileSync(self)).digest("hex");
  const tasks = [];
  for (const tree of [base, head]) {
    const fingerprint = treeFingerprint(tree);
    for (let start = 0; start < files.length; start += CHUNK_SIZE) {
      const chunk = files.slice(start, start + CHUNK_SIZE);
      const key = createHash("sha1")
        .update(JSON.stringify({ fingerprint, scriptHash, files: chunk.map((file) => file.rel) }))
        .digest("hex");
      tasks.push({
        tree,
        files: chunk,
        chunkPath: join(scratch, `${key}.chunk.json`),
        outPath: join(outDir, `${key}.jsonl`),
      });
    }
  }
  await runPool(tasks, args.jobs, self);
  process.stderr.write("\n");

  const baseOutcomes = readOutcomes(tasks, base);
  const headOutcomes = readOutcomes(tasks, head);
  rmSync(scratch, { recursive: true, force: true });
  let crashes = 0;
  for (const [label, outcomes] of [
    ["base", baseOutcomes],
    ["head", headOutcomes],
  ]) {
    for (const [key, outcome] of outcomes) {
      if (!outcome.startsWith("crash ")) continue;
      crashes++;
      console.log(`CRASH on ${label} [${key.replace("\t", "] ")}: ${outcome}`);
    }
  }

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
  if (differences > 0) {
    console.log(`check-regexp-byte-identity: FAILED — ${differences} differences over ${comparisons} comparisons`);
    process.exit(1);
  }
  // A crash on both sides compares equal but says nothing about that file's bytes.
  if (crashes > 0) {
    console.log(`check-regexp-byte-identity: INCONCLUSIVE — 0 differences, but ${crashes} crash outcomes (above)`);
    process.exit(2);
  }
  console.log(`check-regexp-byte-identity: IDENTICAL — 0 differences over ${comparisons} comparisons`);
}

if (process.argv[2] === "--worker") {
  await runWorker(process.argv[3], process.argv[4], process.argv[5]);
} else {
  await main().catch((error) => {
    console.error(`check-regexp-byte-identity: ${error.message}`);
    process.exit(2);
  });
}
