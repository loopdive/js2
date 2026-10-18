// #6990 — out-of-line live-binding calls in eval-consuming standalone modules.
//
// Every top-level function call in a module that links the runtime-eval
// provider used to inline a live-binding read + dynamic dispatch (~375 WAT
// lines, ~8 locals per call). Eligible calls are now plain direct calls
// retargeted at finalize to a per-callee trampoline that calls the
// declaration until the provider is first entered, and goes live after.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import {
  computeCompilerBundleHash,
  defaultRuntimeEvalProviderCacheDir,
  instantiateRuntimeEvalNamespace,
  runtimeEvalProviderCacheKey,
  selectCachedRuntimeEvalProvider,
} from "../scripts/runtime-eval-provider.mjs";
import {
  buildQuickjsAdapterSource,
  quickjsAdapterCachePath,
  quickjsArtifactCacheDir,
  quickjsArtifactCacheKey,
  readQuickjsArtifact,
} from "../scripts/quickjs-eval-provider.mjs";

const RUNTIME_EVAL_IMPORT_MODULE = "js2wasm:runtime-eval";

function quickjsProviderAvailable(): boolean {
  try {
    const cacheDir = defaultRuntimeEvalProviderCacheDir();
    const artifactDir =
      process.env.JS2WASM_QUICKJS_ARTIFACT_DIR ?? quickjsArtifactCacheDir(cacheDir, quickjsArtifactCacheKey());
    const artifact = readQuickjsArtifact(artifactDir);
    if (!artifact) return false;
    const key = runtimeEvalProviderCacheKey(buildQuickjsAdapterSource(artifact.abi), computeCompilerBundleHash());
    return existsSync(quickjsAdapterCachePath(cacheDir, key));
  } catch {
    return false;
  }
}

const OPTIONS = {
  fileName: "live.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  target: "standalone" as const,
  inferModuleStrictArguments: false,
};

/** Body text of `(func $<name> …)` in the module's WAT. */
function funcWat(wat: string, name: string): string {
  const m = wat.match(new RegExp(`\\(func \\$${name} [\\s\\S]*?\\n  \\)\\n`));
  return m ? m[0] : "";
}

describe("#6990 live-call trampoline — codegen shape", () => {
  it("a call site in an eval-consuming module no longer inlines the live read", async () => {
    const src = `function emit(a){ return a + 1; }
function g(){ var s = 0; s = emit(s); s = emit(s); s = emit(s); return s; }
function fl(n){ eval(n); }
export function run(){ return g(); }`;
    const r = await compile(src, { ...OPTIONS, emitWat: true });
    expect(r.success).toBe(true);
    const g = funcWat(r.wat ?? "", "g");
    expect(g).not.toBe("");
    expect(g).not.toContain("__runtime_eval_dynamic_global_obj");
    expect(g).not.toContain("__bare_prev_this");
    expect(r.wat).toContain("__runtime_eval_live_call_emit");
  });
});

describe.skipIf(!quickjsProviderAvailable())("#6990 live-call trampoline — semantics", () => {
  async function run(src: string): Promise<unknown> {
    const r = await compile(src, OPTIONS);
    expect(r.success).toBe(true);
    const module = new WebAssembly.Module(r.binary!);
    const sel = selectCachedRuntimeEvalProvider() as { bundle?: unknown; module?: unknown };
    const imports = WebAssembly.Module.imports(module).length
      ? { [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(sel.bundle ?? sel.module) }
      : {};
    const instance = new WebAssembly.Instance(module, imports);
    return (instance.exports as { run: () => unknown }).run();
  }

  it("before any eval runs, calls reach the declaration", async () => {
    expect(
      await run(`function emit(a){ return a + 1; } function fl(n){ eval(n); }
export function run(){ return emit(emit(0)); }`),
    ).toBe(2);
  });

  it("an indirect eval that redefines the function is observed by later calls", async () => {
    expect(
      await run(`function emit(a){ return a + 1; } function g(){ return emit(1); }
export function run(){ var x = g(); (0,eval)("function emit(a){ return a + 100; }"); return x * 1000 + g(); }`),
    ).toBe(2101);
  });

  it("a direct global eval that redefines the function is observed", async () => {
    expect(
      await run(`function emit(a){ return a + 1; } function g(){ return emit(1); }
var r1 = g(); eval("function emit(a){ return a + 100; }"); var r2 = g();
export function run(){ return r1 * 1000 + r2; }`),
    ).toBe(2101);
  });

  it("an assignment from evaluated code is observed", async () => {
    expect(
      await run(`function emit(a){ return a + 1; } function g(){ return emit(1); }
export function run(){ (0,eval)("emit = function(a){ return a + 7; }"); return g(); }`),
    ).toBe(8);
  });

  it("void and mixed-type signatures round-trip through the trampoline", async () => {
    expect(
      await run(`var c = 0; function bump(){ c++; } function mix(a, b, s){ return a * b + s.length; }
function fl(n){ eval(n); }
export function run(){ bump(); bump(); return c * 100 + mix(2.5, 4, "abc"); }`),
    ).toBe(213);
  });
});
