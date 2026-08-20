// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * `@loopdive/js2` — an ahead-of-time compiler from JavaScript and TypeScript to
 * WebAssembly GC.
 *
 * This is the package's main entry point. Use {@link compile} to turn source
 * text into a {@link CompileResult} (a Wasm binary plus a `.d.ts`, host import
 * helpers, and diagnostics), or the higher-level {@link compileFiles} /
 * {@link compileProject} for multi-file and on-disk projects. The full option
 * surface — target backend (`gc` / `linear` / `wasi` / `standalone`), native
 * strings, wasm-opt optimization, WIT generation, source maps, and more — is
 * documented on {@link CompileOptions}.
 *
 * @example
 * ```ts
 * import { compile } from "@loopdive/js2";
 *
 * const result = await compile(`
 *   export function add(a: number, b: number): number {
 *     return a + b;
 *   }
 * `);
 * const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
 * console.log((instance.exports.add as (a: number, b: number) => number)(2, 3)); // 5
 * ```
 *
 * @module
 */

/**
 * A single host capability an emitted module may need from its import object.
 *
 * The compiler analyzes the source and, for every JS-host operation it cannot
 * lower to pure Wasm (string ops, `console.log`, `Math.*`, boxing/unboxing,
 * `typeof`, extern property get/set, timers, Node builtins, the JSX runtime,
 * …), records an `ImportIntent`. The runtime ({@link buildImports}) reads these
 * to synthesize the matching host functions. Discriminated on the `type` field.
 */
export type ImportIntent =
  | { type: "string_literal"; value: string }
  | { type: "math"; method: string }
  | { type: "console_log"; variant: string }
  | {
      type: "extern_class";
      className: string;
      action: "new" | "method" | "get" | "set";
      member?: string;
      namespacePath?: string[];
    }
  | { type: "string_method"; method: string }
  | { type: "builtin"; name: string }
  // `constructible` marks the #4394 sibling bridge (`__make_callback_ctor`),
  // built for compiled ordinary function definitions so the host object it
  // hands out has [[Construct]] like the source callable does.
  | { type: "callback_maker"; constructible?: boolean }
  | { type: "getter_callback_maker" }
  | { type: "await" }
  | { type: "typeof_check"; targetType: string }
  | { type: "box"; targetType: string }
  | { type: "unbox"; targetType: string }
  | { type: "any_to_index" }
  | { type: "extern_get"; rawCallable?: boolean }
  | { type: "extern_call_raw_callable"; arity: number }
  | { type: "extern_set" }
  | { type: "extern_set_strict" } // (#2017) strict-mode [[Set]] — throws on getter-only / non-writable
  | { type: "boundary_callback"; arity: number }
  | { type: "boundary_promise"; operation: "resolve" | "reject" }
  | { type: "caught_exception" }
  | {
      type: "boundary_object";
      operation:
        | "get"
        | "set"
        | "has"
        | "delete"
        | "keys"
        | "call"
        | "apply"
        | "construct"
        | "reflectGet"
        | "reflectSet"
        | "getPrototypeOf"
        | "setPrototypeOf"
        | "getOwnPropertyDescriptor"
        | "definePropertyValue"
        | "definePropertyAccessor"
        | "getOwnPropertyNames"
        | "getOwnPropertySymbols"
        | "ownKeys"
        | "isAdmitted"
        | "callableKind"
        | "preventExtensions"
        | "reflectPreventExtensions"
        | "seal"
        | "freeze"
        | "isExtensible"
        | "isSealed"
        | "isFrozen"
        | "forInKeys";
    }
  | { type: "truthy_check" }
  | { type: "date_new" }
  | { type: "date_method"; method: string }
  | { type: "date_now" }
  | { type: "declared_global"; name: string }
  | { type: "host_eq" }
  | { type: "host_loose_eq" }
  | { type: "host_add" }
  | { type: "host_bigint_binop" }
  | { type: "host_compare" }
  | { type: "same_value_zero" }
  | { type: "dynamic_import" }
  | { type: "proxy_create" }
  | { type: "node_builtin"; moduleName: string }
  | { type: "node_builtin_fn"; moduleName: string; name: string }
  | { type: "web_storage"; which: "local" | "session" }
  | { type: "timer_set"; mode: "timeout" | "interval" }
  | { type: "timer_clear"; mode: "timeout" | "interval" }
  | { type: "node_dirname" }
  | { type: "node_filename" }
  | { type: "node_import_meta_url" }
  | {
      // (#1540) JSX runtime binding — `_jsx`/`_jsxs`/`_Fragment`/`_jsxDEV`
      // emitted by TypeScript when `jsx: react-jsx` is set. The host binding
      // is either a user-supplied runtime (`deps.jsxRuntime`) or a built-in
      // React-shaped fallback that constructs `{ $$typeof, type, props, key,
      // ref }` objects suitable for `React.isValidElement` consumers.
      type: "jsx_runtime";
      method: "jsx" | "jsxs" | "Fragment" | "jsxDEV";
      specifier: string;
    };

/**
 * Describes one import the compiled module declares, so the host runtime can
 * build the matching entry in the Wasm import object.
 */
export interface ImportDescriptor {
  /** Wasm import namespace the entry lives in. */
  module: "env" | "wasm:js-string" | "string_constants";
  /** Import field name within {@link ImportDescriptor.module}. */
  name: string;
  /** Whether the import is a function or a global. */
  kind: "func" | "global";
  /** The host capability this import provides (see {@link ImportIntent}). */
  intent: ImportIntent;
  /**
   * (#4150) Declared parameter count of a `func` import, read off the wasm
   * function type. Undefined for globals.
   *
   * Wasm import call sites are fixed-arity, so this is the exact number of
   * arguments the host wrapper will ever receive — which lets `buildImports`
   * build a fixed-signature wrapper instead of one with a rest parameter that
   * allocates an args array on every crossing. The host function's own
   * `.length` cannot substitute: it excludes rest and defaulted parameters, so
   * a variadic callee under-reports and a wrapper sized from it would silently
   * drop arguments.
   */
  paramCount?: number;
}

export type { ExportBoundaryKind, ExportSignature, TypedArrayKind } from "./ir/types.js";
import type { ExternCImportSpec as LinearExternCImportSpec } from "./codegen-linear/c-abi.js";
export type { LinearExternCImportSpec };
export type {
  HostImportInventoryEntry,
  HostImportInventorySummary,
  HostImportPolicy,
  HostImportPolicyClass,
} from "./host-import-policy.js";
export type {
  CapabilityImportRequirement,
  CapabilityProviderDefinition,
  CapabilityProviderDiagnostic,
  CapabilityProviderDiagnosticCode,
  CapabilityProviderId,
  CapabilityProviderImportContract,
  PlatformCapabilityDefinition,
  PlatformCapabilityRequirement,
} from "./capability-registry.js";
export { PLATFORM_CAPABILITY_REGISTRY, validatePlatformCapabilityRequirements } from "./capability-registry.js";
export {
  buildCompileExplanation,
  COMPILE_EXPLANATION_SCHEMA_VERSION,
  formatCompileExplanation,
} from "./compile-explain.js";
export type { CompileExplanationInput, CompileExplanationStatus, CompileExplanationV1 } from "./compile-explain.js";
export { validateExportBoundaryPolicies } from "./boundary-policy.js";
export type { BoundarySlotPolicy, BoundaryValuePolicy, ExportBoundaryPolicy } from "./boundary-policy.js";
export {
  createJavaScriptAdapterManifest,
  JAVASCRIPT_ADAPTER_MANIFEST_SCHEMA_VERSION,
  validateJavaScriptAdapterManifest,
} from "./adapter-manifest.js";
export type { JavaScriptAdapterManifestInput, JavaScriptAdapterManifestV1 } from "./adapter-manifest.js";
export type {
  IrInvariantCode,
  IrObservedOutcome,
  IrOutcomePolicy,
  IrOutcomePolicyVerdict,
  IrUnsupportedCode,
} from "./ir/outcomes.js";
// Outcome rows expose these opaque IDs; inventory/ABI construction remains an
// internal IR seam until later R1 commits wire it into compiler ownership.
export type { IrSourceId, IrUnitId } from "./ir/identity.js";
import type { ExportSignature } from "./ir/types.js";
import type { IrObservedOutcome } from "./ir/outcomes.js";

/**
 * The output of a `compile*` call: the compiled Wasm binary plus the artifacts
 * and metadata needed to instantiate, type, and debug it.
 */
export interface CompileResult {
  /** Wasm binary with GC proposal */
  binary: Uint8Array;
  /** WAT text representation (debug) */
  wat: string;
  /** TypeScript declaration file for exports and imports */
  dts: string;
  /** JS module with createImports() helper function */
  importsHelper: string;
  /** true if compilation was successful */
  success: boolean;
  /** Error messages with line numbers */
  errors: CompileError[];
  /** String literal pool (values used in the source) */
  stringPool: string[];
  /** Source map v3 JSON string (only present when sourceMap option is enabled) */
  sourceMap?: string;
  /** Import descriptors for closed import building */
  imports: ImportDescriptor[];
  /** Frozen compile policy used for provider and interop decisions (#4396). */
  targetProfile?: import("./target-profile.js").CompileTargetProfile;
  /**
   * Every emitted import classified as platform capability, boundary adapter,
   * lifecycle support, replaceable accelerator, legacy semantics, or unknown
   * (#4401). Successful compiler results always populate this inventory;
   * `unknown` is actionable debt, never implicit approval.
   */
  hostImportInventory?: import("./host-import-policy.js").HostImportInventoryEntry[];
  /** Deterministic inventory counts for explain output and migration ratchets (#4401). */
  hostImportSummary?: import("./host-import-policy.js").HostImportInventorySummary;
  /** Versioned, provider-neutral platform authority requested by this module (#4398). */
  capabilityRequirements?: import("./capability-registry.js").PlatformCapabilityRequirement[];
  /** Fail-loud ABI/provider validation for the selected capability bindings (#4398). */
  capabilityProviderDiagnostics?: readonly import("./capability-registry.js").CapabilityProviderDiagnostic[];
  /** Stable provider/capability/value-boundary explanation derived from the frozen compile plan (#4382/#4398). */
  explanation?: import("./compile-explain.js").CompileExplanationV1;
  /** C header file content (only present when abi: "c") */
  cHeader?: string;
  /** WIT interface definition (only present when wit option is enabled) */
  wit?: string;
  /** Whether the source declares an exported main() function */
  hasMain: boolean;
  /** Whether the source has top-level executable statements (module init code) */
  hasTopLevelStatements: boolean;
  /**
   * Per-export boundary classifications (#1700/#4399). Surfaced so
   * {@link wrapExports} can marshal typed arrays and native strings across the
   * JS↔Wasm boundary. The Wasm signature alone does not retain every
   * source-level boundary distinction, so codegen exposes it as metadata.
   *
   * Only present (and even then, possibly an empty object) when at least
   * one exported function has a classified param or return. Forward the
   * value to `wrapExports(instance, { signatures: result.exportSignatures })`.
   */
  exportSignatures?: Record<string, ExportSignature>;
  /** Frozen copy/live/opaque policy for every classified export value (#4399). */
  exportBoundaryPolicies?: Readonly<Record<string, import("./boundary-policy.js").ExportBoundaryPolicy>>;
  /** Frozen v1 plan consumed by the generated JavaScript value/capability adapter (#4399). */
  adapterManifest?: import("./adapter-manifest.js").JavaScriptAdapterManifestV1;
  /**
   * Ready-to-pass JS-host import object for default/JS-host mode (#1667).
   *
   * In default mode the compiled binary needs host imports (`env.*`,
   * `wasm:js-string`, `string_constants`), so `WebAssembly.instantiate(binary,
   * {})` throws. This getter wires the runtime helpers from {@link buildImports}
   * into a single object the caller passes directly:
   *
   * ```js
   * const r = await compile(src);
   * const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
   * r.importObject.__setInstance?.(instance);
   * ```
   *
   * Standalone / `wasi` mode is the zero-import portable default and needs no
   * import object; for those targets this is an empty object. Computed lazily —
   * accessing it builds the runtime once and caches the result.
   *
   * Always present on results from the public `compile*` entry points; the
   * low-level `compile*Source` helpers in compiler.ts do not attach it.
   */
  readonly importObject?: WebAssembly.Imports;
  /**
   * #2089 — silent-fallback telemetry counters captured during codegen
   * (per class → per site → count). Only populated when the
   * `trackSilentFallbacks` option is set (the gate
   * `scripts/check-codegen-fallbacks.ts` sets it); `undefined` otherwise so
   * normal compiles pay nothing.
   */
  fallbackCounts?: import("./codegen/fallback-telemetry.js").FallbackCounts;
  /**
   * #1923 — IR post-claim demotions. When the IR selector *claims* a function
   * but it then fails during build/verify/lower/backend-legality, it demotes to
   * the legacy path through the warning channel (`codegen/index.ts`) and is
   * counted by no selector-level metric (`IrFallbackReason` covers only
   * selector-level rejections). Always collected on the WasmGC path (cheap,
   * mirrors `fallbackCounts`); empty/absent for the linear backend (no IR path).
   * Each entry carries the `IrIntegrationError.kind` (build/verify/lower/
   * backend-legality) and the function/message so the ratchet gate
   * `scripts/check-ir-fallbacks.ts` can bucket by kind + normalized message
   * class.
   */
  irPostClaimErrors?: { kind: string; func: string; message: string }[];
  /**
   * (#3000) Names of functions/class-members whose slots were actually patched
   * with an IR-lowered body (the integration pass's `report.compiled`). A mere
   * selector claim does NOT imply emission — a claimed class member whose class
   * has no `IrClassShape` is skipped in Phase B and stays byte-inert on legacy.
   * This is the durable genuine-emission (non-vacuity) signal: a member is truly
   * IR-emitted iff it appears here. Always collected on the WasmGC path.
   */
  irCompiledFuncs?: readonly string[];
  /**
   * (#2138) IR-first compile-once inversion telemetry. Present when IR-first
   * was active for this compile (the DEFAULT as of #3143; disable with the
   * `JS2WASM_IR_FIRST=0` escape hatch): lists the top-level functions whose
   * legacy body emission was skipped because the IR path owned the slot
   * (compiled once instead of twice). `undefined` when IR-first is off —
   * that pipeline is byte-identical to the pre-#2138 behavior and pays zero
   * cost for this field.
   */
  irFirstSkipped?: readonly string[];
  /**
   * #3519 — typed terminal outcome for every attempted source IR unit.
   * Present only when `trackIrOutcomes` is enabled, including on failed
   * results once codegen has begun.
   */
  irOutcomes?: readonly IrObservedOutcome[];
  /** Physical direct-AST body entries and exhaustive source-unit disposition census. */
  irBodyRouteAudit?: import("./codegen/legacy-body-audit.js").IrBodyRouteAudit;
}

/** A single compile diagnostic (error or warning) with its source position. */
export interface CompileError {
  /** Human-readable diagnostic message. */
  message: string;
  /** 1-based line number in the source. */
  line: number;
  /** 1-based column number in the source. */
  column: number;
  /** Whether the diagnostic is fatal (`"error"`) or advisory (`"warning"`). */
  severity: "error" | "warning";
  /** TS diagnostic code (if from TypeScript diagnostics) */
  code?: number;
  /**
   * Source file the diagnostic originated in (#1929). Populated from
   * `diag.file.fileName` for TypeScript diagnostics; absent for diagnostics
   * with no associated file (global/options errors). Essential for the
   * multi-file / files APIs where `line`/`column` alone can't say *which*
   * file. Additive — existing single-file callers can ignore it.
   */
  file?: string;
}

/** Restricts DOM access of compiled code to a subtree (safe-mode containment). */
export interface DomContainmentOptions {
  /** Root element or shadow root that scopes all DOM access. */
  domRoot: Element | ShadowRoot;
}

/**
 * Policy controlling which host imports a module is allowed to use
 * (see {@link checkPolicy}).
 */
export interface ImportPolicy {
  /** Set of import names that are disallowed. */
  blocked: Set<string>;
}

/**
 * Options controlling a compile: target backend, string representation,
 * optimization, diagnostics, host/platform surface, and output artifacts.
 * Every field is optional; the defaults produce a browser-oriented WasmGC
 * module.
 */
export interface CompileOptions {
  /** Emit WAT debug output (default: true) */
  emitWat?: boolean;
  /**
   * (#4420) Gate the result on the host WebAssembly engine.
   *
   * `success` alone means "codegen ran to completion", NOT "the bytes are a
   * module". Self-compiling `src/emit/binary.ts` returned `success: true` with
   * 268 KB of Wasm the engine then rejected — so any scoreboard built on the
   * flag (self-hosting progress, npm-compat matrix, conformance counts) could
   * report progress that does not exist.
   *
   * With `validate: true` the emitted binary is run through
   * `validateEmittedBinary`; if the engine rejects it, `success` flips to
   * `false` and an error-severity {@link CompileError} carrying the engine's
   * detail string is pushed onto `errors`. The binary is still returned so the
   * caller can dump/diff it.
   *
   * Opt-in: validation costs a full engine decode of the module, and existing
   * callers that deliberately inspect invalid output (WAT dumps, minimizers)
   * must keep getting it. The CLI runs its own post-optimize check (#3338) and
   * therefore does NOT set this — it would double-report.
   */
  validate?: boolean;
  /**
   * Debug-only: when set, WAT emission only formats functions whose Wasm
   * name is in this set (plus types/imports/globals for context), skipping
   * the rest. Full-module `emitWat` can throw "Invalid string length" on
   * very large graphs (multi-thousand-function compileProject outputs);
   * this lets a caller recover just the function(s) it actually needs to
   * inspect (e.g. the one named in a WebAssembly.Module() validation
   * error) without paying for or risking the full-module string build.
   */
  emitWatOnlyFunctions?: string[];
  /** Module name (for debugging) */
  moduleName?: string;
  /** Generate source map (default: false) */
  sourceMap?: boolean;
  /** Preserve the Wasm name section through optimization for profiling. */
  preserveDebugNames?: boolean;
  /** Source map URL to embed in the wasm binary (default: "module.wasm.map") */
  sourceMapUrl?: string;
  /** Compilation target: "gc" (WasmGC, default), "linear" (linear memory),
   *  "wasi" (WASI-compatible GC), or "standalone" (pure WasmGC, no JS host
   *  and no WASI runtime — #1470). `target: "standalone"` implies
   *  `nativeStrings: true` and refuses to emit any `wasm:js-string` or
   *  `env` JS-host string imports. */
  target?: "gc" | "linear" | "wasi" | "standalone";
  /**
   * Dynamic direct-eval lowering for the WasmGC JavaScript-host target.
   *
   * `"legacy"` (default) preserves the historical `(source, isDirect)` host
   * import, which cannot observe Wasm locals. `"reified-host"` promotes the
   * caller-visible bindings into the same canonical mutable cells used by the
   * standalone runtime-eval provider and passes those cells to the host through
   * `env::__extern_direct_eval`. The AOT module remains in its original host;
   * an isolated evaluator receives only opaque binding/value handles.
   *
   * This option is invalid for linear/WASI/standalone targets. The no-JS-host
   * lanes own their runtime-eval routing, while the linear backend does not use
   * the WasmGC cell carrier.
   */
  directEval?: "legacy" | "reified-host";
  /**
   * (#743) Declaration source text for the entry module's shipped sibling
   * `.d.ts` (e.g. acorn's `dist/acorn.d.ts` when compiling `dist/acorn.mjs`).
   * Only consulted while `JS2WASM_DTS_ENTRYPOINT_SEEDS` is enabled (**ON by
   * default since 2026-08-08**; `=0` disables): exported functions
   * with implicit-`any` parameters take their declared `string`/`number`
   * parameter types as inference SEEDS (claims joined against internal
   * call-site evidence, guarded at the export boundary — see
   * `src/checker/dts-entrypoint-seeds.ts`). When unset, an on-disk sibling of
   * `fileName` is probed instead. Flag off → byte-identical output.
   */
  entryDeclarations?: string;
  /**
   * (#4035) Host-bridge export policy — whether the module exposes the
   * inspection/interop surface a **JavaScript** host uses to reach inside
   * WasmGC values: `__vec_*`, `__sget_*`/`__sset_*`, `__call_fn*`,
   * `__is_*`, `__struct_field_names`, `__exn_render_*`, `__stdout_*`, and
   * the `js2_*_host_bridge` marker table/global.
   *
   * These are two different things wearing one name:
   *
   * - **js-host mode — a calling convention, not debug info.**
   *   `src/runtime.ts` materializes arrays through `__vec_len`/`__vec_get`,
   *   serves `.push` via `__vec_push`, and reads compiled-struct fields via
   *   `__sget_<key>` (a plain `result[field]` on a WasmGC struct yields
   *   `undefined`). Removing them breaks interop, so the default stays on.
   * - **standalone/WASI — inspection.** The target is a JS-free host; a
   *   deployed module needs its own exports plus `_start`. The real
   *   consumers are harness-side: `__exn_render_*` (#2962) so test262 can
   *   render a natively-thrown GC payload, `__stdout_*` (#3469) for the
   *   host-free completion marker. Every production binary was paying for
   *   them — and because exports are GC roots, `-O3` could strip none of it.
   *
   * `"auto"` (default) therefore resolves per target: `"always"` for js-host,
   * `"off"` for standalone/WASI. A JS-side caller that DOES inspect a
   * standalone module (the test262 runner, any tooling) must ask for
   * `"always"` explicitly. Every consumer already guards each access with a
   * `typeof exports.__x === "function"` check, so absence is safe.
   */
  hostBridge?: "auto" | "always" | "off";
  /**
   * Semantic implementation policy, independent of the execution environment,
   * platform capabilities, and the JS value bridge (#4397).
   *
   * `"auto"` (default) preserves the current target-specific providers.
   * `"native-first"` selects each migrated Wasm-native provider family even
   * when JavaScript instantiates the module. Today this includes the complete
   * native-string family; additional families join this policy as they pass
   * their differential gates. JS boundary wrappers remain enabled according
   * to `hostBridge`, and explicit platform APIs remain available.
   */
  semanticProviders?: import("./target-profile.js").SemanticProviderSelection;
  /**
   * (#86) NOT a real option — declared `never` so `compile(src, { standalone:
   * true })` is a TypeScript excess-property error. The standalone codegen
   * regime is selected via `target: "standalone"`; a `standalone` boolean was
   * silently ignored (it never reached codegen), producing vacuous standalone
   * coverage. `buildCodegenOptions` also throws at runtime for widened
   * (`Record`-typed) callers. Use `target: "standalone"`.
   */
  standalone?: never;
  /**
   * (#86) NOT a real option — see `standalone`. The WASI regime is
   * `target: "wasi"`; a `wasi` boolean was silently ignored.
   */
  wasi?: never;
  /** Enable fast mode — i32 default numbers, performance optimizations */
  fast?: boolean;
  /**
   * (#2119) Whether to infer ES-module strictness (module code is always strict,
   * ECMA-262 11.2.2) from a genuine top-level `import`/`export`. Drives the
   * unmapped `arguments` object for module functions. Defaults to `true` — the
   * product compiles real module input, so this is the spec-correct behaviour.
   *
   * The test262 harness sets this to `false` for *script* tests: its `wrapTest`
   * injects a synthetic `export function test()` entry point that makes
   * TypeScript flag *every* wrapped source as a module
   * (`externalModuleIndicator`). Inferring module-strictness from that synthetic
   * export wrongly unmaps `arguments` for sloppy (`noStrict`) tests asserting
   * mapped behaviour. The harness passes `false` for non-module-goal tests and
   * leaves it `true` (default) for genuine module tests, so the compiler sees
   * the source's *true* strictness rather than the wrapper artifact. An explicit
   * `"use strict"` prologue and class context still force strict regardless.
   */
  inferModuleStrictArguments?: boolean;
  /** Use WasmGC-native strings (array i16) instead of wasm:js-string imports.
   *  Enabled automatically when fast: true or target: "wasi".
   *  Required for non-browser runtimes (wasmtime, wasmer, etc.) */
  nativeStrings?: boolean;
  /**
   * (#2141 S1) Honest generic `any` boxing — Stage-B regime flag of the tag-5
   * ABI retirement. When true, boxing an externref-carried dynamic value into
   * `$AnyValue` runtime-classifies it to its true `JsTag` (undefined/number/
   * boolean/string/object) instead of the historical blanket tag-5 "string"
   * (#1888 box-the-externref ABI). Default false (legacy, byte-identical).
   * Standalone/wasi only — host (gc) mode dynamic values stay host-owned.
   * Do not enable in production until slice S4 of #2141 flips the default.
   */
  honestAnyBoxing?: boolean;
  /**
   * (#745) Known-union `$AnyValue` representation — heterogeneous primitive
   * unions (`number | string`, …) resolve to the universal `$AnyValue` tagged
   * carrier instead of externref, so narrowed reads become tag-checked
   * `struct.get`s with no box/unbox helper round-trip. **Default derived from
   * the lane** (#745 S4.5): ON for native-string lanes (standalone / wasi /
   * fast / strictNoHostImports / explicit `nativeStrings`) now that the S3
   * (strict-eq / truthiness / string-concat) and S4 (params / returns /
   * any-boundary) consumer sweeps landed; the JS-host lane stays default-OFF
   * until S5 (hard-gated on #2141). Setting this option explicitly overrides
   * the lane default; the env kill-switch `JS2WASM_UNION_ANYREP=0` forces the
   * legacy externref regime for A/B control.
   */
  unionAnyRep?: boolean;
  /**
   * (#684) Usage-based `any`-local type inference. When on (default), a
   * function-local `any`/`unknown` identifier binding whose every use is
   * ToNumber-invariant (strictly-numeric operators) is lowered to an unboxed
   * `f64` slot instead of the boxed carrier, eliminating the per-read
   * `__box_number`/`__unbox_number` round-trip. Set false to force the legacy
   * boxed representation. See `src/checker/usage-inference.ts`.
   */
  useUsageInfer?: boolean;
  /**
   * (#4218) Which backend answers `ctx.oracle` type queries. `"checker"`
   * (default) is the TS5 `ts.TypeChecker`; `"inhouse"` is the checker-free
   * binder + annotation-propagation backend; `"differential"` answers from the
   * checker while recording where the in-house backend disagrees. Unset falls
   * back to the `JS2WASM_ORACLE_BACKEND` env var, then `"checker"`.
   */
  oracleBackend?: import("./checker/oracle-backend.js").OracleBackend;
  /**
   * (#2141 S2/S3, #2626) Tag-5 boxed-VALUE equality classifier — the
   * three-way true-class dispatch inside the both-tags-5 arm of
   * `__any_eq`/`__any_strict_eq`: Number×Number → `f64.eq` (#2040),
   * String×String → content eq (landed #1888), Object×Object → `ref.eq`
   * identity (#2585), else legacy `0`. Default TRUE since the #2040 A1 flip
   * (2026-07-16): the #3032 lazy-generator waves (W3/#3302/W4) removed the
   * eager-buffer vacuity that previously made the classifier's honest
   * answers unmask latent dstr failures (the −162 merge_group eject). The
   * emit site remains standalone/wasi-gated — host mode is unaffected. Set
   * `JS2WASM_TAG5_CLASSIFIER=0` (or pass `false` here) to force the legacy
   * always-`0` non-string tag-5 arm, which is also fake-NaN self-unequal —
   * the comparator vacuity described in #2141 S2.
   */
  tag5ValueEqClassifier?: boolean;
  /**
   * (#4173) Fast tag-pair dispatch in the standalone dynamic-eq helpers.
   * When true, `__extern_strict_eq`'s identity-miss path classifies both
   * operands by ref.test (number/i31, string, boolean, bigint, `$AnyValue`)
   * and answers directly — `f64.eq` / `__str_equals` / normalized bool eq /
   * `i64.eq`, or fast-false for identity-only pairs — instead of allocating
   * two `$AnyValue` boxes via `__any_from_extern` and calling
   * `__any_strict_eq`. `$AnyValue`-carrying operands keep the full legacy
   * path (cross-representation identity, #2175). Also dedupes the second
   * `any.convert_extern` in `__is_truthy`. Standalone/WASI only; host lane
   * byte-identical. Default TRUE (A/B-validated, #4173 Results). Set
   * `JS2WASM_FAST_STRICT_EQ=0` (or pass `false`) to force the legacy bodies.
   */
  fastStrictEq?: boolean;
  /**
   * (#2106 S1) Standalone `$undefined` tag-1 singleton regime. When true (and
   * targeting standalone/nativeStrings), `undefined` is represented by the
   * S1.0 immutable tag-1 `$AnyValue` global (extern-wrapped at the externref
   * plane), DISTINCT from `null` (`ref.null.extern`): `null !== undefined`,
   * `typeof null === "object"`, ToNumber(null)=0 vs ToNumber(undefined)=NaN.
   * All undefined producers (emitUndefined, `__extern_get`/`__extern_get_idx`
   * miss, literal stores, boxToAny) and undefined-specific consumers
   * (`__extern_is_undefined`, typeof cluster, strict-eq) flip in lockstep
   * under this flag; nullish-intent consumers widen to `is_null ∨
   * is-singleton`. Default TRUE (#2106 default-flip): the singleton is the
   * standalone/nativeStrings `undefined` representation. Host (gc) mode is
   * unaffected — it has a real host `undefined` via `__get_undefined`, and
   * `undefinedSingletonActive` also gates on standalone||nativeStrings. Set
   * `JS2WASM_UNDEF_SINGLETON=0` to force the legacy (undefined ≡ null ≡
   * ref.null.extern, byte-identical) regime for A/B control / rollback.
   */
  undefinedSingleton?: boolean;
  /** #1588 PR-B: dual i8/i16 string storage. When true, string allocation
   *  sites the encoding analysis proves `ascii`/`utf8-guaranteed` are stored
   *  as i8-backed `Utf8String`; all others stay i16. Default false →
   *  byte-identical output. Implies `nativeStrings` on the WasmGC backend. */
  utf8Storage?: boolean;
  /** Test-only: emit `__test_str_from_externref` and `__test_str_to_externref`
   *  exports so test code can pass JS strings to/from native-string params (#1187).
   *  Has no effect unless `nativeStrings` is also true. Production builds should
   *  leave this unset — when off, the helpers are absent from the module entirely. */
  testRuntime?: boolean;
  /** Enable SIMD-accelerated string/array helpers (requires engine SIMD support) */
  simd?: boolean;
  /** Enable safe mode — reject unsafe TypeScript patterns at compile time */
  safe?: boolean;
  /** Globals allowed in safe mode (e.g. ["document"]) */
  allowedGlobals?: string[];
  /** Extern class members allowed in safe mode (e.g. { Element: ["textContent"] }) */
  allowedExternMembers?: Record<string, string[]>;
  /** Allow JavaScript source files as input (auto-detected for .js fileName) */
  allowJs?: boolean;
  /**
   * Treat every JavaScript root in a multi-file compile as syntax-test input:
   * retain all-root diagnostics and stop on TypeScript grammar errors. By
   * default, `allowJs` keeps its package-oriented diagnostic leniency. Opt-in
   * so ordinary JavaScript product compiles stay unchanged.
   */
  strictJsSyntax?: boolean;
  /**
   * Run the compiler's ECMAScript early-error pass even when `allowJs` is set.
   * Intended for callers that own the complete JavaScript input graph; package
   * dependency compiles retain the historical early-error skip by default.
   */
  enforceJsEarlyErrors?: boolean;
  /** Virtual file name for the source (controls language: use ".js" for JS input) */
  fileName?: string;
  /** Module resolution options for npm packages */
  resolve?: {
    /** Directories to search for modules (default: ["node_modules"]) */
    modules?: string[];
    /** File extensions to try during resolution (default: [".ts", ".tsx", ".d.ts"]) */
    extensions?: string[];
    /**
     * Opt in to consumer-driven expansion of declaration-free barrel modules.
     *
     * When a module contains only imports and re-exports, named consumers only
     * pull the re-export providers for the names they request. Namespace
     * imports are narrowed only when every use is a static property read;
     * dynamic namespace uses and side-effect imports retain the complete
     * graph. This is intended for
     * source trees generated for bundlers (for example TypeScript's
     * `_namespaces/ts.ts`) where unused import/re-export targets and unreachable
     * declaration bodies are declared side-effect-free by the caller. Default
     * false preserves exact ESM module evaluation semantics and the historical
     * graph.
     */
    consumerDrivenBarrels?: boolean;
  };
  /** Packages to keep as host imports (not resolved/bundled) */
  externals?: string[];
  // NOTE: there is no `treeshake` compile option. The standalone `treeshake()`
  // helper (exported below) is used directly by callers/tests; no compile path
  // ever read a `CompileOptions.treeshake` flag, so the dead option was removed
  // (#1931) rather than left as documented-but-inert API surface.
  /** ABI for exported functions: "default" (normal) or "c" (C-compatible calling conventions).
   *  C ABI is only supported with target: "linear". Strings/arrays become (ptr, len) pairs. */
  abi?: "default" | "c";
  /** Enable hardened mode: reject eval, Function constructor, with, __proto__ at compile time */
  hardened?: boolean;
  /** Skip semantic diagnostics for faster compilation (checker still available for type queries) */
  skipSemanticDiagnostics?: boolean;
  /**
   * #4452 — how `compileFiles` picks the TypeScript `compilerOptions` it
   * type-checks the project under. Unset (default) searches upward from the
   * entry file for the nearest `tsconfig.json` and uses its options, so
   * js2wasm agrees with `tsc` about the project it is compiling; a string
   * names a specific config file; `false` forces the legacy hardcoded option
   * set. Only the on-disk `compileFiles` path reads this — the in-memory
   * `compileMulti`/`compile` paths have no project on disk.
   */
  tsconfig?: string | false;
  /** Generate a WIT (WebAssembly Interface Types) file from exported functions.
   *  When set, the result will include a `wit` field with the WIT interface definition.
   *  Value can be true (derive package name from fileName/moduleName) or an object with
   *  packageName/worldName options. */
  wit?: boolean | { packageName?: string; worldName?: string };
  /** Run Binaryen wasm-opt post-processing on the output binary (default: false).
   *  Requires either the 'binaryen' npm package or wasm-opt on PATH.
   *  Set to true for -O3 defaults, or pass a number (1-4) for a specific level. */
  optimize?: boolean | 1 | 2 | 3 | 4;
  /**
   * Experimental: route a narrow set of functions through the middle-end IR
   * (see `src/ir/`). Defaults to **on** since #1131 (the driver passes
   * `experimentalIR !== false`); pass `false` to force the legacy
   * direct-emission path (bit-by-bit divergence tests or emergency revert).
   */
  experimentalIR?: boolean;
  /**
   * #3519 — collect the typed per-unit IR terminal ledger. This does not
   * change hybrid routing or enable IR-only compilation.
   */
  trackIrOutcomes?: boolean;
  /**
   * (#2973) Opt this compile out of the `JS2WASM_IR_FIRST` compile-once
   * inversion, regardless of the ambient env flag. Semantics-critical
   * in-process sub-compiles — the `eval` / `new Function` host shims — MUST
   * set this: they are a proven fast path, not an IR-first *measurement*
   * target, and an IR-first post-claim hard error there is swallowed by the
   * shim's fallback `catch` arms and silently degraded to `undefined` (a wrong
   * answer, not a fail-loud error). Only the fail-loud skip-body inversion is
   * disabled; the ordinary IR overlay (`experimentalIR`) is untouched.
   * Default: false.
   */
  disableIrFirst?: boolean;
  /** Compile-time constant definitions. Substitutes identifiers/dotted paths with literal values
   *  before TypeScript parsing. Example: `{ "process.env.NODE_ENV": '"production"' }`.
   *  Values must be valid JS expression literals (strings need inner quotes).
   *  Also supports shorthand: `"production"` mode sets process.env.NODE_ENV and typeof guards. */
  define?: Record<string, string>;
  /** Allow synchronous file-system access via `node:fs` (`readFileSync`, `writeFileSync`)
   *  as JS host imports in non-WASI targets (#1491). Gated behind an explicit flag
   *  to prevent accidental capability leakage when compiling third-party code.
   *  Default: false (calls to fs.readFileSync / fs.writeFileSync raise a compile error). */
  allowFs?: boolean;
  /**
   * (#4238 slice 1) INTERNAL provider-build option. When true, a `declare
   * function` extern's parameter and return types are resolved through the
   * native-type annotations (`type i32 = number`, `nativeTypeFromTypeNode`)
   * BEFORE falling back to the default `mapTsTypeToWasm` mapping — so
   * `declare function qjs_eval(ctx: i32, src: i32, len: i32): i32` emits a real
   * `(i32,i32,i32) -> i32` import that binds DIRECTLY to a peer wasm module's
   * export with no JS wrapper closure in between.
   *
   * Default off, and deliberately not a CLI flag: user externs must keep the
   * historical f64 mapping (`number` → f64) or every existing host binding
   * would change signature. Only `QUICKJS_ADAPTER_COMPILE_OPTIONS` in
   * `scripts/quickjs-eval-provider.mjs` sets it.
   */
  externNativeTypes?: boolean;
  /**
   * (#4238 slice 1) INTERNAL provider-build option. Import module for
   * `declare function` externs, instead of the default `"env"` JS-host module.
   * Used by the QuickJS eval adapter so its `qjs_*` externs are declared in the
   * `js2wasm:qjs` namespace (a wasm-to-wasm provider namespace, satisfied by
   * `libquickjs.wasm`'s exports — not a JS host surface). Default `undefined`
   * → `"env"`, byte-identical.
   */
  externImportModule?: string;
  /**
   * (#4238 slice 1) INTERNAL provider-build option. Import the module's linear
   * memory from `{ module }.memory` instead of defining one, mirroring the
   * proven `--link node:fs` topology (`src/codegen/wasi.ts`): the PEER module
   * owns and exports the memory, this module imports it at memory index 0, so
   * the `wasm:memory` accessors (`store8`/`load8`/`store32`/`load32`) address
   * the peer's heap directly. A memory import does not perturb the function
   * index space. Default `undefined` → unchanged.
   */
  importMemory?: { module: string; min?: number };
  /**
   * (#2796) Differential-test-harness fidelity flag. In the default JS-host
   * (WasmGC) target, top-level module code runs via the wasm `start` section —
   * i.e. DURING `WebAssembly.instantiate`, BEFORE the host can call
   * `setInstance(instance)`. Top-level code that introspects WasmGC
   * structs (`for…in` / `Object.keys` over a runtime-shaped object) needs the
   * `__struct_field_names` / `__sget_*` exports, which only exist once the
   * instance is constructed — so during the start section they resolve to
   * nothing and a `for…in` enumerates zero keys. The standalone/WASI path does
   * NOT hit this: it runs top-level code via an explicitly-called `_start`
   * export AFTER instantiation, when every export is reachable.
   *
   * When `true`, emit the top-level `__module_init` as an EXPORT and do NOT run
   * it via the wasm `start` section, so the host can invoke
   * `instance.exports.__module_init()` AFTER wiring `setInstance` — symmetric
   * with the standalone `_start` model. The differential-test harness
   * (`scripts/diff-test.ts`) sets this so the HOST lane runs top-level code with
   * the same fully-wired runtime the standalone lane uses, rather than tripping
   * over an exports-timing artifact of the harness. Default `false` →
   * byte-identical output (top-level runs in the wasm `start` section) for every
   * other consumer (website, playground, test262, library users).
   */
  deferTopLevelInit?: boolean;
  /**
   * #2783 — general `--link <namespace>` dynamic-linking axis (the ONLY
   * link-vs-inline control; the old `linkNodeShims` boolean was removed). Each
   * listed namespace is left as a **link-time import** (satisfied at
   * instantiation by a preloaded provider module, e.g.
   * `wasmtime --preload node:fs=node-fs.wasm`) instead of being inline-lowered to
   * a self-contained module. "Leave-as-import" is the universal capability (any
   * external namespace can be a wasm import); "inline-lower" is the special
   * capability the compiler only has for a known few (`node:fs` fd IO). So for an
   * arbitrary namespace `link: ["acme:telemetry"]` simply permits its imports
   * past the strict `--no-host-imports` / WASI gate; for `node:fs` it
   * additionally selects the import-and-link std-IO path (the user module imports
   * `readSync`/`writeSync` + its linear memory from `node:fs` and carries no
   * `wasi_snapshot_preview1` import for stream IO; console.log /
   * process.std*.write lower to `writeSync(1|2, …)`, stdin is `readSync(0, …)`).
   *
   * Target-neutral: any target may retain a declared provider namespace as an
   * explicit link-time import. The special `node:fs` std-IO rewrite remains
   * WASI-only. Default empty — every namespace stays on its existing
   * standalone / inline-lowered path. CLI: `--link <ns>` (repeatable).
   */
  link?: string[];
  /**
   * Node API emulation (#2603). Opt-in via `--emulate node`. When set, the
   * checker is given an ambient `process` declaration so Node globals js2wasm
   * lowers (process.std{in,out,err}, argv, env, exit) type-check without
   * @types/node — and the "Cannot find name 'process'" warning is suppressed.
   * When NOT set, that warning instead suggests adding `--emulate node`.
   * Type-level only; does not change emitted wasm.
   */
  emulateNode?: boolean;
  /**
   * Host environment scoping the AMBIENT global surface (#2528/#2645), now the
   * unified host axis driven by `--target {web,node,deno}` (#2736). The legacy
   * `--platform` flag is a deprecated alias onto this same field. It selects
   * which globals are in scope at type-check time and whether Node-style
   * emulation is on. The backend-lowering names (`gc`/`linear`/`wasi`/
   * `standalone`) still live on the separate `target` option, so this stays an
   * internal sub-axis even though the user-facing flag is unified.
   *
   *   - `"web"`         → DOM ambient surface (`window`, `document`, DOM types)
   *                       in scope; node-only globals are not. Byte-identical to
   *                       the historical default.
   *   - `"node"`/`"deno"` → DOM-only globals are NOT in scope (so `window.stop`
   *                       in a node/deno host is a clear type error), AND the
   *                       Node-emulation injection path turns on (#2645), so
   *                       `process` & friends type-check without @types/node.
   *                       (Real `@types/node` / Deno-lib loading is a later
   *                       #2698 slice; here `deno` routes through the same
   *                       node-emulation/no-DOM ambient surface as `node`.)
   *
   * `undefined` (unset) preserves today's behaviour exactly: the DOM ambient
   * surface is loaded and `emulateNode` is driven solely by its own option /
   * `node:`-import auto-detection. Type-level only; does not change emitted wasm.
   *
   * Precedence vs the backend `target` (e.g. `--target wasi`): the host surface
   * and the backend are independent. When this is unset, a `wasi`/`standalone`
   * target does NOT implicitly drop the DOM ambient surface — that would change
   * today's output; pass `--target node`/`deno` explicitly to scope it.
   */
  platform?: "web" | "node" | "deno";
  /**
   * Enforce dual-mode discipline (#1524): when true, codegen rejects any
   * JS-host `env` import that is not on
   * `src/codegen/host-import-allowlist.ts`. Auto-enabled under
   * `target: "wasi"` unless this option is explicitly set to `false`
   * (the `--allow-host-imports` CLI escape hatch).
   *
   * Compile errors raised by the gate name the offending import and the
   * tracking issue that owns its Wasm-native replacement.
   */
  strictNoHostImports?: boolean;
  /**
   * Linear backend (`target: "linear"`) allocator behaviour (#1856).
   *
   * The linear backend always uses a **bump/arena** allocator — each
   * allocation advances a single heap pointer and nothing is freed until
   * the Wasm instance is dropped (the "allocate-and-exit" model that suits
   * most standalone/WASI short-lived programs; see R10 in
   * `docs/architecture/compiler-design-lessons.md` and ADR-0017). There is
   * deliberately no pluggable GC abstraction.
   *
   * - `"bump"` (default): the plain allocate-and-exit arena, smallest binary.
   * - `"arena-reset"`: same allocator, plus safe between-call reclamation and
   *   the `__arena_reset()` / `__arena_used()` management exports. When every
   *   exported parameter/result and module global is primitive, the compiler
   *   inserts a host-boundary wrapper that rewinds immediately before the next
   *   call. Aggregate boundaries or heap-backed globals conservatively keep
   *   the monotonic arena so returned/escaped pointers remain live; the host
   *   may still use the explicit reset once it knows those lifetimes ended.
   * - `"analysis-stack"`: for single-source functions accepted by the optional
   *   IR path, promote fixed-size owned/non-escaping allocations into a
   *   function-scoped stack region. Direct-backend, multi-module, unsupported,
   *   and escaping allocations keep the ordinary arena fallback.
   *
   * Ignored for non-`linear` targets — the WasmGC backends delegate object
   * lifetime to the host GC and have no linear allocator.
   */
  allocator?: "bump" | "arena-reset" | "analysis-stack";
  /**
   * External C functions the emitted linear module imports (#4539).
   *
   * Linking against a C library — e.g. the pinned engine artifact of ADR-0020
   * — requires the module to declare the functions it calls. Declared before
   * any defined function so indices stay stable; omitting this leaves the
   * emitted binary byte-identical.
   *
   * `linear` target only.
   */
  linearExternImports?: readonly LinearExternCImportSpec[];
  /**
   * Import linear memory from another module instead of defining one (#4539).
   *
   * Required when linking against an artifact that EXPORTS memory: both sides
   * must address one memory and only one may own it. `linear` target only.
   */
  linearImportMemory?: {
    module: string;
    name: string;
    min: number;
    max?: number;
    /**
     * memory64 index type (#4554). The field exists so a 64-bit caller has
     * somewhere to say so; `"i64"` is currently **refused** rather than
     * accepted and ignored, which would emit 32-bit limits for a 64-bit
     * memory.
     */
    indexType?: "i32" | "i64";
  };
  /**
   * Linked-mode heap (#4540) — REQUIRED alongside {@link linearImportMemory}.
   *
   * When the memory belongs to another module, the arena must be carved from
   * that module's allocator instead of owning a fixed address range. Names the
   * `linearExternImports` entry providing `malloc(size: i32) -> ptr: i32`.
   *
   * Compilation is refused if only one of the two is given: a memory-importing
   * module with the standalone arena starts allocating at 1024, which is inside
   * the pinned engine artifact's shadow stack.
   */
  linearLinkedHeap?: {
    mallocImport: string;
    chunkBytes?: number;
  };
  /**
   * Which allocator backs the linear heap (#4557).
   *
   * `"malloc-v1"` emits a real allocator (free lists, coalescing, in-place
   * `realloc`) and exports the five entry points the QuickJS artifact imports
   * for `JS_NewRuntime2`, so the engine allocates through us instead of its own
   * dlmalloc. Defaults to `"bump"` — ADR-0017's monotonic arena, and #4540's
   * shipped fallback.
   */
  linearHeapAllocator?: "bump" | "malloc-v1";
}

import * as path from "path";
import { IncrementalLanguageService, IncrementalProjectLanguageService } from "./checker/index.js";
import { compileFilesSource, compileMultiSource, compileSource, compileToObjectSource } from "./compiler.js";
import { withIrCompileRoute } from "./compiler/ir-cutover-invocation.js";
import { ModuleResolver, resolveAllImports } from "./resolve.js";
import { buildCompiledImports as buildCompiledImportsRuntime } from "./runtime.js";

/**
 * Compile TypeScript source to Wasm GC binary.
 *
 * @example
 * ```ts
 * const result = await compile(`
 *   export function add(a: number, b: number): number {
 *     return a + b;
 *   }
 * `);
 * if (result.success) {
 *   const { instance } = await WebAssembly.instantiate(result.binary, imports);
 *   console.log(instance.exports.add(2, 3)); // 5
 * }
 * ```
 */
export async function compile(source: string, options?: CompileOptions): Promise<CompileResult> {
  return withImportObject(await compileSource(source, options));
}

/**
 * Attach a lazily-computed `importObject` getter (#1667) to a compile result.
 *
 * Building the host runtime via {@link buildImports} is deferred until the
 * caller actually reads `result.importObject`, so standalone / `wasi` outputs
 * (which need no host imports) pay nothing, and the result stays cheap to
 * produce. The built object is cached on first access.
 *
 * The returned object is a valid `WebAssembly.Imports`: `{ env, "wasm:js-string",
 * string_constants }`. It targets the polyfill instantiation path
 * (`WebAssembly.instantiate(binary, importObject)` with no extra options),
 * which is what the issue's example uses.
 */
function withImportObject(result: CompileResult): CompileResult {
  let cached: WebAssembly.Imports | undefined;
  Object.defineProperty(result, "importObject", {
    enumerable: true,
    configurable: true,
    get() {
      if (cached) return cached;
      // Failed compile or genuinely import-free (standalone / wasi) output needs
      // no host runtime — return an empty, harmless import object.
      //
      // (#4029) `result.imports` counts FUNCTION imports only. A module with no
      // host function imports can still declare imported string-constant
      // GLOBALS, built from `result.stringPool` — a two-file graph whose whole
      // content is `add(a, b)` has 0 imports and 4 string constants. Taking the
      // short-circuit there handed back `{}` for a module that declares the
      // `string_constants` namespace, so instantiating through this convenience
      // path died with "Import #0 module=\"string_constants\": module is not an
      // object or function". That is why tests/multi-file.test.ts was 9 failed /
      // 1 passed on a clean checkout. Require BOTH to be empty.
      if (!result.success || (result.imports.length === 0 && result.stringPool.length === 0)) {
        cached = {};
        return cached;
      }
      const built = buildCompiledImportsRuntime(result);
      cached = {
        env: built.env,
        "wasm:js-string": built["wasm:js-string"],
        string_constants: built.string_constants,
      } as unknown as WebAssembly.Imports;
      // (#1712) Expose the runtime's exports hook. Without it, the host
      // runtime's `callbackState.getExports()` is permanently undefined on
      // this convenience path, silently disabling every exports-backed
      // capability (closure wrapping via __call_fn_N/__call_fn_method_N,
      // __sget_* struct reads, __is_closure gating). Callers wire it after
      // instantiation:
      //   const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
      //   (r.importObject as any).__setInstance?.(instance);
      // Non-enumerable so WebAssembly.instantiate's import resolution (which
      // only reads the module-declared namespaces) never sees it.
      if (built.setExports) {
        Object.defineProperty(cached, "__setExports", {
          value: built.setExports,
          enumerable: false,
          configurable: true,
        });
      }
      if (built.setInstance) {
        Object.defineProperty(cached, "__setInstance", {
          value: built.setInstance,
          enumerable: false,
          configurable: true,
        });
      }
      if (built.startImportCounting && built.takeImportCounts) {
        Object.defineProperty(cached, "__startImportCounting", {
          value: built.startImportCounting,
          enumerable: false,
          configurable: true,
        });
        Object.defineProperty(cached, "__takeImportCounts", {
          value: built.takeImportCounts,
          enumerable: false,
          configurable: true,
        });
      }
      return cached;
    },
  });
  return result;
}

/**
 * Compile multiple TypeScript source files into a single Wasm GC binary.
 * Supports cross-file imports: `import { foo } from "./bar"`.
 */
export async function compileMulti(
  files: Record<string, string>,
  entryFile: string,
  options?: CompileOptions,
): Promise<CompileResult> {
  return withImportObject(await compileMultiSource(files, entryFile, options));
}

/**
 * Compile a TypeScript project from an entry file on disk.
 * Uses ts.createProgram with real filesystem access -- TypeScript resolves
 * all imports (relative and package) automatically via standard module resolution.
 * All resolved source files are compiled into a single Wasm module.
 * Only the entry file's exports become Wasm exports.
 *
 * @param entryPath - Path to the entry .ts file (absolute or relative to cwd)
 * @param options - Compile options
 *
 * @example
 * ```ts
 * // Given: src/main.ts imports from src/utils.ts
 * const result = await compileFiles("src/main.ts");
 * // TypeScript resolves src/utils.ts automatically
 * ```
 */
export async function compileFiles(entryPath: string, options?: CompileOptions): Promise<CompileResult> {
  return withImportObject(await compileFilesSource(entryPath, options));
}

/** Only WAT text (debug) */
export async function compileToWat(source: string): Promise<string> {
  const result = await compileSource(source, { emitWat: true });
  return result.wat;
}

/**
 * Compile TypeScript source to a relocatable Wasm object file (.o).
 * The output contains LLVM-style linking and relocation metadata
 * suitable for use with a Wasm linker.
 */
export function compileToObject(source: string, options?: CompileOptions) {
  return compileToObjectSource(source, options);
}

/**
 * Compile a TypeScript project from an entry file on disk.
 * Resolves npm package imports and relative imports recursively,
 * then compiles all resolved files into a single Wasm module.
 *
 * @param entryFile - Absolute or relative path to the entry .ts file
 * @param options - Compile options including resolve and externals settings
 */
export async function compileProject(entryFile: string, options?: CompileOptions): Promise<CompileResult> {
  const logicalEntry = path.resolve(entryFile);
  const logicalRootDir = path.dirname(logicalEntry);

  // Auto-enable allowJs when entry file is .js/.mjs (#1107)
  const isJs = /\.[cm]?js$/.test(logicalEntry);
  const effectiveOptions = isJs && !options?.allowJs ? { ...options, allowJs: true } : options;

  // Create resolver
  const resolver = new ModuleResolver(logicalRootDir, effectiveOptions);
  const resolvedEntry = resolver.canonicalize(logicalEntry);
  const rootDir = path.dirname(resolvedEntry);

  // Resolve all imports recursively
  const allFiles = resolveAllImports(resolvedEntry, resolver);
  const resolutionDiagnostics = resolver.getDiagnostics();
  if (resolutionDiagnostics.length > 0) {
    return withImportObject({
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors: resolutionDiagnostics.map((diagnostic) => ({ ...diagnostic })),
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    });
  }

  // Convert to the Record<string, string> format expected by compileMulti
  const files: Record<string, string> = {};
  const fileKeys = new Map<string, string>();
  for (const [filePath, content] of allFiles) {
    // Use relative paths from root dir as keys
    const relPath = path.relative(rootDir, filePath);
    // Ensure paths start with ./ for the multi-file compiler
    const key = relPath.startsWith(".") ? relPath : `./${relPath}`;
    files[key] = content;
    fileKeys.set(resolver.canonicalize(filePath), key);
  }

  const entryKey = fileKeys.get(resolvedEntry) ?? `./${path.relative(rootDir, resolvedEntry)}`;

  // Preserve the exact importer→specifier→target edges discovered against the
  // physical filesystem. The virtual checker cannot reconstruct pnpm's private
  // dependency tree from flattened in-memory file names (#3654).
  const projectResolutions: Record<string, Record<string, string>> = {};
  for (const filePath of allFiles.keys()) {
    const importerKey = fileKeys.get(resolver.canonicalize(filePath));
    if (!importerKey) continue;
    const resolutions: Record<string, string> = {};
    for (const [specifier, targetPath] of resolver.getResolvedImports(filePath)) {
      const targetKey = fileKeys.get(resolver.canonicalize(targetPath));
      if (targetKey) resolutions[specifier] = targetKey;
    }
    if (Object.keys(resolutions).length > 0) {
      projectResolutions[importerKey] = resolutions;
    }
  }

  return withImportObject(
    await compileMultiSource(
      files,
      entryKey,
      withIrCompileRoute(effectiveOptions, "compileProject"),
      undefined,
      projectResolutions,
    ),
  );
}

/**
 * Create an incremental compiler that reuses a persistent, versioned TypeScript Language Service.
 * Unchanged sources retain their Program, checker, and diagnostic caches; edited sources use
 * incremental snapshots so TypeScript reparses and rechecks only invalidated state. Lib files
 * are parsed once and retained across compilations.
 *
 * Ideal for worker pools or batch compilation scenarios where many source files
 * are compiled sequentially in the same process.
 *
 * @example
 * ```ts
 * const compiler = createIncrementalCompiler();
 * const result1 = await compiler.compile("export function a(): number { return 1; }");
 * const result2 = await compiler.compile("export function b(): number { return 2; }"); // faster
 * const project = await compiler.compileMulti(
 *   { "dep.ts": "export const n = 2", "main.ts": "import { n } from './dep'; export const value = n" },
 *   "main.ts",
 * );
 * compiler.dispose(); // free resources when done
 * ```
 */
export function createIncrementalCompiler(defaultOptions?: CompileOptions): {
  compile: (source: string, options?: CompileOptions) => Promise<CompileResult>;
  compileMulti: (files: Record<string, string>, entryFile: string, options?: CompileOptions) => Promise<CompileResult>;
  dispose: () => void;
} {
  const service = new IncrementalLanguageService();
  let projectService: IncrementalProjectLanguageService | undefined;
  return {
    compile(source: string, options?: CompileOptions): Promise<CompileResult> {
      return compileSource(
        source,
        withIrCompileRoute({ ...defaultOptions, ...options }, "incremental.compile"),
        service,
      );
    },
    async compileMulti(
      files: Record<string, string>,
      entryFile: string,
      options?: CompileOptions,
    ): Promise<CompileResult> {
      projectService ??= new IncrementalProjectLanguageService();
      return withImportObject(
        await compileMultiSource(
          files,
          entryFile,
          withIrCompileRoute({ ...defaultOptions, ...options }, "incremental.compileMulti"),
          projectService,
        ),
      );
    },
    dispose() {
      service.dispose();
      projectService?.dispose();
    },
  };
}

export { entryHasRelativeImports } from "./compiler.js";
export { getBarePackageName, ModuleResolver, resolveAllImports } from "./resolve.js";
export { preloadLibFiles } from "./checker/index.js";
export { getEntryExportNames, treeshake } from "./treeshake.js";
export { generateWit } from "./wit-generator.js";
export type { WitGeneratorOptions } from "./wit-generator.js";
// (#4420) The single engine-validation primitive. Exported so scoreboards
// (dogfood harnesses, npm-compat, self-host probes) can ask "is this a module
// the engine accepts?" without growing another private copy of the idiom.
export { validateEmittedBinary } from "./optimize.js";
export type { EmittedBinaryValidation } from "./optimize.js";

// #2527 / #2514 — canonical runtime-type rec-group identity primitive for
// core-wasm module linking (shared store). Pure analysis over a WasmModule's
// type table; the foundation for the runtime.wasm ABI drift gate.
export {
  canonicalHashOfTypeGroup,
  extractRuntimeGroup,
  fingerprintRuntimeGroup,
  RUNTIME_RECGROUP_ABI_VERSION,
  RUNTIME_RECGROUP_TYPE_NAMES,
} from "./emit/canonical-recgroup.js";
export type { RuntimeGroupFingerprint, RuntimeGroupMember } from "./emit/canonical-recgroup.js";

export {
  buildCompiledAdapterImports,
  buildCompiledImports,
  buildImports,
  buildStringConstants,
  buildWasiPolyfill,
  checkPolicy,
  compileAndInstantiate,
  instantiateWasm,
  instantiateWasmStreaming,
  jsString,
  wrapCompiledExports,
  wrapExports,
} from "./runtime.js";
