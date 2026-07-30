// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Per-function selector — decides which functions to route through the IR
// path vs. the legacy direct AST→Wasm emission.
//
// Phase 1 (shipped) numeric/bool subset: a function is claimed when
//   - all params are typed `number` or `boolean` via an explicit TS type
//     annotation;
//   - return type is typed `number` or `boolean`;
//   - the function body is a "tail":
//       - zero or more `(let|const) <name> = <expr>;` declarations followed by
//       - either `return <expr>;` OR `if (<expr>) <tail> else <tail>`
//         where both arms are themselves valid tails;
//   - every `<expr>` is composed only of literals, param / local references,
//     and the supported unary / binary / conditional operators.
//
// Phase 2 extensions:
//   - `isPhase1Expr` accepts `CallExpression` whose callee is an Identifier.
//     The callee doesn't need to be resolvable at shape-check time — the
//     call-graph closure below ensures every claimed function's callees are
//     also claimed, and the AST→IR lowerer rejects unknown callees cleanly.
//   - Param / return types may come from a propagated TypeMap
//     (`buildTypeMap` in `./propagate.ts`) instead of an explicit TS
//     annotation. That unlocks recursive numeric kernels like `fib` whose
//     params are untyped in source but provably `number` via caller flow.
//   - After individual claims are collected, a call-graph closure pass
//     drops any function whose local callers OR local callees are not
//     themselves claimed. Rationale: the IR path replaces `typeIdx` on
//     the Wasm function record, so if a legacy-compiled caller already
//     emitted a `call` with the OLD signature, the post-IR module will
//     fail Wasm validation. Closing under both edges guarantees every
//     cross-function call in the module is legacy↔legacy or IR↔IR.
//
// Slice 4 (#1169d) — class instances accepted in OUTER functions:
//   - The selector recognises `TypeReferenceNode` referring to a class
//     declared in the same compilation unit. Functions whose params /
//     return are class-typed pass the type gate.
//   - `isPhase1Expr` accepts `NewExpression` (Identifier callee naming a
//     local class), `PropertyAccessExpression` on a (potentially) class
//     receiver, and `CallExpression` whose callee is a property-access on
//     a class receiver (method call).
//   - Statement-position `<obj>.<field> = <expr>` is allowed (in addition
//     to bare call expressions and the existing var-decl / if shapes).
//   - The selector accepts these shapes structurally; the actual
//     class-vs-non-class dispatch happens at the AST→IR lowering layer,
//     where the class registry is consulted to validate that the receiver
//     IS in fact a known class. If not, the lowerer throws and the
//     function falls back to legacy.
//   - Class methods themselves (and constructors) are NOT claimed in
//     slice 4 — they remain on the legacy class-bodies path. The
//     selector only scans top-level `ts.FunctionDeclaration` nodes.
//   - The call-graph closure tolerates calls into class constructors /
//     methods because those are LEGACY-compiled with stable signatures
//     before the IR runs (allocated by `collectClassDeclaration`). The
//     `localClasses` set drives that exemption.

import { ts, forEachChild } from "../ts-api.js";
import { collectIrSafeVarDeclarationLists } from "./function-local-var.js";
import { stringBuilderForcedLegacy } from "./string-builder-shape.js";
// (#1373b C-1) Pure-syntactic async helpers from the LEAF module (safe for
// ir/* — async-static.ts imports only ts-api, so no codegen/index cycle).
import { staticPromiseResolveSettledExpr, unwrapPromiseTypeNode } from "../codegen/async-static.js";
import { closureSignatureEquals, type IrClassShape, type IrClosureSignature, type IrType } from "./nodes.js";
import type { IrImportedFunctionResolver, IrResolvedFunctionTarget } from "./imported-functions.js";
import type { IrHostDateSnapshotResolver } from "./host-date.js";
import type { IrAmbientClassCallResolver, IrHostVoidCallbackResolver } from "./host-extern.js";
import type { IrPromiseDelayResolver } from "./promise-delay.js";
import { collectModuleInitPopulation, makeModuleInitSynthetic, MODULE_INIT_UNIT_NAME } from "./module-init.js";
export { collectModuleInitPopulation, makeModuleInitSynthetic, MODULE_INIT_UNIT_NAME } from "./module-init.js";

import { binaryOpCapability, hostExternCapability, prefixOpCapability } from "./capability.js";
import { isPristineEs5IntrinsicIsFrozenCall } from "./object-integrity.js";
import type {
  IrDeclaredPrimitiveExpressionFamily,
  IrLegacyLocalClassExpressionResolver,
  IrLegacyModuleBindingResolver,
  IrLocalClassExpressionResolver,
  IrModuleBindingResolver,
  IrPrimitiveExpressionFamily,
} from "./module-bindings.js";
import type { LatticeType, TypeMap } from "./propagate.js";
import type { RecursiveTypeEvidence } from "./type-evidence.js";

/**
 * #1169q telemetry — record why a top-level FunctionDeclaration didn't make
 * it into the IR claim set. The intent is to drive the legacy retirement:
 * once the count of unintended fallbacks (excluding deferred features) is
 * zero against the test262 corpus, the legacy expression / statement
 * emitters can be retired.
 */
export type IrFallbackReason =
  | "unnamed"
  | "type-parameters"
  | "non-export-modifier"
  | "async-generator"
  // (#1373) `async function` (without an asterisk) — distinguished from
  // `async-generator` (`async function*`) and from generic
  // `non-export-modifier` / `deferred-feature` so the IR-claim gate can
  // conditionally accept async functions when the standalone
  // `$Promise` + microtask-queue infra (#1326) is fully wired. Phase A
  // (this slice) just buckets them; Phase C wires the lowering.
  | "async-function"
  | "return-type-not-resolvable"
  | "param-type-not-resolvable"
  | "param-shape-rejected" // optional/rest/initializer/non-identifier/duplicate
  // #1372 — binding-pattern param shape too complex for slice 8a destructuring
  // (rest, defaults, nested patterns, computed keys). Distinguished from
  // `param-shape-rejected` so the param-shape bucket continues to track only
  // optional/rest/initializer/duplicate cases.
  | "destructuring-param-complex"
  | "body-shape-rejected"
  // #3529 P1 — checker/syntax-known producer gaps. These are selector-owned
  // Unsupported outcomes: the legacy body is intentionally retained before
  // AST -> IR construction starts, rather than relying on a builder throw.
  | "string-method-unsupported"
  | "array-method-unsupported"
  | "primitive-method-unsupported"
  | "function-invocation-method-unsupported"
  | "logical-value-unsupported"
  | "template-substitution-unsupported"
  | "error-constructor-unsupported"
  | "typed-array-constructor-unsupported"
  | "date-constructor-unsupported"
  | "regexp-constructor-unsupported"
  | "call-resolution-unsupported"
  | "call-arity-unsupported"
  | "constructor-resolution-unsupported"
  | "constructor-arity-unsupported"
  | "class-projection-unsupported"
  | "class-member-unsupported"
  | "external-call" // calls a non-local identifier (parseInt, etc.)
  | "call-graph-closure" // local caller/callee not claimed
  | "recursive-type-evidence" // recursive SCC failed conservative ABI certification
  | "type-resolution-failure" // overrideMap couldn't be built (set externally)
  // #1370 Phase A — class method / constructor of a shape the IR selector
  // doesn't yet handle. Examples: methods on a class with an `extends`
  // clause (Phase E — inheritance), get/set accessors, abstract methods,
  // computed property names. Distinguished from `body-shape-rejected` so a
  // future slice can tell "method-specific gate failure" apart from generic
  // body-shape rejections that apply to top-level FunctionDeclarations too.
  | "class-method"
  | "string-builder-candidate" // (#3740/#3744) kill-switch-forced legacy — see ./string-builder-shape.ts
  | "deferred-feature"; // permanently excluded (eval, with, import(), Proxy)

export interface IrFallback {
  readonly name: string;
  readonly reason: IrFallbackReason;
  /**
   * (#2856 Step-1) Opt-in diagnostic detail for `body-shape-rejected` — the
   * proximate reject arm + offending node kind (e.g. `stmt-assign-nonprop:
   * BinaryExpression`). Populated only when `JS2WASM_IR_SHAPE_DIAG=1`; `undefined`
   * on the normal path so the fallback record and the CI gate are byte-unchanged.
   */
  readonly detail?: string;
}

/**
 * (#2856 Step-1) Opt-in reject-arm recorder for the `body-shape-rejected`
 * bucket. The bucket's reason string ("body-shape-rejected") is uniform, so the
 * 31 rejections cannot be attributed to a specific `isPhase1*` reject arm from
 * the reason alone. When `JS2WASM_IR_SHAPE_DIAG=1`, every instrumented
 * `return false` in the Phase-1 shape gate first calls {@link shapeNo}, which
 * records a `"<arm>:<NodeKind>"` label. `whyNotIrClaimable` resets the recorder
 * per function and, when it ultimately returns `body-shape-rejected`, exposes
 * the FIRST recorded label (the proximate cause) via {@link takeShapeRejectDetail}.
 *
 * Behaviour is byte-identical when the env var is unset: `shapeNo` becomes a
 * bare `return false`, the recorder stays null, and no `detail` is attached.
 */
const SHAPE_DIAG_ON = process.env.JS2WASM_IR_SHAPE_DIAG === "1";
let shapeRejectDetail: string | null = null;
// #3529 P1 — stable reason paired with the existing boolean shape walk. The
// deep isPhase1* recursion deliberately remains boolean; a capability reject
// records its reason here and the subject boundary consumes it. First-wins is
// load-bearing: a nested generic wrapper must not erase the proximate reason.
let typedShapeRejectReason: IrFallbackReason | null = null;

/** Record the proximate reject arm (first-wins) and return false. */
function shapeNo(arm: string, node: ts.Node): false {
  if (SHAPE_DIAG_ON && shapeRejectDetail === null) {
    shapeRejectDetail = `${arm}:${ts.SyntaxKind[node.kind]}`;
  }
  return false;
}

/** Record a stable selector-owned Unsupported reason and return false. */
function capabilityNo(reason: IrFallbackReason, arm: string, node: ts.Node): false {
  if (typedShapeRejectReason === null) typedShapeRejectReason = reason;
  return shapeNo(arm, node);
}

/** Read and clear the recorded reject detail (used by `planIrCompilation`). */
function takeShapeRejectDetail(): string | undefined {
  const d = shapeRejectDetail ?? undefined;
  shapeRejectDetail = null;
  return d;
}

export type IrMathMethodPlan =
  | {
      readonly arity: 1;
      readonly op: "f64.abs" | "f64.sqrt" | "f64.floor" | "f64.ceil" | "f64.trunc";
    }
  | { readonly arity: 1 | 2; readonly helper: `Math_${string}` };

/**
 * Exact-arity Math surface shared by selection, call-graph closure, and the
 * AST→IR builder. Direct Wasm unary operations stay direct; transcendental
 * functions call the already-registered self-hosted `Math_<method>` helper.
 * Keeping arity in this table prevents selector/builder drift and preserves
 * ambient-Math identity checks at each consumer.
 */
export const IR_MATH_METHOD_TABLE: Readonly<Record<string, IrMathMethodPlan>> = {
  abs: { arity: 1, op: "f64.abs" },
  sqrt: { arity: 1, op: "f64.sqrt" },
  floor: { arity: 1, op: "f64.floor" },
  ceil: { arity: 1, op: "f64.ceil" },
  trunc: { arity: 1, op: "f64.trunc" },
  sin: { arity: 1, helper: "Math_sin" },
  cos: { arity: 1, helper: "Math_cos" },
  exp: { arity: 1, helper: "Math_exp" },
  log: { arity: 1, helper: "Math_log" },
  log2: { arity: 1, helper: "Math_log2" },
  pow: { arity: 2, helper: "Math_pow" },
  atan2: { arity: 2, helper: "Math_atan2" },
};

/** Compatibility view for callers/tests that only need the method names. */
export const IR_MATH_UNARY_WHITELIST: ReadonlySet<string> = new Set(
  Object.entries(IR_MATH_METHOD_TABLE)
    .filter(([, plan]) => plan.arity === 1)
    .map(([name]) => name),
);

/**
 * Map a whitelisted `Math.<name>` to its corresponding IR `f64.<op>` tag.
 * Lives next to the whitelist so callers (selector + lowerer) share one
 * source of truth.
 */
export function mathUnaryToIrOp(name: string): "f64.abs" | "f64.sqrt" | "f64.floor" | "f64.ceil" | "f64.trunc" | null {
  const plan = IR_MATH_METHOD_TABLE[name];
  return plan && "op" in plan ? plan.op : null;
}

export interface IrSelection {
  readonly funcs: ReadonlySet<string>;
  /** #1370 Phase A — synthetic-name set keyed by `${className}_${methodName}`
   *  for instance/static methods, and `${className}_new` for constructors.
   *  Populated when class members are IR-eligible. The naming convention
   *  matches `ctx.funcMap` (see `class-bodies.ts:216,275,284`) so Phase B
   *  can patch pre-allocated function slots by direct lookup.
   *
   *  Phase A is selector-only — the `IrSelection.classMembers` is reported
   *  but `compileIrPathFunctions` does NOT yet patch class-method bodies.
   *  Phase B wires the integration loop. */
  readonly classMembers?: ReadonlySet<string>;
  /** Top-level FunctionDeclaration names that did NOT make it into `funcs`,
   *  paired with the rejection reason. Only populated when
   *  `IrSelectionOptions.trackFallbacks` is true. */
  readonly fallbacks?: ReadonlyArray<IrFallback>;
  /** (#2138) Local call-graph edges (top-level FunctionDeclaration name →
   *  set of top-level FunctionDeclaration callee names in the same source
   *  file), exactly as computed by `buildLocalCallGraph` for the Step-2
   *  closure. Exposed so the IR-first compile-once inversion
   *  (`JS2WASM_IR_FIRST=1`) can decide which claimed functions are safe to
   *  skip on the legacy body pass WITHOUT re-deriving the call graph.
   *  Present only when Step 2 ran (i.e. at least one function was
   *  individually claimed); callers must treat a missing map as "no edge
   *  information" and behave conservatively. */
  readonly localCallees?: ReadonlyMap<string, ReadonlySet<string>>;
  /** (#3142) Module-level (top-level statement) claim assessment — gate G3
   *  of the legacy-frontend retirement. Slice 1 added the assessment
   *  (telemetry: the `check:ir-fallbacks` gate ratchets a `module-level`
   *  bucket from it); Slice 2 made it CLAIM-FEEDING — it is populated on
   *  every selection (production included) and `compileIrPathFunctions`
   *  lowers a claimable non-empty unit through from-ast/lower, patching the
   *  legacy `__module_init` slot in place. Any build/verify/lower failure
   *  demotes the whole unit back to the legacy body (which is always still
   *  emitted). */
  readonly moduleInit?: IrModuleInitAssessment;
}

/**
 * (#3142 Slice 1) Result of assessing the module-level statement list as a
 * synthetic IR claim unit (`<module-init>`). The population is every
 * top-level statement that is not a function / class / type / import /
 * export declaration — i.e. the statements the legacy path routes into
 * `__module_init` (approximated syntactically; the legacy collection in
 * `declarations.ts` additionally drops some side-effect-free forms, which
 * only makes this assessment conservative, never unsound).
 */
export interface IrModuleInitAssessment {
  /** Number of statements in the module-init population. `0` means the
   *  module is all declarations — vacuously claimable, nothing to adopt. */
  readonly stmtCount: number;
  /** `null` = claimable under the same per-kind rules as function bodies;
   *  otherwise the rejection reason (reuses `IrFallbackReason`, per the
   *  architect plan). */
  readonly reason: IrFallbackReason | null;
  /** (#2856 Step-1 parity) Reject-arm detail for `body-shape-rejected`,
   *  populated only when `JS2WASM_IR_SHAPE_DIAG=1`. */
  readonly detail?: string;
}

export interface IrSelectionOptions {
  readonly experimentalIR?: boolean;
  /** When true, the returned selection includes a `fallbacks` array listing
   *  every top-level FunctionDeclaration that the selector did NOT claim
   *  along with the reason it was rejected. Off by default — populating
   *  this list adds a small per-function overhead. */
  readonly trackFallbacks?: boolean;
  /**
   * Authoritative direct-callable projection for an unannotated parameter
   * whose source call sites establish a concrete scalar slot. The selector
   * consumes that decision instead of widening the parameter to `dynamic` and
   * withdrawing later on type parity.
   */
  readonly resolveImplicitParamType?: (
    parameter: ts.ParameterDeclaration,
  ) => "f64" | "bool" | "string" | "object" | "dynamic" | undefined;
  /**
   * Exact legacy callable-ABI proof for an unannotated parameter projected as
   * the ordinary non-fast numeric vec. General object/any evidence is not
   * sufficient for the module numeric-array direct-call bridge.
   */
  readonly implicitParamUsesNumericVecAbi?: (parameter: ts.ParameterDeclaration) => boolean;
  /**
   * Standalone/WASI normally close claims over local callers. A production
   * planner may exempt a callee when its direct callable and IR overlay share
   * one fully certified ABI, making a legacy caller's pre-emitted call safe.
   */
  readonly legacyCallerAbiIsProjected?: (declaration: ts.FunctionDeclaration) => boolean;
  /** Whether this backend configuration has the runtime bridges required by
   * dynamic arithmetic, named method calls, and mutable dynamic counters. */
  readonly dynamicRuntimeBuildable?: boolean;
  /**
   * Checker-backed certification for recursive call-graph components. A
   * rejected component is kept on the direct path even when optimistic
   * propagation found a scalar-looking signature. Accepted components still
   * pass every ordinary selector shape and closure gate.
   */
  readonly recursiveTypeEvidence?: RecursiveTypeEvidence;
  /**
   * (#1373b Slice 1) When true, async functions (no `*`) are eligible to
   * flow through the IR's CPS lowering (Phase C). When false (default),
   * the selector buckets them into the `"async-function"` fallback reason
   * and the legacy direct-codegen path takes over.
   *
   * Even when true, individual async functions are still rejected by the
   * selector if their body uses features the Phase C lowering can't handle
   * yet (try/catch around await — see `isAsyncIrReady`).
   *
   * Threaded from `CodegenContext.supportsAsyncIr` via `integration.ts`.
   */
  readonly supportsAsyncIr?: boolean;
  /**
   * (#1373b C-1) The ONE-engine consistency predicate: returns `true` when
   * the converged async engine (the #2906 `$AsyncFrame` drive / host-drive
   * machine, entry `decideAsyncActivation` in `async-activation.ts`) would
   * ACTIVATE for this async function declaration. The IR path claims an
   * async function IFF the engine declines it — the legacy synchronous
   * pass-through population — so engine-activated functions keep
   * byte-identical routing and the IR never builds a second suspension
   * machine (the #2367 graveyard rule).
   *
   * Bound by the real-compile call site (`planIrOverlay` in
   * codegen/index.ts) to `asyncEngineWouldActivate(ctx, fn)`. When ABSENT
   * (bare `planIrCompilation` callers without a codegen context), the gate
   * treats every async fn as engine-claimed — the safe default: never
   * IR-claim without the engine's verdict.
   */
  readonly asyncEngineClaims?: (fn: ts.FunctionLikeDeclaration) => boolean;
  /**
   * (#2856) Host-extern support — resolves a bare identifier that is NOT a
   * local/param binding to an ambient host global (`document`, `console`, …).
   * Returns the extern class name (`"Document"`, `"Console"`) when the
   * identifier's real binding (checker-resolved, so user shadowing wins) is a
   * lib `declare var` of extern-class shape that the legacy backend would
   * register (`isExternalDeclaredClass` parity); `undefined` otherwise.
   *
   * Provided by the `planIrCompilation` call sites (codegen index /
   * check-ir-fallbacks), which own a TypeChecker; select.ts stays
   * checker-free. Only consulted when `jsHostExterns` is true — the
   * capability is mode-gated via `hostExternCapability` (capability.ts):
   * standalone/wasi/strictNoHostImports defer to legacy, which routes
   * `document.*` to the existing #1472/#2907 refusal.
   */
  readonly resolveHostGlobal?: (node: ts.Identifier) => string | undefined;
  /**
   * (#2856 Capability C) Checker-backed module lexical binding resolver.
   * It returns the actual top-level VariableDeclaration, never a flat name,
   * so same-named locals/params/for-loop bindings cannot alias a module slot.
   * Passing `writeValue` additionally proves mutability and supported
   * write-side representation before the selector claims the function.
   */
  readonly resolveModuleBinding?: IrModuleBindingResolver | IrLegacyModuleBindingResolver;
  /** (#2856) True iff the compile targets a JS host (NOT standalone / wasi /
   *  strictNoHostImports). Gates the host-extern capability. */
  readonly jsHostExterns?: boolean;
  /**
   * Proven primitive value family used by coercion-sensitive builtin
   * acceptance. Invalid local annotations and type assertions return
   * `undefined`; this is evidence, not receiver routing.
   */
  readonly classifyPrimitiveExpression?: (expr: ts.Expression) => IrPrimitiveExpressionFamily | undefined;
  /**
   * Declared checker family used only to route builtin-named method calls.
   * Mixed/nullable primitive unions return `primitive-union`; pure
   * class/extern and any/unknown receivers return `undefined` so they keep
   * ordinary conservative dispatch.
   */
  readonly classifyDeclaredPrimitiveExpression?: (
    expr: ts.Expression,
  ) => IrDeclaredPrimitiveExpressionFamily | undefined;
  /**
   * Checker-backed proof that an expression is an Array or tuple. Used to
   * keep Array prototype methods without IR producers out of the claimed set
   * while preserving same-named methods on local classes.
   */
  readonly isArrayExpression?: (expr: ts.Expression) => boolean;
  /**
   * Checker-backed proof that an expression has the ambient lib `RegExp`
   * type. Host-free targets use it to defer `.test`/`.exec` to native
   * standalone codegen instead of selecting the host-extern IR ABI.
   */
  readonly isRegExpExpression?: (expr: ts.Expression) => boolean;
  /**
   * Checker-only ambient identity proof used by Math call selection when a
   * backend deliberately does not install the module-binding capability.
   * Absent means unproven: bare selector callers stay shadow-safe.
   */
  readonly isAmbientBinding?: (node: ts.Identifier) => boolean;
  /** True only when the active backend can resolve `Math_<method>` helpers. */
  readonly supportsSymbolicMathHelpers?: boolean;
  /** Backend owns a no-radix f64 → abstract-string formatter. */
  readonly supportsNumberToString?: boolean;
  /**
   * True when the active backend explicitly supports the selector's exact
   * literal-string `String.replace(search, replacement)` slice. Backends
   * without a matching method plan reject before claim instead of becoming a
   * build demotion.
   */
  readonly supportsLiteralStringReplace?: boolean;
  /**
   * True only when the active backend can materialise a fixed array of
   * checker-proven strings as an externref vec. The default is false: native
   * strings and host-free lanes use a different string carrier and must stay
   * on the legacy path instead of failing after an IR claim.
   */
  readonly supportsHostStringArrayLiterals?: boolean;
  /**
   * (#3053 U2) True iff the unified gc member-read primitive `__dyn_member_get`
   * (#3053 U0) has a SOUND body in this compile config. The gc `$AnyValue` body
   * reads via native `__extern_get` and re-boxes with the native honest
   * classifier (`$AnyString`/`$Object` shaped) — which is correct in
   * fast+standalone/wasi (uniform native value-rep) and in every non-fast
   * (externref-carrier) config (thin `__extern_get` wrapper), but NOT in
   * `fast && !standalone && !wasi` (host js-string): there the carrier is the gc
   * `$AnyValue` yet strings are host js-string externrefs, so the classifier
   * mis-tags them and the emitted body is invalid. In that ONE config the
   * selector must NOT claim a dynamic member read (a clean pre-claim rejection,
   * keeping the function in `param-/return-type-not-resolvable`) rather than
   * claim-then-demote. Provided by the real-compile call site from `ctx`; the
   * default (undefined ⇒ true) is correct for the default-host fallback path.
   */
  readonly dynMemberReadBuildable?: boolean;
  /**
   * #2952 slice 5 — certify that this exact `for (head in receiver)` source
   * expression uses the non-fast dynamic externref carrier. The callback is
   * checker-backed in production and absent for bare selector callers, so the
   * new loop shape is never claimed for a typed object, a fast `$AnyValue`
   * carrier, or an unproven receiver.
   */
  readonly isDynamicForInReceiver?: (receiver: ts.Expression) => boolean;
  /** (#3214 A+B1) Checker-backed imports; omitted by host-free and bare selector callers. */
  readonly importedFunctions?: IrImportedFunctionResolver;
  /** (#3657) Checker-certified class-member calls to same-file primitive host stubs. */
  readonly ambientClassCalls?: IrAmbientClassCallResolver;
  /**
   * (#3214 B2) Checker-certified direct ambient `addEventListener` callback
   * sites. Omitted in host-free modes and bare selector callers so arrows do
   * not widen accidentally outside the production/gate shared proof.
   */
  readonly hostVoidCallbacks?: IrHostVoidCallbackResolver;
  /** Exact checker-certified ambient zero-arg Date snapshots (Calendar). */
  readonly hostDateSnapshots?: IrHostDateSnapshotResolver;
  /**
   * Exact checker-backed class descriptors built by `buildIrClassShapes`.
   * When present, selection treats this registry as authoritative for class
   * existence, fields, methods, accessors, constructor arity, and parent
   * projection. Bare selector callers may omit it and use the conservative
   * syntax mirror below.
   */
  readonly projectedClassShapes?: ReadonlyMap<string, IrClassShape>;
  /**
   * Checker-backed identity for expressions whose value is an instance of a
   * projected local class. The callback returns the declaration's exact local
   * class name, not a textual guess. Production callers can therefore carry
   * class evidence through conditionals, fields/getters, and static method
   * results; bare selector callers omit it and use the conservative syntax
   * proofs below.
   */
  readonly resolveLocalClassExpression?: IrLocalClassExpressionResolver | IrLegacyLocalClassExpressionResolver;
  /**
   * #3529 P1/P4 structural target-capability seam. P1 stays independent of
   * backend/legality.ts; P4 wires its exported capability predicate here.
   * An explicit false prevents an ambient Date snapshot from being claimed
   * even if its checker shape is otherwise exact.
   */
  readonly supportsBackendCapability?: (
    capability:
      | "host-date-snapshot"
      | "host-regexp-constructor"
      | "host-object-define-property"
      | "standalone-native-regexp-test-carrier"
      | "legacy-numeric-array-global",
  ) => boolean;
  /**
   * #3787 exact global String-constructor identity. This is separate from the
   * declaration-file-only ambient predicate because allowJs programs can be
   * compiled without lib declarations, leaving a genuine global unresolved.
   */
  readonly isAmbientStringBinding?: (node: ts.Identifier) => boolean;
  /**
   * (#2856 async-delay slice) Exact checker-certified
   * `new Promise<number>((resolve) => { setTimeout(...); })` construction.
   * Omitted by bare-selector and host-free/M0 callers, so generic arrow/new
   * selection remains unchanged outside the one production proof.
   */
  readonly promiseDelays?: IrPromiseDelayResolver;
}

/**
 * (#1373b C-1) Centralised gate for whether the IR path can claim a given
 * async function. C-1 opens the gate for the SYNC-PASS-THROUGH population
 * only — async function DECLARATIONS the converged engine declines
 * (`asyncEngineClaims(fn) === false`). Engine-activated functions (genuinely
 * suspending, engine-drivable shapes) stay on the `$AsyncFrame` machine;
 * claiming one here would regress real suspension back to sync semantics.
 *
 * Accepting here only opens the door: the normal Phase-1 body-shape pipeline
 * still runs (with `await` accepted via the `isPhase1Expr` arm), so anything
 * the IR can't build stays legacy (correct-or-legacy).
 *
 * Out of C-1 scope (kept in their fallback buckets):
 *   - async methods / arrows / function expressions (#2957 activation paths);
 *   - async generators (`async-generator` bucket, engine 3d lanes);
 *   - bodies containing `for await` (engine 3b/3dii lanes) or nested async
 *     function-likes (closure-lifted async lowering not wired).
 */
export function isAsyncIrReady(options: IrSelectionOptions | undefined, fn: ts.FunctionLikeDeclaration): boolean {
  if (!options?.supportsAsyncIr) return false;
  // C-1 scope: top-level function declarations only.
  if (!ts.isFunctionDeclaration(fn)) return false;
  if (fn.asteriskToken) return false; // async generator — never this gate
  if (!fn.body) return false;
  // ONE-engine invariant: without the engine's verdict, never claim.
  if (options.asyncEngineClaims === undefined) return false;
  if (options.asyncEngineClaims(fn)) return false;
  // Body-scope bounds: `for await` and nested async function-likes are out.
  if (bodyHasAsyncOutOfIrScope(fn.body)) return false;
  return true;
}

/**
 * (#1373b C-1) Walk an async fn body for shapes the C-1 claim excludes:
 * `for await` loops and nested async function-likes (async arrows / function
 * expressions / declarations — their lowering rides the closure-lift path,
 * which has no async arm yet).
 */
function bodyHasAsyncOutOfIrScope(body: ts.Node): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (ts.isForOfStatement(node) && node.awaitModifier) {
      found = true;
      return;
    }
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(body, walk);
  return found;
}

const EMPTY: IrSelection = { funcs: new Set<string>() };

function legacyCallerAbiIsProjected(
  options: IrSelectionOptions | undefined,
  declarations: ReadonlyMap<string, ts.FunctionDeclaration>,
  name: string,
): boolean {
  const declaration = declarations.get(name);
  return declaration !== undefined && options?.legacyCallerAbiIsProjected?.(declaration) === true;
}

export function planIrCompilation(
  sourceFile: ts.SourceFile,
  options?: IrSelectionOptions,
  typeMap?: TypeMap,
): IrSelection {
  if (!options?.experimentalIR) return EMPTY;

  // Slice 4 (#1169d): scan classes declared in this compilation unit.
  // Their names participate in:
  //   - param/return type recognition (a TypeReferenceNode pointing to a
  //     local class is a valid IR-claimable type, like primitives).
  //   - the call-graph closure: `new <className>(...)` and
  //     `instance.method(...)` are NOT external calls because the legacy
  //     `collectClassDeclaration` pass has registered constructors and
  //     methods with stable signatures before the IR runs.
  currentLocalClassDeclarations = collectLocalClassDeclarations(sourceFile);
  const localClasses = new Set(currentLocalClassDeclarations.keys());

  // -------------------------------------------------------------------------
  // Step 1: individual per-function claim.
  //
  // A function is individually-claimable iff its shape is Phase-1-compatible
  // AND every param / return resolves to a concrete primitive (f64/bool).
  // Types come either from explicit TS annotations (classic path) or from
  // the TypeMap (propagation path).
  // -------------------------------------------------------------------------
  const individuallyClaimed = new Set<string>();
  const declByName = new Map<string, ts.FunctionDeclaration>();
  // #1169q telemetry — collect rejection reasons so the dispatcher can
  // log/throw on legacy fallback. Only populated when trackFallbacks is on.
  const trackFallbacks = options?.trackFallbacks === true;
  // (#2856) Arm the host-extern identifier resolution for this run. Mode-gated
  // via the capability table: only a JS-host compile may claim host-global
  // shapes; standalone/wasi defer so legacy keeps its #1472/#2907 refusal.
  currentHostGlobalResolver =
    options?.resolveHostGlobal && hostExternCapability(options?.jsHostExterns === true) !== "defer"
      ? options.resolveHostGlobal
      : null;
  currentModuleBindingResolver = options?.resolveModuleBinding ?? null;
  // (#1373b C-1) Arm the async claim gate for this run (consulted by
  // `whyNotIrClaimable`'s async-modifier arm via `isAsyncIrReady`), and
  // collect the top-level async declaration names for the await-only
  // consumption rule in the call arm.
  currentSelectionOptions = options;
  {
    const asyncNames = new Set<string>();
    for (const stmt of sourceFile.statements) {
      if (
        ts.isFunctionDeclaration(stmt) &&
        stmt.name &&
        stmt.body &&
        !stmt.asteriskToken &&
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        asyncNames.add(stmt.name.text);
      }
    }
    currentAsyncDeclNames = asyncNames;
  }
  // (#3053 U2) Latch the config-soundness of the gc member-read primitive for
  // this run (default true = the sound default-host / fallback path). Read by
  // `dynamicUsesAreMoveOnly` to gate the dynamic member/element-access claim.
  currentDynMemberReadBuildable = options?.dynMemberReadBuildable ?? true;
  currentDynamicRuntimeBuildable = options?.dynamicRuntimeBuildable ?? true;
  const fallbackReasons = new Map<string, IrFallbackReason>();
  // (#2856 Step-1) Parallel to `fallbackReasons`: the opt-in reject-arm detail
  // for `body-shape-rejected` entries (populated only when JS2WASM_IR_SHAPE_DIAG=1).
  const fallbackDetails = new Map<string, string>();
  const captureShapeDetail = (name: string, reason: IrFallbackReason): void => {
    if (!SHAPE_DIAG_ON) return;
    if (reason !== "body-shape-rejected") return;
    // A `body-shape-rejected` that reached an as-yet-uninstrumented helper arm
    // (e.g. inside `isPhase1ObjectLiteral` / `isPhase1TryStatement` /
    // `isPhase1ClosureLiteral`) records nothing; label it `unattributed-arm`
    // so the histogram still accounts for all rejections (completeness).
    fallbackDetails.set(name, takeShapeRejectDetail() ?? "unattributed-arm:helper-internal");
  };
  // Track unnamed FunctionDeclarations too (rare but possible — `default`
  // export of an anonymous function, etc.) so callers can see them.
  let unnamedCount = 0;
  // #2949 slice 2 — pre-collect ALL top-level FunctionDeclarations before the
  // per-function claim loop so `dynamicUsesAreMoveOnly` can resolve CALLEE
  // param/return dynamic-ness independent of declaration order (the loop
  // below fills `declByName` incrementally, which would miss later-declared
  // callees). Module-level for the usual isPhase1* threading reason.
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) declByName.set(stmt.name.text, stmt);
  }
  configureDynamicScanSource(sourceFile, declByName);
  for (const stmt of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(stmt)) continue;
    // Ambient declarations and overload signatures have no executable body
    // and no direct-codegen slot. Only the implementation joins selection.
    if (!stmt.body) continue;
    if (!stmt.name) {
      if (trackFallbacks) unnamedCount++;
      continue;
    }
    declByName.set(stmt.name.text, stmt);
    const recursiveDecision = options?.recursiveTypeEvidence?.decisions.get(stmt.name.text);
    const reason =
      recursiveDecision?.accepted === false
        ? "recursive-type-evidence"
        : trackFallbacks
          ? whyNotIrClaimable(stmt, typeMap, localClasses)
          : isIrClaimable(stmt, typeMap, localClasses)
            ? null
            : "param-shape-rejected"; // sentinel — not used when trackFallbacks=false
    if (reason === null) {
      individuallyClaimed.add(stmt.name.text);
    } else if (trackFallbacks) {
      fallbackReasons.set(stmt.name.text, reason);
      if (reason === "recursive-type-evidence" && recursiveDecision?.detail) {
        fallbackDetails.set(stmt.name.text, recursiveDecision.detail);
      } else {
        captureShapeDetail(stmt.name.text, reason);
      }
    }
  }

  // -------------------------------------------------------------------------
  // #1370 Phase A — class methods + constructors.
  //
  // For each top-level class declaration, walk its members and claim:
  //   - the constructor (synthetic name `${ClassName}_new`),
  //   - each instance method (`${ClassName}_${methodName}`),
  //   - each static method (same shape — class-bodies.ts uses the same
  //     `${className}_${methodName}` key for static and instance).
  //
  // Method bodies use the SAME shape rules as FunctionDeclarations (the
  // existing `isPhase1StatementList`). The legacy `collectClassDeclaration`
  // pass in `class-bodies.ts` pre-allocates funcMap entries with stable
  // signatures BEFORE `compileIrPathFunctions` runs, which means Phase B
  // (when wired) will patch existing slots rather than reserve new ones.
  //
  // Phase A scope:
  //   - Flat classes only — classes with `extends` defer to Phase E
  //     (inheritance + super.method() lowering).
  //   - Identifier / string-literal / numeric-literal property names only.
  //   - No async, no generators (deferred-feature), no abstract, no
  //     get/set accessors (class-method).
  //
  // Phase A is **selector-only**: `compileIrPathFunctions` does not yet
  // patch class-method bodies. Phase B will iterate `classMembers` and do
  // the integration. Until then, populating `classMembers` is informative —
  // the legacy `class-bodies.ts` path continues to emit the methods.
  // -------------------------------------------------------------------------
  const individuallyClaimedClassMembers = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isClassDeclaration(stmt)) continue;
    if (!stmt.name) continue; // anonymous / default-export class — Phase A skips
    const className = stmt.name.text;
    const classHasKnownProjectionGap = localClassHasKnownProjectionGap(className);
    // Phase A doesn't support `super` — skip classes with any heritage clause
    // that introduces a parent (TS allows `implements` clauses too, which are
    // erased at emit time and don't affect codegen, so only `extends` is
    // disqualifying). Track the rejection reason for every method so the
    // telemetry shows them as `class-method` rather than silently dropping.
    const hasParent = stmt.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) ?? false;
    // #3000-E: a subclass whose parent is a locally-declared user class is
    // IR-claimable — `super(...)` chains to the parent's `_init` and
    // `super.method()` static-dispatches to the parent slot (both need the
    // parent's WasmGC struct, which only a local user class has). A subclass of a
    // builtin / externref-backed parent (`extends Error`, `extends Uint8Array`)
    // stays deferred: `super` there routes through host `__new_<Parent>` shapes
    // the IR doesn't model. `buildIrClassShapes` mirrors this exact predicate, so
    // a claim here always finds a shape in Phase B (no post-claim demotion).
    const parentName = extendsParentName(stmt);
    const parentIsLocalClass = parentName !== null && localClasses.has(parentName);
    // The legacy funcMap uses one `${className}_${methodName}` key for both
    // static and instance methods. Patching either side when both declarations
    // exist can target the other side's ABI slot, and the winner otherwise
    // depends on source order. Precompute the collision and suppress BOTH
    // claims deterministically.
    const methodKindsByName = new Map<string, number>();
    for (const candidate of stmt.members) {
      if (!ts.isMethodDeclaration(candidate) || !candidate.name) continue;
      const name = phase1MemberName(candidate.name);
      if (name === null) continue;
      const kind = classElementIsStatic(candidate) ? 2 : 1;
      methodKindsByName.set(name, (methodKindsByName.get(name) ?? 0) | kind);
    }
    const staticInstanceMethodCollisions = new Set(
      [...methodKindsByName].filter(([, kinds]) => kinds === 3).map(([name]) => name),
    );
    for (const member of stmt.members) {
      let memberName: string;
      let memberNode:
        | ts.MethodDeclaration
        | ts.ConstructorDeclaration
        // #3000-B: accessors join the claimable member kinds.
        | ts.GetAccessorDeclaration
        | ts.SetAccessorDeclaration;
      if (ts.isConstructorDeclaration(member)) {
        if (!member.body) continue;
        memberName = `${className}_new`;
        memberNode = member;
      } else if (ts.isMethodDeclaration(member)) {
        if (!member.body) continue;
        if (!member.name) {
          // Defensive — TS parser always populates `.name` for
          // MethodDeclaration; the `null` branch is unreachable in practice.
          continue;
        }
        const methodNameRaw = phase1MemberName(member.name);
        if (methodNameRaw === null) {
          // Computed property name (`[expr]() {}`) or private identifier
          // (`#name() {}`) — Phase A doesn't claim these.
          if (trackFallbacks) {
            fallbackReasons.set(`${className}_<computed>`, "class-method");
          }
          continue;
        }
        memberName = `${className}_${methodNameRaw}`;
        if (staticInstanceMethodCollisions.has(methodNameRaw)) {
          individuallyClaimedClassMembers.delete(memberName);
          if (trackFallbacks) fallbackReasons.set(memberName, "class-member-unsupported");
          continue;
        }
        memberNode = member;
      } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        if (!member.body) continue;
        // #3000-B: get/set accessors. The legacy path (`class-bodies.ts`)
        // registers them under DISTINCT `${className}_get_${prop}` /
        // `${className}_set_${prop}` funcMap keys — a getter and a setter of
        // the same name are two separate slots, not a collapsed one. Claim
        // each independently under the matching key so the Phase B walk and
        // the funcMap slot patch agree.
        const isGet = ts.isGetAccessorDeclaration(member);
        const propName = member.name ? phase1MemberName(member.name) : null;
        if (propName === null) {
          // Computed / private accessor name — not claimed.
          if (trackFallbacks) {
            fallbackReasons.set(`${className}_${isGet ? "get" : "set"}_<computed>`, "class-method");
          }
          continue;
        }
        const accessorKey = `${className}_${isGet ? "get" : "set"}_${propName}`;
        // Static accessors use a different funcMap-entry shape (no `self`
        // injection) — defer them alongside static-method internals, mirroring
        // the instance-only restriction in the Phase B integration walk.
        const isStaticAccessor = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
        if (isStaticAccessor) {
          if (trackFallbacks) fallbackReasons.set(accessorKey, "class-method");
          continue;
        }
        memberName = accessorKey;
        memberNode = member;
      } else {
        // PropertyDeclaration (field), IndexSignatureDeclaration,
        // SemicolonClassElement, ClassStaticBlockDeclaration — none are
        // claimed (not functions — out of IR's scope).
        continue;
      }
      // (#2857 static-method slice) A `static` method compiles to an ordinary
      // function — no `self` injection, no dependency on the (parent-prefixed)
      // instance layout. So even when the class `extends` a parent, a static
      // method whose body does not reference `super` is exactly as IR-claimable
      // as the same method in a flat class (cf. `Animal_kingdom`, already
      // claimed). Let it fall through to the normal `whyNotIrClaimable` gate;
      // only instance members and `super`-using statics need the inheritance
      // substrate deferred to the Phase E slice, which stay `class-method`.
      const isStaticMethod =
        ts.isMethodDeclaration(memberNode) &&
        (memberNode.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false);
      const exactShapes = currentSelectionOptions?.projectedClassShapes;
      if (exactShapes && !ts.isConstructorDeclaration(memberNode)) {
        const descriptorName = memberNode.name ? phase1MemberName(memberNode.name) : null;
        const descriptorKind = ts.isMethodDeclaration(memberNode)
          ? isStaticMethod
            ? "static"
            : "method"
          : ts.isGetAccessorDeclaration(memberNode)
            ? "getter"
            : "setter";
        const exactDescriptor =
          descriptorName === null
            ? undefined
            : exactShapes
                .get(className)
                ?.methods.find(
                  (candidate) =>
                    candidate.name === descriptorName && (candidate.memberKind ?? "method") === descriptorKind,
                );
        if (!exactDescriptor) {
          individuallyClaimedClassMembers.delete(memberName);
          if (trackFallbacks) fallbackReasons.set(memberName, "class-member-unsupported");
          continue;
        }
      }
      // A static method body has no class-shaped `self`; checker failure to
      // project an unrelated instance field/method must not suppress this
      // otherwise primitive function. Instance members still require the
      // exact class descriptor used by the builder.
      if (classHasKnownProjectionGap && !isStaticMethod) {
        if (trackFallbacks) fallbackReasons.set(memberName, "class-projection-unsupported");
        continue;
      }
      // A static method with no `super` is claimable under ANY parent (#2857 —
      // no instance layout dependency). #3000-E adds: INSTANCE members (ctor /
      // method / accessor) are claimable when the parent is a local user class
      // (the inheritance/`super` substrate provides `super(...)` → parent `_init`
      // and `super.method()` → parent slot, both keyed on the instance `this`). A
      // `super`-using STATIC stays deferred — static `super` is a class-object
      // mechanism the IR path (which keys `super` off `this`) does not model. The
      // body-shape gate (`whyNotIrClaimable`, which now accepts instance `super`)
      // still runs below — this only lifts the wholesale `hasParent` reject.
      const claimableUnderParent = isStaticMethod ? !referencesSuper(memberNode) : parentIsLocalClass;
      if (hasParent && !claimableUnderParent) {
        if (trackFallbacks) fallbackReasons.set(memberName, "class-method");
        continue;
      }
      const reason = trackFallbacks
        ? whyNotIrClaimable(memberNode, typeMap, localClasses, /*isMethod*/ true)
        : isIrClaimable(memberNode, typeMap, localClasses, /*isMethod*/ true)
          ? null
          : "class-method"; // sentinel — not used when trackFallbacks=false
      if (reason === null) {
        individuallyClaimedClassMembers.add(memberName);
      } else if (trackFallbacks) {
        fallbackReasons.set(memberName, reason);
        captureShapeDetail(memberName, reason);
      }
    }
  }

  if (individuallyClaimed.size === 0) {
    // Phase A: even when no top-level FunctionDeclaration is claimed, the
    // class-member walk above may have populated `individuallyClaimedClassMembers`.
    // Emit a selection that carries those even though `funcs` is empty.
    if (!trackFallbacks) {
      // (#3142 Slice 2) The module-init assessment is claim-feeding now, so
      // production selections carry it too — a module can have a claimable
      // init unit (zero local calls) even with no claimed functions.
      const prodModuleInit = assessModuleInit(sourceFile, new Set<string>(), declByName, localClasses);
      if (individuallyClaimedClassMembers.size === 0) {
        return { funcs: new Set<string>(), moduleInit: prodModuleInit };
      }
      return { funcs: new Set<string>(), classMembers: individuallyClaimedClassMembers, moduleInit: prodModuleInit };
    }
    const fallbacks: IrFallback[] = [];
    for (const [name, reason] of fallbackReasons) fallbacks.push({ name, reason, detail: fallbackDetails.get(name) });
    for (let i = 0; i < unnamedCount; i++) fallbacks.push({ name: `<unnamed:${i}>`, reason: "unnamed" });
    // (#3142 Slice 1) Module-init assessment — no top-level function is
    // claimed on this path, so any local callee rejects the unit.
    const moduleInit = assessModuleInit(sourceFile, new Set<string>(), declByName, localClasses);
    if (individuallyClaimedClassMembers.size === 0) {
      return { funcs: new Set<string>(), fallbacks, moduleInit };
    }
    return { funcs: new Set<string>(), classMembers: individuallyClaimedClassMembers, fallbacks, moduleInit };
  }

  // -------------------------------------------------------------------------
  // Step 2: call-graph closure.
  //
  // Build each function's set of local callers + local callees (restricted
  // to functions declared in this source file). Iteratively remove any
  // claimed function whose LOCAL callee is not also claimed (and, in
  // standalone/wasi, whose LOCAL caller is not claimed either — see below).
  // Repeat until stable.
  //
  // This safeguards against signature mismatch: the IR path replaces a
  // function's typeIdx after the legacy path has already compiled its
  // callers' bodies. Ensuring both sides of every cross-function edge are
  // on the same side (IR or legacy) avoids cross-signature `call` ops.
  //
  // #2858 — the CALLER direction of this closure is only demoted OUTSIDE
  // JS-host mode. Rationale:
  //   * A legacy caller of an IR-claimed callee is signature-safe: the
  //     callee's funcIdx is pre-allocated by legacy `compileDeclarations`
  //     and its signature is derived from the same TS annotations via the
  //     same mode-consistent `resolvePositionType`/`resolveWasmType`. The
  //     historical `f(x: any)` fast-mode ABI divergence that motivated the
  //     caller-direction demotion was eliminated by #2949 slice 3b
  //     (AnyKeyword → `irDynamic()`: one `any` ABI for both front-ends in
  //     both modes). So in host mode the caller-direction demotion is an
  //     obsolete safeguard — dropping it claims individually-claimable leaf
  //     helpers whose only unclaimed edge is a legacy caller, driving the
  //     `call-graph-closure` bucket (measured in host mode) to zero with
  //     zero post-claim demotions (verified: DOM/benchmark corpus).
  //   * In standalone / wasi (`jsHostExterns` false) IR coverage still has
  //     gaps (host-only ops such as f64 `.toString()`, `Map`), so a
  //     claimed function whose caller defers can surface a *latent*
  //     post-claim failure that the caller-direction demotion incidentally
  //     masks (e.g. `joinNums` in `algorithms.ts` under wasi). Keep the
  //     conservative caller-direction demotion there until those callee
  //     bodies are rejected up front by the body-shape work (#2856/#2857).
  // -------------------------------------------------------------------------
  const demoteOnLegacyCaller = options?.jsHostExterns !== true;
  // #3214 A+B1 — B0 made an exact FunctionTypeNode source boundary use the
  // canonical externref callable ABI in both front-ends.  Host mode can now use
  // the same caller-direction relaxation for callable-param functions as for
  // scalar leaves. Standalone/WASI retain the conservative closure until B1 is
  // explicitly implemented for their carrier/runtime.
  const { callers, callees, hasExternalCall } = buildLocalCallGraph(declByName, localClasses);

  const claimed = new Set(individuallyClaimed);
  // Immediately drop functions that call non-local identifier functions
  // (e.g. parseInt, String, Number, isNaN). from-ast.ts throws for unknown
  // callees; the call-graph closure only tracks local edges so external
  // calls slipped through — catching them here prevents compile_errors.
  for (const name of [...claimed]) {
    if (hasExternalCall.has(name)) {
      claimed.delete(name);
      if (trackFallbacks) fallbackReasons.set(name, "external-call");
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...claimed]) {
      const myCallees = callees.get(name) ?? new Set<string>();
      let safe = true;
      // Standalone/WASI keep caller closure unless production certifies one exact ABI.
      if (demoteOnLegacyCaller && !legacyCallerAbiIsProjected(options, declByName, name)) {
        const myCallers = callers.get(name) ?? new Set<string>();
        for (const c of myCallers) {
          if (!claimed.has(c)) {
            safe = false;
            break;
          }
        }
      }
      if (safe) {
        for (const c of myCallees) {
          if (!claimed.has(c)) {
            safe = false;
            break;
          }
        }
      }
      if (!safe) {
        claimed.delete(name);
        if (trackFallbacks) fallbackReasons.set(name, "call-graph-closure");
        changed = true;
      }
    }
  }

  // #1370 Phase A: thread the class-member claim set through the final
  // return. The set is `undefined` when empty so consumers can check for
  // its presence cheaply (and keeps existing fixtures stable when no class
  // declarations are present).
  const classMembers = individuallyClaimedClassMembers.size > 0 ? individuallyClaimedClassMembers : undefined;

  if (!trackFallbacks) {
    // (#3142 Slice 2) Claim-feeding module-init assessment on the production
    // path — same FINAL-claimed-set gating as the telemetry arm below.
    const prodModuleInit = assessModuleInit(sourceFile, claimed, declByName, localClasses);
    return classMembers
      ? { funcs: claimed, classMembers, localCallees: callees, moduleInit: prodModuleInit }
      : { funcs: claimed, localCallees: callees, moduleInit: prodModuleInit };
  }

  const fallbacks: IrFallback[] = [];
  for (const [name, reason] of fallbackReasons) fallbacks.push({ name, reason, detail: fallbackDetails.get(name) });
  for (let i = 0; i < unnamedCount; i++) fallbacks.push({ name: `<unnamed:${i}>`, reason: "unnamed" });
  // (#3142 Slice 1) Module-init assessment against the FINAL claimed set —
  // runs after the Step-2 closure so `call-graph-closure` verdicts match
  // what Slice 2's lowering will actually be able to link against.
  const moduleInit = assessModuleInit(sourceFile, claimed, declByName, localClasses);
  return classMembers
    ? { funcs: claimed, classMembers, fallbacks, localCallees: callees, moduleInit }
    : { funcs: claimed, fallbacks, localCallees: callees, moduleInit };
}

// ---------------------------------------------------------------------------
// Individual-claim check
// ---------------------------------------------------------------------------

/**
 * #1370 Phase A: a node accepted by the per-function IR claim check. The
 * three shapes share enough surface (`.parameters`, `.body`, `.type`,
 * `.modifiers`, `.typeParameters`, `.asteriskToken`) that the existing
 * `whyNotIrClaimable` body works almost verbatim once the input type is
 * widened. The `isMethod` flag at the call site distinguishes
 * FunctionDeclaration (top-level, with required name and Slice-1+ rules)
 * from MethodDeclaration / ConstructorDeclaration (class-owned, with
 * extra method-specific guards).
 */
export type IrClaimableSubject =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  // #3000-B: get/set accessors are claimable as no-arg / one-arg instance
  // members over a private (or public) slot. A getter's return type comes from
  // `fn.type`; a setter is inherently void (handled explicitly below).
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/**
 * Variant of `isIrClaimable` that returns the rejection reason instead of a
 * boolean. Returns null on accept. Used by `planIrCompilation` when
 * `trackFallbacks` is enabled so the dispatcher can log/throw with a useful
 * cause for each legacy fallback. Mirrors `isIrClaimable` exactly — keep the
 * two in sync.
 *
 * #1370 Phase A: widened to also accept ts.MethodDeclaration and
 * ts.ConstructorDeclaration. Pass `isMethod=true` when invoked for a class
 * member; the function applies the same body / param / return-type gate as
 * for top-level FunctionDeclarations, with method-specific guards added
 * inline (no name → ConstructorDeclaration is fine; computed name →
 * `class-method`; async/generator/abstract methods are filtered ahead of
 * this call so the existing reasons (`body-shape-rejected`,
 * `deferred-feature`) cover them).
 */
/**
 * (#2856 C1) Early-return context for the CURRENT function's body walk.
 * Module-level for the same isPhase1* threading reason as
 * `currentHostGlobalResolver`. The `ReturnStatement` arm of
 * `isPhase1BodyStatement` accepts an early return only when
 *   - `earlyReturnLoopDepth > 0` — we are inside a C-style `while`/`for`/
 *     `do` body (the Wasm `return` op is exactly JS's early exit there), AND
 *   - `earlyReturnBarrierDepth === 0` — NO enclosing for-of body (iterator
 *     `return()` cleanup would be skipped), try/catch/finally body (inlined
 *     finally would be skipped), or constructor body (returns route through
 *     the implicit `return this` synthesis), AND
 *   - the function is not a generator (`currentFnIsGenerator` — generator
 *     returns route through the buffer epilogue).
 * Mirrored by from-ast's `cx.noEarlyReturn` / `funcKind` guards so accepted
 * shapes always lower (select↔build parity, #2138).
 */
let earlyReturnLoopDepth = 0;
let earlyReturnBarrierDepth = 0;
let currentFnIsGenerator = false;
let currentFnIsVoidReturn = false;
// (#1373b C-1) True while walking the body of an async fn the C-1 gate
// accepted — arms the `AwaitExpression` case in `isPhase1Expr`. Reset per
// function walk (and false for the module-init assessment).
let currentFnIsAsync = false;
// (#2856 Capability C) True only while assessing the synthetic module-init
// unit. That unit already owns compound/update lowering through its scoped
// `moduleGlobal` bindings; ordinary functions intentionally keep those wider
// module writes on legacy until their coercion semantics are modeled.
let currentSubjectIsModuleInit = false;
// #3783 — `var` declarations are accepted only after a whole-function
// syntactic proof shows that their function-scoped behavior is indistinguishable
// from the IR's existing lexical local/slot representation. Keyed by the exact
// declaration-list node so nested statement walkers cannot accidentally widen
// another `var` with the same text.
let currentIrSafeVarDeclarationLists: ReadonlySet<ts.VariableDeclarationList> = new Set();
// Current-run state shared by the deep isPhase1* recursion. The structural
// selector configures the same predicates through the narrow hooks below.
let currentSelectionOptions: IrSelectionOptions | undefined;
let currentLocalClassDeclarations: ReadonlyMap<string, ts.ClassDeclaration> = new Map();
let currentClaimClassName: string | null = null;
// #2949 Acorn follow-up — the current top-level function's return expressions
// may be provably boolean even while its unannotated JS callable ABI remains
// dynamic. This proof types direct self-recursion inside `&&` / `||` without
// changing the legacy-visible signature.
let currentSubjectFunctionName: string | null = null;
let currentSubjectReturnsBoolean = false;
let currentClassBindings = new Map<string, string>();
let currentCallableArities = new Map<string, number>();
let currentCallableReturnClasses = new Map<string, string>();
let currentNestedFunctionNames: ReadonlySet<string> = new Set();
// TDZ-visible lexical values prevent an earlier use from falling through to a
// same-text top-level declaration; statement-list scopes remain independent.
let currentLexicalValueBindingNames: ReadonlySet<string> = new Set();
// Async names are accepted only as the immediate operand of await (#1796).
let currentAsyncDeclNames: ReadonlySet<string> = new Set();

/**
 * (#2856) Names LEAKED into the flat scope set by a sibling for-init
 * (`for (let i = ...)` adds `i` to the outer scope after the loop so
 * later statements can reference the counter — the scope tracker is a
 * flat set, not block-scoped). A SECOND sibling `for (let i = ...)`
 * re-declaring such a leaked name is fine: from-ast scopes each for-init
 * in its own `innerCx` copy (`lowerForStatement`), so the two loop
 * counters never collide at build time. Genuine outer bindings (params,
 * body-level locals) are NOT in this set, so shadowing THOSE still
 * rejects — which mirrors `lowerVarDecl`'s redeclaration throw exactly
 * (select↔build parity, #2138). Reset per function walk.
 */
let forInitLeakedNames = new Set<string>();

function prepareFunctionBodySelection(
  fn: IrClaimableSubject,
  parameterNames: ReadonlySet<string>,
  body: ts.Block,
): boolean {
  currentIrSafeVarDeclarationLists = collectIrSafeVarDeclarationLists(fn, parameterNames);
  return stringBuilderForcedLegacy(body);
}

// Current-run checker resolvers. A null host resolver means host-free/deferred.
let currentHostGlobalResolver: ((node: ts.Identifier) => string | undefined) | null = null;
let currentModuleBindingResolver: IrModuleBindingResolver | IrLegacyModuleBindingResolver | null = null;
// C3's Map.get result is deliberately carried as externref until a strict
// undefined check proves the value branch. Keep the local names visible to
// consumer guards so truthiness/logical/nullish uses reject before claim.
let currentModuleMapGetAliases = new Set<ts.VariableDeclaration>();
let currentModuleScalarAliasFamilies = new Map<ts.VariableDeclaration, "f64" | "boolean">();

// #3053 U2 current-run capability for dynamic member reads; sound-default true.
let currentDynMemberReadBuildable = true;
let currentDynamicRuntimeBuildable = true;
// #2949 S5.P follow-up — dynamic member reads used by equality require the
// canonical boxed-any parameter ABI. A top-level function is eligible only
// when every source reference to it is a direct identifier call; value uses
// (notably named Array HOF callbacks) can enter through a legacy direct carrier.
let currentDynScanSourceFile: ts.SourceFile | null = null;
let currentDirectOnlyDynMemberEqualityFunctions: ReadonlySet<ts.FunctionDeclaration> = new Set();
let currentDirectOnlyDynMemberEqualityFunctionsReady = false;
let currentDynMemberEqualitySubject: ts.FunctionDeclaration | null = null;
let currentDynEqualityBoxableParamNames = new Set<string>();
let currentMutableParamSlotNames = new Set<string>();
// Grounded parameter families from the propagation map. The checker sees an
// unannotated allowJs parameter as `any`, but the IR ABI may already have
// proved it f64 from every call edge. Coercion-sensitive builtin selectors
// need that exact proof instead of consulting checker syntax alone.
let currentNumericParamNames = new Set<string>();

/** @internal Configure the shared predicates for an exact structural selector run. */
export function configureIrStructuralSelectorPredicates(
  sourceFile: ts.SourceFile,
  options: IrSelectionOptions | undefined,
  localClassDeclarations: ReadonlyMap<string, ts.ClassDeclaration>,
  functionDeclarations: ReadonlyMap<string, ts.FunctionDeclaration>,
  asyncDeclarationNames: ReadonlySet<string>,
): void {
  currentSelectionOptions = options;
  currentLocalClassDeclarations = localClassDeclarations;
  configureDynamicScanSource(sourceFile, functionDeclarations);
  currentAsyncDeclNames = asyncDeclarationNames;
  currentHostGlobalResolver =
    options?.resolveHostGlobal && hostExternCapability(options.jsHostExterns === true) !== "defer"
      ? options.resolveHostGlobal
      : null;
  currentModuleBindingResolver = options?.resolveModuleBinding ?? null;
  currentDynMemberReadBuildable = options?.dynMemberReadBuildable ?? true;
  currentDynamicRuntimeBuildable = options?.dynamicRuntimeBuildable ?? true;
}

function identifierIsValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false;
  return true;
}

function collectDirectOnlyFunctionDeclarations(
  sourceFile: ts.SourceFile,
  declarations: ReadonlyMap<string, ts.FunctionDeclaration>,
): ReadonlySet<ts.FunctionDeclaration> {
  const valueUsed = new Set<ts.FunctionDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const declaration = declarations.get(node.text);
      if (declaration && node !== declaration.name && identifierIsValueReference(node)) {
        const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
        if (!directCall) valueUsed.add(declaration);
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return new Set([...declarations.values()].filter((declaration) => !valueUsed.has(declaration)));
}

function configureDynamicScanSource(
  sourceFile: ts.SourceFile,
  declarations: ReadonlyMap<string, ts.FunctionDeclaration>,
): void {
  currentDynScanSourceFile = sourceFile;
  currentDynScanDecls = declarations;
  currentDirectOnlyDynMemberEqualityFunctions = new Set();
  currentDirectOnlyDynMemberEqualityFunctionsReady = false;
}

function directOnlyDynMemberEqualityFunctions(): ReadonlySet<ts.FunctionDeclaration> {
  if (currentDirectOnlyDynMemberEqualityFunctionsReady) return currentDirectOnlyDynMemberEqualityFunctions;
  currentDirectOnlyDynMemberEqualityFunctions =
    currentDynScanSourceFile === null || currentDynScanDecls === null
      ? new Set()
      : collectDirectOnlyFunctionDeclarations(currentDynScanSourceFile, currentDynScanDecls);
  currentDirectOnlyDynMemberEqualityFunctionsReady = true;
  return currentDirectOnlyDynMemberEqualityFunctions;
}

function prepareDynamicEqualitySubject(fn: IrClaimableSubject, isMethod: boolean): void {
  currentSubjectIsModuleInit = false;
  currentDynMemberEqualitySubject = !isMethod && ts.isFunctionDeclaration(fn) ? fn : null;
  currentDynEqualityBoxableParamNames = new Set<string>();
  currentMutableParamSlotNames = new Set<string>();
  currentNumericParamNames = new Set<string>();
  currentSubjectFunctionName = !isMethod && ts.isFunctionDeclaration(fn) && fn.name !== undefined ? fn.name.text : null;
  currentSubjectReturnsBoolean =
    currentSubjectFunctionName !== null &&
    fn.body !== undefined &&
    functionReturnsOnlyBooleanExpressions(fn.body, currentSubjectFunctionName);
}

function recordDynamicParamKind(name: string, kind: ResolvedKind, dynamicNames: Set<string>): void {
  if (kind === "dynamic") dynamicNames.add(name);
  else if (kind === "f64" || kind === "bool" || kind === "string") {
    currentDynEqualityBoxableParamNames.add(name);
    if (kind === "f64") currentNumericParamNames.add(name);
  }
}

/**
 * Prove a function's return expressions boolean under the coinductive
 * assumption that direct self-recursion returns the same family. The callable
 * ABI stays dynamic; this proof only permits boolean use inside the body and a
 * tag-correct box at the return boundary.
 */
function functionReturnsOnlyBooleanExpressions(body: ts.Block, selfName: string): boolean {
  let sawReturn = false;
  let accepted = true;
  const visit = (node: ts.Node): void => {
    if (!accepted) return;
    if (node !== body && isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      sawReturn = true;
      if (!node.expression || !expressionIsBooleanWithSelfRecursion(node.expression, selfName)) accepted = false;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return sawReturn && accepted;
}

function expressionIsBooleanWithSelfRecursion(expression: ts.Expression, selfName: string): boolean {
  const candidate = unwrapProjectionExpression(expression);
  if (candidate.kind === ts.SyntaxKind.TrueKeyword || candidate.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isPrefixUnaryExpression(candidate) && candidate.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isBinaryExpression(candidate)) {
    const op = candidate.operatorToken.kind;
    if (isComparisonResultOperator(op)) return true;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      return (
        expressionIsBooleanWithSelfRecursion(candidate.left, selfName) &&
        expressionIsBooleanWithSelfRecursion(candidate.right, selfName)
      );
    }
    return false;
  }
  if (ts.isConditionalExpression(candidate)) {
    return (
      expressionIsBooleanWithSelfRecursion(candidate.whenTrue, selfName) &&
      expressionIsBooleanWithSelfRecursion(candidate.whenFalse, selfName)
    );
  }
  return (
    ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression) && candidate.expression.text === selfName
  );
}

/** Collect direct identifier mutations in one function body. */
function collectDirectMutationNames(body: ts.Block): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (node !== body && isFunctionLike(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      names.add(node.left.text);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    ) {
      names.add(node.operand.text);
    }
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return names;
}

function whyNotIrClaimable(
  fn: IrClaimableSubject,
  typeMap: TypeMap | undefined,
  localClasses: ReadonlySet<string>,
  isMethod: boolean = false,
): IrFallbackReason | null {
  prepareDynamicEqualitySubject(fn, isMethod);
  currentModuleMapGetAliases = new Set<ts.VariableDeclaration>();
  currentModuleScalarAliasFamilies = new Map<ts.VariableDeclaration, "f64" | "boolean">();
  typedShapeRejectReason = null;
  currentClaimClassName =
    isMethod && fn.parent && (ts.isClassDeclaration(fn.parent) || ts.isClassExpression(fn.parent)) && fn.parent.name
      ? fn.parent.name.text
      : null;
  currentClassBindings = new Map<string, string>();
  currentCallableArities = new Map<string, number>();
  currentCallableReturnClasses = new Map<string, string>();
  currentNestedFunctionNames = fn.body ? collectDirectNestedFunctionNames(fn.body) : new Set<string>();
  currentLexicalValueBindingNames = new Set<string>();
  // (#2856 Step-1) Clear any stale reject detail from a prior subject; the body
  // walk below repopulates it via `shapeNo` when SHAPE_DIAG_ON.
  if (SHAPE_DIAG_ON) shapeRejectDetail = null;
  // Top-level FunctionDeclaration must be named; constructor declarations
  // never carry a `name`; a MethodDeclaration with an undefined / computed
  // name is rejected as a Phase-A method-shape failure.
  if (!isMethod) {
    if (!ts.isFunctionDeclaration(fn) || !fn.name) return "unnamed";
  }
  if (fn.typeParameters && fn.typeParameters.length > 0) return "type-parameters";
  // Modifier surface differs between FunctionDeclaration and class members:
  //   - FunctionDeclaration: `export` is the only acceptable modifier.
  //   - Method/Constructor: ignore visibility (`public`/`private`/`protected`)
  //     and `static` for the IR claim check; reject `abstract`, `async`, and
  //     accessor (`get`/`set`) modifiers explicitly so they slot into the
  //     right fallback bucket.
  let isAsyncFn = false;
  if (!isMethod) {
    if (fn.modifiers) {
      // (#1373) Bucket `async` separately from generic non-export modifiers
      // so the IR-claim gate can conditionally accept async functions once
      // Phase B/C lowering lands. Async generators (`async function*`)
      // route into the existing `"async-generator"` bucket; plain async
      // functions get the new `"async-function"` bucket.
      const hasAsyncModifier = fn.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      const isGeneratorFn =
        (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && !!(fn as ts.FunctionDeclaration).asteriskToken;
      if (hasAsyncModifier) {
        if (isGeneratorFn) return "async-generator";
        // (#1373b C-1) Gate open? Then the sync-pass-through async fn falls
        // through to the NORMAL body-shape pipeline (with `await` accepted
        // in `isPhase1Expr` and the return type unwrapped from Promise<T>).
        // Engine-activated / out-of-scope asyncs keep the fallback bucket.
        if (!isAsyncIrReady(currentSelectionOptions, fn)) return "async-function";
        isAsyncFn = true;
      }
      if (fn.modifiers.some((m) => m.kind !== ts.SyntaxKind.ExportKeyword && m.kind !== ts.SyntaxKind.AsyncKeyword))
        return "non-export-modifier";
    }
  } else {
    if (fn.modifiers) {
      for (const m of fn.modifiers) {
        if (m.kind === ts.SyntaxKind.AbstractKeyword) return "class-method";
        // (#1373) Same async-function vs async-generator distinction for
        // class methods. Async generator methods land in the existing
        // `async-generator` bucket via the post-modifier check below.
        if (m.kind === ts.SyntaxKind.AsyncKeyword) {
          const isGeneratorMethod = ts.isMethodDeclaration(fn) && !!fn.asteriskToken;
          return isGeneratorMethod ? "async-generator" : "async-function";
        }
      }
    }
  }

  // Generator detection. ConstructorDeclaration has no asteriskToken.
  const isGenerator = (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && !!fn.asteriskToken;
  if (isGenerator && fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
    return "async-generator";
  }
  // #1370 Phase A: defer generator methods (and constructors-as-generators
  // are syntactically invalid). The top-level FunctionDeclaration generator
  // path lands via Slice 7a's lowerer; lifting that to method position
  // requires extra wiring (Phase D).
  if (isMethod && isGenerator) return "deferred-feature";

  // Method/constructor names don't participate in TypeMap propagation today
  // — that map is keyed by top-level FunctionDeclaration text. Phase A
  // simply skips the propagation lookup for class members; resolveReturnType
  // / resolveParamType still fall back to the AST annotation, which is
  // sufficient for the explicit-typed-method shape the spec targets.
  const entry = !isMethod && ts.isFunctionDeclaration(fn) && fn.name ? typeMap?.get(fn.name.text) : undefined;
  const directMutationNames = fn.body ? collectDirectMutationNames(fn.body) : new Set<string>();

  let isVoidReturn = false;
  // #2949 slice 2 — true when the return position resolved `dynamic`
  // (unannotated + lattice unknown/dynamic). Feeds the move-only scan below.
  let isDynamicReturn = false;
  if (!isGenerator) {
    if (ts.isConstructorDeclaration(fn)) {
      // Constructors have no source-level return type — they always return
      // the constructed instance. Phase A doesn't yet flow that through to
      // the IR (Phase C builds the `struct.new + $self` epilogue). For now
      // we accept the shape and treat the return resolution as "object"
      // implicitly; Phase B/C will use the className from the parent node
      // to produce the correct class-typed return.
    } else if (ts.isSetAccessorDeclaration(fn)) {
      // #3000-B: a set accessor carries no source-level return type — it is
      // inherently void. Its body is a void tail (the lone `this.#x = v;`
      // property store, accepted by `isPhase1Tail`'s void-tail arm).
      isVoidReturn = true;
    } else if (isAsyncFn) {
      // (#1373b C-1) An IR-claimed async fn compiles on the legacy SYNC
      // pass-through model: its wasm result is the raw `T` unwrapped from the
      // `Promise<T>` annotation (matching the declaration pre-pass's
      // checker-based `unwrapPromiseType` — the #1796 call-site consumption
      // contract wraps thenable consumers). C-1 requires the explicit
      // `Promise<T>` annotation; unannotated async fns stay legacy.
      const unwrapped = unwrapPromiseTypeNode((fn as ts.FunctionDeclaration).type);
      if (unwrapped === null) return "return-type-not-resolvable";
      const returnResolved = resolveReturnTypeNode(unwrapped);
      if (returnResolved === null) return "return-type-not-resolvable";
      isVoidReturn = returnResolved === "void";
      isDynamicReturn = returnResolved === "dynamic";
    } else {
      const returnResolved = resolveReturnType(fn, entry?.returnType);
      if (returnResolved === null) return "return-type-not-resolvable";
      isVoidReturn = returnResolved === "void";
      isDynamicReturn = returnResolved === "dynamic";
    }
  }

  const scope = new Set<string>();
  // #2949 slice 2 — names bound to DYNAMIC-typed values (unannotated params
  // whose lattice type is unknown/dynamic; extended with const/let aliases by
  // the move-only scan). Non-empty ⇒ the claim is additionally gated on
  // `dynamicUsesAreMoveOnly` below.
  const dynNames = new Set<string>();
  // Method bodies and constructor bodies see `this` as an implicit local;
  // mark it so a `return this;` / `this.field` reference passes the
  // identifier-in-scope check at Phase-1 expression position.
  if (isMethod) scope.add("this");
  for (let i = 0; i < fn.parameters.length; i++) {
    const p = fn.parameters[i]!;
    // #1372 — binding-pattern params: `function f({ x, y }: Point): …` /
    // `function f([a, b]: number[]): …`. Selector accepts when the pattern
    // is identifier-leaf + no-default + no-rest + no-nested (the slice 8a
    // shape, reused via `isPhase1BindingPattern`). Wider patterns fall
    // through with `destructuring-param-complex` so the legacy lowerer's
    // wider destructure machinery handles them.
    if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
      if (p.questionToken) return "param-shape-rejected";
      if (p.dotDotDotToken) return "param-shape-rejected";
      if (p.initializer) return "param-shape-rejected";
      if (!isPhase1BindingPattern(p.name, scope)) return "destructuring-param-complex";

      const mapped = entry?.params[i];
      const paramResolved = resolveParamType(p, mapped);
      if (paramResolved === null) return "param-type-not-resolvable";
      // #2949 slice 2 — a DYNAMIC binding pattern (`function f({x}) …` with no
      // annotation/evidence) would need dynamic property access to destructure;
      // that's box/unbox territory (slice 3). Keep the honest rejection.
      if (paramResolved === "dynamic") return "param-type-not-resolvable";

      const patternNames = new Set<string>();
      collectPatternNames(p.name, patternNames);
      if ([...patternNames].some((name) => directMutationNames.has(name))) {
        shapeNo("param-pattern-mutation", p.name);
        return "body-shape-rejected";
      }

      collectPatternNames(p.name, scope);
      for (const name of patternNames) clearProjectionBinding(name);
      continue;
    }

    if (!ts.isIdentifier(p.name)) return "param-shape-rejected";
    if (p.questionToken) return "param-shape-rejected";
    if (p.dotDotDotToken) return "param-shape-rejected";
    if (p.initializer) return "param-shape-rejected";
    if (scope.has(p.name.text)) return "param-shape-rejected";

    const mapped = entry?.params[i];
    const paramResolved = resolveParamType(p, mapped);
    if (paramResolved === null) return "param-type-not-resolvable";
    if (
      directMutationNames.has(p.name.text) &&
      paramResolved !== "f64" &&
      paramResolved !== "bool" &&
      paramResolved !== "string" &&
      paramResolved !== "dynamic"
    ) {
      shapeNo("param-mutation-no-slot-representation", p);
      return "body-shape-rejected";
    }
    if (directMutationNames.has(p.name.text)) currentMutableParamSlotNames.add(p.name.text);
    // #2949 slice 2 — collect dynamic-typed param names for the move-only scan.
    recordDynamicParamKind(p.name.text, paramResolved, dynNames);

    const paramType = effectiveIrParamTypeNode(p);
    clearProjectionBinding(p.name.text);
    const className = paramType ? localClassNameFromTypeNode(paramType) : null;
    if (className !== null) currentClassBindings.set(p.name.text, className);
    if (paramType && ts.isFunctionTypeNode(paramType)) {
      const signature = irClosureSignatureFromFunctionTypeNode(paramType);
      if (signature) recordCallableProjection(p.name.text, signature.params.length, paramType.type);
    }

    scope.add(p.name.text);
  }

  const body = fn.body;
  if (!body) return "body-shape-rejected";
  if (prepareFunctionBodySelection(fn, scope, body)) return "string-builder-candidate";
  // (#2856 C1) Reset the early-return context for this function's walk.
  earlyReturnLoopDepth = 0;
  earlyReturnBarrierDepth = 0;
  forInitLeakedNames = new Set();
  currentFnIsGenerator = isGenerator;
  currentFnIsVoidReturn = isVoidReturn;
  currentFnIsAsync = isAsyncFn; // (#1373b C-1) arms the isPhase1Expr await arm
  // #1370 Phase A: constructor bodies don't have a return-statement tail —
  // the legacy lowerer (and Phase C) synthesise the implicit `return this;`.
  // Accept the body as a list of Phase-1 body statements instead, which
  // covers `this.field = expr;`, `this.method(...)`, and bare calls. This
  // mirrors how try/catch/finally bodies are checked (see `isPhase1TryStatement`).
  if (ts.isConstructorDeclaration(fn)) {
    // #3000-C: the IR constructor lowering (`lowerFunctionAstToIr` Phase C)
    // runs ONLY the constructor body statements — it allocates the instance
    // with each struct field at its default, then replays the body's
    // `this.field = …` writes. It does NOT execute two other construction-time
    // effects the legacy path handles:
    //   (a) parameter properties (`constructor(private name: string)`) — the
    //       param both declares AND assigns a field; the IR path treats it as
    //       a plain param and drops the field write.
    //   (b) PropertyDeclaration initialisers (`age = 5;`) — these run at
    //       construction; the IR path leaves the field at its struct default.
    // A class using either would silently mis-construct (the typeIdx-parity
    // guard can't catch it — same signature). Reject to legacy so construction
    // stays correct. Flat classes whose fields are declared without an
    // initialiser and assigned in the body (the common shape, e.g. classes.ts's
    // `Animal`) are unaffected.
    for (const p of fn.parameters) {
      const isParamProperty = p.modifiers?.some(
        (m) =>
          m.kind === ts.SyntaxKind.PublicKeyword ||
          m.kind === ts.SyntaxKind.PrivateKeyword ||
          m.kind === ts.SyntaxKind.ProtectedKeyword ||
          m.kind === ts.SyntaxKind.ReadonlyKeyword,
      );
      if (isParamProperty) return "body-shape-rejected";
    }
    const parent = fn.parent;
    if (parent && (ts.isClassDeclaration(parent) || ts.isClassExpression(parent))) {
      for (const m of parent.members) {
        if (ts.isPropertyDeclaration(m) && m.initializer) return "body-shape-rejected";
      }
    }
    const ctorScope = new Set(scope);
    // (#2856 C1) Constructor bodies never take the early-return arm — their
    // returns route through the implicit `return this` synthesis.
    earlyReturnBarrierDepth++;
    try {
      const accepted = withLexicalValueBindingScope(body.statements, () => {
        for (const s of body.statements) {
          if (!isPhase1BodyStatement(s, ctorScope, localClasses)) return false;
        }
        return true;
      });
      if (!accepted) return typedShapeRejectReason ?? "body-shape-rejected";
    } finally {
      earlyReturnBarrierDepth--;
    }
    return null;
  }
  if (!isPhase1StatementList(body.statements, scope, localClasses, isGenerator, isVoidReturn)) {
    return typedShapeRejectReason ?? "body-shape-rejected";
  }

  // -------------------------------------------------------------------------
  // #2949 slice 2 — dynamic move-only gate.
  //
  // A function whose params/return resolved `dynamic` is claimable ONLY when
  // every dynamic value strictly MOVES (return position, dyn-arg → dyn-param
  // of a local direct call, const/let alias). Slice 2 deliberately has no
  // box/unbox/tag.test lowering, so any other use (arithmetic, truthiness,
  // property access, mixed concrete/dynamic returns, …) cannot be built; the
  // scan keeps such functions in their existing rejection buckets instead of
  // claim-then-demote. Precision here is LOAD-BEARING for `JS2WASM_IR_FIRST`:
  // a claimed+skipped function that later build-demotes is a hard compile
  // error there (see `computeIrFirstSkipSet`; gate 6 additionally keeps
  // dynamic-signature functions compile-twice as insurance while slice 3
  // lowering is absent).
  //
  // Generators with dynamic params stay rejected — the generator prologue /
  // yield machinery has no dynamic arm yet.
  // -------------------------------------------------------------------------
  if (dynNames.size > 0 && isGenerator) return "param-type-not-resolvable";
  if (dynNames.size > 0 || isDynamicReturn || containsRetainedFunctionMethodCall(body)) {
    if (!dynamicUsesAreMoveOnly(fn, dynNames, isDynamicReturn, typeMap)) {
      return dynNames.size > 0 ? "param-type-not-resolvable" : "return-type-not-resolvable";
    }
  }

  return null;
}

/** @internal Exact-subject entry used by the structural selector orchestration. */
export function assessIrStructuralSelectorSubject(
  subject: IrClaimableSubject,
  typeMap: TypeMap | undefined,
  localClasses: ReadonlySet<string>,
  isMethod = false,
): { readonly reason: IrFallbackReason | null; readonly detail?: string } {
  const reason = whyNotIrClaimable(subject, typeMap, localClasses, isMethod);
  const detail =
    reason === "body-shape-rejected" && SHAPE_DIAG_ON
      ? (takeShapeRejectDetail() ?? "unattributed-arm:helper-internal")
      : undefined;
  return detail === undefined ? { reason } : { reason, detail };
}

function isIrClaimable(
  fn: IrClaimableSubject,
  typeMap: TypeMap | undefined,
  localClasses: ReadonlySet<string>,
  isMethod: boolean = false,
): boolean {
  // #1370 Phase A: keeping `isIrClaimable` and `whyNotIrClaimable` in sync
  // is brittle when both have to grow new method-specific guards. Delegate
  // to the reason-returning variant; the per-call overhead of allocating
  // and discarding a string return is negligible against the AST walk in
  // `isPhase1StatementList`.
  return whyNotIrClaimable(fn, typeMap, localClasses, isMethod) === null;
}

/**
 * Resolve a param's type. Explicit TS annotation wins (must be number /
 * boolean / string). Otherwise, the TypeMap entry's lattice type must be a
 * concrete primitive.
 *
 * #1169a — slice 1 widens the resolver to recognise `string`. The set of
 * call sites still treats the result as a null-vs-non-null discriminator,
 * so adding a third positive value is backward-compatible.
 */
// Slice 14 (#1228) — `any` and `void` are accepted at the selector level:
//   - `any` (param or return) lowers to externref via `resolvePositionType`.
//   - `void` (return only) means the function has zero result types; lowering
//     constructs the IrFunctionBuilder with `[]` results and accepts bare
//     `return;` / fall-through tails. `void` in param position is rejected
//     (no JS source emits a `void`-typed param value, so there's nothing to
//     accept).
// #2859 / #3214 B0 — `closure` selector kind (param only): a FunctionTypeNode annotation whose params
//   and return are all primitive-annotated (the same surface slice-3 closure
//   literals support). The override lowers the source parameter to
//   `IrType.callable` / externref; calls unpack it through the canonical wrapper
//   root. `IrType.closure` remains the compiler-owned local literal carrier.
// #2949 slice 2 — `dynamic`: an UNANNOTATED position whose propagated lattice
//   type converged to `unknown` (no evidence) or `dynamic` (top). Lowers to
//   `IrType.dynamic` → the module's boxed-any carrier via
//   `IrLowerResolver.resolveDynamic()` (fast/standalone: `ref_null $AnyValue`;
//   JS-host: externref) — the SAME carrier legacy `resolveWasmType`'s
//   any/unknown arm gives these positions, so IR-claimed and legacy functions
//   agree on the ABI by construction. The claim is additionally gated by
//   `dynamicUsesAreMoveOnly`: producers are still move-only (box/unbox
//   producer widening is the #2949 follow-up slice), so dynamic values may
//   only MOVE. (#2949 slice 3b) The explicit `any` ANNOTATION now resolves
//   "dynamic" too — the historical "any" kind (externref in all modes, no
//   use gating) is deleted: it diverged from legacy's fast-mode `any` ABI
//   and was the last claim-then-demote channel for non-move any-uses.
type ResolvedKind = "f64" | "bool" | "string" | "object" | "void" | "closure" | "dynamic" | null;

/**
 * Return the declaration's effective parameter type node.
 *
 * For TypeScript this is the ordinary `param.type`. For JavaScript, the TS
 * parser/checker boundary exposes a standard `@param {T}` annotation through
 * `getJSDocType` while deliberately leaving `param.type` unset. Keeping this
 * lookup in one helper prevents the selector and the shared AST-to-IR
 * signature resolver from disagreeing about the same source declaration. No
 * comment text is parsed and no synthetic annotation is attached to the AST.
 */
export function effectiveIrParamTypeNode(param: ts.ParameterDeclaration): ts.TypeNode | undefined {
  return param.type ?? ts.getJSDocType(param);
}

/**
 * Return the declaration's effective return type node, including a JavaScript
 * JSDoc `@returns {T}` annotation when present.
 *
 * The caller still applies the existing narrow primitive/object/dynamic
 * mapping. In particular, this helper does not turn an unannotated, `any`,
 * union, or otherwise unsupported signature into a primitive claim.
 */
export function effectiveIrReturnTypeNode(
  fn: ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
): ts.TypeNode | undefined {
  return fn.type ?? ts.getJSDocReturnType(fn);
}

/**
 * #2859 — build an `IrClosureSignature` from an explicit function-type
 * annotation (`(a: number, b: string) => number`), or return `null` when the
 * annotation is outside the expressible surface. The primitive mapping MUST
 * stay identical to `typeNodeToIr` in `from-ast.ts` (number→f64, boolean→i32,
 * string→string): a closure-literal argument's signature is built there, and
 * `lowerClosureCall` / `irTypeEquals` compare the two structurally — any
 * divergence would reject valid calls at lowering time (post-claim demotion).
 *
 * Out-of-surface shapes (→ null, so the selector keeps the honest
 * `param-type-not-resolvable` rejection): non-primitive param/return types,
 * rest/optional/default params, and type parameters. Void returns are a
 * canonical zero-result closure signature; value-position calls still reject.
 */
export function irClosureSignatureFromFunctionTypeNode(node: ts.FunctionTypeNode): IrClosureSignature | null {
  if (node.typeParameters && node.typeParameters.length > 0) return null;
  const prim = (t: ts.TypeNode | undefined): IrType | null => {
    if (!t) return null;
    if (t.kind === ts.SyntaxKind.NumberKeyword) return { kind: "val", val: { kind: "f64" } };
    if (t.kind === ts.SyntaxKind.BooleanKeyword) return { kind: "val", val: { kind: "i32" } };
    if (t.kind === ts.SyntaxKind.StringKeyword) return { kind: "string" };
    return null;
  };
  const params: IrType[] = [];
  for (const p of node.parameters) {
    if (p.questionToken || p.dotDotDotToken || p.initializer) return null;
    const ir = prim(p.type);
    if (!ir) return null;
    params.push(ir);
  }
  const returnType = node.type.kind === ts.SyntaxKind.VoidKeyword ? null : prim(node.type);
  if (returnType === null && node.type.kind !== ts.SyntaxKind.VoidKeyword) return null;
  return { params, returnType };
}

/**
 * Exact callback signature for a bare top-level FunctionDeclaration value.
 * B1 deliberately requires explicit primitive annotations and ordinary,
 * fixed-arity functions: no inference, generators/async, generics,
 * optional/rest/default parameters, destructuring, or callable/void results.
 */
export function irClosureSignatureFromFunctionDeclaration(
  declaration: ts.FunctionDeclaration,
): IrClosureSignature | null {
  if (
    !declaration.body ||
    declaration.asteriskToken ||
    (declaration.typeParameters?.length ?? 0) > 0 ||
    declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    return null;
  }
  const params: IrType[] = [];
  for (const parameter of declaration.parameters) {
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.questionToken ||
      parameter.dotDotDotToken ||
      parameter.initializer
    ) {
      return null;
    }
    const type = effectiveIrParamTypeNode(parameter);
    if (!type) return null;
    if (type.kind === ts.SyntaxKind.NumberKeyword) params.push({ kind: "val", val: { kind: "f64" } });
    else if (type.kind === ts.SyntaxKind.BooleanKeyword) params.push({ kind: "val", val: { kind: "i32" } });
    else if (type.kind === ts.SyntaxKind.StringKeyword) params.push({ kind: "string" });
    else return null;
  }
  const resultNode = effectiveIrReturnTypeNode(declaration);
  let returnType: IrType;
  if (resultNode?.kind === ts.SyntaxKind.NumberKeyword) returnType = { kind: "val", val: { kind: "f64" } };
  else if (resultNode?.kind === ts.SyntaxKind.BooleanKeyword) returnType = { kind: "val", val: { kind: "i32" } };
  else if (resultNode?.kind === ts.SyntaxKind.StringKeyword) returnType = { kind: "string" };
  else return null;
  return { params, returnType };
}

export interface IrImportedFunctionArgumentCertification {
  readonly argument: ts.Identifier;
  readonly target: IrResolvedFunctionTarget;
  readonly signature: IrClosureSignature;
}

export interface IrImportedCallCertification {
  readonly call: ts.CallExpression;
  readonly target: IrResolvedFunctionTarget;
  readonly functionArguments: readonly IrImportedFunctionArgumentCertification[];
}

/**
 * Certify the exact cross-file direct-call surface shared by selection and
 * overlay planning.  Ordinary arguments are left to `isPhase1Expr`; this
 * helper owns only the imported callee/arity contract and the B1 exception for
 * a bare same-file top-level FunctionDeclaration in an exact FunctionTypeNode
 * parameter position.
 */
export function certifyImportedIrCall(
  call: ts.CallExpression,
  resolver: IrImportedFunctionResolver | undefined,
): IrImportedCallCertification | undefined {
  if (
    !resolver ||
    call.questionDotToken ||
    (call.typeArguments?.length ?? 0) > 0 ||
    !ts.isIdentifier(call.expression) ||
    call.arguments.some(ts.isSpreadElement)
  ) {
    return undefined;
  }
  const target = resolver.resolveImportedFunction(call.expression);
  if (!target) return undefined;
  const declaration = target.declaration;
  const returnNode = effectiveIrReturnTypeNode(declaration);
  if (
    !declaration.body ||
    declaration.asteriskToken ||
    (declaration.typeParameters?.length ?? 0) > 0 ||
    declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
    declaration.parameters.some((p) => p.dotDotDotToken || !ts.isIdentifier(p.name)) ||
    (returnNode !== undefined && ts.isFunctionTypeNode(returnNode))
  ) {
    return undefined;
  }
  if (call.arguments.length > declaration.parameters.length) return undefined;
  for (let i = call.arguments.length; i < declaration.parameters.length; i++) {
    const parameter = declaration.parameters[i]!;
    if (!parameter.questionToken && !parameter.initializer) return undefined;
  }

  const functionArguments: IrImportedFunctionArgumentCertification[] = [];
  for (let i = 0; i < call.arguments.length; i++) {
    const argument = call.arguments[i]!;
    const parameter = declaration.parameters[i]!;
    const parameterType = effectiveIrParamTypeNode(parameter);
    if (!parameterType || !ts.isFunctionTypeNode(parameterType)) continue;
    // A supplied callback is B1 only when it is the exact bare declaration
    // value. Arrows, aliases, stored values, and widened callable types stay on
    // legacy. Optional/default callback parameters may be omitted, but a
    // present callback parameter itself must be the exact required shape.
    if (parameter.questionToken || parameter.initializer || !ts.isIdentifier(argument)) {
      return undefined;
    }
    const expected = irClosureSignatureFromFunctionTypeNode(parameterType);
    const functionTarget = resolver.resolveTopLevelFunctionValue(argument);
    const actual = functionTarget ? irClosureSignatureFromFunctionDeclaration(functionTarget.declaration) : null;
    if (!expected || !functionTarget || !actual || !closureSignatureEquals(actual, expected)) return undefined;
    functionArguments.push({ argument, target: functionTarget, signature: actual });
  }
  return { call, target, functionArguments };
}

function resolveParamType(p: ts.ParameterDeclaration, mapped: LatticeType | undefined): ResolvedKind {
  const effectiveType = effectiveIrParamTypeNode(p);
  if (effectiveType) {
    if (effectiveType.kind === ts.SyntaxKind.NumberKeyword) return "f64";
    if (effectiveType.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
    if (effectiveType.kind === ts.SyntaxKind.StringKeyword) return "string";
    // (#2949 slice 3b) `any` IS the dynamic type. The historical #1228
    // mapping ("any" kind → externref override) claimed EVERY any-param
    // function unconditionally and relied on from-ast throwing for
    // non-move uses — a claim-then-demote channel; it also pinned the
    // fast-mode carrier to externref, diverging from legacy's mode-split
    // `any` ABI (fast → ref_null $AnyValue). Resolving `dynamic` here
    // routes any-params through the SAME move-only scan + carrier as
    // unannotated dynamics: non-move uses now reject PRE-claim (no
    // demotion), and the claimed ones share legacy's ABI in both modes.
    if (effectiveType.kind === ts.SyntaxKind.AnyKeyword) return "dynamic";
    // #2859 / #3214 B0 — function-typed param (`fn: () => number`). Accepted
    // when the signature is expressible with the slice-3 closure surface; the
    // source boundary lowers to callable/externref and `fn()` unpacks through
    // the canonical wrapper root. Inexpressible function types stay rejected.
    if (ts.isFunctionTypeNode(effectiveType)) {
      return irClosureSignatureFromFunctionTypeNode(effectiveType) ? "closure" : null;
    }
    // Slice 2 (#1169b) — accept TypeLiteral / TypeReference at the
    // selector level. The actual shape resolution happens in
    // codegen/index.ts:resolvePositionType, which materializes an
    // IrType.object via `objectIrTypeFromTsType`. If shape resolution
    // fails (e.g. callable type, methods, etc.), the override map is
    // populated with a placeholder and the function falls back to
    // legacy via the `safeSelection` filter.
    //
    // Slice 6 part 2 (#1181) — accept ArrayTypeNode (`T[]`) too.
    // `Array<T>` already resolves via TypeReferenceNode. Both shapes
    // route to a vec ref in `resolvePositionType`.
    if (
      ts.isTypeLiteralNode(effectiveType) ||
      ts.isTypeReferenceNode(effectiveType) ||
      ts.isArrayTypeNode(effectiveType)
    )
      return "object";
    return null;
  }
  const projected = currentSelectionOptions?.resolveImplicitParamType?.(p);
  if (projected !== undefined && !(projected === "dynamic" && mapped?.kind === "f64")) return projected;
  if (mapped?.kind === "f64") return "f64";
  if (mapped?.kind === "bool") return "bool";
  if (mapped?.kind === "string") return "string";
  if (mapped?.kind === "object") return "object";
  // #2949 slice 2 — unannotated + lattice unknown (no evidence) or dynamic
  // (top): the position is honestly DYNAMIC. `mapped` must be present (a
  // TypeMap entry exists for every top-level FunctionDeclaration): class
  // members don't participate in propagation (`entry` is undefined there) and
  // must keep the null rejection, not silently become dynamic-claimable.
  // Lattice `union` stays null: #2135's union rows own that shape.
  if (mapped && (mapped.kind === "unknown" || mapped.kind === "dynamic")) return "dynamic";
  return null;
}

// #1370 Phase A: widened to also accept ts.MethodDeclaration. The `.type`
// (return-type annotation) field is identical in shape across both AST
// nodes (it's `TypeNode | undefined`), and so is the dispatch logic below.
// ts.ConstructorDeclaration is excluded — constructors don't carry a
// source-level return type; the caller short-circuits before this.
/**
 * (#1373b C-1) Annotation arm of {@link resolveReturnType}, extracted so the
 * async claim can resolve the `T` unwrapped from a `Promise<T>` annotation
 * with the exact same kind mapping. Keep the two in lockstep.
 */
function resolveReturnTypeNode(t: ts.TypeNode): ResolvedKind {
  if (t.kind === ts.SyntaxKind.NumberKeyword) return "f64";
  if (t.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
  if (t.kind === ts.SyntaxKind.StringKeyword) return "string";
  // Slice 14 (#1228) — `void` return: function has zero result types.
  if (t.kind === ts.SyntaxKind.VoidKeyword) return "void";
  // (#2949 slice 3b) `any` return IS the dynamic type (same rationale as
  // the param arm — one `any` ABI, move-only-scanned).
  if (t.kind === ts.SyntaxKind.AnyKeyword) return "dynamic";
  if (ts.isTypeLiteralNode(t) || ts.isTypeReferenceNode(t) || ts.isArrayTypeNode(t)) return "object";
  return null;
}

function resolveReturnType(
  // #3000-B: also accept a GET accessor — its return type is `fn.type` exactly
  // like a method. (SET accessors are void and never reach here.)
  fn: ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration,
  mapped: LatticeType | undefined,
): ResolvedKind {
  const effectiveType = effectiveIrReturnTypeNode(fn);
  if (effectiveType) {
    return resolveReturnTypeNode(effectiveType);
  }
  if (mapped?.kind === "f64") return "f64";
  if (mapped?.kind === "bool") return "bool";
  if (mapped?.kind === "string") return "string";
  if (mapped?.kind === "object") return "object";
  // #2949 slice 2 — same dynamic arm as `resolveParamType` (see the rationale
  // there). A dynamic return is claimable only when every return statement
  // returns a dynamic-typed MOVE (enforced by `dynamicUsesAreMoveOnly`).
  if (mapped && (mapped.kind === "unknown" || mapped.kind === "dynamic")) return "dynamic";
  return null;
}

// ---------------------------------------------------------------------------
// #2949 slice 2 — dynamic move-only scan
// ---------------------------------------------------------------------------

/**
 * All top-level FunctionDeclarations of the CURRENT `planIrCompilation` run,
 * pre-collected before Step 1 so the move-only scan can resolve CALLEE
 * param/return dynamic-ness regardless of declaration order. Module-level for
 * the same reason as `currentHostGlobalResolver` (threading a param through the
 * shared `isPhase1*` recursion would conflict with every in-flight selector
 * slice). `null` outside a selector run — the scan then treats every callee
 * as non-dynamic (conservative: dyn args to it reject the claim).
 */
let currentDynScanDecls: ReadonlyMap<string, ts.FunctionDeclaration> | null = null;

/** Resolve whether param `argIdx` of local function `calleeName` is dynamic
 *  (same `resolveParamType` verdict the callee's own claim check uses, so the
 *  caller-side scan and the callee's signature can never drift). */
function calleeParamResolvedKind(calleeName: string, argIdx: number, typeMap: TypeMap | undefined): ResolvedKind {
  const decl = currentDynScanDecls?.get(calleeName);
  if (!decl) return null;
  const p = decl.parameters[argIdx];
  if (!p || !ts.isIdentifier(p.name)) return null;
  return resolveParamType(p, typeMap?.get(calleeName)?.params[argIdx]);
}

function calleeParamIsDynamic(calleeName: string, argIdx: number, typeMap: TypeMap | undefined): boolean {
  return calleeParamResolvedKind(calleeName, argIdx, typeMap) === "dynamic";
}

function calleeHasAnyDynamicParam(calleeName: string, typeMap: TypeMap | undefined): boolean {
  const decl = currentDynScanDecls?.get(calleeName);
  if (!decl) return false;
  for (let i = 0; i < decl.parameters.length; i++) {
    if (calleeParamIsDynamic(calleeName, i, typeMap)) return true;
  }
  return false;
}

/** Resolve whether local function `calleeName`'s return is dynamic. */
function calleeReturnIsDynamic(calleeName: string, typeMap: TypeMap | undefined): boolean {
  const decl = currentDynScanDecls?.get(calleeName);
  if (!decl || decl.asteriskToken) return false;
  return resolveReturnType(decl, typeMap?.get(calleeName)?.returnType) === "dynamic";
}

/**
 * True when the subtree contains NO value-use of a dynamic name. Property
 * NAMES (`obj.<name>`, non-computed object-literal keys) are not value uses
 * and are excluded; everything else that mentions a dyn name counts as a
 * touch. Used as the conservative fallback for constructs the move-only scan
 * doesn't model: untouched-by-dynamic subtrees are exactly as claimable as
 * they were before slice 2.
 */
function subtreeTouchesDynamic(root: ts.Node, dynNames: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && dynNames.has(n.text)) {
      found = true;
      return;
    }
    if (ts.isPropertyAccessExpression(n)) {
      visit(n.expression); // skip `.name` — not a value use
      return;
    }
    if (ts.isPropertyAssignment(n)) {
      if (ts.isComputedPropertyName(n.name)) visit(n.name);
      visit(n.initializer); // skip the literal key
      return;
    }
    forEachChild(n, visit);
  };
  visit(root);
  return found;
}

function dynamicMemberEqualityOperandIsBuildable(candidate: ts.Expression): boolean {
  const isMember = ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate);
  return (
    !isMember ||
    (currentDynMemberEqualitySubject !== null &&
      directOnlyDynMemberEqualityFunctions().has(currentDynMemberEqualitySubject))
  );
}

function concreteDynamicEqualityOperandIsBuildable(candidate: ts.Expression, allowVoidZero = false): boolean {
  return (
    ts.isNumericLiteral(candidate) ||
    ts.isStringLiteralLike(candidate) ||
    candidate.kind === ts.SyntaxKind.TrueKeyword ||
    candidate.kind === ts.SyntaxKind.FalseKeyword ||
    candidate.kind === ts.SyntaxKind.NullKeyword ||
    (allowVoidZero &&
      ts.isVoidExpression(candidate) &&
      ts.isNumericLiteral(candidate.expression) &&
      Number(candidate.expression.text) === 0) ||
    (ts.isIdentifier(candidate) &&
      (candidate.text === "undefined" || currentDynEqualityBoxableParamNames.has(candidate.text)))
  );
}

function concreteDynamicAssignmentOperandIsBuildable(candidate: ts.Expression): boolean {
  if (expressionIsProvenNumber(candidate)) return true;
  if (currentSelectionOptions?.classifyPrimitiveExpression?.(candidate) === "string") return true;
  if (candidate.kind === ts.SyntaxKind.TrueKeyword || candidate.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isPrefixUnaryExpression(candidate) && candidate.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isBinaryExpression(candidate)) {
    const op = candidate.operatorToken.kind;
    return (
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.InstanceOfKeyword ||
      op === ts.SyntaxKind.InKeyword ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken
    );
  }
  return (
    ts.isConditionalExpression(candidate) &&
    concreteDynamicAssignmentOperandIsBuildable(candidate.whenTrue) &&
    concreteDynamicAssignmentOperandIsBuildable(candidate.whenFalse)
  );
}

/**
 * True when the current body contains a #3793 retained method call.
 *
 * Such calls always use the boxed-dynamic closed-dispatch ABI, so they must
 * run through {@link dynamicUsesAreMoveOnly} even when the enclosing
 * declaration has no dynamic parameter/result. The scan then proves both the
 * result position and every argument bridge before the selector claims the
 * function.
 */
function containsRetainedFunctionMethodCall(body: ts.Block): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== body && isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && currentModuleBindingResolver?.retainedFunctionMethodPlan(node) !== undefined) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return found;
}

/**
 * #2949 slice 2 — verify every use of a dynamic value in `fn`'s body is a
 * MOVE the from-ast builder can lower withOUT box/unbox/tag.test (which land
 * in slice 3). Allowed sinks for a dynamic value:
 *
 *   - `return <dyn>` when the function's return resolved dynamic;
 *   - argument position of a DIRECT call to a local function whose
 *     corresponding param also resolved dynamic (`irTypeEquals` at the
 *     from-ast call site then holds by construction);
 *   - `const`/`let` initializer that is exactly a dyn identifier or a
 *     dyn-returning local call — the declared name joins `dynNames`;
 *   - re-assignment `<dynLocal> = <dyn move>`;
 *   - statement-position calls (a dropped dynamic result is fine).
 *
 * Dually, a position that REQUIRES a dynamic value (dyn-param argument, dyn
 * return) must receive one — a concrete value there would need a box.
 * Everything else is rejected so the function keeps its existing rejection
 * bucket (never claim-then-demote; see the IR-first hard-error contract).
 *
 * The walker mutates `dynNames` (alias tracking). Shadowing is already
 * rejected by the Phase-1 scope rules, so a flat set is sound.
 */
function dynamicUsesAreMoveOnly(
  fn: IrClaimableSubject,
  dynNames: Set<string>,
  returnIsDynamic: boolean,
  typeMap: TypeMap | undefined,
): boolean {
  const body = fn.body;
  if (!body) return false;

  const unwrap = (e: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return e;
  };

  /**
   * Does `e` PRODUCE a dynamic-typed value?
   *   - a dyn name (alias-tracked local / param);
   *   - a dyn-returning direct local call;
   *   - (#3053 U2 / #2949 S5.P) a member/element read off a dynamic-producing
   *     receiver — `dyn.a`, `dyn[i]`, and chains `dyn.a.b` — since a member read
   *     of any is any (routes through `__dyn_member_get`, result `dynamic`).
   * The member-read arms only CLASSIFY the receiver here; `scanExpr` re-validates
   * the full access (key shape, chain) against the from-ast producer contract.
   */
  const isDynShaped = (e: ts.Expression): boolean => {
    e = unwrap(e);
    if (ts.isIdentifier(e)) return dynNames.has(e.text);
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && !dynNames.has(e.expression.text)) {
      return calleeReturnIsDynamic(e.expression.text, typeMap);
    }
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      currentModuleBindingResolver?.retainedFunctionMethodPlan(e) !== undefined
    ) {
      return true;
    }
    if (
      currentDynamicRuntimeBuildable &&
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      isDynShaped(e.expression.expression)
    ) {
      return true;
    }
    if (
      currentDynamicRuntimeBuildable &&
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (isDynShaped(e.left) || isDynShaped(e.right))
    ) {
      return true;
    }
    if (ts.isConditionalExpression(e) && isDynShaped(e.whenTrue) && isDynShaped(e.whenFalse)) {
      return true;
    }
    if (ts.isPropertyAccessExpression(e)) return isDynShaped(e.expression);
    if (ts.isElementAccessExpression(e)) return isDynShaped(e.expression);
    return false;
  };

  /** Scan a direct-call's arguments against the callee's per-param verdicts. */
  const scanDirectCallArgs = (e: ts.CallExpression, calleeName: string): boolean => {
    for (let i = 0; i < e.arguments.length; i++) {
      const a = e.arguments[i]!;
      if (ts.isSpreadElement(a)) {
        // Spread shifts arg→param index mapping (`expandStaticSpreadArgs`);
        // don't try to track it — safe only when the callee has no dynamic
        // params and the spread source doesn't touch dynamic values.
        if (calleeHasAnyDynamicParam(calleeName, typeMap)) return false;
        if (subtreeTouchesDynamic(a, dynNames)) return false;
        continue;
      }
      const expectedKind = calleeParamResolvedKind(calleeName, i, typeMap);
      const argumentIsDynamic = isDynShaped(a);
      // Acorn stringToNumber's native parse helpers take the non-fast
      // dynamic carrier verbatim as their first externref argument. This is
      // an exact ABI boundary, not a dynamic-to-string unbox: fast AnyValue
      // configurations keep `currentDynamicRuntimeBuildable` false.
      if (
        currentDynamicRuntimeBuildable &&
        currentSubjectFunctionName === "stringToNumber" &&
        argumentIsDynamic &&
        i === 0 &&
        ((calleeName === "parseInt" && e.arguments.length === 2) ||
          (calleeName === "parseFloat" && e.arguments.length === 1))
      ) {
        if (!scanExpr(a, true)) return false;
        continue;
      }
      if (currentDynamicRuntimeBuildable && argumentIsDynamic && expectedKind === "f64") {
        if (!scanExpr(a, true)) return false;
        continue;
      }
      if (!scanExpr(a, expectedKind === "dynamic")) return false;
    }
    return true;
  };

  /**
   * `expectDyn` is the type the POSITION requires: true ⇒ a dynamic value
   * must flow here (box needed otherwise → reject); false ⇒ a concrete value
   * must flow here (unbox needed otherwise → reject).
   */
  const scanExpr = (expr: ts.Expression, expectDyn: boolean): boolean => {
    const e = unwrap(expr);
    if (ts.isIdentifier(e)) {
      return dynNames.has(e.text) === expectDyn;
    }
    if (ts.isCallExpression(e)) {
      const retainedMethod = currentModuleBindingResolver?.retainedFunctionMethodPlan(e);
      if (retainedMethod !== undefined) {
        if (!expectDyn || e.arguments.length !== retainedMethod.arity) return false;
        for (const argument of e.arguments) {
          if (ts.isSpreadElement(argument)) return false;
          const dynamic = isDynShaped(argument);
          if (dynamic) {
            if (!scanExpr(argument, true)) return false;
          } else if (!scanExpr(argument, false)) {
            return false;
          }
        }
        return true;
      }
      if (
        currentDynamicRuntimeBuildable &&
        ts.isPropertyAccessExpression(e.expression) &&
        isDynShaped(e.expression.expression)
      ) {
        const narrowStringReplace =
          e.expression.name.text === "replace" &&
          e.arguments.length === 2 &&
          e.arguments[0]!.kind === ts.SyntaxKind.RegularExpressionLiteral &&
          e.arguments[0]!.getText() === "/_/g" &&
          ts.isStringLiteralLike(e.arguments[1]!) &&
          e.arguments[1]!.text === "";
        if (!currentDynMemberReadBuildable || !expectDyn || (e.arguments.length > 1 && !narrowStringReplace)) {
          return false;
        }
        if (!scanExpr(e.expression.expression, true)) return false;
        if (narrowStringReplace) {
          return scanExpr(e.arguments[0]!, false) && scanExpr(e.arguments[1]!, false);
        }
        for (const argument of e.arguments) {
          if (ts.isSpreadElement(argument)) return false;
          const dynamic = isDynShaped(argument);
          if (!dynamic && !concreteDynamicAssignmentOperandIsBuildable(unwrap(argument))) return false;
          if (!scanExpr(argument, dynamic)) return false;
        }
        return true;
      }
      // Direct call to a (possibly) top-level function. A dyn-NAMED callee
      // (`x()` where x is dynamic) is calling a dynamic value — slice 3.
      if (ts.isIdentifier(e.expression)) {
        if (dynNames.has(e.expression.text)) return false;
        const calleeName = e.expression.text;
        if (calleeReturnIsDynamic(calleeName, typeMap) !== expectDyn) return false;
        return scanDirectCallArgs(e, calleeName);
      }
      // Method-shaped / other callees: no dynamic involvement allowed.
      if (expectDyn) return false;
      if (!scanExpr(e.expression, false)) return false;
      for (const a of e.arguments) {
        if (ts.isSpreadElement(a)) {
          if (subtreeTouchesDynamic(a, dynNames)) return false;
          continue;
        }
        if (!scanExpr(a, false)) return false;
      }
      return true;
    }
    if (ts.isBinaryExpression(e)) {
      const leftIsDyn = isDynShaped(e.left);
      const rightIsDyn = isDynShaped(e.right);
      const op = e.operatorToken.kind;
      if (
        currentSubjectReturnsBoolean &&
        (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken)
      ) {
        return scanExpr(e.left, leftIsDyn) && scanExpr(e.right, rightIsDyn);
      }
      // Plain assignment re-binds; scan the RHS against the LHS's dyn-ness.
      if (e.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(e.left)) {
        if (expectDyn) return false; // assignment-as-value in a dyn position — slice 3
        if (!dynNames.has(e.left.text)) return scanExpr(e.right, false);
        if (isDynShaped(e.right)) return scanExpr(e.right, true);
        const concrete = unwrap(e.right);
        return concreteDynamicAssignmentOperandIsBuildable(concrete) && scanExpr(concrete, false);
      }
      if (op === ts.SyntaxKind.PlusToken && (leftIsDyn || rightIsDyn)) {
        if (!currentDynamicRuntimeBuildable) return false;
        if (!expectDyn) return false;
        const scanAddOperand = (operand: ts.Expression, dynamic: boolean): boolean => {
          if (dynamic) return scanExpr(operand, true);
          const concrete = unwrap(operand);
          return concreteDynamicAssignmentOperandIsBuildable(concrete) && scanExpr(concrete, false);
        };
        return scanAddOperand(e.left, leftIsDyn) && scanAddOperand(e.right, rightIsDyn);
      }
      if (expectDyn) return false; // operator results are concrete-shaped

      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        if (leftIsDyn || rightIsDyn) {
          // #2949 S5.P — open only the concrete equality operands that the
          // from-ast producer can box without consulting a runtime type:
          // numeric/string/boolean literals plus null/undefined. Dynamic
          // operands already carry the exact tag and pass through unchanged.
          const scanEqualityOperand = (operand: ts.Expression, dynamic: boolean): boolean => {
            if (dynamic) {
              const candidate = unwrap(operand);
              // Dynamic member reads are not yet safe at callback boundaries:
              // legacy array methods pass their `obj` argument in the direct
              // array carrier, while __dyn_member_get expects boxed-any input.
              // Keep value-used functions (including named HOF callbacks)
              // pre-claim until that carrier seam is unified. A function whose
              // source references are all direct calls receives the canonical
              // declared ABI and can safely use the existing member producer.
              if (!dynamicMemberEqualityOperandIsBuildable(candidate)) return false;
              return scanExpr(candidate, true);
            }
            const concrete = unwrap(operand);
            // A scalar parameter projected from the direct declaration ABI is
            // just as boxable as a literal: from-ast has its exact f64/bool/
            // string IrType and emits the canonical box before dyn.eq.
            const strict =
              op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
            return concreteDynamicEqualityOperandIsBuildable(concrete, strict) && scanExpr(concrete, false);
          };
          return scanEqualityOperand(e.left, leftIsDyn) && scanEqualityOperand(e.right, rightIsDyn);
        }
      }

      if (
        op === ts.SyntaxKind.LessThanToken ||
        op === ts.SyntaxKind.LessThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanToken ||
        op === ts.SyntaxKind.GreaterThanEqualsToken
      ) {
        if (leftIsDyn || rightIsDyn) {
          // #2949 S5.P — the landed relational producer is deliberately the
          // numeric-abstract arm. Admit exactly one dynamic operand against a
          // proven numeric expression; dyn-vs-dyn may require the
          // string/string ARC arm. A concrete f64 counterpart makes the ARC
          // numeric by construction, so locals such as Acorn's `pos > code`
          // are as safe as numeric literals.
          if (leftIsDyn && rightIsDyn) {
            return currentDynamicRuntimeBuildable && scanExpr(e.left, true) && scanExpr(e.right, true);
          }
          const concrete = unwrap(leftIsDyn ? e.right : e.left);
          if (!expressionIsProvenNumber(concrete)) return false;
          return scanExpr(leftIsDyn ? e.left : e.right, true) && scanExpr(concrete, false);
        }
      }

      if (
        op === ts.SyntaxKind.MinusToken ||
        op === ts.SyntaxKind.AsteriskToken ||
        op === ts.SyntaxKind.SlashToken ||
        op === ts.SyntaxKind.PercentToken
      ) {
        // #2949 S5.P — these operators are pure ToNumber operations. A
        // dynamic-shaped operand uses dyn.to_number; a nested concrete
        // expression is recursively checked and must itself produce f64.
        return scanExpr(e.left, leftIsDyn) && scanExpr(e.right, rightIsDyn);
      }

      return scanExpr(e.left, false) && scanExpr(e.right, false);
    }
    if (ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) {
      if (expectDyn) return false;
      const op = e.operand;
      if (
        isDynShaped(op) &&
        ts.isPrefixUnaryExpression(e) &&
        (e.operator === ts.SyntaxKind.PlusToken ||
          e.operator === ts.SyntaxKind.MinusToken ||
          e.operator === ts.SyntaxKind.ExclamationToken)
      ) {
        return scanExpr(op, true);
      }
      if (
        isDynShaped(op) &&
        (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        return currentDynamicRuntimeBuildable && scanExpr(op, true);
      }
      return scanExpr(op, false);
    }
    if (ts.isConditionalExpression(e)) {
      const trueIsDynamic = isDynShaped(e.whenTrue);
      const falseIsDynamic = isDynShaped(e.whenFalse);
      if (expectDyn) {
        // The builder already accepts equal dynamic branch types. Keep mixed
        // dynamic/concrete joins out until the join can box the concrete arm.
        return (
          trueIsDynamic &&
          falseIsDynamic &&
          scanExpr(e.condition, isDynShaped(e.condition)) &&
          scanExpr(e.whenTrue, true) &&
          scanExpr(e.whenFalse, true)
        );
      }
      if (trueIsDynamic || falseIsDynamic) return false;
      return (
        scanExpr(e.condition, isDynShaped(e.condition)) && scanExpr(e.whenTrue, false) && scanExpr(e.whenFalse, false)
      );
    }
    if (ts.isPropertyAccessExpression(e)) {
      // #3053 U2 / #2949 S5.P — the claim-flip. A named read off a DYNAMIC
      // receiver (`dyn.name`) routes through `__dyn_member_get` (U0/U1) and
      // yields a `dynamic` result, so it is a valid MOVE exactly where a dynamic
      // value is wanted (`expectDyn`): return of a dyn-returning fn, a dyn-param
      // arg, a dyn alias/reassignment. from-ast's `lowerPropertyAccess` dyn arm
      // ALWAYS boxes the named key (tag-5), so there is no key-shape gate here —
      // the claim is 1:1 with the producer (never claim-then-demote).
      if (isDynShaped(e.expression)) {
        return currentDynMemberReadBuildable && expectDyn && scanExpr(e.expression, true);
      }
      // Concrete receiver: the existing typed member-read path (unchanged).
      if (expectDyn) return false;
      return scanExpr(e.expression, false);
    }
    if (ts.isElementAccessExpression(e)) {
      // #3053 U2 / #2949 S5.P — an indexed read off a DYNAMIC receiver
      // (`dyn[key]`) → `dynamic` result. from-ast's `lowerElementAccess` dyn arm
      // produces a NON-NULL key (so it does NOT demote) ONLY for: a string-literal
      // key (tag-5), a dynamic index (used as-is), or a numeric literal (tag-3).
      // Restrict the scan to EXACTLY those key shapes so the claim is 1:1 with the
      // producer — any other index (e.g. a bare i32 local, or dynamic arithmetic
      // like `idx-1`) may box to null / has no dynamic-arith producer, which would
      // claim-then-demote (a HARD error under JS2WASM_IR_FIRST). Result flows only
      // to a dyn-accepting position (`expectDyn`).
      if (isDynShaped(e.expression)) {
        if (!currentDynMemberReadBuildable || !expectDyn) return false;
        if (!scanExpr(e.expression, true)) return false;
        const key = unwrap(e.argumentExpression);
        if (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) return true;
        if (ts.isIdentifier(key) && dynNames.has(key.text)) return true; // dynamic index → used as-is
        return false; // any other index shape is out of the producer contract
      }
      // Concrete receiver: the existing typed element-read path (unchanged).
      if (expectDyn) return false;
      return scanExpr(e.expression, false) && scanExpr(e.argumentExpression, false);
    }
    // Everything else (literals, templates, object/array literals, closures,
    // new-expressions, typeof, …): fine exactly when no dynamic value is
    // involved AND the position doesn't require one.
    return !expectDyn && !subtreeTouchesDynamic(e, dynNames);
  };

  const scanStmt = (s: ts.Statement): boolean => {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) {
          if (subtreeTouchesDynamic(d, dynNames)) return false;
          continue;
        }
        const initIsDyn = isDynShaped(d.initializer);
        if (!scanExpr(d.initializer, initIsDyn)) return false;
        if (initIsDyn) dynNames.add(d.name.text);
      }
      return true;
    }
    if (ts.isReturnStatement(s)) {
      if (!s.expression) return true;
      if (!returnIsDynamic) return scanExpr(s.expression, false);
      if (isDynShaped(s.expression)) return scanExpr(s.expression, true);
      const concrete = unwrap(s.expression);
      // `coerceReturnValue` boxes only after the expression has lowered.
      // A mixed concrete ternary cannot form its join before that boundary;
      // keep it on direct codegen until branch-local boxing is represented.
      if (ts.isConditionalExpression(concrete)) return false;
      return concreteDynamicAssignmentOperandIsBuildable(concrete) && scanExpr(concrete, false);
    }
    if (ts.isExpressionStatement(s)) {
      const e = unwrap(s.expression);
      // Statement-position direct call: the result is DROPPED, so a dynamic
      // return is fine here regardless of the callee's return verdict.
      if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && !dynNames.has(e.expression.text)) {
        return scanDirectCallArgs(e, e.expression.text);
      }
      return scanExpr(s.expression, false);
    }
    if (ts.isIfStatement(s)) {
      return (
        scanExpr(s.expression, isDynShaped(s.expression)) &&
        scanStmt(s.thenStatement) &&
        (!s.elseStatement || scanStmt(s.elseStatement))
      );
    }
    if (ts.isBlock(s)) {
      for (const inner of s.statements) if (!scanStmt(inner)) return false;
      return true;
    }
    if (ts.isWhileStatement(s)) {
      return scanExpr(s.expression, isDynShaped(s.expression)) && scanStmt(s.statement);
    }
    if (ts.isForStatement(s)) {
      if (s.initializer) {
        if (ts.isVariableDeclarationList(s.initializer)) {
          for (const decl of s.initializer.declarations) {
            if (!decl.initializer) continue;
            if (!ts.isIdentifier(decl.name)) {
              if (subtreeTouchesDynamic(decl, dynNames)) return false;
              continue;
            }
            const initializerIsDynamic = isDynShaped(decl.initializer);
            if (!scanExpr(decl.initializer, initializerIsDynamic)) return false;
            if (initializerIsDynamic) dynNames.add(decl.name.text);
          }
        } else if (!scanExpr(s.initializer, false)) {
          return false;
        }
      }
      if (s.condition && !scanExpr(s.condition, isDynShaped(s.condition))) return false;
      if (s.incrementor && !scanExpr(s.incrementor, false)) return false;
      return scanStmt(s.statement);
    }
    if (ts.isForInStatement(s)) {
      return (
        currentSelectionOptions?.isDynamicForInReceiver?.(s.expression) === true &&
        isDynShaped(s.expression) &&
        scanExpr(s.expression, true) &&
        scanStmt(s.statement)
      );
    }
    // For-of / switch / try / throw / nested functions /
    // anything else: conservative — claimable exactly when the statement
    // doesn't touch a dynamic value at all.
    return !subtreeTouchesDynamic(s, dynNames);
  };

  for (const s of body.statements) {
    if (!scanStmt(s)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shape check
// ---------------------------------------------------------------------------

/**
 * Does `stmt` unconditionally terminate its control flow (return / throw, or a
 * block / if-else whose every path does)? EXACT mirror of the identically-named
 * helper in `from-ast.ts` (#1979) — the selector MUST agree with the builder on
 * which non-tail `if (cond) <then>; <rest>` shapes are early-return rewrites
 * (terminating then-arm → the then-arm is reinterpreted as a tail and `<rest>`
 * becomes the else) versus non-terminating guards (side-effecting then-arm →
 * `<rest>` runs afterward, lowered by the converging-guard path in
 * `lowerStatementList`). Drift here re-introduces select↔builder mismatch —
 * under #2138 IR-first that is a live `unreachable` trap, not a silent demote.
 */
function thenArmTerminates(stmt: ts.Statement): boolean {
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) {
    return true;
  }
  if (ts.isBlock(stmt)) {
    const last = stmt.statements[stmt.statements.length - 1];
    return last !== undefined && thenArmTerminates(last);
  }
  if (ts.isIfStatement(stmt)) {
    // An `if` terminates only when it has an else and BOTH arms terminate.
    return (
      stmt.elseStatement !== undefined && thenArmTerminates(stmt.thenStatement) && thenArmTerminates(stmt.elseStatement)
    );
  }
  return false;
}

function isPhase1StatementList(
  stmts: ReadonlyArray<ts.Statement>,
  scope: Set<string>,
  localClasses: ReadonlySet<string>,
  isGenerator: boolean = false,
  isVoidReturn: boolean = false,
): boolean {
  return withProjectionEvidenceScope(() =>
    withLexicalValueBindingScope(stmts, () =>
      isPhase1StatementListInScope(stmts, scope, localClasses, isGenerator, isVoidReturn),
    ),
  );
}

function isPhase1StatementListInScope(
  stmts: ReadonlyArray<ts.Statement>,
  scope: Set<string>,
  localClasses: ReadonlySet<string>,
  // Slice 7b (#1169f): when true, the enclosing function is a
  // `function*` and bare `return;` (no expression) is allowed in tail
  // position. Threaded down to `isPhase1Tail` to relax the "tail must
  // have expression" rule for generators only — non-generators with
  // bare returns continue to be rejected (their return type wouldn't
  // resolve to a primitive anyway).
  isGenerator: boolean = false,
  // Slice 14 (#1228): when true, the enclosing function returns void.
  // Allows bare `return;` and ExpressionStatement at the tail position
  // (the lowerer synthesizes the implicit empty-values return).
  isVoidReturn: boolean = false,
): boolean {
  if (stmts.length < 1)
    return shapeNo("stmt-list-empty", stmts.length ? stmts[0]! : ({ kind: ts.SyntaxKind.Block } as ts.Node));
  for (let i = 0; i < stmts.length - 1; i++) {
    const s = stmts[i]!;
    // Phase 1: VariableStatements before the tail.
    if (ts.isVariableStatement(s)) {
      if (!isPhase1VarDecl(s, scope, localClasses)) return shapeNo("nontail-vardecl", s);
      continue;
    }
    // Slice 3 (#1169c): nested function declaration. Treated like a
    // const-bound arrow — the name enters scope, the body is shape-
    // checked recursively, self-reference is rejected (no slice-3
    // self-recursive nested funcs).
    if (ts.isFunctionDeclaration(s)) {
      if (!isPhase1NestedFunc(s, scope, localClasses)) return false;
      continue;
    }
    // Slice 3 (#1169c): bare call expression statement (drop the result).
    // Lets `inc(); inc(); inc();` patterns work for closures with side
    // effects through ref-cell captures.
    //
    // Slice 4 (#1169d): also accept assignment expressions whose LHS is
    // a property-access on a (presumably class) receiver — i.e.
    // `obj.field = expr;`. The lowerer enforces the receiver IS a class
    // shape; if not, the function falls back to legacy.
    if (ts.isExpressionStatement(s)) {
      if (ts.isCallExpression(s.expression)) {
        if (!isPhase1Expr(s.expression, scope, localClasses)) return shapeNo("nontail-callstmt", s.expression);
        continue;
      }
      // Slice 7a/7b (#1169f): `yield`/`yield <expr>`/`yield* <expr>` as a
      // statement. Only valid when the enclosing function is a generator
      // — that check is enforced by the lowerer (`lowerYield` throws when
      // `cx.funcKind !== "generator"`). The selector accepts the shape
      // unconditionally because functions that nest a yield in a
      // non-generator are ill-typed and would have failed TS source
      // checking before reaching us.
      //
      // Slice 7b accepts:
      //   - `yield;`              — bare yield, lowered as gen.push of a
      //                             null externref (matches legacy
      //                             "yield with no value" semantics).
      //   - `yield <phase1-expr>` — any Phase-1 expression body. The
      //                             from-ast lowerer dispatches by IrType:
      //                             f64/i32 use the typed __gen_push_*
      //                             import; everything else coerces to
      //                             externref and uses __gen_push_ref.
      //   - `yield* <iterable>`   — delegation; lowered as
      //                             gen.yieldStar(coerced_iterable).
      if (ts.isYieldExpression(s.expression)) {
        if (s.expression.expression) {
          if (!isPhase1Expr(s.expression.expression, scope, localClasses))
            return shapeNo("nontail-yield-expr", s.expression);
        } else if (s.expression.asteriskToken) {
          // `yield*` MUST have an expression — TS parser enforces this,
          // but be defensive.
          return shapeNo("nontail-yieldstar-noexpr", s.expression);
        }
        continue;
      }
      // Capability C: a plain write to the exact checker-owned mutable
      // module declaration. Local assignments remain outside this top-level
      // statement-list arm; body buffers already own them.
      if (
        ts.isBinaryExpression(s.expression) &&
        s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(s.expression.left)
      ) {
        const moduleBinding = currentModuleBindingResolver?.(s.expression.left);
        if (moduleBinding) {
          if (!currentModuleBindingResolver?.(s.expression.left, s.expression.right)) {
            return shapeNo("nontail-module-assign-incompatible", s.expression);
          }
          if (!isPhase1Expr(s.expression.right, scope, localClasses)) {
            return shapeNo("nontail-module-assign-rhs", s.expression.right);
          }
          continue;
        }
        if (currentMutableParamSlotNames.has(s.expression.left.text)) {
          if (!isPhase1Expr(s.expression.right, scope, localClasses)) {
            return shapeNo("nontail-param-assign-rhs", s.expression.right);
          }
          clearProjectionBinding(s.expression.left.text);
          continue;
        }
      }
      if (
        ts.isBinaryExpression(s.expression) &&
        s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(s.expression.left)
      ) {
        // LHS: <expr>.<id> — receiver expr must be Phase-1, prop must be an
        // Identifier or (#3000) a PrivateIdentifier (`this.#x = v`).
        if (!ts.isIdentifier(s.expression.left.name) && !ts.isPrivateIdentifier(s.expression.left.name))
          return shapeNo("nontail-assign-computedprop", s.expression);
        if (!moduleExternPropertyWriteIsProven(s.expression.left, s.expression.right)) {
          return shapeNo("nontail-module-extern-assign-value", s.expression.right);
        }
        if (!preflightClassPropertyWrite(s.expression.left, scope)) return false;
        if (!isPhase1Expr(s.expression.left.expression, scope, localClasses))
          return shapeNo("nontail-assign-recv", s.expression.left.expression);
        // RHS: any Phase-1 expression.
        if (!isPhase1Expr(s.expression.right, scope, localClasses))
          return shapeNo("nontail-assign-rhs", s.expression.right);
        continue;
      }
      // (#2856 C2) element store `<id>[<idx>] = <rhs>;` as a NON-TAIL
      // statement — quicksort's post-partition swap (`arr[i + 1] = arr[hi];
      // arr[hi] = tmp;`). Same receiver restriction as the body-buffer arm:
      // a plain in-scope identifier; the lowerer dispatches on its IrType.
      if (
        ts.isBinaryExpression(s.expression) &&
        s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isElementAccessExpression(s.expression.left)
      ) {
        const lhs = s.expression.left;
        if (!ts.isIdentifier(lhs.expression) || !scope.has(lhs.expression.text)) {
          return shapeNo("nontail-elemstore-recv", lhs.expression);
        }
        if (!isPhase1Expr(lhs.argumentExpression, scope, localClasses))
          return shapeNo("nontail-elemstore-idx", lhs.argumentExpression);
        if (!isPhase1Expr(s.expression.right, scope, localClasses))
          return shapeNo("nontail-elemstore-rhs", s.expression.right);
        continue;
      }
      // #3787 / #2856 — top-level-in-body compound assignment. The body
      // statement dispatcher already admitted and lowered this exact slot
      // shape; mirror it here for `<early return>; x -= n; return ...`.
      if (
        ts.isBinaryExpression(s.expression) &&
        (s.expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ||
          s.expression.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken ||
          s.expression.operatorToken.kind === ts.SyntaxKind.AsteriskEqualsToken ||
          s.expression.operatorToken.kind === ts.SyntaxKind.SlashEqualsToken) &&
        ts.isIdentifier(s.expression.left)
      ) {
        if (isUnrepresentableModuleBinding(s.expression.left)) {
          return shapeNo("nontail-module-storage-unrepresentable", s.expression);
        }
        if (currentModuleBindingResolver?.(s.expression.left) && !currentSubjectIsModuleInit) {
          return shapeNo("nontail-module-compound", s.expression);
        }
        if (!scope.has(s.expression.left.text)) return shapeNo("nontail-compound-scope", s.expression.left);
        if (projectionBindingMutationIsUnsupported(s.expression.left.text, s.expression)) return false;
        if (!isPhase1Expr(s.expression.right, scope, localClasses)) {
          return shapeNo("nontail-compound-rhs", s.expression.right);
        }
        clearProjectionBinding(s.expression.left.text);
        continue;
      }
      // (#2856) Catch-all for ExpressionStatements outside the accepted set:
      // mutable local assignment `x = e` / element assignment `arr[i] = e`
      // (LHS not a PropertyAccess), postfix/prefix `++`/`--`, compound
      // assignment `+=`, etc. Label by the offending expression kind + operator
      // so the histogram distinguishes assignment from inc-dec.
      const es = s.expression;
      let arm = "nontail-exprstmt-other";
      if (ts.isBinaryExpression(es)) {
        arm =
          es.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ? "nontail-assign-nonprop-lhs"
            : "nontail-compound-or-binary-stmt";
      } else if (ts.isPrefixUnaryExpression(es) || ts.isPostfixUnaryExpression(es)) {
        arm = "nontail-incdec-stmt";
      }
      return shapeNo(arm, es);
    }
    // Phase 2 extension: an `if (cond)` with NO else, split by whether the
    // then-arm unconditionally terminates — mirroring `lowerStatementList`'s
    // `thenArmTerminates` fork in `from-ast.ts` exactly (#1979).
    // (#2856 calendar residual) A converging top-level `if/else` followed by
    // more statements is already representable by the structured `if.stmt`
    // instruction used inside loop/body buffers. Keep this arm deliberately
    // narrower than the tail-CFG path below: neither branch may return out of
    // the function, and branch-local declarations do not escape. This is the
    // exact shape of calendar::onDay's selection-state update before its two
    // trailing render calls.
    if (ts.isIfStatement(s) && s.elseStatement) {
      if (!isPhase1ConditionExpr(s.expression, scope, localClasses)) {
        return shapeNo("nontail-ifelse-cond", s.expression);
      }
      if (
        !withProjectionEvidenceScope(() =>
          isPhase1BodyStatement(s.thenStatement, new Set(scope), localClasses, /* inLoop */ false),
        )
      ) {
        return shapeNo("nontail-ifelse-then", s.thenStatement);
      }
      if (
        !withProjectionEvidenceScope(() =>
          isPhase1BodyStatement(s.elseStatement!, new Set(scope), localClasses, /* inLoop */ false),
        )
      ) {
        return shapeNo("nontail-ifelse-else", s.elseStatement);
      }
      continue;
    }
    if (ts.isIfStatement(s) && !s.elseStatement) {
      if (!isPhase1ConditionExpr(s.expression, scope, localClasses)) return shapeNo("nontail-if-cond", s.expression);
      if (thenArmTerminates(s.thenStatement)) {
        // Early-return rewrite: `if (cond) <tail>; <rest>` ≡
        // `if (cond) <tail> else { <rest> }`. The then-arm must be a Phase-1
        // tail (terminates on every path); the rest becomes the else block.
        if (
          !withProjectionEvidenceScope(() =>
            isPhase1Tail(s.thenStatement, new Set(scope), localClasses, isGenerator, isVoidReturn),
          )
        )
          return shapeNo("nontail-if-then", s.thenStatement);
        const rest = stmts.slice(i + 1);
        return isPhase1StatementList(rest, new Set(scope), localClasses, isGenerator, isVoidReturn);
      }
      // (#1979) Non-terminating guard: `if (cond) <side-effecting-stmt>;` where
      // the then-arm is a plain body statement (assignment, call, nested guard,
      // …). `from-ast.ts` lowers this via the converging-guard path
      // (`lowerStatementList` lines ~759-782 → `lowerStmt(thenArm)`), so the
      // shape-check for the then-arm mirrors `lowerStmt`'s accepted set exactly
      // (`isPhase1BodyStatement`, not a tail). `<rest>` runs afterward — the
      // outer loop continues validating it (ending in the tail), matching
      // from-ast's `lowerStatementList(rest)` in the continuation block. The
      // then-arm scope is cloned so arm-local `let`s don't leak into `<rest>`.
      // Not in a loop here → `inLoop=false` (break/continue in the guard stay
      // rejected; a `return` would have made `thenArmTerminates` true above).
      if (
        !withProjectionEvidenceScope(() =>
          isPhase1BodyStatement(s.thenStatement, new Set(scope), localClasses, /* inLoop */ false),
        )
      )
        return shapeNo("nontail-if-then-guard", s.thenStatement);
      continue;
    }
    // Slice 6 part 2 (#1181) — for-of statement (always non-tail). The
    // body is itself shape-checked. The bridge in `from-ast.ts` lowers
    // the iterable expression and dispatches to the vec fast path when
    // the iterable's IR type resolves to a vec ref; non-vec iterables
    // throw and the function falls back to legacy.
    if (ts.isForOfStatement(s)) {
      if (!isPhase1ForOf(s, scope, localClasses)) return shapeNo("nontail-forof", s);
      continue;
    }
    // #2952 slice 5 — the narrow dynamic-receiver for-in slice. The
    // checker-backed capability callback keeps typed/fast receivers out.
    if (ts.isForInStatement(s)) {
      if (!isPhase1ForInStatement(s, scope, localClasses)) return shapeNo("nontail-forin", s);
      continue;
    }
    // Slice 12 (#1280) — `while` / `for` (C-style) as non-tail
    // statements. The body is shape-checked via `isPhase1BodyStatement`
    // (same restrictions as for-of).
    if (ts.isWhileStatement(s)) {
      if (!isPhase1WhileStatement(s, scope, localClasses)) return shapeNo("nontail-while", s);
      continue;
    }
    if (ts.isForStatement(s)) {
      if (!isPhase1ForStatement(s, scope, localClasses)) return shapeNo("nontail-for", s);
      // Add init's let-declared names into outer scope so subsequent
      // statements can reference the loop counter (TypeScript would
      // narrow scope to the for-statement, but our scope tracker is
      // a flat set; the conservative addition is fine for shape check).
      // (#2856) Record the leak so a SIBLING for-init may re-declare it.
      if (s.initializer && ts.isVariableDeclarationList(s.initializer)) {
        for (const d of s.initializer.declarations) {
          if (ts.isIdentifier(d.name) && !scope.has(d.name.text)) {
            scope.add(d.name.text);
            forInitLeakedNames.add(d.name.text);
          }
        }
      }
      continue;
    }
    // #2952 slice 1 — `do { body } while (cond)` as a non-tail statement.
    // Post-test loop; same body-shape restrictions as `while` / `for`.
    if (ts.isDoStatement(s)) {
      if (!isPhase1DoStatement(s, scope, localClasses)) return shapeNo("nontail-do", s);
      continue;
    }
    // #2952 slice 3 — `lbl: <loop>` as a non-tail statement. The label set
    // starts empty here: a top-level statement list is never inside a loop,
    // so no outer labels can be in scope.
    if (ts.isLabeledStatement(s)) {
      if (!isPhase1LabeledStatement(s, scope, localClasses, NO_LABELS)) return shapeNo("nontail-labeled", s);
      continue;
    }
    // #2952 slice 4 — `switch (...)` as a non-tail statement.
    if (ts.isSwitchStatement(s)) {
      if (!isPhase1SwitchStatement(s, scope, localClasses)) return shapeNo("nontail-switch", s);
      continue;
    }
    // Slice 9 (#1169h) — throw / try as a non-tail statement. A throw
    // doesn't fall through, but the selector accepts it in non-tail
    // position and the lowerer emits a `throw` instr followed by an
    // implicit unreachable. (Code AFTER a throw in the same block is
    // dead but structurally valid.)
    if (ts.isThrowStatement(s)) {
      if (!isPhase1ThrowStatement(s, scope, localClasses)) return shapeNo("nontail-throw", s);
      continue;
    }
    if (ts.isTryStatement(s)) {
      if (!isPhase1TryStatement(s, scope, localClasses)) return shapeNo("nontail-try", s);
      continue;
    }
    // (#2856) Unhandled statement KIND at non-tail position — `if`-with-`else`,
    // `switch`, `do`, labeled, `break`/`continue`, `for-in`, empty, etc. The
    // node kind is the discriminator.
    return shapeNo("nontail-unhandled-stmt", s);
  }
  return isPhase1Tail(stmts[stmts.length - 1]!, scope, localClasses, isGenerator, isVoidReturn);
}

/**
 * Slice 9 (#1169h): shape-check a `throw <expr>;` statement. Bare
 * `throw;` (no expression) is rejected — the legacy path handles that
 * rare case. The expression must itself be a Phase-1 expression, so the
 * lowerer can produce a value to coerce to externref before throwing.
 */
function isPhase1ThrowStatement(
  stmt: ts.ThrowStatement,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
): boolean {
  if (!stmt.expression) return false;
  if (expressionTouchesModuleMapGetAlias(stmt.expression)) {
    return shapeNo("throw-module-map-get-alias", stmt.expression);
  }
  if (expressionTouchesScalarModuleBinding(stmt.expression) && obviousModuleValueFamily(stmt.expression) !== "string") {
    return shapeNo("throw-module-scalar-unboxed", stmt.expression);
  }
  return isPhase1Expr(stmt.expression, scope, localClasses);
}

/**
 * Slice 9 (#1169h): shape-check a `try { ... } [catch (e) { ... }]
 * [finally { ... }]` statement.
 *
 * Accepted shapes (selector level):
 *   try { <body> } catch (id) { <handler> }
 *   try { <body> } catch { <handler> }                  (ES2019 optional catch)
 *   try { <body> } finally { <cleanup> }
 *   try { <body> } catch (id) { <handler> } finally { <cleanup> }
 *
 * Where `<body>`, `<handler>`, and `<cleanup>` are each Phase-1 body
 * statement lists (no early return / break / continue out of the try
 * region — slice 9 doesn't yet thread the finally-stack inlining for
 * abrupt completions).
 *
 * Rejected (deferred to slice 9.5):
 *   - destructuring catch param (`catch ({message})`).
 *   - `throw` with no expression (handled in `isPhase1ThrowStatement`).
 *   - `try` with neither catch nor finally (TS already rejects this).
 *   - early-return / break / continue inside try / catch / finally bodies
 *     (the body-statement recogniser doesn't allow them anyway).
 */
function isPhase1TryStatement(
  stmt: ts.TryStatement,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
  inLoop: boolean = false,
  labels: ReadonlySet<string> = NO_LABELS,
  breaks: BreakScope = NO_BREAKS,
): boolean {
  return withProjectionEvidenceScope(() =>
    isPhase1TryStatementInScope(stmt, scope, localClasses, inLoop, labels, breaks),
  );
}

function isPhase1TryStatementInScope(
  stmt: ts.TryStatement,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
  // #2952 slice 2 — propagated so a break/continue inside a try nested in a
  // loop is claimable (the lowerer inlines crossed finallys before the br).
  inLoop: boolean = false,
  // #2952 slice 3 — enclosing labeled-loop names, same propagation.
  labels: ReadonlySet<string> = NO_LABELS,
  breaks: BreakScope = NO_BREAKS,
): boolean {
  if (!stmt.catchClause && !stmt.finallyBlock) return shapeNo("try-missing-handler", stmt);

  // (#2856 C1) try/catch/finally bodies are early-return BARRIERS: a Wasm
  // `return` inside them would skip the inlined finally blocks. (#2952 s2's
  // break/continue is different — its `br.label` lowering inlines crossed
  // finallys, so `inLoop` propagates while the early-return arm stays barred.)
  earlyReturnBarrierDepth++;
  try {
    // Try body: must be a Phase-1 body statement list.
    const tryAccepted = withProjectionEvidenceScope(() =>
      withLexicalValueBindingScope(stmt.tryBlock.statements, () => {
        const tryScope = new Set(scope);
        for (const s of stmt.tryBlock.statements) {
          if (!isPhase1BodyStatement(s, tryScope, localClasses, inLoop, labels, breaks))
            return shapeNo("try-body-stmt", s);
        }
        return true;
      }),
    );
    if (!tryAccepted) return false;

    if (stmt.catchClause) {
      const catchAccepted = withProjectionEvidenceScope(() =>
        withLexicalValueBindingScope(stmt.catchClause!.block.statements, () => {
          const catchScope = new Set(scope);
          if (stmt.catchClause!.variableDeclaration) {
            const v = stmt.catchClause!.variableDeclaration;
            // Slice 9 only accepts identifier bindings. Destructuring catch
            // (`catch ({message})`) defers to slice 9.5.
            if (!ts.isIdentifier(v.name)) return shapeNo("try-catch-binding", v.name);
            if (trackedModuleAliasHasName(v.name.text)) {
              return shapeNo("try-catch-module-alias-shadow", v.name);
            }
            clearProjectionBinding(v.name.text);
            catchScope.add(v.name.text);
          }
          for (const s of stmt.catchClause!.block.statements) {
            if (!isPhase1BodyStatement(s, catchScope, localClasses, inLoop, labels, breaks))
              return shapeNo("try-catch-body-stmt", s);
          }
          return true;
        }),
      );
      if (!catchAccepted) return false;
    }

    if (stmt.finallyBlock) {
      const finallyAccepted = withProjectionEvidenceScope(() =>
        withLexicalValueBindingScope(stmt.finallyBlock!.statements, () => {
          const finallyScope = new Set(scope);
          for (const s of stmt.finallyBlock!.statements) {
            if (!isPhase1BodyStatement(s, finallyScope, localClasses, inLoop, labels, breaks))
              return shapeNo("try-finally-body-stmt", s);
          }
          return true;
        }),
      );
      if (!finallyAccepted) return false;
    }

    return true;
  } finally {
    earlyReturnBarrierDepth--;
  }
}

/**
 * Slice 6 part 2 (#1181): shape-check a `for (... of ...)` statement.
 *
 * Accepted: `for ((const|let) <id> of <expr>) <body>` with an
 * Identifier-named loop variable and a Phase-1-acceptable iterable.
 * The body must itself be a Phase-1 body-statement.
 *
 * Rejected (defer to follow-up slices):
 *   - `for await` (slice 7 — async iteration, #1169f).
 *   - destructuring init (slice 8, #1169g).
 *   - bare-identifier init (`for (x of arr)` without `let`/`const`).
 *   - missing initializer.
 */
function isPhase1ForOf(
  stmt: ts.ForOfStatement,
  scope: Set<string>,
  localClasses: ReadonlySet<string>,
  labels: ReadonlySet<string> = NO_LABELS,
  breaks: BreakScope = NO_BREAKS,
): boolean {
  return withProjectionEvidenceScope(() => isPhase1ForOfInScope(stmt, scope, localClasses, labels, breaks));
}

function isPhase1ForOfInScope(
  stmt: ts.ForOfStatement,
  scope: Set<string>,
  localClasses: ReadonlySet<string>,
  labels: ReadonlySet<string> = NO_LABELS,
  breaks: BreakScope = NO_BREAKS,
): boolean {
  if (stmt.awaitModifier) return false;
  if (!ts.isVariableDeclarationList(stmt.initializer)) return false;
  const flags = stmt.initializer.flags;
  if (!(flags & ts.NodeFlags.Let) && !(flags & ts.NodeFlags.Const)) return false;
  if (stmt.initializer.declarations.length !== 1) return false;
  const decl = stmt.initializer.declarations[0]!;
  if (!ts.isIdentifier(decl.name)) return false;
  if (decl.initializer) return false; // for-of decl shouldn't have an `=` initializer
  if (expressionTouchesModuleExtern(stmt.expression)) {
    return shapeNo("forof-module-extern-iterable", stmt.expression);
  }
  if (!isPhase1Expr(stmt.expression, scope, localClasses)) return false;
  const innerScope = new Set(scope);
  clearProjectionBinding(decl.name.text);
  innerScope.add(decl.name.text);
  // (#2856 C1) A for-of body is an early-return BARRIER: the iterator-
  // protocol drive would skip its `iter.return` cleanup on a Wasm return
  // (whether the iterable resolves to the vec fast path is a lowering-time
  // fact the shape walk can't see, so be conservative for all for-ofs).
  // #2952 s2's break/continue stays claimable (`inLoop` true — its br.label
  // targets the loop label, not a function exit).
  earlyReturnBarrierDepth++;
  try {
    return isPhase1BodyStatement(
      stmt.statement,
      innerScope,
      localClasses,
      /* inLoop (#2952 s2) */ true,
      labels,
      breaks,
    );
  } finally {
    earlyReturnBarrierDepth--;
  }
}

/**
 * Slice 12 (#1280): shape-check `while (cond) body`.
 *   - `cond` must be a Phase-1 expression.
 *   - `body` must be a single statement that's a Phase-1 body statement
 *     (same restrictions as a for-of body — see `isPhase1BodyStatement`).
 */
function isPhase1WhileStatement(
  stmt: ts.WhileStatement,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
  labels: ReadonlySet<string> = NO_LABELS,
  breaks: BreakScope = NO_BREAKS,
): boolean {
  return withProjectionEvidenceScope(() => isPhase1WhileStatementInScope(stmt, scope, localClasses, labels, breaks));
}

function isPhase1WhileStatementInScope(
  stmt: ts.WhileStatement,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
  labels: ReadonlySet<string> = NO_LABELS,
  breaks: BreakScope = NO_BREAKS,
): boolean {
  if (!isPhase1ConditionExpr(stmt.expression, scope, localClasses)) return false;
  // (#2856 C1) while bodies admit the early-return arm.
  earlyReturnLoopDepth++;
  try {
    return isPhase1BodyStatement(
      stmt.statement,
      new Set(scope),
      localClasses,
      /* inLoop (#2952 s2) */ true,
      labels,
      breaks,
    );
  } finally {
    earlyReturnLoopDepth--;
  }
}

/**
 * #2952 slice 1 — shape-check `do { body } while (cond)`. Identical
 * constraints to `while`: a Phase-1 condition expression and a Phase-1
 * body statement. The only runtime difference (body-before-cond) is a
 * lowering concern, not a shape concern. Slice 2 lifted the slice-1
 * break/continue restriction: unlabeled break/continue in the body is
 * claimable via the `inLoop` gate + `br.label` lowering. The claim is
 * backed by `lowerDoStatement` (postCond `while.loop`) —
 * selector↔builder parity.
 */
function isPhase1DoStatement(
  stmt: ts.DoStatement,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
  labels: ReadonlySet<string> = NO_LABELS,
  breaks: BreakScope = NO_BREAKS,
): boolean {
  return withProjectionEvidenceScope(() => isPhase1DoStatementInScope(stmt, scope, localClasses, labels, breaks));
}

function isPhase1DoStatementInScope(
  stmt: ts.DoStatement,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
  labels: ReadonlySet<string> = NO_LABELS,
  breaks: BreakScope = NO_BREAKS,
): boolean {
  if (!isPhase1ConditionExpr(stmt.expression, scope, localClasses)) return false;
  // (#2856 C1) do-while bodies admit the early-return arm.
  earlyReturnLoopDepth++;
  try {
    return isPhase1BodyStatement(
      stmt.statement,
      new Set(scope),
      localClasses,
      /* inLoop (#2952 s2) */ true,
      labels,
      breaks,
    );
  } finally {
    earlyReturnLoopDepth--;
  }
}

/** #2952 slice 3 — empty label set (the default for non-labeled contexts). */
const NO_LABELS: ReadonlySet<string> = new Set();

/**
 * #2952 slice 4 — break-only bindings in scope: `inSwitch` makes an
 * UNLABELED `break` claimable outside a loop (it binds the switch,
 * §14.9); `names` are labels bound by enclosing labeled BLOCKS /
 * labeled SWITCHES (valid for labeled break, never for continue).
 * Threaded through the body walks exactly like `inLoop`/`labels`.
 */
interface BreakScope {
  readonly inSwitch: boolean;
  readonly names: ReadonlySet<string>;
}
const NO_BREAKS: BreakScope = { inSwitch: false, names: NO_LABELS };

/**
 * #2952 slice 4 — the numeric value of a claimable `case` test: a plain
 * NumericLiteral or prefix-minus NumericLiteral. EXACT mirror of
 * from-ast's `numericLiteralValue` (selector↔builder parity). `null`
 * for any other expression shape.
 */
function numericCaseTestValue(expr: ts.Expression): number | null {
  if (ts.isNumericLiteral(expr)) return Number(expr.text.replace(/_/g, ""));
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return -Number(expr.operand.text.replace(/_/g, ""));
  }
  return null;
}

/**
 * #2952 slice 4 — shape-check `switch (disc) { case <numeric literal>:
 * ...; default: ... }`. Backed by `lowerSwitchStatement` (block-per-case
 * ladder). Constraints:
 *   - disc: Phase-1 expression (i32/f64 at lowering — ref/string discs
 *     demote there, same discipline as loop conds, #2136);
 *   - every case test a numeric literal (compile-time dispatch table);
 *   - at most one `default` (dup default is a JS SyntaxError anyway);
 *   - clause statements are body statements sharing ONE scope across
 *     clauses (§14.12 — one declaration scope; mirrors from-ast's shared
 *     `switchCx`), with `inSwitch` set so unlabeled `break` claims and
 *     the early-return arm admitted (a Wasm `return` unwinds the case
 *     blocks natively — same soundness as the loop-body arm, #2856 C1).
 */
function isPhase1SwitchStatement(
  stmt: ts.SwitchStatement,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
  inLoop: boolean = false,
  labels: ReadonlySet<string> = NO_LABELS,
  breaks: BreakScope = NO_BREAKS,
  boundNames: ReadonlySet<string> = NO_LABELS,
): boolean {
  return withProjectionEvidenceScope(() => {
    if (!isPhase1Expr(stmt.expression, scope, localClasses)) return shapeNo("switch-disc", stmt.expression);
    let defaults = 0;
    for (const clause of stmt.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) {
        if (numericCaseTestValue(clause.expression) === null) {
          return shapeNo("switch-case-test-nonliteral", clause.expression);
        }
      } else {
        defaults++;
        if (defaults > 1) return shapeNo("switch-multiple-defaults", clause);
      }
    }
    const clauseBreaks: BreakScope = { inSwitch: true, names: new Set([...breaks.names, ...boundNames]) };
    const clauseScope = new Set(scope); // one shared scope across clauses (§14.12)
    // (#2856 C1) Switch clauses admit the early-return arm — a Wasm
    // return unwinds the case blocks natively (barriers still bar it).
    earlyReturnLoopDepth++;
    try {
      for (const clause of stmt.caseBlock.clauses) {
        for (const s of clause.statements) {
          if (!isPhase1BodyStatement(s, clauseScope, localClasses, inLoop, labels, clauseBreaks)) {
            return shapeNo("switch-clause-stmt", s);
          }
        }
      }
    } finally {
      earlyReturnLoopDepth--;
    }
    return true;
  });
}

/**
 * #2952 slice 3 — shape-check `lbl: <loop>`. Only labeled LOOPS are
 * claimed (while / do / for / for-of, plus nested labels `a: b: while` —
 * all names bind the same loop). A labeled NON-loop statement
 * (`lbl: { ... break lbl; }`) needs a `labeled.block` IR kind — banked
 * for the switch slice, since a switch's `break` targets exactly that
 * frame shape — and demotes to legacy here. Backed by
 * `lowerLabeledStatement` in from-ast — selector↔builder parity.
 */
function isPhase1LabeledStatement(
  stmt: ts.LabeledStatement,
  scope: Set<string>,
  localClasses: ReadonlySet<string>,
  labels: ReadonlySet<string>,
  // #2952 slice 4 — threaded so a bare `continue` in a labeled switch
  // nested in a loop stays claimable, and outer break-only labels stay
  // visible inside.
  inLoop: boolean = false,
  breaks: BreakScope = NO_BREAKS,
): boolean {
  const boundNames = new Set<string>();
  let inner: ts.Statement = stmt;
  while (ts.isLabeledStatement(inner)) {
    boundNames.add(inner.label.text);
    inner = inner.statement;
  }
  // Labeled LOOPS bind for break AND continue (slice 3).
  const bound = new Set([...labels, ...boundNames]);
  if (ts.isWhileStatement(inner)) return isPhase1WhileStatement(inner, scope, localClasses, bound, breaks);
  if (ts.isDoStatement(inner)) return isPhase1DoStatement(inner, scope, localClasses, bound, breaks);
  if (ts.isForStatement(inner)) return isPhase1ForStatement(inner, scope, localClasses, bound, breaks);
  if (ts.isForOfStatement(inner)) return isPhase1ForOf(inner, scope, localClasses, bound, breaks);
  // (slice 4) Labeled SWITCH: the labels alias the switch's break frame.
  if (ts.isSwitchStatement(inner)) {
    return isPhase1SwitchStatement(inner, scope, localClasses, inLoop, labels, breaks, boundNames);
  }
  // (slice 4) Any other labeled statement — a break-only `labeled.block`
  // frame around a single body statement.
  const blockBreaks: BreakScope = { inSwitch: breaks.inSwitch, names: new Set([...breaks.names, ...boundNames]) };
  return withProjectionEvidenceScope(() =>
    isPhase1BodyStatement(inner, new Set(scope), localClasses, inLoop, labels, blockBreaks),
  );
}

/**
 * Slice 12 (#1280): shape-check `for (init; cond; update) body`.
 *
 *   - `init`   optional. When present, accepts either a
 *              `VariableDeclarationList` (`for (let i = 0; ...)`) — same
 *              shape as `isPhase1VarDecl` (single named decl with a
 *              Phase-1 initializer; multi-decl is OK if each is named) —
 *              or a Phase-1 expression (`for (i = 0; ...)`).
 *   - `cond`   optional. Empty cond means infinite loop — rejected for
 *              now; the typical pattern `for (;;) { ... break ... }`
 *              would require break support which is deferred. When
 *              present, must be a Phase-1 expression.
 *   - `update` optional. Phase-1 expression. The most common shapes are
 *              postfix `i++` / `i--`, prefix `++i` / `--i`, compound
 *              assignment `i += 1`, or plain assignment `i = i + 1`.
 *   - `body`   single Phase-1 body statement.
 *
 * The init's let-bindings enter scope before cond/update/body are
 * shape-checked.
 */
function isPhase1ForStatement(
  stmt: ts.ForStatement,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
  labels: ReadonlySet<string> = NO_LABELS,
  breaks: BreakScope = NO_BREAKS,
): boolean {
  return withProjectionEvidenceScope(() => isPhase1ForStatementInScope(stmt, scope, localClasses, labels, breaks));
}

function isPhase1ForStatementInScope(
  stmt: ts.ForStatement,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
  labels: ReadonlySet<string> = NO_LABELS,
  breaks: BreakScope = NO_BREAKS,
): boolean {
  // Cond must be present (no infinite loops in slice 12).
  if (!stmt.condition) return shapeNo("for-missing-cond", stmt);

  const innerScope = new Set(scope);

  // Init: optional. Variable declaration adds bindings; expression init
  // doesn't. Both must be Phase-1.
  if (stmt.initializer) {
    if (ts.isVariableDeclarationList(stmt.initializer)) {
      const flags = stmt.initializer.flags;
      const isLexical = !!(flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
      if (!isLexical && !currentIrSafeVarDeclarationLists.has(stmt.initializer))
        return shapeNo("for-init-var-kind", stmt.initializer);
      for (const d of stmt.initializer.declarations) {
        if (!ts.isIdentifier(d.name)) return shapeNo("for-init-name", d.name);
        if (!d.initializer) return shapeNo("for-init-noinit", d);
        // (#2856) A name a SIBLING for-init leaked into the flat scope set is
        // NOT a genuine duplicate — from-ast scopes each for-init in its own
        // innerCx copy, so `for (let i...) {} for (let i...) {}` builds fine.
        // Genuine outer bindings still reject (build-side redeclaration).
        if (innerScope.has(d.name.text) && !forInitLeakedNames.has(d.name.text))
          return shapeNo("for-init-shadow", d.name); // duplicate
        clearProjectionBinding(d.name.text);
        innerScope.add(d.name.text);
        if (!isPhase1Expr(d.initializer, innerScope, localClasses)) return shapeNo("for-init-expr", d.initializer);
        const className = localClassNameForExpression(d.initializer, innerScope);
        if (className !== null) currentClassBindings.set(d.name.text, className);
      }
    } else {
      // Expression init.
      if (!isPhase1Expr(stmt.initializer, innerScope, localClasses)) return shapeNo("for-init-expr", stmt.initializer);
    }
  }

  // Cond: must be a Phase-1 expression in the inner scope.
  if (!isPhase1ConditionExpr(stmt.condition, innerScope, localClasses)) return shapeNo("for-cond", stmt.condition);

  // Update: optional. When present, must be a Phase-1 expression OR a
  // postfix `i++` / `i--` (which `isPhase1Expr` doesn't accept on its
  // own because postfix mutates state — but it's the canonical for-loop
  // update so we accept it explicitly here).
  if (stmt.incrementor) {
    if (!isPhase1ForUpdateExpr(stmt.incrementor, innerScope, localClasses))
      return shapeNo("for-update", stmt.incrementor);
  }

  // Body: single Phase-1 body statement.
  // (#2856 C1) for bodies admit the early-return arm.
  earlyReturnLoopDepth++;
  try {
    return (
      isPhase1BodyStatement(stmt.statement, innerScope, localClasses, /* inLoop (#2952 s2) */ true, labels, breaks) ||
      shapeNo("for-body", stmt.statement)
    );
  } finally {
    earlyReturnLoopDepth--;
  }
}

/**
 * Slice 12 (#1280): the `update` clause of a `for` loop. Same as
 * Phase-1 expressions plus postfix `i++` / `i--` on identifiers in
 * scope (which the body-statement layer accepts as an
 * ExpressionStatement but `isPhase1Expr` does not — postfix is a
 * mutation, not a pure expression).
 */
function isPhase1ForUpdateExpr(
  expr: ts.Expression,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
): boolean {
  if (ts.isPostfixUnaryExpression(expr)) {
    const op = expr.operator;
    if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
      if (!ts.isIdentifier(expr.operand)) return false;
      if (isUnrepresentableModuleBinding(expr.operand)) return false;
      if (currentModuleBindingResolver?.(expr.operand) && !currentSubjectIsModuleInit) return false;
      if (!scope.has(expr.operand.text)) return false;
      if (projectionBindingMutationIsUnsupported(expr.operand.text, expr)) return false;
      clearProjectionBinding(expr.operand.text);
      return true;
    }
    return false;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (!ts.isIdentifier(expr.left)) return isPhase1Expr(expr, scope, localClasses);
    if (isUnrepresentableModuleBinding(expr.left)) return false;
    const moduleBinding = currentModuleBindingResolver?.(expr.left);
    if (moduleBinding) {
      if (currentSubjectIsModuleInit) {
        if (
          op !== ts.SyntaxKind.EqualsToken &&
          op !== ts.SyntaxKind.PlusEqualsToken &&
          op !== ts.SyntaxKind.MinusEqualsToken &&
          op !== ts.SyntaxKind.AsteriskEqualsToken &&
          op !== ts.SyntaxKind.SlashEqualsToken
        ) {
          return false;
        }
        if (!scope.has(expr.left.text)) return false;
        if (op === ts.SyntaxKind.EqualsToken && !currentModuleBindingResolver?.(expr.left, expr.right)) return false;
        return isPhase1Expr(expr.right, scope, localClasses);
      }
      if (op !== ts.SyntaxKind.EqualsToken) return false;
      if (!currentModuleBindingResolver?.(expr.left, expr.right)) return false;
      return isPhase1Expr(expr.right, scope, localClasses);
    }
    // Plain or compound assignment to an identifier in scope.
    if (
      op === ts.SyntaxKind.EqualsToken ||
      op === ts.SyntaxKind.PlusEqualsToken ||
      op === ts.SyntaxKind.MinusEqualsToken ||
      op === ts.SyntaxKind.AsteriskEqualsToken ||
      op === ts.SyntaxKind.SlashEqualsToken
    ) {
      if (!scope.has(expr.left.text)) return false;
      if (projectionBindingMutationIsUnsupported(expr.left.text, expr)) return false;
      if (!isPhase1Expr(expr.right, scope, localClasses)) return false;
      clearProjectionBinding(expr.left.text);
      if (op === ts.SyntaxKind.EqualsToken) {
        const className = localClassNameForExpression(expr.right, scope);
        if (className !== null) currentClassBindings.set(expr.left.text, className);
      }
      return true;
    }
  }
  return isPhase1Expr(expr, scope, localClasses);
}

/**
 * #2952 slice 5 — shape-check the runtime-dynamic for-in form used by Acorn.
 *
 * This first IR-owned slice deliberately accepts only `for (var id in dyn)`.
 * The production callback proves `dyn` is the non-fast externref carrier; the
 * fast `$AnyValue` carrier and typed object/array receivers remain direct until
 * their representation-specific receiver conversions are modeled in IR.
 *
 * The head name is loop-local in this structural model. Consequently a source
 * use after the loop is rejected by the ordinary scope walk rather than
 * incorrectly approximating JavaScript `var` hoisting.
 */
function isPhase1ForInStatement(
  stmt: ts.ForInStatement,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
  labels: ReadonlySet<string> = NO_LABELS,
  breaks: BreakScope = NO_BREAKS,
): boolean {
  if (currentSelectionOptions?.isDynamicForInReceiver?.(stmt.expression) !== true) {
    return shapeNo("forin-receiver-not-dynamic-externref", stmt.expression);
  }
  if (!isPhase1Expr(stmt.expression, scope, localClasses)) return shapeNo("forin-receiver", stmt.expression);
  if (!ts.isVariableDeclarationList(stmt.initializer)) return shapeNo("forin-head-not-declaration", stmt.initializer);
  if (stmt.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) {
    return shapeNo("forin-head-not-var", stmt.initializer);
  }
  if (stmt.initializer.declarations.length !== 1) return shapeNo("forin-head-count", stmt.initializer);
  const declaration = stmt.initializer.declarations[0]!;
  if (!ts.isIdentifier(declaration.name) || declaration.initializer) {
    return shapeNo("forin-head-shape", declaration);
  }
  const headName = declaration.name.text;
  if (scope.has(headName)) return shapeNo("forin-head-shadow", declaration.name);
  let headUsed = false;
  const findHeadUse = (node: ts.Node): void => {
    if (headUsed) return;
    if (ts.isIdentifier(node) && node.text === headName) {
      headUsed = true;
      return;
    }
    forEachChild(node, findHeadUse);
  };
  findHeadUse(stmt.statement);
  if (headUsed) return shapeNo("forin-head-value-used", stmt.statement);

  const bodyScope = new Set(scope);
  bodyScope.add(headName);
  earlyReturnLoopDepth++;
  try {
    return (
      isPhase1BodyStatement(stmt.statement, bodyScope, localClasses, /* inLoop */ true, labels, breaks) ||
      shapeNo("forin-body", stmt.statement)
    );
  } finally {
    earlyReturnLoopDepth--;
  }
}

/**
 * Slice 6 part 2 (#1181): recogniser for body statements inside a for-of
 * loop. Narrower than `isPhase1StatementList` — no nested closures, no
 * nested function decls, no fall-through if/else patterns. Accepts:
 *   - `Block { ... }` (recurses).
 *   - `VariableStatement` (let/const decl with initializer).
 *   - `ExpressionStatement` whose expression is a CallExpression OR an
 *     identifier-LHS / property-LHS assignment OR a compound assignment
 *     (`+=`, `-=`, etc.) on an identifier (lowered as desugared
 *     `<id> = <id> <op> <expr>`).
 *   - Nested `ForOfStatement`.
 */
function isPhase1BodyStatement(
  stmt: ts.Statement,
  scope: Set<string>,
  localClasses: ReadonlySet<string>,
  // #2952 slice 2 — true when an enclosing CLAIMED loop is in scope at this
  // statement position. Loop shape-checkers pass true for their body walks;
  // block/if/try arms propagate it. Gates the break/continue arm: an
  // unlabeled break/continue binds the innermost loop, so it is claimable
  // exactly when that innermost loop is itself on the IR path.
  inLoop: boolean = false,
  // #2952 slice 3 — the label NAMES bound by enclosing CLAIMED labeled
  // loops. Travels the exact same paths as `inLoop`; gates the labeled
  // break/continue arm. Mirrors from-ast's `cx.labelEnv` keys.
  labels: ReadonlySet<string> = NO_LABELS,
  // #2952 slice 4 — break-only scope (enclosing switch / labeled blocks).
  breaks: BreakScope = NO_BREAKS,
): boolean {
  if (ts.isBlock(stmt)) {
    return withProjectionEvidenceScope(() =>
      withLexicalValueBindingScope(stmt.statements, () => {
        const inner = new Set(scope);
        for (const s of stmt.statements) {
          if (!isPhase1BodyStatement(s, inner, localClasses, inLoop, labels, breaks)) return false;
        }
        return true;
      }),
    );
  }
  if (ts.isVariableStatement(stmt)) {
    return isPhase1VarDecl(stmt, scope, localClasses);
  }
  if (ts.isExpressionStatement(stmt)) {
    if (ts.isCallExpression(stmt.expression)) {
      return isPhase1Expr(stmt.expression, scope, localClasses);
    }
    // Slice 7a/7b (#1169f): `yield`/`yield <expr>`/`yield* <expr>` inside
    // a for-of body. Same semantics as the top-level form — only valid
    // when the enclosing function is a generator (lowerer-enforced).
    if (ts.isYieldExpression(stmt.expression)) {
      if (stmt.expression.expression) {
        return isPhase1Expr(stmt.expression.expression, scope, localClasses);
      }
      if (stmt.expression.asteriskToken) return false;
      return true; // bare `yield;`
    }
    if (ts.isBinaryExpression(stmt.expression)) {
      const op = stmt.expression.operatorToken.kind;
      // Plain assignment `<id> = <expr>` — id must be in scope.
      if (op === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(stmt.expression.left)) {
          if (isUnrepresentableModuleBinding(stmt.expression.left)) {
            return shapeNo("body-module-storage-unrepresentable", stmt.expression);
          }
          const moduleBinding = currentModuleBindingResolver?.(stmt.expression.left);
          if (moduleBinding) {
            if (!currentModuleBindingResolver?.(stmt.expression.left, stmt.expression.right)) {
              return shapeNo("body-module-assign-incompatible", stmt.expression);
            }
            return isPhase1Expr(stmt.expression.right, scope, localClasses);
          }
          if (!scope.has(stmt.expression.left.text)) return false;
          if (projectionBindingMutationIsUnsupported(stmt.expression.left.text, stmt.expression)) return false;
          if (!isPhase1Expr(stmt.expression.right, scope, localClasses)) return false;
          clearProjectionBinding(stmt.expression.left.text);
          const className = localClassNameForExpression(stmt.expression.right, scope);
          if (className !== null) currentClassBindings.set(stmt.expression.left.text, className);
          return true;
        }
        if (ts.isPropertyAccessExpression(stmt.expression.left)) {
          // #3000 — allow `this.#x = v` (PrivateIdentifier) in method / ctor
          // bodies, in addition to plain-Identifier field writes.
          if (!ts.isIdentifier(stmt.expression.left.name) && !ts.isPrivateIdentifier(stmt.expression.left.name))
            return false;
          if (!moduleExternPropertyWriteIsProven(stmt.expression.left, stmt.expression.right)) {
            return shapeNo("body-module-extern-assign-value", stmt.expression.right);
          }
          if (!preflightClassPropertyWrite(stmt.expression.left, scope)) return false;
          if (!isPhase1Expr(stmt.expression.left.expression, scope, localClasses)) return false;
          return isPhase1Expr(stmt.expression.right, scope, localClasses);
        }
        // (#2856 C2) element store `<id>[<idx>] = <rhs>;` — receiver
        // restricted to a plain in-scope identifier (quicksort's `arr[i] =
        // arr[j]`); the lowerer dispatches on its IrType (vec → the
        // __vec_elem_set helper with full legacy grow semantics; non-vec
        // receivers demote cleanly).
        if (ts.isElementAccessExpression(stmt.expression.left)) {
          const lhs = stmt.expression.left;
          if (!ts.isIdentifier(lhs.expression) || !scope.has(lhs.expression.text)) {
            return shapeNo("body-elemstore-recv", lhs.expression);
          }
          if (!isPhase1Expr(lhs.argumentExpression, scope, localClasses)) return false;
          return isPhase1Expr(stmt.expression.right, scope, localClasses);
        }
      }
      // Compound assignment `<id> <op>= <expr>` — desugars to
      // `<id> = <id> <op> <expr>`. Same scope check applies.
      if (
        op === ts.SyntaxKind.PlusEqualsToken ||
        op === ts.SyntaxKind.MinusEqualsToken ||
        op === ts.SyntaxKind.AsteriskEqualsToken ||
        op === ts.SyntaxKind.SlashEqualsToken
      ) {
        if (ts.isIdentifier(stmt.expression.left)) {
          if (isUnrepresentableModuleBinding(stmt.expression.left)) {
            return shapeNo("body-module-storage-unrepresentable", stmt.expression);
          }
          if (currentModuleBindingResolver?.(stmt.expression.left) && !currentSubjectIsModuleInit) {
            return shapeNo("body-module-compound", stmt.expression);
          }
          if (!scope.has(stmt.expression.left.text)) return false;
          if (projectionBindingMutationIsUnsupported(stmt.expression.left.text, stmt.expression)) return false;
          if (!isPhase1Expr(stmt.expression.right, scope, localClasses)) return false;
          clearProjectionBinding(stmt.expression.left.text);
          return true;
        }
      }
    }
    // Slice 12 (#1280): postfix `i++` / `i--` / prefix `++i` / `--i`
    // as expression statements inside a loop body. Mutates the
    // identifier's slot, not a pure expression — but as a statement
    // it's the canonical loop counter mutation.
    if (ts.isPostfixUnaryExpression(stmt.expression) || ts.isPrefixUnaryExpression(stmt.expression)) {
      const op = stmt.expression.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        if (!ts.isIdentifier(stmt.expression.operand)) return false;
        if (isUnrepresentableModuleBinding(stmt.expression.operand)) {
          return shapeNo("body-module-storage-unrepresentable", stmt.expression);
        }
        if (currentModuleBindingResolver?.(stmt.expression.operand) && !currentSubjectIsModuleInit) {
          return shapeNo("body-module-update", stmt.expression);
        }
        if (!scope.has(stmt.expression.operand.text)) return false;
        if (projectionBindingMutationIsUnsupported(stmt.expression.operand.text, stmt.expression)) return false;
        clearProjectionBinding(stmt.expression.operand.text);
        return true;
      }
    }
    return shapeNo("body-exprstmt-other", stmt.expression);
  }
  if (ts.isForOfStatement(stmt)) {
    return isPhase1ForOf(stmt, scope, localClasses, labels, breaks);
  }
  if (ts.isForInStatement(stmt)) {
    return isPhase1ForInStatement(stmt, scope, localClasses, labels, breaks);
  }
  // Slice 12 (#1280) — nested while / for inside a body buffer.
  if (ts.isWhileStatement(stmt)) {
    return isPhase1WhileStatement(stmt, scope, localClasses, labels, breaks);
  }
  if (ts.isForStatement(stmt)) {
    if (!isPhase1ForStatement(stmt, scope, localClasses, labels, breaks)) return false;
    // (#2856) Record the leak so a SIBLING for-init may re-declare it.
    if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
      for (const d of stmt.initializer.declarations) {
        if (ts.isIdentifier(d.name) && !scope.has(d.name.text)) {
          scope.add(d.name.text);
          forInitLeakedNames.add(d.name.text);
        }
      }
    }
    return true;
  }
  // #2952 slice 1 — nested `do { body } while (cond)` inside a body buffer.
  if (ts.isDoStatement(stmt)) {
    return isPhase1DoStatement(stmt, scope, localClasses, labels, breaks);
  }
  // #2952 slice 3/4 — `lbl: <loop|switch|block>` nested inside a body buffer.
  if (ts.isLabeledStatement(stmt)) {
    return isPhase1LabeledStatement(stmt, scope, localClasses, labels, inLoop, breaks);
  }
  // #2952 slice 4 — switch nested inside a body buffer.
  if (ts.isSwitchStatement(stmt)) {
    return isPhase1SwitchStatement(stmt, scope, localClasses, inLoop, labels, breaks);
  }
  // Slice 9 (#1169h) — throw / try inside a body statement list.
  // Accepting these here lets a try body / catch body / finally body
  // contain nested throws and nested try-statements (composes with the
  // outer try's catch / finally inlining via the lowerer's structured
  // emission).
  if (ts.isThrowStatement(stmt)) {
    return isPhase1ThrowStatement(stmt, scope, localClasses);
  }
  if (ts.isTryStatement(stmt)) {
    return isPhase1TryStatement(stmt, scope, localClasses, inLoop, labels, breaks);
  }
  // #2952 slice 2 — statement-level `if` inside a body buffer (lowered as
  // the void `if.stmt` IR instr — NOT the top-level block-CFG rewrite).
  // Both arms are body statements; `inLoop` propagates so `if (c) break;`
  // — the canonical multi-exit shape — is claimable.
  if (ts.isIfStatement(stmt)) {
    if (!isPhase1ConditionExpr(stmt.expression, scope, localClasses)) return shapeNo("body-if-cond", stmt.expression);
    if (
      !withProjectionEvidenceScope(() =>
        isPhase1BodyStatement(stmt.thenStatement, new Set(scope), localClasses, inLoop, labels, breaks),
      )
    )
      return false;
    if (
      stmt.elseStatement &&
      !withProjectionEvidenceScope(() =>
        isPhase1BodyStatement(stmt.elseStatement!, new Set(scope), localClasses, inLoop, labels, breaks),
      )
    ) {
      return false;
    }
    return true;
  }
  // #2952 slice 2 — unlabeled break / continue: claimable exactly when an
  // enclosing CLAIMED loop binds them. (slice 3) Labeled forms are
  // claimable when the label is bound by an enclosing CLAIMED labeled
  // loop (`labels` mirrors from-ast's `cx.labelEnv`). Backed by
  // `lowerBreakContinueStatement` — selector↔builder parity.
  if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) {
    const isBreak = ts.isBreakStatement(stmt);
    if (stmt.label) {
      // Loop labels bind both modes; block/switch labels bind break only
      // (continue must target a loop — JS grammar; slice 4).
      if (labels.has(stmt.label.text)) return true;
      if (isBreak && breaks.names.has(stmt.label.text)) return true;
      return shapeNo("body-labeled-break-continue", stmt);
    }
    // (slice 4) Unlabeled break binds the nearest breakable (loop OR
    // switch, §14.9); unlabeled continue only ever binds a loop.
    if (isBreak ? !(inLoop || breaks.inSwitch) : !inLoop) {
      return shapeNo("body-break-continue-outside-loop", stmt);
    }
    return true;
  }
  // (#2856 C1) Early `return` inside a body buffer. Sound only inside a
  // C-style loop with no enclosing barrier (for-of / try / ctor) and never
  // in a generator — see the module-state doc on `earlyReturnLoopDepth`.
  if (ts.isReturnStatement(stmt)) {
    if (currentFnIsGenerator) return shapeNo("body-return-generator", stmt);
    if (earlyReturnLoopDepth === 0 || earlyReturnBarrierDepth > 0) {
      return shapeNo("body-return-context", stmt);
    }
    if (!stmt.expression) {
      return currentFnIsVoidReturn ? true : shapeNo("body-return-bare-nonvoid", stmt);
    }
    return isPhase1Expr(stmt.expression, scope, localClasses);
  }
  return shapeNo("body-unhandled-stmt", stmt);
}

function isPhase1Tail(
  stmt: ts.Statement,
  scope: Set<string>,
  localClasses: ReadonlySet<string>,
  isGenerator: boolean = false,
  isVoidReturn: boolean = false,
): boolean {
  if (ts.isReturnStatement(stmt)) {
    // Slice 7b (#1169f): bare `return;` (no expression) is allowed in
    // generator tails — the lowerer's `lowerTail` generator branch
    // handles the no-expression case by emitting the epilogue without
    // a final push.
    //
    // Slice 14 (#1228): bare `return;` is also allowed in void-returning
    // functions. The lowerer's void branch terminates with empty values.
    if (!stmt.expression) return isGenerator || isVoidReturn ? true : shapeNo("tail-bare-return-nonvoid", stmt);
    return isPhase1Expr(stmt.expression, scope, localClasses);
  }
  if (ts.isBlock(stmt)) {
    return isPhase1StatementList(stmt.statements, new Set(scope), localClasses, isGenerator, isVoidReturn);
  }
  if (ts.isIfStatement(stmt)) {
    if (!stmt.elseStatement) {
      // A void function may end in a statement-position guard and then fall
      // through to its implicit empty return. The builder emits `if.stmt`
      // followed by `return []`; non-void functions still require both tails.
      if (!isVoidReturn) return shapeNo("tail-if-noelse", stmt);
      if (!isPhase1ConditionExpr(stmt.expression, scope, localClasses)) return false;
      return withProjectionEvidenceScope(() =>
        isPhase1BodyStatement(stmt.thenStatement, new Set(scope), localClasses, /* inLoop */ false),
      );
    }
    if (!isPhase1ConditionExpr(stmt.expression, scope, localClasses)) return false;
    if (
      !withProjectionEvidenceScope(() =>
        isPhase1Tail(stmt.thenStatement, new Set(scope), localClasses, isGenerator, isVoidReturn),
      )
    )
      return false;
    if (
      !withProjectionEvidenceScope(() =>
        isPhase1Tail(stmt.elseStatement!, new Set(scope), localClasses, isGenerator, isVoidReturn),
      )
    )
      return false;
    return true;
  }
  // Slice 9 (#1169h) — throw at function tail. `function f() { throw new
  // Error(); }` is a valid Phase-1 tail because the throw produces an
  // abrupt completion that terminates the function (no return needed).
  if (ts.isThrowStatement(stmt)) {
    return isPhase1ThrowStatement(stmt, scope, localClasses);
  }
  // Slice 14 (#1228) — void function tail: an ExpressionStatement (call
  // or other side-effect expression) can stand in for the implicit
  // return. The lowerer's void branch synthesizes the empty-values
  // terminator after the expression's side effects.
  if (isVoidReturn && ts.isExpressionStatement(stmt)) {
    const expr = stmt.expression;
    if (
      (ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr)) &&
      ts.isIdentifier(expr.operand) &&
      isUnrepresentableModuleBinding(expr.operand)
    ) {
      return shapeNo("tail-module-storage-unrepresentable", expr);
    }
    if (ts.isBinaryExpression(expr) && ts.isIdentifier(expr.left)) {
      if (isUnrepresentableModuleBinding(expr.left)) {
        return shapeNo("tail-module-storage-unrepresentable", expr);
      }
      const moduleBinding = currentModuleBindingResolver?.(expr.left);
      if (moduleBinding) {
        if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
          return shapeNo("tail-module-compound", expr);
        }
        if (!currentModuleBindingResolver?.(expr.left, expr.right)) {
          return shapeNo("tail-module-assign-incompatible", expr);
        }
        return isPhase1Expr(expr.right, scope, localClasses);
      }
    }
    // #3000-B: a property-store assignment as the void tail — the SET
    // accessor body shape `set name(v) { this.#name = v; }`. Mirror the
    // NON-tail property-store arm exactly (receiver Phase-1, prop an
    // Identifier or PrivateIdentifier, RHS Phase-1); from-ast's void-tail
    // arm routes it through the same `lowerPropertyAssignment` used mid-body,
    // preserving select↔build parity.
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(expr.left)
    ) {
      if (!ts.isIdentifier(expr.left.name) && !ts.isPrivateIdentifier(expr.left.name))
        return shapeNo("tail-assign-computedprop", expr);
      if (!moduleExternPropertyWriteIsProven(expr.left, expr.right)) {
        return shapeNo("tail-module-extern-assign-value", expr.right);
      }
      if (!preflightClassPropertyWrite(expr.left, scope)) return false;
      if (!isPhase1Expr(expr.left.expression, scope, localClasses))
        return shapeNo("tail-assign-recv", expr.left.expression);
      return isPhase1Expr(expr.right, scope, localClasses);
    }
    // #3000-B: element-store assignment as the void tail (`arr[i] = v;` last).
    // Same receiver restriction as the non-tail element-store arm.
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(expr.left)
    ) {
      const lhs = expr.left;
      if (!ts.isIdentifier(lhs.expression) || !scope.has(lhs.expression.text))
        return shapeNo("tail-elemstore-recv", lhs.expression);
      if (!isPhase1Expr(lhs.argumentExpression, scope, localClasses))
        return shapeNo("tail-elemstore-idx", lhs.argumentExpression);
      return isPhase1Expr(expr.right, scope, localClasses);
    }
    return isPhase1Expr(expr, scope, localClasses);
  }
  return shapeNo("tail-unhandled", stmt);
}

function isPhase1VarDecl(stmt: ts.VariableStatement, scope: Set<string>, localClasses: ReadonlySet<string>): boolean {
  const flags = stmt.declarationList.flags;
  const isLexical = !!(flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
  if (!isLexical && !currentIrSafeVarDeclarationLists.has(stmt.declarationList)) {
    return shapeNo("vardecl-var-kind", stmt);
  }
  if (stmt.modifiers && stmt.modifiers.length > 0) return shapeNo("vardecl-modifier", stmt);
  const isConst = !!(flags & ts.NodeFlags.Const);
  for (const d of stmt.declarationList.declarations) {
    // Slice 8a (#1169g): destructuring binding patterns for `const`-bound
    // declarations only. Object pattern: identifier-only properties with
    // optional renaming, no defaults, no nesting, no rest. Array pattern:
    // identifier-only positional bindings, no defaults, no nesting, no
    // rest. Anything wider (rest, defaults, nested patterns) defers to
    // slice 8.5+ — the legacy `destructuring.ts` path remains for those.
    if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) {
      if (currentSubjectIsModuleInit) return shapeNo("vardecl-module-destructuring", d.name);
      if (!isConst) return shapeNo("vardecl-dstr-let", d.name);
      if (!d.initializer) return shapeNo("vardecl-dstr-noinit", d.name);
      if (!isPhase1BindingPattern(d.name, scope)) return shapeNo("vardecl-dstr-pattern", d.name);
      const patternNames = new Set<string>();
      collectPatternNames(d.name, patternNames);
      for (const name of patternNames) clearProjectionBinding(name);
      const initializerScope = new Set(scope);
      for (const name of patternNames) initializerScope.add(name);
      if (expressionTouchesTrackedModuleValue(d.initializer)) {
        return shapeNo("vardecl-dstr-module-value", d.initializer);
      }
      // Initializer must be Phase-1 expressible. The lowerer inspects
      // its IrType to decide between object.get (object pattern) and
      // vec.get (array pattern); if the resolved IrType isn't compatible
      // with the pattern shape, lowering throws and the function falls
      // back to legacy.
      if (!isPhase1Expr(d.initializer, initializerScope, localClasses))
        return shapeNo("vardecl-dstr-init", d.initializer);
      // Pre-add every leaf identifier to scope so subsequent statements
      // see the new names.
      collectPatternNames(d.name, scope);
      continue;
    }
    if (!ts.isIdentifier(d.name)) return shapeNo("vardecl-nonident-name", d.name);
    if (scope.has(d.name.text)) return shapeNo("vardecl-shadow", d.name);
    if (!d.initializer) return shapeNo("vardecl-noinit", d);
    clearProjectionBinding(d.name.text);
    const initializerScope = new Set(scope);
    initializerScope.add(d.name.text);
    const declarationList = d.parent;
    const declarationStatement = ts.isVariableDeclarationList(declarationList) ? declarationList.parent : undefined;
    const directModuleDeclaration =
      declarationStatement !== undefined &&
      ts.isVariableStatement(declarationStatement) &&
      ts.isSourceFile(declarationStatement.parent);
    // The synthetic module-init builder must map every direct declaration to
    // an already-allocated legacy slot. Shape-only primitive acceptance is not
    // enough in a mode whose storage ABI differs (ordinary fast numbers) or
    // whose builtin representation is native (`Map` under nativeStrings).
    if (
      currentSubjectIsModuleInit &&
      currentModuleBindingResolver !== null &&
      directModuleDeclaration &&
      currentModuleBindingResolver?.(d.name) === undefined
    ) {
      return shapeNo("vardecl-module-storage-unrepresentable", d);
    }
    const directModuleBinding =
      currentSubjectIsModuleInit && directModuleDeclaration ? currentModuleBindingResolver?.(d.name) : undefined;
    if (directModuleBinding && !currentModuleBindingResolver?.bindingValueMatches(d.name, d.initializer)) {
      return shapeNo("vardecl-module-value-flow", d.initializer);
    }
    // A local alias loses the module declaration identity (and therefore its
    // semantic boolean/numeric/extern representation). Reject direct and
    // value-preserving wrappers for every module kind. Calls rooted in a
    // module extern are also deferred because their result type is unknown to
    // this shape-only selector; the established C3 `Map.get` local is the one
    // exact exception, consumed through a strict undefined check.
    if (!currentSubjectIsModuleInit) {
      const initializer = unwrapPhase1Parens(d.initializer);
      const exactMapGetAlias = ts.isCallExpression(initializer) && exactModuleMapMethod(initializer) === "get";
      if (expressionTouchesTrackedModuleValue(d.initializer) && !exactMapGetAlias) {
        const family = obviousModuleValueFamily(d.initializer);
        if (!isConst || (family !== "f64" && family !== "boolean")) {
          return shapeNo("vardecl-module-binding-alias", d.initializer);
        }
      }
      if (
        ts.isCallExpression(initializer) &&
        expressionIsModuleExternRootedCall(initializer) &&
        exactModuleMapMethod(initializer) !== "get"
      ) {
        return shapeNo("vardecl-module-extern-call", d.initializer);
      }
    }
    // Slice 3 (#1169c): closure-literal initializer. Only accepted for
    // `const` (no `let` arrow rebinding in slice 3). The closure
    // shape-check enforces the slice-3 surface (every param + return
    // annotated, body is a Phase-1 tail, no generator/async/named).
    if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
      if (!isConst) return shapeNo("vardecl-let-closure", d.initializer);
      // Permit an explicit closure type annotation (like `: (n: number) => number`)
      // — it's a shape-only signal, not a primitive type. Since the IR doesn't
      // syntactically check the annotation against the body, just accept any
      // annotation (the lowerer enforces semantic match).
      if (!isPhase1ClosureLiteral(d.initializer, initializerScope, localClasses))
        return shapeNo("vardecl-closure-init", d.initializer);
      scope.add(d.name.text);
      recordCallableProjection(d.name.text, d.initializer.parameters.length, d.initializer.type);
      continue;
    }
    if (d.type && !isPhase1TypeNode(d.type)) {
      // Module-init gets the logical extern brand from its direct legacy
      // global map, so nullable host-class annotations are safe here. A local
      // declaration (including a same-named shadow) resolves undefined and
      // keeps the ordinary annotation rejection.
      if (!currentModuleBindingResolver?.(d.name)) return shapeNo("vardecl-typenode", d.type);
    }
    if (!isPhase1Expr(d.initializer, initializerScope, localClasses))
      return shapeNo("vardecl-init-expr", d.initializer);
    const initializer = unwrapPhase1Parens(d.initializer);
    if (!currentSubjectIsModuleInit && isConst && expressionTouchesTrackedModuleValue(initializer)) {
      const family = obviousModuleValueFamily(initializer);
      if (family === "f64" || family === "boolean") {
        currentModuleScalarAliasFamilies.set(d, family);
      }
    }
    if (
      !currentSubjectIsModuleInit &&
      ts.isCallExpression(initializer) &&
      exactModuleMapMethod(initializer) === "get"
    ) {
      currentModuleMapGetAliases.add(d);
    }
    const className =
      (d.type ? localClassNameFromTypeNode(d.type) : null) ??
      localClassNameForExpression(initializer, initializerScope);
    if (className !== null) currentClassBindings.set(d.name.text, className);
    scope.add(d.name.text);
  }
  return true;
}

/**
 * Slice 8a (#1169g): shape-check a destructuring binding pattern. Only
 * identifier-leaf, no-default, no-rest, no-nested patterns are accepted
 * — the lowerer expands these into a sequence of single-name `object.get`
 * / `vec.get` reads at compile time. Wider shapes (rest, defaults,
 * nested) defer to slice 8.5; the function falls back to legacy.
 *
 * Object patterns:
 *   - { a, b }                   — shorthand
 *   - { a: x, b: y }             — renaming (computed key rejected)
 *
 * Array patterns:
 *   - [a, b, c]
 *   - [, b, , d]                 — omitted slots (sparse) accepted
 */
function isPhase1BindingPattern(p: ts.BindingPattern, scope: ReadonlySet<string>): boolean {
  if (ts.isObjectBindingPattern(p)) {
    if (p.elements.length === 0) return false; // empty pattern — nothing to bind
    const localNames = new Set<string>();
    for (const elem of p.elements) {
      // Rest deferred — slice 8b adds object spread/rest collection.
      if (elem.dotDotDotToken) return false;
      // Default value `{ a = 1 }` deferred — needs runtime undefined check.
      if (elem.initializer) return false;
      // Property name must be Identifier or StringLiteral (no computed).
      if (elem.propertyName) {
        if (!ts.isIdentifier(elem.propertyName) && !ts.isStringLiteral(elem.propertyName)) return false;
      }
      // Binding target must be a plain identifier (no nested patterns).
      if (!ts.isIdentifier(elem.name)) return false;
      const name = elem.name.text;
      if (scope.has(name) || localNames.has(name)) return false;
      localNames.add(name);
    }
    return true;
  }
  if (ts.isArrayBindingPattern(p)) {
    if (p.elements.length === 0) return false; // empty `[] = expr` — defer
    const localNames = new Set<string>();
    for (const elem of p.elements) {
      // Omitted (sparse) slots are allowed — `[a, , c]` skips index 1.
      if (ts.isOmittedExpression(elem)) continue;
      // Rest deferred — slice 8b adds vec slice / iter drain.
      if (elem.dotDotDotToken) return false;
      // Default value deferred.
      if (elem.initializer) return false;
      // Binding target must be a plain identifier (no nested patterns).
      if (!ts.isIdentifier(elem.name)) return false;
      const name = elem.name.text;
      if (scope.has(name) || localNames.has(name)) return false;
      localNames.add(name);
    }
    return true;
  }
  return false;
}

/**
 * Slice 8a (#1169g): collect every identifier name introduced by a binding
 * pattern (the leaves) into the given scope. Mirrors the Phase-1 var-decl
 * scope-tracking machinery.
 */
function collectPatternNames(p: ts.BindingPattern, scope: Set<string>): void {
  for (const elem of p.elements) {
    if (ts.isOmittedExpression(elem)) continue;
    if (ts.isIdentifier(elem.name)) scope.add(elem.name.text);
  }
}

/**
 * Slice 3 (#1169c): shape-check a nested `function inner() {...}`
 * declaration inside an outer body. Adds the inner's name to the outer
 * scope on success so subsequent statements / sibling closures can
 * reference it by name.
 */
function isPhase1NestedFunc(
  fn: ts.FunctionDeclaration,
  scope: Set<string>,
  localClasses: ReadonlySet<string>,
): boolean {
  if (!fn.name) return false;
  if (fn.asteriskToken) return false; // generator
  if (
    fn.modifiers &&
    fn.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword || m.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    return false;
  }
  if (fn.typeParameters && fn.typeParameters.length > 0) return false;
  if (scope.has(fn.name.text)) return false; // shadowing — defer

  // Every param + return must have an explicit primitive / object
  // annotation. Slice 3 doesn't run propagation across closure
  // boundaries, so propagation overrides aren't applicable.
  if (!fn.type || annotationToResolvedKind(fn.type) === null) return false;

  const closureScope = new Set(scope);
  for (const p of fn.parameters) {
    if (!ts.isIdentifier(p.name)) return false;
    if (p.questionToken || p.dotDotDotToken || p.initializer) return false;
    if (!p.type || annotationToResolvedKind(p.type) === null) return false;
    if (closureScope.has(p.name.text)) return false;
    closureScope.add(p.name.text);
  }

  // Reject self-reference syntactically — slice 3 doesn't yet support
  // recursive nested funcs (would need a closure-name binding inside
  // the lifted body).
  if (!fn.body) return false;
  if (bodyReferencesIdentifier(fn.body, fn.name.text)) {
    return capabilityNo("call-resolution-unsupported", "nested-function-self-reference", fn);
  }
  const projectionBindings = enterProjectionBindingScope(fn.parameters);
  const outerMutableParamSlotNames = currentMutableParamSlotNames;
  currentMutableParamSlotNames = new Set();
  let bodyAccepted = false;
  try {
    bodyAccepted = isPhase1StatementList(fn.body.statements, closureScope, localClasses);
  } finally {
    currentMutableParamSlotNames = outerMutableParamSlotNames;
    restoreProjectionBindings(projectionBindings);
  }
  if (!bodyAccepted) return false;

  // Add the nested function name to the OUTER scope.
  scope.add(fn.name.text);
  recordCallableProjection(fn.name.text, fn.parameters.length, fn.type);
  return true;
}

/**
 * Slice 3 (#1169c): shape-check an arrow / function-expression
 * initializer used as a `const` closure binding.
 */
function isPhase1ClosureLiteral(
  expr: ts.ArrowFunction | ts.FunctionExpression,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
): boolean {
  if (ts.isFunctionExpression(expr) && expr.name) return shapeNo("closure-named-fnexpr", expr.name); // named func expr — defer
  if ("asteriskToken" in expr && expr.asteriskToken) return shapeNo("closure-generator", expr); // generator
  if (expr.modifiers && expr.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))
    return shapeNo("closure-async", expr);
  if (expr.typeParameters && expr.typeParameters.length > 0) return shapeNo("closure-type-params", expr);

  if (!expr.type || annotationToResolvedKind(expr.type) === null)
    return shapeNo("closure-return-type", expr.type ?? expr);

  const inner = new Set(scope);
  for (const p of expr.parameters) {
    if (!ts.isIdentifier(p.name)) return shapeNo("closure-param-name", p.name);
    if (p.questionToken || p.dotDotDotToken || p.initializer) return shapeNo("closure-param-shape", p);
    if (!p.type || annotationToResolvedKind(p.type) === null) return shapeNo("closure-param-type", p.type ?? p);
    if (inner.has(p.name.text)) return shapeNo("closure-param-shadow", p.name);
    inner.add(p.name.text);
  }

  const projectionBindings = enterProjectionBindingScope(expr.parameters);
  const outerMutableParamSlotNames = currentMutableParamSlotNames;
  currentMutableParamSlotNames = new Set();

  // ArrowFunction with concise body: must be a Phase-1 expression.
  // ArrowFunction / FunctionExpression with block body: Phase-1 tail
  // statement list.
  try {
    if (ts.isArrowFunction(expr) && !ts.isBlock(expr.body)) {
      return isPhase1Expr(expr.body, inner, localClasses) || shapeNo("closure-concise-body", expr.body);
    }
    if (!ts.isBlock(expr.body)) return shapeNo("closure-body-kind", expr.body);
    return isPhase1StatementList(expr.body.statements, inner, localClasses) || shapeNo("closure-body", expr.body);
  } finally {
    currentMutableParamSlotNames = outerMutableParamSlotNames;
    restoreProjectionBindings(projectionBindings);
  }
}

/**
 * Resolve a TypeNode annotation to one of the slice-1+2 ResolvedKinds.
 * Returns `null` for anything outside that surface. Local helper for
 * the closure shape checks; mirrors `resolveParamType`'s annotation
 * arm but without the propagation-fallback path.
 */
function annotationToResolvedKind(node: ts.TypeNode): ResolvedKind {
  if (node.kind === ts.SyntaxKind.NumberKeyword) return "f64";
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
  if (node.kind === ts.SyntaxKind.StringKeyword) return "string";
  if (ts.isTypeLiteralNode(node) || ts.isTypeReferenceNode(node)) return "object";
  return null;
}

/**
 * Recursive scan: does any identifier reference inside `body` resolve
 * to `name`? Walks into nested expressions but stops at function-like
 * boundaries (those have their own analyses run when they're lowered).
 *
 * Used by `isPhase1NestedFunc` to reject self-recursive nested funcs.
 */
function bodyReferencesIdentifier(body: ts.Block, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    if (
      node !== body &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessor(node) ||
        ts.isSetAccessor(node))
    ) {
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return found;
}

function isPhase1TypeNode(node: ts.TypeNode): boolean {
  // (#2856) `number[]` array annotation — the from-ast vardecl arm resolves
  // it to a vec-ref hint (`resolveVecForElement(f64)`), which is what lets an
  // EMPTY initializer (`const arr: number[] = []`) type its `vec.new_fixed`.
  // Kept in lockstep with `lowerVarDecl`'s ArrayTypeNode arm (parity: every
  // annotation accepted here MUST produce a hint there). Only the f64 element
  // is in scope — `string[]` / `boolean[]` element carriers are backend-
  // dependent and stay deferred.
  if (ts.isArrayTypeNode(node)) {
    return node.elementType.kind === ts.SyntaxKind.NumberKeyword;
  }
  return (
    node.kind === ts.SyntaxKind.NumberKeyword ||
    node.kind === ts.SyntaxKind.BooleanKeyword ||
    node.kind === ts.SyntaxKind.StringKeyword
  );
}

/**
 * Slice 10 (#1169i) — host-class names known to the IR. Mirrors the legacy
 * `ctx.externClasses` registration set (see `registerBuiltinExternClasses`
 * in `src/codegen/index.ts:5527-5715`). Functions that USE values of
 * these classes (construction, method calls, property access, RegExp
 * literals) become IR-claimable; the actual lowering throws cleanly if
 * the resolver doesn't carry metadata for the class, falling the
 * function back to legacy via `safeSelection`.
 *
 * Kept in sync with the legacy registration list — drift produces
 * over-claims that fall back at lowering, which is acceptable but
 * suboptimal.
 */
const KNOWN_EXTERN_CLASSES = new Set<string>([
  "RegExp",
  "Date",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Uint8Array",
  "Int8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Promise",
]);

// Typed arrays are handled by the legacy backend's native vec constructor
// path, not by the IR extern-class registry. Treating them as generic extern
// classes therefore claims `new Uint8Array(...)` without a matching builder
// producer. Keep them pre-claim until a representation-polymorphic IR typed-
// array constructor lands.
const NATIVE_TYPED_ARRAY_CLASSES = new Set<string>([
  "Uint8Array",
  "Int8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

// The measured #3529 constructor gap: these ambient constructors are owned
// by the legacy exception runtime and have no IrClass/extern producer.
const LEGACY_ERROR_CONSTRUCTOR_CLASSES = new Set<string>(["Error", "TypeError", "RangeError"]);

function isKnownExternClass(name: string): boolean {
  return KNOWN_EXTERN_CLASSES.has(name);
}

function unwrapPhase1Parens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** Resolve an exact checker-owned module binding, independent of representation. */
function moduleBinding(expr: ts.Expression): ReturnType<IrLegacyModuleBindingResolver> {
  const candidate = unwrapPhase1Parens(expr);
  if (!ts.isIdentifier(candidate)) return undefined;
  return currentModuleBindingResolver?.(candidate);
}

function moduleScalarAliasFamily(expr: ts.Expression): "f64" | "boolean" | undefined {
  const candidate = unwrapPhase1Parens(expr);
  if (!ts.isIdentifier(candidate)) return undefined;
  const declaration = currentModuleBindingResolver?.localVariableDeclaration(candidate);
  return declaration ? currentModuleScalarAliasFamilies.get(declaration) : undefined;
}

function isUnshadowedUndefinedIdentifier(expr: ts.Expression, scope: ReadonlySet<string>): boolean {
  const candidate = unwrapPhase1Parens(expr);
  return (
    ts.isIdentifier(candidate) &&
    candidate.text === "undefined" &&
    !scope.has("undefined") &&
    currentModuleBindingResolver?.isDirectModuleBinding(candidate) !== true
  );
}

/** Resolve an exact module identifier whose shared legacy slot is externref-shaped. */
function moduleExternBinding(expr: ts.Expression): ReturnType<IrLegacyModuleBindingResolver> {
  const binding = moduleBinding(expr);
  return binding?.valueKind.kind === "extern" ? binding : undefined;
}

/** True only for the one module representation whose IR value is a JS boolean. */
function isDirectBooleanModuleBinding(expr: ts.Expression): boolean {
  const binding = moduleBinding(expr);
  return binding?.valueKind.kind === "i32" && binding.valueKind.semantic === "boolean";
}

/**
 * Value-preserving module-binding expressions. Conditional/nullish wrappers
 * deliberately remain classified here even though they are not proven IR
 * consumers: this lets alias and truthiness gates reject them conservatively.
 */
function expressionMayBeModuleBinding(expr: ts.Expression): boolean {
  const candidate = unwrapPhase1Parens(expr);
  if (moduleBinding(candidate)) return true;
  if (ts.isConditionalExpression(candidate)) {
    return expressionMayBeModuleBinding(candidate.whenTrue) || expressionMayBeModuleBinding(candidate.whenFalse);
  }
  if (ts.isBinaryExpression(candidate) && candidate.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return expressionMayBeModuleBinding(candidate.left) || expressionMayBeModuleBinding(candidate.right);
  }
  return false;
}

function isModuleMapGetAlias(expr: ts.Expression): boolean {
  const candidate = unwrapPhase1Parens(expr);
  if (!ts.isIdentifier(candidate)) return false;
  const declaration = currentModuleBindingResolver?.localVariableDeclaration(candidate);
  return declaration !== undefined && currentModuleMapGetAliases.has(declaration);
}

function trackedModuleAliasHasName(name: string): boolean {
  for (const declaration of currentModuleScalarAliasFamilies.keys()) {
    if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return true;
  }
  for (const declaration of currentModuleMapGetAliases) {
    if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return true;
  }
  return false;
}

/** True when any value position refers to a checker-owned module binding. */
function expressionTouchesModuleBinding(expr: ts.Expression): boolean {
  let touched = false;
  const visit = (node: ts.Node): void => {
    if (touched) return;
    if (ts.isIdentifier(node) && moduleBinding(node)) {
      touched = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(expr);
  return touched;
}

function expressionTouchesBooleanModuleBinding(expr: ts.Expression): boolean {
  let touched = false;
  const visit = (node: ts.Node): void => {
    if (touched) return;
    if (ts.isIdentifier(node) && (isDirectBooleanModuleBinding(node) || moduleScalarAliasFamily(node) === "boolean")) {
      touched = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(expr);
  return touched;
}

/** True when an expression contains an f64/boolean module-storage read. */
function expressionTouchesScalarModuleBinding(expr: ts.Expression): boolean {
  let touched = false;
  const visit = (node: ts.Node): void => {
    if (touched) return;
    if (ts.isIdentifier(node)) {
      const binding = moduleBinding(node);
      if ((binding && binding.valueKind.kind !== "extern") || moduleScalarAliasFamily(node) !== undefined) {
        touched = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(expr);
  return touched;
}

function expressionTouchesTrackedModuleValue(expr: ts.Expression): boolean {
  if (expressionTouchesModuleBinding(expr)) return true;
  let touchesScalarAlias = false;
  const visitScalarAlias = (node: ts.Node): void => {
    if (touchesScalarAlias) return;
    if (ts.isIdentifier(node) && moduleScalarAliasFamily(node) !== undefined) {
      touchesScalarAlias = true;
      return;
    }
    forEachChild(node, visitScalarAlias);
  };
  visitScalarAlias(expr);
  if (touchesScalarAlias) return true;
  return expressionTouchesModuleMapGetAlias(expr);
}

function expressionTouchesModuleMapGetAlias(expr: ts.Expression): boolean {
  let touched = false;
  const visit = (node: ts.Node): void => {
    if (touched) return;
    if (ts.isIdentifier(node) && isModuleMapGetAlias(node)) {
      touched = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(expr);
  return touched;
}

/**
 * Conservative value-shape classifier for expressions that can yield a
 * checker-owned module extern. These wrappers preserve the extern value while
 * hiding its identifier from exact-node checks; tracking their logical type in
 * local scope is deferred, so all consumers use this shared predicate.
 */
function expressionMayBeModuleExtern(expr: ts.Expression): boolean {
  const candidate = unwrapPhase1Parens(expr);
  if (moduleExternBinding(candidate)) return true;
  if (ts.isConditionalExpression(candidate)) {
    return expressionMayBeModuleExtern(candidate.whenTrue) || expressionMayBeModuleExtern(candidate.whenFalse);
  }
  if (ts.isBinaryExpression(candidate) && candidate.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return expressionMayBeModuleExtern(candidate.left) || expressionMayBeModuleExtern(candidate.right);
  }
  return false;
}

/** True when any value position in an expression refers to a module extern. */
function expressionTouchesModuleExtern(expr: ts.Expression): boolean {
  let touched = false;
  const visit = (node: ts.Node): void => {
    if (touched) return;
    if (ts.isIdentifier(node) && moduleExternBinding(node)) {
      touched = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(expr);
  return touched;
}

/** True when a static property chain is rooted in a module extern value. */
function expressionIsModuleExternAccessChain(expr: ts.Expression): boolean {
  const candidate = unwrapPhase1Parens(expr);
  if (expressionMayBeModuleExtern(candidate)) return true;
  if (ts.isPropertyAccessExpression(candidate)) {
    return expressionIsModuleExternAccessChain(candidate.expression);
  }
  if (ts.isCallExpression(candidate)) return expressionIsModuleExternRootedCall(candidate);
  return false;
}

function moduleExternPropertyWriteIsProven(left: ts.PropertyAccessExpression, right: ts.Expression): boolean {
  if (!expressionIsModuleExternAccessChain(left.expression)) return true;
  return currentModuleBindingResolver?.externValueIsPassable(right) === true;
}

/** True when a static property chain is rooted in any module value. */
function expressionIsModuleBindingAccessChain(expr: ts.Expression): boolean {
  const candidate = unwrapPhase1Parens(expr);
  if (expressionMayBeModuleBinding(candidate)) return true;
  if (ts.isPropertyAccessExpression(candidate)) {
    return expressionIsModuleBindingAccessChain(candidate.expression);
  }
  return false;
}

function isOptionalModuleExternCall(expr: ts.CallExpression): boolean {
  if (expr.questionDotToken !== undefined) return expressionTouchesModuleExtern(expr);
  return (
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.questionDotToken !== undefined &&
    expressionIsModuleExternAccessChain(expr.expression.expression)
  );
}

/** True when a method-call receiver ultimately comes from a module extern. */
function expressionIsModuleExternRootedCall(expr: ts.Expression): boolean {
  const candidate = unwrapPhase1Parens(expr);
  if (!ts.isCallExpression(candidate)) return false;
  const callee = unwrapPhase1Parens(candidate.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  return (
    expressionIsModuleExternAccessChain(callee.expression) || expressionIsModuleExternRootedCall(callee.expression)
  );
}

function expressionIsModuleBindingRootedCall(expr: ts.Expression): boolean {
  const candidate = unwrapPhase1Parens(expr);
  if (!ts.isCallExpression(candidate)) return false;
  const callee = unwrapPhase1Parens(candidate.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  return (
    expressionIsModuleBindingAccessChain(callee.expression) || expressionIsModuleBindingRootedCall(callee.expression)
  );
}

function isComparisonResultOperator(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.InstanceOfKeyword ||
    op === ts.SyntaxKind.InKeyword
  );
}

type ObviousModuleValueFamily = "f64" | "boolean" | "extern" | "string" | "nullish";

/** Narrow family evidence used only to reject representation mismatches. */
function obviousModuleValueFamily(expr: ts.Expression): ObviousModuleValueFamily | undefined {
  const candidate = unwrapPhase1Parens(expr);
  const binding = moduleBinding(candidate);
  if (binding?.valueKind.kind === "f64") return "f64";
  if (binding?.valueKind.kind === "i32") return "boolean";
  if (binding?.valueKind.kind === "extern") return "extern";
  const scalarAlias = moduleScalarAliasFamily(candidate);
  if (scalarAlias) return scalarAlias;
  if (isModuleMapGetAlias(candidate)) return "extern";
  if (ts.isNumericLiteral(candidate)) return "f64";
  if (candidate.kind === ts.SyntaxKind.TrueKeyword || candidate.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (candidate.kind === ts.SyntaxKind.NullKeyword) return "nullish";
  if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) return "string";
  if (ts.isPrefixUnaryExpression(candidate)) {
    if (candidate.operator === ts.SyntaxKind.ExclamationToken) return "boolean";
    if (
      candidate.operator === ts.SyntaxKind.PlusToken ||
      candidate.operator === ts.SyntaxKind.MinusToken ||
      candidate.operator === ts.SyntaxKind.TildeToken
    ) {
      return "f64";
    }
  }
  if (ts.isBinaryExpression(candidate)) {
    if (isComparisonResultOperator(candidate.operatorToken.kind)) return "boolean";
    if (candidate.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = obviousModuleValueFamily(candidate.left);
      const right = obviousModuleValueFamily(candidate.right);
      if (left === "string" || right === "string") return "string";
      if (left === "f64" && right === "f64") return "f64";
      return undefined;
    }
    if (candidate.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      const left = obviousModuleValueFamily(candidate.left);
      const right = obviousModuleValueFamily(candidate.right);
      return left !== undefined && left === right ? left : undefined;
    }
    if (
      candidate.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken &&
      candidate.operatorToken.kind !== ts.SyntaxKind.BarBarToken
    ) {
      return "f64";
    }
  }
  if (ts.isConditionalExpression(candidate)) {
    const whenTrue = obviousModuleValueFamily(candidate.whenTrue);
    const whenFalse = obviousModuleValueFamily(candidate.whenFalse);
    return whenTrue !== undefined && whenTrue === whenFalse ? whenTrue : undefined;
  }
  if (ts.isCallExpression(candidate) && isExactF64ScalarToStringCall(candidate)) return "string";
  if (ts.isCallExpression(candidate) && exactModuleMapMethod(candidate) === "get") return "extern";
  return currentModuleBindingResolver?.scalarExpressionFamily(candidate);
}

/**
 * Prove that every module-derived value which determines this expression's
 * condition representation is already boolean. Non-module subexpressions are
 * left to the existing selector/build type checks.
 */
function trackedModuleInfluenceIsBoolean(expr: ts.Expression): boolean {
  const candidate = unwrapPhase1Parens(expr);
  if (!expressionTouchesTrackedModuleValue(candidate)) return true;
  if (moduleBinding(candidate)) return isDirectBooleanModuleBinding(candidate);
  if (moduleScalarAliasFamily(candidate)) return moduleScalarAliasFamily(candidate) === "boolean";
  if (isModuleMapGetAlias(candidate)) return false;
  if (ts.isPrefixUnaryExpression(candidate) && candidate.operator === ts.SyntaxKind.ExclamationToken) {
    return trackedModuleInfluenceIsBoolean(candidate.operand);
  }
  if (ts.isBinaryExpression(candidate)) {
    if (isComparisonResultOperator(candidate.operatorToken.kind)) return true;
    if (
      candidate.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      candidate.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
      return trackedModuleInfluenceIsBoolean(candidate.left) && trackedModuleInfluenceIsBoolean(candidate.right);
    }
    return false;
  }
  if (ts.isConditionalExpression(candidate)) {
    return trackedModuleInfluenceIsBoolean(candidate.whenTrue) && trackedModuleInfluenceIsBoolean(candidate.whenFalse);
  }
  if (ts.isCallExpression(candidate)) {
    if (expressionIsModuleBindingRootedCall(candidate)) return false;
    return currentModuleBindingResolver?.scalarExpressionFamily(candidate) === "boolean";
  }
  return false;
}

/** Exact checker-owned module Map method, excluding conditional/nullish receivers. */
function exactModuleMapMethod(expr: ts.CallExpression): string | undefined {
  const callee = unwrapPhase1Parens(expr.expression);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return undefined;
  const receiver = moduleExternBinding(callee.expression);
  return receiver?.valueKind.kind === "extern" && receiver.valueKind.className === "Map" ? callee.name.text : undefined;
}

/**
 * #3517: certify the sole erased-generic constructor shape admitted by the
 * module-init selector. This deliberately requires the NewExpression itself
 * to initialize a direct top-level `const`; wrappers, locals, `let`, runtime
 * arguments, shadowed `Map`, and non-extern storage all retain the generic
 * constructor rejection.
 */
function isExactModuleMapGenericInitializer(expr: ts.NewExpression): boolean {
  const resolver = currentModuleBindingResolver;
  if (!currentSubjectIsModuleInit || resolver === null) return false;
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "Map") return false;
  if (expr.typeArguments?.length !== 2 || (expr.arguments?.length ?? 0) !== 0) return false;
  if (!resolver.isAmbientBinding(expr.expression) || !resolver.externCallArgumentsMatch(expr)) return false;

  const declaration = expr.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== expr) return false;
  if (!ts.isIdentifier(declaration.name)) return false;
  const declarationList = declaration.parent;
  if (!ts.isVariableDeclarationList(declarationList) || !(declarationList.flags & ts.NodeFlags.Const)) return false;
  const statement = declarationList.parent;
  if (!ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent)) return false;

  const storage = resolver(declaration.name);
  return storage?.valueKind.kind === "extern" && storage.valueKind.className === "Map";
}

/**
 * The one scalar method whose current host-string lowering is
 * representation-safe. The receiver proof deliberately covers numeric call
 * results as well as direct module globals/aliases: calendar::renderCal calls
 * `priceOf(...module-derived args).toString()`, whose result is checker-proven
 * f64 even though provenance scanning still sees the module arguments.
 */
function isExactF64ScalarToStringCall(expr: ts.CallExpression): boolean {
  if (!selectorSupportsNumberToString()) return false;
  if (expr.questionDotToken || expr.arguments.length !== 0) return false;
  const callee = unwrapPhase1Parens(expr.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken || callee.name.text !== "toString") {
    return false;
  }
  return expressionIsProvenNumber(callee.expression);
}

/**
 * Central consumer invariant for module extern values. Only shapes with a
 * proven lowering may own an expression that touches one; every coercing or
 * representation-changing consumer rejects before claim.
 */
function moduleExternConsumerIsProven(expr: ts.Expression, scope: ReadonlySet<string>): boolean {
  const candidate = unwrapPhase1Parens(expr);
  if (moduleExternBinding(candidate)) return true; // value / return / argument
  if (isModuleMapGetAlias(candidate)) return true; // direct narrowed value/return
  const touchesMapGetAlias = expressionTouchesModuleMapGetAlias(candidate);
  // Static method calls and property writes are proven by their parent
  // statement/call arms. A standalone property read still depends on member
  // import/result metadata unavailable to this selector (`node.id` can resolve
  // to an unregistered Element_get_id), so keep reads legacy-owned.
  if (ts.isPropertyAccessExpression(candidate)) return false;
  if (ts.isCallExpression(candidate)) return !touchesMapGetAlias && !isOptionalModuleExternCall(candidate);
  if (ts.isVoidExpression(candidate)) return !touchesMapGetAlias;
  if (ts.isBinaryExpression(candidate)) {
    const op = candidate.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(candidate.left) &&
      currentModuleBindingResolver?.(candidate.left, candidate.right)
    ) {
      return true;
    }
    if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      return false;
    }
    const left = unwrapPhase1Parens(candidate.left);
    const right = unwrapPhase1Parens(candidate.right);
    const isExactExternLike = (operand: ts.Expression): boolean =>
      moduleExternBinding(operand) !== undefined || isModuleMapGetAlias(operand);
    return (
      (isExactExternLike(left) &&
        (right.kind === ts.SyntaxKind.NullKeyword || isUnshadowedUndefinedIdentifier(right, scope))) ||
      (isExactExternLike(right) &&
        (left.kind === ts.SyntaxKind.NullKeyword || isUnshadowedUndefinedIdentifier(left, scope)))
    );
  }
  return false;
}

/** A real module lexical whose legacy storage has no sound IR representation. */
function isUnrepresentableModuleBinding(node: ts.Identifier): boolean {
  const resolver = currentModuleBindingResolver;
  return resolver !== null && resolver(node) === undefined && resolver.isDirectModuleBinding(node);
}

/**
 * Module values may enter an IR condition only when their representation is
 * semantically boolean. Numeric i32/f64 values still need JS ToBoolean, and
 * externrefs need host truthiness. Calls rooted in module externs are likewise
 * deferred because this selector has no result-type proof for the method.
 */
function isPhase1ConditionExpr(
  expr: ts.Expression,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
): boolean {
  let truthinessOperand = unwrapPhase1Parens(expr);
  while (
    ts.isPrefixUnaryExpression(truthinessOperand) &&
    truthinessOperand.operator === ts.SyntaxKind.ExclamationToken
  ) {
    truthinessOperand = unwrapPhase1Parens(truthinessOperand.operand);
  }
  if (!trackedModuleInfluenceIsBoolean(truthinessOperand)) {
    return shapeNo("condition-module-value-nonbool", expr);
  }
  if (expressionMayBeModuleBinding(truthinessOperand) && !isDirectBooleanModuleBinding(truthinessOperand)) {
    return shapeNo("condition-module-value-truthiness", expr);
  }
  if (expressionIsModuleExternAccessChain(truthinessOperand)) {
    return shapeNo("condition-module-extern-truthiness", expr);
  }
  if (expressionIsModuleExternRootedCall(truthinessOperand)) {
    return shapeNo("condition-module-extern-call", expr);
  }
  return isPhase1Expr(expr, scope, localClasses);
}

/** Numeric proof used by coercion-sensitive builtin slices (`~`, toFixed). */
function expressionIsProvenNumber(expr: ts.Expression, seen = new Set<ts.VariableDeclaration>()): boolean {
  const candidate = unwrapPhase1Parens(expr);
  if (ts.isNumericLiteral(candidate)) return true;
  if (ts.isIdentifier(candidate)) {
    if (currentNumericParamNames.has(candidate.text)) return true;
    // The module-binding resolver has already proved the shared slot and all
    // of its writes numeric. Do not re-audit the declaration initializer as a
    // local alias: host-produced numeric initializers such as
    // `new Date().getFullYear()` are intentionally outside this helper's
    // narrow call-expression recursion, but their module slot is still an
    // exact f64 value.
    if (moduleBinding(candidate)?.valueKind.kind === "f64") return true;
    const checkerProvesNumber = currentSelectionOptions?.classifyPrimitiveExpression?.(candidate) === "number";
    if (currentModuleBindingResolver?.scalarExpressionFamily(candidate) !== "f64" && !checkerProvesNumber) return false;
    const declaration = currentModuleBindingResolver?.localVariableDeclaration(candidate);
    // Parameters and checker-proven non-local numeric bindings have no local
    // initializer to audit. Local variables do: with semantic diagnostics
    // skipped, their annotation may say `number` while the initializer is a
    // string/boolean. Trace the initializer before allowing a coercion-
    // sensitive builtin to claim the function.
    if (!declaration) return checkerProvesNumber || currentModuleBindingResolver !== null;
    if (seen.has(declaration)) return false;
    if (declaration.type !== undefined && !typeNodeIsNumberOnly(declaration.type)) return false;
    if (!declaration.initializer) return false;
    const nextSeen = new Set(seen);
    nextSeen.add(declaration);
    return expressionIsProvenNumber(declaration.initializer, nextSeen);
  }
  if (ts.isPrefixUnaryExpression(candidate)) {
    return (
      (candidate.operator === ts.SyntaxKind.PlusToken ||
        candidate.operator === ts.SyntaxKind.MinusToken ||
        candidate.operator === ts.SyntaxKind.TildeToken) &&
      expressionIsProvenNumber(candidate.operand, seen)
    );
  }
  if (
    ts.isAsExpression(candidate) ||
    ts.isTypeAssertionExpression(candidate) ||
    ts.isSatisfiesExpression(candidate) ||
    ts.isNonNullExpression(candidate)
  ) {
    return expressionIsProvenNumber(candidate.expression, seen);
  }
  if (ts.isCallExpression(candidate) && ts.isPropertyAccessExpression(candidate.expression)) {
    const recv = candidate.expression.expression;
    const plan = IR_MATH_METHOD_TABLE[candidate.expression.name.text];
    return (
      ts.isIdentifier(recv) &&
      recv.text === "Math" &&
      selectorSeesAmbientBinding(recv) &&
      plan !== undefined &&
      selectorSupportsMathPlan(plan) &&
      candidate.arguments.length === plan.arity &&
      candidate.arguments.every((arg) => !ts.isSpreadElement(arg) && expressionIsProvenNumber(arg, seen))
    );
  }
  return (
    currentModuleBindingResolver?.scalarExpressionFamily(candidate) === "f64" ||
    currentSelectionOptions?.classifyPrimitiveExpression?.(candidate) === "number"
  );
}

function selectorSeesAmbientBinding(node: ts.Identifier): boolean {
  return (
    currentSelectionOptions?.isAmbientBinding?.(node) === true ||
    currentModuleBindingResolver?.isAmbientBinding(node) === true
  );
}

function selectorSeesAmbientStringBinding(node: ts.Identifier): boolean {
  return (
    currentSelectionOptions?.isAmbientStringBinding?.(node) === true ||
    (currentSelectionOptions?.isAmbientStringBinding === undefined && selectorSeesAmbientBinding(node))
  );
}

function selectorSupportsMathPlan(plan: IrMathMethodPlan): boolean {
  return "op" in plan || currentSelectionOptions?.supportsSymbolicMathHelpers === true;
}

function selectorSupportsNumberToString(): boolean {
  return (
    currentSelectionOptions?.supportsNumberToString === true ||
    currentModuleBindingResolver?.supportsHostNumberToString === true
  );
}

function isBoundedToFixedCall(expr: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(expr.expression) || expr.expression.name.text !== "toFixed") return false;
  if (currentModuleBindingResolver?.supportsHostNumberToString !== true) return false;
  if (expr.arguments.length !== 1 || !ts.isNumericLiteral(expr.arguments[0]!)) return false;
  const digits = Number(expr.arguments[0]!.text.replace(/_/g, ""));
  return (
    Number.isInteger(digits) && digits >= 0 && digits <= 100 && expressionIsProvenNumber(expr.expression.expression)
  );
}

function expressionIsProvenString(expr: ts.Expression, seen = new Set<ts.VariableDeclaration>()): boolean {
  const candidate = unwrapPhase1Parens(expr);
  if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) return true;
  if (!ts.isIdentifier(candidate)) return false;
  // Literal provenance alone is insufficient when an explicit annotation
  // gives the local a different IR representation. With semantic diagnostics
  // skipped, `const s: number = "aba"` is still a valid input to codegen; the
  // old proof admitted `s.replace(...)`, then the builder failed after claim
  // while trying to initialize an f64 local with a string. Inferred locals are
  // checker-proven by their literal initializer. Explicit annotations need an
  // equally narrow string-only certificate here; aliases and mixed unions stay
  // conservatively legacy-owned until the resolver exposes string type proof.
  if (currentModuleBindingResolver?.scalarExpressionFamily(candidate) !== undefined) return false;
  const declaration = currentModuleBindingResolver?.localVariableDeclaration(candidate);
  if (!declaration || seen.has(declaration)) return false;
  if (declaration.type !== undefined && !typeNodeIsStringOnly(declaration.type)) return false;
  if (!declaration.initializer) return false;
  seen.add(declaration);
  return expressionIsProvenString(declaration.initializer, seen);
}

function typeNodeIsStringOnly(typeNode: ts.TypeNode): boolean {
  if (typeNode.kind === ts.SyntaxKind.StringKeyword) return true;
  if (ts.isParenthesizedTypeNode(typeNode)) return typeNodeIsStringOnly(typeNode.type);
  if (ts.isLiteralTypeNode(typeNode)) return ts.isStringLiteral(typeNode.literal);
  if (ts.isUnionTypeNode(typeNode)) return typeNode.types.every(typeNodeIsStringOnly);
  return false;
}

function typeNodeIsNumberOnly(typeNode: ts.TypeNode): boolean {
  if (typeNode.kind === ts.SyntaxKind.NumberKeyword) return true;
  if (ts.isParenthesizedTypeNode(typeNode)) return typeNodeIsNumberOnly(typeNode.type);
  if (ts.isLiteralTypeNode(typeNode)) {
    if (ts.isNumericLiteral(typeNode.literal)) return true;
    return (
      ts.isPrefixUnaryExpression(typeNode.literal) &&
      (typeNode.literal.operator === ts.SyntaxKind.PlusToken ||
        typeNode.literal.operator === ts.SyntaxKind.MinusToken) &&
      ts.isNumericLiteral(typeNode.literal.operand)
    );
  }
  if (ts.isUnionTypeNode(typeNode)) return typeNode.types.every(typeNodeIsNumberOnly);
  return false;
}

function isLiteralStringReplaceCall(expr: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(expr.expression) || expr.expression.name.text !== "replace") return false;
  if (expr.arguments.length !== 2) return false;
  return (
    expressionIsProvenString(expr.expression.expression) &&
    expr.arguments.every((arg) => ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
  );
}

// #3529 P1 — exact String producer surface mirrored from from-ast's
// STRING_METHOD_TABLE. This selector table intentionally stores only arity;
// lowering remains the owner of representation-specific argument plans.
const IR_STRING_METHOD_ARITY: Readonly<Record<string, readonly [min: number, max: number]>> = Object.freeze({
  toUpperCase: [0, 0],
  toLowerCase: [0, 0],
  trim: [0, 0],
  charAt: [0, 1],
  slice: [1, 2],
  substring: [0, 2],
  charCodeAt: [0, 1],
  indexOf: [1, 2],
  includes: [1, 2],
  startsWith: [1, 2],
  endsWith: [1, 2],
  replace: [2, 2],
});

function stringMethodHasSupportedArity(name: string, args: readonly ts.Expression[]): boolean {
  // Own-property lookup is deliberate: `toString` / `valueOf` must not hit
  // Object.prototype through a plain Record index.
  if (!Object.prototype.hasOwnProperty.call(IR_STRING_METHOD_ARITY, name)) return false;
  const range = IR_STRING_METHOD_ARITY[name]!;
  return args.length >= range[0] && args.length <= range[1] && !args.some(ts.isSpreadElement);
}

function localClassNameFromTypeNode(node: ts.TypeNode): string | null {
  let typeNode = node;
  while (ts.isParenthesizedTypeNode(typeNode)) typeNode = typeNode.type;
  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return null;
  return currentLocalClassDeclarations.has(typeNode.typeName.text) ? typeNode.typeName.text : null;
}

type ProjectionBindingSnapshot = readonly [Map<string, string>, Map<string, number>, Map<string, string>];

function hasProjectionBinding(name: string): boolean {
  return currentClassBindings.has(name) || currentCallableArities.has(name) || currentCallableReturnClasses.has(name);
}

function projectionBindingMutationIsUnsupported(name: string, node: ts.Node): boolean {
  if (!hasProjectionBinding(name)) return false;
  shapeNo("projection-binding-mutation-no-slot", node);
  return true;
}

function clearProjectionBinding(name: string): void {
  currentClassBindings.delete(name);
  currentCallableArities.delete(name);
  currentCallableReturnClasses.delete(name);
}

function recordCallableProjection(name: string, arity: number, returnType: ts.TypeNode | undefined): void {
  clearProjectionBinding(name);
  currentCallableArities.set(name, arity);
  const returnClass = returnType ? localClassNameFromTypeNode(returnType) : null;
  if (returnClass !== null) currentCallableReturnClasses.set(name, returnClass);
}

function projectionBindingSnapshot(): ProjectionBindingSnapshot {
  return [currentClassBindings, currentCallableArities, currentCallableReturnClasses];
}

function restoreProjectionBindings(snapshot: ProjectionBindingSnapshot): void {
  [currentClassBindings, currentCallableArities, currentCallableReturnClasses] = snapshot;
}

function projectionEvidenceChanged(
  previous: ProjectionBindingSnapshot,
  scoped: ProjectionBindingSnapshot,
  name: string,
): boolean {
  return (
    previous[0].get(name) !== scoped[0].get(name) ||
    previous[1].get(name) !== scoped[1].get(name) ||
    previous[2].get(name) !== scoped[2].get(name)
  );
}

function withProjectionEvidenceScope<T>(callback: () => T): T {
  const previous = projectionBindingSnapshot();
  currentClassBindings = new Map(currentClassBindings);
  currentCallableArities = new Map(currentCallableArities);
  currentCallableReturnClasses = new Map(currentCallableReturnClasses);
  try {
    return callback();
  } finally {
    const scoped = projectionBindingSnapshot();
    const invalidatedOuterNames = new Set([...previous[0].keys(), ...previous[1].keys(), ...previous[2].keys()]);
    restoreProjectionBindings(previous);
    // Declarations introduced only inside the scoped walk disappear. Changes
    // to evidence that existed on entry are a control-flow join, however: the
    // nested path may have executed, so restoring the stale outer fact would
    // be unsound. Keep it only when every tracked component is unchanged.
    for (const name of invalidatedOuterNames) {
      if (projectionEvidenceChanged(previous, scoped, name)) clearProjectionBinding(name);
    }
  }
}

function collectBindingNameTexts(name: ts.BindingName, target: Set<string>): void {
  if (ts.isIdentifier(name)) {
    target.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    collectBindingNameTexts(element.name, target);
  }
}

function withLexicalValueBindingScope<T>(statements: readonly ts.Statement[], callback: () => T): T {
  const previous = currentLexicalValueBindingNames;
  const scoped = new Set(previous);
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNameTexts(declaration.name, scoped);
    }
  }
  currentLexicalValueBindingNames = scoped;
  try {
    return callback();
  } finally {
    currentLexicalValueBindingNames = previous;
  }
}

function enterProjectionBindingScope(parameters: readonly ts.ParameterDeclaration[]): ProjectionBindingSnapshot {
  const previous = projectionBindingSnapshot();
  currentClassBindings = new Map(currentClassBindings);
  currentCallableArities = new Map(currentCallableArities);
  currentCallableReturnClasses = new Map(currentCallableReturnClasses);
  for (const parameter of parameters) {
    if (!ts.isIdentifier(parameter.name)) continue;
    clearProjectionBinding(parameter.name.text);
    if (!parameter.type) continue;
    const className = localClassNameFromTypeNode(parameter.type);
    if (className !== null) currentClassBindings.set(parameter.name.text, className);
    if (ts.isFunctionTypeNode(parameter.type)) {
      const signature = irClosureSignatureFromFunctionTypeNode(parameter.type);
      if (signature) recordCallableProjection(parameter.name.text, signature.params.length, parameter.type.type);
    }
  }
  return previous;
}

function unwrapProjectionExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function computedMemberMayName(name: ts.PropertyName, requested: string): boolean {
  if (!ts.isComputedPropertyName(name)) return false;
  const expression = unwrapProjectionExpression(name.expression);
  if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) return expression.text === requested;
  // Checker-resolved constant computed keys are deliberately not re-evaluated
  // here. If no ordinary projected member matched first, any dynamic/computed
  // declaration is enough to prove the requested member may be absent from the
  // IR class descriptor (the measured `const key = "m"; [key]()` shape).
  return true;
}

function hasFixedIrParameters(parameters: readonly ts.ParameterDeclaration[]): boolean {
  return parameters.every(
    (parameter) =>
      ts.isIdentifier(parameter.name) &&
      !parameter.questionToken &&
      !parameter.dotDotDotToken &&
      !parameter.initializer,
  );
}

type ClassProjectionStatus = "projected" | "unprojected" | "missing";

interface ClassMethodProjection {
  readonly status: ClassProjectionStatus;
  readonly declaration?: ts.MethodDeclaration;
  readonly arity?: number;
  readonly returnClassName?: string;
}

export function classElementIsStatic(member: ts.ClassElement): boolean {
  return (
    ts.canHaveModifiers(member) &&
    (ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false)
  );
}

function classElementMayName(member: ts.ClassElement, requested: string): boolean {
  if (!member.name) return false;
  if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)) {
    return member.name.text === requested;
  }
  return computedMemberMayName(member.name, requested);
}

function classMethodProjection(className: string, methodName: string, isStatic: boolean): ClassMethodProjection {
  const exactShapes = currentSelectionOptions?.projectedClassShapes;
  if (exactShapes) {
    const wantedKind = isStatic ? "static" : "method";
    let declaration = currentLocalClassDeclarations.get(className);
    for (let shape = exactShapes.get(className); shape; shape = shape.parent) {
      const method = shape.methods.find(
        (candidate) => candidate.name === methodName && (candidate.memberKind ?? "method") === wantedKind,
      );
      if (method) {
        return {
          status: "projected",
          arity: method.params.length,
          ...(method.returnType?.kind === "class" ? { returnClassName: method.returnType.shape.className } : {}),
        };
      }
      // An own field/accessor/unprojectable method shadows an inherited
      // callable of the same runtime name. Stop at this class instead of
      // falling through to a parent descriptor that the builder would never
      // dispatch for the source member.
      if (
        declaration?.members.some(
          (member) => classElementIsStatic(member) === isStatic && classElementMayName(member, methodName),
        )
      ) {
        return { status: "unprojected" };
      }
      const parent = declaration ? extendsParentName(declaration) : null;
      declaration = parent === null ? undefined : currentLocalClassDeclarations.get(parent);
    }
    return { status: "missing" };
  }

  let cursor = currentLocalClassDeclarations.get(className);
  while (cursor) {
    const matchingInstanceMethod = cursor.members.some(
      (member) =>
        ts.isMethodDeclaration(member) &&
        !classElementIsStatic(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === methodName,
    );
    for (const member of cursor.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue;
      const memberIsStatic = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
      if (memberIsStatic !== isStatic) continue;
      if (ts.isIdentifier(member.name) && member.name.text === methodName) {
        if (isStatic && matchingInstanceMethod) return { status: "unprojected", declaration: member };
        return classMethodSignatureMayProject(member, cursor)
          ? {
              status: "projected",
              declaration: member,
              arity: member.parameters.length,
              ...(member.type && localClassNameFromTypeNode(member.type)
                ? { returnClassName: localClassNameFromTypeNode(member.type)! }
                : {}),
            }
          : { status: "unprojected", declaration: member };
      }
    }
    for (const member of cursor.members) {
      if (classElementIsStatic(member) === isStatic && classElementMayName(member, methodName)) {
        return { status: "unprojected" };
      }
    }
    const parent = extendsParentName(cursor);
    cursor = parent === null ? undefined : currentLocalClassDeclarations.get(parent);
  }
  return { status: "missing" };
}

function classPropertyHasKnownProjectionGap(className: string, propertyName: string): boolean {
  const exactShapes = currentSelectionOptions?.projectedClassShapes;
  let exactShape = exactShapes?.get(className);
  let cursor = currentLocalClassDeclarations.get(className);
  while (cursor) {
    const ownMembers = cursor.members.filter(
      (member) =>
        !!member.name &&
        !classElementIsStatic(member) &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)
          ? member.name.text === propertyName
          : computedMemberMayName(member.name, propertyName)),
    );
    const field = ownMembers.find(ts.isPropertyDeclaration);
    if (field) {
      if (exactShapes) return !exactShape?.fields.some((candidate) => candidate.name === propertyName);
      return !classFieldMayProject(field, cursor);
    }
    const getter = ownMembers.find(ts.isGetAccessorDeclaration);
    if (getter) {
      if (ts.isComputedPropertyName(getter.name)) return true;
      if (exactShapes) {
        return !exactShape?.methods.some(
          (candidate) => candidate.name === propertyName && candidate.memberKind === "getter",
        );
      }
      return !classAccessorMayProject(getter, cursor);
    }
    // A method is not a first-class value in this IR, and a setter-only
    // property reads as undefined rather than falling through to an ancestor.
    if (ownMembers.some((member) => ts.isMethodDeclaration(member) || ts.isSetAccessorDeclaration(member))) {
      return true;
    }
    if (exactShapes && exactShape?.fields.some((candidate) => candidate.name === propertyName)) return false;
    for (const member of cursor.members) {
      if (!member.name) continue;
      if (computedMemberMayName(member.name, propertyName)) {
        return true;
      }
    }
    const parent = extendsParentName(cursor);
    cursor = parent === null ? undefined : currentLocalClassDeclarations.get(parent);
    exactShape = exactShape?.parent;
  }
  return true;
}

function classPropertyReturnClassName(className: string, propertyName: string): string | null {
  const exactShapes = currentSelectionOptions?.projectedClassShapes;
  let exactShape = exactShapes?.get(className);
  let cursor = currentLocalClassDeclarations.get(className);
  while (cursor) {
    const ownMembers = cursor.members.filter(
      (member) =>
        !!member.name &&
        !classElementIsStatic(member) &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)
          ? member.name.text === propertyName
          : computedMemberMayName(member.name, propertyName)),
    );
    const field = ownMembers.find(ts.isPropertyDeclaration);
    if (field) {
      if (exactShapes) {
        const descriptor = exactShape?.fields.find((candidate) => candidate.name === propertyName);
        return descriptor?.type.kind === "class" ? descriptor.type.shape.className : null;
      }
      if (!classFieldMayProject(field, cursor)) return null;
      const annotated = field.type ? localClassNameFromTypeNode(field.type) : null;
      if (annotated !== null) return annotated;
      const initializer = field.initializer ? unwrapProjectionExpression(field.initializer) : undefined;
      return initializer && ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)
        ? currentLocalClassDeclarations.has(initializer.expression.text)
          ? initializer.expression.text
          : null
        : null;
    }
    const getter = ownMembers.find(ts.isGetAccessorDeclaration);
    if (getter) {
      if (ts.isComputedPropertyName(getter.name)) return null;
      if (exactShapes) {
        const descriptor = exactShape?.methods.find(
          (candidate) => candidate.name === propertyName && candidate.memberKind === "getter",
        );
        return descriptor?.returnType?.kind === "class" ? descriptor.returnType.shape.className : null;
      }
      return classAccessorMayProject(getter, cursor) && getter.type ? localClassNameFromTypeNode(getter.type) : null;
    }
    if (ownMembers.length > 0) return null;
    if (exactShapes) {
      const fieldDescriptor = exactShape?.fields.find((candidate) => candidate.name === propertyName);
      if (fieldDescriptor) return fieldDescriptor.type.kind === "class" ? fieldDescriptor.type.shape.className : null;
      const getterDescriptor = exactShape?.methods.find(
        (candidate) => candidate.name === propertyName && candidate.memberKind === "getter",
      );
      if (getterDescriptor)
        return getterDescriptor.returnType?.kind === "class" ? getterDescriptor.returnType.shape.className : null;
    }
    const parent = extendsParentName(cursor);
    cursor = parent === null ? undefined : currentLocalClassDeclarations.get(parent);
    exactShape = exactShape?.parent;
  }
  return null;
}

function classPropertyWriteHasKnownProjectionGap(className: string, propertyName: string): boolean {
  const exactShapes = currentSelectionOptions?.projectedClassShapes;
  let exactShape = exactShapes?.get(className);
  let cursor = currentLocalClassDeclarations.get(className);
  while (cursor) {
    const ownMembers = cursor.members.filter(
      (member) =>
        !!member.name &&
        !classElementIsStatic(member) &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)
          ? member.name.text === propertyName
          : computedMemberMayName(member.name, propertyName)),
    );
    const field = ownMembers.find(ts.isPropertyDeclaration);
    if (field) {
      if (exactShapes) return !exactShape?.fields.some((candidate) => candidate.name === propertyName);
      return !classFieldMayProject(field, cursor);
    }
    const setter = ownMembers.find(ts.isSetAccessorDeclaration);
    if (setter) {
      if (ts.isComputedPropertyName(setter.name)) return true;
      if (exactShapes) {
        return !exactShape?.methods.some(
          (candidate) => candidate.name === propertyName && candidate.memberKind === "setter",
        );
      }
      return !classAccessorMayProject(setter, cursor);
    }
    if (ownMembers.length > 0) return true;
    if (exactShapes && exactShape?.fields.some((candidate) => candidate.name === propertyName)) return false;
    const parent = extendsParentName(cursor);
    cursor = parent === null ? undefined : currentLocalClassDeclarations.get(parent);
    exactShape = exactShape?.parent;
  }
  return true;
}

function preflightClassPropertyWrite(expression: ts.PropertyAccessExpression, scope: ReadonlySet<string>): boolean {
  if (!ts.isIdentifier(expression.name)) return true;
  const receiverClass = localClassNameForExpression(expression.expression, scope);
  if (receiverClass === null) return true;
  if (localClassHasKnownProjectionGap(receiverClass)) {
    return capabilityNo("class-projection-unsupported", "expr-class-property-write-shape", expression);
  }
  if (classPropertyWriteHasKnownProjectionGap(receiverClass, expression.name.text)) {
    return capabilityNo("class-member-unsupported", "expr-class-property-write-member", expression);
  }
  return true;
}

function classPositionTypeMayProject(
  type: ts.TypeNode | undefined,
  owner: ts.ClassDeclaration,
  allowVoid: boolean = false,
): boolean {
  if (!type) return false;
  let node = type;
  while (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) node = node.type;
  if (
    node.kind === ts.SyntaxKind.NumberKeyword ||
    node.kind === ts.SyntaxKind.BooleanKeyword ||
    node.kind === ts.SyntaxKind.StringKeyword
  ) {
    return true;
  }
  if (allowVoid && node.kind === ts.SyntaxKind.VoidKeyword) return true;
  if (ts.isLiteralTypeNode(node)) {
    return (
      ts.isNumericLiteral(node.literal) ||
      ts.isStringLiteral(node.literal) ||
      node.literal.kind === ts.SyntaxKind.TrueKeyword ||
      node.literal.kind === ts.SyntaxKind.FalseKeyword
    );
  }
  if (ts.isTypeReferenceNode(node)) {
    if (node.typeArguments && node.typeArguments.length > 0) return false;
    if (!ts.isIdentifier(node.typeName)) return false;
    const local = currentLocalClassDeclarations.get(node.typeName.text);
    return local ? local !== owner && local.getStart() < owner.getStart() : false;
  }
  if (ts.isTypeLiteralNode(node)) {
    return node.members.every(
      (member) =>
        ts.isPropertySignature(member) &&
        !member.questionToken &&
        !!member.type &&
        classPositionTypeMayProject(member.type, owner),
    );
  }
  return false;
}

function classInitializerMayProject(initializer: ts.Expression | undefined, owner: ts.ClassDeclaration): boolean {
  if (!initializer) return false;
  const candidate = unwrapProjectionExpression(initializer);
  if (
    ts.isNumericLiteral(candidate) ||
    ts.isStringLiteral(candidate) ||
    candidate.kind === ts.SyntaxKind.TrueKeyword ||
    candidate.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(candidate) && ts.isNumericLiteral(candidate.operand)) return true;
  if (ts.isNewExpression(candidate) && ts.isIdentifier(candidate.expression)) {
    const local = currentLocalClassDeclarations.get(candidate.expression.text);
    return local !== undefined && local !== owner && local.getStart() < owner.getStart();
  }
  return false;
}

function classFieldMayProject(field: ts.PropertyDeclaration, owner: ts.ClassDeclaration): boolean {
  if (!ts.isIdentifier(field.name) && !ts.isPrivateIdentifier(field.name)) return false;
  return field.type
    ? classPositionTypeMayProject(field.type, owner)
    : classInitializerMayProject(field.initializer, owner);
}

function classMethodSignatureMayProject(method: ts.MethodDeclaration, owner: ts.ClassDeclaration): boolean {
  return (
    hasFixedIrParameters(method.parameters) &&
    method.parameters.every((parameter) => classPositionTypeMayProject(parameter.type, owner)) &&
    classPositionTypeMayProject(method.type, owner, /* allowVoid */ true)
  );
}

function classAccessorMayProject(
  accessor: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  owner: ts.ClassDeclaration,
): boolean {
  if (ts.isGetAccessorDeclaration(accessor)) {
    return accessor.parameters.length === 0 && classPositionTypeMayProject(accessor.type, owner);
  }
  return (
    accessor.parameters.length === 1 &&
    hasFixedIrParameters(accessor.parameters) &&
    classPositionTypeMayProject(accessor.parameters[0]!.type, owner)
  );
}

/** Mirror the builder's declaration-order class-shape dependency. */
export function localClassHasKnownProjectionGap(className: string): boolean {
  const exactShapes = currentSelectionOptions?.projectedClassShapes;
  if (exactShapes) return !exactShapes.has(className);
  return localClassHasSyntaxProjectionGap(className, new Set());
}

function localClassHasSyntaxProjectionGap(className: string, visiting: Set<string>): boolean {
  const declaration = currentLocalClassDeclarations.get(className);
  if (!declaration) return true;
  if (visiting.has(className)) return true;
  visiting.add(className);
  const parent = extendsParentName(declaration);
  if (parent !== null) {
    const parentDeclaration = currentLocalClassDeclarations.get(parent);
    if (
      !parentDeclaration ||
      parentDeclaration.getStart() >= declaration.getStart() ||
      localClassHasSyntaxProjectionGap(parent, visiting)
    )
      return true;
  }
  for (const member of declaration.members) {
    if (ts.isConstructorDeclaration(member)) {
      if (!hasFixedIrParameters(member.parameters)) return true;
      if (!member.parameters.every((parameter) => classPositionTypeMayProject(parameter.type, declaration)))
        return true;
      continue;
    }
    if (
      ts.isPropertyDeclaration(member) &&
      !(member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false) &&
      !classFieldMayProject(member, declaration)
    ) {
      return true;
    }
    if (
      ts.isMethodDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      !(member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false) &&
      !(member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) ?? false) &&
      !member.asteriskToken
    ) {
      if (!classMethodSignatureMayProject(member, declaration)) return true;
    }
  }
  visiting.delete(className);
  return false;
}

function superParentClassName(): string | null {
  if (currentClaimClassName === null) return null;
  const exactShapes = currentSelectionOptions?.projectedClassShapes;
  if (exactShapes) return exactShapes.get(currentClaimClassName)?.parent?.className ?? null;
  const declaration = currentLocalClassDeclarations.get(currentClaimClassName);
  return declaration ? extendsParentName(declaration) : null;
}

function projectedConstructorArity(className: string): number | undefined {
  const exactShapes = currentSelectionOptions?.projectedClassShapes;
  if (exactShapes) return exactShapes.get(className)?.constructorParams.length;
  const declaration = currentLocalClassDeclarations.get(className);
  if (!declaration) return undefined;
  const ctor = declaration.members.find(ts.isConstructorDeclaration);
  if (!ctor) return 0;
  return hasFixedIrParameters(ctor.parameters) ? ctor.parameters.length : undefined;
}

function localClassValueIsUnshadowed(name: string, scope: ReadonlySet<string>): boolean {
  return !scope.has(name) && !currentNestedFunctionNames.has(name) && !currentLexicalValueBindingNames.has(name);
}

function localClassNameForExpression(expression: ts.Expression, scope: ReadonlySet<string>): string | null {
  const candidate = unwrapProjectionExpression(expression);
  const checkerClass = currentSelectionOptions?.resolveLocalClassExpression?.(candidate);
  const checkerClassName = typeof checkerClass === "string" ? checkerClass : checkerClass?.legacyName;
  if (checkerClassName !== undefined && currentLocalClassDeclarations.has(checkerClassName)) {
    return checkerClassName;
  }
  if (candidate.kind === ts.SyntaxKind.ThisKeyword) return currentClaimClassName;
  if (ts.isNewExpression(candidate) && ts.isIdentifier(candidate.expression)) {
    return localClassValueIsUnshadowed(candidate.expression.text, scope) &&
      currentLocalClassDeclarations.has(candidate.expression.text)
      ? candidate.expression.text
      : null;
  }
  if (ts.isIdentifier(candidate)) {
    return scope.has(candidate.text) ? (currentClassBindings.get(candidate.text) ?? null) : null;
  }
  if (ts.isConditionalExpression(candidate)) {
    const whenTrue = localClassNameForExpression(candidate.whenTrue, scope);
    const whenFalse = localClassNameForExpression(candidate.whenFalse, scope);
    return whenTrue !== null && whenTrue === whenFalse ? whenTrue : null;
  }
  if (ts.isCallExpression(candidate)) {
    if (ts.isIdentifier(candidate.expression)) {
      if (scope.has(candidate.expression.text)) {
        return currentCallableReturnClasses.get(candidate.expression.text) ?? null;
      }
      if (
        currentNestedFunctionNames.has(candidate.expression.text) ||
        currentLexicalValueBindingNames.has(candidate.expression.text)
      )
        return null;
      const declaration = currentDynScanDecls?.get(candidate.expression.text);
      const returnType = declaration ? effectiveIrReturnTypeNode(declaration) : undefined;
      return returnType ? localClassNameFromTypeNode(returnType) : null;
    }
    if (ts.isPropertyAccessExpression(candidate.expression)) {
      const receiver = candidate.expression.expression;
      const staticReceiver = unwrapProjectionExpression(receiver);
      if (
        ts.isIdentifier(staticReceiver) &&
        localClassValueIsUnshadowed(staticReceiver.text, scope) &&
        currentLocalClassDeclarations.has(staticReceiver.text)
      ) {
        const method = classMethodProjection(staticReceiver.text, candidate.expression.name.text, true);
        return method.status === "projected" ? (method.returnClassName ?? null) : null;
      }
      const receiverClass = localClassNameForExpression(receiver, scope);
      if (!receiverClass) return null;
      const method = classMethodProjection(receiverClass, candidate.expression.name.text, false);
      return method.status === "projected" ? (method.returnClassName ?? null) : null;
    }
  }
  if (ts.isPropertyAccessExpression(candidate) && ts.isIdentifier(candidate.name)) {
    const receiverClass = localClassNameForExpression(candidate.expression, scope);
    return receiverClass === null ? null : classPropertyReturnClassName(receiverClass, candidate.name.text);
  }
  return null;
}

function knownCallableArity(expression: ts.Expression, scope: ReadonlySet<string>): number | undefined {
  const candidate = unwrapProjectionExpression(expression);
  if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
    return hasFixedIrParameters(candidate.parameters) ? candidate.parameters.length : undefined;
  }
  if (!ts.isIdentifier(candidate)) return undefined;
  if (scope.has(candidate.text)) {
    return currentClassBindings.has(candidate.text) ? undefined : currentCallableArities.get(candidate.text);
  }
  if (currentNestedFunctionNames.has(candidate.text) || currentLexicalValueBindingNames.has(candidate.text))
    return undefined;
  const topLevel = currentDynScanDecls?.get(candidate.text);
  if (topLevel && hasFixedIrParameters(topLevel.parameters)) return topLevel.parameters.length;
  const declaration = currentModuleBindingResolver?.localVariableDeclaration(candidate);
  if (!declaration) return undefined;
  if (
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
  ) {
    return hasFixedIrParameters(declaration.initializer.parameters)
      ? declaration.initializer.parameters.length
      : undefined;
  }
  if (declaration.type && ts.isFunctionTypeNode(declaration.type)) {
    const signature = irClosureSignatureFromFunctionTypeNode(declaration.type);
    return signature?.params.length;
  }
  return undefined;
}

function isNumericArrayTypeNode(node: ts.TypeNode): boolean {
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return isNumericArrayTypeNode(node.type);
  }
  if (ts.isArrayTypeNode(node)) return node.elementType.kind === ts.SyntaxKind.NumberKeyword;
  return (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    (node.typeName.text === "Array" || node.typeName.text === "ReadonlyArray") &&
    node.typeArguments?.length === 1 &&
    node.typeArguments[0]!.kind === ts.SyntaxKind.NumberKeyword
  );
}

function directCallParamUsesNumericVecAbi(
  call: ts.CallExpression,
  parameterIndex: number,
  scope: ReadonlySet<string>,
): boolean {
  if (!ts.isIdentifier(call.expression)) return false;
  if (
    scope.has(call.expression.text) ||
    currentNestedFunctionNames.has(call.expression.text) ||
    currentLexicalValueBindingNames.has(call.expression.text)
  ) {
    return false;
  }
  const declaration = currentDynScanDecls?.get(call.expression.text);
  const parameter = declaration?.parameters[parameterIndex];
  if (!parameter || !ts.isIdentifier(parameter.name)) return false;
  const type = effectiveIrParamTypeNode(parameter);
  return type
    ? isNumericArrayTypeNode(type)
    : currentSelectionOptions?.implicitParamUsesNumericVecAbi?.(parameter) === true;
}

type ObviousSelectorValueFamily = "number" | "boolean" | "string" | "reference" | "nullish";

function obviousSelectorValueFamily(
  expression: ts.Expression,
  scope: ReadonlySet<string>,
): ObviousSelectorValueFamily | undefined {
  const candidate = unwrapProjectionExpression(expression);
  if (ts.isNumericLiteral(candidate)) return "number";
  if (candidate.kind === ts.SyntaxKind.TrueKeyword || candidate.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) return "string";
  if (candidate.kind === ts.SyntaxKind.NullKeyword) return "nullish";
  if (ts.isTypeOfExpression(candidate) || ts.isTemplateExpression(candidate)) return "string";
  if (ts.isPrefixUnaryExpression(candidate)) {
    if (candidate.operator === ts.SyntaxKind.ExclamationToken) return "boolean";
    if (
      candidate.operator === ts.SyntaxKind.PlusToken ||
      candidate.operator === ts.SyntaxKind.MinusToken ||
      candidate.operator === ts.SyntaxKind.TildeToken
    )
      return "number";
  }
  if (ts.isBinaryExpression(candidate) && isComparisonResultOperator(candidate.operatorToken.kind)) return "boolean";
  if (ts.isConditionalExpression(candidate)) {
    const whenTrue = obviousSelectorValueFamily(candidate.whenTrue, scope);
    const whenFalse = obviousSelectorValueFamily(candidate.whenFalse, scope);
    return whenTrue !== undefined && whenTrue === whenFalse ? whenTrue : undefined;
  }
  if (
    ts.isObjectLiteralExpression(candidate) ||
    ts.isArrayLiteralExpression(candidate) ||
    ts.isArrowFunction(candidate) ||
    ts.isFunctionExpression(candidate) ||
    currentSelectionOptions?.isArrayExpression?.(candidate) === true ||
    localClassNameForExpression(candidate, scope) !== null ||
    (ts.isIdentifier(candidate) &&
      localClassValueIsUnshadowed(candidate.text, scope) &&
      currentLocalClassDeclarations.has(candidate.text)) ||
    knownCallableArity(candidate, scope) !== undefined
  ) {
    return "reference";
  }
  return undefined;
}

function declaredExpressionHasExactFamily(
  expression: ts.Expression,
  expected: "boolean" | "string",
  scope: ReadonlySet<string>,
): boolean {
  const candidate = unwrapProjectionExpression(expression);
  if (
    expected === "boolean" &&
    currentSubjectReturnsBoolean &&
    currentSubjectFunctionName !== null &&
    !scope.has(currentSubjectFunctionName) &&
    expressionIsBooleanWithSelfRecursion(candidate, currentSubjectFunctionName)
  ) {
    return true;
  }
  const classifier = currentSelectionOptions?.classifyDeclaredPrimitiveExpression;
  const classified = classifier?.(expression);
  if (classified !== undefined) return classified === expected;
  const obvious = obviousSelectorValueFamily(expression, scope);
  // With checker evidence available, `undefined` means class/object/array,
  // any, or unknown — none is an exact primitive proof. Bare selector callers
  // keep their historical unknown-expression fallback but reject every syntax
  // family the selector can identify positively.
  return classifier ? obvious === expected : obvious === undefined || obvious === expected;
}

function staticCallArgumentCount(argumentsList: readonly ts.Expression[]): number | null {
  let count = 0;
  for (const argument of argumentsList) {
    if (!ts.isSpreadElement(argument)) {
      count++;
      continue;
    }
    const source = unwrapProjectionExpression(argument.expression);
    if (
      !ts.isArrayLiteralExpression(source) ||
      source.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element))
    ) {
      return null;
    }
    count += source.elements.length;
  }
  return count;
}

function collectDirectNestedFunctionNames(body: ts.Block): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) {
      if (node.name) names.add(node.name.text);
      return;
    }
    if (node !== body && isFunctionLike(node)) return;
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return names;
}

/**
 * The IR delete lowerer returns constant true and has no global binding
 * attributes. Keep direct module-init `delete this.name` on legacy until the IR
 * owns the GlobalEnvironmentRecord model (#2726).
 */
function isUnsupportedModuleGlobalObjectDelete(expr: ts.DeleteExpression): boolean {
  return (
    currentSubjectIsModuleInit &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.expression.kind === ts.SyntaxKind.ThisKeyword
  );
}

function isPhase1Expr(expr: ts.Expression, scope: ReadonlySet<string>, localClasses: ReadonlySet<string>): boolean {
  if (
    (expressionTouchesModuleExtern(expr) || expressionTouchesModuleMapGetAlias(expr)) &&
    !moduleExternConsumerIsProven(expr, scope)
  ) {
    return shapeNo("expr-module-extern-consumer", expr);
  }
  if (ts.isParenthesizedExpression(expr)) return isPhase1Expr(expr.expression, scope, localClasses);
  // (#1373b C-1) `await <e>` inside a C-1 async body mirrors legacy sync-model lowering:
  //   - `await Promise.resolve(x)` → the settled expression `x` (#3227
  //     static substitution) — check THAT shape; the zero-arg form settles
  //     to `undefined`, which from-ast has no value lowering for → reject.
  //   - anything else → the operand itself (identity / one-level unwrap).
  if (ts.isAwaitExpression(expr)) {
    if (!currentFnIsAsync) return shapeNo("expr-await-outside-async", expr);
    const settled = staticPromiseResolveSettledExpr(expr.expression);
    if (settled === "undefined") return shapeNo("expr-await-undefined-settle", expr);
    if (settled !== null) return isPhase1Expr(settled, scope, localClasses);
    // Direct `await f(...)` of a local async fn — the ONE consumer position
    // where an async callee is claimable (both legacy and IR deliver the raw
    // `T`; #1796). Handled inline so the generic call arm can reject every
    // other async-callee use.
    let op: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(op)) op = op.expression;
    if (ts.isCallExpression(op) && ts.isIdentifier(op.expression) && currentAsyncDeclNames.has(op.expression.text)) {
      if (currentModuleBindingResolver && !currentModuleBindingResolver.externCallArgumentsMatch(op)) {
        return shapeNo("expr-await-module-extern-call-brand", op);
      }
      for (const arg of op.arguments) {
        if (ts.isSpreadElement(arg)) return shapeNo("expr-await-async-call-spread", arg);
        if (!isPhase1Expr(arg, scope, localClasses)) return false;
      }
      return true;
    }
    return isPhase1Expr(expr.expression, scope, localClasses);
  }
  if (ts.isNumericLiteral(expr)) return true;
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
  // Slice 10 (#1169i): RegExp literals lower to `extern.regex` (a
  // `RegExp_new(pattern, flags)` host call). Pattern + flags are
  // string-literal globals, already pre-registered by the legacy
  // `collectStringLiterals` pass (see
  // `src/codegen/index.ts:3274-3278`). Selector accepts the shape
  // unconditionally; the lowerer enforces the resolver carries
  // metadata for the "RegExp" extern class.
  if (expr.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
  // Slice 1 (issue #1168): claim string literals and `null` so that
  // `typeof x === "string"` / `x === null` / `x == null` patterns can
  // compose out of Phase-1 primitives. Actual lowering for non-f64/bool
  // result types is still out of this slice's scope — the selector
  // rejects functions whose return/param types aren't f64/bool via
  // `resolveReturnType` / `resolveParamType`, so accepting the shape
  // here is shape-only acceptance.
  if (ts.isStringLiteral(expr)) return true;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(expr)) {
    // Identifier may name either a param/local (scope) or a function
    // (only valid as the callee of a CallExpression, handled below).
    // A bare identifier that isn't in scope is not a valid Phase-1 expr —
    // UNLESS it resolves to an ambient host global (#2856, JS-host lane
    // only; see `hostExternCapability`): the receiver in
    // `document.getElementById(...)`, `console.log(...)`, `document.body`.
    // The checker-backed resolver settles shadowing: a user binding named
    // `document` resolves to the USER declaration, not the lib global, so
    // this arm never hijacks a module-scope/local shadow. `localClasses` is
    // excluded for symmetry with the legacy user-class-shadows-extern rule
    // (#1284).
    // Resolve by declaration identity before consulting the selector's flat
    // scope-name set. This prevents a leaked sibling `for (let i)` name from
    // impersonating a module-level `i` (#3343). A real local/parameter resolves
    // to its own declaration and returns undefined here, then the scope arm wins.
    if (expr.text === "undefined" && currentModuleBindingResolver?.isDirectModuleBinding(expr)) {
      return shapeNo("expr-module-undefined-shadow", expr);
    }
    if (currentModuleBindingResolver?.(expr) !== undefined) return true;
    if (isUnrepresentableModuleBinding(expr)) {
      return shapeNo("expr-module-storage-unrepresentable", expr);
    }
    if (scope.has(expr.text)) return true;
    if (
      currentHostGlobalResolver !== null &&
      !localClasses.has(expr.text) &&
      currentHostGlobalResolver(expr) !== undefined
    ) {
      return true;
    }
    return shapeNo("expr-ident-not-in-scope", expr);
  }
  // #1370 Phase A — `this` reference inside a method or constructor body.
  // The selector marks `this` as an in-scope binding for class members
  // (see `whyNotIrClaimable` with `isMethod=true`); accept the keyword
  // expression here if "this" is in scope. Outside of class members the
  // keyword never enters scope, so this branch is a no-op for the
  // FunctionDeclaration path.
  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    return scope.has("this");
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    if (!isPhase1PrefixOp(expr.operator))
      return shapeNo(`expr-prefix-op-${ts.tokenToString(expr.operator) ?? expr.operator}`, expr);
    if (expr.operator === ts.SyntaxKind.ExclamationToken && !trackedModuleInfluenceIsBoolean(expr.operand)) {
      return shapeNo("expr-module-value-not", expr);
    }
    if (expressionMayBeModuleExtern(expr.operand)) {
      return shapeNo("expr-module-extern-prefix", expr);
    }
    if (expr.operator === ts.SyntaxKind.TildeToken && !expressionIsProvenNumber(expr.operand)) {
      return shapeNo("expr-tilde-nonnumeric", expr.operand);
    }
    return isPhase1Expr(expr.operand, scope, localClasses);
  }
  if (ts.isBinaryExpression(expr)) {
    const binOp = expr.operatorToken.kind;
    if (binOp === ts.SyntaxKind.AmpersandAmpersandToken || binOp === ts.SyntaxKind.BarBarToken) {
      if (
        !declaredExpressionHasExactFamily(expr.left, "boolean", scope) ||
        !declaredExpressionHasExactFamily(expr.right, "boolean", scope)
      ) {
        return capabilityNo("logical-value-unsupported", "expr-logical-value-family", expr);
      }
    }
    const leftTracksModule = expressionTouchesTrackedModuleValue(expr.left);
    const rightTracksModule = expressionTouchesTrackedModuleValue(expr.right);
    if (leftTracksModule || rightTracksModule) {
      const leftFamily = obviousModuleValueFamily(expr.left);
      const rightFamily = obviousModuleValueFamily(expr.right);
      const isEquality =
        binOp === ts.SyntaxKind.EqualsEqualsToken ||
        binOp === ts.SyntaxKind.ExclamationEqualsToken ||
        binOp === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        binOp === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      const nullishEquality =
        isEquality &&
        (leftFamily === "nullish" ||
          rightFamily === "nullish" ||
          leftFamily === undefined ||
          rightFamily === undefined);
      if (leftFamily && rightFamily && leftFamily !== rightFamily && !nullishEquality) {
        return shapeNo("expr-module-value-representation-mismatch", expr);
      }
      const booleanModuleOperand =
        (leftTracksModule && (leftFamily === "boolean" || expressionTouchesBooleanModuleBinding(expr.left))) ||
        (rightTracksModule && (rightFamily === "boolean" || expressionTouchesBooleanModuleBinding(expr.right)));
      if (
        booleanModuleOperand &&
        !isComparisonResultOperator(binOp) &&
        binOp !== ts.SyntaxKind.AmpersandAmpersandToken &&
        binOp !== ts.SyntaxKind.BarBarToken
      ) {
        return shapeNo("expr-module-boolean-nonboolean-op", expr);
      }
    }
    if (
      binOp === ts.SyntaxKind.QuestionQuestionToken &&
      (expressionTouchesTrackedModuleValue(expr.left) || expressionTouchesTrackedModuleValue(expr.right))
    ) {
      return shapeNo("expr-module-value-nullish", expr);
    }
    if (binOp === ts.SyntaxKind.AmpersandAmpersandToken || binOp === ts.SyntaxKind.BarBarToken) {
      for (const operand of [expr.left, expr.right]) {
        if (!trackedModuleInfluenceIsBoolean(operand)) {
          return shapeNo("expr-module-value-logical", expr);
        }
      }
    }
    const hasModuleExternOperand = expressionMayBeModuleExtern(expr.left) || expressionMayBeModuleExtern(expr.right);
    const isEquality =
      binOp === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      binOp === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      binOp === ts.SyntaxKind.EqualsEqualsToken ||
      binOp === ts.SyntaxKind.ExclamationEqualsToken;
    if (hasModuleExternOperand && isEquality) {
      const left = unwrapPhase1Parens(expr.left);
      const right = unwrapPhase1Parens(expr.right);
      const isStrict =
        binOp === ts.SyntaxKind.EqualsEqualsEqualsToken || binOp === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      // The builder has proven runtime identity checks only for an exact
      // module extern against strict null / undefined. Extern-to-extern,
      // host-member, loose, and wrapped-value equality stay legacy-owned.
      const provenStrictNullish =
        isStrict &&
        ((moduleExternBinding(left) !== undefined &&
          (right.kind === ts.SyntaxKind.NullKeyword || isUnshadowedUndefinedIdentifier(right, scope))) ||
          (moduleExternBinding(right) !== undefined &&
            (left.kind === ts.SyntaxKind.NullKeyword || isUnshadowedUndefinedIdentifier(left, scope))));
      if (!provenStrictNullish) {
        return shapeNo("expr-module-extern-equality", expr);
      }
    } else if (hasModuleExternOperand) {
      // Arithmetic, relational, bitwise, logical, nullish, instanceof, and
      // assignment operators all require a representation/coercion the IR
      // does not model for module externs in this slice.
      return shapeNo("expr-module-extern-binary", expr);
    }
    // (#2856 C3) STRICT undefined-compare — `hit !== undefined` /
    // `x === undefined`. The `undefined` identifier isn't in scope, so the
    // generic operand recursion would reject it; accept it specially as one
    // operand of a strict equality. The from-ast arm dispatches on the other
    // operand's IrType (externref-shaped → runtime `__extern_is_undefined`;
    // never-undefined representations → constant fold). LOOSE `==`/`!=` stay
    // rejected: `null == undefined` is true, so a nullable-ref operand would
    // need a runtime null check this slice doesn't emit.
    if (binOp === ts.SyntaxKind.EqualsEqualsEqualsToken || binOp === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      const leftUndef = isUnshadowedUndefinedIdentifier(expr.left, scope);
      const rightUndef = isUnshadowedUndefinedIdentifier(expr.right, scope);
      if (leftUndef && rightUndef) return true;
      if (rightUndef) return isPhase1Expr(expr.left, scope, localClasses);
      if (leftUndef) return isPhase1Expr(expr.right, scope, localClasses);
    }
    // (#3144) `x instanceof C` where C names a LOCAL class (unshadowed).
    // `instanceof` stays table-deferred for the general/dynamic case
    // (`binaryOpCapability`), but this shape has an IR lowering:
    // `class.instanceof`, a static `__tag` compare mirroring legacy
    // `compileInstanceOf`. from-ast's `lowerInstanceOf` mirrors this arm
    // exactly (identifier RHS, unshadowed, projected local class); a
    // class-typed LHS emits the tag check, never-class representations fold
    // to false, dynamic/extern LHS demotes cleanly (claim-partial, like the
    // `new C(...)` arm below).
    if (
      binOp === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(expr.right) &&
      localClasses.has(expr.right.text) &&
      localClassValueIsUnshadowed(expr.right.text, scope)
    ) {
      if (localClassHasKnownProjectionGap(expr.right.text)) {
        return capabilityNo("class-projection-unsupported", "expr-instanceof-class-shape", expr.right);
      }
      return isPhase1Expr(expr.left, scope, localClasses);
    }
    if (!isPhase1BinaryOp(binOp)) return shapeNo(`expr-binary-op-${ts.tokenToString(binOp) ?? binOp}`, expr);
    return isPhase1Expr(expr.left, scope, localClasses) && isPhase1Expr(expr.right, scope, localClasses);
  }
  if (ts.isConditionalExpression(expr)) {
    if (expressionTouchesTrackedModuleValue(expr.whenTrue) || expressionTouchesTrackedModuleValue(expr.whenFalse)) {
      const whenTrueFamily = obviousModuleValueFamily(expr.whenTrue);
      const whenFalseFamily = obviousModuleValueFamily(expr.whenFalse);
      if (!whenTrueFamily || !whenFalseFamily || whenTrueFamily !== whenFalseFamily) {
        return shapeNo("expr-module-value-conditional-mismatch", expr);
      }
    }
    return (
      isPhase1ConditionExpr(expr.condition, scope, localClasses) &&
      isPhase1Expr(expr.whenTrue, scope, localClasses) &&
      isPhase1Expr(expr.whenFalse, scope, localClasses)
    );
  }
  if (ts.isCallExpression(expr)) {
    if (currentModuleBindingResolver && !currentModuleBindingResolver.externCallArgumentsMatch(expr)) {
      return shapeNo("expr-module-extern-call-brand", expr);
    }
    if (isOptionalModuleExternCall(expr)) {
      return shapeNo("expr-module-extern-optional-call", expr);
    }
    // #3000-E: `super(args)` — a derived ctor chaining to its parent. `super` is
    // a keyword, not an identifier/property-access the generic receiver checks
    // below handle, so recognise the shape here. Args must be Phase-1 exprs; the
    // lowerer (from-ast) resolves the parent `_init` and validates arity/types.
    if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
      const parentClass = superParentClassName();
      if (parentClass === null || localClassHasKnownProjectionGap(parentClass)) {
        return capabilityNo("class-projection-unsupported", "super-call-parent-shape", expr);
      }
      const expectedArity = projectedConstructorArity(parentClass);
      if (expectedArity === undefined) {
        return capabilityNo("class-projection-unsupported", "super-call-parent-constructor", expr);
      }
      if (expr.arguments.length !== expectedArity) {
        return capabilityNo("constructor-arity-unsupported", "super-call-arity", expr);
      }
      for (const arg of expr.arguments) {
        if (ts.isSpreadElement(arg)) return shapeNo("super-call-spread", arg);
        if (!isPhase1Expr(arg, scope, localClasses)) return false;
      }
      return true;
    }
    // #3000-E: `super.method(args)` — static-dispatch to the parent's method slot.
    // The receiver is the `super` keyword; recognise it before the generic
    // property-access receiver check (which would reject `super` as a non-Phase-1
    // receiver). Method name must be a plain identifier; args Phase-1 exprs.
    if (
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.expression.kind === ts.SyntaxKind.SuperKeyword
    ) {
      if (!ts.isIdentifier(expr.expression.name)) return shapeNo("super-method-computed", expr);
      const parentClass = superParentClassName();
      if (parentClass === null || localClassHasKnownProjectionGap(parentClass)) {
        return capabilityNo("class-projection-unsupported", "super-method-parent-shape", expr);
      }
      const projection = classMethodProjection(parentClass, expr.expression.name.text, false);
      if (projection.status !== "projected" || projection.arity === undefined) {
        return capabilityNo("class-member-unsupported", "super-method-member", expr);
      }
      if (expr.arguments.length !== projection.arity) {
        return capabilityNo("call-arity-unsupported", "super-method-arity", expr);
      }
      for (const arg of expr.arguments) {
        if (ts.isSpreadElement(arg)) return shapeNo("super-method-spread", arg);
        if (!isPhase1Expr(arg, scope, localClasses)) return false;
      }
      return true;
    }
    // Slice 4 (#1169d): accept method calls — `<recv>.<methodName>(...)`.
    // The receiver must itself be a Phase-1 expression; the lowerer
    // enforces that the receiver is a class instance whose shape carries
    // `methodName`. If not, the function falls back to legacy.
    if (ts.isPropertyAccessExpression(expr.expression)) {
      if (!ts.isIdentifier(expr.expression.name)) return false;
      if (
        isPristineEs5IntrinsicIsFrozenCall(expr, (node) => selectorSeesAmbientBinding(node) && !scope.has(node.text))
      ) {
        return true;
      }
      // #3793 — exact retained function-object wrappers such as Acorn's
      // `parse(...) { return Parser.parse(...) }`. The checker resolver proves
      // the stable `var Parser = function Parser(...) {}` carrier and its one
      // direct top-level `Parser.parse = function parse(...) {}` assignment.
      // This is a live method call, never a bare call to the assigned body:
      // lowering uses the existing closed dispatcher so `new this(...)`,
      // retained closure identity, and later property reads stay unchanged.
      if (
        currentSelectionOptions?.supportsBackendCapability?.("standalone-native-regexp-test-carrier") === true &&
        currentSelectionOptions.supportsBackendCapability?.("legacy-numeric-array-global") === true
      ) {
        const retainedMethod = currentModuleBindingResolver?.retainedFunctionMethodPlan(expr);
        if (retainedMethod !== undefined) {
          for (const arg of expr.arguments) {
            if (ts.isSpreadElement(arg) || !isPhase1Expr(arg, scope, localClasses)) return false;
          }
          return true;
        }
      }
      if (
        (expr.expression.name.text === "test" || expr.expression.name.text === "exec") &&
        currentSelectionOptions?.isRegExpExpression?.(expr.expression.expression) === true &&
        currentSelectionOptions.supportsBackendCapability?.("host-regexp-constructor") === false
      ) {
        // #3791 — host-free `.test` is claimable only for an exact stable
        // top-level static RegExp whose real legacy externref carrier can be
        // loaded and passed to the in-module native helper. This deliberately
        // bypasses the generic receiver walk: the binding is not a general IR
        // module value, and `.exec`, g/y stateful carriers, reassigned
        // bindings, non-string subjects, and all other shapes keep the
        // established target-capability refusal.
        const nativePlan =
          expr.expression.name.text === "test" &&
          currentSelectionOptions?.supportsBackendCapability?.("standalone-native-regexp-test-carrier") === true
            ? currentModuleBindingResolver?.staticRegExpTestPlan(expr.expression.expression)
            : undefined;
        if (
          nativePlan !== undefined &&
          expr.arguments.length === 1 &&
          !ts.isSpreadElement(expr.arguments[0]!) &&
          (expressionIsProvenString(expr.arguments[0]!) ||
            currentSelectionOptions?.classifyPrimitiveExpression?.(expr.arguments[0]!) === "string")
        ) {
          return isPhase1Expr(expr.arguments[0]!, scope, localClasses);
        }
        return capabilityNo("regexp-constructor-unsupported", "expr-regexp-method-target", expr);
      }
      // (#1371) Whitelist `Math.<unary>(arg)` for a small set of f64-mapped
      // ops. The receiver `Math` is a host global, never in scope, so the
      // generic receiver check below would reject these. Recognise the shape
      // here and accept it; the lowerer in from-ast.ts emits a plain unary
      // f64 op for the call.
      const mathPlan = IR_MATH_METHOD_TABLE[expr.expression.name.text];
      if (
        ts.isIdentifier(expr.expression.expression) &&
        expr.expression.expression.text === "Math" &&
        selectorSeesAmbientBinding(expr.expression.expression) &&
        !scope.has(expr.expression.expression.text) &&
        mathPlan !== undefined &&
        selectorSupportsMathPlan(mathPlan) &&
        expr.arguments.length === mathPlan.arity
      ) {
        return expr.arguments.every(
          (arg) => !ts.isSpreadElement(arg) && expressionIsProvenNumber(arg) && isPhase1Expr(arg, scope, localClasses),
        );
      }
      if (
        ts.isIdentifier(expr.expression.expression) &&
        expr.expression.expression.text === "Math" &&
        selectorSeesAmbientBinding(expr.expression.expression)
      ) {
        return shapeNo("expr-math-call-shape", expr);
      }
      // #3787 — exact ambient String.fromCharCode(...). Each argument is
      // lowered independently through the mode-selected unary helper, then
      // concatenated left-to-right. The numeric proof is required because
      // this first IR slice does not implement the builtin's general ToNumber
      // coercion. Zero arguments are valid and produce the empty string.
      if (
        ts.isIdentifier(expr.expression.expression) &&
        expr.expression.expression.text === "String" &&
        expr.expression.name.text === "fromCharCode" &&
        selectorSeesAmbientStringBinding(expr.expression.expression) &&
        !scope.has("String")
      ) {
        return expr.arguments.every(
          (arg) => !ts.isSpreadElement(arg) && expressionIsProvenNumber(arg) && isPhase1Expr(arg, scope, localClasses),
        );
      }
      // ES5 Object.defineProperty — an exact ambient static call is a
      // symbolic host-helper operation, not an instance method on a value
      // named `Object`. Reject shadowed bindings and host-free targets before
      // walking the three ordinary Phase-1 arguments.
      if (
        ts.isIdentifier(expr.expression.expression) &&
        expr.expression.expression.text === "Object" &&
        expr.expression.name.text === "defineProperty" &&
        selectorSeesAmbientBinding(expr.expression.expression) &&
        !scope.has("Object")
      ) {
        if (currentSelectionOptions?.supportsBackendCapability?.("host-object-define-property") === false) {
          return capabilityNo("call-resolution-unsupported", "expr-object-define-property-target", expr);
        }
        if (expr.arguments.length !== 3 || expr.arguments.some(ts.isSpreadElement)) {
          return shapeNo("expr-object-define-property-shape", expr);
        }
        return expr.arguments.every((arg) => isPhase1Expr(arg, scope, localClasses));
      }
      const builtinReceiver = expr.expression.expression;
      const checkerReceiverFamily = currentSelectionOptions?.classifyDeclaredPrimitiveExpression?.(builtinReceiver);
      const scalarReceiverFamily = currentModuleBindingResolver?.scalarExpressionFamily(builtinReceiver);
      const builtinReceiverFamily =
        checkerReceiverFamily ??
        (scalarReceiverFamily === "f64" ? "number" : scalarReceiverFamily === "boolean" ? "boolean" : undefined);
      const provenReceiverFamily = currentSelectionOptions?.classifyPrimitiveExpression?.(builtinReceiver);
      const isNumberReceiver = provenReceiverFamily === "number" || expressionIsProvenNumber(builtinReceiver);
      const isStringReceiver = provenReceiverFamily === "string" || expressionIsProvenString(builtinReceiver);
      if (currentSelectionOptions?.isArrayExpression?.(builtinReceiver) === true) {
        if (expr.expression.name.text !== "push") {
          return capabilityNo("array-method-unsupported", "expr-array-method-not-lowerable", expr);
        }
        if (expr.arguments.length !== 1 || ts.isSpreadElement(expr.arguments[0]!)) {
          return capabilityNo("array-method-unsupported", "expr-array-push-shape", expr);
        }
      }
      if (
        (expr.expression.name.text === "call" || expr.expression.name.text === "apply") &&
        knownCallableArity(builtinReceiver, scope) !== undefined
      ) {
        return capabilityNo("function-invocation-method-unsupported", "expr-function-invocation-method", expr);
      }
      if (isStringReceiver) {
        if (!stringMethodHasSupportedArity(expr.expression.name.text, expr.arguments)) {
          return capabilityNo("string-method-unsupported", "expr-string-method-surface", expr);
        }
        if (expr.expression.name.text === "replace") {
          if (currentSelectionOptions?.supportsLiteralStringReplace !== true) {
            return capabilityNo("string-method-unsupported", "expr-string-replace-backend", expr);
          }
          if (!isLiteralStringReplaceCall(expr)) {
            return capabilityNo("string-method-unsupported", "expr-string-replace-shape", expr);
          }
          if (!isPhase1Expr(builtinReceiver, scope, localClasses)) return false;
          return expr.arguments.every((arg) => isPhase1Expr(arg, scope, localClasses));
        }
      }
      if (expr.expression.name.text === "toFixed" && isNumberReceiver) {
        if (!isBoundedToFixedCall(expr)) {
          return capabilityNo("primitive-method-unsupported", "expr-number-tofixed-shape", expr);
        }
        return (
          isPhase1Expr(builtinReceiver, scope, localClasses) && isPhase1Expr(expr.arguments[0]!, scope, localClasses)
        );
      }
      if (
        expr.expression.name.text === "toString" &&
        expr.arguments.length === 0 &&
        isNumberReceiver &&
        selectorSupportsNumberToString()
      ) {
        if (!isPhase1Expr(builtinReceiver, scope, localClasses)) return false;
        return true;
      }
      if (
        builtinReceiverFamily === "number" ||
        builtinReceiverFamily === "boolean" ||
        builtinReceiverFamily === "primitive-union" ||
        isNumberReceiver
      ) {
        return capabilityNo("primitive-method-unsupported", "expr-primitive-method-surface", expr);
      }
      // (#2856 C3/Capability C) Preserve the exact Map.get/set arity guard,
      // but identify the receiver through its checker-owned declaration.
      const moduleMapMethod = exactModuleMapMethod(expr);
      if (moduleMapMethod !== undefined) {
        const method = moduleMapMethod;
        if (method !== "get" && method !== "set") return shapeNo("expr-modmap-method", expr);
        const wantArgs = method === "get" ? 1 : 2;
        if (expr.arguments.length !== wantArgs) return shapeNo("expr-modmap-arity", expr);
        for (const arg of expr.arguments) {
          if (ts.isSpreadElement(arg)) return shapeNo("expr-modmap-spread", arg);
          if (!isPhase1Expr(arg, scope, localClasses)) return false;
        }
        return true;
      }
      if (expressionTouchesScalarModuleBinding(expr.expression.expression)) {
        if (!isExactF64ScalarToStringCall(expr)) {
          return shapeNo("expr-module-scalar-method", expr);
        }
        return isPhase1Expr(expr.expression.expression, scope, localClasses);
      }
      // (#3144) Static method call `C.m(args)` — the receiver is a bare
      // LOCAL class identifier (never in scope, so the generic receiver
      // check below would reject it). from-ast's static-call arm mirrors
      // this shape exactly and resolves the `"static"` member descriptor
      // (projected by `buildIrClassShapes`); a call to a member that did
      // not project demotes cleanly (claim-partial, like `new C(...)`).
      // Lowering: `class.static_call` → `call $<C>_<m>` with args only
      // (legacy statics take no `self` param).
      if (
        ts.isIdentifier(expr.expression.expression) &&
        localClassValueIsUnshadowed(expr.expression.expression.text, scope) &&
        localClasses.has(expr.expression.expression.text)
      ) {
        const className = expr.expression.expression.text;
        if (localClassHasKnownProjectionGap(className)) {
          return capabilityNo("class-projection-unsupported", "expr-class-static-shape", expr);
        }
        const projection = classMethodProjection(className, expr.expression.name.text, true);
        if (projection.status !== "projected" || projection.arity === undefined) {
          return capabilityNo("class-member-unsupported", "expr-class-static-member", expr);
        }
        if (expr.arguments.length !== projection.arity) {
          return capabilityNo("call-arity-unsupported", "expr-class-static-arity", expr);
        }
        for (const arg of expr.arguments) {
          if (ts.isSpreadElement(arg)) return false;
          if (!isPhase1Expr(arg, scope, localClasses)) return false;
        }
        return true;
      }
      const receiverClass = localClassNameForExpression(expr.expression.expression, scope);
      if (receiverClass !== null) {
        if (localClassHasKnownProjectionGap(receiverClass)) {
          return capabilityNo("class-projection-unsupported", "expr-class-instance-shape", expr);
        }
        const projection = classMethodProjection(receiverClass, expr.expression.name.text, false);
        if (projection.status !== "projected" || projection.arity === undefined) {
          return capabilityNo("class-member-unsupported", "expr-class-instance-member", expr);
        }
        if (expr.arguments.length !== projection.arity) {
          return capabilityNo("call-arity-unsupported", "expr-class-instance-arity", expr);
        }
        if (!isPhase1Expr(expr.expression.expression, scope, localClasses)) return false;
        for (const arg of expr.arguments) {
          if (ts.isSpreadElement(arg)) return false;
          if (!isPhase1Expr(arg, scope, localClasses)) return false;
        }
        return true;
      }
      if (!isPhase1Expr(expr.expression.expression, scope, localClasses)) return false;
      // (#3214 B2) One exact host callback widening. The checker resolver
      // proves this is the ambient EventTarget `addEventListener` surface and
      // that the zero-param block arrow is synchronous, void, nested-decl
      // free, and capture-readonly. Selection still owns ordinary expression
      // coverage: the event type and the callback body must both fit the
      // complete Phase-1 surface, and every certified capture must already be
      // live in this lexical scope. No other arrow argument bypasses the
      // generic `isPhase1Expr` rejection below.
      const hostVoidCallback = currentSelectionOptions?.hostVoidCallbacks?.(expr);
      if (hostVoidCallback) {
        for (const capture of hostVoidCallback.captureNames) {
          if (!scope.has(capture)) return shapeNo("expr-host-void-callback-capture-scope", hostVoidCallback.callback);
        }
        const eventType = expr.arguments[0]!;
        if (ts.isSpreadElement(eventType) || !isPhase1Expr(eventType, scope, localClasses)) {
          return shapeNo("expr-host-void-callback-event", eventType);
        }
        const callbackScope = new Set(scope);
        if (
          !isPhase1StatementList(
            hostVoidCallback.callback.body.statements,
            callbackScope,
            localClasses,
            /* isGenerator */ false,
            /* isVoidReturn */ true,
          )
        ) {
          return shapeNo("expr-host-void-callback-body", hostVoidCallback.callback.body);
        }
        return true;
      }
      for (const arg of expr.arguments) {
        // Slice 8a (#1169g): spread args restricted to method calls is
        // out of scope — methods on classes have known signatures and
        // expanding spread would blur them. Reject for now.
        if (ts.isSpreadElement(arg)) return false;
        if (!isPhase1Expr(arg, scope, localClasses)) return false;
      }
      return true;
    }
    if (!ts.isIdentifier(expr.expression)) return false;
    // (#1373b C-1) Only the await arm above admits local async callees; every
    // other use remains a legacy thenable consumer.
    if (currentAsyncDeclNames.has(expr.expression.text) && !scope.has(expr.expression.text)) {
      return shapeNo("expr-async-callee-not-awaited", expr);
    }
    if (currentSelectionOptions?.ambientClassCalls?.(expr))
      return expr.arguments.every((arg) => isPhase1Expr(arg, scope, localClasses));
    // (#3214 A+B1) A checker-certified imported direct call is a stable
    // in-module funcMap target, not an external call.  Bare top-level function
    // identifiers are accepted ONLY at the exact FunctionTypeNode argument
    // positions certified by the shared helper; ordinary arguments still
    // recurse through the complete Phase-1 shape checker.
    const imported = certifyImportedIrCall(expr, currentSelectionOptions?.importedFunctions);
    if (imported) {
      const functionArgs = new Set<ts.Expression>(imported.functionArguments.map((entry) => entry.argument));
      for (const arg of expr.arguments) {
        if (functionArgs.has(arg)) continue;
        if (!isPhase1Expr(arg, scope, localClasses)) return false;
      }
      return true;
    }
    const calleeName = expr.expression.text;
    const actualArity = staticCallArgumentCount(expr.arguments);
    if (scope.has(calleeName)) {
      const expectedArity = knownCallableArity(expr.expression, scope);
      if (expectedArity === undefined) {
        return capabilityNo("call-resolution-unsupported", "expr-local-call-target", expr.expression);
      }
      if (actualArity !== null && actualArity !== expectedArity) {
        return capabilityNo("call-arity-unsupported", "expr-local-call-arity", expr);
      }
    } else {
      if (currentNestedFunctionNames.has(calleeName) || currentLexicalValueBindingNames.has(calleeName)) {
        // A sibling function declaration or a TDZ lexical value declaration
        // exists but is not live in the selector's in-order scope. Never fall
        // through to a same-text top-level declaration: the lexical binding
        // wins even though the builder cannot lower this forward reference.
        return capabilityNo("call-resolution-unsupported", "expr-nested-call-before-binding", expr.expression);
      }
      const declaration = currentDynScanDecls?.get(calleeName);
      if (declaration && hasFixedIrParameters(declaration.parameters)) {
        if (actualArity !== null && actualArity !== declaration.parameters.length) {
          return capabilityNo("call-arity-unsupported", "expr-direct-call-arity", expr);
        }
      }
    }
    let parameterIndex = 0;
    for (const arg of expr.arguments) {
      // Slice 8a (#1169g): accept `f(...source)` where the spread source
      // is an ArrayLiteralExpression with no nested spread. The lowerer
      // expands this at compile time into individual call arguments
      // (matches the legacy `expandSpreadCallArgs` fast path). Spread
      // sources of dynamic length (e.g. an arbitrary identifier of vec
      // type) are deferred — they'd require runtime arity expansion
      // which the IR doesn't model in slice 8a.
      if (ts.isSpreadElement(arg)) {
        const spreadSource = arg.expression;
        if (!ts.isArrayLiteralExpression(spreadSource) || !isStaticSpreadSource(spreadSource, scope, localClasses)) {
          return false;
        }
        parameterIndex += spreadSource.elements.length;
        continue;
      }
      const currentParameterIndex = parameterIndex++;
      // #3791 follow-up dependency — an exact stable top-level numeric array
      // may cross only a direct-call boundary. The callee's planned vec ABI
      // remains authoritative; the builder rechecks its real global ValType.
      if (
        currentSelectionOptions?.supportsBackendCapability?.("legacy-numeric-array-global") === true &&
        directCallParamUsesNumericVecAbi(expr, currentParameterIndex, scope) &&
        currentModuleBindingResolver?.staticNumericArrayPlan(arg) !== undefined
      ) {
        continue;
      }
      if (!isPhase1Expr(arg, scope, localClasses)) return false;
    }
    return true;
  }
  // Slice 4 (#1169d) + Slice 10 (#1169i): NewExpression. Callee must be
  // an Identifier naming either:
  //   - a class declared in the same compilation unit (slice 4), or
  //   - a host extern class known to the IR (slice 10 — RegExp,
  //     Uint8Array, DataView, Map, …).
  // Args are Phase-1 expressions. The lowerer validates the
  // constructor's signature against the args (slice 4 against the
  // class shape; slice 10 against `getExternClassInfo`'s
  // constructorParams).
  if (ts.isNewExpression(expr)) {
    if (!ts.isIdentifier(expr.expression)) return shapeNo("expr-new-callee-nonident", expr.expression);
    // (#2856 async-delay slice) Intercept the exact checker-certified
    // Promise<number> timer construction before the generic constructor arm
    // rejects its type argument and arrow.  The resolver has already proven
    // the whole nested relationship; selection only rechecks that its two
    // transitive executor captures are live in this function scope.
    const promiseDelay = currentSelectionOptions?.promiseDelays?.resolve(expr);
    if (promiseDelay) {
      for (const capture of promiseDelay.executorCaptureNames) {
        if (!scope.has(capture)) return shapeNo("expr-promise-delay-capture-scope", expr);
      }
      return true;
    }
    const ctorName = expr.expression.text;
    const isLocalClass = localClassValueIsUnshadowed(ctorName, scope) && localClasses.has(ctorName);
    const isAmbientConstructor = !isLocalClass && selectorSeesAmbientBinding(expr.expression);
    // The IR slice lowers RegExp construction through the host `RegExp_new`
    // extern-class ABI. Host-free targets own RegExp in legacy native codegen,
    // including its runtime pattern compiler, so defer the whole function
    // before from-ast can type-check native strings against externref params.
    if (
      ctorName === "RegExp" &&
      isAmbientConstructor &&
      currentSelectionOptions?.supportsBackendCapability?.("host-regexp-constructor") === false
    ) {
      return capabilityNo("regexp-constructor-unsupported", "expr-new-regexp-target", expr);
    }
    if (!isLocalClass && isKnownExternClass(ctorName) && !isAmbientConstructor) {
      return capabilityNo("constructor-resolution-unsupported", "expr-new-extern-identity", expr.expression);
    }
    if (NATIVE_TYPED_ARRAY_CLASSES.has(ctorName) && isAmbientConstructor) {
      return capabilityNo("typed-array-constructor-unsupported", "expr-new-native-typed-array", expr);
    }
    if (LEGACY_ERROR_CONSTRUCTOR_CLASSES.has(ctorName) && isAmbientConstructor) {
      return capabilityNo("error-constructor-unsupported", "expr-new-error-constructor", expr);
    }
    if (isLocalClass) {
      if (localClassHasKnownProjectionGap(ctorName)) {
        return capabilityNo("class-projection-unsupported", "expr-new-local-class-shape", expr);
      }
      const expectedArity = projectedConstructorArity(ctorName);
      const actualArity = expr.arguments ? staticCallArgumentCount(expr.arguments) : 0;
      if (expectedArity === undefined) {
        return capabilityNo("class-projection-unsupported", "expr-new-local-class-constructor", expr);
      }
      if (actualArity !== null && actualArity !== expectedArity) {
        return capabilityNo("constructor-arity-unsupported", "expr-new-local-class-arity", expr);
      }
    }
    if (currentModuleBindingResolver?.isDirectModuleBinding(expr.expression)) {
      return shapeNo("expr-new-module-binding-callee", expr.expression);
    }
    // Date is native-struct-owned in legacy, while this slice deliberately
    // lowers only checker-certified host snapshots through synthetic extern
    // imports. Exact immediate module-init snapshots share that same host ABI
    // so a Calendar cannot mix UTC-native module state with local host getters.
    const hostDateSnapshot =
      ctorName === "Date" && isAmbientConstructor ? currentSelectionOptions?.hostDateSnapshots?.(expr) : undefined;
    if (ctorName === "Date" && !isLocalClass) {
      if (!isAmbientConstructor) {
        return capabilityNo("constructor-resolution-unsupported", "expr-new-date-identity", expr.expression);
      }
      if (currentSelectionOptions?.supportsBackendCapability?.("host-date-snapshot") === false) {
        return capabilityNo("date-constructor-unsupported", "expr-new-date-target", expr);
      }
      if (currentSubjectIsModuleInit && !hostDateSnapshot) {
        return capabilityNo("date-constructor-unsupported", "expr-new-module-native-date", expr);
      }
      if (!hostDateSnapshot) {
        return capabilityNo("date-constructor-unsupported", "expr-new-date-snapshot-shape", expr);
      }
    }
    if (!isLocalClass && !isKnownExternClass(ctorName)) {
      return capabilityNo("constructor-resolution-unsupported", "expr-new-ctor-unknown", expr.expression);
    }
    // Type arguments are erased before lowering, but accepting them in the
    // general constructor surface would silently widen generic local classes
    // and shadowable builtin names. The one certified exception is the direct
    // module initializer `const cache = new Map<K, V>()`: its ambient
    // constructor identity, extern Map storage, arity, and host ABI are all
    // checker-proven by the shared module-binding resolver.
    if (expr.typeArguments && expr.typeArguments.length > 0 && !isExactModuleMapGenericInitializer(expr)) {
      return shapeNo("expr-new-type-args", expr);
    }
    if (currentModuleBindingResolver && !currentModuleBindingResolver.externCallArgumentsMatch(expr)) {
      return shapeNo("expr-new-module-extern-call-brand", expr);
    }
    if (!expr.arguments) return true;
    for (const arg of expr.arguments) {
      if (!isPhase1Expr(arg, scope, localClasses)) return shapeNo("expr-new-arg", arg);
    }
    return true;
  }
  // Slice 1: `typeof <expr>` is claimable when its operand is a Phase-1
  // expression. The resulting value is a string tag ("number" / "boolean" /
  // "string" / …); downstream it only composes with `isPhase1BinaryOp`'s
  // new string-equality form.
  if (ts.isTypeOfExpression(expr)) {
    if (expressionMayBeModuleExtern(expr.expression)) {
      return shapeNo("expr-module-extern-typeof", expr);
    }
    return isPhase1Expr(expr.expression, scope, localClasses);
  }
  // Slice 1 (#1169a): no-substitution template literals are equivalent to a
  // string literal at the AST level (`\`hello\``).
  if (expr.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) return true;
  // Slice 1: template expressions with substitutions, where every
  // substitution is itself a Phase-1 expression and is positively proven to
  // produce the string representation consumed by from-ast. Object/class
  // coercion stays legacy-owned instead of relying on a builder throw.
  if (ts.isTemplateExpression(expr)) {
    for (const span of expr.templateSpans) {
      if (!declaredExpressionHasExactFamily(span.expression, "string", scope)) {
        return capabilityNo("template-substitution-unsupported", "expr-template-substitution-family", span.expression);
      }
      if (expressionIsModuleExternAccessChain(span.expression)) {
        return shapeNo("expr-module-extern-template", span.expression);
      }
      if (
        expressionTouchesScalarModuleBinding(span.expression) &&
        obviousModuleValueFamily(span.expression) !== "string"
      ) {
        return shapeNo("expr-module-scalar-template", span.expression);
      }
      if (!isPhase1Expr(span.expression, scope, localClasses)) return false;
    }
    return true;
  }
  // Slice 2 (#1169b) — plain "data" object literals. The acceptance
  // helper rejects spread, methods, getters/setters, computed keys,
  // and duplicate keys. Initializers must themselves be Phase-1
  // claimable, so nested objects compose recursively.
  if (ts.isObjectLiteralExpression(expr)) {
    return isPhase1ObjectLiteral(expr, scope, localClasses);
  }
  // Slices 1+2 — property access. Slice 1 accepts `<string>.length`
  // syntactically; slice 2 broadens to any Identifier-named property,
  // with the lowerer enforcing receiver IrType (string→.length only,
  // object→named field). The selector accepts the shape only —
  // type checks happen at lowering time.
  //
  // Slice 4 (#1169d): same shape covers `<recv>.<fieldName>` on a
  // class instance (recv is Phase-1; lowerer dispatches by the recv's
  // resolved IrType).
  if (ts.isPropertyAccessExpression(expr)) {
    // #3000 — accept private-field reads (`this.#x`). A PrivateIdentifier is a
    // valid class-instance field access; from-ast lowers it to `class.get` on
    // the mangled `__priv_x` slot. Non-class receivers with a private name are
    // a TS error and never reach here.
    if (!ts.isIdentifier(expr.name) && !ts.isPrivateIdentifier(expr.name)) return false;
    // Slice 11 (#1169n) — optional chaining (`obj?.prop`). The lowerer
    // doesn't yet emit the null-guard branch, so accept the shape
    // structurally but the lowerer will throw clean fallback when it
    // encounters one. Listed explicitly so a follow-up slice can
    // implement the lowering without touching the selector.
    if (expr.questionDotToken && expressionIsModuleExternAccessChain(expr.expression)) {
      return shapeNo("expr-module-extern-optional-property", expr);
    }
    if (ts.isIdentifier(expr.name)) {
      const receiverClass = localClassNameForExpression(expr.expression, scope);
      if (receiverClass !== null) {
        if (localClassHasKnownProjectionGap(receiverClass)) {
          return capabilityNo("class-projection-unsupported", "expr-class-property-shape", expr);
        }
        if (classPropertyHasKnownProjectionGap(receiverClass, expr.name.text)) {
          return capabilityNo("class-member-unsupported", "expr-class-property-member", expr);
        }
      }
    }
    return isPhase1Expr(expr.expression, scope, localClasses);
  }
  // Slice 2 — element access with a literal string key (sugar for
  // property access on a known shape).
  //
  // Slice 12 (#1169o) — broaden to accept any Phase-1 argument
  // expression. The lowerer dispatches by receiver type:
  //   - String-literal arg + object receiver → existing object-shape
  //     property path (unchanged).
  //   - Any other arg + vec receiver         → `vec.get` with
  //     i32-coerced index.
  //   - Other combinations                    → throw clean fallback so
  //     the function reverts to legacy.
  if (ts.isElementAccessExpression(expr)) {
    if (expressionIsModuleExternAccessChain(expr.expression)) {
      return shapeNo("expr-module-extern-element", expr);
    }
    return (
      isPhase1Expr(expr.expression, scope, localClasses) && isPhase1Expr(expr.argumentExpression, scope, localClasses)
    );
  }
  // #1804 — fixed-length, non-spread, non-sparse array literals are now
  // selector-accepted (lowered via `vec.new_fixed`). This keeps `f([1,2,3])`'s
  // callee in the IR claim set instead of dropping it via the call-graph
  // closure. Shape-only here; element-type uniformity is enforced at lowering
  // (mixed-type / non-scalar literals clean-fall-back there). Spread/sparse
  // stay out of scope (legacy fallback).
  if (ts.isArrayLiteralExpression(expr)) {
    // (#2856 C4) The #1804 guard (withhold the claim whenever the function
    // contains a C-style loop) is RETIRED. The unsound shape it protected —
    // a constructed vec read inside a `while`/`for` body whose SSA value
    // wasn't threaded into the loop buffers — was fixed by the slice-12
    // buffer machinery: uses inside loop cond/body buffers are recorded
    // against the synthetic -1 block id, so any outer-defined value
    // (including a `vec.new_fixed` result) is cross-block-materialized into
    // a Wasm local before the loop op runs (see lower.ts use counting).
    // Verified empirically: read-in-loop-body, read-in-cond, construct-in-
    // body, nested-loop, and after-loop shapes all lower correctly and agree
    // with legacy (tests/ir-algorithms-cluster.test.ts).
    if (
      expr.elements.some((element) => !ts.isOmittedExpression(element) && expressionTouchesTrackedModuleValue(element))
    ) {
      let family: ObviousModuleValueFamily | undefined;
      for (const element of expr.elements) {
        if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
          return shapeNo("expr-arraylit-module-value-unproven", expr);
        }
        const elementFamily = obviousModuleValueFamily(element);
        if (!elementFamily || (family !== undefined && family !== elementFamily)) {
          return shapeNo("expr-arraylit-module-value-unproven", expr);
        }
        family = elementFamily;
      }
    }
    const primitiveFamilies = new Set<IrPrimitiveExpressionFamily>();
    let everyElementPrimitive = expr.elements.length > 0;
    for (const el of expr.elements) {
      if (ts.isSpreadElement(el)) return shapeNo("expr-arraylit-spread", el); // out of scope
      if (ts.isOmittedExpression(el)) return shapeNo("expr-arraylit-sparse", expr); // sparse — out of scope
      if (!isPhase1Expr(el, scope, localClasses) || localClassNameForExpression(el, scope) !== null) return false;
      const family =
        currentSelectionOptions?.classifyPrimitiveExpression?.(el) ??
        (ts.isStringLiteral(el) || el.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
          ? "string"
          : ts.isNumericLiteral(el)
            ? "number"
            : el.kind === ts.SyntaxKind.TrueKeyword || el.kind === ts.SyntaxKind.FalseKeyword
              ? "boolean"
              : undefined);
      if (family) primitiveFamilies.add(family);
      else everyElementPrimitive = false;
    }
    if (everyElementPrimitive && primitiveFamilies.size > 1) {
      return shapeNo("expr-arraylit-mixed-primitive-family", expr);
    }
    if (
      everyElementPrimitive &&
      primitiveFamilies.has("string") &&
      currentSelectionOptions?.supportsHostStringArrayLiterals !== true
    ) {
      return shapeNo("expr-arraylit-string-backend", expr);
    }
    return true;
  }
  // Slice 11 (#1169n) — `delete <expr>` and `void <expr>`. Both are
  // accepted at the selector level when their operand is a Phase-1
  // expression. Lowering emits:
  //   - `delete obj.prop`     → const `true` (most deletes succeed
  //                              syntactically; runtime rejection is
  //                              rare at the IR-claim shape).
  //   - `void <expr>`         → lower expr for side effects, push
  //                              `f64 NaN` (the undefined sentinel
  //                              the IR uses in f64-typed contexts).
  if (ts.isDeleteExpression(expr))
    return isUnsupportedModuleGlobalObjectDelete(expr)
      ? shapeNo("expr-delete-module-global-object", expr)
      : isPhase1Expr(expr.expression, scope, localClasses);
  if (ts.isVoidExpression(expr)) {
    return isPhase1Expr(expr.expression, scope, localClasses);
  }
  // (#2856) Unhandled expression KIND — closures (Arrow/FunctionExpression),
  // await, spread outside the accepted sites, etc. The node kind discriminates.
  return shapeNo("expr-unhandled", expr);
}

/**
 * Slice 8a (#1169g) — does this expression have a statically-known length
 * suitable for compile-time spread expansion in a call? Restricted to
 * `ArrayLiteralExpression` with no nested SpreadElement: the lowerer
 * inlines each element verbatim, so the call's arity is the literal's
 * `elements.length`. Other shapes (vec-typed identifiers, function
 * results) need runtime length introspection and are deferred.
 *
 * Each element of the literal must itself be a Phase-1 expression so the
 * lowerer can lower it in argument position.
 */
function isStaticSpreadSource(
  expr: ts.Expression,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
): boolean {
  if (!ts.isArrayLiteralExpression(expr)) return false;
  for (const elem of expr.elements) {
    if (ts.isSpreadElement(elem)) return false; // nested spread defer
    if (ts.isOmittedExpression(elem)) return false; // sparse defer
    if (!isPhase1Expr(elem, scope, localClasses)) return false;
  }
  return true;
}

/**
 * Slice-2 acceptance check for object literals. Accepts only "plain data"
 * literals: PropertyAssignment / ShorthandPropertyAssignment with
 * Identifier / StringLiteral / NumericLiteral keys and Phase-1-claimable
 * initializers. Rejects spread, methods, accessors, computed keys, and
 * duplicate keys (last-write-wins is JS spec; deferred to a later slice).
 */
function isPhase1ObjectLiteral(
  expr: ts.ObjectLiteralExpression,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
): boolean {
  // Empty literals get rejected by the codegen side (zero-property
  // objects don't form a usable IrType.object shape) — but accepting
  // them at the selector level wouldn't cause a regression: the
  // overrides pass would skip them when shape resolution failed.
  if (expr.properties.length === 0) return shapeNo("objectlit-empty", expr);

  const seen = new Set<string>();
  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = phase1PropertyName(prop.name);
      if (name === null) return shapeNo("objectlit-computed-key", prop.name);
      if (seen.has(name)) return shapeNo("objectlit-duplicate-key", prop.name); // duplicate key — defer
      seen.add(name);
      if (!isPhase1Expr(prop.initializer, scope, localClasses))
        return shapeNo("objectlit-property-init", prop.initializer);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name.text;
      if (seen.has(name)) return shapeNo("objectlit-duplicate-key", prop.name);
      if (!scope.has(name)) return shapeNo("objectlit-shorthand-not-in-scope", prop.name);
      seen.add(name);
      continue;
    }
    // SpreadAssignment, MethodDeclaration, GetAccessorDeclaration,
    // SetAccessorDeclaration → reject.
    if (ts.isSpreadAssignment(prop)) return shapeNo("objectlit-spread", prop);
    return shapeNo("objectlit-property-kind", prop);
  }
  return true;
}

/**
 * Resolve an object literal property name to a string. Identifier and
 * StringLiteral keys produce their text. NumericLiteral keys produce the
 * canonical JS toString of the number. ComputedPropertyName always
 * returns null — slice 2 doesn't see through computed keys, even when
 * the key expression is itself a string literal.
 */
function phase1PropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text; // matches JS — `{ 0: x }` → "0"
  return null;
}

/**
 * #1370 Phase A: extract a class-member's name as a string suitable for the
 * `${className}_${methodName}` synthetic key the legacy `class-bodies.ts`
 * registers in `ctx.funcMap`. Mirrors `phase1PropertyName`'s acceptance set
 * — identifier / string-literal / numeric-literal — but is its own function
 * so a future slice that broadens object-literal property acceptance
 * (e.g. computed-key constants) doesn't accidentally widen the class
 * member naming surface, where collision with non-Phase-1 members would
 * cause Phase B to patch the wrong slot.
 *
 * Returns null for computed names (`[expr]() {}`) and private identifiers
 * (`#priv() {}`) — Phase A can't form a stable funcMap key for either.
 */
export function phase1MemberName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  // ComputedPropertyName, PrivateIdentifier — Phase A skips both.
  return null;
}

/**
 * (#2857 static-method slice) True if a `super` keyword appears anywhere in the
 * subtree. A whole-subtree scan is deliberately conservative: a `super`
 * reference inside a nested function still binds to the enclosing method's home
 * object, so descending into nested boundaries never misses one. Used to keep a
 * `super`-using static method on the legacy path (its inheritance substrate is
 * the Phase E slice's job), while a plain static method is claimable even under
 * `extends`.
 */
export function referencesSuper(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (n.kind === ts.SyntaxKind.SuperKeyword) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * #3000-E: the name of a class's `extends` parent when it is a bare identifier
 * (`class Dog extends Animal`). Returns null for no-extends, an `implements`-only
 * heritage, or a non-identifier parent expression (e.g. `extends foo.Bar` /
 * `extends mixin(Base)` — deferred). The caller cross-checks the name against
 * `localClasses` to confirm the parent is an IR-projectable user class.
 */
export function extendsParentName(stmt: ts.ClassDeclaration): string | null {
  for (const h of stmt.heritageClauses ?? []) {
    if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    const first = h.types[0]?.expression;
    if (first && ts.isIdentifier(first)) return first.text;
  }
  return null;
}

// #2135 — the operator predicates consume the shared capability table
// (`src/ir/capability.ts`), the SAME source `from-ast.ts`'s lowering dispatch
// asserts against. "claim-partial" is selector-accepted (the builder owns the
// documented residual fallback); "defer" is selector-rejected up-front. The
// former slice-11 "shape-only acceptance" block (`%` / `**` / `in` /
// `instanceof` accepted here while the lowerer threw) is retired: those ops
// are table-deferred, so the claim can no longer disagree with the builder.
function isPhase1PrefixOp(op: ts.PrefixUnaryOperator): boolean {
  return prefixOpCapability(op) !== "defer";
}

function isPhase1BinaryOp(op: ts.SyntaxKind): boolean {
  return binaryOpCapability(op) !== "defer";
}

// ---------------------------------------------------------------------------
// Call graph (local edges only)
// ---------------------------------------------------------------------------

/**
 * (#3142 Slice 1) Assess the module-level statement list as a synthetic IR
 * claim unit. See `IrModuleInitAssessment` for the population definition.
 *
 * Two gates, mirroring the per-function claim exactly:
 *   1. **Shape** — every population statement must pass
 *      `isPhase1BodyStatement` (the constructor-body precedent: the unit is
 *      void, has no tail requirement, and the early-return barrier is armed
 *      because a top-level `return` is never claimable). Scope starts empty;
 *      top-level `var`/`let`/`const` names enter it in document order via
 *      `isPhase1VarDecl`, so in-order reads of module bindings pass and
 *      use-before-declaration conservatively rejects.
 *   2. **Call graph** — run the SAME `buildLocalCallGraph` scan over
 *      `declByName ∪ {<module-init>}`: an external callee rejects with
 *      `external-call`; a local callee outside the FINAL claimed set rejects
 *      with `call-graph-closure` (the unit is lowerable only when every
 *      callee's signature lives on the IR side of the fence — identical to
 *      the Step-2 closure for ordinary functions).
 *
 * Runs on PRODUCTION selections too since Slice 2 — the assessment is
 * claim-feeding: `compileIrPathFunctions` lowers a claimable unit and
 * patches the `__module_init` slot. It runs AFTER every per-function body
 * walk, so resetting the module-level walk state here mirrors
 * `whyNotIrClaimable`'s per-subject reset without clobbering anything.
 *
 * (The helpers below are exported for Slice 2's integration.)
 */
export function assessModuleInit(
  sourceFile: ts.SourceFile,
  claimedFuncs: ReadonlySet<string>,
  declByName: ReadonlyMap<string, ts.FunctionDeclaration>,
  localClasses: ReadonlySet<string>,
): IrModuleInitAssessment {
  const population = collectModuleInitPopulation(sourceFile);
  if (population.length === 0) return { stmtCount: 0, reason: null };

  // Gate 1 — shape.
  if (SHAPE_DIAG_ON) shapeRejectDetail = null;
  typedShapeRejectReason = null;
  currentClaimClassName = null;
  currentClassBindings = new Map<string, string>();
  currentCallableArities = new Map<string, number>();
  currentCallableReturnClasses = new Map<string, string>();
  currentNestedFunctionNames = new Set<string>();
  currentLexicalValueBindingNames = new Set<string>();
  earlyReturnLoopDepth = 0;
  earlyReturnBarrierDepth = 1;
  forInitLeakedNames = new Set();
  currentFnIsGenerator = false;
  currentFnIsVoidReturn = true;
  currentFnIsAsync = false; // (#1373b C-1) module-init is never an async body
  currentSubjectIsModuleInit = true;
  currentDynMemberEqualitySubject = null;
  currentIrSafeVarDeclarationLists = new Set();
  currentModuleMapGetAliases = new Set<ts.VariableDeclaration>();
  currentModuleScalarAliasFamilies = new Map<ts.VariableDeclaration, "f64" | "boolean">();
  const scope = new Set<string>();
  for (const stmt of population) {
    if (!isPhase1BodyStatement(stmt, scope, localClasses)) {
      const reason = typedShapeRejectReason ?? "body-shape-rejected";
      const detail =
        reason === "body-shape-rejected" && SHAPE_DIAG_ON
          ? (takeShapeRejectDetail() ?? "unattributed-arm:helper-internal")
          : undefined;
      return { stmtCount: population.length, reason, detail };
    }
  }

  // Gate 2 — call graph. The synthetic wrapper reuses `buildLocalCallGraph`
  // verbatim (zero parity drift with the Step-2 scan); factory nodes are
  // only ever walked downward via `forEachChild`, so the missing
  // parent/position info on the wrapper is inert.
  const syntheticName = MODULE_INIT_UNIT_NAME;
  const synthetic = makeModuleInitSynthetic(population);
  const decls = new Map(declByName);
  decls.set(syntheticName, synthetic);
  const graph = buildLocalCallGraph(decls, localClasses);
  if (graph.hasExternalCall.has(syntheticName)) {
    return { stmtCount: population.length, reason: "external-call" };
  }
  for (const callee of graph.callees.get(syntheticName) ?? []) {
    if (!claimedFuncs.has(callee)) {
      return { stmtCount: population.length, reason: "call-graph-closure" };
    }
  }
  return { stmtCount: population.length, reason: null };
}

export function buildLocalCallGraph(
  decls: ReadonlyMap<string, ts.FunctionDeclaration>,
  localClasses: ReadonlySet<string>,
): {
  callers: Map<string, Set<string>>;
  callees: Map<string, Set<string>>;
  hasExternalCall: Set<string>;
} {
  const callers = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();
  const hasExternalCall = new Set<string>();
  for (const name of decls.keys()) {
    callers.set(name, new Set());
    callees.set(name, new Set());
  }
  for (const [callerName, fn] of decls) {
    if (!fn.body) continue;
    // Slice 3 (#1169c): collect names introduced INSIDE this outer's
    // body that belong to nested function decls or closure bindings.
    // Calls to these names are intra-function (handled by the IR's
    // closure dispatch, not the legacy call-graph), so they must NOT
    // mark the outer as having an external call.
    const localBindings = collectLocalClosureBindings(fn);

    const visit = (node: ts.Node): void => {
      if (node !== fn && isFunctionLike(node)) return;
      // Slice 4 (#1169d): `new <className>(...)` is NOT a function-style
      // call; it dispatches to a legacy-compiled constructor with a
      // stable signature. Walk into the args (which may contain real
      // calls), but don't mark the outer as having an external call.
      if (ts.isNewExpression(node)) {
        // The exact Promise-delay resolver owns every call nested below this
        // construction (Promise executor, timer callback, and resolve call).
        // Treat it as one certified leaf instead of reporting setTimeout /
        // resolve as external identifier calls.  Uncertified `new Promise`
        // shapes retain the ordinary graph behavior below.
        if (currentSelectionOptions?.promiseDelays?.resolve(node)) return;
        if (
          ts.isIdentifier(node.expression) &&
          (localClasses.has(node.expression.text) ||
            (isKnownExternClass(node.expression.text) &&
              (currentModuleBindingResolver === null ||
                currentModuleBindingResolver.isAmbientBinding(node.expression))))
        ) {
          // Slice 4: local class — `<Class>_new` has a stable signature.
          // Slice 10 (#1169i): known extern class — `<Class>_new` is
          // registered as a host import by the legacy
          // `collectUsedExternImports` pass with a stable signature too.
          // Either case → not external; walk into args for nested calls.
          if (node.arguments) {
            for (const a of node.arguments) visit(a);
          }
          return;
        }
        // Unknown constructor → external. Fall through to default
        // ts.forEachChild walking + the CallExpression branch below
        // doesn't reach here, so we mark it explicitly.
        hasExternalCall.add(callerName);
        if (node.arguments) {
          for (const a of node.arguments) visit(a);
        }
        return;
      }
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          const imported = certifyImportedIrCall(node, currentSelectionOptions?.importedFunctions);
          if (imported) {
            // Imported direct calls are neither local graph edges nor external
            // calls. Walk arguments so nested calls retain their own graph
            // classification; the imported callee identifier itself is inert.
            for (const argument of node.arguments) visit(argument);
            return;
          }
          const callee = node.expression.text;
          if (decls.has(callee)) {
            callees.get(callerName)!.add(callee);
            callers.get(callee)!.add(callerName);
          } else if (localBindings.has(callee)) {
            // Slice 3: closure / nested-fn binding within this outer.
            // Intra-function call, dispatched by the IR lowerer.
          } else if (
            currentDynamicRuntimeBuildable &&
            callerName === "stringToNumber" &&
            parseNumberCallUsesDynamicCarrier(callerName, node) &&
            ((callee === "parseFloat" && node.arguments.length === 1) ||
              (callee === "parseInt" && node.arguments.length === 2))
          ) {
            // Exact built-in providers with a stable externref-first ABI.
            // They are registered by the legacy import scan before IR
            // planning and are neither a source call-graph edge nor an
            // arbitrary ambient function. Still visit arguments so nested
            // local/external calls retain their ordinary classification.
            for (const argument of node.arguments) visit(argument);
            return;
          } else {
            // Call to a non-local identifier (e.g. parseInt, String, Number).
            // from-ast.ts throws for unknown callees so we must exclude this
            // function from the IR path.
            hasExternalCall.add(callerName);
          }
        } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
          // Slice 4 (#1169d): `<recv>.<methodName>(...)`. The lowerer
          // will validate that the receiver is a known class instance
          // and dispatch to a legacy-compiled method. We don't mark
          // this as external — the legacy method's signature is stable
          // because class methods aren't IR-claimed in slice 4.
          //
          // Walk into the receiver and args to catch real external calls
          // nested inside.
          //
          // (#1371) Special case: `Math.<whitelisted>(arg)` lowers to a
          // pure Wasm op (no host import), so we DO NOT walk into the
          // receiver — `Math` is a host global that the receiver-walk
          // would otherwise mark as external. We still walk args to
          // catch nested external calls.
          const mathPlan = IR_MATH_METHOD_TABLE[node.expression.name.text];
          if (
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "Math" &&
            selectorSeesAmbientBinding(node.expression.expression) &&
            mathPlan !== undefined &&
            selectorSupportsMathPlan(mathPlan) &&
            node.arguments.length === mathPlan.arity
          ) {
            for (const a of node.arguments) visit(a);
            return;
          }
          if (
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "Object" &&
            node.expression.name.text === "defineProperty" &&
            selectorSeesAmbientBinding(node.expression.expression) &&
            currentSelectionOptions?.supportsBackendCapability?.("host-object-define-property") !== false &&
            node.arguments.length === 3
          ) {
            for (const a of node.arguments) visit(a);
            return;
          }
          if (
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "String" &&
            node.expression.name.text === "fromCharCode" &&
            selectorSeesAmbientStringBinding(node.expression.expression) &&
            node.arguments.every((argument) => !ts.isSpreadElement(argument))
          ) {
            for (const a of node.arguments) visit(a);
            return;
          }
          visit(node.expression.expression);
          for (const a of node.arguments) visit(a);
          return;
        } else {
          // Member-expression or computed call: Array.from(...), Math.trunc(...),
          // arr[Symbol.iterator](), obj.method(), etc.  The IR path cannot lower
          // these — exclude the enclosing function from the IR claim set.
          hasExternalCall.add(callerName);
        }
      }
      forEachChild(node, visit);
    };
    forEachChild(fn.body, visit);
  }
  return { callers, callees, hasExternalCall };
}

function parseNumberCallUsesDynamicCarrier(callerName: string, call: ts.CallExpression): boolean {
  const declaration = currentDynScanDecls?.get(callerName);
  if (!declaration || call.arguments.length === 0) return false;
  const firstArgument = unwrapPhase1Parens(call.arguments[0]!);
  const carrier = ts.isIdentifier(firstArgument)
    ? firstArgument
    : ts.isCallExpression(firstArgument) &&
        ts.isPropertyAccessExpression(firstArgument.expression) &&
        ts.isIdentifier(firstArgument.expression.expression)
      ? firstArgument.expression.expression
      : undefined;
  if (!carrier) return false;
  const parameter = declaration.parameters.find(
    (candidate): candidate is ts.ParameterDeclaration & { name: ts.Identifier } =>
      ts.isIdentifier(candidate.name) && candidate.name.text === carrier.text,
  );
  if (!parameter) return false;
  const explicit = effectiveIrParamTypeNode(parameter);
  if (explicit) return explicit.kind === ts.SyntaxKind.AnyKeyword;
  const projected = currentSelectionOptions?.resolveImplicitParamType?.(parameter);
  if (projected !== undefined) return projected === "dynamic";
  if (implicitParameterHasOnlyStringCallArguments(declaration, parameter)) return false;
  return currentSelectionOptions?.classifyDeclaredPrimitiveExpression?.(parameter.name) === undefined;
}

function implicitParameterHasOnlyStringCallArguments(
  declaration: ts.FunctionDeclaration,
  parameter: ts.ParameterDeclaration,
): boolean {
  if (!declaration.name || !currentDynScanSourceFile) return false;
  const parameterIndex = declaration.parameters.indexOf(parameter);
  if (parameterIndex < 0) return false;
  let sawCall = false;
  let allString = true;
  const visit = (node: ts.Node): void => {
    if (!allString) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === declaration.name!.text
    ) {
      const argument = node.arguments[parameterIndex];
      if (!argument || ts.isSpreadElement(argument)) {
        allString = false;
        return;
      }
      sawCall = true;
      const classified = currentSelectionOptions?.classifyPrimitiveExpression?.(argument);
      if (classified !== "string" && !ts.isStringLiteralLike(unwrapPhase1Parens(argument))) {
        allString = false;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(currentDynScanSourceFile);
  return sawCall && allString;
}

/**
 * Slice 4 (#1169d): scan the source file for class declarations. The
 * resulting map's keys drive:
 *   - param/return type acceptance (a TypeReferenceNode that resolves
 *     statically to one of these names is a valid IR position type),
 *   - `new <className>(...)` shape acceptance,
 *   - call-graph closure exemption for `new <className>(...)` and
 *     `instance.method(...)` calls.
 *
 * Only top-level `ts.ClassDeclaration` nodes are collected. Class
 * expressions assigned to `const` or class declarations nested inside
 * another function body are out of slice 4 scope (the legacy
 * `collectClassDeclaration` pass handles them, but the IR selector
 * doesn't accept their use). Anonymous classes (no `name`) are skipped. The
 * declaration values preserve the identity needed by #3529 projection checks.
 */
function collectLocalClassDeclarations(sourceFile: ts.SourceFile): Map<string, ts.ClassDeclaration> {
  const declarations = new Map<string, ts.ClassDeclaration>();
  for (const stmt of sourceFile.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name) declarations.set(stmt.name.text, stmt);
  }
  return declarations;
}

/**
 * Slice 3 (#1169c): collect every identifier name introduced inside the
 * outer function's top-level body as a nested function decl or as a
 * `const`-bound arrow / function-expression. Calls to these names are
 * intra-function (handled by the IR's closure dispatch) and must not be
 * flagged as external by the call-graph builder.
 *
 * Walks only the OUTER body — nested closures' own bindings are
 * captured at lift time, not visible here.
 */
function collectLocalClosureBindings(fn: ts.FunctionDeclaration): Set<string> {
  const names = new Set<string>();
  if (!fn.body) return names;
  // #2859 / #3214 B0 — function-typed params (`fn: () => number`). A call
  // through such a param dispatches via the IR callable/root machinery — it is
  // NOT an external call. Only
  // expressible signatures count; an inexpressible function type keeps the
  // function on `param-type-not-resolvable` anyway, so its call sites never
  // reach the IR.
  for (const p of fn.parameters) {
    if (
      ts.isIdentifier(p.name) &&
      p.type &&
      ts.isFunctionTypeNode(p.type) &&
      irClosureSignatureFromFunctionTypeNode(p.type)
    ) {
      names.add(p.name.text);
    }
  }
  // Top-level walk: only direct children of the outer body. Nested
  // bindings inside an `if` arm or another function-like don't escape
  // their lexical scope, so they don't shadow the call-graph path.
  // For simplicity we include any nested function decl and any const
  // arrow init found at any nesting level within the outer body — the
  // worst case is a false negative on the external-call check, which
  // would just mean the outer falls back to legacy.
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node !== fn && node.name) {
      names.add(node.name.text);
      return;
    }
    if (node !== fn && isFunctionLike(node)) return;
    if (ts.isVariableStatement(node)) {
      const isConst = !!(node.declarationList.flags & ts.NodeFlags.Const);
      if (isConst) {
        for (const d of node.declarationList.declarations) {
          if (
            ts.isIdentifier(d.name) &&
            d.initializer &&
            (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
          ) {
            names.add(d.name.text);
          }
        }
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(fn.body, visit);
  return names;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}
