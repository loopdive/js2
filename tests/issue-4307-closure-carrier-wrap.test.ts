// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4307 — caller-side carrier-wrap for closure VALUES.
 *
 * #4245 slice 1 made a compiled top-level function DECLARATION callable from
 * evaluated code, because `__module_init` seeds its module global with the
 * #2928 AOT-callable carrier. A closure *value* — `var f = function () {…}`,
 * an arrow assigned to a `var`, a local closure reached by direct eval — is not
 * a declaration and never met that adapter, so it crossed the seam as a raw
 * module-local closure struct: `typeof` answered "object" and calling it was a
 * TypeError inside evaluated code.
 *
 * This lane pins the two halves of the fix and, just as importantly, the AOT
 * side that MUST NOT regress: once a binding holds a carrier, the compiled
 * module still calls it, still classifies it as a function, and two names for
 * one closure are still `===` inside evaluated code.
 *
 * SELF-GATING like the other quickjs lanes: default CI has no clang toolchain,
 * so this file skips unless a built provider is already reachable.
 *
 * Anti-vacuity, inherited from #4238/#4245 and applied to every case:
 *  1. Every eval source is composed through a runtime loop — an all-literal
 *     argument is constant-folded and evaluated at COMPILE time by
 *     `tryStaticEvalInline`, which would make these assertions pass with the
 *     seam entirely dead.
 *  2. Every expectation is a value only the COMPILED body can produce (an odd
 *     `x * 2 + 1`, an `x + 41`), never something any evaluator could invent.
 */
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

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
const ENGINE_ENV = "JS2WASM_EVAL_ENGINE";

function quickjsProviderAvailable(): string | null {
  try {
    const cacheDir = defaultRuntimeEvalProviderCacheDir();
    const artifactDir =
      process.env.JS2WASM_QUICKJS_ARTIFACT_DIR ?? quickjsArtifactCacheDir(cacheDir, quickjsArtifactCacheKey());
    const artifact = readQuickjsArtifact(artifactDir);
    if (!artifact) return null;
    const key = runtimeEvalProviderCacheKey(buildQuickjsAdapterSource(artifact.abi), computeCompilerBundleHash());
    return existsSync(quickjsAdapterCachePath(cacheDir, key)) ? artifactDir : null;
  } catch {
    return null;
  }
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const SOURCE = `
  function joinSource(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }

  // --- a LOCAL closure value reached by DIRECT eval -------------------------
  var localTypeof = 0;
  var localCall = 0;
  function localCaller(): number {
    var twice: any = function (x: number): number { return x * 2 + 1; };
    try { localTypeof = (eval(joinSource(["typeof tw", "ice"])) === "function") ? 1 : 0; } catch (e) { localTypeof = -1; }
    try { localCall = eval(joinSource(["twice(2", "0)"])) as number; } catch (e) { localCall = -1; }
    return 0;
  }
  localCaller();

  // --- the compiled side keeps calling the SAME binding afterwards ----------
  // A carrier now lives in the cell; the static closure-call fast path has to
  // unwrap it or this traps rather than merely answering wrongly.
  var aotAfter = 0;
  function aotAfterCaller(): number {
    var f: any = function (x: number): number { return x + 41; };
    try { eval(joinSource(["typeof ", "f"])); } catch (e) { return -2; }
    return f(1) as number;
  }
  aotAfter = aotAfterCaller();

  // --- identity: two names for ONE closure, compared inside eval ------------
  var identity = 0;
  function identityCaller(): number {
    var f: any = function (): number { return 1; };
    var g: any = f;
    try {
      var a: number = eval(joinSource(["f === ", "g ? 1 : 0"])) as number;
      var b: number = eval(joinSource(["f === ", "g ? 1 : 0"])) as number;
      return a * 10 + b;
    } catch (e) { return -1; }
  }
  identity = identityCaller();

  // --- a nested function CREATED by eval calls the caller's local closure ---
  var nested = 0;
  function nestedCaller(): number {
    var thrice: any = function (x: number): number { return x * 3; };
    try { return eval(joinSource(["(function(){ return thri", "ce(7); })()"])) as number; } catch (e) { return -1; }
  }
  nested = nestedCaller();

  // --- script-scope \`var\` holding a function expression (globals mirror) ----
  var topVar: any = function (x: number): number { return x + 41; };
  var indirectVar = 0;
  var directVar = 0;
  try { indirectVar = (0, eval)(joinSource(["topVar(", "1)"])) as number; } catch (e) { indirectVar = -1; }
  function directVarCaller(): number { return eval(joinSource(["topVar(", "1)"])) as number; }
  try { directVar = directVarCaller(); } catch (e) { directVar = -1; }

  // --- and the compiled side still calls the script-scope binding ----------
  var topVarAot = 0;
  try { topVarAot = topVar(1) as number; } catch (e) { topVarAot = -1; }

  // --- non-closure values are untouched by the wrap ------------------------
  var untouched = 0;
  function untouchedCaller(): number {
    var o: any = { a: 3 };
    var n: number = 4;
    var s: string = "xy";
    try { return eval(joinSource(["o.a + n + s.le", "ngth"])) as number; } catch (e) { return -1; }
  }
  untouched = untouchedCaller();

  export function localTypeofProbe(): number { return localTypeof; }
  export function localCallProbe(): number { return localCall; }
  export function aotAfterProbe(): number { return aotAfter; }
  export function identityProbe(): number { return identity; }
  export function nestedProbe(): number { return nested; }
  export function indirectVarProbe(): number { return indirectVar; }
  export function directVarProbe(): number { return directVar; }
  export function topVarAotProbe(): number { return topVarAot; }
  export function untouchedProbe(): number { return untouched; }
`;

const availableArtifactDir = quickjsProviderAvailable();
const enabled = process.env[ENGINE_ENV] === "quickjs" || availableArtifactDir !== null;

describe.skipIf(!enabled)("#4307 — closure values are carrier-wrapped for the eval seam", () => {
  let probe: Record<string, () => number>;

  beforeAll(async () => {
    const selection = withEnv(
      {
        [ENGINE_ENV]: "quickjs",
        ...(availableArtifactDir ? { JS2WASM_QUICKJS_ARTIFACT_DIR: availableArtifactDir } : {}),
      },
      () => selectCachedRuntimeEvalProvider(),
    ) as { engine?: string; bundle?: unknown };
    expect(selection.engine).toBe("quickjs");

    const compiled = await compile(SOURCE, {
      target: "standalone" as const,
      experimentalIR: false,
      skipSemanticDiagnostics: true,
      // Sloppy: `export` would make the source module code, and module code is
      // strict, where the direct-eval arms under test are unreachable.
      inferModuleStrictArguments: false,
      fileName: "issue-4307-closure-carrier-wrap.ts",
    });
    expect(compiled.success).toBe(true);
    const module = new WebAssembly.Module(compiled.binary!);
    // The probe must actually cross the seam, or it verifies nothing.
    expect(WebAssembly.Module.imports(module).some((i) => i.module === RUNTIME_EVAL_IMPORT_MODULE)).toBe(true);
    const instance = new WebAssembly.Instance(module, {
      [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(selection.bundle),
    });
    (instance.exports as { _start?: () => void })._start?.();
    probe = instance.exports as unknown as Record<string, () => number>;
  }, 180_000);

  it('a LOCAL closure value answers typeof "function" inside evaluated code', () => {
    expect(probe.localTypeofProbe!()).toBe(1);
  });

  it("evaluated code CALLS a local closure value and gets the compiled result", () => {
    // 20 * 2 + 1 — the odd term is only produced by the compiled body.
    expect(probe.localCallProbe!()).toBe(41);
  });

  it("the compiled side still calls the binding after it has crossed the seam", () => {
    // The load-bearing non-regression: the cell now holds a carrier, and the
    // static closure-call fast path must unwrap it instead of trapping.
    expect(probe.aotAfterProbe!()).toBe(42);
  });

  it("two names for one closure stay `===` inside eval, across two evaluations", () => {
    expect(probe.identityProbe!()).toBe(11);
  });

  it("a function CREATED by eval can call the caller's local closure", () => {
    expect(probe.nestedProbe!()).toBe(21);
  });

  it("a script-scope `var` holding a function expression is callable by indirect eval", () => {
    expect(probe.indirectVarProbe!()).toBe(42);
  });

  it("…and by direct eval from inside a sloppy function", () => {
    expect(probe.directVarProbe!()).toBe(42);
  });

  it("…and the compiled module still calls that script-scope binding", () => {
    expect(probe.topVarAotProbe!()).toBe(42);
  });

  it("non-closure bindings (object, number, string) cross unchanged", () => {
    // 3 + 4 + 2 — proves the wrap is a no-op for everything that is not a
    // closure, which is what keeps the rest of the seam byte-neutral.
    expect(probe.untouchedProbe!()).toBe(9);
  });
});
