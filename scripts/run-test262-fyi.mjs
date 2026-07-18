#!/usr/bin/env node

/**
 * Run test262 through test262.fyi's original-harness assembler.
 *
 * Unlike tests/test262-runner.ts, this lane performs no wrapTest/buildPreamble
 * rewriting. test262-fyi/data/runner/read.js concatenates the runtime shim,
 * upstream assert.js + sta.js, metadata includes, and the raw test body.
 */
import fs from "node:fs";
import { execFileSync, fork } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { buildImports, compile } from "./compiler-bundle.mjs";
import { negativeCompileErrorMatches } from "./negative-verdict.mjs";
import { discoverTestPaths, loadOriginalHarnessTests } from "./test262-fyi-reader.mjs";

export { loadOriginalHarnessTests } from "./test262-fyi-reader.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FYI_ROOT = join(ROOT, "test262-fyi", "data");
const INTERNAL_SOURCE_WORKER = "--internal-source-worker";
const DEFAULT_SOURCE_TIMEOUT_MS = 30_000;

const SANDBOX_GLOBAL_NAMES = [
  "Array",
  "Object",
  "Function",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "Math",
  "JSON",
  "Reflect",
];

function buildFreshSandbox(consoleProxy) {
  const sandbox = Object.create(null);
  const context = createContext(sandbox);
  for (const name of SANDBOX_GLOBAL_NAMES) {
    try {
      sandbox[name] = runInContext(name, context);
    } catch {
      // Leave host features absent when the VM realm does not provide them.
    }
  }
  Object.defineProperties(sandbox, {
    undefined: { value: undefined, writable: false, enumerable: false, configurable: false },
    Infinity: { value: Number.POSITIVE_INFINITY, writable: false, enumerable: false, configurable: false },
    NaN: { value: Number.NaN, writable: false, enumerable: false, configurable: false },
  });
  sandbox.console = consoleProxy;
  sandbox.globalThis = sandbox;
  return sandbox;
}

const HOST_PROTOTYPES = [
  Object.prototype,
  Array.prototype,
  String.prototype,
  Number.prototype,
  Boolean.prototype,
  Function.prototype,
  RegExp.prototype,
  Map.prototype,
  Set.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
  Promise.prototype,
];

const HOST_PROTOTYPE_SNAPSHOTS = HOST_PROTOTYPES.map((prototype) => {
  const descriptors = new Map();
  for (const key of Reflect.ownKeys(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor) descriptors.set(key, descriptor);
  }
  return { prototype, descriptors };
});

function restoreHostPrototypes() {
  let clean = true;
  for (const { prototype, descriptors } of HOST_PROTOTYPE_SNAPSHOTS) {
    for (const key of Reflect.ownKeys(prototype)) {
      if (descriptors.has(key)) continue;
      try {
        delete prototype[key];
      } catch {
        // The caller reports an unrecoverable, non-configurable mutation.
      }
      if (Object.getOwnPropertyDescriptor(prototype, key)) clean = false;
    }
    for (const [key, descriptor] of descriptors) {
      const current = Object.getOwnPropertyDescriptor(prototype, key);
      const unchanged =
        current &&
        current.configurable === descriptor.configurable &&
        current.enumerable === descriptor.enumerable &&
        ("value" in descriptor
          ? "value" in current && current.value === descriptor.value && current.writable === descriptor.writable
          : current.get === descriptor.get && current.set === descriptor.set);
      if (unchanged) continue;
      try {
        Object.defineProperty(prototype, key, descriptor);
      } catch {
        clean = false;
      }
    }
  }
  return clean;
}

function usage() {
  console.log(`Usage: pnpm run test:262:fyi -- [options]

Runs test262 with the literal test262.fyi harness assembly. The optional
test262-fyi/data submodule must be initialized first.

Options:
  --filter <text>       Run paths containing text (repeatable)
  --limit <n>           Stop after n selected test records
  --target <target>     gc (default), standalone, or wasi
  --json <path>         Write the complete result document to path
  --list                List selected files without compiling
  --help                Show this help

Examples:
  git submodule update --init --checkout test262-fyi/data
  pnpm run test:262:fyi -- --filter built-ins/Array --limit 20
`);
}

export function parseArgs(argv) {
  const options = { filters: [], limit: Infinity, target: "gc", json: undefined, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--filter") {
      const value = argv[++i];
      if (!value) throw new Error("--filter requires a value");
      options.filters.push(value);
      continue;
    }
    if (arg === "--limit") {
      const value = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(value) || value < 1) throw new Error("--limit must be a positive integer");
      options.limit = value;
      continue;
    }
    if (arg === "--target") {
      const value = argv[++i];
      if (value !== "gc" && value !== "standalone" && value !== "wasi") {
        throw new Error("--target must be gc, standalone, or wasi");
      }
      options.target = value;
      continue;
    }
    if (arg === "--json") {
      const value = argv[++i];
      if (!value) throw new Error("--json requires a path");
      options.json = resolve(value);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function compileErrorText(result) {
  return result.errors?.map((error) => error.message ?? String(error)).join("; ") || "compile failed";
}

function thrownText(error, instance) {
  if (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.Exception && instance) {
    try {
      const tag = instance.exports.__exn_tag ?? instance.exports.__tag;
      const payload = tag ? error.getArg(tag, 0) : undefined;
      if (payload instanceof Error) return `${payload.name}: ${payload.message}`;
      if (payload !== undefined && payload !== null) return String(payload);
    } catch {
      // Fall through to the generic representation.
    }
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return String(error);
  } catch {
    return "unprintable exception";
  }
}

async function runSourceInCurrentRealm(test, source, target) {
  return (async () => {
    const output = [];
    const appendOutput = (line) => {
      Reflect.defineProperty(output, output.length, {
        value: line,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    };
    const consoleProxy = {
      log: (...values) => appendOutput(values.map(String).join(" ")),
      error: (...values) => appendOutput(values.map(String).join(" ")),
      warn: (...values) => appendOutput(values.map(String).join(" ")),
    };

    let result;
    let instance;
    try {
      result = await compile(source, {
        allowJs: true,
        fileName: test.file,
        skipSemanticDiagnostics: true,
        // The original harness remains literal and unwrapped, but the JS-host
        // lane must not execute its top-level assert.* property installation in
        // Wasm start before setExports can wire closure dispatch (#3362/#3284).
        ...(target === "gc" ? { deferTopLevelInit: true } : { target }),
      });
    } catch (error) {
      const detail = thrownText(error);
      const compileNegative = test.negative === true || (Boolean(test.negative) && test.negative?.phase !== "runtime");
      return {
        pass:
          compileNegative &&
          negativeCompileErrorMatches(test.negative === true ? undefined : test.negative?.type, [], detail),
        phase: "compile",
        detail,
        output,
      };
    }

    if (!result.success) {
      const detail = compileErrorText(result);
      const expected = test.negative === true ? undefined : test.negative?.type;
      const syntaxPhase =
        test.negative !== true &&
        (test.negative?.phase === "parse" || test.negative?.phase === "early" || test.negative?.phase === "resolution");
      const pass =
        Boolean(test.negative) &&
        test.negative.phase !== "runtime" &&
        (!expected || detail.includes(expected) || (expected === "SyntaxError" && syntaxPhase));
      return { pass, phase: "compile", detail, output };
    }

    try {
      // The literal harness can mutate intrinsic prototypes. Resolve declared
      // globals against a fresh VM realm per source run so one Test262 record
      // cannot poison Node or the next record (#1310 parity with the project
      // runner). This is host isolation only; the assembled test source remains
      // byte-for-byte unchanged.
      const globalSandbox = buildFreshSandbox(consoleProxy);
      const imports = buildImports(result.imports, { console: consoleProxy }, result.stringPool, { globalSandbox });
      ({ instance } = await WebAssembly.instantiate(result.binary, imports));
      imports.setExports?.(instance.exports);
      const moduleInit = instance.exports.__module_init;
      if (typeof moduleInit === "function") moduleInit();

      // Promise reactions used by doneprintHandle.js may settle immediately
      // after instantiate. Two turns cover the microtask plus its completion log.
      if (test.flags.async) {
        const deadline = Date.now() + 1_000;
        while (Date.now() < deadline && !output.some((line) => line.includes("Test262:AsyncTestComplete"))) {
          await new Promise((resolveTurn) => setTimeout(resolveTurn, 10));
        }
      }

      if (test.negative) {
        return { pass: false, phase: "runtime", detail: "expected an exception", output };
      }
      if (test.flags.async && !output.some((line) => line.includes("Test262:AsyncTestComplete"))) {
        return { pass: false, phase: "runtime", detail: "async completion marker not observed", output };
      }
      return { pass: true, phase: "runtime", output };
    } catch (error) {
      const detail = thrownText(error, instance);
      if (!test.negative) return { pass: false, phase: "runtime", detail, output };
      if (test.negative !== true && test.negative.phase !== "runtime") {
        return { pass: false, phase: "runtime", detail, output };
      }
      const expected = test.negative === true ? undefined : test.negative.type;
      return { pass: !expected || detail.includes(expected), phase: "runtime", detail, output };
    }
  })();
}

export class HostRealmContaminationError extends Error {
  constructor(file, result) {
    super(`test ${file} left a non-configurable mutation on a host intrinsic prototype`);
    this.name = "HostRealmContaminationError";
    this.result = result;
  }
}

async function runSourceWithRealmStatus(test, source, target) {
  restoreHostPrototypes();
  let result;
  let contaminated = false;
  try {
    result = await runSourceInCurrentRealm(test, source, target);
  } finally {
    contaminated = !restoreHostPrototypes();
  }
  return { result, contaminated };
}

async function runSource(test, source, target) {
  const { result, contaminated } = await runSourceWithRealmStatus(test, source, target);
  if (contaminated) throw new HostRealmContaminationError(test.file, result);
  return result;
}

export async function runTest(test, target) {
  const sloppy = await runSource(test, test.contents, target);
  if (!sloppy.pass || !test.strictRerun) return sloppy;
  const strict = await runSource(test, `"use strict";\n${test.contents}`, target);
  return strict.pass ? sloppy : { ...strict, detail: `strict rerun: ${strict.detail ?? "failed"}` };
}

function withoutInternalWorkerFlag(argv) {
  return argv.filter((arg) => arg !== INTERNAL_SOURCE_WORKER);
}

function sourceTimeoutMs() {
  const configured = Number.parseInt(process.env.TEST262_FYI_SOURCE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SOURCE_TIMEOUT_MS;
}

function installInternalSourceWorker(selected, target) {
  process.on("disconnect", () => process.exit(0));
  process.on("message", async (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "shutdown") {
      process.exit(0);
    }
    if (message.type !== "run-source") return;

    const test = selected[message.index];
    if (!test) {
      process.send?.({ type: "fatal", requestId: message.requestId, detail: `unknown test index ${message.index}` });
      return;
    }

    try {
      const source = message.strict ? `"use strict";\n${test.contents}` : test.contents;
      const { result, contaminated } = await runSourceWithRealmStatus(test, source, target);
      process.send?.({ type: "source-result", requestId: message.requestId, result, contaminated }, () => {
        // This process owns the contaminated realm. Exiting after the result
        // is delivered lets the coordinator continue in a fresh realm.
        if (contaminated) process.exit(86);
      });
    } catch (error) {
      process.send?.({
        type: "fatal",
        requestId: message.requestId,
        detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  });
  process.send?.({ type: "ready" });
}

function spawnSourceWorker(argv) {
  return new Promise((resolveWorker, rejectWorker) => {
    const child = fork(fileURLToPath(import.meta.url), [...withoutInternalWorkerFlag(argv), INTERNAL_SOURCE_WORKER], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const onMessage = (message) => {
      if (message?.type !== "ready") return;
      cleanup();
      resolveWorker(child);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectWorker(new Error(`FYI source worker exited before ready (code ${code}, signal ${signal ?? "none"})`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

let nextRequestId = 1;

function requestSource(child, index, strict, timeoutMs) {
  return new Promise((resolveResult, rejectResult) => {
    const requestId = nextRequestId++;
    let timer;
    const onMessage = (message) => {
      if (message?.requestId !== requestId) return;
      if (message.type === "source-result") {
        cleanup();
        resolveResult(message);
      } else if (message.type === "fatal") {
        cleanup();
        rejectResult(new Error(message.detail));
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectResult(
        new Error(`FYI source worker exited during test ${index} (code ${code}, signal ${signal ?? "none"})`),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
    timer = setTimeout(() => {
      cleanup();
      child.kill("SIGKILL");
      resolveResult({
        type: "source-result",
        requestId,
        contaminated: false,
        recycleWorker: true,
        result: {
          pass: false,
          phase: "timeout",
          detail: `source timeout after ${timeoutMs}ms`,
          output: [],
        },
      });
    }, timeoutMs);
    child.send({ type: "run-source", requestId, index, strict });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once("exit", resolveExit));
}

async function stopSourceWorker(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.send({ type: "shutdown" });
  await waitForExit(child);
}

async function runSupervisedTests(selected, target, argv) {
  const results = [];
  const timeoutMs = sourceTimeoutMs();
  let child;

  const runVariant = async (index, strict) => {
    if (!child) child = await spawnSourceWorker(argv);
    const response = await requestSource(child, index, strict, timeoutMs);
    if (response.contaminated || response.recycleWorker) {
      await waitForExit(child);
      child = undefined;
    }
    return response.result;
  };

  try {
    for (let index = 0; index < selected.length; index++) {
      const test = selected[index];
      const sloppy = await runVariant(index, false);
      let result = sloppy;
      if (sloppy.pass && test.strictRerun) {
        const strict = await runVariant(index, true);
        if (!strict.pass) result = { ...strict, detail: `strict rerun: ${strict.detail ?? "failed"}` };
      }
      results.push({ file: test.file, ...result });
      const label = result.pass ? "PASS" : "FAIL";
      console.log(
        `[${index + 1}/${selected.length}] ${label} ${test.file}${result.detail ? ` — ${result.detail}` : ""}`,
      );
    }
  } finally {
    await stopSourceWorker(child);
  }

  return results;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const internalWorker = rawArgs.includes(INTERNAL_SOURCE_WORKER);
  const options = parseArgs(withoutInternalWorkerFlag(rawArgs));
  if (options.help) {
    usage();
    return;
  }

  const allPaths = discoverTestPaths();
  const selectedPaths = allPaths
    .filter((path) => options.filters.every((filter) => path.includes(filter)))
    .slice(0, options.limit);

  if (options.list) {
    for (const path of selectedPaths) console.log(path);
    console.log(`Selected ${selectedPaths.length} of ${allPaths.length} test records.`);
    return;
  }

  const selected = selectedPaths.length > 0 ? await loadOriginalHarnessTests(selectedPaths) : [];
  selected.sort((a, b) => a.file.localeCompare(b.file));

  if (internalWorker) {
    installInternalSourceWorker(selected, options.target);
    return;
  }

  const results = await runSupervisedTests(selected, options.target, rawArgs);
  const passed = results.filter((result) => result.pass).length;

  const document = {
    runner: "test262-fyi-original-harness",
    target: options.target,
    test262FyiRevision: execFileSync("git", ["-C", FYI_ROOT, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    total: selected.length,
    passed,
    failed: selected.length - passed,
    results,
  };
  if (options.json) {
    fs.mkdirSync(dirname(options.json), { recursive: true });
    fs.writeFileSync(options.json, `${JSON.stringify(document, null, 2)}\n`);
  }
  console.log(`Original harness: ${passed}/${selected.length} passed (${options.target})`);
  if (passed !== selected.length) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
