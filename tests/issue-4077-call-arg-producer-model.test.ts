import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #4077 — `fixupExternConvertAny`'s call-argument repair paired arguments with
// the WRONG parameters, and then retyped a `null` argument with a neighbouring
// parameter's GC type.
//
// The pass rewrites `ref.null.extern` into `ref.null $T` when the parameter it
// feeds is a GC ref. To find "the instruction that produces argument i" it
// walked BACKWARD from the call assuming one instruction == one argument, with
// a hand-maintained exception list (`local.tee`, `struct.new`,
// `array.new_fixed`, `call`). Every stack-neutral op missing from that list
// burned a parameter index and shifted the whole pairing by one.
//
// `extern.convert_any` — emitted on essentially every boxed argument — was
// missing. For `f({}, "length", null, function () { … })` codegen emits
//
//     call $objlit ; global.get $str ; ref.null.extern ;
//     ref.func ; i32.const ; i32.const ; struct.new $closure ;
//     extern.convert_any ; call $f
//
// The walk consumed param 3 on `extern.convert_any`, param 2 on `struct.new`,
// and then handed the `ref.null.extern` (argument 2, an `externref` parameter)
// to param **1**, a `(ref null $AnyString)`. It rewrote the null to a
// string-typed null and the module stopped validating:
//
//     call[2] expected type externref, found ref.null of type (ref null 6)
//
// That kills the module during instantiation, so a test262 file hitting it
// loses 100% of its assertions rather than one. Measured on the standalone
// lane: 28 ES5-scope files, all of the `verifyNotWritable(obj, name, null, fn)`
// shape.
//
// Adding one more op to the exception list would not have fixed the class —
// `f(null, a + b)` mis-paired too, and always had. The fix models the operand
// stack for real (a forward pass carrying a producer index per stack slot), so
// argument attribution is exact rather than pattern-matched.

async function compileStandalone(source: string) {
  const result = await compile(source, {
    allowJs: true,
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  if (!result.success || result.errors.some((e) => e.severity === "error")) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  return result.binary;
}

// The reduced form of test262's `verifyNotWritable(obj, name, null, fn)`: a
// four-argument call whose 3rd argument is `null` and whose 4th is a function
// expression (which compiles to `struct.new` + `extern.convert_any`).
const NULL_ARG_BEFORE_CLOSURE_ARG = `
function g(obj, name, verifyProp) {
  return !!verifyProp;
}
function f(obj, name, verifyProp, value) {
  if (g(obj, name, verifyProp)) {
    return 2;
  }
  return 3;
}
var result = f({}, "length", null, function () {
  return "shifted";
});
`;

describe("#4077 — call-argument producer attribution is exact", () => {
  it("a null argument followed by a closure argument still validates", async () => {
    const binary = await compileStandalone(NULL_ARG_BEFORE_CLOSURE_ARG);
    // Before the fix this was `false`: the null had been retyped to the
    // *string* parameter's type and V8 rejected the module.
    expect(WebAssembly.validate(binary)).toBe(true);
    await expect(WebAssembly.instantiate(binary, {})).resolves.toBeDefined();
  });

  // Validation alone is not correctness — a module can instantiate and still
  // compute the wrong thing. `verifyProp` is `null`, so `g` returns false and
  // `f` must return 3. If the null argument were mis-delivered to another
  // parameter slot the value would change.
  it("the null argument still arrives in the right parameter (value check)", async () => {
    const binary = await compileStandalone(`${NULL_ARG_BEFORE_CLOSURE_ARG}
export function probe(): number {
  return f({}, "length", null, function () {
    return "shifted";
  });
}
`);
    const { instance } = await WebAssembly.instantiate(binary, {});
    const exports = instance.exports as Record<string, CallableFunction>;
    exports.__module_init?.();
    expect(exports.probe!()).toBe(3);
  });

  // The mirror case the old exception list could never have handled: the null
  // is the FIRST argument and a binary operation (pop 2 / push 1) produces a
  // later one. The backward walk stepped into `f64.add`'s own operands and
  // never reached the null at all.
  it("a null argument BEFORE an arithmetic argument validates and evaluates", async () => {
    const binary = await compileStandalone(`
function h(a, b, c) {
  if (a) {
    return 0;
  }
  return b + c;
}
export function probe(): number {
  return h(null, "x", 1 + 2);
}
`);
    expect(WebAssembly.validate(binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(binary, {});
    const exports = instance.exports as Record<string, CallableFunction>;
    exports.__module_init?.();
    // `a` is null (falsy) so we take the `b + c` branch: "x" + 3 → "x3",
    // whose numeric coercion is NaN. What matters is that `null` landed in
    // `a` and NOT in `b`; if it had, `b + c` would be 3 rather than NaN.
    expect(Number.isNaN(exports.probe!() as number)).toBe(true);
  });
});
