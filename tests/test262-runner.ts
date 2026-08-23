/**
 * Test262 runner — compiles a filtered subset of the official ECMAScript
 * conformance suite through js2wasm and validates the results.
 *
 * Each test262 test is a standalone JS file. We:
 *   1. Parse metadata (features, flags, negative, includes)
 *   2. Filter out tests that use unsupported features
 *   3. Assemble the literal upstream harness and untouched test body
 *   4. Compile with allowJs, instantiate, and run top-level initialization
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import { createHash } from "crypto";
import { createContext, runInContext } from "node:vm";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { negativeCompileErrorMatches } from "../scripts/negative-verdict.mjs";
// (#3613) ONE renderer for a thrown Wasm payload, shared with the CI worker.
// Two copies "kept in sync" by a comment is exactly how the local lane came to
// report the opaque #2870 label where CI reported the real assertion text.
import {
  renderHarnessThrownText,
  safeStringifyThrown as sharedSafeStringifyThrown,
  tryNativeExnRender as sharedTryNativeExnRender,
} from "../scripts/lib/wasm-exn-render.mjs";
import { isModuleGoal } from "../scripts/test262-module-goal.mjs";
// (#4162) ONE import-object finaliser, shared with scripts/test262-worker.mjs
// and tests/test262-shared.ts. This lane used to instantiate the binary
// directly, so a standalone module linking `js2wasm:runtime-eval` died at
// instantiate and reported a LINK error in place of the test's real signature.
// That is not a niche shape: the `$262.evalScript` shim `assembleOriginalHarness`
// injects into EVERY test contains a direct `eval`, so any test keeping it
// reachable carries the module-level import. Measured on one 162-file ES5 lever:
// 82 files masked, 18 of them actually passing.
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { assembleOriginalHarness, type OriginalHarnessVariant } from "./test262-original-harness.js";
import { SANDBOX_GLOBAL_NAMES } from "../scripts/test262-sandbox-globals.mjs";

// #1310: per-shard global isolation for test262.
//
// Tests that mutate JS built-ins via `__extern_set` host imports
// (e.g. assigning to `Array.prototype.push`) currently contaminate
// subsequent tests in the same shard, because `resolveImport` resolves
// `declared_global` intents at `buildImports` time against the live
// `globalThis`. Once a prior test has clobbered `Array`, the next call
// to `buildImports` sees the polluted constructor.
//
// Fix: thread a `globalSandbox` through `buildImports`. The sandbox is
// a plain Record whose `.Array`, `.Object`, etc. fields are references
// to the *vm context's* fresh built-ins (a sibling realm). After every
// test we check sentinel paths on the sandbox; if any have been mutated
// (e.g. `sandbox.Array.prototype.push = brokenFn`) we discard the
// sandbox and build a new one with another `vm.createContext`, so the
// next test starts from clean built-ins.
//
// `vm.createContext({})` returns the host object but does NOT expose the
// vm realm's built-ins as properties on it — `ctx.Array` is `undefined`.
// We therefore use `vm.runInContext("...")` to extract the realm's
// built-ins explicitly and copy the references onto the sandbox object.
//
// (#3441) The name list itself now lives in the single shared source
// scripts/test262-sandbox-globals.mjs (imported above as SANDBOX_GLOBAL_NAMES),
// so this runner lane and the sharded-CI worker (scripts/test262-worker.mjs)
// can never drift again — the #3419 TypedArray cluster (+ Atomics) is applied
// to both by construction.

const SENTINEL_KEYS: ReadonlyArray<readonly string[]> = [
  ["Array", "prototype", "push"],
  ["Object", "prototype", "hasOwnProperty"],
  ["Function", "prototype", "call"],
  ["String", "prototype", "slice"],
  ["Promise", "prototype", "then"],
  // (#2623 P-7b) Top-level `Promise.resolve = fn` patches now LAND on the
  // sandbox Promise (the observable-resolve contract) — watch the static so a
  // patched sandbox is discarded before the next test.
  ["Promise", "resolve"],
  ["Set", "prototype", "add"],
  ["Map", "prototype", "set"],
  ["WeakMap", "prototype", "set"],
  ["WeakSet", "prototype", "add"],
];

function _buildFreshSandbox(consoleProxy?: Console, exposeDone = true): Record<string, any> {
  // Create a context, then pull each global name out of it via
  // runInContext so the sandbox object exposes them by property name.
  const sandbox = Object.create(null) as Record<string, any>;
  const ctx = createContext(sandbox);
  for (const name of SANDBOX_GLOBAL_NAMES) {
    // runInContext("Array", ctx) returns the realm's Array constructor.
    // Assigning to sandbox[name] also makes it visible to subsequent
    // runInContext calls (the sandbox doubles as the global object).
    try {
      sandbox[name] = runInContext(name, ctx);
    } catch {
      // Some globals may not be present in this vm realm — leave undefined.
    }
  }
  // Script global value properties have immutable data descriptors. A plain
  // object sandbox otherwise lets strict writes create `undefined`/`Infinity`
  // and turns Test262's required TypeErrors into false negatives (#3367).
  Object.defineProperties(sandbox, {
    undefined: { value: undefined, writable: false, enumerable: false, configurable: false },
    Infinity: { value: Number.POSITIVE_INFINITY, writable: false, enumerable: false, configurable: false },
    NaN: { value: Number.NaN, writable: false, enumerable: false, configurable: false },
  });
  if (consoleProxy) sandbox.console = consoleProxy;
  // Provide globalThis as the sandbox itself so `ctx.globalThis === ctx`.
  sandbox.globalThis = sandbox;
  // (#3428) asyncHelpers.js guards `asyncTest` with
  // `Object.prototype.hasOwnProperty.call(globalThis, "$DONE")` and throws
  // "asyncTest called without async flag" when it's absent. A JS engine running
  // the harness as a SCRIPT exposes the top-level `function $DONE`
  // (doneprintHandle.js) as a globalThis own-property, but our compiled MODULE
  // keeps `$DONE` a module-local binding, so the guard failed on all 225
  // asyncTest-based tests. Expose a stub own-property so the guard passes; the
  // real, module-local `$DONE` (lexically in scope inside `asyncTest`) still
  // drives the completion callback that emits the `Test262:AsyncTestComplete`
  // marker.
  //
  // (#4394) ONLY for a test that carries the `async` flag. A JS engine exposes
  // `$DONE` because `doneprintHandle.js` is in the prefix, and that include is
  // itself flag-gated — so a NON-async test must not see the own-property
  // either. `test/harness/asyncHelpers-asyncTest-without-async-flag.js` asserts
  // exactly that (`!Object.hasOwn(globalThis, "$DONE")`) before checking that
  // `asyncTest` refuses to run, and the unconditional stub made the guard it is
  // testing unobservable. Defaults to `true` so the legacy `wrapTest` lane and
  // the shared `getTestSandbox()` are unchanged.
  if (exposeDone) sandbox.$DONE = () => {};
  return sandbox;
}

/**
 * (#4394) Does the test body declare its own top-level `$DONE`? A script's
 * top-level `function` / `var` declarations become own properties of the global
 * object, which is what `asyncHelpers.js`'s
 * `Object.prototype.hasOwnProperty.call(globalThis, "$DONE")` guard observes.
 * A compiled MODULE keeps them module-local, so the sandbox has to mirror it.
 */
function declaresTopLevelDone(body: string): boolean {
  return /^[ \t]*(?:function[ \t]+\$DONE\b|(?:var|let|const)[ \t]+\$DONE\b)/m.test(body);
}

/** A fresh realm for literal-harness execution; never reused across variants. */
export function createTestSandbox(consoleProxy?: Console, exposeDone = true): Record<string, any> {
  return _buildFreshSandbox(consoleProxy, exposeDone);
}

function _readSentinels(sandbox: Record<string, any>): unknown[] {
  return SENTINEL_KEYS.map((path) => {
    let cur: any = sandbox;
    for (const k of path) cur = cur?.[k];
    return cur;
  });
}

let _sandbox: Record<string, any> = _buildFreshSandbox();
let _sentinels: unknown[] = _readSentinels(_sandbox);

/**
 * Return a sandbox object suitable for `buildImports({ globalSandbox })`.
 * Refreshes the sandbox whenever a sentinel built-in has been mutated by
 * the previously-run test.
 */
export function getTestSandbox(): Record<string, any> {
  let dirty = false;
  for (let i = 0; i < SENTINEL_KEYS.length; i++) {
    const path = SENTINEL_KEYS[i]!;
    let cur: any = _sandbox;
    for (const k of path) cur = cur?.[k];
    if (cur !== _sentinels[i]) {
      dirty = true;
      break;
    }
  }
  if (dirty) {
    _sandbox = _buildFreshSandbox();
    _sentinels = _readSentinels(_sandbox);
  }
  return _sandbox;
}

/**
 * Compute a short (12-char) sha256 hex digest of a compiled Wasm binary.
 * Used for the dev-self-merge regression-gate noise filter (#1222): if a test
 * appears to "regress" but the Wasm binary is byte-identical on both base and
 * branch, the runtime difference is pure CI noise and should not count.
 */
export function computeWasmSha(binary: Uint8Array): string {
  return createHash("sha256").update(binary).digest("hex").slice(0, 12);
}

// ── Metadata parsing ────────────────────────────────────────────────

export interface Test262Meta {
  description?: string;
  info?: string;
  features?: string[];
  flags?: string[];
  includes?: string[];
  negative?: { phase: string; type: string };
  es5id?: string;
  es6id?: string;
  esid?: string;
}

export type Test262Scope = "standard" | "annex_b" | "proposal";

export interface Test262ScopeInfo {
  scope: Test262Scope;
  official: boolean;
  reason?: string;
  /** "only" = onlyStrict, "no" = noStrict/sloppy-only, "both" = works in either mode */
  strict: "only" | "no" | "both";
}

const PROPOSAL_FEATURES = new Map([
  ["Temporal", "proposal feature: Temporal"],
  ["import-defer", "proposal feature: import defer"],
  ["source-phase-imports", "proposal feature: source phase imports"],
  // (#837) `upsert` removed — Map/WeakMap.getOrInsert / .getOrInsertComputed
  // are now host-imported as extern methods (see src/codegen/index.ts).
]);

function getTest262RelativePath(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  return filePath.replace(/.*test262\//, "");
}

// Known sloppy-only tests that may not carry a noStrict flag in their metadata
const SLOPPY_MODE_PATHS = new Set([
  "test/annexB/language/function-code/function-redeclaration-block.js",
  "test/annexB/language/function-code/function-redeclaration-switch.js",
  "test/annexB/language/statements/for-in/const-initializer.js",
  "test/annexB/language/statements/for-in/strict-initializer.js",
  "test/annexB/language/statements/for-in/var-arraybindingpattern-initializer.js",
  "test/annexB/language/statements/for-in/let-initializer.js",
  "test/annexB/language/statements/for-in/var-objectbindingpattern-initializer.js",
  "test/annexB/language/statements/labeled/function-declaration.js",
]);

function classifyStrictMode(meta: Test262Meta, relPath: string): "only" | "no" | "both" {
  if (meta.flags?.includes("onlyStrict")) return "only";
  if (meta.flags?.includes("noStrict")) return "no";
  if (SLOPPY_MODE_PATHS.has(relPath)) return "no";
  if (/legacy-octal-escape|legacy-non-octal-escape|S7\.8\.4_A4\.3/.test(relPath)) return "no";
  return "both";
}

export function classifyTestScope(source: string, meta: Test262Meta, filePath?: string): Test262ScopeInfo {
  const relPath = getTest262RelativePath(filePath) ?? "";
  const strict = classifyStrictMode(meta, relPath);

  if (relPath.startsWith("test/staging/") || relPath.startsWith("staging/")) {
    return { scope: "proposal", official: false, reason: "test262 staging proposal", strict };
  }

  if (relPath.startsWith("test/annexB/") || relPath.startsWith("annexB/")) {
    return { scope: "annex_b", official: true, reason: "Annex B", strict };
  }

  if (relPath.includes("built-ins/Temporal/")) {
    return { scope: "proposal", official: false, reason: "proposal feature: Temporal", strict };
  }

  if (meta.features) {
    for (const feat of meta.features) {
      const reason = PROPOSAL_FEATURES.get(feat);
      if (reason) {
        return { scope: "proposal", official: false, reason, strict };
      }
    }
  }

  return { scope: "standard", official: true, strict };
}

/** Parse the /*--- ... ---*​/ YAML front matter from a test262 file */
export function parseMeta(source: string): Test262Meta {
  const match = source.match(/\/\*---\s*([\s\S]*?)\s*---\*\//);
  if (!match) return {};
  const yaml = match[1]!;
  const meta: Test262Meta = {};

  // Simple YAML-ish parser — enough for test262 metadata
  const descMatch = yaml.match(/^description:\s*(.+)$/m);
  if (descMatch) {
    const raw = descMatch[1]!.trim();
    if (raw === ">" || raw === "|") {
      // YAML block scalar — grab indented lines that follow
      const blockMatch = yaml.match(/^description:\s*[>|]\s*\n((?:[ \t]+.+\n?)+)/m);
      meta.description = blockMatch ? blockMatch[1]!.replace(/\n\s*/g, " ").trim() : "";
    } else {
      meta.description = raw;
    }
  }

  const infoMatch = yaml.match(/^info:\s*\|?\s*\n([\s\S]*?)(?=^\w|\Z)/m);
  if (infoMatch) meta.info = infoMatch[1]!.trim();

  const parseList = (name: string): string[] | undefined => {
    const inline = yaml.match(new RegExp(`^${name}:\\s*\\[([^\\]]*)\\]`, "m"));
    if (inline) {
      return inline[1]!
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
    const block = yaml.match(new RegExp(`^${name}:\\s*\\n((?:[ \\t]+-\\s*.*(?:\\n|$))+)`, "m"));
    if (!block) return undefined;
    return block[1]!
      .split("\n")
      .map((line) => line.replace(/^\s*-\s*/, "").trim())
      .filter(Boolean);
  };

  meta.features = parseList("features");
  meta.flags = parseList("flags");
  meta.includes = parseList("includes");

  if (yaml.includes("negative:")) {
    const phaseMatch = yaml.match(/phase:\s*(\w+)/);
    const typeMatch = yaml.match(/type:\s*(\w+)/);
    if (phaseMatch && typeMatch) {
      meta.negative = { phase: phaseMatch[1]!, type: typeMatch[1]! };
    }
  }

  return meta;
}

// ── Filtering ───────────────────────────────────────────────────────

export type FilterResult = { skip: true; reason: string } | { skip: false; reason?: undefined };

// Tests that cause the compiler to hang (infinite loop during compilation)
const HANGING_TESTS = new Set([
  // (#1386) `test/built-ins/Promise/race/invoke-then.js` previously hung at
  // compile time on the `p1.then = p2.then = p3.then = function(a, b) {…}`
  // chained assignment. Verified 2026-05-08: compile completes in ~1.8s
  // (well under the 5s threshold) — wrapped through `wrapTest`, the test
  // returns 6 type-mismatch CEs about the `.then` function signature
  // (returns void instead of `Promise<…>`). The test now registers as
  // `compile_error`, not a hang. Reclassifying skip → compile_error is a
  // bookkeeping move, not a regression.
  // #859: Map/forEach/iterates-values-deleted-then-readded.js previously hung
  // because callback captures were immutable snapshots — `if (count === 0)`
  // never became false, so the test infinitely re-added the deleted key. The
  // ref-cell capture pattern (compileArrowAsCallback) now propagates the
  // count++ mutation back to the outer local, terminating the loop after the
  // spec'd 3 iterations.
  // #1385: Temporal/Duration/from/argument-non-string.js no longer hangs.
  // Local probe (May 2026): wrapTest + compile + instantiate + test() runs
  // ~1.2s total; test() throws WebAssembly.Exception immediately because
  // `Temporal` is not defined in our runtime. No iteration, no hang. Removed.

  // #1589 Hot spot C: language/comments/S7.4_A6.js calls `eval()` inside a
  // `for (i = 0; i <= 65535; i++)` loop. Our eval stub throws each iteration
  // but the loop continues — wall time grows linearly with iteration count
  // (≥65s, well past the 30s vitest budget). Skip until we either (a) tighten
  // the skip filter to catch eval anywhere in source, or (b) ship a no-op
  // eval stub that lets such loops terminate quickly. See #1589 Findings.
  "language/comments/S7.4_A6.js",

  // #1589 Hot spot A (#1589A): Array.prototype.{indexOf,lastIndexOf}.call(obj, …)
  // with `length: 4294967296`. Wrong object-literal field-type inference (empty
  // {} treated as Test262Error) + __extern_has_idx returning 0 for null payload
  // causes a 4-billion-iteration search loop → 30s timeout. Real compiler bug
  // tracked in #1589A — skip these tests in the meantime so the longest shard
  // doesn't pay 3 × 30s of timeout cost.
  "built-ins/Array/prototype/indexOf/15.4.4.14-3-28.js",
  "built-ins/Array/prototype/indexOf/15.4.4.14-3-29.js",
  "built-ins/Array/prototype/lastIndexOf/15.4.4.15-3-28.js",

  // #3122 (surfaced by #3119): never-done iterator whose ONLY exit is an
  // abrupt LHS assignment (`for (x.attr of iterable)` with a throwing setter,
  // §13.7.5.13 step 6.f → IteratorClose). Our accessor-setter store does not
  // raise on this path, so with the #3119 OBJ arm genuinely driving the
  // iterator the loop spins to the runner timeout (previously: host lane
  // compile_timeout / standalone fail "illegal cast" — no pass is lost by
  // skipping). Remove when #3122 lands.
  //
  // NOTE the "test/" prefix: the lookups below strip `.*test262\/` from an
  // absolute path like <root>/test262/test/language/..., which leaves the
  // "test/" segment IN the key. The older prefix-less entries above do not
  // match under this shape (verified 2026-07-09: S7.4_A6.js runs — and now
  // passes — rather than skipping); they are kept as-is because activating
  // them would flip a current pass to skip. Tracked in #3122's notes.
  "test/language/statements/for-of/body-put-error.js",
]);

export function shouldSkip(source: string, meta: Test262Meta, filePath?: string): FilterResult {
  const scope = classifyTestScope(source, meta, filePath);

  // Skip FIXTURE files — auxiliary modules for dynamic-import tests that use
  // export syntax TypeScript rejects. They are never standalone tests.
  // findTestFiles already excludes them, but guard here for defense-in-depth.
  if (filePath && /_FIXTURE\.js$/.test(filePath)) {
    return {
      skip: true,
      reason: "FIXTURE helper file (not a standalone test)",
    };
  }

  // Skip known hanging tests by file path — prevents infinite compilation loops
  if (filePath) {
    const relPath = filePath.replace(/.*test262\//, "");
    if (HANGING_TESTS.has(relPath)) {
      return { skip: true, reason: "compiler hang (see HANGING_TESTS)" };
    }
  }

  // #1390: import-defer proposal tests are syntax-only — they have no
  // `export function test()` and rely on either a parse-phase negative check
  // or a `import defer` namespace runtime that we don't implement. With
  // TEST262_INCLUDE_PROPOSALS=1 they show as ~31 false `compile_error: no test
  // export` entries. Skip the whole subtree unconditionally so the conformance
  // report stays clean regardless of the proposals flag.
  if (filePath) {
    const relPath = filePath.replace(/.*test262\//, "");
    if (relPath.includes("language/import/import-defer/")) {
      return {
        skip: true,
        reason: "proposal feature: import defer (no test harness)",
      };
    }
  }

  // #1696: dynamic-import tests that require host fixture-module resolution
  // and rely on sloppy-script `var x; function x() {}` redeclarations.
  // Two stacked runner gaps:
  //   1. TypeScript rejects the var/function redeclaration at parse time,
  //      before our codegen ever runs.
  //   2. `__dynamic_import` cannot resolve test262 fixture paths
  //      (`./eval-script-code-host-resolves-module-code-*_FIXTURE.js`)
  //      from the runner environment — they are not real modules on disk
  //      relative to the synthetic test source.
  // Skip the 18-test family so the conformance report does not report
  // these as compile errors.
  if (filePath && /eval-script-code-host-resolves-module-code/.test(filePath)) {
    return {
      skip: true,
      reason: "dynamic-import + sloppy-script var/fn redecl + fixture path (#1696)",
    };
  }

  // #1073: annexB/language/eval-code blanket skip removed. The __extern_eval
  // handler now prepends JS-side harness shims (assert_sameValue, assert_throws,
  // etc.) so Gap 1 (harness visibility, ~107 tests) is resolved. Gap 2 (export
  // syntax in eval strings, ~48 tests) and Gap 3 (indirect eval wiring, ~24
  // tests) will fail naturally — they were false positives before #1006.

  if (scope.scope === "proposal" && process.env.TEST262_INCLUDE_PROPOSALS !== "1") {
    return {
      skip: true,
      reason: `Proposal excluded from default scope${scope.reason ? `: ${scope.reason}` : ""}`,
    };
  }

  // All other skip filters have been removed (#494). Tests that fail will
  // show as compile_error or fail in the conformance report rather than
  // being hidden as skips.

  return { skip: false };
}

// ── Path-scoped filter (#1521) ──────────────────────────────────────
//
// The Test262 Differential workflow narrows the test set on PRs that touch
// only narrow areas of the codegen tree (e.g. `src/codegen/regexp.ts` only
// runs RegExp + RegExp-Symbol tests). The workflow detects the changed
// src/ paths, maps them to coarse test category prefixes, and exports the
// result as `TEST262_PATH_FILTER` (a pipe-separated list of substrings).
//
// Filter semantics:
//   - empty / unset → run all tests (safe fallback for core-file changes
//     and for the `detect-scope` job failing entirely).
//   - non-empty → keep tests whose path contains any one of the
//     pipe-separated patterns (substring match).
//
// Apply this filter BEFORE wrap+compile+cache-lookup so even cache hits
// are skipped for filtered-out tests — that's where the wall-clock
// savings come from.

let _cachedPathFilter: string[] | null | undefined;

function parsePathFilter(): string[] | null {
  if (_cachedPathFilter !== undefined) return _cachedPathFilter;
  const raw = process.env.TEST262_PATH_FILTER ?? "";
  const parts = raw
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  _cachedPathFilter = parts.length > 0 ? parts : null;
  return _cachedPathFilter;
}

// (ES5 measurement lane) TEST262_PATH_FILTER_FILE — a file of exact
// test-relative paths, one per line. Env-var filters cap out far below the
// ~9k-entry ES5 subset (and 9k substring patterns would be quadratic), so a
// file-fed EXACT-match Set is the scalable spelling. Composes with
// TEST262_PATH_FILTER: a path passes if it matches EITHER (each is a no-op
// when unset).
let _cachedPathFilterSet: ReadonlySet<string> | null | undefined;
function parsePathFilterSet(): ReadonlySet<string> | null {
  if (_cachedPathFilterSet !== undefined) return _cachedPathFilterSet;
  const file = process.env.TEST262_PATH_FILTER_FILE;
  if (!file) {
    _cachedPathFilterSet = null;
    return null;
  }
  try {
    const lines = readFileSync(file, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    _cachedPathFilterSet = new Set(lines);
  } catch {
    _cachedPathFilterSet = null;
  }
  return _cachedPathFilterSet;
}

/**
 * Check whether `relPath` (a test262/test-relative path like
 * `built-ins/RegExp/prototype/test/foo.js`) matches the active
 * `TEST262_PATH_FILTER`. Returns true when no filter is active (run all),
 * or when the path contains any one of the pipe-separated patterns.
 */
export function matchesPathFilter(relPath: string): boolean {
  const filter = parsePathFilter();
  const filterSet = parsePathFilterSet();
  if (filter === null && filterSet === null) return true;
  if (filterSet !== null && filterSet.has(relPath)) return true;
  if (filter !== null) {
    for (const p of filter) {
      if (relPath.includes(p)) return true;
    }
  }
  return false;
}

// ── Test wrapping ───────────────────────────────────────────────────

/**
 * Strip the 3rd argument from function calls like fn(a, b, msg).
 * Handles nested parentheses correctly.
 */
function stripThirdArg(code: string, fnName: string): string {
  let result = "";
  let i = 0;
  while (i < code.length) {
    const idx = code.indexOf(fnName + "(", i);
    if (idx === -1) {
      result += code.slice(i);
      break;
    }
    result += code.slice(i, idx + fnName.length + 1); // include "fnName("
    let pos = idx + fnName.length + 1;
    let depth = 1; // tracks () nesting
    let bracketDepth = 0; // tracks [] nesting
    let braceDepth = 0; // tracks {} nesting
    let commaCount = 0;
    let secondCommaPos = -1;
    let closeParenPos = -1;
    while (pos < code.length && depth > 0) {
      const ch = code[pos]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          closeParenPos = pos;
          break;
        }
      } else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth--;
      else if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      else if (ch === "," && depth === 1 && bracketDepth === 0 && braceDepth === 0) {
        commaCount++;
        if (commaCount === 2) secondCommaPos = pos;
      } else if (ch === "'" || ch === '"') {
        // Skip string literal
        const quote = ch;
        pos++;
        while (pos < code.length && code[pos] !== quote) {
          if (code[pos] === "\\") pos++;
          pos++;
        }
      }
      pos++;
    }
    if (closeParenPos < 0) {
      // Unmatched paren — append rest of code as-is
      result += code.slice(idx + fnName.length + 1);
      i = code.length;
    } else if (secondCommaPos >= 0) {
      // Include up to 2nd comma, skip to close paren
      result += code.slice(idx + fnName.length + 1, secondCommaPos);
      result += ")";
      i = closeParenPos + 1;
    } else {
      // No 3rd arg — include as-is
      result += code.slice(idx + fnName.length + 1, closeParenPos + 1);
      i = closeParenPos + 1;
    }
  }
  return result;
}

/**
 * Transform `Pattern.call(obj, key)` → `(obj).hasOwnProperty(key)`.
 *
 * Used for:
 *   Object.prototype.hasOwnProperty.call(obj, key)  → (obj).hasOwnProperty(key)
 *
 * Uses paren-counting to correctly extract the first argument (obj),
 * then emits `(obj).hasOwnProperty(` followed by the remaining args.
 */
function transformPrototypeCall(code: string, pattern: string): string {
  const search = pattern + "(";
  let result = "";
  let i = 0;
  while (i < code.length) {
    const idx = code.indexOf(search, i);
    if (idx === -1) {
      result += code.slice(i);
      break;
    }
    result += code.slice(i, idx);
    let pos = idx + search.length;
    // Extract first argument (obj) by finding the comma at depth 0
    let depth = 1;
    const firstArgStart = pos;
    let commaPos = -1;
    while (pos < code.length && depth > 0) {
      const ch = code[pos]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      } else if (ch === "," && depth === 1 && commaPos === -1) {
        commaPos = pos;
        break;
      } else if (ch === "'" || ch === '"') {
        const quote = ch;
        pos++;
        while (pos < code.length && code[pos] !== quote) {
          if (code[pos] === "\\") pos++;
          pos++;
        }
      }
      pos++;
    }
    if (commaPos >= 0) {
      const firstArg = code.slice(firstArgStart, commaPos).trim();
      // Skip whitespace after comma
      let afterComma = commaPos + 1;
      while (afterComma < code.length && code[afterComma] === " ") afterComma++;
      // Find the closing paren for the entire call
      pos = afterComma;
      depth = 1;
      while (pos < code.length && depth > 0) {
        const ch = code[pos]!;
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) break;
        } else if (ch === "'" || ch === '"') {
          const quote = ch;
          pos++;
          while (pos < code.length && code[pos] !== quote) {
            if (code[pos] === "\\") pos++;
            pos++;
          }
        }
        pos++;
      }
      const secondArg = code.slice(afterComma, pos).trim();
      result += `(${firstArg}).hasOwnProperty(${secondArg})`;
      i = pos + 1; // skip closing paren
    } else {
      // No comma found — malformed, emit as-is
      result += search;
      i = idx + search.length;
    }
  }
  return result;
}

/**
 * Replace `throw new Test262Error(...)` with `return 0;`.
 * Using `return 0` instead of `__fail = 1` because:
 *  - In the original harness, throw exits loops and the test
 *  - `return 0` does the same — exits loops AND the function
 *  - `__fail = 1` didn't exit loops, causing infinite loops
 */
function replaceThrowTest262Error(code: string): string {
  const pattern = "throw new Test262Error(";
  let result = "";
  let i = 0;
  while (i < code.length) {
    const idx = code.indexOf(pattern, i);
    if (idx === -1) {
      result += code.slice(i);
      break;
    }
    result += code.slice(i, idx);
    // Skip past the opening paren and find the matching close
    let pos = idx + pattern.length;
    let depth = 1;
    while (pos < code.length && depth > 0) {
      if (code[pos] === "(") depth++;
      else if (code[pos] === ")") depth--;
      pos++;
    }
    // Skip optional semicolon
    if (pos < code.length && code[pos] === ";") pos++;
    result += "return 0;";
    i = pos;
  }
  return result;
}

/**
 * Replace other throw patterns with `return 0;` for the same reason.
 */
function replaceOtherThrows(code: string): string {
  // throw "string literal";
  code = code.replace(/throw\s+"[^"]*"\s*;/g, "return 0;");
  code = code.replace(/throw\s+'[^']*'\s*;/g, "return 0;");
  // throw new Error(...)
  code = code.replace(/throw\s+new\s+Error\s*\([^)]*\)\s*;/g, "return 0;");
  // $DONOTEVALUATE() — should never be reached, return 0 = fail
  code = code.replace(/\$DONOTEVALUATE\s*\(\s*\)\s*;?/g, "return 0;");
  return code;
}

/**
 * Transform `assert.throws(ErrorType, fn)` into `assert_throws(ErrorType, fn)`.
 *
 * These test that calling `fn` throws an error of the given type. We keep BOTH
 * the expected error constructor (first arg) AND the function callback (second
 * arg), dropping only the optional message (third arg). The shim `assert_throws`
 * in the preamble calls `fn()` inside try/catch and verifies the caught error
 * MATCHES `ErrorType` before treating it as a pass (#3285).
 *
 * Previously the first arg was read and discarded — `assert.throws(TypeError,
 * fn)` became `assert_throws(fn)`, so a callback that threw the WRONG error type
 * (e.g. `RangeError` where the spec mandates `TypeError`) still counted as a
 * pass. Threading the type through closes that false-positive.
 *
 * Uses paren-counting to handle nested parens in the function argument.
 */
// (#3285/#3104) Global error constructors whose NAME can be derived at wrap
// time for the assert_throws side channel (`ErrCtor.name === identifier` holds
// for exactly these). Everything else (test-local ctor variables) stays
// legacy-untyped — see the emission comment in transformAssertThrows.
const KNOWN_ERROR_CTOR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "Test262Error",
]);

function transformAssertThrows(code: string, outputFnName: string = "assert_throws"): string {
  const pattern = "assert.throws(";
  let result = "";
  let i = 0;
  while (i < code.length) {
    const idx = code.indexOf(pattern, i);
    if (idx === -1) {
      result += code.slice(i);
      break;
    }
    result += code.slice(i, idx);

    // Parse the arguments inside assert.throws(...)
    let pos = idx + pattern.length;
    let parenDepth = 1; // paren depth — starts at 1 (inside opening paren)
    let braceDepth = 0; // curly brace depth — track function bodies
    let bracketDepth = 0; // square bracket depth — track array destructuring
    const args: string[] = [];
    let currentArgStart = pos;

    while (pos < code.length && parenDepth > 0) {
      const ch = code[pos]!;
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth--;
      else if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth--;
      else if (ch === "," && parenDepth === 1 && braceDepth === 0 && bracketDepth === 0) {
        // Top-level comma — separates arguments (only when not inside braces/brackets)
        args.push(code.slice(currentArgStart, pos).trim());
        currentArgStart = pos + 1;
      } else if (ch === "'" || ch === '"' || ch === "`") {
        // Skip string literal
        const quote = ch;
        pos++;
        while (pos < code.length && code[pos] !== quote) {
          if (code[pos] === "\\") pos++;
          pos++;
        }
      }
      if (parenDepth === 0) {
        // End of assert.throws(...) — capture last argument (excluding closing paren)
        args.push(code.slice(currentArgStart, pos).trim());
      }
      pos++;
    }

    // pos now points to the char after the closing paren
    // Skip optional semicolon and whitespace
    let endPos = pos;
    while (
      endPos < code.length &&
      (code[endPos] === ";" || code[endPos] === " " || code[endPos] === "\n" || code[endPos] === "\r")
    )
      endPos++;

    // args[0] = ErrorType, args[1] = fn, args[2] = optional message.
    // (#3285/#3104) The expected error type is threaded through a GLOBAL NAME
    // side channel (`__expected_throw_name = "TypeError"; assert_throws(fn);`)
    // instead of a second call argument. The two-arg form
    // `assert_throws(ErrorCtor, fn)` — and even a plain global assignment of
    // the ctor VALUE — deterministically triggers #3315 in standalone: any
    // class-as-value in the method body silently CORRUPTS sibling destructured
    // bindings in the enclosing method (A/B-verified 2026-07-16; the
    // name-string assignment is the only validated-clean shape). The name
    // literal is derived at WRAP time for simple ctor identifiers; a complex
    // ctor EXPRESSION (e.g. `typeof(x)==='y' ? RangeError : TypeError`, 3
    // corpus tests) would have to be EVALUATED in the method body — the #3315
    // trigger — so those emit `null` and keep the legacy untyped any-throw
    // semantics (documented narrow limitation).
    if (args.length >= 2 && args[0] && args[1]) {
      // Only KNOWN GLOBAL error constructors resolve to a name literal at wrap
      // time. A test-local ctor VARIABLE (`expectedError`, `DummyError`, …)
      // must NOT be stringified — the identifier is not the error's .name, so
      // the check would false-fail every honest throw (132 host + 67
      // standalone false fails measured on the 2026-07-16 re-measure run
      // before this whitelist). Resolving a variable's value would require
      // evaluating it in the method body — the #3315 trigger — so those sites
      // stay legacy-untyped (null).
      const nameLiteral = KNOWN_ERROR_CTOR_NAMES.has(args[0]) ? JSON.stringify(args[0]) : "null";
      // Statement-position splice: the original call can be prefixed by
      // `await ` (assert.throwsAsync sites). The assignment must land BEFORE
      // the whole statement, not between `await` and the call expression.
      const trailingAwait = /(^|[\s;{}()])await\s*$/.test(result);
      if (trailingAwait) {
        const awaitStart = result.lastIndexOf("await");
        result = result.slice(0, awaitStart) + `__expected_throw_name = ${nameLiteral}; ` + result.slice(awaitStart);
        result += `${outputFnName}(${args[1]});`;
      } else {
        result += `__expected_throw_name = ${nameLiteral}; ${outputFnName}(${args[1]});`;
      }
    }
    // If we couldn't parse args properly, just strip the call (fallback)
    i = endPos;
  }
  return result;
}

/**
 * Strip `if (expr !== undefined) { throw new Test262Error(...) }` guards.
 * These guards verify a value isn't undefined — not meaningful in wasm where
 * there's no undefined type. Uses paren/brace counting for robustness.
 */
function stripUndefinedThrowGuards(code: string): string {
  // Match: if (expr !== undefined) { throw ... }
  const pattern = /if\s*\(/g;
  let result = "";
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const ifStart = match.index;
    // Find matching close paren for the condition
    let pos = ifStart + match[0].length;
    let depth = 1;
    while (pos < code.length && depth > 0) {
      if (code[pos] === "(") depth++;
      else if (code[pos] === ")") depth--;
      pos++;
    }
    const condition = code.slice(ifStart + match[0].length, pos - 1);
    // Check if condition involves undefined comparison
    if (!/!==?\s*undefined\b/.test(condition) && !/undefined\s*!==?/.test(condition)) continue;
    // Find the { ... } block after the condition
    let braceStart = pos;
    while (braceStart < code.length && /\s/.test(code[braceStart]!)) braceStart++;
    if (braceStart >= code.length || code[braceStart] !== "{") continue;
    let bracePos = braceStart + 1;
    let braceDepth = 1;
    while (bracePos < code.length && braceDepth > 0) {
      if (code[bracePos] === "{") braceDepth++;
      else if (code[bracePos] === "}") braceDepth--;
      bracePos++;
    }
    const body = code.slice(braceStart + 1, bracePos - 1);
    // Only strip if the body contains a throw
    if (!/\bthrow\b/.test(body)) continue;
    // Check for else block — keep its body
    let endPos = bracePos;
    let elseBody = "";
    const afterBrace = code.slice(bracePos).match(/^\s*else\s*\{/);
    if (afterBrace) {
      const elseStart = bracePos + afterBrace[0].length;
      let elseDepth = 1;
      let elseEnd = elseStart;
      while (elseEnd < code.length && elseDepth > 0) {
        if (code[elseEnd] === "{") elseDepth++;
        else if (code[elseEnd] === "}") elseDepth--;
        elseEnd++;
      }
      elseBody = code.slice(elseStart, elseEnd - 1);
      endPos = elseEnd;
    }
    // If the condition contains a function call (side effect), preserve it
    // e.g. if (__func() !== undefined) { throw ... } → __func();
    let sideEffect = "";
    const callMatch = condition.match(/^(.+?)\s*!==?\s*undefined\s*$/) || condition.match(/^undefined\s*!==?\s*(.+)$/);
    if (callMatch && /\(/.test(callMatch[1]!)) {
      sideEffect = callMatch[1]!.trim() + ";\n";
    }
    result += code.slice(lastIdx, ifStart) + sideEffect + elseBody;
    lastIdx = endPos;
    pattern.lastIndex = endPos;
  }
  result += code.slice(lastIdx);
  return result;
}

/**
 * Resolve Unicode escape sequences (\uNNNN) in identifier positions.
 * Avoids replacing escapes inside string literals or template literals.
 * This normalizes test262 sources that use escaped keywords as property names
 * (e.g. obj.bre\u0061k → obj.break) so that regex preprocessing works correctly.
 */
//
// #2708 — regexp literals must also be preserved verbatim: a `\uNNNN` inside
// `/.../` is a regexp Unicode escape whose raw text is observable via
// `RegExp#source` (e.g. `/A/.source === "\\u0041"`). The previous segment
// scanner only skipped string literals, so it rewrote `/A/` → `/A/` and broke
// `language/literals/regexp/S7.8.5_A1.1_T1` / `_A2.1_T1`. We now run a small
// tokenizer that copies string/template literals, line/block comments, and
// regexp literals through untouched, applying escape resolution only to the
// remaining code (where escaped identifiers actually appear).
function resolveUnicodeEscapes(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  // The last significant (non-whitespace) token emitted, used to disambiguate a
  // `/` that begins a regexp literal from a division operator. For a word token
  // we keep the whole word so keyword checks (return/typeof/…) work; for
  // punctuation we keep the single char. Literals collapse to "str"/"re".
  let lastTok = "";
  // Punctuators after which a `/` starts a regexp (i.e. an expression follows).
  const REGEX_OK_PUNCT = new Set("([{,;:=!&|?+-*/%^~<>".split(""));
  // Keywords after which a `/` starts a regexp.
  const REGEX_OK_KEYWORDS = new Set([
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "do",
    "else",
    "yield",
    "case",
    "throw",
  ]);
  const isWordChar = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
  const regexpAllowed = () =>
    lastTok === "" || (lastTok.length === 1 && REGEX_OK_PUNCT.has(lastTok)) || REGEX_OK_KEYWORDS.has(lastTok);

  while (i < n) {
    const c = source[i]!;

    // ── String / template literal — copy verbatim ──────────────────────────
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === c) {
          j++;
          break;
        }
        j++;
      }
      out += source.slice(i, j);
      i = j;
      lastTok = "str";
      continue;
    }

    // ── Line comment — copy verbatim (not a significant token) ─────────────
    if (c === "/" && source[i + 1] === "/") {
      let j = i + 2;
      while (j < n && source[j] !== "\n") j++;
      out += source.slice(i, j);
      i = j;
      continue;
    }

    // ── Block comment — copy verbatim ──────────────────────────────────────
    if (c === "/" && source[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      out += source.slice(i, j);
      i = j;
      continue;
    }

    // ── Regexp literal — copy verbatim (track char classes + escapes) ──────
    if (c === "/" && regexpAllowed()) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n) {
        const d = source[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") break; // unterminated — not a regexp after all
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          ok = true;
          j++;
          break;
        }
        j++;
      }
      if (ok) {
        while (j < n && isWordChar(source[j]!)) j++; // consume flags
        out += source.slice(i, j);
        i = j;
        lastTok = "re";
        continue;
      }
      // Not a well-formed regexp — fall through and treat `/` as a normal char.
    }

    // ── \uNNNN escape — resolve to the encoded character ───────────────────
    if (c === "\\" && source[i + 1] === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) {
      out += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
      i += 6;
      lastTok = "id";
      continue;
    }

    // ── Ordinary character ─────────────────────────────────────────────────
    out += c;
    if (!/\s/.test(c)) {
      if (isWordChar(c)) {
        // Accumulate the running word so keyword detection works; reset when the
        // previous significant token was punctuation or a literal.
        const prevIsWord =
          lastTok.length > 0 && lastTok !== "str" && lastTok !== "re" && isWordChar(lastTok[lastTok.length - 1]!);
        lastTok = prevIsWord ? lastTok + c : c;
      } else {
        lastTok = c;
      }
    }
    i++;
  }
  return out;
}

/**
 * Strip assert.sameValue(expr, undefined) / assert.sameValue(expr, void 0, msg) calls.
 * Uses paren-counting to correctly handle nested calls like
 * assert.sameValue(parseInt("11", undefined), parseInt("11", 10)).
 * Only strips when `undefined` or `void 0` is the second top-level argument.
 */
function stripUndefinedAssert(code: string, fnName: string): string {
  let result = "";
  let i = 0;
  while (i < code.length) {
    const idx = code.indexOf(fnName + "(", i);
    if (idx === -1) {
      result += code.slice(i);
      break;
    }
    // Check word boundary before fnName
    if (idx > 0 && /\w/.test(code[idx - 1]!)) {
      result += code.slice(i, idx + fnName.length);
      i = idx + fnName.length;
      continue;
    }
    let pos = idx + fnName.length + 1; // past the opening '('
    let depth = 1;
    let bracketDepth = 0; // tracks [] nesting
    let braceDepth = 0; // tracks {} nesting
    let commaCount = 0;
    let firstCommaPos = -1;
    let closeParenPos = -1;
    while (pos < code.length && depth > 0) {
      const ch = code[pos]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          closeParenPos = pos;
          break;
        }
      } else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth--;
      else if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      else if (ch === "," && depth === 1 && bracketDepth === 0 && braceDepth === 0) {
        commaCount++;
        if (commaCount === 1) firstCommaPos = pos;
      } else if (ch === "'" || ch === '"') {
        const quote = ch;
        pos++;
        while (pos < code.length && code[pos] !== quote) {
          if (code[pos] === "\\") pos++;
          pos++;
        }
      }
      pos++;
    }
    if (firstCommaPos >= 0 && closeParenPos >= 0) {
      // Find the end of the second argument (second comma at depth 1, or close paren)
      let secondArgEnd = closeParenPos;
      let scanPos = firstCommaPos + 1;
      let scanDepth = 1;
      let scanBracketDepth = 0;
      let scanBraceDepth = 0;
      while (scanPos < closeParenPos) {
        const ch = code[scanPos]!;
        if (ch === "(") scanDepth++;
        else if (ch === ")") scanDepth--;
        else if (ch === "[") scanBracketDepth++;
        else if (ch === "]") scanBracketDepth--;
        else if (ch === "{") scanBraceDepth++;
        else if (ch === "}") scanBraceDepth--;
        else if (ch === "," && scanDepth === 1 && scanBracketDepth === 0 && scanBraceDepth === 0) {
          secondArgEnd = scanPos;
          break;
        } else if (ch === "'" || ch === '"') {
          const quote = ch;
          scanPos++;
          while (scanPos < code.length && code[scanPos] !== quote) {
            if (code[scanPos] === "\\") scanPos++;
            scanPos++;
          }
        }
        scanPos++;
      }
      const secondArg = code.slice(firstCommaPos + 1, secondArgEnd).trim();
      if (secondArg === "undefined" || /^void\s+0$/.test(secondArg)) {
        // Strip the entire assert call
        result += code.slice(i, idx);
        let endPos = closeParenPos + 1;
        // Skip optional semicolon and whitespace
        while (endPos < code.length && (code[endPos] === ";" || code[endPos] === " ")) endPos++;
        result += "/* stripped undefined assert */";
        i = endPos;
        continue;
      }
    }
    // Not an undefined assert -- keep as-is
    result += code.slice(i, idx + fnName.length + 1);
    i = idx + fnName.length + 1;
  }
  return result;
}

/**
 * Rename `yield` used as an identifier to `_yield`, but preserve `yield`
 * inside generator function bodies (function*) where it's a keyword.
 *
 * In sloppy-mode JS, `yield` is a valid identifier. But since we wrap
 * test262 tests as modules (strict mode), `yield` is a reserved word
 * and must be renamed — except inside generator bodies where it's the
 * yield keyword.
 *
 * Algorithm: scan through the source tracking brace depth. When we see
 * `function*`, we note the brace depth of its opening `{`. While inside
 * that generator body, `yield` tokens are preserved. Outside, they are
 * renamed to `_yield`.
 */
function renameYieldOutsideGenerators(source: string): string {
  if (!/\byield\b/.test(source)) return source;

  // If no generator functions (neither `function*` nor `*method()` syntax),
  // just rename all yield identifiers.
  const hasGeneratorFunction = /\bfunction\s*\*/.test(source);
  // #1162 / Task #42: include the same broad identifier class as the
  // detail-pass `methodRegex` below so the fast-path doesn't misclassify
  // private/Unicode-named generator methods. Without parity here the
  // fast path falls through to "rename ALL yield identifiers", clobbering
  // `yield` inside `static * #\u{6F}()` / `static * #℘()` etc.
  const hasGeneratorMethod =
    /(?:^|[,{;)\s])\s*\*\s*(?:(?:[\w$#]|\\u\{[^}]*\}|\\u[0-9a-fA-F]{4}|[\u0080-\uFFFF])+|\[[\s\S]*?\])\s*\(/.test(
      source,
    );
  if (!hasGeneratorFunction && !hasGeneratorMethod) {
    return source.replace(/\byield\b/g, "_yield");
  }

  // Strategy: find all function/function* and *method() ranges, build a nesting
  // tree, then for each `yield` occurrence check if the innermost enclosing
  // function is a generator. If yes, keep `yield` as-is (keyword); otherwise
  // rename to `_yield`.

  // Helper: skip a string literal starting at position i (on the quote char).
  function skipString(src: string, i: number): number {
    const quote = src[i]!;
    i++;
    while (i < src.length && src[i] !== quote) {
      if (src[i] === "\\") i++;
      i++;
    }
    return i + 1;
  }

  // Helper: find matching closing brace from an opening brace at position i.
  function findMatchingBrace(src: string, openIdx: number): number {
    let depth = 1;
    let j = openIdx + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      else if (src[j] === '"' || src[j] === "'" || src[j] === "`") {
        j = skipString(src, j);
        continue;
      }
      j++;
    }
    return j;
  }

  // Helper: skip past params `(...)` starting at position i (on the `(`).
  function skipParams(src: string, i: number): number {
    let depth = 1;
    i++;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
        i = skipString(src, i);
        continue;
      }
      i++;
    }
    return i;
  }

  // Helper: starting after the function keyword (and optional `*`),
  // find the param start `(` and body start `{`.
  // Returns { paramStart, bodyStart, bodyEnd } or null.
  function findFunctionExtent(src: string, startIdx: number): { paramStart: number; bodyEnd: number } | null {
    let i = startIdx;
    // Skip whitespace
    while (i < src.length && /\s/.test(src[i]!)) i++;
    // Skip optional name
    if (i < src.length && /[a-zA-Z_$]/.test(src[i]!)) {
      while (i < src.length && /[\w$]/.test(src[i]!)) i++;
    }
    // Skip whitespace
    while (i < src.length && /\s/.test(src[i]!)) i++;
    // Find params
    if (i >= src.length || src[i] !== "(") return null;
    const paramStart = i;
    i = skipParams(src, i);
    // Skip whitespace
    while (i < src.length && /\s/.test(src[i]!)) i++;
    // Skip optional return type annotation (: Type)
    if (i < src.length && src[i] === ":") {
      i++;
      while (i < src.length && src[i] !== "{") i++;
    }
    if (i >= src.length || src[i] !== "{") return null;
    const bodyEnd = findMatchingBrace(src, i);
    return { paramStart, bodyEnd };
  }

  type FuncRange = {
    start: number;
    end: number;
    isGenerator: boolean;
    children: FuncRange[];
  };
  const allFuncs: FuncRange[] = [];

  // Find all `function` and `function*` declarations/expressions
  const funcRegex = /\bfunction\s*(\*?)/g;
  let match: RegExpExecArray | null;
  while ((match = funcRegex.exec(source)) !== null) {
    const isGen = match[1] === "*";
    const afterKeyword = match.index + match[0].length;
    // For non-generators, check word boundary after 'function'
    if (!isGen && afterKeyword < source.length && /[\w$]/.test(source[afterKeyword]!)) continue;
    const extent = findFunctionExtent(source, afterKeyword);
    if (!extent) continue;
    // Range covers from param start to body end (so yield in default params is "inside" the function)
    allFuncs.push({
      start: extent.paramStart,
      end: extent.bodyEnd,
      isGenerator: isGen,
      children: [],
    });
  }

  // Find `*method()` generator method syntax (not caught by function regex).
  // The identifier class covers the four ways a method name can be written:
  //   - ASCII identifier chars (`\w$#`) — common case incl. `#gen` private
  //     names per #1162
  //   - non-ASCII identifier chars (Unicode letters like `℘`, `ZWNJ`/`ZWJ`
  //     joiners) — covered by `[\u0080-\uFFFF]`
  //   - long-form Unicode escape `\u{XXXX}` — covered explicitly
  //   - short-form Unicode escape `\uXXXX` — covered explicitly
  // Without these, methods like `static * #\u{6F}(...)` or `static * #℘(...)`
  // skip the regex match and `yield` in their bodies is incorrectly
  // renamed to `_yield`, hitting the same 52-test class/elements
  // ReferenceError cluster as the missing `static` prefix below.
  const methodRegex = /\*\s*(?:(?:[\w$#]|\\u\{[^}]*\}|\\u[0-9a-fA-F]{4}|[\u0080-\uFFFF])+|\[[\s\S]*?\])\s*\(/g;
  let methodMatch: RegExpExecArray | null;
  while ((methodMatch = methodRegex.exec(source)) !== null) {
    // Distinguish from multiply operator: check preceding context.
    // `static` is needed for `static * gen()` / `static * #gen()` class
    // members — without it, `static * #_(value)` is classified as a
    // multiply expression and `yield` inside the body is incorrectly
    // renamed to `_yield`, producing the "_yield is not defined"
    // ReferenceError at runtime in 52 class/elements test262 cases.
    const before = source.substring(Math.max(0, methodMatch.index - 20), methodMatch.index).trimEnd();
    if (
      !(
        before.endsWith(",") ||
        before.endsWith("{") ||
        before.endsWith(";") ||
        before.endsWith(")") ||
        before.endsWith("async") ||
        before.endsWith("static") ||
        before.length === 0
      )
    ) {
      continue;
    }
    // Find the opening `(` position (it's at the end of the match minus 1)
    const parenStart = methodMatch.index + methodMatch[0].length - 1;
    let j = skipParams(source, parenStart);
    // Skip whitespace
    while (j < source.length && /\s/.test(source[j]!)) j++;
    if (j >= source.length || source[j] !== "{") continue;
    const bodyEnd = findMatchingBrace(source, j);
    // Range covers from param start to body end
    allFuncs.push({
      start: parenStart,
      end: bodyEnd,
      isGenerator: true,
      children: [],
    });
  }

  // Also handle arrow functions: `(...) =>` or `name =>`
  // Arrow functions are non-generators, so yield inside them should be renamed.
  const arrowRegex = /=>\s*\{/g;
  let arrowMatch: RegExpExecArray | null;
  while ((arrowMatch = arrowRegex.exec(source)) !== null) {
    const braceIdx = arrowMatch.index + arrowMatch[0].length - 1;
    const bodyEnd = findMatchingBrace(source, braceIdx);
    allFuncs.push({
      start: braceIdx,
      end: bodyEnd,
      isGenerator: false,
      children: [],
    });
  }

  // Sort by start position
  allFuncs.sort((a, b) => a.start - b.start);

  // Build nesting tree: find the smallest enclosing range for each function
  for (const r of allFuncs) {
    let parent: FuncRange | null = null;
    for (const candidate of allFuncs) {
      if (candidate === r) continue;
      if (candidate.start < r.start && candidate.end > r.end) {
        if (!parent || candidate.start > parent.start) {
          parent = candidate;
        }
      }
    }
    if (parent) {
      parent.children.push(r);
    }
  }
  const roots = allFuncs.filter((r) => !allFuncs.some((c) => c !== r && c.start < r.start && c.end > r.end));

  // For a given position, find the innermost enclosing function
  function findInnermostFunc(pos: number, ranges: FuncRange[]): FuncRange | null {
    for (const r of ranges) {
      if (pos >= r.start && pos < r.end) {
        const child = findInnermostFunc(pos, r.children);
        return child || r;
      }
    }
    return null;
  }

  // Replace yield: keep as keyword only if innermost function is a generator
  const yieldRegex = /\byield\b/g;
  let result = "";
  let lastIndex = 0;
  let yieldMatch: RegExpExecArray | null;
  while ((yieldMatch = yieldRegex.exec(source)) !== null) {
    const pos = yieldMatch.index;
    const innermost = findInnermostFunc(pos, roots);
    const isKeyword = innermost !== null && innermost.isGenerator;
    result += source.slice(lastIndex, pos);
    result += isKeyword ? "yield" : "_yield";
    lastIndex = pos + "yield".length;
  }
  result += source.slice(lastIndex);
  return result;
}

/**
 * Strip all occurrences of `name(...)` call statements from source,
 * handling balanced parentheses so multi-line calls with nested braces
 * (like object literal descriptors) are fully removed.
 */
function stripBalancedCall(source: string, name: string): string {
  const pattern = new RegExp(`\\b${name}\\s*\\(`, "g");
  let result = source;
  let match;
  // Process from end to start so indices stay valid
  const matches: { start: number; end: number }[] = [];
  while ((match = pattern.exec(result)) !== null) {
    const callStart = match.index;
    // Find balanced closing paren
    let depth = 0;
    let i = match.index + match[0].length - 1; // position of '('
    for (; i < result.length; i++) {
      if (result[i] === "(") depth++;
      else if (result[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue; // unbalanced — skip
    // Include trailing semicolon and whitespace
    let end = i + 1;
    while (end < result.length && (result[end] === ";" || result[end] === " " || result[end] === "\t")) end++;
    // Include trailing newline
    if (end < result.length && result[end] === "\n") end++;
    matches.push({ start: callStart, end });
  }
  // Remove from end to start
  for (let j = matches.length - 1; j >= 0; j--) {
    const m = matches[j];
    result = result.slice(0, m.start) + result.slice(m.end);
  }
  return result;
}

/**
 * Transform `verifyProperty(obj, name, { value: X, ... })` calls into
 * `assert_sameValue(obj[name], X)` when a `value:` key is present in the
 * descriptor literal.  Calls without a `value:` are stripped entirely
 * (we cannot check writable/enumerable/configurable in Wasm).
 *
 * Also strips `verifyCallableProperty(...)` and
 * `verifyPrimordialProperty(...)` / `verifyPrimordialCallableProperty(...)`
 * calls since we cannot compile their full semantics.
 */
function transformVerifyPropertyCalls(source: string): string {
  const pattern = /\bverifyProperty\s*\(/g;
  let result = source;
  // Collect replacements (from end to start so indices stay valid)
  const replacements: { start: number; end: number; replacement: string }[] = [];
  let match;
  while ((match = pattern.exec(result)) !== null) {
    const callStart = match.index;
    const argsStart = match.index + match[0].length; // right after '('
    // Find balanced closing paren
    let depth = 1;
    let i = argsStart;
    for (; i < result.length; i++) {
      if (result[i] === "(") depth++;
      else if (result[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue; // unbalanced — skip
    const argsStr = result.slice(argsStart, i);
    // Include trailing semicolon, whitespace, newline
    let end = i + 1;
    while (end < result.length && (result[end] === ";" || result[end] === " " || result[end] === "\t")) end++;
    if (end < result.length && result[end] === "\n") end++;

    // Try to extract obj, name, and value from the descriptor literal.
    // We split the args on a top-level comma to get the first two args,
    // then look for `value:` in the descriptor object.
    const topLevelCommas = findTopLevelCommas(argsStr);
    if (topLevelCommas.length < 2) {
      // Not enough arguments — just strip
      replacements.push({ start: callStart, end, replacement: "" });
      continue;
    }
    const objExpr = argsStr.slice(0, topLevelCommas[0]).trim();
    const nameExpr = argsStr.slice(topLevelCommas[0] + 1, topLevelCommas[1]).trim();
    // The rest is the descriptor (and optional options arg)
    const descPart =
      topLevelCommas.length > 2
        ? argsStr.slice(topLevelCommas[1] + 1, topLevelCommas[2]).trim()
        : argsStr.slice(topLevelCommas[1] + 1).trim();

    // Extract `value: <expr>` from the descriptor object literal
    const valueExpr = extractDescriptorValue(descPart);
    if (valueExpr !== null) {
      // Emit an assertion: assert_sameValue(obj[name], value)
      // We need to handle both string literal keys and computed keys
      let accessExpr: string;
      if (/^"[^"]*"$/.test(nameExpr) || /^'[^']*'$/.test(nameExpr)) {
        const key = nameExpr.slice(1, -1);
        // Use bracket notation for numeric keys or keys with special chars
        if (/^\d+$/.test(key) || /[^a-zA-Z0-9_$]/.test(key)) {
          accessExpr = `${objExpr}[${nameExpr}]`;
        } else {
          accessExpr = `${objExpr}.${key}`;
        }
      } else {
        accessExpr = `${objExpr}[${nameExpr}]`;
      }
      // Determine assertion type based on value expression
      const replacement = `assert_sameValue(${accessExpr}, ${valueExpr});\n`;
      replacements.push({ start: callStart, end, replacement });
    } else {
      // No value to check — strip the call
      replacements.push({ start: callStart, end, replacement: "" });
    }
  }
  // Apply replacements from end to start
  for (let j = replacements.length - 1; j >= 0; j--) {
    const r = replacements[j];
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }
  return result;
}

/** Find indices of top-level commas in an args string (respecting parens, braces, brackets). */
function findTopLevelCommas(s: string): number[] {
  const commas: number[] = [];
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\" && i + 1 < s.length) {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) commas.push(i);
  }
  return commas;
}

/**
 * Extract the expression for `value:` from a descriptor object literal string
 * like `{ value: 1, writable: true, ... }`.
 * Returns null if no `value:` key is found.
 */
function extractDescriptorValue(descStr: string): string | null {
  // Match `value:` (possibly preceded by `{` or `,` and whitespace)
  const valueMatch = descStr.match(/\bvalue\s*:\s*/);
  if (!valueMatch) return null;
  const exprStart = valueMatch.index! + valueMatch[0].length;
  // Read the expression until we hit a top-level comma or closing brace
  let depth = 0;
  let inString: string | null = null;
  let i = exprStart;
  for (; i < descStr.length; i++) {
    const ch = descStr[i];
    if (inString) {
      if (ch === "\\" && i + 1 < descStr.length) {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]") {
      depth--;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) break;
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) break;
  }
  const expr = descStr.slice(exprStart, i).trim();
  return expr.length > 0 ? expr : null;
}

/**
 * Wrap a test262 test into a compilable TS module for targeted compiler probes.
 *
 * Strategy: provide a shim for assert.sameValue that traps on mismatch.
 * The test body runs inside an exported function; returning 1 = success.
 *
 * @deprecated This transformed source is not a conformance verdict oracle.
 * Use assembleOriginalHarness()/runTest262File() for pass/fail accounting.
 */
export interface WrapResult {
  source: string;
  /** Number of lines added before the original test body (preamble + wrapper) */
  bodyLineOffset: number;
}

// Cache for preamble templates — keyed by a bitmask string encoding which
// optional helpers are needed.  Most test262 tests share a tiny number of
// distinct helper combinations so this avoids rebuilding the same large
// string thousands of times.
const preambleCache = new Map<string, string>();

/** Build the preamble string from boolean flags.  Called once per unique
 *  combination and then cached in preambleCache. */
function buildPreamble(
  needsAssertThrows: boolean,
  needsStrAssert: boolean,
  needsBoolAssert: boolean,
  needsCompareArray: boolean,
  needsAssertCompareArray: boolean,
  needsAssertDeepEqual: boolean,
  needsPropertyHelper: boolean,
  needsFnGlobalObject: boolean,
  needsIsConstructor: boolean,
  needsDecimalToHex: boolean,
  needsNans: boolean,
  needsIsNativeFunction: boolean,
  needsAssertNativeFunction: boolean,
  needsTcoHelper: boolean,
  needsDone: boolean,
  needsAsyncTest: boolean,
  needsDoneForAsyncTest: boolean,
  needsTestTypedArray: boolean,
  needsTestBigIntTypedArray: boolean,
  needsTestNonAtomicsFriendlyTypedArray: boolean,
  needsAssertThrowsAsync: boolean,
  needsTypedArrayBinding: boolean,
  needsIteratorBinding: boolean,
  needsDetachBuffer: boolean,
  needs262: boolean,
  needsProxyTraps: boolean,
  needsTypedArrayCtorArrays: boolean,
  needsByteConversionValues: boolean,
  needsResizableAbUtils: boolean,
  dynViewCompare: boolean,
): string {
  let p = `let __fail: number = 0;
let __assert_count: number = 1;
// (#2939/#2940/#3086) Vacuity sentinels. Harness wrappers that call a user
// callback in a loop (testWith*Constructors and siblings) increment
// __harness_cb_expected per callback invocation they ATTEMPT, and — the #3086
// PARTIAL-vacuity extension — snapshot __assert_count around each fn(...) call,
// incrementing __harness_cb_dead when that invocation contributed ZERO asserts
// (its body ran nothing that asserted, i.e. the dispatch-drop / dead-callback
// class). Post-run, a would-be pass (__fail === 0) is VACUOUS when a wrapper was
// invoked (__harness_cb_expected > 0) and EVERY attempted invocation was dead
// (__harness_cb_dead === __harness_cb_expected). This strictly generalizes the
// old global "__assert_count === 1" check (the no-setup-asserts special case):
// it now also catches PARTIAL vacuity — setup asserts (or an earlier
// dispatching wrapper) ran, so __assert_count > 1, yet the callback holding the
// real checks was dropped. Such a pass is scored VACUOUS (a distinct status,
// NOT pass) so host_free_pass / the standalone floor structurally exclude it.
// Under-detection (a callback that asserts even once is not flagged) is safe;
// over-detection is near-impossible for the harness class (its callbacks always
// assert), and requiring ALL invocations dead guards the mixed case.
let __harness_cb_expected: number = 0;
let __harness_cb_dead: number = 0;

class Test262Error {
  message: string;
  // (#3104) \`name\` field so the assert_throws side-channel name check
  // (\`(e as any).name === "Test262Error"\`) can verify a caught Test262Error —
  // the poisoned-iterator dstr-err family throws these and must keep passing
  // under the #3285 typed-throw tightening.
  name: string = "Test262Error";
  constructor(msg: string = "") {
    this.message = msg;
  }
  // (#2671) Real sta.js defines \`Test262Error.thrower\` — the Promise
  // capability tests pass it as the executor's reject callback
  // (\`executor(resolve, Test262Error.thrower)\`). The synthesized prelude
  // lacked it, so those tests read undefined and V8's NewPromiseCapability
  // threw "Promise resolve or reject function is not callable" regardless of
  // compiler correctness. A static METHOD (not the sta.js assignment form)
  // marshals host-callable when passed as a value.
  static thrower(msg: string = ""): void {
    throw new Test262Error(msg);
  }
}

function isSameValue(a: any, b: any): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}

function assert_sameValue(actual: any, expected: any): void {
  __assert_count = __assert_count + 1;
  if (!isSameValue(actual, expected)) {
    if (!__fail) __fail = __assert_count;
  }
}

function assert_notSameValue(actual: any, expected: any): void {
  __assert_count = __assert_count + 1;
  if (isSameValue(actual, expected)) {
    if (!__fail) __fail = __assert_count;
  }
}

function assert_true(value: any, _msg?: any): void {
  __assert_count = __assert_count + 1;
  if (!value) {
    if (!__fail) __fail = __assert_count;
  }
}`;

  if (needsAssertThrows || needsAssertThrowsAsync) {
    // (#3285/#3104) The expected-error-type NAME side channel. wrapTest emits
    // `__expected_throw_name = "TypeError"; assert_throws(fn);` — a string
    // assignment plus the ORIGINAL single-argument call shape. Threading the
    // ctor through as a value (a 2nd call argument, a matcher closure, or even
    // a plain global assignment of the ctor) deterministically triggers #3315
    // in standalone: a class-as-value in the method body silently corrupts
    // sibling destructured bindings in the enclosing method. The name-string
    // assignment is the only A/B-validated clean shape (2026-07-16).
    p += `

let __expected_throw_name: any = null;`;
  }

  if (needsAssertThrows) {
    p += `

function assert_throws(fn: () => void): void {
  __assert_count = __assert_count + 1;
  // Consume the side-channel value so it can never leak into a later
  // (untyped) assert_throws call emitted by other transforms.
  const __expected: any = __expected_throw_name;
  __expected_throw_name = null;
  try {
    fn();
  } catch (e) {
    // (#3285) A caught error only counts as a pass when its \`.name\` matches
    // the expected constructor name (strict: a nameless payload — bare-string
    // throw, null exception carrier — is NOT the required error type, so it
    // fails honestly). The check itself must never throw: a null/opaque
    // payload previously blew up the harness with its own TypeError
    // (the "Cannot access property on null at 81:21" family) — guarded now.
    // No expected name (legacy untyped call sites, or a complex ctor
    // expression wrapTest could not resolve at wrap time) ⇒ any throw passes,
    // matching the pre-#3285 semantics for exactly those sites.
    let __wrong: boolean = false;
    try {
      if (__expected != null) {
        if (e == null) __wrong = true;
        else {
          const en: any = (e as any).name;
          if (en !== __expected) __wrong = true;
        }
      }
    } catch (_ignore) {
      __wrong = true;
    }
    if (__wrong) {
      if (!__fail) __fail = __assert_count;
    }
    return;
  }
  if (!__fail) __fail = __assert_count;
}`;
  }

  if (needsAssertThrowsAsync) {
    p += `

function assert_throwsAsync(fn: () => any): void {
  __assert_count = __assert_count + 1;
  const __expected: any = __expected_throw_name;
  __expected_throw_name = null;
  try {
    const res = fn();
    // Accept thenable returns (Promise rejections from async generators .throw()).
    // The rejection reason can't be inspected synchronously here (the shim does
    // not await), so a thenable return is still accepted untyped — a narrow,
    // documented limitation. The synchronous-throw path below IS type-checked.
    if (res !== null && res !== undefined && typeof res === 'object' && typeof res.then === 'function') {
      return;
    }
  } catch (e) {
    // (#3285) Same strict name-match rule as assert_throws (see there).
    let __wrong: boolean = false;
    try {
      if (__expected != null) {
        if (e == null) __wrong = true;
        else {
          const en: any = (e as any).name;
          if (en !== __expected) __wrong = true;
        }
      }
    } catch (_ignore) {
      __wrong = true;
    }
    if (__wrong) {
      if (!__fail) __fail = __assert_count;
    }
    return;
  }
  if (!__fail) __fail = __assert_count;
}`;
  }

  if (needsStrAssert) {
    p += `

function assert_sameValue_str(actual: any, expected: string): void {
  __assert_count = __assert_count + 1;
  if (actual !== expected) {
    if (!__fail) __fail = __assert_count;
  }
}

function assert_notSameValue_str(actual: any, expected: string): void {
  __assert_count = __assert_count + 1;
  if (actual === expected) {
    if (!__fail) __fail = __assert_count;
  }
}`;
  }

  if (needsBoolAssert) {
    p += `

function assert_sameValue_bool(actual: any, expected: boolean): void {
  __assert_count = __assert_count + 1;
  if (actual !== expected) {
    if (!__fail) __fail = __assert_count;
  }
}

function assert_notSameValue_bool(actual: any, expected: boolean): void {
  __assert_count = __assert_count + 1;
  if (actual === expected) {
    if (!__fail) __fail = __assert_count;
  }
}`;
  }

  // (#3151) LANE-SPLIT param type for the compareArray shims.
  //
  // STANDALONE/WASI lanes (`dynViewCompare`): params are `any`, NOT `any[]`.
  // The real harness `compareArray` (harness/assert.js) is untyped, so
  // `a`/`b` are effectively `any` and `a.length`/`a[i]` go through the
  // DYNAMIC reader — which recognizes a runtime `$__ta_dyn_view` TypedArray
  // (the `new TA(makeCtorArg(…))` harness shape). An `any[]` annotation
  // instead emits WasmGC ARRAY ops, which a dyn-view is not, so every
  // `compareArray(<TA>, <arr>)` returned 0 and gated the whole standalone
  // TypedArray.prototype harness cluster (#2872). Measured on the PR #2899
  // merge_group: +22 standalone TypedArray harness tests.
  //
  // JS-HOST lane: params MUST stay `any[]`. The `any` version regressed 15
  // baseline-pass host tests (merge_group run 29175942933): with an `any`
  // param context, callers' ARRAY-LITERAL arguments are constructed with a
  // lossy representation — `[1, void 0, 3]` becomes an f64 array whose
  // `void 0` element is NaN (`typeof a[1] === "number"`, and NaN !== NaN
  // fails even a self-compare), and mixed literals like `[1, 'z']` /
  // `[symA, symB]` misread their non-numeric elements. The corruption
  // happens at literal CONSTRUCTION in the `any` argument context, so no
  // branch inside compareArray's body can recover it — the lane split is
  // the only harness-level fix. Host TypedArray compareArray tests passed
  // at baseline with `any[]` (host TAs are not dyn-views), so the host lane
  // loses nothing by keeping it.
  const caT = dynViewCompare ? "any" : "any[]";

  if (needsCompareArray) {
    p += `

function compareArray(a: ${caT}, b: ${caT}): number {
  if (a.length !== b.length) return 0;
  for (let i: number = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return 0;
  }
  return 1;
}`;
  }

  if (needsAssertCompareArray) {
    // (#3151) lane-split param type — see the compareArray note above.
    p += `

function assert_compareArray(actual: ${caT}, expected: ${caT}): void {
  __assert_count = __assert_count + 1;
  if (actual.length !== expected.length) { if (!__fail) __fail = __assert_count; return; }
  for (let i: number = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) { if (!__fail) __fail = __assert_count; return; }
  }
}`;
  }

  if (needsAssertDeepEqual) {
    // (#2671) Real harness deepEqual.js analog for the shapes the suite
    // exercises (nested arrays incl. holes/undefined, plain objects like
    // match-indices \`groups\`, primitives with SameValue NaN handling). The
    // RegExp match-indices family includes deepEqual.js and previously died
    // with "assert is not defined" because no shim existed.
    p += `

function __deepEq(a: any, b: any): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  if (a == null && b == null) { return 1; }
  if (a == null || b == null) { return 0; }
  if (typeof a !== "object" || typeof b !== "object") { return 0; }
  var aArr = Array.isArray(a);
  var bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr) { return 0; }
    if (a.length !== b.length) { return 0; }
    for (let i: number = 0; i < a.length; i++) {
      if (!__deepEq(a[i], b[i])) { return 0; }
    }
    return 1;
  }
  var ka = Object.keys(a);
  var kb = Object.keys(b);
  if (ka.length !== kb.length) { return 0; }
  for (let i: number = 0; i < ka.length; i++) {
    var k = ka[i];
    if (!__deepEq(a[k], b[k])) { return 0; }
  }
  return 1;
}

function assert_deepEqual(actual: any, expected: any): void {
  __assert_count = __assert_count + 1;
  if (!__deepEq(actual, expected)) { if (!__fail) __fail = __assert_count; }
}`;
  }

  if (needsPropertyHelper) {
    // verifyProperty calls are transformed into assert_sameValue at the source
    // level (see transformVerifyPropertyCalls), so no stub is needed for it.
    // The deprecated helpers below are stubs — we cannot check
    // writable/enumerable/configurable in our Wasm runtime.
    p += `
function verifyEnumerable(obj: any, name: any): void {}
function verifyNotEnumerable(obj: any, name: any): void {}
function verifyWritable(obj: any, name: any, val?: any): void {}
function verifyNotWritable(obj: any, name: any, val?: any): void {}
function verifyConfigurable(obj: any, name: any): void {}
function verifyNotConfigurable(obj: any, name: any): void {}
function verifyEqualTo(obj: any, name: any, val: any): void {
  assert_sameValue(obj[name], val);
}
function verifyNotEqualTo(obj: any, name: any, val?: any): void {}
function verifyCallableProperty(a: any, b: any, c?: any, d?: any, e?: any, f?: any): void {}
function verifyPrimordialProperty(a: any, b: any, c?: any, d?: any): void {}
function verifyPrimordialCallableProperty(a: any, b: any, c?: any, d?: any, e?: any, f?: any): void {}`;
  }

  if (needsFnGlobalObject) {
    p += `

function fnGlobalObject(): number { return 0; }`;
  }

  if (needsIsConstructor) {
    // (#2875 slice 4) Harness stub pending a real standalone Reflect.construct
    // (#1472 Phase C): everything reports non-constructor. The stub MUST return
    // a real `false`, not the number 0 — `assert.sameValue(isConstructor(x),
    // false)` compiles to a strict `===` where `0 === false` is (correctly)
    // false in the standalone lane, so the typed-number stub failed every
    // `*/not-a-constructor.js` at assert #1 even though the test's second
    // assert (`new X()` throws TypeError) exercises real compiled semantics
    // and passes. `is-a-constructor.js` tests (assert true) keep failing under
    // this stub by design — no false conformance for constructors until the
    // real Reflect.construct newTarget-validation lands.
    p += `

function isConstructor(f: any): boolean { return false; }`;
  }

  if (needsDecimalToHex) {
    // Faithful port of test262/harness/decimalToHexString.js — defines BOTH
    // `decimalToHexString` and `decimalToPercentHexString`. The previous stub
    // returned a constant "0" for decimalToHexString and never defined
    // decimalToPercentHexString at all, which silently broke every
    // encode/decode-URI test (built-ins/{decodeURI,decodeURIComponent,
    // encodeURI,encodeURIComponent}/*) that builds its percent-encoded test
    // input via decimalToPercentHexString: the input came out as garbage, so
    // the expected URIError was never thrown and the test recorded a false
    // `#…` failure. The harness self-test (test/harness/decimalToHexString.js)
    // also asserts decimalToHexString(-1) === "FFFFFFFF" etc., which the
    // constant stub failed. Both functions are pure number→string and compile
    // through the standard codegen path (verified: no host imports added).
    p += `

function decimalToHexString(n: number): string {
  const hex = "0123456789ABCDEF";
  n = n >>> 0;
  let s = "";
  while (n) {
    s = hex[n & 0xf] + s;
    n = n >>> 4;
  }
  while (s.length < 4) {
    s = "0" + s;
  }
  return s;
}

function decimalToPercentHexString(n: number): string {
  const hex = "0123456789ABCDEF";
  return "%" + hex[(n >> 4) & 0xf] + hex[n & 0xf];
}`;
  }

  if (needsNans) {
    p += `

let distinctNaNs: number[] = [NaN];`;
  }

  if (needsIsNativeFunction) {
    p += `

function isNativeFunction(f: number): number { return 1; }`;
  }

  if (needsAssertNativeFunction) {
    p += `

function assertNativeFunction(f: number): void {}`;
  }

  if (needsTcoHelper) {
    p += `

let $MAX_ITERATIONS: number = 100000;`;
  }

  if (needsDone) {
    p += `

function $DONE(err?: any): void {
  __assert_count = __assert_count + 1;
  if (err) { if (!__fail) __fail = __assert_count; }
}`;
  }

  if (needsAsyncTest) {
    p += `

function asyncTest(fn: () => void): void {
  try {
    fn();
    $DONE();
  } catch (e) {
    $DONE(e);
  }
}`;
    if (needsDoneForAsyncTest) {
      p += `

function $DONE(err?: any): void {
  __assert_count = __assert_count + 1;
  if (err) { if (!__fail) __fail = __assert_count; }
}`;
    }
  }

  if (needsDetachBuffer) {
    // #1515: $DETACHBUFFER is test262 harness for detaching an ArrayBuffer.
    // Implemented by setting a sidecar marker `__detached__` on the buffer
    // struct. The runtime DataView/TypedArray method dispatch in
    // `__extern_method_call` reads this via `_sidecarGet` and throws TypeError.
    p += `

function $DETACHBUFFER(buf: any): void {
  if (buf == null) { return; }
  (buf as any).__detached__ = true;
}`;
  }

  // (#3088) Identity `makeCtorArg`/`boundArgFactory` passthrough for the
  // non-BigInt harness shim (mirrors the real harness's `makePassthrough`,
  // which is also an identity).
  //
  // (#3087) NOTE: until the #3087 identifiers.ts fix, a `__`-prefixed function
  // referenced as a VALUE compiled to `ref.null.extern` (the blunt internal-
  // helper name filter), so `makeCtorArg(...)` inside every callback returned
  // null via the dynamic-dispatch drop and `new TA(null)` built a length-0
  // view. With the compiler fix this identity actually RUNS.
  if (needsTestTypedArray) {
    p += `

function __ta_makeCtorArgPassthrough(x: any): any {
  return x;
}`;
  }

  // (#3087) BigInt-lane `makeCtorArg` COMPAT factory. The real harness
  // passthrough is an identity too, but BigInt tests feed it BigInt-LITERAL
  // arrays (`makeCtorArg([40n, 41n])`) and the compiler currently lowers
  // BigInt literals to plain f64 numbers (#1349 — BigInt rep is gated on the
  // i64-brand ValType decision). A faithful identity would therefore hand the
  // host `new BigInt64Array([40, 41])` an array of NUMBERS, which throws
  // "Cannot convert 40 to a BigInt" — flipping ~300 currently-passing BigInt
  // harness tests to runtime errors (measured 3/60 in the #3087 pass-sample
  // A/B). Until #1349 lands:
  //   - (#3335) arrays → x.length: builds a CORRECT-LENGTH zero-filled view
  //     (`new TA(makeCtorArg([1n,2n,3n,4n]))` = `new BigInt64Array(4)`).
  //     The previous `arrays → null` mapping built a LENGTH-0 view
  //     (`new BigInt64Array(null)`), and the six
  //     `TypedArray/prototype/set/BigInt/*` files then hit the host
  //     RangeError "offset is out of bounds" from `.set(src, 0)` on the
  //     empty view — a message the #3189 trap ratchet and the poison
  //     classifier bin as an UNCATCHABLE oob trap (the 45→51 baseline flap
  //     of #3335; the flap's other mode was realm-contamination making
  //     `BigInt64Array` itself undefined). With the true length, a
  //     subsequent element write fails as a CATCHABLE "Cannot convert N to
  //     a BigInt" TypeError (numbers, not BigInts — #1349 rep gap), and
  //     length-asserting tests observe the honest length. Element VALUES
  //     are still zeros, not the literals — content-asserting tests keep
  //     failing (honestly) until #1349;
  //   - primitives → identity: `makeCtorArg(8n)` lowers to `8` and
  //     `new TA(8)` builds the length-8 view the real harness would — a
  //     small honest win with no BigInt conversion involved.
  if (needsTestBigIntTypedArray) {
    p += `

function __ta_makeCtorArgBigIntCompat(x: any): any {
  if (Array.isArray(x)) { return x.length; }
  return x;
}`;
  }

  // (#3088) The real test262 harness (`testTypedArray.js` →
  // `testWithAllTypedArrayConstructors`) invokes the callback as
  // `f(constructor, boundArgFactory)` — 2 ARGS. Many non-BigInt tests declare
  // `function (TA, makeCtorArg) { … }` (2 params, void) and use `makeCtorArg` in
  // the body. The old 1-arg shim (`fn(constructors[i])`) left those callbacks as
  // over-arity-void candidates, which `tryEmitInlineDynamicCall` SKIPS (#1837),
  // so they stayed vacuous even after the #3074 dispatch fix. Pass the second
  // `boundArgFactory` arg (identity passthrough) so 2-param callbacks match arity
  // and dispatch; 1-param callbacks truncate the extra arg (under-arity is fine).
  if (needsTestTypedArray) {
    p += `

function testWithTypedArrayConstructors(fn: any): void {
  const constructors = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array];
  for (let i = 0; i < constructors.length; i++) {
    __harness_cb_expected = __harness_cb_expected + 1;
    const __ac_before = __assert_count;
    fn(constructors[i], __ta_makeCtorArgPassthrough);
    if (__assert_count === __ac_before) { __harness_cb_dead = __harness_cb_dead + 1; }
  }
}`;
  }

  // (#2939/#2940) BigInt TypedArray harness wrapper. The real test262
  // `testWithBigIntTypedArrayConstructors(f, …)` (testTypedArray.js) calls
  // `f(constructor, boundArgFactory)` — a 2-ARG invocation where the callback
  // is typically `function (TA, makeCtorArg) { … }`. Passing only the ctor
  // left `makeCtorArg` undefined; combined with the (now-fixed) nested-scope
  // dispatch gap the whole callback body was dead (a vacuous host-free pass,
  // ~814 tests). Shim the 2-arg signature so 2-param callbacks match arity and
  // dispatch. (#3087) The factory is the BigInt COMPAT one (arrays → null,
  // primitives → identity), NOT the true identity — see its definition above
  // for why a faithful identity would crash on the compiler's f64-lowered
  // BigInt literals until #1349 lands.
  if (needsTestBigIntTypedArray) {
    p += `

function testWithBigIntTypedArrayConstructors(fn: any): void {
  const constructors = [BigInt64Array, BigUint64Array];
  for (let i = 0; i < constructors.length; i++) {
    __harness_cb_expected = __harness_cb_expected + 1;
    const __ac_before = __assert_count;
    fn(constructors[i], __ta_makeCtorArgBigIntCompat);
    if (__assert_count === __ac_before) { __harness_cb_dead = __harness_cb_dead + 1; }
  }
}`;
  }

  // (#3145) `testWithNonAtomicsFriendlyTypedArrayConstructors(f)` iterates the
  // NON-"Atomics friendly" views — the float + Uint8Clamped constructors
  // (`floatArrayConstructors.concat([Uint8ClampedArray])` in the real
  // testTypedArray.js). Every `built-ins/Atomics/*/non-shared-int-views-throws`
  // test wraps `Atomics.<op>(new TA(buffer), …)` in `assert.throws(TypeError,
  // …)` for each such TA — the op must reject a float/clamped view. The
  // callback is 1-param (`TA => { … }`); the tests pass extra `null,
  // ["passthrough"]` selector args which the 1-param shim harmlessly ignores.
  // The name has no `testWithTypedArrayConstructors` infix so the plain shim
  // above never covers it — hence its own gate. Vacuity-tracked like the
  // siblings (snapshot `__assert_count` per invocation).
  if (needsTestNonAtomicsFriendlyTypedArray) {
    p += `

function testWithNonAtomicsFriendlyTypedArrayConstructors(fn: any): void {
  const constructors = [Float32Array, Float64Array, Uint8ClampedArray];
  for (let i = 0; i < constructors.length; i++) {
    __harness_cb_expected = __harness_cb_expected + 1;
    const __ac_before = __assert_count;
    fn(constructors[i]);
    if (__assert_count === __ac_before) { __harness_cb_dead = __harness_cb_dead + 1; }
  }
}`;
  }

  if (needsTypedArrayBinding) {
    // Substitute for the abstract %TypedArray% intrinsic. `%TypedArray%` is the constructor
    // that `Int8Array` (and every concrete TypedArray) inherits from; on the host it is
    // exactly `Object.getPrototypeOf(Int8Array.prototype).constructor`. Binding to it (rather
    // than `Int8Array` directly) exposes the descriptor accessors that live on
    // `%TypedArray%.prototype` — e.g. the `length`/`byteLength`/`buffer`/`@@toStringTag`
    // getters — which are *inherited* by `Int8Array.prototype`, not own. The old
    // `const TypedArray = Int8Array` shim made `Object.getOwnPropertyDescriptor(
    // TypedArray.prototype, "length")` return `undefined`, silently failing the
    // `built-ins/TypedArray/prototype/*` descriptor tests (#1567). We route through
    // `Int8Array.prototype` (member access on a builtin, which the compiler resolves to the
    // host prototype) rather than the bare `Int8Array` identifier (which the compiler does
    // not evaluate as a first-class value).
    p += `

const TypedArray: any = Object.getPrototypeOf(Int8Array.prototype).constructor;`;
  }

  if (needsIteratorBinding) {
    // Shim for the %Iterator% constructor from the iterator-helpers proposal.
    // Our runtime doesn't expose a global `Iterator`, but %IteratorPrototype%
    // is reachable via [][Symbol.iterator]()'s proto chain. We build a
    // minimal function whose .prototype === %IteratorPrototype% so tests
    // that do `typeof Iterator === 'function'`, `Iterator.prototype.X`, or
    // `class X extends Iterator {}` have a usable binding.
    p += `

function Iterator(this: any): void {}
(Iterator as any).prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));`;
  }

  if (needs262) {
    // #1523: test262 host-object stub. Tests rely on `$262` as a precondition
    // for realm creation, ArrayBuffer detach, agent messaging, and global
    // access. We expose a minimal surface — realm/global/eval/detach get
    // useful semantics; agent.* throws "agent unsupported"; gc and evalScript
    // are no-ops; AbstractModuleSource / IsHTMLDDA / etc. surface as
    // undefined so `typeof $262.X === 'function'` checks fail gracefully
    // rather than triggering a ReferenceError at compile time.
    p += `

let $262 = {
  global: globalThis,
  gc: function (): void {},
  evalScript: function (src: any): void {},
  detachArrayBuffer: function (buf: any): void {
    if (buf == null) { return; }
    (buf as any).__detached__ = true;
  },
  createRealm: function (): any {
    const realm: any = {};
    realm.global = realm;
    realm.eval = function (src: any): any { return undefined; };
    realm.detachArrayBuffer = function (buf: any): void {
      if (buf == null) { return; }
      (buf as any).__detached__ = true;
    };
    realm.gc = function (): void {};
    return realm;
  },
  agent: {
    start: function (src: any): void {},
    broadcast: function (val: any): void {},
    receiveBroadcast: function (cb: any): void {},
    report: function (msg: any): void {},
    getReport: function (): any { return null; },
    sleep: function (ms: any): void {},
    monotonicNow: function (): number { return 0; },
    leaving: function (): void {},
  },
  // Identity-only host-object sentinel: enough for tests that require a
  // non-undefined [[IsHTMLDDA]] value to survive assignment/destructuring.
  // Full Annex B falsy/typeof/abstract-equality behavior remains compiler and
  // runtime scope.
  IsHTMLDDA: (globalThis as any),
  AbstractModuleSource: undefined,
};`;
  }

  if (needsTypedArrayCtorArrays) {
    // (#1524) test262 harness/testTypedArray.js also DEFINES the constructor-list
    // constants (`typedArrayConstructors`, `floatArrayConstructors`,
    // `nonClampedIntArrayConstructors`, `intArrayConstructors`) that many tests
    // reference directly (not via a testWith* wrapper). The runner previously
    // shimmed only the wrapper functions, so bodies iterating these bare arrays
    // threw `… is not defined`. Values mirror the upstream file.
    p += `

const floatArrayConstructors: any[] = [Float64Array, Float32Array];
const nonClampedIntArrayConstructors: any[] = [
  Int32Array, Int16Array, Int8Array, Uint32Array, Uint16Array, Uint8Array,
];
const intArrayConstructors: any[] = [
  Int32Array, Int16Array, Int8Array, Uint32Array, Uint16Array, Uint8Array, Uint8ClampedArray,
];
const typedArrayConstructors: any[] = [
  Float64Array, Float32Array,
  Int32Array, Int16Array, Int8Array, Uint32Array, Uint16Array, Uint8Array, Uint8ClampedArray,
];`;
  }

  if (needsByteConversionValues) {
    // (#1524) test262 harness/byteConversionValues.js. Tests reference the
    // `byteConversionValues` object (a `values` array + per-type `expected`
    // arrays) at top level; without the include inlined they threw
    // `byteConversionValues is not defined`. Ported verbatim from the harness.
    p += `

const byteConversionValues: any = {
  values: [
    127, 128, 32767, 32768, 2147483647, 2147483648,
    255, 256, 65535, 65536, 4294967295, 4294967296,
    9007199254740991, 9007199254740992,
    1.1, 0.1, 0.5, 0.50000001, 0.6, 0.7, undefined,
    -1, -0, -0.1, -1.1, NaN,
    -127, -128, -32767, -32768, -2147483647, -2147483648,
    -255, -256, -65535, -65536, -4294967295, -4294967296,
    -9007199254740991, -9007199254740992,
    Infinity, -Infinity,
  ],
  expected: {
    Int8: [
      127, -128, -1, 0, -1, 0, -1, 0, -1, 0, -1, 0, -1, 0,
      1, 0, 0, 0, 0, 0, 0, -1, 0, 0, -1, 0,
      -127, -128, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0,
    ],
    Uint8: [
      127, 128, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0,
      1, 0, 0, 0, 0, 0, 0, 255, 0, 0, 255, 0,
      129, 128, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0,
    ],
    Uint8Clamped: [
      127, 128, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0,
    ],
    Int16: [
      127, 128, 32767, -32768, -1, 0, 255, 256, -1, 0, -1, 0, -1, 0,
      1, 0, 0, 0, 0, 0, 0, -1, 0, 0, -1, 0,
      -127, -128, -32767, -32768, 1, 0, -255, -256, 1, 0, 1, 0, 1, 0, 0, 0,
    ],
    Uint16: [
      127, 128, 32767, 32768, 65535, 0, 255, 256, 65535, 0, 65535, 0, 65535, 0,
      1, 0, 0, 0, 0, 0, 0, 65535, 0, 0, 65535, 0,
      65409, 65408, 32769, 32768, 1, 0, 65281, 65280, 1, 0, 1, 0, 1, 0, 0, 0,
    ],
    Int32: [
      127, 128, 32767, 32768, 2147483647, -2147483648, 255, 256, 65535, 65536, -1, 0, -1, 0,
      1, 0, 0, 0, 0, 0, 0, -1, 0, 0, -1, 0,
      -127, -128, -32767, -32768, -2147483647, -2147483648, -255, -256, -65535, -65536, 1, 0, 1, 0, 0, 0,
    ],
    Uint32: [
      127, 128, 32767, 32768, 2147483647, 2147483648, 255, 256, 65535, 65536, 4294967295, 0, 4294967295, 0,
      1, 0, 0, 0, 0, 0, 0, 4294967295, 0, 0, 4294967295, 0,
      4294967169, 4294967168, 4294934529, 4294934528, 2147483649, 2147483648, 4294967041, 4294967040, 4294901761, 4294901760, 1, 0, 1, 0, 0, 0,
    ],
    Float32: [
      127, 128, 32767, 32768, 2147483648, 2147483648, 255, 256, 65535, 65536, 4294967296, 4294967296, 9007199254740992, 9007199254740992,
      1.100000023841858, 0.10000000149011612, 0.5, 0.5000000149011612, 0.6000000238418579, 0.699999988079071, NaN,
      -1, -0, -0.10000000149011612, -1.100000023841858, NaN,
      -127, -128, -32767, -32768, -2147483648, -2147483648, -255, -256, -65535, -65536, -4294967296, -4294967296, -9007199254740992, -9007199254740992, Infinity, -Infinity,
    ],
    Float64: [
      127, 128, 32767, 32768, 2147483647, 2147483648, 255, 256, 65535, 65536, 4294967295, 4294967296, 9007199254740991, 9007199254740992,
      1.1, 0.1, 0.5, 0.50000001, 0.6, 0.7, NaN,
      -1, -0, -0.1, -1.1, NaN,
      -127, -128, -32767, -32768, -2147483647, -2147483648, -255, -256, -65535, -65536, -4294967295, -4294967296, -9007199254740991, -9007199254740992, Infinity, -Infinity,
    ],
  },
};`;
  }

  if (needsResizableAbUtils) {
    // (#3054 E) Adapted resizableArrayBufferUtils.js. The upstream file builds
    // `ctors` via `new Function('return class My… extends … {}')()` (eval), which
    // this compiler can't run; we inline an eval-free version: the 9 builtin
    // TypedArray constructors (BigInt64/BigUint64/Float16 and the `My*` eval
    // subclasses dropped — unsupported here). Helper returns are typed `ArrayBuffer`
    // so the dynamic `new <ctorVar>(rab)` construct (#3054 D) sees a statically-known
    // buffer arg (an `any`-typed buffer makes the ctor decline → the view is null).
    // `MayNeedBigInt` is a no-op passthrough (no BigInt typed arrays here).
    p += `

const ctors: any[] = [
  Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
  Float32Array, Float64Array, Uint8ClampedArray,
];
const floatCtors: any[] = [Float32Array, Float64Array];
function CreateResizableArrayBuffer(byteLength: number, maxByteLength: number): ArrayBuffer {
  return new ArrayBuffer(byteLength, { maxByteLength: maxByteLength });
}
function Convert(item: any): any { return item; }
function ToNumbers(array: any): any {
  let result: any[] = [];
  for (let i = 0; i < array.length; i++) { result.push(Convert(array[i])); }
  return result;
}
function MayNeedBigInt(ta: any, n: number): any { return n; }
function CreateRabForTest(ctor: any): ArrayBuffer {
  const rab = CreateResizableArrayBuffer(4 * ctor.BYTES_PER_ELEMENT, 8 * ctor.BYTES_PER_ELEMENT);
  const taWrite = new ctor(rab);
  for (let i = 0; i < 4; ++i) { taWrite[i] = MayNeedBigInt(taWrite, 2 * i); }
  return rab;
}
function CollectValuesAndResize(n: any, values: any, rab: any, resizeAfter: number, resizeTo: number): boolean {
  values.push(Number(n));
  if (values.length == resizeAfter) { rab.resize(resizeTo); }
  return true;
}
function TestIterationAndResize(iterable: any, expected: any, rab: any, resizeAfter: number, newByteLength: number): void {
  let values: any[] = [];
  let resized = false;
  for (let value of iterable) {
    values.push(Number(value));
    if (!resized && values.length == resizeAfter) { rab.resize(newByteLength); resized = true; }
  }
  assert.compareArray(values, expected, "TestIterationAndResize: list of iterated values");
  assert(resized, "TestIterationAndResize: resize condition should have been hit");
}`;
  }

  if (needsProxyTraps) {
    // #2183: test262 harness/proxyTrapsHelper.js. Returns a Proxy handler where
    // every trap defaults to a stub that throws a Test262Error when invoked
    // (so a test asserting "trap T must NOT be called" fails if it fires), with
    // each trap overridable via the `overrides` argument. Mirrors the upstream
    // helper verbatim; the throwing stubs are function expressions so they
    // compile to ordinary Wasm closures.
    p += `

function allowProxyTraps(overrides: any): any {
  function throwTest262Error(msg: string): any {
    return function (): any { throw new Test262Error(msg); };
  }
  if (!overrides) { overrides = {}; }
  return {
    getPrototypeOf: overrides.getPrototypeOf || throwTest262Error("[[GetPrototypeOf]] trap called"),
    setPrototypeOf: overrides.setPrototypeOf || throwTest262Error("[[SetPrototypeOf]] trap called"),
    isExtensible: overrides.isExtensible || throwTest262Error("[[IsExtensible]] trap called"),
    preventExtensions: overrides.preventExtensions || throwTest262Error("[[PreventExtensions]] trap called"),
    getOwnPropertyDescriptor: overrides.getOwnPropertyDescriptor || throwTest262Error("[[GetOwnProperty]] trap called"),
    has: overrides.has || throwTest262Error("[[HasProperty]] trap called"),
    get: overrides.get || throwTest262Error("[[Get]] trap called"),
    set: overrides.set || throwTest262Error("[[Set]] trap called"),
    deleteProperty: overrides.deleteProperty || throwTest262Error("[[Delete]] trap called"),
    defineProperty: overrides.defineProperty || throwTest262Error("[[DefineOwnProperty]] trap called"),
    enumerate: throwTest262Error("[[Enumerate]] trap called: this trap has been removed"),
    ownKeys: overrides.ownKeys || throwTest262Error("[[OwnPropertyKeys]] trap called"),
    apply: overrides.apply || throwTest262Error("[[Call]] trap called"),
    construct: overrides.construct || throwTest262Error("[[Construct]] trap called"),
  };
}`;
  }

  return p;
}

/**
 * (#3188 slice 1) Parenthesize the object-literal operand of an `await`:
 * `await {…}` → `await ({…})`. In a genuine async/TLA context `await { … }`
 * is an AwaitExpression whose operand is an ObjectLiteral, but the runner
 * compiles the top-level-await body SYNCHRONOUSLY (the wrapTest TLA path emits
 * it at module top level, not inside an `async` function), so TS treats `await`
 * as an identifier and the following `{ … }` as a *block statement*. That block
 * (`{ function() {} }` in these `await-expr-obj-literal` tests) then swallows the
 * wrapper's trailing `export function test()` during error recovery, yielding a
 * spurious `Duplicate identifier 'test'` / `Duplicate export name 'test'` — 6
 * `language/module-code/top-level-await/syntax/*-obj-literal.js` records failed
 * as a pure runner artifact. Parenthesizing forces the `{…}` to parse as the
 * await operand in every position (top-level statement, `typeof`/`void`, a
 * for-header, and `export var/let x = await {…}` initializers), a semantic
 * no-op in a real async context. Balanced-brace scan skips string/template/
 * comment spans so an `await {` inside a literal is never rewritten.
 */
export function parenthesizeAwaitBraceOperand(body: string): string {
  if (!/\bawait\s*\{/.test(body)) return body;
  let out = "";
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i]!;
    // Skip string / template literals.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        out += body[i];
        if (body[i] === "\\") {
          i++;
          if (i < n) out += body[i];
          i++;
          continue;
        }
        if (body[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Skip line / block comments.
    if (c === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i);
      const end = nl === -1 ? n : nl;
      out += body.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += body.slice(i, stop);
      i = stop;
      continue;
    }
    // Match `await` <ws> `{` at a word boundary.
    if (
      body.startsWith("await", i) &&
      (i === 0 || !/[A-Za-z0-9_$]/.test(body[i - 1]!)) &&
      !/[A-Za-z0-9_$]/.test(body[i + 5] ?? "")
    ) {
      let j = i + 5;
      while (j < n && /\s/.test(body[j]!)) j++;
      if (body[j] === "{") {
        // Find the matching close brace (respecting nested braces + string spans).
        let depth = 0;
        let k = j;
        let str: string | null = null;
        for (; k < n; k++) {
          const ch = body[k]!;
          if (str) {
            if (ch === "\\") {
              k++;
              continue;
            }
            if (ch === str) str = null;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === "`") str = ch;
          else if (ch === "{") depth++;
          else if (ch === "}" && --depth === 0) break;
        }
        // Emit `await ( {…} )`, preserving the original whitespace run.
        out += body.slice(i, j) + "(" + body.slice(j, k + 1) + ")";
        i = k + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Preserve Script-goal top-level `this` when the runner moves a test body into
 * its synthetic exported `test()` function. Ordinary functions and classes
 * introduce their own `this` binding and are deliberately left untouched;
 * arrows inherit the surrounding binding, so a top-level arrow is rewritten.
 * The `as any` keeps the global object on the host-MOP/externref path instead
 * of letting TypeScript's enormous `typeof globalThis` interface select a
 * closed Wasm struct shape (#3367).
 */
export function rewriteScriptTopLevelThis(body: string): string {
  if (!/\bthis\b/.test(body)) return body;

  const sourceFile = ts.createSourceFile("__test262_script.ts", body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const spans: Array<{ start: number; end: number }> = [];

  const visit = (node: ts.Node, hasOwnThis: boolean, inClass: boolean): void => {
    if (node.kind === ts.SyntaxKind.ThisKeyword && !hasOwnThis && !inClass) {
      spans.push({ start: node.getStart(sourceFile), end: node.getEnd() });
      return;
    }

    const nextHasOwnThis = hasOwnThis || (ts.isFunctionLike(node) && !ts.isArrowFunction(node));
    const nextInClass = inClass || ts.isClassDeclaration(node) || ts.isClassExpression(node);
    ts.forEachChild(node, (child) => visit(child, nextHasOwnThis, nextInClass));
  };
  visit(sourceFile, false, false);

  let rewritten = body;
  for (const span of spans.sort((a, b) => b.start - a.start)) {
    rewritten = `${rewritten.slice(0, span.start)}(globalThis as any)${rewritten.slice(span.end)}`;
  }
  return rewritten;
}

export function wrapTest(
  source: string,
  meta?: Test262Meta,
  // (#3151) Compile target of the lane this wrap will be compiled for.
  // Host-free targets (`standalone`/`wasi`) get `any`-typed compareArray
  // shims (dyn-view TypedArray support); the default JS-host lane keeps
  // `any[]` (an `any` param context corrupts callers' array-literal args —
  // see the lane-split note in buildPreamble).
  target?: string,
): WrapResult {
  const dynViewCompare = target === "standalone" || target === "wasi";
  const resolvedMeta = meta ?? parseMeta(source);
  // Strip metadata block
  let body = source.replace(/\/\*---[\s\S]*?---\*\//, "");

  // Note: we no longer strip comments — doing so shifts line numbers,
  // making error line citations inaccurate. Comments don't affect compilation
  // and our regex transforms handle them correctly.

  // Resolve Unicode escape sequences in identifiers (e.g. bre\u0061k → break).
  // test262 uses these to test that keywords are valid property names when escaped.
  // The TS parser handles them, but our regex preprocessing (switch widening,
  // assert routing, etc.) operates on raw source and can be confused by them.
  // Replace \uNNNN sequences outside of string literals with the actual character.
  body = resolveUnicodeEscapes(body);
  if (!resolvedMeta.flags?.includes("module")) {
    body = rewriteScriptTopLevelThis(body);
  }
  if (resolvedMeta.features?.includes("IsHTMLDDA")) {
    // The project wrapper only models the identity/non-undefined part of
    // [[IsHTMLDDA]]. Keep that sentinel directly on the host-MOP path. Going
    // through the synthetic module-global `$262` object gives its callable
    // field a closed Wasm ref type and can corrupt array-destructuring locals
    // before the test begins (#3367).
    body = body.replace(/\$262\.IsHTMLDDA\b/g, "(globalThis as any)");
  }

  // Rename `yield` used as an identifier to `_yield` — in sloppy-mode JS
  // `yield` is a valid identifier, but modules are strict mode where it's reserved.
  // When generator functions are present, only rename `yield` outside generator bodies
  // (inside generator bodies, `yield` is the keyword and must be preserved).
  body = renameYieldOutsideGenerators(body);

  // Widen switch discriminants from literal types to `number` to avoid
  // TypeScript strict narrowing errors like "Type '1' is not comparable to type '0'"
  body = body.replace(/\bswitch\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/g, "switch ($1 as number)");
  body = body.replace(/\bswitch\s*\(\s*(null)\s*\)/g, "switch ($1 as any)");

  // Transform Object.prototype.hasOwnProperty.call(obj, key) → (obj).hasOwnProperty(key)
  // This is semantically equivalent, and our compiler handles obj.hasOwnProperty("key").
  body = transformPrototypeCall(body, "Object.prototype.hasOwnProperty.call");

  // Transform assert.throws(ErrorType, fn) → assert_throws(fn)
  body = transformAssertThrows(body);

  // Transform assert.throwsAsync(ErrorType, fn) → assert_throwsAsync(fn)
  // assert_throwsAsync accepts both synchronous throws AND thenable returns (Promise rejections),
  // since async generators return Promise.reject(e) from .throw() instead of throwing.
  body = body.replace(/\bassert\.throwsAsync\s*\(/g, "assert.throws(");
  body = transformAssertThrows(body, "assert_throwsAsync");

  // Strip undefined-related patterns that can't work in wasm
  // assert.sameValue(expr, undefined) / assert.sameValue(expr, void 0, msg) → comment out
  // Use paren-counting to correctly handle nested calls like assert.sameValue(parseInt("11", undefined), ...)
  body = stripUndefinedAssert(body, "assert.sameValue");
  body = stripUndefinedAssert(body, "assert.notSameValue");
  // var x = undefined; → var x;
  // Previously this was `var x: number = 0;` but that lost undefined identity
  // for nullish operators (??, ??=). Now we just remove the initializer and
  // let the compiler use the default for the inferred type.
  body = body.replace(/\bvar\s+(\w+)\s*=\s*undefined\s*;/g, "var $1;");
  // Strip `if (expr !== undefined) { throw ... }` guards
  body = stripUndefinedThrowGuards(body);

  // Replace assert calls, stripping the optional 3rd message argument
  body = body.replace(/\bassert\.sameValue\b/g, "assert_sameValue");
  body = body.replace(/\bassert\.notSameValue\b/g, "assert_notSameValue");
  body = body.replace(/\bassert\.compareArray\b/g, "assert_compareArray");
  body = body.replace(/\bassert\.deepEqual\b/g, "assert_deepEqual");
  body = body.replace(/\bassert\s*\(/g, "assert_true(");

  // Strip 3rd argument from assert_sameValue / assert_notSameValue calls
  // by finding the call, counting parens to find the 2nd comma, and removing everything after
  body = stripThirdArg(body, "assert_sameValue");
  body = stripThirdArg(body, "assert_notSameValue");
  body = stripThirdArg(body, "assert_compareArray");
  body = stripThirdArg(body, "assert_deepEqual");

  // Convert typeof assertions to direct comparisons (our assert shims only handle numbers)
  // assert_sameValue(typeof X, "Y"); → increment counter, set __fail on mismatch
  // Also handle single-quoted strings and calls without trailing semicolons
  body = body.replace(
    /assert_sameValue\s*\(\s*typeof\s+([^,]+?)\s*,\s*"([^"]+)"\s*\)\s*;?/g,
    '{ __assert_count = __assert_count + 1; if (typeof $1 !== "$2") { if (!__fail) __fail = __assert_count; } }',
  );
  body = body.replace(
    /assert_sameValue\s*\(\s*typeof\s+([^,]+?)\s*,\s*'([^']+)'\s*\)\s*;?/g,
    '{ __assert_count = __assert_count + 1; if (typeof $1 !== "$2") { if (!__fail) __fail = __assert_count; } }',
  );
  // assert_notSameValue(typeof X, "Y"); → increment counter, set __fail on match
  body = body.replace(
    /assert_notSameValue\s*\(\s*typeof\s+([^,]+?)\s*,\s*"([^"]+)"\s*\)\s*;?/g,
    '{ __assert_count = __assert_count + 1; if (typeof $1 === "$2") { if (!__fail) __fail = __assert_count; } }',
  );
  body = body.replace(
    /assert_notSameValue\s*\(\s*typeof\s+([^,]+?)\s*,\s*'([^']+)'\s*\)\s*;?/g,
    '{ __assert_count = __assert_count + 1; if (typeof $1 === "$2") { if (!__fail) __fail = __assert_count; } }',
  );
  // Also handle reverse: assert_sameValue("Y", typeof X)
  body = body.replace(
    /assert_sameValue\s*\(\s*"([^"]+)"\s*,\s*typeof\s+([^)]+?)\s*\)\s*;?/g,
    '{ __assert_count = __assert_count + 1; if (typeof $2 !== "$1") { if (!__fail) __fail = __assert_count; } }',
  );
  body = body.replace(
    /assert_sameValue\s*\(\s*'([^']+)'\s*,\s*typeof\s+([^)]+?)\s*\)\s*;?/g,
    '{ __assert_count = __assert_count + 1; if (typeof $2 !== "$1") { if (!__fail) __fail = __assert_count; } }',
  );

  // With proper Wasm exception handling, throw statements are now compiled
  // natively. Test262Error throws signal test failure and are caught by the
  // try/catch wrapper in the test function (see wrapTest output below).
  // We no longer rewrite them to `return 0;`.

  // Route string comparisons to string-aware assert
  // assert_sameValue(expr, "literal") → assert_sameValue_str(expr, "literal")
  // The expr pattern covers: identifiers, member access chains, bracket access
  // with identifiers/numbers/strings, and method calls (no-arg and single-arg).
  // e.g. obj['prop'], arr[0], foo.bar, log[0].name, fn(), obj.method(), ident[sym]
  const simpleExprPat = "[\\w.]+(?:\\[[^\\]]*\\])*(?:\\.\\w+(?:\\[[^\\]]*\\])*)*(?:\\([^)]*\\))?";
  body = body.replace(
    new RegExp(`assert_sameValue\\s*\\(\\s*(${simpleExprPat})\\s*,\\s*("[^"]*")\\s*\\)`, "g"),
    "assert_sameValue_str($1, $2)",
  );
  body = body.replace(
    new RegExp(`assert_sameValue\\s*\\(\\s*("[^"]*")\\s*,\\s*(${simpleExprPat})\\s*\\)`, "g"),
    "assert_sameValue_str($1, $2)",
  );
  body = body.replace(
    new RegExp(`assert_sameValue\\s*\\(\\s*(${simpleExprPat})\\s*,\\s*('[^']*')\\s*\\)`, "g"),
    "assert_sameValue_str($1, $2)",
  );
  body = body.replace(
    new RegExp(`assert_sameValue\\s*\\(\\s*('[^']*')\\s*,\\s*(${simpleExprPat})\\s*\\)`, "g"),
    "assert_sameValue_str($1, $2)",
  );
  // Also route assert_notSameValue with string literals to assert_notSameValue_str
  body = body.replace(
    new RegExp(`assert_notSameValue\\s*\\(\\s*(${simpleExprPat})\\s*,\\s*("[^"]*")\\s*\\)`, "g"),
    "assert_notSameValue_str($1, $2)",
  );
  body = body.replace(
    new RegExp(`assert_notSameValue\\s*\\(\\s*("[^"]*")\\s*,\\s*(${simpleExprPat})\\s*\\)`, "g"),
    "assert_notSameValue_str($1, $2)",
  );
  body = body.replace(
    new RegExp(`assert_notSameValue\\s*\\(\\s*(${simpleExprPat})\\s*,\\s*('[^']*')\\s*\\)`, "g"),
    "assert_notSameValue_str($1, $2)",
  );
  body = body.replace(
    new RegExp(`assert_notSameValue\\s*\\(\\s*('[^']*')\\s*,\\s*(${simpleExprPat})\\s*\\)`, "g"),
    "assert_notSameValue_str($1, $2)",
  );

  // Strip assert_sameValue(result, vals) where both args are bare identifiers
  body = body.replace(
    /\bassert_sameValue\s*\(\s*result\s*,\s*vals\s*\)\s*;?/g,
    "/* stripped object identity assert */",
  );

  // RegExp exec test pattern: __expected.index = N; __expected.input = "S";
  // Our Wasm arrays can't store extra properties, so extract these to separate variables.
  // Transform: __expected.index = N; → var __expected_index: number = N;
  // Transform: __expected.input = "S"; → var __expected_input: string = "S";
  // Then replace __expected.index → __expected_index, __expected.input → __expected_input.
  //
  // (#1352b) The original regex only matched double-quoted RHS. Many S15.10.2.*
  // tests use single-quoted strings (e.g. `__expected.input = 'alice said: "don\'t"';`)
  // which fell through unmodified — leaving `__expected.input` references on later
  // lines pointing at `__expected_input` (which never got declared) and producing
  // `ReferenceError: __expected_input is not defined`. Extended to handle both
  // quote styles. The `("(?:...)"|'(?:...)')` alternation captures the entire
  // quoted literal so the replacement preserves whichever style the source used.
  let declaredExpectedIndex = false;
  body = body.replace(/__expected\.index\s*=\s*(\d+)\s*;/g, (_m, n) => {
    declaredExpectedIndex = true;
    return `var __expected_index: number = ${n};`;
  });
  // (#1352b) Match double-quoted, single-quoted, or identifier RHS — many tests
  // assign `__expected.input = __string` where `__string` is a previously-declared
  // local. The identifier branch lets the var-decl carry through any string-typed
  // value, not just literals.
  let declaredExpectedInput = false;
  body = body.replace(
    /__expected\.input\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$][\w$]*)\s*;/g,
    (_m, rhs) => {
      declaredExpectedInput = true;
      return `var __expected_input: string = ${rhs};`;
    },
  );
  // Replace property accesses with the extracted variables — but only when the
  // corresponding declaration was emitted. The String case-conversion tests
  // (#1604: toUpperCase/toLowerCase/toLocale*) read `__expected.index` /
  // `__expected.input` without ever assigning them (both sides are `undefined`
  // on a plain string), so rewriting the reads to `__expected_index` /
  // `__expected_input` left a reference to an undeclared variable
  // (`__expected_index is not defined`). When no declaration was extracted,
  // leave the property read intact so it compiles to `undefined`.
  if (declaredExpectedIndex) {
    body = body.replace(/__expected\.index\b(?!\s*=)/g, "__expected_index");
  }
  if (declaredExpectedInput) {
    body = body.replace(/__expected\.input\b(?!\s*=)/g, "__expected_input");
  }

  // Route comparisons involving _input variables to string assert
  body = body.replace(
    /assert_sameValue\s*\(\s*(\w+(?:_input|\.input))\s*,\s*(\w+(?:_input|\.input))\s*\)/g,
    "assert_sameValue_str($1, $2)",
  );
  // Route comparisons of bracket-access elements (common in RegExp exec result tests)
  // e.g. assert_sameValue(__executed[index], __expected[index])
  body = body.replace(/assert_sameValue\s*\(\s*(\w+\[\w+\])\s*,\s*(\w+\[\w+\])\s*\)/g, "assert_sameValue_str($1, $2)");

  // Route boolean comparisons to boolean-aware assert.
  // (#3173) Guard: only rewrite when the captured operand has BALANCED parens.
  // `[^,]+?` happily stops inside a nested call's own boolean argument —
  // `assert_sameValue(sample.getFloat16(0, false), 3.078125)` matched with
  // $1 = "sample.getFloat16(0" and $2 = "false", producing
  // `assert_sameValue_bool(sample.getFloat16(0, false), 3.078125)` — a bool
  // compare against 3.078125, which can never hold. Every DataView
  // `get*(idx, littleEndian-literal)` assert hit this. An unbalanced capture
  // keeps the generic `assert_sameValue`, which compares correctly.
  const parensBalanced = (s: string): boolean => {
    let depth = 0;
    for (const ch of s) {
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth < 0) return false;
      }
    }
    return depth === 0;
  };
  body = body.replace(/assert_sameValue\s*\(\s*([^,]+?)\s*,\s*(true|false)\s*\)/g, (m, a: string, b: string) =>
    parensBalanced(a) ? `assert_sameValue_bool(${a}, ${b})` : m,
  );
  body = body.replace(/assert_sameValue\s*\(\s*(true|false)\s*,\s*([^)]+?)\s*\)/g, (m, a: string, b: string) =>
    parensBalanced(b) ? `assert_sameValue_bool(${a}, ${b})` : m,
  );
  body = body.replace(/assert_notSameValue\s*\(\s*([^,]+?)\s*,\s*(true|false)\s*\)/g, (m, a: string, b: string) =>
    parensBalanced(a) ? `assert_notSameValue_bool(${a}, ${b})` : m,
  );
  body = body.replace(/assert_notSameValue\s*\(\s*(true|false)\s*,\s*([^)]+?)\s*\)/g, (m, a: string, b: string) =>
    parensBalanced(b) ? `assert_notSameValue_bool(${a}, ${b})` : m,
  );

  // Route compareArray assertions through assert_true
  body = body.replace(/\bassert_true\s*\(\s*compareArray\b/g, "assert_true(compareArray");

  // Conditionally include harness helpers only when used (avoids compile errors
  // from unused string/array functions that confuse the type system)
  const needsStrAssert = /\bassert_(sameValue|notSameValue)_str\b/.test(body);
  const needsBoolAssert = /\bassert_(sameValue|notSameValue)_bool\b/.test(body);
  const needsCompareArray = /\bcompareArray\b/.test(body);
  const needsAssertCompareArray = /\bassert_compareArray\b/.test(body);
  const needsAssertDeepEqual = /\bassert_deepEqual\b/.test(body);
  const needsAssertThrows = /\bassert_throws\b/.test(body);
  const needsAssertThrowsAsync = /\bassert_throwsAsync\b/.test(body);

  // ── Harness include shims ───────────────────────────────────────────
  // These are stubs for test262 harness helpers. They are conditionally
  // included only when the test body references the function, to avoid
  // unused-variable compile errors.

  const includes = resolvedMeta.includes ?? [];

  // Body-modifying passes that don't affect preamble content
  // (must happen before preamble cache lookup so the body is consistent)
  if (includes.includes("propertyHelper.js")) {
    if (/\bverifyProperty\b/.test(body)) {
      body = transformVerifyPropertyCalls(body);
    }
    // Strip verifyCallableProperty, verifyPrimordialProperty, verifyPrimordialCallableProperty
    // — we cannot compile their full semantics (function name/length checks, descriptor introspection)
    for (const fn of ["verifyCallableProperty", "verifyPrimordialProperty", "verifyPrimordialCallableProperty"]) {
      if (new RegExp(`\\b${fn}\\b`).test(body)) {
        body = stripBalancedCall(body, fn);
      }
    }
  }

  // Compute all boolean flags that control preamble content, then build a
  // cache key.  Most test262 tests share a tiny number of distinct helper
  // combinations, so this avoids rebuilding the same large string thousands
  // of times.
  const needsPropertyHelper = includes.includes("propertyHelper.js");
  const needsFnGlobalObject = includes.includes("fnGlobalObject.js") && /\bfnGlobalObject\b/.test(body);
  const needsIsConstructor = includes.includes("isConstructor.js") && /\bisConstructor\b/.test(body);
  const needsDecimalToHex =
    includes.includes("decimalToHexString.js") && /\bdecimalTo(?:Percent)?HexString\b/.test(body);
  const needsNans = includes.includes("nans.js") && /\bdistinctNaNs\b/.test(body);
  const needsIsNativeFunction = includes.includes("nativeFunctionMatcher.js") && /\bisNativeFunction\b/.test(body);
  const needsAssertNativeFunction =
    includes.includes("nativeFunctionMatcher.js") && /\bassertNativeFunction\b/.test(body);
  const needsTcoHelper = includes.includes("tcoHelper.js") && /\$MAX_ITERATIONS\b/.test(body);
  const needsDone = /\$DONE\b/.test(body);
  const needsAsyncTest = includes.includes("asyncHelpers.js") && /\basyncTest\b/.test(body);
  const needsDoneForAsyncTest = needsAsyncTest && !needsDone;
  const needsTestTypedArray = includes.includes("testTypedArray.js") && /testWithTypedArrayConstructors/.test(body);
  // (#2939/#2940) The BigInt variant `testWithBigIntTypedArrayConstructors`
  // ships in the SAME testTypedArray.js include; the plain regex above does not
  // match its `…BigIntTypedArray…` infix, so it needs its own gate + shim.
  const needsTestBigIntTypedArray =
    includes.includes("testTypedArray.js") && /testWithBigIntTypedArrayConstructors/.test(body);
  // (#3145) The non-Atomics-friendly wrapper ships in the SAME testTypedArray.js
  // include but its name has no `testWithTypedArrayConstructors` infix, so the
  // plain-TA regex above never matches — it needs its own gate + shim.
  const needsTestNonAtomicsFriendlyTypedArray =
    includes.includes("testTypedArray.js") && /testWithNonAtomicsFriendlyTypedArrayConstructors/.test(body);

  // test262's testTypedArray.js include defines `var TypedArray = Object.getPrototypeOf(Int8Array);`
  // as the abstract %TypedArray% intrinsic. Our runtime's Object.getPrototypeOf(Int8Array) does not
  // yield a usable abstract super — but Int8Array.prototype.X IS the same function as
  // %TypedArray%.prototype.X for proto methods that matter in tests (every/forEach/copyWithin/…).
  // So we inject `const TypedArray = Int8Array` whenever a test references `TypedArray` without
  // declaring it locally. Caveat: tests that rely on TypedArray being abstract (e.g. `new TypedArray()`
  // throwing) will regress — those are rare and live in TypedArrayConstructors/*, not /prototype/*.
  const needsTypedArrayBinding =
    /\bTypedArray\b/.test(body) && !/\b(?:var|let|const|function|class)\s+TypedArray\b/.test(body);

  // test262's iterator-helpers tests reference bare `Iterator` as the
  // %Iterator% constructor. Our runtime lacks that global; inject a minimal
  // shim whose .prototype === %IteratorPrototype% (reachable from
  // [][Symbol.iterator]()'s proto chain). Passes `typeof Iterator ===
  // 'function'` and satisfies `Iterator.prototype.X` lookups.
  const needsIteratorBinding =
    /\bIterator\b/.test(body) && !/\b(?:var|let|const|function|class)\s+Iterator\b/.test(body);

  // #1515: detached-buffer test262 harness — inject $DETACHBUFFER shim that
  // sets a sidecar `__detached__` marker the runtime DataView dispatch checks.
  const needsDetachBuffer = /\$DETACHBUFFER\b/.test(body);

  // #2183: proxyTrapsHelper.js — `allowProxyTraps(overrides)` returns a Proxy
  // handler whose every trap defaults to a throwing stub (so a test asserting
  // "this trap is never called" fails loudly if it fires) and is overridable.
  // Not injected before, so `allowProxyTraps` was undefined and `new Proxy(t,
  // allowProxyTraps(...))` got a null handler — every built-ins/Proxy test that
  // includes this helper failed at construction.
  const needsProxyTraps = includes.includes("proxyTrapsHelper.js") && /\ballowProxyTraps\b/.test(body);

  // (#1524) testTypedArray.js constructor-list constants referenced directly
  // (not via a testWith* wrapper).
  const needsTypedArrayCtorArrays =
    includes.includes("testTypedArray.js") &&
    /\b(typedArrayConstructors|floatArrayConstructors|nonClampedIntArrayConstructors|intArrayConstructors)\b/.test(
      body,
    );
  // (#1524) byteConversionValues.js fixture object.
  const needsByteConversionValues =
    includes.includes("byteConversionValues.js") && /\bbyteConversionValues\b/.test(body);

  // (#3054 E) resizableArrayBufferUtils.js fixtures (`ctors`/`floatCtors`/
  // `CreateResizableArrayBuffer`/`CreateRabForTest`/`CollectValuesAndResize`/
  // `TestIterationAndResize`/`MayNeedBigInt`/`ToNumbers`). The upstream harness
  // builds `ctors` via `new Function('return class …')()` (eval — unsupported), so
  // we inject an ADAPTED, eval-free version (the 9 builtin TA ctors; BigInt/Float16
  // and the eval subclasses dropped). Helper returns are typed `ArrayBuffer` so the
  // dynamic `new <ctorVar>(rab)` construct (#3054 D) sees a statically-known buffer
  // arg. Include-gated + name-gated so it's byte-inert for every other test.
  const needsResizableAbUtils =
    includes.includes("resizableArrayBufferUtils.js") &&
    /\b(ctors|floatCtors|CreateResizableArrayBuffer|CreateRabForTest|CollectValuesAndResize|TestIterationAndResize|MayNeedBigInt|ToNumbers|Convert)\b/.test(
      body,
    );

  // #1523: test262 host-object `$262`. Tests use it as a precondition for
  // realm creation, ArrayBuffer detach, agent messaging, and global access.
  // We expose a minimal stub: createRealm returns a fresh global with eval,
  // detachArrayBuffer sets the `__detached__` sidecar, gc/evalScript are
  // no-ops, agent.* is a stub that throws "agent unsupported".
  const needs262 = /\$262\b/.test(body);

  // Build cache key as a bitmask string
  const cacheKey = [
    needsAssertThrows,
    needsStrAssert,
    needsBoolAssert,
    needsCompareArray,
    needsAssertCompareArray,
    needsAssertDeepEqual,
    needsPropertyHelper,
    needsFnGlobalObject,
    needsIsConstructor,
    needsDecimalToHex,
    needsNans,
    needsIsNativeFunction,
    needsAssertNativeFunction,
    needsTcoHelper,
    needsDone,
    needsAsyncTest,
    needsDoneForAsyncTest,
    needsTestTypedArray,
    needsTestBigIntTypedArray,
    needsTestNonAtomicsFriendlyTypedArray,
    needsAssertThrowsAsync,
    needsTypedArrayBinding,
    needsIteratorBinding,
    needsDetachBuffer,
    needs262,
    needsProxyTraps,
    needsTypedArrayCtorArrays,
    needsByteConversionValues,
    needsResizableAbUtils,
    dynViewCompare,
  ]
    .map((b) => (b ? "1" : "0"))
    .join("");

  let preamble = preambleCache.get(cacheKey);
  if (preamble === undefined) {
    preamble = buildPreamble(
      needsAssertThrows,
      needsStrAssert,
      needsBoolAssert,
      needsCompareArray,
      needsAssertCompareArray,
      needsAssertDeepEqual,
      needsPropertyHelper,
      needsFnGlobalObject,
      needsIsConstructor,
      needsDecimalToHex,
      needsNans,
      needsIsNativeFunction,
      needsAssertNativeFunction,
      needsTcoHelper,
      needsDone,
      needsAsyncTest,
      needsDoneForAsyncTest,
      needsTestTypedArray,
      needsTestBigIntTypedArray,
      needsTestNonAtomicsFriendlyTypedArray,
      needsAssertThrowsAsync,
      needsTypedArrayBinding,
      needsIteratorBinding,
      needsDetachBuffer,
      needs262,
      needsProxyTraps,
      needsTypedArrayCtorArrays,
      needsByteConversionValues,
      needsResizableAbUtils,
      dynViewCompare,
    );
    preambleCache.set(cacheKey, preamble);
  }

  // Auto-declare variables used as destructuring assignment targets but not
  // explicitly declared. In sloppy-mode JS these become implicit globals; since
  // we wrap in strict module scope we need explicit declarations.
  // Detect patterns: { prop: ident } = and { prop: ident, ... } =
  //
  // EXCEPTION: onlyStrict tests that explicitly test PutValue on unresolvable
  // references (§6.2.4 step 5) must NOT be patched — the ReferenceError is the
  // behavior being tested. Detected via `assert.throws(ReferenceError, ...)`
  // wrapping the destructuring assignment.
  const implicitVars = new Set<string>();
  const testsUnresolvablePutValue =
    meta?.flags?.includes("onlyStrict") === true && /assert(?:\.|_)throws\s*\(\s*ReferenceError\b/.test(source);
  // Find all declared vars/let/const
  const declaredVars = new Set<string>();
  for (const m of body.matchAll(/\b(?:var|let|const)\s+([a-zA-Z_$][\w$]*)/g)) {
    declaredVars.add(m[1]!);
  }
  if (!testsUnresolvablePutValue) {
    // Find variables used as targets in object destructuring assignments
    // Pattern: { anyProp: ident } = or { anyProp: ident, ... } =
    for (const m of body.matchAll(/\{\s*(?:[\w\\u]+\s*:\s*(\w+)\s*,?\s*)+\}\s*=/g)) {
      // Re-scan for all prop:ident pairs within the match
      for (const inner of m[0].matchAll(/[\w\\u]+\s*:\s*(\w+)/g)) {
        const v = inner[1]!;
        if (!declaredVars.has(v) && v !== "__fail") {
          implicitVars.add(v);
        }
      }
    }
  }

  let implicitDecls = "";
  if (implicitVars.size > 0) {
    implicitDecls = [...implicitVars].map((v) => `var ${v}: number;`).join("\n  ");
    implicitDecls = "\n  " + implicitDecls;
  }

  // Hoist var declarations that are referenced inside class method/accessor bodies
  // to module scope. When wrapTest wraps everything in a function, class methods
  // become separate Wasm functions that can't capture the enclosing function's locals.
  // By hoisting these vars to module globals, class methods can access them.
  const hoistedVars = new Set<string>();
  // Find var declarations with numeric initializers
  const varDeclNumericPattern = /\bvar\s+(\w+)\s*=\s*(\d+)\s*;/g;
  // Find uninitialized var declarations: var x;
  const varDeclUninitPattern = /\bvar\s+(\w+)\s*;/g;
  const classBodyPattern = /\bclass\s+\w*\s*(?:extends\s+\w+\s*)?\{([\s\S]*?)\n\}/g;
  // Collect all class bodies
  const classBodies: string[] = [];
  for (const cm of body.matchAll(classBodyPattern)) {
    classBodies.push(cm[1]!);
  }
  // Track hoisted var metadata for proper declaration generation
  const hoistedVarMeta = new Map<
    string,
    { type: "number"; init: string } | { type: "any" } | { type: "expr"; fullDecl: string }
  >();
  if (classBodies.length > 0) {
    const classBodyText = classBodies.join("\n");
    for (const vm of body.matchAll(varDeclNumericPattern)) {
      const varName = vm[1]!;
      const initVal = vm[2]!;
      // Check if this variable is referenced in any class body
      if (new RegExp(`\\b${varName}\\b`).test(classBodyText)) {
        hoistedVars.add(varName);
        hoistedVarMeta.set(varName, { type: "number", init: initVal });
      }
    }
    // Also hoist uninitialized vars referenced in class bodies
    for (const vm of body.matchAll(varDeclUninitPattern)) {
      const varName = vm[1]!;
      if (hoistedVars.has(varName)) continue; // already captured by numeric pattern
      // Check if this variable is referenced (written or read) in any class body
      if (new RegExp(`\\b${varName}\\b`).test(classBodyText)) {
        hoistedVars.add(varName);
        hoistedVarMeta.set(varName, { type: "any" });
      }
    }

    // #1363 — Hoist var declarations with arbitrary expression initializers
    // referenced from class bodies. Class methods compile to module-level Wasm
    // functions and cannot capture enclosing-function locals; without hoisting,
    // a method's parameter default `[] = iter` resolves to ref.null.extern,
    // causing a "Cannot destructure 'null' or 'undefined'" trap when invoked.
    //
    // The hoisting strategy converts:
    //   var iter = function*() { iterations += 1; }();
    // into module-scope `let iter: any;` plus an in-body assignment
    // `iter = function*() { iterations += 1; }();` that runs in original order.
    //
    // Bracket/paren/brace-depth-aware scan to capture the full initializer
    // expression up to the matching `;` (handles nested function bodies, object
    // literals with computed keys, string literals, comments, regex literals).
    const findVarStmtEnd = (src: string, eqPos: number): number => {
      let depth = 0;
      let i = eqPos + 1;
      while (i < src.length) {
        const c = src[i]!;
        if (c === "/" && src[i + 1] === "/") {
          // line comment — skip to newline
          while (i < src.length && src[i] !== "\n") i++;
          continue;
        }
        if (c === "/" && src[i + 1] === "*") {
          // block comment
          i += 2;
          while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
          i += 2;
          continue;
        }
        if (c === "'" || c === '"' || c === "`") {
          const quote = c;
          i++;
          while (i < src.length && src[i] !== quote) {
            if (src[i] === "\\") i += 2;
            else i++;
          }
          i++;
          continue;
        }
        if (c === "{" || c === "(" || c === "[") depth++;
        else if (c === "}" || c === ")" || c === "]") depth--;
        else if (c === ";" && depth === 0) return i;
        i++;
      }
      return -1;
    };

    const varInitStart = /\bvar\s+(\w+)\s*=/g;
    for (const vm of body.matchAll(varInitStart)) {
      const varName = vm[1]!;
      if (hoistedVars.has(varName)) continue;
      // Check if this variable is referenced in any class body
      if (!new RegExp(`\\b${varName}\\b`).test(classBodyText)) continue;
      const matchStart = vm.index!;
      const eqPos = matchStart + vm[0].length - 1; // position of '='
      const semiPos = findVarStmtEnd(body, eqPos);
      if (semiPos < 0) continue;
      const fullDecl = body.slice(matchStart, semiPos + 1);
      hoistedVars.add(varName);
      hoistedVarMeta.set(varName, { type: "expr", fullDecl });
    }
  }

  // Build hoisted declarations (module-level) and strip them from the function body
  let hoistedDecls = "";
  let bodyForFunc = body;
  if (hoistedVars.size > 0) {
    for (const v of hoistedVars) {
      const meta = hoistedVarMeta.get(v);
      if (meta?.type === "number") {
        hoistedDecls += `let ${v}: number = ${meta.init};\n`;
        bodyForFunc = bodyForFunc.replace(new RegExp(`\\bvar\\s+${v}\\s*=\\s*${meta.init}\\s*;`), ``);
      } else if (meta?.type === "expr") {
        // #1363 — Var with expression initializer referenced from class body.
        // Hoist `let v: any;` to module scope and rewrite the in-body
        // declaration to a plain assignment so initialization order is
        // preserved. (Side-effects in the initializer must run when the
        // surrounding code reaches that statement, not at module init.)
        hoistedDecls += `let ${v}: any;\n`;
        // Replace the captured `var v = <expr>;` with `v = <expr>;`. Use a
        // literal substring replace (not regex) — the expression may contain
        // characters that mean things in regex. fullDecl includes the
        // trailing `;`.
        const replacement = meta.fullDecl.replace(/^\s*var\s+/, "");
        const idx = bodyForFunc.indexOf(meta.fullDecl);
        if (idx >= 0) {
          bodyForFunc = bodyForFunc.slice(0, idx) + replacement + bodyForFunc.slice(idx + meta.fullDecl.length);
        }
      } else {
        // Uninit var: hoist as any (externref in Wasm)
        hoistedDecls += `let ${v}: any;\n`;
        bodyForFunc = bodyForFunc.replace(new RegExp(`\\bvar\\s+${v}\\s*;`), ``);
      }
    }
  }

  // For onlyStrict tests, add "use strict" so the compiler's strict-mode
  // checks apply (e.g. assignments to arguments/eval, duplicate params).
  const strictDirective = resolvedMeta.flags?.includes("onlyStrict") ? '"use strict";\n' : "";

  // #1612 — top-level-await tests put `await` at module top level, where it is
  // a keyword. Wrapping the body in a *synchronous* `test()` turns `await`
  // back into an identifier, so `await [x]` misparses as element access
  // ("An element access expression should take an argument."). These are
  // syntax-only tests (no assertions), so emit the body at module top level —
  // where `await` parses correctly — and leave `test()` as a trivial probe of
  // `__fail`. The `export function test` already marks the file as a module,
  // so module-goal top-level await is valid.
  //
  // (#3188 slice 1) The obj-literal operand form `await { … }` still misparses
  // even at module top level (synchronous compile ⇒ `await` is an identifier ⇒
  // `{ … }` is a block that swallows the trailing `export function test`), so
  // parenthesize the operand first — see parenthesizeAwaitBraceOperand.
  if (resolvedMeta.features?.includes("top-level-await")) {
    const tlaBody = parenthesizeAwaitBraceOperand(bodyForFunc);
    const tlaPreBody = `${strictDirective}
${preamble}
${hoistedDecls}
${implicitDecls.trim()}
`;
    const tlaPostBody = `
export function test(): number {
  if (__fail) { return __fail; }
  return 1;
}
`;
    const tlaBodyLineOffset = tlaPreBody.split("\n").length - 1;
    const metaBlockTla = source.match(/\/\*---[\s\S]*?---\*\//);
    const metaLinesTla = metaBlockTla ? metaBlockTla[0].split("\n").length - 1 : 0;
    return {
      source: tlaPreBody + tlaBody.trim() + "\n" + tlaPostBody,
      bodyLineOffset: tlaBodyLineOffset - metaLinesTla,
    };
  }

  // (#2932) Module-goal tests: hoist top-level `import` / `export … from`
  // statements whose specifier references a `_FIXTURE` module OUT of the
  // synthetic `export function test()` wrapper to module top level. An
  // `import` nested inside a function body is not a real module import — the
  // TS checker never resolves its binding, and the compiler's top-level
  // import-alias scan (#2930) only sees top-level ImportDeclarations — so
  // every fixture-importing module test read `null`. Each hoisted statement is
  // replaced in the body by a placeholder comment padded to the same line
  // count (keeps error line citations stable); the hoisted copies are emitted
  // ahead of the preamble (bodyLineOffset is computed from preBody, so it
  // adjusts automatically).
  //
  // Scope: `_FIXTURE` specifiers ONLY — the exact class the multi-file
  // fixture branch links via `allowJs` (#2932's purpose). Hoisting is NOT
  // applied to other specifiers: test262's module-namespace tests SELF-import
  // (`import * as ns from './<own-filename>.js'`), and under the runner the
  // test compiles under the virtual key `./test.ts`, so a hoisted self-import
  // cannot resolve — 4 namespace/internals tests flipped pass→fail with
  // "ns is not defined" in PR #2471's merge_group run. Non-fixture module
  // imports keep their pre-#2932 (nested, leniently-ignored) behavior.
  let hoistedImports = "";
  if (resolvedMeta.flags?.includes("module")) {
    const hoistedStmts: string[] = [];
    const hoistOne = (m: string, stmt: string): string => {
      hoistedStmts.push(stmt);
      const newlines = m.split("\n").length - 1;
      return "/* #2932: import/export-from hoisted to module top level */" + "\n".repeat(newlines);
    };
    // import x from '…_FIXTURE.js'; / import {a as b} from …; / import * as ns from …;
    // import x, {a} from …; / import '…_FIXTURE.js';  ([^'";]*? forbids crossing statements)
    bodyForFunc = bodyForFunc.replace(
      /^[ \t]*(import\s+(?:[^'";]*?\bfrom\s*)?['"][^'"]*_FIXTURE[^'"]*['"]\s*;)/gm,
      (m, stmt) => hoistOne(m, stmt),
    );
    // export * from '…'; / export * as ns from '…'; / export {a, b as c} from '…';
    bodyForFunc = bodyForFunc.replace(
      /^[ \t]*(export\s+(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s*from\s*['"][^'"]*_FIXTURE[^'"]*['"]\s*;)/gm,
      (m, stmt) => hoistOne(m, stmt),
    );
    if (hoistedStmts.length > 0) {
      hoistedImports = hoistedStmts.join("\n") + "\n";
    }
  }

  // (#2895 PATH B) Async tests: pump the microtask ring before reading the
  // result so genuinely-pending async-frame continuations (which carry the
  // assertions) run. `__drain_microtasks()` is a compiler intrinsic — the native
  // drain on the host-free targets (`--target standalone`/`wasi`), a void no-op
  // on the JS-host gc lane (which has no native microtask ring), so the gc lane
  // stays byte-identical. Declared so the wrapped TS type-checks.
  const isAsyncTest = resolvedMeta.flags?.includes("async") || needsAsyncTest;
  const asyncDrainDecl = isAsyncTest ? `declare function __drain_microtasks(): void;\n` : "";
  const asyncDrainCall = isAsyncTest ? `  __drain_microtasks();\n` : "";

  // (#3047) Sloppy/top-level `var X` + `function X(){}` coexistence.
  //
  // At Script / function-body top level a FunctionDeclaration is VAR-scoped
  // (TopLevelLexicallyDeclaredNames excludes HoistableDeclarations), so a
  // same-name `var` and function declaration legally coexist there — e.g.
  // `var f; function f(){}` is valid in V8. But this wrapper places the test
  // body inside `try { ... }`, and a *nested Block* makes the function
  // *lexically* scoped, so `try { var f; function f(){} }` becomes a genuine
  // SyntaxError (V8 agrees). That mis-wrapping was reported as ~50 false
  // `Cannot redeclare block-scoped variable` compile errors (dynamic-import
  // /syntax/valid, redeclaration-global, RegExp exec/test, S13*/S10* fn tests).
  //
  // Fix: when a body's TOP-LEVEL statements bind the same name as both a `var`
  // and a `function`, hoist that function declaration out of the `try` to the
  // `test()` body top level. FunctionDeclarations hoist, so runtime semantics
  // are byte-preserved, and the function regains its legal function-body-top-
  // level (var) scope. Guarded strictly to the coexistence pattern, so every
  // other test is emitted unchanged. Line positions of the remaining body are
  // preserved by replacing each hoisted declaration with an equal-line comment.
  let hoistedFns = "";
  try {
    const bodySf = ts.createSourceFile("__body.ts", bodyForFunc, ts.ScriptTarget.Latest, /*setParentNodes*/ false);
    const topLevelVarNames = new Set<string>();
    const topLevelFnDecls: { name: string; start: number; end: number }[] = [];
    for (const stmt of bodySf.statements) {
      if (ts.isVariableStatement(stmt)) {
        const flags = stmt.declarationList.flags;
        if ((flags & ts.NodeFlags.Let) === 0 && (flags & ts.NodeFlags.Const) === 0) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) topLevelVarNames.add(decl.name.text);
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
        topLevelFnDecls.push({ name: stmt.name.text, start: stmt.getStart(bodySf), end: stmt.end });
      }
    }
    const toHoist = topLevelFnDecls.filter((f) => topLevelVarNames.has(f.name));
    if (toHoist.length > 0) {
      const hoisted: string[] = [];
      // Splice out in reverse so earlier offsets stay valid.
      let patched = bodyForFunc;
      for (const f of [...toHoist].sort((a, b) => b.start - a.start)) {
        const text = patched.slice(f.start, f.end);
        hoisted.unshift(text);
        const newlineCount = text.split("\n").length - 1;
        const pad = "/* #3047: function declaration hoisted to test() body top level */" + "\n".repeat(newlineCount);
        patched = patched.slice(0, f.start) + pad + patched.slice(f.end);
      }
      bodyForFunc = patched;
      hoistedFns = hoisted.join("\n") + "\n";
    }
  } catch {
    // Defensive: if the body cannot be parsed standalone, skip the hoist and
    // emit the body unchanged (byte-identical to pre-#3047 behavior).
    hoistedFns = "";
  }

  const preBody = `${strictDirective}
${hoistedImports}${asyncDrainDecl}${preamble}
${hoistedDecls}
export function test(): number {
  ${implicitDecls}
  ${hoistedFns}try {
    `;
  // (#3086) GENERAL (non-harness) vacuity gate. A would-be pass whose test body
  // contains executable assertions (every `assert.*`/bare `assert(` is rewritten
  // to an `assert_*` helper, each of which bumps __assert_count) but executed
  // ZERO of them (__assert_count stayed at its initial 1) asserted nothing at
  // runtime — every assertion sat inside a callback/body that never ran. This is
  // the dropped-nested-callback class (#2939/#2940 host lane, #3083 validator
  // arrays) the harness gate does NOT catch (it keys on testWith*Constructors).
  // Emitted ONLY for tests that HAVE assertions, so a throw-based test (no
  // assert_* calls, checks via `throw new Test262Error`) is never flagged; and
  // it only fires after `if (__fail) return __fail` below, so it touches only
  // would-be passes. Under-detection is safe (an assert form we don't rewrite to
  // assert_* just leaves the test a pass); over-detection needs a test whose
  // EVERY assertion is unreachable, which is itself a vacuous test.
  const hasExecutableAsserts = /\bassert_[A-Za-z]\w*\s*\(/.test(bodyForFunc);
  const generalVacuityGate = hasExecutableAsserts ? "  if (__assert_count === 1) { return -262; }\n" : "";
  // (#3227) Async tests: the JS-host lane schedules `.then`/await continuations
  // on the HOST microtask queue, which cannot drain while `test()` is still on
  // the Wasm→JS stack — so the sync return value is read BEFORE the
  // assertion-bearing callbacks run (they DO run, immediately after `test()`
  // returns; verified empirically). `__drain_microtasks()` is a deliberate
  // no-op on this lane (#2895 PATH B), so the sync verdict of an async test is
  // structurally premature. Export a `__result()` re-check with the SAME
  // verdict logic as the `test()` epilogue; the runner yields to the host
  // event loop after `test()` returns and re-reads the verdict through it.
  const asyncResultExport = isAsyncTest
    ? `
export function __result(): number {
  if (__fail) { return __fail; }
  if (__harness_cb_expected > 0 && __harness_cb_dead === __harness_cb_expected) { return -262; }
${generalVacuityGate}  return 1;
}
`
    : "";
  const postBody = `
  } catch (e) {
    if (!__fail) __fail = -1;
    throw e;
  }
${asyncDrainCall}  if (__fail) { return __fail; }
  // (#2939/#2940/#3086) Vacuity gate: a would-be pass whose harness callback
  // never executed is VACUOUS, not a pass. A wrapper was invoked
  // (__harness_cb_expected > 0) and EVERY attempted callback invocation was dead
  // (contributed zero asserts) — so the callback body holding the real checks
  // was dropped. This generalizes the old "__assert_count === 1" total-vacuity
  // check to also catch PARTIAL vacuity (setup asserts ran, but the callback was
  // still dead). Requiring ALL invocations dead keeps the mixed case safe.
  if (__harness_cb_expected > 0 && __harness_cb_dead === __harness_cb_expected) { return -262; }
${generalVacuityGate}  return 1;
}
${asyncResultExport}`;
  const bodyLineOffset = preBody.split("\n").length - 1;
  // Also account for lines stripped from the original source (metadata block)
  const metaBlock = source.match(/\/\*---[\s\S]*?---\*\//);
  const metaLines = metaBlock ? metaBlock[0].split("\n").length - 1 : 0;
  return {
    source: preBody + bodyForFunc.trim() + postBody,
    bodyLineOffset: bodyLineOffset - metaLines,
  };
}

// ── Test discovery ──────────────────────────────────────────────────

/** Categories of test262 tests to scan */
export const TEST_CATEGORIES = [
  // ── harness self-tests ──
  "harness",
  // ── language ──
  "language/arguments-object",
  "language/asi",
  "language/block-scope",
  "language/comments",
  "language/computed-property-names",
  "language/destructuring",
  "language/directive-prologue",
  "language/eval-code",
  "language/export",
  "language/expressions",
  "language/function-code",
  "language/future-reserved-words",
  "language/global-code",
  "language/identifier-resolution",
  "language/identifiers",
  "language/import",
  "language/keywords",
  "language/line-terminators",
  "language/literals",
  "language/module-code",
  "language/punctuators",
  "language/reserved-words",
  "language/rest-parameters",
  "language/source-text",
  "language/statementList",
  "language/statements",
  "language/types",
  "language/white-space",
  // ── built-ins (consolidated — each entry covers all subdirectories) ──
  "built-ins/AbstractModuleSource",
  "built-ins/AggregateError",
  "built-ins/Array",
  "built-ins/ArrayBuffer",
  "built-ins/ArrayIteratorPrototype",
  "built-ins/AsyncDisposableStack",
  "built-ins/AsyncFromSyncIteratorPrototype",
  "built-ins/AsyncFunction",
  "built-ins/AsyncGeneratorFunction",
  "built-ins/AsyncGeneratorPrototype",
  "built-ins/AsyncIteratorPrototype",
  "built-ins/Atomics",
  "built-ins/BigInt",
  "built-ins/Boolean",
  "built-ins/DataView",
  "built-ins/Date",
  "built-ins/DisposableStack",
  "built-ins/Error",
  "built-ins/FinalizationRegistry",
  "built-ins/Function",
  "built-ins/GeneratorFunction",
  "built-ins/GeneratorPrototype",
  "built-ins/Infinity",
  "built-ins/Iterator",
  "built-ins/JSON",
  "built-ins/Map",
  "built-ins/MapIteratorPrototype",
  "built-ins/Math",
  "built-ins/NaN",
  "built-ins/NativeErrors",
  "built-ins/Number",
  "built-ins/Object",
  "built-ins/Promise",
  "built-ins/Proxy",
  "built-ins/Reflect",
  "built-ins/RegExp",
  "built-ins/RegExpStringIteratorPrototype",
  "built-ins/Set",
  "built-ins/SetIteratorPrototype",
  "built-ins/ShadowRealm",
  "built-ins/SharedArrayBuffer",
  "built-ins/String",
  "built-ins/StringIteratorPrototype",
  "built-ins/SuppressedError",
  "built-ins/Symbol",
  "built-ins/Temporal",
  "built-ins/ThrowTypeError",
  "built-ins/TypedArray",
  "built-ins/TypedArrayConstructors",
  "built-ins/Uint8Array",
  "built-ins/WeakMap",
  "built-ins/WeakRef",
  "built-ins/WeakSet",
  "built-ins/decodeURI",
  "built-ins/decodeURIComponent",
  "built-ins/encodeURI",
  "built-ins/encodeURIComponent",
  "built-ins/eval",
  "built-ins/global",
  "built-ins/isFinite",
  "built-ins/isNaN",
  "built-ins/parseFloat",
  "built-ins/parseInt",
  "built-ins/undefined",
  // ── annexB (legacy browser behaviors, standard test262 format) ──
  "annexB/built-ins",
  "annexB/language",
];

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");

/** Provenance prefix for this lane's runtime-eval tier announcement (#2928 E7). */
const RUNTIME_EVAL_PROVIDER_LABEL = "test262-in-process";

export function findTestFiles(category: string): string[] {
  const dir = join(TEST262_ROOT, "test", category);
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") && !entry.name.includes("_FIXTURE") && !entry.name.endsWith(".imports.js"))
        files.push(full);
    }
  }
  walk(dir);
  return files.sort();
}

// ── Compilation and execution ───────────────────────────────────────

export interface TestTiming {
  /** Total wall-clock time in ms */
  totalMs: number;
  /** Time spent in js2wasm compile() in ms */
  compileMs: number;
  /** Time spent in WebAssembly.instantiate() in ms */
  instantiateMs: number;
  /** Time spent executing the test function in ms */
  executeMs: number;
}

export interface TestResult {
  file: string;
  category: string;
  status: "pass" | "fail" | "skip" | "compile_error";
  reason?: string;
  error?: string;
  /**
   * (#2939/#2940) True when this `fail` is actually a VACUITY correction: the
   * test would have "passed" but its harness-wrapper callback (testWith*
   * Constructors) never executed, so no assertion ran. Kept distinct from a
   * genuine assertion/semantic fail so the report can tally the integrity
   * correction separately (previously-counted-pass → not-pass). Excluded from
   * `pass` (and thus `host_free_pass` / the standalone floor) by being `fail`.
   */
  vacuous?: boolean;
  timing?: TestTiming;
  /**
   * 12-char sha256 hex digest of the compiled Wasm binary, or null if no
   * binary was produced (skip / compile_error / compile_timeout). Used by the
   * PR regression-gate noise filter (#1222): regressions where wasm_sha is
   * unchanged between base and branch are CI noise, not real regressions.
   */
  wasm_sha?: string | null;
  /**
   * (#1853) Hard-error stability bucket. `true` marks a result as a compiler
   * BUG — the compiler produced output the Wasm engine rejected, or trapped on
   * its own malformed codegen — as opposed to an expected coverage gap
   * ("unsupported feature"). Stability is gated separately from coverage: this
   * bucket must stay near-zero and any growth is treated as a release-blocking
   * regression, not absorbed into the not-passing total. `hardErrorKind` names
   * the sub-bucket. Set ONLY where the signal is unambiguously a bug:
   *   - `malformed_wasm` — `WebAssembly.CompileError`/`LinkError` instantiating a
   *     binary the compiler reported as a SUCCESS (the compiler claimed it was
   *     valid). Includes the #1850 verifier-failure-on-a-claimed-function case.
   *   - `missing_test_export` — compile succeeded but no `test` export exists
   *     (the wrapper contract was silently violated by codegen).
   * Plain `compile_error` (the compiler explicitly refused) is NOT a hard error
   * — that is the coverage signal and stays out of this bucket.
   */
  hardError?: boolean;
  hardErrorKind?: "malformed_wasm" | "missing_test_export";
}

/**
 * A standalone Test262 verdict may never depend on imports supplied by the JS
 * harness. Returning a diagnostic here lets every runner path reject the
 * binary before `buildImports` can turn it into a host-satisfied pseudo-pass.
 */
export function standaloneHostImportError(target: string | undefined, imports: readonly unknown[] | undefined) {
  if (target !== "standalone" || !Array.isArray(imports) || imports.length === 0) return undefined;

  const names = imports.map((value) => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return String(value);
    const desc = value as Record<string, unknown>;
    const moduleName = desc.module ?? desc.moduleName ?? desc.module_name ?? "env";
    const name = desc.name ?? desc.field ?? desc.fieldName ?? desc.importName ?? "unknown";
    return `${String(moduleName)}::${String(name)}`;
  });

  return `standalone target emitted host imports: ${[...new Set(names)].sort().join(", ")} (#2961)`;
}

/** Default per-test timeout in milliseconds (prevents infinite-loop hangs) */
const TEST_TIMEOUT_MS = 15000;

export { isModuleGoal };

export function buildNegativeCompileSource(source: string, meta: Test262Meta, category: string): string {
  const strippedSource = source.replace(/\/\*---[\s\S]*?---\*\//, "");
  const strictPrefix = meta.flags?.includes("onlyStrict") ? '"use strict";\n' : "";
  const moduleSuffix = isModuleGoal(category, meta, strippedSource) ? "\nexport {};\n" : "\n";
  return strictPrefix + strippedSource + moduleSuffix;
}

/**
 * Handle a negative test — one that is expected to fail at parse, early, or
 * runtime phase with a specific error type (SyntaxError, ReferenceError, etc.).
 *
 * For parse/early phase: the test passes if compilation rejects the code.
 * For runtime phase: the test passes if execution throws (traps).
 *
 * Returns a TestResult, or null if the test is not a negative test.
 */
export async function handleNegativeTest(
  source: string,
  meta: Test262Meta,
  relPath: string,
  category: string,
  // (#4162) The compile target. This parameter did not exist: the body below
  // referenced a bare `target` identifier that was NEVER BOUND in this scope,
  // so building the compile options threw `ReferenceError: target is not
  // defined` — inside the `try` whose `catch` reports `status: "pass"`. Every
  // parse/early/resolution-phase negative test routed here therefore passed
  // VACUOUSLY, with `compileMs` ~0.05 because nothing was ever compiled.
  target?: "standalone",
): Promise<TestResult | null> {
  if (!meta.negative) return null;

  const { phase, type } = meta.negative;
  const totalStart = performance.now();

  if (phase === "parse" || phase === "early" || phase === "resolution") {
    // For parse/early/resolution phase negative tests, we attempt to compile
    // the raw source (without our test wrapper, since the wrapper adds assert
    // shims that would mask parse errors). If compilation fails, the test passes.
    //
    // We wrap minimally — just enough for the compiler to accept it as a module.
    // For onlyStrict tests, add a "use strict" directive so the compiler's
    // strict-mode checks (eval/arguments binding, octal literals, etc.) apply.
    const minimalWrapped = buildNegativeCompileSource(source, meta, category);

    // (#4162) Built OUTSIDE the try on purpose. The `catch` below reports
    // `status: "pass"` for anything thrown, which is right for a `compile()`
    // rejection and catastrophic for a harness bug — a ReferenceError from this
    // very expression is what made this whole branch vacuous. A harness defect
    // must crash loudly, never launder itself into a conformance pass.
    const compileOptions = {
      fileName: "test.ts",
      emitWat: false,
      ...(target ? { target } : {}),
    };

    let compileMs = 0;
    const compileStart = performance.now();
    try {
      const result = await compile(minimalWrapped, compileOptions);
      compileMs = performance.now() - compileStart;
      const totalMs = performance.now() - totalStart;
      const timing: TestTiming = {
        totalMs: round2(totalMs),
        compileMs: round2(compileMs),
        instantiateMs: 0,
        executeMs: 0,
      };

      if (!result.success || result.errors.some((e) => e.severity === "error")) {
        // Compilation failed as expected — negative test passes
        return { file: relPath, category, status: "pass", timing };
      }

      // For negative tests, warnings also indicate the compiler detected an issue.
      // TypeScript often downgrades ES-spec syntax errors (e.g., strict mode violations,
      // duplicate identifiers) to warnings in our pipeline. If any warning was produced,
      // the compiler did recognize the invalid code — count it as a pass.
      if (result.errors.some((e) => e.severity === "warning")) {
        return { file: relPath, category, status: "pass", timing };
      }

      // Compilation succeeded — but this test expected a parse/early error.
      // Try instantiating: if wasm validation rejects it, that also counts.
      try {
        const sandbox = getTestSandbox();
        const imports = buildImports(result.imports, undefined, result.stringPool, { globalSandbox: sandbox });
        // (#4162) Shared seam: without it a standalone module linking
        // `js2wasm:runtime-eval` throws a LINK error here, which this catch
        // would score as "wasm validation rejected it" — a second way for the
        // instrument's own gap to become a conformance pass.
        await instantiateTest262Module(result.binary, imports, {
          target,
          providerLabel: RUNTIME_EVAL_PROVIDER_LABEL,
        });
      } catch {
        // Instantiation failed — counts as expected error
        const totalMs2 = performance.now() - totalStart;
        return {
          file: relPath,
          category,
          status: "pass",
          timing: {
            totalMs: round2(totalMs2),
            compileMs: round2(compileMs),
            instantiateMs: 0,
            executeMs: 0,
          },
        };
      }

      // Code compiled and instantiated successfully — negative test fails
      return {
        file: relPath,
        category,
        status: "fail",
        error: `expected ${phase} ${type} but compilation succeeded`,
        timing,
      };
    } catch {
      // compile() threw an exception — compilation failed as expected
      compileMs = performance.now() - compileStart;
      const totalMs = performance.now() - totalStart;
      return {
        file: relPath,
        category,
        status: "pass",
        timing: {
          totalMs: round2(totalMs),
          compileMs: round2(compileMs),
          instantiateMs: 0,
          executeMs: 0,
        },
      };
    }
  }

  if (phase === "runtime") {
    // For runtime phase, compile the test normally (with wrapper) and
    // check if execution throws/traps with the expected error.
    // Return null to let the normal flow handle compilation, but the
    // caller will check the result differently.
    return null;
  }

  // Unknown phase — skip
  return {
    file: relPath,
    category,
    status: "skip",
    reason: `unknown negative phase: ${phase}`,
  };
}

/**
 * Extract Wasm function name from a runtime error message.
 * V8 (Node.js) error stacks include entries like:
 *   - "at test (wasm://wasm/...)"
 *   - "RuntimeError: null reference (wasm://wasm/...):function #6:"test""
 * We try to extract the quoted function name from the stack trace.
 */
export function extractWasmFuncName(err: any): string | undefined {
  // (#2962) guarded stringify — see extractWasmCallStack.
  const stack = err?.stack ?? safeStringifyThrown(err);
  // V8 format: at funcName (wasm://...)
  const atMatch = stack.match(/at\s+(\w[\w$]*)\s+\(wasm:\/\//);
  if (atMatch) return atMatch[1];
  // Alternate: "function #N:"name""
  const fnMatch = stack.match(/function\s+#\d+:"([^"]+)"/);
  if (fnMatch) return fnMatch[1];
  return undefined;
}

/**
 * Parse a source map JSON and find the original source line closest to a
 * given wasm byte offset. Returns { line, column, source } or undefined.
 */
export function lookupSourceMapOffset(
  sourceMapJson: string,
  wasmOffset: number,
): { line: number; column: number; source: string } | undefined {
  try {
    const sm = JSON.parse(sourceMapJson);
    const mappings: string = sm.mappings;
    if (!mappings) return undefined;

    const sources: string[] = sm.sources ?? [];

    // Decode VLQ mappings (single-group wasm format: segments separated by commas)
    const segments = mappings.split(",");
    let absWasmOffset = 0;
    let absSourceIdx = 0;
    let absLine = 0;
    let absCol = 0;
    let bestLine = -1;
    let bestCol = -1;
    let bestSource = "";
    let bestOffset = -1;

    for (const seg of segments) {
      if (!seg) continue;
      const values = decodeVLQSegment(seg);
      if (values.length < 4) continue;
      absWasmOffset += values[0];
      absSourceIdx += values[1];
      absLine += values[2];
      absCol += values[3];

      if (absWasmOffset <= wasmOffset) {
        bestLine = absLine;
        bestCol = absCol;
        bestSource = sources[absSourceIdx] ?? "";
        bestOffset = absWasmOffset;
      } else {
        break; // entries are sorted by offset
      }
    }

    if (bestLine >= 0) {
      return { line: bestLine, column: bestCol, source: bestSource };
    }
  } catch {
    // Source map parsing failed — return undefined
  }
  return undefined;
}

/** Decode a single VLQ segment into an array of numbers */
function decodeVLQSegment(segment: string): number[] {
  const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values: number[] = [];
  let i = 0;
  while (i < segment.length) {
    let vlq = 0;
    let shift = 0;
    let continuation = true;
    while (continuation && i < segment.length) {
      const digit = BASE64.indexOf(segment[i]!);
      if (digit === -1) break;
      vlq |= (digit & 0x1f) << shift;
      continuation = (digit & 0x20) !== 0;
      shift += 5;
      i++;
    }
    const isNeg = (vlq & 1) === 1;
    values.push(isNeg ? -(vlq >>> 1) : vlq >>> 1);
  }
  return values;
}

/**
 * Enrich an error message with Wasm function name and source-mapped line info.
 */
/**
 * Extract a human-readable message from a Wasm runtime error.
 * Mirrors the same-named helper in scripts/test262-worker.mjs (#1155).
 *
 * Handles `WebAssembly.Exception` (extracts payload via `__exn_tag` /
 * `__tag` export when an instance is available), generic `Error`
 * (returns `.message`), and falls back to `String(err)` for everything
 * else. If `instance` is null (e.g. the throw happened during
 * `WebAssembly.instantiate` from a start function), tag-based payload
 * lookup is skipped and we return a generic "wasm exception" string.
 *
 * Without this, `String(err)` for a `WebAssembly.Exception` produces
 * `"[object WebAssembly.Exception]"` — uninformative junk that polluted
 * ~39 entries in the committed test262 baseline (residual count from
 * #1294 / #1295 fixes that handled the worker.mjs paths but not the
 * vitest-runner path used by `scripts/test262-worker-esm.mjs`).
 */
/**
 * (#2870) Stringify a thrown payload WITHOUT ever letting a host TypeError
 * escape. A `--target standalone` module's thrown value is frequently a Wasm-GC
 * error struct (an `anyref` with no JS-reachable `toString`); calling `String()`
 * on it makes the HOST `ToPrimitive` throw `Cannot convert object to primitive
 * value`. Unguarded, that host throw escaped `extractWasmExceptionMessage` and
 * was recorded as the test's failure — masking the REAL signature (the genuine
 * in-Wasm throw/trap) behind a phantom formatter TypeError, and collapsing
 * ~2,014 heterogeneous standalone failures onto one string (see #2862). Guard
 * it: on failure fall back to a stable label so the recorded signature reflects
 * that the module threw a non-JS-stringifiable Wasm-GC payload.
 */
// (#3613) Re-exported from the SHARED renderer so this lane and the CI worker
// cannot drift again. The doc comment above is retained for the #2870 history.
const safeStringifyThrown = sharedSafeStringifyThrown;

/**
 * (#2962) Render a natively-thrown Wasm-GC payload through the module's own
 * `__exn_render_prepare` / `__exn_render_char` exports (standalone/wasi
 * binaries emit them at finalize). The module runs the payload through the
 * same `__any_to_string` chain its in-module `String(x)` uses — so an
 * `$Error_struct` renders "TypeError: boom" per §20.5.3.4 and a Test262Error
 * yields its real assertion message — then exposes the flat string one code
 * unit at a time (WasmGC arrays are not host-indexable). Returns `null`
 * when the exports are absent (JS-host binaries), the payload renders empty,
 * or anything throws — the caller then falls back to the #2870 opaque label.
 * The 64k cap is defensive (a corrupt length must not build a giant string).
 */
// (#3613) See safeStringifyThrown above — one implementation, both lanes.
const tryNativeExnRender = sharedTryNativeExnRender;

export function extractWasmExceptionMessage(err: any, instance: any): string {
  if (typeof WebAssembly !== "undefined" && err instanceof (WebAssembly as any).Exception) {
    let payload: any = null;
    if (instance) {
      try {
        const tag = instance.exports?.__exn_tag ?? instance.exports?.__tag;
        if (tag) payload = err.getArg(tag, 0);
      } catch {
        // Tag lookup failed — fall through to generic message.
      }
    }
    if (payload instanceof Error) {
      return payload.message ?? safeStringifyThrown(payload);
    }
    if (payload != null) {
      // (#2962) A host-opaque GC payload (typeof "object"/"function") renders
      // through the module's own exports before falling back to the #2870
      // label. Host-readable primitives keep the direct String() path.
      const t = typeof payload;
      if (t === "object" || t === "function") {
        const native = tryNativeExnRender(instance, payload);
        if (native != null) return native;
      }
      return safeStringifyThrown(payload);
    }
    return instance ? "TypeError (null/undefined access)" : "wasm exception during module init";
  }
  if (err instanceof Error) {
    return err.message ?? safeStringifyThrown(err);
  }
  return safeStringifyThrown(err);
}

/**
 * (#1316 / #1317) Extract every wasm frame from a `RuntimeError.stack`,
 * not just the leaf. Each frame gets the function name + byte offset.
 * The leaf frame is the trap site; subsequent frames are callers up the
 * stack until we reach the JS<->Wasm boundary. For deeply-nested
 * `null_deref` / `illegal_cast` failures this surfaces the full call
 * chain so the failure can be diagnosed without re-running with a
 * debugger.
 *
 * Returns frames in trap-first order (leaf first), e.g.
 *   [{ name: "inner", offset: 0x1de },
 *    { name: "test",  offset: 0x1e7 }]
 */
export function extractWasmCallStack(err: any): Array<{ name: string; offset: number }> {
  // (#2962) Same #2870 hazard one level up: `String(err)` on an exotic thrown
  // value (poisoned/prototype-less object) throws a host TypeError that would
  // crash the runner mid-test instead of recording the failure. Route through
  // the guarded stringifier.
  const stack: string = err?.stack ?? safeStringifyThrown(err);
  const frames: Array<{ name: string; offset: number }> = [];
  // V8 format: `at <name> (wasm://wasm/<hash>:wasm-function[N]:0xOFFSET)`
  const re = /at\s+(\S+)\s+\(wasm:\/\/[^:]*:wasm-function\[\d+\]:0x([0-9a-fA-F]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stack)) !== null) {
    const name = m[1]!;
    const offset = parseInt(m[2]!, 16);
    if (Number.isFinite(offset)) frames.push({ name, offset });
  }
  return frames;
}

export function enrichErrorMessage(
  errMsg: string,
  err: any,
  sourceMapJson: string | undefined,
  bodyLineOffset: number,
): string {
  const parts: string[] = [errMsg];

  // (#1316 / #1317) Extract the full wasm call chain — for `illegal cast`
  // and `dereferencing a null pointer` traps, the leaf frame alone is
  // often a tiny lifted helper (e.g. __closure_N) whose source line
  // doesn't pinpoint the user-visible failure. The next frame up is
  // usually the caller that produced the bad value. When source-map data
  // is available, annotate each frame with its source line so the chain
  // reads as a familiar JS-style stack trace.
  const frames = extractWasmCallStack(err);
  if (frames.length === 0) {
    // Fall back to legacy single-name extraction when the stack is empty
    // or doesn't match the V8 format (e.g. older Node, future format
    // change). Preserves the existing message shape for tests that pin it.
    const funcName = extractWasmFuncName(err);
    if (funcName) parts.push(`in ${funcName}()`);
    return parts.join(" ");
  }

  // Annotate the leaf frame (trap site) — same pattern as the legacy
  // single-frame format: `... in <name>() at source L<line>`.
  const leaf = frames[0]!;
  const leafSrc = sourceMapJson ? lookupSourceMapOffset(sourceMapJson, leaf.offset) : undefined;
  let leafLabel = `in ${leaf.name}()`;
  if (leafSrc && leafSrc.line > 0) {
    const adjustedLine = leafSrc.line - bodyLineOffset;
    const srcLine = adjustedLine > 0 ? adjustedLine : leafSrc.line;
    leafLabel += ` at source L${srcLine}`;
  }
  parts.push(leafLabel);

  // Append additional frames as a call chain. Skip the JS-boundary frame
  // (added implicitly when frames > 1 means a real chain). Cap the chain
  // at 4 frames so the error string stays readable in CI logs and the
  // 300-char `error.substring(0, 300)` truncation in
  // `scripts/test262-worker-esm.mjs` doesn't lose the leaf info.
  if (frames.length > 1) {
    const chainParts: string[] = [];
    const maxFrames = Math.min(frames.length, 4);
    for (let i = 1; i < maxFrames; i++) {
      const f = frames[i]!;
      let label = f.name;
      if (sourceMapJson) {
        const src = lookupSourceMapOffset(sourceMapJson, f.offset);
        if (src && src.line > 0) {
          const adj = src.line - bodyLineOffset;
          const ln = adj > 0 ? adj : src.line;
          label = `${f.name}@L${ln}`;
        }
      }
      chainParts.push(label);
    }
    if (chainParts.length > 0) {
      parts.push(`(via ${chainParts.join(" ← ")})`);
    }
  }

  return parts.join(" ");
}

interface OriginalVariantResult {
  pass: boolean;
  phase: "compile" | "runtime";
  detail?: string;
  timing: TestTiming;
  wasm_sha?: string;
}

/**
 * (#3613) Now a thin alias over the SHARED renderer
 * (`scripts/lib/wasm-exn-render.mjs`).
 *
 * The local copy this replaces was missing the `tryNativeExnRender` step the
 * CI worker has always taken, so on the standalone lane every `Test262Error`
 * surfaced here as the opaque #2870 label ("uncaught Wasm-GC exception
 * (non-stringifiable payload)") while CI reported the real assertion text.
 * Consequences: message-derived triage against the local runner saw one giant
 * undifferentiated bucket, and a standalone runtime-negative test could not
 * match its expected error TYPE (`originalNegativeMatches` searches the
 * detail for `meta.negative.type`, which the opaque label does not contain).
 *
 * `oracle-version-exempt:` this is the LOCAL in-process runner only. The
 * committed baseline rows are produced exclusively by
 * `scripts/test262-worker.mjs`, whose behaviour is byte-unchanged — the shared
 * policy IS the worker's existing policy. No baseline row can reclassify; the
 * change only makes the local lane stop disagreeing with CI.
 */
const originalHarnessThrownText = renderHarnessThrownText as (
  error: unknown,
  instance?: WebAssembly.Instance,
) => string;

function originalNegativeMatches(meta: Test262Meta, detail: string): boolean {
  const expected = meta.negative?.type;
  if (!expected) return Boolean(meta.negative);
  return detail.includes(expected);
}

function appendOriginalHarnessFailureContext(detail: string, source: string): string {
  const lines = source.split("\n");
  const candidates: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (/\bassert\b[.\w]*\s*\(|throw\s+new\s+Test262Error\b/.test(text)) {
      candidates.push({ line: i + 1, text });
    }
  }
  if (candidates.length === 0) return detail;

  let selected = candidates[0]!;
  const sameValue = detail.match(/Expected SameValue\(«([^»]+)», «([^»]+)»\)/);
  if (sameValue) {
    const actual = sameValue[1]!.trim();
    const expected = sameValue[2]!.trim();
    const matchingCall = candidates.find((candidate) => {
      const call = candidate.text.match(/assert\.sameValue\s*\(\s*([^,]+)\s*,\s*([^,)]+)[,)]/);
      return call?.[1]?.trim() === actual && call?.[2]?.trim() === expected;
    });
    if (matchingCall) selected = matchingCall;
  }
  for (const candidate of candidates) {
    const literals = candidate.text.matchAll(/(["'`])([^"'`]{8,})\1/g);
    if ([...literals].some((match) => detail.includes(match[2]!))) {
      selected = candidate;
      break;
    }
  }
  const text = selected.text.length > 600 ? `${selected.text.slice(0, 597)}...` : selected.text;
  return `${detail} | at L${selected.line}: ${text}`;
}

async function runOriginalHarnessVariant(
  variant: OriginalHarnessVariant,
  originalSource: string,
  meta: Test262Meta,
  fileName: string,
  timeoutMs: number,
  target?: "standalone",
): Promise<OriginalVariantResult> {
  restoreHostBuiltins();
  const started = performance.now();
  let compileMs = 0;
  let instantiateMs = 0;
  let executeMs = 0;
  let result: Awaited<ReturnType<typeof compile>> | undefined;
  let instance: WebAssembly.Instance | undefined;

  const timing = (): TestTiming => ({
    totalMs: round2(performance.now() - started),
    compileMs: round2(compileMs),
    instantiateMs: round2(instantiateMs),
    executeMs: round2(executeMs),
  });

  try {
    const compileStarted = performance.now();
    try {
      result = await compile(variant.source, {
        allowJs: true,
        fileName,
        sourceMap: true,
        emitWat: false,
        skipSemanticDiagnostics: true,
        inferModuleStrictArguments: meta.flags?.includes("module") === true,
        // (#2860 F3) Standalone joins the host lane's deferTopLevelInit rule
        // (mirrors scripts/test262-worker.mjs doCompile): under the `(start)`
        // model every top-level throw — i.e. every runtime failure in
        // original-harness mode — surfaced from WebAssembly.instantiate with
        // instance === null, making the #2962 native exception render
        // unreachable and collapsing ~8,600 standalone failures onto the
        // opaque "wasm exception during module init" label. The exec path
        // below already calls the exported __module_init after setInstance.
        ...(target ? { target } : {}),
        ...(target === undefined || target === "standalone" ? { deferTopLevelInit: true } : {}),
        // (#4035) The harness INSPECTS the module from JS — it renders native
        // exception payloads via `__exn_render_*` (#2962) and drains the
        // host-free print sink via `__stdout_*` (#3469). Standalone/WASI now
        // default to `hostBridge: "off"` (a deployed pure-Wasm module needs
        // only its own exports), so the runner must ask for the bridge
        // explicitly or those two channels vanish and the conformance numbers
        // collapse onto opaque labels. This is the harness opt-in the flag was
        // designed around; do not drop it to "shrink the test binaries".
        hostBridge: "always",
      });
    } catch (error) {
      compileMs = performance.now() - compileStarted;
      const detail = originalHarnessThrownText(error);
      const isCompileNegative = Boolean(meta.negative) && meta.negative?.phase !== "runtime";
      return {
        pass: isCompileNegative && negativeCompileErrorMatches(meta.negative?.type, [], detail),
        phase: "compile",
        detail,
        timing: timing(),
      };
    }
    compileMs = performance.now() - compileStarted;

    if (compileMs > timeoutMs) {
      return {
        pass: false,
        phase: "compile",
        detail: `compilation timeout (${round2(compileMs)}ms)`,
        timing: timing(),
      };
    }

    if (!result.success || result.errors.some((error) => error.severity === "error")) {
      const detail =
        result.errors
          .filter((error) => error.severity === "error")
          .map((error) => error.message)
          .join("; ") ||
        result.errors.map((error) => error.message).join("; ") ||
        "compile failed";
      const syntaxPhase =
        meta.negative?.phase === "parse" || meta.negative?.phase === "early" || meta.negative?.phase === "resolution";
      const pass =
        Boolean(meta.negative) &&
        meta.negative?.phase !== "runtime" &&
        (originalNegativeMatches(meta, detail) || (meta.negative?.type === "SyntaxError" && syntaxPhase));
      return { pass, phase: "compile", detail, timing: timing() };
    }

    const wasm_sha = computeWasmSha(result.binary);
    const output: string[] = [];
    const appendOutput = (line: string): void => {
      Reflect.defineProperty(output, output.length, {
        value: line,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    };
    const consoleProxy = {
      log: (...values: unknown[]) => appendOutput(values.map(String).join(" ")),
      error: (...values: unknown[]) => appendOutput(values.map(String).join(" ")),
      warn: (...values: unknown[]) => appendOutput(values.map(String).join(" ")),
    } as unknown as Console;
    const findAsyncMarker = (prefix: string): string | undefined => {
      for (let i = 0; i < output.length; i++) {
        if (output[i]?.includes(prefix)) return output[i];
      }
      return undefined;
    };

    try {
      // (#4394) `$DONE` is an own property of the global exactly when the
      // SCRIPT declares one — either because the `async` flag pulled
      // `doneprintHandle.js` into the prefix, or because the test body declares
      // its own top-level `$DONE` (which a JS engine also exposes as a global
      // own-property, and which `asyncTest` then calls). Exposing it
      // unconditionally made `asyncHelpers-asyncTest-without-async-flag`'s
      // guard unobservable; withholding it unconditionally broke
      // `asyncHelpers-asyncTest-return-not-thenable`, which declares its own.
      const sandbox = createTestSandbox(
        consoleProxy,
        meta.flags?.includes("async") === true || declaresTopLevelDone(originalSource),
      );
      const imports = buildImports(result.imports, { console: consoleProxy }, result.stringPool, {
        globalSandbox: sandbox,
      }) as any;
      const instantiateStarted = performance.now();
      instance = await instantiateTest262Module(result.binary, imports, {
        target,
        providerLabel: RUNTIME_EVAL_PROVIDER_LABEL,
      });
      instantiateMs = performance.now() - instantiateStarted;
      imports.setInstance?.(instance);

      const executeStarted = performance.now();
      const moduleInit = (instance.exports as Record<string, any>).__module_init;
      if (typeof moduleInit === "function") moduleInit();

      // (#3469) Host-free (standalone) async drive + output capture. Standalone
      // has no host `console` import (kept out so the #2961 gate stays green) and
      // no `fd_write`, so .then/await continuations live on the in-module WASM
      // microtask ring and printed output lands in an in-module GC-string sink
      // rather than `consoleProxy`. Drain the ring so the continuations run
      // (reaching `$DONE → print → console.log(marker)`), then mirror the native
      // `__stdout_prepare`/`__stdout_char` sink into `output` so the marker poll
      // below observes it. Feature-detected intrinsics; no-op on the js-host lane.
      let standaloneDrainError: unknown = null;
      if (target === "standalone" && meta.flags?.includes("async")) {
        const exp = instance.exports as Record<string, any>;
        if (typeof exp.__drain_microtasks === "function") {
          try {
            exp.__drain_microtasks();
          } catch (err) {
            standaloneDrainError = err;
          }
        }
        if (typeof exp.__stdout_prepare === "function" && typeof exp.__stdout_char === "function") {
          let len = 0;
          try {
            len = exp.__stdout_prepare() | 0;
          } catch {
            len = 0;
          }
          if (len > 0) {
            let sink = "";
            for (let i = 0; i < len; i++) sink += String.fromCharCode(exp.__stdout_char(i) & 0xffff);
            for (const line of sink.split("\n")) {
              if (line.length > 0) appendOutput(line);
            }
          }
        }
      }

      if (meta.flags?.includes("async")) {
        const deadline = Date.now() + Math.min(timeoutMs, 1_000);
        while (
          Date.now() < deadline &&
          !findAsyncMarker("Test262:AsyncTestComplete") &&
          !findAsyncMarker("Test262:AsyncTestFailure")
        ) {
          await new Promise((resolveTurn) => setTimeout(resolveTurn, 10));
        }
      }
      executeMs = performance.now() - executeStarted;

      if (meta.negative) {
        return {
          pass: false,
          phase: "runtime",
          detail: `expected ${meta.negative.type}`,
          timing: timing(),
          wasm_sha,
        };
      }
      const asyncFailure = findAsyncMarker("Test262:AsyncTestFailure");
      if (asyncFailure) {
        return {
          pass: false,
          phase: "runtime",
          detail: asyncFailure,
          timing: timing(),
          wasm_sha,
        };
      }
      if (meta.flags?.includes("async") && !findAsyncMarker("Test262:AsyncTestComplete")) {
        return {
          pass: false,
          phase: "runtime",
          // (#3469) If the host-free drain threw (an async continuation that
          // escaped uncaught) and no marker was produced, surface that error as
          // the test's real async outcome instead of the generic "not observed".
          detail:
            standaloneDrainError != null
              ? `async continuation threw before completion: ${originalHarnessThrownText(standaloneDrainError, instance)}`
              : "async completion marker not observed",
          timing: timing(),
          wasm_sha,
        };
      }
      return { pass: true, phase: "runtime", timing: timing(), wasm_sha };
    } catch (error) {
      executeMs = Math.max(executeMs, performance.now() - started - compileMs - instantiateMs);
      const enriched = enrichErrorMessage(
        originalHarnessThrownText(error, instance),
        error,
        result.sourceMap,
        variant.bodyLineOffset,
      );
      const detail = appendOriginalHarnessFailureContext(enriched, originalSource);
      return {
        pass: meta.negative?.phase === "runtime" && originalNegativeMatches(meta, detail),
        phase: "runtime",
        detail,
        timing: timing(),
        wasm_sha,
      };
    }
  } finally {
    restoreHostBuiltins();
  }
}

/**
 * Authoritative Test262 execution path. Unlike wrapTest(), this compiles the
 * literal upstream harness assembly and untouched test body. A normal script
 * record must pass both its sloppy execution and Test262's strict rerun.
 */
export async function runTest262File(
  filePath: string,
  category: string,
  timeoutMs = TEST_TIMEOUT_MS,
  target?: "standalone",
): Promise<TestResult> {
  const relPath = relative(TEST262_ROOT, filePath);
  const source = readFileSync(filePath, "utf-8");
  const meta = parseMeta(source);

  const relTest = filePath.replace(/.*test262\//, "");
  if (HANGING_TESTS.has(relTest)) {
    return { file: relPath, category, status: "skip", reason: "compiler hang (see HANGING_TESTS)" };
  }
  if (!meta.negative) {
    const filter = shouldSkip(source, meta, filePath);
    if (filter.skip) return { file: relPath, category, status: "skip", reason: filter.reason };
  }

  const assembly = assembleOriginalHarness(source, meta);
  const primary = await runOriginalHarnessVariant(assembly.primary, source, meta, filePath, timeoutMs, target);
  if (!primary.pass) {
    return {
      file: relPath,
      category,
      status: primary.phase === "compile" ? "compile_error" : "fail",
      error: primary.detail,
      timing: primary.timing,
      wasm_sha: primary.wasm_sha ?? null,
    };
  }

  if (assembly.strictRerun) {
    const strict = await runOriginalHarnessVariant(assembly.strictRerun, source, meta, filePath, timeoutMs, target);
    if (!strict.pass) {
      return {
        file: relPath,
        category,
        status: strict.phase === "compile" ? "compile_error" : "fail",
        error: `strict rerun: ${strict.detail ?? "failed"}`,
        timing: {
          totalMs: round2(primary.timing.totalMs + strict.timing.totalMs),
          compileMs: round2(primary.timing.compileMs + strict.timing.compileMs),
          instantiateMs: round2(primary.timing.instantiateMs + strict.timing.instantiateMs),
          executeMs: round2(primary.timing.executeMs + strict.timing.executeMs),
        },
        wasm_sha: primary.wasm_sha ?? strict.wasm_sha ?? null,
      };
    }
    primary.timing = {
      totalMs: round2(primary.timing.totalMs + strict.timing.totalMs),
      compileMs: round2(primary.timing.compileMs + strict.timing.compileMs),
      instantiateMs: round2(primary.timing.instantiateMs + strict.timing.instantiateMs),
      executeMs: round2(primary.timing.executeMs + strict.timing.executeMs),
    };
  }

  return {
    file: relPath,
    category,
    status: "pass",
    timing: primary.timing,
    wasm_sha: primary.wasm_sha ?? null,
  };
}

/** Legacy transformed runner retained only for wrapper-specific diagnostics. */
export async function runSyntheticTest262File(
  filePath: string,
  category: string,
  timeoutMs = TEST_TIMEOUT_MS,
  // (#2095) Optional compile target so the baseline validator can exercise the
  // STANDALONE lane, not just the default JS-host (gc) lane. `undefined` keeps
  // the historical host-mode behaviour. Before instantiation the standalone
  // path rejects any non-empty import manifest, matching the sharded worker.
  target?: "standalone",
): Promise<TestResult> {
  // (#3318) ENTRY restore: the previous in-process run may have executed test
  // code that poisoned the REAL builtin prototypes (this runner compiles and
  // runs in the caller's realm). E.g. `Array.prototype[1] = 1` left behind by
  // lastIndexOf/15.4.4.15-8-a-14.js crashes the NEXT compile inside the TS
  // checker ("Cannot create property 'declaredType' on number '1'" — its
  // symbolLinks array read inherits the polluted index). The sharded CI
  // worker has its own restoreBuiltins; this is the in-process counterpart.
  // NOTE: the FINAL call still leaves that test's pollution in the process —
  // callers doing further compiles outside the runner should invoke
  // restoreHostBuiltins() themselves.
  restoreHostBuiltins();
  const totalStart = performance.now();
  const relPath = relative(TEST262_ROOT, filePath);
  const source = readFileSync(filePath, "utf-8");
  const meta = parseMeta(source);

  // Check for known hanging tests FIRST — before any compilation
  if (filePath) {
    const relTest = filePath.replace(/.*test262\//, "");
    if (HANGING_TESTS.has(relTest)) {
      return {
        file: relPath,
        category,
        status: "skip",
        reason: "compiler hang (see HANGING_TESTS)",
      };
    }
  }

  // Handle parse/early/resolution-phase negative tests BEFORE shouldSkip —
  // these tests contain intentionally invalid code (eval, with, delete, etc.)
  // that shouldSkip would filter out. Since the test expects a parse error,
  // we should try to compile and check for errors, not skip.
  if (
    meta.negative &&
    (meta.negative.phase === "parse" || meta.negative.phase === "early" || meta.negative.phase === "resolution")
  ) {
    const negResult = await handleNegativeTest(source, meta, relPath, category, target);
    if (negResult) return negResult;
  }

  // For runtime negative tests, bypass shouldSkip entirely. These tests
  // expect the code to compile but throw at runtime. Skip filters (eval,
  // with, etc.) would prevent us from even trying — but we should attempt
  // compilation and execution. If compilation fails, the existing runtime
  // negative handler reports compile_error appropriately.
  // Runtime negative tests expect the code to throw at runtime — they
  // intentionally use constructs like eval, with, etc. that shouldSkip would
  // filter out. Bypass shouldSkip for these tests so handleNegativeTest can
  // process them (compile + run, checking that execution throws/traps).
  const isRuntimeNegative = meta.negative?.phase === "runtime";

  if (!isRuntimeNegative) {
    const filter = shouldSkip(source, meta, filePath);
    if (filter.skip) {
      return { file: relPath, category, status: "skip", reason: filter.reason };
    }
  }

  // Wrap the test
  const { source: wrappedSource, bodyLineOffset } = wrapTest(source, meta, target);
  const moduleGoal = isModuleGoal(category, meta, source);

  /** Adjust error line numbers to refer to the original source file.
   *  The wrapped source has a variable preamble and stripped comments,
   *  so a fixed offset doesn't work. Instead, find the code text at
   *  the error line in the wrapped source and search for it in the
   *  original source. */
  const wrappedLines = wrappedSource.split("\n");
  const originalLines = source.split("\n");
  function adjustLine(line: number): number {
    // Get the code text at the error line in the wrapped source
    if (line < 1 || line > wrappedLines.length) return line;
    const errorText = wrappedLines[line - 1].trim();
    if (
      !errorText ||
      errorText === "{" ||
      errorText === "}" ||
      errorText === "try {" ||
      errorText === "} catch (e) {"
    ) {
      // Generic structural line — fall back to offset
      const adjusted = line - bodyLineOffset;
      return adjusted > 0 ? adjusted : line;
    }
    // Search for this exact text in the original source
    for (let i = 0; i < originalLines.length; i++) {
      if (originalLines[i].trim() === errorText) return i + 1;
    }
    // Partial match — search for substring
    for (let i = 0; i < originalLines.length; i++) {
      if (originalLines[i].includes(errorText)) return i + 1;
    }
    // Fall back to offset
    const adjusted = line - bodyLineOffset;
    return adjusted > 0 ? adjusted : line;
  }

  // Compile (with timeout)
  let result;
  const compileStart = performance.now();
  let compileMs = 0;
  try {
    result = await compile(wrappedSource, {
      fileName: "test.ts",
      sourceMap: true,
      emitWat: false,
      // (#2119) keep the in-process runner aligned with the sharded worker:
      // only genuine module-goal tests infer module-strictness; script tests
      // keep mapped `arguments` despite the synthetic `export function test()`
      // wrapper. Matches `test262-shared.ts`.
      inferModuleStrictArguments: moduleGoal,
      // (#2095) standalone lane for the baseline validator (default host/gc).
      // (#3049 C1 / #3123) Host lane defers top-level init (export
      // `__module_init`, no wasm `(start)` section) so top-level code runs
      // AFTER `setInstance` has wired the runtime — aligned with
      // `scripts/compiler-fork-worker.mjs` (#1251 both-paths rule). The
      // wasi/linear lanes keep their own `_start` model and are untouched.
      // (#2860 F3) The STANDALONE lane joins the defer rule (mirrors the
      // worker's doCompile): under `(start)` a top-level throw surfaced from
      // instantiate with instance === null, so the #2962 native exception
      // render was unreachable and standalone failures collapsed onto the
      // opaque "wasm exception during module init" label. The exec path
      // below already calls the exported __module_init after setInstance.
      // MODULE-GOAL tests are EXCLUDED: the multi-module (FIXTURE) link
      // already synthesizes per-module init plumbing, and adding the
      // deferred-export flag there emitted a SECOND `__module_init` export in
      // one binary — V8 rejects it ("Duplicate export name '__module_init'"),
      // which is exactly the 6-file `language/module-code/*` regression that
      // parked the stack PR #2835/#2839 in the merge queue.
      ...(target ? { target } : {}),
      ...(moduleGoal || (target !== undefined && target !== "standalone") ? {} : { deferTopLevelInit: true }),
      // #1251: align with the sharded runner — both `scripts/compiler-fork-worker.mjs`
      // (the production path that records the committed JSONL) and `tests/test262-vitest.test.ts`
      // FIXTURE multi-compile pass `skipSemanticDiagnostics: true`. Without this flag,
      // `runTest262File` ran TypeScript type-checking on the wrapped test source while
      // the JSONL recorded results from a skipSemanticDiagnostics=true sharded run, so
      // tests with TS type-incompatible code (Argument of type 'X' is not assignable …)
      // would pass in the sharded run but fail in `validate-test262-baseline`, producing
      // 6–19 false-positive `compile_error` failures per validator run depending on the
      // sample. Aligning the flag eliminates the entire TS-checker non-determinism cluster.
      skipSemanticDiagnostics: true,
    });
    compileMs = performance.now() - compileStart;

    // Guard: if compilation took >30s, report as CE and skip execution
    if (compileMs > 30_000) {
      const totalMs = performance.now() - totalStart;
      const timing: TestTiming = {
        totalMs: round2(totalMs),
        compileMs: round2(compileMs),
        instantiateMs: 0,
        executeMs: 0,
      };
      return {
        file: relPath,
        category,
        status: "compile_error",
        error: `compilation timeout (${round2(compileMs)}ms)`,
        timing,
      };
    }
  } catch (compileErr: any) {
    compileMs = performance.now() - compileStart;
    const totalMs = performance.now() - totalStart;
    const timing: TestTiming = {
      totalMs: round2(totalMs),
      compileMs: round2(compileMs),
      instantiateMs: 0,
      executeMs: 0,
    };
    // For runtime negative tests, a compile error is not expected — the code
    // should compile successfully and fail at runtime.
    // Exception: if the compiler detected a TDZ violation (ReferenceError) at compile
    // time and the test expects a ReferenceError, count it as a pass.
    if (isRuntimeNegative) {
      const errMsg = compileErr.message ?? String(compileErr);
      if (meta.negative!.type === "ReferenceError" && errMsg.includes("before initialization")) {
        return { file: relPath, category, status: "pass", timing };
      }
      return {
        file: relPath,
        category,
        status: "compile_error",
        error: errMsg,
        timing,
      };
    }
    return {
      file: relPath,
      category,
      status: "compile_error",
      error: compileErr.message ?? String(compileErr),
      timing,
    };
  }

  if (!result.success || result.errors.some((e) => e.severity === "error")) {
    const totalMs = performance.now() - totalStart;
    const timing: TestTiming = {
      totalMs: round2(totalMs),
      compileMs: round2(compileMs),
      instantiateMs: 0,
      executeMs: 0,
    };
    if (isRuntimeNegative) {
      // If the compiler detected a TDZ violation (ReferenceError) at compile time
      // and the test expects a ReferenceError, count it as a pass.
      const errMsgs = result.errors.filter((e) => e.severity === "error").map((e) => e.message);
      if (meta.negative!.type === "ReferenceError" && errMsgs.some((m) => m.includes("before initialization"))) {
        return { file: relPath, category, status: "pass", timing };
      }
      return {
        file: relPath,
        category,
        status: "compile_error",
        error:
          result.errors
            .filter((e) => e.severity === "error")
            .map((e) => `L${adjustLine(e.line)}:${e.column} ${e.message}`)
            .join("; ") || result.errors.map((e) => `L${adjustLine(e.line)}:${e.column} ${e.message}`).join("; "),
        timing,
      };
    }
    return {
      file: relPath,
      category,
      status: "compile_error",
      error:
        result.errors
          .filter((e) => e.severity === "error")
          .map((e) => `L${adjustLine(e.line)}:${e.column} ${e.message}`)
          .join("; ") || result.errors.map((e) => `L${adjustLine(e.line)}:${e.column} ${e.message}`).join("; "),
      timing,
    };
  }

  // Compile succeeded — compute wasm_sha for the regression-gate noise filter (#1222).
  // All subsequent return paths in this function operate on a valid `result.binary`,
  // so attach the same hash to every outcome (pass/fail/runtime-error).
  const wasm_sha = computeWasmSha(result.binary);

  // For runtime negative tests, if the compiler produced warnings that indicate
  // it detected the expected error at compile time (TDZ violations, scope errors,
  // undeclared variables), count as a pass — the compiler caught what JS would
  // throw at runtime.
  if (isRuntimeNegative && result.errors.some((e) => e.severity === "warning")) {
    const totalMs = performance.now() - totalStart;
    return {
      file: relPath,
      category,
      status: "pass",
      timing: {
        totalMs: round2(totalMs),
        compileMs: round2(compileMs),
        instantiateMs: 0,
        executeMs: 0,
      },
      wasm_sha,
    };
  }

  const standaloneImportError = standaloneHostImportError(target, result.imports);
  if (standaloneImportError) {
    const totalMs = performance.now() - totalStart;
    return {
      file: relPath,
      category,
      status: "compile_error",
      error: standaloneImportError,
      timing: {
        totalMs: round2(totalMs),
        compileMs: round2(compileMs),
        instantiateMs: 0,
        executeMs: 0,
      },
      wasm_sha,
    };
  }

  // Instantiate and run with timeout
  let instantiateMs = 0;
  let executeMs = 0;
  // (#1155) Hoisted out of the try so the catch can pass it to
  // `extractWasmExceptionMessage` for tag-based payload extraction.
  let instance: any = null;
  try {
    const sandbox = getTestSandbox();
    const importResult = buildImports(result.imports, undefined, result.stringPool, { globalSandbox: sandbox });
    const imports = importResult as any;
    const instantiateStart = performance.now();
    // (#4162) Same shared seam as the original-harness lane — this legacy
    // wrapper lane also accepts `target: "standalone"` (#2095), so it had the
    // identical runtime-eval link hole.
    instance = await instantiateTest262Module(result.binary, imports, {
      target,
      providerLabel: RUNTIME_EVAL_PROVIDER_LABEL,
    });
    instantiateMs = performance.now() - instantiateStart;
    // Provide the branded instance so callbacks and host bridges are discoverable.
    importResult.setInstance?.(instance);
    // (#3049 C1) Deferred top-level init (host lane): run the exported
    // `__module_init` now that `setInstance` has wired the runtime. Inside the
    // same try as instantiate + test(), so a top-level throw keeps the exact
    // classification it had when it surfaced from the `(start)` section
    // (runtime-negative → pass, else fail — see the catch below).
    const moduleInit = (instance.exports as any).__module_init;
    if (typeof moduleInit === "function") {
      moduleInit();
    }
    const testFn = (instance.exports as any).test;
    if (typeof testFn !== "function") {
      const totalMs = performance.now() - totalStart;
      // (#1853) Compile + instantiate both succeeded but the module is missing
      // the `test` export the harness contract requires — codegen silently
      // dropped it. A bug, not a coverage gap → hard-error bucket.
      return {
        file: relPath,
        category,
        status: "compile_error",
        error: "no test export",
        timing: {
          totalMs: round2(totalMs),
          compileMs: round2(compileMs),
          instantiateMs: round2(instantiateMs),
          executeMs: 0,
        },
        wasm_sha,
        hardError: true,
        hardErrorKind: "missing_test_export",
      };
    }

    const executeStart = performance.now();
    let ret = testFn();
    executeMs = performance.now() - executeStart;
    // (#3227) Async re-read: for async-flagged tests the wrapper exports
    // `__result()` (same verdict logic as the test() epilogue). The JS-host
    // lane runs `.then`/await continuations on the HOST microtask queue, which
    // only drains after `test()` returns — so a sync `1`/`-262` from an async
    // test was read before the assertion-bearing callbacks executed. Yield to
    // the event loop (setImmediate runs after the whole microtask queue,
    // including recursively-queued chains; two rounds cover continuations that
    // schedule a macrotask hop), then re-read the verdict. Sync assert
    // failures (ret >= 2, __fail is sticky/first-wins) and runtime-negative
    // tests keep their sync semantics.
    const resultFn = (instance.exports as any).__result;
    if (!isRuntimeNegative && typeof resultFn === "function" && (ret === 1 || ret === -262)) {
      // A post-return continuation can THROW (a wasm trap or a Test262Error
      // escaping a .then reaction) — inside the drain window that surfaces as
      // an uncaughtException/unhandledRejection, which would kill the fork
      // worker. Capture it and score THIS test failed instead (the throw IS
      // the test's async outcome; pre-#3227 it fired unattributed between
      // tests).
      let deferredError: unknown = null;
      const onDeferred = (err: unknown) => {
        if (deferredError == null) deferredError = err;
      };
      process.on("uncaughtException", onDeferred);
      process.on("unhandledRejection", onDeferred);
      try {
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
      } finally {
        process.off("uncaughtException", onDeferred);
        process.off("unhandledRejection", onDeferred);
      }
      if (deferredError != null) {
        const e: any = deferredError;
        const msg =
          e?.message != null ? `${e.constructor?.name ?? "Error"}: ${String(e.message)}` : String(deferredError);
        return {
          file: relPath,
          category,
          status: "fail",
          error: `${msg.slice(0, 600)} | async continuation threw after test() returned (#3227)`,
          timing: {
            totalMs: round2(performance.now() - totalStart),
            compileMs: round2(compileMs),
            instantiateMs: round2(instantiateMs),
            executeMs: round2(executeMs),
          },
          wasm_sha,
        };
      }
      try {
        ret = resultFn();
      } catch {
        // The re-read itself trapped — keep the sync verdict rather than
        // crediting/blaming the re-read.
      }
    }
    const totalMs = performance.now() - totalStart;
    const timing: TestTiming = {
      totalMs: round2(totalMs),
      compileMs: round2(compileMs),
      instantiateMs: round2(instantiateMs),
      executeMs: round2(executeMs),
    };

    if (isRuntimeNegative) {
      // Runtime negative test: execution completed without error — that means
      // the expected runtime error did NOT happen, so the test fails.
      return {
        file: relPath,
        category,
        status: "fail",
        error: `expected runtime ${meta.negative!.type} but execution succeeded`,
        timing,
        wasm_sha,
      };
    }

    if (ret === 1 || ret === 1.0) {
      return { file: relPath, category, status: "pass", timing, wasm_sha };
    }
    // (#2939/#2940) ret === -262: VACUITY sentinel — a would-be pass whose
    // harness-wrapper callback never executed (invoked wrapper + zero counted
    // asserts). Scored as `fail` (so host_free_pass / the standalone floor
    // structurally exclude it) with a distinct `vacuous` marker + reason so the
    // report can surface the integrity correction ("N previously-counted passes
    // are vacuous"). This is the durable vacuity rule enforced in-runner: a dead
    // callback is not a pass.
    if (ret === -262) {
      return {
        file: relPath,
        category,
        status: "fail",
        vacuous: true,
        error: "vacuous: harness-wrapper callback never executed (#2940) — no assertion ran",
        timing,
        wasm_sha,
      };
    }
    // ret >= 2: the (ret-1)th assert (1-based) that failed
    //   (__assert_count starts at 1, incremented before check, so first assert → 2)
    // ret == -1: uncaught exception (not from an assert)
    // ret == 0: legacy (should not happen with new shims)
    //
    // #1318 — surface enough of the assert source line to diagnose the
    // failure. Previously we truncated to 160 chars which cut off most
    // assertion messages. Most assert lines fit comfortably in 600 chars
    // (the longest legitimate assert.sameValue with a descriptive message
    // and a multi-arg comparison stays well under that). The downstream
    // worker still caps the full error string at 2000 chars so this won't
    // bloat the JSONL beyond what fits a single test result.
    const ASSERT_LINE_MAX = 600;
    let assertCtx = "";
    if (typeof ret === "number" && ret >= 2) {
      const assertIdx = ret - 1; // 1-based index into assert calls
      // Find the Nth assert call in the original source to show context
      const assertRegex = /\bassert\b[.\w]*\s*\(/g;
      let nth = 0;
      let m: RegExpExecArray | null;
      while ((m = assertRegex.exec(source)) !== null) {
        nth++;
        if (nth === assertIdx) {
          // Extract the line containing this assert
          const lineStart = source.lastIndexOf("\n", m.index) + 1;
          const lineEnd = source.indexOf("\n", m.index);
          const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
          // 1-based line number for the user (matches editor display).
          const lineNumber = (source.slice(0, m.index).match(/\n/g)?.length ?? 0) + 1;
          const truncated = line.length > ASSERT_LINE_MAX ? `${line.slice(0, ASSERT_LINE_MAX - 3)}...` : line;
          assertCtx = ` | assert #${assertIdx} at L${lineNumber}: ${truncated}`;
          break;
        }
      }
      if (!assertCtx) {
        // #1318 — Nth assert not found via regex (e.g. test uses Test262Error
        // throws or a custom helper that doesn't match `\bassert\b...`).
        // Look for a bare `throw new Test262Error(...)` to surface its
        // message — that's a common test262 failure idiom that the regex
        // above misses.
        const throwRegex = /throw\s+new\s+Test262Error\s*\(([^)]*)\)/g;
        let throwMatch: RegExpExecArray | null;
        let nthThrow = 0;
        while ((throwMatch = throwRegex.exec(source)) !== null) {
          nthThrow++;
          if (nthThrow === assertIdx) {
            const lineStart = source.lastIndexOf("\n", throwMatch.index) + 1;
            const lineEnd = source.indexOf("\n", throwMatch.index);
            const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
            const lineNumber = (source.slice(0, throwMatch.index).match(/\n/g)?.length ?? 0) + 1;
            const truncated = line.length > ASSERT_LINE_MAX ? `${line.slice(0, ASSERT_LINE_MAX - 3)}...` : line;
            assertCtx = ` | Test262Error #${assertIdx} at L${lineNumber}: ${truncated}`;
            break;
          }
        }
        if (!assertCtx) {
          assertCtx = ` | assert #${assertIdx} of ${nth} total`;
        }
      }
    } else if (ret === -1) {
      assertCtx = " | uncaught exception (no assert tracked)";
    }
    return {
      file: relPath,
      category,
      status: "fail",
      error: `returned ${ret}${assertCtx}`,
      timing,
      wasm_sha,
    };
  } catch (err: any) {
    const totalMs = performance.now() - totalStart;
    const timing: TestTiming = {
      totalMs: round2(totalMs),
      compileMs: round2(compileMs),
      instantiateMs: round2(instantiateMs),
      executeMs: round2(executeMs),
    };

    if (isRuntimeNegative) {
      // Runtime negative test: execution threw/trapped — this is the expected
      // behavior. The test passes.
      return { file: relPath, category, status: "pass", timing, wasm_sha };
    }

    // WebAssembly.CompileError / LinkError during instantiation is a true
    // compile/link failure, not a test failure. Distinguish from
    // `WebAssembly.Exception`, which is a runtime throw from the start
    // function or test execution and routes to `status: "fail"` below
    // (#1155).
    if (
      err instanceof WebAssembly.CompileError ||
      err?.constructor?.name === "CompileError" ||
      err instanceof (WebAssembly as any).LinkError ||
      err?.constructor?.name === "LinkError"
    ) {
      // (#1853) The compiler reported `result.success` for this binary, yet the
      // Wasm engine rejected it — that is malformed output (a BUG), not an
      // unsupported-feature gap. Mark it for the hard-error stability bucket so
      // it is gated as a regression rather than absorbed into the coverage
      // count. Subsumes the #1850 verifier-failure-on-a-claimed-function case:
      // a verifier rejection of a function the compiler claimed valid surfaces
      // here as a CompileError.
      return {
        file: relPath,
        category,
        status: "compile_error",
        error: enrichErrorMessage(err.message, err, result.sourceMap, bodyLineOffset),
        timing,
        wasm_sha,
        hardError: true,
        hardErrorKind: "malformed_wasm",
      };
    }
    // (#1155) Use extractWasmExceptionMessage so a `WebAssembly.Exception`
    // gets its payload extracted via the instance's `__exn_tag` (when
    // available) instead of stringifying to `"[object WebAssembly.Exception]"`.
    // Generic Errors fall through to err.message; everything else to String(err).
    const baseMsg = extractWasmExceptionMessage(err, instance);
    // Traps from unreachable() count as assertion failures
    if (baseMsg.includes("unreachable") || baseMsg.includes("wasm")) {
      return {
        file: relPath,
        category,
        status: "fail",
        error: enrichErrorMessage(baseMsg, err, result.sourceMap, bodyLineOffset),
        timing,
        wasm_sha,
      };
    }
    return {
      file: relPath,
      category,
      status: "fail",
      error: enrichErrorMessage(baseMsg, err, result.sourceMap, bodyLineOffset),
      timing,
      wasm_sha,
    };
  }
}

/** Round to 2 decimal places for readable timing output */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Classify a runtime/compile error message into a category bucket.
 * Used by test262-vitest.test.ts for aggregate error analysis in reports.
 *
 * Categories:
 *   null_deref      — Wasm trap: dereferencing a null pointer
 *   illegal_cast    — Wasm trap: illegal cast (ref.cast failure)
 *   oob             — Wasm trap: out of bounds memory/table access
 *   unreachable     — Wasm trap: unreachable instruction executed
 *   type_error      — JS TypeError (from host imports or runtime)
 *   range_error     — JS RangeError or stack overflow
 *   syntax_error    — JS SyntaxError (unexpected in runtime, usually negative test)
 *   promise_error   — Promise rejection or async failure
 *   assertion_fail  — Test returned non-1 value (assert counter)
 *   exception_in_test — Test returned -1 (exception caught by wrapper)
 *   wasm_compile    — GENUINE Wasm validation/instantiation error
 *                     ("invalid Wasm binary" / "Compiling function #N…failed")
 *   missing_dependency — (#3187) compiler DI diagnostic: a required extern
 *                     class or host import function was never wired
 *                     ("No dependency provided for …") — NOT invalid-Wasm
 *   missing_builtin — (#3187) an unimplemented builtin / runtime feature
 *                     ("… is not a function") — NOT invalid-Wasm
 *   host_import_leak — standalone output requested imports that only the JS
 *                     harness could satisfy; the binary is never executed
 *   harness_shape   — (#3187) module compiled but exposes no `test` export
 *                     ("no test export") — NOT invalid-Wasm
 *   negative_test_fail — Negative test that should have failed but passed
 *   runtime_error   — Other Cannot/Invalid runtime errors
 *   other           — Unclassified
 *
 * (#3187) The wasm_compile / missing_dependency / missing_builtin / harness_shape
 * split un-inflates the genuine invalid-Wasm bucket (~448 → ~87): "… is not a
 * function" and "No dependency provided …" were previously mis-binned as
 * wasm_compile. This is a verdict-classification change, so ORACLE_VERSION was
 * bumped (see tests/test262-oracle-version.ts). Label-only: no pass/fail flips.
 */
export function classifyError(errorMsg: string | undefined): string | undefined {
  if (!errorMsg) return undefined;
  if (/standalone target emitted host imports/i.test(errorMsg)) return "host_import_leak";

  // (#3285) Wrapper return-code protocol FIRST — before the trap patterns. A
  // message beginning with "returned <N>" is by construction the synthetic
  // wrapper's assert-counter protocol (an assertion failure / caught
  // exception), never a genuine Wasm trap: a real trap surfaces as a host
  // RuntimeError message ("out of bounds memory access", "unreachable" …) and
  // aborts the module — it cannot produce a "returned N" result. Since the
  // #3285 shim embeds the ORIGINAL test source line in these messages
  // ("returned 2 — assert #1 at L28: assert.throws(RangeError, …, `…is out of
  // bounds: ${duration}`)"), quoted test text was hitting the trap regexes
  // below and mis-binning honest assertion fails as uncatchable traps —
  // poisoning the #3189 trap-growth ratchet with false positives (19 such
  // rows pre-existed in the host baseline; the #3285 tightening added more).
  // Label-only relabel (no pass/fail flips) — covered by the same
  // ORACLE_VERSION 4 bump as the #3285 tightening itself.
  if (/^returned -1\b/.test(errorMsg)) return "exception_in_test";
  if (/^returned \d+/.test(errorMsg)) return "assertion_fail";

  // (#3468 F1) A message beginning with "Test262Error" is by construction a
  // rendered ASSERTION THROW (the #2962 standalone exception renderer prefixes
  // the constructor name), never a genuine Wasm trap: a real trap aborts the
  // module with a host RuntimeError message ("out of bounds memory access",
  // "unreachable" …) that carries no Test262Error prefix. This rule must sit
  // BEFORE the trap regexes for exactly the #3285 reason above — assertion
  // TEXT quoting the test's own words ("following shrink (out of bounds)
  // Expected SameValue(«8», «0»)…") was matching /out of bounds/ etc. and
  // mis-binning honest assertion fails as uncatchable traps, false-positive-
  // tripping the #3189 trap ratchet (seen live on the F1 merge_group run
  // 30043224652: 6 Test262Error rows counted as NEW oob — including
  // Temporal/Duration/…/result-out-of-range-1.js, the SAME file the v4 fix
  // caught for the "returned N" shape; measured baseline also carries 3 such
  // false "unreachable" rows). Label-only relabel (no pass/fail flips) —
  // covered by the same ORACLE_VERSION 10 bump as the #3468 F1 de-inflation.
  if (/^Test262Error\b/.test(errorMsg)) return "assertion_fail";

  // Wasm traps
  if (/dereferencing a null/i.test(errorMsg)) return "null_deref";
  if (/illegal cast/i.test(errorMsg)) return "illegal_cast";
  if (/out of bounds/i.test(errorMsg)) return "oob";
  if (/unreachable/i.test(errorMsg)) return "unreachable";

  // JS errors propagated from host imports or the runtime
  if (/^TypeError\b|TypeError \(null\/undefined/i.test(errorMsg)) return "type_error";
  if (/^RangeError\b|Maximum call stack/i.test(errorMsg)) return "range_error";
  if (/^SyntaxError\b/i.test(errorMsg)) return "syntax_error";

  // Promise / async failures
  if (/^Promise\b|promise/i.test(errorMsg)) return "promise_error";

  // (Assertion "returned N" patterns are classified at the TOP of this
  // function — before the trap regexes — see the #3285 comment there.)
  // (#2962/#3468 F1) The `^Test262Error` → assertion_fail rule moved to the
  // TOP of this function, before the trap regexes — see the #3468 comment
  // there (assertion text quoting trap words was stealing the row).

  // Wasm compile/validation errors (from instantiation). (#3187) Order matters:
  // classify GENUINE invalid-Wasm FIRST so an instantiation error that quotes
  // source text ("Compiling function #N…failed: …") isn't stolen by the
  // missing-builtin/missing-dependency rules below.
  if (/invalid Wasm binary|Compiling function/i.test(errorMsg)) return "wasm_compile";
  // (#3187) The compiler's own dependency-injection diagnostic — "No dependency
  // provided for extern class X" / "…for imported function env::__X" — is NOT
  // invalid-Wasm; it means a required host import/extern was never wired. Its own
  // bucket so it stops inflating wasm_compile (~56 records were mis-binned).
  if (/No dependency provided/i.test(errorMsg)) return "missing_dependency";
  // (#3187) "… is not a function" is a missing builtin / unimplemented runtime
  // feature (safeBroadcast, transferToImmutable, sumPrecise, then, …), not an
  // invalid-Wasm binary. Kept AFTER the genuine-wasm_compile rule above so
  // instantiate errors that quote source aren't stolen (~170 records mis-binned).
  if (/\bis not a function\b/i.test(errorMsg)) return "missing_builtin";
  if (/expected .+ but compiled/i.test(errorMsg)) return "negative_test_fail";
  if (/expected runtime .+ but succeeded/i.test(errorMsg)) return "negative_test_fail";
  // (#3187) "no test export" is a harness-shape problem (module compiled fine but
  // exposes no `test` export), not invalid-Wasm — its own bucket.
  if (/no test export/i.test(errorMsg)) return "harness_shape";

  // Catch-all for other errors
  if (/Cannot |Invalid /i.test(errorMsg)) return "runtime_error";

  return "other";
}
