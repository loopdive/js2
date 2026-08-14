// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Call-site inline fast path for `__is_truthy`.
 *
 * Truthiness is load-bearing for control flow everywhere, so an inline arm that
 * is one case wrong does not run slower — it takes the wrong branch. Three
 * things therefore have to hold:
 *
 * 1. ANSWERS, against **native Node**, not against the OFF build. An
 *    ON-vs-OFF comparison agrees happily on a wrong answer; that is how
 *    #4217's `generator` defect stayed invisible. Every falsy value JS has
 *    (`undefined`, `null`, `false`, `0`, `-0`, `NaN`, `""`, `0n`) is exercised
 *    next to a near-miss truthy twin (`"0"`, `"false"`, `[]`, `{}`, `-1`, `1n`,
 *    `Infinity`), in six syntactic contexts, and every arm subset is checked
 *    independently — a subset is a DIFFERENT emitted guard chain, not a
 *    configuration of one.
 *
 * 2. BYTE-IDENTITY at `JS2WASM_INLINE_TRUTHY_IC=0`. The pass is **default ON**
 *    (the two-arm profile) since the #4157 tuned-set flip, so the identity
 *    guarantee hangs off an explicit off-token rather than off absence — and a
 *    value naming no known arm takes the default rather than disabling.
 *
 * 3. The MECHANISM must be live. Parity also passes if the pass never engages —
 *    twice in one session (#4157 entry 22) a confident null was reported from a
 *    mechanism that was never enabled. So the fixture reads the pass's own
 *    site counter, AND poisons the fast arms (`…_POISON=1`, which appends
 *    `i32.eqz`) and requires the answer to CHANGE. A guard that cannot be made
 *    to break is a guard that was never executed.
 *
 * Values are held in `any` locals and passed through non-inlinable boundaries
 * so the truthiness test is a real dynamic `__is_truthy` call rather than a
 * statically-folded branch.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
// Six syntactic ToBoolean contexts, each contributing one bit. Kept in separate
// functions so no single one can be folded away with its operand.
function ctxIf(v: any): number { if (v) { return 1; } return 0; }
function ctxNot(v: any): number { return !v ? 0 : 1; }
function ctxTernary(v: any): number { return v ? 1 : 0; }
function ctxAnd(v: any): number { var r: any = v && 7; return r === 7 ? 1 : 0; }
function ctxOr(v: any): number { var r: any = v || 7; return r === 7 ? 0 : 1; }
function ctxWhile(v: any): number { var n: number = 0; while (v) { n = 1; break; } return n; }

function bits(v: any): number {
  return ctxIf(v) + 2 * ctxNot(v) + 4 * ctxTernary(v) + 8 * ctxAnd(v) + 16 * ctxOr(v) + 32 * ctxWhile(v);
}

function mix(acc: number, v: any): number { return (acc * 131 + bits(v)) % 1000000007; }

export function run(): number {
  var acc: number = 0;
  // --- falsy, every one of them ---
  var undef: any = undefined;
  acc = mix(acc, undef);
  acc = mix(acc, null);
  acc = mix(acc, false);
  acc = mix(acc, 0);
  acc = mix(acc, -0);
  acc = mix(acc, 0 / 0);
  acc = mix(acc, "");
  // --- near-miss truthy twins ---
  acc = mix(acc, true);
  acc = mix(acc, "0");
  acc = mix(acc, "false");
  acc = mix(acc, " ");
  acc = mix(acc, 1);
  acc = mix(acc, -1);
  acc = mix(acc, 0.5);
  acc = mix(acc, 1 / 0);
  acc = mix(acc, -1 / 0);
  // --- outside the i31 range, so these are heap-boxed numbers ---
  acc = mix(acc, 1073741824);
  acc = mix(acc, -1073741825);
  acc = mix(acc, 1e21);
  // --- references: an empty array and an empty object are TRUTHY ---
  var arr: any = [];
  acc = mix(acc, arr);
  var obj: any = {};
  acc = mix(acc, obj);
  var fn: any = ctxIf;
  acc = mix(acc, fn);
  // --- booleans that arrive from a computation, i.e. really boxed ---
  var b1: any = 1 < 2;
  acc = mix(acc, b1);
  var b2: any = 1 > 2;
  acc = mix(acc, b2);
  var b3: any = "a" === "b";
  acc = mix(acc, b3);
  // --- a falsy value read back out of a container, not a literal ---
  var holder: any = { f: 0, g: "", h: false, i: 1 };
  acc = mix(acc, holder.f);
  acc = mix(acc, holder.g);
  acc = mix(acc, holder.h);
  acc = mix(acc, holder.i);
  acc = mix(acc, holder.missing);
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
  patchedSites: number;
  arms: string;
}

const ENV_IC = "JS2WASM_INLINE_TRUTHY_IC";
const ENV_POISON = "JS2WASM_INLINE_TRUTHY_IC_POISON";
/**
 * The pass's summary line is printed only for an operator who named the flag or
 * the debug channel — on a DEFAULT build it would otherwise appear on every
 * compile. This fixture reads `patched-sites` out of that line, so it must ask
 * for the channel; without it `build(undefined)` would report zero patches for
 * a pass that ran, and every mechanism assertion would go vacuous.
 */
const ENV_DEBUG = "JS2WASM_INLINE_TRUTHY_IC_DEBUG";

function setEnv(key: string, value: string | undefined): void {
  // `= undefined` coerces to the STRING "undefined", which reads as "set".
  // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function build(ic: string | undefined, poison?: boolean): Promise<Built> {
  const saved = { ic: process.env[ENV_IC], poison: process.env[ENV_POISON], debug: process.env[ENV_DEBUG] };
  const lines: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  setEnv(ENV_IC, ic);
  setEnv(ENV_POISON, poison === true ? "1" : undefined);
  setEnv(ENV_DEBUG, "1");
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (s.startsWith("[truthy-ic]")) {
      lines.push(s);
      return true;
    }
    return (realWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const result = await compile(SOURCE, { fileName: "issue-4157-truthy-ic.ts", target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const joined = lines.join("");
    const patched = /patched-sites=(\d+)/.exec(joined);
    const arms = /arms=([\w,]+)/.exec(joined);
    return { binary: result.binary, patchedSites: patched ? Number(patched[1]) : 0, arms: arms ? arms[1]! : "" };
  } finally {
    process.stderr.write = realWrite;
    setEnv(ENV_IC, saved.ic);
    setEnv(ENV_POISON, saved.poison);
    setEnv(ENV_DEBUG, saved.debug);
  }
}

async function answerOf(binary: Uint8Array): Promise<number> {
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(binary), {});
  const exports = instance.exports as unknown as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return (exports.run as () => number)();
}

describe("#4157 __is_truthy call-site inline fast path", () => {
  it("is byte-identical to the legacy build when the flag is `0`", async () => {
    const zero = await build("0");
    const off = await build("off");
    expect(zero.patchedSites).toBe(0);
    expect(off.patchedSites).toBe(0);
    expect(Buffer.from(off.binary).equals(Buffer.from(zero.binary))).toBe(true);
    // POISON alone must be inert: it only ever touches an arm this pass emits.
    const poisonedOff = await build("0", true);
    expect(Buffer.from(poisonedOff.binary).equals(Buffer.from(zero.binary))).toBe(true);
  });

  it("unset is the two-arm profile, and an unrecognised arm name falls back to it", async () => {
    const unset = await build(undefined);
    const one = await build("1");
    const junk = await build("nosucharm");
    expect(unset.arms, "unset must select the measured default, not `all`").toBe("anyval,boxbool");
    expect(unset.patchedSites).toBeGreaterThan(0);
    expect(Buffer.from(one.binary).equals(Buffer.from(unset.binary))).toBe(true);
    expect(Buffer.from(junk.binary).equals(Buffer.from(unset.binary))).toBe(true);
  });

  it("engages, and a wider arm set patches a bigger binary", async () => {
    const off = await build("0");
    const dflt = await build("1");
    const all = await build("all");
    expect(dflt.patchedSites).toBeGreaterThan(0);
    expect(dflt.arms).toBe("anyval,boxbool");
    expect(all.patchedSites).toBe(dflt.patchedSites);
    expect(dflt.binary.length).toBeGreaterThan(off.binary.length);
    expect(all.binary.length).toBeGreaterThan(dflt.binary.length);
  });

  it("answers exactly what native Node answers, for every arm subset", async () => {
    const subsets = [
      undefined,
      "0",
      "1",
      "all",
      "anyval",
      "i31",
      "boxnum",
      "boxbool",
      "bigint",
      "str",
      "anyval,boxbool,str",
    ];
    for (const ic of subsets) {
      const built = await build(ic);
      expect(await answerOf(built.binary), `${ENV_IC}=${ic ?? "unset"}`).toBe(NODE_ANSWER);
    }
  });

  it("poisoning the fast arms CHANGES the answer — the guard is really executed", async () => {
    const poisoned = await build("all", true);
    expect(poisoned.patchedSites).toBeGreaterThan(0);
    expect(await answerOf(poisoned.binary)).not.toBe(NODE_ANSWER);
  });
});
