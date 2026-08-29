// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5167 — counted-loop proof for string `s[i]` reads on the IR path.
//
// #2972 taught `lowerElementAccess` to delegate a PROVEN-in-bounds string
// element read to the existing charAt machinery (`s[i]` ≡ `s.charAt(i)` for
// integer 0 ≤ i < s.length — §10.4.3.5 vs §22.1.3.1). Its proof was
// literal-length only (`const hex = "0123…"; hex[n & 0xf]`), which a string
// PARAM can never satisfy — so `for (let i = 0; i < s.length; i++) … s[i]`
// claimed at select and then demoted at BUILD with
// `element-access-unsupported` in all three lanes.
//
// This issue adds the SECOND proof to the SAME arm: the #2766 counted-loop
// witness (`detectCountedLoopSafeIndex`, already syntactic and already
// recording string receivers). No new read primitive, no per-lane work, and
// no OOB decision — OOB is unreachable under the proof, so the UNPROVEN
// residual keeps demoting exactly as before. The tests below hold both
// halves: the newly-claimed shapes emit an IR body in every lane with
// runtime parity against the legacy front-end, and the residual + every
// proof-voiding shape still demotes.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { stringElementReadLowerable } from "../src/ir/capability.js";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Lane = { readonly name: string; readonly opts: Record<string, unknown> };

/** The three lanes the acceptance criteria name. */
const LANES: readonly Lane[] = [
  { name: "default", opts: {} },
  { name: "nativeStrings", opts: { nativeStrings: true } },
  { name: "standalone", opts: { target: "standalone" } },
];

async function compileIr(src: string, lane: Lane): Promise<CompileResult> {
  return compile(src, {
    fileName: "issue-5167.ts",
    experimentalIR: true,
    trackIrOutcomes: true,
    ...lane.opts,
  } as never);
}

/** The emission bar: `kind: "emitted"` AND `irBodyEmitted: true` for `name`. */
function outcomeOf(r: CompileResult, name: string): { kind: string; irBodyEmitted: boolean; code?: string } {
  const row = (r.irOutcomes ?? []).find((o) => o.displayName === name);
  if (!row) throw new Error(`no IR outcome row for "${name}"`);
  return { kind: row.kind, irBodyEmitted: row.irBodyEmitted, code: (row as { code?: string }).code };
}

async function instantiate(r: CompileResult): Promise<Record<string, Function>> {
  const imports = (r.imports ?? []).length === 0 ? {} : buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(exports);
  exports.__module_init?.();
  return exports;
}

// ── Sources ────────────────────────────────────────────────────────────────
//
// Every runtime source exports a zero-argument NUMBER-returning `run` so the
// same module can be instantiated and called identically in all three lanes
// (a string argument cannot cross the standalone boundary). The string PARAM
// — the shape this issue is about — lives on the inner helper, which is what
// the proof and the emission assertions target.

/** The canonical shape: counted loop over a string PARAM, reading `s[i]`. */
const COUNT_SRC = `
function countA(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "a") n = n + 1;
  }
  return n;
}
export function run(): number {
  // "a" is the length-1 boundary; "" is the empty-loop boundary.
  return countA("banana") * 1000 + countA("a") * 100 + countA("") * 10 + countA("bbb");
}
`;

/** Same proof, `const c = s[i]` binding form + a `+= 2` step. */
const BIND_SRC = `
function scan(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 2) {
    const c = s[i];
    if (c === "x") n = n + 3;
    if (c === "y") n = n + 5;
  }
  return n;
}
export function run(): number {
  return scan("xyxyxy") * 100 + scan("x") * 10 + scan("");
}
`;

/** Residual: a bare `s[i]` with no enclosing counted loop. */
const BARE_SRC = `
export function pick(s: string, i: number): string {
  return s[i];
}
`;

/** Residual: a constant index on a PARAM — no statically known length. */
const CONST_INDEX_SRC = `
export function first(s: string): string {
  return s[0];
}
`;

/** Proof-voided: the body reassigns the induction variable. */
const MUTATES_INDEX_SRC = `
export function bad(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "a") n = n + 1;
    i = i + 0;
  }
  return n;
}
`;

/** Proof-voided: the body calls a method on the receiver (documented limit). */
const RECEIVER_METHOD_SRC = `
export function mixed(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "a") n = n + 1;
    if (s.charCodeAt(i) === 98) n = n + 2;
  }
  return n;
}
`;

/** Proof-voided: `<=` admits `i === s.length`, which is OOB. */
const NON_STRICT_SRC = `
export function offByOne(s: string): number {
  let n = 0;
  for (let i = 0; i <= s.length; i++) {
    if (s[i] === "a") n = n + 1;
  }
  return n;
}
`;

/** The #2972 literal-length shape — must keep claiming exactly as before. */
const LITERAL_LEN_SRC = `
function toHex(n: number): string {
  const hex = "0123456789ABCDEF";
  return hex[(n >> 4) & 0xf] + hex[n & 0xf];
}
export function run(): number {
  return toHex(0xab) === "AB" && toHex(0) === "00" && toHex(0xff) === "FF" ? 1 : 0;
}
`;

async function expectDemotesEverywhere(src: string, name: string): Promise<void> {
  for (const lane of LANES) {
    const r = await compileIr(src, lane);
    expect(r.success, `${lane.name}: ${r.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const o = outcomeOf(r, name);
    expect({ lane: lane.name, ...o }).toEqual({
      lane: lane.name,
      kind: "unsupported",
      irBodyEmitted: false,
      code: "element-access-unsupported",
    });
  }
}

describe("#5167 counted-loop-proven string index reads", () => {
  describe("claim + emit in all three lanes", () => {
    for (const [label, src, fn] of [
      ["counted loop over a string param", COUNT_SRC, "countA"],
      ["const-bound read with a +=2 step", BIND_SRC, "scan"],
    ] as const) {
      it(`${label}: emitted with an IR body in every lane`, async () => {
        for (const lane of LANES) {
          const r = await compileIr(src, lane);
          expect(r.success, `${lane.name}: ${r.errors.map((e) => e.message).join("\n")}`).toBe(true);
          expect({ lane: lane.name, ...outcomeOf(r, fn) }).toEqual({
            lane: lane.name,
            kind: "emitted",
            irBodyEmitted: true,
            code: undefined,
          });
          expect(r.irPostClaimErrors ?? []).toEqual([]);
        }
      });
    }

    it("the #2972 literal-length shape still emits (no regression)", async () => {
      for (const lane of LANES) {
        const r = await compileIr(LITERAL_LEN_SRC, lane);
        expect(r.success, `${lane.name}: ${r.errors.map((e) => e.message).join("\n")}`).toBe(true);
        expect({ lane: lane.name, ...outcomeOf(r, "toHex") }).toEqual({
          lane: lane.name,
          kind: "emitted",
          irBodyEmitted: true,
          code: undefined,
        });
      }
    });
  });

  describe("runtime parity vs the legacy front-end", () => {
    // MEASURED on origin/main fc6fd3b5 (2026-08-29, `.tmp/legacy-check.mts`, an
    // A/B against a pristine `src/ir/`): the LEGACY front-end is ALREADY wrong
    // in the nativeStrings lane for both string shapes here — the counted-loop
    // source returns 0 instead of 3100, and the #2972 literal-length shape
    // traps with "illegal cast". That is pre-existing and untouched by this
    // change: `experimentalIR: false` never enters `src/ir/`. So parity is
    // asserted against legacy only in the lanes where legacy is sound, while
    // the IR value is asserted against the SPEC answer in ALL three — which is
    // how this change makes nativeStrings CORRECT where legacy is not.
    const LEGACY_SOUND_LANES: ReadonlySet<string> = new Set(["default", "standalone"]);

    for (const [label, src, expected] of [
      // countA("banana")=3, countA("a")=1, countA("")=0, countA("bbb")=0
      ["counted loop over a string param", COUNT_SRC, 3100],
      // scan("xyxyxy") reads i=0,2,4 → "x","x","x" = 9; scan("x")=3; scan("")=0
      ["const-bound read with a +=2 step", BIND_SRC, 930],
      ["the #2972 literal-length shape", LITERAL_LEN_SRC, 1],
    ] as const) {
      it(`${label}: same value on the IR and legacy paths, every lane`, async () => {
        for (const lane of LANES) {
          const ir = await compileIr(src, lane);
          expect(ir.success, `${lane.name}: ${ir.errors.map((e) => e.message).join("\n")}`).toBe(true);
          const irRun = (await instantiate(ir)).run as () => number;
          expect({ lane: lane.name, v: irRun() }).toEqual({ lane: lane.name, v: expected });
          if (!LEGACY_SOUND_LANES.has(lane.name)) continue;
          const legacy = await compile(src, {
            fileName: "issue-5167.ts",
            experimentalIR: false,
            ...lane.opts,
          } as never);
          expect(legacy.success, `${lane.name} legacy`).toBe(true);
          const legacyRun = (await instantiate(legacy)).run as () => number;
          expect({ lane: lane.name, v: legacyRun() }).toEqual({ lane: lane.name, v: expected });
        }
      });
    }
  });

  describe("residual preservation — everything unproven still demotes", () => {
    it("bare `s[i]` with no enclosing loop", async () => {
      await expectDemotesEverywhere(BARE_SRC, "pick");
    });
    it("`s[0]` on a param (no statically known length)", async () => {
      await expectDemotesEverywhere(CONST_INDEX_SRC, "first");
    });
    it("body reassigns the induction variable", async () => {
      await expectDemotesEverywhere(MUTATES_INDEX_SRC, "bad");
    });
    it("body calls a method on the receiver (documented over-conservatism)", async () => {
      await expectDemotesEverywhere(RECEIVER_METHOD_SRC, "mixed");
    });
    it("`i <= s.length` admits the OOB index", async () => {
      await expectDemotesEverywhere(NON_STRICT_SRC, "offByOne");
    });
  });

  describe("stringElementReadLowerable — the single-source predicate", () => {
    // `s[i]` (identifier index), `s[5]`, `s[n & 0xf]`, `s?.[i]`, `t[i]`.
    const sf = ts.createSourceFile(
      "p.ts",
      "const a = s[i]; const b = s[5]; const c = s[n & 0xf]; const d = s?.[i]; const e = t[i];",
      ts.ScriptTarget.Latest,
      true,
    );
    const reads: ts.ElementAccessExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isElementAccessExpression(node)) reads.push(node);
      node.forEachChild(visit);
    };
    sf.forEachChild(visit);
    const [ident, lit5, masked, optional, otherRecv] = reads;
    const lens = new Map([["s", 16]]);

    it("without a witness, only the #2972 literal-length proof admits a read", () => {
      expect(stringElementReadLowerable(ident!, lens)).toBe(false); // unbounded `i`
      expect(stringElementReadLowerable(lit5!, lens)).toBe(true); // 5 < 16
      expect(stringElementReadLowerable(masked!, lens)).toBe(true); // [0,15] < 16
      expect(stringElementReadLowerable(otherRecv!, lens)).toBe(false); // no length fact
    });

    it("the counted-loop witness admits an identifier index with NO length fact", () => {
      // This is the whole point: a string PARAM is never in `lens`.
      expect(stringElementReadLowerable(ident!, undefined, true)).toBe(true);
      expect(stringElementReadLowerable(otherRecv!, new Map(), true)).toBe(true);
    });

    it("the witness never widens beyond the induction variable it ranges over", () => {
      // A non-identifier index is not what `detectCountedLoopSafeIndex` proved,
      // so the witness must not carry it — it falls back to the literal proof.
      expect(stringElementReadLowerable(masked!, undefined, true)).toBe(false);
      expect(stringElementReadLowerable(masked!, lens, true)).toBe(true); // literal proof
      // Optional chaining is out of scope under either proof (#2713).
      expect(stringElementReadLowerable(optional!, lens, true)).toBe(false);
    });
  });
});
