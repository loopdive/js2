/**
 * Issue #1433 — DisposableStack / AsyncDisposableStack lifecycle semantics
 *
 * Problem: object literals like `{ [Symbol.dispose]() {…} }` were stored as
 * WasmGC structs whose `@@dispose` field is invisible to native JS APIs.
 * `DisposableStack.use(resource)` rejects them because
 * `resource[Symbol.dispose]` is undefined.
 *
 * Fix: detect literals carrying a `[Symbol.dispose]` or
 * `[Symbol.asyncDispose]` computed method and route them through the
 * JS-host plain-object path (`__new_plain_object` + `__extern_set`).
 * Computed method keys that resolve to well-known symbols are boxed via
 * `__box_symbol` so the disposer is installed under the *real* Symbol
 * property, not the wasm-internal "@@dispose" alias.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(source: string): Promise<{ success: boolean; result?: any; error?: string }> {
  const compiled = await compile(source, { fileName: "test.ts" });
  if (!compiled.success) return { success: false, error: compiled.errors[0]?.message };
  try {
    const imports = buildImports(compiled.imports, undefined, compiled.stringPool);
    const { instance } = await WebAssembly.instantiate(compiled.binary, imports);
    if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
    const ret = (instance.exports as any).test?.();
    return { success: true, result: ret };
  } catch (e: any) {
    return { success: false, error: `${e.constructor.name}: ${e.message}` };
  }
}

describe("Issue #1433: DisposableStack / AsyncDisposableStack lifecycle", () => {
  it("[Symbol.dispose] method is installed as a real JS function", async () => {
    const r = await compileAndRun(`
      export function test(): any {
        var resource: any = {
            [Symbol.dispose]() { return 42; }
        };
        return resource;
      }
    `);
    expect(r.success).toBe(true);
    expect(typeof r.result?.[Symbol.dispose]).toBe("function");
  });

  it("DisposableStack.use + dispose invokes Symbol.dispose with correct `this`", async () => {
    const r = await compileAndRun(`
      export function test(): number {
        var stack = new DisposableStack();
        var resource: any = {
            disposed: false,
            [Symbol.dispose]() {
                this.disposed = true;
            }
        };
        stack.use(resource);
        stack.dispose();
        return resource.disposed ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("DisposableStack disposes resources in LIFO order", async () => {
    // Order is enforced by the native host DisposableStack; we just verify
    // that two resources both fire and observe their relative ordering by
    // recording the order in a shared closure.
    const r = await compileAndRun(`
      export function test(): number {
        var stack = new DisposableStack();
        var order: number[] = [];
        var r1: any = { [Symbol.dispose]() { order.push(1); } };
        var r2: any = { [Symbol.dispose]() { order.push(2); } };
        stack.use(r1);
        stack.use(r2);
        stack.dispose();
        // LIFO: r2 disposed first, then r1
        if (order.length !== 2) return 0;
        if (order[0] !== 2) return 0;
        if (order[1] !== 1) return 0;
        return 1;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("DisposableStack.dispose is idempotent (does not re-invoke disposers)", async () => {
    const r = await compileAndRun(`
      export function test(): number {
        var stack = new DisposableStack();
        var count = 0;
        var r1: any = { [Symbol.dispose]() { count = count + 1; } };
        stack.use(r1);
        stack.dispose();
        stack.dispose();
        return count;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("[Symbol.asyncDispose] method is installed as a real JS function", async () => {
    const r = await compileAndRun(`
      export function test(): any {
        var resource: any = {
            [Symbol.asyncDispose]() { return Promise.resolve(); }
        };
        return resource;
      }
    `);
    expect(r.success).toBe(true);
    expect(typeof r.result?.[Symbol.asyncDispose]).toBe("function");
  });

  it("DisposableStack.disposed flips true after dispose()", async () => {
    const r = await compileAndRun(`
      export function test(): number {
        var stack = new DisposableStack();
        if (stack.disposed) return 0;
        stack.dispose();
        return stack.disposed ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("DisposableStack.move() transfers entries and disposes the new stack", async () => {
    const r = await compileAndRun(`
      export function test(): number {
        var stack = new DisposableStack();
        var disposed = 0;
        var resource: any = { [Symbol.dispose]() { disposed = disposed + 1; } };
        stack.use(resource);
        var moved = stack.move();
        // Original stack is now disposed (drained) and shouldn't fire the disposer.
        stack.dispose();
        if (disposed !== 0) return 0;
        // The moved stack still owns the resource; disposing it fires.
        moved.dispose();
        return disposed === 1 ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });
});
