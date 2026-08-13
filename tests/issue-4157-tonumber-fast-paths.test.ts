// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4157) The two default-OFF ToNumber fast paths for the standalone lane:
//
//   JS2WASM_FUSED_TONUMBER — Slice A, `__to_primitive` + `__unbox_number`
//                            fused into one `__to_number(externref) -> f64`.
//   JS2WASM_SMI_FASTPATH   — Slice B, a `ref.test i31` guard that answers the
//                            small-integer case with `i31.get_s` and no call.
//
// Three things are pinned, and the first is the one that is easy to get wrong:
//
//  1. **The flag-ON build must DIFFER from the flag-OFF build.** A
//     parity-only test passes just as happily when the gate silently declined
//     every site and measured nothing — that is exactly how #4157 entry (14)'s
//     first fixture fooled itself (no `__module_init`, pass bailed, binaries
//     identical, test green). So difference is asserted explicitly.
//  2. **The flag-OFF build is byte-identical** to one compiled with the
//     variables absent, and `=0` is off (the token rule: only an affirmative
//     token turns these on, unlike the `derivation-flags.ts` family).
//  3. **Every answer is checked against NATIVE NODE**, not against the
//     flag-off build, so a wrong answer shared by both flag states still fails.
//     The value matrix is chosen for the i31 boundary (±2^30) and for every
//     shape the fast arms must REFUSE: -0, NaN, ±Infinity, strings, objects
//     with `valueOf`/`toString`, arrays, and the boxed wrappers.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { compile } from "../src/index.js";

const FUSED = "JS2WASM_FUSED_TONUMBER";
const SMI = "JS2WASM_SMI_FASTPATH";

/** The i31 payload range `__box_number` accepts: [-2^30, 2^30-1]. */
const I31_MAX = 2 ** 30 - 1;
const I31_MIN = -(2 ** 30);

const VALUES = [
  0,
  1,
  5,
  -7,
  I31_MAX,
  I31_MIN,
  I31_MAX + 1,
  I31_MIN - 1,
  2.5,
  -0,
  NaN,
  Infinity,
  -Infinity,
  null,
  undefined,
  true,
  false,
  "",
  "  42  ",
  "abc",
];

const VALUES_SRC = `[
  0, 1, 5, -7, ${I31_MAX}, ${I31_MIN}, ${I31_MAX + 1}, ${I31_MIN - 1}, 2.5, -0,
  NaN, Infinity, -Infinity, null, undefined, true, false, "", "  42  ", "abc",
  { valueOf: function () { return 7; } },
  { toString: function () { return "8"; } },
  { valueOf: function () { return {}; }, toString: function () { return "9"; } },
  [], [5], new Number(11), new Boolean(true), new String("12")
]`;

const HOST_EXTRA = [
  { valueOf: () => 7 },
  { toString: () => "8" },
  { valueOf: () => ({}), toString: () => "9" },
  [] as unknown,
  [5] as unknown,
  new Number(11),
  new Boolean(true),
  new String("12"),
];

const SRC = `
var vals: any[] = ${VALUES_SRC};
export function nvals(): number { return vals.length; }
export function probe(i: number, k: number): number {
  var v: any = vals[i];
  if (k === 0) return v - 0;
  if (k === 1) return v * 1;
  if (k === 2) return +v;
  if (k === 3) return Number(v);
  if (k === 4) return v < 5 ? 1 : 0;
  if (k === 5) return v >= 5 ? 1 : 0;
  if (k === 6) return -v;
  if (k === 7) return v - v;
  return -999;
}
// valueOf must be tried FIRST under the number hint: 2 - 1 = 1. If toString
// ran first the answer would be "3" - 1 = 2.
var both: any = { valueOf: function (): any { return 2; }, toString: function (): any { return "3"; } };
export function ordering(): number { return both - 1; }
// A throwing valueOf must still throw, from the same operand position.
var bad: any = { valueOf: function (): any { throw new TypeError("boom"); } };
export function throwing(): number {
  try {
    return bad - 1;
  } catch (e: any) {
    return 777;
  }
}
`;

type Flags = { fused?: string; smi?: string };

async function build(flags: Flags): Promise<{ binary: Uint8Array; sha: string }> {
  const prevFused = process.env[FUSED];
  const prevSmi = process.env[SMI];
  if (flags.fused === undefined) delete process.env[FUSED];
  else process.env[FUSED] = flags.fused;
  if (flags.smi === undefined) delete process.env[SMI];
  else process.env[SMI] = flags.smi;
  try {
    const r = await compile(SRC, { fileName: "p.ts", skipSemanticDiagnostics: true, target: "standalone" });
    expect(r.binary?.length, r.errors.map((e) => e.message).join("\n")).toBeGreaterThan(0);
    return { binary: r.binary, sha: createHash("sha256").update(r.binary).digest("hex") };
  } finally {
    if (prevFused === undefined) delete process.env[FUSED];
    else process.env[FUSED] = prevFused;
    if (prevSmi === undefined) delete process.env[SMI];
    else process.env[SMI] = prevSmi;
  }
}

const hostVals: unknown[] = [...VALUES, ...HOST_EXTRA];

function hostProbe(i: number, k: number): number {
  const v = hostVals[i] as never;
  switch (k) {
    case 0:
      return (v as number) - 0;
    case 1:
      return (v as number) * 1;
    case 2:
      return +(v as number);
    case 3:
      return Number(v);
    case 4:
      return (v as number) < 5 ? 1 : 0;
    case 5:
      return (v as number) >= 5 ? 1 : 0;
    case 6:
      return -(v as number);
    case 7:
      return (v as number) - (v as number);
    default:
      return -999;
  }
}

type Probes = {
  nvals: () => number;
  probe: (i: number, k: number) => number;
  ordering: () => number;
  throwing: () => number;
};

async function instantiate(binary: Uint8Array): Promise<Probes> {
  const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary), {});
  return exports as unknown as Probes;
}

/** `Object.is`, but with NaN === NaN so a NaN answer is comparable. */
function same(a: number, b: number): boolean {
  return (Number.isNaN(a) && Number.isNaN(b)) || Object.is(a, b);
}

async function assertMatchesNode(binary: Uint8Array, label: string): Promise<void> {
  const ex = await instantiate(binary);
  expect(ex.nvals(), `${label}: case count`).toBe(hostVals.length);
  const bad: string[] = [];
  for (let i = 0; i < hostVals.length; i++) {
    for (let k = 0; k <= 7; k++) {
      const got = ex.probe(i, k);
      const want = hostProbe(i, k);
      if (!same(got, want)) bad.push(`probe(${i},${k}) got=${got} want=${want}`);
    }
  }
  expect(bad, `${label}: ${bad.length} divergence(s) vs native Node`).toEqual([]);
  // ToPrimitive method order and its side effects survive both fast paths.
  expect(ex.ordering(), `${label}: valueOf must precede toString`).toBe(1);
  expect(ex.throwing(), `${label}: a throwing valueOf must still throw`).toBe(777);
}

describe("#4157 — ToNumber fast paths are opt-in and semantics-preserving", () => {
  it("is byte-identical with the flags unset, empty or 0", { timeout: 240_000 }, async () => {
    const base = await build({});
    expect((await build({ fused: "0", smi: "0" })).sha, "=0 must be OFF").toBe(base.sha);
    expect((await build({ fused: "", smi: "" })).sha, "empty must be OFF").toBe(base.sha);
    // A non-affirmative token must NOT enable these (opposite of the
    // derivation-flags family, where any junk value means ON).
    expect((await build({ fused: "maybe", smi: "maybe" })).sha, "junk must be OFF").toBe(base.sha);
  });

  it("each flag actually changes the emission", { timeout: 240_000 }, async () => {
    const base = await build({});
    const fused = await build({ fused: "1" });
    const smi = await build({ smi: "1" });
    expect(fused.sha, "JS2WASM_FUSED_TONUMBER=1 emitted nothing new").not.toBe(base.sha);
    expect(smi.sha, "JS2WASM_SMI_FASTPATH=1 emitted nothing new").not.toBe(base.sha);
    expect(fused.sha, "the two flags must not collapse to the same emission").not.toBe(smi.sha);
    // Slice B inlines a guard at every site and adds no shared function, so it
    // grows the module unconditionally — that IS assertable.
    expect(smi.binary.length, "the inline guard should grow the module").toBeGreaterThan(base.binary.length);
    // Slice A is NOT assertable in the same way, and the reason is worth
    // recording: it trades ~11 bytes per site (a hint `global.get` + one call)
    // for one shared helper of fixed size, so its size sign depends on the SITE
    // COUNT. Measured: this fixture (a couple of dozen sites) grows by ~21 B,
    // while standalone acorn (1,085 sites) SHRINKS by 6,314 B. Same break-even
    // shape as the #4157 const-box hoist. Asserting "smaller" here would pin a
    // property of the fixture, not of the change.
  });

  for (const [label, flags] of [
    ["flags off", {}],
    ["fused only", { fused: "1" }],
    ["smi only", { smi: "1" }],
    ["both", { fused: "1", smi: "1" }],
  ] as [string, Flags][]) {
    it(`matches native Node — ${label}`, { timeout: 240_000 }, async () => {
      await assertMatchesNode((await build(flags)).binary, label);
    });
  }
});
