// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Call-site fast paths for `__str_flatten` / `__str_equals`
 * (`src/codegen/flat-str-ic.ts`, flag `JS2WASM_FLAT_STR_IC`).
 *
 * Same three-legged protocol as the sibling IC fixtures
 * (`issue-4157-is-truthy-inline-ic.test.ts`):
 *
 * 1. ANSWERS against **native Node**, not against the OFF build — an ON-vs-OFF
 *    comparison agrees happily on a wrong answer. The corpus covers flat
 *    strings, genuine ConsString ropes (built by runtime concatenation),
 *    equal and unequal same-length pairs, length rejects, and reads
 *    (`indexOf`, `charCodeAt`) whose self-flattening helpers sit behind
 *    caller-side flatten sites.
 * 2. BYTE-IDENTITY for every off-token, and poison-alone inert.
 * 3. The MECHANISM must be live: the pass's own site counters must be > 0, and
 *    under `…_POISON=1` every fast arm is `unreachable`, so a workload that
 *    still completes never executed them — the poisoned build must TRAP.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
function eq(a: any, b: any): number { return a === b ? 1 : 0; }
function firstIndex(s: any, needle: any): number { return s.indexOf(needle); }
function codeAt(s: any, i: number): number { return s.charCodeAt(i); }

// Genuine rope: runtime concatenation of any-typed parts, opaque to folding.
function makeRope(seed: any, n: number): any {
  var s: any = seed;
  for (var i = 0; i < n; i++) { s = s + "ab"; }
  return s;
}

function mix(acc: number, v: number): number { return (acc * 131 + v) % 1000000007; }

export function run(): number {
  var acc: number = 0;
  var flat: any = "xababab";      // interned flat literal
  var flatTwin: any = "xababab";  // same contents (interned: likely same ref)
  var rope: any = makeRope("x", 3);      // "xababab" as a cons chain
  var rope2: any = makeRope("x", 3);     // equal contents, distinct rope
  var shorter: any = makeRope("x", 2);   // "xabab" — length reject vs rope
  // --- identity (same reference) ---
  acc = mix(acc, eq(flat, flat));
  acc = mix(acc, eq(rope, rope));
  // --- equal contents: flat/flat, flat/rope, rope/rope ---
  acc = mix(acc, eq(flat, flatTwin));
  acc = mix(acc, eq(flat, rope));
  acc = mix(acc, eq(rope, rope2));
  // --- same length, unequal ---
  acc = mix(acc, eq("abcd", "abce"));
  acc = mix(acc, eq(flat, "xababac"));
  // --- length rejects ---
  acc = mix(acc, eq("a", "ab"));
  acc = mix(acc, eq(rope, shorter));
  acc = mix(acc, eq("", "a"));
  // --- reads through self-flattening helpers, on flat AND rope operands ---
  acc = mix(acc, firstIndex(flat, "bab"));
  acc = mix(acc, firstIndex(rope, "bab"));
  acc = mix(acc, firstIndex(rope, "zz"));
  acc = mix(acc, codeAt(flat, 0));
  acc = mix(acc, codeAt(rope, 4));
  // --- compare again AFTER the reads (rope is now memoized in place) ---
  acc = mix(acc, eq(rope, flat));
  acc = mix(acc, eq(rope, "nope"));
  return acc;
}
`;

/** The identical program in plain JS — the oracle. */
const NODE_ANSWER: number = (() => {
  const js = SOURCE.replace(/:\s*(number|any|string)\b/g, "").replace(/^export /gm, "");
  return new Function(`${js}\nreturn run();`)() as number;
})();

interface Built {
  binary: Uint8Array;
  flattenSites: number;
  equalsSites: number;
}

const ENV_IC = "JS2WASM_FLAT_STR_IC";
const ENV_POISON = "JS2WASM_FLAT_STR_IC_POISON";

function setEnv(key: string, value: string | undefined): void {
  // `= undefined` coerces to the STRING "undefined", which reads as "set".
  // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function build(ic: string | undefined, poison?: boolean): Promise<Built> {
  const saved = { ic: process.env[ENV_IC], poison: process.env[ENV_POISON] };
  const lines: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  setEnv(ENV_IC, ic);
  setEnv(ENV_POISON, poison === true ? "1" : undefined);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (s.startsWith("[flat-str-ic]")) {
      lines.push(s);
      return true;
    }
    return (realWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const result = await compile(SOURCE, { fileName: "issue-4157-flat-str-ic.ts", target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const joined = lines.join("");
    const flatten = /flatten-sites=(\d+)/.exec(joined);
    const equals = /equals-sites=(\d+)/.exec(joined);
    return {
      binary: result.binary,
      flattenSites: flatten ? Number(flatten[1]) : 0,
      equalsSites: equals ? Number(equals[1]) : 0,
    };
  } finally {
    process.stderr.write = realWrite;
    setEnv(ENV_IC, saved.ic);
    setEnv(ENV_POISON, saved.poison);
  }
}

async function answerOf(binary: Uint8Array): Promise<number> {
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(binary), {});
  const exports = instance.exports as unknown as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return (exports.run as () => number)();
}

describe("#4157 __str_flatten/__str_equals call-site fast paths", () => {
  it("is byte-identical to the base build for every off-token, and poison-alone is inert", async () => {
    const off = await build(undefined);
    expect(off.flattenSites).toBe(0);
    expect(off.equalsSites).toBe(0);
    for (const token of ["", "0", "off", "false", "no"]) {
      const built = await build(token);
      expect(built.flattenSites + built.equalsSites, `${ENV_IC}=${JSON.stringify(token)}`).toBe(0);
      expect(Buffer.from(built.binary).equals(Buffer.from(off.binary)), `${ENV_IC}=${JSON.stringify(token)}`).toBe(
        true,
      );
    }
    // POISON alone must be inert: it only ever touches arms this pass emits.
    const poisonedOff = await build(undefined, true);
    expect(Buffer.from(poisonedOff.binary).equals(Buffer.from(off.binary))).toBe(true);
  });

  it("engages on both families and answers exactly what native Node answers", async () => {
    const on = await build("1");
    expect(on.flattenSites).toBeGreaterThan(0);
    expect(on.equalsSites).toBeGreaterThan(0);
    expect(await answerOf(on.binary)).toBe(NODE_ANSWER);
    // The OFF build agrees too (sanity that the corpus itself is stable).
    const off = await build(undefined);
    expect(await answerOf(off.binary)).toBe(NODE_ANSWER);
  });

  it("poisoned fast arms TRAP — the guards are really executed", async () => {
    const poisoned = await build("1", true);
    expect(poisoned.flattenSites).toBeGreaterThan(0);
    expect(poisoned.equalsSites).toBeGreaterThan(0);
    await expect(answerOf(poisoned.binary)).rejects.toThrow(/unreachable/);
  });
});
