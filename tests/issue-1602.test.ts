import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1602 — call-site argument coercion / method-closure trampolines emitted
 * invalid wasm. Three independent codegen bugs surfaced as
 * `WebAssembly.validate` failures ("call[N] expected externref, found ...").
 * Each `expect(WebAssembly.validate(...)).toBe(true)` is the regression guard:
 * before the fix these modules failed validation at the offending `call`.
 */
async function compileValid(source: string): Promise<Uint8Array> {
  const result = await compile(source, { fileName: "test.ts" });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  return result.binary;
}

describe("#1602 call-site argument coercion emits valid wasm", () => {
  it("new function(obj){...}({...null}) with an extern call in the body", async () => {
    // Bug A: the `new <FunctionExpression>(args)` call captured a stale lifted
    // func index — compiling the `{...null}` spread arg added late imports that
    // shifted every function index, but the `call` used the pre-shift value,
    // disagreeing with the already-shifted `ref.func`.
    await compileValid(`
      function asv(a: any, b: any): void {}
      export function test(): number {
        var callCount = 0;
        new function (obj) {
          asv(Object.keys(obj).length, 0);
          callCount += 1;
        }({ ...null });
        return callCount;
      }
    `);
  });

  it("sibling generator methods with default params in different positions", async () => {
    // Bug B: `{ *m(x = 42, y) {} }` (params [f64, externref]) and
    // `{ *m(x, y = 42) {} }` (params [externref, f64]) structurally dedupe to
    // the same method name and shared one funcMap entry. The second body
    // overwrote the func type, so the first method's value-closure trampoline
    // forwarded args in the wrong order. Each literal must get its own funcIdx.
    await compileValid(`
      export function test(): number {
        var f1 = ({ *m(x = 42) {} }).m;
        var f2 = ({ *m(x = 42, y) {} }).m;
        var f3 = ({ *m(x, y = 42) {} }).m;
        var f4 = ({ *m(x, y = 42, z) {} }).m;
        return (f1 ? 1 : 0) + (f2 ? 1 : 0) + (f3 ? 1 : 0) + (f4 ? 1 : 0);
      }
    `);
  });

  it("async object method accessed as a value", async () => {
    // Bug C: the method-as-closure trampoline body snapshotted the method
    // signature before it was finalized; rebuilding it against the final
    // signature after all bodies compiled keeps the forwarding consistent.
    await compileValid(`
      export function test(): number {
        var f = ({ async m() {} }).m;
        return f ? 1 : 0;
      }
    `);
  });

  it("the four object-method literals together compile to one valid module", async () => {
    await compileValid(`
      function asv(a: any, b: any): void {}
      export function test(): number {
        var a = ({ *m(x = 42) {} }).m;
        var b = ({ *m(x = 42, y) {} }).m;
        var c = ({ *m(x, y = 42) {} }).m;
        asv(a, b);
        asv(c, 0);
        return 1;
      }
    `);
  });

  it("multiple static-async class-method extractions are valid wasm", async () => {
    // Bug D: a class expression used as a value produced a bare `ref.func`
    // (funcref) for the constructor. funcref is not a subtype of
    // anyref/externref, so `(class {...}).f` member read fed the raw funcref
    // into `__extern_get` (externref param) — invalid module
    // ("call expected externref, found ref.func"). One extraction happened to
    // dead-code-eliminate clean; two or more left the funcref on the stack.
    await compileValid(`
      let x = "h";
      let f = class { static async f() {} }.f;
      let g = class { static async ["g"]() {} }.g;
      let h = class { static async [x]() {} }.h;
      export function test(): number { return 1; }
    `);
  });

  it("class-expression value passed directly as a call argument is valid wasm", async () => {
    await compileValid(`
      function use(v: any): void {}
      export function test(): number {
        use(class { m() {} });
        return 1;
      }
    `);
  });
});
