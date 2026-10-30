// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 (follow-up (a) of "Script `var` reference homes") — IR-claimed
// function-local arrays mishandled out-of-range, hole, non-integer, negative and
// huge element keys. Measured on main `fcd27b7492`, standalone and gc alike:
// `a[5]` and `a[a.length]` handed a dynamic consumer NaN instead of undefined,
// `a[0.5]` read `a[0]`, a grow gap read 0 or NaN, and `a[-1] = 5` /
// `a[4294967295] = 5` trapped ("array element access out of bounds").
//
// Now every row either lowers with JS semantics or stays legacy from the
// selector (on an array, a constant key that is not an array index up to the
// sparse ceiling takes legacy's named-key or sparse route), and no runtime key
// reaches the grow-store helper as a truncation.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
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
    "grow-gap (hole) read": {
      body: `var a = [1]; a[3] = 9; assert.sameValue(a[2], undefined);`,
      disposition: "claimed",
    },
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
    return compile(source, { fileName: "test.ts", trackIrOutcomes: true, ...targetOptions(target) });
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
      // Non-integer, negative, NaN and 2^32-1 keys name properties, not
      // elements: element 0 and the length are untouched. (Was: 702 for 0.5,
      // a trap for -1 and 4294967295.)
      for (const key of [0.5, -1, Number.NaN, 4294967295]) expect(store(key)).toBe(102);
      expect(store(1)).toBe(102);
      expect(store(5)).toBe(106);
      // A valid index the dense vec cannot back is dropped rather than
      // trapping; JavaScript would make `length` 2147483649 here.
      expect(store(2147483648)).toBe(102);
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
        export function f(): number { const a = make(); const gap = read(a, 50); return read(a, 20000000) * 10 + (gap === gap ? 0 : 1); }`,
        target,
      );
      for (const name of ["make", "read", "f"]) expect(outcomeOf(result, name)?.irBodyEmitted, name).toBe(true);
      expect(((await instantiate(result)).exports.f as () => number)()).toBe(31);
    }, 60_000);

    it(`leaves a constant store beyond MAX_DENSE_VEC_LENGTH to legacy's sparse tail (${target})`, async () => {
      // The vec lane's grow-store would trap ("requested new array is too large").
      const result = await compileTs(
        `export function f(): number { const a: number[] = [1]; a[200000000] = 3; return a.length; }`,
        target,
      );
      expect(outcomeOf(result, "f")).toMatchObject({ kind: "unsupported", stage: "select" });
      expect(postClaimErrorsOf(result, "f")).toEqual([]);
      expect(((await instantiate(result)).exports.f as () => number)()).toBe(200000001);
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

    it(`reads a grow gap as undefined, i.e. NaN in a numeric consumer (${target})`, async () => {
      // Was 1: the grow-store helper zero-filled the gap.
      const result = await compileTs(
        `export function gap(): number { const a: number[] = [1]; a[3] = 3; return a[1] + 1; }`,
        target,
      );
      expect(outcomeOf(result, "gap")?.irBodyEmitted).toBe(true);
      expect(((await instantiate(result)).exports.gap as () => number)()).toBeNaN();
    }, 60_000);

    it(`hands an any-typed parameter undefined for out-of-range and gap reads (${target})`, async () => {
      const result = await compileTs(
        `function isUndefined(v: any): number { return v === undefined ? 1 : 0; }
        export function probe(): number {
          const a: number[] = [1, 2];
          a[4] = 5;
          return isUndefined(a[9]) * 100 + isUndefined(a[3]) * 10 + isUndefined(a[0]);
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
  }
});
