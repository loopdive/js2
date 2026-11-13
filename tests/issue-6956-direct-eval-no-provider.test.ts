// #6956 — standalone with `runtimeEvalProvider: false`: a direct `eval(src)`
// with a non-constant source still imported
// `js2wasm:runtime-eval.{__runtime_direct_eval,__runtime_apply_interpreted}`
// (only `Function(...)` was refused, #6676), so a module that merely CONTAINS
// such a call (Octane earley-boyer's never-called `sc_jsNew`) could not
// instantiate. With no provider the call now throws a catchable EvalError
// in-module, only when the source is a string (§19.2.1.1 PerformEval returns a
// non-string argument unchanged), and nothing is imported. Without the option
// the provider imports are unchanged (control).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SOURCE = `
function sc_jsNew(c) {
  var evalStr = ["new c(", ")"].join("");
  return eval(evalStr);
}
function dyn(src) { return eval(src); }
function indirect(src) { return (0, eval)(src); }
function classify(f) {
  try { f(); return 0; } catch (e) { return e instanceof EvalError ? 1 : 2; }
}
export function alive() { return typeof sc_jsNew === "function" ? 1 : 0; }
export function jsNewForm() { return classify(function () { return sc_jsNew(Object); }); }
export function directForm() { return classify(function () { return dyn("1 + 1"); }); }
export function indirectForm() { return classify(function () { return indirect("1 + 1"); }); }
export function nonStringNumber() { return dyn(42); }
export function nonStringObject() { var o = {}; return dyn(o) === o ? 1 : 0; }
export function noArgument() { return eval() === undefined ? 1 : 0; }
export function argsEvaluatedFirst() {
  var seen = 0;
  var src = ["x", "y"].join("");
  try { eval((seen = 1, src)); } catch (e) { return seen === 1 && e instanceof EvalError ? 1 : 2; }
  return 3;
}
export function constantFolds() { return eval("1 + 1"); }
`;

async function compileStandalone(extra: Record<string, unknown>) {
  const result = await compile(SOURCE, {
    fileName: "main.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    inferModuleStrictArguments: false,
    ...extra,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  return { module, imports: WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`) };
}

describe("#6956 — standalone direct eval without a runtime-eval provider", () => {
  it("runtimeEvalProvider: false — zero imports, string sources throw EvalError", async () => {
    const { module, imports } = await compileStandalone({ runtimeEvalProvider: false });
    expect(imports).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    const ex = instance.exports as Record<string, (...args: unknown[]) => unknown>;
    expect(ex.alive()).toBe(1);
    expect(ex.jsNewForm()).toBe(1);
    expect(ex.directForm()).toBe(1);
    expect(ex.indirectForm()).toBe(1);
    expect(ex.nonStringNumber()).toBe(42);
    expect(ex.nonStringObject()).toBe(1);
    expect(ex.noArgument()).toBe(1);
    expect(ex.argsEvaluatedFirst()).toBe(1);
    expect(ex.constantFolds()).toBe(2);
  });

  it("without the option the provider imports are still emitted (control)", async () => {
    const { imports } = await compileStandalone({});
    expect(imports).toContain("js2wasm:runtime-eval.__runtime_direct_eval");
  });
});
