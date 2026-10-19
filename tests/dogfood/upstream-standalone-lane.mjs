// (#7013) Standalone lane for the npm upstream unit suites.
//
// Every upstream suite measures its package in the JS-host lane by default
// (`target: "gc"`, a host import object, `wrapExports`). Setting
// `JS2WASM_UPSTREAM_TARGET=standalone` runs the SAME generated test modules with
// `target: "standalone"` instead: pure WasmGC, instantiated with an EMPTY import
// object.
//
// Boundary decision (see plan/issues/7013-standalone-upstream-unit-lane.md):
//
// - The assertion harness (expect / assert / QUnit / vi / jest shims) is plain
//   JavaScript that is ALREADY concatenated into each generated test module, so
//   it is compiled into the standalone binary with the package and the test
//   bodies. Nothing about assertions crosses the boundary.
// - The only host<->Wasm contact is a tiny, explicit, test-only set of NUMERIC
//   exports appended by `standaloneHarnessExports` below: count, start(i),
//   outcome(), and a select-text / char-code reader pair for test names and failure
//   messages. WasmGC strings, arrays and promises are opaque to the host, so
//   reading them one UTF-16 code unit at a time is the narrowest seam that
//   keeps the report's names and error texts.
// - Async tests settle through the module's own native Promise job queue: the
//   host calls the compiler-emitted `__drain_microtasks` export, which runs the
//   Wasm-owned jobs. There is no host event loop behind a standalone module, so
//   a test that waits on a real timer or host I/O stays pending and is
//   reported as such — that is a genuine standalone gap, not harness noise.
// - The compiled package code gets NO host imports. A binary that still
//   declares any import is recorded as a `host-import` compile failure with the
//   import names, never instantiated with stubs.

import { realpathSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { renderHarnessThrownText } from "../../scripts/lib/wasm-exn-render.mjs";

export const UPSTREAM_TARGET_ENV = "JS2WASM_UPSTREAM_TARGET";

/** `"standalone"` when the opt-in lane is selected, `"gc"` (JS host) otherwise. */
export function upstreamTarget(env = process.env) {
  const value = String(env[UPSTREAM_TARGET_ENV] ?? "").trim();
  if (value === "" || value === "gc" || value === "js-host") return "gc";
  if (value === "standalone") return "standalone";
  throw new Error(`${UPSTREAM_TARGET_ENV} must be "standalone", "gc" or unset; got ${JSON.stringify(value)}`);
}

export function isStandaloneUpstreamLane(env = process.env) {
  return upstreamTarget(env) === "standalone";
}

/**
 * Compiler options that select the standalone lane. Spread AFTER a lane's own
 * options so a package adapter cannot silently change the deployment tier.
 * `runtimeEvalProvider: false` matches the npm-compat standalone perf lanes: a
 * zero-import module has no host eval provider to call.
 */
export const STANDALONE_COMPILE_OVERRIDES = Object.freeze({ target: "standalone", runtimeEvalProvider: false });

/**
 * Source for the numeric standalone test boundary.
 *
 * Parameter types decide the Wasm signature of each export, so they are
 * load-bearing: an untyped `index` would be an `externref` the host cannot
 * fill with a number in a zero-import module. TypeScript modules get type
 * annotations; a plain-JavaScript module (`language: "js"`, e.g. React's
 * `react.<build>.js` unit) gets the same types as JSDoc.
 *
 * @param {object} spec
 * @param {string} spec.count  expression: number of registered tests
 * @param {string} spec.run    expression using `index`: runs one test and
 *                             returns 1 (pass) / other (fail), or a promise of it
 * @param {string} spec.name   expression using `index`: the test's name
 * @param {string} spec.error  expression using `index`: the harness-recorded
 *                             failure text (may be undefined/empty)
 * @param {{ language?: "ts" | "js" }} [options]
 */
export function standaloneHarnessExports({ count, run, name, error }, { language = "ts" } = {}) {
  const ts = language === "ts";
  const t = (annotation) => (ts ? annotation : "");
  const doc = (jsdoc) => (ts ? "" : `/** ${jsdoc} */\n`);
  return `
// ---- (#7013) standalone numeric test boundary (test-only) ----
let __standaloneOutcome = 0;
let __standaloneThrown = "";
${doc("@param {any} value @returns {string}")}function __standaloneText(value${t(": any")})${t(": string")} {
  if (value === undefined || value === null) return "";
  return value && value.message !== undefined ? String(value.message) : String(value);
}
${doc("@param {any} value")}function __standaloneSettle(value${t(": any")})${t(": void")} {
  __standaloneOutcome = value === 1 ? 1 : 0;
}
${doc("@param {any} reason")}function __standaloneReject(reason${t(": any")})${t(": void")} {
  __standaloneOutcome = 0;
  __standaloneThrown = __standaloneText(reason);
}
${doc("@returns {number}")}export function upstreamStandaloneCount()${t(": number")} { return ${count}; }
${doc("@param {number} index @returns {number}")}export function upstreamStandaloneStart(index${t(": number")})${t(": number")} {
  __standaloneOutcome = 2;
  __standaloneThrown = "";
  let result${t(": any")};
  try {
    result = ${run};
  } catch (thrown) {
    __standaloneReject(thrown);
    return __standaloneOutcome;
  }
  if (result && typeof result.then === "function") {
    result.then(__standaloneSettle, __standaloneReject);
  } else {
    __standaloneSettle(result);
  }
  return __standaloneOutcome;
}
${doc("@returns {number}")}export function upstreamStandaloneOutcome()${t(": number")} { return __standaloneOutcome; }
// Selecting a text materializes it once; the host then reads it one code
// unit at a time from the cached copy (re-deriving it per code unit made a
// 63k-test file quadratic in its failure-message length).
let __standaloneSelected = "";
${doc("@param {number} kind @param {number} index @returns {number}")}export function upstreamStandaloneSelectText(kind${t(": number")}, index${t(": number")})${t(": number")} {
  if (kind === 0) __standaloneSelected = __standaloneText(${name});
  else if (kind === 1) __standaloneSelected = __standaloneText(${error});
  else __standaloneSelected = __standaloneThrown;
  return __standaloneSelected.length;
}
${doc("@param {number} at @returns {number}")}export function upstreamStandaloneTextCharCode(at${t(": number")})${t(": number")} {
  return __standaloneSelected.charCodeAt(at);
}
`;
}

/** The boundary over the shared shim's registry (`UPSTREAM_TEST_SHIM` + `UPSTREAM_TEST_EXPORTS`). */
export const UPSTREAM_TEST_STANDALONE_EXPORTS = standaloneHarnessExports({
  count: "__upstreamTests.length",
  run: "runUpstreamTest(index)",
  name: "__upstreamTests[index].name",
  error: "__upstreamErrors[index]",
});

const NODE_ASSERT_SHIM = fileURLToPath(new URL("./standalone-node-assert.js", import.meta.url));
const NODE_ASSERT_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])(?:node:)?assert(?:\/strict)?\2/g;

/**
 * The generated TEST module as the standalone lane compiles it: Node's
 * `assert` (an assertion harness, like expect/QUnit) resolves to the
 * compiled-in `standalone-node-assert.js`, and the numeric boundary is
 * appended. Only this test module is rewritten — package sources are not.
 */
export function standaloneTestModuleSource(source, generatedPath) {
  if (!source.includes("export async function runUpstreamTest(")) {
    throw new Error("standalone upstream lane needs a module built on UPSTREAM_TEST_EXPORTS (runUpstreamTest)");
  }
  // Real paths on both ends: a generated module under a symlinked temp root
  // (macOS `/var` → `/private/var`) is resolved from its canonical directory.
  let shim = relative(realpathSync(dirname(generatedPath)), realpathSync(NODE_ASSERT_SHIM)).replace(/\\/g, "/");
  if (!shim.startsWith(".")) shim = `./${shim}`;
  const rewritten = source.replace(NODE_ASSERT_IMPORT, (_match, head, quote) => `${head}${quote}${shim}${quote}`);
  return `${rewritten}\n${UPSTREAM_TEST_STANDALONE_EXPORTS}`;
}

const TEXT_NAME = 0;
const TEXT_ERROR = 1;
const TEXT_REJECTION = 2;
const MAX_TEXT = 4000;
const MAX_DRAIN_ROUNDS = 10_000;
const STANDALONE_INIT_TIMEOUT_MS = 120_000;

function readText(exports, kind, index) {
  try {
    const length = Number(exports.upstreamStandaloneSelectText(kind, index));
    if (!(length > 0)) return "";
    let text = "";
    for (let at = 0; at < Math.min(length, MAX_TEXT); at++) {
      text += String.fromCharCode(exports.upstreamStandaloneTextCharCode(at));
    }
    return length > MAX_TEXT ? `${text}…` : text;
  } catch {
    return "";
  }
}

/**
 * The innermost Wasm frames of an engine trap (`illegal cast`, `unreachable`,
 * …), so a failure cluster names the compiled function it came from. Empty for
 * a thrown JS value, which carries its own message.
 */
function trapFrames(thrown) {
  if (!(thrown instanceof WebAssembly.RuntimeError)) return "";
  const frames = String(thrown.stack ?? "")
    .split("\n")
    .map((line) => line.match(/at (\S+) \(wasm:\/\/wasm\//)?.[1])
    .filter(Boolean)
    .slice(0, 3);
  return frames.length > 0 ? ` @ ${frames.join(" < ")}` : "";
}

/**
 * Host imports a standalone module retained, as `module.name:kind`.
 *
 * A package-linked project (`packageLinking`, the npm provider cache) is
 * several Wasm modules: the consumer imports each provider's exports under the
 * provider's `js2wasm:npm:*` namespace, and every module shares one exception
 * tag (`env.__exn`). Those are Wasm-to-Wasm links supplied by the linker, not
 * host capabilities, so they are not counted. Anything else is.
 */
function standaloneHostImports(module, linkNamespaces) {
  return WebAssembly.Module.imports(module)
    .filter(
      ({ module: ns, name, kind }) => !linkNamespaces.has(ns) && !(ns === "env" && name === "__exn" && kind === "tag"),
    )
    .map(({ module: ns, name, kind }) => `${ns}.${name}:${kind}`);
}

export class StandaloneHostImportError extends Error {
  constructor(imports) {
    super(
      `standalone binary retained ${imports.length} host import(s): ${imports.slice(0, 8).join(", ")}` +
        (imports.length > 8 ? ", …" : ""),
    );
    this.name = "StandaloneHostImportError";
    this.imports = imports;
  }
}

/**
 * Validate and instantiate a standalone compile result with an EMPTY host
 * import object. Throws `StandaloneHostImportError` when the consumer or any
 * linked provider declares a host import.
 */
export async function instantiateStandaloneResult(result) {
  const providers = result.linkedModules ?? [];
  const linkNamespaces = new Set(providers.map((provider) => provider.namespace));
  const hostImports = [];
  for (const binary of [result.binary, ...providers.map((provider) => provider.binary)]) {
    hostImports.push(...standaloneHostImports(await WebAssembly.compile(binary), linkNamespaces));
  }
  if (hostImports.length > 0) throw new StandaloneHostImportError([...new Set(hostImports)]);
  if (providers.length > 0) {
    // Loaded lazily: the JS-host runner imports this module without the compiler.
    const { instantiateLinkedProject } = await import("../../src/index.ts");
    return (await instantiateLinkedProject(result, {})).instance;
  }
  return (await WebAssembly.instantiate(result.binary, {})).instance;
}

/** Run every queued native Promise job; `false` when the queue never went quiet. */
export function drainStandaloneMicrotasks(exports) {
  const drain = exports.__drain_microtasks;
  if (typeof drain !== "function") return true;
  const pending = exports.__microtasks_pending;
  for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
    drain();
    if (typeof pending !== "function" || Number(pending()) === 0) return true;
  }
  return false;
}

/** Run one registered test through the numeric boundary. */
function runStandaloneTest(instance, index, onStart) {
  const exports = instance.exports;
  const name = readText(exports, TEXT_NAME, index);
  onStart?.(index, name);
  let outcome;
  let error = "";
  try {
    outcome = Number(exports.upstreamStandaloneStart(index));
    if (outcome === 2) {
      const quiet = drainStandaloneMicrotasks(exports);
      outcome = Number(exports.upstreamStandaloneOutcome());
      if (outcome === 2) {
        error = quiet
          ? "standalone: async test never settled (its job queue drained empty; it awaits host time or I/O)"
          : "standalone: async test never settled (microtask queue did not go quiet)";
      }
    } else {
      // A synchronous outcome can still have queued jobs (fire-and-forget
      // promises inside the test); run them before the next test starts.
      drainStandaloneMicrotasks(exports);
    }
  } catch (thrown) {
    outcome = 0;
    error = `trap: ${renderHarnessThrownText(thrown, instance)}${trapFrames(thrown)}`;
  }
  const passed = outcome === 1;
  if (!passed && error === "") {
    error = readText(exports, TEXT_ERROR, index) || readText(exports, TEXT_REJECTION, index);
  }
  return { index, name, passed, error: passed ? "" : error || "upstream assertion failed in standalone Wasm" };
}

function assertBoundary(instance) {
  if (typeof instance.exports.upstreamStandaloneStart !== "function") {
    throw new Error("standalone module is missing the upstreamStandalone* test boundary exports");
  }
}

/**
 * Run the registered tests of an instantiated standalone module through the
 * numeric boundary. Returns the same `{ count, names, statuses, errors }`
 * shape the JS-host worker reports, so the suite summaries are lane-agnostic.
 * `startIndex` / `onResult` serve the isolated runner below.
 */
export function runStandaloneUpstreamTests(instance, { startIndex = 0, onStart, onResult } = {}) {
  assertBoundary(instance);
  const count = Number(instance.exports.upstreamStandaloneCount());
  const names = [];
  const statuses = [];
  const errors = [];
  for (let index = startIndex; index < count; index++) {
    const result = runStandaloneTest(instance, index, onStart);
    onResult?.(result);
    names.push(result.name);
    statuses.push(result.passed);
    errors.push(result.error);
  }
  return { count, names, statuses, errors };
}

/**
 * Same results as `runStandaloneUpstreamTests`, for callers that run tests in
 * their OWN process (uuid, react): a synchronous Wasm test that never returns
 * cannot be interrupted in-process, so the module runs in a worker thread with
 * a per-test deadline. A test that overruns is recorded as a timeout and a
 * fresh instance continues from the next test. A linked project
 * (`linkedModules`) runs in-process — its providers need the compiler runtime.
 */
export async function runStandaloneUpstreamTestsIsolated(result, { testTimeoutMs = 60_000 } = {}) {
  if ((result.linkedModules ?? []).length > 0) {
    return runStandaloneUpstreamTests(await instantiateStandaloneResult(result));
  }
  await instantiateStandaloneResult(result); // the zero-import check, on this thread
  const names = [];
  const statuses = [];
  const errors = [];
  let count = null;
  let next = 0;
  while (count === null || next < count) {
    const outcome = await runWorkerFrom(result.binary, next, testTimeoutMs, (message) => {
      if (message.type === "count") count = message.count;
      if (message.type === "start") names[message.index] = message.name;
      if (message.type === "result") {
        names[message.index] = message.name;
        statuses[message.index] = message.passed;
        errors[message.index] = message.error;
        next = message.index + 1;
      }
    });
    if (outcome.type === "init-error") throw new Error(`module init: ${outcome.error}`);
    if (outcome.type === "timeout") {
      if (count === null) throw new Error(`module init did not finish within ${STANDALONE_INIT_TIMEOUT_MS} ms`);
      names[next] ??= "";
      statuses[next] = false;
      errors[next] = `standalone: test did not finish within ${testTimeoutMs} ms (worker terminated)`;
      next++;
    }
  }
  return { count, names, statuses, errors };
}

function runWorkerFrom(binary, startIndex, testTimeoutMs, onMessage) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./upstream-standalone-run-worker.mjs", import.meta.url), {
      workerData: { binary, startIndex },
    });
    let timer;
    // Instantiation + module init get their own, longer deadline; after the
    // `count` message every test gets `testTimeoutMs`.
    let deadline = STANDALONE_INIT_TIMEOUT_MS;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        worker.terminate();
        resolve({ type: "timeout" });
      }, deadline);
    };
    arm();
    worker.on("message", (message) => {
      onMessage(message);
      if (message.type === "count") deadline = testTimeoutMs;
      if (message.type === "done" || message.type === "init-error") {
        clearTimeout(timer);
        worker.terminate();
        resolve(message);
      } else arm();
    });
    worker.on("error", (error) => {
      clearTimeout(timer);
      resolve({ type: "init-error", error: renderHarnessThrownText(error) });
    });
  });
}

/** Worker-thread body for `runStandaloneUpstreamTestsIsolated`. */
export async function standaloneRunWorkerMain({ binary, startIndex }, post) {
  const { instance } = await WebAssembly.instantiate(binary, {});
  try {
    instance.exports.__module_init?.();
    drainStandaloneMicrotasks(instance.exports);
    assertBoundary(instance);
  } catch (error) {
    post({ type: "init-error", error: renderHarnessThrownText(error, instance) });
    return;
  }
  post({ type: "count", count: Number(instance.exports.upstreamStandaloneCount()) });
  runStandaloneUpstreamTests(instance, {
    startIndex,
    onStart: (index, name) => post({ type: "start", index, name }),
    onResult: (result) => post({ type: "result", ...result }),
  });
  post({ type: "done" });
}
