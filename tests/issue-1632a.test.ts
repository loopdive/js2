import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #1632a — Function.prototype.bind via __bind_function host import.
//
// Spec §20.2.3.2 / §10.4.1 (Bound Function Exotic Objects):
//   * .name === "bound " + target.name
//   * .length === max(0, target.length - boundArgs.length)
//   * [[Call]] / [[Construct]] prepend [[BoundArguments]]
//
// The compiler delegates to the host's `Function.prototype.bind` so all of
// the above are owned by the engine. The codegen layer is responsible for
// (a) routing to __bind_function, (b) passing the partial args as a JS Array,
// and (c) supplying nameHint / lengthHint for Wasm closure targets.
//
// Only fires when the TS checker resolves the receiver's type to have call
// signatures (preserves the legacy "throws on non-function receiver" path
// that test262 expects on JSON.bind, Math.bind, etc.).
describe("#1632a Function.prototype.bind — bound-function via host", () => {
  it("bound function .length is 0 when boundArgs exceed target.length", async () => {
    const exports = await compileToWasm(`
      function target(a: number): number { return a; }
      export function test(): any {
        return target.bind(undefined, 1, 2, 3).length;
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("bind preserves immediate-call shape (fn.bind(null)(arg) reduces statically)", async () => {
    const exports = await compileToWasm(`
      function double(a: number): number { return a * 2; }
      export function test(): any {
        return double.bind(null)(21);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("bind result is a real JS function (typeof === 'function')", async () => {
    const exports = await compileToWasm(`
      function id(a: number): number { return a; }
      export function test(): any {
        return typeof id.bind(undefined);
      }
    `);
    expect(exports.test()).toBe("function");
  });

  it("bound function with no partial args carries target length unchanged", async () => {
    const exports = await compileToWasm(`
      function target(a: number, b: number, c: number): number { return a + b + c; }
      export function test(): any {
        return target.bind(undefined).length;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("non-callable receiver (JSON.bind) preserves the legacy 'not a function' throw", async () => {
    // JSON is a host object whose `.bind` property is undefined under the
    // TS lib types; the bind guard sees no callsigs on the receiver and falls
    // through to the legacy path, which throws TypeError on the call.
    const exports = await compileToWasm(`
      export function test(): any {
        try {
          (JSON as any).bind();
          return "no-throw";
        } catch (e: any) {
          return "threw";
        }
      }
    `);
    expect(exports.test()).toBe("threw");
  });

  // Spec-correct .name ("bound " + target.name) and .length recomputation
  // both work in isolation but the standalone test262 conformance runner is
  // what validates the full set (the in-process vitest harness loads many
  // tests in sequence and re-instantiates modules; metadata-read on bind
  // result interacts with the runtime's import resolver state in a way that
  // isn't fully reset between modules — out of scope for this fix).
  //
  // Invoking the bound function via `const b = fn.bind(...); b(arg)` requires
  // the externref-callable invocation infrastructure tracked by #1596
  // (Function.prototype.apply/.call). The immediate-call shape above is the
  // one form that works without that.
  it.skip("[gated on #1596] calling a bound function prepends [[BoundArguments]] to the call", async () => {
    const exports = await compileToWasm(`
      function add(a: number, b: number, c: number): number { return a + b + c; }
      export function test(): any {
        const bound: any = add.bind(undefined, 10, 20);
        return bound(30);
      }
    `);
    expect(exports.test()).toBe(60);
  });
});
