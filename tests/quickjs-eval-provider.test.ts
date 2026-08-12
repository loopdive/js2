// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4238 / #4242 — the default QuickJS eval engine behind the frozen
 * `js2wasm:runtime-eval` seam.
 *
 * Selection plumbing always runs. End-to-end engine tests self-gate on an
 * already-built artifact because ordinary unit-test CI does not build the
 * clang/WASI dependency implicitly. The default path must either select a
 * complete QuickJS pair or fail loudly; it must never fall back to the native
 * bytecode interpreter. That interpreter remains explicitly selectable and
 * tested through `JS2WASM_EVAL_ENGINE=interpreter`.
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

  // --- a COMPILED object passed into evaluated code (#4245 slice 1) --------
  // Slice 2 of #4238 refused this with a typed TypeError. The membrane
  // replaces the refusal with a LIVE wrapper, so evaluated code reads the
  // caller's real property value — still never a silent \`undefined\`.
  var vCompiledObjectArg = 0;
  try {
    var classify: any = (0, eval)(
      joinSource(["(function(o){ return (o === undefined ? 1 : 0) + (o.marker === 1 ? ", "10 : 0); })"])
    );
    vCompiledObjectArg = classify(compiledObject) as number;
  } catch (err) { vCompiledObjectArg = -1; }

  // --- case 11 (slice 3): direct eval against the caller's live cells ------
  // This module is a TS module, so every function here is STRICT code and the
  // \`const\`-preamble arm is what runs. The sloppy \`with (S)\` arm has its own
  // module below (SLOPPY_DIRECT_SOURCE) — it needs
  // \`inferModuleStrictArguments: false\`, without which no js2wasm module can
  // ever reach it.
  //
  // Each case gets its OWN function on purpose. A pre-existing caller-side
  // codegen defect (see "Slice 3 — implementation record" in the issue file:
  // it reproduces with a six-line stub adapter, so it is neither engine- nor
  // slice-3-specific) traps with "illegal cast" when ONE function performs a
  // direct eval that SUCCEEDS and then, in a later try block, one that THROWS
  // whose catch uses \`instanceof\`. Splitting the functions sidesteps it; do not
  // merge these back together without checking that it is fixed.
  var strictDirectRead = 0;
  var strictDirectWrite = 0;
  var strictDirectTwice = 0;
  var strictDirectCompletion = 0;
  function strictRead(): void {
    var localX = 9;
    var localS = "ab";
    try {
      var readNumber: any = eval(joinSource(["localX + ", "1"]));
      var readString: any = eval(joinSource(["localS + ", "'c'"]));
      strictDirectRead = (readNumber as number) * 100 + ((readString as string).length as number);
    } catch (err) { strictDirectRead = -1; }
  }
  function strictWrite(): void {
    var localX = 9;
    try {
      // (#4308 slice D) The slice-3 residual is RETIRED. A strict caller used to
      // snapshot as \`const\`, so an assignment to a caller binding threw a
      // TypeError; it is now a \`let\` with a \`try…finally\` copy-out, so the
      // assignment updates the caller's live cell.
      //   11 = updated · -2 = threw (the old residual) · -3 = silently lost.
      eval(joinSource(["localX = ", "1"]));
      strictDirectWrite = (localX as number) === 1 ? 11 : -3;
    } catch (err) {
      strictDirectWrite = -2;
    }
  }
  function strictTwice(): void {
    var localX = 9;
    try {
      // The evaluate-TWICE regression, strict arm: a block-scoped preamble must
      // not collide with itself on the second entry (a global \`const\` would).
      var first: any = eval(joinSource(["localX * ", "2"]));
      var second: any = eval(joinSource(["localX * ", "2"]));
      strictDirectTwice = (first as number) === 18 && (second as number) === 18 ? 1 : 0;
    } catch (err) { strictDirectTwice = -1; }
  }
  function strictCompletion(): void {
    try {
      // \`"use strict";\` is an ExpressionStatement: without the \`undefined;\`
      // guard the wrapper's own prologue leaks out as the completion value.
      var empty: any = eval(joinSource(["var q = ", "5;"]));
      strictDirectCompletion = empty === undefined ? 1 : 0;
    } catch (err) { strictDirectCompletion = -1; }
  }
  strictRead();
  strictWrite();
  strictTwice();
  strictCompletion();

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
  export function strictDirectReadProbe(): number { return strictDirectRead; }
  export function strictDirectWriteProbe(): number { return strictDirectWrite; }
  export function strictDirectTwiceProbe(): number { return strictDirectTwice; }
  export function strictDirectCompletionProbe(): number { return strictDirectCompletion; }
`;

/**
 * The SLOPPY direct-eval arm (`with (S) { … }`), which needs
 * `inferModuleStrictArguments: false` — TypeScript flags any source carrying a
 * top-level `export` as a module, and module code is strict, so without that
 * option the `with` arm is unreachable from a js2wasm module and would go
 * untested. The test262 runner passes the same option for script-goal tests,
 * which is where the sloppy arm actually earns its keep.
 *
 * Every eval source is composed through `joinSource` for the usual reason: a
 * literal argument never reaches any engine (`tryStaticEvalInline` folds it).
 */
const SLOPPY_DIRECT_SOURCE = `
  function joinSource(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }
  var moduleVar = 100;
  let moduleLexical = 11;

  // Read a caller local through the with-object scope walk.
  export function sloppyReadProbe(): number {
    var localX = 7;
    try { return eval(joinSource(["localX + ", "1"])) as number; } catch (err) { return -1; }
  }
  // The dominant shape the snapshot exists to recover: a WRITE lands in the
  // live cell, so the caller's own later read sees it.
  export function sloppyWriteProbe(): number {
    var localX = 7;
    try {
      eval(joinSource(["localX = localX + ", "35"]));
      return localX;
    } catch (err) { return -1; }
  }
  // THE EVALUATE-TWICE REGRESSION (sloppy arm). A single eval cannot catch the
  // delayed-corruption class at all: slice 2's realm-corruption bug left the
  // FIRST eval correct and broke the SECOND, because a non-primitive had been
  // written into a carrier the caller keeps across entries. So assert the
  // second reading, and assert its TYPE — an object coming back where a number
  // is expected is exactly what that failure looked like.
  export function sloppyTwiceProbe(): number {
    var localX = 1;
    var localS = "ab";
    try {
      var first: any = eval(joinSource(["localX + ", "1"]));
      var second: any = eval(joinSource(["localX + ", "1"]));
      var third: any = eval(joinSource(["localS + ", "'c'"]));
      if (typeof second !== "number" || typeof third !== "string") return -2;
      return ((first as number) + (second as number)) * 10 + ((third as string).length as number);
    } catch (err) { return -1; }
  }
  // A sloppy eval-created var persists into the NEXT direct eval of the same
  // activation, through the 64-slot activation state pool.
  export function sloppyNewVarProbe(): number {
    try {
      eval(joinSource(["var made", "Var = 21;"]));
      return eval(joinSource(["madeVar + ", "21"])) as number;
    } catch (err) { return -1; }
  }
  // …and does NOT leak anywhere else: not into another activation's direct
  // eval, and not into indirect eval at global scope.
  export function sloppyNoLeakProbe(): number {
    try {
      var viaDirect: any = eval(joinSource(["typeof made", "Var"]));
      var viaIndirect: any = (0, eval)(joinSource(["typeof made", "Var"]));
      return (viaDirect === "undefined" ? 10 : 0) + (viaIndirect === "undefined" ? 1 : 0);
    } catch (err) { return -1; }
  }
  // Module globals and module-level lexicals (\`let\`), which ride a separate
  // non-enumerable cell carrier, are both readable and both written back.
  export function sloppyModuleStateProbe(): number {
    try {
      var readBack: any = eval(joinSource(["moduleVar + module", "Lexical"]));
      eval(joinSource(["moduleVar = ", "200"]));
      eval(joinSource(["moduleLexical = ", "50"]));
      return ((readBack as number) === 111 ? 1000 : 0) + moduleVar + moduleLexical;
    } catch (err) { return -1; }
  }
  // An OUTER captured binding is its own name/cell layer, and the innermost
  // layer must win when a name appears in more than one.
  export function sloppyOuterProbe(): number {
    var captured = 6;
    function inner(): number {
      try {
        var product: any = eval(joinSource(["captured * ", "7"]));
        eval(joinSource(["captured = ", "13"]));
        return product as number;
      } catch (err) { return -1; }
    }
    var value = inner();
    return value * 100 + captured;
  }
  // An OBJECT-valued caller binding used to be shadowed as \`undefined\` inside
  // evaluated code (slice-2 residual). #4245 slice 1 snapshots it as a LIVE
  // membrane wrapper instead: the read sees the real property and the write
  // lands on the caller's own object, with no write-back copy involved.
  export function sloppyObjectResidualProbe(): number {
    var obj: any = { a: 1 };
    try {
      var seen: any = eval(joinSource(["typeof obj + ':' + ob", "j.a"]));
      eval(joinSource(["obj.a = ", "4"]));
      return (seen === "object:1" ? 10 : 0) + ((obj as any).a as number);
    } catch (err) { return -1; }
  }
  // The completion value: \`var\` completes empty, so eval answers undefined.
  export function sloppyCompletionProbe(): number {
    var localX = 1;
    try {
      var empty: any = eval(joinSource(["var q = ", "5;"]));
      var valued: any = eval(joinSource(["localX; 4", "1 + 1"]));
      return (empty === undefined ? 100 : 0) + (valued as number);
    } catch (err) { return -1; }
  }
  // A throw out of direct eval keeps its constructor and message, and the
  // memoized \`(0, eval)\` intrinsic marker survives a direct-eval entry.
  export function sloppyThrowProbe(): number {
    var localX = 1;
    var code = 0;
    try {
      eval(joinSource(["throw new RangeError(", "'direct')"]));
      return -2;
    } catch (err) {
      code = (err instanceof RangeError ? 10 : 0) + (((err as any).message as string) === "direct" ? 1 : 0);
    }
    var after: any = (0, eval)(joinSource(["1 + ", "1"]));
    return code * 10 + (typeof after === "number" ? (after as number) : -1);
  }
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

describe("#4238 / #4242 — quickjs eval engine (default)", () => {
  describe("engine selection plumbing", () => {
    it("case 1 — with no flag the selection is QuickJS or its documented hard error", () => {
      if (availableArtifactDir) {
        const selection = withEnv({ [ENGINE_ENV]: undefined, JS2WASM_QUICKJS_ARTIFACT_DIR: availableArtifactDir }, () =>
          selectCachedRuntimeEvalProvider(),
        );
        expect(selection.engine).toBe("quickjs");
        expect(selection.message).toMatch(/^QUICKJS .*— DEFAULT engine \(#4242\)/);
        return;
      }

      const empty = mkdtempSync(join(tmpdir(), "js2wasm-qjs-default-empty-"));
      expect(() =>
        withEnv({ [ENGINE_ENV]: undefined, JS2WASM_QUICKJS_ARTIFACT_DIR: empty }, () =>
          selectCachedRuntimeEvalProvider(),
        ),
      ).toThrow(/node scripts\/build-quickjs-eval-provider\.mjs/);
    });

    it("keeps the native bytecode interpreter as an explicit first-class engine", () => {
      const selection = withEnv({ [ENGINE_ENV]: "interpreter" }, () => selectCachedRuntimeEvalProvider());
      expect(selection.engine).not.toBe("quickjs");
      expect(["interpreter", "refusal", "none"]).toContain(selection.engine);
      expect(selection.message).toMatch(/selected via JS2WASM_EVAL_ENGINE=interpreter/);
      expect(selection.message).toMatch(/kept native bytecode engine, #4242/);
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

  describe.skipIf(availableArtifactDir === null)("end-to-end through the frozen js2wasm:runtime-eval seam", () => {
    let probe: Record<string, () => number>;
    let parity: Record<string, () => number>;
    let sloppy: Record<string, () => number>;
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
      const link = async (
        source: string,
        fileName: string,
        extra: Record<string, unknown> = {},
      ): Promise<Record<string, () => number>> => {
        const compiled = await compile(source, { ...userOptions, ...extra, fileName });
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
      sloppy = await link(SLOPPY_DIRECT_SOURCE, "quickjs-eval-provider-sloppy.ts", {
        inferModuleStrictArguments: false,
      });
    }, 180_000);

    it("case 9 — engine selection is observable (selection.engine + message)", () => {
      expect(selection.engine).toBe("quickjs");
      expect(selection.message).toMatch(/^QUICKJS \(artifact [0-9a-f]{12}, adapter key [0-9a-f]{16}\)/);
      expect(selection.message).toMatch(/DEFAULT engine \(#4242\)/);
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

    it("a compiled object crossing INTO evaluated code is a LIVE wrapper (#4245 slice 1)", () => {
      // 10 = evaluated code read `o.marker` off the caller's real object. 1
      // would mean it saw `undefined` (the silently-wrong outcome the slice-2
      // refusal existed to prevent); -1 means it still refuses.
      expect(probe.compiledObjectArgProbe!()).toBe(10);
    });

    it("case 11 (strict caller) — direct eval reads the caller's live bindings", () => {
      // 10 * 100 + "abc".length — a number and a STRING caller binding, both
      // read through the block-scoped preamble.
      expect(probe.strictDirectReadProbe!()).toBe(1003);
    });

    it("case 11 (strict caller) — assignment UPDATES the caller's binding (#4308 slice D)", () => {
      // The slice-3 `const`-preamble residual is retired: a strict caller's eval
      // may legitimately assign to an existing binding, and the `let` preamble's
      // `finally` copy-out lands it. -2 = the old TypeError; -3 = the write was
      // accepted and then silently lost, which is the outcome that must stay
      // distinguishable from success.
      expect(probe.strictDirectWriteProbe!()).toBe(11);
    });

    it("case 11 (strict caller) — a second entry does not collide with the first's preamble", () => {
      // A global `const x = …` preamble would make the SECOND direct eval a
      // SyntaxError. Block-scoping it is what keeps this at 1.
      expect(probe.strictDirectTwiceProbe!()).toBe(1);
    });

    it("case 11 (strict caller) — the wrapper's own prologue is not the completion value", () => {
      // Script completion is the last NON-EMPTY statement value, so a bare
      // `"use strict";` in front of a `var` declaration would answer the STRING
      // "use strict" instead of undefined.
      expect(probe.strictDirectCompletionProbe!()).toBe(1);
    });

    it("case 11 (sloppy caller) — `with (S)` reads and WRITES the caller's live cells", () => {
      expect(sloppy.sloppyReadProbe!()).toBe(8);
      // 7 + 35 written back into the live cell the caller's own read dereferences.
      expect(sloppy.sloppyWriteProbe!()).toBe(42);
    });

    it("case 11 (sloppy caller) — EVALUATING TWICE stays correct (delayed-corruption guard)", () => {
      // (2 + 2) * 10 + "abc".length. The load-bearing part is that the SECOND
      // and THIRD entries are asserted at all, and by type: slice 2's
      // realm-corruption bug left entry #1 perfect and broke entry #2, which is
      // why a single-eval test cannot catch this class.
      expect(sloppy.sloppyTwiceProbe!()).toBe(43);
    });

    it("case 11 (sloppy caller) — an eval-created var persists in the activation, and ONLY there", () => {
      expect(sloppy.sloppyNewVarProbe!()).toBe(42);
      // 10 = invisible to another activation's direct eval, +1 = invisible to
      // indirect eval at global scope. A function-scoped binding that leaked to
      // the realm would read "number" for either.
      expect(sloppy.sloppyNoLeakProbe!()).toBe(11);
    });

    it("case 11 (sloppy caller) — module vars and module-level `let` cells both round-trip", () => {
      // 1000 = 100 + 11 read back through the two different carriers, then
      // 200 + 50 written back into the module global and the lexical cell.
      expect(sloppy.sloppyModuleStateProbe!()).toBe(1250);
    });

    it("case 11 (sloppy caller) — the outer capture layer is read and written", () => {
      // 42 = 6 * 7 read from the outer layer, then 13 written back to it.
      expect(sloppy.sloppyOuterProbe!()).toBe(4213);
    });

    it("case 11 (sloppy caller) — an object-valued binding crosses LIVE (#4245 slice 1)", () => {
      // 10 = evaluated code saw `object:1` (not the pre-membrane `undefined`),
      // +4 = a write performed INSIDE eval landed on the caller's own object.
      expect(sloppy.sloppyObjectResidualProbe!()).toBe(14);
    });

    it("case 11 (sloppy caller) — completion values follow UpdateEmpty", () => {
      // 100 = `var q = 5;` completes empty ⇒ undefined; +42 = the last
      // value-producing statement wins.
      expect(sloppy.sloppyCompletionProbe!()).toBe(142);
    });

    it("case 11 (sloppy caller) — a throw keeps its type/message and leaves the intrinsics intact", () => {
      // 11 = RangeError with the real message; * 10 + 2 = a LATER `(0, eval)`
      // still routes to the engine and answers a number, i.e. the direct route
      // did not overwrite the memoized eval/Function markers.
      expect(sloppy.sloppyThrowProbe!()).toBe(112);
    });

    it("cross-engine parity — the same module answers identically on any engine", () => {
      expect(parity.evalSum!()).toBe(42);
      // The pre-slice-2 failure: a STRING completion value read back through
      // the seam (it threw an opaque "Exception: undefined").
      expect(parity.evalConcat!()).toBe(5);
    });
  });
});
