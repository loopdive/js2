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

/**
 * #4308 slice A — intrinsic-error identity across the membrane.
 *
 * Shaped like the 64 `annexB/…/eval-code/**` files this slice targets: a SLOPPY
 * function caller, a DIRECT eval, and `assert.throws(ReferenceError, fn)` living
 * only INSIDE the eval string — `assert` is a top-level function declaration
 * carrying `throws` as a property, which is verbatim test262's harness shape (an
 * object-literal `assert` is NOT the same test: its `throws` is an uncarried
 * closure value and is not callable from evaluated code at all).
 *
 * Liveness is not assumed: on the pre-slice-A adapter this same module measures
 * `identity → 0` with `sameNameMisses → 3`, i.e. the exact
 * "different error constructor with the same name" signature the corpus fails
 * on. A regression to the old behaviour therefore cannot pass these cases.
 */
const MEMBRANE_ERROR_IDENTITY_SOURCE = `
  function joinSource(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }

  // Counters live on an OBJECT, never on module-level primitive \`var\`s: the
  // globals pull copies the realm's value of every primitive global back over
  // the compiled one after the eval, so a primitive written by a membrane
  // callback DURING the evaluation is silently reset when it returns.
  var report: any = { hits: 0, misses: 0, sameNameMiss: 0 };

  function assert(mustBeTrue: any): number { return mustBeTrue ? 1 : 0; }
  (assert as any).throws = function (expectedErrorConstructor: any, func: any): number {
    try {
      func();
    } catch (thrown) {
      if ((thrown as any).constructor !== expectedErrorConstructor) {
        report.misses = (report.misses as number) + 1;
        if ((thrown as any).name === (expectedErrorConstructor as any).name) {
          report.sameNameMiss = (report.sameNameMiss as number) + 1;
        }
        return 0;
      }
      report.hits = (report.hits as number) + 1;
      return 1;
    }
    return -1;
  };

  // Each case gets its OWN function, which also keeps every \`catch\` out of a
  // frame that later runs a direct eval. #4305 (fixed separately, PR #4339)
  // traps \`illegal cast\` on the STATIC shape \`catch\` → direct eval → \`catch\`
  // whose body READS its parameter: \`fctx.boxedCaptures\` is keyed by name, so a
  // catch clause rebinding that name leaves stale direct-eval cell metadata and
  // the identifier read emits a \`ref.cast\` against a raw exception payload.
  // Neither \`instanceof\` nor a succeeding-then-throwing sequence is required —
  // it is compile-time, engine-independent, and hits the refusal path too.
  var vIdentity = 0;
  function identityCaller(): number {
    try { return eval(joinSource(["assert.throws(Reference", "Error, function() { f; })"])) as number; }
    catch (e) { return -1; }
  }
  vIdentity = identityCaller();

  // The other direction: the realm's own \`instanceof\` must keep working, i.e.
  // the compiled constructor must NOT have been mirrored in over QuickJS's.
  var vRealmInstanceof = 0;
  function realmInstanceofCaller(): number {
    try {
      return eval(joinSource([
        "(function(){ try { qq; return 0; } catch (e) {",
        " return (e instanceof ReferenceError) ? 1 : 0; } })()"
      ])) as number;
    } catch (e) { return -1; }
  }
  vRealmInstanceof = realmInstanceofCaller();

  // A SECOND and a THIRD evaluation after the new crossing path has run once —
  // the delayed-realm-corruption class shows up here, not on the first eval.
  var vSecond = 0;
  function secondCaller(): number {
    try { return eval(joinSource(["assert.throws(Type", "Error, function() { null.x; })"])) as number; }
    catch (e) { return -1; }
  }
  vSecond = secondCaller();

  var vThird = 0;
  function thirdCaller(): number {
    try { return eval(joinSource(["assert.throws(Reference", "Error, function() { zz; })"])) as number; }
    catch (e) { return -1; }
  }
  vThird = thirdCaller();

  // The constructor as an INDIRECT eval completion value, not a call argument.
  var vIndirect = 0;
  function indirectCaller(): number {
    try {
      var got: any = (0, eval)(joinSource(["Reference", "Error"]));
      return got === ReferenceError ? 1 : 0;
    } catch (e) { return -1; }
  }
  vIndirect = indirectCaller();

  // Engine identity in-band: no value any engine can produce proves which one ran.
  var vEngine = 0;
  function engineCaller(): number {
    try { return eval(joinSource(["(__js2wasm_eval_", "engine === 'quickjs') ? 1 : 0"])) as number; }
    catch (e) { return -1; }
  }
  vEngine = engineCaller();

  export function identityProbe(): number { return vIdentity; }
  export function realmInstanceofProbe(): number { return vRealmInstanceof; }
  export function secondProbe(): number { return vSecond; }
  export function thirdProbe(): number { return vThird; }
  export function indirectProbe(): number { return vIndirect; }
  export function engineProbe(): number { return vEngine; }
  export function hitsProbe(): number { return report.hits as number; }
  export function missesProbe(): number { return report.misses as number; }
  export function sameNameMissProbe(): number { return report.sameNameMiss as number; }
`;

/**
 * #4308 slice B — EvalDeclarationInstantiation for a GLOBAL caller / indirect
 * eval.
 *
 * Shaped like the `annexB/language/eval-code/{direct,indirect}/global-*`
 * corpus, including the two harness details that decide whether those files
 * measure anything at all:
 *
 *  - `fnGlobalObject.js` is `Function("return this;")()`, and it is written here
 *    with NO `new` and NO cast. That matters: `(Function as any)(…)` is a
 *    DIFFERENT lowering (the cast stops it being the recognised intrinsic call
 *    site) and throws — measured while writing this. The corpus takes the bare
 *    form, so the lane must too.
 *  - `verifyProperty` asks for `{writable, enumerable, configurable}`, so the
 *    descriptor cases below read real descriptors rather than just values.
 *
 * Anti-vacuity, measured both ways: on the pre-slice-B adapter this same module
 * fails 11 of its 19 readings — `realm` reads 0 (the caller's realm object and
 * QuickJS's `globalThis` were disjoint), `fnWrite`/`fnCall` read 0 (a function
 * could not cross back into a caller binding), `hidden` throws. It cannot pass
 * with the slice reverted.
 */
const EDI_GLOBAL_SOURCE = `
  function joinSource(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }
  var marker = 7;
  var initialBV: any = 0;
  var currentBV: any = 0;

  var vEngine = 0;
  try { vEngine = (0, eval)(joinSource(["(__js2wasm_eval_", "engine === 'quickjs') ? 1 : 0"])) as number; }
  catch (e) { vEngine = -1; }

  // test262's fnGlobalObject: the value it hands every eval-global test must be
  // the CALLER'S realm carrier. While it was an opaque published box,
  // \`Object.defineProperty(fnGlobalObject(), 'f', …)\` defined \`f\` on a
  // one-property object and neither realm ever saw it.
  var realmObj: any = 0;
  var vRealm = 0;
  try {
    var mk: any = Function(joinSource(["return th", "is;"]));
    realmObj = mk();
    vRealm = ((realmObj as any).marker === 7) ? 1 : 0;
  } catch (e) { vRealm = -1; }

  // EDI creates the binding on the caller's realm, with the B.3.3.3 attributes.
  var vCreate = 0;
  var vDesc = 0;
  try {
    (0, eval)(joinSource(["var ediVar = ", "41 + 1;"]));
    vCreate = ((realmObj as any).ediVar === 42) ? 1 : 0;
    var d: any = Object.getOwnPropertyDescriptor(realmObj, "ediVar");
    vDesc = (d && d.writable === true && d.enumerable === true && d.configurable === true) ? 1 : 0;
  } catch (e) { vCreate = -1; }

  // annex B: the var binding is \`undefined\` INSIDE the body and carries the
  // function afterwards.
  var vInit = 0;
  var vAfter = 0;
  try {
    var seen: any = (0, eval)(joinSource([
      "(function(){ return 0; })(); { function ediFn(){ return 'de", "cl'; } } typeof ediFn"
    ]));
    vInit = (seen === "function") ? 1 : 0;
  } catch (e) { vInit = -1; }
  try { vAfter = (typeof (realmObj as any).ediFn === "function") ? 1 : 0; } catch (e) { vAfter = -1; }

  // The \`block-scoping\` shape: a FUNCTION written into a caller binding, and a
  // primitive written into another, from one evaluation.
  var vFnWrite = 0;
  var vFnCall = 0;
  var vPrim = 0;
  try {
    (0, eval)(joinSource([
      "{ function bsF() { initialBV = bsF; bsF = 123; currentBV = bsF; return 'de", "cl'; } } bsF();"
    ]));
    vFnWrite = (typeof initialBV === "function") ? 1 : 0;
    vFnCall = (vFnWrite === 1 && (initialBV as any)() === "decl") ? 1 : 0;
    vPrim = (currentBV === 123) ? 1 : 0;
  } catch (e) { vFnWrite = -1; }

  // A pre-existing NON-ENUMERABLE global must reach the realm (probe P3): this
  // is the whole \`existing-non-enumerable-global-init\` cluster.
  var vHidden = 0;
  try {
    Object.defineProperty(realmObj, "hid", {
      value: "hx", enumerable: false, writable: true, configurable: true
    });
    vHidden = (0, eval)(joinSource(["(hid === 'h", "x') ? 1 : 0"])) as number;
  } catch (e) { vHidden = -1; }

  // …and EDI must not REINITIALISE it: the value is still "hx" inside the body,
  // the var-scoped binding is updated afterwards, and the DESCRIPTOR is untouched.
  var vNoReinit = 0;
  var vKeepDesc = 0;
  try {
    vNoReinit = (0, eval)(joinSource([
      "var pre = (hid === 'hx') ? 1 : 0; { function h", "id(){} } pre"
    ])) as number;
    vNoReinit = (vNoReinit === 1 && typeof (realmObj as any).hid === "function") ? 1 : 0;
    var d2: any = Object.getOwnPropertyDescriptor(realmObj, "hid");
    vKeepDesc = (d2 && d2.enumerable === false && d2.writable === true && d2.configurable === true) ? 1 : 0;
  } catch (e) { vNoReinit = -1; }

  // SECOND and THIRD evaluations after the new function-valued write-back path.
  var vSecond = 0;
  var vThird = 0;
  try { vSecond = (0, eval)(joinSource(["1 + ", "1"])) as number; } catch (e) { vSecond = -1; }
  try {
    (0, eval)(joinSource(["var lateVar = ", "9;"]));
    vThird = ((realmObj as any).lateVar === 9) ? 1 : 0;
  } catch (e) { vThird = -1; }

  // The declared-names probe evaluates the source as TEXT twice and as EFFECTS
  // zero times: the sentinel throw precedes the first statement by construction.
  var vNoBoom = 0;
  try {
    vNoBoom = (0, eval)(joinSource([
      "var boomWitness = 1; (function(){ return (boomWitn", "ess === 1) ? 1 : 0; })()"
    ])) as number;
  } catch (e) { vNoBoom = -1; }
  var vBoomOnce = 0;
  try {
    // If the probe had EXECUTED the source it would have run the increment too,
    // and the realm would read 2 rather than 1.
    vBoomOnce = ((realmObj as any).boomWitness === 1) ? 1 : 0;
  } catch (e) { vBoomOnce = -1; }

  // The memoized eval/Function markers survive every new write-back path.
  var vEvalAlive = 0;
  try { vEvalAlive = (0, eval)(joinSource(["20 + ", "22"])) as number; } catch (e) { vEvalAlive = -1; }

  // A DIRECT eval written at global scope takes the same route.
  var vDirect = 0;
  try {
    eval(joinSource(["var direct", "Var = 55;"]));
    vDirect = ((realmObj as any).directVar === 55) ? 1 : 0;
  } catch (e) { vDirect = -1; }

  export function engineProbe(): number { return vEngine; }
  export function realmProbe(): number { return vRealm; }
  export function createProbe(): number { return vCreate; }
  export function descProbe(): number { return vDesc; }
  export function initProbe(): number { return vInit; }
  export function afterProbe(): number { return vAfter; }
  export function fnWriteProbe(): number { return vFnWrite; }
  export function fnCallProbe(): number { return vFnCall; }
  export function primProbe(): number { return vPrim; }
  export function hiddenProbe(): number { return vHidden; }
  export function noReinitProbe(): number { return vNoReinit; }
  export function keepDescProbe(): number { return vKeepDesc; }
  export function secondProbe(): number { return vSecond; }
  export function thirdProbe(): number { return vThird; }
  export function noBoomProbe(): number { return vNoBoom; }
  export function boomOnceProbe(): number { return vBoomOnce; }
  export function evalAliveProbe(): number { return vEvalAlive; }
  export function directProbe(): number { return vDirect; }
`;

/**
 * #4245 slice 2 — the OUTWARD half. A plain QuickJS object reaching compiled
 * code is a mirrored live view, not an opaque handle box.
 *
 * The anti-vacuity bar here is higher than "a read works", because the failure
 * this slice fixes was itself a passing-looking one: test262's `verifyProperty`
 * gates EVERY descriptor check behind `hasOwnProperty(desc, field)`, so a box
 * that answers "no own properties" makes the whole helper a silent no-op. Two
 * cases below therefore assert the helper's own preconditions (`ownKeys` counts
 * exactly 3, `hasOwn` answers true) rather than only its verdict, and one
 * asserts a value QuickJS alone could produce (`configurable: false` — a
 * synthesized all-true descriptor would read `true`).
 */
const MEMBRANE_OUTWARD_SOURCE = `
  function joinSource(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }

  // A descriptor object built INSIDE the QuickJS realm and handed to a compiled
  // function — verbatim the shape of the 48 annexB \`*-global-init\` files.
  var report: any = { fields: 0, bad: 0, hasEnum: 0, hasValue: 0, enumVal: "", cfgVal: "" };
  function inspectDescriptor(desc: any): number {
    var names: any = Object.getOwnPropertyNames(desc);
    report.fields = (names as any).length as number;
    for (var i = 0; i < ((names as any).length as number); i += 1) {
      var f: any = (names as any)[i];
      if (f !== "value" && f !== "writable" && f !== "enumerable" && f !== "configurable" && f !== "get" && f !== "set") {
        report.bad = (report.bad as number) + 1;
      }
    }
    report.hasEnum = (Object as any).hasOwn(desc, "enumerable") ? 1 : 0;
    report.hasValue = (Object as any).hasOwn(desc, "value") ? 1 : 0;
    report.enumVal = String((desc as any).enumerable);
    report.cfgVal = String((desc as any).configurable);
    return 1;
  }
  var vInspect = 0;
  try {
    vInspect = (0, eval)(joinSource([
      "inspectDescriptor({ enumerable: true, writable: tr",
      "ue, configurable: false })"
    ])) as number;
  } catch (e) { vInspect = -1; }

  // A box returned to compiled code: read, then MUTATED BY A LATER EVAL.
  var vRead = 0;
  var vLive = 0;
  var vWriteBack = 0;
  try {
    var box: any = (0, eval)(joinSource(["globalThis.laneObj = { n: 4", "1, s: 'ok' }"]));
    vRead = ((box as any).n as number) * 10 + (((box as any).s as string)).length;
    (0, eval)(joinSource(["laneOb", "j.n = 55"]));
    vLive = (box as any).n as number;
    // …and the other direction: a compiled write, plus a compiled-side NEW key,
    // both observed inside the next evaluation.
    (box as any).n = 9;
    (box as any).fresh = 4;
    vWriteBack = (0, eval)(joinSource(["laneObj.n * 10 + laneOb", "j.fresh"])) as number;
  } catch (e) { vRead = -1; }

  // Enumerability is mirrored, not invented: a non-enumerable own property is
  // reported by getOwnPropertyNames and hidden from Object.keys.
  var vEnumFidelity = 0;
  try {
    var ne: any = (0, eval)(joinSource([
      "globalThis.neObj = Object.defineProperty({ vis: 1 }, 'hid', { value: 2, enumera",
      "ble: false, configurable: true, writable: true })"
    ]));
    vEnumFidelity =
      ((Object.getOwnPropertyNames(ne) as any).length as number) * 100 +
      ((Object.keys(ne) as any).length as number) * 10 +
      (((ne as any).hid as number));
  } catch (e) { vEnumFidelity = -1; }

  // Identity COLLAPSE, both ways. A compiled object crossing in as a wrapper and
  // straight back out must be the SAME object (\`qjs_wrapper_gc_handle\`), and one
  // QuickJS object read by two evals must be one box.
  var mine: any = { tag: 7 };
  function sameAsMine(x: any): number { return x === mine ? 1 : 0; }
  var vCollapse = 0;
  var vBoxIdentity = 0;
  try {
    vCollapse = (0, eval)(joinSource(["sameAsMi", "ne(mine)"])) as number;
  } catch (e) { vCollapse = -1; }
  try {
    var a1: any = (0, eval)(joinSource(["globalThis.idObj = { k: ", "1 }"]));
    var a2: any = (0, eval)(joinSource(["idOb", "j"]));
    vBoxIdentity = (a1 === a2) ? 1 : 0;
  } catch (e) { vBoxIdentity = -1; }

  // A self-referential object must not recurse forever while being mirrored.
  var vCycle = 0;
  try {
    var cyc: any = (0, eval)(joinSource(["globalThis.cycObj = { v: 3 }; cycObj.self = cycObj; cycOb", "j"]));
    vCycle = (((cyc as any).self as any) === cyc ? 10 : 0) + ((cyc as any).v as number);
  } catch (e) { vCycle = -1; }

  export function inspectProbe(): number { return vInspect; }
  export function fieldsProbe(): number { return report.fields as number; }
  export function badProbe(): number { return report.bad as number; }
  export function hasEnumProbe(): number { return report.hasEnum as number; }
  export function hasValueProbe(): number { return report.hasValue as number; }
  export function enumValProbe(): number { return (report.enumVal as string) === "true" ? 1 : 0; }
  export function cfgValProbe(): number { return (report.cfgVal as string) === "false" ? 1 : 0; }
  export function readProbe(): number { return vRead; }
  export function liveProbe(): number { return vLive; }
  export function writeBackProbe(): number { return vWriteBack; }
  export function enumFidelityProbe(): number { return vEnumFidelity; }
  export function collapseProbe(): number { return vCollapse; }
  export function boxIdentityProbe(): number { return vBoxIdentity; }
  export function cycleProbe(): number { return vCycle; }
`;

/**
 * #4308 slices C (function-caller EDI) and D (strict caller / strict source).
 *
 * Shaped like the corpus these two slices close: sloppy FUNCTION callers with a
 * DIRECT eval, plus the three `var-env-var-strict-*` shapes. Every source is
 * composed through a runtime loop (`tryStaticEvalInline` folds literals), and
 * every reading is asserted against compiled-side state.
 *
 * Anti-vacuity, measured: on the pre-slice adapter this module reads
 * `fnUpdate 0 · noSkip 1 · strictSource 1 · strictCaller -1 · lexCls -1`
 * — five of the twelve readings, i.e. it cannot pass with the slices reverted.
 */
const EDI_FUNC_SOURCE = `
  function joinSource(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }

  // --- annexB B.3.3.3, function caller: a TOP-LEVEL function declaration is
  // initialized at EDI, then the BLOCK one overwrites the varEnv binding. A
  // block-wrapped source demotes the top-level declaration to a block-lexical
  // one and answers "outer declaration" — the exact corpus failure.
  var after: any = 0;
  (function() {
    eval(joinSource([
      '{ function f() { return "inner declaration"; } }after = f;',
      ' function f() { return "outer declaration"; }'
    ]));
  }());
  var fnUpdate = 0;
  try { fnUpdate = (after() as string) === "inner declaration" ? 1 : 0; } catch (e) { fnUpdate = -1; }

  // --- the block function must UPDATE a same-named formal parameter, and must
  // NOT re-initialize it to \`undefined\` first.
  var init: any = 0;
  var after2: any = 0;
  (function(f: any) {
    eval(joinSource(['init = f;{ function f() {  } }', 'after2 = f;']));
  }(123));
  var noSkip = ((init as number) === 123 ? 1 : 0) + (typeof after2 === "function" ? 10 : 0);

  // --- an eval-CREATED FUNCTION is claimed into the caller's activation pool
  // and is FUNCTION-SCOPED. The two readings together are what make this a
  // measurement rather than a tautology: before the slice the function was
  // simply LEFT on the QuickJS realm, where a later direct eval could still
  // reach it (so \`poolFn\` alone would pass) — but so could an INDIRECT one,
  // which is a global-scope evaluation and must NOT see a function-scoped
  // binding. \`poolScoped\` is the reading that separates the two.
  //
  // The second and third evaluations are deliberate: a write-back path that
  // corrupts the realm shows up on a LATER evaluation, not the first.
  var poolFn = -1;
  var poolScoped = -1;
  function poolFnCaller(): void {
    try {
      eval(joinSource(["function created(a) { return a + ", "40; }"]));
      var one = eval(joinSource(["created(", "1)"])) as number;
      var two = (0, eval)(joinSource(["1 + ", "1"])) as number;
      var three = eval(joinSource(["created(", "2)"])) as number;
      poolFn = one + two + three;
      poolScoped = (0, eval)(joinSource(["typeof crea", "ted === 'undefined' ? 1 : 0"])) as number;
    } catch (e) { poolFn = -2; }
  }
  poolFnCaller();

  // --- slice D: a STRICT SOURCE under a sloppy caller gets its own variable
  // environment, so the caller's \`v\` is untouched.
  var strictSource = -1;
  (function() {
    var v: any = 0;
    (function() {
      eval(joinSource(["'use strict';var v", " = 1"]));
      strictSource = v as number;
    }());
  }());

  // --- slice D: a STRICT CALLER. The eval's own \`var w\` must not reach the
  // caller's \`w\`, an assignment to an existing binding must, and the
  // assignment must survive a THROW (the \`finally\` copy-out).
  var strictCaller = -1;
  var strictWrite = -1;
  var strictThrow = -1;
  function strictArm(): void {
    "use strict";
    var w: any = 0;
    eval(joinSource(["var w = ", "1"]));
    strictCaller = w as number;
    var x: any = 1;
    eval(joinSource(["x = x + ", "41"]));
    strictWrite = x as number;
    var y: any = 0;
    try { eval(joinSource(["y = 9; throw new Error('bo", "om')"])); } catch (e) { }
    strictThrow = y as number;
  }
  strictArm();

  // --- slice D: eval's lexical declarations do not leak between evaluations.
  var lexCls = 0;
  try {
    eval(joinSource(["class outside", " {}"]));
    eval(joinSource(["class outside", " {}"]));
    lexCls = 1;
  } catch (e) { lexCls = -1; }

  // --- slice C: the declaration-free ARROW caller. Its layers are all empty,
  // exactly like global code inside a block, so only the routing sentinel can
  // tell them apart. \`arrowGlobal\` reads 1 when the \`var\` did NOT land on the
  // global object, which is the whole point of the one \`src/\` line.
  var arrowGlobal = -1;
  var arrowInner = -1;
  var arrowFn: any = () => {
    eval(joinSource(["var arrowVar = ", "7; arrowInner = arrowVar;"]));
    arrowGlobal = typeof (globalThis as any).arrowVar === "undefined" ? 1 : 0;
  };
  arrowFn();

  // --- caller-pool metadata stays metadata. Each visible eval binding now has
  // an adjacent impossible-name marker. Fill all 64 visible slots so a marker
  // accidentally treated as a binding or capacity slot cannot hide.
  var markerDecl = "";
  for (var mi = 0; mi < 64; mi += 1) markerDecl = markerDecl + "var m" + mi + " = " + mi + ";";
  var poolMarkerInvisible = -1;
  var poolReuse = -1;
  var poolReuseOverflow = -1;
  function markerPoolCaller(): void {
    try {
      eval(joinSource([markerDecl, ""]));
      poolMarkerInvisible = eval(joinSource([
        "Object.getOwnPropertyNames(__js2wasm_eval_scope__).some(function (k) {",
        " return k === '' || k.indexOf('js2wasm:deletable-eval-binding') >= 0; }) ? 0 : 1"
      ])) as number;
      var deleted: any = eval(joinSource(["delete m", "0"]));
      eval(joinSource(["var replacement = ", "99;"]));
      var replacementSum: any = eval(joinSource(["m1 + replace", "ment"]));
      poolReuse = deleted === true && replacementSum === 100 ? 1 : 0;
      poolReuseOverflow = (0, eval)(joinSource([
        "typeof __js2wasm_eval_pool_overflow_count__ === 'number' ? ",
        "__js2wasm_eval_pool_overflow_count__ : 0"
      ])) as number;
    } catch (e) {
      poolMarkerInvisible = -1;
      poolReuse = -1;
      poolReuseOverflow = -1;
    }
  }
  markerPoolCaller();

  // --- redeclaring a persisted eval binding must not hide a successful
  // deletion. EDI presents \`r0\` on the QuickJS realm for the redeclaration,
  // while the paired marker in the caller pool remains the authority for
  // whether that binding may become a vacancy. Fill all 64 groups so the
  // replacement can only persist by reusing the exact deleted group.
  var redeclaredPoolDecl = "";
  for (var ri = 0; ri < 64; ri += 1) {
    redeclaredPoolDecl = redeclaredPoolDecl + "var r" + ri + " = " + ri + ";";
  }
  var poolRedeclareDelete = -1;
  var poolRedeclareReuse = -1;
  var poolRedeclareScoped = -1;
  var poolRedeclareOverflow = -1;
  function redeclaredPoolCaller(): void {
    try {
      eval(joinSource([redeclaredPoolDecl, ""]));
      var deleted: any = eval(joinSource(["var r0; delete r", "0"]));
      var missing: any = eval(joinSource(["typeof r0 === 'undefined' ? ", "1 : 0"]));
      eval(joinSource(["var replacementAfterRedeclare = ", "99;"]));
      var replacementSum: any = eval(joinSource(["r1 + replacementAfterRede", "clare"]));
      poolRedeclareDelete = deleted === true && missing === 1 ? 1 : 0;
      poolRedeclareReuse = replacementSum === 100 ? 1 : 0;
      poolRedeclareScoped = (0, eval)(joinSource([
        "typeof replacementAfterRedeclare === 'undefined' ? ",
        "1 : 0"
      ])) as number;
      poolRedeclareOverflow = (0, eval)(joinSource([
        "typeof __js2wasm_eval_pool_overflow_count__ === 'number' ? ",
        "__js2wasm_eval_pool_overflow_count__ : 0"
      ])) as number;
    } catch (e) {
      poolRedeclareDelete = -1;
      poolRedeclareReuse = -1;
      poolRedeclareScoped = -1;
      poolRedeclareOverflow = -1;
    }
  }
  redeclaredPoolCaller();

  // --- the pool's 64-slot ceiling is ACCEPTED but not silent: overflowing it
  // must neither trap nor mis-slot, and the drop must be countable.
  //
  // The 70 declarations are built at MODULE level on purpose. A
  // \`for (var i = …)\` loop in the same function as a direct eval currently
  // emits an INVALID module (\`local.tee … expected (ref null N), found i32\`) —
  // engine-independent caller-side codegen, reproduced on the base tree with
  // this branch's \`src/\` change reverted, so it is neither slice C's nor D's.
  // \`let\` in the loop head is unaffected.
  var poolDecl = "";
  for (var pi = 0; pi < 70; pi += 1) poolDecl = poolDecl + "var n" + pi + " = " + pi + ";";
  var poolOverflow = -1;
  var poolNamed = 0;
  function poolCaller(): void {
    try {
      eval(joinSource([poolDecl, ""]));
      poolOverflow = (0, eval)(joinSource(["typeof __js2wasm_eval_pool_overflow_count__ === 'number' ? __js2wasm_eval_pool_overflow_cou", "nt__ : 0"])) as number;
      poolNamed = (0, eval)(joinSource(["1 + ", "1"])) as number;
    } catch (e) { poolOverflow = -1; }
  }
  poolCaller();

  export function fnUpdateProbe(): number { return fnUpdate; }
  export function noSkipProbe(): number { return noSkip; }
  export function poolFnProbe(): number { return poolFn; }
  export function poolScopedProbe(): number { return poolScoped; }
  export function strictSourceProbe(): number { return strictSource; }
  export function strictCallerProbe(): number { return strictCaller; }
  export function strictWriteProbe(): number { return strictWrite; }
  export function strictThrowProbe(): number { return strictThrow; }
  export function lexClsProbe(): number { return lexCls; }
  export function arrowGlobalProbe(): number { return arrowGlobal; }
  export function arrowInnerProbe(): number { return arrowInner; }
  export function poolMarkerInvisibleProbe(): number { return poolMarkerInvisible; }
  export function poolReuseProbe(): number { return poolReuse; }
  export function poolReuseOverflowProbe(): number { return poolReuseOverflow; }
  export function poolRedeclareDeleteProbe(): number { return poolRedeclareDelete; }
  export function poolRedeclareReuseProbe(): number { return poolRedeclareReuse; }
  export function poolRedeclareScopedProbe(): number { return poolRedeclareScoped; }
  export function poolRedeclareOverflowProbe(): number { return poolRedeclareOverflow; }
  export function poolOverflowProbe(): number { return poolOverflow; }
  export function poolNamedProbe(): number { return poolNamed; }
`;

const availableArtifactDir = quickjsProviderAvailable();
const enabled = process.env[ENGINE_ENV] === "quickjs" || availableArtifactDir !== null;

describe.skipIf(!enabled)("#4245 slice 1 — quickjs eval membrane (inward)", () => {
  let probe: Record<string, () => number>;
  let direct: Record<string, () => number>;
  let errors: Record<string, () => number>;
  let edi: Record<string, () => number>;
  let ediFunc: Record<string, () => number>;
  let outward: Record<string, () => number>;

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
    errors = await link(MEMBRANE_ERROR_IDENTITY_SOURCE, "quickjs-membrane-error-identity.ts", {
      inferModuleStrictArguments: false,
    });
    // `inferModuleStrictArguments: false` is the Script goal — the option (not
    // the source shape) that every `language/eval-code/` test compiles under.
    edi = await link(EDI_GLOBAL_SOURCE, "quickjs-edi-global.ts", {
      inferModuleStrictArguments: false,
    });
    outward = await link(MEMBRANE_OUTWARD_SOURCE, "quickjs-membrane-outward.ts", {
      inferModuleStrictArguments: false,
    });
    ediFunc = await link(EDI_FUNC_SOURCE, "quickjs-edi-func.ts", {
      inferModuleStrictArguments: false,
    });
  }, 300_000);

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

  // ---------------------------------------- #4308 slice A: error identity ---

  it("the error-identity lane really ran under the quickjs engine", () => {
    // In-band marker, not an arithmetic result any engine could produce.
    expect(errors.engineProbe!()).toBe(1);
  });

  it("in-eval `assert.throws(ReferenceError, …)` matches on IDENTITY (the done-signal)", () => {
    // 1 = `thrown.constructor === expectedErrorConstructor`. Pre-slice-A this
    // reads 0 with sameNameMissProbe() === 3 — the corpus's exact failure.
    expect(errors.identityProbe!()).toBe(1);
    expect(errors.sameNameMissProbe!()).toBe(0);
    expect(errors.missesProbe!()).toBe(0);
  });

  it("realm-side `e instanceof ReferenceError` still answers true", () => {
    // The half a "mirror the compiled constructors INTO the realm" fix breaks:
    // QuickJS builds engine-generated errors from its own intrinsics whatever
    // the global binding says.
    expect(errors.realmInstanceofProbe!()).toBe(1);
  });

  it("the SECOND and THIRD evaluations after the new crossing path still match", () => {
    // Delayed realm corruption surfaces on a LATER eval, never the first.
    expect(errors.secondProbe!()).toBe(1);
    expect(errors.thirdProbe!()).toBe(1);
    expect(errors.hitsProbe!()).toBe(3);
  });

  it("an intrinsic error constructor crossing out as a COMPLETION value is the caller's own", () => {
    // The argument path and the completion path are different crossings; both
    // funnel through qjsPublish, and this pins the one the arg case does not.
    expect(errors.indirectProbe!()).toBe(1);
  });

  // ------------------------------------- #4308 slice B: global/indirect EDI ---

  it("the EDI lane really ran under the quickjs engine", () => {
    expect(edi.engineProbe!()).toBe(1);
  });

  it("`Function('return this;')()` is the CALLER'S realm, not an opaque box", () => {
    // The premise every eval-global test rests on: test262's fnGlobalObject.
    // Pre-slice-B this reads 0 — a box with one `__qjs_handle__` property.
    expect(edi.realmProbe!()).toBe(1);
  });

  it("EDI creates the var binding on the caller's realm with B.3.3.3 attributes", () => {
    expect(edi.createProbe!()).toBe(1);
    // {writable:true, enumerable:true, configurable:true} — what
    // CreateGlobalVarBinding prescribes and what `verifyProperty` checks.
    expect(edi.descProbe!()).toBe(1);
  });

  it("an annex-B block function is `undefined` inside the body and a function after", () => {
    expect(edi.initProbe!()).toBe(1);
    expect(edi.afterProbe!()).toBe(1);
  });

  it("a FUNCTION crosses back into a caller binding, callable (the done-signal)", () => {
    // 1 = `typeof initialBV === "function"`, and the call returns the value only
    // the evaluated body produces. This is the `block-scoping` /
    // `existing-block-fn-update` shape. Pre-slice-B both read 0.
    expect(edi.fnWriteProbe!()).toBe(1);
    expect(edi.fnCallProbe!()).toBe(1);
    // …and a primitive written in the SAME evaluation still lands.
    expect(edi.primProbe!()).toBe(1);
  });

  it("a NON-ENUMERABLE compiled global is visible inside evaluated code", () => {
    // Probe P3's decisive question. `Object.keys` cannot see it; the widened
    // push reads it through `Object.getOwnPropertyNames`.
    expect(edi.hiddenProbe!()).toBe(1);
  });

  it("EDI does not REINITIALISE an existing binding, and leaves its descriptor", () => {
    expect(edi.noReinitProbe!()).toBe(1);
    // enumerable:false survives — the pull assigns, it never re-defines.
    expect(edi.keepDescProbe!()).toBe(1);
  });

  it("the SECOND and THIRD evaluations after the new write-back path are clean", () => {
    expect(edi.secondProbe!()).toBe(2);
    expect(edi.thirdProbe!()).toBe(1);
    // The memoized eval/Function markers were not clobbered.
    expect(edi.evalAliveProbe!()).toBe(42);
  });

  it("the declared-names probe has ZERO side effects on the caller's realm", () => {
    // The source runs exactly once — under the real evaluation. If the probe
    // had executed it too, the witness would read 2.
    expect(edi.noBoomProbe!()).toBe(1);
    expect(edi.boomOnceProbe!()).toBe(1);
  });

  it("a DIRECT eval written at global scope takes the same EDI route", () => {
    expect(edi.directProbe!()).toBe(1);
  });

  // ---------------------------------------------- #4245 slice 2 (outward) ---

  it("a QuickJS descriptor object reaches a compiled function with its REAL own keys", () => {
    // The precondition, not the verdict. `fields === 3` is what makes test262's
    // `verifyProperty` a real check rather than a silent no-op, and `bad === 0`
    // is the "Invalid descriptor field: __qjs_handle__" failure the 48-file
    // cluster reported before this slice.
    expect(outward.inspectProbe!()).toBe(1);
    expect(outward.fieldsProbe!()).toBe(3);
    expect(outward.badProbe!()).toBe(0);
  });

  it("hasOwnProperty on the box answers TRUE for a present key and FALSE for an absent one", () => {
    // The single reason a Proxy box was rejected: `__hasOwnProperty` has no
    // `$Proxy` arm, so it answers false for every key and `verifyProperty`
    // verifies nothing while reporting success.
    expect(outward.hasEnumProbe!()).toBe(1);
    expect(outward.hasValueProbe!()).toBe(0);
  });

  it("descriptor VALUES cross faithfully, including a false flag", () => {
    // `configurable: false` is the anti-vacuity half — a synthesized all-true
    // descriptor, which is what the plan's own fallback would have produced,
    // reads `true` here.
    expect(outward.enumValProbe!()).toBe(1);
    expect(outward.cfgValProbe!()).toBe(1);
  });

  it("a QuickJS object read by compiled code carries its properties", () => {
    expect(outward.readProbe!()).toBe(412); // 41 * 10 + "ok".length
  });

  it("a LATER eval's mutation is visible to the compiled side (acceptance box 2)", () => {
    expect(outward.liveProbe!()).toBe(55);
  });

  it("a compiled write — and a compiled-side NEW key — reach the QuickJS object", () => {
    expect(outward.writeBackProbe!()).toBe(94); // n = 9, fresh = 4
  });

  it("enumerability is mirrored, not invented", () => {
    // 2 own names, 1 enumerable key, and the hidden value still readable.
    expect(outward.enumFidelityProbe!()).toBe(212);
  });

  it("a compiled object handed through eval and back is the SAME object", () => {
    // `qjs_wrapper_gc_handle` was exported and declared by slice 1 but had no
    // caller on this path, so identity was lost on the way out.
    expect(outward.collapseProbe!()).toBe(1);
  });

  it("one QuickJS object read by two evals is ONE box", () => {
    expect(outward.boxIdentityProbe!()).toBe(1);
  });

  it("a self-referential QuickJS object mirrors without recursing forever", () => {
    expect(outward.cycleProbe!()).toBe(13); // self === box, v === 3
  });

  // ---- #4308 slice C — function-caller EvalDeclarationInstantiation --------

  it("a TOP-LEVEL function declaration in eval code stays top-level (annexB order)", () => {
    // 0 would be "outer declaration" — the reading a block-wrapped source gives,
    // and the exact `func:existing-fn-update` corpus failure.
    expect(ediFunc.fnUpdateProbe!()).toBe(1);
  });

  it("an annexB block function UPDATES a same-named formal parameter without re-initializing it", () => {
    // 1 = `init` still 123 (not reset to undefined); 10 = the parameter is a
    // function afterwards. 1 alone is the pre-slice reading.
    expect(ediFunc.noSkipProbe!()).toBe(11);
  });

  it("an eval-created FUNCTION lands in the caller's variable environment and stays callable", () => {
    // 41 + 2 + 42 — the first call, an intervening SECOND evaluation, and a
    // THIRD call after it. A write-back that corrupts the realm fails the tail,
    // not the head.
    expect(ediFunc.poolFnProbe!()).toBe(85);
  });

  it("…and it is FUNCTION-scoped: an indirect eval does not see it", () => {
    // The discriminating half. Before the slice the function was left on the
    // QuickJS realm, where a global-scope evaluation could reach it too — this
    // reads 0 in that world and 1 only when the binding really moved into the
    // caller's activation pool.
    expect(ediFunc.poolScopedProbe!()).toBe(1);
  });

  it("a declaration-free ARROW caller keeps its eval's `var` off the global object", () => {
    // The one `src/` line. Without the routing sentinel the arrow is
    // indistinguishable from global code and this reads 0.
    expect(ediFunc.arrowGlobalProbe!()).toBe(1);
    expect(ediFunc.arrowInnerProbe!()).toBe(7);
  });

  it("activation-pool marker entries never become QuickJS scope bindings", () => {
    // A leaked leading-NUL marker reaches qjs_set_prop_str as the empty-string
    // key today; the substring guard also catches it if the key transport ever
    // becomes length-aware. The source fills every one of the 64 visible slots
    // first, so a half-capacity walk cannot pass this by accident.
    expect(ediFunc.poolMarkerInvisibleProbe!()).toBe(1);
  });

  it("deleting a persisted eval binding releases its paired slot for coherent reuse", () => {
    expect(ediFunc.poolReuseProbe!()).toBe(1);
    // Exactly 64 names, one deletion, then one replacement must not count as
    // overflow. This separates real pair reuse from a replacement left on the
    // QuickJS realm where a later indirect eval could see it.
    expect(ediFunc.poolReuseOverflowProbe!()).toBe(0);
  });

  it("redeclaring then deleting a persisted eval binding releases that exact paired slot", () => {
    expect(ediFunc.poolRedeclareDeleteProbe!()).toBe(1);
    expect(ediFunc.poolRedeclareReuseProbe!()).toBe(1);
    // The replacement belongs to the caller activation, not the QuickJS realm.
    expect(ediFunc.poolRedeclareScopedProbe!()).toBe(1);
    // With all 64 groups occupied, zero overflow proves the replacement reused
    // the four-cell group whose redeclared binding was deleted.
    expect(ediFunc.poolRedeclareOverflowProbe!()).toBe(0);
  });

  it("pool exhaustion fails SAFE and is countable, never a trap or a mis-slot", () => {
    // 70 declared names against 64 slots: the tail is dropped by design, the
    // drop is counted, and the very next evaluation still works.
    expect(ediFunc.poolOverflowProbe!()).toBe(6);
    expect(ediFunc.poolNamedProbe!()).toBe(2);
  });

  // ---- #4308 slice D — strict caller / strict source -----------------------

  it("a STRICT SOURCE under a sloppy caller cannot instantiate the caller's var", () => {
    expect(ediFunc.strictSourceProbe!()).toBe(0);
  });

  it("a STRICT CALLER's eval cannot instantiate a var in the caller's scope", () => {
    // -1 is the pre-slice reading: the `const` preamble collided with the
    // source's own `var` and the whole eval threw
    // `invalid redefinition of lexical identifier`.
    expect(ediFunc.strictCallerProbe!()).toBe(0);
  });

  it("a STRICT CALLER's eval CAN assign to an existing caller binding", () => {
    expect(ediFunc.strictWriteProbe!()).toBe(42);
  });

  it("a strict-caller write survives a throw later in the same eval", () => {
    expect(ediFunc.strictThrowProbe!()).toBe(9);
  });

  it("eval's lexical declarations do not leak into the next evaluation", () => {
    // -1 = the second `class outside {}` threw `redeclaration of 'outside'`,
    // which is what evaluating as a fresh Script (rather than through the
    // realm's own eval) does.
    expect(ediFunc.lexClsProbe!()).toBe(1);
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
