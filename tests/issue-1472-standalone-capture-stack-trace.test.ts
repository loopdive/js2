// #1472 — tailwindcss's `CssSyntaxError` constructor runs
// `Error.captureStackTrace && Error.captureStackTrace(this, e)`. `Error` is in
// BUILTIN_CLASS_NAMES for the JS-host lane, whose generic static-method arm
// resolves the receiver through `__get_builtin("Error")` — a host import
// `--target standalone` refuses, which refused the whole tailwindcss graph.
// A host-free realm's native error constructors have no V8
// `captureStackTrace`: the read is `undefined` (the guard short-circuits) and
// an unguarded call throws TypeError after its arguments are evaluated.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string) {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
    fileName: "main.js",
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, () => number>;
}

describe("#1472 — `Error.captureStackTrace(...)` under --target standalone", () => {
  it("tailwindcss's guarded CssSyntaxError constructor compiles host-free and runs", async () => {
    const exports = await run(`
class CssSyntaxError extends Error {
  constructor(m) {
    super(m);
    this.name = "CssSyntaxError";
    Error.captureStackTrace && Error.captureStackTrace(this, CssSyntaxError);
  }
}
/** @returns {number} */
export function guarded() {
  try {
    var e = new CssSyntaxError("boom");
    return e.message === "boom" && e.name === "CssSyntaxError" && e instanceof Error ? 1 : 2;
  } catch (e) { return 3; }
}
/** @returns {number} */
export function absent() { return typeof Error.captureStackTrace === "undefined" ? 1 : 0; }
`);
    expect(exports.guarded()).toBe(1);
    expect(exports.absent()).toBe(1);
  });

  it("an unguarded call throws TypeError after evaluating its arguments", async () => {
    const exports = await run(`
/** @returns {number} */
export function direct() {
  var n = 0;
  try { Error.captureStackTrace({}, n++); return 10; }
  catch (e) { return (e instanceof TypeError ? 1 : 2) + (n === 1 ? 0 : 20); }
}
/** @returns {number} */
export function subclassCtor() {
  try { RangeError.captureStackTrace({}); return 10; }
  catch (e) { return e instanceof TypeError ? 1 : 2; }
}
`);
    expect(exports.direct()).toBe(1);
    expect(exports.subclassCtor()).toBe(1);
  });

  it("control: a user-declared `Error` binding keeps its own captureStackTrace", async () => {
    const exports = await run(`
var Error = { captureStackTrace: function (o) { o.tagged = 7; } };
/** @returns {number} */
export function test() { var o = {}; Error.captureStackTrace(o); return o.tagged; }
`);
    expect(exports.test()).toBe(7);
  });
});
