import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2101a R5 — standalone own-field storage on externref-backed Error subclasses.
//
// An Error subclass instance IS the parent `$Error_struct` externref (no
// per-subclass WasmGC struct), so user-declared own fields (`class A extends
// Error { code = 0 }`) had nowhere to live: `this.code = …` cast `this` to the
// vestigial `$A` struct and TRAPPED at construction, taking message/instanceof
// down with it. The fix gives `$Error_struct` a trailing `$props` (fieldIdx 5)
// open-`$Object` backing, lazily allocated on first own-field write; reads/
// writes route through `__extern_set`/`__extern_get`.
async function runNum(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#2101a R5 standalone externref-subclass own-field", () => {
  it("own field reads back the written value", async () => {
    expect(
      await runNum(`
        class A extends Error { code: number = 0; constructor(m: string) { super(m); this.code = 42; } }
        export function f(): number { const a = new A("z"); return a.code; }
      `),
    ).toBe(42);
  });

  it("multiple own fields are independent", async () => {
    expect(
      await runNum(`
        class A extends Error { x: number = 0; y: number = 0; constructor(m: string) { super(m); this.x = 3; this.y = 5; } }
        export function f(): number { const a = new A("z"); return a.x * 10 + a.y; }
      `),
    ).toBe(35);
  });

  it("a subclass declaring its own field + ctor stores it", async () => {
    expect(
      await runNum(`
        class A extends Error { constructor(m: string) { super(m); } }
        class D extends A { code: number = 0; constructor(m: string) { super(m); this.code = 7; } }
        export function f(): number { const d = new D("z"); return d.code; }
      `),
    ).toBe(7);
  });

  // Regression guards: the own-field write previously TRAPPED construction,
  // which broke the inherited Error machinery too. These confirm message +
  // instanceof survive when an own field is present.
  it("inherited .message still works when an own field is declared", async () => {
    expect(
      await runNum(`
        class A extends Error { code: number = 0; constructor(m: string) { super(m); this.code = 42; } }
        export function f(): number { const a = new A("hello"); return a.message.length; }
      `),
    ).toBe(5);
  });

  it("instanceof Error still holds when an own field is declared", async () => {
    expect(
      await runNum(`
        class A extends Error { code: number = 0; constructor(m: string) { super(m); this.code = 42; } }
        export function f(): number { const a = new A("z"); return (a instanceof Error) ? 1 : 0; }
      `),
    ).toBe(1);
  });
});
