// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4157) The two ToNumber fast paths for the standalone lane, **both default
// ON** since the tuned-set flip (`src/perf-flags.ts`):
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
//  2. **`=0` is the byte-identical LEGACY build, and unset is the tuned one.**
//     This inverted with the default flip: the guarantee used to hang off
//     absence, and now hangs off an explicit off-token. The token rule is the
//     `derivation-flags.ts` shape — `0`/`off`/`false`/`no`/empty disable, a
//     malformed value takes the tuned default rather than half-enabling
//     anything. Junk therefore now means ON, which is the assertion below that
//     reads backwards against the pre-flip version of this file.
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

/** The legacy emission — the only way back to it is an explicit off-token. */
const OFF: Flags = { fused: "0", smi: "0" };

describe("#4157 — ToNumber fast paths default ON and are semantics-preserving", () => {
  it("only an explicit off-token disables; unset and junk are ON", { timeout: 240_000 }, async () => {
    const off = await build(OFF);
    expect((await build({ fused: "off", smi: "off" })).sha, "=off must be OFF").toBe(off.sha);
    expect((await build({ fused: "", smi: "" })).sha, "empty must be OFF").toBe(off.sha);
    // The flip's whole point: absence now means the tuned default, and a
    // malformed value falls back to that default rather than to silence.
    const unset = await build({});
    expect(unset.sha, "unset must be the TUNED build, not the legacy one").not.toBe(off.sha);
    expect((await build({ fused: "maybe", smi: "maybe" })).sha, "junk must take the default").toBe(unset.sha);
  });

  it("the default is `all` on the SMI level, and `=1` steps down to the cheap one", { timeout: 240_000 }, async () => {
    const all = await build({ fused: "0", smi: "all" });
    const cheap = await build({ fused: "0", smi: "1" });
    const dflt = await build({ fused: "0" });
    expect(dflt.sha, "unset SMI must equal =all, the level entry (34) measured").toBe(all.sha);
    expect(cheap.sha, "=1 must still select the restricted i32-only level").not.toBe(all.sha);
  });

  it("each flag actually changes the emission", { timeout: 240_000 }, async () => {
    const base = await build(OFF);
    const fused = await build({ fused: "1", smi: "0" });
    const smi = await build({ fused: "0", smi: "1" });
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
    ["flags off", OFF],
    ["fused only", { fused: "1", smi: "0" }],
    ["smi only", { fused: "0", smi: "1" }],
    ["smi=all only", { fused: "0", smi: "all" }],
    ["both", { fused: "1", smi: "1" }],
    ["the shipped default (both unset)", {}],
  ] as [string, Flags][]) {
    it(`matches native Node — ${label}`, { timeout: 240_000 }, async () => {
      await assertMatchesNode((await build(flags)).binary, label);
    });
  }
});
