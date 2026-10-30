// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 (follow-up (a) of "Script `var` reference homes") — IR-claimed
// function-local arrays mishandled out-of-range, non-integer, negative and huge
// element keys. Measured on main `fcd27b7492`, standalone and gc alike: `a[5]`
// and `a[a.length]` handed a dynamic consumer NaN instead of undefined, `a[0.5]`
// read `a[0]`, and `a[-1] = 5` / `a[4294967295] = 5` trapped ("array element
// access out of bounds").
//
// Now every row either lowers with JS semantics or stays legacy from the
// selector (on an array, a key that names a property takes legacy's named-key
// route), and no store reaches the grow-store helper with a truncated or
// negative index; a static index past the i32 range still traps, as on main.
// An f64 grow gap that reads 0 is the separate gap-fill change.
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { TsCheckerOracle } from "../src/checker/oracle.js";
import { compile } from "../src/index.js";
import { constBindingNumber } from "../src/shared/array-index-key.js";
import { ts } from "../src/ts-api.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

type Target = "gc" | "standalone";
type Result = Awaited<ReturnType<typeof compile>>;

const TARGETS: readonly Target[] = ["standalone", "gc"];

function targetOptions(target: Target) {
  return target === "standalone" ? { target: "standalone" as const } : {};
}

function outcomeOf(result: Result, name: string) {
  return (result.irOutcomes ?? []).find((outcome) => outcome.displayName === name);
}

function postClaimErrorsOf(result: Result, name: string) {
  return (result.irPostClaimErrors ?? []).filter((error) => error.func === name);
}

async function instantiate(result: Result): Promise<WebAssembly.Instance> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  (result.importObject as { __setInstance?: (i: WebAssembly.Instance) => void } | undefined)?.__setInstance?.(instance);
  return instance;
}

/** Run `body` as `function f() { … }` under the real test262 harness. */
async function compileHarnessBody(body: string, target: Target): Promise<Result> {
  const source = `/*---\ndescription: vector index semantics\n---*/\nfunction f() { ${body} }\nf();\n`;
  return compile(assembleOriginalHarness(source, parseMeta(source) as never).primary.source, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    deferTopLevelInit: true,
    ...targetOptions(target),
  });
}

/** The same body in node, against a minimal `assert.sameValue`. */
function runInNode(body: string): void {
  const assert = {
    sameValue(actual: unknown, expected: unknown) {
      if (!Object.is(actual, expected)) throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
    },
  };
  new Function("assert", body)(assert);
}

describe("#7106 — IR vector element keys under the test262 harness", () => {
  // `claimed`: `f` lowers on the IR. `select`: the selector refuses it, so the
  // whole function keeps its legacy body (never a post-claim demote).
  const rows: Record<string, { body: string; disposition: "claimed" | "select" }> = {
    "out-of-range read": { body: `var a = [1]; assert.sameValue(a[5], undefined);`, disposition: "claimed" },
    "fractional read": { body: `var a = [1]; assert.sameValue(a[0.5], undefined);`, disposition: "select" },
    "2^32-1 store": {
      body: `var a = [0, 1, 2]; a[4294967295] = 5; assert.sameValue(a.length, 3);`,
      disposition: "select",
    },
    "negative store": { body: `var a = [0, 1, 2]; a[-1] = 5; assert.sameValue(a.length, 3);`, disposition: "select" },
    "a[a.length] read": { body: `var a = [1]; assert.sameValue(a[a.length], undefined);`, disposition: "claimed" },
    "negative read": { body: `var a = [1]; assert.sameValue(a[-1], undefined);`, disposition: "select" },
    "large index store and read-back": {
      body: `var a = [1]; a[20000000] = 3; assert.sameValue(a[20000000], 3); assert.sameValue(a.length, 20000001);`,
      disposition: "claimed",
    },
    "boolean variable key": {
      body: `var b = true; var a = [1]; a[b] = 7; assert.sameValue(a[b], 7); assert.sameValue(a[1], undefined);`,
      disposition: "select",
    },
  };

  for (const [name, { body, disposition }] of Object.entries(rows)) {
    it(`node agrees with the row: ${name}`, () => {
      expect(() => runInNode(body)).not.toThrow();
    });

    for (const target of TARGETS) {
      it(`${name} (${target}): ${disposition === "claimed" ? "lowers on the IR" : "refused at select"}, passes`, async () => {
        const result = await compileHarnessBody(body, target);
        const outcome = outcomeOf(result, "f");
        if (disposition === "claimed") {
          expect(outcome?.irBodyEmitted).toBe(true);
        } else {
          expect(outcome).toMatchObject({ kind: "unsupported", stage: "select" });
        }
        expect(postClaimErrorsOf(result, "f")).toEqual([]);
        const instance = await instantiate(result);
        expect(() => (instance.exports.__module_init as () => void)()).not.toThrow();
      }, 60_000);
    }
  }
});

describe("#7106 — IR vector element keys in function bodies", () => {
  async function compileTs(source: string, target: Target): Promise<Result> {
    return compile(source, { fileName: "test.ts", trackIrOutcomes: true, emitWat: true, ...targetOptions(target) });
  }

  function functionWat(wat: string, name: string): string {
    const start = wat.indexOf(`(func $${name}`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const next = wat.indexOf("\n  (func $", start + 1);
    return wat.slice(start, next < 0 ? undefined : next);
  }

  for (const target of TARGETS) {
    it(`keeps a non-index constant key on a non-array receiver on the IR (${target})`, async () => {
      // The select-time refusal is for the vec lane only: the dynamic arm reads
      // the named property `"1.5"` itself.
      const result = await compile(
        `export function g(o) { return o[1.5]; }
        export function h() { return (g({ "1.5": 7 }) === 7 ? 10 : 0) + (g({}) === undefined ? 1 : 0); }`,
        {
          fileName: "test.js",
          allowJs: true,
          skipSemanticDiagnostics: true,
          trackIrOutcomes: true,
          ...targetOptions(target),
        },
      );
      expect(outcomeOf(result, "g")?.irBodyEmitted).toBe(true);
      expect(((await instantiate(result)).exports.h as () => number)()).toBe(11);
    }, 60_000);
  }

  for (const target of TARGETS) {
    it(`keeps a counted numeric loop over a[i] on the IR (${target})`, async () => {
      const result = await compileTs(
        `export function sum(a: number[]): number {
          let s = 0;
          for (let i = 0; i < a.length; i++) s += a[i];
          return s;
        }
        export function run(): number { return sum([1, 2, 3, 4]); }`,
        target,
      );
      expect(outcomeOf(result, "sum")?.irBodyEmitted).toBe(true);
      const instance = await instantiate(result);
      expect((instance.exports.run as () => number)()).toBe(10);
    }, 60_000);

    it(`never traps on a runtime store key that is not an array index (${target})`, async () => {
      const source = `export function store(i: number): number {
        const a: number[] = [1, 2];
        a[i] = 7;
        return a[0] * 100 + a.length;
      }`;
      const result = await compileTs(source, target);
      expect(outcomeOf(result, "store")?.irBodyEmitted).toBe(true);
      const store = (await instantiate(result)).exports.store as (i: number) => number;
      // Non-integer, negative, NaN, infinite and 2^32-1 keys name properties,
      // not elements: element 0 and the length are untouched. (Was: 702 for
      // 0.5, a trap for -1 and 4294967295.)
      for (const key of [0.5, -1, -2147483649, Number.NaN, Infinity, -Infinity, 4294967295, 2 ** 53]) {
        expect(store(key), String(key)).toBe(102);
      }
      expect(store(1)).toBe(102);
      expect(store(5)).toBe(106);
      // A valid index no vec can back traps in the grow-store, as on main;
      // dropping it would leave `length` silently wrong (JavaScript: 2147483649).
      for (const key of [2147483648, 4294967294]) expect(() => store(key)).toThrow(WebAssembly.RuntimeError);
    }, 60_000);

    it(`keeps a large constant index on the vec lane: store, read-back, compound, cast key, read (${target})`, async () => {
      const result = await compileTs(
        `export function store(): number { const a: number[] = [1]; a[20000000] = 3; return a.length * 10 + a[20000000]; }
        export function compound(): number { const a: number[] = [1]; a[20000000] += 3; a[20000001]++; return a.length; }
        export function cast(): number { const a: number[] = [1]; a[16777217 as any] = 7; return a.length; }
        function readFar(a: number[]): number { return a[200000000]; }
        export function callsReadFar(): number { const v = readFar([1]); return v === v ? 0 : 1; }`,
        target,
      );
      for (const name of ["store", "compound", "cast", "readFar", "callsReadFar"]) {
        expect(outcomeOf(result, name)?.irBodyEmitted, name).toBe(true);
      }
      const exports = (await instantiate(result)).exports as Record<string, () => number>;
      expect(exports.store!()).toBe(200000013);
      expect(exports.compound!()).toBe(20000002);
      expect(exports.cast!()).toBe(16777218);
      expect(exports.callsReadFar!()).toBe(1);
    }, 60_000);

    it(`reads an array another function filled at a large constant index (${target})`, async () => {
      const result = await compileTs(
        `function make(): number[] { const a: number[] = [1]; a[20000000] = 3; return a; }
        function read(a: number[], i: number): number { return a[i]; }
        export function f(): number { const a = make(); return read(a, 20000000) * 10 + read(a, 0); }`,
        target,
      );
      for (const name of ["make", "read", "f"]) expect(outcomeOf(result, name)?.irBodyEmitted, name).toBe(true);
      expect(((await instantiate(result)).exports.f as () => number)()).toBe(31);
    }, 60_000);

    it(`traps on a store at an index past the i32 range, whatever its spelling, as on main (${target})`, async () => {
      // The saturated index grows the backing array to 2^31 slots and traps
      // ("array element access out of bounds"), exactly as main's IR does. No
      // spelling falls back to a silent wrong answer: legacy's high-index route
      // drops the read-back and the compound, and drops `length` for every
      // spelling but a bare literal. Static keys (a literal, a `const` bound to
      // one) saturate without a runtime test; the rest saturate in its cold arm.
      const writes = {
        bound: `a[2147483647] = 5;`,
        bare: `a[2147483648] = 5;`,
        constBinding: `const K = 2147483648; a[K] = 5;`,
        constChain: `const K = 2147483648; const J = K; a[J] = 5;`,
        negatedTwice: `a[-(-2147483648)] = 5;`,
        unaryPlus: `a[+2147483648] = 5;`,
        satisfies: `a[2147483648 satisfies number] = 5;`,
        compound: `a[2147483648] += 1;`,
        high: `a[4294967294] = 5;`,
        power: `a[2 ** 31] = 5;`,
        sum: `const K = 2147483647; a[K + 1] = 5;`,
        readonlyField: `const o = new Big(); a[o.k] = 5;`,
        narrowed: `const k: number = big(); if (k === 2147483648) a[k] = 5;`,
      };
      const result = await compileTs(
        `class Big { readonly k: 2147483648 = 2147483648; }
        function big(): number { return 2147483648; }
        ${Object.entries(writes)
          .map(
            ([name, write]) =>
              `export function ${name}(): number { const a: number[] = [1]; ${write} return a.length; }`,
          )
          .join("\n")}`,
        target,
      );
      const exports = (await instantiate(result)).exports as Record<string, () => number>;
      for (const name of Object.keys(writes)) {
        expect(outcomeOf(result, name)?.irBodyEmitted, name).toBe(true);
        expect(postClaimErrorsOf(result, name), name).toEqual([]);
        expect(() => exports[name]!(), name).toThrow(WebAssembly.RuntimeError);
      }
    }, 60_000);

    it(`grows a narrowed i32 vec past the f64 vec's allocation limit (${target})`, async () => {
      // 4-byte elements: V8 grows this past index 134217723, where an f64 vec stops.
      const result = await compileTs(
        `export function f(): number { const a: number[] = []; a[0] = 1; a[200000000] = 7; return (a[200000000] | 0) * 1e9 + a.length; }`,
        target,
      );
      expect(outcomeOf(result, "f")?.irBodyEmitted).toBe(true);
      expect(((await instantiate(result)).exports.f as () => number)()).toBe(7200000001);
    }, 60_000);

    it(`skips a store at a negative int32 key instead of trapping, and guards no static index (${target})`, async () => {
      const result = await compileTs(
        `export function constant(): number { const a: number[] = [10, 20, 30]; a[4] = 1; return a.length; }
        const FOUR = 4;
        export function constBound(): number { const K = FOUR; const a: number[] = [10, 20, 30]; a[K] = 1; return a.length; }
        export function store(k: number): number { const a: number[] = [10, 20, 30]; a[k | 0] = 1; return a.length * 100 + a[0]; }
        export function compound(k: number): number { const a: number[] = [10, 20, 30]; a[k | 0] += 1; return a.length * 100 + a[0]; }
        export function increment(k: number): number { const a: number[] = [10, 20, 30]; a[k | 0]++; return a.length * 100 + a[0]; }
        export function loop(): number {
          const a: number[] = [10, 20, 30];
          for (let i = 0; i < 3; i++) a[i - 1] = i;
          return a.length * 100 + a[0] + a[1] * 10;
        }`,
        target,
      );
      for (const name of ["constant", "constBound", "store", "compound", "increment", "loop"]) {
        expect(outcomeOf(result, name)?.irBodyEmitted, name).toBe(true);
      }
      // The store guard is `i32.ge_s index 0`; a static index (a literal, or a
      // `const` chain to one, read through the oracle) needs none.
      for (const name of ["constant", "constBound"])
        expect(functionWat(result.wat!, name), name).not.toContain("i32.ge_s");
      expect(functionWat(result.wat!, "store")).toContain("i32.ge_s");
      const exports = (await instantiate(result)).exports as Record<string, (k?: number) => number>;
      expect(exports.constant!()).toBe(5);
      expect(exports.constBound!()).toBe(5);
      // Main's IR trapped ("array element access out of bounds") on every row.
      for (const name of ["store", "compound", "increment"]) expect(exports[name]!(-1), name).toBe(310);
      expect(exports.loop!()).toBe(321);
    }, 60_000);

    it(`tests a key at runtime when a call made its narrowed literal type wrong (${target})`, async () => {
      // `o.k === 1` narrows `o.k`, and a `const` copying it, to the type 1, but
      // `o.set()` changes the value. Only a literal, or a `const` bound to one,
      // is a static key; trusting the type skipped the runtime test and the
      // store guard (226655b496: a trap, a trap, 307 and 11).
      const narrowed = (cls: string, body: string) =>
        `{ const o = new ${cls}(); const a: number[] = [10, 20, 30]; if (o.k === 1) { o.set(); ${body} } return 0; }`;
      const store = `a[o.k] = 7; return a.length * 100 + a[0];`;
      const result = await compileTs(
        `class Negative { k: 1 | -1 = 1; set(): void { this.k = -1; } }
        class Half { k: 1 | 0.5 = 1; set(): void { this.k = 0.5; } }
        export function negative(): number ${narrowed("Negative", store)}
        export function copied(): number ${narrowed("Negative", `const k = o.k; a[k] = 7; return a.length * 100 + a[0];`)}
        export function half(): number ${narrowed("Half", store)}
        export function halfRead(): number ${narrowed("Half", `return a[o.k] + 1;`)}`,
        target,
      );
      for (const name of ["negative", "copied", "half", "halfRead"]) {
        expect(outcomeOf(result, name)?.irBodyEmitted, name).toBe(true);
      }
      const exports = (await instantiate(result)).exports as Record<string, () => number>;
      for (const name of ["negative", "copied", "half"]) expect(exports[name]!(), name).toBe(310);
      expect(exports.halfRead!()).toBeNaN();
    }, 60_000);

    it(`grows to a runtime index above the sparse ceiling (${target})`, async () => {
      const result = await compileTs(
        `export function f(n: number): number { const a: number[] = [1]; a[n] = 3; return a.length; }`,
        target,
      );
      expect(outcomeOf(result, "f")?.irBodyEmitted).toBe(true);
      expect(((await instantiate(result)).exports.f as (n: number) => number)(16777217)).toBe(16777218);
    }, 60_000);

    it(`leaves a boolean key and a non-index literal type to legacy's named-key route (${target})`, async () => {
      const result = await compileTs(
        `export function t(b: boolean): number { const a: number[] = [10, 20]; a[b] = 5; return a[0] * 100 + a[1]; }
        export function roundTrip(b: boolean): number { const a: number[] = [10, 20]; a[b] = 5; return a[b] + a[0]; }
        export function literalType(): number { const k = 0.5; const a: number[] = [10, 20]; a[k] = 7; return a[k] + a[0] * 100; }`,
        target,
      );
      for (const name of ["t", "roundTrip", "literalType"]) {
        expect(outcomeOf(result, name), name).toMatchObject({ kind: "unsupported", stage: "select" });
        expect(postClaimErrorsOf(result, name)).toEqual([]);
      }
      const exports = (await instantiate(result)).exports as Record<string, (b?: boolean) => number>;
      // Main's IR wrote element 1 / 0 (1005 / 520).
      for (const key of [true, false]) {
        expect(exports.t!(key)).toBe(1020);
        expect(exports.roundTrip!(key)).toBe(15);
      }
      expect(exports.literalType!()).toBe(1007);
    }, 60_000);

    it(`reads a runtime non-index key as absent, not truncated (${target})`, async () => {
      const result = await compileTs(
        `export function read(i: number): number { const a: number[] = [1, 2]; return a[i] + 1; }`,
        target,
      );
      expect(outcomeOf(result, "read")?.irBodyEmitted).toBe(true);
      const read = (await instantiate(result)).exports.read as (i: number) => number;
      for (const key of [0.5, -1, Number.NaN, 4294967295, 5]) expect(read(key)).toBeNaN();
      expect(read(1)).toBe(3);
    }, 60_000);

    it(`hands an any-typed parameter undefined for out-of-range reads (${target})`, async () => {
      const result = await compileTs(
        `function isUndefined(v: any): number { return v === undefined ? 1 : 0; }
        export function probe(): number {
          const a: number[] = [1, 2];
          return isUndefined(a[9]) * 100 + isUndefined(a[2]) * 10 + isUndefined(a[0]);
        }
        export function counted(): number {
          const a: number[] = [1, 2, 3];
          let n = 0;
          for (let i = 0; i < a.length; i++) n += isUndefined(a[i]);
          return n;
        }`,
        target,
      );
      for (const name of ["isUndefined", "probe", "counted"]) expect(outcomeOf(result, name)?.irBodyEmitted).toBe(true);
      const exports = (await instantiate(result)).exports;
      expect((exports.probe as () => number)()).toBe(110);
      expect((exports.counted as () => number)()).toBe(0);
    }, 60_000);

    it(`reads a module binding that shadows NaN or Infinity as that binding (${target})`, async () => {
      // The selector's local scope cannot see a module-level `const NaN = 1`;
      // the checker's binding decides, so the key is not refused as the global
      // `NaN` (legacy then gave 330 and NaN; main's IR, node and here 317, 20).
      const body = `const a: number[] = [10, 20, 30];`;
      const modules = {
        constNaN: [`const NaN = 1;`, `${body} a[NaN] = 7; return a.length * 100 + a[0] + a[1];`, 317],
        letInfinity: [`let Infinity = 1;`, `${body} a[Infinity] = 7; return a.length * 100 + a[0] + a[1];`, 317],
        readInfinity: [`const Infinity = 1;`, `${body} return a[Infinity];`, 20],
      } as const;
      for (const [name, [binding, fn, expected]] of Object.entries(modules)) {
        const result = await compileTs(`${binding}\nexport function f(): number { ${fn} }`, target);
        expect(outcomeOf(result, "f")?.irBodyEmitted, name).toBe(true);
        expect(((await instantiate(result)).exports.f as () => number)(), name).toBe(expected);
      }
    }, 60_000);
  }
});

describe("#7106 — the const binding behind a static element key", () => {
  it("follows a const chain to its number, through casts, and nothing ambient or mutable", () => {
    const { sourceFile, checker } = analyzeSource(
      `export {};
      const J = 2147483648;
      const K = J as number;
      const NaN = 2;
      const N = NaN;
      declare const D = 1;
      const C = D;
      let L = 1;
      const Half = 0.5;
      K; N; D; C; L; Half;`,
      "issue-7106-const-key.ts",
    );
    const oracle = new TsCheckerOracle(checker);
    const keys = sourceFile.statements
      .filter(ts.isExpressionStatement)
      .map((statement) => statement.expression)
      .filter(ts.isIdentifier);
    expect(Object.fromEntries(keys.map((key) => [key.text, constBindingNumber(key, oracle)]))).toEqual({
      K: 2147483648,
      N: 2,
      D: undefined,
      C: undefined,
      L: undefined,
      Half: 0.5,
    });
  });
});
