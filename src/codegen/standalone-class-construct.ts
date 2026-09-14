// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// standalone-class-construct.ts — (#5383 S2g) `new K(…)` where `K` is a class
// reached as a VALUE, under `--target standalone`.
//
// ## The defect (measured, three lines, ONE module, no link boundary)
//
//     class PlainDate { constructor(y) { this.y = y; } }
//     const mk = (K) => new K(5);
//     export function test() { return mk(PlainDate).y; }   // undefined
//
// `tryCompileNativeConstructFromValue` owns that call site and routes it to the
// per-arity `__native_construct_<N>` driver (#3981). The driver's ordinary
// §10.2.2 tail is `proto = callee.prototype`, `self = Object.create(proto)`,
// `result = __call_fn_method_<N>(self, callee, …)` — a CLOSURE dispatch. But a
// class value in standalone is not a closure: it is the class-object singleton,
// an `extern.convert_any`'d `$ClassName` STRUCT with the same type and the same
// `__tag` as an instance (#3976, `class-object-of.ts`). The module-local
// closure dispatcher misses, `result` is null, and the driver returns the bare
// `Object.create(proto)` — an object with none of the constructor's own fields.
//
// The same hole exists on the wasm→wasm boundary: `__js2wasm_link_construct`
// (#5383 S2f R12) runs that identical ordinary tail on the PROVIDER side, so a
// consumer's `new NS.PlainDate(…)` reached the provider and still got an empty
// object back.
//
// ## The mechanism
//
// One `construct` trampoline per standalone class, keyed by the class's
// IDENTITY (its class-object singleton global) rather than by type — the same
// discriminator #5383 S2f R13 had to use for `typeof`, and for the same reason:
// no `ref.test` can separate a class value from an instance of that class.
//
//     __class_construct_<Name>(args: externref-vec, argc: i32) -> externref
//         a_i = i < argc ? coerce(args[i]) : <zero of the formal's type>
//         (new.target := <Name>; __argc := min(argc, formals))
//         return box(<Name>_new(a_0 … a_n))
//
//     __class_construct_dispatch(callee, args, argc) -> externref
//         ref.eq the callee against each class-object singleton, in turn;
//         on a hit, tail into that class's trampoline. No hit ⇒ null, which is
//         the caller's signal to keep its previous behaviour EXACTLY.
//
// `<Name>_new` is the SAME constructor entry a static `new Name(…)` calls, so
// field initializers, `super(…)` and parameter defaults all run by
// construction rather than by re-implementation. The argument marshalling is
// `extern-arg-marshal.ts`'s (`externArgCoercionInstrs` / `resultBoxingInstrs`),
// shared with the method dispatchers so a defaulted `f64` formal keeps the
// #5380 omitted-argument sentinel in BOTH callers.
//
// Missing arguments are padded with the formal's ZERO value and the real
// defaults come from the callee's own parameter prologue, which reads the
// `__argc` module global (#5244) — the trampoline publishes the true count, so
// `new K()` on `constructor(y = 7)` runs the initializer instead of seeing 0.
// `__argc` is only WRITTEN when the callee actually consults it; the global is
// never created here (it exists already whenever a prologue reads it), so a
// finalize-time global append can never happen.
//
// ## Scope / byte-neutrality
//
// Standalone (and WASI) only, and only for a module that (a) has at least one
// eligible class and (b) either compiles a `new <runtime value>` site or is a
// provider whose consumer is wasm. Every other module emits identical bytes
// (sha256 A/B, 6 modules x 2 targets); the JS-host lane never reaches here at
// all (it routes through `__construct_closure` / the host mirror).
//
// `extends Array` and other builtin-parent classes are deliberately EXCLUDED:
// they have no `$ClassName` struct and their construction already has a
// standalone path (`standalone-subclass-ctors.ts`). Adding them here would
// replace a working lowering, not fill a hole.

import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { buildCoerceIdxs, externArgCoercionInstrs, resultBoxingInstrs } from "./extern-arg-marshal.js";
import { classMemberFuncKey } from "./class-member-keys.js";
import { funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { emitSetNewTargetBeforeCall } from "./new-target.js";
import { addFuncType } from "./registry/types.js";
import { defaultValueInstrs } from "./type-coercion.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
/** WasmGC `eq` abstract heap type — the only thing `ref.eq` accepts. */
const EQ_HEAP_TYPE = -19;

export const CLASS_CONSTRUCT_DISPATCH = "__class_construct_dispatch";

/**
 * Modules with a `new <runtime value>` site — the ONLY sites whose callee can
 * turn out to be a class-object singleton.
 *
 * A construct-driver reservation is NOT that signal: `array-species.ts` and
 * `array-from-native.ts` reserve one for species construction in any module
 * that touches those builtins, so gating on "a driver exists" changed the bytes
 * of every class-bearing standalone module that merely used an Array method
 * (measured: +134 B on a two-class module with no dynamic `new` at all).
 */
const valueConstructSites = new WeakSet<CodegenContext>();

/** Record that this module constructs from a runtime VALUE. */
export function markClassValueConstructSite(ctx: CodegenContext): void {
  valueConstructSites.add(ctx);
}

/**
 * The one gate for everything in this module: a `new <value>` site here, or a
 * provider whose consumer is wasm (its boundary terminal is the other caller).
 * Every other standalone module emits exactly the bytes it did before.
 */
function classConstructWanted(ctx: CodegenContext): boolean {
  if (!ctx.standalone && !ctx.wasi) return false;
  return valueConstructSites.has(ctx) || ctx.exportsConsumedByWasm === true;
}

/**
 * (#5383 S2g) `ref.eq` arms over every class-object singleton, running
 * `onMatch` on a hit — the SAME identity discriminator `typeof` needs (#5383
 * S2f R13): a class VALUE is a `$ClassName` struct with the same type and tag
 * as an instance, so only identity can separate them.
 *
 * Exported for `__reflect_is_constructor`, which answers the `[[Construct]]`
 * bit the wasm→wasm boundary's `callableKind` terminal publishes. Standalone /
 * WASI callers only — the JS-host lane has the class mirror and must stay
 * byte-identical.
 */
export function classObjectIdentityArms(ctx: CodegenContext, anyLocalIdx: number, onMatch: Instr[]): Instr[] {
  if (!classConstructWanted(ctx)) return [];
  const globals = [...ctx.classObjectGlobals.values()].sort((a, b) => a - b);
  if (globals.length === 0) return [];
  const inner: Instr[] = [];
  for (const globalIdx of globals) {
    // Lazy singleton: an untouched class holds a null global, which is not
    // eq-castable — test castability per global rather than casting blind.
    inner.push(
      { op: "global.get", index: globalIdx },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
          { op: "global.get", index: globalIdx },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
          { op: "ref.eq" },
          { op: "if", blockType: { kind: "empty" }, then: [...onMatch] },
        ],
      },
    );
  }
  return [
    { op: "local.get", index: anyLocalIdx },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "if", blockType: { kind: "empty" }, then: inner },
  ];
}

interface ClassConstructCandidate {
  className: string;
  classObjectGlobalIdx: number;
  ctorFuncIdx: number;
  paramTypes: ValType[];
  resultType: ValType | undefined;
}

function collectCandidates(ctx: CodegenContext): ClassConstructCandidate[] {
  const out: ClassConstructCandidate[] = [];
  for (const className of [...ctx.classObjectGlobals.keys()].sort()) {
    // An externref-backed builtin subclass keeps its own construction path.
    if (ctx.classBuiltinParentMap.has(className)) continue;
    if (ctx.structMap.get(className) === undefined) continue;
    const classObjectGlobalIdx = ctx.classObjectGlobals.get(className);
    const ctorFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${className}_new`));
    if (classObjectGlobalIdx === undefined || ctorFuncIdx === undefined) continue;
    const signature = funcSignatureOf(ctx, ctorFuncIdx);
    if (!signature) continue;
    out.push({
      className,
      classObjectGlobalIdx,
      ctorFuncIdx,
      paramTypes: [...signature.params],
      resultType: signature.results.length > 0 ? signature.results[0] : undefined,
    });
  }
  return out;
}

/** Mint one function at FINALIZE, exactly as the late dispatcher fills do. */
function mint(ctx: CodegenContext, name: string, params: ValType[], body: Instr[]): number {
  const typeIdx = addFuncType(ctx, params, [EXTERNREF], `$${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: [], body, exported: false } as WasmFunction);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

function buildTrampolineBody(
  ctx: CodegenContext,
  candidate: ClassConstructCandidate,
  externGetIdxIdx: number,
): Instr[] {
  const ci = buildCoerceIdxs(ctx);
  const optionalParams = ctx.funcOptionalParams.get(`${candidate.className}_new`) ?? [];
  const body: Instr[] = [];
  for (let a = 0; a < candidate.paramTypes.length; a++) {
    const want = candidate.paramTypes[a] ?? EXTERNREF;
    const present: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "f64.const", value: a },
      { op: "call", funcIdx: externGetIdxIdx },
      ...externArgCoercionInstrs(
        ci,
        want,
        optionalParams.some((candidateParam) => candidateParam.index === a),
      ),
    ];
    body.push(
      { op: "i32.const", value: a },
      { op: "local.get", index: 1 },
      { op: "i32.lt_s" },
      { op: "if", blockType: { kind: "val", type: want }, then: present, else: defaultValueInstrs(want) },
    );
  }
  // No-op unless the module uses `new.target` (`ctx.usesNewTarget`).
  emitSetNewTargetBeforeCall(ctx, body, candidate.className);
  // (#5244) Publish the call-site count for the callee's default prologue,
  // clamped to the formal count exactly as `maybeSetArgcForKnownCall` does.
  // Only when the callee consults it AND the global already exists — this runs
  // at finalize, where appending a module global is not safe.
  const needsArgc =
    ctx.funcUsesArguments.has(`${candidate.className}_new`) || ctx.funcOptionalParams.has(`${candidate.className}_new`);
  if (needsArgc && ctx.argcGlobalIdx >= 0) {
    body.push(
      { op: "local.get", index: 1 },
      { op: "i32.const", value: candidate.paramTypes.length },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: candidate.paramTypes.length },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "global.set", index: ctx.argcGlobalIdx },
    );
  }
  body.push({ op: "call", funcIdx: candidate.ctorFuncIdx });
  if (candidate.resultType !== undefined) body.push(...resultBoxingInstrs(ci, candidate.resultType));
  else body.push({ op: "ref.null.extern" });
  return body;
}

/**
 * Mint the per-class construct trampolines and their identity dispatcher.
 *
 * Idempotent, and returns the dispatcher's funcIdx (or `undefined` when this
 * module has nothing to dispatch — in which case every caller keeps the exact
 * bytes it emitted before this module existed).
 *
 * Called from `fillNativeConstructDrivers` (finalize) so it precedes BOTH
 * consumers: the `__native_construct_<N>` drivers filled right after it, and
 * `__js2wasm_link_construct`, filled later by
 * `publishStandaloneLinkBoundaryExports`.
 */
export function ensureStandaloneClassConstructDispatch(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(CLASS_CONSTRUCT_DISPATCH);
  if (existing !== undefined) return existing;
  if (!classConstructWanted(ctx)) return undefined;
  // `__extern_get_idx` is the native index read (host-import-free); without it
  // a trampoline cannot source its arguments at all.
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  if (externGetIdxIdx === undefined) return undefined;
  const candidates = collectCandidates(ctx);
  if (candidates.length === 0) return undefined;

  const trampolines: { candidate: ClassConstructCandidate; funcIdx: number }[] = [];
  for (const candidate of candidates) {
    const name = `__class_construct_${candidate.className}`;
    if (ctx.funcMap.has(name)) continue;
    const funcIdx = mint(ctx, name, [EXTERNREF, I32], buildTrampolineBody(ctx, candidate, externGetIdxIdx));
    trampolines.push({ candidate, funcIdx });
  }
  if (trampolines.length === 0) return undefined;

  // params: 0 = callee, 1 = args vec, 2 = argc. Local 3 = the callee as anyref.
  const dispatchBody: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: 3 },
  ];
  const inner: Instr[] = [];
  for (const { candidate, funcIdx } of trampolines) {
    inner.push(
      // The singleton global is LAZY: before its first materialisation it holds
      // a null externref, which is not eq-castable — so test castability per
      // global rather than casting blind (a bare cast would trap on a class
      // the program never read as a value).
      { op: "global.get", index: candidate.classObjectGlobalIdx },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 },
          { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
          { op: "global.get", index: candidate.classObjectGlobalIdx },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
          { op: "ref.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "local.get", index: 2 },
              { op: "call", funcIdx },
              { op: "return" },
            ],
          },
        ],
      },
    );
  }
  dispatchBody.push(
    { op: "local.get", index: 3 },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "if", blockType: { kind: "empty" }, then: inner },
    // No class matched. Null is the "not mine" answer every caller already
    // knows how to fall through on.
    { op: "ref.null.extern" },
  );

  const dispatchIdx = mint(ctx, CLASS_CONSTRUCT_DISPATCH, [EXTERNREF, EXTERNREF, I32], dispatchBody);
  const dispatchFn = ctx.mod.functions.find((fn) => (fn as { name?: string }).name === CLASS_CONSTRUCT_DISPATCH);
  if (dispatchFn) (dispatchFn as WasmFunction).locals = [{ name: "__cc_callee_any", type: { kind: "anyref" } }];
  return dispatchIdx;
}
