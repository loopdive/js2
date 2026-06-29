import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2818 — Bug C (class-method half): a block-scoped `let`/`const` captured by a
// class method read back null. Root cause: the eager class-body compile pass
// (`compileClassesFromStatements` in declarations.ts) dropped its
// `insideFunction` flag when recursing into block / if / loop / switch / try /
// labeled statements, so a class nested in such a statement *inside a function*
// was compiled EAGERLY (as if module-level) instead of being deferred to
// `compileNestedClassDeclaration`. Eager compilation runs before the enclosing
// block-`let` initialises, so `promoteAccessorCapturesToGlobals` never fired and
// the method body resolved the captured name to the `ref.null.extern` fallback.
// Fix: propagate `insideFunction` through every control-flow recursion so the
// class is deferred and compiled in-scope (after the block-`let` runs).
async function run(source: string, fn = "test", args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn](...args);
}

describe("#2818 block-scoped let captured by a class method", () => {
  it("method reads the captured block-let (string)", async () => {
    expect(
      await run(`export function test(): string {
        { let s = "outer"; class C { m(): string { return s; } } return new C().m(); }
      }`),
    ).toBe("outer");
  });

  it("method reads the captured block-let (numeric)", async () => {
    expect(
      await run(`export function test(): number {
        { let n = 42; class C { m(): number { return n; } } return new C().m(); }
      }`),
    ).toBe(42);
  });

  it("arrow inside the method reaches the captured block-let", async () => {
    expect(
      await run(`export function test(): string {
        { let s = "outer"; class C { m(): string { const g = () => s; return g(); } } return new C().m(); }
      }`),
    ).toBe("outer");
  });

  it("generator method captures the block-let", async () => {
    expect(
      await run(`export function test(): number {
        { let n = 7; class C { *m() { yield n; yield n + 1; } }
          const it = new C().m(); return (it.next().value as number) + (it.next().value as number); }
      }`),
    ).toBe(15);
  });

  it("private method captures the block-let", async () => {
    expect(
      await run(`export function test(): string {
        { let s = "p"; class C { #m(): string { return s; } call(): string { return this.#m(); } }
          return new C().call(); }
      }`),
    ).toBe("p");
  });

  it("static method captures the block-let", async () => {
    expect(
      await run(`export function test(): string {
        { let s = "st"; class C { static m(): string { return s; } } return C.m(); }
      }`),
    ).toBe("st");
  });

  it("param-default referencing the block-let", async () => {
    expect(
      await run(`export function test(): number {
        { let base = 100; class C { m(x: number = base): number { return x; } } return new C().m(); }
      }`),
    ).toBe(100);
  });

  it("method observes a later mutation of the captured let (shared global)", async () => {
    expect(
      await run(`export function test(): number {
        { let n = 1; class C { m(): number { return n; } } const c = new C(); n = 5; return c.m(); }
      }`),
    ).toBe(5);
  });

  it("class in an if-block inside a function captures the block-let", async () => {
    expect(
      await run(`export function test(): number {
        if (1 > 0) { let bump = 10; class C { m(): number { return bump; } } return new C().m(); }
        return -1;
      }`),
    ).toBe(10);
  });

  it("class in a for-block inside a function captures the block-let", async () => {
    expect(
      await run(`export function test(): number {
        let acc = 0;
        for (let i = 0; i < 3; i++) { let bump = 10; class C { m(): number { return bump; } } acc += new C().m(); }
        return acc;
      }`),
    ).toBe(30);
  });

  // Regression control: fn-scope (non-block) capture must keep working (#1672).
  it("fn-scope let captured by a class method (control, unchanged)", async () => {
    expect(
      await run(`export function test(): string {
        let s = "outer"; class C { m(): string { return s; } } return new C().m();
      }`),
    ).toBe("outer");
  });
});
