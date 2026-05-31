import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1690 — for-loop condition/incrementor buffers were detached from any
 * walker-reachable location for the window between when they're compiled and
 * when they're spliced into the assembled loop body. Body compilation often
 * triggers `addStringConstantGlobal` (e.g., a null-check error message),
 * which shifts module-global indices and updates the moduleGlobals map.
 * Because the cond/incr buffers were unreachable, their `global.get`/`global.set`
 * indices were left stale-low, so a later read of a module-global variable
 * (`__mod_i`, `__mod_list`, etc.) silently pointed at the global that
 * USED to occupy that slot — frequently a `(ref null N)` array global where an
 * f64 was expected, producing invalid Wasm at `f64.lt`/`f64.add` consumers.
 *
 * This surfaced compiling acorn.mjs (#1690 issue file) with the error
 *   "f64.lt[0] expected type f64, found global.get of type (ref null N)"
 * inside `isInAstralSet`. Reduced to a minimal repro: a top-level
 * `for (var i = 0, list = [...]; ...)` registers `i` and `list` as module
 * globals, then a function-local `for (var i = 0; i < set.length; ...)` whose
 * body emits null-check errors triggers the shift mid-loop.
 *
 * Fix: register the temporary cond/incr buffers in `ctx.liveBodies` for the
 * window they sit outside `fctx.body`, and have `fixupModuleGlobalIndices`
 * walk `liveBodies` (parallel to the existing function-index shift walker).
 */
describe("#1690 — for-loop global-index shift during body compilation", () => {
  it("minimal repro: function-local for-loop after top-level for-loop", async () => {
    const src = [
      "for (var i = 0, list = [1, 2, 3]; i < list.length; i += 1) {",
      "  var x = list[i];",
      "}",
      "",
      "function f(set) {",
      "  var pos = 0;",
      "  for (var i = 0; i < set.length; i += 2) {",
      "    pos += set[i];",
      "    if (pos > 10) return false;",
      "    pos += set[i + 1];",
      "    if (pos >= 20) return true;",
      "  }",
      "  return false;",
      "}",
    ].join("\n");

    const r = await compile(src, { fileName: "issue-1690.mjs" });
    expect(r.success).toBe(true);
    expect(r.binary).toBeDefined();
    // The smoking-gun assertion — the bug manifested as an invalid Wasm
    // module that compile() accepted (success=true) but WebAssembly.compile
    // rejected. The fix must keep WebAssembly.compile happy.
    return WebAssembly.compile(r.binary as BufferSource).then((mod) => {
      expect(mod).toBeDefined();
    });
  });

  it("incrementor expression with module-global aliasing", async () => {
    // Variant covering the `incrInstrs` half of the fix: the incrementor
    // buffer is also detached during cond+body compilation.
    const src = [
      "var counter = 0;",
      "for (var i = 0; i < 3; i = i + 1) { counter = counter + 1; }",
      "",
      "function g(arr) {",
      "  var sum = 0;",
      "  for (var i = 0; i < arr.length; i += 1) {",
      "    sum += arr[i];",
      "    if (sum > 100) return -1;",
      "  }",
      "  return sum;",
      "}",
    ].join("\n");

    const r = await compile(src, { fileName: "issue-1690b.mjs" });
    expect(r.success).toBe(true);
    return WebAssembly.compile(r.binary as BufferSource).then((mod) => {
      expect(mod).toBeDefined();
    });
  });

  it("do-while condition buffer follows the same fix", async () => {
    // The same detached-buffer pattern exists in compileDoWhileStatement
    // (the cond is compiled into a fresh array, then spliced after the
    // body). This variant exercises that path.
    const src = [
      "var moduleI = 0;",
      "var moduleList = [1, 2, 3];",
      "",
      "function h(set) {",
      "  var i = 0;",
      "  var sum = 0;",
      "  do {",
      "    sum += set[i];",
      "    i += 1;",
      "  } while (i < set.length);",
      "  return sum;",
      "}",
    ].join("\n");

    const r = await compile(src, { fileName: "issue-1690c.mjs" });
    expect(r.success).toBe(true);
    return WebAssembly.compile(r.binary as BufferSource).then((mod) => {
      expect(mod).toBeDefined();
    });
  });
});
