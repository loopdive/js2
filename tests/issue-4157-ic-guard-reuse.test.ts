// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157 defect C) Cross-IC guard reuse.
 *
 * The reuse skips a `ref.test` (and the hit arm's `ref.cast`) at a later inline
 * cache because an earlier one already decided the same question about the same
 * value. Three things have to hold, and the third is where a plausible
 * implementation goes wrong SILENTLY:
 *
 * 1. ANSWERS. Compared against native Node for the identical program, not just
 *    ON-vs-OFF — an ON/OFF comparison agrees happily on a wrong answer.
 * 2. MECHANISM. Parity also passes when the pass never engages, so the fixture
 *    reads the pass's own reuse counter and asserts it fired.
 * 3. RE-ENTRY. `loopHoist` and `tryReassign` put the leader OUTSIDE a `loop` /
 *    `try` and the follower INSIDE it, then reassign the receiver to a
 *    different class in between. "Everything earlier in the enclosing array
 *    dominates" is TRUE for both and still not enough: a back edge re-enters the
 *    loop body after the reassignment, and a catch body is entered from after
 *    it. Without the subtree clobber both read the stale guard and answer with
 *    the WRONG class's slot — and, because the classes here have different field
 *    arities, that is an observable wrong answer rather than a trap.
 *
 * `mono.nv = 41` between two reads is the fourth case: the cached thing is the
 * CAST, not the value, so an in-place slot update must stay visible.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
class Mono { mv: string; nv: number; m3: string; constructor(v: string) { this.mv = v; this.nv = 5; this.m3 = "z"; } }
class Alt { mv: string; nv: number; a3: string; a4: string; constructor(v: string) { this.mv = v; this.nv = 9; this.a3 = "p"; this.a4 = "q"; } }

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
  var alt: any = new Alt("bb");

  // Straight line, one receiver: a leader and two followers.
  acc = mix(acc, mono.mv);
  acc = mix(acc, mono.nv);
  acc = mix(acc, mono.m3);

  // A reassignment between the reads must break the chain.
  var r: any = mono;
  acc = mix(acc, r.mv);
  r = alt;
  acc = mix(acc, r.mv);
  acc = mix(acc, r.nv);

  // A nested arm inherits the guard from the array that dominates it.
  acc = mix(acc, mono.nv);
  if (acc > 0) { acc = mix(acc, mono.mv); acc = mix(acc, mono.m3); }

  // The CAST is cached, not the value: an in-place slot update stays visible.
  acc = mix(acc, mono.nv);
  mono.nv = 41;
  acc = mix(acc, mono.nv);
  return acc;
}

/** Leader before the loop, follower inside it, receiver swapped mid-body. */
export function loopHoist(n: number): number {
  var acc = 0;
  var mono: any = new Mono("aa");
  var alt: any = new Alt("bb");
  var r: any = mono;
  acc = mix(acc, r.mv);
  for (var i = 0; i < n; i++) {
    acc = mix(acc, r.nv);
    acc = mix(acc, r.mv);
    r = alt;
  }
  return acc;
}

/** Leader before the try, follower in the catch, receiver swapped in between. */
export function tryReassign(): number {
  var acc = 0;
  var mono: any = new Mono("aa");
  var alt: any = new Alt("bb");
  var r: any = mono;
  acc = mix(acc, r.mv);
  try {
    r = alt;
    throw "boom";
  } catch (e) {
    acc = mix(acc, r.nv);
    acc = mix(acc, r.mv);
  }
  return acc;
}
`;

interface Answers {
  run: number;
  loop: number;
  tried: number;
}

/** The identical program in plain JS — the oracle. */
const NODE_ANSWERS: Answers = (() => {
  const js = SOURCE.replace(/:\s*(number|any|string)\b/g, "")
    .replace(/ as (number|string)/g, "")
    .replace(/^export /gm, "");
  return new Function(`${js}\nreturn { run: run(), loop: loopHoist(3), tried: tryReassign() };`)() as Answers;
})();

interface Built {
  binary: Uint8Array;
  reuses: number;
  leaders: number;
}

async function build(reuse: string | undefined): Promise<Built> {
  const saved = { ic: process.env.JS2WASM_INLINE_PROP_IC, reuse: process.env.JS2WASM_IC_GUARD_REUSE };
  const set = (key: string, value: string | undefined): void => {
    // `= undefined` coerces to the STRING "undefined", which reads as "set".
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  const lines: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  set("JS2WASM_INLINE_PROP_IC", "4");
  set("JS2WASM_IC_GUARD_REUSE", reuse);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (s.startsWith("[ic-guard-reuse]")) {
      lines.push(s);
      return true;
    }
    return (realWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const result = await compile(SOURCE, { fileName: "issue-4157-ic-guard-reuse.ts", target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const joined = lines.join("");
    const reuses = /reuses=(\d+)/.exec(joined);
    const leaders = /leaders=(\d+)/.exec(joined);
    return {
      binary: result.binary,
      reuses: reuses ? Number(reuses[1]) : 0,
      leaders: leaders ? Number(leaders[1]) : 0,
    };
  } finally {
    process.stderr.write = realWrite;
    set("JS2WASM_INLINE_PROP_IC", saved.ic);
    set("JS2WASM_IC_GUARD_REUSE", saved.reuse);
  }
}

async function answersOf(binary: Uint8Array): Promise<Answers> {
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(binary), {});
  const exports = instance.exports as unknown as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return {
    run: (exports.run as () => number)(),
    loop: (exports.loopHoist as (n: number) => number)(3),
    tried: (exports.tryReassign as () => number)(),
  };
}

describe("#4157 cross-IC guard reuse", () => {
  it("is byte-identical to the inline-cache build when the flag is unset", async () => {
    const off = await build(undefined);
    const zero = await build("0");
    expect(off.reuses).toBe(0);
    expect(zero.reuses).toBe(0);
    expect(Buffer.from(zero.binary).equals(Buffer.from(off.binary))).toBe(true);
  });

  it("engages, and shrinks the binary it engages on", async () => {
    const off = await build(undefined);
    const on = await build("1");
    expect(on.reuses).toBeGreaterThan(0);
    expect(on.leaders).toBeGreaterThan(0);
    expect(on.binary.length).toBeLessThan(off.binary.length);
  });

  it("answers exactly what native Node answers, flag on and off", async () => {
    for (const reuse of [undefined, "1"]) {
      const answers = await answersOf((await build(reuse)).binary);
      expect(answers, `JS2WASM_IC_GUARD_REUSE=${reuse ?? "unset"}`).toEqual(NODE_ANSWERS);
    }
  });
});
