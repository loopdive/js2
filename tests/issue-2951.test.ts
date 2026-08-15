// #2951 gate-2 — narrow the IR-first generator skip-set.
//
// #2138's `computeIrFirstSkipSet` blanket-excluded every generator from the
// IR-first skip set (compile-twice), because IR-generator self-sufficiency
// without legacy's side effects was unproven (deviation 3). The predecessor
// slice (`gen.setReturn`, #2640) closed the last value-returning-`return`
// deferral so value-carrying generators now IR-claim with zero post-claim
// demotions. This suite proves the narrowing:
//
//   1. A selector-claimed, value-returning generator now appears in
//      `CompileResult.irFirstSkipped` under `JS2WASM_IR_FIRST=1` (JS-host),
//      compiles clean (no hard error / no post-claim demotion), and produces
//      the correct runtime result when drained host-side.
//   2. STANDALONE keeps generators compile-twice (gate 2 still excludes them):
//      `irFirstSkipped` must NOT list the generator.
//   3. Flag OFF is byte-inert: the skip machinery never runs, so
//      `irFirstSkipped` is undefined and the module still runs.
//
// Runtime parity holds by construction: under the default (flag-off) IR
// overlay a claimed generator ALREADY ships its IR body (the overlay
// overwrites the legacy slot), so skipping the wasted legacy compile changes
// only compile time — not the shipped body.
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

const prevFlag = process.env.JS2WASM_IR_FIRST;
afterEach(() => {
  if (prevFlag === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_FIRST");
  else process.env.JS2WASM_IR_FIRST = prevFlag;
});

async function compileWith(source: string, opts: Parameters<typeof compile>[1], irFirst: boolean) {
  // (#3143) IR-first is default-ON; the off-arm must use the explicit "0"
  // escape hatch (unset now means ON).
  if (irFirst) process.env.JS2WASM_IR_FIRST = "1";
  else process.env.JS2WASM_IR_FIRST = "0";
  return compile(source, opts);
}

async function drain(binary: Uint8Array, imports: unknown, stringPool: unknown, take: (g: any) => unknown) {
  const importObj = buildImports(imports as never, undefined, stringPool as never) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(binary, importObj as never);
  if (typeof importObj.setExports === "function") {
    (importObj.setExports as (e: unknown) => void)(instance.exports);
  }
  return take((instance.exports as { g: (...a: number[]) => any }).g());
}

const VALUE_RETURN_GEN = `export function* g(){ yield 1; yield 2; return 3; }`;

describe("#2951 gate-2 — IR-first generator skip-set narrowing", () => {
  it("JS-host: a value-returning generator compiles+runs correctly under IR-first", async () => {
    const res = await compileWith(VALUE_RETURN_GEN, { fileName: "test.ts" }, /* irFirst */ true);
    expect(res.success).toBe(true);
    // (2026-08-15) The generator half of #2951 is now CLOSED: an IR-claimed
    // JS-host generator enters the prepared/compile-once route, so the legacy
    // body is never emitted and the owner IS listed in `irFirstSkipped`. This
    // superseded the earlier "#3143 f64-only allowlist ⇒ compile-twice" note.
    expect(res.irFirstSkipped ?? []).toContain("g");
    // no hard compile error and no post-claim demotion (self-sufficiency proof)
    expect((res.errors ?? []).filter((e) => e.severity === "error")).toHaveLength(0);
    expect(res.irPostClaimErrors ?? []).toHaveLength(0);
    // spread excludes the return value (return 3 lands only on the terminal
    // {value, done:true} IteratorResult, per #2035)
    const got = await drain(res.binary!, res.imports, res.stringPool, (gen) => JSON.stringify([...gen]));
    expect(got).toBe("[1,2]");
  });

  it("JS-host: the terminal return value surfaces once with done:true", async () => {
    const res = await compileWith(VALUE_RETURN_GEN, { fileName: "test.ts" }, true);
    // Compile-once, and the shipped body is the IR body — anti-vacuity for the
    // skip: a skipped slot with no IR body would trap instead of draining.
    expect(res.irFirstSkipped ?? []).toContain("g");
    const got = await drain(res.binary!, res.imports, res.stringPool, (gen) => {
      gen.next();
      gen.next();
      const r = gen.next();
      return `${r.done}:${r.value}`;
    });
    expect(got).toBe("true:3");
  });

  it("standalone keeps generators compile-twice (gate 2 still excludes them)", async () => {
    const res = await compileWith(VALUE_RETURN_GEN, { fileName: "test.ts", target: "standalone" }, true);
    // gate 2 stays for standalone: the generator must NOT be skipped
    expect(res.irFirstSkipped ?? []).not.toContain("g");
  });

  it("flag OFF (=0 escape hatch, #3143): skip machinery is inert (irFirstSkipped undefined)", async () => {
    const res = await compileWith(VALUE_RETURN_GEN, { fileName: "test.ts" }, /* irFirst */ false);
    expect(res.success).toBe(true);
    expect(res.irFirstSkipped).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #2951 generator compile-once (2026-08-15) — the deviation-3 half, closed.
// ---------------------------------------------------------------------------
//
// Before this slice an IR-claimed generator emitted BOTH bodies: the direct
// emitter compiled the legacy body and the IR overlay overwrote the slot
// afterwards. The blocker was not the skip predicate but DEPENDENCY DISCOVERY:
// `gen.push` / `gen.epilogue` / `gen.yieldStar` / `gen.setReturn` resolved
// their host callables by name inside the lowerer, so prepared-component
// sealing reported `implicit-support-reference-unavailable` and peeled the
// owner back to the direct route. `attachIrGeneratorSupport` makes those
// callables symbolic and `observeAttachedGeneratorProviders` observes them
// BEFORE sealing (sealing runs before lowering), after which the ordinary
// prepared/compile-once machinery admits the generator.
const FOROF_GEN = `export function* counter(n: number) { for (let i = 0; i < n; i++) yield i; return n; }`;

describe("#2951 — IR-claimed JS-host generators compile once", () => {
  it("emits only the IR body (legacy body skipped) and still drains correctly", async () => {
    const res = await compileWith(FOROF_GEN, { fileName: "test.ts", trackIrOutcomes: true }, true);
    expect(res.success).toBe(true);
    const generatorUnit = (res.irOutcomes ?? []).find((outcome) => outcome.displayName === "counter");
    expect(generatorUnit).toBeDefined();
    // The regression this test exists for: `legacyBodyEmitted` used to be true.
    expect(generatorUnit?.legacyBodyEmitted).toBe(false);
    expect(generatorUnit?.irBodyEmitted).toBe(true);
    expect((res.errors ?? []).filter((e) => e.severity === "error")).toHaveLength(0);
    expect(res.irPostClaimErrors ?? []).toHaveLength(0);

    // Anti-vacuity: a skipped slot without a shipped IR body traps on call.
    const importObj = buildImports(res.imports as never, undefined, res.stringPool as never) as Record<string, unknown>;
    const { instance } = await WebAssembly.instantiate(res.binary!, importObj as never);
    if (typeof importObj.setExports === "function") {
      (importObj.setExports as (e: unknown) => void)(instance.exports);
    }
    const exports = instance.exports as { counter: (n: number) => Iterable<number> & Iterator<number> };
    expect([...exports.counter(5)]).toEqual([0, 1, 2, 3, 4]);
    const gen = exports.counter(2);
    gen.next();
    gen.next();
    expect(gen.next()).toMatchObject({ done: true, value: 2 });
  });

  it("standalone generators stay compile-twice (out of scope — #680 native carrier)", async () => {
    const res = await compileWith(
      FOROF_GEN,
      { fileName: "test.ts", target: "standalone", trackIrOutcomes: true },
      true,
    );
    expect(res.success).toBe(true);
    const generatorUnit = (res.irOutcomes ?? []).find((outcome) => outcome.displayName === "counter");
    expect(generatorUnit?.legacyBodyEmitted).toBe(true);
    expect(res.irFirstSkipped ?? []).not.toContain("counter");
  });

  it("the IR-first escape hatch still runs the generator identically", async () => {
    // The legacy generator body was pure waste: the IR overlay overwrote the
    // slot anyway, so dropping it changes compile work, not observable
    // behaviour. (Byte-identity of the SHIPPED module against pre-slice `main`
    // was measured separately — see the issue's Test Results. Flag-on vs
    // flag-off is NOT byte-comparable: `=0` disables the whole IR-first
    // ordering, not just this skip.)
    const withoutFlag = await compileWith(FOROF_GEN, { fileName: "test.ts" }, false);
    expect(withoutFlag.success).toBe(true);
    const importObj = buildImports(withoutFlag.imports as never, undefined, withoutFlag.stringPool as never) as Record<
      string,
      unknown
    >;
    const { instance } = await WebAssembly.instantiate(withoutFlag.binary!, importObj as never);
    if (typeof importObj.setExports === "function") {
      (importObj.setExports as (e: unknown) => void)(instance.exports);
    }
    const exports = instance.exports as { counter: (n: number) => Iterable<number> };
    expect([...exports.counter(5)]).toEqual([0, 1, 2, 3, 4]);
  });
});
