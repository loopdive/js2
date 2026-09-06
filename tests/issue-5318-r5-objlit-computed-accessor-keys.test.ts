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

/**
 * Compile for the DEFAULT (JS-host) target and instantiate through the
 * compiler's own `importObject`, so the host bridge is exercised rather than
 * node's native semantics (which is what `runHost` above measures).
 */
async function runHostTarget(source: string, exportName: string, fileName: string): Promise<unknown> {
  const result = await compile(source, { allowJs: true, fileName, skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const importObject = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  // The documented host wiring step (`src/index.ts` §CompileResult.importObject):
  // without it the host object sidecars never see the instance, so open-object
  // operations (`{...src}`, a method call, a `__proto__` setter) silently
  // misbehave — a literal without ANY accessor already answers wrongly, which
  // makes every measurement on this lane unusable.
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return (instance.exports as Record<string, () => unknown>)[exportName]!();
}

describe("#5318 r5 review r2 — a later same-key member OVERRIDES an evaluated-key accessor", () => {
  // §13.2.5.5 defines every object-literal member with
  // CreateDataPropertyOrThrow — it DEFINES, it does not [[Set]]. Once the
  // literal has installed a real accessor under an evaluated key, routing the
  // later members through `__extern_set` ran that accessor instead of
  // replacing it: the getter-only shapes below answered the GETTER's value
  // where node answers the later data property / method.
  //
  // Measured 2026-09-06 (node 25.9.0 oracle; base = git archive origin/main
  // c9a8b48616): node 5 / 5 / 7, base 5 / 5 / 7, the r2 lane 1 / 1 / 1 on
  // standalone and an unreadable value on the JS-host target.
  const OVERRIDE = `
    const s = Symbol("a");
    export function probeDataAfterAccessorSym() {
      const o = { get [s]() { return 1; }, [s]: 5 };
      const r = o[s];
      return r === undefined ? -1 : r;
    }
    export function probeDataAfterAccessorStr() {
      const o = { get [(function () { return "z1"; })()]() { return 1; }, [(function () { return "z1"; })()]: 5 };
      const r = o["z1"];
      return r === undefined ? -1 : r;
    }
    export function probeMethodAfterAccessor() {
      const o = {
        get [(function () { return "z2"; })()]() { return 1; },
        [(function () { return "z2"; })()]() { return 7; },
      };
      const r = o["z2"];
      return typeof r === "function" ? r() : (r === undefined ? -1 : r);
    }
    export function probeAccessorAfterData() {
      const o = { [(function () { return "z3"; })()]: 5, get [(function () { return "z3"; })()]() { return 1; } };
      const r = o["z3"];
      return r === undefined ? -1 : r;
    }
    export function probeAccessorMethodAccessor() {
      const o = {
        get [(function () { return "z4"; })()]() { return 1; },
        [(function () { return "z4"; })()]() { return 9; },
        get [(function () { return "z4"; })()]() { return 2; },
      };
      const r = o["z4"];
      return typeof r === "function" ? -9 : (r === undefined ? -1 : r);
    }
  `;

  const CASES: ReadonlyArray<readonly [string, number]> = [
    ["probeDataAfterAccessorSym", 5],
    ["probeDataAfterAccessorStr", 5],
    ["probeMethodAfterAccessor", 7],
    ["probeAccessorAfterData", 1],
    ["probeAccessorMethodAccessor", 2],
  ];

  for (const [probe, expected] of CASES) {
    it(`standalone: ${probe} (node: ${expected})`, async () => {
      expect(await runStandalone(OVERRIDE, probe, "issue-5318-r5-objlit-override.js")).toBe(expected);
      expect(runHost(OVERRIDE, probe)).toBe(expected);
    });
  }

  // The install runs on the JS-host target too, so the override must hold
  // there — through the compiler's own import object, not node's semantics.
  it("host target: a later data property overrides the evaluated-key accessor (node: 5)", async () => {
    expect(await runHostTarget(OVERRIDE, "probeDataAfterAccessorStr", "issue-5318-r5-objlit-override-host.js")).toBe(5);
  });

  // The descriptor materialised for a runtime-keyed accessor carries exactly
  // the four accessor fields — no `value` slot. Measured by OWN KEYS, not by
  // `"value" in d`: with `d` statically typed as `PropertyDescriptor` the
  // compiler answers `in` from the TS type, which reports `value` present on
  // base too (an unrelated, pre-existing `in` defect — see the issue).
  const DESCRIPTOR = `
    function score(d) {
      const ks = Object.keys(d);
      let s = 0;
      for (let i = 0; i < ks.length; i++) {
        if (ks[i] === "get") s += 1;
        else if (ks[i] === "set") s += 10;
        else if (ks[i] === "enumerable") s += 100;
        else if (ks[i] === "configurable") s += 1000;
        else s += 100000;
      }
      return s;
    }
    export function probeDynAccessorDescriptor() {
      const o = { get [(function () { return "q1"; })()]() { return 8; } };
      const d = Object.getOwnPropertyDescriptor(o, "q1");
      return d === undefined ? -1 : score(d);
    }
  `;

  it("standalone: a runtime-keyed accessor's descriptor has get/set/enumerable/configurable only (node: 1111)", async () => {
    expect(await runStandalone(DESCRIPTOR, "probeDynAccessorDescriptor", "issue-5318-r5-objlit-descriptor.js")).toBe(
      1111,
    );
    expect(runHost(DESCRIPTOR, "probeDynAccessorDescriptor")).toBe(1111);
  });
});

describe("#5318 r5 review r2 — `__proto__` and spread AFTER an evaluated-key accessor", () => {
  // Two regressions the review-round-2 measurement found in the define switch
  // above, both reproduced on 2026-09-06 against
  // `.tmp/rev5318r2/base` (git archive c9a8b48616) and node 22.22.2:
  //
  //  R1 (JS-host target) A NON-computed `__proto__: v` is §B.3.1, not a
  //     property definition — it runs `[[SetPrototypeOf]]`. The host lane has
  //     no `__object_setPrototypeOf`, so it depends on `__extern_set` reaching
  //     the host object's own `__proto__` SETTER; routing it to
  //     `__defineProperty_value` created an own enumerable `'__proto__'` data
  //     property instead (0 → 10 below).
  //  R2 (all targets) A spread that follows the accessor went through
  //     `__object_assign`, which is [[Set]]: over the getter-only accessor the
  //     literal had just installed under the SAME key it threw
  //     ("Cannot set property sb of #<Object> which has only a getter" on the
  //     host; a raw `WebAssembly.Exception` on standalone/wasi) where node
  //     answers 5.
  //
  // NOTE ON THE HOST HARNESS: these numbers are only readable once
  // `result.importObject.__setInstance(instance)` runs (see `runHostTarget`).
  // Without it even a literal with NO accessor answers wrongly on this lane.
  const PROTO_AND_SPREAD = `
    function rk(v) { return v; }
    export function probeProtoIdentAfterAcc() {
      const p = { pm: 7 };
      const o = { get [rk('zz')]() { return 1; }, __proto__: p };
      return (Object.getPrototypeOf(o) === p ? 1 : 0) + (Object.prototype.hasOwnProperty.call(o, '__proto__') ? 10 : 0);
    }
    export function probeProtoStrAfterAcc() {
      const p = { pm: 7 };
      const o = { get [rk('zz')]() { return 1; }, "__proto__": p };
      return (Object.getPrototypeOf(o) === p ? 1 : 0) + (Object.prototype.hasOwnProperty.call(o, '__proto__') ? 10 : 0);
    }
    export function probeProtoNullAfterAcc() {
      const o = { get [rk('yy')]() { return 1; }, __proto__: null };
      return Object.prototype.hasOwnProperty.call(o, '__proto__') ? 10 : 0;
    }
    export function probeProtoComputedAfterAcc() {
      const p = { pm: 7 };
      const o = { get [rk('zy')]() { return 1; }, [rk('__proto__')]: p };
      return (Object.getPrototypeOf(o) === p ? 1 : 0) + (Object.prototype.hasOwnProperty.call(o, '__proto__') ? 10 : 0);
    }
    export function probeProtoShorthandAfterAcc() {
      const __proto__ = 7;
      const o = { get [rk('zw')]() { return 1; }, __proto__ };
      return Object.prototype.hasOwnProperty.call(o, '__proto__') ? 10 : 0;
    }
    export function probeSpreadSameKeyAfterAcc() {
      const src = { sb: 5 };
      const o = { get [rk('sb')]() { return 3; }, ...src };
      return o.sb === undefined ? -1 : o.sb;
    }
    export function probeSpreadSourceGetterOnce() {
      let calls = 0;
      const src = { get sb() { calls = calls + 1; return 5; } };
      const o = { get [rk('sb')]() { return 3; }, ...src };
      return (o.sb === 5 ? 1 : 0) + calls * 10;
    }
    export function probeSpreadBeforeAcc() {
      const src = { p: 1, q: 2 };
      const o = { ...src, get [rk('sa')]() { return 3; } };
      return (o.p === 1 ? 1 : 0) + (o.q === 2 ? 10 : 0) + (o.sa === 3 ? 100 : 0);
    }
  `;

  // node 22.22.2 answers, in probe order:
  //   1 / 1 / 0 / 10 / 10 / 5 / 11 / 111
  //
  // The host target answers 0 for the three §B.3.1 forms rather than node's
  // 1 / 1 / 0: this lane's `__proto__` write reaches a sidecar rather than a
  // real JS object, so the prototype does not become `p` by IDENTITY. That is
  // BASE behaviour (measured 0 / 0 / 0 there too) and out of scope here — what
  // this pins is that no own `'__proto__'` property appears, which is exactly
  // what the define route created.
  const HOST_EXPECTED: ReadonlyArray<readonly [string, number]> = [
    ["probeProtoIdentAfterAcc", 0],
    ["probeProtoStrAfterAcc", 0],
    ["probeProtoNullAfterAcc", 0],
    ["probeProtoComputedAfterAcc", 10],
    ["probeProtoShorthandAfterAcc", 10],
    ["probeSpreadSameKeyAfterAcc", 5],
    ["probeSpreadSourceGetterOnce", 11],
    ["probeSpreadBeforeAcc", 111],
  ];

  for (const [probe, expected] of HOST_EXPECTED) {
    it(`host target: ${probe} === ${expected}`, async () => {
      expect(await runHostTarget(PROTO_AND_SPREAD, probe, "issue-5318-r5-objlit-proto-spread-host.js")).toBe(expected);
    });
  }

  // Standalone: since #5350 r1 (the `__proto__:` literal is a dynamic-proto
  // receiver) the identifier / string forms DO link the prototype (the 1 bit,
  // node's answer), but `Object.prototype.hasOwnProperty.call(o, '__proto__')`
  // still answers true on such an object (the 10 bit; node false) — measured
  // identical on a plain `{ a: 1, __proto__: p }` with no accessor at all, so
  // it is a pre-existing `__hasOwnProperty` gap on the `$Object` proto entry,
  // not this file's routing. Pinned at 11 (was 10 before the link was real)
  // so the next change to either bit is deliberate. The three spread rows DO
  // match node.
  const STANDALONE_EXPECTED: ReadonlyArray<readonly [string, number]> = [
    ["probeProtoIdentAfterAcc", 11],
    ["probeProtoStrAfterAcc", 11],
    ["probeProtoNullAfterAcc", 10],
    ["probeProtoComputedAfterAcc", 10],
    ["probeProtoShorthandAfterAcc", 10],
    ["probeSpreadSameKeyAfterAcc", 5],
    ["probeSpreadSourceGetterOnce", 11],
    ["probeSpreadBeforeAcc", 111],
  ];

  for (const [probe, expected] of STANDALONE_EXPECTED) {
    it(`standalone: ${probe} === ${expected}`, async () => {
      expect(await runStandalone(PROTO_AND_SPREAD, probe, "issue-5318-r5-objlit-proto-spread.js")).toBe(expected);
    });
  }
});
