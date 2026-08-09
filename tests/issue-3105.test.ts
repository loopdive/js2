// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { hashProbeAdvanceInstrs, hashProbeInitInstrs } from "../src/codegen-linear/emit-idioms.js";
import { counterLoopInstrs } from "../src/codegen/emit-idioms.js";

/**
 * #3105 slice 1 — emit-idiom builder library (linear backend).
 *
 * The ×10 hash-probe-advance scaffold (`idx = (idx + 1) % cap`, the tail of
 * every open-addressing probe loop in the string/numeric Map & Set runtimes)
 * was lifted out of `src/codegen-linear/runtime.ts` into
 * `hashProbeAdvanceInstrs`. Byte-identity across the corpus — including the new
 * `linear` target — is proved by `scripts/prove-emit-identity.mjs`; this is the
 * required #2093 runtime gate.
 *
 * Two guards:
 *  1. the builder emits the exact six-instruction sequence the 10 sites used to
 *     hand-roll (any drift here would break byte-identity), and
 *  2. a Map/Set program still compiles under the linear backend and executes
 *     the probe path deterministically (the linear target only exercises this
 *     code when such a program compiles — that keeps the proof non-vacuous).
 */
describe("#3105 emit-idioms (linear) — hash-probe advance", () => {
  it("hashProbeAdvanceInstrs returns the exact idx=(idx+1)%cap sequence", () => {
    expect(hashProbeAdvanceInstrs(5, 3)).toEqual([
      { op: "local.get", index: 5 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.get", index: 3 },
      { op: "i32.rem_u" },
      { op: "local.set", index: 5 },
    ]);
  });

  it("threads distinct idx/cap locals through unchanged (6 instrs, no extra ops)", () => {
    const seq = hashProbeAdvanceInstrs(9, 2);
    expect(seq).toHaveLength(6);
    expect(seq[0]).toEqual({ op: "local.get", index: 9 }); // read idx
    expect(seq[3]).toEqual({ op: "local.get", index: 2 }); // read cap
    expect(seq[5]).toEqual({ op: "local.set", index: 9 }); // store idx
  });

  it("Map/Set program compiles + runs under the linear backend, deterministically", async () => {
    const source = `
      export function run(): number {
        const sm = new Map<string, number>();
        sm.set("alpha", 1);
        sm.set("beta", 2);
        sm.set("gamma", 3);
        let total = 0;
        if (sm.has("alpha")) total += sm.get("alpha");
        if (sm.has("gamma")) total += sm.get("gamma");
        total += sm.size;
        const ss = new Set<string>();
        ss.add("x");
        ss.add("y");
        ss.add("x");
        if (ss.has("y")) total += 1;
        total += ss.size;
        const nm = new Map<number, number>();
        nm.set(10, 100);
        nm.set(20, 200);
        if (nm.has(20)) total += nm.get(20);
        total += nm.size;
        const ns = new Set<number>();
        ns.add(7);
        ns.add(8);
        ns.add(7);
        if (ns.has(8)) total += 1;
        total += ns.size;
        return total;
      }
    `;
    const r1 = await compile(source, { target: "linear" });
    expect(r1.success, r1.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r1.binary.length).toBeGreaterThan(0);

    const { instance: i1 } = await WebAssembly.instantiate(r1.binary, {});
    const ret = (i1.exports as { run(): number }).run();
    expect(typeof ret).toBe("number");
    expect(Number.isFinite(ret)).toBe(true);

    // A broken probe advance would trap or drift; recompiling + rerunning must
    // yield the identical result (the emit is deterministic and byte-stable).
    const r2 = await compile(source, { target: "linear" });
    const { instance: i2 } = await WebAssembly.instantiate(r2.binary, {});
    expect((i2.exports as { run(): number }).run()).toBe(ret);
  });
});

/**
 * #3105 slice 2 — hash-probe INIT (`idx = hash % cap`, the head of every
 * open-addressing probe loop). Lifted out of the same 10 sites in
 * `src/codegen-linear/runtime.ts` (string/numeric Map & Set) into
 * `hashProbeInitInstrs`. Byte-identity across the corpus (including the
 * `linear` target) is proved by `scripts/prove-emit-identity.mjs`; the Map/Set
 * program above exercises the init path at each loop head, keeping the proof
 * non-vacuous.
 */
describe("#3105 emit-idioms (linear) — hash-probe init", () => {
  it("hashProbeInitInstrs returns the exact idx=hash%cap sequence", () => {
    expect(hashProbeInitInstrs(4, 3, 5)).toEqual([
      { op: "local.get", index: 4 },
      { op: "local.get", index: 3 },
      { op: "i32.rem_u" },
      { op: "local.set", index: 5 },
    ]);
  });

  it("threads distinct hash/cap/idx locals through unchanged (4 instrs, no extra ops)", () => {
    const seq = hashProbeInitInstrs(9, 2, 7);
    expect(seq).toHaveLength(4);
    expect(seq[0]).toEqual({ op: "local.get", index: 9 }); // read hash
    expect(seq[1]).toEqual({ op: "local.get", index: 2 }); // read cap
    expect(seq[3]).toEqual({ op: "local.set", index: 7 }); // store idx
  });
});

/**
 * #3105 slice 3 — counter-loop (`for (; i < bound; i += step) { body }`, the
 * `block { loop { … } }` counted-forward scaffold). Lifted out of the 6 clean
 * copies in `src/codegen/json-runtime.ts` (the JSON string writer + the number
 * parser's digit/exponent scans) into `counterLoopInstrs`. Byte-identity across
 * the corpus (incl. the standalone/wasi `json.ts` records that emit the native
 * JSON runtime) is proved by `scripts/prove-emit-identity.mjs`; a JSON program
 * compiled + run under standalone keeps the proof non-vacuous here.
 */
describe("#3105 emit-idioms (WasmGC) — counter-loop", () => {
  it("counterLoopInstrs returns the exact block{loop{…}} counted-forward scaffold", () => {
    expect(
      counterLoopInstrs({
        i: 2,
        bound: [{ op: "local.get", index: 5 }],
        body: [{ op: "nop" }],
      }),
    ).toEqual([
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 2 },
              { op: "local.get", index: 5 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "nop" },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ]);
  });

  it("threads a custom step and preserves body branch depths unchanged", () => {
    const seq = counterLoopInstrs({
      i: 0,
      bound: [{ op: "local.get", index: 1 }],
      // an early-exit already inside the body must keep its depth (the builder
      // wraps it in the identical two-level nest)
      body: [{ op: "br_if", depth: 1 }],
      step: 4,
    });
    const loop = (seq[0] as { body: { body: unknown[] }[] }).body[0];
    expect(loop.body[4]).toEqual({ op: "br_if", depth: 1 }); // body br_if unchanged
    expect(loop.body[6]).toEqual({ op: "i32.const", value: 4 }); // custom step
  });

  it("JSON.stringify + JSON.parse compile + run under standalone (native json-runtime)", async () => {
    const source = `
      export function run(): number {
        let total = 0;
        total += JSON.stringify("a\\"b\\\\c").length; // emitJsonQuoteString loops
        total += JSON.parse("12345") as number;       // integer-digit loop
        total += JSON.parse("3.5") as number;          // fraction-digit loop
        total += JSON.parse("2e3") as number;          // exponent-digit loop
        return total;
      }
    `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ret = (instance.exports as { run(): number }).run();
    // 9 (quoted length) + 12345 + 3.5 + 2000 = 14357.5
    expect(ret).toBe(14357.5);
  });
});
