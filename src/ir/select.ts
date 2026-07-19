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
// (#1373b C-1) Pure-syntactic async helpers from the LEAF module (safe for
// ir/* — async-static.ts imports only ts-api, so no codegen/index cycle).
import { staticPromiseResolveSettledExpr, unwrapPromiseTypeNode } from "../codegen/async-static.js";
import type { IrClosureSignature, IrType } from "./nodes.js";

import { binaryOpCapability, hostExternCapability, prefixOpCapability } from "./capability.js";
import type { LatticeType, TypeMap } from "./propagate.js";

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
  | "external-call" // calls a non-local identifier (parseInt, etc.)
  | "call-graph-closure" // local caller/callee not claimed
  | "type-resolution-failure" // overrideMap couldn't be built (set externally)
  // #1370 Phase A — class method / constructor of a shape the IR selector
  // doesn't yet handle. Examples: methods on a class with an `extends`
  // clause (Phase E — inheritance), get/set accessors, abstract methods,
  // computed property names. Distinguished from `body-shape-rejected` so a
  // future slice can tell "method-specific gate failure" apart from generic
  // body-shape rejections that apply to top-level FunctionDeclarations too.
  | "class-method"
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

/** Record the proximate reject arm (first-wins) and return false. */
function shapeNo(arm: string, node: ts.Node): false {
  if (SHAPE_DIAG_ON && shapeRejectDetail === null) {
    shapeRejectDetail = `${arm}:${ts.SyntaxKind[node.kind]}`;
  }
  return false;
}

/** Read and clear the recorded reject detail (used by `planIrCompilation`). */
function takeShapeRejectDetail(): string | undefined {
  const d = shapeRejectDetail ?? undefined;
  shapeRejectDetail = null;
  return d;
}

/**
 * (#1371) Whitelist of `Math.<name>(arg)` unary calls the IR can lower to a
 * plain Wasm `f64.<op>` instruction without any host import. Each entry maps
 * 1:1 to an op in the `IrUnop` extended set (`src/ir/nodes.ts`). Restricting
 * the whitelist to ops with direct Wasm equivalents preserves bit-exact JS
 * semantics:
 *  - `Math.round` is intentionally excluded — JS rounds 0.5 → 1 (away from
 *    zero) but `f64.nearest` rounds to even, so a 1:1 lowering is unsound.
 *  - `Math.min` / `Math.max` are binary and live in `IR_MATH_BINARY_WHITELIST`
 *    (deferred — needs an `IrBinop` extension).
 */
export const IR_MATH_UNARY_WHITELIST: ReadonlySet<string> = new Set(["abs", "sqrt", "floor", "ceil", "trunc"]);

/**
 * Map a whitelisted `Math.<name>` to its corresponding IR `f64.<op>` tag.
 * Lives next to the whitelist so callers (selector + lowerer) share one
 * source of truth.
 */
export function mathUnaryToIrOp(name: string): "f64.abs" | "f64.sqrt" | "f64.floor" | "f64.ceil" | "f64.trunc" | null {
  switch (name) {
    case "abs":
      return "f64.abs";
    case "sqrt":
      return "f64.sqrt";
    case "floor":
      return "f64.floor";
    case "ceil":
      return "f64.ceil";
    case "trunc":
      return "f64.trunc";
    default:
      return null;
  }
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
  /** (#2856) True iff the compile targets a JS host (NOT standalone / wasi /
   *  strictNoHostImports). Gates the host-extern capability. */
  readonly jsHostExterns?: boolean;
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
  const localClasses = collectLocalClasses(sourceFile);

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
        !stmt.asteriskToken &&
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        asyncNames.add(stmt.name.text);
      }
    }
    currentAsyncDeclNames = asyncNames;
  }
  // (#2856 C3) Module-scope `const <m> = new Map(...)` bindings — the
  // `<m>.get(k)` / `<m>.set(k, v)` method-call receiver arm of isPhase1Expr
  // consults this set. JS-host lane only (same capability gate as the
  // host-global resolver): in standalone/nativeStrings mode `Map` isn't a
  // registered extern class, so from-ast couldn't lower the calls — the
  // empty set keeps select↔build parity there.
  // (#3053 U2) Latch the config-soundness of the gc member-read primitive for
  // this run (default true = the sound default-host / fallback path). Read by
  // `dynamicUsesAreMoveOnly` to gate the dynamic member/element-access claim.
  currentDynMemberReadBuildable = options?.dynMemberReadBuildable ?? true;
  currentModuleScopeMapConsts.clear();
  if (hostExternCapability(options?.jsHostExterns === true) !== "defer") {
    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          ts.isNewExpression(d.initializer) &&
          ts.isIdentifier(d.initializer.expression) &&
          d.initializer.expression.text === "Map"
        ) {
          currentModuleScopeMapConsts.add(d.name.text);
        }
      }
    }
  }
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
    if (ts.isFunctionDeclaration(stmt) && stmt.name) declByName.set(stmt.name.text, stmt);
  }
  currentDynScanDecls = declByName;
  for (const stmt of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(stmt)) continue;
    if (!stmt.name) {
      if (trackFallbacks) unnamedCount++;
      continue;
    }
    declByName.set(stmt.name.text, stmt);
    const reason = trackFallbacks
      ? whyNotIrClaimable(stmt, typeMap, localClasses)
      : isIrClaimable(stmt, typeMap, localClasses)
        ? null
        : "param-shape-rejected"; // sentinel — not used when trackFallbacks=false
    if (reason === null) {
      individuallyClaimed.add(stmt.name.text);
    } else if (trackFallbacks) {
      fallbackReasons.set(stmt.name.text, reason);
      captureShapeDetail(stmt.name.text, reason);
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
    for (const member of stmt.members) {
      let memberName: string;
      let memberNode:
        | ts.MethodDeclaration
        | ts.ConstructorDeclaration
        // #3000-B: accessors join the claimable member kinds.
        | ts.GetAccessorDeclaration
        | ts.SetAccessorDeclaration;
      if (ts.isConstructorDeclaration(member)) {
        memberName = `${className}_new`;
        memberNode = member;
      } else if (ts.isMethodDeclaration(member)) {
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
        memberNode = member;
      } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
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
  // #2858 host-mode narrowing (BANKED 2026-07-06 regression fix). Relaxing the
  // caller-direction demotion in host mode is sound for value-param leaf helpers
  // (the #2949 slice-3b `any`-ABI unification makes a legacy caller of an IR
  // callee signature-safe). It is NOT sound when the claimed helper takes a
  // **callable/closure param** (a `FunctionTypeNode` parameter, e.g.
  // `fn: () => number`): #2949's `any`-ABI unification does not cover the
  // closure-as-callable-param ABI. If such a helper is claimed for IR only
  // because its lone unclaimed edge is a legacy caller passing it a
  // captured-closure argument, the IR lowering illegal-casts that legacy
  // captured-closure struct (legacy closure ABI ≠ IR callable/funcref
  // signature) and diverges from the legacy output (the 3 equivalence-gate
  // regressions on #2752). Keep the conservative caller-direction demotion for
  // any function carrying a callable param so it stays on the legacy path
  // alongside its legacy caller; value-param leaves keep the relaxation
  // (bucket→0 win + the 24 tagged-template fixes preserved).
  const hasCallableParam = (name: string): boolean => {
    const fn = declByName.get(name);
    if (!fn) return false;
    return fn.parameters.some((p) => p.type !== undefined && ts.isFunctionTypeNode(p.type));
  };
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
      // Caller-direction demotion: always in standalone/wasi (#2858), and in
      // host mode only for functions with a callable/closure param (BANKED
      // 2026-07-06 — see `hasCallableParam` above).
      if (demoteOnLegacyCaller || hasCallableParam(name)) {
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
type IrClaimableSubject =
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
// (#1373b C-1) The options of the CURRENT `planIrCompilation` run, so
// `whyNotIrClaimable` (whose signature is shared by many recursion helpers)
// can consult the async gate without threading a param through every
// `isPhase1*` helper — same module-state pattern as
// `currentHostGlobalResolver` / `currentDynScanDecls`. `undefined` outside a
// selector run (async fns then keep their fallback bucket).
let currentSelectionOptions: IrSelectionOptions | undefined;
// (#1373b C-1) Names of the top-level ASYNC (non-generator) function
// declarations of the current run. A claimed body may reference these ONLY as
// the immediate operand of an `await`: legacy classifies any other call-site
// use as a THENABLE consumer and wraps the raw result in `Promise.resolve`
// (#1796 `classifyAsyncConsumer` — no cast, no await ⇒ thenable), a wrap the
// IR does not emit. Claiming such a shape would change observable behavior,
// so the call arm rejects it (parity-first; the shape stays legacy).
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

/**
 * (#2856) Host-extern resolution for the CURRENT `planIrCompilation` run.
 * Set (and cleared) at the selector entry from `IrSelectionOptions` —
 * module-level for the same reason as `currentHostGlobalResolver`: the
 * `isPhase1*` predicates are a deep recursion whose signatures are shared
 * with every in-flight selector slice, and threading a param through all of
 * them would conflict with each of those PRs for zero behavioural gain.
 * `null` = host-extern claiming disabled (no callback, or a host-free mode —
 * see `hostExternCapability` in capability.ts).
 */
let currentHostGlobalResolver: ((node: ts.Identifier) => string | undefined) | null = null;

/**
 * (#2856 C3) Module-scope `const <m> = new Map(...)` binding names for the
 * CURRENT `planIrCompilation` run (JS-host lane only — cleared/refilled at
 * the selector entry). Receiver acceptance for `<m>.get(k)` / `<m>.set(k, v)`
 * method calls; the from-ast identifier arm resolves the same binding via
 * `resolver.getModuleScopeExternBinding` (the legacy `__mod_<name>` global +
 * extern-class brand), so accepted shapes always lower.
 */
const currentModuleScopeMapConsts = new Set<string>();

/**
 * (#3053 U2) Whether the gc `__dyn_member_get` body is sound in the CURRENT
 * `planIrCompilation` run's compile config (see `IrSelectionOptions.
 * dynMemberReadBuildable`). Set at selector entry, read by
 * `dynamicUsesAreMoveOnly`'s member/element-access arms. Defaults to `true`
 * (the sound default-host / fallback path). Module-scope, mirroring
 * `currentModuleScopeMapConsts` — `planIrCompilation` is not reentrant.
 */
let currentDynMemberReadBuildable = true;

function whyNotIrClaimable(
  fn: IrClaimableSubject,
  typeMap: TypeMap | undefined,
  localClasses: ReadonlySet<string>,
  isMethod: boolean = false,
): IrFallbackReason | null {
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

      collectPatternNames(p.name, scope);
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
    // #2949 slice 2 — collect dynamic-typed param names for the move-only scan.
    if (paramResolved === "dynamic") dynNames.add(p.name.text);

    scope.add(p.name.text);
  }

  const body = fn.body;
  if (!body) return "body-shape-rejected";
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
      for (const s of body.statements) {
        if (!isPhase1BodyStatement(s, ctorScope, localClasses)) return "body-shape-rejected";
      }
    } finally {
      earlyReturnBarrierDepth--;
    }
    return null;
  }
  if (!isPhase1StatementList(body.statements, scope, localClasses, isGenerator, isVoidReturn))
    return "body-shape-rejected";

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
  if (dynNames.size > 0 || isDynamicReturn) {
    if (!dynamicUsesAreMoveOnly(fn, dynNames, isDynamicReturn, typeMap)) {
      return dynNames.size > 0 ? "param-type-not-resolvable" : "return-type-not-resolvable";
    }
  }

  return null;
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
// #2859 — `closure` (param only): a FunctionTypeNode annotation whose params
//   and return are all primitive-annotated (the same surface slice-3 closure
//   literals support). Lowers to `IrType.closure`; calls through the param
//   dispatch via `lowerClosureCall` exactly like a closure-typed local.
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
 * void returns (`emitClosureCall` is value-producing), rest/optional/default
 * params, type parameters.
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
  const returnType = prim(node.type);
  if (!returnType) return null;
  return { params, returnType };
}

function resolveParamType(p: ts.ParameterDeclaration, mapped: LatticeType | undefined): ResolvedKind {
  if (p.type) {
    if (p.type.kind === ts.SyntaxKind.NumberKeyword) return "f64";
    if (p.type.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
    if (p.type.kind === ts.SyntaxKind.StringKeyword) return "string";
    // (#2949 slice 3b) `any` IS the dynamic type. The historical #1228
    // mapping ("any" kind → externref override) claimed EVERY any-param
    // function unconditionally and relied on from-ast throwing for
    // non-move uses — a claim-then-demote channel; it also pinned the
    // fast-mode carrier to externref, diverging from legacy's mode-split
    // `any` ABI (fast → ref_null $AnyValue). Resolving `dynamic` here
    // routes any-params through the SAME move-only scan + carrier as
    // unannotated dynamics: non-move uses now reject PRE-claim (no
    // demotion), and the claimed ones share legacy's ABI in both modes.
    if (p.type.kind === ts.SyntaxKind.AnyKeyword) return "dynamic";
    // #2859 — function-typed param (`fn: () => number`). Accepted when the
    // signature is expressible with the slice-3 closure surface; the param
    // lowers to the closure supertype struct and `fn()` dispatches through
    // `lowerClosureCall`. Inexpressible function types stay rejected.
    if (ts.isFunctionTypeNode(p.type)) {
      return irClosureSignatureFromFunctionTypeNode(p.type) ? "closure" : null;
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
    if (ts.isTypeLiteralNode(p.type) || ts.isTypeReferenceNode(p.type) || ts.isArrayTypeNode(p.type)) return "object";
    return null;
  }
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
  if (fn.type) {
    return resolveReturnTypeNode(fn.type);
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
function calleeParamIsDynamic(calleeName: string, argIdx: number, typeMap: TypeMap | undefined): boolean {
  const decl = currentDynScanDecls?.get(calleeName);
  if (!decl) return false;
  const p = decl.parameters[argIdx];
  if (!p || !ts.isIdentifier(p.name)) return false;
  return resolveParamType(p, typeMap?.get(calleeName)?.params[argIdx]) === "dynamic";
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
      if (!scanExpr(a, calleeParamIsDynamic(calleeName, i, typeMap))) return false;
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
      // Plain assignment re-binds; scan the RHS against the LHS's dyn-ness.
      if (e.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(e.left)) {
        if (expectDyn) return false; // assignment-as-value in a dyn position — slice 3
        return scanExpr(e.right, dynNames.has(e.left.text));
      }
      if (expectDyn) return false; // operator results are concrete-shaped
      return scanExpr(e.left, false) && scanExpr(e.right, false);
    }
    if (ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) {
      if (expectDyn) return false;
      const op = e.operand;
      return scanExpr(op, false);
    }
    if (ts.isConditionalExpression(e)) {
      // Dyn joins in cond-expr arms need refinement widening at the join —
      // slice 3. Concrete conditional expressions pass through.
      if (expectDyn) return false;
      return scanExpr(e.condition, false) && scanExpr(e.whenTrue, false) && scanExpr(e.whenFalse, false);
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
      return scanExpr(s.expression, returnIsDynamic);
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
        scanExpr(s.expression, false) && scanStmt(s.thenStatement) && (!s.elseStatement || scanStmt(s.elseStatement))
      );
    }
    if (ts.isBlock(s)) {
      for (const inner of s.statements) if (!scanStmt(inner)) return false;
      return true;
    }
    if (ts.isWhileStatement(s)) {
      return scanExpr(s.expression, false) && scanStmt(s.statement);
    }
    // For / for-of / for-in / switch / try / throw / nested functions /
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
      if (
        ts.isBinaryExpression(s.expression) &&
        s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(s.expression.left)
      ) {
        // LHS: <expr>.<id> — receiver expr must be Phase-1, prop must be an
        // Identifier or (#3000) a PrivateIdentifier (`this.#x = v`).
        if (!ts.isIdentifier(s.expression.left.name) && !ts.isPrivateIdentifier(s.expression.left.name))
          return shapeNo("nontail-assign-computedprop", s.expression);
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
    if (ts.isIfStatement(s) && !s.elseStatement) {
      if (!isPhase1Expr(s.expression, scope, localClasses)) return shapeNo("nontail-if-cond", s.expression);
      if (thenArmTerminates(s.thenStatement)) {
        // Early-return rewrite: `if (cond) <tail>; <rest>` ≡
        // `if (cond) <tail> else { <rest> }`. The then-arm must be a Phase-1
        // tail (terminates on every path); the rest becomes the else block.
        if (!isPhase1Tail(s.thenStatement, new Set(scope), localClasses, isGenerator, isVoidReturn))
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
      if (!isPhase1BodyStatement(s.thenStatement, new Set(scope), localClasses, /* inLoop */ false))
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
  // #2952 slice 2 — propagated so a break/continue inside a try nested in a
  // loop is claimable (the lowerer inlines crossed finallys before the br).
  inLoop: boolean = false,
): boolean {
  if (!stmt.catchClause && !stmt.finallyBlock) return false;

  // (#2856 C1) try/catch/finally bodies are early-return BARRIERS: a Wasm
  // `return` inside them would skip the inlined finally blocks. (#2952 s2's
  // break/continue is different — its `br.label` lowering inlines crossed
  // finallys, so `inLoop` propagates while the early-return arm stays barred.)
  earlyReturnBarrierDepth++;
  try {
    // Try body: must be a Phase-1 body statement list.
    const tryScope = new Set(scope);
    for (const s of stmt.tryBlock.statements) {
      if (!isPhase1BodyStatement(s, tryScope, localClasses, inLoop)) return false;
    }

    if (stmt.catchClause) {
      const catchScope = new Set(scope);
      if (stmt.catchClause.variableDeclaration) {
        const v = stmt.catchClause.variableDeclaration;
        // Slice 9 only accepts identifier bindings. Destructuring catch
        // (`catch ({message})`) defers to slice 9.5.
        if (!ts.isIdentifier(v.name)) return false;
        catchScope.add(v.name.text);
      }
      for (const s of stmt.catchClause.block.statements) {
        if (!isPhase1BodyStatement(s, catchScope, localClasses, inLoop)) return false;
      }
    }

    if (stmt.finallyBlock) {
      const finallyScope = new Set(scope);
      for (const s of stmt.finallyBlock.statements) {
        if (!isPhase1BodyStatement(s, finallyScope, localClasses, inLoop)) return false;
      }
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
function isPhase1ForOf(stmt: ts.ForOfStatement, scope: Set<string>, localClasses: ReadonlySet<string>): boolean {
  if (stmt.awaitModifier) return false;
  if (!ts.isVariableDeclarationList(stmt.initializer)) return false;
  const flags = stmt.initializer.flags;
  if (!(flags & ts.NodeFlags.Let) && !(flags & ts.NodeFlags.Const)) return false;
  if (stmt.initializer.declarations.length !== 1) return false;
  const decl = stmt.initializer.declarations[0]!;
  if (!ts.isIdentifier(decl.name)) return false;
  if (decl.initializer) return false; // for-of decl shouldn't have an `=` initializer
  if (!isPhase1Expr(stmt.expression, scope, localClasses)) return false;
  const innerScope = new Set(scope);
  innerScope.add(decl.name.text);
  // (#2856 C1) A for-of body is an early-return BARRIER: the iterator-
  // protocol drive would skip its `iter.return` cleanup on a Wasm return
  // (whether the iterable resolves to the vec fast path is a lowering-time
  // fact the shape walk can't see, so be conservative for all for-ofs).
  // #2952 s2's break/continue stays claimable (`inLoop` true — its br.label
  // targets the loop label, not a function exit).
  earlyReturnBarrierDepth++;
  try {
    return isPhase1BodyStatement(stmt.statement, innerScope, localClasses, /* inLoop (#2952 s2) */ true);
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
): boolean {
  if (!isPhase1Expr(stmt.expression, scope, localClasses)) return false;
  // (#2856 C1) while bodies admit the early-return arm.
  earlyReturnLoopDepth++;
  try {
    return isPhase1BodyStatement(stmt.statement, new Set(scope), localClasses, /* inLoop (#2952 s2) */ true);
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
): boolean {
  if (!isPhase1Expr(stmt.expression, scope, localClasses)) return false;
  // (#2856 C1) do-while bodies admit the early-return arm.
  earlyReturnLoopDepth++;
  try {
    return isPhase1BodyStatement(stmt.statement, new Set(scope), localClasses, /* inLoop (#2952 s2) */ true);
  } finally {
    earlyReturnLoopDepth--;
  }
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
): boolean {
  // Cond must be present (no infinite loops in slice 12).
  if (!stmt.condition) return false;

  const innerScope = new Set(scope);

  // Init: optional. Variable declaration adds bindings; expression init
  // doesn't. Both must be Phase-1.
  if (stmt.initializer) {
    if (ts.isVariableDeclarationList(stmt.initializer)) {
      const flags = stmt.initializer.flags;
      if (!(flags & ts.NodeFlags.Let) && !(flags & ts.NodeFlags.Const)) return false;
      for (const d of stmt.initializer.declarations) {
        if (!ts.isIdentifier(d.name)) return false;
        if (!d.initializer) return false;
        if (!isPhase1Expr(d.initializer, innerScope, localClasses)) return false;
        // (#2856) A name a SIBLING for-init leaked into the flat scope set is
        // NOT a genuine duplicate — from-ast scopes each for-init in its own
        // innerCx copy, so `for (let i...) {} for (let i...) {}` builds fine.
        // Genuine outer bindings still reject (build-side redeclaration).
        if (innerScope.has(d.name.text) && !forInitLeakedNames.has(d.name.text)) return false; // duplicate
        innerScope.add(d.name.text);
      }
    } else {
      // Expression init.
      if (!isPhase1Expr(stmt.initializer, innerScope, localClasses)) return false;
    }
  }

  // Cond: must be a Phase-1 expression in the inner scope.
  if (!isPhase1Expr(stmt.condition, innerScope, localClasses)) return false;

  // Update: optional. When present, must be a Phase-1 expression OR a
  // postfix `i++` / `i--` (which `isPhase1Expr` doesn't accept on its
  // own because postfix mutates state — but it's the canonical for-loop
  // update so we accept it explicitly here).
  if (stmt.incrementor) {
    if (!isPhase1ForUpdateExpr(stmt.incrementor, innerScope, localClasses)) return false;
  }

  // Body: single Phase-1 body statement.
  // (#2856 C1) for bodies admit the early-return arm.
  earlyReturnLoopDepth++;
  try {
    return isPhase1BodyStatement(stmt.statement, innerScope, localClasses, /* inLoop (#2952 s2) */ true);
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
      return ts.isIdentifier(expr.operand) && scope.has(expr.operand.text);
    }
    return false;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    // Plain or compound assignment to an identifier in scope.
    if (
      op === ts.SyntaxKind.EqualsToken ||
      op === ts.SyntaxKind.PlusEqualsToken ||
      op === ts.SyntaxKind.MinusEqualsToken ||
      op === ts.SyntaxKind.AsteriskEqualsToken ||
      op === ts.SyntaxKind.SlashEqualsToken
    ) {
      if (!ts.isIdentifier(expr.left)) return false;
      if (!scope.has(expr.left.text)) return false;
      return isPhase1Expr(expr.right, scope, localClasses);
    }
  }
  return isPhase1Expr(expr, scope, localClasses);
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
): boolean {
  if (ts.isBlock(stmt)) {
    const inner = new Set(scope);
    for (const s of stmt.statements) {
      if (!isPhase1BodyStatement(s, inner, localClasses, inLoop)) return false;
    }
    return true;
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
          if (!scope.has(stmt.expression.left.text)) return false;
          return isPhase1Expr(stmt.expression.right, scope, localClasses);
        }
        if (ts.isPropertyAccessExpression(stmt.expression.left)) {
          // #3000 — allow `this.#x = v` (PrivateIdentifier) in method / ctor
          // bodies, in addition to plain-Identifier field writes.
          if (!ts.isIdentifier(stmt.expression.left.name) && !ts.isPrivateIdentifier(stmt.expression.left.name))
            return false;
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
          if (!scope.has(stmt.expression.left.text)) return false;
          return isPhase1Expr(stmt.expression.right, scope, localClasses);
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
        return ts.isIdentifier(stmt.expression.operand) && scope.has(stmt.expression.operand.text);
      }
    }
    return shapeNo("body-exprstmt-other", stmt.expression);
  }
  if (ts.isForOfStatement(stmt)) {
    return isPhase1ForOf(stmt, scope, localClasses);
  }
  // Slice 12 (#1280) — nested while / for inside a body buffer.
  if (ts.isWhileStatement(stmt)) {
    return isPhase1WhileStatement(stmt, scope, localClasses);
  }
  if (ts.isForStatement(stmt)) {
    if (!isPhase1ForStatement(stmt, scope, localClasses)) return false;
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
    return isPhase1DoStatement(stmt, scope, localClasses);
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
    return isPhase1TryStatement(stmt, scope, localClasses, inLoop);
  }
  // #2952 slice 2 — statement-level `if` inside a body buffer (lowered as
  // the void `if.stmt` IR instr — NOT the top-level block-CFG rewrite).
  // Both arms are body statements; `inLoop` propagates so `if (c) break;`
  // — the canonical multi-exit shape — is claimable.
  if (ts.isIfStatement(stmt)) {
    if (!isPhase1Expr(stmt.expression, scope, localClasses)) return shapeNo("body-if-cond", stmt.expression);
    if (!isPhase1BodyStatement(stmt.thenStatement, new Set(scope), localClasses, inLoop)) return false;
    if (stmt.elseStatement && !isPhase1BodyStatement(stmt.elseStatement, new Set(scope), localClasses, inLoop)) {
      return false;
    }
    return true;
  }
  // #2952 slice 2 — unlabeled break / continue: claimable exactly when an
  // enclosing CLAIMED loop binds them (labeled forms are slice 3). Backed
  // by `lowerBreakContinueStatement` in from-ast (br.label against the
  // innermost loop's synthesised label) — selector↔builder parity.
  if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) {
    if (stmt.label) return shapeNo("body-labeled-break-continue", stmt);
    if (!inLoop) return shapeNo("body-break-continue-outside-loop", stmt);
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
    if (!stmt.elseStatement) return shapeNo("tail-if-noelse", stmt);
    if (!isPhase1Expr(stmt.expression, scope, localClasses)) return false;
    if (!isPhase1Tail(stmt.thenStatement, new Set(scope), localClasses, isGenerator, isVoidReturn)) return false;
    if (!isPhase1Tail(stmt.elseStatement, new Set(scope), localClasses, isGenerator, isVoidReturn)) return false;
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
  if (!(flags & ts.NodeFlags.Let) && !(flags & ts.NodeFlags.Const)) return shapeNo("vardecl-var-kind", stmt);
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
      if (!isConst) return shapeNo("vardecl-dstr-let", d.name);
      if (!d.initializer) return shapeNo("vardecl-dstr-noinit", d.name);
      if (!isPhase1BindingPattern(d.name, scope)) return shapeNo("vardecl-dstr-pattern", d.name);
      // Initializer must be Phase-1 expressible. The lowerer inspects
      // its IrType to decide between object.get (object pattern) and
      // vec.get (array pattern); if the resolved IrType isn't compatible
      // with the pattern shape, lowering throws and the function falls
      // back to legacy.
      if (!isPhase1Expr(d.initializer, scope, localClasses)) return shapeNo("vardecl-dstr-init", d.initializer);
      // Pre-add every leaf identifier to scope so subsequent statements
      // see the new names.
      collectPatternNames(d.name, scope);
      continue;
    }
    if (!ts.isIdentifier(d.name)) return shapeNo("vardecl-nonident-name", d.name);
    if (scope.has(d.name.text)) return shapeNo("vardecl-shadow", d.name);
    if (!d.initializer) return shapeNo("vardecl-noinit", d);
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
      if (!isPhase1ClosureLiteral(d.initializer, scope, localClasses))
        return shapeNo("vardecl-closure-init", d.initializer);
      scope.add(d.name.text);
      continue;
    }
    if (d.type && !isPhase1TypeNode(d.type)) return shapeNo("vardecl-typenode", d.type);
    if (!isPhase1Expr(d.initializer, scope, localClasses)) return shapeNo("vardecl-init-expr", d.initializer);
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
  if (bodyReferencesIdentifier(fn.body, fn.name.text)) return false;
  if (!isPhase1StatementList(fn.body.statements, closureScope, localClasses)) return false;

  // Add the nested function name to the OUTER scope.
  scope.add(fn.name.text);
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
  if (ts.isFunctionExpression(expr) && expr.name) return false; // named func expr — defer
  if ("asteriskToken" in expr && expr.asteriskToken) return false; // generator
  if (expr.modifiers && expr.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  if (expr.typeParameters && expr.typeParameters.length > 0) return false;

  if (!expr.type || annotationToResolvedKind(expr.type) === null) return false;

  const inner = new Set(scope);
  for (const p of expr.parameters) {
    if (!ts.isIdentifier(p.name)) return false;
    if (p.questionToken || p.dotDotDotToken || p.initializer) return false;
    if (!p.type || annotationToResolvedKind(p.type) === null) return false;
    if (inner.has(p.name.text)) return false;
    inner.add(p.name.text);
  }

  // ArrowFunction with concise body: must be a Phase-1 expression.
  // ArrowFunction / FunctionExpression with block body: Phase-1 tail
  // statement list.
  if (ts.isArrowFunction(expr) && !ts.isBlock(expr.body)) {
    return isPhase1Expr(expr.body, inner, localClasses);
  }
  if (!ts.isBlock(expr.body)) return false;
  return isPhase1StatementList(expr.body.statements, inner, localClasses);
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

function isKnownExternClass(name: string): boolean {
  return KNOWN_EXTERN_CLASSES.has(name);
}

function isPhase1Expr(expr: ts.Expression, scope: ReadonlySet<string>, localClasses: ReadonlySet<string>): boolean {
  if (ts.isParenthesizedExpression(expr)) return isPhase1Expr(expr.expression, scope, localClasses);
  // (#1373b C-1) `await <e>` inside a C-1-claimed async body. Shape-accept
  // mirrors the legacy sync-model lowering from-ast emits:
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
    if (scope.has(expr.text)) return true;
    return (
      currentHostGlobalResolver !== null &&
      !localClasses.has(expr.text) &&
      currentHostGlobalResolver(expr) !== undefined
    );
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
    return isPhase1Expr(expr.operand, scope, localClasses);
  }
  if (ts.isBinaryExpression(expr)) {
    const binOp = expr.operatorToken.kind;
    // (#2856 C3) STRICT undefined-compare — `hit !== undefined` /
    // `x === undefined`. The `undefined` identifier isn't in scope, so the
    // generic operand recursion would reject it; accept it specially as one
    // operand of a strict equality. The from-ast arm dispatches on the other
    // operand's IrType (externref-shaped → runtime `__extern_is_undefined`;
    // never-undefined representations → constant fold). LOOSE `==`/`!=` stay
    // rejected: `null == undefined` is true, so a nullable-ref operand would
    // need a runtime null check this slice doesn't emit.
    if (binOp === ts.SyntaxKind.EqualsEqualsEqualsToken || binOp === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      const isUndefIdent = (e: ts.Expression): boolean =>
        ts.isIdentifier(e) && e.text === "undefined" && !scope.has("undefined");
      const leftUndef = isUndefIdent(expr.left);
      const rightUndef = isUndefIdent(expr.right);
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
      !scope.has(expr.right.text)
    ) {
      return isPhase1Expr(expr.left, scope, localClasses);
    }
    if (!isPhase1BinaryOp(binOp)) return shapeNo(`expr-binary-op-${ts.tokenToString(binOp) ?? binOp}`, expr);
    return isPhase1Expr(expr.left, scope, localClasses) && isPhase1Expr(expr.right, scope, localClasses);
  }
  if (ts.isConditionalExpression(expr)) {
    return (
      isPhase1Expr(expr.condition, scope, localClasses) &&
      isPhase1Expr(expr.whenTrue, scope, localClasses) &&
      isPhase1Expr(expr.whenFalse, scope, localClasses)
    );
  }
  if (ts.isCallExpression(expr)) {
    // #3000-E: `super(args)` — a derived ctor chaining to its parent. `super` is
    // a keyword, not an identifier/property-access the generic receiver checks
    // below handle, so recognise the shape here. Args must be Phase-1 exprs; the
    // lowerer (from-ast) resolves the parent `_init` and validates arity/types.
    if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
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
      // (#1371) Whitelist `Math.<unary>(arg)` for a small set of f64-mapped
      // ops. The receiver `Math` is a host global, never in scope, so the
      // generic receiver check below would reject these. Recognise the shape
      // here and accept it; the lowerer in from-ast.ts emits a plain unary
      // f64 op for the call.
      if (
        ts.isIdentifier(expr.expression.expression) &&
        expr.expression.expression.text === "Math" &&
        IR_MATH_UNARY_WHITELIST.has(expr.expression.name.text) &&
        expr.arguments.length === 1 &&
        !ts.isSpreadElement(expr.arguments[0]!)
      ) {
        return isPhase1Expr(expr.arguments[0]!, scope, localClasses);
      }
      // (#2856 C3) `<moduleMapConst>.get(k)` / `.set(k, v)` — the receiver is
      // a module-scope `const <m> = new Map(...)` binding (never in the local
      // scope set, so the generic receiver check below would reject it). The
      // from-ast identifier arm lowers the receiver as a TDZ-checked
      // `global.get $__mod_<m>` branded `extern:Map`; `.get`/`.set` then ride
      // the existing extern method-call machinery (Map_get / Map_set host
      // imports, registered by the legacy source scan). JS-host lane only —
      // the set is empty otherwise.
      if (
        ts.isIdentifier(expr.expression.expression) &&
        !scope.has(expr.expression.expression.text) &&
        currentModuleScopeMapConsts.has(expr.expression.expression.text) &&
        (expr.expression.name.text === "get" || expr.expression.name.text === "set")
      ) {
        const wantArgs = expr.expression.name.text === "get" ? 1 : 2;
        if (expr.arguments.length !== wantArgs) return shapeNo("expr-modmap-arity", expr);
        for (const arg of expr.arguments) {
          if (ts.isSpreadElement(arg)) return shapeNo("expr-modmap-spread", arg);
          if (!isPhase1Expr(arg, scope, localClasses)) return false;
        }
        return true;
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
        !scope.has(expr.expression.expression.text) &&
        localClasses.has(expr.expression.expression.text)
      ) {
        for (const arg of expr.arguments) {
          if (ts.isSpreadElement(arg)) return false;
          if (!isPhase1Expr(arg, scope, localClasses)) return false;
        }
        return true;
      }
      if (!isPhase1Expr(expr.expression.expression, scope, localClasses)) return false;
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
    // (#1373b C-1) A local ASYNC callee is claimable ONLY as the immediate
    // operand of an `await` (handled inline in the await arm above, which
    // never recurses here for that shape). Every other use — `return f();`,
    // `const p = f();`, an argument position — is a THENABLE consumer under
    // the legacy #1796 call-site contract (wrapped in `Promise.resolve`),
    // which the IR does not emit. Reject to keep claimed-vs-legacy behavior
    // identical; the fn stays on the legacy path.
    if (currentAsyncDeclNames.has(expr.expression.text) && !scope.has(expr.expression.text)) {
      return shapeNo("expr-async-callee-not-awaited", expr);
    }
    for (const arg of expr.arguments) {
      // Slice 8a (#1169g): accept `f(...source)` where the spread source
      // is an ArrayLiteralExpression with no nested spread. The lowerer
      // expands this at compile time into individual call arguments
      // (matches the legacy `expandSpreadCallArgs` fast path). Spread
      // sources of dynamic length (e.g. an arbitrary identifier of vec
      // type) are deferred — they'd require runtime arity expansion
      // which the IR doesn't model in slice 8a.
      if (ts.isSpreadElement(arg)) {
        if (!isStaticSpreadSource(arg.expression, scope, localClasses)) return false;
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
    if (!ts.isIdentifier(expr.expression)) return false;
    const ctorName = expr.expression.text;
    if (!localClasses.has(ctorName) && !isKnownExternClass(ctorName)) return false;
    if (expr.typeArguments && expr.typeArguments.length > 0) return false; // defer generics
    if (!expr.arguments) return true;
    for (const arg of expr.arguments) {
      if (!isPhase1Expr(arg, scope, localClasses)) return false;
    }
    return true;
  }
  // Slice 1: `typeof <expr>` is claimable when its operand is a Phase-1
  // expression. The resulting value is a string tag ("number" / "boolean" /
  // "string" / …); downstream it only composes with `isPhase1BinaryOp`'s
  // new string-equality form.
  if (ts.isTypeOfExpression(expr)) {
    return isPhase1Expr(expr.expression, scope, localClasses);
  }
  // Slice 1 (#1169a): no-substitution template literals are equivalent to a
  // string literal at the AST level (`\`hello\``).
  if (expr.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) return true;
  // Slice 1: template expressions with substitutions, where every
  // substitution is itself a Phase-1 expression. Type compatibility
  // (each sub must produce a string in slice 1) is enforced later in
  // from-ast — accepting the shape here is shape-only acceptance.
  if (ts.isTemplateExpression(expr)) {
    for (const span of expr.templateSpans) {
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
    for (const el of expr.elements) {
      if (ts.isSpreadElement(el)) return shapeNo("expr-arraylit-spread", el); // out of scope
      if (ts.isOmittedExpression(el)) return shapeNo("expr-arraylit-sparse", expr); // sparse — out of scope
      if (!isPhase1Expr(el, scope, localClasses)) return false;
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
  if (ts.isDeleteExpression(expr)) {
    return isPhase1Expr(expr.expression, scope, localClasses);
  }
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
  if (expr.properties.length === 0) return false;

  const seen = new Set<string>();
  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = phase1PropertyName(prop.name);
      if (name === null) return false;
      if (seen.has(name)) return false; // duplicate key — defer
      seen.add(name);
      if (!isPhase1Expr(prop.initializer, scope, localClasses)) return false;
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name.text;
      if (seen.has(name)) return false;
      if (!scope.has(name)) return false;
      seen.add(name);
      continue;
    }
    // SpreadAssignment, MethodDeclaration, GetAccessorDeclaration,
    // SetAccessorDeclaration → reject.
    return false;
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
function phase1MemberName(name: ts.PropertyName): string | null {
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
function referencesSuper(node: ts.Node): boolean {
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
function extendsParentName(stmt: ts.ClassDeclaration): string | null {
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
/** (#3142) The synthetic claim-unit name for the module-level statement list. */
export const MODULE_INIT_UNIT_NAME = "<module-init>";

/**
 * (#3142) The module-init population: every top-level statement that is not
 * a function / class / type / import / export declaration — i.e. the
 * statements the legacy path routes into `__module_init` (approximated
 * syntactically; the legacy collection in `declarations.ts` additionally
 * drops some side-effect-free forms, which only makes the assessment
 * conservative). Exported so Slice 2's integration lowers EXACTLY the
 * population the selector assessed — one definition, no drift.
 */
export function collectModuleInitPopulation(sourceFile: ts.SourceFile): ts.Statement[] {
  const population: ts.Statement[] = [];
  for (const stmt of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isImportDeclaration(stmt) ||
      ts.isImportEqualsDeclaration(stmt) ||
      ts.isExportDeclaration(stmt) ||
      ts.isExportAssignment(stmt) ||
      ts.isEmptyStatement(stmt)
    ) {
      // Declaration statements are owned by the existing declaration
      // machinery (`compileDeclarations` / class collection / export glue) —
      // not module-init work. NOTE: `enum` and `namespace` declarations
      // deliberately STAY in the population (they generate runtime code) and
      // reject via the body-shape gate's unhandled-statement arm.
      continue;
    }
    population.push(stmt);
  }
  return population;
}

/**
 * (#3142) Wrap the module-init population in a synthetic void
 * `<module-init>` FunctionDeclaration. Shared by the selector's Gate-2
 * call-graph scan and Slice 2's from-ast lowering so both see the same
 * unit shape. Factory nodes are only ever walked downward via
 * `forEachChild`, so the missing parent/position info is inert.
 */
export function makeModuleInitSynthetic(population: readonly ts.Statement[]): ts.FunctionDeclaration {
  return ts.factory.createFunctionDeclaration(
    /* modifiers */ undefined,
    /* asteriskToken */ undefined,
    MODULE_INIT_UNIT_NAME,
    /* typeParameters */ undefined,
    /* parameters */ [],
    /* type */ undefined,
    ts.factory.createBlock([...population], /* multiLine */ true),
  );
}

function assessModuleInit(
  sourceFile: ts.SourceFile,
  claimedFuncs: ReadonlySet<string>,
  declByName: ReadonlyMap<string, ts.FunctionDeclaration>,
  localClasses: ReadonlySet<string>,
): IrModuleInitAssessment {
  const population = collectModuleInitPopulation(sourceFile);
  if (population.length === 0) return { stmtCount: 0, reason: null };

  // Gate 1 — shape.
  if (SHAPE_DIAG_ON) shapeRejectDetail = null;
  earlyReturnLoopDepth = 0;
  earlyReturnBarrierDepth = 1;
  forInitLeakedNames = new Set();
  currentFnIsGenerator = false;
  currentFnIsVoidReturn = true;
  currentFnIsAsync = false; // (#1373b C-1) module-init is never an async body
  const scope = new Set<string>();
  for (const stmt of population) {
    if (!isPhase1BodyStatement(stmt, scope, localClasses)) {
      const detail = SHAPE_DIAG_ON ? (takeShapeRejectDetail() ?? "unattributed-arm:helper-internal") : undefined;
      return { stmtCount: population.length, reason: "body-shape-rejected", detail };
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

function buildLocalCallGraph(
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
        if (
          ts.isIdentifier(node.expression) &&
          (localClasses.has(node.expression.text) || isKnownExternClass(node.expression.text))
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
          const callee = node.expression.text;
          if (decls.has(callee)) {
            callees.get(callerName)!.add(callee);
            callers.get(callee)!.add(callerName);
          } else if (localBindings.has(callee)) {
            // Slice 3: closure / nested-fn binding within this outer.
            // Intra-function call, dispatched by the IR lowerer.
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
          if (
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "Math" &&
            IR_MATH_UNARY_WHITELIST.has(node.expression.name.text)
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

/**
 * Slice 4 (#1169d): scan the source file for class declarations. The
 * resulting set drives:
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
 * doesn't accept their use). Anonymous classes (no `name`) are skipped.
 */
function collectLocalClasses(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      names.add(stmt.name.text);
    }
  }
  return names;
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
  // #2859 — function-typed params (`fn: () => number`). A call through such a
  // param dispatches via the IR's closure machinery (`lowerClosureCall`),
  // exactly like a slice-3 closure local — it is NOT an external call. Only
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
    if (node !== fn && isFunctionLike(node)) return;
    if (ts.isFunctionDeclaration(node) && node !== fn && node.name) {
      names.add(node.name.text);
    }
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
