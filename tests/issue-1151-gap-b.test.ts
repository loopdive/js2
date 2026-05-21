import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

// Issue #1151 Gap B: binding-pattern parameters without an explicit type
// annotation inferred to f64 (or some non-externref wasmType), causing the
// param-destructure dispatch to skip the null guard and silently produce
// uninitialized locals. The fix overrides wasmType to externref whenever
// the param's name is an Array/ObjectBindingPattern.
//
// Mirror sites in three files:
//   - src/codegen/closures.ts          (function-expression / arrow)
//   - src/codegen/class-bodies.ts      (class method)
//   - src/codegen/literals.ts          (object-literal method)
//
// Spec: ECMA-262 §14.3.3.1 BindingPattern : ObjectBindingPattern and
// §14.3.3.2 ArrayBindingPattern require throwing TypeError if the value is
// null/undefined before any property/element extraction.

describe("issue #1151 Gap B — binding-pattern param null guard", () => {
  it("function expression with array-binding pattern param throws on null", async () => {
    await assertEquivalent(
      `
      var f = function ([[x]]: any) { return 1; };
      export function callWithNull(): number {
        try { f([null]); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }
      }
      export function callWithValid(): number {
        try { return f([[42]]); } catch { return -1; }
      }
      `,
      [
        { fn: "callWithNull", args: [] },
        { fn: "callWithValid", args: [] },
      ],
    );
  });

  it("function expression with object-binding pattern param throws on null", async () => {
    await assertEquivalent(
      `
      var f = function ({ x }: any) { return 1; };
      export function callWithNull(): number {
        try { f(null); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }
      }
      export function callWithUndef(): number {
        try { f(undefined); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }
      }
      export function callWithValid(): number {
        try { f({ x: 7 }); return 1; } catch { return -1; }
      }
      `,
      [
        { fn: "callWithNull", args: [] },
        { fn: "callWithUndef", args: [] },
        { fn: "callWithValid", args: [] },
      ],
    );
  });

  it("async function with array-binding pattern param rejects on null", async () => {
    // For async functions, the synchronous TypeError at param destructure is
    // routed through the call-site try/catch wrapper (#1150) and surfaces as
    // a rejected Promise. We can't await Promises in the equivalence test
    // harness, but we can confirm the function does not trap and that the
    // returned value is a Promise.
    await assertEquivalent(
      `
      var f = async function ([[x]]: any) { return 1; };
      export function callShape(): number {
        var p: any = f([null]);
        // A Promise object is truthy; a thrown trap would propagate.
        return p && typeof p.then === "function" ? 1 : 0;
      }
      export function callShapeValid(): number {
        var p: any = f([[42]]);
        return p && typeof p.then === "function" ? 1 : 0;
      }
      `,
      [
        { fn: "callShape", args: [] },
        { fn: "callShapeValid", args: [] },
      ],
    );
  });

  it("object-literal method with array-binding pattern param throws on null", async () => {
    await assertEquivalent(
      `
      var o: any = { m([x]: any) { return 1; } };
      export function callWithNull(): number {
        try { o.m(null); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }
      }
      export function callWithValid(): number {
        try { return o.m([5]); } catch { return -1; }
      }
      `,
      [
        { fn: "callWithNull", args: [] },
        { fn: "callWithValid", args: [] },
      ],
    );
  });

  it("object-literal method with object-binding pattern param throws on undefined", async () => {
    await assertEquivalent(
      `
      var o: any = { m({ a }: any) { return 1; } };
      export function callWithUndef(): number {
        try { o.m(undefined); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }
      }
      export function callWithValid(): number {
        try { return o.m({ a: 3 }); } catch { return -1; }
      }
      `,
      [
        { fn: "callWithUndef", args: [] },
        { fn: "callWithValid", args: [] },
      ],
    );
  });
});
