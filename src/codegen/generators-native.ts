// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Wasm-native generator lowering (#680).
 *
 * No-JS-host state-machine path for `function*` declarations. The body is
 * decomposed into a flat list of **states**; each `yield` is a suspension
 * checkpoint that spills live locals into a WasmGC state struct and returns a
 * `{value, done}` result. `next()` re-enters a generated resume function at the
 * saved state.
 *
 * Phase 1 (#1665) handled a linear sequence of sequential numeric yields with
 * an optional numeric `return`.
 *
 * Phase 2 (#2079) adds yields inside structured control flow — `while` / `for`
 * / `do-while` loops and `if` / `else` — by lowering each construct to states
 * with explicit successor-state transitions and driving them with a trampoline:
 * the resume function wraps the state dispatch in a `loop`, a yield/return
 * `br`s out producing the result, and a non-yielding transition (loop back-edge,
 * if-join, sequential boundary) sets the state field and `br`s back to the
 * dispatch top to re-enter at the new state within the same `next()` call.
 *
 * Constraints kept for this slice (bail to the scoped diagnostic / host path):
 *   - yielded expressions and spilled locals are numeric (f64);
 *   - `yield*`, `break`/`continue` targeting a yield-loop, `switch`/labeled
 *     statements with yields, and `try/catch` with yields are not modeled
 *     (try/finally without catch is, as in Phase 1).
 */
import { ts } from "../ts-api.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import {
  isBooleanType,
  isNumberType,
  isStringType,
  isUndefWidenedBindingElement,
  resolveBindingElementType,
} from "../checker/type-mapper.js";
import type { FieldDef, Instr, ValType, WasmFunction } from "../ir/types.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import { ensureNativeIteratorRuntime } from "./iterator-native.js";
import { popBody, pushBody } from "./context/bodies.js";
import type { CodegenContext, FunctionContext, NativeGeneratorInfo } from "./context/types.js";
import { reportError } from "./context/errors.js";
import { nativeStringType } from "./native-strings.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  ensureLateImport,
  flushLateImportShifts,
  valTypesMatch,
} from "./shared.js";
import { UNDEF_F64_BITS } from "./value-tags.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js"; // (#2864 wave-2 S1)
import { addUnionImports } from "./index.js";
import { bodyNeedsArgumentsObject } from "./helpers/body-uses-arguments.js";
import { resolveSpillLocalValType } from "./statements/variables.js";
import { resolveWasmType } from "./index.js";
import { ensureExnTag } from "./registry/imports.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";
// (#2895 PR1) The frame ABI (state-struct field offsets + resume modes) and the
// field-I/O / spill-store emit helpers now live in the shared resumable-frame
// core, consumed unchanged here and by the host-free async path (PATH B).
import {
  STATE_FIELD,
  SENT_FIELD,
  MODE_FIELD,
  ABRUPT_FIELD,
  ERROR_FIELD,
  RESULT_VALUE_FIELD,
  RESULT_DONE_FIELD,
  PARAM_FIELD_OFFSET,
  MODE_NEXT,
  MODE_THROW,
  sanitizeTypeName,
  defaultSpillInstr,
  setStateInstrs,
  setModeInstrs,
  storeSpills,
} from "./frame-core.js";
// (#3271) Pure AST-scan predicate primitives now live in
// generators-native-ast-scan.ts; imported back for the planner + candidacy gates.
import {
  statementContainsYield,
  statementNeedsStructuralLowering,
  nodeContainsYield,
  spillSafeValType,
  bodyDeclaresBinding,
  loopBodyHasUnsupportedJump,
  thenBody,
  methodBodyUsesSuper,
  fnExprBodyReferencesThis,
  bodyReferencesOwnName,
  isFunctionLikeScope,
} from "./generators-native-ast-scan.js";

const MAX_NATIVE_GENERATOR_STATES = 256;

/**
 * Terminator of a generator state — what happens after the state's straight-line
 * prelude statements run.
 *
 *  - `yield`   suspend: emit the yielded value as `{value, done:0}`, set the
 *              state to `next` and return to the caller.
 *  - `return`  complete with a value: `{value, done:1}`.
 *  - `done`    complete with no value: `{undefined, done:1}`.
 *  - `jump`    transfer control to state `next` WITHOUT suspending (loop
 *              back-edge / if-join / sequential boundary) — re-enters the
 *              trampoline in the same `next()` call.
 *  - `branch`  evaluate a numeric condition; if truthy jump to `thenState`,
 *              else jump to `elseState`. No suspension.
 */
type StateTerminator =
  | { kind: "yield"; expr: ts.Expression | undefined; next: number }
  | { kind: "return"; expr: ts.Expression | undefined }
  | { kind: "done" }
  // (#3050) `setPending` — when jumping INTO a state-lowered finally on the
  // NORMAL path, reset the region's pending-completion kind to 0 (none) so the
  // finally's exit router proceeds to the join. Abrupt entries write the pending
  // fields directly in the routers; plain jumps leave it undefined (no write).
  | { kind: "jump"; next: number; setPending?: number }
  | { kind: "branch"; cond: ts.Expression; negate: boolean; thenState: number; elseState: number }
  // (#3050) Exit router of a state-lowered `finally` block: consult the saved
  // pending completion — none → proceed to `join`; return/throw → re-dispatch
  // the completion against the region's OUTER unwind chain (innermost-first),
  // which may enter an outer catch/finally or complete/re-throw.
  | { kind: "finally-exit"; join: number; unwind: UnwindEntry[] }
  // (#2170) `yield* <inner-generator-call>` — delegate to an inner native
  // generator. `subject` is the inner generator call expression; `innerName` is
  // the callee's source name (resolved to a `NativeGeneratorInfo` at emit time).
  // `siteIndex` keys the per-delegation `ref null $InnerState` slot allocated in
  // the state struct (see `delegationSites`). This is a SELF-suspending state:
  // each `.next()` re-enters it, driving the inner's resume until the inner is
  // done, then control transfers to `next`.
  // (#2864 R1) `bindResultTo` — for `const x = yield* inner()`: the name that
  // receives the DELEGATION COMPLETION value (the inner's `return` value,
  // §27.5.3.7 — `innerRes.value` once `innerRes.done`). It is delivered by the
  // done-arm inside the SAME resume call that observed the inner's completion,
  // NOT from the `sent` field — so it is deliberately NOT a resume binding (a
  // resume binding would clobber it with the `.next(v)` argument on re-entry).
  | {
      kind: "yield-star";
      delegationKind: "native-gen";
      subject: ts.Expression;
      innerName: string;
      siteIndex: number;
      next: number;
      bindResultTo?: string;
    }
  // (#2173 slice-2a) `yield* <numeric-array/vec>` — delegate to a NUMERIC
  // iterable by driving a vec cursor directly (the array for-of fast path),
  // never the #1320 `__iterator` bridge (which would leak host box/unbox
  // imports). `vecSiteIndex` keys the per-site `{ref null $Vec, i32 cursor}`
  // slot pair. Like the native-gen kind this state is SELF-suspending: each
  // `.next()` re-enters it, re-yields `vec.data[cursor]`, and advances the
  // cursor until it is exhausted, then transfers to `next`.
  | {
      kind: "yield-star";
      delegationKind: "vec";
      subject: ts.Expression;
      vecSiteIndex: number;
      next: number;
      bindResultTo?: string;
    }
  // (#2173 slice-2b) `yield* <generic iterable>` — delegate to a `.values()`
  // iterator or a custom `{ [Symbol.iterator]() { return { next() {…} } } }` by
  // driving the standalone-native `__iterator` / `__iterator_next` runtime
  // (#2038) from an `externref` `$__IterRec` slot. Zero host imports (the native
  // iterator runtime is emitted Wasm). Like the other delegation kinds this
  // state is SELF-suspending: each `.next()` re-enters it, steps the iterator,
  // re-yields the (unboxed) value, and transfers to `next` once the iterator
  // reports done. `iterableSiteIndex` keys the per-site externref slot.
  | {
      kind: "yield-star";
      delegationKind: "iterable";
      subject: ts.Expression;
      iterableSiteIndex: number;
      next: number;
      bindResultTo?: string;
    };

/**
 * (#3050) A try-region admitted by the NEW try-region machinery: a `try` whose
 * catch crosses a yield, and/or whose `finally` itself yields. The catch and
 * finally blocks are lowered as REAL states; abrupt completions (`.throw(e)` /
 * `.return(v)` at a suspended yield, or a runtime exception during a try-part
 * state) are ROUTED to the region's handler states instead of the legacy
 * "replay finalizers then re-throw" tail. Legacy kind-L regions (finally-only
 * with a yield-free finally) never mint one of these — they keep the
 * byte-identical `abruptResume.finalizers` replay.
 */
interface TryRegionPlan {
  /** Catch-clause binding name (spilled as externref), when the catch binds one. */
  catchParamName?: string;
  /** Entry state of the catch block (set when the catch block is lowered). */
  catchEntryState?: number;
  /** Entry state of the state-lowered finally block. */
  finallyEntryState?: number;
}

/**
 * (#3050) One step of the abrupt-completion unwind chain attached to a
 * resumable state, ordered innermost-first at capture time:
 *  - `replay`  legacy yield-free finally — compiled inline, runs for BOTH
 *              return and throw completions (byte-identical to abruptResume);
 *  - `catch`   an enclosing catch handler — intercepts THROW completions only:
 *              binds the stored error and enters the catch block's states;
 *  - `finally` an enclosing state-lowered finally — intercepts BOTH: saves the
 *              completion in the pending fields and enters the finally states;
 *              the finally's exit router re-dispatches the pending completion.
 */
type UnwindEntry =
  | { kind: "replay"; statements: readonly ts.Statement[] }
  | { kind: "catch"; region: TryRegionPlan }
  | { kind: "finally"; region: TryRegionPlan };

/**
 * (#3050) Runtime-throw route for exceptions raised WHILE EXECUTING a state
 * (e.g. a `throw obj;` statement in a try block, or a throwing call). States
 * positionally inside a NEW try-region get their dispatch arm wrapped in a wasm
 * `try`/`catch $exc` that routes the exception per JS semantics: into the
 * region's catch (binding the error) or into its finally (as a pending throw).
 */
type ThrowRoute = { kind: "catch"; region: TryRegionPlan } | { kind: "finally"; region: TryRegionPlan };

interface NativeGeneratorState {
  /** Straight-line, yield-free statements to run on entering this state. */
  statements: ts.Statement[];
  /**
   * Local names bound from the `.next(value)` argument on resume into this
   * state (the suspended `let x = yield …` target).
   */
  resumeBindings: string[];
  /**
   * Active `finally` blocks (innermost last) whose statements run on a
   * `GeneratorResumeAbrupt` (`.return()`) hitting the yield that leads here.
   */
  abruptResume?: { finalizers: readonly ts.Statement[][] };
  /**
   * (#3050) Innermost-first unwind chain for abrupt resume at this state.
   * Present INSTEAD of `abruptResume` when any enclosing try-region uses the
   * new machinery; states under only legacy kind-L regions keep `abruptResume`
   * so already-supported shapes emit byte-identical code.
   */
  unwind?: UnwindEntry[];
  /**
   * (#3050) Runtime-throw route for exceptions raised while this state's arm
   * executes (set for states positionally inside a NEW try-region).
   */
  throwRoute?: ThrowRoute;
  terminator: StateTerminator;
}

interface NativeGeneratorPlan {
  states: NativeGeneratorState[];
  /**
   * (#2864 D4) Id of the state that COMPLETES the generator — the state whose
   * terminator is the final `done`, or the dedicated empty placeholder minted
   * for it when the fallthrough carries trailing statements.
   *
   * This is **not** `states.length - 1`. Every structural lowering
   * (`for`/`while`/`do`/`if`, and the #3050 try-region) reserves its exit/join
   * state BEFORE lowering the nested body, so a generator body that ENDS in one
   * of those leaves the fallthrough cursor at a LOWER id than the last reserved
   * state — and the last reserved state is then a LIVE yield successor. The
   * pre-D4 `states.length - 1` therefore aliased "generator completed" onto a
   * real suspension point, which made `buildNativeGeneratorDispatch`'s
   * `suspended = state != START && state != doneState` test report DONE for a
   * genuinely suspended generator: `.throw(e)` / `.return(v)` took the
   * §27.5.3.4 already-completed arm and never resumed, so an enclosing `catch`
   * across the yield was skipped and the error escaped raw. Measured on
   * standalone + wasi for `try { yield … } catch {}` as the whole body, the
   * same inside `for`/`while`, and nested loops under one try.
   */
  doneState: number;
  spills: string[];
  /**
   * (#2864 F1b) The wasm ValType for each spilled local, keyed by name. A local
   * carried across a `yield` gets a state-struct field at its ACTUAL type
   * (object → `ref_null $Object`, string → the native-string ref, number → f64),
   * not the historical f64. A `let x = yield …` resume binding takes the carrier
   * (`sent`-field) type. Every spill resolves to a supported kind or the plan
   * bails to the host path (see `buildNativeGeneratorPlan`).
   */
  spillTypes: Map<string, ValType>;
  /** (#2171) Uniform yield element ValType — f64 (numeric) or native string. */
  elemValType: ValType;
  /**
   * (#2170) One entry per `yield*` delegation site, in `siteIndex` order. The
   * inner generator's source name lets the resume emitter resolve its
   * `NativeGeneratorInfo` at emit time; `buildResumeInfo` allocates one
   * `ref null $InnerState` field per entry to persist the inner iterator across
   * the outer generator's host re-entries.
   */
  delegationSites: { innerName: string }[];
  /**
   * (#2173 slice-2a) One entry per `yield* <numeric-array/vec>` site, in source
   * order. `buildResumeInfo` resolves each `subject`'s vec type and allocates a
   * `{ref null $Vec, i32 cursor}` field pair, appended AFTER the native-gen
   * delegation slots so the f64 `spillFieldOffset` and native-gen slot indices
   * are unaffected (byte-inert for non-vec-delegating generators).
   */
  vecDelegationSites: { subject: ts.Expression }[];
  /**
   * (#2173 slice-2b) One entry per `yield* <generic iterable>` site, in source
   * order. `buildResumeInfo` allocates one `externref` field per entry (the
   * `$__IterRec` slot), appended AFTER the native-gen and vec delegation slots.
   */
  iterableDelegationSites: { subject: ts.Expression }[];
  /**
   * (#3050) True when any try-region lowers its finally as states (a yielding
   * finally): the state struct then carries an i32 `pending` completion-kind
   * field (0 none / 1 return / 2 throw) consumed by the finally exit router.
   * The value/error payloads ride the existing `abrupt` / `error` fields.
   */
  needsPending: boolean;
  /**
   * (#3050) True when any state carries a `throwRoute` (its arm is wrapped in a
   * wasm try/catch). In JS-host mode the wrap's catch_all recovers foreign JS
   * exceptions via `__get_caught_exception`, acquired up-front by the resume
   * emitter so no late import fires mid-trampoline.
   */
  hasThrowRoutes: boolean;
  /**
   * (#3386) Names bound by a destructuring PARAM pattern. Their values are
   * produced by the emit site's eager (call-time) param destructure into
   * factory locals; `compileNativeGeneratorFunction` packs those locals into
   * the matching spill fields at `struct.new` (instead of the inert default).
   */
  patternParamBindings: Set<string>;
  /**
   * (#3315/#3386) Subset of `patternParamBindings` whose spill type was
   * undefined-preservation-widened to externref; marked `undefWidenedLocals`
   * in the resume fctx so identifier reads keep undefined observable.
   */
  undefWidenedPatternBindings: Set<string>;
}

function noJsHostTarget(ctx: CodegenContext): boolean {
  return ctx.standalone || ctx.wasi;
}

function isNumericExpression(ctx: CodegenContext, expr: ts.Expression | undefined): boolean {
  if (!expr) return true;
  const t = ctx.checker.getTypeAtLocation(expr);
  return isNumberType(t) || isBooleanType(t);
}

// (#2171) Native-string yield support. A yield expression qualifies for the
// string-payload path when its static type is a string and the target lowers
// strings to the native `$AnyString` ref (standalone / nativeStrings). The
// generator-wide elem type is decided up-front (generatorElemValType): all
// numeric → f64 (the default path), all string → the native string ref,
// anything else / mixed → unsupported (bail to the #680 diagnostic).
function isStringYieldExpression(ctx: CodegenContext, expr: ts.Expression | undefined): boolean {
  if (!expr) return false;
  if (!(ctx.nativeStrings && ctx.anyStrTypeIdx >= 0)) return false;
  return isStringType(ctx.checker.getTypeAtLocation(expr));
}

/**
 * Decide a generator's uniform yield element ValType. Walks every `yield` in
 * the body (not descending into nested functions).
 *
 *  - all-numeric (or zero-yield) → `{kind:"f64"}` (the historical fast path);
 *  - all-string (including a direct `yield*` string) → the native `$AnyString` ref (#2171);
 *  - anything else (object yields, or a MIX of numeric/string/object) →
 *    `{kind:"externref"}`, the universal boxed-`any` carrier (#2864 F1). Every
 *    JS value coerces to externref host-free in standalone/WASI (numbers via the
 *    native `__box_number`, objects/strings via `extern.convert_any`), so the
 *    heterogeneous frame needs no host import. This is the seam that unblocks
 *    object/mixed-yield generators that previously bailed to the eager-buffer
 *    host path (and thus refused under standalone).
 *
 * Never returns null now — the externref carrier subsumes the formerly-bailing
 * cases; zero-yield generators are rejected separately by the plan builder.
 */
function generatorElemValType(ctx: CodegenContext, decl: GeneratorDecl): ValType {
  let sawNumeric = false;
  let sawString = false;
  let sawOther = false;
  const visit = (node: ts.Node): void => {
    if (isFunctionLikeScope(node)) {
      return; // a yield here belongs to an inner generator
    }
    if (ts.isYieldExpression(node)) {
      // A direct `yield* "abc"` is lowered by the generic iterable cursor,
      // whose values are native strings in the standalone iterator runtime.
      // Include that operand in the carrier decision; otherwise the generator
      // defaults to f64 and each delegated character becomes NaN.
      if (node.asteriskToken) {
        if (isStringYieldExpression(ctx, node.expression)) sawString = true;
      } else if (isNumericExpression(ctx, node.expression)) sawNumeric = true;
      else if (isStringYieldExpression(ctx, node.expression)) sawString = true;
      else sawOther = true;
    }
    // (#3505) A top-level `return expr;` feeds the SAME result-struct value
    // field as a yield (the return terminator builds the result directly), so
    // its type participates in the carrier decision too. Deciding from yields
    // alone made `function* g() { return 'str'; }` an f64 carrier whose plan
    // then bailed on the string return — legacy host path on the gc lane and
    // a #680 refusal in standalone, for a shape the machine supports.
    if (ts.isReturnStatement(node) && node.expression) {
      if (isNumericExpression(ctx, node.expression)) sawNumeric = true;
      else if (isStringYieldExpression(ctx, node.expression)) sawString = true;
      else sawOther = true;
    }
    ts.forEachChild(node, visit);
  };
  if (decl.body) visit(decl.body);
  // Uniform numeric (or no yields): the f64 fast path, byte-identical to before.
  if (!sawOther && !sawString) return { kind: "f64" };
  // Uniform string: the native-string carrier (#2171), byte-identical to before.
  if (!sawOther && !sawNumeric && sawString) return nativeStringType(ctx);
  // Heterogeneous (object and/or mixed types): the boxed-any externref carrier.
  return { kind: "externref" };
}

/** True when a generator uses the boxed-`any` externref carrier (#2864 F1). */
export function carrierIsAny(elemValType: ValType): boolean {
  return elemValType.kind === "externref";
}

/**
 * The ValType of the per-frame `sent` / `abrupt` scalar fields. For the boxed-any
 * carrier these hold a boxed `any` (externref) so `.next(v)` / `.return(v)` carry
 * an arbitrary value; for the numeric & string carriers they stay f64 (a
 * `.next(v)`/`.return(v)` argument coerces to f64, byte-identical to pre-#2864).
 */
function genCarrierFieldType(elemValType: ValType): ValType {
  return carrierIsAny(elemValType) ? { kind: "externref" } : { kind: "f64" };
}

/**
 * Plan builder. Walks the generator body producing a state graph. Returns
 * `null` when any shape is outside the supported subset, so callers fall back
 * to the host path (or the scoped diagnostic in standalone).
 */
function buildNativeGeneratorPlan(ctx: CodegenContext, decl: GeneratorDecl): NativeGeneratorPlan | null {
  if (!decl.body) return null;

  // (#2171/#2864) Decide the uniform yield element type up-front. Numeric → f64
  // (the historical path); all-string → native string ref; mixed / object →
  // the boxed-any externref carrier. `yieldValueOk` then gates each per-yield
  // check on that decision: a string yield is accepted only in a string-typed
  // generator, a numeric yield only in a numeric one, and ANY yield is accepted
  // in the boxed-any carrier (every value coerces to externref).
  const elemValType = generatorElemValType(ctx, decl);
  const elemIsString = elemValType.kind === "ref" || elemValType.kind === "ref_null";
  const elemIsAny = carrierIsAny(elemValType);
  const yieldValueOk = (expr: ts.Expression | undefined): boolean =>
    elemIsAny ? true : elemIsString ? isStringYieldExpression(ctx, expr) : isNumericExpression(ctx, expr);

  const states: NativeGeneratorState[] = [];
  const spills: string[] = [];
  // (#2170) `yield*` delegation sites, allocated in source order; index into
  // this array is the terminator's `siteIndex`.
  const delegationSites: { innerName: string }[] = [];
  // (#2173 slice-2a) `yield* <numeric-array/vec>` sites, allocated in source
  // order; index into `vecDelegationSlots` at emit time.
  const vecDelegationSites: { subject: ts.Expression }[] = [];
  // (#2173 slice-2b) `yield* <generic iterable>` sites, allocated in source
  // order; index into `iterableDelegationSlots` at emit time.
  const iterableDelegationSites: { subject: ts.Expression }[] = [];
  // (#2864 R1) Names bound to a delegation COMPLETION value
  // (`const x = yield* inner()`). Spilled at f64 — the delegation gate admits
  // only f64-elem inners, and the inner's `return` value rides its result
  // struct's f64 `value` field. Typed here (not via `resolveSpillLocalValType`,
  // whose declaration-shape cascade doesn't model a yield* initializer, nor via
  // the `sent`-carrier rule, which types `.next(v)` bindings).
  const delegationBindingNames = new Set<string>();
  const spillSet = new Set<string>();
  // (#2864 F1b) The variable declaration that introduced each spilled name, so
  // the spill's wasm type can be resolved at its actual ValType.
  const spillDecls = new Map<string, ts.VariableDeclaration>();
  // (#2920/#3386) Types for names bound by a destructuring PARAM pattern. These
  // names are not introduced by a body `VariableDeclaration` (so
  // `resolveSpillLocalValType` cannot type them) — their VALUES are produced by
  // the emit site's eager (call-time) param destructure and packed into the
  // spill fields at `struct.new` (`compileNativeGeneratorFunction`).
  // Registering them as spills persists them across yields; this map supplies
  // their ValType in the spill-typing loop.
  const patternParamSpillTypes = new Map<string, ValType>();
  // (#3315/#3386) Pattern-bound names whose spill was undefined-preservation-
  // widened to externref; the resume fctx marks them `undefWidenedLocals`.
  const undefWidenedPatternBindings = new Set<string>();
  const addSpill = (name: string, decl?: ts.VariableDeclaration): void => {
    if (decl !== undefined && !spillDecls.has(name)) spillDecls.set(name, decl);
    if (spillSet.has(name)) return;
    spillSet.add(name);
    spills.push(name);
  };

  // Builder is structured as a recursive lowering over the statement list with
  // an explicit "current state being filled" cursor. Because Wasm has no goto,
  // we model control flow with state ids resolved up-front: we reserve a state
  // id, then fill it.
  let ok = true;

  // The state currently being constructed: its prelude statements + pending
  // resume bindings / abrupt-resume context.
  let curStatements: ts.Statement[] = [];
  let curResumeBindings: string[] = [];
  let curAbrupt: NativeGeneratorState["abruptResume"] | undefined;
  let curUnwind: UnwindEntry[] | undefined; // (#3050) new-region unwind chain
  let curUsed = false; // becomes the id below once we know it

  // (#3050) New try-region machinery bookkeeping. `curThrowRoute` is the
  // runtime-throw route for states reserved at the current lowering position
  // (stamped onto every state minted while set); `stateThrowRoutes` collects the
  // stamps and is applied to the final state objects after lowering (finishState
  // rebuilds state objects, so stamping the placeholder would be lost).
  // `stateFinallyDepth` counts how many state-lowered finally blocks enclose the
  // current position — a region with its OWN state-lowered finally nested inside
  // one would clobber the single shared pending-completion field, so it bails.
  let curThrowRoute: ThrowRoute | undefined;
  const stateThrowRoutes = new Map<number, ThrowRoute>();
  let stateFinallyDepth = 0;
  let needsPending = false;
  let hasThrowRoutes = false;
  // (#3050) Catch-param spills are typed externref (the exn tag payload) —
  // resolved here, not from a body VariableDeclaration (none exists).
  const catchParamSpillTypes = new Map<string, ValType>();

  // Reserve the state id for the in-progress state.
  let curId = reserveState();

  function reserveState(): number {
    const id = states.length;
    // Placeholder; filled by finishState. Marked with a sentinel terminator.
    states.push({
      statements: [],
      resumeBindings: [],
      terminator: { kind: "done" },
    });
    // (#3050) Stamp the runtime-throw route of the lowering position that
    // minted this state (applied to the final object after lowering).
    if (curThrowRoute) stateThrowRoutes.set(id, curThrowRoute);
    return id;
  }

  function startState(): number {
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    curUnwind = undefined;
    curUsed = false;
    return reserveState();
  }

  function finishState(id: number, terminator: StateTerminator): void {
    states[id] = {
      statements: curStatements,
      resumeBindings: curResumeBindings,
      abruptResume: curAbrupt,
      unwind: curUnwind,
      terminator,
    };
  }

  /** (#3050) Point the cursor at an already-reserved state with a fresh prelude. */
  function resetCursor(id: number): void {
    curId = id;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    curUnwind = undefined;
  }

  const tryYieldDeclaration = (stmt: ts.Statement): { name: string; yieldExpr: ts.YieldExpression } | null => {
    if (!ts.isVariableStatement(stmt)) return null;
    if (stmt.declarationList.declarations.length !== 1) return null;
    const declStmt = stmt.declarationList.declarations[0]!;
    if (!ts.isIdentifier(declStmt.name)) return null;
    if (!declStmt.initializer || !ts.isYieldExpression(declStmt.initializer)) return null;
    return { name: declStmt.name.text, yieldExpr: declStmt.initializer };
  };

  const statementsAreYieldFree = (statements: readonly ts.Statement[]): boolean =>
    statements.every((stmt) => !statementContainsYield(stmt));

  /**
   * Lower a list of statements into the state graph, threading the "current
   * state" cursor. Each `yield` closes the current state with a yield
   * terminator pointing at a freshly-reserved successor and continues filling
   * that successor. Loops/ifs containing yields reserve their header / branch
   * states and wire jumps. Returns false (sets ok=false) on unsupported shapes.
   *
   * `unwind` carries the enclosing try-region unwind chain for abrupt-resume,
   * outermost-first (#3050): legacy yield-free finally bodies as `replay`
   * entries (byte-identical to the historical activeFinalizers threading) plus
   * `catch` / `finally` entries for regions on the new try-region machinery.
   */
  function lowerStatements(statements: readonly ts.Statement[], unwind: readonly UnwindEntry[]): boolean {
    for (const stmt of statements) {
      if (!ok) return false;
      if (stmt.kind === ts.SyntaxKind.EmptyStatement) continue;

      // A top-level `return` always terminates the current state. (Routed here
      // first so a bare `return expr;` is a completion terminator, not a raw
      // wasm `return` from compileStatement.)
      if (ts.isReturnStatement(stmt)) {
        // (#2171) The return *value* must match the generator's yield element
        // type (numeric or string); a bare `return;` (no expr) is allowed.
        if (stmt.expression && !yieldValueOk(stmt.expression)) return fail();
        // (#3050) A `return` inside a region with a state-lowered finally must
        // thread the completion THROUGH the finally (which can itself suspend).
        // That return-through path is not modeled yet — bail to the host path
        // rather than silently skip the finally. (Catch entries never intercept
        // returns, and legacy replay entries keep today's behavior.)
        if (unwind.some((e) => e.kind === "finally")) return fail();
        collectSpillsIn(stmt);
        finishState(curId, { kind: "return", expr: stmt.expression });
        // Unreachable tail — start a fresh (dead) state so the cursor stays
        // valid; it will simply never be entered.
        curId = startState();
        // Statements after an unconditional return are dead.
        return true;
      }

      // Straight-line statement (no yield, no nested return): append to the
      // current state's prelude and let compileStatement emit it verbatim.
      if (!statementNeedsStructuralLowering(stmt)) {
        collectSpillsIn(stmt);
        curStatements.push(stmt);
        continue;
      }

      // Statement that CONTAINS a yield somewhere — must be modeled.
      // 1) `yield expr;` as an expression statement.
      if (ts.isExpressionStatement(stmt) && ts.isYieldExpression(stmt.expression)) {
        if (!emitYield(stmt.expression, undefined, unwind)) return false;
        continue;
      }

      // 2) `let x = yield expr;`
      const yd = tryYieldDeclaration(stmt);
      if (yd) {
        if (!emitYield(yd.yieldExpr, yd.name, unwind)) return false;
        continue;
      }

      // 3) try statements wrapping yields.
      if (ts.isTryStatement(stmt)) {
        const finallyYieldFree = !stmt.finallyBlock || statementsAreYieldFree(stmt.finallyBlock.statements);
        if (!stmt.catchClause && stmt.finallyBlock && finallyYieldFree) {
          // Legacy kind-L region: finally-only, yield-free finally — the
          // historical replay lowering, byte-identical to pre-#3050.
          if (
            !lowerStatements(stmt.tryBlock.statements, [
              ...unwind,
              { kind: "replay", statements: [...stmt.finallyBlock.statements] },
            ])
          ) {
            return false;
          }
          // finally runs on the normal path too.
          for (const f of stmt.finallyBlock.statements) {
            collectSpillsIn(f);
            curStatements.push(f);
          }
          continue;
        }
        // (#3050) New try-region machinery: catch across yield and/or a
        // yielding finally.
        if (!lowerTryRegion(stmt, unwind)) return false;
        continue;
      }

      // 4) if / else with yields in a branch.
      if (ts.isIfStatement(stmt)) {
        if (!lowerIf(stmt, unwind)) return false;
        continue;
      }

      // 5) while / do-while / for loops with yields in the body.
      if (ts.isWhileStatement(stmt)) {
        if (!lowerWhile(stmt, unwind)) return false;
        continue;
      }
      if (ts.isDoStatement(stmt)) {
        if (!lowerDoWhile(stmt, unwind)) return false;
        continue;
      }
      if (ts.isForStatement(stmt)) {
        if (!lowerFor(stmt, unwind)) return false;
        continue;
      }

      // 6) A bare block with yields — flatten it (no new scope modeling).
      if (ts.isBlock(stmt)) {
        if (!lowerStatements(stmt.statements, unwind)) return false;
        continue;
      }

      return fail();
    }
    return ok;
  }

  /**
   * (#3050) Lower a try statement on the NEW try-region machinery: the try,
   * catch and finally blocks each become real state subgraphs; abrupt
   * completions and runtime exceptions are ROUTED between them per JS
   * semantics (§14.15 TryStatement + §27.5.3.4 GeneratorResumeAbrupt):
   *
   *   [cur] --jump--> [try states] --normal--> [finally states | join]
   *                     | runtime throw / .throw() at a yield
   *                     v
   *                  [catch states] --normal--> [finally states | join]
   *                     | runtime throw / abrupt at a yield (throw AND return)
   *                     v
   *                  [finally states] --exit router--> join | outer unwind
   *
   * The catch param is spilled as externref; the pending completion kind rides
   * the state struct's i32 `pending` field (payloads reuse `abrupt`/`error`).
   */
  function lowerTryRegion(stmt: ts.TryStatement, outerUnwind: readonly UnwindEntry[]): boolean {
    // A region with a state-lowered finally nested inside another state-lowered
    // finally would clobber the single shared pending-completion field — bail.
    if (stmt.finallyBlock && stateFinallyDepth > 0) return fail();

    // Catch param: identifier-only, spilled at externref (the exn tag payload).
    let catchParamName: string | undefined;
    const catchDecl = stmt.catchClause?.variableDeclaration;
    if (catchDecl) {
      if (!ts.isIdentifier(catchDecl.name)) return fail();
      catchParamName = catchDecl.name.text;
      if (!catchParamSpillTypes.has(catchParamName)) {
        // Reusing the slot across sibling catches of the same name is fine
        // (externref, non-overlapping lifetimes); any OTHER same-named binding
        // (body local, param, pattern binding) would share the slot wrongly.
        if (
          spillSet.has(catchParamName) ||
          patternParamSpillTypes.has(catchParamName) ||
          (decl.body !== undefined && bodyDeclaresBinding(decl.body, catchParamName))
        ) {
          return fail();
        }
        catchParamSpillTypes.set(catchParamName, { kind: "externref" });
        addSpill(catchParamName);
      }
    }

    const region: TryRegionPlan = { catchParamName };
    if (stmt.finallyBlock) needsPending = true;
    hasThrowRoutes = true;

    const outerRoute = curThrowRoute;
    const tryPartRoute: ThrowRoute = stmt.catchClause ? { kind: "catch", region } : { kind: "finally", region };
    const catchPartRoute: ThrowRoute | undefined = stmt.finallyBlock ? { kind: "finally", region } : outerRoute;

    // Unwind chains per part (outermost-first, matching the legacy threading;
    // captured lists are reversed to innermost-first at the yield).
    const finallyEntryUnwind: UnwindEntry[] = stmt.finallyBlock ? [{ kind: "finally", region }] : [];
    const tryUnwind: UnwindEntry[] = [
      ...outerUnwind,
      ...finallyEntryUnwind,
      ...(stmt.catchClause ? [{ kind: "catch", region } as UnwindEntry] : []),
    ];
    const catchUnwind: UnwindEntry[] = [...outerUnwind, ...finallyEntryUnwind];

    // Reserve all part-entry states up front so each part's tail can be wired
    // the moment its cursor is still live (finishState reads the live cursor).
    const tryEntry = reserveState();
    const catchEntry = stmt.catchClause ? reserveState() : -1;
    const finallyEntry = stmt.finallyBlock ? reserveState() : -1;
    const joinId = reserveState();
    if (catchEntry >= 0) region.catchEntryState = catchEntry;
    if (finallyEntry >= 0) region.finallyEntryState = finallyEntry;
    // The up-front reservations were stamped with the SURROUNDING route —
    // re-stamp them with their own part's route.
    stampRoute(tryEntry, tryPartRoute);
    if (catchEntry >= 0) stampRoute(catchEntry, catchPartRoute);
    if (finallyEntry >= 0) stampRoute(finallyEntry, outerRoute);
    stampRoute(joinId, outerRoute);

    const normalNext = finallyEntry >= 0 ? finallyEntry : joinId;
    const normalPending = finallyEntry >= 0 ? 0 : undefined;

    // --- try part ---
    finishState(curId, { kind: "jump", next: tryEntry });
    curThrowRoute = tryPartRoute;
    resetCursor(tryEntry);
    const tryOk = lowerStatements(stmt.tryBlock.statements, tryUnwind);
    curThrowRoute = outerRoute;
    if (!tryOk) return false;
    finishState(curId, { kind: "jump", next: normalNext, setPending: normalPending });

    // --- catch part ---
    if (stmt.catchClause) {
      curThrowRoute = catchPartRoute;
      resetCursor(catchEntry);
      const catchOk = lowerStatements(stmt.catchClause.block.statements, catchUnwind);
      curThrowRoute = outerRoute;
      if (!catchOk) return false;
      finishState(curId, { kind: "jump", next: normalNext, setPending: normalPending });
    }

    // --- finally part ---
    if (stmt.finallyBlock) {
      resetCursor(finallyEntry);
      stateFinallyDepth++;
      const finOk = lowerStatements(stmt.finallyBlock.statements, [...outerUnwind]);
      stateFinallyDepth--;
      if (!finOk) return false;
      finishState(curId, { kind: "finally-exit", join: joinId, unwind: [...outerUnwind].reverse() });
    }

    // Continue in the join state.
    resetCursor(joinId);
    return ok;
  }

  /** (#3050) Overwrite / clear a state's runtime-throw route stamp. */
  function stampRoute(id: number, route: ThrowRoute | undefined): void {
    if (route) stateThrowRoutes.set(id, route);
    else stateThrowRoutes.delete(id);
  }

  function fail(): boolean {
    ok = false;
    return false;
  }

  /** Close the current state at a yield and continue in a fresh successor. */
  function emitYield(
    yieldExpr: ts.YieldExpression,
    bindSentTo: string | undefined,
    unwind: readonly UnwindEntry[],
  ): boolean {
    // (#2170) `yield* <inner-generator-call>` — delegate to an inner native
    // generator. Slice-1 supports a direct call to a native-generator function
    // declaration (`yield* inner()`); anything else (arbitrary iterable, the
    // value of `yield*` consumed, a non-native inner) still bails to the host
    // path / scoped diagnostic.
    if (yieldExpr.asteriskToken) {
      // (#3050) `yield*` inside a NEW try-region is not modeled — the
      // delegation states ignore the resume mode, so an abrupt completion
      // could not be routed into the region's catch/finally. Bail to the host
      // path (legacy replay-only regions keep today's behavior).
      if (unwind.some((e) => e.kind !== "replay")) return fail();
      // (#2864 D2) A yield-star terminator SELF-SUSPENDS (its yield arm re-enters
      // the SAME state on the next resume), so it must live in a DEDICATED state:
      //  (a) empty prelude / no resume bindings — otherwise the prelude statements
      //      re-ran and the `sent`-copy re-executed (clobbering the binding with
      //      later `.next(v)` values) on EVERY mid-delegation resume;
      //  (b) never state 0 — the `.return()`/`.throw()` dispatch reads state 0 as
      //      NOT-STARTED (§27.5.3.4/§27.5.3.6), so a first-statement `yield*`
      //      suspension was misclassified and completed/threw WITHOUT closing the
      //      delegate (and without running the outer's own finalizers);
      //  (c) always carrying an abrupt block — recomputed below from the yield*
      //      position's replay chain (empty outside any try/finally) — so a
      //      mid-delegation `.return()`/`.throw()` resume is handled instead of
      //      silently ignored; the block hosts the D2 delegate-close forwarding.
      // Split only when needed so already-dedicated states keep their ids.
      if (curStatements.length > 0 || curResumeBindings.length > 0 || curId === 0) {
        const starId = reserveState();
        finishState(curId, { kind: "jump", next: starId });
        resetCursor(starId);
      }
      curAbrupt = {
        finalizers: unwind.map((e) => [...(e as { statements: readonly ts.Statement[] }).statements]).reverse(),
      };
      curUnwind = undefined;
      const subject = yieldExpr.expression;
      const innerName = subject ? nativeGeneratorDelegationName(subject) : undefined;
      if (subject && innerName === undefined) {
        // (#2173 slice-2a) Not a native-generator call — try a NUMERIC
        // array / vec delegate (`yield* [1,2,3]`, `yield* arr`). Driven by a
        // direct vec cursor (no host box/unbox), so it stays standalone-clean.
        // Same carrier-mismatch gate as the native-gen path: the vec elements
        // are f64, so an f64 outer re-yields them exactly and a boxed-any outer
        // boxes via the `repairStructTypeMismatches` seam (fixups.ts); a STRING
        // outer has a concrete-ref `value` no repair can bridge — bail it to the
        // host path (standalone: the clean #680 refusal).
        if (!elemIsString && isNumericIterableDelegate(ctx, subject)) {
          // (#2864 R1) `const x = yield* [..]` — the delegation completion value
          // (§27.5.3.7) of an array is `undefined`; the done-arm delivers the f64
          // undefined sentinel into the binding's spill (a #2106 residual).
          if (bindSentTo !== undefined) {
            delegationBindingNames.add(bindSentTo);
            addSpill(bindSentTo);
          }
          const vecSiteIndex = vecDelegationSites.length;
          vecDelegationSites.push({ subject });
          const nextId = startStateAfterYield(undefined, unwind);
          finishState(curId, {
            kind: "yield-star",
            delegationKind: "vec",
            subject,
            vecSiteIndex,
            next: nextId,
            bindResultTo: bindSentTo,
          });
          curId = reserveState();
          curStatements = [];
          curResumeBindings = pendingResumeBindings;
          curAbrupt = pendingAbrupt;
          curUnwind = pendingUnwind;
          pendingResumeBindings = [];
          pendingAbrupt = undefined;
          pendingUnwind = undefined;
          return ok;
        }
        // (#2173 slice-2b) Not a native-gen call nor a numeric vec — try a
        // GENERIC iterable (`yield* arr.values()`, `yield* customIterable`).
        // Driven by the standalone-native `__iterator`/`__iterator_next` runtime
        // (#2038) → zero host imports. The iterator value rides externref and re-yields through the OUTER
        // result struct's `value` field; an f64 outer unboxes it and a boxed-any
        // outer passes it through. A direct string operand is the one concrete
        // ref case supported here: the iterator runtime returns native-string
        // refs, and the emitter casts the externref back to that ref below.
        if ((!elemIsString || isStringYieldExpression(ctx, subject)) && isGenericIterableDelegate(ctx, subject)) {
          // (#2864 R1) `const x = yield* it` — the delegation completion value
          // (§27.5.3.7) is the iterator's done-result `value`; for the common
          // array/`.values()` shape that is `undefined`. The done-arm delivers
          // the outer's undefined sentinel into the binding's spill (#2106
          // residual, exactly as the vec arm).
          if (bindSentTo !== undefined) {
            delegationBindingNames.add(bindSentTo);
            addSpill(bindSentTo);
          }
          const iterableSiteIndex = iterableDelegationSites.length;
          iterableDelegationSites.push({ subject });
          const nextId = startStateAfterYield(undefined, unwind);
          finishState(curId, {
            kind: "yield-star",
            delegationKind: "iterable",
            subject,
            iterableSiteIndex,
            next: nextId,
            bindResultTo: bindSentTo,
          });
          curId = reserveState();
          curStatements = [];
          curResumeBindings = pendingResumeBindings;
          curAbrupt = pendingAbrupt;
          curUnwind = pendingUnwind;
          pendingResumeBindings = [];
          pendingAbrupt = undefined;
          pendingUnwind = undefined;
          return ok;
        }
        return fail();
      }
      if (!subject || innerName === undefined) return fail();
      // (#2864 R1) Carrier-mismatch gate: the delegation yield-arm re-yields the
      // inner's f64 `value` through the OUTER result struct. For an f64 outer
      // that is exact; for the boxed-any outer the f64→externref mismatch is
      // repaired to a `__box_number` by `repairStructTypeMismatches`
      // (fixups.ts). A STRING outer's result `value` is a concrete ref no
      // repair can bridge — main emitted an INVALID module for that shape
      // (wasm validation failure at instantiation, latent since #2170/#2171).
      // Bail it to the host path (standalone: the clean #680 refusal) instead.
      if (elemIsString) return fail();
      // (#2864 R1) `const x = yield* inner()` — bind the delegation COMPLETION
      // value (the inner's `return` value). The done-arm writes it inside the
      // same resume call, so it is NOT a resume binding (see the terminator
      // comment); it only needs a typed spill slot.
      if (bindSentTo !== undefined) {
        delegationBindingNames.add(bindSentTo);
        addSpill(bindSentTo);
      }
      const siteIndex = delegationSites.length;
      delegationSites.push({ innerName });
      const nextId = startStateAfterYield(undefined, unwind);
      finishState(curId, {
        kind: "yield-star",
        delegationKind: "native-gen",
        subject,
        innerName,
        siteIndex,
        next: nextId,
        bindResultTo: bindSentTo,
      });
      // Create the successor and make it current (mirrors finishCurrentAsYield).
      curId = reserveState();
      curStatements = [];
      curResumeBindings = pendingResumeBindings;
      curAbrupt = pendingAbrupt;
      curUnwind = pendingUnwind;
      pendingResumeBindings = [];
      pendingAbrupt = undefined;
      pendingUnwind = undefined;
      return ok;
    }
    // (#2171) yieldValueOk admits the f64 numeric path AND the uniform
    // native-string path; mixed/object yields still bail.
    if (!yieldValueOk(yieldExpr.expression)) return fail();
    const next = startStateAfterYield(bindSentTo, unwind);
    // The state we were filling (curIdBefore) is finished by startStateAfterYield's
    // caller — handled inside helper to keep ids tidy.
    finishCurrentAsYield(yieldExpr.expression, next, unwind, bindSentTo);
    return ok;
  }

  /**
   * (#2170) If `expr` is a direct call to a native-generator function
   * declaration (`inner()` where `function* inner(){…}`), return the callee's
   * source name; else undefined. Resolution to the inner's `NativeGeneratorInfo`
   * is deferred to emit time (the inner may not be registered yet during the
   * candidate pre-pass), so here we only confirm the callee is a zero-host
   * native generator declaration.
   */
  function nativeGeneratorDelegationName(expr: ts.Expression): string | undefined {
    if (!ts.isCallExpression(expr)) return undefined;
    if (expr.arguments.length !== 0) return undefined; // slice-1: no-arg inner call
    // TS CallExpression's callee is `.expression`.
    const callee = expr.expression;
    if (!ts.isIdentifier(callee)) return undefined;
    const sym = ctx.checker.getSymbolAtLocation(callee);
    const innerDecl = sym?.declarations?.find((d): d is ts.FunctionDeclaration => ts.isFunctionDeclaration(d));
    if (!innerDecl || !innerDecl.asteriskToken || !innerDecl.body) return undefined;
    if (!isNativeGeneratorCandidate(ctx, innerDecl)) return undefined;
    // (#2170 slice-1 / #2171 interop) Only numeric (f64) inner generators are
    // delegated. The per-elemType result struct (#2171) means a string inner
    // (`__NativeGeneratorResult_str`) and a numeric outer
    // (`__NativeGeneratorResult_f64`) would mismatch when the yield-star arm
    // re-yields `innerRes.value` through the OUTER result struct. Same-elemType
    // string delegation is a follow-up; for now bail to the host path.
    const innerElem = generatorElemValType(ctx, innerDecl);
    if (innerElem === null || innerElem.kind !== "f64") return undefined;
    return callee.text;
  }

  // (#2173 slice-2a) True when `subject`'s static type is a NUMERIC array
  // (`number[]` — an array literal of numbers, or an identifier/param typed
  // `number[]`), which lowers to the canonical f64 vec. This is the direct-vec
  // case driven by the array for-of fast path — `vec.data[idx]` reads f64 with
  // zero host imports. Generic `{next()}` iterables / `arr.values()` iterators
  // are NOT arrays and stay on the host path (slice-2b, the #1320 bridge); a
  // string / string[] / object[] subject fails the numeric-element gate.
  // (#1930) Uses the registry-free `ctx.oracle` type boundary, NOT the raw
  // TS checker (the oracle-ratchet gate); the concrete vec ValType is resolved
  // separately in `buildResumeInfo` via `getOrRegisterVecType`.
  function isNumericIterableDelegate(ctx: CodegenContext, subject: ts.Expression): boolean {
    const fact = ctx.oracle.typeFactOf(subject);
    return fact.kind === "array" && fact.element.kind === "number";
  }

  // (#2173 slice-2b) True when `subject`'s static type is a GENERIC iterable that
  // is NOT already handled by the numeric-vec fast path — a `.values()`/`.keys()`/
  // `.entries()` iterator or a custom `{ [Symbol.iterator]() {…} }` object. Such a
  // type carries a well-known `[Symbol.iterator]` member, which the TS checker
  // names with a `__@iterator`-prefixed escaped name (e.g. `__@iterator@9`). We
  // require that member (spec-aligned: `yield*` performs GetIterator, which reads
  // `[Symbol.iterator]`), so a bare non-iterable object is NOT admitted. The
  // native `__iterator` runtime (#2038) then drives it host-free. Mirrors the
  // checker use already present in `nativeGeneratorDelegationName`.
  function isGenericIterableDelegate(ctx: CodegenContext, subject: ts.Expression): boolean {
    const t = ctx.checker.getTypeAtLocation(subject);
    if (!t) return false;
    for (const p of ctx.checker.getPropertiesOfType(t)) {
      if (p.getName().startsWith("__@iterator")) return true;
    }
    return false;
  }

  // Reserve the successor of a yield and set up its resume binding/abrupt
  // context, returning its id.
  let pendingResumeBindings: string[] = [];
  let pendingAbrupt: NativeGeneratorState["abruptResume"] | undefined;
  let pendingUnwind: UnwindEntry[] | undefined; // (#3050)
  function startStateAfterYield(bindSentTo: string | undefined, unwind: readonly UnwindEntry[]): number {
    pendingResumeBindings = bindSentTo ? [bindSentTo] : [];
    if (unwind.every((e) => e.kind === "replay")) {
      // Legacy chain (replay-only): byte-identical abruptResume capture.
      pendingAbrupt = {
        // Replay entries are minted with fresh mutable arrays (lowerStatements
        // spreads the finally statements), so this cast only erases the
        // UnwindEntry-level readonly view.
        finalizers: unwind.map((e) => [...(e as { statements: readonly ts.Statement[] }).statements]).reverse(),
      };
      pendingUnwind = undefined;
    } else {
      // (#3050) New try-region chain — captured innermost-first.
      pendingAbrupt = undefined;
      pendingUnwind = [...unwind].reverse();
    }
    if (bindSentTo) addSpill(bindSentTo);
    return states.length; // successor id (reserved inside finishCurrentAsYield)
  }

  function finishCurrentAsYield(
    expr: ts.Expression | undefined,
    nextId: number,
    _unwind: readonly UnwindEntry[],
    _bindSentTo: string | undefined,
  ): void {
    finishState(curId, { kind: "yield", expr, next: nextId });
    // Now actually create the successor and make it current.
    curId = reserveState();
    curStatements = [];
    curResumeBindings = pendingResumeBindings;
    curAbrupt = pendingAbrupt;
    curUnwind = pendingUnwind;
    pendingResumeBindings = [];
    pendingAbrupt = undefined;
    pendingUnwind = undefined;
  }

  /** if (cond) thenBlock [else elseBlock] — at least one branch yields. */
  function lowerIf(stmt: ts.IfStatement, unwind: readonly UnwindEntry[]): boolean {
    if (!isNumericExpression(ctx, stmt.expression)) return fail();
    collectSpillsIn(stmt.expression);
    // Close current state with a branch terminator. Reserve the join state and
    // the branch entry states.
    const branchHostId = curId;

    // Reserve then-entry, else-entry, join.
    const thenEntry = reserveState();
    const hasElse = !!stmt.elseStatement;
    const elseEntry = hasElse ? reserveState() : -1;
    const joinId = reserveState();

    finishState(branchHostId, {
      kind: "branch",
      cond: stmt.expression,
      negate: false,
      thenState: thenEntry,
      elseState: hasElse ? elseEntry : joinId,
    });

    // Lower then-branch starting at thenEntry.
    curId = thenEntry;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    curUnwind = undefined;
    if (!lowerStatements(thenBody(stmt.thenStatement), unwind)) return false;
    finishState(curId, { kind: "jump", next: joinId });

    if (hasElse) {
      curId = elseEntry;
      curStatements = [];
      curResumeBindings = [];
      curAbrupt = undefined;
      curUnwind = undefined;
      if (!lowerStatements(thenBody(stmt.elseStatement!), unwind)) return false;
      finishState(curId, { kind: "jump", next: joinId });
    }

    // Continue in the join state.
    curId = joinId;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    curUnwind = undefined;
    return ok;
  }

  /** while (cond) body — body yields. */
  function lowerWhile(stmt: ts.WhileStatement, unwind: readonly UnwindEntry[]): boolean {
    if (!isNumericExpression(ctx, stmt.expression)) return fail();
    if (loopBodyHasUnsupportedJump(stmt.statement)) return fail();
    collectSpillsIn(stmt.expression);

    // Current state jumps to the header.
    const headerId = reserveState();
    finishState(curId, { kind: "jump", next: headerId });

    // header: branch on cond → bodyEntry / exit
    const bodyEntry = reserveState();
    const exitId = reserveState();
    states[headerId] = {
      statements: [],
      resumeBindings: [],
      terminator: { kind: "branch", cond: stmt.expression, negate: false, thenState: bodyEntry, elseState: exitId },
    };

    // body: lower, then jump back to header.
    curId = bodyEntry;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    curUnwind = undefined;
    if (!lowerStatements(thenBody(stmt.statement), unwind)) return false;
    finishState(curId, { kind: "jump", next: headerId });

    // continue at exit.
    curId = exitId;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    curUnwind = undefined;
    return ok;
  }

  /** do body while (cond) — body runs at least once, then header. */
  function lowerDoWhile(stmt: ts.DoStatement, unwind: readonly UnwindEntry[]): boolean {
    if (!isNumericExpression(ctx, stmt.expression)) return fail();
    if (loopBodyHasUnsupportedJump(stmt.statement)) return fail();
    collectSpillsIn(stmt.expression);

    const bodyEntry = reserveState();
    finishState(curId, { kind: "jump", next: bodyEntry });

    const headerId = reserveState();
    const exitId = reserveState();

    // body → header
    curId = bodyEntry;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    curUnwind = undefined;
    if (!lowerStatements(thenBody(stmt.statement), unwind)) return false;
    finishState(curId, { kind: "jump", next: headerId });

    // header: cond ? bodyEntry : exit
    states[headerId] = {
      statements: [],
      resumeBindings: [],
      terminator: { kind: "branch", cond: stmt.expression, negate: false, thenState: bodyEntry, elseState: exitId },
    };

    curId = exitId;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    curUnwind = undefined;
    return ok;
  }

  /** for (init; cond; update) body — body yields. */
  function lowerFor(stmt: ts.ForStatement, unwind: readonly UnwindEntry[]): boolean {
    if (loopBodyHasUnsupportedJump(stmt.statement)) return fail();
    // init: a yield-free var-decl list or expression; append to current state.
    if (stmt.initializer) {
      if (ts.isVariableDeclarationList(stmt.initializer)) {
        // Only numeric simple declarations.
        for (const d of stmt.initializer.declarations) {
          if (!ts.isIdentifier(d.name)) return fail();
          if (d.initializer && statementContainsYield(d.initializer as unknown as ts.Statement)) return fail();
          addSpill(d.name.text);
        }
        // Wrap into a synthetic VariableStatement so compileStatement handles it.
        const vs = ts.factory.createVariableStatement(undefined, stmt.initializer);
        curStatements.push(vs);
      } else {
        if (nodeContainsYield(stmt.initializer)) return fail();
        curStatements.push(ts.factory.createExpressionStatement(stmt.initializer));
      }
    }

    const cond = stmt.condition;
    if (cond && !isNumericExpression(ctx, cond)) return fail();
    if (cond) collectSpillsIn(cond);

    const headerId = reserveState();
    finishState(curId, { kind: "jump", next: headerId });

    const bodyEntry = reserveState();
    const updateId = reserveState();
    const exitId = reserveState();

    states[headerId] = {
      statements: [],
      resumeBindings: [],
      terminator: cond
        ? { kind: "branch", cond, negate: false, thenState: bodyEntry, elseState: exitId }
        : { kind: "jump", next: bodyEntry },
    };

    // body → update
    curId = bodyEntry;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    curUnwind = undefined;
    if (!lowerStatements(thenBody(stmt.statement), unwind)) return false;
    finishState(curId, { kind: "jump", next: updateId });

    // update → header
    if (stmt.incrementor) {
      if (nodeContainsYield(stmt.incrementor)) return fail();
      collectSpillsIn(stmt.incrementor);
    }
    states[updateId] = {
      statements: stmt.incrementor ? [ts.factory.createExpressionStatement(stmt.incrementor)] : [],
      resumeBindings: [],
      terminator: { kind: "jump", next: headerId },
    };

    curId = exitId;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    curUnwind = undefined;
    return ok;
  }

  // Conservatively spill every simple numeric local declared / assigned in the
  // generator body, since loops re-enter states across suspensions and the live
  // local set is hard to compute precisely. Identifiers that are params are
  // already in the state struct.
  function collectSpillsIn(node: ts.Node): void {
    function visit(n: ts.Node): void {
      // (#3050) A catch clause's binding IS a ts.VariableDeclaration — catch
      // params are registered (externref-typed) by lowerTryRegion, not here.
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && !ts.isCatchClause(n.parent)) {
        addSpill(n.name.text, n);
      }
      if (
        ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isArrowFunction(n) ||
        ts.isMethodDeclaration(n)
      ) {
        return;
      }
      ts.forEachChild(n, visit);
    }
    visit(node);
  }

  // Pre-scan the whole body so every loop-carried / yield-crossing local is a
  // spill field BEFORE states are emitted (a state entered on resume reads all
  // spills from the struct, so any local mutated across a suspension must be a
  // spill regardless of which state declared it).
  collectSpillsIn(decl.body);

  // (#2920/#3386) Register each destructuring-PARAM binding name as a spill.
  //
  // TIMING (#3386): parameter destructuring is EAGER — per §10.2.11
  // FunctionDeclarationInstantiation (step 23-25, IteratorBindingInitialization)
  // it runs at CALL time for generators too; the test262 dstr templates assert
  // `assert.throws(..., function() { f(g); })` with NO `.next()`. Every native-
  // generator emit site already destructures pattern params into factory locals
  // BEFORE `compileNativeGeneratorFunction` (function-body.ts:988,
  // class-bodies.ts:2301, literals.ts:2931, closures.ts
  // emitClosureParamDestructuring, nested-declarations.ts:650/:1074) using the
  // SAME corpus-proven emitters ordinary functions use — iterator protocol via
  // the standalone-native `__array_from_iter_n` (#2904), null guards, elision,
  // element defaults. The factory packs those bound locals into the spill
  // fields at `struct.new` (see `compileNativeGeneratorFunction`), and the
  // resume function reads them back via the ordinary spill-load loop. The old
  // state-0 resume-prelude RE-destructure is retired: it both violated the
  // call-time spec timing and would double-drive one-shot iterators for the
  // shapes admitted here (it was only safe for the previously-admitted
  // idempotent reads — typed vec indexing / object property gets).
  //
  // Each bound name spills at the type `ensureBindingLocals` gives the emit
  // site's factory local (`resolveBindingElementType`, incl. the #3315
  // undefined-preserving externref widening) so the packed value round-trips
  // the state struct unchanged. If ANY bound name has no struct-storable type,
  // bail to host so the candidate gate and registration agree (no
  // undefined-funcidx module).
  //
  // (#3945) REST elements (`[a, ...r]` / `{a, ...r}`) are admitted, under a
  // DIFFERENT typing rule than the non-rest elements below. A non-rest element's
  // factory local is allocated by `ensureBindingLocals` from
  // `resolveBindingElementType` and the emit site does not re-type it, so the
  // checker rule is faithful there. A REST local is minted by the destructure
  // lane instead and then REALLOCATED over that guess (destructuring-params.ts,
  // the #971 realloc) — `$__vec_externref` / `$__vec_f64` / a rest `$Object`,
  // decided by the EMIT SITE's resolved param type, which this builder cannot
  // see (`isNativeGeneratorCandidate` calls it with no param types and must
  // agree with `analyzeNativeGenerator`, or the emit bakes an undefined
  // funcidx) and cannot read back afterwards (a `.next()` site can emit the
  // resume fn before the generator's own emit site destructures). So a rest
  // binding spills at the WASM-BOUNDARY rep, `externref`: AST-only, and
  // reachable from every lane because `compileNativeGeneratorFunction` already
  // coerces the factory local into the spill type. Same lesson as the #3620
  // note on the `param_*` fields below. Full argument: plan/issues/3945-*.md.
  //
  // Whole-param defaults (`[x] = []`) ARE admitted now: the emit site's
  // param-default machinery evaluates the initializer into the param local at
  // call time (before the destructure + factory pack), exactly as for ordinary
  // functions. The #2938 `struct.new[k] expected i32, found externref`
  // mis-typing was the class-bodies COLLECTION-phase param typing diverging
  // from the emit phase (no binding-pattern widening in collection) — fixed in
  // lockstep with this admission (class-bodies.ts collection now applies the
  // identical widen predicate). Object-literal methods keep their #2581
  // default/optional bail in the candidate gate (trampoline argc gap).
  for (const param of decl.parameters) {
    if (ts.isIdentifier(param.name)) continue;
    const pat = param.name;
    if (!ts.isArrayBindingPattern(pat) && !ts.isObjectBindingPattern(pat)) return null;
    const elements: ts.BindingElement[] = [];
    const restNames: string[] = [];
    const walk = (p: ts.BindingPattern): void => {
      for (const el of p.elements) {
        if (ts.isOmittedExpression(el)) continue;
        if (el.dotDotDotToken) {
          // (#3945) An IDENTIFIER rest takes the boundary-rep rule below. A
          // nested pattern under it (`[...[a, b]]`, `[...{length}]`) binds its
          // OWN names via the ordinary `ensureBindingLocals` path, so it is
          // walked like any sub-pattern and keeps the checker rule. The pre-fix
          // walk `continue`d here WITHOUT descending — lifting the bail alone
          // would leave those names unspilled: host-free, valid, and silently
          // reading the inert default.
          if (ts.isIdentifier(el.name)) restNames.push(el.name.text);
          else walk(el.name);
          continue;
        }
        if (ts.isIdentifier(el.name)) elements.push(el);
        else walk(el.name);
      }
    };
    walk(pat);
    for (const name of restNames) {
      patternParamSpillTypes.set(name, { kind: "externref" });
      addSpill(name);
    }
    for (const el of elements) {
      const id = el.name as ts.Identifier;
      // (#3386 → #3952) Element defaults that evaluate to a CLOSURE. #3386 bailed
      // all three of arrow / function-expression / class-expression, and set the
      // bar for widening: "once the closure-valued spill round-trip is proven in
      // all lanes". #3952 ran that proof — each arm spills the closure, SUSPENDS,
      // resumes, and CALLS it (import-freedom plus a plain value read would pass a
      // module that stored a broken reference and never invoked it):
      //
      //   ARROW / plain FUNCTION-EXPRESSION  → round-trips. objlit, class and
      //     array-pattern lanes all return the called closure's value across a
      //     suspension, host-free, and `arrow.name` is still `"arrow"`
      //     (NamedEvaluation, #1450/#1119/#1049). ADMITTED.
      //   GENERATOR function expression (`[g = function*(){}]`) → objlit lane
      //     traps at runtime. STILL BAILS.
      //   CLASS expression (`{ K = class {…} }`) → "dereferencing a null pointer"
      //     in BOTH the objlit and class lanes. STILL BAILS.
      //
      // Note #3386's cited evidence is stale: the shape it named — the #3164
      // host-mix fixture `*method([gen = function*(){}] = [])` in the CLASS lane —
      // now passes. The unsafe set is real but different from the recorded one,
      // which is why this widening is driven by a fresh matrix rather than by
      // relaxing the predicate to whatever the old comment blamed.
      //
      // The class lane also passes the generator-fn-expr arm today (32 rows), but
      // admitting a shape that traps in a sibling lane on lane identity alone is
      // how a leak gets traded for a silent wrong value — so `gen` stays bailed
      // uniformly and is left as a measured, bounded follow-up on #3952.
      //
      // The generator FUNCTION-EXPRESSION host (`const g = function*({…} = {}){}`)
      // keeps the bail for ALL closure defaults too, and the control is what
      // justifies it: that lane already traps on an element default with a plain
      // NUMERIC value (`{ n = 41 }`), with no closure anywhere. So its defect is
      // pre-existing and closure-INDEPENDENT — admitting these 8 rows would swap a
      // loud host-import leak for a runtime trap without proving anything. Tracked
      // separately; do not fold it in here.
      const closureDefault =
        el.initializer !== undefined &&
        (ts.isFunctionExpression(el.initializer) ||
          ts.isArrowFunction(el.initializer) ||
          ts.isClassExpression(el.initializer));
      if (
        closureDefault &&
        ((ts.isFunctionExpression(el.initializer!) && el.initializer!.asteriskToken !== undefined) ||
          ts.isClassExpression(el.initializer!) ||
          ts.isFunctionExpression(decl))
      ) {
        return null;
      }
      const elemTsType = ctx.checker.getTypeAtLocation(el);
      const bindType = resolveBindingElementType(el, elemTsType, (t) => resolveWasmType(ctx, t));
      const safe = spillSafeValType(bindType);
      if (!safe) return null;
      patternParamSpillTypes.set(id.text, safe);
      // (#3315) Mirror ensureBindingLocals' undef-widened marking so identifier
      // reads in the RESUME function skip the checker-type unbox narrowing
      // (which would degrade a runtime `undefined` to NaN before it can be
      // observed). Threaded into the resume fctx via the info.
      if (isUndefWidenedBindingElement(el, resolveWasmType(ctx, elemTsType))) {
        undefWidenedPatternBindings.add(id.text);
      }
      addSpill(id.text);
    }
  }

  if (!lowerStatements(decl.body.statements, [])) return null;
  if (!ok) return null;

  // Final fallthrough state completes the generator.
  finishState(curId, { kind: "done" });

  // (#3050) When the final fallthrough state carries trailing statements
  // (`… yield x; trailing();`), it doubles as BOTH the last executable state
  // and the completed-generator dispatch target — so every post-completion
  // `.next()` re-dispatched into it and RE-RAN the trailing prelude
  // (observable via a `unreachable += 1` after the last yield,
  // GeneratorPrototype/throw/try-*-following-*). Mint a DEDICATED empty done
  // state in that case; generators whose final state is already empty keep
  // their exact state graph (byte-identical).
  //
  // (#2864 D4) `doneState` is the id of the state that COMPLETES the generator,
  // which is the final fallthrough cursor (or the placeholder just minted for
  // it) — NOT `states.length - 1`. Those coincide only for a straight-line
  // body: every structural lowering (`for`/`while`/`do`/`if`/try-region)
  // reserves its exit/join state BEFORE the nested body's states, so a body
  // ENDING in one leaves the fallthrough at a LOWER id than the last reserved
  // state. See the doneState note in `NativeGeneratorPlan`.
  const doneState =
    states[curId]!.statements.length > 0
      ? reserveState() // empty placeholder — its default terminator IS `done`
      : curId;

  // (#3050) Apply the runtime-throw route stamps now that every state object is
  // final (finishState rebuilds them, so stamping placeholders would be lost).
  for (const [id, route] of stateThrowRoutes) {
    const s = states[id];
    if (s) s.throwRoute = route;
  }

  // Reject when the state count is too large. (#2170) A `yield*` delegation
  // state is a suspension point too.
  //
  // (#2938) NO-YIELD generators now lower natively: a zero-suspend body runs to
  // completion in state 0 and produces a done-from-start trampoline. This was
  // held off behind the late-import funcIdx-shift bug (`__str_flatten call[1]
  // expected externref, found i32` at harness scale) fixed by #2936 (the
  // raw-import + deferred-batch shift-regime mix in ensureLateImport). The
  // 1780-file no-yield dstr-binding corpus is the payoff (~250-350 host-free
  // flips). This bail relaxes in LOCKSTEP with the candidate gate's terminal
  // yield-require (`isNativeGeneratorCandidate`) — a mismatch is an
  // undefined-funcidx invalid module.
  if (states.length > MAX_NATIVE_GENERATOR_STATES) return null;

  // (#2864 F1b) Type every spilled local at its ACTUAL wasm ValType so a live-
  // across-yield object / string / typed-struct local survives the frame, rather
  // than the F1 blanket bail (`elemIsAny && spills.length > 0`) or the historical
  // f64-only assumption. Two kinds of spill:
  //   • a `let x = yield …` RESUME BINDING — its value comes from the `sent`
  //     carrier field, so it must match the carrier type (f64 for numeric/string,
  //     externref for the boxed-any carrier), NOT resolveWasmType(x) (the declared
  //     `TNext`, usually `any`).
  //   • a plain body LOCAL — resolved via `resolveSpillLocalValType`, which mirrors
  //     the type the resume function's var-declaration will assign it.
  // If ANY spill cannot be resolved to a supported, struct-storable kind, the
  // whole generator bails to the host path (return null) — consistent across the
  // candidate gate and registration (both route through this builder), so the
  // host imports stay registered and no undefined funcidx is baked.
  const resumeBindingNames = new Set<string>();
  for (const s of states) for (const b of s.resumeBindings) resumeBindingNames.add(b);
  const carrierType = genCarrierFieldType(elemValType);
  const spillTypes = new Map<string, ValType>();
  for (const name of spills) {
    // (#2864 R1) A delegation-completion binding (`const x = yield* inner()`)
    // holds the inner's f64 `return` value — always f64 (only f64-elem inners
    // are delegated), independent of the OUTER's carrier.
    if (delegationBindingNames.has(name)) {
      spillTypes.set(name, { kind: "f64" });
      continue;
    }
    if (resumeBindingNames.has(name)) {
      // A `let x = yield …` binding reads `.next(v)`'s value from the `sent`
      // carrier field. For numeric / native-string carriers (sent = f64 / string)
      // this round-trips and was already supported. For the BOXED-ANY carrier the
      // sent value is an externref whose later member reads need the any-receiver
      // dispatch (#2151) — not yet correct here (it silently computes a wrong
      // value), so keep bailing that shape to the host path, exactly as F1 did.
      if (carrierIsAny(elemValType)) return null;
      spillTypes.set(name, carrierType);
      continue;
    }
    // (#2920) A destructuring-param binding name — typed up-front from the
    // checker (no body `VariableDeclaration` exists to resolve it from).
    const patternType = patternParamSpillTypes.get(name);
    if (patternType) {
      spillTypes.set(name, patternType);
      continue;
    }
    // (#3050) A catch-clause param — always externref (the exn tag payload);
    // no body VariableDeclaration exists to resolve it from. A same-named body
    // declaration bailed at region-lowering time, so no conflict reaches here.
    const catchType = catchParamSpillTypes.get(name);
    if (catchType) {
      spillTypes.set(name, catchType);
      continue;
    }
    const declNode = spillDecls.get(name);
    const resolved = declNode ? resolveSpillLocalValType(ctx, declNode) : null;
    if (!resolved) return null;
    spillTypes.set(name, resolved);
  }

  return {
    states,
    doneState,
    spills,
    spillTypes,
    elemValType,
    delegationSites,
    vecDelegationSites,
    iterableDelegationSites,
    needsPending,
    hasThrowRoutes,
    patternParamBindings: new Set(patternParamSpillTypes.keys()),
    undefWidenedPatternBindings,
  };
}

/**
 * (#2571) A native-generator candidate is either a named `function*`
 * declaration or a class / object-literal generator METHOD. Both expose
 * `.body` / `.parameters` / `.asteriskToken` / `.name`, so the plan builder and
 * the state model treat them uniformly; the only method-specific handling is the
 * synthetic `this` leading param (threaded in `registerNativeGenerator`).
 */
export type GeneratorDecl = ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression;

/**
 * (#3164) Generator FUNCTION EXPRESSIONS (`var g = function*(){…}`, the dstr
 * harness IIFE `var iter = function*(){…}()`) are candidates too: the closure
 * lowering (closures.ts) registers them under their lifted `__closure_<n>` name
 * with the closure `__self` param threaded as a leading synthetic capture, and
 * the lifted body emits the native state-struct factory instead of the
 * eager-buffer host path. This is the fn-expr-specific shape gate consumed by
 * `isNativeGeneratorCandidate` — slice 1 (#3164), pattern params added (#3386):
 *   - identifier or binding-pattern params, no default/optional/rest (the
 *     closure trampoline's argc/default machinery is NOT threaded; a param
 *     default's evaluation is a CALL-time observable per
 *     §27.5/EvaluateGeneratorBody). Pattern params destructure eagerly in the
 *     lifted factory (emitClosureParamDestructuring) and pack into spill
 *     fields (#3386);
 *   - no `arguments` (the eager path builds the arguments vec; the state struct
 *     has no slot for it);
 *   - no `this` (a bare function expression's `this` is call-site dependent; the
 *     state-struct model has no receiver slot for the non-method case);
 *   - a NAMED fn-expr must not reference its own name (the self-binding scope
 *     rides `__self` in the closure model, which the resume function lacks);
 *   - no outer-scope capture (checked by the caller via
 *     `generatorCapturesOuterScope`, same as methods).
 */
function isNativeGeneratorExpressionShape(ctx: CodegenContext, decl: ts.FunctionExpression): boolean {
  if (!decl.body) return false;
  for (const param of decl.parameters) {
    // (#3386) Binding-pattern params are admitted: the closure's lifted body
    // eagerly destructures them (emitClosureParamDestructuring, before the
    // factory emit — call-time per §10.2.11) and the factory packs the bound
    // values into spill fields; pattern legality is decided by
    // `buildNativeGeneratorPlan`. (#3893) Whole-param defaults are admitted in
    // the no-JS-host lane too — closures.ts emits them in the lifted body =
    // the factory, again where §10.2.11 wants them. Optional/rest still bail.
    if (
      !ts.isIdentifier(param.name) &&
      !ts.isArrayBindingPattern(param.name) &&
      !ts.isObjectBindingPattern(param.name)
    ) {
      return false;
    }
    if (param.questionToken || param.dotDotDotToken || (param.initializer && !noJsHostTarget(ctx))) return false;
  }
  if (bodyNeedsArgumentsObject(decl.body)) return false;
  if (fnExprBodyReferencesThis(decl.body)) return false;
  if (decl.name && bodyReferencesOwnName(decl.body, decl.name.text)) return false;
  // (#3302) Outer-scope captures are ADMITTED in the standalone/wasi lane:
  // the lifted closure already carries them as `__self` struct fields, and
  // the resume function re-materializes them via
  // `NativeGeneratorInfo.selfCaptureRehydration` (the exact async-drive-lane
  // mechanism, async-frame.ts #2865). This retires the eager-buffer HOST
  // fallback for the dominant test262 dstr-fixture IIFE
  // (`var iter = function*(){ iterations += 1; }();`) — which leaked the
  // whole `env::__gen_*`/`__get_caught_exception` import family into
  // standalone binaries (validate-but-can't-instantiate) AND ran the body at
  // creation (the §27.5.3.1 violation, #3032). Under a JS host a fn-expr
  // never reaches this gate (the host-lane candidate block admits only
  // FunctionDeclarations), but keep the bail explicit for defense — the
  // eager host path with the slice-1 lazy thunk remains the host-lane
  // lowering.
  if (!noJsHostTarget(ctx) && generatorCapturesOuterScope(ctx, decl)) return false;
  return true;
}

/**
 * (#3050) True when any value-position identifier in the generator body has no
 * checker symbol (an unresolvable global like test262's `test262unresolvable`).
 * Host-lane native routing bails on these — the eager path's #928
 * deferred-pending-throw is the behavior the JS-host lane relies on. Skips
 * property names and does not descend into nested function-likes.
 */
function bodyReferencesUnresolvableIdentifier(ctx: CodegenContext, decl: GeneratorDecl): boolean {
  if (!decl.body) return false;
  const { checker } = ctx;
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (isFunctionLikeScope(node)) {
      return;
    }
    if (
      ts.isIdentifier(node) &&
      node.text !== "arguments" &&
      node.text !== "undefined" &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
      !((ts.isVariableDeclaration(node.parent) || ts.isBindingElement(node.parent)) && node.parent.name === node)
    ) {
      const sym = checker.getSymbolAtLocation(node);
      if (!sym) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(decl.body, visit);
  return found;
}

/**
 * (#3032 W6) HOST-lane shape bails for the native routing, covering the two
 * body shapes the state machine still miscompiles (verified pre-existing on
 * the standalone lane, where they are baseline-accounted; the host lane must
 * not INHERIT them as pass→fail flips — it keeps the eager path instead):
 *
 *   - `yield (… yield …)` — a yield nested in another yield's operand. The
 *     plan builder collapses the two suspends (first `next()` returns the
 *     OUTER operand instead of the inner yield's value —
 *     `generators/yield-as-yield-operand.js` returns 0 for `yield yield 1`).
 *   - `yield*` delegation — the host-lane resume fn routes the delegate
 *     through the `__iterator` chain, which traps (`illegal cast`) when the
 *     delegate is a host-side generator object (an eager-lowered inner —
 *     `generators/yield-star-before-newline.js`). Standalone delegates
 *     native→native and is unaffected.
 *
 * Both scans stop at nested function boundaries (a nested generator's yields
 * are its own).
 */
function bodyHasHostUnsupportedYieldShape(decl: GeneratorDecl): boolean {
  if (!decl.body) return false;
  let found = false;
  const containsYield = (node: ts.Node): boolean => {
    if (ts.isYieldExpression(node)) return true;
    if (isFunctionLikeScope(node)) return false;
    let hit = false;
    ts.forEachChild(node, (c) => {
      if (!hit && containsYield(c)) hit = true;
    });
    return hit;
  };
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isFunctionLikeScope(node)) return;
    if (ts.isYieldExpression(node)) {
      if (node.asteriskToken) {
        found = true; // yield* delegation
        return;
      }
      if (node.expression && containsYield(node.expression)) {
        found = true; // yield nested in a yield operand
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(decl.body, visit);
  return found;
}

/**
 * (#3050) Conservative HOST-lane use-site safety walk. The native generator
 * state struct is a WasmGC ref the JS host cannot iterate, so it must never
 * escape to a host-iterating context. Walks every `<name>(…)` call in the
 * source file and demands its result flow into an allowlisted consumer:
 *
 *   - `g().next()/…` member access on the call result;
 *   - `for (x of g())` (NO await), `[...g()]`, `Array.from(g())`;
 *   - `const [a,b] = g()` array-destructuring;
 *   - `iter = g()` / `var iter = g()` — where EVERY reference of `iter` is
 *     itself allowlisted (member access — `.next()`/`.throw()` incl. inside
 *     nested closures like `assert.throws(function(){ iter.throw(e) })` —
 *     for-of/spread/Array.from subject, destructuring source, reassignment).
 *
 * Anything else (an eager generator's `yield*` subject, for-await-of, an
 * arbitrary call argument such as `Promise.all(g())` / `new Map(g())`, a
 * return value, a property value, …) fails the walk and the generator keeps
 * the eager host path. Name-based matching over-approximates (a shadowing
 * same-named function bails too) — conservative by design.
 */
function hostLaneGeneratorUsesAreSafe(ctx: CodegenContext, decl: GeneratorDecl): boolean {
  if (!decl.name || !ts.isIdentifier(decl.name)) return false;
  const genName = decl.name.text;
  const sf = decl.getSourceFile();
  const { checker } = ctx;

  const isArrayFromArg = (node: ts.Node): boolean => {
    const p = node.parent;
    return (
      ts.isCallExpression(p) &&
      p.arguments.length > 0 &&
      p.arguments[0] === node &&
      ts.isPropertyAccessExpression(p.expression) &&
      ts.isIdentifier(p.expression.expression) &&
      p.expression.expression.text === "Array" &&
      p.expression.name.text === "from"
    );
  };

  /**
   * (#3032 W6) The `{value, done}` RESULT of a `.next()/.return()/.throw()`
   * call on a native generator is ALSO a raw WasmGC struct. Reflection on it
   * (`Object.getPrototypeOf(result)`, passing it as a call argument like
   * `hasOwnProperty.call(result, …)`) sees the struct, not a plain object —
   * `GeneratorPrototype/next/result-prototype.js` regressed exactly there. So
   * a result value must itself stay in allowlisted consumers: property reads
   * (`r.value`/`r.done`), `typeof`, statement-drop, or a binding whose every
   * use is again allowlisted.
   */
  const resultConsumptionIsSafe = (call: ts.Node): boolean => {
    const p = call.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === call) return true; // .value/.done chains
    if (ts.isExpressionStatement(p)) return true; // result dropped
    if (ts.isTypeOfExpression(p)) return true;
    if (ts.isParenthesizedExpression(p)) return resultConsumptionIsSafe(p);
    if (ts.isVariableDeclaration(p) && p.initializer === call && ts.isIdentifier(p.name)) {
      return resultBindingUsesAreSafe(p.name);
    }
    if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      p.right === call &&
      ts.isIdentifier(p.left)
    ) {
      if (!resultBindingUsesAreSafe(p.left)) return false;
      // The assignment expression's own value is the result too.
      return ts.isExpressionStatement(p.parent) ? true : resultConsumptionIsSafe(p);
    }
    return false;
  };

  /** Every reference of a RESULT binding is an allowlisted result consumer? */
  const resultBindingUsesAreSafe = (bindingName: ts.Identifier): boolean => {
    const sym = checker.getSymbolAtLocation(bindingName);
    if (!sym) return false;
    let safe = true;
    const visitRef = (node: ts.Node): void => {
      if (!safe) return;
      if (ts.isIdentifier(node) && node.text === bindingName.text && node !== bindingName) {
        if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;
        if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
        if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) return;
        const refSym = checker.getSymbolAtLocation(node);
        if (refSym !== sym) return;
        const p = node.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === node) return; // r.value / r.done
        if (ts.isTypeOfExpression(p)) return;
        // Reassignment target — the RHS is checked at its own call site.
        if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === node) {
          return;
        }
        safe = false;
      }
      ts.forEachChild(node, visitRef);
    };
    ts.forEachChild(sf, visitRef);
    return safe;
  };

  /**
   * A reference/result value consumed in an allowlisted, host-safe position?
   *
   * `viaBinding` distinguishes the TWO ways this walk reaches a consumer:
   *
   *   - `false` — the node is the generator CALL expression itself
   *     (`for (x of g())`, `[...g()]`, `Array.from(g())`, `g().next()`). The
   *     for-of driver / spread-drain / Array.from-drain all see the call's
   *     native state-struct ValType directly, so they lower to the WasmGC
   *     native path (`tryCompileNativeGeneratorForOf` / `emitNativeGeneratorToVec`).
   *
   *   - `true` — the node is a REFERENCE to a `var/let iter = g()` binding
   *     (`for (x of iter)`, `[...iter]`, `Array.from(iter)`). The binding's
   *     inferred TS type is `Generator<T>`, which resolves to **externref**, so
   *     the generator result is `extern.convert_any`-coerced on assignment and
   *     the state-struct type is LOST at the reference. An iteration/drain
   *     consumer over that externref falls to the JS-host iterator protocol,
   *     which cannot drive a raw WasmGC struct — `next()` reports `done` on the
   *     first call and the loop body is silently skipped (#3468: for-of
   *     break/continue/return-label tests over `var it = values()` regressed to
   *     "unreachable following for..of"). Only `.next()/.throw()/.return()`
   *     member CALLS have a native-aware lowering that recognises the struct
   *     through the externref; every host-protocol iteration consumer of a
   *     binding is unsafe and keeps the generator on the eager host path.
   */
  const useIsSafe = (node: ts.Node, viaBinding: boolean): boolean => {
    const p = node.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === node) {
      // (#3032 W6) A resume-method CALL (`it.next()/…`) produces a raw result
      // struct — its consumption must be allowlisted too (see
      // resultConsumptionIsSafe). Non-call member reads (`.value`, `.length`)
      // and other member names keep the original terminal-safe answer.
      const memberName = p.name.text;
      if (
        (memberName === "next" || memberName === "return" || memberName === "throw") &&
        ts.isCallExpression(p.parent) &&
        p.parent.expression === p
      ) {
        return resultConsumptionIsSafe(p.parent);
      }
      return true;
    }
    // A for-of consumer over a binding is native-safe once the binding slot
    // preserves the generator state-struct type (the slot typer below mirrors
    // the direct-call result). Keep spread/Array.from/destructure over a
    // binding conservative: those drains still use the generic vec carrier.
    if (ts.isForOfStatement(p) && p.expression === node && !p.awaitModifier) return true;
    if (!viaBinding) {
      if (ts.isSpreadElement(p)) return true;
      if (isArrayFromArg(node)) return true;
    }
    if (ts.isParenthesizedExpression(p)) return useIsSafe(p, viaBinding);
    return false;
  };

  /** Every reference of the binding `sym` (outside its declaration) is safe? */
  const bindingUsesAreSafe = (bindingName: ts.Identifier): boolean => {
    const sym = checker.getSymbolAtLocation(bindingName);
    if (!sym) return false;
    let safe = true;
    const visitRef = (node: ts.Node): void => {
      if (!safe) return;
      if (ts.isIdentifier(node) && node.text === bindingName.text && node !== bindingName) {
        // Skip non-value positions (property names, declaration names — incl.
        // the binding's own `var iter;` declaration name).
        if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;
        if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
        if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) return;
        const refSym = checker.getSymbolAtLocation(node);
        if (refSym !== sym) return;
        // (#3032 W6) A RE-ENTRANT use — the instance binding referenced INSIDE
        // the generator's own body (`function* g() { iter.return(42); }`,
        // GeneratorPrototype/{return,throw}/from-state-executing) — is unsafe:
        // inside the resume fn the binding rides an any/externref capture cell,
        // so the member call dynamic-dispatches to the host shim with a raw
        // state struct (`gen.return` reads `undefined`). Keep such generators
        // on the eager host path.
        if (node.getStart() >= decl.getStart() && node.getEnd() <= decl.getEnd()) {
          safe = false;
          return;
        }
        const p = node.parent;
        if (useIsSafe(node, /* viaBinding */ true)) return;
        // Reassignment target (`iter = g()` again) — the RHS call is checked
        // at its own call site.
        if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === node) {
          return;
        }
        // (#3468) Array-destructuring SOURCE over a binding (`[a] = iter` /
        // `const [a] = iter`) is NOT native-safe: the binding is externref, so
        // the destructure drain falls to the host protocol (yields NaN/defaults).
        // Only the DIRECT-call destructuring form (`[a] = g()`) drains natively;
        // it is admitted at the call site below, not here. So a binding used as a
        // destructuring source keeps the generator on the eager host path.
        safe = false;
      }
      ts.forEachChild(node, visitRef);
    };
    ts.forEachChild(sf, visitRef);
    return safe;
  };

  let allSafe = true;
  const visit = (node: ts.Node): void => {
    if (!allSafe) return;
    // (#2662) A NON-CALL value reference of the generator name (`const h = g`,
    // `obj.fn = g`, `g.prototype…`, a call argument `f(g)`) aliases or escapes
    // the FUNCTION itself; calls through the alias are invisible to this walk,
    // so the state struct could reach a host-iterating context unchecked. Only
    // references that RESOLVE to this declaration bail (a shadowing same-named
    // binding is someone else's value; symbol-less resolution failures bail
    // conservatively). The declaration's own name and pure property NAMES are
    // not value references.
    if (
      ts.isIdentifier(node) &&
      node.text === genName &&
      node !== decl.name &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
      !(ts.isBindingElement(node.parent) && node.parent.name === node) &&
      (checker.getSymbolAtLocation(node)?.declarations?.includes(decl) ?? true)
    ) {
      allSafe = false;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === genName &&
      // Only calls that actually resolve to THIS declaration (a same-named
      // local in another scope is someone else's call).
      (checker.getSymbolAtLocation(node.expression)?.declarations?.includes(decl) ?? true)
    ) {
      const p = node.parent;
      if (useIsSafe(node, /* viaBinding */ false)) {
        // safe direct consumer
      } else if (ts.isVariableDeclaration(p) && p.initializer === node) {
        if (ts.isIdentifier(p.name)) {
          if (!bindingUsesAreSafe(p.name)) allSafe = false;
        }
        // array/object-binding destructuring init → handled natively, safe.
      } else if (
        ts.isBinaryExpression(p) &&
        p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        p.right === node &&
        ts.isIdentifier(p.left)
      ) {
        if (!bindingUsesAreSafe(p.left)) allSafe = false;
      } else if (
        ts.isBinaryExpression(p) &&
        p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        p.right === node &&
        ts.isArrayLiteralExpression(p.left)
      ) {
        // `[a, b] = g()` destructuring-assignment source — native path.
      } else {
        allSafe = false;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return allSafe;
}

export function isNativeGeneratorCandidate(ctx: CodegenContext, decl: GeneratorDecl): boolean {
  if (!noJsHostTarget(ctx)) {
    // (#3050 → #3032 W6) JS-HOST lane: the eager-buffer lowering evaluates the
    // whole body at creation, which violates §27.5 EvaluateGeneratorBody
    // (GeneratorStart SUSPENDS at start-of-body; nothing runs until the first
    // `next()`), cannot express a `.throw()`/abrupt resumption into a
    // try-region (GeneratorPrototype/throw/try-{catch,finally}-*), and cannot
    // deliver a `next(v)` sent value into the body (the buffer replays
    // pre-computed yields). #3050 scoped host-lane native routing to exactly
    // the try-region shapes; #3032 W6 drops that restriction — every free
    // `function*` DECLARATION that passes the conservative safety walks below
    // (resolvable identifiers + allowlisted use sites) now routes through the
    // native state machine under the JS host too, making creation lazy and
    // `next(v)` two-way for the dominant test262 shape. Non-plannable shapes
    // still fall back to the eager buffer via the plan gate below; generator
    // EXPRESSIONS and METHODS keep their host-lane lowerings (thunk / eager)
    // for now — separate W6 slices.
    if (!ts.isFunctionDeclaration(decl)) return false;
    // (#3032 W6) An EXPORTED generator declaration keeps the eager host path:
    // its factory is called directly from JS (`instance.exports.g().next()`),
    // and the native factory returns a raw WasmGC state struct the host
    // cannot invoke `.next()` on. The use-site safety walk below cannot see
    // host-side consumers — the export boundary is the one escape it cannot
    // model — so gate on the export modifier itself. (In-module callers of an
    // exported generator are unaffected: they ride the eager host object,
    // exactly the pre-W6 behavior.)
    if (ts.getModifiers(decl)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return false;
    // (#3032 W6) Body shapes the native machine still miscompiles (nested
    // yield operands, `yield*` delegation) keep the eager host path — see
    // bodyHasHostUnsupportedYieldShape.
    if (bodyHasHostUnsupportedYieldShape(decl)) return false;
    // Conservative: a body referencing an UNRESOLVABLE identifier (e.g.
    // `try { yield test262unresolvable } catch (e) {…}`) keeps the eager path —
    // its host-lane semantics ride #928's deferred-pending-throw (the eager
    // eval's JS ReferenceError is re-thrown at the first next()), which the
    // resume-time evaluation may not reproduce identically.
    if (bodyReferencesUnresolvableIdentifier(ctx, decl)) return false;
    // Conservative use-site safety walk: the native state struct is a WasmGC
    // ref the JS HOST cannot iterate — if it escapes to any host-iterating
    // context (an EAGER generator's `yield*`, for-await-of, Promise.all,
    // `new Map(g())`, an arbitrary call argument, …) the values silently drop
    // (an eager outer's `yield* inner()` over a native inner yielded nothing).
    // Only generators whose every call-site result flows into an ALLOWLISTED
    // consumer — `.next()/.throw()/.return()` member calls, for-of (no await),
    // spread, `Array.from`, destructuring — route natively under the JS host;
    // anything else keeps the eager path.
    if (!hostLaneGeneratorUsesAreSafe(ctx, decl)) return false;
  }
  if (!decl.body || !decl.asteriskToken) return false;
  // (#2864 wave-2 S2) A body that READS the implicit `arguments` object has no
  // native-frame support: the state struct has slots for `this`, own params and
  // spilled locals, and the RESUME function compiles the body with a fresh
  // `FunctionContext` in which nothing ever builds the arguments vec (the
  // §10.2.11 setup in function-body.ts runs on the FACTORY's context only). So
  // `arguments` resolves to nothing in the resume body.
  //
  // This bail already existed for the two OTHER generator forms — generator
  // EXPRESSIONS (`isNativeGeneratorExpressionShape`) and METHODS (the
  // `bodyNeedsArgumentsObject(decl.body)` arm below) — and was simply never
  // applied to free function DECLARATIONS, which #3032 W6 subsequently routed
  // natively on the JS-HOST lane as well. Measured consequences of the gap:
  //   * JS-HOST (gc): `function* g(a,b){ const n = arguments.length; yield n }`
  //     compiled "successfully" and produced a module the ENGINE REJECTS —
  //     `global.set[0] expected type externref, found i32.const of type i32`.
  //     A non-generator reading `arguments`, and a generator not reading it,
  //     are both valid; it is specifically generator × `arguments`.
  //   * standalone/wasi: a raw wasm trap at the first `arguments` read, before
  //     any suspend — not a suspend-crossing problem.
  // Both become the ordinary eager-buffer path (host: correct; standalone: a
  // clean #680 refusal), which is what every other unsupported shape does here.
  //
  // NOTE for the #3032 "js-host bytes identical" contract: host bytes DO change
  // for these programs, and that contract cannot apply — the bytes being
  // replaced are an invalid module, so there is no valid baseline to preserve.
  //
  // Making `arguments` genuinely work in the native frame is a real slice, not
  // a wider gate: the factory must build the vec at CALL time (§10.2.11) and
  // spill it, the resume function must reload it into an `arguments` local, and
  // MAPPED aliasing (`arguments[0] = v` writing back to param `a`) needs
  // `fctx.mappedArgsInfo` rebuilt against the frame. Design banked in #2864.
  if (bodyNeedsArgumentsObject(decl.body)) return false;
  // (#3164) A FunctionExpression may be anonymous — its native registration
  // rides a synthetic lifted-closure name supplied by the emit site
  // (closures.ts). Everything else still requires a name (funcMap key).
  if (!decl.name && !ts.isFunctionExpression(decl)) return false;
  // (#3164) Fn-expr-specific shape gate (identifier-only params, no
  // `this`/`arguments`, no self-name reference, no outer capture). Applied
  // here — the SINGLE candidate gate — so `sourceNeedsGeneratorHostImports`,
  // `registerNativeGenerator`, and the closures.ts emit site all agree
  // (disagreement bakes an undefined `__gen_*` funcIdx → invalid module).
  if (ts.isFunctionExpression(decl) && !isNativeGeneratorExpressionShape(ctx, decl)) return false;
  // (#2571) An object-literal method with a computed/string name
  // (`{ [k]*(){} }`, `{ "m"*(){} }`) is out of scope — only an identifier-named
  // method threads cleanly through the funcMap key. (#3896) PRIVATE names are
  // admitted: already `__priv_`-mangled, and class-only, so never this shape.
  if (ts.isMethodDeclaration(decl) && !ts.isIdentifier(decl.name) && !ts.isPrivateIdentifier(decl.name)) return false;
  // (#2571/#2581) A method generator is native-routable only when its emit site
  // is wired to the native factory: CLASS bodies (class-bodies.ts, #2571) and
  // OBJECT-LITERAL methods (literals.ts, #2581). Both compile the method body as
  // a func whose param 0 is the receiver `this` (a `ref $struct`), so the
  // synthetic-`this` state-struct model applies uniformly. Any OTHER
  // MethodDeclaration context (e.g. a TS interface/type member, or a shape the
  // emit paths don't cover) keeps the host path — bailing here (the single
  // candidate gate consumed by both `registerNativeGenerator` AND
  // `sourceNeedsGeneratorHostImports`) keeps the host imports registered,
  // avoiding an undefined-funcidx invalid module.
  if (ts.isMethodDeclaration(decl) && !ts.isClassLike(decl.parent) && !ts.isObjectLiteralExpression(decl.parent)) {
    return false;
  }
  const modifiers = ts.canHaveModifiers(decl) ? ts.getModifiers(decl) : undefined;
  if (modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword || m.kind === ts.SyntaxKind.DeclareKeyword)) {
    return false;
  }
  for (const param of decl.parameters) {
    // (#2920/#3386) Rest params (`...args`) still bail — a separate follow-up.
    // Array / object binding-pattern params are natively lowered: the emit
    // site destructures the raw arg EAGERLY (call time, §10.2.11) into factory
    // locals and `compileNativeGeneratorFunction` packs the bound values into
    // spill fields; the plan builder decides pattern legality (rest elements /
    // unstorable binding types bail there). Identifier params stay
    // byte-identical.
    if (param.dotDotDotToken) return false;
    if (
      !ts.isIdentifier(param.name) &&
      !ts.isArrayBindingPattern(param.name) &&
      !ts.isObjectBindingPattern(param.name)
    ) {
      return false;
    }
  }
  // (#2581 → #3948) The OBJECT-LITERAL generator method DEFAULT/OPTIONAL bail is
  // LIFTED. #2581's diagnosis was right about the symptom and wrong about both
  // the mechanism and the remedy, so the correction is recorded here rather than
  // just deleted (see issue #3948 for the instrumented trace):
  //
  //   * The mechanism was NOT the `emitObjectMethodAsClosure` trampoline. A plain
  //     `o.m()` is a direct call and does reach `maybeSetArgcForKnownCall`
  //     (call-receiver-method.ts). What it found there was an EMPTY
  //     `ctx.funcOptionalParams` — object-literal methods were the one method
  //     form that never registered optional-param metadata (class bodies do it in
  //     `registerClassOptionalParams`, free functions in declarations.ts). The
  //     gate `!funcUsesArguments.has(n) && !funcOptionalParams.has(n)` therefore
  //     returned early and `$__argc` kept its `-1` "unknown caller" sentinel.
  //   * The remedy was NOT sound either: routing to the eager-buffer HOST path
  //     does not apply the default correctly — measured on the host lane,
  //     `{ *m(a = 5) }.m().next().value` is 0 there too. The bail bought no
  //     correctness, only a `__gen_*` host-import leak in standalone (98 rows).
  //
  // #3948 fixes the real gap in literals.ts (register the optional params), which
  // makes the argc-driven default fire for object-literal methods in BOTH lanes;
  // this gate then has nothing left to protect against. Kill-switched both ways:
  // restoring this bail turns the leak red again, and reverting the literals.ts
  // registration alone leaves a host-free module that silently yields the inert 0.
  //
  // `questionToken` STILL bails, and that half was measured rather than inherited:
  // with the argc registration in place, `{ *m(a?: number) { yield a === undefined
  // ? 42 : a } }.m()` still yields 0, not 42 — an `a?: number` param lowers to a
  // bare `f64` with no `undefined` inhabitant, so there is nothing for the missing
  // -arg branch to bind. That is a value-representation gap (#3949's family), not
  // an admission-gate one, and the same 0 comes out of a NON-generator
  // `{ m(a?: number) }`. Admitting it here would trade a leak for a wrong value,
  // so it keeps the host path until the rep gap is closed. #3893 made the same
  // call for function expressions.
  if (ts.isMethodDeclaration(decl) && ts.isObjectLiteralExpression(decl.parent)) {
    for (const param of decl.parameters) {
      if (param.questionToken) return false;
    }
  }
  // (#2938) A generator METHOD whose emitted name is not unique within its
  // class / object literal must bail to the host path. The class collection
  // pass keys everything on `${className}_${methodName}` and SKIPS a
  // duplicate-name member ("Skip if a function with this name is already
  // registered" — the static/instance same-name case), so a second `*id()`
  // would be emitted against the FIRST member's `NativeGeneratorInfo`
  // (mismatched `synthesizedThis` param model → "local index out of range" at
  // binary emit, fn-name-gen-method.js). Computed names (`*[sym]()`) bail too:
  // their emitted-name derivation is not stable enough to prove uniqueness.
  // Gate here — the SINGLE source of truth — so collection, the method emit
  // AND `sourceNeedsGeneratorHostImports` all agree (host imports stay
  // registered; behavior matches the pre-#2938 eager-buffer path).
  if (ts.isMethodDeclaration(decl)) {
    if (ts.isComputedPropertyName(decl.name)) return false;
    const parent = decl.parent;
    if (ts.isClassLike(parent) || ts.isObjectLiteralExpression(parent)) {
      const ownName = decl.name.getText();
      const members: readonly ts.Node[] = ts.isObjectLiteralExpression(parent) ? parent.properties : parent.members;
      let sameName = 0;
      for (const m of members) {
        if (
          ts.isMethodDeclaration(m) &&
          m.asteriskToken &&
          !ts.isComputedPropertyName(m.name) &&
          m.name.getText() === ownName
        ) {
          sameName++;
        }
      }
      if (sameName > 1) return false;
    }
  }
  // (#2571) A method generator that reads `arguments`, uses `super.*`, or
  // CAPTURES an enclosing-function binding (#2203) has no native state-machine
  // support: the eager-buffer path builds the arguments vec / closure, while the
  // native state struct has slots only for `this` + own params, not captures.
  // Bail to the host path so it stays correct (host) / refuses cleanly
  // (standalone) rather than reading a garbage slot. This keeps the candidate
  // gate the SINGLE source of truth — `registerNativeGenerator` (class-bodies)
  // and `sourceNeedsGeneratorHostImports` both consult it and agree.
  if (
    ts.isMethodDeclaration(decl) &&
    decl.body &&
    (bodyNeedsArgumentsObject(decl.body) ||
      methodBodyUsesSuper(decl.body) ||
      // (#3032 W4) Outer-scope captures are ADMITTED for method generators in
      // the standalone/wasi lane: a class / object-literal method body never
      // receives captures as params — it resolves them through the
      // #2029/#3039/#3121 promotion machinery (`ctx.capturedBoxGlobals` /
      // `ctx.capturedGlobals` module globals), which is fctx-INDEPENDENT, so
      // the resume function compiles the same body with the same global
      // reads/writes — no threading needed. The promotion runs in the
      // enclosing fctx before the class/literal members compile, hence before
      // the resume fn emits. JS-host lane keeps the eager path (byte-identical;
      // its laziness is the #3032 thunk track).
      (!noJsHostTarget(ctx) && generatorCapturesOuterScope(ctx, decl)))
  ) {
    return false;
  }
  const plan = buildNativeGeneratorPlan(ctx, decl);
  // (#2938) No terminal yield-require — no-yield (zero-suspend) generators are
  // native candidates now that #2936 fixed the late-import funcIdx-shift class.
  // Relaxed in LOCKSTEP with buildNativeGeneratorPlan's suspendCount bail.
  return plan !== null;
}

/**
 * (#2203) True when `decl` is a generator nested inside another function that
 * reads or writes a binding from an enclosing scope (a "capture"). Such a
 * generator cannot use the Wasm-native generator factory — its state lives in a
 * struct, with no slot for captured outer-scope bindings, so the native
 * registration in `nested-declarations.ts` is gated on `captures.length === 0`
 * and a capturing generator falls through to the eager-buffer host path. In a
 * no-JS-host target the eager path needs the `__gen_*` host imports; if they
 * were never registered (because `isNativeGeneratorCandidate` — which does not
 * model captures — wrongly classified this as native), the emit bakes a
 * `funcIdx: undefined` and produces invalid Wasm. Flagging the capture here lets
 * `sourceNeedsGeneratorHostImports` register the host imports so the funcidx is
 * valid (the test262 standalone runner supplies the `__gen_*` shim). A
 * non-capturing nested generator stays native and is NOT flagged, so it does not
 * gain unused host-import dependencies.
 */
function generatorCapturesOuterScope(ctx: CodegenContext, decl: GeneratorDecl): boolean {
  if (!decl.body) return false;
  // Only generators nested inside another function-like scope can capture; a
  // top-level generator's free variables are module globals, which the native
  // lowering already reads/writes directly (no host buffer needed).
  let ancestor: ts.Node | undefined = decl.parent;
  let nested = false;
  while (ancestor) {
    if (ts.isSourceFile(ancestor)) break;
    if (
      ts.isFunctionDeclaration(ancestor) ||
      ts.isFunctionExpression(ancestor) ||
      ts.isArrowFunction(ancestor) ||
      ts.isMethodDeclaration(ancestor) ||
      ts.isConstructorDeclaration(ancestor) ||
      ts.isGetAccessorDeclaration(ancestor) ||
      ts.isSetAccessorDeclaration(ancestor)
    ) {
      nested = true;
      break;
    }
    ancestor = ancestor.parent;
  }
  if (!nested) return false;

  let captures = false;
  const checker = ctx.checker;
  function scan(node: ts.Node): void {
    if (captures) return;
    if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      const sym = checker.getSymbolAtLocation(node);
      const declNode = sym?.declarations?.[0];
      if (declNode) {
        // A binding declared OUTSIDE the generator body, yet inside some
        // enclosing function (i.e. not a module global / global builtin), is a
        // capture. Walk the declaration's ancestors: if we reach the generator
        // decl it is local (not a capture); if we reach an enclosing function
        // first it is captured; if we reach the SourceFile it is a module/global
        // binding the native path handles directly.
        let p: ts.Node | undefined = declNode;
        while (p) {
          if (p === decl) return; // declared within the generator → local
          if (p === decl.body) return;
          if (
            ts.isFunctionDeclaration(p) ||
            ts.isFunctionExpression(p) ||
            ts.isArrowFunction(p) ||
            ts.isMethodDeclaration(p) ||
            ts.isConstructorDeclaration(p)
          ) {
            // Reached an enclosing function before the SourceFile → captured.
            captures = true;
            return;
          }
          if (ts.isSourceFile(p)) return; // module-level binding → not a capture
          p = p.parent;
        }
      }
    }
    ts.forEachChild(node, scan);
  }
  scan(decl.body);
  return captures;
}

export function sourceNeedsGeneratorHostImports(ctx: CodegenContext, sourceFile: ts.SourceFile): boolean {
  let found = false;
  let needsHost = false;

  function visit(node: ts.Node): void {
    if (needsHost) return;
    if (ts.isFunctionDeclaration(node) && node.asteriskToken && node.body) {
      found = true;
      // A non-native-candidate generator needs the host imports; so does a
      // nested generator that captures an outer-scope binding (#2203) — it
      // cannot use the native factory (no capture slot in the state struct) and
      // falls to the eager-buffer host path, which would otherwise bake an
      // undefined funcidx in a no-JS-host target.
      if (!isNativeGeneratorCandidate(ctx, node) || generatorCapturesOuterScope(ctx, node)) needsHost = true;
      return;
    }
    if (ts.isFunctionExpression(node) && node.asteriskToken) {
      found = true;
      // (#3164) A generator FUNCTION EXPRESSION no longer forces the host
      // imports when the extended candidate gate admits it (zero/identifier
      // params, no `this`/`arguments`/self-name/capture — the fn-expr arm of
      // `isNativeGeneratorCandidate`); the closures.ts emit site routes it
      // through the native state-struct factory. Any bail (including async —
      // the modifiers check inside the candidate) keeps the imports
      // registered, exactly like the declaration/method branches.
      if (!node.body || !isNativeGeneratorCandidate(ctx, node)) needsHost = true;
      return;
    }
    if (ts.isMethodDeclaration(node) && node.asteriskToken && node.body) {
      found = true;
      // (#2571) A class / object-literal generator METHOD that the native path
      // can lower (instance/static, identifier params, no capture / arguments /
      // super) no longer forces the host imports — same logic as the
      // FunctionDeclaration branch above, generalized to methods. A
      // non-candidate or capturing method generator still needs the host buffer.
      if (!isNativeGeneratorCandidate(ctx, node) || generatorCapturesOuterScope(ctx, node)) needsHost = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return found && needsHost;
}

/**
 * Result struct (`{ value, done }`) for a generator whose yields have the given
 * `elemValType`. The numeric (f64) variant is cached on
 * `ctx.nativeGeneratorResultTypeIdx` (the historical singleton, kept so the many
 * f64 callers are unchanged); any other elem type (e.g. the native string ref,
 * #2171) gets its own `__NativeGeneratorResult_<kind>` struct, cached in
 * `structMap` by name. Defaults to f64 when no elem type is supplied.
 */
export function ensureNativeGeneratorResultType(ctx: CodegenContext, elemValType?: ValType): number {
  const elem: ValType = elemValType ?? { kind: "f64" };
  const isF64 = elem.kind === "f64";
  if (isF64 && ctx.nativeGeneratorResultTypeIdx >= 0) return ctx.nativeGeneratorResultTypeIdx;

  const kindTag =
    elem.kind === "ref" || elem.kind === "ref_null" ? `ref${(elem as { typeIdx: number }).typeIdx}` : elem.kind;
  const structName = `__NativeGeneratorResult_${kindTag}`;
  const existing = ctx.structMap.get(structName);
  if (existing !== undefined) {
    if (isF64) ctx.nativeGeneratorResultTypeIdx = existing;
    return existing;
  }

  const fields: FieldDef[] = [
    { name: "value", type: elem, mutable: false },
    // (#3050) `done` is BRANDED boolean so any boxing to externref (the dynamic
    // any-receiver `.done` read in the JS-host lane, `result.done` flowing into
    // an `any` context) routes through `__box_boolean`, not `__box_number` —
    // `result.done === true` must hold (a number-boxed 1 !== true, which failed
    // the GeneratorPrototype/throw follow-up-`next()` asserts). Wasm-level the
    // field is a plain i32 (brands are erased at emission).
    { name: "done", type: { kind: "i32", boolean: true }, mutable: false },
  ];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: structName, fields });
  ctx.structMap.set(structName, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, structName);
  ctx.structFields.set(structName, fields);
  if (isF64) ctx.nativeGeneratorResultTypeIdx = typeIdx;
  return typeIdx;
}

/**
 * (#3050) One leading synthetic capture param of a capturing nested native
 * generator. The caller (nested-declarations.ts) prepends these before the
 * user params — mutable captures ride as `ref $cell` (writes propagate to the
 * enclosing frame through the shared cell), immutable ones by value. `boxed`
 * carries the cell layout so the resume function registers the name in
 * `boxedCaptures` (identifier reads/writes deref the cell, exactly like a
 * lifted closure body).
 */
export interface NativeGeneratorCaptureParam {
  name: string;
  boxed?: { refCellTypeIdx: number; valType: ValType };
  /**
   * (#3032 W3) This synthetic leading param is a TDZ-flag BOX
   * (`ref $cell<i32>`, param name `__tdz_box_<orig>`) for the TDZ-flagged
   * capture named here — NOT a value capture. `boxed` must stay unset (the
   * flag box must not enter the resume fctx's `boxedCaptures`); the resume
   * function instead registers it in `boxedTdzFlags`/`tdzFlagLocals` under
   * this original name so `emitLocalTdzCheck` reads the shared i32 cell.
   */
  tdzFlagFor?: string;
}

export function registerNativeGenerator(
  ctx: CodegenContext,
  decl: GeneratorDecl,
  functionName: string,
  paramTypes: ValType[],
  // (#2571) When `decl` is a non-static instance generator METHOD, the caller
  // passes `paramTypes = [receiverType, ...userParamTypes]` and sets this flag.
  // We then prepend a `"this"` entry to `paramNames` so the state struct mints a
  // `param_this` field (rehydrated as a `this` local in the resume function) and
  // the param/name arrays stay aligned. Free functions / static methods leave
  // this `false` — byte-identical to pre-#2571.
  synthesizedThis = false,
  // (#3050) Capturing nested generator: the caller passes
  // `paramTypes = [...captureParamTypes, ...userParamTypes]` plus this aligned
  // capture list. Mutually exclusive with `synthesizedThis` (methods never take
  // the capturing path).
  leadingCaptures?: NativeGeneratorCaptureParam[],
): NativeGeneratorInfo | null {
  const existing = ctx.nativeGenerators.get(functionName);
  // Idempotent re-registration (shadow-aliased entries included) returns the
  // decl's own info rather than minting a duplicate state machine.
  const own = nativeGeneratorInfoForDecl(ctx, functionName, decl);
  if (own) return own;
  // (#3505) Same source name, DIFFERENT declaration - two module files in one
  // compileMulti graph (or two scopes) each declare `function* g`. The registry
  // is name-keyed, so returning `existing` here aliased every later declaration
  // to the FIRST-registered body: test262 instn-uniq-env-rec's entry generator
  // resumed the fixture's empty body and yielded the absent-value sentinel
  // (NaN) instead of its own return value. Register the new declaration under a
  // unique INTERNAL name (state struct + resume fn derive from it) and let the
  // bare key point at the LATEST declaration - the same last-wins order
  // `ctx.funcMap` already gives colliding plain function declarations. The
  // shadowed info is re-keyed under a space-separated alias (no source
  // identifier contains a space) so the dispatch-table walkers that iterate
  // `ctx.nativeGenerators.values()` still see every registered generator; the
  // re-key happens at the final `set` below so a candidate/plan bail leaves
  // the registry untouched.
  let internalName = functionName;
  let shadowAliasKey: string | undefined;
  if (existing) {
    let shadowIdx = 0;
    while (ctx.nativeGenerators.has(`${functionName} shadowed${shadowIdx}`)) shadowIdx++;
    shadowAliasKey = `${functionName} shadowed${shadowIdx}`;
    internalName = `${functionName}__redecl${shadowIdx + 1}`;
  }
  if (!isNativeGeneratorCandidate(ctx, decl)) return null;

  const plan = buildNativeGeneratorPlan(ctx, decl);
  if (!plan) return null;

  const elemValType = plan.elemValType;
  // (#2864 F1b) Spilled locals are now typed at their actual ValType
  // (`plan.spillTypes`), so the historical string/any guards that bailed any
  // generator with a live-across-yield non-numeric local are retired — the plan
  // builder already returned null for any spill whose type it could not resolve.

  const resultTypeIdx = ensureNativeGeneratorResultType(ctx, elemValType);
  // (#2571) The synthetic `this` (when present) is the FIRST param name, aligned
  // with the caller's `paramTypes[0] === receiverType`. User params follow.
  // (#2920) A binding-pattern param has no source identifier; mint a unique
  // synthetic name (`__genarg{i}`) so its `param_*` state field is distinct
  // (two `[a,b]`/`{x}` params would otherwise both be `param_`, a dup field).
  // The raw arg lives in this field and is destructured in the resume prelude.
  const userParamNames = decl.parameters.map((p, i) => (ts.isIdentifier(p.name) ? p.name.text : `__genarg${i}`));
  // (#3050) Leading synthetic capture params (capturing nested generator)
  // precede the user params, aligned with the caller's paramTypes prefix.
  const captureNames = (leadingCaptures ?? []).map((c) => c.name);
  const paramNames = synthesizedThis ? ["this", ...userParamNames] : [...captureNames, ...userParamNames];
  // (#2864 F1) `sent` / `abrupt` carry the `.next(v)` / `.return(v)` value. For
  // the boxed-any carrier they are externref so an arbitrary value survives; for
  // numeric / string carriers they stay f64 (byte-identical to before).
  const carrierFieldType = genCarrierFieldType(elemValType);
  const stateFields: FieldDef[] = [
    { name: "state", type: { kind: "i32" }, mutable: true },
    { name: "sent", type: carrierFieldType, mutable: true },
    { name: "mode", type: { kind: "i32" }, mutable: true },
    { name: "abrupt", type: carrierFieldType, mutable: true },
    // (#2864 F2) `gen.throw(e)` payload — externref regardless of carrier.
    { name: "error", type: { kind: "externref" }, mutable: true },
  ];
  // (#3620) A BINDING-PATTERN parameter's state field must be typed at the
  // value's actual wasm-boundary representation (`externref`), NOT at the TS
  // type the checker infers for the pattern.
  //
  // Why: for `*m([x] = [1])` the checker infers the parameter as the TUPLE
  // `[number]`, so `resolveWasmType` mints a `$__tuple_N` struct and the caller
  // passed one — until the parameter gained a DEFAULT. A defaulted parameter is
  // widened to `externref` at the wasm boundary (the callee must be able to see
  // "argument absent"), which removes the call site's tuple conversion, and the
  // in-callee default materialization emits the array literal in its natural
  // `$__vec_f64` shape. The state field still claimed `$__tuple_N`, so the
  // factory's param→field coercion emitted an unconditional
  // `ref.cast (ref null $__tuple_N)` over a value that is now never a tuple —
  // an UNCATCHABLE `illegal cast` that aborted the module.
  //
  // This is the same defect shape as #3610: a `ref.cast` justified by a static
  // type that no longer describes the runtime value. The fix is the same in
  // spirit — do not assert what is not guaranteed. The resume prelude's
  // destructuring reader already dispatches dynamically over
  // tuple-struct / vec / generic-iterable receivers (`ref.test` cascade), so an
  // `externref` field is exactly what it is built to consume.
  //
  // Keyed off the synthetic `__genarg{i}` name minted above for binding-pattern
  // params (#2920) — the one place that already distinguishes them, so the
  // name/type arrays cannot drift apart.
  const stateParamTypes = paramTypes.map((t, i) =>
    (paramNames[i] ?? "").startsWith("__genarg") ? ({ kind: "externref" } as ValType) : t,
  );
  for (let i = 0; i < stateParamTypes.length; i++) {
    stateFields.push({
      name: `param_${paramNames[i] ?? i}`,
      type: stateParamTypes[i]!,
      mutable: false,
    });
  }
  const spillFieldOffset = PARAM_FIELD_OFFSET + paramTypes.length;
  // Params that are also reassigned in the body need a mutable spill slot too;
  // but params already live in the struct. Spills cover body-declared locals.
  const paramNameSet = new Set(paramNames);
  const bodySpills = plan.spills.filter((s) => !paramNameSet.has(s));
  // (#2864 F1b) Spill field at the local's actual ValType (object → ref_null
  // struct, string → native-string ref, number → f64), aligned 1:1 with
  // `bodySpills` so the resume-load local, store/load, and struct-init default
  // all agree. `plan.spillTypes` is guaranteed to hold an entry for each spill.
  const spillTypes: ValType[] = bodySpills.map((s) => plan.spillTypes.get(s) ?? { kind: "f64" });
  for (let i = 0; i < bodySpills.length; i++) {
    stateFields.push({
      name: `spill_${bodySpills[i]}`,
      type: spillTypes[i]!,
      mutable: true,
    });
  }

  // (#2170) `yield*` delegation slots — appended AFTER spills so the f64
  // spillFieldOffset indexing is unaffected. Each holds the inner generator's
  // state ref across the outer generator's host re-entries. The inner is a
  // native generator (the candidate check confirmed it); register it first so
  // its state struct typeIdx exists, then type the slot as `ref null
  // $InnerState`.
  const delegationSlots: { fieldIdx: number; innerName: string }[] = [];
  for (const site of plan.delegationSites) {
    const innerInfo = ensureRegisteredNativeGenerator(ctx, site.innerName);
    // Fall back to a nullable eqref slot if the inner cannot be resolved to a
    // concrete state type (defensive — the candidate gate makes this unlikely).
    const slotType: ValType =
      innerInfo !== null ? { kind: "ref_null", typeIdx: innerInfo.stateTypeIdx } : { kind: "eqref" };
    delegationSlots.push({ fieldIdx: stateFields.length, innerName: site.innerName });
    stateFields.push({ name: `deleg_${delegationSlots.length - 1}`, type: slotType, mutable: true });
  }

  // (#2173 slice-2a) `yield* <numeric-array/vec>` slots — appended AFTER the
  // native-gen delegation slots (and after spills) so neither the f64
  // `spillFieldOffset` nor the native-gen slot field indices are affected;
  // byte-inert for generators without a vec-delegation site. Each site gets TWO
  // fields: `ref null $Vec` (materialized iterable) + `i32` cursor. The vec type
  // is resolved once here from the subject's static type and stored on the info,
  // so the emit-time cursor drive and this field layout use the SAME typeIdx.
  const vecDelegationSlots: NonNullable<NativeGeneratorInfo["vecDelegationSlots"]> = [];
  for (const _site of plan.vecDelegationSites) {
    // The gate (`isNumericIterableDelegate`) has already established the subject
    // is a `number[]`, which lowers to the canonical f64 vec. Resolve that vec
    // type directly (registry call, no checker) so the field layout and the
    // emit-time cursor drive use the SAME typeIdx as `compileExpression(subject)`
    // produces (both go through `getOrRegisterVecType(ctx, "f64")`).
    const vecTypeIdx = getOrRegisterVecType(ctx, "f64");
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const vecFieldIdx = stateFields.length;
    stateFields.push({
      name: `vecdeleg_${vecDelegationSlots.length}`,
      type: { kind: "ref_null", typeIdx: vecTypeIdx },
      mutable: true,
    });
    const cursorFieldIdx = stateFields.length;
    stateFields.push({ name: `veccur_${vecDelegationSlots.length}`, type: { kind: "i32" }, mutable: true });
    vecDelegationSlots.push({
      vecFieldIdx,
      cursorFieldIdx,
      vecTypeIdx,
      arrTypeIdx,
      elemType: { kind: "f64" },
    });
  }

  // (#2173 slice-2b) `yield* <generic iterable>` slots — appended AFTER the
  // native-gen and vec delegation slots (and after spills) so no earlier field
  // index or the f64 `spillFieldOffset` is affected; byte-inert for generators
  // without a generic-iterable site. Each site gets ONE `externref` field
  // holding the `$__IterRec` returned by the native `__iterator` runtime.
  const iterableDelegationSlots: NonNullable<NativeGeneratorInfo["iterableDelegationSlots"]> = [];
  for (const _site of plan.iterableDelegationSites) {
    iterableDelegationSlots.push({ fieldIdx: stateFields.length });
    stateFields.push({
      name: `iterdeleg_${iterableDelegationSlots.length - 1}`,
      type: { kind: "externref" },
      mutable: true,
    });
  }

  // (#3050) Pending completion kind for state-lowered finally regions —
  // appended LAST so every existing field index is unaffected; byte-inert for
  // generators without a yielding finally. Payloads reuse `abrupt` / `error`.
  let pendingFieldIdx: number | undefined;
  if (plan.needsPending) {
    pendingFieldIdx = stateFields.length;
    stateFields.push({ name: "pending", type: { kind: "i32" }, mutable: true });
  }

  // (#3032 W6) NOMINAL BRAND for the state struct. Two generators with the
  // same shape (e.g. `function* g1() { yield; }` and `function* g2() {
  // yield 1; }`) mint structurally IDENTICAL state structs, which WasmGC
  // iso-recursive canonicalization merges — `ref.test $__GenState_g1` then
  // MATCHES a g2 instance, and every state-type dispatch chain
  // (buildNativeGeneratorDispatch, the iterator-carrier GENSTATE step) resumes
  // the FIRST-registered generator's resume fn on the other's state
  // (`iter = g2(); iter.next().value` returned g1's `undefined` —
  // generators/yield-as-statement.js, BOTH lanes). Defeat canonicalization
  // structurally: each state struct declares a DISTINCT empty supertype from a
  // per-module brand CHAIN (`__GenBrand_0` open no-parent, `__GenBrand_n` sub
  // of `__GenBrand_{n-1}` — each distinct by ancestry depth). Type-level only:
  // no field/layout/operand changes, and every `ref.test`/`ref.cast` site
  // becomes nominally precise for free.
  // (#3505) `nativeGenerators.size` stalls when a redeclared name overwrites
  // its bare key (alias + overwrite net one entry per TWO registrations), so
  // suffix with the always-unique type index when the size-derived name is
  // already taken. Non-colliding modules keep the historical names.
  let brandName = `__GenBrand_${ctx.nativeGenerators.size}`;
  const brandTypeIdx = ctx.mod.types.length;
  if (ctx.structMap.has(brandName)) brandName = `__GenBrand_${ctx.nativeGenerators.size}_${brandTypeIdx}`;
  ctx.mod.types.push({
    kind: "struct",
    name: brandName,
    fields: [],
    superTypeIdx: ctx.genStateBrandTipIdx ?? -1, // -1 = open, no parent (the __vec_base convention)
  });
  ctx.structMap.set(brandName, brandTypeIdx);
  ctx.typeIdxToStructName.set(brandTypeIdx, brandName);
  ctx.genStateBrandTipIdx = brandTypeIdx;

  const stateName = `__GenState_${sanitizeTypeName(internalName)}`;
  const stateTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: stateName,
    fields: stateFields,
    superTypeIdx: brandTypeIdx,
    final: true,
  });
  ctx.structMap.set(stateName, stateTypeIdx);
  ctx.typeIdxToStructName.set(stateTypeIdx, stateName);
  ctx.structFields.set(stateName, stateFields);

  const yieldCount = plan.states.filter((s) => s.terminator.kind === "yield").length;
  const info: NativeGeneratorInfo = {
    functionName: internalName,
    decl,
    synthesizedThis,
    stateTypeIdx,
    resultTypeIdx,
    paramNames,
    // (#3620) The STATE-FIELD types, not the caller's declared param types —
    // the resume prelude allocates its `param_*` locals from this array and
    // must agree with the field it `struct.get`s. Identical to `paramTypes`
    // except for binding-pattern params (widened to `externref` above).
    paramTypes: stateParamTypes,
    paramFieldOffset: PARAM_FIELD_OFFSET,
    sentFieldIdx: SENT_FIELD,
    modeFieldIdx: MODE_FIELD,
    abruptFieldIdx: ABRUPT_FIELD,
    spillNames: bodySpills,
    spillTypes,
    spillFieldOffset,
    // (#3386) Pattern-param binding names (values packed from the emit site's
    // eagerly-destructured factory locals at struct.new) + the undef-widened
    // subset (marked `undefWidenedLocals` in the resume fctx).
    patternParamBindings: plan.patternParamBindings.size > 0 ? plan.patternParamBindings : undefined,
    undefWidenedPatternBindings:
      plan.undefWidenedPatternBindings.size > 0 ? plan.undefWidenedPatternBindings : undefined,
    yieldCount,
    // (#2864 D4) The state that COMPLETES the generator, taken from the plan —
    // NOT `states.length - 1`, which aliases onto a live yield successor for any
    // body ending in a loop / if / try-region (see `NativeGeneratorPlan.doneState`).
    doneState: plan.doneState,
    elemValType,
    delegationSlots: delegationSlots.length > 0 ? delegationSlots : undefined,
    vecDelegationSlots: vecDelegationSlots.length > 0 ? vecDelegationSlots : undefined,
    iterableDelegationSlots: iterableDelegationSlots.length > 0 ? iterableDelegationSlots : undefined,
    pendingFieldIdx,
    // (#3050) Capturing nested generator: leading capture-param count (for the
    // resume prelude's user-param offset) + the cell layouts to register in the
    // resume fctx's boxedCaptures.
    leadingCaptureCount: leadingCaptures && leadingCaptures.length > 0 ? leadingCaptures.length : undefined,
    leadingCaptureCells: leadingCaptures
      ?.filter((c) => c.boxed)
      .map((c) => ({ name: c.name, refCellTypeIdx: c.boxed!.refCellTypeIdx, valType: c.boxed!.valType })),
    // (#3032 W3) TDZ-flag box params (entries marked `tdzFlagFor`): record the
    // ORIGINAL captured name + the param index of its flag box so the resume
    // function can register `boxedTdzFlags`/`tdzFlagLocals`. The paramIdx is
    // the leadingCaptures position — value captures and flag boxes together
    // form the paramNames/paramTypes prefix, in caller order.
    leadingTdzFlags: (() => {
      const flags = (leadingCaptures ?? []).flatMap((c, i) =>
        c.tdzFlagFor ? [{ name: c.tdzFlagFor, paramIdx: i }] : [],
      );
      return flags.length > 0 ? flags : undefined;
    })(),
  };
  if (shadowAliasKey !== undefined && existing) ctx.nativeGenerators.set(shadowAliasKey, existing);
  ctx.nativeGenerators.set(functionName, info);
  return info;
}

/**
 * (#2170) Resolve a native-generator info by source name (already-registered
 * lookup). The inner of a `yield*` is usually declared before the outer (source
 * order) and already in `ctx.nativeGenerators`. Returns null if not registered.
 */
/**
 * (#3505) Resolve the native-generator info registered for EXACTLY this
 * declaration. The registry's bare key is name-keyed and last-wins under
 * same-name redeclarations (two module files each declaring `function* g`),
 * so a name hit is verified against the decl and shadow-aliased entries are
 * scanned before concluding this decl has no native registration.
 */
export function nativeGeneratorInfoForDecl(
  ctx: CodegenContext,
  name: string,
  decl: ts.Node,
): NativeGeneratorInfo | undefined {
  const byName = ctx.nativeGenerators.get(name);
  if (byName && byName.decl === decl) return byName;
  // Scan ONLY this name's shadow aliases — never other names' entries: one
  // declaration may legitimately register under several names (e.g. a class
  // method under its classMemberFuncKey and again under a different key from
  // another emit site), and answering with a different-name info here would
  // hand the caller a state machine whose funcMap/resume wiring belongs to
  // the other name (measured: 617 class gen-method standalone tests broke on
  // exactly that in the first cut of this fix).
  for (let shadowIdx = 0; ; shadowIdx++) {
    const alias = ctx.nativeGenerators.get(`${name} shadowed${shadowIdx}`);
    if (!alias) return undefined;
    if (alias.decl === decl) return alias;
  }
}

function ensureRegisteredNativeGenerator(ctx: CodegenContext, name: string): NativeGeneratorInfo | null {
  const existing = ctx.nativeGenerators.get(name);
  if (existing) return existing;
  return null;
}

// (#2171/#2979) The default `value` for a done/empty result. The old comment
// claimed "the consumer never reads value when done=1" — FALSE: JS reads
// `.value` off a done result routinely, and it must be `undefined`
// (`g.next().value` after exhaustion — test262 `generators/{no-yield,return}.js`).
// So the default must be a *distinguishable absent marker*, not a value-space
// collision:
//   - f64 carrier: the UNDEF_F64 sentinel (value-tags.ts) — a signaling-NaN
//     bit pattern JS arithmetic never produces. Numerically it already behaves
//     as NaN (ToNumber(undefined) === NaN, so typed f64 reads become
//     spec-correct: the old `f64 0` default made an exhausted `.value` read
//     indistinguishable from a genuine yielded/returned 0). The dynamic
//     `.value` reader canonicalizes the sentinel to the null externref — the
//     standalone canonical `undefined` (`__extern_is_undefined` is
//     `ref.is_null`, object-runtime.ts).
//   - externref carrier: null externref (already the canonical undefined).
//   - ref carrier (native string): null ref — `extern.convert_any(null)` is
//     the null externref, canonical again.
//   - i32 carrier: no sentinel space in i32; keep 0.
function defaultElemValueInstrs(ctx: CodegenContext, elemValType: ValType): Instr[] {
  if (elemValType.kind === "f64") {
    return [{ op: "i64.const", value: UNDEF_F64_BITS }, { op: "f64.reinterpret_i64" }];
  }
  if (elemValType.kind === "i32") return [{ op: "i32.const", value: 0 }];
  // (#2864 wave-2 S1) The boxed-any carrier's absent value is `undefined`, and
  // the null externref is NOT that. The F1 note above ("already the canonical
  // undefined") was inherited from the pre-#2106 model where standalone could
  // not tell the two apart; that stopped being true once the tag-1 `$undefined`
  // singleton was reserved in every standalone module. Measured host-free on
  // `language/expressions/yield/formal-parameters.js`: the terminal
  // `{value, done:true}` of an any-carrier generator read back as JS **null**
  // (`result.value === null` true, `typeof` "object"), and the harness reported
  // `SameValue(«null», «undefined»)`. Emit the lane's canonical `undefined`.
  if (elemValType.kind === "externref") return canonicalUndefinedExternInstrs(ctx);
  return [{ op: "ref.null", typeIdx: (elemValType as { typeIdx: number }).typeIdx }];
}

function emptyResult(ctx: CodegenContext, info: NativeGeneratorInfo): Instr[] {
  return [
    ...defaultElemValueInstrs(ctx, info.elemValType),
    { op: "i32.const", value: 1 },
    { op: "struct.new", typeIdx: info.resultTypeIdx },
  ];
}

export function emptyResultForType(ctx: CodegenContext, resultTypeIdx: number): Instr[] {
  return [
    ...defaultElemValueInstrs(ctx, { kind: "f64" }),
    { op: "i32.const", value: 1 },
    { op: "struct.new", typeIdx: resultTypeIdx },
  ];
}

export function nativeReturnResultFromLocal(info: NativeGeneratorInfo, valueLocal: number): Instr[] {
  return [
    { op: "local.get", index: valueLocal },
    { op: "i32.const", value: 1 },
    { op: "struct.new", typeIdx: info.resultTypeIdx },
  ];
}

export function emitExpressionAsF64(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
): number {
  if (!expr) {
    const tmp = allocLocal(fctx, `__gen_value_${fctx.locals.length}`, { kind: "f64" });
    // (#2979) A missing expression is JS `undefined` (bare `return;`,
    // `.next()` / `.return()` with no argument). Use the UNDEF_F64 sentinel —
    // numerically identical to the old quiet NaN (still a NaN), but
    // distinguishable by sentinel-aware readers so `gen.return().value` /
    // bare-`return` results canonicalize to `undefined` instead of NaN.
    fctx.body.push(...defaultElemValueInstrs(ctx, { kind: "f64" }));
    fctx.body.push({ op: "local.set", index: tmp });
    return tmp;
  }

  const resultType = compileExpression(ctx, fctx, expr, { kind: "f64" });
  if (resultType === null) {
    fctx.body.push({ op: "f64.const", value: NaN });
  } else if (resultType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (!valTypesMatch(resultType, { kind: "f64" })) {
    coerceType(ctx, fctx, resultType, { kind: "f64" });
  }
  const tmp = allocLocal(fctx, `__gen_value_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: tmp });
  return tmp;
}

/**
 * (#2864 F1) Compile a `.next(v)` / `.return(v)` argument to the generator's
 * carrier field type and return a local holding it. For numeric / string
 * carriers this is exactly `emitExpressionAsF64` (the f64 `sent`/`abrupt` field,
 * byte-identical to before). For the boxed-any carrier the value is compiled to
 * externref (host-free boxing in standalone/WASI), so an arbitrary `.next(v)`
 * survives into the resume function. A missing arg yields the carrier default
 * (`NaN` for f64, null externref for the boxed-any carrier).
 */
export function emitCarrierValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
  info: NativeGeneratorInfo,
): number {
  if (!carrierIsAny(info.elemValType)) return emitExpressionAsF64(ctx, fctx, expr);
  const carrier: ValType = { kind: "externref" };
  const tmp = allocLocal(fctx, `__gen_carrier_${fctx.locals.length}`, carrier);
  if (!expr) {
    fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "local.set", index: tmp });
    return tmp;
  }
  const t = compileExpression(ctx, fctx, expr, carrier);
  if (t === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (!valTypesMatch(t, carrier)) {
    coerceType(ctx, fctx, t, carrier);
  }
  fctx.body.push({ op: "local.set", index: tmp });
  return tmp;
}

/**
 * (#2864 F1) Compile a `.next(v)` / `.return(v)` argument to externref (the
 * boxed-`any` representation) for the open dispatch, returning a local holding
 * it. A missing argument is a null externref. Used only when the dispatch chain
 * includes an any-carrier generator.
 */
export function emitOpenAnyArgValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
): number {
  const carrier: ValType = { kind: "externref" };
  const tmp = allocLocal(fctx, `__gen_any_arg_${fctx.locals.length}`, carrier);
  if (!expr) {
    fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "local.set", index: tmp });
    return tmp;
  }
  const t = compileExpression(ctx, fctx, expr, carrier);
  if (t === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (!valTypesMatch(t, carrier)) {
    coerceType(ctx, fctx, t, carrier);
  }
  fctx.body.push({ op: "local.set", index: tmp });
  return tmp;
}

/**
 * (#2171) Compile a yield/return value to the generator's element ValType and
 * return a local holding it. For numeric generators this is exactly
 * `emitExpressionAsF64` (unchanged path). For a string generator it compiles the
 * expression to the native string ref and stores it; a missing expr (bare
 * `return;`) yields the elem-type default (null ref).
 */
function emitYieldValueAsElem(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
  info: NativeGeneratorInfo,
): number {
  if (info.elemValType.kind === "f64") return emitExpressionAsF64(ctx, fctx, expr);
  const elem = info.elemValType;
  const tmp = allocLocal(fctx, `__gen_value_${fctx.locals.length}`, elem);
  if (!expr) {
    fctx.body.push(...defaultElemValueInstrs(ctx, elem));
    fctx.body.push({ op: "local.set", index: tmp });
    return tmp;
  }
  const t = compileExpression(ctx, fctx, expr, elem);
  if (t === null) {
    fctx.body.push(...defaultElemValueInstrs(ctx, elem));
  } else if (!valTypesMatch(t, elem)) {
    coerceType(ctx, fctx, t, elem);
  }
  fctx.body.push({ op: "local.set", index: tmp });
  return tmp;
}

/**
 * Compile a numeric condition to an i32 truthiness on the stack. Booleans are
 * already i32; numbers compile to f64, so reduce with `f64.ne 0` (NaN → 0,
 * matching JS ToBoolean for numbers).
 */
function emitConditionAsI32(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): void {
  const t = compileExpression(ctx, fctx, expr);
  if (t === null) {
    fctx.body.push({ op: "i32.const", value: 0 });
    return;
  }
  if (t.kind === "i32") return;
  if (t.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.ne" });
    return;
  }
  // Fallback: coerce to f64 then truthiness.
  coerceType(ctx, fctx, t, { kind: "f64" });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.ne" });
}

/**
 * Emit the trampoline resume body into `fctx.body`. `selfLocal` is the state
 * struct ref. The shape is:
 *
 *   block $exit (result <empty, $__result holds the value>)
 *     loop $dispatch
 *       if (state==0) { …state 0… }
 *       else if (state==1) { …state 1… }
 *       …
 *       else { done }
 *     end
 *   end
 *   local.get $__result
 *
 * Each state's terminator emits:
 *   - yield/return  → set $__result, `br $exit`
 *   - jump/branch   → set state, `br $dispatch`
 *   - done          → set $__result (=undefined,done:1); fall out of loop
 */
function emitTrampoline(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NativeGeneratorInfo,
  plan: NativeGeneratorPlan,
  selfLocal: number,
  resultLocal: number,
  // (#3050) Host-mode foreign-exception recovery import for throw-route wraps.
  getCaughtExnIdx?: number,
): Instr[] {
  const states = plan.states;

  // Recursively build the nested-if chain. `level` is the recursion depth
  // (0-based) — used to compute branch depths: from inside the arm at `level`,
  // the enclosing `loop` is at depth `level+1` and the wrapping `block` at
  // `level+2`.
  function buildArm(stateId: number, level: number): Instr[] {
    if (stateId >= states.length) {
      // Past the last state: complete (defensive; should be the `done` state).
      return [
        ...setStateInstrs(info, selfLocal, info.doneState),
        ...emptyResult(ctx, info),
        { op: "local.set", index: resultLocal },
      ];
    }
    const loopDepth = level + 1; // br to re-enter dispatch
    const exitDepth = level + 2; // br to leave block (return to caller)

    const thenBody = compileState(
      ctx,
      fctx,
      info,
      states[stateId]!,
      stateId,
      loopDepth,
      exitDepth,
      selfLocal,
      resultLocal,
      getCaughtExnIdx,
    );
    const elseBody = buildArm(stateId + 1, level + 1);
    return [
      { op: "local.get", index: selfLocal },
      { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
      { op: "i32.const", value: stateId },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: thenBody,
        else: elseBody,
      },
    ];
  }

  const chain = buildArm(0, 0);

  return [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: chain,
        },
      ],
    },
    { op: "local.get", index: resultLocal },
  ];
}

/**
 * Compile one state's prelude + terminator into an Instr[] for its dispatch
 * arm. Branch depths are passed in (the arm sits `level` ifs deep inside the
 * trampoline loop).
 */
function compileState(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NativeGeneratorInfo,
  state: NativeGeneratorState,
  stateId: number,
  loopDepth: number,
  exitDepth: number,
  selfLocal: number,
  resultLocal: number,
  // (#3050) Host-mode foreign-exception recovery import for throw-route wraps,
  // acquired up-front by the resume emitter (never mid-trampoline).
  getCaughtExnIdx?: number,
): Instr[] {
  const saved = fctx.body;
  const body: Instr[] = [];
  fctx.body = body;
  // (#2182) `saved` is detached for the whole resume-state build, which runs
  // `compileStatement` / `emitYieldValueAsElem` — both can trigger a late
  // import. The shifter walks `fctx.body` (= body) but not this raw local, so
  // register `saved` in liveBodies for the swap's lifetime; otherwise a late
  // import would over-shift any `call` funcIdx already in the outer body.
  ctx.liveBodies.add(saved);

  // (#3050) A state positionally inside a NEW try-region gets its whole arm
  // wrapped in a wasm `try`/`catch $exc` (see the tail of this function) so a
  // runtime exception routes to the region's catch/finally. The wrap adds one
  // block level — every branch depth inside the arm shifts by one.
  if (state.throwRoute) {
    loopDepth += 1;
    exitDepth += 1;
  }

  // Abrupt-resume handling: if we resumed into this state in an abrupt mode
  // (mode != 0), run the enclosing finalizers, then either complete with the
  // `.return(v)` value (mode 1) or RE-THROW the `.throw(e)` error (mode 2, #2864
  // F2). Both share the finalizer run + spill store + done transition; they
  // diverge only at the tail. The finalizers are compiled ONCE into `abruptBody`,
  // which the outer `if (mode != 0)` guards.
  //
  // (#3050) States under a NEW try-region carry `unwind` instead: the abrupt
  // completion walks the innermost-first unwind chain — into an enclosing catch
  // (throw only), into a state-lowered finally (both, saved as pending), through
  // legacy replay finalizers — and only completes/re-throws when no handler
  // remains. Legacy states keep the byte-identical `abruptResume` emission.
  if (state.unwind) {
    const abruptBody: Instr[] = [];
    const savedAbrupt = fctx.body;
    fctx.body = abruptBody;
    emitUnwindWalk(ctx, fctx, info, state.unwind, {
      selfLocal,
      resultLocal,
      srcFieldIdx: info.modeFieldIdx,
      loopDepth: loopDepth + 1, // inside the `if (mode != 0)`
      exitDepth: exitDepth + 1,
    });
    fctx.body = savedAbrupt;

    body.push({ op: "local.get", index: selfLocal });
    body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx });
    body.push({ op: "i32.const", value: MODE_NEXT });
    body.push({ op: "i32.ne" });
    body.push({ op: "if", blockType: { kind: "empty" }, then: abruptBody, else: [] });
  } else if (state.abruptResume) {
    const abruptBody: Instr[] = [];
    const savedAbrupt = fctx.body;
    fctx.body = abruptBody;
    // (#2864 D2) Delegation abrupt forwarding — iterator close through `yield*`
    // (§27.5.3.7 steps 7.b/7.c). A `.return(v)` / `.throw(e)` on the OUTER while
    // suspended in a native-gen yield-star state must forward the abrupt to the
    // INNER first (drive its resume once with the SAME mode + payloads) so the
    // inner's `finally` blocks run, then continue the outer's own abrupt path
    // (its finalizers + completion) exactly as before. Gated on the state's
    // terminator being a native-gen delegation AND the slot being non-null
    // (mid-delegation) — byte-inert for non-delegating generators, and inert at
    // runtime for an abrupt resume at the plain-yield suspension that precedes
    // the delegation (slot still null). A mode-2 inner re-throws after its
    // finalizers (F2), and a `finally` that itself throws surfaces a NEW error —
    // both are caught here, stored as the outer's error, and upgrade the outer
    // to the throw path (a return completion whose close throws becomes a throw
    // completion, per spec).
    if (state.terminator.kind === "yield-star" && state.terminator.delegationKind === "native-gen") {
      const closeSlot = info.delegationSlots?.[state.terminator.siteIndex];
      const closeInner = closeSlot ? ctx.nativeGenerators.get(closeSlot.innerName) : undefined;
      if (closeSlot && closeInner) {
        const closeResumeIdx = ensureNativeGeneratorResumeFunction(ctx, closeInner);
        const closeDelegLocal = allocLocal(fctx, `__gen_close_deleg_${fctx.locals.length}`, {
          kind: "ref",
          typeIdx: closeInner.stateTypeIdx,
        });
        const closeErrLocal = allocLocal(fctx, `__gen_close_err_${fctx.locals.length}`, { kind: "externref" });
        // The inner is f64-gated (delegation admission), so its `abrupt` field is
        // f64: copy the outer's `.return(v)` value when the outer's carrier is
        // also f64; a boxed-any outer's externref abrupt has no unbox seam here —
        // deliver undefined (the value is unobservable: the inner result is
        // discarded and the outer completes with its OWN abrupt field).
        const closeAbruptPayload: Instr[] =
          genCarrierFieldType(info.elemValType).kind === "f64"
            ? [
                { op: "local.get", index: selfLocal },
                { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.abruptFieldIdx },
              ]
            : [{ op: "f64.const", value: NaN }];
        const closeCatch: Instr[] = [
          { op: "local.set", index: closeErrLocal },
          { op: "local.get", index: selfLocal },
          { op: "local.get", index: closeErrLocal },
          { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD },
          ...setModeInstrs(info, selfLocal, MODE_THROW),
        ];
        abruptBody.push(
          { op: "local.get", index: selfLocal },
          { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: closeSlot.fieldIdx },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: selfLocal },
              { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: closeSlot.fieldIdx },
              { op: "ref.as_non_null" },
              { op: "local.set", index: closeDelegLocal },
              // inner.mode = outer.mode; inner.abrupt = payload; inner.error = outer.error
              { op: "local.get", index: closeDelegLocal },
              { op: "local.get", index: selfLocal },
              { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
              { op: "struct.set", typeIdx: closeInner.stateTypeIdx, fieldIdx: closeInner.modeFieldIdx },
              { op: "local.get", index: closeDelegLocal },
              ...closeAbruptPayload,
              { op: "struct.set", typeIdx: closeInner.stateTypeIdx, fieldIdx: closeInner.abruptFieldIdx },
              { op: "local.get", index: closeDelegLocal },
              { op: "local.get", index: selfLocal },
              { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD },
              { op: "struct.set", typeIdx: closeInner.stateTypeIdx, fieldIdx: ERROR_FIELD },
              // Drive the inner ONCE (result discarded); catch its mode-2
              // re-throw / a finally-thrown replacement error. Foreign JS
              // exceptions (host mode) recover via __get_caught_exception when
              // the resume emitter acquired it (#3050 wrap parity).
              buildTargetTaggedTry(
                ctx,
                { kind: "empty" },
                [{ op: "local.get", index: closeDelegLocal }, { op: "call", funcIdx: closeResumeIdx }, { op: "drop" }],
                [{ tagIdx: ensureExnTag(ctx), body: closeCatch }],
                getCaughtExnIdx !== undefined ? [{ op: "call", funcIdx: getCaughtExnIdx }, ...closeCatch] : undefined,
              ),
              // Close complete — clear the slot.
              { op: "local.get", index: selfLocal },
              { op: "ref.null", typeIdx: closeInner.stateTypeIdx },
              { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: closeSlot.fieldIdx },
            ],
            else: [],
          },
        );
      }
    }
    for (const finalizer of state.abruptResume.finalizers) {
      for (const stmt of finalizer) compileStatement(ctx, fctx, stmt);
    }
    abruptBody.push(...storeSpills(info, fctx, selfLocal));
    abruptBody.push(...setStateInstrs(info, selfLocal, info.doneState));

    // mode 2 (throw): re-throw the stored error. `throw` is stack-polymorphic
    // (control leaves the resume function), so no value/`br` is needed and the
    // generator surfaces the error to the `.throw(e)` caller, finalizers having
    // run first (§27.5.3.4 GeneratorResumeAbrupt with a throw completion, no
    // catch in this slice — try/catch-across-yield stays the next slice).
    const throwBody: Instr[] = [
      { op: "local.get", index: selfLocal },
      { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD },
      { op: "throw", tagIdx: ensureExnTag(ctx) },
    ];

    // mode 1 (return): complete with the abrupt value (unchanged from F1). The
    // `.return(v)` value lives in `abrupt` when its carrier matches the result
    // `value` type (numeric / boxed-any); for a string generator the abrupt
    // field stays f64, so complete with the elem default (string `.return(v)` is
    // a documented follow-up). br depth is exitDepth + 2 — inside the outer
    // `if (mode != 0)` AND the inner `if (mode == 2) … else …`.
    const returnBody: Instr[] = [];
    if (valTypesMatch(genCarrierFieldType(info.elemValType), info.elemValType)) {
      returnBody.push({ op: "local.get", index: selfLocal });
      returnBody.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.abruptFieldIdx });
    } else {
      returnBody.push(...defaultElemValueInstrs(ctx, info.elemValType));
    }
    returnBody.push({ op: "i32.const", value: 1 });
    returnBody.push({ op: "struct.new", typeIdx: info.resultTypeIdx });
    returnBody.push({ op: "local.set", index: resultLocal });
    returnBody.push({ op: "br", depth: exitDepth + 2 });

    abruptBody.push({ op: "local.get", index: selfLocal });
    abruptBody.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx });
    abruptBody.push({ op: "i32.const", value: MODE_THROW });
    abruptBody.push({ op: "i32.eq" });
    abruptBody.push({ op: "if", blockType: { kind: "empty" }, then: throwBody, else: returnBody });
    fctx.body = savedAbrupt;

    body.push({ op: "local.get", index: selfLocal });
    body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx });
    body.push({ op: "i32.const", value: MODE_NEXT });
    body.push({ op: "i32.ne" });
    body.push({ op: "if", blockType: { kind: "empty" }, then: abruptBody, else: [] });
  }

  // Resume bindings: copy the `.next(value)` sent value into the bound local
  // and its spill field.
  for (const name of state.resumeBindings) {
    const localIdx = fctx.localMap.get(name);
    const spillIdx = info.spillNames.indexOf(name);
    if (localIdx === undefined || spillIdx < 0) continue;
    body.push({ op: "local.get", index: selfLocal });
    body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.sentFieldIdx });
    body.push({ op: "local.set", index: localIdx });
    body.push({ op: "local.get", index: selfLocal });
    body.push({ op: "local.get", index: localIdx });
    body.push({ op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.spillFieldOffset + spillIdx });
  }

  // Prelude statements (straight-line, yield-free).
  for (const stmt of state.statements) compileStatement(ctx, fctx, stmt);

  const term = state.terminator;
  switch (term.kind) {
    case "yield": {
      const tmp = emitYieldValueAsElem(ctx, fctx, term.expr, info);
      body.push(...storeSpills(info, fctx, selfLocal));
      body.push(...setStateInstrs(info, selfLocal, term.next));
      body.push(...setModeInstrs(info, selfLocal, 0));
      body.push({ op: "local.get", index: tmp });
      body.push({ op: "i32.const", value: 0 });
      body.push({ op: "struct.new", typeIdx: info.resultTypeIdx });
      body.push({ op: "local.set", index: resultLocal });
      body.push({ op: "br", depth: exitDepth }); // leave trampoline → return result
      break;
    }
    case "return": {
      const tmp = emitYieldValueAsElem(ctx, fctx, term.expr, info);
      body.push(...storeSpills(info, fctx, selfLocal));
      body.push(...setStateInstrs(info, selfLocal, info.doneState));
      body.push(...setModeInstrs(info, selfLocal, 0));
      body.push({ op: "local.get", index: tmp });
      body.push({ op: "i32.const", value: 1 });
      body.push({ op: "struct.new", typeIdx: info.resultTypeIdx });
      body.push({ op: "local.set", index: resultLocal });
      body.push({ op: "br", depth: exitDepth });
      break;
    }
    case "jump": {
      body.push(...storeSpills(info, fctx, selfLocal));
      // (#3050) A normal-path entry into a state-lowered finally resets the
      // region's pending-completion kind (abrupt entries write it in the
      // routers instead).
      if (term.setPending !== undefined && info.pendingFieldIdx !== undefined) {
        body.push({ op: "local.get", index: selfLocal });
        body.push({ op: "i32.const", value: term.setPending });
        body.push({ op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.pendingFieldIdx });
      }
      body.push(...setStateInstrs(info, selfLocal, term.next));
      body.push({ op: "br", depth: loopDepth }); // re-enter dispatch at new state
      break;
    }
    // (#3050) Exit router of a state-lowered finally: pending none → proceed to
    // the join; pending return/throw → re-dispatch the saved completion against
    // the region's OUTER unwind chain (which may enter an outer catch/finally,
    // run legacy replays, or complete/re-throw).
    case "finally-exit": {
      body.push(...storeSpills(info, fctx, selfLocal));
      const abruptArm: Instr[] = [];
      {
        const savedFx = fctx.body;
        fctx.body = abruptArm;
        emitUnwindWalk(ctx, fctx, info, term.unwind, {
          selfLocal,
          resultLocal,
          srcFieldIdx: info.pendingFieldIdx!,
          loopDepth: loopDepth + 1, // inside the `if (pending == 0) … else …`
          exitDepth: exitDepth + 1,
        });
        fctx.body = savedFx;
      }
      body.push({ op: "local.get", index: selfLocal });
      body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.pendingFieldIdx! });
      body.push({ op: "i32.eqz" });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [...setStateInstrs(info, selfLocal, term.join), { op: "br", depth: loopDepth + 1 }],
        else: abruptArm,
      });
      break;
    }
    case "branch": {
      body.push(...storeSpills(info, fctx, selfLocal));
      emitConditionAsI32(ctx, fctx, term.cond);
      if (term.negate) body.push({ op: "i32.eqz" });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...setStateInstrs(info, selfLocal, term.thenState),
          { op: "br", depth: loopDepth + 1 }, // +1 for the inner branch `if`
        ],
        else: [...setStateInstrs(info, selfLocal, term.elseState), { op: "br", depth: loopDepth + 1 }],
      });
      break;
    }
    case "done": {
      body.push(...storeSpills(info, fctx, selfLocal));
      body.push(...setStateInstrs(info, selfLocal, info.doneState));
      body.push(...emptyResult(ctx, info));
      body.push({ op: "local.set", index: resultLocal });
      // No br: fall out of the trampoline loop (loop only repeats on explicit
      // br), then `block $exit` ends and the caller reads $__result.
      break;
    }
    case "yield-star": {
      if (term.delegationKind === "vec") {
        // (#2173 slice-2a) Delegate to a NUMERIC array / vec by driving a cursor
        // over its f64 `data`, zero host imports (the array for-of fast path):
        //   if (vec == null) { vec = <subject>(); cursor = 0 }   ; first entry
        //   if (cursor >= vec.length) {                          ; exhausted
        //     vec = null; bindResult = undefined; state = next; br loop;
        //   } else {
        //     state = THIS; mode = 0; cursor++;
        //     result = { vec.data[cursor], done: 0 }; br exit;    ; re-enter here
        //   }
        const vslot = info.vecDelegationSlots?.[term.vecSiteIndex];
        if (!vslot || vslot.vecTypeIdx === null) {
          // Defensive: unresolved vec type — complete rather than emit invalid wasm.
          body.push(...storeSpills(info, fctx, selfLocal));
          body.push(...setStateInstrs(info, selfLocal, info.doneState));
          body.push(...emptyResult(ctx, info));
          body.push({ op: "local.set", index: resultLocal });
          break;
        }
        const vecTypeIdx = vslot.vecTypeIdx;
        const vecRefType: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
        const vecLocal = allocLocal(fctx, `__gen_vec_${fctx.locals.length}`, vecRefType);
        const cursorLocal = allocLocal(fctx, `__gen_veccur_${fctx.locals.length}`, { kind: "i32" });

        // Spill straight-line locals computed in this state's prelude BEFORE
        // suspending; the vec slot itself lives in the struct already.
        body.push(...storeSpills(info, fctx, selfLocal));

        // Lazily materialize the iterable on first entry (slot null): evaluate
        // the subject ONCE (iterator semantics — GetIterator runs once) and
        // reset the cursor to 0 (so a vec-yield* inside a loop re-iterates).
        const materialize: Instr[] = [];
        {
          const savedC = fctx.body;
          fctx.body = materialize;
          compileExpression(ctx, fctx, term.subject, vecRefType);
          fctx.body = savedC;
        }
        body.push({ op: "local.get", index: selfLocal });
        body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: vslot.vecFieldIdx });
        body.push({ op: "ref.is_null" });
        body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: selfLocal },
            ...materialize,
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: vslot.vecFieldIdx },
            { op: "local.get", index: selfLocal },
            { op: "i32.const", value: 0 },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: vslot.cursorFieldIdx },
          ],
          else: [],
        });

        // Load vec + cursor into locals.
        body.push({ op: "local.get", index: selfLocal });
        body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: vslot.vecFieldIdx });
        body.push({ op: "local.set", index: vecLocal });
        body.push({ op: "local.get", index: selfLocal });
        body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: vslot.cursorFieldIdx });
        body.push({ op: "local.set", index: cursorLocal });

        // (#2864 R1) `const x = yield* [..]` — deliver the completion value
        // (§27.5.3.7). An array's completion value is `undefined`; carry the f64
        // undefined-as-NaN sentinel into the binding's local AND its spill.
        // (#2106 residual: `x === x` diverges from Node — do not pin in tests.)
        const bindInstrs: Instr[] = [];
        if (term.bindResultTo !== undefined) {
          const bindLocal = fctx.localMap.get(term.bindResultTo);
          const bindSpillIdx = info.spillNames.indexOf(term.bindResultTo);
          if (bindLocal !== undefined && bindSpillIdx >= 0) {
            bindInstrs.push(
              { op: "f64.const", value: NaN },
              { op: "local.set", index: bindLocal },
              { op: "local.get", index: selfLocal },
              { op: "f64.const", value: NaN },
              {
                op: "struct.set",
                typeIdx: info.stateTypeIdx,
                fieldIdx: info.spillFieldOffset + bindSpillIdx,
              },
            );
          }
        }

        const doneArm: Instr[] = [
          // exhausted — clear the slot, advance to the successor, re-enter.
          { op: "local.get", index: selfLocal },
          { op: "ref.null", typeIdx: vecTypeIdx },
          { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: vslot.vecFieldIdx },
          ...bindInstrs,
          ...setStateInstrs(info, selfLocal, term.next),
          { op: "br", depth: loopDepth + 1 }, // +1 for the inner `if`
        ];
        const yieldArm: Instr[] = [
          // element available — stay in THIS state; advance the cursor.
          ...setStateInstrs(info, selfLocal, stateId),
          ...setModeInstrs(info, selfLocal, 0),
          { op: "local.get", index: selfLocal },
          { op: "local.get", index: cursorLocal },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: vslot.cursorFieldIdx },
          // result = { vec.data[cursor] (f64), done: 0 }
          { op: "local.get", index: vecLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: cursorLocal },
          { op: "array.get", typeIdx: vslot.arrTypeIdx },
          { op: "i32.const", value: 0 },
          { op: "struct.new", typeIdx: info.resultTypeIdx },
          { op: "local.set", index: resultLocal },
          { op: "br", depth: exitDepth + 1 }, // +1 for the inner `if`
        ];
        // if (cursor >= vec.length) doneArm else yieldArm
        body.push({ op: "local.get", index: cursorLocal });
        body.push({ op: "local.get", index: vecLocal });
        body.push({ op: "ref.as_non_null" });
        body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
        body.push({ op: "i32.ge_s" });
        body.push({ op: "if", blockType: { kind: "empty" }, then: doneArm, else: yieldArm });
        break;
      }
      if (term.delegationKind === "iterable") {
        // (#2173 slice-2b) Delegate to a GENERIC iterable by driving the
        // standalone-native `__iterator`/`__iterator_next` runtime (#2038) from an
        // externref `$__IterRec` slot — zero host imports. §27.5.3.7:
        //   if (rec == null) rec = __iterator(<subject>);        ; first entry
        //   (done, value) = __iterator_next(rec);
        //   if (done) { rec = null; bindResult = undefined; state = next; br loop }
        //   else { state = THIS; mode = 0; result = { unbox(value), done:0 }; br exit }
        const islot = info.iterableDelegationSlots?.[term.iterableSiteIndex];
        if (!islot) {
          // Defensive: unresolved slot — complete rather than emit invalid wasm.
          body.push(...storeSpills(info, fctx, selfLocal));
          body.push(...setStateInstrs(info, selfLocal, info.doneState));
          body.push(...emptyResult(ctx, info));
          body.push({ op: "local.set", index: resultLocal });
          break;
        }
        ensureNativeIteratorRuntime(ctx);
        const iteratorIdx = ctx.funcMap.get("__iterator");
        const iteratorNextIdx = ctx.funcMap.get("__iterator_next");
        if (iteratorIdx === undefined || iteratorNextIdx === undefined) {
          body.push(...storeSpills(info, fctx, selfLocal));
          body.push(...setStateInstrs(info, selfLocal, info.doneState));
          body.push(...emptyResult(ctx, info));
          body.push({ op: "local.set", index: resultLocal });
          break;
        }
        const recLocal = allocLocal(fctx, `__gen_iterrec_${fctx.locals.length}`, { kind: "externref" });
        const doneLocal = allocLocal(fctx, `__gen_iterdone_${fctx.locals.length}`, { kind: "i32" });
        const valueLocal = allocLocal(fctx, `__gen_iterval_${fctx.locals.length}`, { kind: "externref" });

        // Spill straight-line locals BEFORE suspending; the rec slot lives in the
        // struct already.
        body.push(...storeSpills(info, fctx, selfLocal));

        // Lazily materialize the iterator on first entry (slot null): evaluate the
        // subject ONCE (GetIterator runs once), box to externref, and wrap via the
        // native `__iterator`.
        const materialize: Instr[] = [];
        {
          const savedC = fctx.body;
          fctx.body = materialize;
          const st = compileExpression(ctx, fctx, term.subject, { kind: "externref" });
          if (st && st.kind !== "externref") coerceType(ctx, fctx, st, { kind: "externref" });
          fctx.body.push({ op: "call", funcIdx: iteratorIdx });
          fctx.body = savedC;
        }
        body.push({ op: "local.get", index: selfLocal });
        body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: islot.fieldIdx });
        body.push({ op: "ref.is_null" });
        body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: selfLocal },
            ...materialize,
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: islot.fieldIdx },
          ],
          else: [],
        });

        // rec → local; step it once: (done, value) = __iterator_next(rec).
        body.push({ op: "local.get", index: selfLocal });
        body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: islot.fieldIdx });
        body.push({ op: "local.set", index: recLocal });
        body.push({ op: "local.get", index: recLocal });
        body.push({ op: "call", funcIdx: iteratorNextIdx });
        body.push({ op: "local.set", index: valueLocal }); // value (top of stack)
        body.push({ op: "local.set", index: doneLocal }); // done

        // (#2864 R1 / #2106 residual) `const x = yield* it` — deliver the
        // completion value (undefined for the array/`.values()` shape) into the
        // binding's local AND spill. Sentinel matches the binding's slot type.
        const bindInstrs: Instr[] = [];
        if (term.bindResultTo !== undefined) {
          const bindLocal = fctx.localMap.get(term.bindResultTo);
          const bindSpillIdx = info.spillNames.indexOf(term.bindResultTo);
          if (bindLocal !== undefined && bindSpillIdx >= 0) {
            const bindType = getLocalType(fctx, bindLocal);
            const undef: Instr = bindType?.kind === "f64" ? { op: "f64.const", value: NaN } : { op: "ref.null.extern" };
            bindInstrs.push(
              undef,
              { op: "local.set", index: bindLocal },
              { op: "local.get", index: selfLocal },
              undef,
              {
                op: "struct.set",
                typeIdx: info.stateTypeIdx,
                fieldIdx: info.spillFieldOffset + bindSpillIdx,
              },
            );
          }
        }

        // Re-yielded value: unbox the externref `value` to the OUTER element type
        // (f64 outer → native `__unbox_number`; string outer → guarded native
        // string ref cast; boxed-any outer → pass through).
        const valueInstrs: Instr[] = [];
        {
          const savedC = fctx.body;
          fctx.body = valueInstrs;
          fctx.body.push({ op: "local.get", index: valueLocal });
          if (info.elemValType.kind === "f64") {
            coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" }, "number");
          } else if (info.elemValType.kind === "ref" || info.elemValType.kind === "ref_null") {
            coerceType(ctx, fctx, { kind: "externref" }, info.elemValType);
          }
          fctx.body = savedC;
        }

        const doneArm: Instr[] = [
          // exhausted — clear the slot, advance to the successor, re-enter.
          { op: "local.get", index: selfLocal },
          { op: "ref.null.extern" },
          { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: islot.fieldIdx },
          ...bindInstrs,
          ...setStateInstrs(info, selfLocal, term.next),
          { op: "br", depth: loopDepth + 1 }, // +1 for the inner `if`
        ];
        const yieldArm: Instr[] = [
          // iterator yielded — stay in THIS state so the next .next() re-drives it.
          ...setStateInstrs(info, selfLocal, stateId),
          ...setModeInstrs(info, selfLocal, 0),
          ...valueInstrs,
          { op: "i32.const", value: 0 },
          { op: "struct.new", typeIdx: info.resultTypeIdx },
          { op: "local.set", index: resultLocal },
          { op: "br", depth: exitDepth + 1 }, // +1 for the inner `if`
        ];
        body.push({ op: "local.get", index: doneLocal });
        body.push({ op: "if", blockType: { kind: "empty" }, then: doneArm, else: yieldArm });
        break;
      }
      // (#2170) Delegate to the inner native generator. §27.5.3.7:
      //   if (deleg == null) deleg = <inner>();           ; first entry
      //   innerRes = __gen_resume_<inner>(deleg);
      //   if (innerRes.done == 0) {                        ; inner yielded
      //     store spills; state = THIS; mode = 0;
      //     result = { innerRes.value, done: 0 }; br exit; ; re-enter here next .next()
      //   } else {                                         ; inner done
      //     deleg = null; state = next; br loop;           ; resume outer machine
      //   }
      const slot = info.delegationSlots?.[term.siteIndex];
      const innerInfo = slot ? ctx.nativeGenerators.get(slot.innerName) : undefined;
      if (!slot || !innerInfo) {
        // Defensive: the plan recorded a delegation site the struct/registry
        // did not back. Complete the generator rather than emit invalid wasm.
        body.push(...storeSpills(info, fctx, selfLocal));
        body.push(...setStateInstrs(info, selfLocal, info.doneState));
        body.push(...emptyResult(ctx, info));
        body.push({ op: "local.set", index: resultLocal });
        break;
      }
      const innerResumeIdx = ensureNativeGeneratorResumeFunction(ctx, innerInfo);
      const innerStateRef: ValType = { kind: "ref", typeIdx: innerInfo.stateTypeIdx };
      const innerResRef: ValType = { kind: "ref", typeIdx: innerInfo.resultTypeIdx };
      const delegLocal = allocLocal(fctx, `__gen_deleg_${fctx.locals.length}`, innerStateRef);
      const innerResLocal = allocLocal(fctx, `__gen_innerres_${fctx.locals.length}`, innerResRef);

      // Spill any straight-line locals computed in this state's prelude BEFORE
      // suspending; the delegation slot itself lives in the struct already.
      body.push(...storeSpills(info, fctx, selfLocal));

      // Lazily materialize the inner generator on first entry: if the slot is
      // null, construct `<inner>()` and store it.
      const constructInner: Instr[] = [];
      {
        const savedC = fctx.body;
        fctx.body = constructInner;
        compileNativeGeneratorFunction(ctx, fctx, innerInfo.decl, innerInfo);
        fctx.body = savedC;
      }
      body.push({ op: "local.get", index: selfLocal });
      body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: slot.fieldIdx });
      body.push({ op: "ref.is_null" });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: selfLocal },
          ...constructInner,
          { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: slot.fieldIdx },
        ],
        else: [],
      });

      // deleg (non-null) → local; drive its resume once.
      body.push({ op: "local.get", index: selfLocal });
      body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: slot.fieldIdx });
      body.push({ op: "ref.as_non_null" });
      body.push({ op: "local.set", index: delegLocal });
      body.push({ op: "local.get", index: delegLocal });
      body.push({ op: "call", funcIdx: innerResumeIdx });
      body.push({ op: "local.set", index: innerResLocal });

      // (#2864 R1) `const x = yield* inner()` — on completion, deliver the
      // inner's `return` value (§27.5.3.7: the yield* expression's value is
      // `innerRes.value` once `innerRes.done`) into the binding's local AND its
      // spill field, so it both flows into the successor state within this
      // resume call and survives later suspensions. The inner is f64-gated, so
      // the value and the binding's spill slot are both f64.
      const bindInstrs: Instr[] = [];
      if (term.bindResultTo !== undefined) {
        const bindLocal = fctx.localMap.get(term.bindResultTo);
        const bindSpillIdx = info.spillNames.indexOf(term.bindResultTo);
        if (bindLocal !== undefined && bindSpillIdx >= 0) {
          bindInstrs.push(
            { op: "local.get", index: innerResLocal },
            { op: "struct.get", typeIdx: innerInfo.resultTypeIdx, fieldIdx: RESULT_VALUE_FIELD },
            { op: "local.set", index: bindLocal },
            { op: "local.get", index: selfLocal },
            { op: "local.get", index: bindLocal },
            {
              op: "struct.set",
              typeIdx: info.stateTypeIdx,
              fieldIdx: info.spillFieldOffset + bindSpillIdx,
            },
          );
        }
      }

      // if (innerRes.done == 0) re-yield innerRes.value (stay in THIS state)
      const doneArm: Instr[] = [
        // inner done — clear the slot, advance to the successor state, re-enter.
        { op: "local.get", index: selfLocal },
        { op: "ref.null", typeIdx: innerInfo.stateTypeIdx },
        { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: slot.fieldIdx },
        ...bindInstrs,
        ...setStateInstrs(info, selfLocal, term.next),
        { op: "br", depth: loopDepth + 1 }, // +1 for the inner `if`
      ];
      const yieldArm: Instr[] = [
        // inner yielded — stay in THIS state so the next .next() re-drives it.
        ...setStateInstrs(info, selfLocal, stateId),
        ...setModeInstrs(info, selfLocal, 0),
        { op: "local.get", index: innerResLocal },
        { op: "struct.get", typeIdx: innerInfo.resultTypeIdx, fieldIdx: RESULT_VALUE_FIELD },
        { op: "i32.const", value: 0 },
        { op: "struct.new", typeIdx: info.resultTypeIdx },
        { op: "local.set", index: resultLocal },
        { op: "br", depth: exitDepth + 1 }, // +1 for the inner `if`
      ];
      body.push({ op: "local.get", index: innerResLocal });
      body.push({ op: "struct.get", typeIdx: innerInfo.resultTypeIdx, fieldIdx: RESULT_DONE_FIELD });
      body.push({ op: "if", blockType: { kind: "empty" }, then: doneArm, else: yieldArm });
      break;
    }
  }

  fctx.body = saved;
  ctx.liveBodies.delete(saved);

  // (#3050) Wrap the arm in a wasm try/catch so a runtime exception raised
  // while this state executes (a `throw` statement in a try block, a throwing
  // call, …) routes to the enclosing region's catch/finally per JS semantics.
  // The wrap was already accounted for in the +1 depth shift at the top.
  if (state.throwRoute) {
    const route = state.throwRoute;
    // Route body with the caught error value (externref) ON THE STACK.
    const routeInstrs = (): Instr[] => {
      const out: Instr[] = [];
      if (route.kind === "catch") {
        // Bind the error to the catch param (local + spill, so it survives a
        // later suspension inside the catch), then enter the catch block. The
        // jump stays within this resume call, so locals remain authoritative.
        const eName = route.region.catchParamName;
        const localIdx = eName !== undefined ? fctx.localMap.get(eName) : undefined;
        if (localIdx !== undefined) {
          out.push({ op: "local.set", index: localIdx });
          const spillIdx = eName !== undefined ? info.spillNames.indexOf(eName) : -1;
          if (spillIdx >= 0) {
            out.push({ op: "local.get", index: selfLocal });
            out.push({ op: "local.get", index: localIdx });
            out.push({ op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.spillFieldOffset + spillIdx });
          }
        } else {
          out.push({ op: "drop" });
        }
        out.push(...setModeInstrs(info, selfLocal, MODE_NEXT));
        out.push(...setStateInstrs(info, selfLocal, route.region.catchEntryState!));
      } else {
        // Save the throw as the region's pending completion and enter the
        // state-lowered finally; its exit router re-propagates afterwards.
        const scratch = allocLocal(fctx, `__gen_exn_${fctx.locals.length}`, { kind: "externref" });
        out.push({ op: "local.set", index: scratch });
        out.push({ op: "local.get", index: selfLocal });
        out.push({ op: "local.get", index: scratch });
        out.push({ op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD });
        if (info.pendingFieldIdx !== undefined) {
          out.push({ op: "local.get", index: selfLocal });
          out.push({ op: "i32.const", value: MODE_THROW });
          out.push({ op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.pendingFieldIdx });
        }
        out.push(...setModeInstrs(info, selfLocal, MODE_NEXT));
        out.push(...setStateInstrs(info, selfLocal, route.region.finallyEntryState!));
      }
      // Inside the try construct the loop label sits at the (already shifted)
      // loopDepth — identical for the try body and its catch bodies.
      out.push({ op: "br", depth: loopDepth });
      return out;
    };
    // Foreign JS exceptions (host mode only): recover the value via
    // `__get_caught_exception` (acquired up-front — no late import here) and
    // route identically. Standalone/wasi have no foreign exceptions (#1473).
    const catchAll: Instr[] | undefined =
      getCaughtExnIdx !== undefined ? [{ op: "call", funcIdx: getCaughtExnIdx }, ...routeInstrs()] : undefined;
    return [
      buildTargetTaggedTry(
        ctx,
        { kind: "empty" },
        body,
        [{ tagIdx: ensureExnTag(ctx), body: routeInstrs() }],
        catchAll,
      ),
    ];
  }
  return body;
}

/**
 * (#3050) Emit the abrupt-completion unwind walk into `fctx.body`. `entries`
 * is innermost-first. The completion KIND is read from the state struct field
 * `srcFieldIdx` — the resume `mode` field when routing a fresh `.throw()` /
 * `.return()` at a suspended yield, or the `pending` field when a state-lowered
 * finally's exit router re-dispatches its saved completion. The payloads always
 * ride the `error` (throw) / `abrupt` (return) fields.
 *
 *  - `replay`  compile the legacy yield-free finally statements inline (both
 *              completion kinds run them — same as the historical router);
 *  - `catch`   throw-kind only: bind `error` to the catch param (local + spill),
 *              clear the mode, and enter the catch block's states;
 *  - `finally` both kinds: save the kind into `pending`, clear the mode, and
 *              enter the finally's states (its exit router continues outward) —
 *              nothing after it is reachable;
 *  - tail      no handler left: complete the generator, then re-throw (throw)
 *              or produce `{abrupt, done:1}` (return) — byte-compatible with
 *              the legacy `abruptResume` tail.
 *
 * `loopDepth`/`exitDepth` are the branch depths AT THE WALK'S EMISSION LEVEL.
 */
function emitUnwindWalk(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NativeGeneratorInfo,
  entries: readonly UnwindEntry[],
  o: { selfLocal: number; resultLocal: number; srcFieldIdx: number; loopDepth: number; exitDepth: number },
): void {
  const body = fctx.body;
  const srcIsThrow = (): Instr[] => [
    { op: "local.get", index: o.selfLocal },
    { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: o.srcFieldIdx },
    { op: "i32.const", value: MODE_THROW },
    { op: "i32.eq" },
  ];
  for (const entry of entries) {
    if (entry.kind === "replay") {
      for (const stmt of entry.statements) compileStatement(ctx, fctx, stmt);
      continue;
    }
    if (entry.kind === "catch") {
      // Throw completions enter the catch; return completions pass through.
      const thenInstrs: Instr[] = [];
      const eName = entry.region.catchParamName;
      const localIdx = eName !== undefined ? fctx.localMap.get(eName) : undefined;
      if (localIdx !== undefined) {
        thenInstrs.push({ op: "local.get", index: o.selfLocal });
        thenInstrs.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD });
        thenInstrs.push({ op: "local.set", index: localIdx });
        const spillIdx = eName !== undefined ? info.spillNames.indexOf(eName) : -1;
        if (spillIdx >= 0) {
          thenInstrs.push({ op: "local.get", index: o.selfLocal });
          thenInstrs.push({ op: "local.get", index: localIdx });
          thenInstrs.push({
            op: "struct.set",
            typeIdx: info.stateTypeIdx,
            fieldIdx: info.spillFieldOffset + spillIdx,
          });
        }
      }
      thenInstrs.push(...setModeInstrs(info, o.selfLocal, MODE_NEXT));
      thenInstrs.push(...storeSpills(info, fctx, o.selfLocal));
      thenInstrs.push(...setStateInstrs(info, o.selfLocal, entry.region.catchEntryState!));
      thenInstrs.push({ op: "br", depth: o.loopDepth + 1 }); // +1: inside this if
      body.push(...srcIsThrow());
      body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs, else: [] });
      continue;
    }
    // finally — intercepts BOTH completion kinds; nothing after is reachable.
    body.push({ op: "local.get", index: o.selfLocal });
    body.push({ op: "local.get", index: o.selfLocal });
    body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: o.srcFieldIdx });
    body.push({ op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.pendingFieldIdx! });
    body.push(...setModeInstrs(info, o.selfLocal, MODE_NEXT));
    body.push(...storeSpills(info, fctx, o.selfLocal));
    body.push(...setStateInstrs(info, o.selfLocal, entry.region.finallyEntryState!));
    body.push({ op: "br", depth: o.loopDepth });
    return;
  }
  // Tail: no handler — complete the generator, then re-throw or return-complete
  // (mirrors the legacy abruptResume tail).
  body.push(...storeSpills(info, fctx, o.selfLocal));
  body.push(...setStateInstrs(info, o.selfLocal, info.doneState));
  const throwBody: Instr[] = [
    { op: "local.get", index: o.selfLocal },
    { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD },
    { op: "throw", tagIdx: ensureExnTag(ctx) },
  ];
  const returnBody: Instr[] = [];
  if (valTypesMatch(genCarrierFieldType(info.elemValType), info.elemValType)) {
    returnBody.push({ op: "local.get", index: o.selfLocal });
    returnBody.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.abruptFieldIdx });
  } else {
    returnBody.push(...defaultElemValueInstrs(ctx, info.elemValType));
  }
  returnBody.push({ op: "i32.const", value: 1 });
  returnBody.push({ op: "struct.new", typeIdx: info.resultTypeIdx });
  returnBody.push({ op: "local.set", index: o.resultLocal });
  returnBody.push({ op: "br", depth: o.exitDepth + 1 }); // +1: inside this if
  body.push(...srcIsThrow());
  body.push({ op: "if", blockType: { kind: "empty" }, then: throwBody, else: returnBody });
}

export function ensureNativeGeneratorResumeFunction(ctx: CodegenContext, info: NativeGeneratorInfo): number {
  const fnName = `__gen_resume_${sanitizeTypeName(info.functionName)}`;
  // (#2941) SINGLE SOURCE OF TRUTH = `ctx.funcMap`, which every late-import
  // shifter (`shiftLateImportIndices` / `addStringImports` / `addUnionImports`)
  // keeps current. `info.resumeFuncIdx` is a plain cached number that NO shift
  // pass walked (unlike `nativeStrHelpers` / `mapHelpers` / the async-scheduler
  // side-channels), so once the resume function is emitted, a late import that
  // lands afterwards bumps the funcMap entry but leaves the cache stale-low.
  // Already-baked `call` instrs are repaired by the shifter's body walk, but a
  // NEW bake after the shift that reads the stale cache targets one function too
  // early — the class-static generator `call[…] need N got 1` invalid-module
  // desync (#2938 merge_group). Re-reading funcMap on every cached hit makes the
  // returned idx always current (reference_2193 lineage: read the shift-maintained
  // map, never a cached number). We also refresh the cache so a direct reader of
  // `info.resumeFuncIdx` sees the current value; `shiftLateImportIndices` now
  // walks `ctx.nativeGenerators` too (belt-and-suspenders lockstep, #2941).
  if (info.resumeFuncIdx !== undefined) {
    const current = ctx.funcMap.get(fnName);
    if (current !== undefined && current !== info.resumeFuncIdx) info.resumeFuncIdx = current;
    return info.resumeFuncIdx;
  }

  const existing = ctx.funcMap.get(fnName);
  if (existing !== undefined) {
    info.resumeFuncIdx = existing;
    return existing;
  }

  const selfType: ValType = { kind: "ref", typeIdx: info.stateTypeIdx };
  const resultType: ValType = { kind: "ref", typeIdx: info.resultTypeIdx };
  const typeIdx = addFuncType(ctx, [selfType], [resultType], `${fnName}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  info.resumeFuncIdx = funcIdx;
  ctx.funcMap.set(fnName, funcIdx);

  // #2079: reserve this function's slot with a placeholder BEFORE emitting the
  // body. The Phase-2 body can lazily register helper functions (numeric
  // operators like `%`/`**`, coercions, …) which append to `ctx.mod.functions`
  // and would otherwise push the real resume function past `funcIdx` — a stale
  // capture: every baked `call funcIdx` (the for-of driver, `.next()` dispatch)
  // would hit the helper instead of resume. Reserving the slot now keeps
  // `funcIdx` stable; we fill the placeholder body in place at the end. (Same
  // late-shift class as #1677/#1809/#1899; same fix idiom as the accessor
  // drivers.)
  const placeholder: WasmFunction = {
    name: fnName,
    typeIdx,
    locals: [],
    body: [{ op: "unreachable" }],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, placeholder);

  const resumeFctx: FunctionContext = {
    name: fnName,
    params: [{ name: "__gen_self", type: selfType }],
    locals: [],
    localMap: new Map([["__gen_self", 0]]),
    returnType: resultType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  // Copy params into locals.
  for (let i = 0; i < info.paramTypes.length; i++) {
    const localIdx = allocLocal(resumeFctx, info.paramNames[i]!, info.paramTypes[i]!);
    resumeFctx.body.push({ op: "local.get", index: 0 });
    resumeFctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.paramFieldOffset + i });
    resumeFctx.body.push({ op: "local.set", index: localIdx });
  }

  // (#3050) Capturing nested generator: register each cell-riding capture in
  // `boxedCaptures` so identifier reads/writes inside resume states deref the
  // shared cell (the exact mechanism a lifted capturing function body uses) —
  // a `count += 1` inside the generator is visible in the enclosing frame.
  if (info.leadingCaptureCells) {
    for (const cap of info.leadingCaptureCells) {
      if (!resumeFctx.boxedCaptures) resumeFctx.boxedCaptures = new Map();
      resumeFctx.boxedCaptures.set(cap.name, { refCellTypeIdx: cap.refCellTypeIdx, valType: cap.valType });
    }
  }

  // (#3032 W3) TDZ-flag boxes riding as leading params: register each
  // rehydrated flag-box local in `boxedTdzFlags` + `tdzFlagLocals` under the
  // ORIGINAL captured name, so TDZ-checked identifier reads inside resume
  // states (`emitLocalTdzCheck` / `emitLocalTdzInit`) deref the shared i32
  // cell — the exact mechanism a lifted capturing function body uses
  // (nested-declarations.ts #1205 Stage 3). The flag box already rides the
  // state struct as an ordinary `param_*` field (copied into a local above);
  // only this registration makes the body's TDZ machinery resolve it. The
  // cell's typeIdx comes from the param's own ValType so it always matches
  // the state-struct field / call-site prepend.
  if (info.leadingTdzFlags) {
    for (const tf of info.leadingTdzFlags) {
      const boxLocalIdx = resumeFctx.localMap.get(info.paramNames[tf.paramIdx]!);
      const pt = info.paramTypes[tf.paramIdx]!;
      if (boxLocalIdx === undefined || (pt.kind !== "ref" && pt.kind !== "ref_null")) continue;
      if (!resumeFctx.boxedTdzFlags) resumeFctx.boxedTdzFlags = new Map();
      resumeFctx.boxedTdzFlags.set(tf.name, { refCellTypeIdx: pt.typeIdx, localIdx: boxLocalIdx });
      if (!resumeFctx.tdzFlagLocals) resumeFctx.tdzFlagLocals = new Map();
      resumeFctx.tdzFlagLocals.set(tf.name, boxLocalIdx);
    }
  }

  // (#3302) CAPTURING generator fn-expression (lifted closure): re-run the
  // closures.ts capture prologue from the rehydrated `__self` param — the
  // captures live as fields of the closure struct, NOT as leading wasm params
  // (the closure ABI is fixed: trampoline passes `[args..., __self]`).
  // Materialize each capture field into a named local, then re-apply the
  // `boxedCaptures` / `boxedTdzFlags` + `tdzFlagLocals` registrations the
  // lifted body's prologue made, so identifier reads/writes and TDZ checks in
  // the resume states deref the SHARED cells (write-through to the enclosing
  // frame — by-reference, not the host buffer's by-value snapshot). Mirrors
  // async-frame.ts #2865; immutable by-value captures re-read the immutable
  // struct field on every resume (stable), mutable ones re-fetch the cell
  // (identity-stable), so suspends are transparent.
  if (info.selfCaptureRehydration) {
    const rehydration = info.selfCaptureRehydration;
    const selfIdx = resumeFctx.localMap.get(rehydration.selfParamName);
    if (selfIdx !== undefined) {
      let selfForCaptures = selfIdx;
      if (rehydration.castToTypeIdx !== null) {
        const castLocal = allocLocal(resumeFctx, "__self_cast", { kind: "ref", typeIdx: rehydration.castToTypeIdx });
        resumeFctx.body.push({ op: "local.get", index: selfIdx });
        resumeFctx.body.push({ op: "ref.cast", typeIdx: rehydration.castToTypeIdx });
        resumeFctx.body.push({ op: "local.set", index: castLocal });
        selfForCaptures = castLocal;
      }
      for (const entry of rehydration.entries) {
        const localIdx = allocLocal(resumeFctx, entry.name, entry.localType);
        resumeFctx.body.push({ op: "local.get", index: selfForCaptures });
        resumeFctx.body.push({ op: "struct.get", typeIdx: rehydration.structTypeIdx, fieldIdx: entry.fieldIdx });
        resumeFctx.body.push({ op: "local.set", index: localIdx });
      }
      for (const bc of rehydration.boxedCaptures) {
        if (!resumeFctx.boxedCaptures) resumeFctx.boxedCaptures = new Map();
        resumeFctx.boxedCaptures.set(bc.name, { refCellTypeIdx: bc.refCellTypeIdx, valType: bc.valType });
      }
      for (const tf of rehydration.tdzFlags) {
        const flagLocal = allocLocal(resumeFctx, `__tdz_box_${tf.name}`, {
          kind: "ref_null",
          typeIdx: tf.refCellTypeIdx,
        });
        resumeFctx.body.push({ op: "local.get", index: selfForCaptures });
        resumeFctx.body.push({ op: "struct.get", typeIdx: rehydration.structTypeIdx, fieldIdx: tf.fieldIdx });
        resumeFctx.body.push({ op: "local.set", index: flagLocal });
        if (!resumeFctx.boxedTdzFlags) resumeFctx.boxedTdzFlags = new Map();
        resumeFctx.boxedTdzFlags.set(tf.name, { refCellTypeIdx: tf.refCellTypeIdx, localIdx: flagLocal });
        if (!resumeFctx.tdzFlagLocals) resumeFctx.tdzFlagLocals = new Map();
        resumeFctx.tdzFlagLocals.set(tf.name, flagLocal);
      }
    }
  }

  // Load spills into locals. (#2864 F1b) The load local is minted at the spill's
  // actual ValType so the `struct.get` (of the same-typed field) round-trips. The
  // body's var-declaration reuses this exact slot (it is already in `localMap`),
  // and because the resume fctx carries no analysis caches, its computed type
  // equals `resolveSpillLocalValType` → no slot re-type, no mismatch.
  for (let i = 0; i < info.spillNames.length; i++) {
    const localIdx = allocLocal(resumeFctx, info.spillNames[i]!, info.spillTypes[i]!);
    resumeFctx.body.push({ op: "local.get", index: 0 });
    resumeFctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.spillFieldOffset + i });
    resumeFctx.body.push({ op: "local.set", index: localIdx });
  }

  // (#2920/#3386) Pattern-param bindings need NO state-0 re-destructure here:
  // parameter destructuring is EAGER (call time, §10.2.11
  // FunctionDeclarationInstantiation) and already ran in the FACTORY — the emit
  // site destructured the raw arg into factory locals, and
  // `compileNativeGeneratorFunction` packed those bound values into the spill
  // fields at `struct.new`. The spill-load loop above rehydrated them into
  // same-named locals, so body reads resolve exactly as before. (The historic
  // state-0 prelude re-destructure both mistimed GetIterator/default side
  // effects to first-`.next()` — the corpus asserts they throw at `f(g)` — and
  // would double-drive one-shot iterators now that iterator-protocol shapes
  // are admitted.)
  //
  // (#3315/#3386) Mark undef-widened pattern bindings in the resume fctx so
  // identifier reads skip the checker-type unbox narrowing (mirrors
  // ensureBindingLocals' marking in the factory).
  if (info.undefWidenedPatternBindings) {
    for (const name of info.undefWidenedPatternBindings) {
      (resumeFctx.undefWidenedLocals ??= new Set()).add(name);
    }
  }

  // Result holding local (the trampoline writes it; the tail reads it).
  const resultLocal = allocLocal(resumeFctx, "__gen_result", { kind: "ref", typeIdx: info.resultTypeIdx });

  const plan = buildNativeGeneratorPlan(ctx, info.decl);
  if (!plan) {
    reportError(ctx, info.decl, "Internal error: native generator plan disappeared during emission");
    resumeFctx.body.push(...emptyResult(ctx, info));
  } else {
    const savedFunc = ctx.currentFunc;
    ctx.currentFunc = resumeFctx;
    try {
      // (#3050) Throw-route wraps in HOST mode recover foreign JS exceptions
      // via `__get_caught_exception` (mirrors exceptions.ts; dead in
      // standalone/wasi, #1473 — wasm traps aren't catchable and every native
      // throw rides the `$exc` tag). Acquire it BEFORE the trampoline emit so
      // no late import fires mid-arm-chain (detached earlier arms would miss
      // the funcidx shift).
      let getCaughtExnIdx: number | undefined;
      if (plan.hasThrowRoutes && !ctx.standalone && !ctx.wasi) {
        getCaughtExnIdx = ensureLateImport(ctx, "__get_caught_exception", [], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, resumeFctx);
      }
      resumeFctx.body.push(...emitTrampoline(ctx, resumeFctx, info, plan, 0, resultLocal, getCaughtExnIdx));
    } finally {
      ctx.currentFunc = savedFunc;
    }
  }

  // (#2864 F1b) Reconcile each spill's struct field with the FINAL type its
  // resume-function local settled on. The body's var-declaration reuses the
  // pre-allocated spill slot and may re-type it (e.g. a predicted `ref_null`
  // narrowed by the declaration to a non-null `ref`); a non-null ref has no
  // struct-construction default and would not round-trip through `struct.get`,
  // so widen it back to `ref_null` and pin BOTH the local slot and the spill
  // field (+ `info.spillTypes`, which the constructor's init default reads) to
  // that common type. This runs before any `struct.new` of the state struct —
  // the constructor (`compileNativeGeneratorFunction`) calls this function
  // first — so the init defaults observe the reconciled types.
  const stateStruct = ctx.mod.types[info.stateTypeIdx];
  for (let i = 0; i < info.spillNames.length; i++) {
    const localIdx = resumeFctx.localMap.get(info.spillNames[i]!);
    if (localIdx === undefined || localIdx < resumeFctx.params.length) continue;
    const slot = resumeFctx.locals[localIdx - resumeFctx.params.length];
    if (!slot) continue;
    let finalType = slot.type;
    if (finalType.kind === "ref") finalType = { kind: "ref_null", typeIdx: finalType.typeIdx };
    slot.type = finalType;
    info.spillTypes[i] = finalType;
    if (stateStruct && stateStruct.kind === "struct") {
      const field = stateStruct.fields[info.spillFieldOffset + i];
      if (field) field.type = finalType;
    }
  }

  // Fill the reserved placeholder in place — its index (funcIdx) stayed stable
  // while body compilation appended any helper functions after it.
  placeholder.locals = resumeFctx.locals;
  placeholder.body = resumeFctx.body;
  return funcIdx;
}

export function compileNativeGeneratorFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: GeneratorDecl,
  info: NativeGeneratorInfo,
): void {
  ensureNativeGeneratorResumeFunction(ctx, info);
  // Construct the state struct: state=0, sent=⊥, mode=0, abrupt=⊥, params…, spills(NaN)…
  // (#2864 F1) `sent`/`abrupt` init to the carrier default — `f64 NaN` for the
  // numeric/string carriers (unchanged) or a null externref for the boxed-any
  // carrier so the struct.new typechecks before the first `.next(v)`.
  const carrierInit: Instr = carrierIsAny(info.elemValType)
    ? { op: "ref.null.extern" }
    : { op: "f64.const", value: NaN };
  fctx.body.push({ op: "i32.const", value: 0 }); // state
  fctx.body.push(carrierInit); // sent
  fctx.body.push({ op: "i32.const", value: 0 }); // mode = MODE_NEXT
  fctx.body.push(carrierInit); // abrupt
  fctx.body.push({ op: "ref.null.extern" }); // (#2864 F2) error
  // (#2571) Read every wasm param into its `param_*` state slot. For an instance
  // method generator the synthetic `this` is wasm param 0 and user params are
  // 1..n, so iterate `info.paramTypes.length` (which includes the synthetic
  // `this`), NOT `decl.parameters.length`. For free functions / static methods
  // the two are equal, so this is byte-identical there.
  for (let i = 0; i < info.paramTypes.length; i++) {
    fctx.body.push({ op: "local.get", index: i });
  }
  // (#2864 F1b) Spill slots start at their type's inert default — `f64 NaN`
  // (numeric, unchanged), `i32`/`i64` 0, a null ref for object/string spills, or
  // a null externref for boxed-any spills — so the `struct.new` typechecks before
  // the body's declaration overwrites the slot on first entry.
  //
  // (#3386) EXCEPT pattern-param bindings: their values were just produced by
  // the emit site's eager (call-time per §10.2.11) param destructure into
  // factory locals of the same name — pack the bound VALUE into the spill
  // field so the resume function's ordinary spill-load loop rehydrates the
  // binding on every entry. Coerce when the destructure lane's local type
  // differs from the spill type (e.g. an f64 struct-field bind into an
  // undef-widened externref spill). A name missing from the factory localMap
  // (defensive) keeps the inert default.
  for (let i = 0; i < info.spillNames.length; i++) {
    const spillName = info.spillNames[i]!;
    const spillType = info.spillTypes[i]!;
    const bindLocal = info.patternParamBindings?.has(spillName) ? fctx.localMap.get(spillName) : undefined;
    if (bindLocal !== undefined) {
      const localType = getLocalType(fctx, bindLocal);
      fctx.body.push({ op: "local.get", index: bindLocal });
      if (localType && !valTypesMatch(localType, spillType)) {
        // ref → ref_null of the same struct is a pure subtype widening — no
        // instruction needed; anything else routes through the coercion engine
        // (which handles its own late-import bookkeeping against fctx.body).
        const pureWiden =
          localType.kind === "ref" && spillType.kind === "ref_null" && localType.typeIdx === spillType.typeIdx;
        if (!pureWiden) coerceType(ctx, fctx, localType, spillType);
      }
    } else {
      fctx.body.push(defaultSpillInstr(spillType));
    }
  }
  // (#2170) `yield*` delegation slots start null — the inner generator is
  // materialized lazily on first entry into the yield-star state.
  for (const slot of info.delegationSlots ?? []) {
    const innerInfo = ctx.nativeGenerators.get(slot.innerName);
    if (innerInfo) {
      fctx.body.push({ op: "ref.null", typeIdx: innerInfo.stateTypeIdx });
    } else {
      fctx.body.push({ op: "ref.null.eq" });
    }
  }
  // (#2173 slice-2a) `yield* <numeric-array/vec>` slots start `{null vec, 0}` —
  // the iterable is materialized lazily on first entry into the vec-yield-star
  // state, and the cursor is (re)set to 0 on that materialization.
  for (const slot of info.vecDelegationSlots ?? []) {
    if (slot.vecTypeIdx !== null) {
      fctx.body.push({ op: "ref.null", typeIdx: slot.vecTypeIdx });
    } else {
      fctx.body.push({ op: "ref.null.eq" });
    }
    fctx.body.push({ op: "i32.const", value: 0 }); // cursor
  }
  // (#2173 slice-2b) `yield* <generic iterable>` slots start null-externref —
  // the `$__IterRec` is materialized lazily (`__iterator(subject)`) on first
  // entry into the iterable-yield-star state.
  for (const _slot of info.iterableDelegationSlots ?? []) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  // (#3050) Pending completion kind starts at 0 (none).
  if (info.pendingFieldIdx !== undefined) {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "struct.new", typeIdx: info.stateTypeIdx });
}

// (#3271) The native-generator CONSUMER / call-site subsystem now lives in
// generators-native-consumer.ts. Re-export its public entry points here so
// external importers of `./generators-native.js` are unaffected by the move.
export {
  tryCompileNativeGeneratorMethodCall,
  tryCompileNativeGeneratorResultProperty,
  isNativeGeneratorResultStruct,
  sentinelAwareF64BoxInstrs,
  nativeGeneratorInfoForForOfSubject,
  tryCompileNativeGeneratorForOf,
  emitNativeGeneratorToVec,
} from "./generators-native-consumer.js";
