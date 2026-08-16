// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4512 — ref-typed §7.1.2 ToBoolean in CONDITION / ternary / `!` position.
//
// The deferred residual of #4503: object/string/number values in boolean
// condition position did not produce a ToBoolean and demoted to legacy. This
// widens the shared `lowerToBooleanForCondition` helper (branded `irBool()`) to
// the tail-`if`, ternary, discarded-ternary and `!` sites, and has the loop path
// delegate to it.
//
// TWO complementary gates, because of a platform constraint:
//   1. CLAIM / non-vacuity — every reachable carrier (object, string, number)
//      produces an IR body (`emitted` + `irBodyEmitted`) in all three lanes.
//      Object arms are proven HERE: a wasmgc object cannot be constructed inside
//      IR-claimed code (object literals reject at select) nor passed across the
//      export boundary from JS, so the object arm is not by-value-executable yet
//      — the emitted IR (`const true` for a non-null object) is correct by
//      construction, and this test proves it lowers.
//   2. BY-VALUE execution — string ("" falsy / "x" truthy) and number (0/NaN
//      falsy) conditions are BUILT from a numeric param, run through IR, and
//      pinned against the plain-JS answer. This executes the string and f64
//      ToBoolean arms, the `!` negation, and the correct-branch selection.
//
// FINDING (pre-existing legacy bug, IR is MORE correct): in the `nativeStrings`
// lane, LEGACY treats an empty native string as TRUTHY (`if ("")` takes the then
// branch). The IR path correctly tests length, so IR and legacy DIVERGE there.
// Host and standalone legacy are correct. Legacy↔IR parity is therefore asserted
// on the host lane (where legacy is spec-correct); IR-vs-JS is asserted on all.

import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type LaneOptions = Record<string, unknown>;

const LANES: ReadonlyArray<readonly [string, LaneOptions]> = [
  ["host", {}],
  ["nativeStrings", { nativeStrings: true }],
  ["standalone", { target: "standalone" }],
];

async function compileLane(src: string, lane: LaneOptions, experimentalIR: boolean): Promise<CompileResult> {
  return await compile(src, {
    fileName: "t.ts",
    experimentalIR,
    trackIrOutcomes: true,
    ...lane,
  } as Parameters<typeof compile>[1]);
}

type IrOutcomeLike = {
  displayName?: unknown;
  kind?: unknown;
  code?: unknown;
  stage?: unknown;
  irBodyEmitted?: unknown;
};

function outcomeOf(result: CompileResult, name: string): IrOutcomeLike | undefined {
  return (result.irOutcomes as readonly IrOutcomeLike[] | undefined)?.find((o) => o.displayName === name);
}

async function instantiate(result: CompileResult): Promise<Record<string, (...a: number[]) => number>> {
  if (!result.success) throw new Error(`compile failed: ${result.errors[0]?.message}`);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, (...a: number[]) => number>;
}

/** Shapes proven to CLAIM through IR (bare object / string / number condition). */
const CLAIM_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ["object if", `export function f(o: {x:number}): number { if (o) { return 1; } else { return 0; } }`],
  ["string if", `export function f(s: string): number { if (s) { return 1; } else { return 0; } }`],
  ["number if", `export function f(n: number): number { if (n) { return 1; } else { return 0; } }`],
  ["object ternary", `export function f(o: {x:number}): number { return o ? 1 : 2; }`],
  ["string ternary", `export function f(s: string): number { return s ? 1 : 2; }`],
  ["number ternary", `export function f(n: number): number { return n ? 1 : 2; }`],
  ["!object", `export function f(o: {x:number}): number { return !o ? 1 : 0; }`],
  ["!string", `export function f(s: string): number { return !s ? 1 : 0; }`],
  [
    "while object",
    `export function f(o: {x:number}): number { let n = 0; while (o) { n++; if (n > 2) break; } return n; }`,
  ],
];

/**
 * BY-VALUE cases: build the condition from a numeric param so the module can be
 * invoked and both branches are reachable. `expect` is the plain-JS reference.
 */
interface ExecCase {
  readonly name: string;
  readonly src: string;
  readonly expect: (n: number) => number;
  readonly stringDependent: boolean; // legacy nativeStrings mis-handles empty string
}

const EXEC_CASES: ReadonlyArray<ExecCase> = [
  {
    name: 'string if ("" falsy)',
    src: `export function f(n: number): number { const s = n > 0 ? "x" : ""; if (s) { return 111; } else { return 222; } }`,
    expect: (n) => {
      const s = n > 0 ? "x" : "";
      return s ? 111 : 222;
    },
    stringDependent: true,
  },
  {
    name: "string ternary",
    src: `export function f(n: number): number { const s = n > 0 ? "abc" : ""; return s ? 333 : 444; }`,
    expect: (n) => {
      const s = n > 0 ? "abc" : "";
      return s ? 333 : 444;
    },
    stringDependent: true,
  },
  {
    name: "!string",
    src: `export function f(n: number): number { const s = n > 0 ? "y" : ""; return !s ? 555 : 666; }`,
    expect: (n) => {
      const s = n > 0 ? "y" : "";
      return !s ? 555 : 666;
    },
    stringDependent: true,
  },
  {
    name: "number if (0 / NaN falsy)",
    src: `export function f(n: number): number { if (n) { return 11; } else { return 22; } }`,
    expect: (n) => (n ? 11 : 22),
    stringDependent: false,
  },
  {
    name: "number ternary",
    src: `export function f(n: number): number { return n ? 33 : 44; }`,
    expect: (n) => (n ? 33 : 44),
    stringDependent: false,
  },
  {
    name: "!number",
    src: `export function f(n: number): number { return !n ? 55 : 66; }`,
    expect: (n) => (!n ? 55 : 66),
    stringDependent: false,
  },
];

// Inputs exercise truthy (1, 5, -2), falsy-zero (0) and falsy-NaN (NaN).
const INPUTS = [0, 1, 5, -2, NaN] as const;

describe("#4512 ref-typed ToBoolean in condition position", () => {
  describe.each(LANES)("lane %s", (laneName, laneOptions) => {
    it.each(CLAIM_SHAPES)("CLAIM (emitted + irBodyEmitted): %s", async (_name, src) => {
      const result = await compileLane(src, laneOptions, true);
      expect(result.success, `compile failed in ${laneName}`).toBe(true);
      const outcome = outcomeOf(result, "f");
      expect(outcome, `no IR outcome for f in ${laneName}`).toBeDefined();
      expect(outcome!.kind).toBe("emitted");
      expect(outcome!.irBodyEmitted, "vacuous emit — no IR body").toBe(true);
    });

    it.each(EXEC_CASES.map((c) => [c.name, c] as const))("BY-VALUE IR == JS: %s", async (_n, c) => {
      // The whole function must actually claim IR — otherwise this proves nothing.
      const compiled = await compileLane(c.src, laneOptions, true);
      expect(outcomeOf(compiled, "f")?.kind, `${c.name} did not claim IR in ${laneName}`).toBe("emitted");
      const ir = await instantiate(compiled);
      for (const n of INPUTS) {
        expect(ir.f(n), `IR ${c.name} n=${n} @${laneName}`).toBe(c.expect(n));
      }
    });
  });

  describe("legacy↔IR parity on the host lane (legacy is spec-correct there)", () => {
    it.each(EXEC_CASES.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
      const ir = await instantiate(await compileLane(c.src, {}, true));
      const legacy = await instantiate(await compileLane(c.src, {}, false));
      for (const n of INPUTS) {
        expect(ir.f(n), `parity ${c.name} n=${n}`).toBe(legacy.f(n));
      }
    });
  });

  describe("negative boundary — raw host externref must demote CLEANLY", () => {
    // `unknown` is a raw host externref: ToBoolean needs the JS host (the value
    // may box a falsy primitive), so a null test would be a WRONG answer. It
    // must reject as a TYPED capability gap, never a bare-throw invariant.
    it.each(LANES)("`if (o: unknown)` rejects unsupported, not invariant (%s)", async (_lane, laneOptions) => {
      const src = `export function f(o: unknown): number { if (o) { return 1; } else { return 0; } }`;
      const outcome = outcomeOf(await compileLane(src, laneOptions, true), "f");
      expect(outcome).toBeDefined();
      expect(outcome!.kind).toBe("unsupported");
      expect(outcome!.kind).not.toBe("invariant");
      expect(outcome!.irBodyEmitted).toBe(false);
    });
  });
});
