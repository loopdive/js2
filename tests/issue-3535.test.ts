/**
 * #3535 (#2860 F3) — standalone `(start)` top-level throws were unrenderable.
 *
 * Under the `(start)`-section init model, a top-level throw in a
 * `--target standalone` module surfaces out of `WebAssembly.instantiate`
 * with `instance === null`, so the #2962 native exception-render path
 * (`__exn_render_prepare` / `__exn_render_char`, which needs a live
 * instance) is unreachable and every runtime failure collapses onto the
 * opaque "wasm exception during module init" label (~8,600 baseline rows).
 *
 * The fix: the standalone test262 lane compiles with
 * `deferTopLevelInit: true` (same rule the host lane adopted in #3049 C1 /
 * #3123): `__module_init` is exported instead of wired to `(start)`, the
 * runner instantiates, then calls it explicitly — a top-level throw now
 * happens with a live instance and renders its real signature.
 *
 * This test pins the compiler contract the fix depends on, end to end:
 *   1. standalone + deferTopLevelInit emits a host-free binary that
 *      EXPORTS `__module_init` and does NOT run top-level code at
 *      instantiate time;
 *   2. calling `__module_init()` raises the top-level throw as a
 *      `WebAssembly.Exception` whose payload renders through the module's
 *      own `__exn_render_prepare`/`__exn_render_char` exports to the real
 *      error text ("TypeError: boom"), not an opaque label.
 * Plus a structural drift-guard on the worker's lane rule.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// NOTE: not a bare `throw new TypeError("boom")` — a throw-only top level is
// currently dropped entirely in standalone (#3468 "Bug 2": empty module, no
// init), which would vacuously pass/fail these assertions. The conditional
// throw over a live binding survives codegen and provably runs.
const THROWING_SOURCE = 'var obj = {};\nif (!obj.m) { throw new TypeError("boom"); }\nvar keep = obj;\n';

describe("#3535 standalone deferTopLevelInit renders top-level throws (#2860 F3)", () => {
  it("defers init to an exported __module_init and renders the real throw signature", async () => {
    const result = await compile(THROWING_SOURCE, {
      allowJs: true,
      fileName: "test.js",
      skipSemanticDiagnostics: true,
      target: "standalone",
      hostBridge: "always",
      deferTopLevelInit: true,
    });
    expect(result.success).toBe(true);
    // Host-free: the standalone #2961 gate must still hold under defer.
    expect(result.imports).toHaveLength(0);

    const importObj = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
    // (1) Instantiate must NOT throw — top-level code is deferred, not in (start).
    const { instance } = await WebAssembly.instantiate(result.binary, importObj as WebAssembly.Imports);
    const exports = instance.exports as Record<string, unknown>;
    const moduleInit = exports.__module_init;
    expect(typeof moduleInit).toBe("function");

    // (2) The explicit init call raises the throw with a LIVE instance…
    let thrown: unknown;
    try {
      (moduleInit as () => void)();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WebAssembly.Exception);

    // …so the #2962 render path is reachable and yields the real signature.
    const tag = (exports.__exn_tag ?? exports.__tag) as WebAssembly.Tag;
    expect(tag).toBeDefined();
    const payload = (thrown as WebAssembly.Exception).getArg(tag, 0);
    const prep = exports.__exn_render_prepare as (p: unknown) => number;
    const chr = exports.__exn_render_char as (i: number) => number;
    expect(typeof prep).toBe("function");
    expect(typeof chr).toBe("function");
    const len = prep(payload);
    expect(len).toBeGreaterThan(0);
    let rendered = "";
    for (let i = 0; i < len; i++) rendered += String.fromCharCode(chr(i));
    expect(rendered).toContain("TypeError");
    expect(rendered).toContain("boom");
  });

  it("standalone without deferTopLevelInit keeps the (start) model (non-test262 embedders unchanged)", async () => {
    const result = await compile(THROWING_SOURCE, {
      allowJs: true,
      fileName: "test.js",
      skipSemanticDiagnostics: true,
      target: "standalone",
      hostBridge: "always",
    });
    expect(result.success).toBe(true);
    const importObj = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
    let instantiateThrew = false;
    try {
      await WebAssembly.instantiate(result.binary, importObj as WebAssembly.Imports);
    } catch {
      instantiateThrew = true;
    }
    expect(instantiateThrew).toBe(true);
  });

  it("worker lane rule: standalone joins the deferTopLevelInit arm (drift guard)", () => {
    const worker = readFileSync("scripts/test262-worker.mjs", "utf8");
    // The doCompile defer rule must exclude only NON-standalone targets
    // (wasi/linear) from the defer arm — i.e. standalone defers like host.
    expect(worker).toContain('(target && target !== "standalone") || (!originalHarness && inferModuleStrictArguments)');
  });
});
