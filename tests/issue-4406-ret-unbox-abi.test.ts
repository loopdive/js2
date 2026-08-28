// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4406 Phase 0+1 — the return-type unboxing ABI for BOOLEAN-returning methods.
 *
 * ## What was wrong
 *
 * `Prover.isNumeric` deliberately answers TRUE for booleans, and the
 * `numericFunctions` loop in `numeric-property-analysis.ts` — unlike the
 * property and grounded-slot loops beside it — carries no `isBooleanish`
 * filter. So a prototype predicate whose every return is a boolean lands in
 * `numericFunctionNames`, and `refinedTwinReturnType` mints its twin with an
 * **f64** result.
 *
 * On a condition (`if (this.eat(tt.comma))`) an f64 0/1 and a boolean 0/1
 * agree, which is why the acorn dogfood checksum never noticed. A corpus that
 * STRINGIFIES, `typeof`s, `JSON.stringify`s or `===`-compares the result does
 * notice: `"" + p.pred()` reads `"1"` where JS says `"true"`.
 *
 * ## What this file pins
 *
 * #2847's boolean fixpoint already computes the right verdict — it was just
 * discarded. Phase 0 publishes it as `ctx.booleanFunctionNames`; Phase 1 makes
 * `refinedTwinReturnType` consult it BEFORE the numeric set (boolean ⊂ numeric,
 * so a numeric-first test claims every predicate as f64 and the boolean arm is
 * dead code) and mints a boolean-branded `i32` twin instead.
 *
 * Behind `JS2WASM_RET_UNBOX_ABI`, default OFF. Every test here is a
 * DIFFERENTIAL — it asserts the OFF lowering as well as the ON one — so "the
 * flag changed nothing" can never read as a pass.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// Same pin, same reason as #3754's file: the IR inliner's adapter rule inlines
// `__dc_*` trampolines unconditionally, which relocates the shim shape these
// assertions read. The VALUE assertions below are unaffected by the inliner.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

/**
 * A write-once fnctor prototype PREDICATE and one consumer.
 *
 * `pred` deliberately returns `this.eq(x) && this.eq(x)` rather than a bare
 * comparison. A bare `return this.n === x` already lowers to a boolean-branded
 * i32 through the DECLARED signature, so `refinedTwinReturnType` never runs on
 * it (it declines when the declared result is not `externref`). The
 * `&&`-of-calls shape is the one that still reaches the refinement — and it is
 * acorn's own idiom (`eatContextual`, `shouldParseArrow`, every `regexp_eat*`).
 */
function predicateAxis(body: string): string {
  return `
    function P(n) { this.n = n; }
    var pp = P.prototype;
    pp.eq = function (x) { return this.n === x; };
    pp.pred = function (x) { return this.eq(x) && this.eq(x); };
    function inner() { ${body} }
    export function run() { return inner(); }
  `;
}

/** `[box-bool-fuse]` debug lines produced by the most recent {@link build}. */
let lastFuseNotes: string[] = [];

async function build(src: string, env?: Record<string, string>) {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env ?? {})) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  const notes: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (/^\[box-bool-fuse\]/m.test(text)) {
      notes.push(...text.split("\n").filter((l) => l.trim().length > 0));
      return true;
    }
    return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const result = await compile(src, { fileName: "pred.mjs", skipSemanticDiagnostics: true, target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.Module.imports(await WebAssembly.compile(result.binary)), "standalone stays host-free").toEqual(
      [],
    );
    return result;
  } finally {
    process.stderr.write = realWrite;
    lastFuseNotes = notes;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * The generic body's SHIM, with call targets resolved back to names.
 *
 * A refined twin's results no longer equal the generic body's, so the shim can
 * no longer `return_call` it — it degrades to `call $twin; <box>; return`. That
 * box is the one place the refined type is spelled out in readable WAT (a
 * func's `(type N)` indexes the full type space, of which the printer emits
 * only a subset — the reason #3754's file reads a local instead), and it is
 * also §3.3(a)'s actual assertion: pick the helper off the BRAND.
 */
function shimTailAfterTwinCall(wat: string): string[] {
  const lines = wat.split("\n");
  const names: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*\(func \$(\S+)/);
    if (m) names.push(m[1]!);
  }
  const resolved = wat.replace(/\b(return_call|call) (\d+)\b/g, (_m, op, i) => `${op} $${names[Number(i)] ?? i}`);
  return [...resolved.matchAll(/call \$__closure_\d+__typed_this((?:\s*\n\s*\S[^\n]*){1,3})/g)].map((m) =>
    m[1]!
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" "),
  );
}

const runExport = async (r: { binary: Uint8Array }) =>
  ((await WebAssembly.instantiate(r.binary, {})).instance.exports as { run(): number }).run();

describe("#4406 — boolean-return twins", () => {
  const AXIS = predicateAxis('var p = new P(5); return ("" + p.pred(5)).length;');

  it('the value differential: OFF stringifies to "1", ON to "true" (node\'s answer)', async () => {
    expect(await runExport(await build(AXIS))).toBe(1); // "1" — the defect
    expect(await runExport(await build(AXIS, { JS2WASM_RET_UNBOX_ABI: "1" }))).toBe(4); // "true"
  });

  it("ON the shim re-boxes with __box_boolean; OFF it takes the f64 box", async () => {
    const off = shimTailAfterTwinCall((await build(AXIS)).wat!);
    const on = shimTailAfterTwinCall((await build(AXIS, { JS2WASM_RET_UNBOX_ABI: "1" })).wat!);
    expect(
      on.some((tail) => tail.startsWith("call $__box_boolean")),
      on.join(" / "),
    ).toBe(true);
    expect(off.some((tail) => tail.includes("__box_boolean"))).toBe(false);
    // The OFF shim boxes an F64 — through the SMI fast path's inline i31 form
    // (`JS2WASM_SMI_FASTPATH`, tuned-default ON), not a bare `__box_number`
    // call. Pin the f64-only opcode rather than the helper name, or this reads
    // as "no box at all".
    expect(
      off.some((tail) => tail.includes("i32.trunc_sat_f64_s")),
      off.join(" / "),
    ).toBe(true);
  });

  it("ON: typeof / JSON.stringify / ===true / false all agree with node", async () => {
    // The acorn lane is BLIND to every one of these — its 83 predicates are
    // only ever consumed in conditions, where f64 0/1 and boolean 0/1 agree.
    const cases: [string, number][] = [
      ["var p = new P(5); return (typeof p.pred(5)).length;", 7], // "boolean"
      ["var p = new P(5); return JSON.stringify(p.pred(5)).length;", 4], // "true"
      ["var p = new P(5); return p.pred(5) === true ? 1 : 0;", 1],
      ['var p = new P(5); return ("" + p.pred(6)).length;', 5], // "false"
      ["var p = new P(5); return p.pred(5) ? 1 : 0;", 1], // the condition case, unchanged
    ];
    for (const [body, want] of cases) {
      const built = await build(predicateAxis(body), { JS2WASM_RET_UNBOX_ABI: "1" });
      expect(await runExport(built), body).toBe(want);
    }
  });

  it("a MIXED boolean/number method is not claimed, and keeps its OFF value", async () => {
    // One non-boolean return anywhere under the same NAME withdraws it from
    // #2847's fixpoint, so the boolean arm declines and the ABI is unchanged.
    const src = `
      function P(n) { this.n = n; }
      var pp = P.prototype;
      pp.eq = function (x) { return this.n === x; };
      pp.pred = function (x) { if (x > 100) { return 7; } return this.eq(x) && this.eq(x); };
      function inner() { var p = new P(5); return (p.pred(5) ? 1 : 0) + p.pred(200); }
      export function run() { return inner(); }
    `;
    const on = await build(src, { JS2WASM_RET_UNBOX_ABI: "1" });
    expect(shimTailAfterTwinCall(on.wat!).some((tail) => tail.includes("__box_boolean"))).toBe(false);
    expect(await runExport(on)).toBe(await runExport(await build(src)));
    expect(await runExport(on)).toBe(8);
  });

  it("the flag is OFF by default and every off-token disables it", async () => {
    const base = await build(AXIS);
    for (const token of ["0", "off", "false", "no", ""]) {
      const { binary } = await build(AXIS, { JS2WASM_RET_UNBOX_ABI: token });
      expect(Buffer.from(binary).equals(Buffer.from(base.binary)), `token ${JSON.stringify(token)}`).toBe(true);
    }
  });

  it("POISON alone (main flag off) is inert", async () => {
    // The poison switch inverts every refined boolean result at the trampoline
    // edge, which is how a null result is told apart from a path that never ran
    // (#4157 entry 22). It must never fire on its own.
    const base = await build(AXIS);
    const poisonOnly = await build(AXIS, { JS2WASM_RET_UNBOX_ABI_POISON: "1" });
    expect(Buffer.from(poisonOnly.binary).equals(Buffer.from(base.binary))).toBe(true);
  });

  it("POISON with the flag on changes the emitted module", async () => {
    // If poison did NOT change the binary, the trampoline edge it targets would
    // carry no refined boolean result and every "flag on" claim about the
    // devirtualized path would be about a shape that does not exist.
    const on = await build(predicateAxis("var p = new P(5); return p.pred(5) ? 1 : 0;"), {
      JS2WASM_RET_UNBOX_ABI: "1",
    });
    const poisoned = await build(predicateAxis("var p = new P(5); return p.pred(5) ? 1 : 0;"), {
      JS2WASM_RET_UNBOX_ABI: "1",
      JS2WASM_RET_UNBOX_ABI_POISON: "1",
    });
    expect(Buffer.from(poisoned.binary).equals(Buffer.from(on.binary))).toBe(false);
  });
});

/**
 * Phase 2 — the MERGE half.
 *
 * Phase 1 typed the callee's result; nothing consumed it differently, and on the
 * acorn lane it moved `__box_boolean` by +35 out of 275,113 (the null §4
 * predicts). The boxes live in the logical-value MERGE: `expressions/logical-
 * ops.ts` unifies `i32 || externref` to `externref`, so a proven-boolean arm
 * re-boxes for a value that is about to be ToBoolean'd again — and lever 4
 * (#4157, `box-boolean-fuse.ts`) declines the whole site because its sibling arm
 * tails in an externref-returning call it cannot specialise.
 *
 * Phase 2 adds the general leaf: keep the consumer, move a COPY of it into the
 * arm. The sibling's box then fuses.
 *
 * `pick` below is deliberately built from PLAIN functions, not fnctor prototype
 * methods — `refinedTwinReturnType` never fires on it, so nothing here can be
 * carried by Phase 1 and every delta is the merge's.
 */
const MERGE_AXIS = `
  function box(o) { return o.v; }
  function pick(a, b, o) { return ((a === b) && box(o)) ? 11 : 22; }
  export function run() {
    var o = { v: "yes" };
    return pick(1, 1, o) * 10000 + pick(1, 2, o) * 100 + pick(1, 1, { v: "" });
  }
`;

/** Lever 4 on (its own default-OFF gate) plus its stats line. */
const FUSE = { JS2WASM_UNBOXED_BOOL_FUSE: "1", JS2WASM_UNBOXED_BOOL_FUSE_DEBUG: "1" };

/** The single `[box-bool-fuse]` stats line from the most recent build. */
function fuseTally(): string {
  const line = lastFuseNotes.find((l) => l.startsWith("[box-bool-fuse] fused-sink="));
  expect(line, `no fuse stats line; got ${JSON.stringify(lastFuseNotes)}`).toBeDefined();
  return line!;
}

describe("#4406 Phase 2 — the merge sink", () => {
  it("lever 4 ALONE declines this merge on arm-tail-call", async () => {
    // The before-state, asserted rather than assumed: without the merge half the
    // site is stranded, so the next test's `fused-sink=1` cannot be a shape that
    // was already fusing.
    await build(MERGE_AXIS, FUSE);
    expect(fuseTally()).toMatch(/fused-sink=0\b/);
    expect(fuseTally()).toMatch(/arm-tail-call=1\b/);
  });

  it("with the ABI flag the site fuses, taking a copy of the consumer", async () => {
    await build(MERGE_AXIS, { ...FUSE, JS2WASM_RET_UNBOX_ABI: "1" });
    const tally = fuseTally();
    expect(tally).toMatch(/fused-sink=1\b/);
    expect(tally).toMatch(/box-call=1\b/); // the sibling's box — the point of the change
    expect(tally).toMatch(/sunk-consumer=1 \(sites=1, merge-sink=on\)/);
    expect(tally).not.toMatch(/arm-tail-call/);
  });

  it("the merged VALUE is identical with and without the sink", async () => {
    // 11 (both true) · 22 (a !== b) · 22 (box(o) is the falsy "") — node's answer
    // for the same source, and the invariant the rewrite must not disturb.
    const plain = await runExport(await build(MERGE_AXIS));
    const fused = await runExport(await build(MERGE_AXIS, FUSE));
    const sunk = await runExport(await build(MERGE_AXIS, { ...FUSE, JS2WASM_RET_UNBOX_ABI: "1" }));
    expect(plain).toBe(112222);
    expect(fused).toBe(112222);
    expect(sunk).toBe(112222);
  });

  it("POISON inverts a sunk merge — the path is executed, not merely emitted", async () => {
    // The liveness proof #4157 entry 22 asks for, isolated to Phase 2: this
    // source has no refined trampoline for Phase 1's poison to touch, so an
    // unchanged answer here would mean the sunk consumer never ran.
    const poisoned = await build(MERGE_AXIS, {
      ...FUSE,
      JS2WASM_RET_UNBOX_ABI: "1",
      JS2WASM_RET_UNBOX_ABI_POISON: "1",
    });
    expect(fuseTally()).toMatch(/RET-ABI-POISON=ON/);
    expect(await runExport(poisoned)).toBe(221111); // every arm's verdict flipped
  });

  it("the sink needs BOTH gates — the ABI flag alone changes nothing", async () => {
    // Lever 4 is the vehicle, so with it off the merge half cannot fire and the
    // shipping default stays byte-for-byte where it was.
    const base = await build(MERGE_AXIS);
    const abiOnly = await build(MERGE_AXIS, { JS2WASM_RET_UNBOX_ABI: "1" });
    expect(Buffer.from(abiOnly.binary).equals(Buffer.from(base.binary))).toBe(true);
  });

  it("a merge with no free leaf is declined rather than paying size for nothing", async () => {
    // `??` unifies through a branch that is not a tee'd ToBoolean, so neither arm
    // is a box or a cond-reuse leaf. Sinking both would copy the consumer twice
    // and delete zero boxes — the pass declines instead.
    const src = `
      function box(o) { return o.v; }
      function pick(o, d) { return (box(o) ?? box(d)) ? 11 : 22; }
      export function run() { return pick({ v: "yes" }, { v: "no" }); }
    `;
    await build(src, { ...FUSE, JS2WASM_RET_UNBOX_ABI: "1" });
    expect(fuseTally()).toMatch(/no-free-leaf=\d+/);
  });
});
