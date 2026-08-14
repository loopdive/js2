// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Unboxed boolean fusion (`src/codegen/box-boolean-fuse.ts`).
 *
 * Three claims, each with its own failure mode:
 *
 * 1. BYTE-IDENTITY when the flag is unset or set to any off token — the pass
 *    must be invisible by default, and POISON alone must be inert (it only
 *    ever touches a site this pass fused).
 *
 * 2. The MECHANISM must be live. Parity also passes if the pass never engages
 *    (#4157 entry 22 — a confident null was reported twice from a mechanism
 *    that was never enabled). So the fixture reads the pass's own debug
 *    counters AND poisons the fused answer (`…_POISON=1` puts `i32.eqz` where
 *    the deleted `__is_truthy` consumer stood) and requires the unit answers
 *    to INVERT: fusedAnd(1,1,1)/(1,1,0)/(0,1,1) flip 1/0/0 → 0/1/1.
 *
 * 3. ANSWERS: flag-on agrees with flag-off — and both with native Node — over
 *    a 9-value input matrix crossed with itself, on FUSED shapes (the sink
 *    `if (a && (b && (c > 0)))` with box-call + cond-reuse leaves, nested
 *    merge included) and on DECLINED shapes (`a && b` whose arm tail is a
 *    plain local re-read, and a truthy call whose operand arrives through a
 *    local — the cross-function residual class the pass must leave alone).
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
// FUSED shapes: an externref logical merge consumed immediately by ToBoolean.
// fusedAnd nests the merge (a && (b && (c > 0))) so one site carries a
// box-call leaf AND two cond-reuse leaves through a nested if tree.
function fusedAnd(a: any, b: any, c: number): number { if (a && (b && (c > 0))) { return 1; } return 0; }
function fusedOr(a: any, n: number): number { return (a || n > 0) ? 1 : 0; }
// DECLINED shapes: the pass must refuse these untouched.
function declinedAnd(a: any, b: any): number { if (a && b) { return 1; } return 0; }
function declinedLocal(v: any): number { var t: any = v; if (t) { return 1; } return 0; }

// Unit probes for the poison inversion — values built in-module so the 'any'
// params hold real boxed representations, not host values.
export function pAnd111(): number { var a: any = "x"; var b: any = 1; return fusedAnd(a, b, 1); }
export function pAnd110(): number { var a: any = "x"; var b: any = 1; return fusedAnd(a, b, 0); }
export function pAnd011(): number { var a: any = 0; var b: any = 1; return fusedAnd(a, b, 1); }

export function run(): number {
  var acc: number = 0;
  var vals: any[] = [0, 1, -1, "", "a", true, false, 1.5, 0 / 0];
  for (var i = 0; i < vals.length; i++) {
    var v: any = vals[i];
    for (var j = 0; j < vals.length; j++) {
      var w: any = vals[j];
      acc = (acc * 131 + fusedAnd(v, w, i - 4) + 2 * fusedOr(v, j - 4) + 4 * declinedAnd(v, w) + 8 * declinedLocal(v)) % 1000000007;
    }
  }
  return acc;
}
`;

/** The identical program in plain JS — the oracle. */
const NODE_ANSWER: number = (() => {
  const js = SOURCE.replace(/:\s*(number|any|string)(\[\])?/g, "").replace(/^export /gm, "");
  return new Function(`${js}\nreturn run();`)() as number;
})();

interface Built {
  binary: Uint8Array;
  fusedSink: number;
}

const ENV_FUSE = "JS2WASM_UNBOXED_BOOL_FUSE";
const ENV_POISON = "JS2WASM_UNBOXED_BOOL_FUSE_POISON";
const ENV_DEBUG = "JS2WASM_UNBOXED_BOOL_FUSE_DEBUG";

function setEnv(key: string, value: string | undefined): void {
  // `= undefined` coerces to the STRING "undefined", which reads as "set".
  // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function build(fuse: string | undefined, poison?: boolean): Promise<Built> {
  const saved = { fuse: process.env[ENV_FUSE], poison: process.env[ENV_POISON], debug: process.env[ENV_DEBUG] };
  const lines: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  setEnv(ENV_FUSE, fuse);
  setEnv(ENV_POISON, poison === true ? "1" : undefined);
  setEnv(ENV_DEBUG, "1");
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (s.startsWith("[box-bool-fuse]")) {
      lines.push(s);
      return true;
    }
    return (realWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const result = await compile(SOURCE, { fileName: "issue-4157-box-boolean-fuse.ts", target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const fused = /fused-sink=(\d+)/.exec(lines.join(""));
    return { binary: result.binary, fusedSink: fused ? Number(fused[1]) : 0 };
  } finally {
    process.stderr.write = realWrite;
    setEnv(ENV_FUSE, saved.fuse);
    setEnv(ENV_POISON, saved.poison);
    setEnv(ENV_DEBUG, saved.debug);
  }
}

interface Answers {
  run: number;
  p111: number;
  p110: number;
  p011: number;
}

async function answersOf(binary: Uint8Array): Promise<Answers> {
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(binary), {});
  const exports = instance.exports as unknown as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return {
    run: (exports.run as () => number)(),
    p111: (exports.pAnd111 as () => number)(),
    p110: (exports.pAnd110 as () => number)(),
    p011: (exports.pAnd011 as () => number)(),
  };
}

describe("#4157 unboxed boolean fusion", () => {
  it("is byte-identical to the base build for every off-token spelling; ON differs", async () => {
    const off = await build(undefined);
    expect(off.fusedSink).toBe(0);
    for (const token of ["0", "off", "false", "no", "", " OFF ", " No "]) {
      const built = await build(token);
      expect(built.fusedSink, `${ENV_FUSE}=${JSON.stringify(token)}`).toBe(0);
      expect(
        Buffer.from(built.binary).equals(Buffer.from(off.binary)),
        `${ENV_FUSE}=${JSON.stringify(token)} must be byte-identical`,
      ).toBe(true);
    }
    // POISON alone must be inert: it only ever touches a site this pass fused.
    const poisonedOff = await build(undefined, true);
    expect(Buffer.from(poisonedOff.binary).equals(Buffer.from(off.binary))).toBe(true);
    // ON engages and produces a different binary.
    const on = await build("1");
    expect(on.fusedSink).toBeGreaterThan(0);
    expect(Buffer.from(on.binary).equals(Buffer.from(off.binary))).toBe(false);
  });

  it("poison INVERTS the fused answers — the mechanism is really live", async () => {
    const on = await build("1");
    const poisoned = await build("1", true);
    expect(poisoned.fusedSink).toBe(on.fusedSink);
    expect(poisoned.fusedSink).toBeGreaterThan(0);
    const clean = await answersOf(on.binary);
    const flipped = await answersOf(poisoned.binary);
    // fusedAnd(1,1,1)/(1,1,0)/(0,1,1): 1/0/0 invert to 0/1/1.
    expect(clean.p111).toBe(1);
    expect(clean.p110).toBe(0);
    expect(clean.p011).toBe(0);
    expect(flipped.p111).toBe(0);
    expect(flipped.p110).toBe(1);
    expect(flipped.p011).toBe(1);
    expect(flipped.run).not.toBe(clean.run);
  });

  it("flag-on agrees with flag-off — and with native Node — on fused AND declined shapes", async () => {
    const off = await build(undefined);
    const on = await build("1");
    expect(on.fusedSink).toBeGreaterThan(0);
    const offAnswers = await answersOf(off.binary);
    const onAnswers = await answersOf(on.binary);
    expect(onAnswers).toEqual(offAnswers);
    expect(offAnswers.run).toBe(NODE_ANSWER);
    expect(onAnswers.run).toBe(NODE_ANSWER);
  });
});
