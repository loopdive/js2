// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4238 — the QuickJS eval ENGINE behind the frozen `js2wasm:runtime-eval` seam.
 *
 * SELF-GATING. Default CI has no clang-toolchain guarantee and this lane must
 * NEVER build implicitly, so the suite runs only when a built provider is
 * already reachable:
 *   `JS2WASM_EVAL_ENGINE=quickjs` was requested, OR the keyed artifact
 *   (or `JS2WASM_QUICKJS_ARTIFACT_DIR`) plus the compiled adapter are present
 *   in `.test262-cache`.
 * Otherwise the whole file skips with a message naming the prebuild command.
 *
 * The default-path cases (1–3) are the ones that matter most: they assert that
 * with the flag unset the selector behaves exactly as it did before #4238, and
 * that a bad flag value fails LOUDLY instead of degrading into the NONE tier.
 *
 * Slice 2 adds cases 5–10: the full MVP value bridge in both directions,
 * `new Function`, apply-through-the-seam, error mapping, and the globals mirror.
 */
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
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
  QUICKJS_ENGINE_IDENTITY_GLOBAL,
} from "../scripts/quickjs-eval-provider.mjs";

const RUNTIME_EVAL_IMPORT_MODULE = "js2wasm:runtime-eval";
const ENGINE_ENV = "JS2WASM_EVAL_ENGINE";

/** Is a fully built quickjs provider reachable without building anything? */
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

/** Run `fn` with `JS2WASM_EVAL_ENGINE` (and friends) temporarily overridden. */
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
 * The probe module. A plain `target: "standalone"` USER module — it carries
 * none of the adapter's provider-build options, so it is exactly the shape the
 * engine has to serve.
 *
 * Anti-vacuity, both traps recorded in slice 1 and respected by EVERY case
 * below:
 *  1. Every eval source is composed from a runtime binding (`identityName`, a
 *     `+` of two literals, a `var`). An all-literal argument is constant-folded
 *     and then evaluated at COMPILE time by `tryStaticEvalInline`, which would
 *     make these assertions pass without QuickJS ever running.
 *  2. `40 + 2 === 42` proves nothing about WHICH engine ran, so the engine
 *     identity is asserted separately and in band, via the marker the adapter
 *     installs on the QuickJS realm (`"quickjs".length === 7`).
 */
const PROBE_SOURCE = `
  var identityName = ${JSON.stringify(QUICKJS_ENGINE_IDENTITY_GLOBAL)};
  var g = 7;
  var compiledObject: any = { marker: 1 };

  // Anti-vacuity trap #1, applied to EVERY source below: a compile-time
  // constant eval argument is folded and then evaluated AT COMPILE TIME by
  // tryStaticEvalInline, so the assertion passes without QuickJS running.
  // Composing the source through this runtime loop is what makes each case a
  // real measurement (it caught a genuine string-path failure during slice 2).
  function joinSource(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }

  var indirectNumber = 0;
  var engineNameLength = 0;
  try {
    indirectNumber = (0, eval)("typeof " + identityName + " === 'string' ? 40 + 2 : 0") as number;
  } catch (err) { indirectNumber = -1; }
  try {
    engineNameLength = (0, eval)(identityName + ".length") as number;
  } catch (err) { engineNameLength = -1; }

  // --- case 5: primitive round-trips, both directions ---------------------
  var vTrue = 0;
  try { vTrue = ((0, eval)(joinSource(["!", "!1"])) as boolean) ? 1 : 0; } catch (err) { vTrue = -1; }
  var vFalse = -1;
  try { vFalse = ((0, eval)(joinSource(["!", "!0"])) as boolean) ? 1 : 0; } catch (err) { vFalse = -2; }
  var vNull = 0;
  try { vNull = ((0, eval)(joinSource(["nu", "ll"])) === null) ? 1 : 0; } catch (err) { vNull = -1; }
  var vUndefined = 0;
  try { vUndefined = ((0, eval)(joinSource(["void ", "0"])) === undefined) ? 1 : 0; } catch (err) { vUndefined = -1; }
  var vNaN = 0;
  try {
    var nanValue: any = (0, eval)(joinSource(["Na", "N"]));
    vNaN = (typeof nanValue === "number" && (nanValue as number) !== (nanValue as number)) ? 1 : 0;
  } catch (err) { vNaN = -1; }
  var vString = 0;
  try {
    var text: any = (0, eval)(joinSource(["'ab' + ", "'cde'"]));
    vString = (text as string).length * 1000 + ((text as string).charCodeAt(4) as number);
  } catch (err) { vString = -1; }
  var vUtf8 = 0;
  try {
    // U+00E9 (2-byte) and U+4E2D (3-byte): the transcoder, not just ASCII.
    var wide: any = (0, eval)(joinSource(["'\\\\u00e9\\\\u4e2d' + ", "''"]));
    vUtf8 = ((wide as string).charCodeAt(0) as number) + ((wide as string).charCodeAt(1) as number);
  } catch (err) { vUtf8 = -1; }

  // --- case 6: new Function (global scope) --------------------------------
  var vNewFunction = 0;
  try {
    var made: any = new Function("a", "b", joinSource(["return a + b", " + 1"]));
    vNewFunction = made(20, 21) as number;
  } catch (err) { vNewFunction = -1; }
  var vNewFunctionSyntax = 0;
  try {
    var bad: any = new Function("a", joinSource(["return", " ;;;)"]));
    vNewFunctionSyntax = -2;
  } catch (err) { vNewFunctionSyntax = err instanceof SyntaxError ? 1 : 2; }

  // --- case 7: an eval-defined function invoked from compiled code --------
  var vEvalFunction = 0;
  try {
    var doubler: any = (0, eval)(joinSource(["(function(x){ return x * ", "2; })"]));
    vEvalFunction = doubler(21) as number;
  } catch (err) { vEvalFunction = -1; }
  var vEvalFunctionString = 0;
  try {
    var joiner: any = (0, eval)(joinSource(["(function(a,b){ return a + ", "b; })"]));
    var joined: any = joiner("xy", "zzz");
    vEvalFunctionString = (joined as string).length;
  } catch (err) { vEvalFunctionString = -1; }
  var vCallableIdentity = 0;
  try {
    var makeSelf: any = (0, eval)(joinSource(["(function(){ globalThis.__probe_fn = function(){ return 5; }; return globalThis.", "__probe_fn; })"]));
    var first: any = makeSelf();
    var second: any = (0, eval)(joinSource(["globalThis.", "__probe_fn"]));
    vCallableIdentity = (first === second ? 10 : 0) + (first() as number);
  } catch (err) { vCallableIdentity = -1; }

  // --- case 8: error mapping (real name + message) ------------------------
  var vSyntaxError = 0;
  try { (0, eval)(joinSource(["{", ""])); vSyntaxError = -2; }
  catch (err) {
    vSyntaxError = (err instanceof SyntaxError ? 10 : 0) + (((err as any).name as string) === "SyntaxError" ? 1 : 0);
  }
  var vThrownMessage = 0;
  try { (0, eval)(joinSource(["throw new TypeError(", "'boom')"])); vThrownMessage = -2; }
  catch (err) {
    vThrownMessage = (err instanceof TypeError ? 10 : 0) + (((err as any).message as string) === "boom" ? 1 : 0);
  }
  var vReferenceError = 0;
  try { (0, eval)(joinSource(["nope", "Undefined"])); vReferenceError = -2; }
  catch (err) {
    vReferenceError =
      (err instanceof ReferenceError ? 10 : 0) + (((err as any).name as string) === "ReferenceError" ? 1 : 0);
  }
  var vThrowFromCallable = 0;
  try {
    var thrower: any = (0, eval)(joinSource(["(function(){ throw new RangeError(", "'range'); })"]));
    thrower();
    vThrowFromCallable = -2;
  } catch (err) {
    vThrowFromCallable = (err instanceof RangeError ? 10 : 0) + (((err as any).message as string) === "range" ? 1 : 0);
  }

  // --- case 10: pushed-global visibility and write-back --------------------
  var vGlobalRead = 0;
  try { vGlobalRead = (0, eval)(joinSource(["g + ", "0"])) as number; } catch (err) { vGlobalRead = -1; }
  var vGlobalWrite = 0;
  try { (0, eval)(joinSource(["g = ", "8"])); vGlobalWrite = g; } catch (err) { vGlobalWrite = -1; }

  // --- opaque handle box: a non-callable QuickJS object out and back in ----
  var vHandleBox = 0;
  try {
    var boxed: any = (0, eval)(joinSource(["({ a: ", "1 })"]));
    var describe: any = (0, eval)(joinSource(["(function(o){ return typeof o + ", "':' + o.a; })"]));
    vHandleBox = (describe(boxed) as string).length;
  } catch (err) { vHandleBox = -1; }

  // --- a COMPILED object passed into evaluated code is REFUSED, loudly ------
  // Loud beats silently-wrong: evaluated code must never quietly observe
  // \`undefined\` where the caller handed it an object.
  var vCompiledObjectArg = 0;
  try {
    var classify: any = (0, eval)(joinSource(["(function(o){ return o === undefined ? 1 : ", "2; })"]));
    vCompiledObjectArg = -(classify(compiledObject) as number);
  } catch (err) {
    vCompiledObjectArg =
      (err instanceof TypeError ? 10 : 0) +
      ((((err as any).message as string).indexOf("compiled objects") >= 0) ? 1 : 0);
  }

  // --- case 11: direct eval is still the slice-3 tier ---------------------
  function callerScope(): number {
    var localX = 7;
    try {
      return eval(joinSource(["localX + ", "1"])) as number;
    } catch (err) {
      return err instanceof TypeError ? 1 : 2;
    }
  }
  var directEvalOutcome = -9;
  directEvalOutcome = callerScope();

  export function indirectNumberProbe(): number { return indirectNumber; }
  export function engineNameLengthProbe(): number { return engineNameLength; }
  export function truthProbe(): number { return vTrue; }
  export function falsehoodProbe(): number { return vFalse; }
  export function nullProbe(): number { return vNull; }
  export function undefinedProbe(): number { return vUndefined; }
  export function nanProbe(): number { return vNaN; }
  export function stringProbe(): number { return vString; }
  export function utf8Probe(): number { return vUtf8; }
  export function newFunctionProbe(): number { return vNewFunction; }
  export function newFunctionSyntaxProbe(): number { return vNewFunctionSyntax; }
  export function evalFunctionProbe(): number { return vEvalFunction; }
  export function evalFunctionStringProbe(): number { return vEvalFunctionString; }
  export function callableIdentityProbe(): number { return vCallableIdentity; }
  export function syntaxErrorProbe(): number { return vSyntaxError; }
  export function thrownMessageProbe(): number { return vThrownMessage; }
  export function referenceErrorProbe(): number { return vReferenceError; }
  export function throwFromCallableProbe(): number { return vThrowFromCallable; }
  export function globalReadProbe(): number { return vGlobalRead; }
  export function globalWriteProbe(): number { return vGlobalWrite; }
  export function handleBoxProbe(): number { return vHandleBox; }
  export function compiledObjectArgProbe(): number { return vCompiledObjectArg; }
  export function directEvalProbe(): number { return directEvalOutcome; }
`;

/**
 * The cross-ENGINE parity shape (tech lead, 2026-08-09): one module whose two
 * exports are answerable by any correct engine, so the same expectations hold
 * for the interpreter tier. `join` concatenates a runtime array, so
 * `tryStaticEvalInline` can never answer — the anti-vacuity rule again.
 *
 * `evalConcat` is the case that FAILED before slice 2 (it surfaced as an opaque
 * "Exception: undefined", which is also why the error mapping matters).
 */
const PARITY_SOURCE = `
  function join(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }
  export function evalSum(): number {
    return (0, eval)(join(["4", "0", " + ", "2"])) as number;
  }
  export function evalConcat(): number {
    return ((0, eval)(join(["'ab' + ", "'cde'"])) as string).length;
  }
`;

const availableArtifactDir = quickjsProviderAvailable();
const engineRequested = process.env[ENGINE_ENV] === "quickjs";
const enabled = engineRequested || availableArtifactDir !== null;

describe.skipIf(!enabled)("#4238 — quickjs eval engine (flag-gated)", () => {
  describe("flag plumbing (default path is untouched)", () => {
    it("case 1 — with no flag the selection is the pre-existing interpreter/refusal tier", () => {
      const selection = withEnv({ [ENGINE_ENV]: undefined }, () => selectCachedRuntimeEvalProvider());
      expect(selection.engine).not.toBe("quickjs");
      expect(["interpreter", "refusal", "none"]).toContain(selection.engine);
      expect(selection.message).not.toMatch(/QUICKJS/);
      expect(selection.message).toMatch(/^(INTERPRETER|REFUSAL|NONE)/);
      // The quickjs bundle descriptor is absent, so every existing consumer
      // (which destructures only `module`/`message`) is unaffected.
      expect((selection as { bundle?: unknown }).bundle).toBeUndefined();
    });

    it("case 2 — an unknown engine value throws loudly (never degrades to NONE)", () => {
      expect(() => withEnv({ [ENGINE_ENV]: "v8" }, () => selectCachedRuntimeEvalProvider())).toThrow(
        /JS2WASM_EVAL_ENGINE="v8" is not a known eval engine/,
      );
      // Explicitly NOT a NONE-tier selection object: the throw must escape the
      // selector's try/catch, or a typo would silently disable eval.
      expect(() => withEnv({ [ENGINE_ENV]: "" }, () => selectCachedRuntimeEvalProvider())).toThrow(
        /is not a known eval engine/,
      );
    });

    it("case 3 — flag set + artifact missing is a hard error naming the prebuild command", () => {
      const empty = mkdtempSync(join(tmpdir(), "js2wasm-qjs-empty-"));
      expect(() =>
        withEnv({ [ENGINE_ENV]: "quickjs", JS2WASM_QUICKJS_ARTIFACT_DIR: empty }, () =>
          selectCachedRuntimeEvalProvider(),
        ),
      ).toThrow(/node scripts\/build-quickjs-eval-provider\.mjs/);
    });

    it("TEST262_DISABLE_RUNTIME_EVAL_PROVIDER wins over the engine flag", () => {
      const selection = withEnv({ [ENGINE_ENV]: "quickjs", TEST262_DISABLE_RUNTIME_EVAL_PROVIDER: "1" }, () =>
        selectCachedRuntimeEvalProvider(),
      );
      expect(selection.engine).toBe("none");
      expect(selection.module).toBeNull();
    });
  });

  describe("end-to-end through the frozen js2wasm:runtime-eval seam", () => {
    let probe: Record<string, () => number>;
    let parity: Record<string, () => number>;
    let selection: { engine?: string; message?: string; bundle?: unknown };

    beforeAll(async () => {
      selection = withEnv(
        {
          [ENGINE_ENV]: "quickjs",
          ...(availableArtifactDir ? { JS2WASM_QUICKJS_ARTIFACT_DIR: availableArtifactDir } : {}),
        },
        () => selectCachedRuntimeEvalProvider(),
      ) as typeof selection;

      const userOptions = {
        target: "standalone" as const,
        experimentalIR: false,
        skipSemanticDiagnostics: true,
      };
      const link = async (source: string, fileName: string): Promise<Record<string, () => number>> => {
        const compiled = await compile(source, { ...userOptions, fileName });
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
      probe = await link(PROBE_SOURCE, "quickjs-eval-provider-probe.ts");
      parity = await link(PARITY_SOURCE, "quickjs-eval-provider-parity.ts");
    }, 180_000);

    it("case 9 — engine selection is observable (selection.engine + message)", () => {
      expect(selection.engine).toBe("quickjs");
      expect(selection.message).toMatch(/^QUICKJS \(artifact [0-9a-f]{12}, adapter key [0-9a-f]{16}\)/);
      expect(selection.message).toMatch(/NOT CI-comparable/);
    });

    it("case 4 — indirect eval runs inside QuickJS (slice-1 done-signal)", () => {
      // 42 only if QuickJS evaluated the source against the realm this adapter
      // set up; any other outcome (interpreter, static fold, refusal) gives 0
      // or -1.
      expect(probe.indirectNumberProbe!()).toBe(42);
    });

    it("case 9 (in-band) — evaluated code can read the engine-identity global", () => {
      // "quickjs".length — a real QuickJS string on the realm's globalThis.
      expect(probe.engineNameLengthProbe!()).toBe(7);
    });

    it("case 5 — boolean / null / undefined / NaN round-trip", () => {
      expect(probe.truthProbe!()).toBe(1);
      expect(probe.falsehoodProbe!()).toBe(0);
      expect(probe.nullProbe!()).toBe(1);
      expect(probe.undefinedProbe!()).toBe(1);
      // Tag-dispatch edge case: qjs_to_f64's NaN is a VALUE for a numeric tag,
      // never an error sentinel.
      expect(probe.nanProbe!()).toBe(1);
    });

    it("case 5 — strings round-trip, including non-ASCII (UTF-8 both directions)", () => {
      // 'abcde'.length * 1000 + 'e'.charCodeAt(0)
      expect(probe.stringProbe!()).toBe(5101);
      // U+00E9 (2-byte) + U+4E2D (3-byte) survive the transcoder unchanged.
      expect(probe.utf8Probe!()).toBe(0xe9 + 0x4e2d);
    });

    it("case 6 — new Function is real (and its early errors are SyntaxErrors)", () => {
      expect(probe.newFunctionProbe!()).toBe(42);
      expect(probe.newFunctionSyntaxProbe!()).toBe(1);
    });

    it("case 7 — an eval-defined function is invocable from compiled code", () => {
      expect(probe.evalFunctionProbe!()).toBe(42);
      // String arguments in AND a string result out, through qjs_call.
      expect(probe.evalFunctionStringProbe!()).toBe(5);
      // 10 = the same QuickJS function crossing out twice is one identity;
      // +5 = it is genuinely callable.
      expect(probe.callableIdentityProbe!()).toBe(15);
    });

    it("case 8 — a throw inside evaluated code keeps its real name and message", () => {
      expect(probe.syntaxErrorProbe!()).toBe(11);
      expect(probe.thrownMessageProbe!()).toBe(11);
      expect(probe.referenceErrorProbe!()).toBe(11);
      expect(probe.throwFromCallableProbe!()).toBe(11);
    });

    it("case 10 — module globals are visible to evaluated code and written back", () => {
      expect(probe.globalReadProbe!()).toBe(7);
      expect(probe.globalWriteProbe!()).toBe(8);
    });

    it("a non-callable QuickJS object crosses out as an opaque handle box and back in", () => {
      // "object:1".length — the SAME QuickJS object, not a fresh one.
      expect(probe.handleBoxProbe!()).toBe(8);
    });

    it("a compiled object crossing INTO evaluated code is a typed TypeError, not a silent undefined", () => {
      // 10 = TypeError, +1 = it carries the #4238 message. A negative reading
      // means the call SUCCEEDED and evaluated code saw the value the MVP
      // cannot represent — the silently-wrong outcome this refusal exists to
      // prevent (the #4245 membrane is what will make it representable).
      expect(probe.compiledObjectArgProbe!()).toBe(11);
    });

    it("case 11 — direct eval is still the typed slice-3 refusal", () => {
      expect(probe.directEvalProbe!()).toBe(1);
    });

    it("cross-engine parity — the same module answers identically on any engine", () => {
      expect(parity.evalSum!()).toBe(42);
      // The pre-slice-2 failure: a STRING completion value read back through
      // the seam (it threw an opaque "Exception: undefined").
      expect(parity.evalConcat!()).toBe(5);
    });
  });
});

if (!enabled) {
  // eslint-disable-next-line no-console
  console.error(
    "[#4238] quickjs eval-engine lane SKIPPED — no built provider. Run: " +
      "node scripts/build-quickjs-eval-provider.mjs (needs clang-18/cmake/git/curl + network), " +
      "or set JS2WASM_QUICKJS_ARTIFACT_DIR to a prebuilt artifact dir.",
  );
}
