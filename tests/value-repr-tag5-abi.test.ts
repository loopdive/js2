// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2141 S1 — tag-5 box-the-externref ABI retirement: the two-regime probe suite.
//
// The `honestAnyBoxing` compile option (default OFF) is the Stage-B regime
// flag: ON routes generic externref boxing through runtime classification to
// the true `JsTag` (via `__any_from_extern`, whose null/fallback arms are
// honest under the flag) instead of the historical blanket tag-5 "string"
// (#1888). This suite is the migration ratchet:
//
//  1. INERTNESS — flag absent vs explicitly false is byte-identical (the
//     legacy regime carries zero dark-launch risk).
//  2. EXERCISED — flag-on modules actually register + route through the
//     honest boxer where the generic arm fires.
//  3. BEHAVIOR PINS — a measured matrix of dynamic-value shapes across
//     {legacy, honest} × {fast, plain} standalone. Cells are pinned to
//     CURRENT behavior (some are known-wrong vs JS truth — the `jsTruth`
//     column documents the target). When a #2141 slice fixes a cell the pin
//     fails loudly → update the pin, shrinking the known-wrong set. A pin
//     that regresses toward wrong is an instant local signal.
//  4. NO-REGRESSION INVARIANT — for every shape, wherever the LEGACY regime
//     already answers correctly, the HONEST regime must too. (Honesty may
//     only fix, never break — the structural guarantee that makes the S4
//     flip monotone.)
//
// See plan/issues/2141-tag5-abi-untangle-honest-boxing.md (Implementation
// Plan) for the slice DAG: S2 dstr-reliance root-cause, S3 tag-agnostic eq
// consumers, S4 default flip, S5 retire the lie.
import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Regime = { honestAnyBoxing: boolean };
type Lane = { fast: boolean };

async function build(src: string, lane: Lane, regime?: Regime): Promise<Uint8Array> {
  const r = await compile(src, {
    target: "standalone",
    ...(lane.fast ? { fast: true } : {}),
    ...(regime ?? {}),
  } as never);
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  return r.binary;
}

async function run(binary: Uint8Array): Promise<unknown> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as { test(): unknown }).test();
}

const sha = (b: Uint8Array) => createHash("sha256").update(Buffer.from(b)).digest("hex");
const hasName = (b: Uint8Array, name: string) => Buffer.from(b).includes(Buffer.from(name, "utf8"));

/**
 * The probe matrix. `pins` = MEASURED current results per
 * [fastOff, fastOn, plainOff, plainOn]; `jsTruth` = the ECMAScript answer.
 * Known-wrong pins (≠ jsTruth) are the migration backlog:
 *  - eqUndefUndef  plain: `undefined === undefined` via any locals → 0 (both
 *    regimes; pre-existing, independent of the boxing lie — S3 territory).
 *  - launderedUndefEq fast: generic-boxed undefined vs literal-boxed
 *    undefined cross-tag → 0 (both regimes; the mixed-provenance coherence
 *    class behind the −794 — S3 eq classifier + S4 flip resolve it).
 *  - launderedObjTypeof fast legacy: tag-5 lie makes `typeof <obj as any>`
 *    answer "string" → 0. The HONEST regime already fixes it (pin 1) — the
 *    first measurable S1 win.
 */
const MATRIX: Array<{
  name: string;
  src: string;
  jsTruth: number;
  /** [fast+legacy, fast+honest, plain+legacy, plain+honest] */
  pins: [number, number, number, number];
}> = [
  {
    name: "typeofUndef",
    src: `export function test(): number { const x: any = undefined; const y: any = x; return (typeof y === "undefined") ? 1 : 0; }`,
    jsTruth: 1,
    pins: [1, 1, 1, 1],
  },
  {
    name: "eqUndefUndef",
    src: `export function test(): number { const x: any = undefined; const y: any = undefined; return x === y ? 1 : 0; }`,
    jsTruth: 1,
    pins: [1, 1, 0, 0],
  },
  {
    name: "eqUndefNum",
    src: `export function test(): number { const x: any = undefined; const y: any = 1; return x === y ? 1 : 0; }`,
    jsTruth: 0,
    pins: [0, 0, 0, 0],
  },
  {
    name: "eqObjSelf",
    src: `export function test(): number { const o = { a: 1 }; const x: any = o; const y: any = o; return x === y ? 1 : 0; }`,
    jsTruth: 1,
    pins: [1, 1, 1, 1],
  },
  {
    name: "eqObjDistinct",
    src: `export function test(): number { const x: any = { a: 1 }; const y: any = { a: 1 }; return x === y ? 1 : 0; }`,
    jsTruth: 0,
    pins: [0, 0, 0, 0],
  },
  {
    name: "eqStrContent",
    src: `export function test(): number { const x: any = "ab"; const y: any = "a" + "b"; return x === y ? 1 : 0; }`,
    jsTruth: 1,
    pins: [1, 1, 1, 1],
  },
  {
    name: "truthyUndef",
    src: `export function test(): number { const x: any = undefined; const y: any = x; return y ? 1 : 0; }`,
    jsTruth: 0,
    pins: [0, 0, 0, 0],
  },
  {
    name: "launderedUndefEq",
    src: `function id(v: any): any { return v; } export function test(): number { const y: any = id(undefined); return y === undefined ? 1 : 0; }`,
    jsTruth: 1,
    pins: [0, 0, 1, 1],
  },
  {
    name: "launderedTypeof",
    src: `function id(v: any): any { return v; } export function test(): number { const y: any = id(undefined); return typeof y === "undefined" ? 1 : 0; }`,
    jsTruth: 1,
    pins: [1, 1, 1, 1],
  },
  {
    name: "launderedObjTypeof",
    src: `function id(v: any): any { return v; } export function test(): number { const y: any = id({ a: 1 }); return typeof y === "object" ? 1 : 0; }`,
    jsTruth: 1,
    pins: [0, 1, 1, 1],
  },
];

const LANES: Array<{ label: string; lane: Lane }> = [
  { label: "fast", lane: { fast: true } },
  { label: "plain", lane: { fast: false } },
];

describe("#2141 S1 — flag-off inertness (legacy regime byte-identical)", () => {
  for (const { label, lane } of LANES) {
    it(`option absent vs explicit false: identical binaries (${label} standalone)`, async () => {
      for (const { name, src } of MATRIX) {
        const absent = await build(src, lane);
        const explicitOff = await build(src, lane, { honestAnyBoxing: false });
        expect(sha(explicitOff), name).toBe(sha(absent));
        // The honest boxer must not leak into legacy modules.
        expect(hasName(absent, "__any_from_extern") === hasName(explicitOff, "__any_from_extern"), name).toBe(true);
      }
    });
  }
});

describe("#2141 S1 — honest regime is exercised where the generic arm fires", () => {
  it("flag-on registers __any_from_extern and changes the module (fast standalone typeof shape)", async () => {
    const shape = MATRIX.find((m) => m.name === "typeofUndef")!;
    const off = await build(shape.src, { fast: true }, { honestAnyBoxing: false });
    const on = await build(shape.src, { fast: true }, { honestAnyBoxing: true });
    expect(sha(on)).not.toBe(sha(off));
    expect(hasName(on, "__any_from_extern")).toBe(true);
  });
});

describe("#2141 S1 — behavior pins (the migration ratchet)", () => {
  for (const probe of MATRIX) {
    for (let cell = 0; cell < 4; cell++) {
      const { label, lane } = LANES[cell < 2 ? 0 : 1]!;
      const honest = cell % 2 === 1;
      const pinned = probe.pins[cell]!;
      const wrongNote = pinned === probe.jsTruth ? "" : ` [KNOWN-WRONG vs js=${probe.jsTruth}]`;
      it(`${probe.name} · ${label} · ${honest ? "honest" : "legacy"} → ${pinned}${wrongNote}`, async () => {
        const bin = await build(probe.src, lane, { honestAnyBoxing: honest });
        expect(await run(bin)).toBe(pinned);
      });
    }
  }
});

describe("#2141 S1 — honesty may only fix, never break", () => {
  it("wherever legacy answers correctly, honest does too (pin-table invariant)", () => {
    for (const probe of MATRIX) {
      // fast lane
      if (probe.pins[0] === probe.jsTruth) {
        expect(probe.pins[1], `${probe.name} fast: honest regressed a correct legacy answer`).toBe(probe.jsTruth);
      }
      // plain lane
      if (probe.pins[2] === probe.jsTruth) {
        expect(probe.pins[3], `${probe.name} plain: honest regressed a correct legacy answer`).toBe(probe.jsTruth);
      }
    }
  });
});
