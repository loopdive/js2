// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4406 Phase 3 — the PARAMETER half of the return-type unboxing ABI.
 *
 * ## What it closes
 *
 * Phases 1 and 2 typed the callee's RESULT and the merge that consumes it.
 * Neither sees an ARGUMENT, and argument position is where the surviving
 * `__box_boolean` traffic lives (the issue's §1.4 producer ranking: `local.get`
 * next 29 %, `call __dc_*` next 15 %, `i32.const` next 5 %). A devirtualized
 * `this.m(false)` pushes `i32.const 0; call $__box_boolean` purely because the
 * trampoline declares `externref` in that slot.
 *
 * Phase 3 proves, whole-program, that a parameter SLOT of a NAME only ever
 * receives booleans, and declares it a boolean-branded `i32` on both the twin
 * and its trampoline.
 *
 * ## What is load-bearing here, and why each test exists
 *
 * A refined RESULT is imposed on the callee and coerced there, so an imprecise
 * verdict costs performance. A refined PARAMETER is imposed on the CALLERS,
 * where an unproven caller silently hands the body a value it will read as a
 * boolean. Three tests pin the three things that make that safe: the verdict is
 * conjunctive over call sites (`a non-boolean anywhere withdraws the slot`),
 * conjunctive over declarations (`an assigned parameter is not refined`), and
 * the twin is unreachable from dynamic callers (`the forwarding shim is
 * suppressed`). The value tests pin that a refined slot still reads as a real
 * JavaScript boolean — `typeof`, stringification and `=== true`, none of which
 * the acorn lane can see.
 *
 * Behind `JS2WASM_RET_UNBOX_ABI`, default OFF. Every test is a DIFFERENTIAL, so
 * "the flag changed nothing" can never read as a pass.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// Same pin, same reason as #3754's and Phase 0+1's files: the IR inliner's
// adapter rule inlines `__dc_*` trampolines unconditionally, which relocates
// the very call sequences these assertions read.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

/**
 * A write-once fnctor prototype method with ONE parameter, and a sibling that
 * calls it twice with booleans.
 *
 * The two arguments are deliberately different shapes: `this.n > 3` is a
 * computed boolean (the `local.get`-next bucket) and `false` is a literal (the
 * `i32.const`-next bucket). Both box under the declared `externref` ABI.
 */
function paramAxis(calleeBody: string, driveBody?: string): string {
  return `
    function P(n) { this.n = n; }
    var pp = P.prototype;
    pp.takeFlag = function (flag) { ${calleeBody} };
    pp.drive = function () { ${driveBody ?? "return this.takeFlag(this.n > 3) + this.takeFlag(false);"} };
    function inner() { var p = new P(5); return p.drive(); }
    export function run() { return inner(); }
  `;
}

async function build(src: string, env?: Record<string, string>) {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env ?? {})) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    const result = await compile(src, { fileName: "param.mjs", skipSemanticDiagnostics: true, target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.Module.imports(await WebAssembly.compile(result.binary)), "standalone stays host-free").toEqual(
      [],
    );
    return result;
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * The WAT with every `call N` / `return_call N` rewritten to `call $name`.
 *
 * The printer emits numeric call targets and only a subset of the type space,
 * so the readable evidence for a refined parameter is not the trampoline's
 * declared signature — it is the disappearance of the box that used to precede
 * the call to it.
 */
function resolveCalls(wat: string): string {
  const names: string[] = [];
  for (const line of wat.split("\n")) {
    const m = line.match(/^\s*\(func \$(\S+)/);
    if (m) names.push(m[1]!);
  }
  return wat.replace(/\b(return_call|call) (\d+)\b/g, (_m, op, i) => `${op} $${names[Number(i)] ?? i}`);
}

/**
 * How many `__box_boolean` calls reach `takeFlag`'s trampoline with no other
 * call in between — i.e. boxes in ARGUMENT position at that call site.
 *
 * The count itself is not pinned: the closure lifter lifts the same arrow more
 * than once, so the absolute number tracks an implementation detail. The
 * differential — some, versus none — is the claim.
 */
function boxesBeforeTrampoline(wat: string): number {
  return [...resolveCalls(wat).matchAll(/call \$__box_boolean(?:(?!call \$)[\s\S])*?call \$__dc_P_takeFlag_1/g)].length;
}

/** How many generic bodies still tail-call their typed-`this` twin. */
function shimTailCalls(wat: string): number {
  return [...resolveCalls(wat).matchAll(/return_call \$\S*__typed_this/g)].length;
}

const runExport = async (r: { binary: Uint8Array }) =>
  ((await WebAssembly.instantiate(r.binary, {})).instance.exports as { run(): number }).run();

/**
 * (#4406 Phase 4) `JS2WASM_RET_UNBOX_ABI` is now DEFAULT-ON, so a bare build is
 * the ON lane. Every OFF lane below therefore spells the token out. The
 * differentials are unchanged — only which side needed naming moved.
 */
const OFF = { JS2WASM_RET_UNBOX_ABI: "0" } as const;

describe("#4406 Phase 3 — boolean parameter slots", () => {
  // `(typeof flag).length` is 7 for "boolean" and 6 for "number": the callee
  // itself reports which representation arrived, so a slot narrowed to a raw
  // i32 that LOST its boolean brand fails here rather than silently shipping.
  const AXIS = paramAxis("return (typeof flag).length;");

  it("the box differential: OFF boxes both arguments, ON passes them unboxed", async () => {
    expect(boxesBeforeTrampoline((await build(AXIS, OFF)).wat!), "OFF: every argument boxes").toBeGreaterThan(0);
    expect(boxesBeforeTrampoline((await build(AXIS, { JS2WASM_RET_UNBOX_ABI: "1" })).wat!), "ON: none do").toBe(0);
  });

  it("the refined slot still reads as a real boolean — typeof / string / === true", async () => {
    const cases: [string, number][] = [
      ["return (typeof flag).length;", 14], // "boolean" twice
      ['return ("" + flag).length;', 9], // "true" + "false"
      ["return flag === true ? 1 : 0;", 1], // only the first argument is true
      ["return flag === false ? 1 : 0;", 1], // only the second is false
      ["return flag ? 1 : 0;", 1], // the condition case, where 0/1 and a boolean agree
    ];
    for (const [body, want] of cases) {
      const src = paramAxis(body);
      const on = await build(src, { JS2WASM_RET_UNBOX_ABI: "1" });
      expect(await runExport(on), body).toBe(want);
      // The ABI must not change the observable value, only its carrier.
      expect(await runExport(await build(src, OFF)), `${body} (flag off)`).toBe(want);
    }
  });

  it("the forwarding shim is SUPPRESSED for a refined method — the twin's only entry is the trampoline", async () => {
    // This is the safety property, not an optimisation: the shim forwards the
    // GENERIC body's externref parameters into the twin, so with a slot
    // narrowed to i32 it would impose ToBoolean on whatever an un-enumerable
    // caller (`arr.map(o.m)`, `o.m.call(…)`, `o["m"](…)`) passed.
    expect(shimTailCalls((await build(AXIS, OFF)).wat!)).toBeGreaterThan(0);
    expect(shimTailCalls((await build(AXIS, { JS2WASM_RET_UNBOX_ABI: "1" })).wat!)).toBe(0);
  });

  it("a non-boolean at ANY call site withdraws the slot, and the value survives", async () => {
    // One `takeFlag(7)` anywhere in the program is enough: the verdict is
    // conjunctive over every syntactic call site of the name.
    const src = paramAxis("return (typeof flag).length;", "return this.takeFlag(this.n > 3) + this.takeFlag(7);");
    const on = await build(src, { JS2WASM_RET_UNBOX_ABI: "1" });
    expect(boxesBeforeTrampoline(on.wat!), "slot must NOT be refined").toBeGreaterThan(0);
    expect(await runExport(on)).toBe(await runExport(await build(src, OFF)));
    expect(await runExport(on)).toBe(13); // "boolean" + "number"
  });

  it("a parameter the body ASSIGNS is not refined", async () => {
    // The declaration-side rule. Imposing i32 on a slot the body overwrites
    // would coerce the new value through a representation it never agreed to.
    const src = paramAxis('if (flag) { flag = "x"; } return (typeof flag).length;');
    const on = await build(src, { JS2WASM_RET_UNBOX_ABI: "1" });
    expect(boxesBeforeTrampoline(on.wat!), "slot must NOT be refined").toBeGreaterThan(0);
    expect(await runExport(on)).toBe(await runExport(await build(src, OFF)));
    expect(await runExport(on)).toBe(13); // "string" + "boolean"
  });

  it("every off-token disables it, and the DEFAULT is now ON (#4406 Phase 4)", async () => {
    const base = await build(AXIS, OFF);
    for (const token of ["0", "off", "false", "no", ""]) {
      const { binary } = await build(AXIS, { JS2WASM_RET_UNBOX_ABI: token });
      expect(Buffer.from(binary).equals(Buffer.from(base.binary)), `token ${JSON.stringify(token)}`).toBe(true);
    }
    // The flip itself, pinned: unset must NOT reproduce the off lane, and a
    // typo must land on the new default rather than half-disabling anything.
    const unset = await build(AXIS);
    expect(Buffer.from(unset.binary).equals(Buffer.from(base.binary)), "unset must be ON").toBe(false);
    const typo = await build(AXIS, { JS2WASM_RET_UNBOX_ABI: "yes" });
    expect(Buffer.from(typo.binary).equals(Buffer.from(unset.binary)), "a typo is the default").toBe(true);
  });

  it("POISON: inert alone, and ON it inverts every refined argument", async () => {
    // #4157 entry 22's lesson — a green run with a poisoned path is proof the
    // path is dead. The switch is deliberately separate from Phase 1's, which
    // already breaks the acorn parse on its own and so could not attribute a
    // break to this half.
    const src = paramAxis("return flag ? 1 : 0;");
    const base = await build(src, OFF);
    const poisonOnly = await build(src, { ...OFF, JS2WASM_PARAM_UNBOX_ABI_POISON: "1" });
    expect(Buffer.from(poisonOnly.binary).equals(Buffer.from(base.binary)), "poison alone is inert").toBe(true);

    // The two calls must be WEIGHTED, or inverting both is the identity on the
    // sum and the poison reads as inert when it is in fact live.
    const weighted = paramAxis("return flag ? 1 : 0;", "return this.takeFlag(this.n > 3) * 10 + this.takeFlag(false);");
    expect(await runExport(await build(weighted, { JS2WASM_RET_UNBOX_ABI: "1" }))).toBe(10);
    expect(
      await runExport(await build(weighted, { JS2WASM_RET_UNBOX_ABI: "1", JS2WASM_PARAM_UNBOX_ABI_POISON: "1" })),
      "true↔false at both call sites — a dead path could not move this",
    ).toBe(1);
  });
});
