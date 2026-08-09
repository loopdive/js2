#!/usr/bin/env node

// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// One-shot Test262 engine CLI for external runners such as test262.fyi.
// The caller owns source assembly and verdict classification. js2 owns one
// isolated compile+execute attempt and communicates success through the normal
// process exit/stdout/stderr contract used by every test262.fyi engine.
import fs from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverFixtureGraph } from "./test262-fixture-graph.mjs";
import { FyiSourceExecutor, runTest } from "./run-test262-fyi.mjs";
import { enforceTest262FyiRuntime } from "./test262-fyi-runtime.mjs";

// (#3599) Re-exported so external integrations that run many files in one
// long-lived process (see `executeTestFile`'s `executor` param below) can
// construct and reuse a `FyiSourceExecutor` themselves, instead of paying a
// fresh Node start + full compiler-module load on every single-file
// invocation of this CLI. Both are otherwise internal to this module.
export { FyiSourceExecutor, runTest };

const SUPPORTED_TARGETS = new Set(["gc", "standalone"]);

function usage() {
  return `Usage: js2-test262 [options] <assembled-test-file>

Run one source file through js2's original-harness Test262 executor.

Options:
  --target <target>          gc or standalone
  --test262-root <path>      Test262 checkout containing test/ and harness/
  --engine-suffix <suffix>  Temporary filename suffix added by the caller
  --module                   Compile the input as a module
  --check-runtime            Verify the authoritative Node/Unicode contract
  -h, --help                 Show this help`;
}

export function parseArgs(argv) {
  const options = {
    target: undefined,
    test262Root: undefined,
    engineSuffix: undefined,
    module: false,
    inputPath: undefined,
    checkRuntime: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--module") {
      options.module = true;
    } else if (arg === "--check-runtime") {
      options.checkRuntime = true;
    } else if (arg === "--target") {
      options.target = argv[++index];
    } else if (arg === "--test262-root") {
      options.test262Root = argv[++index];
    } else if (arg === "--engine-suffix") {
      options.engineSuffix = argv[++index];
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (options.inputPath) {
      throw new Error(`unexpected positional argument: ${arg}`);
    } else {
      options.inputPath = arg;
    }
  }

  if (options.help || options.checkRuntime) return options;
  if (!SUPPORTED_TARGETS.has(options.target)) {
    throw new Error("--target must be gc or standalone");
  }
  if (!options.test262Root) throw new Error("--test262-root is required");
  if (!options.inputPath) throw new Error("an assembled test file is required");
  return options;
}

export function testPathForInput(inputPath, test262Root, engineSuffix) {
  const testRoot = resolve(test262Root, "test");
  const absoluteInput = resolve(inputPath);
  if (absoluteInput !== testRoot && !absoluteInput.startsWith(`${testRoot}${sep}`)) {
    throw new Error(`assembled test is outside the Test262 test root: ${absoluteInput}`);
  }

  let testPath = relative(testRoot, absoluteInput).replaceAll("\\", "/");
  if (engineSuffix) {
    const suffix = engineSuffix.startsWith(".") ? engineSuffix : `.${engineSuffix}`;
    if (!testPath.endsWith(suffix)) {
      throw new Error(`assembled test does not end in the expected ${suffix} suffix: ${testPath}`);
    }
    testPath = testPath.slice(0, -suffix.length);
  }
  return testPath;
}

export function parseTest262Flags(source) {
  const flags = new Set();
  const inline = source.match(/^flags:\s*\[([^\]]*)\]\s*$/m)?.[1];
  if (inline !== undefined) {
    for (const value of inline.split(",")) {
      const flag = value.trim();
      if (flag) flags.add(flag);
    }
  }

  const block = source.match(/^flags:\s*\n((?:\s+-\s+[^\n]+\n?)+)/m)?.[1];
  if (block) {
    for (const match of block.matchAll(/^\s+-\s+([^\s#]+).*$/gm)) flags.add(match[1]);
  }
  return flags;
}

export function parseTest262Negative(source, flags = parseTest262Flags(source)) {
  const block = source.match(/^negative:\s*\n\s*phase:\s*([^\s#]+).*\n\s*type:\s*([^\s#]+).*$/m);
  if (block) return { phase: block[1], type: block[2] };
  return flags.has("negative") ? true : undefined;
}

// (#3599) `executor` lets a caller that runs many files in the same process —
// e.g. a persistent server wrapping this one-shot function — supply an
// already-running `FyiSourceExecutor` and reuse its warm compiler/worker
// across calls instead of paying a fresh Node start + full module load per
// file. Omitting it preserves the original one-shot behavior exactly: a
// fresh executor is created and torn down before returning, matching every
// existing caller (the `main()` CLI entry point below, and any external
// integration written against the prior signature).
export async function executeTestFile({ target, test262Root, inputPath, engineSuffix, module = false, executor }) {
  const source = fs.readFileSync(resolve(inputPath), "utf8");
  const flags = parseTest262Flags(source);
  const testPath = testPathForInput(inputPath, test262Root, engineSuffix);
  const graph = discoverFixtureGraph(testPath, source, { test262Root });
  const asyncTest = flags.has("async");
  const negative = parseTest262Negative(source, flags);
  // FyiSourceExecutor resolves its own worker path (bundled dist/ layout or
  // unbundled scripts/ layout) — see run-test262-fyi.mjs's resolveWorkerPath.
  const ownExecutor = executor ?? new FyiSourceExecutor();

  try {
    const result = await runTest(
      {
        file: testPath,
        contents: source,
        flags: { module: module || flags.has("module"), async: asyncTest },
        // Preserve js2's phase/type checks, then encode the verdict through the
        // same process result contract test262.fyi uses for every other engine.
        negative,
        strictRerun: false,
        ...graph,
      },
      target,
      ownExecutor,
    );
    return { ...result, asyncTest, negative };
  } finally {
    if (!executor) ownExecutor.shutdown();
  }
}

export function processOutcome(result) {
  if (result.negative) {
    if (!result.pass) {
      // test262.fyi scores a negative as failed when the engine exits cleanly.
      // Do not leak an unrelated compiler/runtime diagnostic that its legacy
      // keyword heuristic could mistake for the requested error.
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const type = result.negative === true ? "Error" : result.negative.type;
    const phase = result.negative === true ? "negative" : `${result.negative.phase} negative`;
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${type}: expected ${phase} observed\n`,
    };
  }
  if (result.pass) {
    return {
      exitCode: 0,
      stdout: result.asyncTest ? "Test262:AsyncTestComplete\n" : "",
      stderr: "",
    };
  }
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${result.detail ?? "js2 Test262 execution failed"}\n`,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.checkRuntime) {
    const contract = enforceTest262FyiRuntime();
    console.log(
      `Test262 FYI runtime ready: ${contract.actual.version} / Unicode ${contract.actual.unicode} (${contract.id})`,
    );
    return 0;
  }
  const outcome = processOutcome(await executeTestFile(options));
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  return outcome.exitCode;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
const invokedDirectly =
  invokedPath && fs.existsSync(invokedPath) && fs.realpathSync(invokedPath) === fs.realpathSync(modulePath);
if (invokedDirectly || (invokedPath && import.meta.url === pathToFileURL(invokedPath).href)) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
