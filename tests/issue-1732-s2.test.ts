/**
 * #1732 S2 — `new <NonCtorNamespace>.<method>()` must throw TypeError.
 *
 * A method pulled off a non-constructor namespace object (Math / JSON / Reflect
 * / Atomics) is an ordinary function with no [[Construct]] (§21.3 / §25.5 /
 * §28.1 / §25.4), so `new` on it must throw TypeError (§7.3.13 Construct →
 * IsConstructor). The compile-time Pattern 2 guard in new-super.ts only fires
 * when the TS lib KNOWS the method has call-sigs / no-construct-sigs; methods
 * NEWER than the bundled lib — `Math.f16round`, `Math.sumPrecise` — resolve to
 * `any`, slip past Pattern 2, and reached the unknown-ctor path that never
 * performed [[Construct]] (so `new Math.f16round()` returned instead of
 * throwing — test262 built-ins/Math/f16round/not-a-constructor.js etc.).
 *
 * S2 fix: a Pattern-1 extension keyed on the receiver NAMESPACE NAME
 * (Math/JSON/Reflect/Atomics), so it fires for any current or future method on
 * those namespaces regardless of lib version.
 *
 * NOTE: the A8 own-`length`/`name` descriptor + for-in family this slice
 * nominally targeted is already green on main (host method values carry correct
 * descriptors and route for-in through the host key path post-#941/#936), so
 * S2's only codegen change is this namespace-method not-a-constructor arm.
 *
 * Assertion style: the `new` throw crosses the JS boundary as a raw
 * `WebAssembly.Exception`, NOT a JS `TypeError`. So we catch INSIDE the
 * compiled module and check `e instanceof TypeError` there (returning 1) — the
 * exact `assert.throws(TypeError, …)` shape test262 uses, and the only way to
 * observe that the thrown value is a real TypeError instance.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Returns 1 iff `new <newExpr>` throws and the caught value is a TypeError;
// 0 if no throw; 2 if a non-TypeError was thrown.
async function newThrowsTypeError(newExpr: string): Promise<unknown> {
  const src = `export function test(): number { try { var x = new ${newExpr}; return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`;
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`CE: ${r.errors[0]?.message ?? "?"}`);
  const io = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, io as any);
  (io as any).setExports?.(instance.exports);
  return (instance.exports as any).test();
}

describe("#1732 S2 — new on a non-constructor namespace method throws TypeError", () => {
  it("new Math.f16round() → TypeError (method newer than TS lib, type any)", async () => {
    expect(await newThrowsTypeError("(Math.f16round as any)(1)")).toBe(1);
  });

  it("new Math.sumPrecise() → TypeError (also lib-unknown)", async () => {
    expect(await newThrowsTypeError("(Math.sumPrecise as any)([])")).toBe(1);
  });

  it("new Reflect.has() → TypeError", async () => {
    expect(await newThrowsTypeError(`(Reflect.has as any)({}, "x")`)).toBe(1);
  });

  it("new JSON.parse() → TypeError", async () => {
    expect(await newThrowsTypeError(`(JSON.parse as any)("1")`)).toBe(1);
  });

  // ── Regression guards: lib-known namespace methods + the namespace itself ──

  it("new Math.abs() still throws TypeError (lib-known, Pattern 2)", async () => {
    expect(await newThrowsTypeError("(Math.abs as any)(1)")).toBe(1);
  });

  it("new Math() (the namespace itself) still throws TypeError", async () => {
    expect(await newThrowsTypeError("Math()")).toBe(1);
  });
});
