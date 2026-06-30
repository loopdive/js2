import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2886 — `new <global-non-constructor-builtin>()` must throw a real TypeError.
//
// The global builtin FUNCTIONS decodeURI / decodeURIComponent / encodeURI /
// encodeURIComponent / parseInt / parseFloat / isNaN / isFinite are ordinary
// built-in function objects that do NOT implement [[Construct]] (ECMA-262
// §19.2). Per §13.3.5.1 EvaluateNew step 5, `new <fn>()` must throw a TypeError
// because IsConstructor(fn) is false.
//
// Before the fix, these identifiers fell through the `new`-expression dispatch
// to the unknown-constructor path and were mis-routed to an `extern_class` host
// import, which throws a BARE `Error: No dependency provided for extern class
// "decodeURI"` at runtime — not a TypeError. The Sputnik tests
// `built-ins/{decodeURI,decodeURIComponent,encodeURI,encodeURIComponent}/
// S15.1.3.*_A5.7.js` and `built-ins/parseFloat/S15.1.2.3_A7.7.js` strictly check
// `e instanceof TypeError`, so they failed.

async function run(source: string, fn = "test", args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!(...args);
}

// Returns 1 if `new <name>()` throws a TypeError, 2 if it throws something else,
// 0 if it does not throw — mirrors the Sputnik S15.1.*_A5.7 / A7.7 shape.
const NEW_THROWS_TYPEERROR = (name: string) =>
  `export function test(): number {
     var caught = 0;
     try { new ${name}(); caught = 0; }
     catch (e) { if ((e instanceof TypeError) === true) caught = 1; else caught = 2; }
     return caught;
   }`;

const GLOBAL_NON_CONSTRUCTORS = [
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
];

describe("#2886 new <global-non-constructor-builtin>() throws TypeError", () => {
  for (const name of GLOBAL_NON_CONSTRUCTORS) {
    it(`new ${name}() throws a TypeError instance`, async () => {
      expect(await run(NEW_THROWS_TYPEERROR(name))).toBe(1);
    });
  }

  // The ordinary CALL form must keep working — only `new` is rejected.
  it("decodeURI(...) call still decodes", async () => {
    expect(await run(`export function test(): string { return decodeURI("abc%20def"); }`)).toBe("abc def");
  });
  it("encodeURIComponent(...) call still encodes", async () => {
    expect(await run(`export function test(): string { return encodeURIComponent("a b"); }`)).toBe("a%20b");
  });
  it("parseInt(...) call still parses", async () => {
    expect(await run(`export function test(): number { return parseInt("42"); }`)).toBe(42);
  });

  // Regression control: a USER-DEFINED function shadowing a global name IS
  // constructable; `new <shadow>()` must run the user constructor, not throw.
  it("user-defined shadow `function parseInt(){ this.x = 7 }` stays constructable", async () => {
    const src = `function parseInt(this: any) { this.x = 7; }
      export function test(): number { var o: any = new parseInt(); return o.x; }`;
    expect(await run(src)).toBe(7);
  });
  it("user-defined shadow `function isNaN(){ this.x = 9 }` stays constructable", async () => {
    const src = `function isNaN(this: any) { this.x = 9; }
      export function test(): number { var o: any = new isNaN(); return o.x; }`;
    expect(await run(src)).toBe(9);
  });
});
