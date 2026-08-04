// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3418 — the test262 literal-harness runtime shim leaked two UNUSED host
// imports (`console_log_externref` from `var print`, `structuredClone` from
// `$262.detachArrayBuffer`) into every standalone compile, so the #2961
// standalone gate rejected ~29.8k official rows whose tests never mention
// `print`/`$262`. The fix is a pre-parse dead-binding elision
// (`src/deadcode-elide.ts`, wired in `compiler.ts` for standalone/wasi only):
// a top-level var statement with pure initializers whose names are never
// mentioned again (identifier, property name, or string) is blanked before
// the parser, so the unified import collector never requests the imports.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";
import { elideDeadTopLevelBindings } from "../src/deadcode-elide.js";

const ROOT = join(import.meta.dirname, "..");
const shim = readFileSync(join(ROOT, "scripts", "test262-fyi-runtime.js"), "utf8");
const assertJs = readFileSync(join(ROOT, "test262", "harness", "assert.js"), "utf8");
const staJs = readFileSync(join(ROOT, "test262", "harness", "sta.js"), "utf8");
const harnessPrefix = shim + assertJs + staJs;

// Exactly the worker's originalHarness standalone compile options
// (scripts/test262-worker.mjs `doCompile`).
const standaloneOpts = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  target: "standalone" as const,
  inferModuleStrictArguments: false,
};

const importNames = (r: { imports: { name: string }[] }): string[] => r.imports.map((i) => i.name).sort();

async function runStandalone(binary: Uint8Array): Promise<void> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  const start = (instance.exports._start ?? instance.exports.__module_init) as (() => void) | undefined;
  start?.();
}

describe("#3418 — shim-only standalone tests compile host-free", () => {
  it("shim+assert+sta+body emits ZERO imports and runs (sloppy)", async () => {
    const r = await compile(
      harnessPrefix +
        `assert.sameValue(2 * 21, 42);
assert.throws(Test262Error, function () { throw new Test262Error("boom"); });
assert(true, "plain assert");
`,
      standaloneOpts,
    );
    expect(r.success).toBe(true);
    expect(importNames(r)).toEqual([]);
    await runStandalone(r.binary);
  });

  it("strict-rerun shape also compiles host-free and runs", async () => {
    const r = await compile('"use strict";\n' + harnessPrefix + "assert.sameValue(1 + 1, 2);\n", standaloneOpts);
    expect(r.success).toBe(true);
    expect(importNames(r)).toEqual([]);
    await runStandalone(r.binary);
  });

  it("assert.js + sta.js alone stay host-free (control)", async () => {
    const r = await compile(assertJs + staJs + "assert.sameValue(1, 1);\n", standaloneOpts);
    expect(r.success).toBe(true);
    expect(importNames(r)).toEqual([]);
  });
});

// NOTE (post-#3369 / #3436): the standalone contract changed underneath these
// tests. Sibling PR #3369 made standalone `console.*` a native no-op sink that
// registers NO `console_*` host import, and skips the `structuredClone` host
// import entirely (the global stays undefined, `typeof structuredClone` folds
// to "undefined"). So on the standalone/wasi lane a LIVE use of `print`/`$262`
// no longer materializes any host import — the imports these tests originally
// guarded no longer exist there. The "no semantic laundering" honesty question
// (does eliding a dead binding hide a genuinely-needed import?) is therefore
// moot for `print`/`$262` on standalone: even a kept, live binding imports
// nothing. These cases are reworked to assert the NEW invariant (standalone
// use ⇒ zero imports); the honesty guard that a live use keeps a REAL import
// now lives on the js-host lane below, where the imports are genuine.
describe("#3418 — standalone print/$262 use emits no imports (post-#3369 host-free contract)", () => {
  it("a test that CALLS print emits zero imports (standalone console no-op sink) and runs", async () => {
    const r = await compile(harnessPrefix + 'print("hello");\n', standaloneOpts);
    expect(r.success).toBe(true);
    expect(importNames(r)).toEqual([]);
    await runStandalone(r.binary);
  });

  it("doneprintHandle.js (async include) references print → binding kept, still host-free", async () => {
    const done = readFileSync(join(ROOT, "test262", "harness", "doneprintHandle.js"), "utf8");
    const r = await compile(done + harnessPrefix + "$DONE();\n", standaloneOpts);
    expect(r.success).toBe(true);
    expect(importNames(r)).toEqual([]);
  });

  it("a test using $262.detachArrayBuffer emits no structuredClone import (standalone skips it)", async () => {
    const r = await compile(
      harnessPrefix + "var ab = new ArrayBuffer(8);\n$262.detachArrayBuffer(ab);\n",
      standaloneOpts,
    );
    expect(r.success).toBe(true);
    expect(importNames(r)).toEqual([]);
  });

  it("typeof print is a mention → binding kept, but still zero imports (no console host)", async () => {
    const r = await compile(harnessPrefix + 'assert.sameValue(typeof print, "function");\n', standaloneOpts);
    expect(r.success).toBe(true);
    expect(importNames(r)).toEqual([]);
    await runStandalone(r.binary);
  });

  it('a string mention ("print" / globalThis["print"]) blocks the drop but adds no import', async () => {
    const r = await compile(
      harnessPrefix + 'var f = globalThis["print"];\nassert.sameValue(typeof f, "function");\n',
      standaloneOpts,
    );
    expect(r.success).toBe(true);
    expect(importNames(r)).toEqual([]);
  });
});

describe("#3418 — host lane is byte-identical (gate excludes gc/linear)", () => {
  it("default (js-host) compile of the same source keeps both imports", async () => {
    const src = harnessPrefix + "assert.sameValue(1, 1);\n";
    const hostOpts = { ...standaloneOpts, target: undefined };
    const r = await compile(src, hostOpts);
    expect(r.success).toBe(true);
    expect(importNames(r)).toContain("console_log_externref");
    expect(importNames(r)).toContain("structuredClone");
  });

  // Honesty guard (relocated from standalone → js-host, post-#3369): on the
  // host lane the console/structuredClone imports ARE real, so a live use must
  // keep them — the elision (standalone/wasi-only) never runs here, and no
  // no-op-sink lowering applies. This is the "no semantic laundering" check
  // that standalone can no longer host.
  it("js-host: a test that CALLS print keeps console_log_externref (import is real)", async () => {
    const hostOpts = { ...standaloneOpts, target: undefined };
    const r = await compile(harnessPrefix + 'print("hello");\n', hostOpts);
    expect(r.success).toBe(true);
    expect(importNames(r)).toContain("console_log_externref");
  });

  it("js-host: $262.detachArrayBuffer keeps structuredClone (import is real)", async () => {
    const hostOpts = { ...standaloneOpts, target: undefined };
    const r = await compile(harnessPrefix + "var ab = new ArrayBuffer(8);\n$262.detachArrayBuffer(ab);\n", hostOpts);
    expect(r.success).toBe(true);
    expect(importNames(r)).toContain("structuredClone");
  });
});

describe("#3418 — generality beyond the harness (any standalone program)", () => {
  it("an unused host-touching binding no longer forces a host import", async () => {
    const r = await compile(
      `var debugLog = function (x: number) { console.log(x); };
export function double(n: number): number { return n * 2; }
`,
      { target: "standalone" },
    );
    expect(r.success).toBe(true);
    expect(importNames(r)).toEqual([]);
  });

  it("wasi target elides too (strict no-host-imports gate no longer trips)", async () => {
    const r = await compile(
      `var debugLog = function (x: number) { console.log(x); };
export function double(n: number): number { return n * 2; }
`,
      { target: "wasi" },
    );
    expect(r.success).toBe(true);
    expect(r.errors.filter((e) => e.severity === "error")).toEqual([]);
  });
});

describe("#3418 — elideDeadTopLevelBindings unit behavior", () => {
  const elide = (src: string) => elideDeadTopLevelBindings(src, ts.ScriptKind.JS);

  it("is strictly length-preserving with newlines kept (identity positions)", () => {
    const src = shim + "var x = 1;\nx;\n";
    const out = elide(src);
    expect(out.source.length).toBe(src.length);
    expect(out.source.split("\n").length).toBe(src.split("\n").length);
    expect(out.elided.sort()).toEqual(["$262", "print"]);
    // `x` is mentioned → kept.
    expect(out.source).toContain("var x = 1;");
  });

  it("fixpoint: a chain rooted at a live use keeps the whole chain", () => {
    // `b`'s initializer reads `a` (not in the pure whitelist) → b is not a
    // candidate → its mention of `a` is live → a is kept.
    const out = elide("var a = function () { return 1; };\nvar b = a;\nb();\n");
    expect(out.elided).toEqual([]);
  });

  it("multi-declarator statements are all-or-nothing", () => {
    const out = elide("var dead1 = function () {}, dead2 = 42;\n");
    expect(out.elided.sort()).toEqual(["dead1", "dead2"]);
    const kept = elide("var dead = function () {}, live = 42;\nlive;\n");
    expect(kept.elided).toEqual([]);
  });

  it("declaration-only `var x;` with no mentions is elided", () => {
    const out = elide("var x;\nvar y = 1;\ny;\n");
    expect(out.elided).toEqual(["x"]);
  });

  it("bails (identity) on syntax errors", () => {
    const src = "var broken = function ( { ;\n";
    const out = elide(src);
    expect(out.source).toBe(src);
    expect(out.elided).toEqual([]);
  });

  it("template-literal chunks count as mentions", () => {
    const out = elide("var probe = function () {};\nvar msg = `has probe${1}suffix`;\nmsg;\n");
    // `probe` appears only INSIDE a template chunk text? No — "has probe" is
    // not an exact match of "probe"; exact-text matching is intentional so
    // `Test262Error` never pins `$262`. The exact chunk case:
    expect(out.elided).toEqual(["probe"]);
    const blocked = elide("var probe = function () {};\nvar msg = `${1}probe${2}`;\nmsg;\n");
    expect(blocked.elided).toEqual([]);
  });

  it("does not touch export/declare statements or impure initializers", () => {
    const out = elide("export var kept = function () {};\nvar eager = sideEffect();\n");
    expect(out.elided).toEqual([]);
  });

  it("retains all bindings when eval can name them through computed source", () => {
    const src =
      'var hidden = 40;\nvar helper = function (x) { return x + 2; };\n(0, eval)(prefix + "helper(hidden)");\n';
    const out = elide(src);
    expect(out.source).toBe(src);
    expect(out.elided).toEqual([]);
  });

  it("retains only names mentioned by literal eval source", () => {
    const src =
      'var hidden = 40;\nvar helper = function (x) { return x + 2; };\nvar unused = function () {};\neval("helper(hidden)");\n';
    const out = elide(src);
    expect(out.source).toContain("var hidden = 40;");
    expect(out.source).toContain("var helper = function");
    expect(out.elided).toEqual(["unused"]);
  });

  it("does not let literal eval revive a dead evalScript-style shim", () => {
    const src =
      'var shim = { evalScript: function (source) { return eval(source); } };\nvar answer = 42;\neval("answer");\n';
    const out = elide(src);
    expect(out.source).toContain("var answer = 42;");
    expect(out.elided).toEqual(["shim"]);
  });

  it("retains all bindings when the Function constructor can name them", () => {
    const src =
      'var hidden = 40;\nvar helper = function (x) { return x + 2; };\nvar Ctor = Function;\nnew Ctor(prefix + "return helper(hidden)");\n';
    const out = elide(src);
    expect(out.source).toBe(src);
    expect(out.elided).toEqual([]);
  });

  it("never elides early-error binding names (strict `var eval` stays a SyntaxError)", async () => {
    const out = elide('"use strict";\nvar eval = function () {};\n');
    expect(out.elided).toEqual([]);
    // End-to-end: the negative-test verdict must survive — the compile still
    // reports the strict-mode early error instead of silently succeeding.
    const r = await compile('"use strict";\nvar eval = function () {};\n', standaloneOpts);
    expect(r.success && r.errors.filter((e) => e.severity === "error").length === 0).toBe(false);
  });
});
