// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Call-site inline cache for dynamic property reads.
 *
 * Three things have to hold, and the third is the one that killed the design
 * this one replaces (#2674).
 *
 * 1. ANSWERS. `run()` is compared against what native Node produces for the
 *    identical program. An ON-vs-OFF comparison alone would happily agree on a
 *    wrong answer — that is how #4217's `generator` defect (a constant `false`
 *    on one field of 64) stayed invisible.
 *
 * 2. MECHANISM. Parity also passes if the pass silently never engages. The
 *    fixture reads the pass's own site counter out of its debug channel and
 *    asserts sites were rewritten AND that the count grows when the candidate
 *    ceiling is raised — a gate that never bites is indistinguishable from an
 *    absent gate.
 *
 * 3. READ/WRITE AGREEMENT. #2674's frozen inline chain answered `undefined` for
 *    a receiver shape it did not know about while the WRITE dispatcher hit the
 *    slot; acorn's expression parser then never terminated. So `run()` writes a
 *    property through an `any` receiver onto a struct with NO slot for it (the
 *    write lands in the sidecar) and reads it back through the inline guard,
 *    which must MISS and defer to the dispatcher; and it updates a REAL slot in
 *    place and re-reads it, which is why the guard must read the slot rather
 *    than cache a value.
 *
 * ## Why there are two exported entry points
 *
 * `runDyn()` holds the reads whose receiver does NOT carry the numeric name
 * being read. On the BASE build those answer `NaN`, not `undefined`, because
 * #1269's Phase-3 narrowing collapses a single-f64-candidate read to f64 and a
 * miss unboxes to NaN. That is pre-existing behaviour this feature neither
 * causes nor fixes, so Node is not the right oracle for it — the base build is,
 * and the contract being tested ("the inline arm answers exactly what the
 * dispatcher would have") is exactly an ON-vs-OFF equality. They are the most
 * interesting cases in the file: they are where the speculation MISSES.
 *
 * Every class has a DISTINCT field arity on purpose. Structurally identical
 * WasmGC structs canonicalize to one heap type, so same-shape classes make
 * `ref.test $A` match a `B` — a real, pre-existing aliasing behaviour of the
 * dispatcher ladder that this feature neither introduces nor fixes, and that
 * would otherwise make this fixture measure that instead of this.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
class Mono { mv: string; nv: number; constructor(v: string) { this.mv = v; this.nv = 5; } }
class Bare { other: string; ov: number; b2: string; b3: string; constructor(v: string) { this.other = v; this.ov = 6; this.b2 = "x"; this.b3 = "y"; } }
class PolyA { pv: string; qv: number; a2: string; constructor(v: string) { this.pv = v; this.qv = 31; this.a2 = "a"; } }
class PolyB { pv: string; qv: number; p2: string; p3: string; p4: string; constructor(v: string) { this.pv = v; this.qv = 32; this.p2 = "b"; this.p3 = "c"; this.p4 = "d"; } }
class Getter { hidden: number; h2: string; h3: string; h4: string; h5: string; constructor() { this.hidden = 7; this.h2 = "e"; this.h3 = "f"; this.h4 = "g"; this.h5 = "h"; } get gv(): number { return this.hidden; } }
class Meth { q1: string; q2: string; q3: string; q4: string; q5: string; q6: string; constructor() { this.q1 = "i"; this.q2 = "j"; this.q3 = "k"; this.q4 = "l"; this.q5 = "m"; this.q6 = "n"; } mm(): number { return 11; } }

function rMv(o: any): any { return o.mv; }
function rNv(o: any): any { return o.nv; }
function rOv(o: any): any { return o.ov; }
function rQv(o: any): any { return o.qv; }
function rPv(o: any): any { return o.pv; }
function rGv(o: any): any { return o.gv; }
function rMm(o: any): any { return o.mm; }
function rOther(o: any): any { return o.other; }

// Maps every observed value to a small integer. Stringifying instead would
// compare \`String(fn)\` source text, which differs between Node and the
// compiled build for reasons unrelated to this feature.
function code(v: any): number {
  if (v === undefined) return 1;
  if (v === null) return 2;
  if (typeof v === "boolean") return v ? 3 : 4;
  if (typeof v === "function") return 6;
  if (typeof v === "string") return 10 + (v as string).length * 3 + (v as string).charCodeAt(0) % 17;
  if (typeof v === "number") return 100 + (v as number);
  return 7;
}

function mix(acc: number, v: any): number { return (acc * 1009 + code(v)) % 1000000007; }

export function run(): number {
  var acc = 0;
  var mono: any = new Mono("aa");
  var bare: any = new Bare("bb");
  var pa: any = new PolyA("cc");
  var pb: any = new PolyB("dd");
  var getter: any = new Getter();
  var meth: any = new Meth();
  var lit: any = { gv: 8, lv: 9, l3: 1, l4: 1, l5: 1, l6: 1, l7: 1 };

  // Monomorphic reference field.
  acc = mix(acc, rMv(mono));
  // Same name on a struct with no such slot: MISS -> dispatcher.
  acc = mix(acc, rMv(bare));
  // Same name on a plain hash-bag receiver: MISS -> dispatcher -> __extern_get.
  acc = mix(acc, rMv(lit));

  // Monomorphic NUMERIC fields — these also reserve the #3673 typed-f64 twin,
  // so the second read below goes through a differently-shaped inlined arm.
  acc = mix(acc, rNv(mono));
  acc = mix(acc, rNv(mono) + 1);
  acc = mix(acc, rOv(bare));

  // Polymorphic names: one receiver is candidate[0], the other is not.
  acc = mix(acc, rQv(pa));
  acc = mix(acc, rQv(pb));
  acc = mix(acc, rPv(pa));
  acc = mix(acc, rPv(pb));
  acc = mix(acc, rPv(mono));

  // Get-accessor name, also carried by a plain object literal. An inline field
  // arm here would shadow the getter.
  acc = mix(acc, rGv(getter));
  acc = mix(acc, rGv(lit));
  acc = mix(acc, rGv(mono));

  // Method value: no struct field carries the name, and the canonical singleton
  // identity must hold through the dynamic path.
  acc = mix(acc, rMm(meth));
  acc = mix(acc, rMm(meth) === meth.mm);
  acc = mix(acc, rMm(mono));

  acc = mix(acc, rOther(bare));
  acc = mix(acc, rOther(mono));

  // READ/WRITE AGREEMENT (#2674). Writing \`mv\` onto a receiver with no \`mv\`
  // slot lands in the sidecar; reading it back must see the written value, not
  // the inline guard's opinion.
  bare.mv = "zz";
  acc = mix(acc, rMv(bare));
  lit.mv = "qq";
  acc = mix(acc, rMv(lit));
  // ...and an in-place update of a REAL slot must stay visible through the
  // guard, which is why the arm reads the slot instead of caching a value.
  mono.mv = "ww";
  acc = mix(acc, rMv(mono));
  mono.nv = 41;
  acc = mix(acc, rNv(mono));
  acc = mix(acc, rNv(mono) + 1);

  return acc;
}

/** The speculation-MISS cases. Base build is the oracle — see the file header. */
export function runDyn(): number {
  var acc = 0;
  var mono: any = new Mono("aa");
  var bare: any = new Bare("bb");
  var pa: any = new PolyA("cc");
  var lit: any = { gv: 8, lv: 9, l3: 1, l4: 1, l5: 1, l6: 1, l7: 1 };
  acc = mix(acc, rNv(bare));
  acc = mix(acc, rNv(lit));
  acc = mix(acc, rOv(mono));
  acc = mix(acc, rQv(mono));
  acc = mix(acc, rQv(pa));
  bare.nv = 12;
  acc = mix(acc, rNv(bare));
  return acc;
}
`;

/** The identical program in plain JS — the oracle for `run()`. */
const NODE_ANSWER: number = (() => {
  const js = SOURCE.replace(/:\s*(number|any|string)\b/g, "")
    .replace(/ as (number|string)/g, "")
    .replace(/^export /gm, "");
  return new Function(`${js}\nreturn run();`)() as number;
})();

interface Built {
  binary: Uint8Array;
  patchedSites: number;
  eligible: number;
}

async function build(ic: string | undefined): Promise<Built> {
  const saved = { ic: process.env.JS2WASM_INLINE_PROP_IC, dbg: process.env.JS2WASM_INLINE_PROP_IC_DEBUG };
  const set = (key: string, value: string | undefined): void => {
    // `= undefined` coerces to the STRING "undefined", which reads as "set".
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  const lines: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  set("JS2WASM_INLINE_PROP_IC", ic);
  set("JS2WASM_INLINE_PROP_IC_DEBUG", "1");
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (s.startsWith("[inline-prop-ic]")) {
      lines.push(s);
      return true;
    }
    return (realWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const result = await compile(SOURCE, { fileName: "issue-4157-inline-ic.ts", target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const joined = lines.join("");
    const patched = /patched-sites=(\d+)/.exec(joined);
    const eligible = /eligible-dispatchers=(\d+)/.exec(joined);
    return {
      binary: result.binary,
      patchedSites: patched ? Number(patched[1]) : 0,
      eligible: eligible ? Number(eligible[1]) : 0,
    };
  } catch (e) {
    process.stderr.write = realWrite;
    throw e;
  } finally {
    process.stderr.write = realWrite;
    set("JS2WASM_INLINE_PROP_IC", saved.ic);
    set("JS2WASM_INLINE_PROP_IC_DEBUG", saved.dbg);
  }
}

async function answersOf(binary: Uint8Array): Promise<{ run: number; dyn: number }> {
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(binary), {});
  const exports = instance.exports as unknown as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return { run: (exports.run as () => number)(), dyn: (exports.runDyn as () => number)() };
}

describe("#4157 member-get call-site inline cache", () => {
  // Since the tuned-set flip the byte-identity guarantee hangs off `=0`, not
  // off absence: unset now selects ceiling 8. `off` is the spelling twin.
  it("is byte-identical to the legacy build when the flag is `0`", async () => {
    const zero = await build("0");
    const off = await build("off");
    expect(zero.patchedSites).toBe(0);
    expect(off.patchedSites).toBe(0);
    expect(Buffer.from(off.binary).equals(Buffer.from(zero.binary))).toBe(true);
  });

  it("unset is ceiling 8, and a malformed value falls back to it — never to OFF", async () => {
    const eight = await build("8");
    const unset = await build(undefined);
    const junk = await build("maybe");
    expect(unset.patchedSites, "unset must patch — the pass is default ON").toBeGreaterThan(0);
    expect(unset.patchedSites).toBe(eight.patchedSites);
    expect(unset.eligible).toBe(eight.eligible);
    expect(Buffer.from(junk.binary).equals(Buffer.from(unset.binary))).toBe(true);
  });

  it("engages, and the candidate ceiling bites", async () => {
    const off = await build("0");
    const mono = await build("1");
    const poly = await build("4");
    expect(mono.patchedSites).toBeGreaterThan(0);
    expect(poly.patchedSites).toBeGreaterThan(mono.patchedSites);
    expect(poly.eligible).toBeGreaterThan(mono.eligible);
    expect(mono.binary.length).toBeGreaterThan(off.binary.length);
    expect(poly.binary.length).toBeGreaterThan(mono.binary.length);
  });

  it("answers exactly what native Node answers, at every candidate ceiling", async () => {
    for (const ic of ["0", "1", "4", undefined]) {
      const built = await build(ic);
      const answers = await answersOf(built.binary);
      expect(answers.run, `JS2WASM_INLINE_PROP_IC=${ic ?? "unset"}`).toBe(NODE_ANSWER);
    }
  });

  it("answers exactly what the legacy build answers on the MISS cases", async () => {
    const base = await answersOf((await build("0")).binary);
    for (const ic of ["1", "4", undefined]) {
      const answers = await answersOf((await build(ic)).binary);
      expect(answers.dyn, `JS2WASM_INLINE_PROP_IC=${ic ?? "unset"}`).toBe(base.dyn);
      expect(answers.run, `JS2WASM_INLINE_PROP_IC=${ic ?? "unset"}`).toBe(base.run);
    }
  });
});
