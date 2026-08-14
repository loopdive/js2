// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2856 (follow-on to #1979) — non-terminating `if (cond) <stmt>;` guard at a
// NON-void, non-tail body position.
//
// #1979 fixed the `from-ast.ts` lowering so a non-terminating then-arm no
// longer skips the rest of the body (`lowerStatementList`'s converging-guard
// path). But the SELECTOR only let such guards through for VOID functions (via
// the `isVoidReturn && ExpressionStatement` void-tail arm in `isPhase1Tail`).
// A NON-void function whose non-tail `if (cond) x = e;` guard is followed by
// more statements + a value return (the canonical `fdow` day-of-week shape)
// stayed `body-shape-rejected: tail-unhandled`, even though from-ast could
// already lower it. This slice extends the selector's non-tail if-no-else arm
// to mirror from-ast's `thenArmTerminates` fork: terminating then-arm → tail
// rewrite; non-terminating then-arm → `isPhase1BodyStatement` guard.
//
// Every case asserts legacy/IR observable equality, ZERO post-claim demotions,
// and an explicit emitted IR terminal outcome. Binary inequality is not a
// valid ownership witness: sufficiently simple optimized IR and direct bodies
// may intentionally converge to the same bytes.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// (#4157) "emits the trailing tail ONCE" is counted as call sites in the WAT.
// The IR inliner rewrites those sites, so the count reads 0 and the
// emitted-once property becomes unobservable rather than false. Pin it off.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

const JS_STRING = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  fromCharCode: (c: number) => String.fromCharCode(c),
  cast: (s: unknown) => String(s),
  test: (v: unknown) => (typeof v === "string" ? 1 : 0),
};

interface RunResult {
  value: unknown;
  binary: Uint8Array;
  outcome: unknown;
  postClaim: unknown[];
  wat: string;
}

async function compileRun(
  source: string,
  fn: string,
  args: unknown[],
  experimentalIR: boolean,
  deps: Record<string, unknown> = {},
): Promise<RunResult> {
  const r = await compile(source, { experimentalIR, trackFallbacks: true, trackIrOutcomes: true });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, { ...ENV_STUB, ...deps }, r.stringPool);
  const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
  imports["wasm:js-string"] = JS_STRING as unknown as WebAssembly.ModuleImports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  built.setExports?.(instance.exports as Record<string, Function>);
  const f = (instance.exports as Record<string, unknown>)[fn];
  if (typeof f !== "function") throw new Error(`export ${fn} missing`);
  return {
    value: (f as (...a: unknown[]) => unknown)(...args),
    binary: r.binary,
    outcome: r.irOutcomes?.find((candidate) => candidate.unitKind === "function" && candidate.displayName === fn),
    postClaim: r.irPostClaimErrors ?? [],
    wat: r.wat,
  };
}

function functionBody(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name} `);
  if (start < 0) return "";
  let depth = 0;
  for (let index = start; index < wat.length; index++) {
    if (wat[index] === "(") depth++;
    else if (wat[index] === ")" && --depth === 0) return wat.slice(start, index + 1);
  }
  return "";
}

function watCallTargets(wat: string, body: string): string[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => {
    const target = names[Number(match[1])] ?? "<missing>";
    return target.endsWith("_import") ? target.slice(0, -"_import".length) : target;
  });
}

async function expectParity(
  source: string,
  fn: string,
  args: unknown[],
  expected: unknown,
  opts: { expectClaimed?: boolean } = {},
): Promise<void> {
  const legacy = await compileRun(source, fn, args, false);
  const ir = await compileRun(source, fn, args, true);
  expect(legacy.value, "legacy value").toStrictEqual(expected);
  expect(ir.value, "IR value matches legacy").toStrictEqual(legacy.value);
  expect(ir.postClaim, "no post-claim demotions").toStrictEqual([]);
  if (opts.expectClaimed !== false) {
    expect(ir.outcome, "IR path exercised through an emitted terminal").toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
    });
  }
}

describe("#2856 — non-terminating if-guard at non-void body position", () => {
  it("simple `if (cond) x = e;` guard then value return", async () => {
    // The minimal fdow shape: a mutation guard followed by more statements.
    await expectParity(
      `export function f(m: number, y: number): number {
         let yr = y;
         if (m < 2) yr = yr - 1;
         return yr * 10 + m;
       }`,
      "f",
      [1, 2000],
      // m=1 < 2 → yr = 1999; 1999*10 + 1 = 19991
      19991,
    );
  });

  it("guard NOT taken — rest still runs with the unmutated value", async () => {
    await expectParity(
      `export function f(m: number, y: number): number {
         let yr = y;
         if (m < 2) yr = yr - 1;
         return yr * 10 + m;
       }`,
      "f",
      [5, 2000],
      // m=5 ≥ 2 → yr stays 2000; 2000*10 + 5 = 20005
      20005,
    );
  });

  it("Zeller-style day-of-week (the `fdow` corpus function)", async () => {
    const src = `export function fdow(y: number, m: number): number {
      const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
      let yr = y;
      if (m < 2) yr = yr - 1;
      const d = (yr + ((yr / 4) | 0) - ((yr / 100) | 0) + ((yr / 400) | 0) + t[m] + 1) % 7;
      return (d + 6) % 7;
    }`;
    // Verify across a range of (y, m) pairs to exercise both guard arms.
    const oracle = (y: number, m: number): number => {
      let yr = y;
      if (m < 2) yr = yr - 1;
      const d =
        (yr + ((yr / 4) | 0) - ((yr / 100) | 0) + ((yr / 400) | 0) + [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4][m]! + 1) % 7;
      return (d + 6) % 7;
    };
    for (const [y, m] of [
      [2026, 0],
      [2026, 1],
      [2026, 6],
      [2000, 11],
      [1999, 2],
    ] as const) {
      await expectParity(src, "fdow", [y, m], oracle(y, m));
    }
  });

  it("block then-arm with multiple mutations", async () => {
    await expectParity(
      `export function f(a: number): number {
         let x = 1;
         let y = 2;
         if (a > 0) { x = x + a; y = y + a; }
         return x * 100 + y;
       }`,
      "f",
      [5],
      // x=6, y=7 → 607
      607,
    );
  });

  it("multiple consecutive guards before the tail", async () => {
    await expectParity(
      `export function f(a: number, b: number): number {
         let acc = 0;
         if (a > 0) acc = acc + 10;
         if (b > 0) acc = acc + 1;
         return acc;
       }`,
      "f",
      [1, 0],
      10,
    );
  });

  it("evaluates a side-effecting guard once and emits the trailing tail once", async () => {
    const source = `
      let hits = 0;
      function probe(flag: number): boolean {
        hits = hits + 1;
        if (flag > 0) return true;
        return false;
      }
      export function f(flag: number): number {
        let value = 0;
        if (probe(flag)) value = 10;
        return value + hits;
      }
    `;
    const [legacyTaken, irTaken, legacyMiss, irMiss] = await Promise.all([
      compileRun(source, "f", [1], false),
      compileRun(source, "f", [1], true),
      compileRun(source, "f", [0], false),
      compileRun(source, "f", [0], true),
    ]);
    expect([legacyTaken.value, irTaken.value]).toEqual([11, 11]);
    expect([legacyMiss.value, irMiss.value]).toEqual([1, 1]);
    expect(irTaken.postClaim).toEqual([]);
    expect(irMiss.postClaim).toEqual([]);
    for (const result of [irTaken, irMiss]) {
      expect(result.outcome).toMatchObject({
        kind: "emitted",
        irBodyEmitted: true,
      });
    }
    expect(watCallTargets(irTaken.wat, functionBody(irTaken.wat, "f")).filter((name) => name === "probe")).toHaveLength(
      1,
    );
    expect(watCallTargets(irMiss.wat, functionBody(irMiss.wat, "f")).filter((name) => name === "probe")).toHaveLength(
      1,
    );
  });

  it("nested non-terminating guard `if (c1) if (c2) x = e;`", async () => {
    await expectParity(
      `export function f(a: number, b: number): number {
         let x = 0;
         if (a > 0) if (b > 0) x = a + b;
         return x;
       }`,
      "f",
      [3, 4],
      7,
    );
  });

  it("guard followed by a loop that reads the mutated local", async () => {
    await expectParity(
      `export function f(n: number): number {
         let base = 0;
         if (n > 5) base = 100;
         let s = base;
         for (let i = 0; i < n; i++) s = s + i;
         return s;
       }`,
      "f",
      [10],
      // base=100; sum 0..9 = 45 → 145
      145,
    );
  });

  it("REGRESSION: terminating then-arm (early return) still rewrites", async () => {
    await expectParity(
      `export function f(n: number): number {
         if (n < 0) return -1;
         return n * 2;
       }`,
      "f",
      [21],
      42,
    );
  });
});
