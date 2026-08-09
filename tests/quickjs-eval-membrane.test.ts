// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4245 slice 1 — the INWARD half of the QuickJS eval membrane.
 *
 * A compiled WasmGC object or function crossing INTO evaluated code is a LIVE
 * exotic wrapper, not a copy and not a refusal: reads and writes go through
 * property traps that call back into the GC adapter, and a call on a wrapped
 * compiled function re-enters compiled code.
 *
 * SELF-GATING, exactly like tests/quickjs-eval-provider.test.ts: default CI has
 * no clang toolchain and this lane must never build implicitly, so the file
 * skips unless a built provider is already reachable.
 *
 * Anti-vacuity rules inherited from #4238 and applied to EVERY case here:
 *  1. Every eval source is composed through a runtime loop. An all-literal
 *     argument is constant-folded and then evaluated at COMPILE time by
 *     `tryStaticEvalInline`, which would make these assertions pass with the
 *     membrane entirely dead.
 *  2. An expectation any evaluator could satisfy proves nothing about which
 *     engine ran. Every case below is asserted against compiled-side state the
 *     membrane is the only path to (a property of a compiled object, the return
 *     value of a compiled function), so a fallback tier cannot fake it.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  QUICKJS_MEMBRANE_CALLBACKS,
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

/**
 * The membrane probe module. `wrapped` and `alias` are two module globals
 * naming ONE compiled object — that pairing is what makes the identity case a
 * real measurement rather than a tautology.
 */
const MEMBRANE_SOURCE = `
  function joinSource(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }

  var wrapped: any = { n: 7, s: "abc" };
  var alias: any = wrapped;
  var other: any = { n: 7 };
  function compiledAdd(a: number, b: number): number { return a + b + 1; }

  // --- read a compiled object's property from inside evaluated code --------
  var vRead = 0;
  try { vRead = (0, eval)(joinSource(["wrapped.n +", " 0"])) as number; } catch (e) { vRead = -1; }

  // --- write it, and observe the write on the COMPILED side ----------------
  var vWrite = 0;
  try {
    (0, eval)(joinSource(["wrapped.n = ", "99"]));
    vWrite = wrapped.n as number;
  } catch (e) { vWrite = -1; }

  // --- a NEW property created by evaluated code is visible to compiled code -
  var vFresh = 0;
  try {
    (0, eval)(joinSource(["wrapped.fresh = ", "5"]));
    vFresh = wrapped.fresh as number;
  } catch (e) { vFresh = -1; }

  // --- a STRING property round-trips (UTF-8 in both key and value) ---------
  var vString = 0;
  try { vString = ((0, eval)(joinSource(["wrapped.s + ", "'d'"])) as string).length; } catch (e) { vString = -1; }

  // --- identity: two names for ONE object, in two SEPARATE evaluations -----
  var vIdentityA = 0;
  var vIdentityB = 0;
  var vDistinct = 0;
  try { vIdentityA = (0, eval)(joinSource(["wrapped === ", "alias ? 1 : 0"])) as number; } catch (e) { vIdentityA = -1; }
  try { vIdentityB = (0, eval)(joinSource(["wrapped === ", "alias ? 1 : 0"])) as number; } catch (e) { vIdentityB = -1; }
  // …and two DISTINCT compiled objects must not collapse onto one wrapper.
  try { vDistinct = (0, eval)(joinSource(["wrapped === ", "other ? 0 : 1"])) as number; } catch (e) { vDistinct = -1; }

  // --- calling a compiled function from evaluated code ---------------------
  var vCall = 0;
  var vTypeof = 0;
  try { vCall = (0, eval)(joinSource(["compiledAdd(20,", " 21)"])) as number; } catch (e) { vCall = -1; }
  try {
    vTypeof = (0, eval)(joinSource(["typeof compiledAdd === 'fun", "ction' ? 1 : 0"])) as number;
  } catch (e) { vTypeof = -1; }

  // --- a compiled function passed as a seam ARGUMENT, invoked by eval'd code -
  var vCallback = 0;
  try {
    var apply2: any = (0, eval)(joinSource(["(function(f){ return f(1", "0, 30); })"]));
    vCallback = apply2(compiledAdd) as number;
  } catch (e) { vCallback = -1; }

  // --- \`in\` resolves own + prototype through the compiled object runtime ---
  var vHas = 0;
  try {
    vHas = (0, eval)(
      joinSource(["(('n' in wrapped) ? 10 : 0) + (('nope' in wr", "apped) ? 0 : 1)"])
    ) as number;
  } catch (e) { vHas = -1; }

  // --- delete reaches the compiled object ----------------------------------
  var vDelete = 0;
  try {
    (0, eval)(joinSource(["delete wrap", "ped.s"]));
    vDelete = (wrapped.s === undefined) ? 1 : 0;
  } catch (e) { vDelete = -1; }

  // --- reflective defineProperty is LOUD, not approximated ------------------
  var vDefine = 0;
  try {
    (0, eval)(joinSource(["Object.defineProperty(wrapped, 'q', { val", "ue: 1 })"]));
    vDefine = -2;
  } catch (e) { vDefine = (e instanceof TypeError) ? 1 : -3; }

  // --- Symbol keys are the documented residual: absent / no-op, never a trap -
  var vSymbol = 0;
  try {
    vSymbol = (0, eval)(
      joinSource(["(function(){ var s = Symbol('k'); wrapped[s] = 1; return wrapped[s] === undefin",
                  "ed ? 1 : 0; })()"])
    ) as number;
  } catch (e) { vSymbol = -1; }

  export function readProbe(): number { return vRead; }
  export function writeProbe(): number { return vWrite; }
  export function freshProbe(): number { return vFresh; }
  export function stringProbe(): number { return vString; }
  export function identityAProbe(): number { return vIdentityA; }
  export function identityBProbe(): number { return vIdentityB; }
  export function distinctProbe(): number { return vDistinct; }
  export function callProbe(): number { return vCall; }
  export function typeofProbe(): number { return vTypeof; }
  export function callbackProbe(): number { return vCallback; }
  export function hasProbe(): number { return vHas; }
  export function deleteProbe(): number { return vDelete; }
  export function defineProbe(): number { return vDefine; }
  export function symbolProbe(): number { return vSymbol; }
`;

/**
 * The SLOPPY arm (`with (S) { … }`), which needs a second compile with
 * `inferModuleStrictArguments: false`: any source carrying a top-level
 * `export` is module code, module code is strict, and the `with` arm is
 * otherwise unreachable — which is exactly where test262's script-goal files
 * live.
 */
const MEMBRANE_DIRECT_SOURCE = `
  function joinSource(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }
  // A LOCAL object-valued binding of a sloppy caller, reached by DIRECT eval.
  var directObject = 0;
  function directObjectCaller(): number {
    var local: any = { a: 1 };
    try {
      var seen: any = eval(joinSource(["local.a + ", "1"]));
      eval(joinSource(["local.a = ", "6"]));
      return (seen as number) * 10 + ((local as any).a as number);
    } catch (e) { return -1; }
  }
  directObject = directObjectCaller();

  // A LOCAL closure VALUE. This was slice 1's enumerated residual (it crossed
  // as a plain non-callable wrapper); #4307 carrier-wraps it caller-side, so
  // it now answers typeof "function" AND the call re-enters compiled code.
  var directCall = 0;
  function directCallCaller(): number {
    var twice: any = function (x: number): number { return x * 2; };
    try {
      var kind: any = eval(joinSource(["typeof tw", "ice"]));
      var got = 0;
      try { got = eval(joinSource(["twice(2", "1)"])) as number; } catch (inner) { got = -100; }
      return (kind === "function" ? 1000 : 0) + got;
    } catch (e) { return -1; }
  }
  directCall = directCallCaller();

  export function directObjectProbe(): number { return directObject; }
  export function directCallProbe(): number { return directCall; }
`;

const availableArtifactDir = quickjsProviderAvailable();
const enabled = process.env[ENGINE_ENV] === "quickjs" || availableArtifactDir !== null;

describe.skipIf(!enabled)("#4245 slice 1 — quickjs eval membrane (inward)", () => {
  let probe: Record<string, () => number>;
  let direct: Record<string, () => number>;

  beforeAll(async () => {
    const selection = withEnv(
      {
        [ENGINE_ENV]: "quickjs",
        ...(availableArtifactDir ? { JS2WASM_QUICKJS_ARTIFACT_DIR: availableArtifactDir } : {}),
      },
      () => selectCachedRuntimeEvalProvider(),
    ) as { engine?: string; bundle?: unknown };
    expect(selection.engine).toBe("quickjs");

    const link = async (
      source: string,
      fileName: string,
      extra: Record<string, unknown> = {},
    ): Promise<Record<string, () => number>> => {
      const compiled = await compile(source, {
        target: "standalone" as const,
        experimentalIR: false,
        skipSemanticDiagnostics: true,
        ...extra,
        fileName,
      });
      expect(compiled.success).toBe(true);
      const module = new WebAssembly.Module(compiled.binary!);
      // The probe must actually cross the seam, or it verifies nothing.
      expect(WebAssembly.Module.imports(module).some((i) => i.module === RUNTIME_EVAL_IMPORT_MODULE)).toBe(true);
      const instance = new WebAssembly.Instance(module, {
        [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(selection.bundle),
      });
      (instance.exports as { _start?: () => void })._start?.();
      return instance.exports as unknown as Record<string, () => number>;
    };
    probe = await link(MEMBRANE_SOURCE, "quickjs-membrane-probe.ts");
    direct = await link(MEMBRANE_DIRECT_SOURCE, "quickjs-membrane-direct.ts", {
      inferModuleStrictArguments: false,
    });
  }, 180_000);

  it("reads a compiled object's property from inside evaluated code", () => {
    expect(probe.readProbe!()).toBe(7);
  });

  it("writes through the wrapper and the COMPILED side observes it (the done-signal)", () => {
    expect(probe.writeProbe!()).toBe(99);
  });

  it("a property CREATED by evaluated code lands on the compiled object", () => {
    expect(probe.freshProbe!()).toBe(5);
  });

  it("string keys and string values cross in both directions", () => {
    // "abcd".length — the value came out of the compiled heap as a GC string,
    // was concatenated inside QuickJS, and was measured back on the GC side.
    expect(probe.stringProbe!()).toBe(4);
  });

  it("identity: two names for one compiled object are `===` inside eval", () => {
    expect(probe.identityAProbe!()).toBe(1);
  });

  it("identity holds across a SECOND, separate evaluation", () => {
    // The load-bearing half: a fresh wrapper per crossing would still pass the
    // case above (both names are converted in the same push).
    expect(probe.identityBProbe!()).toBe(1);
  });

  it("two DISTINCT compiled objects do not collapse onto one wrapper", () => {
    expect(probe.distinctProbe!()).toBe(1);
  });

  it("evaluated code can CALL a compiled function", () => {
    // 20 + 21 + 1 — a value only the compiled body produces.
    expect(probe.callProbe!()).toBe(42);
  });

  it('a wrapped compiled function answers `typeof` as "function"', () => {
    expect(probe.typeofProbe!()).toBe(1);
  });

  it("a compiled function passed as a seam ARGUMENT is callable by eval'd code", () => {
    // 10 + 30 + 1 — the argument path, not the globals mirror.
    expect(probe.callbackProbe!()).toBe(41);
  });

  it("`in` is answered by the compiled object runtime, present and absent", () => {
    expect(probe.hasProbe!()).toBe(11);
  });

  it("`delete` reaches the compiled object", () => {
    expect(probe.deleteProbe!()).toBe(1);
  });

  it("Object.defineProperty on a wrapper is a typed TypeError, not an approximation", () => {
    // -2 would mean it silently succeeded with unknown attributes; -3 a
    // different error type. Loud beats approximated.
    expect(probe.defineProbe!()).toBe(1);
  });

  it("Symbol keys are absent/no-op (documented residual), never a trap", () => {
    expect(probe.symbolProbe!()).toBe(1);
  });

  it("direct eval in a SLOPPY caller reads and writes a local object-valued binding", () => {
    // (1 + 1) * 10 + 6 — the read saw the caller's live property, the write
    // landed on the caller's own object with no copy-back involved.
    expect(direct.directObjectProbe!()).toBe(26);
  });

  it("a LOCAL closure value is callable across the membrane (#4307 retires the residual)", () => {
    // 1000 = evaluated code sees `typeof` as "function"; +42 = `twice(21)` ran
    // the COMPILED body and returned its value. Slice 1 read 12 here (object +
    // throw). A reading of 42 alone would mean the call works but `typeof`
    // still lies; 1000 + -100 would mean the reverse.
    expect(direct.directCallProbe!()).toBe(1042);
  });

  it("the callback ABI list is the link-time order the shim consumes positionally", () => {
    // qjs_set_membrane_callbacks takes the five slot indices POSITIONALLY, so
    // reordering this array silently rewires every trap. Pin it.
    expect([...QUICKJS_MEMBRANE_CALLBACKS]).toEqual([
      "__membrane_get",
      "__membrane_set",
      "__membrane_has",
      "__membrane_delete",
      "__membrane_call",
    ]);
  });

  it("a stale artifact (no membrane exports) fails LOUDLY at selection", () => {
    const empty = mkdtempSync(join(tmpdir(), "js2wasm-qjs-membrane-"));
    expect(() =>
      withEnv({ [ENGINE_ENV]: "quickjs", JS2WASM_QUICKJS_ARTIFACT_DIR: empty }, () =>
        selectCachedRuntimeEvalProvider(),
      ),
    ).toThrow(/build-quickjs-eval-provider\.mjs/);
  });
});
