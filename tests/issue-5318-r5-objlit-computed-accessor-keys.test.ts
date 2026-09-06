// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5318 r5 Step 2 — an OBJECT LITERAL accessor whose ComputedPropertyName is
// only known at evaluation time.
//
// `literals.ts`'s accessor pre-pass resolved each `get`/`set` key to a
// compile-time string (`resolveAccessorPropName`) and skipped every key it
// could not fold — "arbitrary computed key: out of scope". So
// `{ get [s]() {} }` with a symbol-valued `s` installed NOTHING: the read
// answered `undefined`, and a later `A[s] = v` quietly created a plain DATA
// property where the spec has an accessor. Measured on the base tree, four
// distinct shapes were wrong and none of them threw.
//
// This is the object-literal twin of the class mechanism #5318 r4 built. Each
// half now evaluates its own key at its own source position and installs
// itself alone, marking WHICH half it defines with bits 8/9 of the
// `__defineProperty_accessor` flag word — the same §10.1.6.3 merge
// `class-proto-accessors.ts::classAccessorInstallFlags` uses, so a `set [k]`
// after a `get [k]` merges instead of blanking it.
//
// A literal with no dynamic-keyed accessor is byte-identical to origin/main on
// host, wasi and standalone (`.tmp/w5/5318/bytes.mts`, 2026-09-05).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

/** Test262 rows this step flips, measured fail → pass against `git archive origin/main`. */
const STEP_2_ROWS = [
  "language/computed-property-names/object/accessor/getter.js",
  "language/computed-property-names/object/accessor/setter.js",
] as const;

async function runStandalone(source: string, exportName: string, fileName: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(result.imports, "#5318 standalone controls must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, () => unknown>)[exportName]!();
}

function runHost(source: string, exportName: string): unknown {
  const hostSource = source.replace(/\bexport\s+/g, "");
  return (new Function(`${hostSource}\nreturn ${exportName};`)() as () => unknown)();
}

describe("#5318 r5 Step 2 — Test262 rows", () => {
  for (const relativePath of STEP_2_ROWS) {
    const file = resolve(process.cwd(), "test262", "test", relativePath);
    it.skipIf(!existsSync(file))(
      `step 2: ${relativePath} passes in standalone`,
      async () => {
        try {
          const standalone = await runTest262File(file, "issue-5318-r5", 60_000, "standalone");
          expect({ status: standalone.status, error: standalone.error }).toEqual({
            status: "pass",
            error: undefined,
          });
        } finally {
          restoreHostBuiltins();
        }
      },
      300_000,
    );
  }
});

describe("#5318 r5 Step 2 — the object-literal evaluated-key accessor matrix", () => {
  // The `object/accessor/getter.js` shape: three getters whose keys are a
  // string literal, a numeric literal and a SYMBOL. Only the symbol half is
  // new — the first two already folded to compile-time names.
  const GETTERS = `
    const s = Symbol();
    const A = {
      get ["a"]() { return "A"; },
      get [1]() { return 1; },
      get [s]() { return s; },
    };
    export function probeStringKey() { return A.a === "A" ? 1 : 0; }
    export function probeNumericKey() { return A[1] === 1 ? 1 : 0; }
    export function probeSymbolKey() { return A[s] === s ? 1 : 0; }
  `;

  for (const probe of ["probeStringKey", "probeNumericKey", "probeSymbolKey"]) {
    it(`standalone: ${probe} reads back the getter (node: 1)`, async () => {
      expect(await runStandalone(GETTERS, probe, "issue-5318-r5-objlit-get.js")).toBe(1);
      expect(runHost(GETTERS, probe)).toBe(1);
    });
  }

  // A SETTER half alone. Before this the write fell through to a plain data
  // property and `calls` stayed 0.
  const SETTER = `
    const s = Symbol();
    let calls = 0;
    const A = { set [s](_) { calls += 1; } };
    export function probeSetterSymbol() { A[s] = 1; return calls; }
  `;

  it("standalone: a symbol-keyed setter half runs (node: 1)", async () => {
    expect(await runStandalone(SETTER, "probeSetterSymbol", "issue-5318-r5-objlit-set.js")).toBe(1);
    expect(runHost(SETTER, "probeSetterSymbol")).toBe(1);
  });

  // A PAIR under one evaluated key. This is what bits 8/9 buy: without them
  // the trailing `set` replaces both slots and blanks the getter.
  const PAIR = `
    const s = Symbol();
    let sink = 0;
    const B = {
      get [s]() { return 20 + sink; },
      set [s](v) { sink = v; },
    };
    export function probePairSymbol() { B[s] = 3; const v = B[s]; return v === undefined ? -1 : v; }
  `;

  it("standalone: a symbol-keyed get/set pair merges (node: 23)", async () => {
    expect(await runStandalone(PAIR, "probePairSymbol", "issue-5318-r5-objlit-pair.js")).toBe(23);
    expect(runHost(PAIR, "probePairSymbol")).toBe(23);
  });

  // A key that is a runtime STRING expression rather than a symbol.
  const RUNTIME = `
    let x = 0;
    let sink = 0;
    const D = {
      get [x || "k"]() { return 30 + sink; },
      set [x || "k"](v) { sink = v; },
    };
    export function probeRuntimePair() { D[x || "k"] = 4; const v = D[x || "k"]; return v === undefined ? -1 : v; }
  `;

  it("standalone: a runtime-string-keyed pair merges (node: 34)", async () => {
    expect(await runStandalone(RUNTIME, "probeRuntimePair", "issue-5318-r5-objlit-rt.js")).toBe(34);
    expect(runHost(RUNTIME, "probeRuntimePair")).toBe(34);
  });

  // Order preservation: a literal whose accessor keys ALL fold keeps the old
  // encoding, and a duplicate folding key still resolves to the last one.
  const FOLDED = `
    let sink = 0;
    const A = {
      a: 1,
      get b() { return sink + 2; },
      set b(v) { sink = v; },
      ["c"]: 3,
      get ["d"]() { return 4; },
      m() { return 5; },
      get [1]() { return 7; },
    };
    const C = { get [1]() { return 1; }, get [1]() { return 2; } };
    export function probeFolded() { A.b = 10; return A.a + A.b + A.c + A.d + A.m() + A[1]; }
    export function probeDuplicates() { const v = C[1]; return v === undefined ? -1 : v; }
  `;

  it("standalone: a literal with only folding accessor keys is unchanged (node: 32)", async () => {
    expect(await runStandalone(FOLDED, "probeFolded", "issue-5318-r5-objlit-folded.js")).toBe(32);
    expect(runHost(FOLDED, "probeFolded")).toBe(32);
  });

  it("standalone: a duplicated folding key still answers the last one (node: 2)", async () => {
    expect(await runStandalone(FOLDED, "probeDuplicates", "issue-5318-r5-objlit-folded.js")).toBe(2);
    expect(runHost(FOLDED, "probeDuplicates")).toBe(2);
  });

  // The key expression is evaluated ONCE per half, at the half's own source
  // position — the `to-name-side-effects` ordering rule.
  const SIDE_EFFECTS = `
    let counter = 0;
    const key1 = { toString: function() { counter += 1; return "b"; } };
    const key2 = { toString: function() { counter += 10; return "d"; } };
    const O = {
      a() { return 1; },
      get [key1]() { return 2; },
      c() { return 3; },
      get [key2]() { return 4; },
    };
    export function probeOrder() { return counter; }
    export function probeReads() { return O.b + O.d; }
  `;

  it("standalone: each dynamic key is evaluated exactly once, in source order (node: 11)", async () => {
    expect(await runStandalone(SIDE_EFFECTS, "probeOrder", "issue-5318-r5-objlit-order.js")).toBe(11);
    expect(runHost(SIDE_EFFECTS, "probeOrder")).toBe(11);
  });

  it("standalone: both dynamic keys read back (node: 6)", async () => {
    expect(await runStandalone(SIDE_EFFECTS, "probeReads", "issue-5318-r5-objlit-order.js")).toBe(6);
    expect(runHost(SIDE_EFFECTS, "probeReads")).toBe(6);
  });
});
