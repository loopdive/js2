// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Call-dispatch devirtualization (`JS2WASM_CALL_DISPATCH_IC`).
 *
 * The pass copies each filled `__call_m_<name>_<arity>` dispatcher's outermost
 * guard + hit arm to the call site, so three things must hold:
 *
 * 1. ANSWERS at a POLYMORPHIC dynamic `.test` site — a `$NativeRegExp`
 *    receiver HITS the inlined outermost brand guard (#3507) while an
 *    object-literal receiver with its own `test` method MISSES to the
 *    unmodified dispatcher (the closed-struct arm) — both against the
 *    flag-off baseline AND against native Node. NOTE: small typed programs
 *    never route through `__call_m_*`; the receiver must flow through an
 *    `any` boundary to force the dynamic dispatcher.
 * 2. BYTE-IDENTITY when the flag is unset (poison alone included) — the pass
 *    must be invisible by default.
 * 3. The MECHANISM must be live. Parity also passes if the pass never
 *    engages, so the fixture reads the pass's own debug counters AND poisons
 *    the inlined hit arm (`…_POISON=1` → `unreachable`), requiring a hitting
 *    receiver to trap. A guard that cannot be made to break was never
 *    executed (#4157 entry 22).
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
// The receiver crosses a non-inlinable \`any\` boundary, so \`r.test(s)\` is a
// real dynamic dispatch through __call_m_test_1 — not a statically-devirtualized
// direct call.
function probe(r: any, s: any): number {
  return r.test(s) ? 1 : 0;
}

export function run(): number {
  var re: any = /ab+c/;
  // An object literal WITH its own \`test\` method: fails the outermost
  // $NativeRegExp brand guard and must fall through to the unmodified
  // dispatcher's closed-struct arm.
  var fake: any = { test(s: any): any { return s === "abc"; } };
  var acc: number = 0;
  acc = acc * 2 + probe(re, "xabbcx"); // RegExp hit arm -> 1
  acc = acc * 2 + probe(re, "xyz"); // RegExp hit arm -> 0
  acc = acc * 2 + probe(fake, "abc"); // miss -> closed-struct arm -> 1
  acc = acc * 2 + probe(fake, "zzz"); // miss -> closed-struct arm -> 0
  acc = acc * 2 + probe(re, "abc"); // back to the hit arm -> 1
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
  armed: number;
  patchedSites: number;
}

const ENV_IC = "JS2WASM_CALL_DISPATCH_IC";
const ENV_POISON = "JS2WASM_CALL_DISPATCH_IC_POISON";
const ENV_DEBUG = "JS2WASM_CALL_DISPATCH_IC_DEBUG";

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
  setEnv(ENV_DEBUG, "1"); // stats are emitted only under the debug companion
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (s.startsWith("[call-dispatch-ic]")) {
      lines.push(s);
      return true;
    }
    return (realWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const result = await compile(SOURCE, { fileName: "issue-4157-call-dispatch-ic.ts", target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const joined = lines.join("");
    const armed = /armed-dispatchers=(\d+)/.exec(joined);
    const patched = /patched-sites=(\d+)/.exec(joined);
    return {
      binary: result.binary,
      armed: armed ? Number(armed[1]) : 0,
      patchedSites: patched ? Number(patched[1]) : 0,
    };
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

describe("#4157 call-dispatch devirtualization (__call_m_* site inline)", () => {
  it("is byte-identical to the base build when the flag is unset", async () => {
    const off = await build(undefined);
    const zero = await build("0");
    const offAlias = await build("off");
    expect(off.patchedSites).toBe(0);
    expect(zero.patchedSites).toBe(0);
    expect(Buffer.from(zero.binary).equals(Buffer.from(off.binary))).toBe(true);
    expect(Buffer.from(offAlias.binary).equals(Buffer.from(off.binary))).toBe(true);
    // POISON alone must be inert: it only ever touches an arm this pass emits.
    const poisonedOff = await build(undefined, true);
    expect(Buffer.from(poisonedOff.binary).equals(Buffer.from(off.binary))).toBe(true);
  });

  it("hit (RegExp) and miss (object-literal) receivers both answer the flag-off baseline", async () => {
    const off = await build(undefined);
    const on = await build("1");
    expect(on.armed).toBeGreaterThan(0);
    expect(on.patchedSites).toBeGreaterThan(0);
    // NOT asserted: that the ON binary is LARGER. Copying an arm to each site
    // usually grows the module, but that is incidental, not the property under
    // test — and it is FALSE under the tuned-11 defaults, where devirtualizing
    // lets the tuned passes drop enough dispatcher machinery to come out net
    // smaller (measured on the flip branch: 121,730 ON vs 121,945 OFF). The
    // real invariants are below: same answer as the flag-off baseline, plus
    // the poison test proving the copied arm actually executes.
    expect(on.binary.length).not.toBe(off.binary.length);
    const baseline = await answerOf(off.binary);
    expect(baseline).toBe(NODE_ANSWER);
    expect(await answerOf(on.binary)).toBe(baseline);
  });

  it("poisoning the inlined hit arm changes the answer or traps — the arm is really executed", async () => {
    const poisoned = await build("1", true);
    expect(poisoned.patchedSites).toBeGreaterThan(0);
    let answer: number | undefined;
    let trapped = false;
    try {
      answer = await answerOf(poisoned.binary);
    } catch {
      trapped = true; // the poisoned arm is `unreachable` — a hitting receiver traps
    }
    expect(trapped || answer !== NODE_ANSWER).toBe(true);
  });
});
