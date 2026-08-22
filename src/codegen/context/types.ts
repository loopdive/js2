// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared backend context and metadata types.
 *
 * This module owns the stable type layer for the codegen backend so leaf
 * modules do not need to import the monolithic `codegen/index.ts` file just
 * to reference context/state shapes.
 */
import { ts } from "../../ts-api.js";
import type { TypeOracle } from "../../checker/oracle.js";
import type { UsageInference } from "../../checker/usage-inference.js";
import type { IrUnitId } from "../../ir/identity.js";
import type { FieldDef, Instr, LocalDef, SourcePos, ValType, WasmFunction, WasmModule } from "../../ir/types.js";
import type { IrObservedOutcome } from "../../ir/outcomes.js";
import type { StandaloneRegExpEngineConfig } from "../regexp-standalone.js";
import type { ObjectRuntimeTypes } from "../object-runtime.js";
import type { FallbackCounts } from "../fallback-telemetry.js";
import type { CompileTargetProfile } from "../../target-profile.js";
import type { IrRuntimeEvalBoundaryPlan } from "../../ir/runtime-eval-boundary-plan.js";
import type { StandaloneCapabilityDemandState } from "./capability-state.js";
import type * as BodyRouteAudit from "./body-route-audit.js";

export interface CodegenError {
  message: string;
  line: number;
  column: number;
  /** Source file that owns the diagnostic node, when one is available. */
  file?: string;
  /**
   * #1921 — the compile-failure gate keys on this field, not on a magic
   * `"Codegen error:"` message prefix.
   *
   * - `"error"` (the default for {@link reportError} / {@link reportErrorNoNode})
   *   fails the build (`success: false`).
   * - `"warning"` is non-blocking and used by the IR-fallback channel for
   *   "we tried the IR path, it didn't fit, the legacy body still works" events.
   * - `"degrade"` is a *deliberate* compile-with-fallback-value diagnostic: the
   *   expression compiled to a placeholder (stack-balancer hole, identity bind,
   *   etc.) and the build is intentionally allowed to succeed. Each degrade site
   *   must reference a tracking issue, mirroring the host-import allowlist
   *   discipline.
   *
   * An omitted severity is treated as `"error"` by the gate (see
   * `isFatalCodegenDiagnostic` in src/compiler.ts) so that a forgotten
   * classification fails loudly instead of silently degrading.
   */
  severity?: "error" | "warning" | "degrade";
  /**
   * (#3725) Survive a speculative rollback.
   *
   * `rollbackSpeculative` (#1919) truncates `ctx.errors` back to the snapshot,
   * which is correct for a genuine PROBE — one of several candidate lowerings,
   * where a failure just means "not this one". But the backend's REFUSAL idiom
   * is also `reportError(...); return null`, and that lands on the very same
   * "inner produced no usable value" exit in `compileExpression`. So a
   * deliberate "this program cannot be compiled for this target" was discarded
   * and `pushDefaultValue` substituted a null — the compile reported
   * `success: true` with zero errors and the module trapped at runtime
   * ("dereferencing a null pointer"). A refusal silently became a trap.
   *
   * Marking a diagnostic `sticky` opts it out of that truncation. Use it ONLY at
   * sites that are a deliberate, documented refusal (target capability gaps like
   * the #1599 standalone JSON refusal) — never on a probe's failure, which
   * SHOULD vanish with the emission it described.
   *
   * Deliberately opt-IN rather than "retain every fatal diagnostic": auditing
   * the retain-all behaviour surfaced pre-existing sites that depend on the
   * swallow (60 `#1539` standalone-RegExp refusals inside the compiled-Acorn
   * acceptance module alone), so flipping it wholesale is its own remediation
   * project. See #3725.
   */
  sticky?: true;
}

/** Result returned by generateModule / generateMultiModule. */
export interface CodegenResult extends BodyRouteAudit.Result {
  module: WasmModule;
  errors: CodegenError[];
  /**
   * #2089 — silent-fallback telemetry counters captured during this codegen
   * run (per class → per site → count). Surfaced for structured gate
   * aggregation rather than warning parsing. Optional so existing callers that
   * destructure `{ module, errors }` are unaffected.
   */
  fallbackCounts?: FallbackCounts;
  /** #3519 — optional typed terminal outcome ledger for attempted IR units. */
  irOutcomes?: readonly IrObservedOutcome[];
}

/** Public options for backend code generation. */
export interface CodegenOptions extends BodyRouteAudit.Options {
  /** Whether to generate source positions for source map */
  sourceMap?: boolean;
  /** Fast mode: i32 default numbers */
  fast?: boolean;
  /** Use WasmGC-native strings instead of wasm:js-string imports */
  nativeStrings?: boolean;
  /** #1588 PR-B: dual i8/i16 string storage (default false → byte-identical). */
  utf8Storage?: boolean;
  /** Test-only: emit `__test_str_from_externref` / `__test_str_to_externref` exports (#1187). */
  testRuntime?: boolean;
  /** WASI target: emit WASI imports (fd_write, proc_exit) instead of JS host imports */
  wasi?: boolean;
  /**
   * Node-compatible ambient globals are enabled. This is distinct from the
   * Wasm backend target: a gc-host build can still target the Node platform.
   */
  nodeGlobals?: boolean;
  /**
   * #2783 — the dynamic-linking axis: namespaces to leave as link-time imports
   * (satisfied by a preloaded provider) instead of inline-lowering. `["node:fs"]`
   * routes std-IO through the `node:fs` shim (the user module imports
   * `readSync`/`writeSync` + its linear memory from `node:fs` and carries NO
   * `wasi_snapshot_preview1` import for the stream IO path; console.log /
   * process.std*.write lower to `writeSync(1|2, …)`; `node-fs.wasm` implements
   * the interface over WASI). WASI-gated in `create-context.ts` (ignored for
   * non-WASI targets). Default empty — the inline fd_read/fd_write path stays.
   */
  link?: string[];
  /** Standalone target (#1470): pure WasmGC, no JS host imports and no WASI
   *  runtime. Implies `nativeStrings: true` and refuses to emit any
   *  `wasm:js-string` namespace or `env::__concat_*` / `__extern_toString` /
   *  `__unbox_string` JS-host string imports. Used so the compiled module is
   *  runnable under pure-Wasm engines (wasmtime, wasmer) without a JS host. */
  standalone?: boolean;
  /** JS-host direct-eval lowering; see `CompileOptions.directEval`. */
  directEval?: "legacy" | "reified-host";
  /**
   * (#4035) Host-bridge export policy — see `CompileOptions.hostBridge`.
   * `"auto"` (default) resolves to `"always"` for js-host and `"off"` for
   * standalone/WASI; the resolved boolean lands on `ctx.emitHostBridge`.
   */
  hostBridge?: "auto" | "always" | "off";
  /** Select migrated Wasm-native semantic providers independently of JS interop. */
  semanticProviders?: import("../../target-profile.js").SemanticProviderSelection;
  /**
   * (#2141 S1) Honest generic `any` boxing — the Stage-B regime flag. When ON,
   * `boxToAny`'s externref arm routes through `__any_box_extern` (runtime
   * classification → true `JsTag`) instead of the historical tag-5
   * "box-the-externref" lie (#1888). Default OFF: byte-identical to the legacy
   * regime (the honest helper is not even registered). Flips to default-on for
   * standalone/wasi in slice S4 after the consumer migration (S2/S3) lands —
   * see plan/issues/2141-tag5-abi-untangle-honest-boxing.md.
   */
  honestAnyBoxing?: boolean;
  /**
   * (#745) Known-union `$AnyValue` representation — heterogeneous primitive
   * unions (`number | string`, …) resolve to the universal `$AnyValue` tagged
   * carrier instead of externref. **Default is derived from the lane**
   * (#745 S4.5): ON for native-string lanes (the computed `nativeStrings`
   * const — standalone / wasi / fast / strictNoHostImports / explicit
   * `nativeStrings`) now that the S3 (strict-eq / truthiness / string-concat)
   * and S4 (params / returns / any-boundary) consumer sweeps landed and made
   * those paths carrier-agnostic; the JS-host lane stays default-OFF until S5
   * (hard-gated on #2141). Explicit option wins over the lane default; set the
   * env kill-switch `JS2WASM_UNION_ANYREP=0` to force the legacy externref
   * union regime for A/B control (mirrors `JS2WASM_UNDEF_SINGLETON`, #2106).
   * Coordinate with #2141 (tag-5 ABI untangle).
   */
  unionAnyRep?: boolean;
  /**
   * (#684) Usage-based `any`-local type inference. When ON, a function-local
   * `any`/`unknown` identifier binding whose every use is ToNumber-invariant
   * (strictly-numeric operators) is lowered to an unboxed `f64` slot instead of
   * the boxed carrier (`externref` / `$AnyValue`), eliminating the per-read
   * `__box_number`/`__unbox_number` round-trip. Sound by construction — the
   * inference (`src/checker/usage-inference.ts`) bails on any use that could
   * observe the original non-numeric value. Default ON; set false to force the
   * legacy boxed representation for every `any` local.
   */
  useUsageInfer?: boolean;
  /**
   * (#4218) Which implementation backs `ctx.oracle`:
   *
   *   - `"checker"` (default) — the TS5 `ts.TypeChecker`.
   *   - `"inhouse"` — the checker-free binder + annotation-propagation backend
   *     (`src/checker/inhouse-oracle.ts`). Answers `unresolvable` wherever it
   *     cannot prove a fact syntactically, so codegen degrades to the dynamic
   *     representation rather than mis-lowering.
   *   - `"differential"` — answers from the checker (behavior identical) while
   *     recording where the in-house backend disagrees. The measurement lane.
   *
   * Unset falls back to `JS2WASM_ORACLE_BACKEND`, then `"checker"`.
   */
  oracleBackend?: import("../../checker/oracle-backend.js").OracleBackend;
  /** (#2141 S2/S3, #2626, #2040 A1) Tag-5 boxed-VALUE equality classifier —
   *  see the `CompileOptions.tag5ValueEqClassifier` doc. Default TRUE
   *  (#2040 flip); `JS2WASM_TAG5_CLASSIFIER=0` forces the legacy regime. */
  tag5ValueEqClassifier?: boolean;
  /** (#4173) Fast tag-pair dispatch in `__extern_strict_eq` (identity-miss →
   *  direct f64/string/bool/bigint compare or fast-false, no `$AnyValue`
   *  allocation) + single-convert `__is_truthy` ladder. Default TRUE;
   *  `JS2WASM_FAST_STRICT_EQ=0` forces the legacy bodies. */
  fastStrictEq?: boolean;
  /** (#2106 S1) Standalone `$undefined` tag-1 singleton regime — see the
   *  `CompileOptions.undefinedSingleton` doc. Default TRUE (#2106 flip);
   *  `JS2WASM_UNDEF_SINGLETON=0` forces the legacy regime. */
  undefinedSingleton?: boolean;
  /** (#2796) Diff-test-harness fidelity: in JS-host mode, export the top-level
   *  `__module_init` and do NOT run it via the wasm `start` section, so the host
   *  invokes it AFTER `setExports` (symmetric with the standalone `_start`
   *  model). Default false → top-level runs in the start section. See
   *  `CompileOptions.deferTopLevelInit`. WASI is unaffected (it already exports
   *  `_start`). */
  deferTopLevelInit?: boolean;
  /**
   * Experimental: route a narrow set of functions through the middle-end IR
   * (see `src/ir/`). Defaults to **on** since #1131 (the front-end driver
   * passes `experimentalIR !== false`); pass `false` to force the legacy
   * direct-emission path (bit-by-bit divergence tests or emergency revert).
   */
  experimentalIR?: boolean;
  /**
   * (#2973) Opt out of the `JS2WASM_IR_FIRST` compile-once inversion for this
   * compile, regardless of the ambient env flag. Set by semantics-critical
   * in-process sub-compiles (the `eval` / `new Function` host shims) so an
   * IR-first post-claim hard error there is not swallowed by the shim's
   * fallback `catch` and silently turned into `undefined`. Leaves the ordinary
   * IR overlay (`experimentalIR`) untouched. Default: false.
   */
  disableIrFirst?: boolean;
  /**
   * #2089 — count silent codegen fallbacks via `reportSilentFallback` and, when
   * set, surface each as a warning diagnostic. Used by
   * `scripts/check-codegen-fallbacks.ts`. Default off (counts are still kept;
   * only the warning emission is gated).
   */
  trackSilentFallbacks?: boolean;
  /** #3519 — collect typed terminal outcomes for every attempted IR unit. */
  trackIrOutcomes?: boolean;
  /** Node builtin modules detected during import preprocessing (#1044) */
  nodeBuiltins?: import("../../import-resolver.js").NodeBuiltinImport[];
  /** Set of function names imported from node:fs (detected pre-preprocessing).
   *  Used by both the WASI fs syscall path (#1035) and the JS-host fs imports (#1491). */
  wasiNodeFsFuncs?: Set<string>;
  /** (#743) Declared-parameter seeds for exported entrypoints, collected from
   *  the entry's shipped sibling `.d.ts` (flag-gated upstream). ONE shared map
   *  consumed by both the IR fixpoint and the legacy call-site inference so the
   *  lanes cannot diverge on seed facts. Absent → no seeding anywhere. */
  dtsEntrypointSeeds?: import("../../checker/dts-entrypoint-seeds.js").DtsEntrypointSeeds;
  /** (#2657) Set of LOCAL names imported from `"wasi_snapshot_preview1"`
   *  (detected pre-preprocessing). The raw-WASI fd_read/fd_write passthrough
   *  binds these identifiers directly to the WASI import funcs — the most honest
   *  pure-WASI-P1 expression, no `node:fs` surface (loopdive/js2wasm#389). */
  wasiRawImports?: Set<string>;
  /** (#2657) Set of LOCAL names imported from `"wasm:memory"` — js2wasm's inline
   *  linear-memory access intrinsics (`store32`/`load32`/`store8`/`load8`). These
   *  lower to a single WASM memory op (NOT imports); they let a raw-WASI module
   *  lay out its iovec + result slot without a GC roundtrip. Honestly namespaced
   *  away from `wasi_snapshot_preview1` (no host provides them). */
  wasiMemAccessors?: Set<string>;
  /** Allow `node:fs` JS-host imports for non-WASI targets (#1491). Default: false. */
  allowFs?: boolean;
  /** (#4238) Resolve `declare function` extern signatures through the native
   *  type annotations (`type i32 = number`) before the default f64 mapping. */
  externNativeTypes?: boolean;
  /** (#4238) Import module for `declare function` externs (default `"env"`). */
  externImportModule?: string;
  /** (#4238) Import the module's linear memory from `<module>.memory` instead
   *  of defining one (mirrors the `--link node:fs` topology). */
  importMemory?: { module: string; min?: number };
  /**
   * Enforce dual-mode discipline (#1524): when set, `addImport` rejects any
   * JS-host `env` import that is not on the
   * `src/codegen/host-import-allowlist.ts` baseline. WASI builds enable this
   * by default unless `allowHostImports` is set. Set this directly via
   * `--no-host-imports` on the CLI or `strictNoHostImports: true` in
   * `CompileOptions`.
   */
  strictNoHostImports?: boolean;
  /** JSX runtime import detected during preprocessing (#1540). */
  jsxRuntime?: import("../../import-resolver.js").JsxRuntimeImport;
  /**
   * (#2119) Infer ES-module strictness (→ unmapped `arguments`) from a genuine
   * top-level `import`/`export`. Default `true`. The test262 harness sets this
   * `false` for script tests so its synthetic `export function test()` wrapper
   * does not unmap sloppy (`noStrict`) arguments. See `CompileOptions`.
   */
  inferModuleStrictArguments?: boolean;
}

/** Info about an externally declared class. */
export interface ExternClassInfo {
  importPrefix: string;
  namespacePath: string[];
  className: string;
  constructorParams: ValType[];
  methods: Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>;
  properties: Map<string, { type: ValType; readonly: boolean }>;
}

/** Info about an optional parameter. */
export interface OptionalParamInfo {
  index: number;
  type: ValType;
  /** If the default is a compile-time constant, its value is stored here. */
  constantDefault?: { kind: "f64"; value: number } | { kind: "i32"; value: number };
  /** True when the default is a non-constant expression (needs callee-side evaluation). */
  hasExpressionDefault?: boolean;
}

/** Info about a rest parameter. */
export interface RestParamInfo {
  /** Index of the rest parameter in the original TS signature */
  restIndex: number;
  /** Element type of the rest array (e.g. f64 for number[]) */
  elemType: ValType;
  /** Array type index in the module types */
  arrayTypeIdx: number;
  /** Vec struct type index wrapping the array */
  vecTypeIdx: number;
}

/** Metadata for a function eligible for call-site inlining. */
export interface InlinableFunctionInfo {
  /** The compiled body instructions (shallow copy, safe to re-emit) */
  body: Instr[];
  /** Number of parameters */
  paramCount: number;
  /** Parameter types (for allocating temp locals) */
  paramTypes: ValType[];
  /** Return type (null = void) */
  returnType: ValType | null;
}

/** Metadata for a closure stored in a local variable. */
export interface ClosureInfo {
  /** Type index of the closure struct */
  structTypeIdx: number;
  /** Type index of the inner function type (for call_ref) */
  funcTypeIdx: number;
  /** Return type of the closure */
  returnType: ValType | null;
  /** Parameter types of the closure (excluding the closure struct self param) */
  paramTypes: ValType[];
  /** True only for source closures with one or more captured lexical bindings. */
  hasCaptures?: boolean;
  /** True when the source closure has a `...rest` parameter. */
  hasRestParam?: boolean;
  /**
   * True only while every concrete allocation of this wrapper/subtype is a
   * checker-certified one-shot host callback. Such values are consumed by
   * `__make_callback(-2, closure)` immediately and never enter the generic
   * callable/property/method bridges. An ordinary allocation clears the bit.
   */
  hostOneShotOnly?: boolean;
  /** Compiler-only carrier admitted exclusively by the reusable DOM callback dispatcher. */
  domCallbackOnly?: boolean;
  /**
   * True when a source closure observes the call-site arity protocol through
   * its own `arguments`, a rest parameter, or a parameter default. Undefined
   * is conservative for synthetic/dynamic wrappers whose source is unknown.
   */
  needsCallSiteArity?: boolean;
  /** Small, capture-free numeric closure body eligible for HOF call-site inlining. */
  inlineBody?: Instr[];
}

/** Metadata for a generator lowered to an in-module WasmGC state machine (#680). */
export interface NativeGeneratorInfo {
  /** Source-level generator function name. */
  functionName: string;
  /**
   * Original declaration; used to emit the resume function lazily. (#2571) A
   * class / object-literal generator method is a `ts.MethodDeclaration`; it
   * shares `.body` / `.parameters` / `.asteriskToken` with FunctionDeclaration,
   * and the native lowering treats an instance method's `this` as a synthetic
   * leading param (see `registerNativeGenerator`). (#3164) A generator
   * FUNCTION EXPRESSION registers under its lifted `__closure_<n>` name with
   * the closure `__self` param threaded as a leading synthetic capture.
   */
  decl: ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression;
  /**
   * (#2571) When `decl` is a non-static instance generator METHOD, the receiver
   * is threaded as a synthetic leading param named `"this"` (state field
   * `param_this`). `synthesizedThis` records that the param model has one extra
   * leading entry beyond `decl.parameters` so the factory reads `local.get 0`
   * (the `this` wasm param) into `param_this`. Free functions / static methods
   * leave this `false` (no synthetic param) — byte-identical to pre-#2571.
   */
  synthesizedThis?: boolean;
  /** Per-generator state struct type index. */
  stateTypeIdx: number;
  /** Shared IteratorResult-like struct type index. */
  resultTypeIdx: number;
  /** Absolute function index for the generated resume function, once emitted. */
  resumeFuncIdx?: number;
  /** Parameter names copied into the state struct at construction time. */
  paramNames: string[];
  /** Parameter value types copied into the state struct at construction time. */
  paramTypes: ValType[];
  /** Field index where captured params start in the state struct. */
  paramFieldOffset: number;
  /** Field index for the value passed to `.next(value)`. */
  sentFieldIdx: number;
  /** Field index for resume mode: 0 = next, 1 = return. */
  modeFieldIdx: number;
  /** Field index for the value passed to `.return(value)`. */
  abruptFieldIdx: number;
  /** Function-local names spilled into the state struct across suspensions. */
  spillNames: string[];
  /**
   * (#2864 F1b) Wasm ValType of each spilled local, aligned 1:1 with
   * `spillNames`. The state-struct spill field, the resume-load local, and the
   * struct-construction init default are all minted at this type so object /
   * string / typed-struct locals survive across a `yield` (historically f64).
   */
  spillTypes: ValType[];
  /** Field index where spilled locals start in the state struct. */
  spillFieldOffset: number;
  /**
   * (#3386) Names bound by a destructuring PARAM pattern (a subset of
   * `spillNames`). Parameter destructuring is EAGER per §10.2.11
   * FunctionDeclarationInstantiation: every emit site destructures the pattern
   * into factory locals BEFORE the factory emit, and
   * `compileNativeGeneratorFunction` packs those locals into the matching
   * spill fields at `struct.new` (instead of the inert default). The resume
   * function then reads the bindings back through the ordinary spill-load
   * loop — no state-0 re-destructure (which would double-drive one-shot
   * iterators and mistime default/GetIterator side effects to first-`.next()`).
   */
  patternParamBindings?: Set<string>;
  /**
   * (#3315/#3386) Subset of `patternParamBindings` whose spill type was
   * undefined-preservation-widened to externref; the resume fctx marks them in
   * `undefWidenedLocals` so identifier reads keep `undefined` observable.
   */
  undefWidenedPatternBindings?: Set<string>;
  /** Number of top-level yield suspension points. */
  yieldCount: number;
  /** Terminal state value. */
  doneState: number;
  /**
   * (#2171) ValType of the generator's yielded values. `{kind:"f64"}` for the
   * numeric path (default); the native-string ref for a generator whose yields
   * are all strings. The result struct's `value` field and the for-of / .next()
   * extraction read this. Mixed / object yields are not yet supported (the plan
   * bails before a generator with disagreeing yield types is registered).
   */
  elemValType: ValType;
  /**
   * (#2170) `yield*` delegation slots, in source `siteIndex` order. Each slot is
   * a mutable `ref null $InnerState` field in the state struct that persists the
   * inner generator's state across the outer generator's host re-entries.
   * `innerName` resolves to the inner's `NativeGeneratorInfo` at emit time.
   */
  delegationSlots?: { fieldIdx: number; innerName: string }[];
  /**
   * (#2173 slice-2a) `yield*` delegation over a NUMERIC array / vec (e.g.
   * `yield* [1,2,3]`), in source `vecSiteIndex` order. Each site owns TWO
   * state-struct fields — a `ref null $Vec` holding the materialized iterable
   * and an `i32` cursor — driven like the array for-of fast path: read
   * `vec.data[cursor]` (already f64, no box), re-yield, `cursor++`, until
   * `cursor >= vec.length`. Zero host imports (the #1320 `__iterator` bridge is
   * NOT used — it would leak `__box_number`/`__unbox_number`). `vecTypeIdx` is
   * null only in the defensive unresolved case (the emit arm then completes the
   * generator rather than emit invalid wasm).
   */
  vecDelegationSlots?: {
    vecFieldIdx: number;
    cursorFieldIdx: number;
    vecTypeIdx: number | null;
    arrTypeIdx: number;
    elemType: ValType;
  }[];
  /**
   * (#2173 slice-2b) `yield*` delegation over a GENERIC iterable — a
   * `.values()`/`.keys()`/`.entries()` iterator or a custom
   * `{ [Symbol.iterator]() { return { next() {…} } } }` object, in source
   * `iterableSiteIndex` order. Each site owns ONE `externref` state-struct field
   * holding the `$__IterRec` returned by the standalone-native `__iterator`
   * runtime (`iterator-native.ts`, #2038), driven per resume via
   * `__iterator_next` (also native → zero host imports). Appended AFTER the
   * native-gen and vec delegation slots so neither the f64 `spillFieldOffset`
   * nor the earlier slot field indices are affected (byte-inert for generators
   * without an iterable-delegation site).
   */
  iterableDelegationSlots?: { fieldIdx: number }[];
  /**
   * (#3050) Field index of the i32 pending-completion kind (0 none / 1 return /
   * 2 throw) consumed by a state-lowered finally's exit router. Present only
   * when the generator has a yielding finally (appended LAST in the state
   * struct so all other field indices are unaffected). The completion payloads
   * ride the existing `abrupt` (return value) / `error` (thrown value) fields.
   */
  pendingFieldIdx?: number;
  /**
   * (#3050) Capturing NESTED generator: number of leading synthetic capture
   * params preceding the user params in `paramNames`/`paramTypes` (the state
   * struct stores them as ordinary `param_*` fields). The factory's wasm
   * signature carries them first — call sites already prepend them via
   * `ctx.nestedFuncCaptures`, identical to a lifted capturing function.
   */
  leadingCaptureCount?: number;
  /**
   * (#3050) The subset of leading captures that ride as ref CELLS (mutable /
   * already-boxed captures). The resume function registers each in its
   * `boxedCaptures` so identifier reads/writes inside resume states deref the
   * shared cell — writes propagate to the enclosing frame.
   */
  leadingCaptureCells?: {
    name: string;
    refCellTypeIdx: number;
    valType: ValType;
  }[];
  /**
   * (#3032 W3) TDZ-flag boxes riding as leading synthetic params. Each entry
   * names a TDZ-flagged capture (`name` = the ORIGINAL captured binding) and
   * the index into `paramNames`/`paramTypes` of its `ref $cell<i32>` flag-box
   * param (named `__tdz_box_<name>`, minted by nested-declarations.ts after
   * the value-capture params — the #1205 Stage 3 layout
   * `[valueCaps, tdzFlagBoxes, userParams]`). The resume function registers
   * the rehydrated flag-box local in `boxedTdzFlags` + `tdzFlagLocals` under
   * the original name so TDZ-checked identifier reads inside resume states
   * (`emitLocalTdzCheck`) deref the shared i32 cell, exactly like a lifted
   * capturing closure body.
   */
  leadingTdzFlags?: { name: string; paramIdx: number }[];
  /**
   * (#3302) CAPTURING generator FUNCTION EXPRESSION (lifted closure): the
   * `__self` capture-struct rehydration recipe for the resume function. The
   * lifted closure carries its captures as fields of the closure struct
   * (value captures at fields 1..N — ref cells for mutable ones — and TDZ
   * flag boxes at fields N+1..N+K; closures.ts prologue invariant), and the
   * `__self` ref itself rides the state struct as the single leading capture
   * param (#3164). The resume fn compiles the SAME body statements in a fresh
   * FunctionContext, so it must re-run the closures.ts capture prologue from
   * the rehydrated `__self` local: materialize each entry into a named local,
   * then re-apply the `boxedCaptures` / `boxedTdzFlags` + `tdzFlagLocals`
   * registrations so identifier reads/writes and TDZ checks resolve through
   * the shared cells. Mirrors the async drive lane's re-materialization
   * (async-frame.ts #2865); without it capture resolution falls back to STALE
   * outer-scope local indices — a guaranteed miscompile.
   * `castToTypeIdx` is set when `__self`'s param type is the wrapper base
   * struct (needs a `ref.cast` to the concrete capture struct first).
   */
  selfCaptureRehydration?: {
    selfParamName: string;
    structTypeIdx: number;
    castToTypeIdx: number | null;
    entries: { name: string; fieldIdx: number; localType: ValType }[];
    boxedCaptures: { name: string; refCellTypeIdx: number; valType: ValType }[];
    tdzFlags: { name: string; fieldIdx: number; refCellTypeIdx: number }[];
  };
}

export type NullishExclusion = "null" | "undefined" | "nullish";

export interface NullGuardFact {
  varName: string;
  narrowedBranch: "then" | "else";
  excludes: NullishExclusion;
  provesNonNull: boolean;
}

/**
 * #2682: a recognised canonical string-read loop. `dataLocal` holds the
 * (non-null) `ref $__str_data` i16 array of the once-flattened receiver and
 * `offLocal` its i32 byte offset; `recvName`/`indexName` are the loop-invariant
 * receiver and the in-bounds-proven induction variable. See
 * `FunctionContext.hoistedCharReads`.
 */
export interface HoistedCharRead {
  recvName: string;
  indexName: string;
  dataLocal: number;
  offLocal: number;
}

/** Per-function context. */
export interface FunctionContext {
  /** Function name */
  name: string;
  /**
   * Source-level function represented by this body.  Present only for
   * ECMAScript functions (not compiler/runtime helpers); used by the ES5
   * Function `caller` poison lowering to recognize a self-reference.
   */
  sourceFunction?: ts.FunctionLikeDeclaration;
  /** Source strictness of {@link sourceFunction}. */
  sourceFunctionStrict?: boolean;
  /** Root function body where an activation-entry snapshot must be inserted. */
  callerStrictEntryBody?: Instr[];
  /**
   * Root instruction buffer for source-function activation prologues. Unlike
   * `body`, this remains stable while conditional/loop arms temporarily swap
   * in detached instruction buffers.
   */
  activationEntryBody?: Instr[];
  /** Activation-local snapshot of the immediate caller's source strictness. */
  callerStrictLocalIdx?: number;
  /** Parameters (these are the first N locals) */
  params: { name: string; type: ValType }[];
  /** Additional locals declared in the body */
  locals: LocalDef[];
  /** All local names → index (params first, then locals) */
  localMap: Map<string, number>;
  /**
   * Function-scoped `var` bindings that are also bare `for...in` assignment
   * targets. Their slots must remain externref because the loop writes string
   * keys even when a later declaration initializer is numerically typed.
   */
  forInIdentifierVars?: Set<string>;
  /** Bindings widened because their assignments cross representation domains.
   * Reads keep the boxed carrier; concrete consumers perform coercion at use. */
  mixedAssignmentCarrierVars?: Set<string>;
  /**
   * Callback captures whose ABI deliberately remains externref.  Their
   * checker type may be a concrete array/object, but the value crossed a host
   * callback boundary and must stay dynamically dispatched rather than being
   * narrowed to a WasmGC ref that the host cannot reconstruct reliably.
   */
  captureExternrefNames?: Set<string>;
  /** Return type */
  returnType: ValType | null; // null = void
  /** Accumulated body instructions */
  body: Instr[];
  /** Block depth for br labels */
  blockDepth: number;
  /** Break label depth stack */
  breakStack: number[];
  /** Continue label depth stack */
  continueStack: number[];
  /** Map from label name to break/continue stack indices for labeled break/continue */
  labelMap: Map<string, { breakIdx: number; continueIdx: number }>;
  evalCompletionLocal?: number; // §13 eval completion register — statements/eval-completion-value.ts
  /** Depth for `return` inside generator body -- adjusted by loop/block nesting */
  generatorReturnDepth?: number;
  /** Map from variable name → ref cell info (for mutable closure captures) */
  boxedCaptures?: Map<string, { refCellTypeIdx: number; valType: ValType }>;
  /**
   * Names this lifted nested function receives as leading capture parameters.
   * A sibling-forwarding site must read these names through this function's
   * localMap rather than reusing the declaring frame's outerLocalIdx.
   */
  liftedCaptureNames?: Set<string>;
  /** Stable frame slots for leading captures, retained when a body-local shadows the same name. */
  liftedCaptureSlots?: Map<string, number>;
  /**
   * Source-visible bindings owned by a function whose lexical descendants may
   * perform direct eval. These functions alone promote bindings to the shared
   * boxed-cell carrier; functions without this set remain byte-identical.
   */
  directEvalBindingNames?: Set<string>;
  /**
   * Direct-eval bindings that belong to this activation rather than a captured
   * outer environment. The corresponding cells seed one persistent name/slot
   * vector per Wasm invocation, so sloppy eval-created `var` bindings survive
   * later eval calls in the same activation.
   */
  directEvalActivationBindingNames?: Set<string>;
  /** Names whose canonical cells are capture parameters from outer scopes. */
  directEvalOuterBindingNames?: Set<string>;
  /** Stable activation binding name → canonical cell local. */
  directEvalActivationBindings?: Map<string, number>;
  /**
   * Hidden caller-owned flat state pool for eval-created activation vars.
   * One nullable externref local persists for the Wasm invocation and is
   * lazily filled with the provider ABI's 256 ref-cell carriers.
   */
  directEvalActivationStatePoolLocal?: number;
  /** Canonical `(mut externref)` cell type used at the AOT↔interpreter seam. */
  directEvalRefCellTypeIdx?: number;
  /**
   * (#3121) Names whose local slot was PROMOTED to a module global by
   * `promoteAccessorCapturesToGlobals` (object-literal method / accessor /
   * class-body capture). The promotion deletes the name from `localMap` so
   * every subsequent reference in this function resolves through the promoted
   * global (`ctx.capturedGlobals` / `ctx.capturedBoxGlobals`) — the SAME store
   * the method body reads and writes. The orphaned slot still exists in
   * `fctx.locals`, so the #1177 block-shadow rescan in `compileArrowAsClosure`
   * must NOT resurrect it: capturing the stale slot forks the binding into a
   * second store (a fresh ref cell over a dead local) that the method's
   * global-routed writes never reach. Recorded per-fctx (not by bare name on
   * ctx) so an unrelated same-named local in another function is unaffected.
   */
  promotedCaptureNames?: Set<string>;
  /**
   * (#3128) Function-expression / arrow nodes INLINED into this function's
   * body by the IIFE-inlining path (calls.ts). Their AST function boundary
   * does NOT exist in the emitted Wasm — their locals live in THIS fctx's
   * frame. The closure capture-mutability analysis (`compileArrowAsClosure`
   * `writtenInOuter`) must walk PAST these nodes when locating the enclosing
   * scope: a closure nested inside an inlined IIFE that captures a var of the
   * REAL enclosing function would otherwise scan only the IIFE body, miss the
   * outer write, and capture the var BY VALUE — a stale copy the outer
   * assignment never reaches (`p2 = (function(){ return () => p2; })()`).
   */
  inlinedIifeNodes?: Set<ts.Node>;
  /**
   * (#2865) The `__self` capture-struct layout of a LIFTED CLOSURE body
   * (closures.ts materializes each capture from `__self` field `i+1` into a
   * named local in the body prologue). The async drive lane compiles the body
   * in a FRESH resume FunctionContext whose frame captured only the closure's
   * PARAMS — so the resume prologue must re-materialize these capture locals
   * from the frame-captured `__self` before any body statement compiles.
   * `castToTypeIdx` is set when `__self`'s param type is the wrapper base
   * struct (needs a `ref.cast` to the concrete capture struct first).
   */
  selfCaptureLayout?: {
    selfParamName: string;
    structTypeIdx: number;
    castToTypeIdx: number | null;
    entries: { name: string; fieldIdx: number; localType: ValType }[];
  };
  /**
   * (#2976) Per-activation memo locals for capture-carrying nested function
   * declarations referenced as VALUES: funcName → local holding the
   * closure instance. References lazily fill it once, preserving identity and
   * making sidecar/static writes visible at every subsequent reference.
   * Lazy initialization retains first-dynamic-reference capture semantics.
   */
  nestedFnClosureMemos?: Map<string, number>;
  /** Function-declaration bindings materialized once because their Function identity is observable. */
  hoistedFunctionValueBindings?: Set<string>;
  /** Hoisted Function bindings whose singleton closure has been emitted in this frame. */
  materializedHoistedFunctionValueBindings?: Set<string>;
  /** Hoisted Function bindings currently constructing a mutually recursive closure value. */
  materializingHoistedFunctionValueBindings?: Set<string>;
  /** Whether this function is a class constructor (for new.target support) */
  isConstructor?: boolean;
  /**
   * (#4464) This is a synthesized `new F()` body for a plain FUNCTION
   * constructor ("fnctor"), not a `class` constructor.
   *
   * It exists as a SEPARATE bit from {@link isConstructor} on purpose. The
   * §10.2.1.3 step-13 return rule (an Object return overrides `this`; a
   * primitive / bare return is discarded and `this` is the result) applies to
   * both, and the fnctor body never had it — so `function F(){ this.x=1;
   * return true }` fell through to the generic value-return path, which pushed
   * a `ref.null $__fnctor_F` and the `new` site trapped "dereferencing a null
   * pointer" (`S13.2.2_A6_T2`, `_A7_T1`, `_A8_T1/T2`). But `isConstructor` ALSO
   * gates `new.target`, whose lowering reads a class-id global that no fnctor
   * `new` site writes; reusing it would silently swap `new.target === undefined`
   * for a stale class id. One bit per question.
   */
  isFnctorConstructor?: boolean;
  /**
   * (#4464) Local index of the constructed `this` receiver when the
   * construction result is an EXTERNREF object rather than a nominal struct —
   * the `new function(){…}` FunctionExpression lowering. Set ⇒
   * `compileReturnStatement` applies §10.2.1.3 step 13 with a RUNTIME
   * Type(V)-is-Object probe (`__typeof_object`/`__typeof_function`), because
   * the operand's type here is a runtime property, not a static one.
   */
  constructThisExternLocal?: number;
  /** Whether this constructor belongs to a class declared with `extends`. Spec §10.2.1.3
   * step 13c requires a derived constructor that returns a non-object, non-undefined
   * value to throw TypeError instead of silently coercing and null-dereffing. */
  isDerivedConstructor?: boolean;
  /** Whether this function is a generator (function*) */
  isGenerator?: boolean;
  /**
   * #3509 — This is an ordinary lifted closure whose body is deferred until
   * invocation. Standalone dynamic import may compile to an in-module runtime
   * trap in this body instead of rejecting closure creation. Async/generator
   * closures deliberately leave this unset because their Promise/lazy-throw
   * semantics require separate substrate.
   */
  deferredDynamicImportTrap?: boolean;
  /**
   * (#2007/#1448) Set once a closure-allocating array method
   * (`map`/`filter`/`flatMap`/`forEach`/`reduce`/`find`/`sort`) has been
   * lowered in this function body. The standalone vec-concat join fast-path
   * (`tryCompileNativeVecConcatOperand`) reads it: once such a method has
   * emitted its closure setup, a LATE `number_toString` registration triggered
   * by the join would `addUnionImports`-shift and corrupt the already-emitted
   * closure code (a pre-existing hazard `a.join(",")` also exhibits). So the
   * join falls back to `$__any_to_string` ("[object Object]", the baseline
   * behaviour) when this flag is set — no regression.
   */
  emittedClosureArrayMethod?: boolean;
  /**
   * (#2895 PATH B) Set while emitting a host-free async **resume** function body
   * (`__async_resume_f<name>`). When present, `return v` settles the frame's
   * result `$Promise` (`__promise_fulfill(resultPromise, v)`) and emits a void
   * `return`, instead of the generic value-return — the resume function returns
   * void; the async result is delivered through the promise. Mirrors the
   * `isGenerator` `return` arm. Undefined on every non-resume body.
   */
  asyncDriveReturn?: {
    /** Local holding the frame's result `$Promise` (loaded at resume entry). */
    resultPromiseLocal: number;
    /** `$Promise` struct typeIdx. */
    promiseTypeIdx: number;
    /** `__promise_fulfill(promise, value) -> value` funcIdx. */
    fulfillFuncIdx: number;
    /**
     * (#2906 3c-ii) The ACTIVE handler region's await-free finalizer at the
     * lead statement currently being compiled — set/cleared per-lead by
     * `buildStateBody`. A `return v` compiled while this is non-empty replays
     * it between evaluating `v` and settling (return-through-finally). Cleared
     * during the replay itself so a `return` INSIDE the finally settles
     * directly (the finally's completion overrides, §14.15.3).
     */
    pendingFinalizer?: readonly ts.Statement[];
    /**
     * (#2906 3c-ii) The `__async_in_try` region-id local. The replay resets it
     * to 0 first so a throw INSIDE the replayed finally does not re-enter the
     * same region's catch/finalizer (mirrors the inline finally leads, which
     * are flagged not-in-try).
     */
    handlerLocal?: number;
  };
  /** Set of variable names that are read-only bindings (e.g. named function expression name) */
  readOnlyBindings?: Set<string>;
  /** Set of variable names that are const bindings — assignment throws TypeError at runtime */
  constBindings?: Set<string>;
  /** Stack of saved body arrays for addUnionImports index shifting */
  savedBodies: Instr[][];
  /**
   * Raw `__argc` cached at function entry for parameter defaults. Defaults need
   * to clear the global before initializer expressions can make nested calls;
   * `arguments` construction reuses this local when both features are present.
   */
  argcCachedLocal?: number;
  /** Set of function names successfully hoisted during THIS function body's hoisting pass */
  hoistedFuncs?: Set<string>;
  /** Enclosing class name — propagated to closures for super keyword resolution */
  enclosingClassName?: string;
  /**
   * (#1395) True when compiling a static class member context (static field
   * initializer, static method body, or a closure spawned from inside one).
   * In a static context, `this` resolves to the class constructor object
   * (the `__class_<Name>` singleton), NOT to a per-instance struct. Per
   * ECMA-262 §15.7.1.1 step 5.b, DefineField is called with the class as
   * receiver for static fields, so `this` inside `static f = () => this`
   * is the class itself. Propagated through closure spawning the same way
   * `enclosingClassName` is.
   */
  isStaticContext?: boolean;
  /**
   * (#1636-S1) True only for closure bodies that can be dispatched from the
   * host via `__call_fn_method_N` (lifted free closures and anonymous
   * callbacks passed to e.g. `JSON.stringify`'s replacer / a value's
   * `toJSON`). Those dispatchers install the host-supplied receiver into the
   * `__current_this` module global before the inner `call_ref`, so the
   * closure's `this` must read that global when it has no other binding.
   *
   * Named function declarations, methods, and constructors are NOT dispatched
   * through `__call_fn_method_N` — they are called directly via `call $f`,
   * where `__current_this` is never installed for them. They must keep the
   * spec-correct `undefined` (strict) / globalObject (sloppy) `this`, so they
   * must NOT read `__current_this`. The flag gates the fallback to exactly the
   * bodies that can observe a host-installed receiver. Without it, every
   * `this` in a free function in any module that emits a closure regressed to
   * the global's `ref.null.extern` initial value (#1636-S1 regression: 171
   * test262 failures in `function-code/10.4.3-1-*` and `Array/prototype/*`).
   */
  readsCurrentThis?: boolean;
  /** While lowering a compile-time direct-eval Script, an otherwise absent
   * receiver in a sloppy caller denotes the realm global object. This is
   * scoped to the foreign eval AST so ordinary strict/direct-call `this`
   * lowering keeps its existing behavior. */
  directEvalSloppyThisFallback?: boolean;
  /** Set of variable names known to be non-null in the current scope (type narrowing) */
  narrowedNonNull?: Set<string>;
  /**
   * (#3315) Parameter array-pattern bindings widened from a scalar checker
   * type (f64) to an undefined-preserving externref local — see
   * `resolveBindingElementType`. Identifier reads of these names must NOT
   * apply the checker-type unbox narrowing (the checker type is the pattern
   * default's fiction; unboxing would degrade a runtime `undefined` to NaN
   * before any `=== undefined` / `typeof` observation). Reads return the raw
   * externref; numeric consumers coerce per ToNumber at their own use site.
   */
  undefWidenedLocals?: Set<string>;
  /** Const boolean aliases for null guards, e.g. `const ok = x !== null`. */
  nullGuardAliases?: Map<string, NullGuardFact>;
  /** Variables narrowed through a const boolean null-guard alias in the active branch. */
  aliasedNullGuardNonNull?: Set<string>;
  /**
   * Set of "arrayVar:indexVar" keys where bounds checks can be elided.
   * Populated when a for-loop condition guarantees indexVar < arrayVar.length.
   */
  safeIndexedArrays?: Set<string>;
  /**
   * Exact `arr.push(value)` calls whose immediately preceding empty literal was
   * preallocated from the same canonical counted-loop proof. Capacity and
   * receiver-null checks are redundant only at these AST nodes.
   */
  presizedArrayPushCalls?: Map<ts.CallExpression, number>;
  /**
   * Const `split()` results proven to be observed only through `.length`.
   * The declaration stores the uniform field count as i32 instead of
   * materializing a transient string array; property access resolves by symbol.
   */
  derivedStringArrayLengthLocals?: Map<ts.Symbol, number>;
  /** Static split arrays whose identity and elements are observed only by proven nested length reads. */
  derivedStaticSplitArrays?: Map<ts.Symbol, { length: number }>;
  /** Scalar descriptors for const derived strings with no identity escape. */
  derivedSubstringReads?: Map<
    ts.Declaration,
    | { kind: "native" | "lower" | "upper"; dataLocal: number; offLocal: number; lenLocal: number; minLen: number }
    | { kind: "host"; receiverLocal: number; offLocal: number; lenLocal: number; minLen: number }
  >;
  /**
   * #2682: per-loop proofs for the canonical string-read hot loop
   * `for (let i = 0; i < recv.length; i++) … recv.charCodeAt(i) …`.
   *
   * Keyed by the (loop-invariant) string receiver identifier name. When an
   * entry is present, the loop has been recognised by
   * `detectCanonicalCharReadLoop` (statements/loops.ts): the receiver was
   * flattened ONCE before the loop and its `.data`/`.off` descriptor hoisted
   * into the listed locals, and `i` is PROVEN in-bounds (`0 <= i < len`) at
   * every body point (init >= 0, strict `<`, monotonic step, `i`/`recv` not
   * mutated, no capturing closure). `recv.charCodeAt(i)` reads then lower to a
   * direct i32 `array.get_u(dataLocal, offLocal + i)` with NO per-call flatten,
   * NO struct.get reload, and NO OOB/NaN branch (the branch is dead under the
   * proof — byte-identical to the guarded read). Native-string mode only.
   * Scoped save/restore around the loop body exactly like `safeIndexedArrays`.
   */
  hoistedCharReads?: Map<string, HoistedCharRead>;
  /**
   * #1120: Set of let/const locals whose lifecycle is fully constrained
   * to int32 by explicit `| 0` (or other bitwise) coercion. These get
   * allocated as i32 instead of f64, and the binary-op layer can use
   * native i32 arithmetic for `(a + b) | 0`-style updates without the
   * heavy f64 -> ToInt32 -> f64 round-trip.
   */
  i32CoercedLocals?: Set<string>;
  /**
   * (#3123) let-bindings declared as a fnctor-subclass class instance
   * (`class C extends F`, F a top-level plain function) that are REASSIGNED
   * with a value of another static type — at runtime they can hold a HOST
   * object (e.g. `iterator = iterator.drop(0)` stores the Iterator-helper
   * wrapper minted by F's live prototype methods). The pre-hoist allocator
   * widens their slot to externref (a `(ref $C)` slot would null the host
   * value through the guarded cast), and the class-method-call ladder
   * dispatches member calls on them DYNAMICALLY (`__extern_method_call`) so
   * the runtime value — struct instance or host object — decides.
   */
  fnctorWidenedLocals?: Set<string>;
  /**
   * #1197: Set of let/const locals declared as `number[]` whose element
   * storage can safely lower to `i32` instead of `f64` (every write site is
   * provably i32-shaped, every use is a whitelisted access pattern, no
   * closure capture). The variable-declaration codegen consults this set
   * to pick the `__vec_i32` vec type at allocation time.
   */
  i32SpecializedArrays?: Set<string>;
  /**
   * Free list for temporary locals, keyed by ValType key string.
   * Used by allocTempLocal/releaseTempLocal to reuse locals of the same type.
   */
  tempFreeList?: Map<string, number[]>;
  /**
   * Stack of statically-proven `with` scopes (#1387). Each entry is a closed
   * object-literal target compiled into a local. Identifier lowering consults
   * this stack innermost-first and rewrites proven own-property bindings to
   * direct struct field access.
   */
  withScopes?: (
    | {
        // (#1387) Tier-1 static entry: a closed object-literal target compiled
        // into a local; bare names matching a field route to direct struct
        // get/set.
        kind: "static";
        /** Hidden by-reference closure capture selected by ir/with-environment. */
        captureName: string;
        localIdx: number;
        structTypeIdx: number;
        fields: FieldDef[];
        blockedNames: Set<string>;
      }
    | {
        // (#2663 Slice 1) Tier-2 dynamic entry: the `with` target is an
        // arbitrary externref. Bare names are resolved at runtime via a
        // HasBinding gate (`__extern_has`) + `Get` (`emitDynGet`), falling back
        // to the outer lexical lowering when absent.
        kind: "dynamic";
        /** Hidden by-reference closure capture selected by ir/with-environment. */
        captureName: string;
        localIdx: number;
        blockedNames: Set<string>;
      }
  )[];
  /** Map from let/const local variable name → local index of its i32 TDZ flag (0 = uninitialized) */
  tdzFlagLocals?: Map<string, number>;
  /**
   * (#2814) Per-declaration record of the value (and optional TDZ-flag) slot that
   * `walkStmtForLetConst` pre-allocated for a `let`/`const` at the *function*
   * level. Keyed by the declaration node so it is unique to that exact binding.
   *
   * Used by `compileVariableStatement` to fix the duplicate-local desync (Bug C):
   * a block-scoped `let` captured by a *hoisted FunctionDeclaration* records its
   * capture against this pre-hoisted slot, but `saveBlockScopedShadows` then
   * deletes the slot on block entry and the `let` re-allocates a fresh one — so
   * the capture reads the stale (never-written) slot → null. When the slot is the
   * block-let's OWN pre-hoisted slot (the pre-pass only allocates a name absent
   * from `localMap` ⇒ no genuine outer/param/var shadow), the declaration reuses
   * it instead of re-allocating, re-aligning value-slot == capture-slot.
   * Genuine shadows are *skipped* by the pre-pass, so they are never recorded
   * here and keep re-allocating a fresh slot (correct lexical shadowing).
   */
  preHoistedLetConstSlots?: Map<ts.VariableDeclaration, { valueSlot: number; flagSlot?: number }>;
  /**
   * (#2200 Annex B B.3.3 Phase 1) Block-nested `function F` declarations whose
   * web-compat outer var-binding is *cancelled* by an intervening lexical
   * (`let`/`const`/class) shadow or a same-named parameter. Maps the function
   * name → the source-position range(s) of the block(s) that declare it. A read
   * of `F` OUTSIDE every such block must NOT resolve to the block-local function
   * (it has no outer binding) and instead throws ReferenceError; a read INSIDE
   * the declaring block still resolves normally. Normally empty — the read-site
   * guard in `compileIdentifier` is gated on `.has(name)`, so non-Annex-B
   * modules stay byte-identical.
   */
  annexBCancelled?: Map<string, Array<{ start: number; end: number }>>;
  /**
   * (#2200 Annex B B.3.3 Phase 2) Block-nested `function F` declarations that ARE
   * eligible for the web-compat outer var-binding (no cancelling shadow/param).
   * The outer binding is pre-allocated as a TDZ var (`localMap[F]` + a
   * `tdzFlagLocals[F]` flag, zero-init = uninitialised); it is assigned the
   * function value + flag←1 at the declaration's textual position (so it only
   * initialises when control reaches the block). Membership gates the
   * declaration-site init and the `typeof F` runtime-flag branch; normally empty,
   * so non-Annex-B function decls are byte-identical.
   */
  annexBOuterBindings?: Set<string>;
  /**
   * Subset of `annexBOuterBindings` whose name is shared by multiple eligible,
   * capture-free declaration sites in the same var scope. Direct calls for
   * these names must dispatch through the live outer-binding local because the
   * executed branch, rather than the name-keyed funcMap winner, determines the
   * callee.
   */
  annexBRepeatedOuterBindings?: Set<string>;
  /**
   * Annex B declarations whose enclosing function already has a direct
   * same-name FunctionDeclaration. Unlike `annexBOuterBindings`, these bindings
   * are initialized at function entry with the direct declaration's closure and
   * carry no TDZ flag; evaluating the nested declaration replaces that live
   * value without changing the canonical name-keyed hoist owner.
   */
  annexBExistingDirectFunctionBindings?: Set<string>;
  /**
   * For TDZ flag locals that have been boxed in an i32 ref cell so that
   * mutations propagate to closures that captured the flag (#1177).
   *
   * Each entry records the ref-cell struct type idx and the local index of
   * the ref-cell ref. Once a name is in this map, ALL set/get of its TDZ
   * flag must go through `struct.get` / `struct.set` on the ref cell —
   * `emitLocalTdzCheck` and `emitLocalTdzInit` detect this map before
   * falling back to raw i32 local access.
   *
   * Note: when an entry exists here, `tdzFlagLocals[name]` continues to
   * point at the SAME local index (the boxed ref-cell ref local).  We
   * preserve the old map so call-site checks (calls.ts) keep firing.
   */
  boxedTdzFlags?: Map<
    string,
    {
      refCellTypeIdx: number;
      localIdx: number;
      /**
       * (#4394) The RAW i32 flag local the box was built from, when it was
       * built from a verified live flag. Reuse sites are not dominated by the
       * site that teed `localIdx` (deepEqual.js `format` builds the box in its
       * first `return lazyResult…` branch; sibling branches read it null), so
       * they re-init the box lazily from this source when `localIdx` is null.
       */
      srcFlagIdx?: number;
    }
  >;
  /**
   * (#3546) Locals in `__module_init` that SHADOW a module-global binding for a
   * top-level closure declaration (`const/let/var f = () => …` at module
   * level): name → the shadow local's index. The declaration dual-stores
   * (local + `$__mod_<name>` global); a later TOP-LEVEL reassignment resolves
   * to the local via `localMap` and would otherwise update only the shadow —
   * every OTHER function's read/call of the binding goes through the global,
   * which silently kept the FIRST closure. Assignment's local arm consults
   * this map (exact name→index match, so genuine function-locals and
   * block-scoped shadows never match) and re-syncs the global after the local
   * write.
   */
  moduleBindingShadowLocals?: Map<string, number>;
  /**
   * Stack of catch rethrow info. Each entry tracks a catch variable name and the
   * current depth (number of block-like structures) from the catch boundary.
   */
  catchRethrowStack?: { varName: string; depth: number; exnLocalIdx?: number }[];
  /**
   * Stack of pending finally blocks. When a return/break/continue exits a try
   * block that has a finally clause, the finally instructions must be inlined
   * before the control-flow transfer.
   */
  finallyStack?: {
    cloneFinally: () => Instr[];
    breakStackLen: number;
    continueStackLen: number;
    /**
     * Clone the finally body and bump every `br`/`br_if`/`br_table` in it that
     * targets a label OUTSIDE the finally body by `extraDepth`. The pre-compiled
     * finally was lowered at the try-frame depth (+1); inlining it at an
     * abrupt-completion site nested deeper than the try frame (inside an
     * `if`/`switch`/inner-`try` within the try) requires bumping those
     * outer-targeting branches by the extra nesting delta. (#2061)
     */
    cloneFinallyAtDepth: (extraDepth: number) => Instr[];
    /**
     * Snapshot of `breakStack` taken when this entry was pushed (i.e. at the
     * try-frame depth). At an inline site the nesting delta is
     * `current breakStack value − this snapshot value` for any outer label
     * (every label op bumps all outer entries uniformly, so the delta is the
     * same across entries). (#2061)
     */
    breakDepthBaseline: number[];
    /** Snapshot of `continueStack` at push time — see `breakDepthBaseline`. (#2061) */
    continueDepthBaseline: number[];
  }[];
  /**
   * Number of enclosing `try` blocks WITH a catch clause currently being
   * compiled. Wasm `return_call` replaces the caller frame, so a callee's
   * throw would unwind past the enclosing handler — the tail-call rewrite
   * must be suppressed while this is > 0, exactly like `finallyStack`
   * suppresses it for pending finally blocks. (#1972)
   */
  tryCatchDepth?: number;
  /**
   * Pending writeback instructions for mutable callback captures (#859).
   */
  pendingCallbackWritebacks?: Instr[];
  /**
   * Persistent writeback instructions for getter/setter callbacks (#929).
   * Unlike pendingCallbackWritebacks (one-shot), these are re-emitted after
   * every call expression so that mutations from deferred callback invocations
   * (e.g. Object.defineProperty getter called later by Object.defineProperties)
   * are reflected in the outer scope's local variables.
   */
  persistentCallbackWritebacks?: Instr[];
  /**
   * Mapped arguments info for non-strict functions with simple parameters (#849).
   */
  mappedArgsInfo?: {
    argsLocalIdx: number;
    arrTypeIdx: number;
    vecTypeIdx: number;
    paramCount: number;
    paramOffset: number;
    paramTypes: ValType[];
    /** Persistent per-activation name/null vector shared with runtime direct
     * eval. The interpreter nulls an entry when delete/defineProperty severs
     * that arguments-index mapping; later AOT sync sites consult the same
     * vector instead of resurrecting the correspondence. */
    runtimeMappedNamesLocalIdx?: number;
    /**
     * Argument indices whose param↔arguments mapping has been severed at
     * compile time (#1511). Per ECMA-262 §10.4.4.2, a `defineProperty` that
     * makes a mapped slot non-writable (or turns it into an accessor) or a
     * `delete arguments[i]` removes the link: later parameter writes must no
     * longer reflect into `arguments[i]` and vice-versa. The mapped-sync
     * emitters consult this set and skip severed indices. Populated lazily
     * during body codegen — order matters, since the emitters read it live.
     */
    unmappedIndices?: Set<number>;
    /**
     * Argument indices made non-configurable via a statically-resolvable
     * `Object.defineProperty(arguments, "<i>", { configurable: false })`
     * (#2667). Per ECMA-262 §10.4.4.5 + OrdinaryDelete, `delete arguments[i]`
     * on a non-configurable index must return `false` and leave the property
     * (and its param mapping) intact. The delete emitter consults this set so
     * the statically-known case reports the spec-correct result without a
     * runtime descriptor-sidecar round-trip. Populated lazily during body
     * codegen; read live, so codegen order matters.
     */
    nonConfigurableIndices?: Set<number>;
    /**
     * Argument indices made non-writable via a statically-resolvable
     * `Object.defineProperty(arguments, "<i>", { writable: false })` (#2667).
     * Per ECMA-262 §10.4.4.2, a non-writable data property rejects later
     * `arguments[i] = x` writes (and the write-back into the param). The
     * element-assignment emitter consults this set to drop such writes.
     * (Setting `writable:false` also severs the param↔arguments map, so the
     * index is additionally added to `unmappedIndices`.)
     */
    nonWritableIndices?: Set<number>;
    /**
     * Argument indices whose `Object.defineProperty(arguments, "<i>", …)` was
     * routed to the RUNTIME define (#4491) — an accessor, a `writable:false`
     * data descriptor, or any shape the inline mapped fast path declines. That
     * route records a real descriptor in the sidecar, which from then on is the
     * authority for the index; the inline fast path writes only the opaque vec
     * slot, so taking it afterwards would leave the two disagreeing (a later
     * `{value: 20}` updated `arguments[0]` while `getOwnPropertyDescriptor`
     * still reported the old value). Consulted by the fast-path predicate.
     */
    runtimeDefinedIndices?: Set<number>;
  };
  /**
   * #1210: bindings detected as `let s = ""; for (...) s += <expr>` builders
   * whose storage should be rewritten to a doubling i16-array buffer at
   * compile time. Populated by `detectStringBuilders` during the
   * function-body pre-scan, BEFORE `hoistLetConstWithTdz` runs (so the
   * hoist pass can skip pre-allocating these decls' locals).
   */
  pendingStringBuilders?: Set<ts.VariableDeclaration>;
  /**
   * #1761: presize info for those `pendingStringBuilders` whose final length
   * is a provably runtime-known linear function of a loop bound. Keyed by the
   * same declaration node. When present at the init site, the buffer is
   * allocated once at `bound * unitsPerIter` and the append sites drop the
   * per-append cap-check. Populated by `detectStringBuilders` (presize out-param).
   */
  stringBuilderPresize?: Map<
    ts.VariableDeclaration,
    {
      boundExpr: ts.Expression; // loop-invariant bound, evaluated once at init
      unitsPerIter: number; // constant code-units appended per iteration
    }
  >;
  /**
   * #1210: live string-builder bindings keyed by binding name. While
   * present, `s += <expr>` routes to `compileStringBuilderAppend`
   * (in-place buffer write), and identifier reads materialize a fresh
   * `$NativeString` view of the current buffer state via
   * `emitStringBuilderRead`.
   */
  stringBuilders?: Map<
    string,
    {
      bufLocalIdx: number; // ref_null $__str_data — the growable i16 buffer
      lenLocalIdx: number; // i32 — current logical length
      capLocalIdx: number; // i32 — current physical capacity (== buf.length)
      materializedLocalIdx: number; // ref_null $AnyString — reserved for future cache
      presized?: boolean; // #1761: true when buffer presized; appends skip cap-check
    }
  >;
  /**
   * #1886 Slice B — live linear-backed `Uint8Array` buffers in this function. A
   * buffer proven linear-safe by the #1886 analysis
   * (`ctx.linearUint8.safeBindings`) is represented as a `(ptr, len)` pair of
   * i32 locals instead of a GC vec, so `buf[i]`, `buf.length`, and
   * `process.std*.{read,write}(buf)` operate on linear memory with zero
   * GC↔linear copies. Absent entry ⇒ the binding uses the existing GC-vec path
   * unchanged.
   *
   * #2045: keyed by the binding's `ts.Symbol`, NOT by identifier text. A
   * name-keyed registry was scope-blind — a linear param `buf` plus an
   * inner-block `const buf = new Uint8Array(...)` (a distinct symbol with the
   * same name) collided, so element access addressed the wrong buffer in both
   * shadowing directions (silent corruption). Symbol identity is scope-correct.
   */
  linearU8Buffers?: Map<
    ts.Symbol,
    {
      ptrLocalIdx: number; // i32 — base byte offset into the page-4 linear arena
      lenLocalIdx: number; // i32 — element length (== byte length for Uint8Array)
    }
  >;
  /** #1886 — function-entry arena mark for rewinding short-lived linear-U8 locals. */
  linearU8ArenaMarkLocalIdx?: number;
  /**
   * #2660 PART-1 — the WasmGC struct name (`__fnctor_<Name>` / class-struct key
   * in `ctx.structMap`) that a lifted method's `this` receiver resolves to, when
   * statically known. Populated by the #2681 syntactic prototype-alias resolver
   * (`resolveLiftedMethodThisStruct`, owned by the PART-2 dispatch slice) when a
   * function is lowered as a `Class.prototype.m = function(){}` (or aliased
   * `var pp = Class.prototype; pp.m = …`) method, so the dynamic `this.<field>`
   * read/write/compound dispatch can pin to that one struct instead of the
   * open-scan `findAlternateStructsForField`.
   *
   * **Read by `resolveReceiverStruct` case (1)** (the analysis-layer provider in
   * `fnctor-escape-gate.ts`). **INERT in PART-1**: this slice only DECLARES the
   * field; nothing in PART-1 sets it and `resolveReceiverStruct` is not yet
   * called by any lowering, so emitted Wasm is byte-identical. PART-2 wires the
   * setter + the consuming read/write/compound emitters.
   */
  thisStructName?: string;
  /**
   * (#3683 S2) Set ONLY on a typed-`this` TWIN body — the second compilation of
   * an admitted fnctor prototype method, whose prologue has already cast
   * `__current_this` down to this struct and parked it in
   * {@link typedThisLocalIdx}. When present, a `this.<field>` read / write /
   * compound-update on a PLAIN (non-presence-tracked, non-accessor) field of
   * this struct lowers to a bare `struct.get`/`struct.set` against that local,
   * returning the FIELD's ValType — instead of the `__get_member_<name>` /
   * `__set_member_<name>` dispatcher call plus the externref box/unbox
   * round-trip the generic body needs for a dynamic `this`. Every OTHER
   * construct inside the twin keeps its dynamic lowering (`this` as a value
   * still reads `__current_this`, which the generic body's `ref.test` shim
   * guarantees holds this instance).
   */
  typedThisStructIdx?: number;
  /** (#3683 S2) `ctx.structFields` key for {@link typedThisStructIdx}. */
  typedThisStructName?: string;
  /** (#3683 S2) Local holding the once-cast `(ref $__fnctor_F)` receiver. */
  typedThisLocalIdx?: number;
}

export interface CodegenContext extends StandaloneCapabilityDemandState, BodyRouteAudit.Context {
  mod: WasmModule;
  /**
   * Immutable target/provider/interop policy resolved once at context creation.
   * New policy decisions read this profile instead of reconstructing a target
   * lane from the compatibility booleans below (#4396).
   */
  targetProfile: CompileTargetProfile;
  programAbiSession?: import("../program-abi-session.js").ProgramAbiSession;
  programAbiModuleInitCallables?: import("../program-abi-module-init-planning.js").ProgramAbiModuleInitCallableRegistry;
  programAbiSourceCallables?: import("../program-abi-source-callable-planning.js").ProgramAbiSourceCallableRegistry;
  programAbiCallableImports?: import("../program-abi-import-planning.js").ProgramAbiCallableImportRegistry;
  programAbiCallableProviders?: import("../program-abi-provider-planning.js").ProgramAbiCallableProviderRegistry;
  programAbiClassCallables?: import("../program-abi-class-callable-planning.js").ProgramAbiClassCallableRegistry;
  programAbiCallables?: import("../program-abi-callable-planning.js").ProgramAbiCallableRegistry;
  programAbiGlobals?: import("../program-abi-global-planning.js").ProgramAbiGlobalRegistry;
  programAbiExports?: import("../program-abi-export-planning.js").ProgramAbiExportRegistry;
  programAbiTypes?: import("../program-abi-type-planning.js").ProgramAbiTypeRegistry;
  irPlanningIdentityContext?: import("../../ir/planning-identity.js").IrPlanningIdentityContext;
  /** Exact prepared class-body routing retained while nested bodies compile in scope. */
  irClassBodyRouting?: import("../class-bodies.js").ClassBodyCompileRouting;
  checker: ts.TypeChecker;
  /** True when the single-file input is an ECMAScript Module goal. Script-goal
   * module init uses the host global object for top-level `this`; module goal
   * keeps top-level `this` undefined (#3365). */
  sourceIsModule: boolean;
  /**
   * (#1930) THE type-query boundary. Prefer `ctx.oracle` over raw
   * `ctx.checker` in ALL new code — the oracle-ratchet CI gate fails on
   * growth of direct checker usage under src/codegen/. Registry-free,
   * side-effect-free, memoized; returns TypeFact (never ts.Type). The
   * codegen-side fact→ValType adapter performs registration separately.
   */
  oracle: TypeOracle;
  /**
   * (#684) Usage-based `any`-local inference oracle. Checker-layer pre-pass that
   * answers "can this boxed-`any` local declaration be lowered to an unboxed
   * f64?" — see `src/checker/usage-inference.ts`. Consulted at the local-slot
   * minting sites (var hoister, let/const hoister, `localTypeForDeclaration`).
   * Gated by `useUsageInfer`.
   */
  usageInference: UsageInference;
  /** (#684) Master switch for `usageInference`. Default true. */
  useUsageInfer: boolean;
  /** Map from function name to its absolute index (imports + locals) */
  funcMap: Map<string, number>;
  /** Source-qualified realm builtins whose names may also occur in package
   * modules. Kept separate from funcMap so a user function named parseInt does
   * not steal a call through an ambient-builtin alias. */
  ambientBuiltinFuncMap: Map<string, number>;
  /** Exact IR artifact identity to its allocator-owned defined-function object. */
  irUnitFuncMap: Map<IrUnitId, WasmFunction>;
  /** Map from struct/interface name to type index */
  structMap: Map<string, number>;
  /** Reverse map from type index to struct/interface name (O(1) reverse lookup) */
  typeIdxToStructName: Map<number, string>;
  /**
   * (#3921 follow-up) Shared zero-length backing-store global per array type
   * — see `empty-vec-store.ts`. Lazily populated.
   */
  sharedEmptyVecGlobals?: Map<number, number>;
  /** Map from struct name to field info */
  structFields: Map<string, FieldDef[]>;
  /** (#2853 park fix) Struct type indices that MUST NOT be nominally branded by
   *  the shape-brand finalize pass, because a trapping guarded downcast between
   *  two same-layout sibling `__anon_*`/`__fnctor_*` shapes was emitted for them
   *  (e.g. a `var` reassigned across different-key object literals). Branding
   *  them would separate previously-canonically-equal types → the baked
   *  `ref.test`/`ref.as_non_null` narrowing would trap. Excluding them reverts
   *  those shapes to exact pre-brand baseline behaviour (test262-safe). */
  noBrandShapeTypes: Set<number>;
  /** Number of imported functions */
  numImportFuncs: number;
  /** wasm:js-string import indices — separate from funcMap to prevent
   *  user-defined functions from shadowing them (#1072). */
  jsStringImports: Map<string, number>;
  /** Current function context (set during function compilation) */
  currentFunc: FunctionContext | null;
  /** Stack of parent function contexts saved during nested closure compilation. */
  funcStack: FunctionContext[];
  /** Errors accumulated during codegen */
  errors: CodegenError[];
  /**
   * #2089 — silent-fallback telemetry counters (per class → per site → count).
   * Populated by `reportSilentFallback` (fallback-telemetry.ts) at instrumented
   * fallback sites; aggregated by `scripts/check-codegen-fallbacks.ts` into the
   * baseline. Phase 0 is pure telemetry — no behavior depends on these counts.
   */
  fallbackCounts: FallbackCounts;
  /**
   * #2089 — when true, every `reportSilentFallback` also pushes a warning
   * diagnostic (in addition to counting). Off by default; the gate script and
   * `JS2WASM_LOG_CODEGEN_FALLBACKS=1` turn it on.
   */
  trackSilentFallbacks?: boolean;
  /** (#2119) Infer module-strictness (→ unmapped arguments) from a genuine
   *  top-level import/export. Default true; test262 script tests pass false. */
  inferModuleStrictArguments?: boolean;
  /**
   * #1923 — captured IR post-claim demotions (build/verify/lower/backend-
   * legality failures on a function the selector claimed, which fall back to
   * legacy through the warning channel). Always collected (cheap), mirroring
   * `fallbackCounts`; surfaced on `CompileResult.irPostClaimErrors` for the
   * ratchet gate. Each entry carries the IR integration error's `kind` and the
   * function/message.
   */
  irPostClaimErrors: { kind: string; func: string; message: string }[];
  /** #3519 — allocated only when `trackIrOutcomes` is requested. */
  irOutcomes?: IrObservedOutcome[];
  /**
   * #3000 — names of functions/class-members whose slots were actually patched
   * with an IR-lowered body by `compileIrPathFunctions` (its `report.compiled`).
   * A selector CLAIM alone does not imply emission: a claimed class member whose
   * class has no `IrClassShape` is skipped in Phase B and stays byte-inert on
   * legacy. This list is the durable non-vacuity signal — a member is GENUINELY
   * IR-emitted iff it appears here. Surfaced on `CompileResult.irCompiledFuncs`.
   */
  irCompiledFuncs?: readonly string[];
  /** Last AST node with a valid source position — used as fallback for error reporting
   * when the immediate node lacks source file context (synthetic/detached nodes). */
  lastKnownNode: ts.Node | null;
  /** Registry of external declared classes */
  externClasses: Map<string, ExternClassInfo>;
  /** #1238 — pseudo-extern-class registry for built-ins like String / Array
   *  that don't have host-import-backed constructors / methods. These exist
   *  purely as metadata for the IR's method-dispatch lookup
   *  (`resolveMethodDispatchTarget`). They are NOT consumed by
   *  `compileNewExpression`, `collectUsedExternImports`, the `__new_<name>`
   *  interceptor, or the `mod.externClasses` populator — keeping them out
   *  of `ctx.externClasses` ensures legacy code paths for `new Array(...)`
   *  / `new String(...)` are unchanged. Downstream slices (#1232, #1233)
   *  consult this map via `getPseudoExternClassInfo`. */
  pseudoExternClasses: Map<string, ExternClassInfo>;
  /** Optional parameter info per function */
  funcOptionalParams: Map<string, OptionalParamInfo[]>;
  /** Map from anonymous ts.Type → generated struct name */
  anonTypeMap: Map<ts.Type, string>;
  /** Counter for generating anonymous struct names */
  anonTypeCounter: number;
  /** Map from string literal value → import func name */
  stringLiteralMap: Map<string, string>;
  /** Map from import name → string literal value (for .d.ts comments) */
  stringLiteralValues: Map<string, string>;
  /** Counter for string literal imports */
  stringLiteralCounter: number;
  /**
   * #1463 — Source text per function declaration, keyed by function name.
   * Populated in `collectDeclarations` from `stmt.getText(sourceFile)` so
   * `Function.prototype.toString` can return spec-compliant source instead
   * of the `function () { [native code] }` placeholder for identifier-typed
   * receivers (`add.toString()` where `add` is a top-level declaration).
   * Not populated for class methods, arrow functions, or expressions —
   * those still fall back to the placeholder.
   */
  funcSourceText: Map<string, string>;
  /** Map from string literal value → global import index */
  stringGlobalMap: Map<string, number>;
  /** Number of imported globals (string constants) */
  numImportGlobals: number;
  /** Whether wasm:js-string imports have been registered */
  hasStringImports: boolean;
  /** Map from "EnumName.Member" → numeric value */
  enumValues: Map<string, number>;
  /** Map from "EnumName.Member" → string value (for string enums) */
  enumStringValues: Map<string, string>;
  /** Map from element kind (e.g. "f64") → registered array type index */
  arrayTypeMap: Map<string, number>;
  /** Map from element kind (e.g. "f64") → registered vec struct type index */
  vecTypeMap: Map<string, number>;
  /**
   * Per-export TypedArray classification populated during user-function
   * declaration emission (#1700). Read by the runtime `wrapExports` to
   * marshal `Uint8Array` params/results across the JS↔Wasm boundary.
   */
  exportSignatures: Map<string, import("../../ir/types.js").ExportSignature>;
  /** Map from className → parent className (for inheritance chain walk) */
  externClassParent: Map<string, string>;
  /** Map from global name (e.g. "document") → import info. `className` is
   *  the extern class of the global's declared type ("Document") — recorded
   *  at registration for the IR host-extern path (#2856), which types the
   *  `call global_<name>` handle as `IrType.extern { className }`. */
  declaredGlobals: Map<string, { type: ValType; funcIdx: number; className?: string }>;
  /** Counter for generated callback functions (__cb_0, __cb_1, ...) */
  callbackCounter: number;
  /** Map from captured variable name → global index in mod.globals */
  capturedGlobals: Map<string, number>;
  /** Captured globals whose type was widened from ref to ref_null for null init */
  capturedGlobalsWidened: Set<string>;
  /**
   * (#2029 family A) Mutable-capture ref-cell boxes promoted to module
   * globals so an accessor body can materialize a nested function's closure.
   * When an object-literal getter/setter references a nested function `f`
   * whose captures include a MUTABLE outer local `v`, the closure-construction
   * code inside the accessor needs the SAME ref-cell box the enclosing
   * function writes through — an outer-fctx local slot (`cap.outerLocalIdx`)
   * is unreachable from the accessor's own function (baking it emit-crashed
   * with "local index out of range", or silently read the wrong local when
   * the stale index happened to be in range). `promoteAccessorCapturesToGlobals`
   * boxes `v` eagerly in the enclosing fctx and aliases the box in a module
   * global of type `(ref null $cell)`; closure-materialization sites source
   * the capture from here when the current fctx cannot resolve it.
   *
   * (#3039) `valType` (the ref cell's inner value type) is present ONLY for
   * DIRECT boxed captures — a variable the accessor/method body reads or
   * writes itself (not merely through a nested closure). When set, the
   * read/write sites (identifiers.ts / assignment.ts / unary-updates.ts) must
   * DEREF the box (`global.get; struct.get/struct.set field 0`) instead of
   * treating the global as holding the value. Transitive-fn box entries leave
   * `valType` undefined; they are consumed only by closure materialization
   * (calls.ts), never by the scalar read/write sites.
   */
  capturedBoxGlobals?: Map<string, { globalIdx: number; refCellTypeIdx: number; valType?: ValType }>;
  /** Set of class names (local classes compiled to Wasm GC structs) */
  classSet: Set<string>;
  /**
   * (#2023) `new.target` support. When the program references `new.target`
   * anywhere, a single mutable i32 module global holds the class-id of the
   * class named at the *outermost* `new` site (set/restored around each `new`
   * call; `super()` deliberately leaves it untouched so it reflects the
   * derived-most constructor). `classNewTargetIds` assigns each local class a
   * stable 1-based i32 id so `new.target === SomeClass` lowers to an i32
   * compare against this global. `newTargetGlobalIdx` is the global's index
   * (undefined until allocated). Gated on `usesNewTarget` so programs without
   * `new.target` emit none of this machinery.
   */
  usesNewTarget: boolean;
  newTargetGlobalIdx: number | undefined;
  classNewTargetIds: Map<string, number>;
  /**
   * (#802) Dynamic prototype support. Set by the `scanForDynamicProto` pre-scan
   * when the program mutates an object's [[Prototype]] at runtime
   * (`Object.setPrototypeOf` / `Reflect.setPrototypeOf` / `o.__proto__ = v`).
   * `dynamicProtoClasses` holds the hierarchy-ROOT class names whose instances
   * are proto-mutation receivers — ONLY those classes get the appended
   * standalone-only `$__proto__` externref struct field (Slice B; the #799a
   * unconditional-append regression is avoided by this gating).
   * `dynamicProtoLiteralNodes` marks object-literal AST nodes that are proto
   * receivers (Slice A consumes it: promote the literal to a native `$Object`,
   * standalone-only, via `compileObjectLiteral` + the matching variable-local
   * typing in statements/variables.ts + index.ts — zero struct-layout change).
   * `dynProtoSentinelGlobalIdx` is the lazily-reserved mutable externref global
   * holding the "explicitly null prototype" sentinel `$Object` (distinguishes
   * `setPrototypeOf(o, null)` from "never dynamically set" in the appended
   * field; undefined until first needed). Everything is gated on the marked
   * sets being non-empty, so programs without proto mutation are
   * byte-identical.
   */
  usesDynamicProto: boolean;
  dynamicProtoClasses: Set<string>;
  dynamicProtoLiteralNodes: WeakSet<ts.Node>;
  dynProtoSentinelGlobalIdx: number | undefined;
  /**
   * (#2001 S1) Sparse-array hole support. Set by the `scanForArrayHoles`
   * pre-scan when the program contains any array-literal elision
   * (`OmittedExpression`). Gates the `$Hole → undefined` read-boundary guard at
   * every externref-element vec read / join site, so a hole-bearing literal in
   * one function and a `a[i]` read in another agree regardless of compilation
   * order. Clear — the common case — keeps every array read byte-identical.
   */
  usesArrayHoles: boolean;
  /** Exact, escape-free `new Array(n)` declarations admitted to #4222's carrier. */
  holeyArrayDeclarations: Set<ts.VariableDeclaration>;
  /** Exact constructor nodes that materialize the dedicated sparse carrier. */
  holeyArrayConstructorNodes: Set<ts.NewExpression>;
  /** Exact direct `.filter(...)` calls that consume that carrier. */
  holeyArrayFilterCallNodes: Set<ts.CallExpression>;
  /**
   * (#2001 S2 / merge-group park on PR #2832) Set by the same
   * `scanForArrayHoles` pre-scan when the module WRITES an index property onto
   * `Array.prototype` (`Object.defineProperty(Array.prototype, "0", …)`,
   * `Array.prototype[0] = …`, `Reflect.defineProperty(Array.prototype, …)`).
   * §23.1.3.* HOF visit-skips are keyed on `HasProperty(O, k)` — which is TRUE
   * for a hole whose index is inherited from `Array.prototype` — but the flat
   * WasmGC vec cannot model prototype-index inheritance. When this flag is set
   * the module-wide HOF hole visit-skip (`shouldHoleSkip`) is disabled and
   * holes fall back to the S1 visit-with-`undefined` behavior, which matches
   * the observable result for the dominant test262 shape (inherited accessor
   * without a getter ⇒ [[Get]] yields `undefined`). Clear — the common case —
   * keeps the spec-correct skip. See the regressed trio
   * `built-ins/Array/prototype/{every,filter,some}/*-c-i-22.js`.
   */
  protoIndexDirty: boolean;
  /**
   * (#4176) Set by the same pre-scan when the module WRITES a NAMED property
   * onto a branded builtin's `.prototype` (`Function.prototype.value = …`,
   * `Object.prototype.zzz = …`, `Object.defineProperty(String.prototype, …)`).
   * Consumer: the proto-property store reserve gate ONLY (`reserveProtoIndexStore`
   * runs under `protoIndexDirty || protoNamedDirty`). Deliberately SEPARATE
   * from `protoIndexDirty`: a named key can never be an inherited integer
   * index, so the HOF hole visit-skip and the typed element fast lanes (which
   * key on `protoIndexDirty`) stay enabled for the common polyfill idiom
   * (`String.prototype.foo = …`).
   */
  protoNamedDirty: boolean;
  /**
   * (#2175 V2-S3b-1) Set by the same pre-scan when a branded builtin's
   * `.prototype` can reach the DYNAMIC reader as a runtime value — i.e. a
   * `<Builtin>.prototype` read in VALUE position (bound to a variable, passed
   * as an argument, returned, …) or any `Object.getPrototypeOf(…)` call (the
   * `harness/testTypedArray.js:64` idiom `var TypedArray =
   * Object.getPrototypeOf(Int8Array)`, which is how ~121 ES2015 reflection
   * tests reach `%TypedArray%.prototype`).
   *
   * Consumers, both reserve-only:
   *  1. `reserveProtoIndexStore` — a purely reflective READER never writes a
   *     builtin proto, so neither `protoIndexDirty` nor `protoNamedDirty`
   *     fires and the whole `__protoidx_*` consult substrate stays unreserved.
   *     This flag arms it for the read-only case.
   *  2. `ensureNativeProtoCompanionSeeder` (native-proto.ts) — gates whether a
   *     materialized `$NativeProto` also emits a seeder that populates its
   *     brand companion with the glue's own members.
   *
   * Deliberately SEPARATE from the two write flags for the same reason those
   * are separate from each other: it must not disable the HOF hole visit-skip
   * or the typed element fast lanes, which key on `protoIndexDirty`. A module
   * that never reads a builtin proto as a value keeps every byte it has today
   * (the seeder is additionally gated on the brand's proto actually being
   * materialized, so a clean module emits nothing).
   */
  protoMemberDirty: boolean;
  /**
   * (#4159) A descriptor that is not provably data-only may exist somewhere in
   * the module. Consumers: the TYPED element read/write lanes only — #3251's
   * value write-back keeps `array.get` coherent for DATA descriptors, but an
   * accessor has no value to write back. Clear ⇒ byte-identical emission, no
   * runtime guard. Per-MODULE over-approximation; see #4159 for the rationale.
   */
  vecAccessorDescriptorDirty: boolean;
  /**
   * (#4504) A descriptor that can affect inherited [[Set]] may exist in this
   * module: an accessor, a non-writable data descriptor, an accessor
   * declaration, or dynamically introduced code.  This is deliberately
   * separate from `vecAccessorDescriptorDirty`: the latter protects typed vec
   * value write-back and can stay clear for a provably data descriptor whose
   * `writable` bit is false, while that descriptor is still load-bearing for
   * the ordinary inherited-set decision.  Clear keeps the resolver and its
   * result channel out of flag-clear modules.
   */
  inheritedSetDescriptorDirty: boolean;
  /**
   * (#4602) Property KEYS a #4504-relevant descriptor could be installed
   * under, when every trigger in the module names its key statically (an
   * accessor declaration's literal name, a `defineProperty` call with a
   * literal key and non-provably-writable descriptor, a literal
   * `defineProperties`/`create` bag entry, a literal `__defineGetter__`/
   * `__defineSetter__` key).  A trigger whose key cannot be resolved
   * statically (freeze, a captured define builtin, a computed name, dynamic
   * code) sets `inheritedSetDescriptorDirty` instead, which supersedes this
   * set.  Consumers with a static property name gate per key via
   * `inheritedSetAffectsKey`; key-dynamic runtime machinery activates on
   * `inheritedSetAnyDirty`.  A clean key compiles byte-identical to a
   * flag-clear module — that is the whole point: one accessor declaration in
   * a 226KB bundle must not demote every unrelated member write (measured
   * ~1.7x on acorn standalone, #4602).
   */
  inheritedSetDirtyKeys: Set<string>;
  /**
   * (#4222) The module contains a `delete <elementAccess>`, so some array index
   * may be semantically ABSENT while its dense backing slot still holds a
   * value. `__delete_property`'s vec arm (#4010) records that as a
   * `FLAG_DELETED_INDEX` entry in the #3251 overlay companion — storage the
   * TYPED lane's `i < length` presence test cannot see. Consumers: the same
   * typed element read/write + index-presence lanes as
   * `vecAccessorDescriptorDirty` (both feed `overlayRouteActive`). Kept SEPARATE
   * from that flag because the two are independent module properties and either
   * one alone is enough to make the dense answer wrong; folding them would make
   * each scan's over-approximation pay for the other. Clear ⇒ byte-identical
   * emission, no runtime guard.
   */
  vecIndexDeleteDirty: boolean;
  /**
   * (#4230 L1) The module mentions a descriptor-defining or own-name-reading
   * `Object`/`Reflect` builtin — `defineProperty`, `defineProperties`, a
   * two-argument `create`, `getOwnPropertyNames`, `ownKeys`,
   * `getOwnPropertyDescriptors`. Consumer: `vec-overlay-keys.ts`, which unions
   * the #3251 overlay companion into `Object.keys` / for-in /
   * `getOwnPropertyNames` and gives the last of those the `$__vec_base` arm it
   * never had.
   *
   * Deliberately NOT folded into `vecAccessorDescriptorDirty`: that flag is
   * set only for a NON-data descriptor (#4159 needs it for the accessor
   * write-back hole), while a plain `defineProperty(arr, "p", {value: 12})`
   * lands a named expando in the overlay that must still enumerate. Clear ⇒ not
   * one instruction, local, type or function is added, so a module that never
   * asks about own keys is byte-identical.
   */
  vecOwnKeysDirty: boolean;
  /**
   * (#4159/#4160) `eval` / `Function` present ⇒ forces BOTH flags above.
   * Load-bearing: static eval inlining (#1163) splices statements in during
   * BODY compilation, after this pre-scan, so the flags would otherwise stay
   * clear for code the scan never saw. See #4160.
   */
  dynamicCodeDirty: boolean;
  /**
   * (#2083) Set true the first time `getOrRegisterVecType` is asked for a vec
   * type from a genuine usage site (an array literal, array method, for-of over
   * an array, TypedArray, etc.) — i.e. the module materialises at least one
   * array value that may cross the JS↔Wasm boundary. The two pre-registrations
   * in `createCodegenContext` (`externref`/`f64`, baked in for type-index
   * stability) are excluded via `suppressVecUsageFlag`, so this stays false for
   * arith-/string-only modules with no arrays. Gates the host-glue vec exports
   * (`__vec_len`/`__vec_get`/`__vec_push`/`__vec_pop`/`__vec_mut_supported`/
   * `__is_vec`) so they no longer leak into every module (#2083). The host
   * runtime guards every `exports.__vec_*` access with a `typeof === "function"`
   * check, so their absence is safe.
   */
  usesVecValue: boolean;
  /**
   * (#4035) Resolved host-bridge policy: true = publish the JS-host
   * inspection/interop export surface, false = strip it at finalize so DCE
   * can reclaim everything it was pinning. Derived once in
   * `createCodegenContext` from `options.hostBridge` ("auto" ⇒ on for
   * js-host, off for standalone/WASI). Read only by
   * `stripHostBridgeExports`; individual emitters stay unconditional so the
   * decision lives in exactly one place.
   */
  emitHostBridge: boolean;
  /**
   * (#2083) When true, `getOrRegisterVecType` does NOT flip `usesVecValue`.
   * Set only for the duration of the two pre-registration calls in
   * `createCodegenContext` (the `externref`/`f64` type-index-stability stubs),
   * which are not real array usage.
   */
  suppressVecUsageFlag: boolean;
  /**
   * (#2001 S1) Type index of the `$Hole` zero-field sentinel struct, and the
   * absolute index of the immutable `$__hole` singleton global. Registered
   * lazily + once by `ensureHoleType` during body compilation (after class
   * collection, per `project_type_index_shift_and_deadelim`). `-1` / `undefined`
   * until first use; pruned by dead-elimination when no hole literal is stored.
   */
  holeTypeIdx: number;
  holeGlobalIdx: number | undefined;
  /**
   * (#2970) `import.meta` per-module object identity. One shared zero-field
   * `$ImportMeta` struct type, plus a DISTINCT immutable global instance per
   * source file (keyed by `SourceFile.fileName`). Each `import.meta` value read
   * returns the global of the file it syntactically occurs in, so identity is
   * stable within a module and distinct across modules (§sec-meta-properties).
   * Created lazily by `ensureImportMetaObject`.
   */
  importMetaTypeIdx: number | undefined;
  importMetaGlobals: Map<string, number>;
  /**
   * (#2800) The mutable i32 `__in_module_init` flag — 1 for the duration of
   * `__module_init` (the Wasm `start` section in gc/host mode, which runs INSIDE
   * `WebAssembly.instantiate`, BEFORE the host wires struct getters via
   * `__setExports`), 0 otherwise. The delete-aware `any`-receiver READ
   * (`tryEmitDeleteAwareDynamicGet`) branches on it: while init runs (host
   * `__extern_get` can't reach `__sget_<field>` → returns undefined for every
   * struct field), read the slot HOST-FREE via the `__get_member_<name>`
   * dispatcher; at runtime use the tombstone-aware host `__extern_get`.
   *
   * `inModuleInitFlagReads` collects the `global.get` flag-read Instr objects
   * emitted at read sites (with a placeholder index); `finalizeInModuleInitFlag`
   * allocates the i32 global AFTER every import settles and patches their
   * `.index` + records the final slot in `inModuleInitGlobalIdx`. Undefined/empty
   * for delete-free / standalone / WASI modules (byte-identical).
   */
  inModuleInitFlagReads: Instr[] | undefined;
  inModuleInitGlobalIdx: number | undefined;
  /**
   * (#2580 M0) Value-rep dynamic-read substrate. Set true by a call site that
   * needs the runtime property-presence read primitives (`__dyn_has` /
   * `__dyn_get`) — e.g. M1's `any`-receiver `.length`. Gates
   * `ensureDynReadHelpers`: when clear (the common case AND all of M0, which adds
   * NO call sites), the helpers are never emitted, so a hole/dynamic-free module
   * is byte-identical. The two helpers dispatch the #1852 boxed `$AnyValue`
   * family by tag (0 null / 1 undefined / 2 i32 / 3 f64 / 4 bool / 5 string /
   * 6 GC-ref → `$Object`/`$Vec`).
   */
  usesDynRead: boolean;
  /** (#2580 M0) Idempotence latch for `ensureDynReadHelpers` (once per module). */
  dynReadHelpersEmitted: boolean;
  /**
   * (#3053 U0) Unified dynamic-reader carrier substrate. Set true by a call site
   * (U1's IR member-read wiring) that needs the carrier-uniform
   * `__dyn_member_get(recv,key) -> carrier` primitive. Gates `ensureDynMemberGet`:
   * when clear (the common case AND all of U0, which adds NO call sites), the
   * helper is never emitted, so every module is byte-identical — the latch, not
   * dead-elim, guarantees zero bytes for an uncalled defined function. The
   * `JS2WASM_FORCE_DYN_MEMBER_GET=1` self-test escape sets this (and additionally
   * emits exported unit-test drivers) so U0's bodies are validated as VALID Wasm
   * (gc + standalone) before U1 wires the real call sites.
   */
  usesDynMemberGet: boolean;
  /** (#3053 U0) Idempotence latch for `ensureDynMemberGet` (once per module). */
  dynMemberGetHelpersEmitted: boolean;
  /** Classes that must throw TypeError at evaluation time */
  classThrowsOnEval: Set<string>;
  /**
   * (#1983) Names of top-level user `function` declarations in the source. Used
   * by `classMemberFuncKey` to detect when a synthetic class-member key
   * (`${className}_${member}`) would collide with a user function of the same
   * name (e.g. `class A { m() {} }` + `function A_m() {}`), so the class
   * member's **funcMap** entry can take a collision-free key. Populated in
   * `collectDeclarations` (runs before any class body compiles).
   */
  topLevelFunctionNames: Set<string>;
  /** Source nodes for those names. Runtime-eval global seeding compiles the
   * real identifier so callable metadata matches an ordinary AOT value read. */
  topLevelFunctionDeclarations: Map<string, ts.FunctionDeclaration>;
  /** Map from "ClassName_methodName" → method info for local classes */
  classMethodSet: Set<string>;
  /** Classes inside function bodies whose body compilation is deferred */
  deferredClassBodies: Set<string>;
  /** Set of "ClassName_propName" for getter/setter accessor properties */
  classAccessorSet: Set<string>;
  /**
   * (#1888 S5c) Set of "structName_propName" whose getter/setter is compiled as
   * a host-free CLOSURE (capturing env, call_ref-invoked) rather than the bare
   * `${struct}_get_${prop}(this)` fn. Populated by the C2 define-site when
   * `S5C_STRUCT_ACCESSOR_CLOSURE` is on; the C3 read / C4 write sites dispatch
   * through the per-(struct,prop) `$__acc_get/set_<struct>_<prop>` globals +
   * the S5b `__call_accessor_get/set` drivers ONLY when this set has the key, so
   * class-accessor emission (#459/#1680/#1681/#1605) stays on the proven bare-fn
   * path. Maps the key → the get/set global indices.
   */
  structAccessorClosure: Map<string, { getGlobal?: number; setGlobal?: number }>;
  /** Set of "ClassName_propName" for static getter/setter accessor properties */
  staticAccessorSet: Set<string>;
  /** Set of "ClassName_methodName" for static methods (no self param) */
  staticMethodSet: Set<string>;
  /** Map from "ClassName_propName" → global index for static properties */
  staticProps: Map<string, number>;
  /**
   * (#1719 CPR — compiled prototype record) Captured prototype-member overrides.
   *
   * `Array.prototype[Symbol.iterator] = fn` / `Array.prototype.values = fn` have
   * no compiled landing spot today and are silently dropped — the override is
   * never observed (#1719 root cause). CPR captures such writes here. The OUTER
   * key is a **proto-owner identity token** (today a builtin name, e.g.
   * `"Array"`); the INNER key is the well-known member key (`"@@iterator"`,
   * `"values"`). The value is the lifted override closure's funcref index plus
   * the funcTypeIdx needed to `call_ref` it. Read sites (array destructuring,
   * for-of, spread) consult this when the whole-program brand
   * (`arrayIteratorMaybeOverridden`) is set and drive the stored closure as the
   * value's `@@iterator` (§7.4.2 GetIterator) instead of the backing-store walk.
   *
   * The proto-owner key is typed as an open string TOKEN (not a narrow union) so
   * it can later carry user-class / struct-type identities — probe-1 showed
   * `C.prototype.m=` is dropped for user classes too — without rebuilding the
   * table; the cluster (#1130/#1320) grafts on by widening the token. This is the
   * prototype-OVERRIDE substrate, kept conceptually distinct from instance-level
   * own-property descriptors (`_wasmStructAccessors` / #1629), which live on
   * values, not prototypes.
   */
  protoOverrides: Map<string, Map<string, { funcIdx: number; funcTypeIdx: number; globalIdx: number }>>;
  /**
   * (#1719 CPR read-drive) True once the in-Wasm
   * `__drive_proto_iterator(thisVal: externref, closure: externref) -> externref`
   * driver placeholder has been reserved (pushed + registered in `funcMap` under
   * `"__drive_proto_iterator"`). The read-drive sites (array dstr / for-of /
   * spread) are emitted during body compilation, BEFORE the post-processing
   * phase that can see the fully-populated `closureInfoByTypeIdx` needed to
   * dispatch the override closure. So the FIRST read-drive site pushes a
   * placeholder function (fixing its append-position funcIdx) and registers it in
   * `funcMap`; the body is filled in post-processing (calls the registered
   * `__call_fn_method_0`). The placeholder is never reserved when the brand is
   * clear, so override-free modules stay byte-identical. Storing the funcIdx in
   * `funcMap` (not a raw number here) is load-bearing: `shiftLateImportIndices`
   * patches both the `funcMap` entry and the emitted `call` by the same delta, so
   * a late-import index shift never desyncs the reservation.
   */
  protoIteratorDriverReserved?: boolean;
  /**
   * (#1888 S5b accessor live get/set) Set when `ensureObjectRuntime` reserves the
   * `__call_accessor_get` / `__call_accessor_set` driver placeholders so the
   * `__extern_get` / `__extern_set` accessor arms can `call` them. The bodies are
   * filled in post-processing by `fillAccessorDrivers` AFTER
   * `emitClosureMethodCallExportN(0/1)` registers `__call_fn_method_0/1` — same
   * reserve/fill funcIdx-authority pattern as `protoIteratorDriverReserved`
   * (proto-override.ts). Never reserved when the object runtime is not emitted
   * (non-standalone), so host/GC modules stay byte-identical.
   */
  accessorGetDriverReserved?: boolean;
  accessorSetDriverReserved?: boolean;
  /**
   * (#2166 PR-D1) True once the standalone `JSON.parse(text, reviver)` codec
   * reserved its `__call_reviver(holder, key, value) -> externref` driver
   * funcIdx — filled in finalize to wrap `__call_fn_method_2`. Same reserve/fill
   * funcIdx-authority pattern as the accessor drivers above.
   */
  reviverDriverReserved?: boolean;
  /**
   * (#2166 PR-D2) True once the standalone `JSON.stringify` codec reserved its
   * `__call_to_json(value, method, key) -> externref` driver funcIdx — filled in
   * finalize to wrap `__call_fn_method_1` (value bound as the `toJSON`
   * receiver).
   */
  toJsonDriverReserved?: boolean;
  /**
   * (#2166 PR-D3) True once the standalone `JSON.stringify` codec reserved its
   * `__call_replacer(holder, replacer, key, value) -> externref` driver funcIdx
   * — filled in finalize to wrap `__call_fn_method_2` (holder bound as the
   * replacer `this`, key+value the two replacer args).
   */
  replacerDriverReserved?: boolean;
  /**
   * (#1888 Slice 1) True once the standalone open-any method-dispatch bridge
   * `__apply_closure(fn, recv, args) -> externref` has reserved its funcIdx via
   * a placeholder function pushed during `ensureObjectRuntime` (registered in
   * `funcMap` under `"__apply_closure"`). The bridge calls the
   * `__call_fn_method_0..4` exports, which are only emitted at FINALIZE (after
   * the full `closureInfoByTypeIdx` is known), so the placeholder body is filled
   * by `fillApplyClosure` in post-processing — mirroring the
   * `protoIteratorDriverReserved` reserve-then-fill pattern (#1719). Only set
   * under `--target standalone`, so the GC/host path stays byte-identical.
   */
  applyClosureReserved?: boolean;
  /**
   * (#3468 C-core) Set when `ensureObjectRuntime` reserved the closure-own-
   * property side-table helpers (`__is_closure_prop_carrier`, `__closure_bag_lookup`,
   * `__closure_bag_ensure`, `__closure_prop_get`, `__closure_prop_set`). Their
   * bodies self-call `__extern_get`/`__extern_set` and need the COMPLETE
   * captured-closure subtype set, both only available at FINALIZE, so they are
   * filled by `fillClosurePropHelpers` —
   * same reserve-then-fill pattern as `applyClosureReserved` (#1719). Only set
   * under `--target standalone`, so the GC/host path (which uses `env::__extern_*`
   * imports) stays byte-identical.
   */
  closurePropHelpersReserved?: boolean;
  /**
   * (#3468 C-core) Type index of the `$ClosurePropEntry` linked-list node
   * `{ next: (ref null $ClosurePropEntry); key: eqref; bag: externref }` used by
   * the closure-own-property side table. Registered in `ensureObjectRuntime`'s
   * type section (standalone only) so `fillClosurePropHelpers` can `struct.new`/
   * `struct.get` against a stable index.
   */
  closurePropEntryTypeIdx?: number;
  /**
   * (#3468 C-core) Global index of `$__closure_prop_head`
   * (`(mut ref null $ClosurePropEntry)`, init `ref.null`) — the head of the
   * closure-own-property side table's linked list.
   */
  closurePropHeadGlobalIdx?: number;
  /**
   * (#3537) Set when `ensureObjectRuntime` reserved the array ($Vec) expando
   * side-table helpers (`__is_vec_prop_carrier`, `__vec_bag_lookup`,
   * `__vec_bag_ensure`, `__vec_prop_get`, `__vec_prop_set`) — the ARRAY arm of
   * the #3468 own-property family. Bodies self-call `__extern_get`/`__extern_set`
   * so they are filled by `fillVecPropHelpers` at FINALIZE. Standalone/wasi only.
   */
  vecPropHelpersReserved?: boolean;
  /**
   * (#3537) Type index of the `$VecPropEntry` linked-list node
   * `{ next: (ref null $VecPropEntry); key: eqref; bag: externref }`.
   */
  vecPropEntryTypeIdx?: number;
  /** (#3537) Global index of `$__vec_prop_head` (`(mut ref null $VecPropEntry)`). */
  vecPropHeadGlobalIdx?: number;
  /**
   * (#3537) `$__vec_base` type index resolved at RESERVE time (never registers
   * a type at finalize) — the `ref.test` target for `__is_vec_prop_carrier`.
   */
  vecPropBaseTypeIdx?: number;
  /**
   * (#4160) Set when `ensureObjectRuntime` reserved the prototype-index-store
   * helpers (`__protoidx_*`, proto-index-store.ts) — the runtime companions
   * that make `Object.prototype[i]` / `Array.prototype[i]` writes visible
   * through the prototype chain. Reserved ONLY under
   * `ctx.standalone && ctx.protoIndexDirty` (pre-scan flag, #4128), so a
   * flag-clear module carries no trace; bodies + chokepoint arms are filled by
   * `fillProtoIndexStore` at FINALIZE.
   */
  protoIndexStoreReserved?: boolean;
  /** (#4160) Set once `fillProtoIndexStore` has run (idempotency latch). */
  protoIndexStoreFilled?: boolean;
  /** (#4504) Mutable result channel for one completed native [[Set]] attempt:
   * 0 = unadmitted, 1 = success/handled, 2 = refused.  `Reflect.set` exposes
   * it as a boolean while strict assignment distinguishes refusal from an
   * unadmitted host boundary.  Undefined when the descriptor resolver is not
   * emitted. */
  externSetResultGlobalIdx?: number;
  /** (#4160) Global index of `__protoidx_obj_companion` (`(mut externref)`). */
  protoIndexObjCompanionGlobalIdx?: number;
  /** (#4160) Global index of `__protoidx_arr_companion` (`(mut externref)`). */
  protoIndexArrCompanionGlobalIdx?: number;
  /**
   * (#4176) Global index of `__protoidx_companions` — the lazily-minted
   * per-brand companion TABLE (`(mut (ref null $__protoidx_carr))`, one
   * externref slot per builtin brand) that generalizes the two globals above
   * to every branded builtin prototype (`Function.prototype.value = …`).
   */
  protoIndexCompanionsGlobalIdx?: number;
  /** (#4176) Type index of `$__protoidx_carr` (`array (mut externref)`). */
  protoIndexCompanionsArrTypeIdx?: number;
  /**
   * (#1100) Set when the standalone Proxy trap-dispatch runtime reserved its
   * `__proxy_call_{get,set,has}` driver placeholders (in `ensureProxyRuntime`).
   * Those drivers invoke the user trap closures through the `__call_fn_method_N`
   * exports, which are only emitted at FINALIZE, so their bodies are filled by
   * `fillProxyDispatch` in post-processing — same reserve-then-fill pattern as
   * `applyClosureReserved` / the accessor drivers (#1719). Only set under
   * `--target standalone`, so the GC/host path stays byte-identical.
   */
  proxyDispatchReserved?: boolean;
  /**
   * (#3125) Set when the native-Promise thenable-assimilation substrate
   * reserved its `__promise_has_callable_then` predicate placeholder
   * (`ensurePromiseThenableSubstrate`, async-scheduler.ts). The predicate needs
   * the FULL closed-struct + closure shape sets, which are only complete at
   * FINALIZE, so the body is filled by `fillPromiseThenableHelpers`
   * (closed-method-dispatch.ts) — same reserve-then-fill pattern as
   * `applyClosureReserved` (#1719). Only set under standalone/wasi, so the
   * GC/host path stays byte-identical.
   */
  promiseThenableReserved?: boolean;
  /**
   * (#2151) Method names for which a closed-struct `__call_m_<name>` dispatcher
   * was reserved at an any-receiver call site (standalone/wasi). The placeholder
   * body is filled by `fillClosedMethodDispatch` at FINALIZE (after all
   * object-literal struct types + their `<Struct>_<name>` methods are known),
   * mirroring the `fillApplyClosure` reserve-then-fill pattern (#1719). Each
   * dispatcher does a `ref.test/ref.cast/call <Struct>_<name>` type-switch over
   * every closed struct that has the method (threading the struct as `this`),
   * falling through to the open-`$Object` `__extern_method_call` otherwise. Only
   * populated under `--target standalone || --target wasi`.
   */
  closedMethodDispatchNames?: Set<string>;
  /**
   * (#2151 Slice 4) Method names that need a VARARG closed-struct dispatcher
   * `__call_m_<name>_vararg(recv, args)` for a DYNAMIC-spread call `o.m(...xs)`
   * whose arity is unknown at compile time. Filled at FINALIZE by
   * `fillClosedMethodDispatch` (the vararg pass), sourcing each declared param
   * from `__extern_get_idx(args, i)` instead of fixed dispatcher params.
   */
  closedMethodDispatchVarargNames?: Set<string>;
  /**
   * (#2664) Property names that need a deferred-fill member-WRITE dispatcher
   * `__set_member_<name>(recv: externref, val: externref)`. The symmetric
   * struct.set write dispatch (#2659) was emitted INLINE at each `any`-receiver
   * `obj.<name> = v` write, freezing its struct-candidate set at the write's
   * compile time. A field-writing closure compiled BEFORE a later struct type
   * (e.g. acorn's `$__fnctor_Parser`, registered after the closure) only got the
   * earlier candidate's `ref.test` arm; the real instance failed it and the
   * write leaked to the `__extern_set` sidecar while reads used the slot —
   * non-termination (#2664). Routing the write through a reserved dispatcher
   * filled at FINALIZE (when the full struct-type table is known) gives every
   * write site the COMPLETE candidate set regardless of compile order. Filled by
   * `fillMemberSetDispatch`; populated in BOTH gc/host and standalone (the
   * dual-struct-type compile-order hazard is mode-independent).
   */
  memberSetDispatchNames?: Set<string>;
  /**
   * Property names assigned an object literal outside their defining literal.
   * Anonymous struct fields with these names use an externref carrier so a
   * later object of a different closed shape can be stored without ref.cast.
   */
  objectLiteralAssignedPropertyNames: Set<string>;
  /** Concrete RHS types observed for those property writes. */
  objectLiteralAssignedPropertyTypes: Map<string, ts.Type[]>;
  /**
   * (#2674) Property names that need a deferred-fill member-READ dispatcher
   * `__get_member_<name>(recv: externref) -> externref` — the SYMMETRIC read-side
   * counterpart of `memberSetDispatchNames`. The member-READ multi-struct
   * dispatch (`findAlternateStructsForField` + `ref.test`/`struct.get` chain) was
   * also enumerated INLINE per read site, so a reader compiled before a later
   * struct type only got the earlier candidate's arm → stale `__extern_get`
   * `undefined` read on the real (later-type) instance, while #2664's deferred
   * write hit the slot → read/write divergence → non-termination (acorn 9th wall).
   * Routing the alternates fallback through a reserved dispatcher filled at
   * FINALIZE gives every read site the COMPLETE candidate set. Filled by
   * `fillMemberGetDispatch`; populated in BOTH gc/host and standalone.
   */
  memberGetDispatchNames?: Set<string>;
  /**
   * (#3673) Property names that additionally reserved the TYPED f64 read
   * dispatcher `__get_member_<name>__f64(recv) -> f64`. Reserved by the
   * externref→f64 coercion rewrite in type-coercion.ts when a ToNumber-context
   * read site's stack top is literally a generic-dispatcher call — the typed
   * twin collapses numeric-slot hits to one call with a bare `struct.get`
   * arm (no `__box_number` / `__to_primitive` / `__unbox_number` round-trip).
   * Filled by `fillTypedMemberGetF64Dispatch` right after the generic fill.
   */
  memberGetTypedF64DispatchNames?: Set<string>;
  /**
   * (#2963) Class-METHOD arms for the `__get_member_<name>` dispatcher:
   * propName → the receiver-typed arms that answer the canonical method-value
   * singleton (the SAME per-`<Owner>_<method>` cache global the typed
   * `C.prototype.m` read mints via `emitCachedMethodClosureAccess`), so a
   * dynamic `any`-receiver read `c.m` is `===` the typed read. Recorded at
   * reserve time (`ensureMethodArmsForProp` — the singleton machinery must be
   * minted at compile time, never at finalize); consumed by
   * `fillMemberGetDispatch`, which re-resolves the trampoline/cache-global
   * indices BY NAME (shift-safe). Arms are children-first so an override's
   * arm shadows the superclass arm under WasmGC subtyping.
   */
  memberGetMethodArms?: Map<
    string,
    {
      receiverStructTypeIdx: number;
      methodFullName: string;
      closureStructTypeIdx: number;
      depth: number;
    }[]
  >;
  /**
   * (#2831) Per-target-vec-type host-externref → wasm-vec materializer helpers.
   * Maps a vec struct typeIdx (`$__vec_*`) → the reserved helper function NAME
   * `__vec_from_extern_<vecTypeIdx>(externref) -> (ref null $vec)`. The helper
   * body is `buildVecFromExternref` (the read-consistent inverse of
   * `__make_iterable`): it reads `__extern_length` + per-element `__extern_get`
   * and `struct.new`s a fresh vec of the EXACT target type, handling
   * empty/non-empty/host-array/null uniformly, with a same-rep `ref.test`
   * short-circuit that preserves wasm-vec identity.
   *
   * Reserved ONCE up-front by `reserveVecFieldMaterializers` (a finalize sub-pass
   * that owns its import shifts — the #2043 reserve-then-fill discipline), BEFORE
   * the `__sset_*` setters and `fillMemberSetDispatch` bake. The three setter
   * emitters then look the helper up by NAME (funcMap stays in lockstep across
   * later import shifts) and emit a `call` instead of an UNGUARDED narrowing
   * `ref.cast` on the inbound value — which traps `illegal cast` on a
   * host-marshalled `[]` at a dynamic any-receiver write (the #2831 blocker), or
   * (with a wasm-vec-only guard) silently DROPS the write (the #2664 desync).
   * Empty/undefined until a vec-typed field write site exists ⇒ byte-identical
   * for modules without the pattern.
   */
  vecFromExternMap?: Map<number, string>;
  /**
   * (#1904) True once the standalone `__extern_is_array(externref) -> i32`
   * helper placeholder has been emitted by the object runtime. Its body is
   * filled in post-processing after all Wasm array carrier types (`__vec_*`
   * plus `$ObjVec`) are known.
   */
  externIsArrayReserved?: boolean;
  /**
   * (#2190) True once `__extern_get_idx` is registered with its static
   * `$Object`/`$ObjVec` arms (standalone only). The per-element-kind
   * `__vec_<k>` dispatch arms are appended at FINALIZE by
   * `fillExternGetIdxVecArms`, after every `__vec_*` carrier type is known —
   * the same reserve/fill pattern as `externIsArrayReserved`. Without the
   * deferred fill, an array literal of an element kind compiled after
   * `ensureObjectRuntime` would have no indexing arm and `(arr as any)[i]`
   * would read back null/0 (sibling of the #2189 `.length` gap).
   */
  externGetIdxReserved?: boolean;
  /**
   * (#3251 S1) True once the standalone array-descriptor overlay entry points
   * (`__vec_dp_value` / `__vec_dp_accessor` / `__vec_gopd`) were reserved as
   * safe-no-op placeholders by `reserveVecOverlayHelpers` (vec-overlay.ts) so
   * the `__defineProperty_value` / `__defineProperty_accessor` /
   * `__getOwnPropertyDescriptor` vec arms could bake their `call`. Bodies are
   * filled by `fillVecOverlayHelpers` in finalize. Standalone only.
   */
  vecOverlayReserved?: boolean;
  /**
   * (#3251 S1) Absolute global index of the mutable `$__vec_overlay_state`
   * module global (null until the first vec companion is created). Registered
   * at FINALIZE by `fillVecOverlayHelpers`; tracked here so a (hypothetical)
   * late import-global insertion can shift it in `fixupModuleGlobalIndices`.
   */
  vecOverlayStateGlobalIdx?: number;
  /** (#3673) i32 flag global — 1 once any overlay companion carries a numeric
   *  (array-index) key; gates the `__extern_get_idx` overlay prologue. */
  vecOverlayNumericGlobalIdx?: number;
  /** (#3251 S1) Type index of `$__overlay_state` (see above). */
  vecOverlayStateTypeIdx?: number;
  /**
   * (#2358 #10) True once `__to_primitive` reserved the
   * `__array_to_primitive_string` placeholder. Filled by `fillArrayToPrimitive`
   * (array-to-primitive.ts) in post-processing, AFTER `__extern_length` /
   * `__extern_get_idx` are registered — `__to_primitive` is emitted before those
   * helpers, so the array-ToPrimitive join arm can only call a RESERVED funcIdx
   * (mirror of `externGetIdxReserved` / the accessor-driver reserve/fill). Lets
   * `Number([1])` / `"1,2" == [1,2]` / `1 + [2]` reduce a runtime `$Vec` to its
   * Array.prototype.toString (`join(",")`) host-free, standalone only.
   */
  arrayToPrimitiveReserved?: boolean;
  /**
   * (#2638) True once `__to_primitive` has reserved the `__class_to_primitive`
   * driver — standalone routing of a nominal CLASS-instance struct (neither
   * `$Object` nor `$Vec`) through the per-struct `__call_valueOf`/`__call_toString`
   * dispatchers per §7.1.1.1. Those dispatchers are emitted at FINALIZE (after
   * `__to_primitive`), so the driver body is filled by `fillClassToPrimitive`
   * post-`emitToPrimitiveMethodExports`; same reserve/fill funcIdx discipline as
   * `arrayToPrimitiveReserved`. Lets `(new C() as any) - 8` / `Number(new C() as any)`
   * reduce via the class's valueOf/toString host-free, standalone only.
   */
  classToPrimitiveReserved?: boolean;
  /**
   * (#2038) True once the native iterator runtime (`ensureNativeIteratorRuntime`,
   * iterator-native.ts) has emitted `__iterator` / `__iterator_next` with a
   * vec-only body and is awaiting its USER-iterator arm. The USER arm dispatches
   * a custom `{[Symbol.iterator]()}` / `{next()}` object through the closed-struct
   * method dispatchers `__call_@@iterator` / `__call_next` and the field getters
   * `__sget_value` / `__sget_done`, all of which are emitted at FINALIZE (after
   * every user struct is known — `emitIteratorMethodExport` /
   * `emitStructFieldGetters`). So the carrier bodies are rebuilt with the USER arm
   * by `fillNativeIteratorUserArms` in post-processing — same reserve-then-fill
   * funcIdx-authority discipline as `protoIteratorDriverReserved` (#1719). The
   * eager body is a valid vec-only carrier (byte-identical to the pre-#2038
   * runtime), so if the fill is ever skipped (e.g. multi-module) custom iterables
   * keep trapping as before rather than shipping a broken module. Only set under
   * `--target standalone` / `wasi`.
   */
  nativeIteratorUserArmPending?: boolean;
  /**
   * Static property initializer expressions to compile into __module_init.
   * `className` (#1395) is the owning class name — used to set
   * `enclosingClassName` + `isStaticContext` on the initFctx so `this`
   * inside the initializer (and any closures it spawns) resolves to the
   * class-object singleton via `emitLazyClassObjectGet`.
   */
  staticInitExprs: {
    globalIdx?: number;
    initializer?: ts.Expression;
    staticBlock?: ts.ClassStaticBlockDeclaration;
    className?: string;
  }[];
  /** Counter for generated closure types/functions */
  closureCounter: number;
  /**
   * #2928 — true once the module has materialized the canonical eight-slot
   * callable carrier used by the separately linked interpreter runtime.
   */
  runtimeEvalCallableSeeded?: boolean;
  /** Exact eight-slot callable root registered by the runtime-eval seed. */
  runtimeEvalCallableTypeIdx?: number;
  /** Canonical branded carrier for an interpreted callback crossing modules. */
  runtimeEvalInterpretedCallbackTypeIdx?: number;
  runtimeEvalValueTypeIdx?: number;
  /**
   * #2928 — this unit consumes or provides the linked runtime-eval ABI.
   * Callable writes to its native global object use the cross-module carrier.
   */
  runtimeEvalCallableBoundaryEnabled?: boolean;
  /** Compile-once inventory of runtime-eval provider and callback demand. */
  runtimeEvalBoundaryPlan?: IrRuntimeEvalBoundaryPlan;
  /**
   * #2928 — structurally canonical `(call,get,target,brandA,brandB)` carrier
   * shared by caller and provider without changing the ordinary closure
   * hierarchy. Consumers must verify both brands after the structural test.
   */
  runtimeEvalAotCallableCarrier?: {
    structTypeIdx: number;
    funcTypeIdx: number;
    propertyGetFuncTypeIdx: number;
    trampolineFuncIdx?: number;
    propertyGetTrampolineFuncIdx?: number;
    interpretedTrampolineFuncIdx?: number;
    /** (#4307) `(externref) -> externref` closure→carrier wrap helper. */
    wrapHelperFuncIdx?: number;
  };
  /** Runtime-eval global-object push/pull helpers have been reserved/filled. */
  runtimeEvalGlobalSyncReserved?: boolean;
  runtimeEvalGlobalSyncFilled?: boolean;
  /** Runtime guard: 1 only while execution is crossing the linked provider. */
  runtimeEvalProviderActiveGlobalIdx?: number;
  /** This unit consumes linked runtime eval and therefore needs mutable global
   * function bindings, not immutable direct-call indices. */
  runtimeEvalGlobalFunctionBindings?: boolean;
  /**
   * (#2640) When set, `compileArrowAsClosure` widens any callback parameter
   * whose resolved type is a typed WasmGC vec/array (`__vec_*`/`__arr_*`/
   * `$__vec_base`) to `externref`. Set transiently by
   * `compileArrayLikePrototypeCall` around the callback compile: that path
   * dispatches a generic `Array.prototype.X.call(arrayLike, cb)` over a
   * DYNAMIC (non-vec) array-like receiver, and passes that receiver to the
   * callback's array parameter as an `externref`. Without the widening,
   * TypeScript infers the callback's array param as `T[]` → a typed vec ref,
   * so the dispatch loop must pass `ref.null` (the receiver fails the vec
   * `ref.test`) and the callback's `obj.length`/`obj[i]` lowers to a
   * `struct.get` on null → "dereferencing a null pointer". Widening to
   * externref routes those reads through the tag-aware dynamic reader.
   * This path is ONLY entered for non-vec array-like receivers (real
   * `__vec_`/`__arr_` receivers bail out of `compileArrayLikePrototypeCall`
   * upstream), so the typed `arr.forEach(cb)` hot path is never touched.
   */
  forceExternrefCallbackParams?: boolean;
  /**
   * (#3137) True while compiling a native `.then`/`.catch` callback closure
   * (`compileStandalonePromiseThenCallback` window). TUPLE-typed callback
   * params widen to externref in `computeClosureWrapperSig`: the native
   * then-wrapper ABI always delivers externref, and a combinator results vec
   * can never be the contextually-inferred tuple struct — the unguarded
   * `ref.cast` trapped (illegal cast in `__then_fulfill_N`, the #3137
   * allSettled harness class). Every other closure compile is unaffected.
   */
  widenTupleCallbackParams?: boolean;
  /**
   * (#3432 follow-up) Variable declarations whose callable-typed initializer
   * compiled to externref and whose slot STAYED externref — i.e. the decl
   * SKIPPED the closure match-and-recast (the #3432 guard in
   * `compileVariableStatement`). Before #3432 the recast normalized such
   * values to "matched-closure-struct or null", which is the invariant the
   * #1941 host-call-fallback gate (`calleeMayBeHostCallable`) relies on to
   * omit the `__call_function` arm for ordinary locals. A skipped-recast var
   * can legitimately hold a FOREIGN callable (a host bridge-wrapped wasm
   * closure read back off a property/array, a bound function, a host
   * builtin), so direct calls of these vars MUST emit the #1712 host
   * fallback arm — otherwise the closure-struct dispatch does
   * `struct.get` on the nulled guarded cast and traps "dereferencing a
   * null pointer" (the +107 null_deref merge_group cluster on PR #3370:
   * test262 harness `assert.compareArray`'s `var format = compareArray.format;
   * … format(actual)`).
   */
  skippedClosureRecastDecls?: Set<ts.Node>;
  /** Map from local variable name → closure metadata (for call_ref dispatch) */
  closureMap: Map<string, ClosureInfo>;
  closureInfoByTypeIdx: Map<number, ClosureInfo>;
  maxHostDynamicMethodCallArity?: number;
  /**
   * Host-lane dynamic method names whose receiver may be a compiled class
   * instance. Finalization emits a small ref.test dispatcher for these names
   * so the JS host can resolve ordinary WasmGC class methods, not only the
   * older fnctor-subclass surface.
   */
  hostDynamicClassMethodNames: Set<string>;
  /** Resolved concrete types for generic functions (from call-site analysis) */
  genericResolved: Map<string, { params: ValType[]; results: ValType[] }>;
  /** Rest parameter info per function (functions with ...rest syntax) */
  funcRestParams: Map<string, RestParamInfo>;
  /**
   * Functions whose body reads `arguments`. Used by callers to decide
   * whether to populate the `__extras_argv` module global with extra
   * runtime args beyond the formal param count (#1053).
   */
  funcUsesArguments: Set<string>;
  /**
   * Module global index for the runtime extras argv vec (#1053).
   * Lazily registered on first use; -1 if not yet created.
   * Type: (mut (ref null $vec_externref))
   */
  extrasArgvGlobalIdx: number;
  /** Vec struct type index for the extras argv global (matches externref vec type). */
  extrasArgvVecTypeIdx: number;
  /**
   * Absolute Wasm global index for the `__argc` (mut i32) module global.
   * Set by the caller to communicate the actual call-site argument count
   * to functions that use `arguments`. -1 = not yet created.
   */
  argcGlobalIdx: number;
  /**
   * (#2933) Canonical VARIADIC builtin value-closure convention, set when a
   * genuinely-variadic builtin static method (`Math.max`/`Math.min`) is
   * reified as a first-class value under `--target standalone`. The closure's
   * lifted func type is `(self, (ref null $vec_externref)) -> externref` — one
   * vec param carrying ALL call-site args — so a single any-callee dispatch
   * arm (call-identifier.ts) serves every call-site arity. `undefined` when no
   * variadic builtin value read occurred (the dispatch arm is then not
   * emitted, keeping such modules byte-identical).
   */
  variadicBuiltinClosure?: {
    /** Lifted func type of the variadic closures (`ref.test` discriminator). */
    funcTypeIdx: number;
    /** Wrapper struct type the closures' self param expects. */
    structTypeIdx: number;
    /** `$vec_externref` struct type (len + arr) used for the args-vec param. */
    vecTypeIdx: number;
    /** Underlying externref array type inside the vec. */
    arrTypeIdx: number;
  };
  /**
   * Absolute Wasm global index for the `__current_this` (mut externref) module
   * global (#1636-S1). Set by `__call_fn_method_N` to the host-supplied
   * receiver before invoking the closure body; restored after the call.
   * A `ThisKeyword` reference in a free-function closure (no local `this`
   * binding, not in static context) reads from this global instead of the
   * previous `undefined` fallback. -1 = not yet created.
   */
  currentThisGlobalIdx: number;
  /**
   * (#4203) Global index of the immutable `__this_explicit_null` marker: "the
   * caller passed `null`", as distinct from `__current_this`'s `ref.null.extern`
   * "no receiver installed". See `explicit-null-receiver.ts`.
   */
  explicitNullThisGlobalIdx?: number;
  /** Mutable i32 hand-off used by ES5 Function `caller` poison semantics. */
  callerStrictGlobalIdx: number;
  /** Source function name → source strictness, consumed by the final call-site pass. */
  sourceFunctionStrictness: Map<string, boolean>;
  /** Source-function or inlined-IIFE instruction region → strictness. */
  sourceFunctionStrictnessByBody: Map<Instr[], boolean>;
  /** Idempotence guard for the final call-site instrumentation pass. */
  functionPoisonPillCallsFinalized?: boolean;
  /** Map from struct name → set of closure type indices used for valueOf fields */
  valueOfClosureTypes: Map<string, number[]>;
  /**
   * (#1989) Set of `${structName}_${valueOf|toString|@@toPrimitive}` method full
   * names whose SHARED func body has already been claimed by the first object
   * literal of a deduped anon-struct type. Same-shape literals share a struct
   * type, so the first literal compiled keeps the shared `${name}_valueOf` func
   * (referenced by the host `__call_*`/`__sget_*` exports and name-keyed coercion
   * fallbacks); every LATER same-shape literal forks its own per-literal method
   * func and stores its own funcref in the struct field, so per-instance
   * `call_ref` dispatch resolves to the correct method body per object.
   */
  toPrimitiveSharedClaimed: Set<string>;
  /**
   * (#1989) Set of anon-struct type names that have MORE THAN ONE object literal
   * sharing the deduped struct type and carrying a `valueOf`/`toString`/
   * `@@toPrimitive` method — i.e. the same-shape collision case where each
   * literal stores its own method funcref. Only these structs route the host
   * `__call_*` ToPrimitive dispatch through the per-instance struct-field closure
   * (instead of the name-keyed standalone func, which is the first literal's body
   * and is correct + simpler for the single-literal case). This keeps the
   * single-literal path — including the §7.1.1.1 step-6 TypeError walk — on the
   * well-tested standalone arm, and only opts the genuine collision case into
   * per-instance dispatch.
   */
  toPrimitiveForkedStructs: Set<string>;
  /** Tag index for the exception tag (-1 if not yet registered) */
  exnTagIdx: number;
  /** Whether union type helper imports have been registered */
  hasUnionImports: boolean;
  /**
   * #1121: Function names whose return type was promoted from implicit-`any`
   * to a concrete numeric type (f64) by inferNumericReturnTypes. Used by
   * collectDeclarations to override the TS-derived return type when the
   * recursive numeric kernel pattern is detected.
   */
  numericReturnTypes?: Map<string, ValType>;
  /**
   * Standalone implicit-`any` returns proven numeric independently of the
   * function's parameter carriers. Unlike {@link numericReturnTypes}, these
   * facts do not require every parameter to be f64/i32 at declaration time.
   */
  bindingAwareNumericReturnTypes?: Map<string, ValType>;
  /**
   * #2847: property names whose complete source definition/write set is
   * boolean-producing. Used to preserve JS boolean identity through untyped
   * numeric carriers and sidecar writes; computed conservatively per module.
   */
  booleanPropertyNames: Set<string>;
  /**
   * #3683 S4a: property names whose complete source write set is NUMERIC
   * (`analyzeNumericPropertyNames`). `deriveFnctorFields` promotes a fnctor
   * struct field with such a name from the boxed `externref` carrier to a
   * physical `f64` slot, which is what lets an S2 typed-`this` twin's
   * `struct.get` hand back an unboxed number instead of a value the consumer
   * has to `__unbox_number`. Standalone lane only; `undefined` (⇒ never
   * promote) in host mode and before the pre-pass runs.
   */
  numericPropertyNames?: ReadonlySet<string>;
  /**
   * (#3753 S1) Property names whose EVERY write is provably a string, from the
   * same whole-program walk as {@link numericPropertyNames}. `deriveFnctorFields`
   * gives such a field a native string slot rather than the boxed `externref`
   * carrier, which removes the `ref.test` + `ref.cast` + `__str_flatten` that a
   * boxed slot forces on every read. Standalone lane only, like the numeric
   * verdict.
   */
  stringPropertyNames?: ReadonlySet<string>;
  /**
   * (#3753 S2) Function names proven to return a number on every path, from the
   * same whole-program fixpoint. Lets a `+` whose RHS is such a call unbox the
   * result once rather than boxing BOTH operands into `$AnyValue` and running
   * the generic `__any_add` with a tag-dispatch unbox after it.
   */
  numericFunctionNames?: ReadonlySet<string>;
  /** (#4122) Grounded "every definition of this slot is numeric" verdict from
   *  `analyzeNumericPropertyNames`; absent in the host lane / when disabled. */
  numericLocalVerdict?: (node: ts.Node, name: string) => boolean;
  /** Whole-program "every definition is a string" evidence for linked
   *  implicit-any parameter inference. It does not change local storage. */
  stringLocalVerdict?: (node: ts.Node, name: string) => boolean;
  /**
   * #3673: property names the SOURCE defines as a function-valued member
   * (`collectUserMethodNames`). Consulted by
   * `compileGuardedNativeStringMethodCall` so a `String.prototype`-named
   * method that the program ALSO defines on its own objects (acorn's
   * `RegExpValidationState.prototype.at` vs `String.prototype.at`) gets a real
   * dynamic-dispatch fallback on the `ref.test $AnyString` miss instead of a
   * benign sentinel. `undefined` before the pre-pass ⇒ behave exactly as
   * before.
   */
  userMethodNames?: ReadonlySet<string>;
  /** Set of function names that are async (for .d.ts generation) */
  asyncFunctions: Set<string>;
  /** Set of function names that are generators (function*) */
  generatorFunctions: Set<string>;
  /** Map from generator function name → yield element type */
  generatorYieldType: Map<string, ValType>;
  /** Shared native generator IteratorResult-like struct type index, or -1 before registration. */
  nativeGeneratorResultTypeIdx: number;
  /** Function declarations lowered to Wasm-native generator state machines (#680). */
  nativeGenerators: Map<string, NativeGeneratorInfo>;
  /**
   * (#2865) Async-generator PRODUCERS driven on the async-frame machine, keyed
   * by sanitized stem (the `__async_gen_next_<stem>` suffix). Populated by
   * `emitAsyncGenerator`; consumed by (a) the `.next()` runtime dispatch chain
   * in calls.ts and (b) the stem-collision guard in `isAsyncGenDriveCandidate`
   * (two same-named gens in different scopes would otherwise share one
   * `__async_gen_next_<stem>` helper typed for the FIRST gen's frame — a
   * guaranteed `ref.cast` trap for the second).
   */
  asyncGenProducers?: Map<
    string,
    {
      stateTypeIdx: number;
      nextHelperName: string;
      decl: ts.Node;
      /** (#3389 slice 2a) `__async_gen_return_<stem>` — the `.return(v)` driver. */
      returnHelperName?: string;
      /** (#3389 slice 2a) `__async_gen_throw_<stem>` — the `.throw(e)` driver. */
      throwHelperName?: string;
    }
  >;
  /**
   * (#2865) True once ANY async generator was emitted on the LEGACY buffer path
   * (`__create_async_generator`). The `.next()` runtime dispatch chain uses this
   * to decide its miss arm: with legacy receivers possible it must fall back to
   * the host `__gen_next`; in an all-driven module it emits a plain null instead
   * — referencing `__gen_next` there would force an otherwise-dead host import
   * and break the zero-import (host-free) contract.
   */
  asyncGenLegacyBufferEmitted?: boolean;
  /**
   * (#3132) True once ANY generator (sync OR async) was emitted on the LEGACY
   * eager-buffer path (`__create_generator` / `__create_async_generator`) —
   * the superset of {@link asyncGenLegacyBufferEmitted}. The native
   * `__iterator` HOSTGEN arm (#3075, iterator-native.ts) keys on this: it must
   * fill exactly when a HOST generator object can exist at runtime. Keying on
   * funcMap import presence instead (the eager `__gen_*` bundle registration)
   * would PIN the whole bundle as referenced imports in an all-driven module,
   * breaking the zero-import host-free contract for modules whose every
   * generator lowered natively.
   */
  legacyGenBufferEmitted?: boolean;
  /**
   * (#2980 conservative Promise-lane fallback) True when the module SOURCE has
   * ANY async generator, set in the pre-body `collectDeclarations` walk. On the
   * widened-standalone measure lane, `widenAsyncGenFallback` (async-scheduler.ts)
   * keeps BOTH carrier gates OFF for such a module — a native `$Promise` fed into
   * the gen's legacy `__gen_*` buffer / host `.then` over `__gen_next` mishandles
   * it (the 07-09 async-generator −4). Pre-body so a `Promise.reject` INSIDE the
   * gen sees it. Read only under the measure — wasi + gc/host stay byte-identical.
   */
  moduleHasAsyncGen?: boolean;
  /**
   * (#3132 PR-2) True when the module SOURCE has an async generator that is NOT
   * provably drive-lowered under the native `$Promise` carrier — i.e. one that
   * WILL fall to the legacy `__gen_*`/`__create_async_generator` host buffer:
   * an async gen METHOD (class/obj-literal — not yet wired to the drive), a body
   * outside the bounded drive shape (`asyncGenDrivableUnderCarrier`), a
   * top-level rest param, an unsafe spill, or a stem collision. Set in the
   * pre-body `collectDeclarations` walk (same discipline as
   * {@link moduleHasAsyncGen}). `widenAsyncGenFallback` (async-scheduler.ts)
   * keeps the native carrier OFF ONLY for such a module — the exact case where a
   * native `$Promise` would mix into a host `__gen_*` buffer (the #2980 07-09
   * −4). A module whose async gens are ALL drivable keeps the carrier ON and its
   * driven gens become fully host-free (no Promise host imports). CONSERVATIVE:
   * any doubt sets this true (carrier off = pre-#2980 host-consistent behaviour).
   * Standalone-gated read; wasi (carrier always on) + gc/host unaffected.
   */
  moduleHasNonDrivableAsyncGen?: boolean;
  /**
   * (#2903) True when the module SOURCE contains any construct that can mint a
   * HOST promise under `--target standalone` while the native `$Promise` chain
   * is active: dynamic `import()`, host-routed combinators
   * (`Promise.allSettled`/`any`/`allKeyed`/`allSettledKeyed`, subclass
   * `X.all`/`X.race`), `.finally(…)` (host-routed instance method), or
   * `Array.fromAsync`. Set in the pre-body `collectDeclarations` walk (same
   * discipline as {@link moduleHasAsyncGen} so compile order cannot miss a
   * textually-later producer). The `.then`/`.catch` receiver bridge
   * (`emitStandaloneThenWithNativeFallback`, calls.ts) keys its miss arm on
   * this: with NO host-promise source in the module every runtime promise is a
   * native `$Promise`, so the host fallback arm is provably dead and is
   * replaced by a native TypeError — dropping the `Promise_then*` /
   * `__make_callback` host imports that kept ~626 otherwise-passing standalone
   * modules host-import-leaky (unscored under the honest #2879 metric).
   * Unset/false on the gc/host and wasi lanes (setter is standalone-gated).
   */
  moduleHasHostPromiseSource?: boolean;
  /**
   * (#2903 finally sub-front) `.finally(...)` CallExpression nodes that were
   * lowered to the NATIVE §27.2.5.3 machinery (`emitStandalonePromiseFinally`)
   * — set by the calls.ts finally arms, read by `isAsyncCallExpression`
   * (expressions.ts) to skip the async-call fulfilled-wrap for exactly these
   * nodes: the native lowering already returns a `$Promise`, so the wrap would
   * double-wrap, while the legacy host route (producer modules) still NEEDS
   * the wrap (byte/behaviour parity with pre-native output). A per-node marker
   * keeps the two decisions structurally in lockstep — the wrap check runs
   * AFTER the call compiled, when funcMap-dependent predicates may have
   * drifted.
   */
  standaloneNativeFinallyNodes?: Set<ts.Node>;
  /**
   * Function declarations pre-registered during module-pass eager class body
   * compilation. The entry has a reserved `mod.functions` slot and signature,
   * but its body still belongs to the normal nested-function hoist pass.
   */
  preRegisteredBodyless?: Set<string>;
  /** Map from module-level variable name → global index in mod.globals */
  moduleGlobals: Map<string, number>;
  /** Script `var` names whose global-object properties are non-configurable. */
  globalObjectVarBindings?: Set<string>;
  /** Script `let`/`const`/class names in the declarative half of the global
   * environment. Runtime eval mirrors these through private canonical cells;
   * they are never exposed as ordinary global-object properties. */
  globalLexicalBindings?: Set<string>;
  /** Sloppy unresolvable assignment targets discovered before body compilation. */
  sloppyImplicitGlobals?: Set<string>;
  /**
   * (#2931) Names of function declarations that are *reassigned* somewhere in the
   * realm (`fn = …`). ES function bindings are live/mutable, so such a name is
   * backed by a mutable `externref` module global (registered in `moduleGlobals`)
   * that both the reassignment (`global.set`) and every read (`global.get`) go
   * through. Import aliases of a reassigned function propagate into this set too
   * (see `registerImportBindingAliases`). Empty for the common case (no function
   * declaration is ever reassigned), so non-affected programs stay byte-identical.
   */
  liveFuncBindingGlobals?: Set<string>;
  /**
   * (#4182) Names bound live at MODULE scope by Annex B B.3.3.2 (a sloppy
   * block/`if`/`switch`-nested `function f` whose enclosing var scope is the
   * SourceFile). Subset discipline: every member is also in
   * `liveFuncBindingGlobals` and `moduleGlobals`. Reads/typeof/calls route
   * through the backing externref global; the B.3.3.2.c evaluation step
   * (`tryCompileAnnexBModuleBlockFnEvaluation`) `global.set`s it at the
   * declaration's textual position in `__module_init`. Normally empty.
   */
  annexBModuleBindings?: Set<string>;
  /**
   * (#4182) Per-declaration compiled function index for module-scope Annex B
   * block functions — keeps the #2965 two-pass `__module_init` compile from
   * compiling the same declaration node twice.
   */
  annexBModuleFnIdxByDecl?: WeakMap<ts.FunctionDeclaration, number>;
  /**
   * Per-declaration compiled function index for function-scope Annex B
   * declarations that update an already-instantiated direct-function binding.
   * The bare-name maps are restored to the direct declaration after compiling
   * each inner body, so this node-keyed cache is the stable statement-time
   * lookup for its closure value.
   */
  annexBDistinctFunctionIndices?: WeakMap<ts.FunctionDeclaration, number>;
  /** Deferred `export default <variable>` where variable is a module global (#1108).
   *  Resolved after all collectDeclarations calls when global indices are final. */
  deferredDefaultGlobalExport?: string;
  /** Runtime storage for `export default <expression>` in linked modules.
   * Identifier/function defaults use their existing binding; expression
   * defaults need a stable cell that default imports can alias. */
  defaultExpressionGlobals?: WeakMap<ts.ExportAssignment, { bindingName: string; type: ValType }>;
  /** Module-level variable initializers (compiled into __module_init) */
  moduleInitStatements: ts.Statement[];
  /**
   * (#3623) Top-level ExpressionStatement shapes that the `collectDeclarations`
   * allow-list did NOT collect and that are not provably inert — shape label →
   * count. The allow-list has silently dropped an observable statement at least
   * six times (#1268, #2671, #2992, #3366, #3468, #3592 RC1, #3615), each a
   * silent wrong answer that turned its test into a vacuous pass. Recording the
   * fall-through makes the seventh visible instead of invisible; the map is
   * empty for every program whose top-level statements are all handled.
   */
  droppedModuleInitShapes?: Map<string, number>;
  /**
   * (#2976) Module-level dedupe of the value-closure artifacts for a
   * capture-carrying nested function declaration: funcName → its ONE custom
   * closure struct type and trampoline. Previously every reference site
   * minted a fresh struct type + trampoline function (and a fresh instance —
   * the identity bug). The trampoline is stored by NAME and re-resolved
   * through `ctx.funcMap` at each emission so late-import funcIdx shifts
   * cannot desync a cached raw index.
   */
  nestedFnClosureArtifacts?: Map<string, { structTypeIdx: number; trampolineName: string }>;
  /** (#4139) Closure struct type minted for a lifted arrow / function
   *  expression, keyed by the AST node. The fnctor twin build reads it to
   *  materialize the ctor's sibling captures from the closure value that
   *  arrives as the standalone `__constructor_identity` param. */
  closureStructByNode?: WeakMap<ts.Node, { structTypeIdx: number }>;
  /** Nested function capture info. */
  nestedFuncCaptures: Map<
    string,
    {
      name: string;
      outerLocalIdx: number;
      mutable?: boolean;
      valType?: ValType;
      /**
       * #1205: Whether this capture's TDZ flag must be propagated to the lifted
       * function as an extra leading param. When true, the lifted fn signature
       * gains a trailing flag-ref-cell param after all value captures and the
       * call site (calls.ts) prepends the boxed flag ref. Mirrors the arrow-
       * function Stage 3 wiring in `compileArrowAsClosure`.
       */
      hasTdzFlag?: boolean;
      /**
       * #1205: At-construction-time outer-fctx flag local index. May point
       * to either the raw i32 flag local (must be wrapped at the call site)
       * or an already-boxed ref-cell local (passed through directly). Stored
       * as metadata so the call site can re-resolve via `fctx.tdzFlagLocals`
       * / `fctx.boxedTdzFlags` at call time.
       */
      outerTdzFlagIdx?: number;
    }[]
  >;
  /**
   * (#4133 / #4134) Which nested `FunctionDeclaration` currently owns a
   * `funcMap` name.
   *
   * `funcMap` and `nestedFuncCaptures` are keyed by BARE name and are global
   * and permanent, but a nested function declaration lexically SHADOWS any
   * outer or imported binding of the same name, and only for the extent of its
   * enclosing body. Without an owner record the hoist loop cannot tell "this
   * exact declaration is already compiled" (skip) from "some unrelated module's
   * function happens to have this name" (must still compile, shadowing it).
   * Absent ⇒ the name belongs to a top-level declaration, an import, or a
   * synthesized runtime helper — never to a nested declaration.
   */
  funcMapOwnerDecl: Map<string, ts.FunctionDeclaration>;
  /** Map from child className → parent className (for local class inheritance) */
  classParentMap: Map<string, string>;
  /**
   * (#1366a) Map from child className → built-in JS parent name when the parent
   * is a host-constructible builtin (Error / TypeError / RangeError / ...).
   * Subclass instances are externref-backed; `super(args)` lowers to
   * `__new_<Parent>(args)` instead of the field-walk path.
   */
  classBuiltinParentMap: Map<string, string>;
  /**
   * (#1366a) Set of class names whose runtime instance representation is
   * externref (NOT a WasmGC struct). Constructor return type, `new` result
   * type, and `instanceof` routing all consult this set. Currently populated
   * for subclasses of host-constructible builtins.
   */
  classExternrefBackedSet: Set<string>;
  /** Counter for assigning unique class tags (for instanceof support) */
  classTagCounter: number;
  /** Map from class name → unique tag value (for instanceof support) */
  classTagMap: Map<string, number>;
  /** Map from TS symbol name → synthetic class name for class expressions */
  classExprNameMap: Map<string, string>;
  /** Map from ClassExpression AST node → synthetic class name */
  anonClassExprNames: Map<ts.ClassExpression, string>;
  /** Map from function/class identifier → its ES-spec .name string value */
  functionNameMap: Map<string, string>;
  /** Whether to attach source positions for source map generation */
  sourceMap: boolean;
  /** Map from tuple type signature key → type index of the tuple struct */
  tupleTypeMap: Map<string, number>;
  /** Fast mode: default number to i32, promote to f64 only when needed */
  fast: boolean;
  /**
   * (#745) When true, statically-known heterogeneous primitive unions
   * (`number | string`, `string | boolean`, … — see
   * `isHeterogeneousPrimitiveUnion`) resolve to the universal `$AnyValue`
   * tagged carrier instead of externref, eliminating per-op box/unbox/typeof
   * helper round-trips. **Default derived from the lane** (#745 S4.5): ON for
   * native-string lanes (the computed `nativeStrings` const) now that the S3
   * (strict-eq / truthiness / string-concat) and S4 (params / returns /
   * any-boundary) consumer sweeps made those paths carrier-agnostic; the
   * JS-host lane stays default-OFF until S5 (hard-gated on #2141). Explicit
   * `CodegenOptions.unionAnyRep` wins; env kill-switch `JS2WASM_UNION_ANYREP=0`
   * forces the legacy externref regime for A/B. Modules with no such union
   * (and that never emit `__any_unbox_bool`) emit byte-identical wasm
   * regardless — see #745 S4.5 decision 4 for the two intended drift classes.
   */
  unionAnyRep: boolean;
  /** Use WasmGC-native strings instead of wasm:js-string imports */
  nativeStrings: boolean;
  /** #1719 S1 — `ITER_OVERRIDDEN` whole-program brand for the array
   *  object-value representation track. Set by the `sourceOverridesArrayIterator`
   *  pre-scan (in index.ts) when the program may monkeypatch
   *  `Array.prototype[Symbol.iterator]` / `Array.prototype.values`
   *  (assignment or `Object.define{Property,Properties}(Array.prototype, …)`).
   *  When `false` (the common case) every array-destructuring site emits
   *  byte-identical output and takes the existing backing-store fast path.
   *  The S2 slice consults this flag to route a branded array RHS through the
   *  host-Array reflection + host `GetIterator` so an overridden `@@iterator`
   *  is observed (§7.4.2 / §8.5.2). Default `false`. */
  arrayIteratorMaybeOverridden: boolean;
  /** #1588 PR-B: dual i8/i16 storage. When true (and `nativeStrings`),
   *  string allocation sites proven `ascii`/`utf8-guaranteed` by the encoding
   *  analysis use an i8-backed `Utf8String`; everything else stays i16.
   *  Default false → byte-identical to today (the Utf8String types are not
   *  even registered when off). */
  utf8Storage: boolean;
  /** Native string support type indices */
  nativeStrDataTypeIdx: number;
  anyStrTypeIdx: number;
  nativeStrTypeIdx: number;
  consStrTypeIdx: number;
  /** (#3673 round 9) `$HashedString <: $NativeString` with a cached FNV-1a
   *  hash field — allocated only by interned literal globals (hash baked at
   *  compile time) and `__str_flatten` memoized flat copies (lazy); consumed
   *  by `__obj_hash`'s cache fast path. -1 when native strings are off. */
  hashedStrTypeIdx: number;
  /**
   * (#3673) Interned native-string literal globals: literal value (prefixed by
   * encoding kind) → module-global index of an immutable `(ref $NativeString)`
   * / `(ref $Utf8String)` global whose constant init materializes the literal
   * ONCE at instantiation. Before this, every execution of a literal site
   * re-allocated the backing array + struct — measured as the dominant
   * allocation source of a standalone compiled-acorn parse (the `__extern_get`
   * member ladder allocates its comparison literal per probe per call).
   */
  nativeStrLiteralGlobals: Map<string, number>;
  /**
   * (#3469) Standalone host-free `console.log`/`print` output sink. On
   * `--target standalone` `console.log` has no host import and no `fd_write`
   * (unlike WASI), so it lowered to a pure no-op (#3436) — which made the
   * test262 async completion marker (`$DONE → print → console.log(
   * "Test262:AsyncTestComplete")`) unobservable. When the source uses
   * `console.*` in standalone mode, `finalizeUnifiedCollector` sets this flag;
   * the pre-body phase then mints an in-module `$AnyString` accumulator global
   * (`__stdout_acc`, index below) + a `__stdout_append` helper, and finalize
   * emits `__stdout_prepare`/`__stdout_char` readout exports (mirroring the
   * `__exn_render_*` pattern) so the runner can read printed output host-free.
   */
  usesStandaloneConsoleSink: boolean;
  /** (#3469) Global index of the `__stdout_acc` accumulator, -1 until minted. */
  stdoutAccGlobalIdx: number;
  /**
   * (#2866) Type index of the native `$Symbol` carrier struct
   * `(struct (field $id i32) (field $desc (ref null $AnyString)))`, used in
   * `--target standalone`/`wasi` (host-free) to represent a Symbol value as a
   * real GC reference instead of leaking the host-only `env::__box_symbol`
   * import. Identity is decided by the i32 `$id` (well-known symbols get fixed
   * ids 1-12, `Symbol()` ids monotonically from 100), so `Symbol("x") !==
   * Symbol("x")` and the same well-known symbol is `===`. -1 until registered by
   * `ensureSymbolCarrier`.
   */
  symbolTypeIdx: number;
  /**
   * (#40) Immutable `(array i32)` type index for the Unicode case-mapping tables
   * (emitNativeCaseConversion). Registered once on first use.
   */
  caseTableArrTypeIdx?: number;
  /**
   * (#4234) Immutable `(array f64)` type index for the decimal-scaling
   * power-of-ten table used by the native string→number parsers
   * (`parse-number-native.ts`). Registered once on first use.
   */
  pow10ArrTypeIdx?: number;
  /** (#4234) Global index of the `10^0 … 10^308` table built on that type. */
  pow10TableGlobalIdx?: number;
  /** #1588 PR-B: i8 backing array + Utf8String subtype indices. -1 when
   *  `utf8Storage` is off (types not registered). */
  utf8StrDataTypeIdx: number;
  utf8StrTypeIdx: number;
  /** #1588 PR-B: the live AllocSiteRegistry from the IR pipeline, threaded so
   *  the string-lowering sites can read the `encoding` annotation. Undefined
   *  for non-IR / legacy front-end paths (→ encoding reads back `wtf16`). */
  allocRegistry?: import("../../ir/alloc-registry.js").AllocSiteRegistry;
  /** Whether native string helper functions have been emitted */
  nativeStrHelpersEmitted: boolean;
  /** Whether native string host bridge helpers have been emitted */
  nativeStrExternBridgeEmitted: boolean;
  /** Whether the testRuntime string helpers (#1187) have been emitted */
  testRuntimeStringHelpersEmitted: boolean;
  /** Test-only: emit testRuntime string-coercion exports (#1187). */
  testRuntime: boolean;
  /** Map from native string helper name → function index */
  nativeStrHelpers: Map<string, number>;
  /** #1103a: Wasm-native Map runtime (standalone / WASI). All -1 / empty until
   *  `ensureMapRuntimeTypes` / `ensureMapHelpers` run; only used when the
   *  native-collections path is active (gated on nativeStrings/standalone). */
  mapTypeIdx: number;
  mapEntryTypeIdx: number;
  mapEntriesTypeIdx: number;
  mapBucketsTypeIdx: number;
  mapIterTypeIdx: number;
  /** Shared {value, done} iterator-result struct for native collections. */
  mapIterResultTypeIdx: number;
  /** Map from native Map helper name → function index. */
  mapHelpers: Map<string, number>;
  /** #3242: Wasm-native WeakRef struct `{ target: anyref (immut) }` for
   *  standalone / WASI. `-1` until `ensureWeakRefStruct` registers it (gated on
   *  nativeStrings). Strong-backed — no real GC weakness (WasmGC has no weak
   *  refs; no passing spec test observes the difference). */
  weakRefTypeIdx: number;
  /** Whether the Map runtime helper functions have been emitted. */
  mapHelpersEmitted: boolean;
  /** #1539: map from native standalone-regex helper name → function index.
   *  Mirrors `nativeStrHelpers`; populated by `src/codegen/native-regex.ts`. */
  nativeRegexHelpers: Map<string, number>;
  /** #1677: import-function count captured the instant the native-string
   *  helpers were first emitted (mid-finalize). Used by
   *  `reconcileNativeStrFinalizeShift` to shift the helper bodies + map by the
   *  number of imports added afterwards during the rest of finalize. -1 until
   *  helpers are emitted; reset to -1 once reconciled. */
  nativeStrHelperImportBase: number;
  /** Map from value type kind → ref cell struct type index */
  refCellTypeMap: Map<string, number>;
  /** Type index of the $AnyValue boxed-any struct */
  anyValueTypeIdx: number;
  /**
   * (#3169) The `any === any` binary expression whose operands are CURRENTLY
   * being compiled through the `$AnyValue` equality dispatch
   * (`compileAnyBinaryDispatch` → emitStrictEq/emitLooseEq), set/restored
   * around that call in binary-ops.ts. The #3037 read-carrier
   * (`maybeWrapAnyReadEqualityCarrier`) fires ONLY when its operand's parent
   * is this expression — guaranteeing the `ref $AnyValue` it produces is
   * consumed by `__any_strict_eq` and never by an equality path chosen while
   * `$AnyValue` was still unregistered (a mid-operand lazy registration flips
   * `anyValueTypeIdx` ≥ 0 AFTER binary-ops' entry decision — the
   * `obj[idx] !== val` spurious-neq hazard). `undefined` when no any-equality
   * dispatch is active.
   */
  activeAnyEqDispatchExpr?: ts.BinaryExpression;
  /**
   * (#2106 S1) Global index of the standalone `$undefined` singleton — an
   * immutable tag-1 `$AnyValue`, reserved up-front at `ensureAnyValueType` time
   * so `undefined` is distinguishable from `null` (`ref.null extern`) in
   * standalone/native-strings mode. `undefined` otherwise has no host value and
   * conflates with null. Reserved as a GLOBAL (not a late func import) to avoid
   * the #329 native-string finalize-shift hazard. `undefined` until reserved.
   */
  undefinedGlobalIdx?: number;
  /**
   * (#3032 W6) Type index of the TIP of the per-module `__GenBrand_n` chain —
   * the empty supertype structs that make each native generator's state
   * struct NOMINALLY distinct (same-shape state structs otherwise merge under
   * WasmGC iso-recursive canonicalization, cross-matching every
   * `ref.test $__GenState_*` dispatch arm). Each `registerNativeGenerator`
   * mints the next brand as a subtype of this tip and advances it.
   * `undefined` until the first native generator registers.
   */
  genStateBrandTipIdx?: number;
  /**
   * (#3032 / #2141-S2) Global index of the `mut i32` `__gen_eager_mode` flag
   * for LAZY generator-expression creation. 0 (default) = a zero-param
   * `function*(){}` expression returns a lazy thunk generator
   * (`__create_generator(<self closure>, null)`); the host sets the flag via
   * the exported `__gen_set_eager` around the deferred first-`next()` body
   * run. Reserved lazily by `ensureGenEagerFlag` (closures.ts); `undefined`
   * until the first lazy-eligible generator expression is compiled.
   */
  genEagerFlagGlobalIdx?: number;
  /** Map from any-value helper name → function index */
  anyHelpers: Map<string, number>;
  /** Whether any-value helper functions have been emitted */
  anyHelpersEmitted: boolean;
  /** (#1789) Whether the WASI module-init guard (idempotent __module_init +
   *  prepended init call on exports) has been applied. */
  moduleInitGuardApplied: boolean;
  /**
   * #1984 — freeze-point discipline (child of #2043 Option 3). Set to `true`
   * by `generateModule`/`generateMultiModule` once the module's index spaces
   * are final (right before `stackBalance`, after the last legitimate
   * `addUnionImports`/`addStringImports`/`reconcileNativeStrFinalizeShift`
   * mutation in every mode). While set, `addImport`/`ensureLateImport` throw a
   * named producer-site error instead of silently mutating a finalized import
   * space — so the producer that added an import too late self-identifies with
   * its own stack, rather than #2043's emit-time validation only naming the
   * downstream symptom. Default `false`. */
  indexSpaceFrozen: boolean;
  /** Shape-inferred array-like variables */
  shapeMap: Map<string, { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType }>;
  /** Set of function names that failed during hoisting pre-pass */
  hoistFailedFuncs?: Set<string>;
  /** Counter for unique tagged template cache global variables */
  templateCacheCounter: number;
  /** Type index for template vec struct */
  templateVecTypeIdx: number;
  /**
   * (#4222 ES5 residual) Dedicated `new Array(n)` sparse carrier. This is a
   * subtype of the ordinary externref vec, never a module-wide mode: only
   * pre-scanned constructor sites may materialize it.
   */
  holeyArrayTypeIdx: number;
  /**
   * (#2186) Type index for the shared `$__vec_base` supertype — a `(length i32)`
   * struct that every `__vec_<elemKind>` subtypes. Lets standalone runtime
   * helpers (`__extern_length`) `ref.test`/`ref.cast` a boxed array externref
   * to read its `.length` uniformly, regardless of element kind. -1 = not yet
   * registered (created lazily on first `getOrRegisterVecType`).
   */
  vecBaseTypeIdx: number;
  /**
   * (#2159 / #38) Type index for the standalone `$__dv_window` struct — a
   * `{buf: (ref null __vec_i32_byte), byteOffset: i32, byteLength: i32}` wrapper
   * produced by `new DataView(buffer, byteOffset, byteLength)` when the view is
   * windowed (offset > 0 or an explicit byteLength). Lets the native DataView
   * accessors add `byteOffset` to every byte index while sharing the parent's
   * backing array (so windowed writes are visible through the full view), and
   * lets `dv.byteOffset`/`dv.byteLength` reflect the ctor args. -1 = not yet
   * registered (created lazily). Offset-0 default-length views keep the bare
   * i32_byte vec representation (no wrapper, zero new cost).
   */
  dvWindowTypeIdx: number;
  /**
   * (#2159 / #2357 / #47) Type index for the standalone `$__subview` struct — a
   * `{base: (ref null __vec_<elem>), byteOffset: i32, length: i32}` view produced
   * by `TypedArray.prototype.subarray(begin, end)`. It SHARES the parent's backing
   * `data` array (true aliasing — a sub-write is visible in the parent) and carries
   * the element offset + windowed length. Element access discriminates view-vs-plain
   * at COMPILE time via the receiver's resolved ValType (a binding initialised by
   * `subarray` resolves to `$__subview`), so the plain-array `a[i]` hot path takes
   * ZERO extra instructions — no per-access runtime branch. Keyed per element kind
   * in `subviewTypeMap`; this scalar holds the most-recently-registered idx for
   * back-compat. -1 = not yet registered. (Spec: plan/issues/2357.)
   */
  subviewTypeIdx: number;
  /** (#2357) Per-element-kind `$__subview` struct type indices, keyed by elemKind. */
  subviewTypeMap: Map<string, number>;
  /**
   * (#3054 B1) Per-TypedArray-name `$__ta_view_<name>` struct type indices, keyed
   * by the TS view name (`"Uint8Array"`, `"Int32Array"`, …). A `$__ta_view` is a
   * byte-backed TypedArray view that holds a ref to the source ArrayBuffer's
   * `$__vec_i32_byte` struct (SHARED backing — sibling views and DataViews over
   * the same buffer observe each other's writes) plus an element `byteOffset`.
   * Element access byte-decodes little-endian via the dataview-native engine,
   * discriminated at COMPILE time by the receiver's resolved ValType.typeIdx
   * (mirroring `subviewTypeMap`), so plain-array / native-TA hot paths are
   * byte-inert. Map miss = not registered. (Spec: plan/issues/3054 Phase A/B1.)
   */
  taViewTypeMap: Map<string, number>;
  /**
   * (#3054 C) Type index for the standalone `$__resizable_ab` struct — a WasmGC
   * SUBTYPE of `$__vec_i32_byte` carrying an extra `maxByteLength: i32` field:
   * `{length: i32 (mut), data: (ref $__arr_i32_byte) (mut), maxByteLength: i32}`.
   * Produced by `new ArrayBuffer(n, {maxByteLength})`. The subtype identity IS the
   * resizable bit (`ref.test $__resizable_ab` ⇒ resizable; a plain
   * `$__vec_i32_byte` ⇒ fixed) — no separate flag needed. Because it is a subtype,
   * the 23 `i32_byte` read sites `ref.cast` to the parent vec UNCHANGED (is-a);
   * only the resizable-aware sites (ctor, `.resize()`, `.maxByteLength`/`.resizable`
   * getters) know the subtype. Registered late+once (mirrors `getOrRegisterTaViewType`),
   * so the subtype always follows its supertype in type-index order → no reorder
   * hazard. -1 = not yet registered. (Spec: plan/issues/3054 Phase A A.2.)
   */
  resizableAbTypeIdx: number;
  /**
   * (#3054 D) Type index for the standalone `$__ta_ctor` struct — a first-class
   * runtime value for a TypedArray CONSTRUCTOR used in value position
   * (`const c = Uint8Array`, `ctors = [Uint8Array, …]`, a `new ctor(rab)` callee).
   * `{kind: i32}` where `kind` indexes `TA_CTOR_KINDS` (the 9 element kinds). Before
   * this a bare TA name in value position degraded to `ref.null.extern`
   * (indistinguishable — `Uint8Array === Int8Array` was `true`), so a dynamic
   * `new ctor(rab)` dropped the ctor and produced null. The `kind` field drives the
   * runtime-switch dynamic construct + `ctor.BYTES_PER_ELEMENT`. Registered
   * late+once; -1 = not yet registered. Byte-inert: only emitted when a TA ctor is
   * used as a value. (Spec: plan/issues/3054 Phase A/D.)
   */
  taCtorTypeIdx: number;
  /** (#3054 D) Per-kind memoized singleton module-global holding the boxed `$__ta_ctor` value (identity via `ref.eq`). Key = kind index. */
  taCtorSingletonGlobals: Map<number, number>;
  /**
   * (#3054 D) Type index for `$__ta_dyn_view` — a shared-backing TypedArray view
   * whose element kind is only known at RUNTIME (built by a dynamic `new
   * ctor(rab)`). Unlike B1's per-kind `$__ta_view_<K>` (which are structurally
   * identical → WasmGC canonicalizes them to ONE runtime type, so `ref.test` can't
   * recover the kind), this struct carries a `kind: i32` field:
   * `{length: i32 (mut), buf: (ref null $__vec_i32_byte), byteOffset: i32, kind: i32}`,
   * subtype of `$__vec_base`. All dynamic-view access (`.byteLength`, element
   * get/set) dispatches on the stored `kind` (not `ref.test`). Registered late+once;
   * -1 = not yet registered. Byte-inert: only emitted for a dynamic `new ctor(…)`.
   */
  taDynViewTypeIdx: number;
  /**
   * (#3140) Type index for `$__bound_fn` — the standalone/WASI native
   * bound-function carrier minted by `Function.prototype.bind`:
   * `{target: externref, thisArg: externref, boundArgs: externref ($ObjVec)}`.
   * `__apply_closure` carries a front-guard that unwraps it (prepending
   * `boundArgs`) and the closure classifier treats it as callable, so
   * `typeof bound === "function"` and bound-of-bound chains work. Registered
   * late+once; -1 = not yet registered. Byte-inert: only emitted when a
   * standalone `.bind(...)` site compiles.
   */
  boundFnTypeIdx: number;
  /**
   * (#3057) Set by a module pre-scan when the source contains a dynamic
   * `new <ctorVar>(bufferArg)` (a `$__ta_dyn_view`-producing construct). Enables the
   * runtime-kind element byte-codec arm on the generic dynamic index path (`ta[i]` /
   * `ta[i]=v` for an `any` receiver) even in a helper function compiled BEFORE the
   * construct — the `$__ta_dyn_view` type is registered lazily, so a plain
   * `taDynViewTypeIdx >= 0` check would miss cross-function reads (ToNumbers/Collect).
   * Byte-inert: false for any module without the construct, so those never emit the
   * codec arm and never register the type.
   */
  moduleUsesDynTaView: boolean;
  /** Type index for the WasmGC `$Error_struct` used in standalone/WASI mode (#1104). -1 = not yet registered. */
  errorStructTypeIdx: number;
  /**
   * Extra properties for empty object variables.
   *
   * (#3364) Keyed by a PER-DECLARATION key (`widenedVarKey`, name + decl start
   * offset), NOT the bare variable name. Acorn's parser reuses generic local
   * names (`node`, `type`, …) across many functions, each building an object
   * with a DIFFERENT field set; bare-name keying let the last widening win, so
   * every other same-named var built the WRONG struct — dropping its real field
   * values, so `.callee`/`.type`/… read back null (the in-Wasm AST walk then
   * ran away). Per-declaration keys keep each var's shape distinct.
   */
  widenedTypeProperties: Map<string, { name: string; type: ValType }[]>;
  /** Map from widened variable's per-declaration key (#3364) to its registered struct name */
  widenedVarStructMap: Map<string, string>;
  /** Widened empty-object fields introduced by Object.defineProperty rather than assignment. */
  widenedDefinePropertyKeys: Set<string>;
  /**
   * (#2372) Standalone-only: receiver var names that are the target of at least
   * one `Object.defineProperty(var, key, desc)` where `desc` is a *dynamic*
   * (non-inline-literal) descriptor. Such defines are applied via the native
   * `__obj_define_from_desc` `$Object` runtime, which the struct-widening read
   * path (`struct.get`) cannot observe. Membership here suppresses
   * struct-widening for the receiver so it stays on the `$Object` representation
   * and both the dynamic write and the read-back route through the native
   * runtime consistently. Empty in host/gc/wasi mode (only populated under
   * `ctx.standalone`).
   */
  dynamicDescriptorWidenVars: Set<string>;
  /**
   * (#2584) Standalone-only: receiver var names that are the subject of at least
   * one `$Object`-hash-only operation — bracket read/write (`o[k]`), `key in o`,
   * `Object.keys/values/entries/getOwnPropertyDescriptor/getOwnPropertyNames(o)`,
   * `Object.assign(o, …)` / `Object.assign(…, o)`, or `for (… in o)`. These
   * consumers all read the native `$Object` open-hash runtime, which a widened
   * closed WasmGC struct is invisible to. A var written via dot-access AND read
   * via any of these would otherwise widen to a struct on the write side but miss
   * it on the read side (`o.a = 7; o["a"]` → 0). Membership here suppresses
   * struct-widening for the receiver so it stays a `__new_plain_object` /
   * `$Object`; dot-writes then route through `__extern_set` and every access form
   * reads the same hash consistently. Mirrors `dynamicDescriptorWidenVars`; the
   * two sets are additive. Empty in host/gc/wasi mode (only populated under
   * `ctx.standalone`).
   */
  objectHashConsumerVars: Set<string>;
  /**
   * (#2937) HOST-mode companion to `objectHashConsumerVars`, keyed by ts.Type
   * identity instead of variable name. In a JS-mode source file (acorn.mjs),
   * the checker EVOLVES `var o = {}` through its later static-named writes into
   * an anonymous object type WITH those properties. `resolveWasmType` /
   * `ensureStructForType` would auto-register that evolved type as a closed
   * `__anon_N` struct and type the LOCAL (and every flow position: returns,
   * class fields, receivers) as `(ref null __anon_N)` — while the poisoned
   * initializer builds a host plain object (externref). The declaration's
   * guarded cast then stores ref.null and every static read null-derefs (the
   * compiled-acorn `getOptions` uniform throw). Types recorded here refuse
   * struct resolution and stay externref end to end, so ALL access forms on a
   * poisoned var route through the host MOP (`__extern_get`/`__extern_set`)
   * coherently. Populated only in host/gc/wasi mode (standalone keeps its
   * pre-existing codegen byte-identical; its matching gap is filed separately).
   */
  objectHashConsumerTypes: Set<ts.Type>;
  /** Functions proven to return an open `$Object` populated via computed keys. */
  dynamicObjectReturnFunctions: Set<string>;
  /**
   * (#2837) Variable names initialized by a NON-EMPTY object literal that later
   * receives an OUT-OF-SHAPE property write (a direct `V.k=` with `k` not in the
   * literal's static shape, or a nested depth-≥2 write `V.a.b…=` onto a nested
   * descriptor object — the acorn `prototypeAccessors.inFunction.get = fn`
   * idiom). A non-empty literal is otherwise lowered to a CLOSED struct whose
   * field set is frozen at the literal shape, so such a write lowers to
   * `drop` and the read to `ref.null extern` (the getter is never installed →
   * `inFunction` reads 0 → every `return` throws). Membership routes the literal
   * through the existing recursive externref `$Object` builder
   * (`compileObjectLiteralAsExternref`) and types the local externref (via
   * `externrefAccessorVars`), so every access goes through `__extern_get`/`set`.
   * Populated by `collectGrowableObjectLiterals` (declarations.ts); a
   * consumer-safety guard keeps struct-typed-consumer vars OFF this set to avoid
   * the #1897 closed-struct-consumer regression.
   */
  growableObjectLiteralVars: Set<string>;
  /**
   * (#671 W1) Declaration-site keys for direct-DeleteBinding `with` targets
   * whose planner/proof selected the canonical open-object carrier. Member
   * reads and writes consult this keyed set rather than the bare-name
   * growable-object set: a same-named local in another scope must retain its
   * pre-existing representation and static member lowering.
   */
  irWithOpenObjectTargetKeys: Set<string>;
  /**
   * (#4208) Exact declarations whose shared `var` binding is repeatedly
   * initialized with different OrdinaryToPrimitive method shapes. These
   * literals must use the open `$Object` carrier: a closed anonymous struct
   * cannot safely receive a later sibling shape, and the guarded reassignment
   * otherwise stores null before `valueOf` / `toString` can run.
   *
   * Declaration identity is intentional. A bare-name set would poison every
   * unrelated local named `object` in the same compilation unit.
   */
  ordinaryToPrimitiveObjectDeclarations: Set<ts.VariableDeclaration>;
  /** Initializer-node twin of `ordinaryToPrimitiveObjectDeclarations`. */
  ordinaryToPrimitiveObjectLiterals: Set<ts.ObjectLiteralExpression>;
  /** Module-global names whose direct non-specific spread initializer is an open object. */
  hostSpreadObjectGlobals: Set<string>;
  /**
   * (#1239) Variable names whose initializer is an object literal carrying
   * `get`/`set` accessors. Such variables are stored as plain JS host
   * objects (via `__new_plain_object` + `__defineProperty_accessor`) and
   * must NEVER be treated as a wasmGC struct ref — every read/write goes
   * through the externref host path so V8's accessor descriptor fires.
   *
   * Populated in `compileObjectLiteralWithAccessors` (literals.ts) and
   * consulted by `resolveStructNameForExpr` and `resolveEffectiveStructName`
   * to short-circuit the struct-resolution chain back to `undefined`.
   */
  externrefAccessorVars: Set<string>;
  /** Math methods that need inline Wasm implementations */
  pendingMathMethods: Set<string>;
  /**
   * (#1602) Object-method-as-closure trampolines whose body forwards the
   * method's params positionally. The method's `func.typeIdx` can be
   * re-resolved (param types / order finalized) AFTER the trampoline was
   * emitted, which would leave the eagerly-built forwarding body referencing a
   * stale signature and produce an invalid module. We rebuild each trampoline
   * body against the method's FINAL signature in a post-pass after all function
   * bodies are compiled.
   */
  pendingMethodTrampolines: {
    trampolineBody: Instr[];
    /** The trampoline's own func index. */
    trampolineFuncIdx: number;
    methodFuncIdx: number;
    objStructTypeIdx: number;
    /** User-param count the wrapper func type was built with (excludes self). */
    userParamCount: number;
    /**
     * (#1669) The wrapper func type's user-param types and result, captured at
     * emit time. These are the static types of the `local.get`s the forwarding
     * body reads, and the type the trampoline must return. The method's
     * signature can drift away from these during later body compilation; the
     * finalize pass coerces each forwarded arg from `wrapperUserParams[i]` to
     * the method's final param type, and the method's result back to
     * `wrapperResult`, so the rebuilt body validates against both signatures.
     * Captured directly (not re-derived from `trampolineFuncIdx`) because late
     * import shifting can move that index relative to the recorded value.
     */
    wrapperUserParams: ValType[];
    wrapperResult: ValType | undefined;
    /**
     * (#1340) True when the underlying callable is a plain function declaration
     * with no hidden `this` param (so the finalizer must NOT slice off the
     * first param of `sig.params` and must NOT emit a `ref.null` prologue for
     * `this`). Methods leave this false/undefined and keep the legacy
     * `this`-drop behaviour.
     */
    noThisParam?: boolean;
    /**
     * (#1809) True when `methodFuncIdx` already pointed at a host IMPORT at
     * registration time — e.g. a DOM/host global (`resizeTo`, `scrollBy`) or
     * any `declare`d function used as a first-class value, where the trampoline
     * legitimately forwards into an imported function. The late-import shift
     * walker keeps import indices stable (new imports append at the end, so it
     * only bumps indices `>= importsBefore` and leaves existing import targets
     * untouched), so an import target at finalize is EXPECTED here, not a missed
     * shift. The #1525b guard must only fire when a target that was a DEFINED
     * function at registration resolves to an import at finalize.
     */
    methodTargetsImport?: boolean;
    /**
     * (#2025) Whether the method body reads `this` (param 0), computed at
     * registration BEFORE the TypeError-helper late import shifts function
     * indices (which would make a finalize-time `methodFuncIdx` lookup point at
     * the wrong function). Finalize reuses this captured value to decide whether
     * the trampoline's null-`this` arm throws a catchable TypeError.
     */
    methodUsesThis?: boolean;
  }[];
  /** True if Math.clz32 or Math.imul is used — requires ToUint32 Wasm helper */
  needsToUint32: boolean;
  /** Map from class name → class AST declaration node */
  classDeclarationMap: Map<string, ts.ClassDeclaration | ts.ClassExpression>;
  /** Cache for function type deduplication: signature key → type index */
  funcTypeCache: Map<string, number>;
  /** Wrapper type indices */
  wrapperNumberTypeIdx: number;
  wrapperStringTypeIdx: number;
  wrapperBooleanTypeIdx: number;
  /** Native union-helper carrier type indices, present under WASI/standalone. */
  nativeBoxNumberTypeIdx: number;
  nativeBoxBooleanTypeIdx: number;
  nativeBigIntTypeIdx: number;
  /** Cache for function reference wrappers: signature key → ClosureInfo */
  funcRefWrapperCache: Map<string, ClosureInfo>;
  /** #3371: constructible ordinary-function wrapper subtypes, keyed by signature. */
  constructibleFuncRefWrapperCache: Map<string, ClosureInfo>;
  /** #3371: exact wrapper/subtype identities which implement [[Construct]]. */
  constructibleClosureTypeIdxs: Set<number>;
  /**
   * (#3981) Per-arity `"prototype"` key push for the reserved standalone
   * `__native_construct_<N>` drivers. Built at the call site (reserve time) and
   * replayed into the driver body at finalize, because the string-constant
   * machinery belongs to the mid-compile phase while the body is filled after
   * `__call_fn_method_<N>` exists.
   */
  nativeConstructProtoKey: Map<number, Instr[]>;
  /**
   * (#3433) Per-compile memo: source file → symbols assigned an async function
   * expression via `x = async function …` / `x = async () => …` anywhere in the
   * file. Replaces the O(call-sites × file-size) full-file rescan that
   * `symbolBindsAsyncFunction` (#2612) performed for EVERY call expression whose
   * earlier async checks fell through (i.e. every ordinary sync call). On the
   * oracle-v8 test262 harness assemblies (6–18 KB per test) that rescan was
   * ~40 % of total compile time. Lazily initialized on first query.
   */
  asyncAssignScanCache?: Map<ts.SourceFile, ReadonlySet<ts.Symbol>>;
  /**
   * (#3433) Per-compile memo: source file → (symbol of an identifier
   * assignment target → RHS expressions of every `ident = <rhs>` in the file).
   * Single walk shared by `resolveAssignedNominalType` (#2767), which
   * previously re-walked the whole file per bare-`var`/`let` receiver query.
   * RHS type resolution stays lazy per queried symbol (unchanged checker-call
   * pattern for matches). Lazily initialized on first query.
   */
  identAssignRhsCache?: Map<ts.SourceFile, ReadonlyMap<ts.Symbol, readonly ts.Expression[]>>;
  /** Pending module-init body (not yet in mod.functions) that needs global index fixup */
  pendingInitBody: Instr[] | null;
  /** Map from function name to inlinable function info */
  inlinableFunctions: Map<string, InlinableFunctionInfo>;
  /** Global index of the __symbol_counter */
  symbolCounterGlobalIdx: number;
  /** (#2163) Global index of the native symbol id→description table
   *  (`ref_null` to an array of `$AnyString`), lazily allocated. -1 until first
   *  use. Standalone-mode native `.description` storage. */
  symbolDescGlobalIdx: number;
  /** (#2163) Type index of the symbol description table's array type
   *  (`array (mut (ref null $AnyString))`). -1 until created. */
  symbolDescArrTypeIdx: number;
  /** (#2163) Native `Symbol.for`/`Symbol.keyFor` registry (standalone mode).
   *  Two parallel growable arrays — slot→key string (reuses
   *  `symbolDescArrTypeIdx`) and slot→symbol id (`array (mut i32)`) — plus a
   *  count global. All -1 until the first `Symbol.for`/`keyFor`. */
  symbolRegKeysGlobalIdx: number;
  symbolRegIdsGlobalIdx: number;
  symbolRegCountGlobalIdx: number;
  /** (#2163) Type index of the registry ids array (`array (mut i32)`). */
  symbolRegIdsArrTypeIdx: number;
  /** Stack of in-progress parent function bodies for index shifting during closure compilation */
  parentBodiesStack: Instr[][];
  /** All live (allocated but not yet attached to ctx.mod.functions) FunctionContext bodies.
   *  Walked by addUnionImports / shiftLateImportIndices to ensure call-funcIdx values
   *  in nested function bodies under construction (e.g. `cbFctx.body` in
   *  compileArrowAsCallback during its captures-extraction / param-coercion setup
   *  phase, BEFORE the savedFunc swap puts it on funcStack) are still shifted on
   *  late import addition. (#1384) */
  liveBodies: Set<Instr[]>;
  /** Hash-based lookup for anonymous struct deduplication */
  anonStructHash: Map<string, string>;
  /**
   * (#2009) Result of the same-structural-shape collision-resolution post-pass:
   * anon struct name → its nonzero shape-id. Populated ONLY for structs that
   * genuinely collide (a different-named struct shares the same field TYPES,
   * making them runtime-indistinguishable under WasmGC iso-recursive
   * canonicalization). Such structs get a hidden trailing `$shape` i32 field
   * retro-stamped per-instance; host reflection and dynamic dispatch read it to
   * recover the JavaScript shape by value. Shape id zero is reserved as an
   * invalid/miss value. Non-colliding structs remain absent and unchanged.
   */
  shapeIdByStructName: Map<string, number>;
  /** (#2009) shape-id → ordered field-name CSV, for the host name export. */
  shapeNameCsvById: string[];
  /**
   * (#2009 R3b) anon object-literal struct name → its field names in JS
   * INSERTION order (the order keys were first introduced while evaluating the
   * literal source: named props left-to-right, spreads contributing each
   * source's own keys in order, FIRST occurrence wins). The struct's slot order
   * comes from `ts.Type.getProperties()`, which for spread-result types is
   * last-spread-first and does NOT match JS enumeration order. Host enumeration
   * (`Object.keys`/`JSON.stringify`/`for-in`) is driven by the field-name CSV in
   * `__struct_field_names`, read BY NAME (slot-independent), so reordering the
   * CSV by this list restores spec enumeration order without touching slots,
   * getters, dedup, or the `$shape` field. First literal of a deduped canonical
   * type wins (deterministic by compile order). Empty when a struct's checker
   * order already matches insertion order (plain literals), so the reorder is a
   * no-op for the common case.
   */
  structInsertionOrder: Map<string, string[]>;
  /** Pending late import shift state */
  pendingLateImportShift: { importsBefore: number } | null;
  /** Map from class name → global index of the prototype externref singleton */
  protoGlobals: Map<string, number>;
  /** Map from class name → own method names (instance methods, for prototype allowlist; see #1047) */
  classMethodNames: Map<string, string[]>;
  /** Map from class name → global idx of the method-name CSV string constant (see #1047) */
  classMethodsCsvGlobal: Map<string, number>;
  /** Map from class name → global index of the class-object externref singleton (#1395). Used so `C` resolves to a real object whose static-method descriptors are queryable. */
  classObjectGlobals: Map<string, number>;
  /** Map from class name → own static method names (for the static method allowlist; #1395) */
  classStaticMethodNames: Map<string, string[]>;
  /** Map from class name → global idx of the static-method-name CSV string constant (#1395) */
  classStaticMethodsCsvGlobal: Map<string, number>;
  /** #1888 S6 — lazily materialized built-in namespace singleton globals
   *  (Array/Object static method surface under standalone). */
  builtinObjectGlobals: Map<string, number>;
  /** (#1394) Map from `${className}_${methodName}` → global idx of the cached
   *  externref singleton closure for the method. Lazily allocated on first
   *  property-access of `C.prototype.<method>` or `instance.<method>` (as
   *  value). Reused on every subsequent access so `c.m === C.prototype.m`
   *  holds (verifyProperty identity assertions across ~478 class/elements
   *  tests). The companion canonical trampoline is named
   *  `__obj_meth_tramp_${className}_${methodName}_cached` and is also reused
   *  across all access sites to avoid bloating mod.functions. */
  methodClosureGlobals: Map<string, number>;
  /**
   * (#2025) Once an extractable method-as-closure trampoline is emitted, the
   * `__new_TypeError` import + message string are registered eagerly so the
   * trampoline's null-`this` arm can throw a CATCHABLE TypeError (instead of
   * trapping on a null `struct.get`) with stable, shift-tracked indices.
   * Pure-lookup after that — the trampoline never registers mid-finalize.
   */
  nullThisTypeErrorReady: boolean;
  /** (#1340) Singleton closure-struct externref globals for top-level function
   *  declarations used as first-class values. Keyed by function name. Ensures
   *  `foo === foo` and so sidecar writes on `foo.prototype` are observed by
   *  later reads. Mirrors `methodClosureGlobals` (#1394) for the function-decl
   *  case where the same JS identifier is read as a value at multiple sites. */
  funcClosureGlobals: Map<string, number>;
  /** Whether targeting WASI */
  wasi: boolean;
  /** Whether Node-compatible ambient globals such as `global` are enabled. */
  nodeGlobals: boolean;
  /** Whether targeting standalone (no JS host, no WASI runtime — #1470).
   *  When true, the emitter MUST NOT add `wasm:js-string` namespace imports
   *  or JS-host string helpers (`__concat_N`, `__extern_toString`,
   *  `__unbox_string`, `__str_from_mem`, `__str_to_mem`,
   *  `__str_extern_len`). Implies `nativeStrings === true`. */
  standalone: boolean;
  /** Resolved JS-host direct-eval lowering. */
  directEvalMode: "legacy" | "reified-host";
  /** Private externref-array carrier used only by reified JS-host direct eval. */
  hostRuntimeEvalVecTypeIdx?: number;
  /** (#2141 S1) Honest generic `any` boxing regime flag — see the
   *  `CodegenOptions.honestAnyBoxing` doc. Default false (legacy tag-5
   *  box-the-externref ABI, byte-identical). */
  honestAnyBoxing: boolean;
  /** (#2141 S2/S3, #2626, #2040 A1) Tag-5 boxed-VALUE equality classifier —
   *  three-way true-class dispatch in the both-tags-5 eq arm (numeric
   *  `f64.eq` / string content / object `ref.eq`). Default TRUE since the
   *  #2040 A1 flip (unblocked by the #3032 lazy-generator waves); the emit
   *  site stays standalone/wasi-gated so host mode is byte-identical.
   *  `JS2WASM_TAG5_CLASSIFIER=0` forces the legacy always-`0` arm. */
  tag5ValueEqClassifier: boolean;
  /** (#4173) Fast tag-pair dispatch in the dynamic-eq helpers — see the
   *  `CodegenOptions.fastStrictEq` doc. Default TRUE;
   *  `JS2WASM_FAST_STRICT_EQ=0` forces the legacy bodies. */
  fastStrictEq: boolean;
  /** (#2106 S1) Standalone `$undefined` tag-1 singleton regime flag — see the
   *  `CompileOptions.undefinedSingleton` doc. Default TRUE (#2106 flip);
   *  `=0` forces legacy. Only meaningful under standalone/nativeStrings;
   *  host mode ignores it. */
  undefinedSingleton: boolean;
  /** (#2796) Diff-test-harness fidelity: in JS-host mode, export the top-level
   *  `__module_init` and do NOT wire the wasm `start` section to it, so the host
   *  runs it after `setExports` (symmetric with the standalone `_start` model).
   *  Default false. WASI is unaffected. */
  deferTopLevelInit: boolean;
  /** (#2179) True when the module body contains any `delete` of a property or
   *  element access (e.g. `delete o.a` / `delete o[k]`). Pre-scanned once at
   *  module setup. When true, `any`/`unknown`-typed property READS in JS-host
   *  mode are routed through the tombstone-aware `__extern_get` host helper
   *  instead of the inline `ref.test`+`struct.get` fast-path — the fast-path
   *  reads the live WasmGC field and bypasses the runtime delete tombstone, so
   *  a post-delete read returned the stale value (#2179). Delete-free modules
   *  keep the byte-identical inline fast-path (zero overhead). */
  moduleUsesDelete?: boolean;
  /** (#4223) True when the module syntactically READS a `constructor` property
   *  (`x.constructor` / `x["constructor"]`) and the target is standalone.
   *  Pre-scanned once at module setup; it is the demand gate for the
   *  primitive-wrapper constructor carriers
   *  (`ensureWrapperConstructorCarriers`, wrapper-constructor-carrier.ts) and
   *  therefore for the `__extern_get` arm that consumes them. A module that
   *  never reads `.constructor` mints nothing and emits byte-identical
   *  output. */
  wrapperCtorCarrierDemanded?: boolean;
  /** (#4232) True when `wrapperCtorCarrierDemanded` holds AND the module
   *  mentions the `Object` identifier — the NARROWER gate for the
   *  ordinary-object (`Object(null)`) arm alone. That arm answers from
   *  `emitBuiltinNamespaceObject`, which materializes the whole `Object`
   *  static surface as closures and thereby arms the JS-host method-closure
   *  bridge; riding the shared flag put that surface into every standalone
   *  module reading `.constructor` anywhere, including ones only ever asking
   *  about a primitive wrapper (#4034's unconditional-pull-in hazard). */
  plainCtorCarrierDemanded?: boolean;
  /** (#4187) Identifier names appearing as the receiver of a member delete
   *  (`delete r.k` / `delete r[e]`), pre-scanned by
   *  `scanModuleMemberDeletes`. Consulted ONLY by the standalone arm of
   *  the `hasOwnProperty`/`propertyIsEnumerable` routing gate in
   *  `compilePropertyIntrospection`: a receiver that saw `Object.defineProperty`
   *  AND appears here can have its const-fold disagree with runtime state, so it
   *  routes to the runtime helper. Empty for nearly every module. */
  memberDeleteReceiverNames?: ReadonlySet<string>;
  /** (#1472 Phase A) Set of dynamic-shape object/property host-import names
   *  already refused under `--target standalone`, used to deduplicate the
   *  compile-error so a single source construct emits at most one error per
   *  import name. Lazily initialized in late-imports.ts. */
  standaloneRefusedImports?: Set<string>;
  /** (#1472 Phase B) Type indices for the Wasm-native open-object runtime
   *  ($Object / $PropMap / $PropEntry), allocated once by ensureObjectRuntime
   *  in object-runtime.ts. Undefined until first open-object op under
   *  --target standalone. */
  objectRuntimeTypes?: ObjectRuntimeTypes;
  /** (#2175 S0) Module-type index of the single shared `$NativeProto` struct —
   *  the host-free builtin/class prototype-object representation. Registered
   *  once by `registerNativeProtoType` (property-access.ts) the first time a
   *  `.prototype`-as-value read demands a native proto object under
   *  `--target standalone`. Undefined until then. */
  nativeProtoTypeIdx?: number;
  /** (#2175 S0) Builtin-brand id table — a reserved high-negative i32 band
   *  disjoint from `classTagMap`'s range, so a `$NativeProto.$brand` (or the
   *  `$ClassMeta.$parentTag` externref-backed-subclass slot from #2101) is a
   *  single i32 namespace shared with class tags without collision. Seeded
   *  lazily from the BUILTIN_BRAND_TABLE constant by `getBuiltinBrand`. */
  builtinBrandMap?: Map<string, number>;
  /** (#2175 S0) Per-funcIdx metadata for native-method-closure values, so the
   *  existing `.length`/`.name`-on-function reads resolve a closure's arity and
   *  member name (e.g. `RegExp.prototype.test.length === 1`,
   *  `.name === "test"`). Populated by `ensureStandaloneNativeMethodClosure`. */
  nativeClosureMeta?: Map<number, { name: string; length: number }>;
  /** (#2896) Struct-type index → static `{name, length}` metadata for builtin
   *  function-closure values under `--target standalone`. Each (builtin, member)
   *  closure gets a UNIQUE wrapper-struct SUBTYPE (fields `[funcref func,
   *  (mut i32) bfnstate, i32 bfnid]`, supertype = its signature wrapper
   *  struct), so the
   *  reflective runtime natives (`__getOwnPropertyDescriptor` / `__extern_get` /
   *  `__hasOwnProperty` / `__getOwnPropertyNames` / `__delete_property`) can
   *  `ref.test` the value at RUNTIME and answer its spec `name`/`length` own
   *  properties. Populated by `ensureBuiltinFnMetaType` (builtin-fn-meta.ts);
   *  consumed by `fillBuiltinFnMeta` (object-runtime.ts) at finalize. */
  builtinFnMetaByTypeIdx?: Map<number, { name: string; length: number }>;
  /** (#2896) Cache: `(builtin, member)` key → the meta struct-type index above.
   *  Keeps `ensureBuiltinFnMetaType` idempotent per closure identity. */
  builtinFnMetaTypeByKey?: Map<string, number>;
  /** (#2963) Reified-builtin-value IDENTITY substrate. A builtin static method
   *  read AS A VALUE (`const r = Promise.resolve`, `[1,2].map(Number.isInteger)`)
   *  must be a MODULE-LEVEL SINGLETON: every read of the same (builtin, member)
   *  yields the SAME ref so `Promise.resolve === Promise.resolve` holds and a
   *  `delete fn.name` mutates the one shared object (ES: builtin methods are a
   *  single function object). Keyed by the meta/wrapper struct-type index (the
   *  per-(builtin, member) unique type from `ensureBuiltinFnMetaType`), the value
   *  is the index of a `(ref null <structType>)` mutable global that
   *  `pushBuiltinFnSingletonValueInstrs` lazily materializes once (a null-guarded
   *  `struct.new` in a shift-covered function body — NOT a const-init, whose
   *  embedded `ref.func` the late-import funcidx shifter does not walk). */
  builtinFnSingletonGlobalByTypeIdx?: Map<number, number>;
  /** (#4437) Type index of `$__fn_instance_meta` — `{externref name, i32 length}`,
   *  the nominal per-DECLARATION metadata struct a user closure's `$fnmeta` slot
   *  points at. Minted lazily by `ensureFnInstanceMetaStructType`
   *  (function-instance-meta.ts) at the first closure that carries the slot, so
   *  its index is always LOWER than every referring closure struct — a backward
   *  reference, which keeps it a singleton rec group (`computeRecGroups` would
   *  otherwise merge everything in between, perturbing the #2514 canonical
   *  runtime rec-group boundary). */
  fnInstanceMetaStructTypeIdx?: number;
  /** (#4437) `"<length>:<name>"` → index of the mutable `(ref null
   *  $__fn_instance_meta)` global holding that entry's ONE instance. Two
   *  declarations with the same name and expected-argument-count share it: the
   *  struct is immutable, so sharing is unobservable. */
  fnInstanceMetaGlobalByKey?: Map<string, number>;
  /** (#4437) Closure struct-type index → the field index of its `$fnmeta` slot.
   *  One `ref.test` arm per entry is emitted into `__fninst_meta` at finalize
   *  (function-instance-props.ts). The slot always sits LAST, so the index
   *  differs per family — the shared wrapper has 3 own fields, the constructible
   *  wrapper 4, and a capture subtype 3+N. */
  fnInstanceMetaFamilies?: Map<number, number>;
  /** (#4437) Base closure struct-type index → the `$fnmeta`-carrying SUBTYPE
   *  minted over it. Needed only where the base is SHARED across functions (the
   *  per-signature wrapper and its constructible variant); a capture subtype is
   *  already per-function and grows the slot in place. */
  fnInstanceMetaSubtypeByBase?: Map<number, number>;
  /** (#4440) Physical function name (`ClassName_m`, `ClassName_get_p`,
   *  `ClassName_set_p`, `LiteralType_field`) → the member DECLARATION behind it.
   *  The method mint sites take a name + funcIdx, never a node, so this is how
   *  `function-instance-meta-methods.ts` recovers the parameter list for §15.1.5
   *  and the property key for §10.2.9. Keyed by NAME rather than funcIdx because
   *  funcIdx is shift-sensitive and the name is what those sites already
   *  re-resolve by. Written by `class-bodies.ts` at registration time. */
  fnMetaMemberDecls?: Map<
    string,
    ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.PropertyAssignment
  >;
  /** (#2193 PR-B) Struct-type indices of `$NativeProto` member closures whose
   *  FIRST user param is the receiver (`this`) — e.g. `Array.prototype.slice`'s
   *  `(self, this, start, end)` closure. Unlike a plain user function (which
   *  ignores `this`), a reflective `m.call(thisArg, …args)` on one of these MUST
   *  thread `thisArg` into param 1 instead of dropping it. The generic `.call`
   *  dispatch in expressions/calls.ts consults this set to decide. Populated by
   *  `ensureStandaloneNativeMethodClosure`. */
  nativeProtoReceiverClosureStructTypes?: Set<number>;
  /** (#682) Native standalone RegExp engine hook. Standalone mode currently
   *  enables the reduced literal-substring backend; null means RegExp lowering
   *  must stay on the explicit #1474 refusal path. */
  standaloneRegExpEngine: StandaloneRegExpEngineConfig | null;
  /**
   * (#1373b C-1) When true (default; JS2WASM_IR_ASYNC=0 disables), the IR
   * selector may claim SYNC-PASS-THROUGH async function declarations — the
   * population the ONE async engine (#2906 $AsyncFrame drive / host-drive,
   * `decideAsyncActivation`) declines. Engine-activated (genuinely
   * suspending) functions are NEVER IR-claimed: the `asyncEngineClaims`
   * predicate threaded into `planIrCompilation` keeps their routing
   * byte-identical. Claimed asyncs compile on the raw-`T` sync model
   * (`await` = per-lane unwrap/identity, returns unwrapped; the #1796
   * call-site consumption contract owns Promise wrapping).
   *
   * Read by `src/ir/select.ts` `isAsyncIrReady`; threaded via
   * `planIrOverlay` (codegen/index.ts) into `IrSelectionOptions`.
   */
  supportsAsyncIr: boolean;
  /**
   * #2524 / #2633 — when true (WASI only), std-IO is lowered to imported
   * `node:fs` `readSync`/`writeSync` calls (over a shim-owned, imported linear
   * memory) instead of inline `fd_read`/`fd_write`. console.log/warn/error and
   * process.std*.write lower to `writeSync(1|2, …)`; the bespoke
   * `js2wasm:node-process` shim was retired (#2633). Driven by the `link` set
   * (`["node:fs"]`).
   *
   * #2783 — an INTERNAL convenience boolean, **derived** from
   * `linkedNamespaces.has("node:fs")` (there is no user-facing `linkNodeShims`
   * option anymore — `link: string[]` is the only input). The two
   * are computed together in `create-context.ts`; this boolean additionally
   * requires a WASI target. Keeping it lets the ~30
   * existing `ctx.linkNodeShims` read sites stay zero-churn while the underlying
   * state generalizes to an arbitrary set of linked namespaces.
   */
  linkNodeShims: boolean;
  /**
   * #2783 — the set of external namespaces left as **link-time imports** for
   * this compile on any target. `node:fs` membership additionally drives the
   * import-and-link std-IO codegen path only on WASI (see `linkNodeShims`). For
   * an arbitrary namespace, membership declares that its imports are expected
   * provider edges rather than implicit host leaks.
   */
  linkedNamespaces: ReadonlySet<string>;
  /**
   * (#4238 slice 1) Resolve `declare function` extern param/result types
   * through `nativeTypeFromTypeNode` (the `type i32 = number` annotations)
   * before falling back to `mapTsTypeToWasm`. Default false → the historical
   * f64-for-`number` mapping, byte-identical.
   */
  externNativeTypes: boolean;
  /**
   * (#4238 slice 1) Import module for `declare function` externs. `undefined`
   * → `"env"` (the JS-host module), unchanged.
   */
  externImportModule?: string;
  /**
   * (#4238 slice 1) When set, the module imports its linear memory from
   * `<module>.memory` at memory index 0 instead of defining one. Enables the
   * `wasm:memory` inline accessors to address a PEER wasm module's heap.
   */
  importMemory?: { module: string; min?: number };
  /** #2631/#2633: func index of the imported `node:fs::readSync` (fd,ptr,len)->i32 (-1 = not registered). */
  nodeFsReadSyncIdx: number;
  /** #2631/#2633: func index of the imported `node:fs::writeSync` (fd,ptr,len)->i32 (-1 = not registered). */
  nodeFsWriteSyncIdx: number;
  /** WASI import indices */
  wasiFdWriteIdx: number;
  wasiFdReadIdx?: number;
  wasiProcExitIdx: number;
  wasiPathOpenIdx: number;
  wasiFdCloseIdx: number;
  wasiPollOneoffIdx?: number;
  /** (#2632 Phase 2) wasi_snapshot_preview1::fd_fdstat_set_flags import func idx — undefined if not registered. */
  wasiFdFdstatSetFlagsIdx?: number;
  wasiBumpPtrGlobalIdx: number;
  /** #1482: wasi_snapshot_preview1::environ_sizes_get import index (-1 = not registered) */
  wasiEnvironSizesGetIdx: number;
  /** #1482: wasi_snapshot_preview1::environ_get import index (-1 = not registered) */
  wasiEnvironGetIdx: number;
  /** #1482: env::__wasi_env_get_str late import index for JS-polyfill fast path (-1 = not registered) */
  wasiEnvGetStrIdx: number;
  /** (#1483) WASI clock_time_get import func idx — -1 if not yet registered. */
  wasiClockTimeGetIdx?: number;
  /** (#1483) Pending flag — emit `__wasi_write_string` after lib-globals scan. */
  wasiPendingFdWriteHelper?: boolean;
  /** (#1483 + #1493) Pending flag — emit `__wasi_write_string_stderr` after lib-globals scan. */
  wasiPendingConsoleStderrHelper?: boolean;
  /** (#1483) Pending flag — emit `__wasi_write_file_sync` after lib-globals scan. */
  wasiPendingPathOpenHelper?: boolean;
  /** (#1483) Pending flag — emit `__wasi_date_now` / `__wasi_performance_now` after lib-globals scan. */
  wasiClockHelpersPending?: boolean;
  /** (#1484) Pending flag — emit `__wasi_sleep_ms` after lib-globals scan. */
  wasiPendingSleepMsHelper?: boolean;
  /** (#2632) Pending flag — register timer heap + run-loop reactor after lib-globals scan. */
  wasiPendingTimerHeap?: boolean;
  /** (#2632 Phase 2) Pending flag — activate the fd0 stdin reactor (multi-sub poll + internal buffer) before timer-heap registration. */
  wasiPendingStdinReactor?: boolean;
  /** Set of node:fs functions used in this compilation unit (both WASI and JS-host fs paths). */
  wasiNodeFsFuncs: Set<string>;
  /** (#743) Shared `.d.ts` entrypoint seed map — see the CodegenOptions field. */
  dtsEntrypointSeeds?: import("../../checker/dts-entrypoint-seeds.js").DtsEntrypointSeeds;
  /** (#2657) Local names imported from `"wasi_snapshot_preview1"` — the raw-WASI
   *  fd_read/fd_write passthrough bindings (loopdive/js2wasm#389). Empty for any
   *  program that does not import the raw WASI module. */
  wasiRawImports: Set<string>;
  /** (#2657) Local names imported from `"wasm:memory"` — js2wasm's inline
   *  linear-memory access intrinsics (`store32`/`load32`/`store8`/`load8`). Empty
   *  for any program that does not import the intrinsic module. */
  wasiMemAccessors: Set<string>;
  /**
   * #1886 — Linear-safe `Uint8Array` analysis result. Populated (WASI/standalone
   * only) by `analyzeLinearUint8` as a pre-pass; `undefined` otherwise. Symbols
   * in `linearUint8.safeBindings` are byte buffers proven to never escape the
   * GC heap, so codegen backs them by linear memory (a `(ptr,len)` pair) with
   * zero-copy `fd_read`/`fd_write`. Every consumer is additive — when this is
   * `undefined` or a binding is absent, the existing GC-vec path is used
   * unchanged. (Codegen consumers land in later slices; the analysis itself is
   * side-effect free and safe to run unconditionally behind the WASI gate.)
   */
  linearUint8?: import("../linear-uint8-analysis.js").LinearUint8Result;
  /**
   * #2660 S1 — whole-program escape / dynamic-use classification for `new F()`
   * function-constructor instances. Each site is classified `reconstruct`
   * (dynamically consumed AND no typed own-field consumer → S3 `$Object`
   * reconstruction candidate), `keep-typed` (has a typed own-field consumer →
   * never reconstruct, hot-path protection), or `keep-static` (no dynamic
   * consumer → no reconstruction needed). **INERT in S1** — produced by
   * `analyzeFnctorEscapeGate` and stored here, but NOT yet consumed by any
   * lowering decision (S3 wires `compileNewFunctionDeclaration` to read it). The
   * conservative default (`keep`) means an empty/imprecise result leaves emitted
   * Wasm byte-identical.
   */
  fnctorEscapeGate?: import("../fnctor-escape-gate.js").FnctorEscapeGateResult;
  /**
   * (#3685 S3) Memoized receiver-flow verdicts, keyed by source file. The
   * analysis is whole-program and pure; computing it per call site would be
   * quadratic on a file the size of acorn's dist.
   */
  receiverFlowByFile?: Map<import("typescript").SourceFile, import("../receiver-flow-analysis.js").ReceiverFlowResult>;
  /**
   * (#3683 S2) Memoized inverse of `protoMethodWriteOnce.methods` — the RHS
   * function node of each write-once prototype-method assignment mapped to its
   * owning fnctor name. Built lazily on the first twin-admission query so the
   * check is an O(1) node lookup rather than a per-closure scan of every
   * class's method map. Read-only after construction.
   */
  typedThisWriteOnceIndex?: Map<ts.FunctionLikeDeclaration, string>;
  /**
   * (#3683 S3) The same inverse index keyed to `"<F>/<m>"` instead of just
   * `<F>` — S3 needs the METHOD name to pair a compiled twin with the
   * trampoline reserved for it. Built lazily, read-only after construction.
   */
  typedThisWriteOnceKeyIndex?: Map<ts.FunctionLikeDeclaration, string>;
  /**
   * (#3683 S2) Diagnostic counter: how many prototype methods received a typed
   * twin in this compilation. Surfaced by the S2 probe/test, not by codegen.
   */
  typedThisTwinCount?: number;
  /**
   * (#3683 S3) `"<F>/<m>/<arity>"` → the direct-call TRAMPOLINE reserved for
   * that prototype method. Reserved lazily at the first devirtualized call site
   * and FILLED at finalize (`fillDirectCallTrampolines`), because a twin body
   * routinely calls a method whose own body has not been compiled yet (acorn's
   * mutually recursive `parseMaybeAssign` ↔ `parseExprOps` ↔ …). See
   * `typed-this.ts` for why the indirection exists and what each field means.
   */
  directCallTrampolines?: Map<string, import("../typed-this.js").DirectCallTrampoline>;
  /**
   * (#3683 S3) `"<F>/<m>"` → the compiled typed TWIN of that prototype method:
   * its wasm function NAME (never a raw index — funcMap is the shift-maintained
   * source of truth) and its exact param/result ValTypes, so the finalize fill
   * can prove the trampoline's signature and the twin's agree before baking a
   * direct `call`. Populated by `compileArrowAsClosure` at twin-mint time.
   */
  directCallTwins?: Map<string, { twinName: string; params: ValType[]; results: ValType[] }>;
  /**
   * (#3780) `"<F>/<m>"` → the lifted generic body and the closure instance
   * created for a write-once prototype method that could not receive a typed
   * twin (normally because it captures module state). Direct-call trampolines
   * use this to bypass the dynamic property/apply bridge without discarding the
   * closure environment.
   */
  directCallGenerics?: Map<
    string,
    {
      liftedName: string;
      selfGlobalIdx: number;
      selfTypeIdx: number;
      params: ValType[];
      results: ValType[];
    }
  >;
  /**
   * #2773 S1 (keystone) — fnctor name → reserved `$__fnctor_<Name>` struct type
   * index. Populated up-front by `reserveFnctorStructTypes` (index.ts) at the
   * deterministic type-init phase so the index is IDENTICAL across the hoist pass
   * and the emit pass (the on-demand registration at the `new F()` site landed at
   * a pass-dependent index → `ref.test`/`struct.get` desync). When a name is
   * present here, `compileNewFunctionDeclaration` FILLS the reserved slot in place
   * instead of pushing a new type (which would re-shift every downstream typeIdx).
   * Empty for fnctor-free modules ⇒ byte-identical no-op.
   */
  fnctorReservedTypeIdx: Map<string, number>;
  /**
   * (#4394) Harness error fnctors whose `new <Name>` interception was DECLINED
   * because the module DECLARES `function <Name>` (sta.js's `Test262Error`) —
   * their thrown instances are ordinary user structs, so the #2962 exception
   * renderer bakes a per-fnctor "Name: message" arm for them (see
   * `emitExceptionRenderExports`); without it every such throw rendered
   * "[object Object]" and the merged standalone report lost the signature.
   */
  exnRenderFnctorErrorNames?: Set<string>;
  /**
   * (#3927) fnctor name → reserved `$__fnctor_<Name>__cold` tail-struct type
   * index, reserved alongside the main struct in `reserveFnctorStructTypes` so
   * both indices are pass-invariant. Present only when
   * `JS2WASM_FNCTOR_HOT_FIELDS` is set; `deriveFnctorFields` declines the split
   * entirely when the name is absent, which is what keeps the on-demand
   * (non-reserved) fnctor path on the union struct.
   */
  fnctorColdTailTypeIdx?: Map<string, number>;
  /**
   * (#3927) main `__fnctor_<Name>` struct name → its cold-tail struct name, for
   * the fnctors whose split actually took effect. This is the map the read/write
   * dispatchers enumerate to find cold arms (`findColdStructsForField`); a
   * fnctor whose eligible-field count never exceeded the hot limit is absent.
   */
  fnctorColdTailStructName?: Map<string, string>;
  /**
   * (#3927 per-type layouts) fnctor name → the family's reserved type indices,
   * hint global and stamp range, reserved alongside the base struct in
   * `reserveFnctorStructTypes` so every index is pass-invariant. Present only
   * under `JS2WASM_FNCTOR_LAYOUT_EMIT` for split-verdict plans.
   */
  fnctorLayoutReserved?: Map<string, import("../fnctor-layout-emit.js").FnctorLayoutReservation>;
  /**
   * (#3927 per-type layouts) BASE struct name (`__fnctor_<Name>`) → the
   * completed emission info for a family whose split actually took effect —
   * the map every layout-aware consumer (dispatcher fills, reflective passes,
   * the Phase-3 narrowing vote) enumerates. Populated by
   * `applyFnctorLayoutSplit` during field derivation.
   */
  fnctorLayoutInfo?: Map<string, import("../fnctor-layout-emit.js").FnctorLayoutEmitInfo>;
  /**
   * (#3927 per-type layouts) allocation-label SITE (the factory call / direct
   * `new` expression node from the alloc-labels plan) → the layout hint to
   * publish before compiling that expression. Consumed by
   * `maybeEmitLayoutHint` at the top of the call/new compilers.
   */
  fnctorLayoutHintBySite?: Map<ts.Node, { hintGlobalIdx: number; ordinal: number }>;
  /**
   * (#3927 per-type layouts) next globally-unique layout stamp. Stamps are
   * 1-based and allocated CONTIGUOUSLY per family — the resid / presence arms'
   * range guards (`stampRangeTestInstrs`) depend on that contiguity.
   */
  fnctorLayoutNextStamp?: number;
  /**
   * #1886 Slice B — Func index of the lazily-emitted
   * `__lin_u8_alloc(len:i32)->i32` bump allocator for linear-backed Uint8Array
   * buffers (`undefined` = not yet emitted). Allocates from a dedicated page-4
   * arena pointed at by `$__lin_u8_arena_ptr` (NOT the page-0 string-literal
   * `$__wasi_bump_ptr`, which would alias literal data). Reuses the #1856
   * align8 + on-demand `memory.grow` idiom (see `codegen-linear/runtime.ts
   * addRuntime`), emitted here because the WasmGC front-end owns its own
   * memory/globals and cannot call the linear backend's module bootstrap.
   */
  linearU8AllocFuncIdx?: number;
  /**
   * #1886 Slice B — func-type index for `__lin_u8_alloc`'s `(i32)->(i32)`
   * signature, reserved eagerly (before any GC struct/array or native-string
   * helper type) so the shared type-table prefix stays stable. The allocator
   * function is emitted later and reuses this slot. See reserveLinearU8AllocType.
   */
  linearU8AllocTypeIdx?: number;
  /**
   * (#2026 #53) Eagerly-reserved `$ObjVecArr` = `(array (mut externref))` type
   * index, registered in the up-front type-init phase (`reserveObjVecArrType`)
   * when the source declares a class. The dynamic-`new` runtime-argv path
   * (`emitDynamicNewFallback`) and `ensureObjectRuntime` both ADOPT this slot
   * instead of minting the type lazily mid-expression — minting it late baked an
   * unresolved `-1` heap-type ref (the #2043 / subview type-idx-stability hazard).
   */
  reservedObjVecArrTypeIdx?: number;
  /** #1886 Slice B — global index of the page-4 linear-U8 arena bump pointer. */
  linearU8ArenaGlobalIdx?: number;
  /** Whether `node:fs` JS-host imports are permitted (non-WASI target only, #1491). */
  allowFs: boolean;
  /**
   * #1524 — When true, `addImport` rejects any JS-host `env` import that is
   * not on the dual-mode allowlist (`src/codegen/host-import-allowlist.ts`).
   * Auto-enabled when `wasi: true` (unless the caller passes
   * `strictNoHostImports: false` explicitly). Drives the architectural gate
   * documented under "Architecture Principles → JS host optional" in CLAUDE.md.
   */
  strictNoHostImports: boolean;
  /** Map from let/const module global variable name → TDZ flag global index */
  tdzGlobals: Map<string, number>;
  /** Set of let/const module global variable names */
  tdzLetConstNames: Set<string>;
  /** Compile-time property descriptor flags */
  definedPropertyFlags: Map<string, number>;
  /**
   * (#3872) `<integrityVarKey>:<propName>` keys defined non-writable via
   * `Object.defineProperty` on an EXTERNREF receiver. Deliberately SEPARATE
   * from `definedPropertyFlags`, which has four readers (notably
   * `builtin-static-gopd.ts`, where a present entry OVERRIDES the shape table);
   * folding these in perturbed `getOwnPropertyDescriptor`. Consulted only by
   * `isNonWritableDataProperty`. See #3872 for the full account.
   */
  nonWritableExternKeys: Set<string>;
  /** Properties whose descriptor/value lives in the runtime sidecar. */
  sidecarDefinedPropertyKeys: Set<string>;
  /**
   * (#2726) `varName:propName` keys for which `Object.defineProperty` was
   * statically observed on an identifier receiver — recorded uniformly across
   * EVERY defineProperty lowering path (inline data, inline accessor fast path,
   * runtime-descriptor, etc.). Used ONLY to route `hasOwnProperty` /
   * `propertyIsEnumerable` to the runtime helper instead of constant-folding
   * against the (defineProperty-widened) static struct shape: a configurable
   * `delete` records a `_wasmStructDeletedKeys` tombstone the compile-time
   * shape answer can't see. Kept SEPARATE from `definedPropertyFlags` /
   * `sidecarDefinedPropertyKeys` so it never perturbs descriptor-flag or
   * `getOwnPropertyDescriptor` routing — it is a presence-routing signal only.
   */
  definePropertyReceiverKeys: Set<string>;
  /**
   * (#2726) `varName:propName` keys defined as a NON-configurable ACCESSOR via
   * the inline-accessor `Object.defineProperty` fast path on a statically
   * struct-typed receiver. That path compiles the getter/setter into a
   * `${struct}_get/set_<prop>` function + `classAccessorSet` and — unlike the
   * data fast path — never mirrors the descriptor's `configurable` flag into the
   * runtime `_wasmPropDescs` sidecar, so the host `__delete_property` can't see
   * it and wrongly reports a successful delete. The struct-field `delete` site
   * consults this set to emit OrdinaryDelete's refusal (return `false`; strict
   * mode ⇒ TypeError) for `delete obj.accessor` of a non-configurable accessor
   * (#2726 group (d): `11.4.1-4-a-2-s`). Consumed ONLY by the delete site.
   */
  nonConfigurableAccessorKeys: Set<string>;
  /**
   * (#2676) Maps a mapped-`arguments` function's declaration node to its live
   * `mappedArgsInfo`. A `delete args[i]` in a *nested* closure — typically the
   * strict callback in `assert.throws(TypeError, function(){ "use strict";
   * delete args[0]; })` after `var args = arguments` — has no `mappedArgsInfo`
   * of its own and reads the alias `args`, not the literal `arguments`, so the
   * #2667 direct-`arguments[i]` delete arm never fires. The delete site walks
   * the alias' declaration initializer (`= arguments`) up to the enclosing
   * (non-arrow) function that owns `arguments` and reads this map to recover the
   * outer function's per-index `nonConfigurableIndices`. Populated when
   * `mappedArgsInfo` is created (the `compileFunctionBody` path); read live at
   * the delete site, so the index reflects every `Object.defineProperty(...,
   * { configurable:false })` processed before the delete is compiled.
   */
  mappedArgsInfoByFunc: Map<ts.Node, NonNullable<FunctionContext["mappedArgsInfo"]>>;
  /** Object mutability state sets */
  nonExtensibleVars: Set<string>;
  frozenVars: Set<string>;
  sealedVars: Set<string>;
  /** Per-shape default property flags table */
  shapePropFlags: Map<number, Uint8Array>;
  /** Cache for function-constructor struct types */
  funcConstructorMap: Map<
    string,
    {
      structTypeIdx: number;
      ctorFuncName: string;
      /** Exact leading-capture ABI used when the synthesized constructor was minted. */
      captureLayout: import("../fnctor-constructor-identity.js").FnctorCaptureLayout;
      /**
       * (#2071) The synthesized ctor was minted with an EXTERNREF result (its
       * body may `return` a foreign object, so §10.2.1.3 step 13 is resolved
       * at runtime via `emitConstructReturnSelect`). Every `new` site of this
       * fnctor — builder and cache-hit alike — must report the externref
       * result type; reporting the struct type against a widened ctor is a
       * Wasm type error at the call site. Standalone/WASI only; absent/false
       * keeps the historical `(ref $Struct)` ABI byte-identically.
       */
      resultIsExtern?: boolean;
      /**
       * (fnctor-ctor-arguments.ts) The synthesized ctor materializes an
       * `arguments` object, so its call sites must publish over-supplied
       * arguments through `__extras_argv`/`__argc` instead of dropping them.
       * Cached with the ctor because the CACHE-HIT arm emits the call site
       * without ever seeing the declaration: a second `new F(…)` that forgot
       * this fact silently passed the builder's protocol-speaking callee a
       * stale/empty extras vector.
       */
      readsArguments?: boolean;
    }
  >;
  /**
   * (#2660 S2) Per-fnctor prototype `$Object` — fnctor symbol name → module
   * global index (`mut externref`) holding a native `$Object` for `F.prototype`.
   * Synthesized on the first `F.prototype` read/write in standalone mode so
   * `Object.create(F.prototype)` resolves and #2660 S3 can seed `instance.$proto`
   * from it. Empty/unused in host/GC mode (the prototype stays on the closure).
   */
  fnctorPrototypeObject: Map<string, number>;
  /** Per-compilation recursion guard for ensureStructForType (prevents infinite loops on circular types) */
  ensureStructPending: Set<ts.Type>;
  /** Node builtin modules registered as externref globals (#1044) */
  nodeBuiltinGlobals: Map<string, number>; // localName → funcIdx
  /**
   * JSX runtime import detected during preprocessing (#1540). The codegen
   * intercepts call expressions whose callee identifier matches one of the
   * recorded local names (`localJsx`/`localJsxs`/`localJsxDev`) and routes
   * them to the matching `__jsx_runtime_*` host import. The `Fragment`
   * binding is exposed as a no-arg externref-returning function under
   * `nodeBuiltinGlobals` so identifier resolution treats it like any
   * declared externref.
   */
  jsxRuntime?: import("../../import-resolver.js").JsxRuntimeImport;
}

export type { SourcePos };
