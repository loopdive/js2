import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2604 — Standalone `Set.prototype.METHOD.call(recv, …)` / `inst.METHOD.call(recv, …)`
//   native dispatch + `[[SetData]]` brand-check TypeError.
//
// The reflective `.call` shape never reached `tryCompileNativeSetMethodCall`
// (which only fires on a direct `s.add(v)` with a static Set receiver), so it
// neither routed to the native Set runtime NOR brand-checked the receiver — a
// non-Set receiver (`""`, `0`, `{}`, `[]`, `null`, `new Map()`, `Set.prototype`)
// ran to completion instead of throwing the spec TypeError (24.2.3.* "If S does
// not have a [[SetData]] internal slot, throw a TypeError").
//
// Fix: a Set-method `.call` pre-check in calls.ts → `tryCompileSetReflectiveCall`
// (set-runtime.ts) compiles the first `.call` arg as the receiver, runs the
// shared `emitSetBrandCheck` (`ref.test $Map` → catchable TypeError on a miss),
// then dispatches add/has/delete/clear to the native helpers. Gated on
// nativeStrings; the generic #2193 member-closure path is unchanged.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const io = r.importObject as WebAssembly.Imports & { __setExports?: (e: Record<string, unknown>) => void };
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setExports?.(instance.exports as Record<string, unknown>);
  return (instance.exports as { test(): unknown }).test();
}

// Each method × non-Set receiver → 1 if a TypeError was thrown.
const throwsFor = (method: string, recv: string, args = "") =>
  `export function test(): number {
     try { Set.prototype.${method}.call(${recv} as any${args}); return 0; }
     catch (e: any) { return e instanceof TypeError ? 1 : 2; }
   }`;

describe("#2604 Set.prototype.METHOD.call brand-check throws TypeError on non-Set receiver", () => {
  const methods = ["add", "has", "delete"] as const;
  const primitives = ['""', "0", "true", "null", "undefined"] as const;
  for (const m of methods) {
    for (const p of primitives) {
      it(`${m}.call(${p}) → TypeError`, async () => {
        expect(await runStandalone(throwsFor(m, p, ", 1"))).toBe(1);
      });
    }
    it(`${m}.call({}) (plain object) → TypeError`, async () => {
      expect(await runStandalone(throwsFor(m, "{}", ", 1"))).toBe(1);
    });
    it(`${m}.call([]) (array) → TypeError`, async () => {
      expect(await runStandalone(throwsFor(m, "[]", ", 1"))).toBe(1);
    });
    it(`${m}.call(Set.prototype) → TypeError`, async () => {
      expect(await runStandalone(throwsFor(m, "Set.prototype", ", 1"))).toBe(1);
    });
  }

  it("clear.call(non-Set) → TypeError", async () => {
    expect(await runStandalone(throwsFor("clear", '""'))).toBe(1);
  });

  it("instance form `s.add.call({}, 1)` → TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = new Set(); try { s.add.call({} as any, 1); return 0; } catch (e: any) { return e instanceof TypeError ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });
});

describe("#2604 valid Set receiver dispatches to the native runtime", () => {
  it("Set.prototype.has.call(realSet, v) returns the membership boolean", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = new Set([5]); return Set.prototype.has.call(s, 5) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("Set.prototype.add.call(realSet, v) mutates the set (chainable)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = new Set(); Set.prototype.add.call(s, 9); return s.has(9) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("Set.prototype.delete.call(realSet, v) removes and returns true", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = new Set([5]); const r = Set.prototype.delete.call(s, 5); return r && !s.has(5) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("Set.prototype.clear.call(realSet) empties the set", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = new Set([1, 2]); Set.prototype.clear.call(s); return s.size === 0 ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("regression: direct s.add/s.has still works", async () => {
    expect(
      await runStandalone(`export function test(): number { const s = new Set(); s.add(7); return s.has(7) ? 1 : 0; }`),
    ).toBe(1);
  });
});
