// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared backend context and metadata types.
 *
 * This module owns the stable type layer for the codegen backend so leaf
 * modules do not need to import the monolithic `codegen/index.ts` file just
 * to reference context/state shapes.
 */
import { ts } from "../../ts-api.js";
import type { FieldDef, Instr, LocalDef, SourcePos, ValType, WasmModule } from "../../ir/types.js";
import type { StandaloneRegExpEngineConfig } from "../regexp-standalone.js";
import type { ObjectRuntimeTypes } from "../object-runtime.js";

export interface CodegenError {
  message: string;
  line: number;
  column: number;
  severity?: "error" | "warning";
}

/** Result returned by generateModule / generateMultiModule. */
export interface CodegenResult {
  module: WasmModule;
  errors: CodegenError[];
}

/** Public options for backend code generation. */
export interface CodegenOptions {
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
  /** Standalone target (#1470): pure WasmGC, no JS host imports and no WASI
   *  runtime. Implies `nativeStrings: true` and refuses to emit any
   *  `wasm:js-string` namespace or `env::__concat_*` / `__extern_toString` /
   *  `__unbox_string` JS-host string imports. Used so the compiled module is
   *  runnable under pure-Wasm engines (wasmtime, wasmer) without a JS host. */
  standalone?: boolean;
  /**
   * Experimental: route a narrow set of functions through the middle-end IR
   * (see `src/ir/`). Defaults to off. Leave off in production until the IR
   * reaches parity with the legacy direct-emission path.
   */
  experimentalIR?: boolean;
  /** Node builtin modules detected during import preprocessing (#1044) */
  nodeBuiltins?: import("../../import-resolver.js").NodeBuiltinImport[];
  /** Set of function names imported from node:fs (detected pre-preprocessing).
   *  Used by both the WASI fs syscall path (#1035) and the JS-host fs imports (#1491). */
  wasiNodeFsFuncs?: Set<string>;
  /** Allow `node:fs` JS-host imports for non-WASI targets (#1491). Default: false. */
  allowFs?: boolean;
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
}

/** Metadata for a generator lowered to an in-module WasmGC state machine (#680). */
export interface NativeGeneratorInfo {
  /** Source-level generator function name. */
  functionName: string;
  /** Original declaration; used to emit the resume function lazily. */
  decl: ts.FunctionDeclaration;
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
  /** Field index where spilled locals start in the state struct. */
  spillFieldOffset: number;
  /** Number of top-level yield suspension points. */
  yieldCount: number;
  /** Terminal state value. */
  doneState: number;
}

export type NullishExclusion = "null" | "undefined" | "nullish";

export interface NullGuardFact {
  varName: string;
  narrowedBranch: "then" | "else";
  excludes: NullishExclusion;
  provesNonNull: boolean;
}

/** Per-function context. */
export interface FunctionContext {
  /** Function name */
  name: string;
  /** Parameters (these are the first N locals) */
  params: { name: string; type: ValType }[];
  /** Additional locals declared in the body */
  locals: LocalDef[];
  /** All local names → index (params first, then locals) */
  localMap: Map<string, number>;
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
  /** Depth for `return` inside generator body -- adjusted by loop/block nesting */
  generatorReturnDepth?: number;
  /** Map from variable name → ref cell info (for mutable closure captures) */
  boxedCaptures?: Map<string, { refCellTypeIdx: number; valType: ValType }>;
  /** Whether this function is a class constructor (for new.target support) */
  isConstructor?: boolean;
  /** Whether this constructor belongs to a class declared with `extends`. Spec §10.2.1.3
   * step 13c requires a derived constructor that returns a non-object, non-undefined
   * value to throw TypeError instead of silently coercing and null-dereffing. */
  isDerivedConstructor?: boolean;
  /** Whether this function is a generator (function*) */
  isGenerator?: boolean;
  /**
   * (#1042) True while {@link emitAsyncStateMachine} is driving an async
   * function body through the CPS transform. Read by the `AwaitExpression`
   * dispatcher in expressions.ts to decide between the legacy pass-through and
   * a continuation split. Inert in #1042 PR1 (the activation hook is unwired
   * and `ASYNC_CPS_ENABLED` is false), so it stays undefined/false and the
   * emitted Wasm is byte-identical.
   */
  asyncCpsActive?: boolean;
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
  /** Set of variable names known to be non-null in the current scope (type narrowing) */
  narrowedNonNull?: Set<string>;
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
   * #1120: Set of let/const locals whose lifecycle is fully constrained
   * to int32 by explicit `| 0` (or other bitwise) coercion. These get
   * allocated as i32 instead of f64, and the binary-op layer can use
   * native i32 arithmetic for `(a + b) | 0`-style updates without the
   * heavy f64 -> ToInt32 -> f64 round-trip.
   */
  i32CoercedLocals?: Set<string>;
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
  withScopes?: {
    localIdx: number;
    structTypeIdx: number;
    fields: FieldDef[];
    blockedNames: Set<string>;
  }[];
  /** Map from let/const local variable name → local index of its i32 TDZ flag (0 = uninitialized) */
  tdzFlagLocals?: Map<string, number>;
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
  boxedTdzFlags?: Map<string, { refCellTypeIdx: number; localIdx: number }>;
  /**
   * Stack of catch rethrow info. Each entry tracks a catch variable name and the
   * current depth (number of block-like structures) from the catch boundary.
   */
  catchRethrowStack?: { varName: string; depth: number }[];
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
   * #1886 Slice B — live linear-backed `Uint8Array` buffers in this function,
   * keyed by binding name. A buffer proven linear-safe by the #1886 analysis
   * (`ctx.linearUint8.safeBindings`) is represented as a `(ptr, len)` pair of
   * i32 locals instead of a GC vec, so `buf[i]`, `buf.length`, and
   * `process.std*.{read,write}(buf)` operate on linear memory with zero
   * GC↔linear copies. Absent entry ⇒ the binding uses the existing GC-vec path
   * unchanged.
   */
  linearU8Buffers?: Map<
    string,
    {
      ptrLocalIdx: number; // i32 — base byte offset into the page-4 linear arena
      lenLocalIdx: number; // i32 — element length (== byte length for Uint8Array)
    }
  >;
  /** #1886 — function-entry arena mark for rewinding short-lived linear-U8 locals. */
  linearU8ArenaMarkLocalIdx?: number;
}

/** Context shared across all codegen. */
export interface CodegenContext {
  mod: WasmModule;
  checker: ts.TypeChecker;
  /** Map from function name to its absolute index (imports + locals) */
  funcMap: Map<string, number>;
  /** Map from struct/interface name to type index */
  structMap: Map<string, number>;
  /** Reverse map from type index to struct/interface name (O(1) reverse lookup) */
  typeIdxToStructName: Map<number, string>;
  /** Map from struct name to field info */
  structFields: Map<string, FieldDef[]>;
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
  /** Map from global name (e.g. "document") → import info */
  declaredGlobals: Map<string, { type: ValType; funcIdx: number }>;
  /** Counter for generated callback functions (__cb_0, __cb_1, ...) */
  callbackCounter: number;
  /** Map from captured variable name → global index in mod.globals */
  capturedGlobals: Map<string, number>;
  /** Captured globals whose type was widened from ref to ref_null for null init */
  capturedGlobalsWidened: Set<string>;
  /** Set of class names (local classes compiled to Wasm GC structs) */
  classSet: Set<string>;
  /** Classes that must throw TypeError at evaluation time */
  classThrowsOnEval: Set<string>;
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
   * (#1904) True once the standalone `__extern_is_array(externref) -> i32`
   * helper placeholder has been emitted by the object runtime. Its body is
   * filled in post-processing after all Wasm array carrier types (`__vec_*`
   * plus `$ObjVec`) are known.
   */
  externIsArrayReserved?: boolean;
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
  /** Map from local variable name → closure metadata (for call_ref dispatch) */
  closureMap: Map<string, ClosureInfo>;
  /** Map from closure struct type index → closure metadata (for anonymous closures) */
  closureInfoByTypeIdx: Map<number, ClosureInfo>;
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
   * Absolute Wasm global index for the `__current_this` (mut externref) module
   * global (#1636-S1). Set by `__call_fn_method_N` to the host-supplied
   * receiver before invoking the closure body; restored after the call.
   * A `ThisKeyword` reference in a free-function closure (no local `this`
   * binding, not in static context) reads from this global instead of the
   * previous `undefined` fallback. -1 = not yet created.
   */
  currentThisGlobalIdx: number;
  /** Map from struct name → set of closure type indices used for valueOf fields */
  valueOfClosureTypes: Map<string, number[]>;
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
   * Function declarations pre-registered during module-pass eager class body
   * compilation. The entry has a reserved `mod.functions` slot and signature,
   * but its body still belongs to the normal nested-function hoist pass.
   */
  preRegisteredBodyless?: Set<string>;
  /** Map from module-level variable name → global index in mod.globals */
  moduleGlobals: Map<string, number>;
  /** Deferred `export default <variable>` where variable is a module global (#1108).
   *  Resolved after all collectDeclarations calls when global indices are final. */
  deferredDefaultGlobalExport?: string;
  /** Module-level variable initializers (compiled into __module_init) */
  moduleInitStatements: ts.Statement[];
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
  /** Map from any-value helper name → function index */
  anyHelpers: Map<string, number>;
  /** Whether any-value helper functions have been emitted */
  anyHelpersEmitted: boolean;
  /** (#1789) Whether the WASI module-init guard (idempotent __module_init +
   *  prepended init call on exports) has been applied. */
  moduleInitGuardApplied: boolean;
  /** Shape-inferred array-like variables */
  shapeMap: Map<string, { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType }>;
  /** Set of function names that failed during hoisting pre-pass */
  hoistFailedFuncs?: Set<string>;
  /** Counter for unique tagged template cache global variables */
  templateCacheCounter: number;
  /** Type index for template vec struct */
  templateVecTypeIdx: number;
  /** Type index for the WasmGC `$Error_struct` used in standalone/WASI mode (#1104). -1 = not yet registered. */
  errorStructTypeIdx: number;
  /** Extra properties for empty object variables */
  widenedTypeProperties: Map<string, { name: string; type: ValType }[]>;
  /** Map from widened variable name to its registered struct name */
  widenedVarStructMap: Map<string, string>;
  /** Widened empty-object fields introduced by Object.defineProperty rather than assignment. */
  widenedDefinePropertyKeys: Set<string>;
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
  /** Pending module-init body (not yet in mod.functions) that needs global index fixup */
  pendingInitBody: Instr[] | null;
  /** Map from function name to inlinable function info */
  inlinableFunctions: Map<string, InlinableFunctionInfo>;
  /** Global index of the __symbol_counter */
  symbolCounterGlobalIdx: number;
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
  /** (#1340) Singleton closure-struct externref globals for top-level function
   *  declarations used as first-class values. Keyed by function name. Ensures
   *  `foo === foo` and so sidecar writes on `foo.prototype` are observed by
   *  later reads. Mirrors `methodClosureGlobals` (#1394) for the function-decl
   *  case where the same JS identifier is read as a value at multiple sites. */
  funcClosureGlobals: Map<string, number>;
  /** Whether targeting WASI */
  wasi: boolean;
  /** Whether targeting standalone (no JS host, no WASI runtime — #1470).
   *  When true, the emitter MUST NOT add `wasm:js-string` namespace imports
   *  or JS-host string helpers (`__concat_N`, `__extern_toString`,
   *  `__unbox_string`, `__str_from_mem`, `__str_to_mem`,
   *  `__str_extern_len`). Implies `nativeStrings === true`. */
  standalone: boolean;
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
  /** (#682) Native standalone RegExp engine hook. Standalone mode currently
   *  enables the reduced literal-substring backend; null means RegExp lowering
   *  must stay on the explicit #1474 refusal path. */
  standaloneRegExpEngine: StandaloneRegExpEngineConfig | null;
  /**
   * (#1373b) When true, async functions flow through the IR's CPS lowering
   * (Phase C). When false (default), the IR selector buckets async functions
   * into the `"async-function"` fallback reason and they take the legacy
   * direct-codegen path. The first scaffolding slice (#1373b Slice 1)
   * keeps this hardcoded `false`; subsequent slices (Slice 2: PENDING-path
   * CPS continuations, Slice 3: gate-flip) wire it on incrementally once
   * the lowering is parity-tested against the legacy path.
   *
   * Read by `src/ir/select.ts`'s `isAsyncIrReady(ctx)` helper; threaded
   * through `src/ir/integration.ts` into the selector via the
   * `IrPlanOptions.supportsAsyncIr` field.
   */
  supportsAsyncIr: boolean;
  /** WASI import indices */
  wasiFdWriteIdx: number;
  wasiFdReadIdx?: number;
  wasiProcExitIdx: number;
  wasiPathOpenIdx: number;
  wasiFdCloseIdx: number;
  wasiPollOneoffIdx?: number;
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
  /** Set of node:fs functions used in this compilation unit (both WASI and JS-host fs paths). */
  wasiNodeFsFuncs: Set<string>;
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
  /** Properties whose descriptor/value lives in the runtime sidecar. */
  sidecarDefinedPropertyKeys: Set<string>;
  /** Object mutability state sets */
  nonExtensibleVars: Set<string>;
  frozenVars: Set<string>;
  sealedVars: Set<string>;
  /** Per-shape default property flags table */
  shapePropFlags: Map<number, Uint8Array>;
  /** Cache for function-constructor struct types */
  funcConstructorMap: Map<string, { structTypeIdx: number; ctorFuncName: string }>;
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
  /**
   * #1261 — module-wide worst-case eval tier (1=no eval … 5=direct sloppy).
   * Computed read-only by `classifyEvalTier`; downstream optimization gating
   * (#1262–#1265) consumes it. Optional because not every context constructs
   * from a full source file.
   */
  evalTier?: import("../eval-tiering.js").EvalTier;
}

export type { SourcePos };
