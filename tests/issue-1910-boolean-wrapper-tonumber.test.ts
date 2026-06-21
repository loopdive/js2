import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #1910 R3 — standalone `new Boolean(x)` wrapper ToNumber.
//
// `new Boolean(x)` builds a `$Object` wrapper carrying its [[BooleanData]]
// primitive in the reserved FLAG_INTERNAL slot as a BOXED boolean
// (`__box_boolean_struct`). `__to_primitive` recovers that boxed-boolean
// externref from the slot, and the ToNumber that `Number(...)` applies routes
// it through `__unbox_number`. Before this fix `__unbox_number` had no
// boxed-boolean arm, so it fell through to the opaque-ref NaN fallback and
// `Number(new Boolean(true))` returned NaN instead of 1 (§7.1.4
// ToNumber(true)=1, ToNumber(false)=0).
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#1910 R3 standalone Boolean-wrapper ToNumber", () => {
  it("Number(new Boolean(true)) === 1", async () => {
    expect(await runStandalone(`export function f(): number { return Number(new Boolean(true)); }`)).toBe(1);
  });

  it("Number(new Boolean(false)) === 0", async () => {
    expect(await runStandalone(`export function f(): number { return Number(new Boolean(false)); }`)).toBe(0);
  });

  it("new Boolean(true) coerces to 1 in numeric context (+ 0)", async () => {
    expect(await runStandalone(`export function f(): number { return (new Boolean(true) as any) + 0; }`)).toBe(1);
  });

  it("new Boolean(false) coerces to 0 in numeric context (+ 0)", async () => {
    expect(await runStandalone(`export function f(): number { return (new Boolean(false) as any) + 0; }`)).toBe(0);
  });

  // §20.3.3.3 Boolean.prototype.valueOf returns the [[BooleanData]] slot. The
  // standalone wrapper-accessor path routes through __to_primitive (slot read)
  // then __unbox_boolean to recover the i32 primitive.
  it("new Boolean(true).valueOf() is truthy → 1", async () => {
    expect(await runStandalone(`export function f(): number { return new Boolean(true).valueOf() ? 1 : 0; }`)).toBe(1);
  });

  it("new Boolean(false).valueOf() is falsy → 0", async () => {
    expect(await runStandalone(`export function f(): number { return new Boolean(false).valueOf() ? 1 : 0; }`)).toBe(0);
  });
});
