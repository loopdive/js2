import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!r.success) throw new Error("CE: " + r.errors.map((e) => e.message).join("; "));
  const importObj = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(r.binary, importObj as never);
  if (typeof importObj.setExports === "function") {
    (importObj.setExports as (e: unknown) => void)(instance.exports);
  }
  return (instance.exports as { test: () => number }).test();
}

// #820h — (Async)DisposableStack referenced as a *value* (not in new/method
// position) must resolve to the host global constructor so reflective
// operations (prototype access, property descriptors, Reflect.construct)
// see the real native object instead of a null externref.
describe("#820h (Async)DisposableStack as a host-global value", () => {
  it("DisposableStack.prototype is a non-null object", async () => {
    expect(await run(`export function test(): number { return DisposableStack.prototype != null ? 1 : 0; }`)).toBe(1);
  });

  it("Object.getOwnPropertyDescriptor sees the disposed accessor", async () => {
    expect(
      await run(`export function test(): number {
        let d = Object.getOwnPropertyDescriptor(DisposableStack.prototype, 'disposed');
        return (typeof d.get === 'function' && typeof d.set === 'undefined') ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.construct(DisposableStack, []) builds an instance", async () => {
    expect(
      await run(`export function test(): number {
        let s = Reflect.construct(DisposableStack, []);
        return s != null ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("AsyncDisposableStack.prototype resolves too", async () => {
    expect(await run(`export function test(): number { return AsyncDisposableStack.prototype != null ? 1 : 0; }`)).toBe(
      1,
    );
  });

  it("a user-defined class named DisposableStack still shadows the global", async () => {
    expect(
      await run(`class DisposableStack { x: number = 5; getX(): number { return this.x; } }
        export function test(): number { let d = new DisposableStack(); return d.getX(); }`),
    ).toBe(5);
  });

  it("a local binding named SuppressedError still shadows the global", async () => {
    expect(await run(`export function test(): number { let SuppressedError = 7; return SuppressedError; }`)).toBe(7);
  });

  it("normal new DisposableStack().dispose() still works", async () => {
    expect(
      await run(`export function test(): number {
        let s = new DisposableStack(); s.dispose(); return s.disposed ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
