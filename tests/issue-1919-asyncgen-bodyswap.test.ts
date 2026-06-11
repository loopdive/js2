// #1919 slice 3 — async-gen i64 (~230) + truthiness if[0] (~150) standalone
// invalid-Wasm sub-buckets.
//
// Root cause: the generator lowering (compileNestedFunctionDeclaration,
// literals.ts generator methods, closures.ts function-expression generators)
// and the param-destructure branch builders (destructuring-params.ts) swapped
// fctx.body with a raw local-variable swap. While the inner buffer compiled,
// the OUTER body — param-default / destructure-guard calls whose funcIdx
// values were already baked — was reachable only through a local variable,
// so a late import ensured inside the window (e.g. __get_undefined,
// __array_from_iter_n) ran shiftLateImportIndices without repairing it:
// every baked call in the prologue ended one slot low per missed flush.
// The validator names the bystander callee (call[0] expected i64 →
// __box_bigint; if[0] expected i32 → an externref-returning neighbor of
// __extern_is_undefined), which is why the bucket masqueraded as an
// async-generator i64 ABI problem.
//
// Fix: pushBody/popBody (generator sites) and pushBodyTo (destructure branch
// buffers) register the outgoing body on fctx.savedBodies, which every shift
// walker covers.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string, target?: "standalone") {
  const res = (await compile(source, {
    target,
    skipSemanticDiagnostics: true,
  } as never)) as never as {
    success: boolean;
    binary: Uint8Array;
    imports: unknown[];
    stringPool: string[];
    errors?: { message: string }[];
  };
  expect(res.success, res.errors?.map((e) => e.message).join("; ")).toBe(true);
  const importObj = buildImports(res.imports ?? [], undefined, res.stringPool) as never as Record<string, unknown> & {
    setExports?: (e: unknown) => void;
  };
  // Must not throw "WebAssembly.instantiate(): Compiling function ... failed"
  const { instance } = await WebAssembly.instantiate(res.binary, importObj as never);
  if (typeof importObj.setExports === "function") importObj.setExports(instance.exports);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#1919 slice 3: generator/destructure body-swap late-import skew", () => {
  // if[0] flavor: nested async generator with array-pattern param + default.
  // The param prologue bakes call __extern_is_undefined; compiling the
  // generator body ensures __get_undefined (a late import). With the raw
  // swap the baked call missed the flush → `if[0] expected i32, found call
  // of type externref` at instantiate.
  const arrayPatternSrc = `
    export function test(): number {
      var values = [2, 3];
      var sum = 0;
      async function* f([...x] = values) {
        sum = x[0] + x[1];
        yield 1;
      }
      f();
      return sum + 1;
    }
  `;

  // i64 flavor: object pattern containing an array pattern (trailing comma).
  // The nested array destructure ensures __array_from_iter_n while the outer
  // object-destructure branch buffer is active; the outer prologue's baked
  // __new_TypeError / __extern_is_undefined calls missed two flushes →
  // `call[0] expected i64` (lands on __box_bigint) at instantiate.
  const objectPatternSrc = `
    export function test(): number {
      var got = 0;
      async function* f({ x: [y], }: { x: number[] }) {
        got = y;
        yield 1;
      }
      f({ x: [45] });
      return got >= 0 ? 1 : 0;
    }
  `;

  it("standalone: async-gen array-pattern default param instantiates and runs", async () => {
    expect(await compileAndRun(arrayPatternSrc, "standalone")).toBe(1);
  });

  it("standalone: async-gen object-pattern-with-array param instantiates and runs", async () => {
    expect(await compileAndRun(objectPatternSrc, "standalone")).toBe(1);
  });

  it("host-mode guard: both shapes stay valid on the default path", async () => {
    // Call f with an explicit argument: the no-arg default-param call hits a
    // pre-existing host-mode bug (caller pads with ref.null, default doesn't
    // fire — #1021/#1025 family; throws "Cannot destructure" on main too).
    // This guard only asserts the codegen of these shapes stays VALID on the
    // host path — instantiate + run must not hit a validation error.
    expect(await compileAndRun(arrayPatternSrc.replace("f();", "f([2, 3]);"))).toBe(6);
    expect(await compileAndRun(objectPatternSrc)).toBe(1);
  });
});
