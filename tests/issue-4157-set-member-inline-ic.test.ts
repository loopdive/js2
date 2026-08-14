// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Call-site inline cache for dynamic property WRITES — the write-side
 * twin of `issue-4157-member-get-inline-ic.test.ts`, and the same three-part
 * argument:
 *
 * 1. ANSWERS. `run()` is compared against what native Node produces for the
 *    identical program. An ON-vs-OFF comparison alone would happily agree on a
 *    wrong answer.
 * 2. MECHANISM. Parity also passes if the pass silently never engages. The
 *    fixture reads the pass's own counters out of its debug channel and
 *    asserts sites were rewritten AND that the candidate cap bites (a 3-way
 *    polymorphic dispatcher is declined at cap 2 and speculated on at cap 8).
 * 3. POISON. `JS2WASM_SET_MEMBER_IC_POISON=1` replaces the hit arm with
 *    `unreachable`; the workload must TRAP. A fast path that cannot be made to
 *    fail visibly is indistinguishable from a fast path that never ran
 *    (#4157 entry 22). Poison with the flag UNSET must stay byte-identical —
 *    the companion must be inert without the mechanism.
 *
 * The write cases cover every arm family the extractor accepts and every miss
 * family behind the unmodified else-call:
 *   - HIT: monomorphic externref slot (`mv`), and an f64 slot whose arm tail
 *     is the `__unbox_number` coerce (`nv`) — the arm-tail relocation case;
 *   - SIDECAR MISS: the same name written onto a struct with NO such slot
 *     (`ref.test` fails → dispatcher → `__extern_set_strict`), read back;
 *   - HASH-BAG MISS: written onto a plain object literal (`$Object`);
 *   - NONSTRICT COMPOUND: `o.nv += k` routes through the
 *     `__set_member_nonstrict_<name>` dispatcher — a distinct plan entry;
 *   - 3-WAY POLYMORPHIC: `qv` carried by three distinct-arity fnctors, so only
 *     `candidates[0]` is speculated on and the other two must MISS to the
 *     dispatcher. Distinct field arities on purpose: structurally identical
 *     WasmGC structs canonicalize to one heap type, which would otherwise make
 *     `ref.test $A` match a `B` and measure that instead of this.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
// ES5 constructor functions (acorn's own idiom) — a TS class with typed
// fields pins the receiver and compiles this fixture's writes to direct
// struct.set, which never reserves a dispatcher at all. The fnctor pattern is
// what routes an any-receiver write through __set_member_<name>, and a
// prototype method's compound write-back through the NONSTRICT dispatcher.
function Mono(v) { this.mv = v; this.nv = 5; }
Mono.prototype.bumpNv = function () { this.nv += 3; };
function Bare(v) { this.other = v; this.ov = 6; this.b2 = "x"; this.b3 = "y"; }
function PolyA(v) { this.qv = v; this.pa = 1; this.a2 = "a"; }
function PolyB(v) { this.qv = v; this.pb = 2; this.b2x = "b"; this.b3x = "c"; }
function PolyC(v) { this.qv = v; this.pc = 3; this.c2 = "d"; this.c3 = "e"; this.c4 = "f"; }

function wMv(o, v) { o.mv = v; }
function wNv(o, v) { o.nv = v; }
function wQv(o, v) { o.qv = v; }
function rMv(o) { return o.mv; }
function rNv(o) { return o.nv; }
function rQv(o) { return o.qv; }

// Maps every observed value to a small integer, so the accumulator compares
// values rather than host-specific stringifications.
function code(v) {
  if (v === undefined) return 1;
  if (v === null) return 2;
  if (typeof v === "boolean") return v ? 3 : 4;
  if (typeof v === "function") return 6;
  if (typeof v === "string") return 10 + v.length * 3 + v.charCodeAt(0) % 17;
  if (typeof v === "number") return 100 + v;
  return 7;
}

function mix(acc, v) { return (acc * 1009 + code(v)) % 1000000007; }

export function run() {
  var acc = 0;
  var mono = new Mono("aa");
  var bare = new Bare("bb");
  var pa = new PolyA(31);
  var pb = new PolyB(32);
  var pc = new PolyC(33);
  var lit = { lv: 9, l3: 1, l4: 1, l5: 1, l6: 1, l7: 1, l8: 1 };

  // HIT + arm-tail (f64-unbox): monomorphic f64 slot — the value arrives
  // boxed and the copied arm's tail unboxes it into the slot. Updated in
  // place and read back twice: the guard must read the slot, not a cache.
  wNv(mono, 41);
  acc = mix(acc, rNv(mono));
  wNv(mono, 43);
  acc = mix(acc, rNv(mono));
  acc = mix(acc, rNv(mono) + 1);

  // NONSTRICT COMPOUND: the prototype method's read-modify-write routes
  // through __set_member_nonstrict_nv.
  mono.bumpNv();
  acc = mix(acc, rNv(mono));

  // String slot (mv): its dispatcher arm is runtime-brand-guarded, so the
  // extractor DECLINES it — the write must still answer identically.
  wMv(mono, "zz");
  acc = mix(acc, rMv(mono));

  // SIDECAR MISS: bare has no mv/nv slot — the guard must MISS and the write
  // must land where the dispatcher would have put it (the sidecar), where the
  // read-back finds it.
  wMv(bare, "qq");
  acc = mix(acc, rMv(bare));
  wNv(bare, 17);
  acc = mix(acc, rNv(bare));

  // HASH-BAG MISS: a plain object literal receiver ($Object).
  wMv(lit, "kk");
  acc = mix(acc, rMv(lit));
  wNv(lit, 19);
  acc = mix(acc, rNv(lit));

  // 3-WAY POLYMORPHIC numeric slot: only candidates[0] is speculated on; the
  // other two shapes must miss the inline guard and still hit their slots.
  wQv(pa, 51);
  wQv(pb, 52);
  wQv(pc, 53);
  acc = mix(acc, rQv(pa));
  acc = mix(acc, rQv(pb));
  acc = mix(acc, rQv(pc));
  wQv(pb, 54);
  acc = mix(acc, rQv(pb));

  return acc;
}
`;

/** The identical program in plain JS — the oracle for `run()`. */
const NODE_ANSWER: number = (() => {
  const js = SOURCE.replace(/^export /gm, "");
  return new Function(`${js}\nreturn run();`)() as number;
})();

interface Built {
  binary: Uint8Array;
  patchedSites: number;
  eligible: number;
}

const ENV_KEYS = [
  "JS2WASM_SET_MEMBER_IC",
  "JS2WASM_SET_MEMBER_IC_DEBUG",
  "JS2WASM_SET_MEMBER_IC_POISON",
  "JS2WASM_SET_MEMBER_F64",
] as const;

async function build(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): Promise<Built> {
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
  const set = (key: string, value: string | undefined): void => {
    // `= undefined` coerces to the STRING "undefined", which reads as "set".
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  for (const k of ENV_KEYS) set(k, env[k]);
  set("JS2WASM_SET_MEMBER_IC_DEBUG", env.JS2WASM_SET_MEMBER_IC_DEBUG ?? "1");
  const lines: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (s.startsWith("[set-member-ic]")) {
      lines.push(s);
      return true;
    }
    return (realWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const result = await compile(SOURCE, {
      fileName: "issue-4157-set-member-ic.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const joined = lines.join("");
    const patched = /patched-sites=(\d+)/.exec(joined);
    const eligible = /eligible-dispatchers=(\d+)/.exec(joined);
    return {
      binary: result.binary,
      patchedSites: patched ? Number(patched[1]) : 0,
      eligible: eligible ? Number(eligible[1]) : 0,
    };
  } finally {
    process.stderr.write = realWrite;
    for (const k of ENV_KEYS) set(k, saved.get(k));
  }
}

async function answerOf(binary: Uint8Array): Promise<number> {
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(binary), {});
  const exports = instance.exports as unknown as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return (exports.run as () => number)();
}

describe("#4157 member-set call-site inline cache", () => {
  it("is byte-identical to the base build for every off token, and poison alone is inert", async () => {
    const off = await build({});
    expect(off.patchedSites).toBe(0);
    for (const tok of ["0", "off", "false", "no", "", " OFF "]) {
      const b = await build({ JS2WASM_SET_MEMBER_IC: tok });
      expect(b.patchedSites, `token ${JSON.stringify(tok)}`).toBe(0);
      expect(Buffer.from(b.binary).equals(Buffer.from(off.binary)), `token ${JSON.stringify(tok)}`).toBe(true);
    }
    const poisonAlone = await build({ JS2WASM_SET_MEMBER_IC_POISON: "1" });
    expect(Buffer.from(poisonAlone.binary).equals(Buffer.from(off.binary))).toBe(true);
  });

  it("engages, and the candidate cap bites (cap 2 vs 8)", async () => {
    const off = await build({});
    const cap2 = await build({ JS2WASM_SET_MEMBER_IC: "2" });
    const cap8 = await build({ JS2WASM_SET_MEMBER_IC: "8" });
    expect(cap2.patchedSites).toBeGreaterThan(0);
    expect(cap8.patchedSites).toBeGreaterThan(cap2.patchedSites);
    expect(cap8.eligible).toBeGreaterThan(cap2.eligible);
    expect(cap2.binary.length).toBeGreaterThan(off.binary.length);
    expect(cap8.binary.length).toBeGreaterThan(cap2.binary.length);
  });

  it("answers exactly what native Node answers, at every candidate cap", async () => {
    for (const ic of [undefined, "2", "8", "1"]) {
      const built = await build(ic === undefined ? {} : { JS2WASM_SET_MEMBER_IC: ic });
      expect(await answerOf(built.binary), `JS2WASM_SET_MEMBER_IC=${ic ?? "unset"}`).toBe(NODE_ANSWER);
    }
  });

  it("answers exactly what native Node answers with the typed f64 write twins on", async () => {
    const built = await build({ JS2WASM_SET_MEMBER_IC: "8", JS2WASM_SET_MEMBER_F64: "1" });
    expect(built.patchedSites).toBeGreaterThan(0);
    expect(await answerOf(built.binary)).toBe(NODE_ANSWER);
  });

  it("poison traps the workload — proof the fast path actually executes", async () => {
    const poisoned = await build({ JS2WASM_SET_MEMBER_IC: "8", JS2WASM_SET_MEMBER_IC_POISON: "1" });
    expect(poisoned.patchedSites).toBeGreaterThan(0);
    await expect(answerOf(poisoned.binary)).rejects.toThrow(/unreachable/);
  });
});
