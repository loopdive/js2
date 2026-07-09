// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// AST → IR lowering.
//
// Phase 1 numeric/bool subset. The selector in `select.ts` restricts us to
// functions whose params are number/boolean, whose return type is
// number/boolean, and whose body is a "tail":
//   - zero or more `(let|const) <id> = <expr>;` declarations, followed by
//   - either `return <expr>;` OR `if (<expr>) <tail> else <tail>`,
//   - where each if-arm is itself a valid tail (terminates via return).
//
// `<expr>` may be:
//   - NumericLiteral / TrueKeyword / FalseKeyword
//   - Identifier referring to a parameter or a previously-declared local
//   - BinaryExpression with an arithmetic / comparison / logical operator
//   - PrefixUnaryExpression with `-`, `+`, `!`
//   - ConditionalExpression (`a ? b : c`)
//   - CallExpression to a locally-declared function (Phase 2)
//   - ParenthesizedExpression (unwrap)
//
// Everything else throws — the selector must keep those functions on the
// legacy path.
//
// Control flow is represented as basic blocks with `br_if` terminators. The
// entry block holds the pre-branch `let`/`const` decls; each if-arm is its
// own block (fork scope so declarations don't leak). Arms always terminate
// with `return` — Phase 1 doesn't model join blocks yet.
//
// Phase 2 extensions:
//   - Explicit TS `: number` / `: boolean` annotations are optional. When
//     absent, the caller passes `paramTypeOverrides` / `returnTypeOverride`
//     from the propagated TypeMap. This is what lets a recursive `fib`
//     whose `n` is untyped in source compile as `(f64) -> f64`.
//   - CallExpression to a local function lowers to `IrInstrCall`. The
//     call's return type comes from `callReturnTypes` (same TypeMap),
//     with arg types validated against the propagated callee param types.

import { ts, forEachChild } from "../ts-api.js";

import { FMOD_FN } from "../codegen/fmod.js"; // #2945 — `%` lowers to a call of the shared exact-fmod helper
import { evaluateConstantCondition } from "../codegen/statements/control-flow.js";
// #2766 — reuse the legacy counted-loop proof predicates (pure AST analysis, no
// codegen state) to port the `safeIndexedArrays` in-bounds proof into the IR.
import { isIncreasingStep, loopBodyMutatesIndexOrArray } from "../codegen/statements/loops.js";
import { IrFunctionBuilder } from "./builder.js";
import type { AllocSiteRegistry } from "./alloc-registry.js";
import {
  assertNotDeferred,
  binaryOpCapability,
  collectStringLiteralLens,
  hostExternCapability,
  prefixOpCapability,
  stringIndexProvenBelow,
} from "./capability.js";
import type { IrLowerResolver, IrVecLowering } from "./lower.js";
import { mathUnaryToIrOp } from "./select.js";
import { JsTag } from "../codegen/js-tag.js"; // #2949 S5.2 — box-refinement tags for dynamic equality operands
import {
  asVal,
  closureSignatureEquals,
  irDynamic,
  irTypeEquals,
  irVal,
  type IrBinop,
  type IrClassShape,
  type IrClosureSignature,
  type IrFunction,
  type IrInstr,
  type IrLabelId,
  type IrObjectShape,
  type IrType,
  type IrUnop,
  type IrValueId,
} from "./nodes.js";
import type { ValType } from "./types.js";

/**
 * Slice 10 (#1169i) — the from-ast view of one extern-class entry. Mirrors
 * `ExternClassInfo` from `src/codegen/context/types.ts` but limits the
 * surface to what the from-ast layer needs to validate `new ExternClass(...)`,
 * `recv.method(...)`, and property access on extern-class receivers.
 *
 * Methods carry the LEGACY-registered signature shape: `params[0]` is the
 * receiver `externref` and `params[1..]` are the user args. The from-ast
 * lowerer slices off the receiver when matching call args against
 * `params.slice(1)`. Slicing here keeps the from-ast logic dispatch-free.
 */
export interface IrExternClassMeta {
  readonly className: string;
  readonly constructorParams: readonly ValType[];
  readonly methods: ReadonlyMap<string, { readonly params: readonly ValType[]; readonly results: readonly ValType[] }>;
  readonly properties: ReadonlyMap<string, { readonly type: ValType; readonly readonly: boolean }>;
}

/**
 * Slice 6 part 4 refactor (#1185): a narrowed view of `IrLowerResolver`
 * restricted to the methods the AST→IR build phase actually consults.
 * Threading this subset through `LowerCtx` retires per-feature shortcuts
 * (`nativeStrings: boolean`, `anyStrTypeIdx: number`,
 * `inferVecElementValTypeFromContext`, etc.) without forcing the full
 * resolver — including its lazy struct registries that don't exist
 * yet at Phase-1 build time — into the from-ast layer.
 *
 * Phase-1 callable methods only:
 *   - `nativeStrings()` — backend mode discriminator
 *   - `resolveString()` — `IrType.string` ValType (extern vs native struct ref)
 *   - `resolveVec(valType)` — vec struct shape recovery
 *
 * Slice 10 (#1169i) adds:
 *   - `getExternClassInfo(name)` — extern-class metadata for slice-10
 *     lowering of `new ExternClass(...)`, `recv.method(...)`, and
 *     property access on extern-class receivers. Returns undefined if
 *     `name` isn't a registered extern class.
 *
 * The full `IrLowerResolver` (in `src/ir/lower.ts`) extends this and
 * adds Phase-3 methods like `resolveObject`, `resolveClass`,
 * `resolveClosure`. Those depend on registries that aren't populated
 * until Phase 3, so from-ast doesn't see them.
 */
export interface IrFromAstResolver {
  nativeStrings?(): boolean;
  resolveString?(): ValType;
  resolveVec?(valType: ValType): IrVecLowering | null;
  /**
   * #1804 — register-or-recover the vec struct for an element ValType so
   * `lowerArrayLiteral` can type a constructed `vec.new_fixed`'s result SSA
   * value as `{ kind: "ref", typeIdx: vecStructTypeIdx }`.
   */
  resolveVecForElement?(elementValType: ValType): IrVecLowering | null;
  /**
   * Slice 10 (#1169i) — return metadata for the named extern class, or
   * `undefined` if no such class is registered.
   */
  getExternClassInfo?(className: string): IrExternClassMeta | undefined;
  /**
   * #1375 narrow slice — TS-narrowing fast-path for optional chaining.
   * Returns `true` when the TypeScript type of `expr` is provably non-null
   * (i.e. `getNonNullableType(t) === t`). Used by `lowerPropertyAccess`
   * to skip the `?.`-on-nullable-receiver throw when TS has already
   * narrowed away null/undefined — the IR's `isIrTypeNullable` is more
   * conservative (treats `extern` as always nullable), so this gate
   * recovers a small set of well-typed `m?.x` cases where `m: Map<...>`
   * (no `| undefined`) is genuinely non-null at TS level.
   *
   * When unimplemented or returns `undefined`, `lowerPropertyAccess`
   * keeps the existing throw → legacy fallback.
   */
  isExpressionTsNonNullable?(expr: ts.Expression): boolean | undefined;
  /**
   * (#2856) Host-extern support — resolve a bare identifier to an ambient
   * host global registered by the legacy `collectDeclaredGlobals` pass
   * (`document` → `{ importName: "global_document", className: "Document" }`).
   * Returns `undefined` for anything that isn't a registered declared global.
   * In host-free modes (standalone/wasi/strictNoHostImports) the legacy pass
   * registers nothing, so this resolves nothing — the capability gate
   * (`hostExternCapability`) already made the selector defer those functions.
   */
  getHostGlobalInfo?(name: string): { importName: string; className: string } | undefined;
  /**
   * (#2856) True iff this compile targets a JS host. Feeds the
   * `hostExternCapability` invariant assert at the host-extern lowering
   * arms — a host-extern node reaching the builder in a host-free mode is a
   * selector↔capability drift, not a fallback.
   */
  jsHostExterns?(): boolean;
  /**
   * (#2856) Console-argument variant selection for `console.<m>(arg)` —
   * returns the import-name suffix (`console_<m>_<variant>`). MUST use the
   * same checker predicates as the legacy `collectConsoleImports` scan so
   * the variant the IR picks is the variant the scan registered.
   */
  consoleArgVariant?(arg: ts.Expression): "number" | "bool" | "string" | "externref";
  /**
   * (#2856) Resolve an extern-class member through the legacy inheritance
   * chain (`ctx.externClasses` + `ctx.externClassParent` — e.g. `appendChild`
   * on an `Element` receiver resolves on `Node`). `node`, when provided, is
   * the use-site AST node (the PropertyAccessExpression or its enclosing
   * CallExpression) — the resolver uses the checker's type AT THE USE SITE to
   * brand an externref-typed result with its extern class name
   * (`resultClassName`), which is what lets chained member access
   * (`document.body.appendChild(...)`, `e.style.cssText = ...`) dispatch.
   * Registration-time result types can't provide this (overloads collapse to
   * the first signature; generic returns have no symbol).
   */
  resolveExternMember?(
    className: string,
    memberName: string,
    kind: "method" | "property",
    node?: ts.Node,
  ):
    | {
        /** The registered import prefix — `${prefix}_${method}` / `${prefix}_get_${prop}`. */
        importPrefix: string;
        /** Method signature (params[0] = receiver externref), when kind = "method". */
        method?: { params: ValType[]; results: ValType[]; requiredParams: number };
        /** Property info, when kind = "property". */
        property?: { type: ValType; readonly: boolean };
        /** Extern class name of the RESULT when it is an externref-shaped host
         *  object (checker-derived at the use site); undefined otherwise. */
        resultClassName?: string;
      }
    | undefined;
  /**
   * (#2856 C2) True when `expr`'s checker type names a TypedArray-family
   * view (Uint8Array, Int16Array, Uint8ClampedArray, …, or a subarray
   * view). Element WRITES on those carry per-view conversion semantics
   * (ToUint8 / ToUint8Clamp / packed-storage truncation — see the legacy
   * `compileElementAssignment` view arms) that the plain vec store helper
   * must not bypass, so `lowerElementStore` demotes them to legacy.
   * Element READS are unaffected (value-identical to plain vec reads).
   */
  isTypedArrayViewExpr?(expr: ts.Expression): boolean;
  /**
   * (#2856 C3) Resolve a module-scope `const`/`let` binding to the Wasm
   * global (and optional TDZ flag global) the legacy backend allocated for
   * it, plus the extern-class brand of its value when the binding holds a
   * host object (e.g. `const cache = new Map()` → className "Map").
   * Returns `undefined` when the name isn't a registered module global or
   * its value isn't an externref-shaped extern-class instance.
   */
  getModuleScopeExternBinding?(name: string):
    | {
        /** Name of the value global in `ctx.mod.globals` (`__mod_<name>`). */
        globalName: string;
        /** Name of the i32 TDZ flag global, or null when TDZ was elided. */
        tdzGlobalName: string | null;
        /** Registered extern class of the held value (e.g. "Map"). */
        className: string;
      }
    | undefined;
}

export interface AstToIrOptions {
  readonly exported?: boolean;
  /**
   * #1370 Phase B: explicit name for the lowered function. Required for
   * MethodDeclaration (where `.name` is `PropertyName`, not Identifier)
   * and ConstructorDeclaration (which has no name node at all). For
   * top-level FunctionDeclaration this can be omitted; the caller's
   * `fn.name.text` is used as a fallback.
   */
  readonly funcName?: string;
  /**
   * #1370 Phase B: when set, the lowered function gets an implicit
   * `__self` parameter as its FIRST parameter, and `this` is bound in
   * the body's scope to that parameter's SSA value. Pass when lowering
   * an instance method — the legacy `class-bodies.ts` pre-allocates
   * instance method signatures as `[(ref $structTypeIdx), ...userParams]`
   * (see `class-bodies.ts:301`); the IR-lowered body must mirror that
   * layout exactly so existing legacy callers' `call $methodFuncIdx`
   * ops route to the correct typeIdx.
   *
   * The `IrType` should be `{ kind: "class"; shape }` so `this.field`
   * accesses resolve via `class.get` / `class.set` against the shape's
   * field list.
   *
   * Static methods don't get a `selfParam`; constructors don't either —
   * Phase C synthesises `struct.new + __self` inside the body.
   */
  readonly selfParam?: { readonly type: IrType };
  /**
   * #3000-C Phase C: set ONLY when lowering a `ConstructorDeclaration`. Names
   * the class the constructor builds. Unlike `selfParam` (an instance method's
   * caller-supplied `__self` FIRST param), a constructor is NOT passed `this` —
   * it ALLOCATES the instance. So when this is set the lowerer:
   *   - synthesises `this` = `class.alloc(shape)` (a fresh default-initialised
   *     struct) at body entry and binds it in scope,
   *   - forces the IR result type to `{ kind: "class"; shape }` (the ctor
   *     returns the constructed instance — `(ref $struct)`),
   *   - lowers the ctor body statements as plain (non-tail) statements, then
   *     synthesises the implicit `return this` epilogue.
   * Mutually exclusive with `selfParam`.
   */
  readonly constructorClassShape?: IrClassShape;
  /**
   * If present, overrides the IR types for the function's own parameters.
   * Indexed by parameter position. Used when the AST lacks explicit TS
   * type annotations and the Phase-2 propagation pass has inferred types.
   */
  readonly paramTypeOverrides?: readonly IrType[];
  /**
   * If present, overrides the IR return type. Same rationale as
   * `paramTypeOverrides`.
   *
   * Slice 14 (#1228) — null = void return (zero Wasm result types). The
   * IrFunctionBuilder is constructed with `[]` results and the lowerer
   * accepts bare `return;` and fall-through tails.
   */
  readonly returnTypeOverride?: IrType | null;
  /**
   * Map from callee function name to that callee's IR types (param +
   * return). Consulted when lowering a CallExpression whose callee is a
   * local function. Missing entries cause the lowerer to throw — the
   * selector's call-graph closure should guarantee every call we reach
   * has an entry.
   *
   * Slice 14 (#1228) — `returnType: IrType | null`. Null means a void
   * callee — calls in expression position (`x = f();`) are spec-illegal
   * for void; calls in statement position (`f();`) are fine.
   */
  readonly calleeTypes?: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType | null }>;
  /**
   * Slice 4 (#1169d): map from class name to that class's IR shape
   * (fields + methods + constructor signature). Consulted when lowering
   * NewExpression / class-receiver PropertyAccess / class-receiver
   * method calls. Missing entries cause the relevant lowering case to
   * throw, falling back to legacy.
   */
  readonly classShapes?: ReadonlyMap<string, IrClassShape>;
  /**
   * Slice 6 part 4 refactor (#1185): the from-ast view of the IR
   * lowerer's resolver. Replaces the per-feature shortcuts that
   * #1181 / #1182 / #1183 each added (`nativeStrings`,
   * `anyStrTypeIdx`, `inferVecElementValTypeFromContext`).
   *
   * Optional so existing tests / callers that don't need string or
   * vec type resolution can keep working. The `lowerForOfStatement`
   * arms that DO need it (string + vec) throw a clean fall-back-to-
   * legacy error when the resolver is absent or returns `null`.
   *
   * The integration layer (`compileIrPathFunctions`) is the canonical
   * supplier — it builds the resolver (or its subset) eagerly and
   * passes it in.
   */
  readonly resolver?: IrFromAstResolver;
  /** Optional-chain nullability check (#1281). When absent, `?.` / `?.()` throw to legacy. */
  readonly checker?: ts.TypeChecker;
  /**
   * #1586: module-global allocation-site registry. When supplied, the builder
   * mints a stable `AllocSiteId` for every value-creating instr (object.new,
   * closure.new, string.const, …). Optional — when absent, `alloc` fields stay
   * unset, which is inert at lowering (byte-identical output).
   */
  readonly allocRegistry?: AllocSiteRegistry;
}

/**
 * Slice 3 (#1169c): lowering an outer function may produce additional
 * lifted IR functions (one per nested function declaration / closure
 * expression). The integration layer treats these as synthesized
 * BuiltFns that get fresh funcIdx slots.
 */
export interface LoweredFunctionResult {
  readonly main: IrFunction;
  readonly lifted: readonly IrFunction[];
}

export function lowerFunctionAstToIr(
  fn:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    // #3000-B: get/set accessors lower as no-arg / one-arg instance members
    // over the (now-supported) private slot. A getter behaves like a no-param
    // method whose return type is `fn.type`; a setter behaves like a one-param
    // VOID method (setters carry no source-level return type).
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
  options: AstToIrOptions = {},
): LoweredFunctionResult {
  // #1370 Phase B: name resolution.
  //
  // FunctionDeclaration: prefer `fn.name.text`, fall back to options.funcName.
  // MethodDeclaration: use options.funcName (its `.name` is PropertyName).
  // ConstructorDeclaration: use options.funcName (no `.name` node).
  const astName = ts.isFunctionDeclaration(fn) ? fn.name?.text : undefined;
  const name = options.funcName ?? astName;
  if (!name) {
    throw new Error("ir/from-ast: function declaration without a name (and no options.funcName supplied)");
  }
  if (!fn.body) {
    throw new Error(`ir/from-ast: function ${name} has no body`);
  }

  // #1370 Phase B: ConstructorDeclaration has no `asteriskToken` field,
  // and a method/function may have one. Type-narrow before access.
  const isGenerator = (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && !!fn.asteriskToken;

  // #3000-C Phase C: constructor-body lowering. A ConstructorDeclaration has
  // no `.type` (its return type is implicit — the constructed instance). The
  // integration walk supplies `options.constructorClassShape`; the lowerer
  // allocates `this`, runs the body, and returns the instance (see the
  // `isCtor` branch below). Without the shape we can't form the class-typed
  // return / `this`, so reject to legacy (defensive — the integration walk
  // always supplies it).
  const isCtor = ts.isConstructorDeclaration(fn);
  if (isCtor && !options.constructorClassShape) {
    throw new Error(`ir/from-ast: constructor lowering requires options.constructorClassShape (${name})`);
  }

  // Slice 7a (#1169f): `function*` produces a Generator-like externref
  // regardless of the source-level return type annotation
  // (`Generator<number>`, `IterableIterator<T>`, etc.). The IR result
  // type is unconditionally `externref`; the source annotation is
  // ignored at the IR layer.
  //
  // Slice 14 (#1228) — `void` return: `returnTypeOverride === null` AND
  // `fn.type?.kind === VoidKeyword` indicates a void-returning function.
  // The IR builder is constructed with `[]` results; lowerTail accepts
  // bare `return;` / fall-through tails.
  const isVoidReturn =
    !isGenerator &&
    !isCtor &&
    // #3000-B: a set accessor is inherently void (no source-level return type);
    // treat it as void even if the caller forgot the explicit override.
    (ts.isSetAccessorDeclaration(fn) ||
      options.returnTypeOverride === null ||
      (options.returnTypeOverride === undefined && fn.type?.kind === ts.SyntaxKind.VoidKeyword));
  const returnType: IrType | null = isGenerator
    ? irVal({ kind: "externref" })
    : // #3000-C: a constructor returns the constructed instance — `(ref $struct)`.
      isCtor
      ? ({ kind: "class", shape: options.constructorClassShape! } as IrType)
      : isVoidReturn
        ? null
        : resolveIrType(fn.type, options.returnTypeOverride ?? undefined, `return type of ${name}`);
  // #1372 — binding-pattern params: synthesize a stable internal name
  // (`__pattern_param_<idx>`) so the IR `addParam` machinery has a regular
  // identifier to bind, then emit destructuring reads (object.get / vec.get
  // / class.get) into the function body as a preamble. Identifier params
  // pass through unchanged.
  const params: { name: string; type: IrType }[] = fn.parameters.map((p, idx) => {
    const override = options.paramTypeOverrides?.[idx];
    if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
      return {
        name: `__pattern_param_${idx}`,
        type: resolveIrType(p.type, override, `pattern param #${idx} of ${name}`),
      };
    }
    if (!ts.isIdentifier(p.name)) {
      throw new Error(`ir/from-ast: unsupported param shape in Phase 1 (${name})`);
    }
    // #2713 — rest (`...args`), default (`x = 5`) and optional (`x?`) params
    // keep an Identifier name and so slip this gate, after which their
    // arity/defaulting semantics are dropped (a regression against #1372).
    // The top-level selector already rejects them (`select.ts` →
    // param-shape-rejected); mirror that here so nested function declarations
    // lowered through this path demote cleanly to legacy rather than
    // miscompiling. (No-op for top-level claimed functions — the selector has
    // already filtered these out.)
    if (p.questionToken || p.dotDotDotToken || p.initializer) {
      throw new Error(`ir/from-ast: rest/default/optional param not in Phase 1 IR scope (${name})`);
    }
    return {
      name: p.name.text,
      type: resolveIrType(p.type, override, `param ${p.name.text} of ${name}`),
    };
  });

  // Slice 14 (#1228) — void functions have zero result types; pass `[]`.
  const builder = new IrFunctionBuilder(
    name,
    returnType === null ? [] : [returnType],
    options.exported ?? false,
    options.allocRegistry,
  );

  // Single scope map for both params and let/const locals. Phase 1 forbids
  // shadowing (enforced by the selector) so there is no nesting to track.
  const scope = new Map<string, ScopeBinding>();
  // #1370 Phase B: synthetic `__self` for instance methods. Must be added
  // FIRST so its SSA index matches the legacy `local 0` slot the
  // pre-allocated typeIdx expects (see `class-bodies.ts:301`). `this` is
  // bound in scope to this SSA value; subsequent `this.field` /
  // `this.method()` accesses route through the existing class.get /
  // class.set / class.method lowerings (slice 4 #1169d).
  if (options.selfParam) {
    const selfV = builder.addParam("__self", options.selfParam.type);
    scope.set("this", { kind: "local", value: selfV, type: options.selfParam.type });
  }
  // #1372 — track binding-pattern params + their SSA values for the post-
  // openBlock destructure preamble.
  const pendingDestructures: { pattern: ts.BindingPattern; value: IrValueId }[] = [];
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    const astParam = fn.parameters[i]!;
    const v = builder.addParam(p.name, p.type);
    if (ts.isObjectBindingPattern(astParam.name) || ts.isArrayBindingPattern(astParam.name)) {
      // Don't bind the synthesized __pattern_param_N name in user-visible
      // scope — leaf names will be bound below by lowerBindingPattern.
      pendingDestructures.push({ pattern: astParam.name, value: v });
      continue;
    }
    scope.set(p.name, { kind: "local", value: v, type: p.type });
  }

  builder.openBlock();

  // Slice 7a (#1169f): generator prologue — allocate the `__gen_buffer`
  // Wasm-local slot, initialize it via `__gen_create_buffer()`. Must
  // happen AFTER `openBlock()` (instrs require a current block) and
  // BEFORE user-body lowering so `lowerYield` can emit `gen.push`
  // against the slot. The lowerer reads `func.generatorBufferSlot` to
  // produce the `local.get $__gen_buffer` op.
  let generatorBufferSlot: number | undefined;
  if (isGenerator) {
    builder.setFuncKind("generator");
    generatorBufferSlot = builder.declareSlot("__gen_buffer", { kind: "externref" });
    builder.setGeneratorBufferSlot(generatorBufferSlot);
    const buf = builder.emitCall({ kind: "func", name: "__gen_create_buffer" }, [], irVal({ kind: "externref" }));
    if (buf === null) {
      throw new Error(`ir/from-ast: __gen_create_buffer call must produce a value (${name})`);
    }
    builder.emitSlotWrite(generatorBufferSlot, buf);
  }

  const stmts = fn.body.statements;
  // #3000-C: an empty constructor body (`constructor() {}`) is valid — it just
  // allocates + returns `this`. Only non-ctor Phase-1 functions require ≥1
  // statement (their body must produce a return/tail).
  if (!isCtor && stmts.length < 1) {
    throw new Error(`ir/from-ast: Phase 1 expects at least 1 statement in ${name}`);
  }

  const lifted: IrFunction[] = [];
  const liftedCounter = { value: 0 };
  const mutatedLets = collectMutatedLetNames(fn);
  const cx: LowerCtx = {
    builder,
    scope,
    funcName: name,
    returnType,
    calleeTypes: options.calleeTypes,
    classShapes: options.classShapes,
    resolver: options.resolver,
    lifted,
    liftedCounter,
    mutatedLets,
    // (#2972) statically-known literal string lengths — proven-in-bounds
    // string element reads (`hex[(n >> 4) & 0xf]`) consult this.
    stringLiteralLens: collectStringLiteralLens(fn),
    funcKind: isGenerator ? "generator" : "regular",
    generatorBufferSlot,
    checker: options.checker,
    allocRegistry: options.allocRegistry,
  };
  // #1372 — emit destructuring preamble for binding-pattern params. Each
  // leaf becomes a `local` ScopeBinding via `lowerBindingPattern`; the
  // user-body code then sees the leaf identifiers as regular locals.
  // Emitted AFTER cx is built (lowerObjectPattern/lowerArrayPattern need
  // `cx.scope`/`cx.builder`) but BEFORE `lowerStatementList(stmts, cx)`
  // so the body sees the leaves in scope from statement #0.
  for (const { pattern, value } of pendingDestructures) {
    lowerBindingPattern(pattern, value, cx);
  }

  if (isCtor) {
    // #3000-C Phase C: synthesise `this` = a freshly-allocated, default-
    // initialised instance (NO ctor call — that would recurse into the very
    // `<className>_new` function we are compiling). Bind it so the body's
    // `this.field = …` writes route through `class.set` / `class.get`.
    const shape = options.constructorClassShape!;
    const thisType: IrType = { kind: "class", shape };
    const thisV = builder.emitClassAlloc(shape);
    scope.set("this", { kind: "local", value: thisV, type: thisType });
    // Constructor body statements are plain (non-tail) statements — the
    // return is the implicit `return this`, not any body statement. Lower
    // each via the body-statement dispatcher (the SAME shapes the selector's
    // `isPhase1BodyStatement` admits), then synthesise the epilogue.
    for (const s of stmts) {
      lowerStmt(s, cx);
      // A break/continue can't appear at ctor-body top level (no enclosing
      // loop) — the selector rejects it — so no dead-code guard is needed.
    }
    builder.terminate({ kind: "return", values: [thisV] });
    return { main: builder.finish(), lifted };
  }

  lowerStatementList(stmts, cx);

  return { main: builder.finish(), lifted };
}

/**
 * Does `stmt` unconditionally terminate its control flow (return / throw, or a
 * block / if-else whose every path does)? Used by the mid-body `if (cond)
 * <then>; <rest>` rewrite: the "early-return" structural reinterpretation
 * (`if (cond) <then> else { <rest> }`) is only sound when the then-arm
 * terminates — otherwise `<rest>` must still run after a true-branch
 * side effect. (#1979)
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

function lowerStatementList(stmts: readonly ts.Statement[], cx: LowerCtx): void {
  if (stmts.length < 1) {
    throw new Error(`ir/from-ast: empty statement list in ${cx.funcName}`);
  }
  for (let i = 0; i < stmts.length - 1; i++) {
    const s = stmts[i]!;
    if (ts.isVariableStatement(s)) {
      lowerVarDecl(s, cx);
      continue;
    }
    // Slice 3 (#1169c): nested function declaration. Adds a
    // `nestedFunc` scope binding and lifts the body to a top-level IR
    // function in `cx.lifted`.
    if (ts.isFunctionDeclaration(s)) {
      lowerNestedFunctionDeclaration(s, cx);
      continue;
    }
    // Slice 3 (#1169c): bare call expression statement — lower the
    // call, drop the result. Lets `inc(); inc(); inc();` work.
    //
    // Slice 4 (#1169d): also accept `<obj>.<field> = <expr>;` — lowered
    // as `class.set` or `object.set` based on the receiver's IrType.
    if (ts.isExpressionStatement(s)) {
      if (ts.isCallExpression(s.expression)) {
        // (#2856) Method-shaped statement calls go through lowerMethodCall
        // in STATEMENT position so void extern/console methods are legal
        // (`host.appendChild(box);`, `console.log("…");`). Expression
        // position keeps throwing on void — only this flag differs.
        if (ts.isPropertyAccessExpression(s.expression.expression) && !s.expression.questionDotToken) {
          void lowerMethodCall(s.expression, cx, /* statementPosition */ true);
          continue;
        }
        // The result SSA value is unused; DCE strips it if pure.
        // closure.call and call are flagged side-effecting in dead-code
        // so they stay live. (#2856 C4) Statement position — a VOID direct
        // call (`quicksort(arr, lo, p - 1);`) is legal here.
        void lowerCall(s.expression, cx, /* statementPosition */ true);
        continue;
      }
      // Slice 7a (#1169f): `yield <expr>;` as a top-level statement.
      // Selected only inside `function*` (the selector enforces this
      // at the function-claim level; if a non-generator function
      // somehow surfaces a yield here, `lowerYield` throws).
      if (ts.isYieldExpression(s.expression)) {
        lowerYield(s.expression, cx);
        continue;
      }
      if (
        ts.isBinaryExpression(s.expression) &&
        s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(s.expression.left)
      ) {
        lowerPropertyAssignment(s.expression, cx);
        continue;
      }
      // (#2856 C2) element store `arr[i] = v;` as a non-tail statement —
      // quicksort's post-partition swap writes live here (outside any loop).
      if (
        ts.isBinaryExpression(s.expression) &&
        s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isElementAccessExpression(s.expression.left)
      ) {
        lowerElementStore(s.expression.left, s.expression.right, cx);
        continue;
      }
      throw new Error(`ir/from-ast: unsupported ExpressionStatement shape in ${cx.funcName}`);
    }
    // Slice 6 part 2 (#1181): for-of statement (always non-tail). The
    // body is shape-checked by `isPhase1ForOf` and lowered via a
    // separate `lowerStmt` body-statement dispatcher (no nested
    // closures, no nested function decls).
    if (ts.isForOfStatement(s)) {
      lowerForOfStatement(s, cx);
      continue;
    }
    // Slice 12 (#1280): generic structured `while (cond) body` and
    // `for (init; cond; update) body` loops. Both lower to a
    // declarative `{while,for}.loop` IR instr which the lowerer
    // emits as `block { loop { <cond>; i32.eqz; br_if 1; <body>;
    // <update?>; br 0 } }`.
    if (ts.isWhileStatement(s)) {
      lowerWhileStatement(s, cx);
      continue;
    }
    if (ts.isForStatement(s)) {
      lowerForStatement(s, cx);
      continue;
    }
    // #2952 slice 1: `do { body } while (cond)` (post-test loop).
    if (ts.isDoStatement(s)) {
      lowerDoStatement(s, cx);
      continue;
    }
    // Slice 9 (#1169h): throw / try as a non-tail statement.
    if (ts.isThrowStatement(s)) {
      lowerThrowStatement(s, cx);
      continue;
    }
    if (ts.isTryStatement(s)) {
      lowerTryStatement(s, cx);
      continue;
    }
    // Phase 2: early-return `if` with no else + subsequent statements.
    // Structurally: `if (cond) <tail>; <rest>` ≡ `if (cond) <tail> else { <rest> }`.
    // The then-arm lowers to its own block that terminates in `return`
    // (lowerTail enforces that); the else-arm opens a reserved block and
    // recursively lowers the remaining statements.
    if (ts.isIfStatement(s) && !s.elseStatement) {
      // Whether the then-arm unconditionally terminates decides the shape:
      // a terminating then-arm permits the early-return rewrite
      // (`if (cond) <tail> else { <rest> }`); a non-terminating one is just a
      // side-effecting guard and `<rest>` must run afterwards either way. (#1979)
      const terminates = thenArmTerminates(s.thenStatement);

      // #1043: compile-time constant fold. After --define substitution of
      // process.env.NODE_ENV (etc.), the condition may be a literal-vs-literal
      // comparison. Skip the dead arm so dev-only code never reaches codegen.
      const constResult = evaluateConstantCondition(s.expression);
      if (constResult !== undefined) {
        if (constResult) {
          if (terminates) {
            // Then-arm taken and terminating: the rest is unreachable, stop.
            lowerTail(s.thenStatement, { ...cx, scope: new Map(cx.scope) });
            return;
          }
          // Then-arm taken but non-terminating: run its side effects, then
          // fall through to the rest in the same block / scope.
          lowerStmt(s.thenStatement, { ...cx, scope: new Map(cx.scope) });
          continue;
        }
        // Then-arm dead: skip it and continue with the remaining statements
        // in the same block / scope.
        continue;
      }
      const cond = lowerExpr(s.expression, cx, irVal({ kind: "i32" }));
      const condType = cx.builder.typeOf(cond);
      if (asVal(condType)?.kind !== "i32") {
        throw new Error(`ir/from-ast: if condition must be bool in ${cx.funcName}`);
      }
      const rest = stmts.slice(i + 1);

      if (terminates) {
        // Early-return rewrite: `if (cond) <tail> else { <rest> }`.
        const thenId = cx.builder.reserveBlockId();
        const elseId = cx.builder.reserveBlockId();
        cx.builder.terminate({
          kind: "br_if",
          condition: cond,
          ifTrue: { target: thenId, args: [] },
          ifFalse: { target: elseId, args: [] },
        });

        cx.builder.openReservedBlock(thenId);
        lowerTail(s.thenStatement, { ...cx, scope: new Map(cx.scope) });

        cx.builder.openReservedBlock(elseId);
        lowerStatementList(rest, { ...cx, scope: new Map(cx.scope) });
        return;
      }

      // Non-terminating then-arm: emit a converging guard. Both the then-block
      // (after its side effect) and the false branch fall through to a shared
      // continuation block holding `<rest>`. (#1979)
      const thenId = cx.builder.reserveBlockId();
      const contId = cx.builder.reserveBlockId();
      cx.builder.terminate({
        kind: "br_if",
        condition: cond,
        ifTrue: { target: thenId, args: [] },
        ifFalse: { target: contId, args: [] },
      });

      cx.builder.openReservedBlock(thenId);
      lowerStmt(s.thenStatement, { ...cx, scope: new Map(cx.scope) });
      cx.builder.terminate({ kind: "br", branch: { target: contId, args: [] } });

      cx.builder.openReservedBlock(contId);
      if (rest.length === 0) {
        // No trailing statements — the function's implicit void return.
        cx.builder.terminate({ kind: "return", values: [] });
      } else {
        lowerStatementList(rest, { ...cx, scope: new Map(cx.scope) });
      }
      return;
    }
    throw new Error(`ir/from-ast: unexpected statement before tail (got ${ts.SyntaxKind[s.kind]} in ${cx.funcName})`);
  }
  lowerTail(stmts[stmts.length - 1]!, cx);
}

/**
 * Lower a "tail" statement — one that must end in a return on every path.
 * Phase 1 tails are: `return <expr>;`, a `Block { ... }` whose own tail is a
 * tail, or `if (<cond>) <tail> else <tail>`.
 */
function lowerTail(stmt: ts.Statement, cx: LowerCtx): void {
  if (ts.isReturnStatement(stmt)) {
    // Slice 7a/7b (#1169f): generator return. Match the legacy semantics
    // (`compileReturnStatement` in `codegen/statements/control-flow.ts`
    // line 89-123): a `return <value>` inside a `function*` pushes
    // `<value>` onto the eager buffer as a final yielded value, then
    // wraps the buffer with `__create_generator` to produce the
    // externref Generator object. This is non-spec — JS spec says the
    // return value lands in `IteratorResult.value` with `done:true` —
    // but matching legacy is the correctness target so existing
    // test262 coverage doesn't drift.
    //
    // Slice 7b widens the return type: we accept any Phase-1 expression
    // and route it through the same `lowerYield`-style dispatch
    // (f64/i32 stay native; ref/string/object/class coerce to
    // externref → __gen_push_ref). Same dispatch logic as `lowerYield`
    // except we get a `ts.Expression` already, not a YieldExpression.
    if (cx.funcKind === "generator") {
      // #2951: a generator's `return <value>` value belongs ONLY to the
      // terminal `{value, done:true}` IteratorResult — it must NOT be pushed
      // into the eager yield buffer (where spread / for-of / Array.from would
      // surface it as a yielded `done:false` element). The legacy return path
      // (`compileReturnStatement` in `codegen/statements/control-flow.ts:144`)
      // routes the value through `__gen_set_return`, which stashes it on the
      // buffer as a side property for the host drain to emit once with
      // `done:true`. We now mirror that here via `gen.setReturn`: lower the
      // value through the SAME dispatch `lowerYield` uses (f64 / i32 stay
      // native; reference-shaped values coerce to externref), then emit
      // `gen.setReturn` — the lowerer BOXES the value to externref (f64 →
      // `__box_number`, and if the box helper is unresolvable it THROWS to
      // defer to legacy). Finally the epilogue wraps the buffer with
      // `__create_generator`. Bare `return;` (no value) has nothing to stash
      // and skips straight to the epilogue.
      if (stmt.expression) {
        // Same advisory-externref hint + `typeOf`-driven dispatch as
        // `lowerYield`: numeric / bool returns keep their native f64 / i32
        // representation (the `gen.setReturn` lowerer boxes them); every
        // reference-shaped value is coerced to externref upstream so the
        // lowerer's `externref → pass-through` arm sees the right Wasm type.
        const value = lowerExpr(stmt.expression, cx, irVal({ kind: "externref" }));
        const valTy = asVal(cx.builder.typeOf(value));
        if (valTy?.kind === "f64" || valTy?.kind === "i32") {
          cx.builder.emitGenSetReturn(value);
        } else {
          cx.builder.emitGenSetReturn(coerceYieldValueToExternref(value, cx));
        }
      }
      const generatorObj = cx.builder.emitGenEpilogue();
      cx.builder.terminate({ kind: "return", values: [generatorObj] });
      return;
    }
    // Slice 14 (#1228): void function — bare `return;` or `return expr;`
    // (the value is discarded). Terminate with empty values.
    if (cx.returnType === null) {
      if (stmt.expression) {
        // Lower for side effects but discard the value.
        lowerExpr(stmt.expression, cx, irVal({ kind: "externref" }));
      }
      cx.builder.terminate({ kind: "return", values: [] });
      return;
    }
    if (!stmt.expression) {
      throw new Error(`ir/from-ast: Phase 1 return must have an expression in ${cx.funcName}`);
    }
    const v = lowerExpr(stmt.expression, cx, cx.returnType);
    const vCoerced = coerceReturnValue(v, cx);
    cx.builder.terminate({ kind: "return", values: [vCoerced] });
    return;
  }
  // Slice 14 (#1228) — void function tail: any non-return statement that
  // doesn't terminate the function falls through to an implicit return.
  // We accept ExpressionStatement (e.g., `f();`) as a tail in void
  // functions and synthesize the implicit return.
  if (cx.returnType === null && ts.isExpressionStatement(stmt)) {
    // (#2856) Method-shaped tail call in a void function — statement
    // position, so void extern/console methods are legal here too.
    if (
      ts.isCallExpression(stmt.expression) &&
      ts.isPropertyAccessExpression(stmt.expression.expression) &&
      !stmt.expression.questionDotToken
    ) {
      void lowerMethodCall(stmt.expression, cx, /* statementPosition */ true);
      cx.builder.terminate({ kind: "return", values: [] });
      return;
    }
    // (#2856 C4) Direct-call tail in a void function — `quicksort(arr, p +
    // 1, hi);` as the last statement. Statement position, so a void callee
    // is legal.
    if (ts.isCallExpression(stmt.expression) && ts.isIdentifier(stmt.expression.expression)) {
      void lowerCall(stmt.expression, cx, /* statementPosition */ true);
      cx.builder.terminate({ kind: "return", values: [] });
      return;
    }
    // #3000-B: property-store assignment as a void tail — the SET accessor
    // body shape `set name(v) { this.#name = v; }`. Route through the SAME
    // `lowerPropertyAssignment` the non-tail statement path uses (see
    // `lowerStatementList`), so a setter's lone assignment produces bytes
    // identical to the mid-body case, then synthesize the implicit return.
    if (
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(stmt.expression.left)
    ) {
      lowerPropertyAssignment(stmt.expression, cx);
      cx.builder.terminate({ kind: "return", values: [] });
      return;
    }
    // #3000-B: element-store assignment as a void tail (`arr[i] = v;` as the
    // final statement of a void function) — mirror the non-tail element-store
    // arm for select↔build parity.
    if (
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(stmt.expression.left)
    ) {
      lowerElementStore(stmt.expression.left, stmt.expression.right, cx);
      cx.builder.terminate({ kind: "return", values: [] });
      return;
    }
    // Lower the expression for side effects, discard the value.
    lowerExpr(stmt.expression, cx, irVal({ kind: "externref" }));
    cx.builder.terminate({ kind: "return", values: [] });
    return;
  }
  if (ts.isBlock(stmt)) {
    // Fork scope — declarations inside the block stay local to this arm.
    const childCx: LowerCtx = { ...cx, scope: new Map(cx.scope) };
    lowerStatementList(stmt.statements, childCx);
    return;
  }
  // Slice 9 (#1169h): `throw <expr>;` at function tail. The throw
  // terminates the function abruptly — no return is reached. We lower
  // the throw and terminate the current block with `unreachable` so the
  // verifier and lowerer treat it as a stop.
  if (ts.isThrowStatement(stmt)) {
    lowerThrowStatement(stmt, cx);
    cx.builder.terminate({ kind: "unreachable" });
    return;
  }
  if (ts.isIfStatement(stmt)) {
    if (!stmt.elseStatement) {
      throw new Error(`ir/from-ast: Phase 1 if must have an else arm in ${cx.funcName}`);
    }
    // #1043: compile-time constant fold. After --define substitution of
    // process.env.NODE_ENV (etc.), the condition may be a literal-vs-literal
    // comparison. Lower only the live arm so dev-only code never reaches codegen.
    const constResult = evaluateConstantCondition(stmt.expression);
    if (constResult !== undefined) {
      const taken = constResult ? stmt.thenStatement : stmt.elseStatement;
      lowerTail(taken, { ...cx, scope: new Map(cx.scope) });
      return;
    }
    const cond = lowerExpr(stmt.expression, cx, irVal({ kind: "i32" }));
    const condType = cx.builder.typeOf(cond);
    if (asVal(condType)?.kind !== "i32") {
      throw new Error(`ir/from-ast: if condition must be bool in ${cx.funcName}`);
    }
    // Reserve block IDs for both arms BEFORE terminating the current block.
    // The else ID must be fixed when we emit br_if, even though it opens after
    // any nested blocks the then-arm allocates.
    const thenId = cx.builder.reserveBlockId();
    const elseId = cx.builder.reserveBlockId();
    cx.builder.terminate({
      kind: "br_if",
      condition: cond,
      ifTrue: { target: thenId, args: [] },
      ifFalse: { target: elseId, args: [] },
    });

    cx.builder.openReservedBlock(thenId);
    lowerTail(stmt.thenStatement, { ...cx, scope: new Map(cx.scope) });

    cx.builder.openReservedBlock(elseId);
    lowerTail(stmt.elseStatement, { ...cx, scope: new Map(cx.scope) });
    return;
  }
  throw new Error(`ir/from-ast: unsupported tail statement ${ts.SyntaxKind[stmt.kind]} in ${cx.funcName}`);
}

/**
 * Slice 3 (#1169c): scope bindings carry a "kind" so call-site lowering
 * knows how to dispatch.
 *
 *   - `local`: params, let/const primitives, locally-built objects, and
 *     closures stored as values (the closure case sets `type` to
 *     `IrType.closure`). Reads emit `local.get`; if the type is `boxed`
 *     (ref cell), reads dereference via `refcell.get`.
 *   - `nestedFunc`: name-only binding for `function inner() {...}`.
 *     Calls expand into prepended-capture-args + direct call (matches
 *     the legacy `compileNestedFunctionDeclaration` pattern).
 *
 * Slice 6 (#1169e):
 *   - `slot`: a Wasm-local slot that survives across iterations of a
 *     for-of loop. Used for the loop variable AND for outer-scope `let`
 *     bindings that are mutated inside the loop body. Reads emit
 *     `slot.read`; writes emit `slot.write`. Once a name is bound as a
 *     slot, all subsequent reads/writes (including AFTER the for-of)
 *     route through the slot — this preserves the cross-iteration value
 *     semantics without requiring SSA phi nodes.
 */
type ScopeBinding =
  | { kind: "local"; value: IrValueId; type: IrType }
  | {
      kind: "nestedFunc";
      liftedName: string;
      signature: IrClosureSignature;
      captures: readonly NestedCapture[];
    }
  | {
      kind: "slot";
      slotIndex: number;
      /**
       * The slot's IR type as the binding sees it. For most slots this
       * equals the underlying Wasm-local type (e.g. `irVal({ kind:
       * "f64" })` for a numeric slot). For string-loop variables in
       * native-strings mode, this is `IrType.string` while the
       * underlying slot is `(ref $AnyString)` — see `asType` below.
       */
      type: IrType;
      /**
       * Slice 6 part 4 refactor (#1185): optional widening for
       * identifier reads. When present, the SSA result of a `slot.read`
       * against this binding is re-tagged to `asType` instead of
       * `irVal(slot.type)`. Used for native-strings string for-of
       * where the slot ValType is `(ref $AnyString)` but the loop
       * variable should compose with slice-1 string ops as
       * `IrType.string`.
       *
       * The Wasm-level value is identical between `slot.type` and
       * `asType` — `IrType.string` lowers to `(ref $AnyString)` in
       * native mode — so this is purely a type-system rewrite.
       */
      asType?: IrType;
    };

/**
 * Slice 3 (#1169c): one entry in a closure / nested-function's capture
 * set. `outerValue` is the SSA value the call-site uses to materialize
 * the capture argument; for mutable captures, the call-site wraps it
 * in a refcell on first use (rebinding `cx.scope` in-place so
 * subsequent outer reads/writes go through the cell).
 */
interface NestedCapture {
  readonly name: string;
  readonly type: IrType;
  readonly mutable: boolean;
  readonly outerValue: IrValueId;
}

interface LowerCtx {
  readonly builder: IrFunctionBuilder;
  readonly scope: Map<string, ScopeBinding>;
  readonly funcName: string;
  // Slice 14 (#1228) — `null` means the enclosing function is void.
  // `lowerTail` checks this to accept bare `return;` / fall-through tails.
  readonly returnType: IrType | null;
  readonly calleeTypes?: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType | null }>;
  /** Slice 4 (#1169d) — class shape registry, keyed by className. */
  readonly classShapes?: ReadonlyMap<string, IrClassShape>;
  /**
   * Slice 6 part 4 refactor (#1185) — from-ast view of the IR
   * resolver. Drives:
   *   - the string for-of strategy switch (`nativeStrings()`)
   *   - native-strings slot ValTypes (`resolveString()`)
   *   - vec element / data-array ValType inference (`resolveVec()`)
   *
   * Replaces the per-feature `nativeStrings: boolean` and
   * `anyStrTypeIdx: number` fields that #1183 added. Optional so
   * legacy callers (and tests) without resolver support work; the
   * for-of arms that need it throw a clean fall-back-to-legacy
   * error when it's absent.
   */
  readonly resolver?: IrFromAstResolver;
  /** Slice 3 — output bin for lifted closures / nested funcs. */
  readonly lifted: IrFunction[];
  /** Slice 3 — mutable counter for synthesizing lifted-func names. */
  readonly liftedCounter: { value: number };
  /**
   * Slice 6 part 2 (#1181) — names of `let` bindings that are mutated
   * somewhere in the function body (assignments via `=`, `+=`, `-=`,
   * `*=`, `/=`, or pre/postfix `++`/`--`). Mutated lets bind as a
   * `slot` ScopeBinding instead of `local` so cross-iteration writes
   * propagate correctly. Computed once per outer function in
   * `lowerFunctionAstToIr` via `collectMutatedLetNames`.
   */
  readonly mutatedLets: ReadonlySet<string>;
  /**
   * (#2972) Locals bound once to a string literal and never reassigned
   * (incl. nested-function writes) → the literal's code-unit length. Feeds
   * the proven-in-bounds string element read in `lowerElementAccess`.
   * Populated for the OUTER function only; nested/lifted contexts omit it
   * (shadowing across closure scopes would make the fact unsound there).
   */
  readonly stringLiteralLens?: ReadonlyMap<string, number>;
  /**
   * Slice 7a (#1169f): kind of function being lowered. `lowerYield`
   * checks this to refuse `yield` outside generators (defensive — the
   * selector should already have rejected the function). `lowerTail`
   * uses it to rewrite `return <expr>;` as a `gen.epilogue` + return
   * the externref Generator object, since a generator's IR-level
   * return type is externref regardless of source-level annotation.
   */
  readonly funcKind: "regular" | "generator" | "async";
  /**
   * Slice 7a (#1169f): for `funcKind === "generator"` only — the slot
   * index of the `__gen_buffer` Wasm-local. Reserved by the prologue
   * in `lowerFunctionAstToIr`. `lowerYield` reads this when emitting
   * `gen.push`; `lowerTail` reads it when emitting `gen.epilogue`.
   */
  readonly generatorBufferSlot?: number;
  /** Optional-chain nullability check (#1281). When absent, `?.` / `?.()` throw to legacy. */
  readonly checker?: ts.TypeChecker;
  /**
   * #1586: module-global allocation-site registry, threaded so lifted-closure
   * builders mint stable ids on the same registry as the outer function.
   */
  readonly allocRegistry?: AllocSiteRegistry;
  /**
   * #2766 — counted-loop in-bounds proof, ported from legacy
   * `fctx.safeIndexedArrays`. Holds `"arrayVar:indexVar"` pairs proven
   * `0 <= index < array.length` for the *current loop body* (a fresh set is
   * threaded onto the body cx by `lowerForStatement`, so it naturally scopes to
   * the loop and accumulates outward through nested loops). `lowerElementAccess`
   * consults it: a proven read keeps the fast unchecked `vec.get`; every
   * unproven read falls to the SAFE bounds-checked read (no trap).
   */
  readonly safeIndexedArrays?: ReadonlySet<string>;
  /**
   * #2952 slice 2 — the innermost enclosing CLAIMED loop's label, threaded
   * onto the body cx by every loop lowerer. `lowerBreakContinueStatement`
   * emits `br.label` against it (unlabeled break/continue bind the
   * innermost loop, ECMA-262 §14.8/§14.9). Absent outside loop bodies;
   * lifted-closure contexts are constructed fresh, so it never leaks
   * across function boundaries.
   */
  readonly loopLabel?: IrLabelId;
  /**
   * (#2856) Early-return barrier. Set `true` for statement buffers where a
   * Wasm-`return`-based early exit is UNSOUND: for-of bodies (an iterator-
   * protocol drive would skip its `iter.return` cleanup) and try/catch/
   * finally bodies (a Wasm return skips the inlined finally). `lowerStmt`'s
   * ReturnStatement arm throws (→ clean legacy demote) when set. Plain
   * while/for/do bodies inherit the surrounding value, so a loop nested
   * inside a try correctly stays barred. Mirrored by the selector's
   * `earlyReturnBarrierDepth` so accepted shapes always lower.
   */
  readonly noEarlyReturn?: boolean;
}

/**
 * Slice 6 part 2 (#1181): walk a function body to collect every `let`
 * name that is reassigned somewhere — `<id> = <expr>`, `<id> +=/-=/*=/`/=`
 * `<expr>`, or pre/postfix `++<id>`/`--<id>`/`<id>++`/`<id>--`. Names
 * that match are bound as `slot` ScopeBindings so the cross-iteration
 * write semantics inside for-of loops work correctly. Const-bound names
 * are not in scope for mutation; we only track identifier-LHS writes.
 *
 * We DON'T descend into nested function-likes — their writes are local
 * to their own scope and don't influence the outer's slot decisions.
 */
function collectMutatedLetNames(
  fn:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    // #3000-B: accessors reach this via `lowerFunctionAstToIr`; only `.body` is read.
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
): Set<string> {
  const writes = new Set<string>();
  if (!fn.body) return writes;
  return collectMutatedLetNamesFromBlock(fn.body);
}

function collectMutatedLetNamesFromBlock(body: ts.Block): Set<string> {
  const writes = new Set<string>();
  const visit = (node: ts.Node): void => {
    // Skip nested function bodies — their writes belong to their own
    // scope. The outer `mutatedLets` only governs outer-scope `let`s.
    if (
      node !== body &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        if (ts.isIdentifier(node.left)) writes.add(node.left.text);
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        if (ts.isIdentifier(node.operand)) writes.add(node.operand.text);
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return writes;
}

function lowerVarDecl(stmt: ts.VariableStatement, cx: LowerCtx): void {
  const isConst = !!(stmt.declarationList.flags & ts.NodeFlags.Const);
  for (const d of stmt.declarationList.declarations) {
    // Slice 8a (#1169g): destructuring binding patterns (selector restricts
    // to const, no rest, no defaults, no nesting). Lower the initializer
    // ONCE into an SSA value, then walk the pattern emitting one
    // `object.get` (object pattern) or `vec.get` (array pattern) per leaf
    // and binding each leaf as a `local` ScopeBinding.
    if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) {
      if (!d.initializer) {
        throw new Error(`ir/from-ast: binding pattern requires an initializer (${cx.funcName})`);
      }
      // Hint: pass an externref so the initializer's actual IrType (object,
      // class, vec ref, etc.) flows through unchanged. The pattern lowerer
      // dispatches on the inferred IrType.
      const initValue = lowerExpr(d.initializer, cx, irVal({ kind: "externref" }));
      lowerBindingPattern(d.name, initValue, cx);
      continue;
    }
    if (!ts.isIdentifier(d.name)) {
      throw new Error(`ir/from-ast: destructuring declarations not supported in Phase 1 (${cx.funcName})`);
    }
    const name = d.name.text;
    if (cx.scope.has(name)) {
      throw new Error(`ir/from-ast: redeclaration of '${name}' in ${cx.funcName}`);
    }
    if (!d.initializer) {
      throw new Error(`ir/from-ast: Phase 1 requires an initializer for '${name}' in ${cx.funcName}`);
    }
    // Slice 3 (#1169c): closure-literal initializer. Lifted to a
    // top-level IR function and bound in scope as an IrType.closure
    // value (so `lowerCall` dispatches via `closure.call`).
    if (isConst && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
      const value = lowerClosureExpression(d.initializer, cx);
      cx.scope.set(name, { kind: "local", value, type: cx.builder.typeOf(value) });
      continue;
    }
    // Slice 2 (#1169b): non-primitive type annotations on locals
    // (TypeLiteral / TypeReference) can't be resolved to an IrType
    // here without a TS checker. Defer those to inference from the
    // initializer — `typeNodeToIr` only fires for primitive type
    // keywords; everything else falls through to inference.
    const annotated =
      d.type && isPrimitiveTypeNode(d.type) ? typeNodeToIr(d.type, `local ${name} of ${cx.funcName}`) : undefined;
    const hint: IrType = annotated ?? irVal({ kind: "f64" });
    const value = lowerExpr(d.initializer, cx, hint);
    const inferred = cx.builder.typeOf(value);
    if (annotated) {
      // Slice 1 (#1169a): the IrType discriminator includes a `string` arm
      // alongside `val`, so use `irTypeEquals` for a structural match
      // rather than `asVal`-only kind comparison (which silently drops
      // the string case).
      if (!irTypeEquals(annotated, inferred)) {
        throw new Error(
          `ir/from-ast: local '${name}' annotated as ${describeIrType(annotated)} but initializer is ${describeIrType(inferred)} in ${cx.funcName}`,
        );
      }
    }
    // #2782 (hybrid Row 5) + #2790 (i32 arm) — no-box NUMBER-local proof gate.
    // The bindings below keep an `f64` / `i32`-typed local UNBOXED (as a `local`
    // SSA value or a numeric `slot`). Per the Hybrid Invariant that no-box
    // specialization must be discharged by a proof on the TS *type*, never the
    // lowered Wasm kind: `number` / `boolean` / `symbol` all collapse to `f64` /
    // `i32`, so the kind alone cannot tell a genuine numeric local from an `any`
    // / union one a scalar hint coerced opaquely. Prove the local's TS type is a
    // pure number — or (i32 only, #2790) a pure `boolean`, the other sound
    // tag-determinable i32 brand that boxes via `__box_boolean` (#2785) —
    // (`proveUnboxedNumberLocal`, reusing #2781's `classifyPrimitiveProof`);
    // anything unprovable — `any` / `unknown` / a MIXED `number | string` union —
    // demotes to the SAFE boxed legacy lowering (which carries the dynamic tag).
    // No checker → unchanged (#2780 / #2781's no-checker arm). `inferred` is the
    // bound representation here (an `annotated` mismatch already threw above),
    // and `d.name` is an Identifier (non-identifier decls threw earlier).
    if (!proveUnboxedNumberLocal(d.name, inferred, cx)) {
      const boundKind = asVal(inferred)?.kind === "i32" ? "i32" : "f64";
      throw new Error(
        `ir/from-ast: local '${name}' is bound as an unboxed ${boundKind} but its TS type is not ` +
          `provably a pure number${boundKind === "i32" ? " or boolean" : ""} — keeping the no-box ` +
          `number representation is unsound (the ${boundKind} Wasm kind conflates number / boolean / ` +
          `any); demote to the SAFE boxed legacy lowering in ${cx.funcName} (#2782/#2790)`,
      );
    }
    // Slice 6 part 2 (#1181): mutable `let` bindings whose name is
    // reassigned anywhere in the function body bind as a `slot`
    // ScopeBinding instead of `local`. The slot is a Wasm-local that
    // survives across for-of iterations, and reads/writes go through
    // `slot.read` / `slot.write` instead of carrying the SSA value
    // through the scope.
    //
    // Slice 6 part 4 refactor (#1185): extended to support
    // `IrType.string` slot bindings via the resolver. In
    // native-strings mode we use the resolver's `resolveString()` to
    // get the underlying `(ref $AnyString)` ValType for the slot,
    // and tag the binding with `asType: IrType.string` so identifier
    // reads compose with slice-1 string ops.
    if (!isConst && cx.mutatedLets.has(name)) {
      const slotValType = asVal(inferred);
      if (slotValType !== null && slotValType.kind !== "ref" && slotValType.kind !== "ref_null") {
        const slotIndex = cx.builder.declareSlot(name, slotValType);
        cx.builder.emitSlotWrite(slotIndex, value);
        cx.scope.set(name, { kind: "slot", slotIndex, type: inferred });
        continue;
      }
      // String let in native-strings mode: slot ValType is the
      // resolver's string ref; binding type is IrType.string via
      // asType widening so body code composes with string ops.
      if (inferred.kind === "string") {
        const stringValType = cx.resolver?.resolveString?.();
        if (stringValType) {
          const slotIndex = cx.builder.declareSlot(name, stringValType);
          cx.builder.emitSlotWrite(slotIndex, value);
          cx.scope.set(name, {
            kind: "slot",
            slotIndex,
            type: irVal(stringValType),
            asType: { kind: "string" },
          });
          continue;
        }
      }
      // Fall through to local binding for non-slot-eligible types —
      // the lowerer will catch any subsequent assignment and throw,
      // landing the function back on the legacy path.
    }
    cx.scope.set(name, { kind: "local", value, type: inferred });
  }
}

// ---------------------------------------------------------------------------
// Binding pattern lowering (slice 8a — #1169g)
// ---------------------------------------------------------------------------
//
// Destructuring patterns decompose at compile time into a sequence of
// single-name bindings. Object pattern leaves emit `object.get`; array
// pattern leaves emit `vec.get` (when the source is a vec ref).
//
// Slice 8a scope: identifier-leaf, no-default, no-rest, no-nested patterns.
// Anything wider is rejected by the selector and stays on the legacy
// destructuring path. Mixed array/object patterns over generic iterables
// (Map, Set) require iter.next protocol and are deferred to slice 8b.
//
// Why hint with externref for the initializer in `lowerVarDecl`? The
// pattern's source type isn't known until lowering — it could be
// IrType.object, IrType.class (for class instances treated like objects
// — out of scope), or `(ref $vec_*)`. The externref hint is advisory;
// `lowerExpr`'s producers inspect their own type rather than coercing
// to the hint, so an object literal stays IrType.object and a vec ref
// stays `(ref $vec_*)`.

/**
 * Slice 8a (#1169g): walk a destructuring binding pattern and emit one
 * field/index read per leaf, binding each name as a `local` ScopeBinding.
 *
 * The source SSA value is read once per leaf. The IR's CSE / DCE passes
 * coalesce repeated reads when safe; even without that, struct.get and
 * array.get are pure ops cheap enough that a single-store tee isn't
 * required for correctness.
 */
function lowerBindingPattern(pattern: ts.BindingPattern, source: IrValueId, cx: LowerCtx): void {
  if (ts.isObjectBindingPattern(pattern)) {
    lowerObjectPattern(pattern, source, cx);
    return;
  }
  lowerArrayPattern(pattern, source, cx);
}

/**
 * Slice 8a (#1169g): decompose `const { a, b: x } = obj` into per-leaf
 * `object.get` reads. The source must lower to an IrType.object; class
 * instances and externref-typed sources fall through to a clean throw,
 * landing the function back on legacy.
 */
function lowerObjectPattern(pattern: ts.ObjectBindingPattern, source: IrValueId, cx: LowerCtx): void {
  const sourceType = cx.builder.typeOf(source);
  // #1372 — destructuring a class instance ({ x, y }: Vec2) is identical at
  // the IR level to destructuring an object literal: each leaf reads one
  // named field. The only difference is the emit op (class.get vs object.get).
  if (sourceType.kind !== "object" && sourceType.kind !== "class") {
    throw new Error(
      `ir/from-ast: object destructuring source must be IrType.object or IrType.class (got ${describeIrType(sourceType)}) in ${cx.funcName}`,
    );
  }
  for (const elem of pattern.elements) {
    // Selector enforces no rest / no default / identifier-leaf only;
    // defensive checks here surface selector regressions as clean throws
    // rather than silent miscompiles.
    if (elem.dotDotDotToken) {
      throw new Error(`ir/from-ast: object rest pattern not in slice 8a (${cx.funcName})`);
    }
    if (elem.initializer) {
      throw new Error(`ir/from-ast: pattern default values not in slice 8a (${cx.funcName})`);
    }
    if (!ts.isIdentifier(elem.name)) {
      throw new Error(`ir/from-ast: nested binding patterns not in slice 8a (${cx.funcName})`);
    }
    // The property name being read out of the source. `propertyName`
    // is set when the pattern uses renaming (`{ a: x }` — propName is
    // "a", localName is "x"); shorthand patterns leave it null.
    const propName = elem.propertyName
      ? ts.isIdentifier(elem.propertyName)
        ? elem.propertyName.text
        : ts.isStringLiteral(elem.propertyName)
          ? elem.propertyName.text
          : null
      : elem.name.text;
    if (propName === null) {
      throw new Error(`ir/from-ast: object pattern property name must be Identifier or StringLiteral (${cx.funcName})`);
    }
    const localName = elem.name.text;
    if (cx.scope.has(localName)) {
      throw new Error(`ir/from-ast: redeclaration of '${localName}' in pattern in ${cx.funcName}`);
    }
    const field = sourceType.shape.fields.find((f) => f.name === propName);
    if (!field) {
      throw new Error(
        `ir/from-ast: object pattern reads unknown field "${propName}" (shape: ${describeIrType(sourceType)}) in ${cx.funcName}`,
      );
    }
    const v =
      sourceType.kind === "class"
        ? cx.builder.emitClassGet(source, propName, field.type)
        : cx.builder.emitObjectGet(source, propName, field.type);
    cx.scope.set(localName, { kind: "local", value: v, type: field.type });
  }
}

/**
 * Slice 8a (#1169g): decompose `const [x, y, z] = arr` into per-index
 * `vec.get` reads on a vec source. `vec.get` traps on out-of-bounds at
 * runtime — same semantics as legacy destructuring's array path
 * (legacy uses array.get without a bounds check too).
 *
 * The source must lower to a `(ref|ref_null) $vec_*` IrType.val. Anything
 * else (string, externref, class) routes to legacy via a clean throw.
 */
function lowerArrayPattern(pattern: ts.ArrayBindingPattern, source: IrValueId, cx: LowerCtx): void {
  const sourceType = cx.builder.typeOf(source);
  const valTy = asVal(sourceType);
  if (!valTy || (valTy.kind !== "ref" && valTy.kind !== "ref_null")) {
    throw new Error(
      `ir/from-ast: array destructuring source must be vec ref (got ${describeIrType(sourceType)}) in ${cx.funcName}`,
    );
  }
  // Recover the element ValType. We need a resolver thread-through —
  // matches the slice-6 vec for-of pattern. If the resolver is absent
  // or doesn't recognize the ref as a vec, fall back to legacy.
  const vec = cx.resolver?.resolveVec?.(valTy);
  if (!vec) {
    throw new Error(
      `ir/from-ast: array destructuring source is not a recognisable vec ref (${describeIrType(sourceType)}) in ${cx.funcName}`,
    );
  }
  const elemValType = vec.elementValType;
  const elemIrType: IrType = irVal(elemValType);

  let i = 0;
  for (const elem of pattern.elements) {
    if (ts.isOmittedExpression(elem)) {
      i++;
      continue;
    }
    if (elem.dotDotDotToken) {
      throw new Error(`ir/from-ast: array rest pattern not in slice 8a (${cx.funcName})`);
    }
    if (elem.initializer) {
      throw new Error(`ir/from-ast: pattern default values not in slice 8a (${cx.funcName})`);
    }
    if (!ts.isIdentifier(elem.name)) {
      throw new Error(`ir/from-ast: nested binding patterns not in slice 8a (${cx.funcName})`);
    }
    const localName = elem.name.text;
    if (cx.scope.has(localName)) {
      throw new Error(`ir/from-ast: redeclaration of '${localName}' in pattern in ${cx.funcName}`);
    }
    const idx = cx.builder.emitConst({ kind: "i32", value: i }, irVal({ kind: "i32" }));
    const v = cx.builder.emitVecGet(source, idx, elemIrType);
    cx.scope.set(localName, { kind: "local", value: v, type: elemIrType });
    i++;
  }
}

function typeNodeToIr(node: ts.TypeNode | undefined, where: string): IrType {
  if (!node) throw new Error(`ir/from-ast: missing type annotation (${where})`);
  switch (node.kind) {
    case ts.SyntaxKind.NumberKeyword:
      return irVal({ kind: "f64" });
    case ts.SyntaxKind.BooleanKeyword:
      return irVal({ kind: "i32" });
    case ts.SyntaxKind.StringKeyword:
      return { kind: "string" };
    default:
      throw new Error(`ir/from-ast: unsupported type in Phase 1 (${where})`);
  }
}

/**
 * Quick predicate: does this TypeNode resolve to a primitive IrType
 * without needing a TS checker? Used by `lowerVarDecl` and
 * `resolveIrType` to decide whether to consult the override map.
 */
function isPrimitiveTypeNode(node: ts.TypeNode): boolean {
  return (
    node.kind === ts.SyntaxKind.NumberKeyword ||
    node.kind === ts.SyntaxKind.BooleanKeyword ||
    node.kind === ts.SyntaxKind.StringKeyword
  );
}

/** Short debug string for IrType, used in error messages. */
function describeIrType(t: IrType): string {
  if (t.kind === "val") return t.val.kind;
  if (t.kind === "string") return "string";
  if (t.kind === "object") {
    return `object{${t.shape.fields.map((f) => `${f.name}:${describeIrType(f.type)}`).join(",")}}`;
  }
  if (t.kind === "closure") {
    const ps = t.signature.params.map(describeIrType).join(",");
    return `closure(${ps})->${describeIrType(t.signature.returnType)}`;
  }
  if (t.kind === "class") return `class<${t.shape.className}>`;
  if (t.kind === "extern") return `extern<${t.className}>`;
  // #1926 — union members / boxed inner are IrTypes; recurse.
  if (t.kind === "union") return `union<${t.members.map(describeIrType).join(",")}>`;
  // #2949 — dynamic leaf; render the optional JsTag refinement when present.
  if (t.kind === "dynamic") return t.tag === undefined ? "dynamic" : `dynamic<tag:${t.tag}>`;
  return `boxed<${describeIrType(t.inner)}>`;
}

/**
 * Resolve the IR type for a function param or return.
 *
 * If the AST has an explicit TypeNode, it must agree with the override
 * (if any). If the AST has no TypeNode, the override is authoritative.
 * If neither is present, that's a compiler bug — the selector should not
 * have claimed this function.
 */
function resolveIrType(node: ts.TypeNode | undefined, override: IrType | undefined, where: string): IrType {
  if (node && isPrimitiveTypeNode(node)) {
    const fromNode = typeNodeToIr(node, where);
    if (override && !irTypeEquals(override, fromNode)) {
      throw new Error(
        `ir/from-ast: type override (${describeIrType(override)}) disagrees with annotation (${describeIrType(fromNode)}) at ${where}`,
      );
    }
    return fromNode;
  }
  // Slice 2 (#1169b): non-primitive TypeNodes (TypeLiteral / TypeReference)
  // need a TS checker to resolve into an IrType.object — we don't have
  // one inside the IR layer. The caller (codegen/index.ts:resolvePositionType)
  // pre-resolves these and passes the result via `override`, so we
  // simply prefer the override here. If neither is present, the
  // selector and override builder are out of sync — that's a bug.
  if (override) return override;
  throw new Error(`ir/from-ast: missing type annotation and no override (${where})`);
}

function lowerExpr(expr: ts.Expression, cx: LowerCtx, hint: IrType): IrValueId {
  if (ts.isParenthesizedExpression(expr)) {
    return lowerExpr(expr.expression, cx, hint);
  }
  if (ts.isNumericLiteral(expr)) {
    return cx.builder.emitConst({ kind: "f64", value: Number(expr.text) }, irVal({ kind: "f64" }));
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return cx.builder.emitConst({ kind: "bool", value: true }, irVal({ kind: "i32" }));
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return cx.builder.emitConst({ kind: "bool", value: false }, irVal({ kind: "i32" }));
  }
  // Slice 1 (#1169a) — strings, templates, typeof, .length, null-keyword.
  if (ts.isStringLiteral(expr) || expr.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    const lit = expr as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
    return cx.builder.emitStringConst(lit.text);
  }
  if (ts.isTemplateExpression(expr)) {
    return lowerTemplateExpression(expr, cx);
  }
  if (ts.isTypeOfExpression(expr)) {
    return lowerTypeOf(expr, cx);
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    // Bare `null` composes only when the consuming context is reference-
    // shaped (externref / ref_null), because IR Phase 1 has no nullable
    // union: a `null` flowing into an f64/i32 hint would mismatch the
    // consumer's Wasm type at validation. The optional-chaining null arm
    // and the `??` lowering both pass a reference-shaped hint here.
    //
    // `=== null` / `!== null` never reach this branch — `tryFoldNullCompare`
    // intercepts them before operand recursion (the fold is purely static
    // because there's no runtime null value to compare against).
    // The null const's `ty` must be a `val`-kind externref/ref_null so the
    // lowerer emits `ref.null.extern` / `ref.null T` (see lower.ts "null").
    // An `extern` className hint is null-compatible at the Wasm level
    // (opaque externref), so we materialize a plain `externref` null for it.
    const hintVal = asVal(hint);
    if (hint.kind === "extern") {
      const ty = irVal({ kind: "externref" });
      return cx.builder.emitConst({ kind: "null", ty }, ty);
    }
    if (hintVal && (hintVal.kind === "externref" || hintVal.kind === "ref_null")) {
      return cx.builder.emitConst({ kind: "null", ty: hint }, hint);
    }
    throw new Error(
      `ir/from-ast: bare 'null' in non-reference context (${describeIrType(hint)}) is not supported in IR (${cx.funcName})`,
    );
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return lowerPropertyAccess(expr, cx);
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return lowerObjectLiteral(expr, cx);
  }
  if (ts.isElementAccessExpression(expr)) {
    return lowerElementAccess(expr, cx);
  }
  // Slice 12 (#1169o) — `ArrayLiteralExpression` is selector-accepted
  // for shape but the IR doesn't yet emit `vec.new_fixed`. Throw clean
  // fallback so the enclosing function reverts to legacy. The selector
  // accepts the shape primarily so functions whose only "non-Phase-1"
  // construct is an array-literal callee argument (e.g. `f([1,2,3])`)
  // don't drop their callee from the IR claim set via the call-graph
  // closure.
  if (ts.isArrayLiteralExpression(expr)) {
    return lowerArrayLiteral(expr, cx, hint);
  }
  // #1370 Phase B: `this` reference inside an instance method body.
  // The integration loop binds `this` in scope to the synthetic
  // `__self` parameter's SSA value before lowering the body. Outside
  // of class-method bodies the keyword never enters scope, so this
  // branch only fires for IR-claimed instance methods.
  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    const p = cx.scope.get("this");
    if (!p) {
      throw new Error(`ir/from-ast: 'this' reference outside an instance method body (${cx.funcName})`);
    }
    if (p.kind !== "local") {
      throw new Error(`ir/from-ast: unexpected 'this' binding kind ${p.kind} in ${cx.funcName}`);
    }
    return p.value;
  }
  if (ts.isIdentifier(expr)) {
    const p = cx.scope.get(expr.text);
    // (#2856) Host ambient global (`document`, `window`, …): not a scope
    // binding — resolves through the legacy declared-globals registry to the
    // `global_<name>` handle import, typed as the global's extern class so
    // member access on it dispatches through the extern arms. Scope bindings
    // take priority (a local named `document` shadows the global, matching
    // both JS semantics and the selector's checker-backed resolution).
    // Host-free modes register no declared globals, so this resolves nothing
    // there — and the capability gate means the selector never claims such a
    // function in those modes anyway (`assertNotDeferred` guards the
    // invariant).
    if (!p) {
      const hg = cx.resolver?.getHostGlobalInfo?.(expr.text);
      if (hg) {
        assertNotDeferred(
          hostExternCapability(cx.resolver?.jsHostExterns?.() === true),
          `host global "${expr.text}"`,
          cx.funcName,
        );
        const r = cx.builder.emitCall({ kind: "func", name: hg.importName }, [], {
          kind: "extern",
          className: hg.className,
        });
        if (r === null) {
          throw new Error(`ir/from-ast: host global "${expr.text}" produced no result in ${cx.funcName}`);
        }
        return r;
      }
      // (#2856 C3) Module-scope binding holding an extern-class instance
      // (`const fibCache = new Map()` at module level). The legacy backend
      // allocated a `__mod_<name>` externref global (module-level statements
      // always compile via legacy — the IR only claims functions), so the IR
      // read is a `global.get` against the SAME storage slot, branded with
      // the binding's extern class so member calls dispatch through the
      // extern arms. When legacy tracked a TDZ flag for the binding, emit
      // the same read-site check legacy does: `if (__tdz_<name> == 0) throw`.
      const mg = cx.resolver?.getModuleScopeExternBinding?.(expr.text);
      if (mg) {
        assertNotDeferred(
          hostExternCapability(cx.resolver?.jsHostExterns?.() === true),
          `module-scope extern binding "${expr.text}"`,
          cx.funcName,
        );
        if (mg.tdzGlobalName) {
          const tdz = cx.builder.emitGlobalGet({ kind: "global", name: mg.tdzGlobalName }, irVal({ kind: "i32" }));
          const cond = cx.builder.emitUnary("i32.eqz", tdz, irVal({ kind: "i32" }));
          const thenBody = cx.builder.collectBodyInstrs(() => {
            const nullExt = cx.builder.emitConst(
              { kind: "null", ty: irVal({ kind: "externref" }) },
              irVal({ kind: "externref" }),
            );
            cx.builder.emitThrow(nullExt);
          });
          cx.builder.emitIfStmt({ cond, then: thenBody, else: [] });
        }
        return cx.builder.emitGlobalGet(
          { kind: "global", name: mg.globalName },
          { kind: "extern", className: mg.className },
        );
      }
    }
    if (!p) throw new Error(`ir/from-ast: identifier "${expr.text}" is not in scope in ${cx.funcName}`);
    // Slice 6 part 2 (#1181): slot-bound identifier (let mutated across
    // for-of iterations). Reads emit `slot.read`, which lowers to a
    // `local.get` on the Wasm-local slot. The slot's type is recorded
    // at declaration time so the IR result type matches.
    //
    // Slice 6 part 4 refactor (#1185): if the binding has an `asType`
    // widening, the SSA result is tagged as `asType` instead of
    // `irVal(slot.type)`. This lets native-strings string for-of
    // loop variables compose with slice-1 string ops even though the
    // underlying slot ValType is `(ref $AnyString)` rather than
    // `IrType.string`.
    if (p.kind === "slot") {
      if (p.asType) {
        return cx.builder.emitSlotReadAs(p.slotIndex, p.asType);
      }
      return cx.builder.emitSlotRead(p.slotIndex);
    }
    if (p.kind !== "local") {
      // Slice 3 (#1169c): nestedFunc bindings are name-only — they have
      // no SSA value. Bare reference (without a CallExpression) cannot
      // produce an IR value. The callable form is handled by `lowerCall`.
      throw new Error(`ir/from-ast: bare reference to nested function "${expr.text}" not in slice 3 (${cx.funcName})`);
    }
    // Slice 3 (#1169c): refcell-typed bindings need a deref on read.
    // The SSA value IS the cell ref; expression-position reads expect
    // the inner scalar.
    if (p.type.kind === "boxed") {
      return cx.builder.emitRefCellGet(p.value, p.type.inner);
    }
    return p.value;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    return lowerPrefixUnary(expr, cx);
  }
  if (ts.isBinaryExpression(expr)) {
    return lowerBinary(expr, cx, hint);
  }
  if (ts.isConditionalExpression(expr)) {
    return lowerConditional(expr, cx);
  }
  if (ts.isCallExpression(expr)) {
    const callResult = lowerCall(expr, cx);
    if (callResult === null) {
      // Unreachable: expression position (statementPosition=false) throws
      // before returning null.
      throw new Error(`ir/from-ast: void call in expression position (${cx.funcName})`);
    }
    return callResult;
  }
  // Slice 4 (#1169d): class instantiation. Lookup must succeed against
  // the class registry seeded from `ctx.classShapes`; if not, the
  // function falls back to legacy.
  // Slice 10 (#1169i): extends to host extern classes — `new RegExp(...)`,
  // `new Uint8Array(N)`, etc. Dispatch happens inside `lowerNewExpression`
  // by checking the resolver's `getExternClassInfo` before the slice-4
  // class-shape lookup.
  if (ts.isNewExpression(expr)) {
    return lowerNewExpression(expr, cx);
  }
  // Slice 10 (#1169i): RegExp literal `/pattern/flags`. Lowers to
  // `extern.regex` which materializes the pattern + flags strings and
  // calls the `RegExp_new` host import.
  if (expr.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    return lowerRegExpLiteral(expr, cx);
  }
  // Slice 11 (#1169n) — `delete <expr>`. The IR-claim shape doesn't
  // support property deletes that change runtime behavior (slice 11
  // doesn't track per-instance prop existence). Most `delete` uses
  // in IR-claimable functions delete properties that are statically
  // known to exist (so the result is `true`), or delete unresolved
  // refs (also `true`). We lower the operand for side effects (e.g.
  // `delete f().x` must still call f) and then push the constant
  // `true`.
  if (ts.isDeleteExpression(expr)) {
    // Lower operand for side effects only — the result is unused.
    // Property-access operand: lower the receiver (the .name part is
    // statically resolved, so the access itself has no runtime effect
    // on the IR-claim shape). Other operands lower via `lowerExpr`.
    if (ts.isPropertyAccessExpression(expr.expression)) {
      // Lower the receiver expression for side effects; ignore the
      // produced SSA value (DCE drops it if pure).
      void lowerExpr(expr.expression.expression, cx, irVal({ kind: "f64" }));
    } else {
      void lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
    }
    return cx.builder.emitConst({ kind: "bool", value: true }, irVal({ kind: "i32" }));
  }
  // Slice 11 (#1169n) — `void <expr>`. Lower the operand for side
  // effects, then push the IR's f64 NaN sentinel as the result. The
  // hint type drives whether downstream code treats this as f64 or
  // coerces to externref. For now, emit f64 NaN (the closest scalar
  // approximation of `undefined` in numeric context). Functions that
  // use `void` outside f64 context will need a future widening to
  // emit a proper undefined-typed value; for slice 11, throw if the
  // operand context demands a non-f64 result.
  if (ts.isVoidExpression(expr)) {
    void lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
    return cx.builder.emitConst({ kind: "f64", value: NaN }, irVal({ kind: "f64" }));
  }
  throw new Error(`ir/from-ast: unsupported expression kind ${ts.SyntaxKind[expr.kind]} in ${cx.funcName}`);
}

/**
 * #2780 (hybrid Row 6) — the widening-escape proof for the ArrayLiteral fast
 * path. Returns `true` when the literal's result flows into a sink that demands a
 * WIDER / heterogeneous element type than the homogeneous NARROW vec
 * `vec.new_fixed` would build — `any[]` / `unknown[]` / a heterogeneous-union
 * element, or a bare `any` / `unknown` slot. In that case the packed fast path is
 * UNSOUND: a `vec<f64>` (etc.) handed to an `any`-typed alias could later receive
 * a string/object element the packed vec cannot hold (e.g. `const a: any[] =
 * [1,2,3]; a[0] = "x"`). When it returns `true`, codegen must fall to the SAFE
 * legacy lowering, which boxes each element to the dynamic externref
 * representation.
 *
 * This is a **local** proof (the Hybrid-Invariant point of Row 6): it inspects
 * only the literal's own TS contextual type — no whole-function dataflow. The
 * fresh allocation is decidable from the sink type at this single site.
 *
 * The comparison reads the TS **type** (`TypeFlags`), never the Wasm ValType
 * kind: `number[]`, `boolean[]` and `symbol[]` all collapse to the same element
 * ValType (f64 / i32 / i32) — keying on the kind would misclassify a
 * boolean-vs-number sink. Note the TS gotcha that the intrinsic `boolean` type is
 * internally the union `true | false`, so `isUnion()` is `true` for it; it is
 * excluded via the `Boolean` flag so `boolean[]` stays on the fast path, while a
 * genuine heterogeneous union (`string | number`) — which does not carry that
 * flag — is correctly treated as a widening.
 *
 * Structural-supertype scalar sinks (`{}[]`, `object[]`) are intentionally NOT
 * flagged here — Row 6 scopes to `any` / `unknown` / heterogeneous sinks, and
 * those residuals stay covered by the existing downstream `irTypeEquals` net
 * (a wider-typed write demotes the function to legacy), exactly as today.
 */
function arrayLiteralWideningEscapes(expr: ts.ArrayLiteralExpression, cx: LowerCtx): boolean {
  const checker = cx.checker;
  // No checker → cannot prove a sink at this site. The existing element-type
  // (`irTypeEquals`) checks here plus the downstream demotion net still guard
  // correctness, so keep the fast path (HI: a missing proof is not a license to
  // miscompile — there is no narrow-vec build whose escape we are masking,
  // because every boundary use is still type-checked).
  if (!checker) return false;
  const ctxType = checker.getContextualType(expr);
  if (!ctxType) return false; // consumed at its own narrow type → no widening at this site.
  // A bare `any` / `unknown` slot (e.g. `const a: any = [1,2,3]`): the literal
  // escapes into a fully dynamic value.
  if (ctxType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  // Array / tuple sink: inspect the element type the sink demands.
  const ctxElem = ctxType.getNumberIndexType();
  if (!ctxElem) return false; // non-indexable concrete sink → no array widening here.
  if (ctxElem.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true; // any[] / unknown[].
  // Heterogeneous element union (`(number | string)[]`) the packed vec cannot
  // hold — but NOT the intrinsic `boolean` (= `true | false`) which is uniform.
  if (ctxElem.isUnion() && !(ctxElem.flags & ts.TypeFlags.Boolean)) return true;
  return false;
}

/**
 * #1804 — lower a fixed-length, non-spread, non-sparse, same-typed array
 * literal to a `vec.new_fixed` IR node. Out of scope (clean fallback to
 * legacy): spread elements (`[...xs]`), elision holes (`[1, , 3]`), mixed
 * element types, and empty literals with no usable element-type hint.
 *
 * Element type resolution: prefer the `hint` (a vec ref whose element IrType
 * the resolver can recover) — covers `const a: number[] = [1,2,3]` and the
 * empty `const a: number[] = []`; otherwise infer from the first element and
 * require every element to share that IrType.
 *
 * #2780 (hybrid Row 6) — before the fast `vec.new_fixed`, discharge the
 * widening-escape proof (`arrayLiteralWideningEscapes`): the packed narrow vec is
 * only sound when the literal does NOT flow into an `any` / `unknown` /
 * heterogeneous sink. When it does, demote to the SAFE legacy lowering (which
 * boxes each element) — this mirrors #2766's prove-then-specialize shape.
 */
function lowerArrayLiteral(expr: ts.ArrayLiteralExpression, cx: LowerCtx, hint: IrType): IrValueId {
  // Reject spread / sparse — out of scope, keep on legacy.
  for (const el of expr.elements) {
    if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) {
      throw new Error(`ir/from-ast: array literal with spread/elision not in #1804 scope (${cx.funcName})`);
    }
  }

  // Recover an element IrType from the hint when it is (or wraps) a vec ref.
  const hintVal = asVal(hint);
  const hintElem = hintVal ? (cx.resolver?.resolveVec?.(hintVal)?.elementValType ?? null) : null;
  const hintElemIr: IrType | null = hintElem ? irVal(hintElem) : null;

  if (expr.elements.length === 0) {
    // Empty literal — element type must come from the hint.
    if (!hintElemIr) {
      throw new Error(`ir/from-ast: empty array literal needs a vec-typed hint to infer element type (${cx.funcName})`);
    }
    const elemVT = asVal(hintElemIr)!;
    const vec = cx.resolver?.resolveVecForElement?.(elemVT);
    if (!vec) {
      throw new Error(`ir/from-ast: resolver cannot register vec for empty literal (${cx.funcName})`);
    }
    return cx.builder.emitVecNewFixed([], hintElemIr, irVal({ kind: "ref", typeIdx: vec.vecStructTypeIdx }));
  }

  // #2780 (hybrid Row 6) — widening-escape proof, the PRIMARY HI gate (run
  // before element lowering, mirroring #2766's prove-then-specialize: prove the
  // specialization is sound, else fall to the SAFE path). `vec.new_fixed` builds
  // a homogeneous NARROW vec (`vec<f64>` / `vec<i32>` / …). That specialization
  // is only sound when this non-empty literal does NOT flow into a sink that
  // demands a WIDER / heterogeneous element type (`any[]` / `unknown[]` / a
  // union). When it does — a literal passed where an `any[]` is expected
  // (`g([1,2,3])`, `g(x: any[])`), or an annotated `const a: any[] = [1,2,3]`
  // were the selector to claim it (today such functions are `body-shape-rejected`
  // because `lowerVarDecl` only forwards PRIMITIVE type annotations; this gate
  // keeps the fast path sound if that claim scope ever widens) — demote to the
  // SAFE legacy lowering, which boxes each element to the dynamic externref
  // representation. Gating here (before the element-type loop) makes the explicit
  // HI reason the demotion cause rather than the incidental "mixed-type" throw
  // that the externref-hint path would otherwise raise; the existing
  // element-type / hint `irTypeEquals` checks remain as a backstop for any sink
  // `getContextualType` cannot recover at this site. Empty literals are excluded
  // (handled above): with a wide hint they already build a correct wide vec, so
  // there is no narrow build to let escape.
  if (arrayLiteralWideningEscapes(expr, cx)) {
    throw new Error(
      `ir/from-ast: array literal flows into a widening/heterogeneous sink ` +
        `(any[]/unknown[]/union element) — the packed vec.new_fixed fast path is ` +
        `unsound here; demote to the SAFE boxed legacy lowering (${cx.funcName})`,
    );
  }

  // Lower each element. Use the hint element type as each element's hint when
  // we have one (so e.g. number elements stay f64).
  const elementIds: IrValueId[] = [];
  for (const el of expr.elements) {
    elementIds.push(lowerExpr(el as ts.Expression, cx, hintElemIr ?? irVal({ kind: "f64" })));
  }

  // Determine the shared element IrType: the hint's element type if present,
  // else the first element's type. Require every element to share it.
  const elementType = hintElemIr ?? cx.builder.typeOf(elementIds[0]!);
  for (const id of elementIds) {
    if (!irTypeEquals(cx.builder.typeOf(id), elementType)) {
      throw new Error(`ir/from-ast: mixed-type array literal not in #1804 scope (${cx.funcName})`);
    }
  }

  const elemVT = asVal(elementType);
  if (!elemVT) {
    // Non-scalar (object/closure/...) element types are out of scope for this slice.
    throw new Error(`ir/from-ast: array literal element type ${elementType.kind} not in #1804 scope (${cx.funcName})`);
  }
  const vec = cx.resolver?.resolveVecForElement?.(elemVT);
  if (!vec) {
    throw new Error(`ir/from-ast: resolver cannot register vec for array literal (${cx.funcName})`);
  }
  return cx.builder.emitVecNewFixed(elementIds, elementType, irVal({ kind: "ref", typeIdx: vec.vecStructTypeIdx }));
}

/**
 * Slice 10 (#1169i) — lower a `/pattern/flags` RegExp literal. Reuses the
 * legacy `parseRegExpLiteral` to extract pattern + flags from the literal
 * text. The flags string is normalized to `""` when no flags are present
 * (matches the legacy `compileRegExpLiteral` convention — see
 * `src/codegen/typeof-delete.ts:166-168`); a `null` flags arg would
 * otherwise produce `RegExp("...", null)` at runtime, which JS rejects
 * as `TypeError: Invalid flags 'null'`.
 */
function lowerRegExpLiteral(expr: ts.Expression, cx: LowerCtx): IrValueId {
  const { pattern, flags } = parseRegExpLiteralText(expr.getText());
  return cx.builder.emitRegExpLiteral(pattern, flags);
}

/**
 * Slice 10 (#1169i) — local copy of the legacy `parseRegExpLiteral` (in
 * `src/codegen/index.ts:3218`). Duplicated here to avoid importing from
 * `codegen/index.ts` from `ir/from-ast.ts`, which would add a second
 * pass-through over the existing `codegen/index.ts ↔ ir/integration.ts`
 * circular dependency. The two implementations are trivially identical;
 * any drift would surface as a behavioural mismatch in the slice-10
 * equivalence tests.
 */
function parseRegExpLiteralText(text: string): { pattern: string; flags: string } {
  const lastSlash = text.lastIndexOf("/");
  return { pattern: text.slice(1, lastSlash), flags: text.slice(lastSlash + 1) };
}

/**
 * Lower a template literal with substitutions. Slice 1 (#1169a) restricts
 * substitutions to expressions that lower to `IrType.string`. Mixed-type
 * substitutions (number/boolean coerced to string) require `number_toString`
 * plumbing through `IrInstrCall` and are deferred.
 *
 * Even when the head text is empty (`${x}rest`) we emit a `string.const ""`
 * to give the chain a consistent left operand for the first concat — same
 * convention as the legacy `compileTemplateExpression`. The IR
 * constant-folder may collapse trivial empty-concats downstream.
 */
function lowerTemplateExpression(expr: ts.TemplateExpression, cx: LowerCtx): IrValueId {
  let acc = cx.builder.emitStringConst(expr.head.text);
  for (const span of expr.templateSpans) {
    const sub = lowerExpr(span.expression, cx, { kind: "string" });
    const subType = cx.builder.typeOf(sub);
    if (subType.kind !== "string") {
      throw new Error(
        `ir/from-ast: template substitution must be string in slice 1 (got ${describeIrType(subType)} in ${cx.funcName})`,
      );
    }
    acc = cx.builder.emitStringConcat(acc, sub);
    if (span.literal.text) {
      const lit = cx.builder.emitStringConst(span.literal.text);
      acc = cx.builder.emitStringConcat(acc, lit);
    }
  }
  return acc;
}

/**
 * Lower `typeof <expr>` by static fold (slice 1). Operand IrType must be
 * statically known; union/boxed operands are deferred to a follow-up
 * slice that emits a runtime tag dispatch via `tag.test`.
 */
function lowerTypeOf(expr: ts.TypeOfExpression, cx: LowerCtx): IrValueId {
  const inner = lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
  const innerType = cx.builder.typeOf(inner);
  const tag = staticTypeOfFor(innerType);
  if (tag === null) {
    throw new Error(
      `ir/from-ast: typeof of non-static IrType (${describeIrType(innerType)}) is deferred (${cx.funcName})`,
    );
  }
  return cx.builder.emitStringConst(tag);
}

/**
 * Map an IR type to the JS `typeof` tag string that any value of that type
 * would produce at runtime. Returns `null` for types whose runtime tag
 * varies (unions, boxed, references) — those need a runtime dispatch and
 * are out of slice 1's scope.
 */
function staticTypeOfFor(t: IrType): string | null {
  if (t.kind === "string") return "string";
  if (t.kind === "val") {
    if (t.val.kind === "f64" || t.val.kind === "f32" || t.val.kind === "i64") return "number";
    if (t.val.kind === "i32") return "boolean"; // i32 represents bool in slice 1
  }
  return null;
}

/**
 * Optional-chaining gate (#1281). Returns true when the lowered IrType
 * could carry a null reference at runtime — i.e. cases where the IR's
 * eager-evaluation primitives (no short-circuit `if/else` for property
 * access) cannot safely evaluate the receiver.
 *
 * Conservative: anything that's not a known non-null kind (`object`,
 * `class`, `string`, `extern` class, `closure`, `vec`, or `val.kind:
 * "ref"`) is treated as nullable. That's slightly stricter than spec
 * semantics but keeps the gate sound — the legacy fallback handles all
 * remaining cases correctly.
 */
function isIrTypeNullable(t: IrType): boolean {
  switch (t.kind) {
    case "object":
    case "class":
    case "string":
    case "closure":
      return false;
    case "extern":
      // Host-class externref values (Map, RegExp, ...) — externref is
      // nullable at the JS host level. Treat as nullable for `?.` gating.
      return true;
    case "val": {
      const v = t.val;
      // Non-null reference types in WasmGC are `ref`. Vecs/typed arrays
      // surface as `ref` to a registered struct. Everything else
      // (ref_null, externref, eqref, anyref, funcref, primitives) can
      // carry null at the JS source level.
      return v.kind !== "ref";
    }
    case "union":
    case "boxed":
      return true;
    default:
      return true;
  }
}

/**
 * #1375 Slice B — IR-native short-circuit lowering for `extern_recv?.prop`
 * using the (#1392) `emitIfElse` + `emitRefIsNull` primitives.
 *
 * Pattern:
 *   if (ref.is_null(recv)) { result = <undef sentinel of propType> }
 *   else                   { result = <className>_get_<propName>(recv) }
 *
 * The sentinel for the null arm depends on the property's ValType:
 *   - `f64`        — `f64.const NaN` (matches JS `undefined → Number → NaN`)
 *   - `i32`        — `i32.const 0`   (rare for extern props; pragmatic)
 *   - `externref`  — `ref.null.extern`
 *   - `ref_null T` — `ref.null` of the appropriate heap type
 *   - other refs   — fall through to legacy (cannot widen to ref_null
 *                    inside an `if` arm without type-system support)
 *
 * When the prop type isn't one of the supported sentinels, we throw to
 * legacy fallback — the existing slice-11 behavior for the rest of #1375.
 */
function lowerOptionalExternPropertyAccess(
  propName: string,
  recv: IrValueId,
  recvType: IrType,
  cx: LowerCtx,
): IrValueId {
  if (recvType.kind !== "extern") {
    throw new Error(`ir/from-ast: lowerOptionalExternPropertyAccess called with non-extern recv in ${cx.funcName}`);
  }
  const className = recvType.className;
  const info = cx.resolver?.getExternClassInfo?.(className);
  if (!info) {
    throw new Error(`ir/from-ast: extern class ${className} not registered in ${cx.funcName}`);
  }
  const prop = info.properties.get(propName);
  if (!prop) {
    throw new Error(`ir/from-ast: extern class ${className} has no property "${propName}" in ${cx.funcName}`);
  }
  const propValType = prop.type;
  const resultType: IrType = irVal(propValType);

  // Limit Slice B to prop types whose IR-claimed ValType matches the
  // actual host-import return type. The extern-class registry for some
  // properties (notably numeric ones like `Map.size`, `RegExp.lastIndex`)
  // declares `prop.type: f64` but the underlying `<className>_get_<prop>`
  // host import actually returns `externref` (boxed Number) — `lowerExpr`
  // for the non-`?.` case relies on a downstream coercion in `lowerBinary`
  // / `coerceType` to unbox before use. Inside our `emitIfElse` arm the
  // unboxing isn't reached, so the elseValue's wasm type (externref)
  // mismatches the if-result type (f64) at Wasm validation time.
  //
  // Safe types here: those where the IR-declared ValType matches the
  // host-import wasm return type 1:1. `externref` is always safe (the
  // host returns externref, which is what we want). We bail on `f64`
  // and `i32` to legacy until the prop registry tracks the actual
  // host-import return type alongside the declared TS type.
  if (propValType.kind !== "externref") {
    throw new Error(
      `ir/from-ast: optional ?.${propName} on extern ${className} with non-externref prop type (${describeIrType(resultType)}) deferred to legacy in ${cx.funcName}`,
    );
  }

  // Compute is_null condition before opening the if-arms, so the cond
  // SSA value is defined at the if-instr's emission point (per IrInstrIf
  // contract: condition lives in the outer scope).
  const cond = cx.builder.emitRefIsNull(recv);

  // Build the "null arm": emit a `ref.null.extern` matching the result
  // type. `collectBodyInstrs` re-routes builder emits into the arm's
  // buffer; the SSA value defined inside the callback becomes `thenValue`.
  let thenValue!: IrValueId;
  const thenBody = cx.builder.collectBodyInstrs(() => {
    thenValue = cx.builder.emitConst({ kind: "null", ty: resultType }, resultType);
  });

  // Build the "non-null arm": emit the actual extern-property access.
  let elseValue!: IrValueId;
  const elseBody = cx.builder.collectBodyInstrs(() => {
    elseValue = cx.builder.emitExternProp(className, propName, recv, resultType);
  });

  return cx.builder.emitIfElse({
    cond,
    then: thenBody,
    thenValue,
    else: elseBody,
    elseValue,
    resultType,
  });
}

/**
 * #3000 — map a property name to the struct-slot key the class registry uses.
 * A `PrivateIdentifier` (`#x`) is mangled to `__priv_x`, byte-for-byte matching
 * the legacy `resolveClassMemberName` (`src/codegen/class-bodies.ts`) so the IR
 * `class.get`/`class.set` resolve the identical `structFields` slot the legacy
 * path allocated. A plain `Identifier` passes through unchanged.
 */
function irPrivateFieldName(name: ts.Identifier | ts.PrivateIdentifier): string {
  return ts.isPrivateIdentifier(name) ? "__priv_" + name.text.slice(1) : name.text;
}

/**
 * Lower a property access expression.
 *
 * Slice 1 (#1169a) handles `<string>.length` (the only `.length` form
 * relevant before slice 2). Slice 2 (#1169b) extends to named property
 * reads on `IrType.object` receivers — the lowerer resolves the field
 * by name against the receiver shape's canonical field list and emits
 * `object.get`.
 *
 * Receivers of any other IrType (boxed, union, val with non-string
 * representation) are out of slice 2's scope and throw, so the
 * containing function falls back to legacy.
 */
function lowerPropertyAccess(expr: ts.PropertyAccessExpression, cx: LowerCtx): IrValueId {
  // #3000 — private-field read (`this.#x`). A PrivateIdentifier is not an
  // Identifier, so the pre-#3000 guard rejected it. Private names lower to the
  // SAME mangled struct-slot key the legacy path registers
  // (`resolveClassMemberName`: `#x` → `__priv_x`), so the class shape / fieldIdx
  // resolve the identical slot. Only class receivers carry private slots; on any
  // other receiver kind the mangled name won't be found and the function
  // demotes to legacy cleanly.
  if (!ts.isIdentifier(expr.name) && !ts.isPrivateIdentifier(expr.name)) {
    throw new Error(`ir/from-ast: computed property access not in slice 2 (${cx.funcName})`);
  }
  const propName = irPrivateFieldName(expr.name);

  // Receiver type is unknown until we lower it; pass an f64 hint (the
  // numeric default) and inspect the resulting IrType. The hint is
  // advisory — string / object lowerings ignore it.
  const recv = lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);

  // Optional chaining (`obj?.prop`, #1281). For receivers whose lowered
  // IrType is provably non-null (struct shapes, class instances, strings,
  // non-null refs), `?.` is redundant safety syntax and we lower it like
  // a regular `.` access. For genuinely nullable IrTypes the path
  // depends on the receiver kind:
  //
  //   - TS-narrowing fast-path (#1375 Slice A): when TypeScript proves
  //     the expression's type is non-null (`getNonNullableType(t) === t`),
  //     fall through to the regular `.` access — `Map<...>` without
  //     `| undefined` is a common case the IR's conservative
  //     `isIrTypeNullable` flags as nullable but TS proves safe.
  //   - Extern host-class receiver (#1375 Slice B): use the new (#1392)
  //     `emitIfElse` + `emitRefIsNull` IR primitives to short-circuit.
  //     Returns the property's value when the receiver is non-null, or
  //     a null/NaN sentinel of the property's IrType when null.
  //   - Other nullable kinds (raw externref, ref_null val): still throw
  //     to legacy fallback, where `compileOptionalPropertyAccess`
  //     already emits a Wasm-level `if/else` null-guarded access. The
  //     IR doesn't yet have a unified prop-access dispatch for those.
  if (expr.questionDotToken && isIrTypeNullable(recvType)) {
    const tsNonNull = cx.resolver?.isExpressionTsNonNullable?.(expr.expression) === true;
    if (tsNonNull) {
      // Fall through: TS-proven non-null → lower as ordinary `.prop` access.
    } else if (recvType.kind === "extern") {
      // Slice B — IR-native short-circuit on extern receivers.
      return lowerOptionalExternPropertyAccess(propName, recv, recvType, cx);
    } else {
      throw new Error(`ir/from-ast: optional chaining (?.) on nullable receiver not in slice 11 (${cx.funcName})`);
    }
  }

  if (recvType.kind === "string") {
    // Slice 1 — only `.length` is supported on string receivers.
    if (propName !== "length") {
      throw new Error(`ir/from-ast: .${propName} on string is not in slice 2 (${cx.funcName})`);
    }
    return cx.builder.emitStringLen(recv);
  }

  if (recvType.kind === "object") {
    // Slice 2 — named field read on a known shape.
    const fieldIdx = recvType.shape.fields.findIndex((f) => f.name === propName);
    if (fieldIdx < 0) {
      throw new Error(
        `ir/from-ast: object has no field "${propName}" (shape: ${describeIrType(recvType)}) in ${cx.funcName}`,
      );
    }
    const fieldType = recvType.shape.fields[fieldIdx]!.type;
    return cx.builder.emitObjectGet(recv, propName, fieldType);
  }

  if (recvType.kind === "class") {
    // Slice 4 (#1169d) — named field read on a class instance. Static
    // resolution: look up `propName` against the class shape's field
    // list. Methods are not readable as bare property access in slice 4
    // (no method-as-value); only call expressions resolve them.
    const field = recvType.shape.fields.find((f) => f.name === propName);
    if (!field) {
      throw new Error(`ir/from-ast: class ${recvType.shape.className} has no field "${propName}" in ${cx.funcName}`);
    }
    return cx.builder.emitClassGet(recv, propName, field.type);
  }

  if (recvType.kind === "extern") {
    // Slice 10 (#1169i), widened by #2856 — extern-class property read with
    // inheritance-chain resolution. The instr's className must be the
    // DEFINING class (the import is `<definer>_get_<prop>`, e.g.
    // `Node_appendChild` for an `Element` receiver), which the chain walk
    // returns as `importPrefix`. Result branding (#2856): an externref-shaped
    // property whose USE-SITE type names an extern class becomes
    // `IrType.extern { className }`, so chained access
    // (`document.body.appendChild(...)`, `e.style.cssText = ...`) keeps
    // dispatching through the extern arms.
    const className = recvType.className;
    const resolved = cx.resolver?.resolveExternMember?.(className, propName, "property", expr);
    if (resolved?.property) {
      const resultType: IrType = resolved.resultClassName
        ? { kind: "extern", className: resolved.resultClassName }
        : irVal(resolved.property.type);
      return cx.builder.emitExternProp(resolved.importPrefix, propName, recv, resultType);
    }
    // Flat (own-class) lookup for resolvers that don't implement the #2856
    // chain walk — preserves the pre-#2856 slice-10 behaviour.
    const info = cx.resolver?.getExternClassInfo?.(className);
    if (!info) {
      throw new Error(`ir/from-ast: extern class ${className} not registered in ${cx.funcName}`);
    }
    const prop = info.properties.get(propName);
    if (!prop) {
      throw new Error(`ir/from-ast: extern class ${className} has no property "${propName}" in ${cx.funcName}`);
    }
    return cx.builder.emitExternProp(className, propName, recv, irVal(prop.type));
  }

  // Slice 13 (#1169p) — vec-shaped receiver (`number[]`, `string[]`, …):
  // support `.length` (the only structural property a vec carries).
  // Other Array prototype properties are non-existent in TS so this
  // branch only fires for `.length`. Method dispatch (`arr.push(...)`,
  // `arr.map(...)`, etc.) is handled in `lowerMethodCall`.
  const recvVal = asVal(recvType);
  if (recvVal && (recvVal.kind === "ref" || recvVal.kind === "ref_null")) {
    const vec = cx.resolver?.resolveVec?.(recvVal);
    if (vec) {
      if (propName === "length") {
        return cx.builder.emitVecLen(recv);
      }
      throw new Error(`ir/from-ast: .${propName} on vec not in slice 13 (${cx.funcName})`);
    }
  }

  // #3053 U1 / #2949 S5.4 — named read `recv.name` on a boxed-any (dynamic)
  // receiver: route through the unified reader primitive
  // `__dyn_member_get(recv, key)` (#3053 U0). The receiver already IS the
  // carrier; the key is the property name boxed as a tag-5 string carrier, so
  // the helper's own `__any_to_extern(key)` yields the property key. The result
  // is the identity-preserving, tag-honest carrier (`dynamic`) — the S5.4
  // carrier-impedance blocker is dissolved.
  //
  // MECHANISM ONLY: the selector's move-only scan (`select.ts`
  // `dynamicUsesAreMoveOnly`) still REJECTS a dyn receiver in a member read, so
  // no claimed function reaches this arm until S5.P (U2) opens the scan — it is
  // wired but unreached (byte-inert). It replaces the prior unconditional throw
  // for a dynamic receiver, which — being a claim-then-demote the selector
  // never actually produces — was itself unreachable in a claimed function.
  if (recvType.kind === "dynamic") {
    const key = cx.builder.emitBox(cx.builder.emitStringConst(propName), irDynamic(JsTag.String));
    return cx.builder.emitDynMemberGet(recv, key);
  }

  throw new Error(
    `ir/from-ast: property access .${propName} on ${describeIrType(recvType)} is not in slice 2 (${cx.funcName})`,
  );
}

/**
 * Lower an object literal to an IR `object.new`. The shape is derived
 * from the literal's properties: each PropertyAssignment /
 * ShorthandPropertyAssignment contributes one field. Field types come
 * from the lowered initializer's IrType (no TS-checker introspection
 * — we're already past type resolution by the time we lower).
 *
 * The shape is sorted by name AFTER lowering so the canonical form
 * compares equal across literals with different syntactic ordering. The
 * value list is reordered to match.
 */
function lowerObjectLiteral(expr: ts.ObjectLiteralExpression, cx: LowerCtx): IrValueId {
  if (expr.properties.length === 0) {
    throw new Error(`ir/from-ast: empty object literal not in slice 2 (${cx.funcName})`);
  }
  const built: { name: string; type: IrType; value: IrValueId }[] = [];
  const seen = new Set<string>();
  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = phase1PropertyName(prop.name);
      if (name === null) {
        throw new Error(`ir/from-ast: object literal property name not in slice 2 (${cx.funcName})`);
      }
      if (seen.has(name)) {
        throw new Error(`ir/from-ast: duplicate object literal key "${name}" not in slice 2 (${cx.funcName})`);
      }
      seen.add(name);
      const v = lowerExpr(prop.initializer, cx, irVal({ kind: "f64" }));
      const type = cx.builder.typeOf(v);
      built.push({ name, type, value: v });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name.text;
      if (seen.has(name)) {
        throw new Error(`ir/from-ast: duplicate object literal key "${name}" not in slice 2 (${cx.funcName})`);
      }
      seen.add(name);
      const found = cx.scope.get(name);
      if (!found) {
        throw new Error(`ir/from-ast: shorthand "${name}" not in scope in ${cx.funcName}`);
      }
      // Slice 3 (#1169c): only `local`-kind bindings are usable as
      // shorthand object property values. nestedFunc bindings have no
      // SSA value.
      if (found.kind !== "local") {
        throw new Error(`ir/from-ast: shorthand "${name}" refers to a non-local binding (${cx.funcName})`);
      }
      // If the local is refcell-typed, deref to expose the inner scalar
      // (the same logic the identifier-handler in lowerExpr applies).
      if (found.type.kind === "boxed") {
        const v = cx.builder.emitRefCellGet(found.value, found.type.inner);
        built.push({ name, type: cx.builder.typeOf(v), value: v });
      } else {
        built.push({ name, type: found.type, value: found.value });
      }
      continue;
    }
    throw new Error(`ir/from-ast: object literal element ${ts.SyntaxKind[prop.kind]} not in slice 2 (${cx.funcName})`);
  }
  built.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const shape: IrObjectShape = {
    fields: built.map((b) => ({ name: b.name, type: b.type })),
  };
  return cx.builder.emitObjectNew(
    shape,
    built.map((b) => b.value),
  );
}

/**
 * #2766 — IR counterpart of legacy `isSafeBoundsEliminated`
 * (`src/codegen/property-access.ts`). The index `arr[i]` is proven in
 * `[0, array.length)` iff both `arr` and `i` are simple identifiers and the pair
 * was recorded by `detectCountedLoopSafeIndex` on the enclosing loop body's cx.
 */
function isProvenInBoundsIr(expr: ts.ElementAccessExpression, cx: LowerCtx): boolean {
  if (!cx.safeIndexedArrays || cx.safeIndexedArrays.size === 0) return false;
  if (!ts.isIdentifier(expr.expression) || !ts.isIdentifier(expr.argumentExpression)) return false;
  return cx.safeIndexedArrays.has(expr.expression.text + ":" + expr.argumentExpression.text);
}

/**
 * #2766 — the SAFE (hybrid-invariant default) bounds-checked vec read. Emits
 * `inBounds ? vec.get(idx) : <JS-correct OOB default>` so an out-of-bounds index
 * NEVER traps — the IR counterpart of #2760's legacy floor F1
 * (`emitPlainArrayUndefinedOobGet`). The read result type is UNCHANGED from the
 * fast `emitVecGet` (the element ValType), so there is **no downstream type
 * cascade**: only the runtime semantics change (trap → JS-correct value).
 *
 * Element-kind dispatch for the OOB default (mirrors
 * `lowerOptionalExternPropertyAccess`'s sentinel table, and legacy's
 * `emitBoundsCheckedArrayGet(useUndefinedSentinel=false)` type-defaults):
 *   - `f64`       → `f64.const NaN` — `ToNumber(undefined)` is NaN, the
 *                   JS-correct image of an OOB read in the numeric context the IR
 *                   retains a primitive read in. (A `number[]` read whose result
 *                   must be *observed* as `undefined` flows to an `any`/externref
 *                   sink, which has no IR box primitive and already demotes the
 *                   whole function to legacy F1 — so NaN here is never observed
 *                   as a wrong `undefined`.) Stays UNBOXED: no late import is
 *                   added, so the R1 Math.* funcIdx-shift miscompile cannot recur.
 *   - `i32`       → `i32.const 0` — `ToBoolean(undefined)` is false (0) for
 *                   `boolean[]`; 0 for an i32-specialized numeric read.
 *   - `externref` → `ref.null.extern` — matches legacy's *non-widened* externref
 *                   OOB default (JS `null`). Full externref OOB→`undefined` is
 *                   the documented R1-deferred follow-up (it trips the
 *                   map-on-array-like canary `15.4.4.19-8-b-2.js` via a separate
 *                   length bug); matching legacy here keeps that canary green.
 *   - `ref_null`  → `ref.null` of the element heap type.
 *   - other (non-null `ref`, `i64`, packed `i8`/`i16`, `f32`, …) → demote to
 *     legacy (throw): a null-ish default isn't expressible in an `if`-arm without
 *     widening the result to `ref_null`, which WOULD cascade to consumers (the
 *     same limitation `lowerOptionalExternPropertyAccess` documents). Legacy
 *     bounds-checks all element kinds (returns the type-default, never traps), so
 *     the demote is still trap-free.
 */
function emitSafeVecGet(recv: IrValueId, idxI32: IrValueId, elemValType: ValType, cx: LowerCtx): IrValueId {
  const elemIr = irVal(elemValType);
  let makeOobDefault: (() => IrValueId) | null = null;
  switch (elemValType.kind) {
    case "f64":
      makeOobDefault = () => cx.builder.emitConst({ kind: "f64", value: NaN }, elemIr);
      break;
    case "i32":
      makeOobDefault = () => cx.builder.emitConst({ kind: "i32", value: 0 }, elemIr);
      break;
    case "externref":
    case "ref_null":
      makeOobDefault = () => cx.builder.emitConst({ kind: "null", ty: elemIr }, elemIr);
      break;
    default:
      throw new Error(
        `ir/from-ast: SAFE OOB vec read for element kind '${elemValType.kind}' needs legacy ` +
          `(no in-arm default without a result-type widen) in ${cx.funcName}`,
      );
  }

  // cond = (unsigned) idx < len. `emitVecLen` yields an f64 JS length; convert
  // back to i32 for the unsigned compare. A negative index wraps to a huge
  // unsigned value > any length, so it lands in the OOB arm (JS-correct: a plain
  // array reads a negative index as `undefined`). The comparison uses the SAME
  // truncated i32 index the read uses, so it agrees with the read exactly.
  const lenF64 = cx.builder.emitVecLen(recv);
  const lenI32 = cx.builder.emitUnary("i32.trunc_sat_f64_s", lenF64, irVal({ kind: "i32" }));
  const cond = cx.builder.emitBinary("i32.lt_u", idxI32, lenI32, irVal({ kind: "i32" }));

  // then arm: in-bounds → the unchecked vec.get (provably safe inside this arm).
  let thenValue!: IrValueId;
  const thenBody = cx.builder.collectBodyInstrs(() => {
    thenValue = cx.builder.emitVecGet(recv, idxI32, elemIr);
  });
  // else arm: OOB → the JS-correct default (pure const; no late import).
  let elseValue!: IrValueId;
  const elseBody = cx.builder.collectBodyInstrs(() => {
    elseValue = makeOobDefault!();
  });

  return cx.builder.emitIfElse({
    cond,
    then: thenBody,
    thenValue,
    else: elseBody,
    elseValue,
    resultType: elemIr,
  });
}

/**
 * Lower an element access whose argument is a string literal — sugar
 * for property access on a known shape. Numeric / computed keys are
 * out of slice 2's scope and throw, so the function falls back to
 * legacy.
 */
/**
 * (#2856 C2) Lower an element STORE `arr[i] = v;` in statement position —
 * the write dual of `lowerElementAccess`'s vec arm. Dispatches to the
 * per-vec-type `__vec_elem_set_<vecTypeIdx>` helper (materialized on demand
 * by the resolver's `resolveFunc`, see src/codegen/vec-elem-set.ts), which
 * carries the FULL legacy semantics: null-guard, grow-on-OOB (capacity
 * doubling + data copy), the store, and the JS length update. A bare
 * `array.set` would trap on the growing-write pattern (`a[i] = v` past the
 * end), which is common in newly-claimed code — so the helper is the only
 * sound lowering.
 *
 * Demotes (clean throw → legacy) for: TypedArray-view receivers (per-view
 * conversion semantics — ToUint8/clamp/packing), non-vec receivers
 * (externref objects, strings), packed/exotic element kinds, and value
 * types that don't coerce to the element type.
 */
function lowerElementStore(lhs: ts.ElementAccessExpression, rhs: ts.Expression, cx: LowerCtx): void {
  if (lhs.questionDotToken) {
    throw new Error(`ir/from-ast: optional element store (a?.[i] = v) not in IR scope (${cx.funcName})`);
  }
  // TypedArray views need the legacy per-view value conversions.
  if (cx.resolver?.isTypedArrayViewExpr?.(lhs.expression)) {
    throw new Error(`ir/from-ast: element store on a TypedArray view not in IR scope (${cx.funcName})`);
  }
  const recv = lowerExpr(lhs.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);
  const recvVal = asVal(recvType);
  if (!recvVal || (recvVal.kind !== "ref" && recvVal.kind !== "ref_null")) {
    throw new Error(`ir/from-ast: element store on ${describeIrType(recvType)} not in IR scope (${cx.funcName})`);
  }
  const vec = cx.resolver?.resolveVec?.(recvVal);
  if (!vec) {
    throw new Error(`ir/from-ast: element-store receiver is not a recognisable vec in ${cx.funcName}`);
  }
  const elem = vec.elementValType;
  // Narrow slice: f64 vecs (number[]) and externref vecs (string[]/any[] in
  // host mode). Native-string / packed / exotic element vecs demote.
  if (elem.kind !== "f64" && elem.kind !== "externref") {
    throw new Error(`ir/from-ast: element store into '${elem.kind}' vec not in IR scope (${cx.funcName})`);
  }
  // Index — the same f64-lower + trunc_sat discipline as the read path.
  const idxRaw = lowerExpr(lhs.argumentExpression, cx, irVal({ kind: "f64" }));
  const idxTy = asVal(cx.builder.typeOf(idxRaw));
  let idxI32: IrValueId;
  if (idxTy?.kind === "i32") {
    idxI32 = idxRaw;
  } else if (idxTy?.kind === "f64") {
    idxI32 = cx.builder.emitUnary("i32.trunc_sat_f64_s", idxRaw, irVal({ kind: "i32" }));
  } else {
    throw new Error(`ir/from-ast: element-store index must be number or bool in ${cx.funcName}`);
  }
  // Value — lower with the element-type hint, then coerce.
  const valRaw = lowerExpr(rhs, cx, irVal(elem));
  let val: IrValueId;
  if (elem.kind === "f64") {
    const valTy = asVal(cx.builder.typeOf(valRaw));
    if (valTy?.kind !== "f64") {
      throw new Error(
        `ir/from-ast: element-store value ${describeIrType(cx.builder.typeOf(valRaw))} into f64 vec ` +
          `not in IR scope (${cx.funcName})`,
      );
    }
    val = valRaw;
  } else {
    val = coerceToExpectedExtern(valRaw, elem, cx, `element-store value`);
  }
  // The helper name embeds the vec STRUCT typeIdx; the lower-time resolver
  // intercepts the prefix and materializes the helper on demand (name-based
  // resolution — funcIdx-shift safe by construction).
  cx.builder.emitCall({ kind: "func", name: `__vec_elem_set_${vec.vecStructTypeIdx}` }, [recv, idxI32, val], null);
}

function lowerElementAccess(expr: ts.ElementAccessExpression, cx: LowerCtx): IrValueId {
  // #2713 — `a?.[i]` carries a `questionDotToken`: on a `null`/`undefined`
  // receiver the access must short-circuit to `undefined`, not index it.
  // The element-access lowering below ignores the token and emits an
  // unconditional `vec.get` (or object field read), which TRAPS on a null
  // receiver instead of yielding `undefined`. Optional chaining is
  // explicitly out of slice scope (#1169n: "Optional chaining `?.` / `?.()`
  // — need null-guard branching"), so demote the whole function to legacy,
  // which has the runtime null-guard. (Same demote-to-legacy discipline the
  // property-access optional arm already follows.)
  if (expr.questionDotToken) {
    throw new Error(`ir/from-ast: optional element access (a?.[i]) not in IR scope (${cx.funcName})`);
  }
  const arg = expr.argumentExpression;
  const isStringLitKey = ts.isStringLiteral(arg) || arg.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral;
  // Lower the receiver first so we can dispatch by its IrType.
  const recv = lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);

  // Slice 2 — string-literal key on an object-shaped receiver: read the
  // named field. This path matches `obj["fieldName"]` ≡ `obj.fieldName`.
  if (isStringLitKey && recvType.kind === "object") {
    const propName = (arg as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text;
    const fieldIdx = recvType.shape.fields.findIndex((f) => f.name === propName);
    if (fieldIdx < 0) {
      throw new Error(
        `ir/from-ast: object has no field "${propName}" (shape: ${describeIrType(recvType)}) in ${cx.funcName}`,
      );
    }
    const fieldType = recvType.shape.fields[fieldIdx]!.type;
    return cx.builder.emitObjectGet(recv, propName, fieldType);
  }

  // Slice 12 (#1169o) — dynamic element access on a vec receiver.
  // The receiver's ValType must resolve to a vec via the resolver; the
  // index is lowered as f64 (JS Number) and truncated to i32 for the
  // backend `vec.get`.
  //
  // (#2766 — hybrid prove-then-specialize) The read is FAST (an unchecked
  // `vec.get`/`array.get`, which traps on OOB) ONLY when the index is *proven*
  // in `[0, length)` (the counted-loop proof ported from legacy
  // `safeIndexedArrays`). Otherwise it falls to the SAFE bounds-checked read
  // (`emitSafeVecGet`) that returns the JS-correct OOB value instead of
  // trapping. This retires the old "slice 12 trusts the type / the selector
  // keeps OOB functions in legacy" assumption: the trapping read was the
  // sharpest hybrid-invariant violation (strictly worse than legacy, which at
  // least bounds-checks and returns a sentinel).
  const recvVal = asVal(recvType);
  if (recvVal && (recvVal.kind === "ref" || recvVal.kind === "ref_null")) {
    const vec = cx.resolver?.resolveVec?.(recvVal);
    if (vec) {
      // Lower the index expression as f64 (JS Number semantics), then
      // truncate to i32 via the new `i32.trunc_sat_f64_s` IrUnop (slice
      // 12). Saturation handles NaN→0 and out-of-range values, matching
      // what test262's typical `arr[i]` patterns expect (i is always a
      // valid array index for IR-claimable functions).
      const idxF64 = lowerExpr(arg, cx, irVal({ kind: "f64" }));
      const idxF64Type = cx.builder.typeOf(idxF64);
      const idxValTy = asVal(idxF64Type);
      if (!idxValTy) {
        throw new Error(
          `ir/from-ast: element-access index has unexpected IrType ${describeIrType(idxF64Type)} in ${cx.funcName}`,
        );
      }
      let idxI32: IrValueId;
      if (idxValTy.kind === "i32") {
        // Already i32 (e.g. a comparison or bool result — unusual but
        // possible for compound expressions). Use directly.
        idxI32 = idxF64;
      } else if (idxValTy.kind === "f64") {
        idxI32 = cx.builder.emitUnary("i32.trunc_sat_f64_s", idxF64, irVal({ kind: "i32" }));
      } else {
        throw new Error(
          `ir/from-ast: element-access index must be number or bool (got ${idxValTy.kind}) in ${cx.funcName}`,
        );
      }
      const elemIr = irVal(vec.elementValType);
      // FAST path — proven in-bounds (counted-loop proof) → unchecked read.
      if (isProvenInBoundsIr(expr, cx)) {
        return cx.builder.emitVecGet(recv, idxI32, elemIr);
      }
      // SAFE path — index not proven → bounds-checked read, no trap.
      return emitSafeVecGet(recv, idxI32, vec.elementValType, cx);
    }
  }

  // (#2972) String receiver with a PROVEN-in-bounds computed index: lower
  // through the SAME charAt machinery as `s.charAt(i)`. For an integer index
  // i with 0 ≤ i < s.length, `s[i]` ≡ `s.charAt(i)` exactly (§22.1.3.1 vs
  // §10.4.3 String-exotic indexed access — both yield the single code unit).
  // The PROOF is what makes typing the result `string` sound: an UNPROVEN
  // index could be out of bounds, where `s[i]` is `undefined` but charAt is
  // `""` — that residual deliberately stays on the demote path below (the
  // documented element-access claim-partial residual; see
  // plan/issues/2972-*.md for the widen-to-undefined alternative that was
  // rejected). Proof = receiver is a never-reassigned local bound to a
  // string literal (statically known length, `cx.stringLiteralLens`) AND the
  // index is a non-negative integer literal < len, or bit-masked by `& K`
  // with K < len (JS `x & K` = ToInt32 each, so for 0 ≤ K ≤ 2^31−1 the
  // result's set bits ⊆ K's bits ⇒ result ∈ [0, K] — the test262 harness
  // shape `hex[(n >> 4) & 0xf]` on a 16-char literal). BOTH lanes' helpers
  // are pre-registered by the #2972 element-access arm of the unified
  // collector scan (`declarations.ts`): it adds "charAt" to
  // `stringMethodNeeded`, whose finalize loop registers the `string_charAt`
  // env import (host lane) or calls `ensureNativeStringHelpers` for
  // `__str_charAt` (native lane) — no late-import shift at IR lower time.
  if (recvType.kind === "string" && ts.isIdentifier(expr.expression)) {
    const litLen = cx.stringLiteralLens?.get(expr.expression.text);
    if (litLen !== undefined && stringIndexProvenBelow(arg, litLen)) {
      const r = lowerStringMethodCall("charAt", recv, ts.factory.createNodeArray([arg]), cx);
      if (r !== null) return r;
      throw new Error(`ir/from-ast: internal — charAt delegation produced no value in ${cx.funcName}`);
    }
  }

  // #3053 U1 / #2949 S5.4 — indexed read `recv[key]` on a boxed-any (dynamic)
  // receiver: route through the unified reader primitive
  // `__dyn_member_get(recv, key)` (#3053 U0). A string-literal key boxes as a
  // tag-5 string carrier; any other key is lowered concrete and boxed
  // (`boxConcreteToDynamic` — a numeric index boxes tag-3, and the helper's own
  // `__any_to_extern(key)` converts it to the decimal property key). `null` box
  // (an ambiguous key kind) demotes cleanly to the throw below.
  //
  // MECHANISM ONLY (see the twin arm in `lowerPropertyAccess`): the selector's
  // move-only scan rejects a dyn receiver in an element read until S5.P (U2),
  // so this arm is unreached in a claimed function today — byte-inert.
  if (recvType.kind === "dynamic") {
    let key: IrValueId | null;
    if (isStringLitKey) {
      const propName = (arg as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text;
      key = cx.builder.emitBox(cx.builder.emitStringConst(propName), irDynamic(JsTag.String));
    } else {
      const idx = lowerExpr(arg, cx, irVal({ kind: "f64" }));
      const idxType = cx.builder.typeOf(idx);
      key = idxType.kind === "dynamic" ? idx : boxConcreteToDynamic(idx, idxType, arg, cx);
    }
    if (key !== null) {
      return cx.builder.emitDynMemberGet(recv, key);
    }
  }

  throw new Error(
    `ir/from-ast: element access on ${describeIrType(recvType)} with index ${ts.SyntaxKind[arg.kind]} not in slice 12 (${cx.funcName})`,
  );
}

/**
 * Resolve an object literal property name to a string. Identifier and
 * StringLiteral keys produce their text. NumericLiteral keys produce
 * the canonical JS toString of the number. ComputedPropertyName always
 * returns null. Duplicated locally from select.ts to avoid a circular
 * import.
 */
function phase1PropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

/**
 * Lower a direct call to a locally-declared function. The callee's signature
 * comes from `calleeTypes` (seeded by the Phase-2 TypeMap via the caller).
 * If the callee isn't in the map, the selector's call-graph closure was
 * violated — we throw so the caller can fall back to the legacy path.
 *
 * Arg type mismatch is fatal too: the selector is supposed to keep the
 * whole strongly-connected component on the IR path only when the types
 * are consistent. If we land here with a mismatch, the TypeMap was stale
 * or the propagation pass converged on a dynamic type that the selector
 * ignored — both are bugs.
 */
/**
 * #3000-E: the SSA value of the current `this` binding (the allocated instance
 * in a ctor, or the `__self` param in a method). Throws if `this` isn't bound —
 * `super` outside a class member never reaches here (the selector rejects it).
 */
function requireThisValue(cx: LowerCtx): IrValueId {
  const p = cx.scope.get("this");
  if (!p || p.kind !== "local") {
    throw new Error(`ir/from-ast: super used with no 'this' binding in ${cx.funcName}`);
  }
  return p.value;
}

/**
 * #3000-E: the parent `IrClassShape` for a `super(...)` / `super.method()` in the
 * current class member. Read from the `this` binding's class shape `.parent`,
 * which `buildIrClassShapes` populates only for a single-level subclass of a
 * local user class. Throws (→ clean legacy fallback) when absent — e.g. a
 * subclass whose parent's shape didn't project.
 */
function requireSuperParentShape(cx: LowerCtx): IrClassShape {
  const p = cx.scope.get("this");
  if (!p || p.kind !== "local" || p.type.kind !== "class") {
    throw new Error(`ir/from-ast: super used with no class 'this' binding in ${cx.funcName}`);
  }
  const parent = p.type.shape.parent;
  if (!parent) {
    throw new Error(
      `ir/from-ast: super used in ${p.type.shape.className} which has no IR-projected parent shape (${cx.funcName})`,
    );
  }
  return parent;
}

function lowerCall(expr: ts.CallExpression, cx: LowerCtx, statementPosition = false): IrValueId | null {
  // Optional call (`fn?.()` / `obj?.method()`, #1281). The IR has no
  // short-circuit primitive for nullable callees, and at this point we
  // haven't yet lowered the callee/receiver to inspect its IrType. The
  // safe path is to throw to legacy, where `compileOptionalCallExpression`
  // already emits the null-guarded `if/else` block. The optional
  // PROPERTY-ACCESS path (`obj?.prop`) gets the IR fast-path; full
  // optional-call IR support is a follow-up.
  if (expr.questionDotToken) {
    throw new Error(`ir/from-ast: optional call (?.()) not in slice 11 (${cx.funcName})`);
  }
  // #3000-E: `super(args)` — a derived constructor chaining to its parent's
  // `_init`. Intercepted BEFORE the property-access / identifier dispatch below
  // because `super` is a keyword, not an identifier the receiver-lowering can
  // handle. The `this` binding (the allocated subclass instance) and the parent
  // shape (`this` shape's `.parent`) drive the emitted `<parent>_init` call.
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    const parentShape = requireSuperParentShape(cx);
    const self = requireThisValue(cx);
    if (expr.arguments.length !== parentShape.constructorParams.length) {
      throw new Error(
        `ir/from-ast: super(...) has ${expr.arguments.length} args, expected ${parentShape.constructorParams.length} in ${cx.funcName}`,
      );
    }
    const args: IrValueId[] = [];
    for (let i = 0; i < expr.arguments.length; i++) {
      const expected = parentShape.constructorParams[i]!;
      const argVal = lowerExpr(expr.arguments[i]!, cx, expected);
      const argType = cx.builder.typeOf(argVal);
      if (!irTypeEquals(argType, expected)) {
        throw new Error(
          `ir/from-ast: super() arg ${i} is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
        );
      }
      args.push(argVal);
    }
    cx.builder.emitClassSuperInit(parentShape, self, args);
    return null;
  }
  // Slice 4 (#1169d): method call — `<recv>.<methodName>(args)`. The
  // receiver must lower to an IrType.class; the method must exist on
  // the class shape and be non-void (slice 4 only handles methods with
  // a returning result in expression position).
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const r = lowerMethodCall(expr, cx);
    if (r === null) {
      // Unreachable: in expression position (statementPosition=false) every
      // void arm throws before returning null (#2856 added the null returns
      // for statement position only).
      throw new Error(`ir/from-ast: method call produced no result in expression position (${cx.funcName})`);
    }
    return r;
  }
  if (!ts.isIdentifier(expr.expression)) {
    throw new Error(`ir/from-ast: only direct calls supported in Phase 2 (${cx.funcName})`);
  }
  const calleeName = expr.expression.text;

  // Slice 3 (#1169c): local-binding lookups WIN over top-level callees
  // because the source-level identifier resolution puts inner-scope
  // names first. The dispatcher picks one of three paths:
  //   - `local` binding whose IrType is closure → closure.call
  //   - `nestedFunc` binding → direct call with prepended captures
  //   - top-level callee in calleeTypes → vanilla `call`
  const binding = cx.scope.get(calleeName);
  if (binding?.kind === "local" && binding.type.kind === "closure") {
    return lowerClosureCall(binding.value, binding.type.signature, expr.arguments, cx);
  }
  if (binding?.kind === "nestedFunc") {
    return lowerNestedFuncCall(binding, expr.arguments, cx);
  }

  const calleeSig = cx.calleeTypes?.get(calleeName);
  if (!calleeSig) {
    throw new Error(`ir/from-ast: call to unknown function "${calleeName}" in ${cx.funcName}`);
  }
  // Slice 8a (#1169g): spread args with statically-known sources
  // (ArrayLiteralExpression with no nested spread). Expand at compile
  // time to one IR arg per literal element. The pre-expansion arity
  // check below counts spread elements as their literal element count.
  const expandedArgExprs = expandStaticSpreadArgs(expr.arguments, cx);
  if (expandedArgExprs.length !== calleeSig.params.length) {
    throw new Error(
      `ir/from-ast: call to ${calleeName} has ${expandedArgExprs.length} args, expected ${calleeSig.params.length} in ${cx.funcName}`,
    );
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < expandedArgExprs.length; i++) {
    const argExpr = expandedArgExprs[i]!;
    const expected = calleeSig.params[i]!;
    const argVal = lowerExpr(argExpr, cx, expected);
    const argType = cx.builder.typeOf(argVal);
    if (!irTypeArgAssignable(argType, expected)) {
      throw new Error(
        `ir/from-ast: arg ${i} of call to ${calleeName} is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  const result = cx.builder.emitCall({ kind: "func", name: calleeName }, args, calleeSig.returnType);
  if (result === null) {
    // (#2856 C4) `quicksort(arr, lo, p - 1);` — a void direct call in
    // STATEMENT position is legal (the recursion driver shape). Expression
    // position keeps throwing.
    if (statementPosition) return null;
    throw new Error(`ir/from-ast: call to ${calleeName} returned void used as expression in ${cx.funcName}`);
  }
  return result;
}

/**
 * (#2856 C4) Wasm-level assignability for direct-call arguments. Exact
 * IrType equality, plus the one sound widening the vec-literal-as-argument
 * shape needs: a NON-NULL `(ref $T)` value passed where the callee's param
 * is `(ref null $T)` — a Wasm subtype, so the call validates and the callee
 * observes the identical value. (`const sorted = [1, 3, 5]` produces
 * `(ref $vec_f64)` via `vec.new_fixed`; a `number[]` param resolves as
 * `(ref null $vec_f64)`.) The reverse (ref_null → ref) stays rejected.
 */
function irTypeArgAssignable(actual: IrType, expected: IrType): boolean {
  if (irTypeEquals(actual, expected)) return true;
  const a = asVal(actual);
  const e = asVal(expected);
  if (
    a !== null &&
    e !== null &&
    a.kind === "ref" &&
    e.kind === "ref_null" &&
    (a as { typeIdx: number }).typeIdx === (e as { typeIdx: number }).typeIdx
  ) {
    return true;
  }
  return false;
}

/**
 * Slice 8a (#1169g): expand spread args at compile time. The selector
 * (`isStaticSpreadSource`) restricts spread sources to
 * `ArrayLiteralExpression` with no nested SpreadElement, so each spread
 * arg has a known element count and we can inline its elements as
 * additional 1:1 args. Non-spread args pass through unchanged.
 *
 * The result is a parallel `Expression[]` whose length equals the
 * post-expansion arity. The caller's existing 1:1 `lowerExpr`-per-arg
 * loop runs against the returned array.
 *
 * Defensive: any spread whose source isn't an ArrayLiteral throws
 * (selector should have rejected, but a clean throw routes to legacy
 * if a regression slips in).
 */
function expandStaticSpreadArgs(args: readonly ts.Expression[], cx: LowerCtx): ts.Expression[] {
  const out: ts.Expression[] = [];
  for (const a of args) {
    if (ts.isSpreadElement(a)) {
      if (!ts.isArrayLiteralExpression(a.expression)) {
        throw new Error(
          `ir/from-ast: dynamic-length spread args not in slice 8a (${ts.SyntaxKind[a.expression.kind]} in ${cx.funcName})`,
        );
      }
      for (const e of a.expression.elements) {
        if (ts.isSpreadElement(e) || ts.isOmittedExpression(e)) {
          throw new Error(
            `ir/from-ast: nested spread / sparse element inside spread arg not in slice 8a (${cx.funcName})`,
          );
        }
        out.push(e);
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Slice 3 (#1169c): lower a call-by-value to a closure binding.
 * `callee` is the SSA value of the closure struct. The lowered
 * `closure.call` instr emits `<callee>; args; <callee>; struct.get
 * $func; call_ref` — the second `<callee>` use is forced into a Wasm
 * local by `collectIrUses`'s double count.
 */
function lowerClosureCall(
  callee: IrValueId,
  signature: IrClosureSignature,
  argExprs: readonly ts.Expression[],
  cx: LowerCtx,
): IrValueId {
  if (argExprs.length !== signature.params.length) {
    throw new Error(`ir/from-ast: closure call arity mismatch in ${cx.funcName}`);
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < argExprs.length; i++) {
    const expected = signature.params[i]!;
    const argVal = lowerExpr(argExprs[i]!, cx, expected);
    if (!irTypeEquals(cx.builder.typeOf(argVal), expected)) {
      throw new Error(
        `ir/from-ast: closure arg ${i} type mismatch (expected ${describeIrType(expected)}, got ${describeIrType(cx.builder.typeOf(argVal))}) in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  return cx.builder.emitClosureCall(callee, args, signature.returnType);
}

/**
 * Slice 3 (#1169c): lower a call to a nested function declaration.
 * Prepends capture args to the user args and emits a direct `call`
 * (no struct, no funcref) — matches the legacy
 * `compileNestedFunctionDeclaration` pattern.
 *
 * Mutable captures: if the outer hasn't already wrapped the variable
 * in a refcell (because no closure-VALUE has been built that captured
 * it as mutable), wrap it here and rebind `cx.scope[name]` so subsequent
 * outer reads/writes go through the cell.
 */
function lowerNestedFuncCall(
  binding: {
    kind: "nestedFunc";
    liftedName: string;
    signature: IrClosureSignature;
    captures: readonly NestedCapture[];
  },
  argExprs: readonly ts.Expression[],
  cx: LowerCtx,
): IrValueId {
  if (argExprs.length !== binding.signature.params.length) {
    throw new Error(`ir/from-ast: nested func call arity mismatch in ${cx.funcName}`);
  }
  const args: IrValueId[] = [];
  for (const cap of binding.captures) {
    const live = cx.scope.get(cap.name);
    if (cap.mutable) {
      if (live?.kind === "local" && live.type.kind === "boxed") {
        args.push(live.value);
      } else if (live?.kind === "local") {
        const innerVal = asVal(cap.type);
        if (!innerVal) {
          throw new Error(`ir/from-ast: mutable nested capture "${cap.name}" must be a primitive (${cx.funcName})`);
        }
        const cell = cx.builder.emitRefCellNew(live.value, innerVal);
        // #1926 — boxed.inner is an IrType; wrap the scalar ValType with irVal.
        cx.scope.set(cap.name, { kind: "local", value: cell, type: { kind: "boxed", inner: irVal(innerVal) } });
        args.push(cell);
      } else {
        throw new Error(`ir/from-ast: nested mutable capture "${cap.name}" not in scope (${cx.funcName})`);
      }
    } else {
      // Read-only capture — read the CURRENT value from outer scope. If
      // an earlier sibling's mutable capture upgraded the binding to a
      // refcell, deref through it.
      if (live?.kind === "local" && live.type.kind === "boxed") {
        const v = cx.builder.emitRefCellGet(live.value, live.type.inner);
        args.push(v);
      } else if (live?.kind === "local") {
        args.push(live.value);
      } else {
        throw new Error(`ir/from-ast: nested capture "${cap.name}" not in scope (${cx.funcName})`);
      }
    }
  }
  for (let i = 0; i < argExprs.length; i++) {
    const expected = binding.signature.params[i]!;
    const argVal = lowerExpr(argExprs[i]!, cx, expected);
    if (!irTypeEquals(cx.builder.typeOf(argVal), expected)) {
      throw new Error(
        `ir/from-ast: nested arg ${i} type mismatch (expected ${describeIrType(expected)}, got ${describeIrType(cx.builder.typeOf(argVal))}) in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  const r = cx.builder.emitCall({ kind: "func", name: binding.liftedName }, args, binding.signature.returnType);
  if (r === null) {
    throw new Error(`ir/from-ast: nested call returned void in ${cx.funcName}`);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Class lowering (#1169d — IR Phase 4 Slice 4)
// ---------------------------------------------------------------------------

/**
 * Slice 4 (#1169d): lower a `new ClassName(args)` expression.
 *
 * The class shape is looked up against `cx.classShapes`. Argument types
 * must match the constructor's declared `constructorParams`. Generic
 * type-arguments are not supported (the selector rejects them).
 *
 * Returns the SSA value of the constructed instance — its IrType is
 * `{ kind: "class", shape }` so subsequent property accesses / method
 * calls dispatch correctly.
 */
function lowerNewExpression(expr: ts.NewExpression, cx: LowerCtx): IrValueId {
  if (!ts.isIdentifier(expr.expression)) {
    throw new Error(`ir/from-ast: only direct constructor names supported in slice 4 (${cx.funcName})`);
  }
  const className = expr.expression.text;

  // Slice 10 (#1169i): host extern class (RegExp, Uint8Array, …) takes
  // priority over the slice-4 class registry — the legacy externClasses
  // map is the source of truth for built-in constructors. The result is
  // tagged as `IrType.extern { className }` so subsequent
  // `recv.method(...)` and `recv.prop` access can dispatch through the
  // extern path.
  const externInfo = cx.resolver?.getExternClassInfo?.(className);
  if (externInfo) {
    const argExprs = expr.arguments ?? [];
    // Constructor arity is permissive: the legacy host imports often
    // accept fewer args than `constructorParams` reports (the optional
    // / overload arms collapse). We don't enforce a strict equality
    // here — extra args are an error, but missing args silently pad
    // with sentinel values matching the legacy convention. For step A
    // (RegExp), `new RegExp(pattern)` and `new RegExp(pattern, flags)`
    // are both valid; for slice-10 step C (TypedArrays), `new
    // Uint8Array(N)` matches a single-param overload.
    if (argExprs.length > externInfo.constructorParams.length) {
      throw new Error(
        `ir/from-ast: new ${className}(...) has ${argExprs.length} args, max ${externInfo.constructorParams.length} in ${cx.funcName}`,
      );
    }
    const args: IrValueId[] = [];
    for (let i = 0; i < argExprs.length; i++) {
      const expectedTy = externInfo.constructorParams[i]!;
      const hint = irVal(expectedTy);
      const argVal = lowerExpr(argExprs[i]!, cx, hint);
      args.push(coerceToExpectedExtern(argVal, expectedTy, cx, `arg ${i} of new ${className}`));
    }
    // Pad missing optional args with default sentinels so the host
    // `<className>_new` import receives the right Wasm arity. Mirrors
    // the legacy `compileNewExpression` extern path (see
    // `src/codegen/expressions/new-super.ts:2200-2203`'s
    // `pushDefaultValue` loop). For step A (RegExp): missing flags arg
    // pads as `ref.null.extern`, which the host's `RegExp_new` stub
    // converts to `undefined` flags via the JS host import shim — JS
    // accepts `new RegExp(p, undefined)` as "no flags" while rejecting
    // `new RegExp(p, null)` as TypeError "Invalid flags 'null'". The
    // legacy uses `emitUndefinedValue` for the same reason; the IR
    // path leans on the host import shim's null-vs-undefined treatment
    // (the shim treats `ref.null.extern` as undefined).
    for (let i = argExprs.length; i < externInfo.constructorParams.length; i++) {
      const expectedTy = externInfo.constructorParams[i]!;
      args.push(emitDefaultExternArg(cx, expectedTy));
    }
    return cx.builder.emitExternNew(className, args);
  }

  const shape = cx.classShapes?.get(className);
  if (!shape) {
    throw new Error(`ir/from-ast: unknown class "${className}" in ${cx.funcName}`);
  }
  const argExprs = expr.arguments ?? [];
  if (argExprs.length !== shape.constructorParams.length) {
    throw new Error(
      `ir/from-ast: new ${className}(...) has ${argExprs.length} args, expected ${shape.constructorParams.length} in ${cx.funcName}`,
    );
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < argExprs.length; i++) {
    const expected = shape.constructorParams[i]!;
    const argVal = lowerExpr(argExprs[i]!, cx, expected);
    const argType = cx.builder.typeOf(argVal);
    if (!irTypeEquals(argType, expected)) {
      throw new Error(
        `ir/from-ast: arg ${i} of new ${className}(...) is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  return cx.builder.emitClassNew(shape, args);
}

/**
 * Slice 10 (#1169i) — coerce an SSA value to the ValType expected by an
 * extern-class import param. The legacy host imports take ValType-typed
 * params (most often `externref` for ref-shaped args, `f64` for numeric
 * args). The IR's static types may not match exactly:
 *   - `IrType.string` in host-strings mode is already externref → no-op.
 *   - `IrType.string` in native-strings mode is `(ref $AnyString)` → the
 *     verifier would reject the type mismatch, so for slice-10 we reject
 *     this case and fall back to legacy. (TODO follow-up: thread native-
 *     strings string args through `extern.convert_any` before the call.)
 *   - `IrType.extern { ... }` is externref → no-op when expected is
 *     externref.
 *   - `IrType.val { f64 }` matches `f64`.
 *   - Mismatches throw and the function falls back to legacy.
 *
 * Returns the (possibly identical) SSA value to push.
 */
/**
 * Slice 10 (#1169i) — emit a default sentinel SSA value for a missing
 * optional arg in an extern-class constructor or method call. Mirrors
 * `pushDefaultValue` in `src/codegen/type-coercion.ts:2093` for the
 * subset of ValTypes the IR's extern path encounters:
 *   - externref → `ref.null.extern` (host shim treats as `undefined`)
 *   - f64 → `0`
 *   - i32 → `0`
 *   - i64 → `0n`
 * Other ValTypes throw — slice 10 doesn't see them in the legacy
 * extern-class signatures we deal with.
 */
function emitDefaultExternArg(cx: LowerCtx, expected: ValType): IrValueId {
  switch (expected.kind) {
    case "externref":
      return cx.builder.emitConst({ kind: "null", ty: irVal(expected) }, irVal(expected));
    case "f64":
      return cx.builder.emitConst({ kind: "f64", value: 0 }, irVal(expected));
    case "i32":
      return cx.builder.emitConst({ kind: "i32", value: 0 }, irVal(expected));
    case "i64":
      return cx.builder.emitConst({ kind: "i64", value: 0n }, irVal(expected));
    default:
      throw new Error(`ir/from-ast: cannot pad default arg of type ${expected.kind} (${cx.funcName})`);
  }
}

function coerceToExpectedExtern(value: IrValueId, expected: ValType, cx: LowerCtx, where: string): IrValueId {
  const t = cx.builder.typeOf(value);
  // Same-kind val match (e.g. f64 → f64).
  const got = asVal(t);
  if (got && got.kind === expected.kind) {
    return value;
  }
  // String → externref: in host-strings mode, IrType.string is already
  // externref; the verifier sees the SSA type as `string` but the Wasm
  // valtype is externref so the host call accepts it transparently.
  // We keep the SSA type as-is and rely on the lowerer's ValType
  // resolution.
  if (expected.kind === "externref" && t.kind === "string" && !cx.resolver?.nativeStrings?.()) {
    return value;
  }
  // extern → externref: extern values are externref-shaped.
  if (expected.kind === "externref" && t.kind === "extern") {
    return value;
  }
  // (#2856 C3) f64 → externref: box through the `__box_number` host import —
  // the exact coercion legacy's `coerceType` emits for the same site (so the
  // import is registered by legacy's own compile of the function in the
  // dual-compile model). JS-host lane only: standalone has no `__box_number`
  // (its boxing is the `$AnyValue` family), so demote there.
  if (expected.kind === "externref" && got !== null && got.kind === "f64" && cx.resolver?.nativeStrings?.() === false) {
    const boxed = cx.builder.emitCall({ kind: "func", name: "__box_number" }, [value], irVal({ kind: "externref" }));
    if (boxed === null) {
      throw new Error(`ir/from-ast: __box_number produced no result in ${cx.funcName}`);
    }
    return boxed;
  }
  throw new Error(`ir/from-ast: ${where} expects ${expected.kind} but got ${describeIrType(t)} (${cx.funcName})`);
}

/**
 * Slice 4 (#1169d): lower `<recv>.<methodName>(args)` on a class
 * receiver. The receiver is lowered first (so we can inspect its
 * IrType); the method's signature is looked up against the receiver's
 * class shape; argument types must match. Returns the SSA value of the
 * call result — throws if the method is void (slice 4 rejects void
 * methods in expression position; statement-position void calls go
 * through the bare ExpressionStatement path).
 *
 * Receivers of any IrType other than `class` fall through to a clean
 * error, letting the function fall back to legacy.
 */
/**
 * (#2856) Console methods the IR lowers (single-arg statement calls). Mirrors
 * the CONSOLE_METHODS list in the legacy `collectConsoleImports` scan — a
 * method outside this set was never import-registered, so the IR must demote.
 */
const IR_CONSOLE_METHODS: ReadonlySet<string> = new Set(["log", "warn", "error", "info", "debug"]);

function lowerMethodCall(expr: ts.CallExpression, cx: LowerCtx, statementPosition = false): IrValueId | null {
  if (!ts.isPropertyAccessExpression(expr.expression) || !ts.isIdentifier(expr.expression.name)) {
    throw new Error(`ir/from-ast: malformed method call in ${cx.funcName}`);
  }
  const methodName = expr.expression.name.text;

  // #3000-E: `super.method(args)` — static-dispatch to the PARENT's method slot.
  // Intercepted BEFORE receiver lowering: `super` is a keyword lowerExpr can't
  // produce a value for. The receiver passed to the parent method is `this` (the
  // subclass instance — a WasmGC subtype of the parent), and the method resolves
  // against the parent shape so a subclass override is bypassed.
  if (expr.expression.expression.kind === ts.SyntaxKind.SuperKeyword) {
    const parentShape = requireSuperParentShape(cx);
    const self = requireThisValue(cx);
    const method = parentShape.methods.find((m) => m.name === methodName);
    if (!method) {
      throw new Error(
        `ir/from-ast: super.${methodName}() — parent class ${parentShape.className} has no method "${methodName}" in ${cx.funcName}`,
      );
    }
    if (expr.arguments.length !== method.params.length) {
      throw new Error(
        `ir/from-ast: super.${methodName}() has ${expr.arguments.length} args, expected ${method.params.length} in ${cx.funcName}`,
      );
    }
    const args: IrValueId[] = [];
    for (let i = 0; i < expr.arguments.length; i++) {
      const expected = method.params[i]!;
      const argVal = lowerExpr(expr.arguments[i]!, cx, expected);
      const argType = cx.builder.typeOf(argVal);
      if (!irTypeEquals(argType, expected)) {
        throw new Error(
          `ir/from-ast: super.${methodName}() arg ${i} is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
        );
      }
      args.push(argVal);
    }
    if (method.returnType === null && !statementPosition) {
      throw new Error(`ir/from-ast: void super.${methodName}() used in expression position (${cx.funcName})`);
    }
    return cx.builder.emitClassSuperCall(parentShape, self, methodName, args, method.returnType);
  }

  // (#2856) console.<m>(arg) — host console variant call. Intercepted BEFORE
  // receiver lowering (like the Math arm below): `console` has NO
  // `global_console` handle and NO extern-class registration — the legacy
  // backend services it via dedicated per-arg-type import variants
  // (`console_log_string`, `console_log_number`, … — `collectConsoleImports`).
  // Statement position only: console methods return undefined, and the
  // single-arg restriction mirrors what this slice lowers (multi-arg calls
  // demote cleanly). The variant is chosen by the resolver from the CHECKER
  // type of the argument — the exact predicate `collectConsoleImports` used
  // to register the import — so the picked name is registered by
  // construction.
  if (
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "console" &&
    cx.scope.get("console") === undefined &&
    cx.resolver?.consoleArgVariant !== undefined
  ) {
    assertNotDeferred(
      hostExternCapability(cx.resolver?.jsHostExterns?.() === true),
      `console.${methodName}`,
      cx.funcName,
    );
    if (!statementPosition) {
      throw new Error(`ir/from-ast: console.${methodName} in expression position not supported (${cx.funcName})`);
    }
    if (!IR_CONSOLE_METHODS.has(methodName)) {
      throw new Error(`ir/from-ast: console.${methodName} not in IR console slice (${cx.funcName})`);
    }
    if (expr.arguments.length !== 1) {
      throw new Error(
        `ir/from-ast: console.${methodName} with ${expr.arguments.length} args not in slice (${cx.funcName})`,
      );
    }
    const argExpr = expr.arguments[0]!;
    const variant = cx.resolver.consoleArgVariant(argExpr);
    const importName = `console_${methodName}_${variant}`;
    const expected: ValType =
      variant === "number" ? { kind: "f64" } : variant === "bool" ? { kind: "i32" } : { kind: "externref" };
    const argVal = lowerExpr(argExpr, cx, irVal(expected));
    const coerced = coerceToExpectedExtern(argVal, expected, cx, `arg of console.${methodName}`);
    cx.builder.emitCall({ kind: "func", name: importName }, [coerced], null);
    return null;
  }

  // (#1371) Math.<whitelisted>(arg) — pure-Wasm f64 unary op. Recognise
  // the shape BEFORE lowering the receiver, because `Math` is a host
  // global with no IR type binding (lowerExpr on `Math` would throw
  // "unknown identifier"). The selector's `isPhase1Expr` already
  // rejected anything not in `IR_MATH_UNARY_WHITELIST` — but check
  // again here as a hard guard so an unsupported method on `Math`
  // produces the same clean "not in slice" error we use elsewhere
  // (avoiding a confusing "unknown identifier 'Math'" from the
  // receiver lower path below).
  if (ts.isIdentifier(expr.expression.expression) && expr.expression.expression.text === "Math") {
    const irOp = mathUnaryToIrOp(methodName);
    if (irOp !== null && expr.arguments.length === 1) {
      const arg = lowerExpr(expr.arguments[0]!, cx, irVal({ kind: "f64" }));
      const argType = cx.builder.typeOf(arg);
      if (argType.kind !== "val" || argType.val.kind !== "f64") {
        throw new Error(
          `ir/from-ast: Math.${methodName} arg must be f64, got ${describeIrType(argType)} (${cx.funcName})`,
        );
      }
      return cx.builder.emitUnary(irOp, arg, irVal({ kind: "f64" }));
    }
    throw new Error(`ir/from-ast: Math.${methodName} not in IR whitelist (${cx.funcName})`);
  }

  const recv = lowerExpr(expr.expression.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);

  // (#2856) `<number>.toString()` (no radix) on an f64 receiver → the
  // `number_toString` `(f64) -> externref` host import, pre-registered by the
  // legacy source scan whenever a checker-number `.toString()` appears in
  // source (src/codegen/index.ts ~9100). Host-strings mode only: the import
  // returns a HOST string (externref), which is exactly `IrType.string`'s
  // carrier there — so the result composes with the string `+` proof arms
  // (`"n=" + i.toString()`). Native-strings mode has a `(ref $AnyString)`
  // carrier and demotes here (native number formatting is a follow-up arm);
  // radix args likewise demote.
  if (
    methodName === "toString" &&
    expr.arguments.length === 0 &&
    recvType.kind === "val" &&
    recvType.val.kind === "f64" &&
    cx.resolver?.nativeStrings?.() === false
  ) {
    const r = cx.builder.emitCall({ kind: "func", name: "number_toString" }, [recv], { kind: "string" });
    if (r === null) {
      throw new Error(`ir/from-ast: number_toString produced no result in ${cx.funcName}`);
    }
    return r;
  }

  // Slice 13c (#1232) — String prototype method dispatch. When the receiver
  // is `IrType.string`, look up the method in the synthetic String pseudo-
  // extern registry (#1238) and dispatch to either the native helper
  // (`__str_<method>`) or the JS-host import (`string_<method>`) based on
  // the active string backend. Returns null when the method isn't supported
  // by Phase 1 (caller falls through to the existing `string` arm below).
  if (recvType.kind === "string") {
    const r = lowerStringMethodCall(methodName, recv, expr.arguments, cx);
    if (r !== null) return r;
    // Method not in slice 13c table — fall through to the recvType.kind !== "class"
    // check below, which throws the clean "not in slice 4" error and routes this
    // function back to the legacy compiler path. Do NOT throw here — a premature
    // throw here gets caught at the wrong layer and corrupts the claim state.
  }

  // Slice 10 (#1169i) — extern-class method call. The legacy host imports
  // store the signature as `[receiver_externref, ...userParams] ->
  // results`, so we slice off `params[0]` when matching call args.
  //
  // #2856 widens this arm with (a) inheritance-chain member resolution
  // (`appendChild` on an `Element` receiver resolves on `Node`; the instr's
  // className becomes the DEFINING class so the lowered import name is
  // `Node_appendChild`), (b) use-site result branding (an externref result
  // whose checker type names an extern class carries `IrType.extern` so
  // chained access dispatches), and (c) statement-position void calls
  // (`host.appendChild(box);`) — expression position keeps throwing on void.
  if (recvType.kind === "extern") {
    const className = recvType.className;
    const chained = cx.resolver?.resolveExternMember?.(className, methodName, "method", expr);
    const method = chained?.method ?? cx.resolver?.getExternClassInfo?.(className)?.methods.get(methodName);
    if (!method) {
      throw new Error(`ir/from-ast: extern class ${className} has no method "${methodName}" in ${cx.funcName}`);
    }
    const definingClass = chained?.importPrefix ?? className;
    // params[0] is the receiver — userParams = params.slice(1).
    const userParams = method.params.slice(1);
    if (expr.arguments.length > userParams.length) {
      throw new Error(
        `ir/from-ast: method ${definingClass}.${methodName} has ${expr.arguments.length} args, max ${userParams.length} in ${cx.funcName}`,
      );
    }
    const args: IrValueId[] = [];
    for (let i = 0; i < expr.arguments.length; i++) {
      const expected = userParams[i]!;
      const argVal = lowerExpr(expr.arguments[i]!, cx, irVal(expected));
      args.push(coerceToExpectedExtern(argVal, expected, cx, `arg ${i} of ${definingClass}.${methodName}`));
    }
    // (#2856) Pad missing OPTIONAL args with default sentinels: the host
    // import's Wasm signature has FIXED arity = the registered params
    // (`createElement(tagName, options?)` imports as (recv, externref,
    // externref)), so the call must push exactly that many values. Mirrors
    // the legacy `pushDefaultValue` loop (new-super.ts) and the extern.new
    // padding above — without it the emitted call is stack-short and the
    // module fails Wasm validation ("not enough arguments on the stack").
    for (let i = expr.arguments.length; i < userParams.length; i++) {
      args.push(emitDefaultExternArg(cx, userParams[i]!));
    }
    // Result type: use-site extern brand when available (#2856), else the
    // first registered result, or null if void.
    const resultType: IrType | null =
      method.results.length > 0
        ? chained?.resultClassName
          ? { kind: "extern", className: chained.resultClassName }
          : irVal(method.results[0]!)
        : null;
    if (resultType === null && !statementPosition) {
      throw new Error(
        `ir/from-ast: void method ${definingClass}.${methodName} used in expression position (${cx.funcName})`,
      );
    }
    const r = cx.builder.emitExternCall(definingClass, methodName, recv, args, resultType);
    if (resultType !== null && r === null) {
      throw new Error(`ir/from-ast: extern.call produced no result in ${cx.funcName}`);
    }
    return r;
  }

  if (recvType.kind !== "class") {
    throw new Error(
      `ir/from-ast: method call .${methodName}(...) on ${describeIrType(recvType)} not in slice 4 (${cx.funcName})`,
    );
  }
  const method = recvType.shape.methods.find((m) => m.name === methodName);
  if (!method) {
    throw new Error(`ir/from-ast: class ${recvType.shape.className} has no method "${methodName}" in ${cx.funcName}`);
  }
  if (expr.arguments.length !== method.params.length) {
    throw new Error(
      `ir/from-ast: method ${recvType.shape.className}.${methodName} has ${expr.arguments.length} args, expected ${method.params.length} in ${cx.funcName}`,
    );
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < expr.arguments.length; i++) {
    const expected = method.params[i]!;
    const argVal = lowerExpr(expr.arguments[i]!, cx, expected);
    const argType = cx.builder.typeOf(argVal);
    if (!irTypeEquals(argType, expected)) {
      throw new Error(
        `ir/from-ast: arg ${i} of ${recvType.shape.className}.${methodName} is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  // #3052: a VOID instance method is legal in STATEMENT position
  // (`this.add(x);` / `obj.tick();`) — only reject void in EXPRESSION position
  // (mirrors the `super.method()` arm above and the extern-class arm below).
  // The `class.call` emit + lowering already carry a null result through: a
  // void method's Wasm slot leaves nothing on the operand stack, so the
  // statement emits balanced (no drop needed) via `emitBlockBody`'s
  // `result === null` in-place path. The selector already CLAIMS this shape —
  // before this slice from-ast threw here, demoting the caller post-claim to
  // legacy (banked in #3000-C's notes).
  if (method.returnType === null && !statementPosition) {
    throw new Error(
      `ir/from-ast: void method ${recvType.shape.className}.${methodName} used in expression position (${cx.funcName})`,
    );
  }
  const r = cx.builder.emitClassCall(recv, methodName, args, method.returnType);
  if (method.returnType !== null && r === null) {
    // Defensive — emitClassCall returns null only when resultType is null.
    throw new Error(`ir/from-ast: class.call produced no result in ${cx.funcName}`);
  }
  return r;
}

/**
 * Slice 13c (#1232) — Phase 1 String prototype-method dispatch through the IR.
 *
 * For an IR-claimed function with a string-typed receiver, dispatch the
 * method call directly to:
 *   - **`__str_<method>`** (native helper) when `nativeStrings` mode is on
 *   - **`string_<method>`** (host import) when JS-host string backend is on
 *
 * Both helpers/imports are pre-registered by the legacy passes
 * (`collectStringMethodImports` walks the entire source AST regardless
 * of IR claim, so any `s.<method>(...)` triggers import registration;
 * `ensureNativeStringHelpers` populates the native helpers once per
 * module). The IR's `cx.builder.emitCall` then resolves the import name
 * via the lowerer's `resolveFunc` at module-emit time.
 *
 * Argument coercion:
 *   - **Native mode**: index args (start, end, fromIndex, position) are
 *     `i32` in the helper signature. Lower the source `f64` and apply
 *     `i32.trunc_sat_f64_s` (saturating truncation, matches the legacy
 *     `compileStringMethodCall` path). String args lower as `IrType.string`
 *     and pass through unchanged (resolver maps the IrType to
 *     `(ref $NativeString)` at lower time).
 *   - **JS-host mode**: index args remain f64 (the host import's signature
 *     is `(externref, f64...) -> externref`). String args lower as
 *     `IrType.string` (resolver maps to externref).
 *
 * Result type:
 *   - String-returning methods: `IrType.string` (resolver picks externref
 *     vs `(ref $NativeString)` per backend mode).
 *   - Number-returning (`charCodeAt`, `indexOf`): `IrType.val<f64>`.
 *   - Boolean-returning (`includes`, `startsWith`, `endsWith`): `IrType.val<i32>`.
 *
 * **MLIR seam alignment** (per #1231 Phase 2 design note): the dispatch
 * table here is a static const + `cx.resolver.nativeStrings()` lookup —
 * no IR node mutations, no ambient maps. A future MLIR optimizer
 * producing the same `IrType.string` receiver shape would hit this same
 * function unchanged.
 *
 * Returns `null` for unsupported methods so the caller can fall back to
 * legacy via a clean throw.
 */
interface StringMethodSig {
  /** User-arg ValTypes in JS-host mode (excluding receiver). Used to
   *  hint `lowerExpr` and to choose i32-truncation for native mode. */
  readonly hostArgs: readonly ValType[];
  /** IR result type — `IrType.string` for string-returning methods,
   *  `IrType.val<f64>` for number-returning, `IrType.val<i32>` for boolean. */
  readonly result: IrType;
  /** Number of required user args (excluding optional ones). */
  readonly requiredArgs: number;
}

const STRING_METHOD_TABLE: Readonly<Record<string, StringMethodSig>> = {
  toUpperCase: { hostArgs: [], result: { kind: "string" }, requiredArgs: 0 },
  toLowerCase: { hostArgs: [], result: { kind: "string" }, requiredArgs: 0 },
  trim: { hostArgs: [], result: { kind: "string" }, requiredArgs: 0 },
  charAt: { hostArgs: [{ kind: "f64" }], result: { kind: "string" }, requiredArgs: 1 },
  slice: {
    hostArgs: [{ kind: "f64" }, { kind: "f64" }],
    result: { kind: "string" },
    requiredArgs: 1, // slice(start) is valid; end is optional
  },
  indexOf: {
    hostArgs: [{ kind: "externref" }, { kind: "externref" }],
    result: irVal({ kind: "f64" }),
    requiredArgs: 1, // fromIndex optional
  },
  // #2002 — the second arg is the start position (includes/startsWith) or
  // endPosition (endsWith). Declared as an optional f64 so the IR host path
  // forwards it to `string_<method>` (whose import signature is now
  // `(externref, externref, f64) -> i32`). An omitted position pads with NaN;
  // the `string_method` host shim strips a trailing NaN so the JS method
  // applies its spec default (0 for includes/startsWith, length for endsWith).
  includes: {
    hostArgs: [{ kind: "externref" }, { kind: "f64" }],
    result: irVal({ kind: "i32" }),
    requiredArgs: 1,
  },
  startsWith: {
    hostArgs: [{ kind: "externref" }, { kind: "f64" }],
    result: irVal({ kind: "i32" }),
    requiredArgs: 1,
  },
  endsWith: {
    hostArgs: [{ kind: "externref" }, { kind: "f64" }],
    result: irVal({ kind: "i32" }),
    requiredArgs: 1,
  },
};

function lowerStringMethodCall(
  methodName: string,
  recv: IrValueId,
  args: ts.NodeArray<ts.Expression>,
  cx: LowerCtx,
): IrValueId | null {
  const sig = STRING_METHOD_TABLE[methodName];
  if (!sig) return null;

  if (args.length < sig.requiredArgs || args.length > sig.hostArgs.length) {
    throw new Error(
      `ir/from-ast: String.${methodName}(...) arg count ${args.length} not in [${sig.requiredArgs}, ${sig.hostArgs.length}] (${cx.funcName})`,
    );
  }

  const useNative = cx.resolver?.nativeStrings?.() === true;
  if (
    useNative &&
    (methodName === "indexOf" ||
      methodName === "includes" ||
      // #2002 — the native string backend lowers the position arg via its
      // own __str_* helpers (src/codegen/string-ops.ts); defer to the legacy
      // native path rather than re-implement position handling in the IR.
      methodName === "startsWith" ||
      methodName === "endsWith")
  ) {
    return null;
  }
  const funcName = useNative ? `__str_${methodName}` : `string_${methodName}`;

  // Build the argument list. params[0] is always the receiver
  // (`IrType.string`). Remaining args are coerced per backend.
  const loweredArgs: IrValueId[] = [recv];
  for (let i = 0; i < args.length; i++) {
    const expectedHost = sig.hostArgs[i]!;
    let argVal: IrValueId;
    if (expectedHost.kind === "f64") {
      // Index-style arg. Lower as f64, then truncate to i32 in native mode.
      const f64Val = lowerExpr(args[i]!, cx, irVal({ kind: "f64" }));
      argVal = useNative ? cx.builder.emitUnary("i32.trunc_sat_f64_s", f64Val, irVal({ kind: "i32" })) : f64Val;
    } else if (expectedHost.kind === "externref") {
      // String-style arg. Lower as IrType.string — resolver maps to
      // externref (host) or (ref $NativeString) (native) at lower time.
      argVal = lowerExpr(args[i]!, cx, { kind: "string" });
    } else {
      throw new Error(
        `ir/from-ast: String.${methodName} arg ${i} expected ValType ${expectedHost.kind} not in slice 13c (${cx.funcName})`,
      );
    }
    loweredArgs.push(argVal);
  }

  // Pad missing optional args with backend-appropriate sentinels.
  // For host-mode externref args (e.g. indexOf's fromIndex omitted),
  // emit `ref.null.extern` — the host import shim treats it as undefined.
  // For host-mode f64 args (e.g. slice's end omitted), emit a sentinel
  // that the host knows means "to end" (matches the legacy convention).
  //
  // #1248: For `String.slice(start)` (single-arg), the missing `end`
  // argument MUST default to `s.length`, NOT 0. The host import
  // `string_slice(s, start, 0)` interprets end=0 literally and returns
  // an empty string for any non-zero start. The fix is symmetric to the
  // legacy compiler path in `src/codegen/expressions/calls.ts:4040+` —
  // when slice is called with only `start`, push `recv.length` as the
  // implicit `end` arg.
  for (let i = args.length; i < sig.hostArgs.length; i++) {
    const expectedHost = sig.hostArgs[i]!;
    if (useNative) {
      // #1248 native-mode: slice's missing `end` defaults to `recv.len`.
      // For other methods we still throw — Phase 1 only covers fully-
      // specified call sites for native mode.
      if (methodName === "slice" && i === 1 && expectedHost.kind === "f64") {
        // emitStringLen returns f64; truncate to i32 for native helpers
        const f64Len = cx.builder.emitStringLen(recv);
        const i32Len = cx.builder.emitUnary("i32.trunc_sat_f64_s", f64Len, irVal({ kind: "i32" }));
        loweredArgs.push(i32Len);
        continue;
      }
      throw new Error(
        `ir/from-ast: String.${methodName} optional arg ${i} omitted in nativeStrings mode not in slice 13c (${cx.funcName})`,
      );
    } else {
      // #1248 host-mode: for `String.slice(start)`, the missing `end`
      // arg defaults to `recv.length` (as f64). All other missing
      // optional args fall back to the generic sentinel.
      if (methodName === "slice" && i === 1 && expectedHost.kind === "f64") {
        const lenVal = cx.builder.emitStringLen(recv);
        loweredArgs.push(lenVal);
        continue;
      }
      // #2002 — includes/startsWith/endsWith pad an omitted position with NaN.
      // The `string_method` host shim strips a trailing NaN so the JS method
      // applies its spec default (0 for includes/startsWith, length for
      // endsWith) instead of ToInteger(NaN)=0.
      if (
        expectedHost.kind === "f64" &&
        (methodName === "includes" || methodName === "startsWith" || methodName === "endsWith")
      ) {
        const nan = cx.builder.emitConst({ kind: "f64", value: NaN }, irVal({ kind: "f64" }));
        loweredArgs.push(nan);
        continue;
      }
      const def = emitDefaultExternArg(cx, expectedHost);
      loweredArgs.push(def);
    }
  }

  const r = cx.builder.emitCall({ kind: "func", name: funcName }, loweredArgs, sig.result);
  if (r === null) {
    throw new Error(`ir/from-ast: String.${methodName} produced void result (${cx.funcName})`);
  }
  return r;
}

/**
 * Slice 4 (#1169d): lower `<obj>.<field> = <expr>;` as `class.set` (or
 * `object.set`, depending on the receiver's IrType). Statement-position
 * only — caller (in `lowerStatementList`) has already verified shape.
 *
 * For class receivers: validate `fieldName` exists on the shape and
 * the RHS type matches the field type. For object receivers: same idea
 * via the slice-2 `object.set`. Anything else throws and the function
 * falls back to legacy.
 */
function lowerPropertyAssignment(expr: ts.BinaryExpression, cx: LowerCtx): void {
  const lhs = expr.left;
  // #3000 — private-field write (`this.#x = v`). Same mangling as the read
  // path so the write targets the identical legacy struct slot.
  if (!ts.isPropertyAccessExpression(lhs) || (!ts.isIdentifier(lhs.name) && !ts.isPrivateIdentifier(lhs.name))) {
    throw new Error(`ir/from-ast: malformed property assignment LHS in ${cx.funcName}`);
  }
  const fieldName = irPrivateFieldName(lhs.name);
  const recv = lowerExpr(lhs.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);

  if (recvType.kind === "class") {
    const field = recvType.shape.fields.find((f) => f.name === fieldName);
    if (!field) {
      throw new Error(`ir/from-ast: class ${recvType.shape.className} has no field "${fieldName}" in ${cx.funcName}`);
    }
    const newValue = lowerExpr(expr.right, cx, field.type);
    const newValueType = cx.builder.typeOf(newValue);
    if (!irTypeEquals(newValueType, field.type)) {
      throw new Error(
        `ir/from-ast: assignment to ${recvType.shape.className}.${fieldName} (${describeIrType(field.type)}) got ${describeIrType(newValueType)} (${cx.funcName})`,
      );
    }
    cx.builder.emitClassSet(recv, fieldName, newValue);
    return;
  }

  if (recvType.kind === "object") {
    const fieldIdx = recvType.shape.fields.findIndex((f) => f.name === fieldName);
    if (fieldIdx < 0) {
      throw new Error(
        `ir/from-ast: object has no field "${fieldName}" (shape: ${describeIrType(recvType)}) in ${cx.funcName}`,
      );
    }
    const fieldType = recvType.shape.fields[fieldIdx]!.type;
    const newValue = lowerExpr(expr.right, cx, fieldType);
    const newValueType = cx.builder.typeOf(newValue);
    if (!irTypeEquals(newValueType, fieldType)) {
      throw new Error(
        `ir/from-ast: assignment to .${fieldName} (${describeIrType(fieldType)}) got ${describeIrType(newValueType)} (${cx.funcName})`,
      );
    }
    cx.builder.emitObjectSet(recv, fieldName, newValue);
    return;
  }

  // (#2856) Extern-class property write (`box.textContent = "x"`,
  // `e.style.cssText = css`, `host.innerHTML = ""`). Chain-walking
  // resolution like the read arm; the instr's className is the DEFINING
  // class so the lowered import is `<definer>_set_<prop>`
  // (`Element_set_textContent` for an HTMLDivElement receiver). The value
  // coerces to the registered property ValType exactly as extern method
  // args do. Readonly properties never resolve as writable in the lib, so
  // TS source that assigns them failed checking before reaching us.
  if (recvType.kind === "extern") {
    assertNotDeferred(
      hostExternCapability(cx.resolver?.jsHostExterns?.() !== false),
      `extern property write .${fieldName}`,
      cx.funcName,
    );
    const resolved = cx.resolver?.resolveExternMember?.(recvType.className, fieldName, "property", lhs);
    if (!resolved?.property) {
      throw new Error(
        `ir/from-ast: extern class ${recvType.className} has no property "${fieldName}" in ${cx.funcName}`,
      );
    }
    const newValue = lowerExpr(expr.right, cx, irVal(resolved.property.type));
    const coerced = coerceToExpectedExtern(newValue, resolved.property.type, cx, `value of .${fieldName}`);
    cx.builder.emitExternPropSet(resolved.importPrefix, fieldName, recv, coerced);
    return;
  }

  throw new Error(`ir/from-ast: property assignment on ${describeIrType(recvType)} is not in slice 4 (${cx.funcName})`);
}

// ---------------------------------------------------------------------------
// for-of statement lowering (slice 6 part 2 — #1181)
// ---------------------------------------------------------------------------
//
// Activates the slice-6 IR scaffolding shipped by #1169e. Lowers
// `for (const x of arr)` over a vec ref to a `forof.vec` declarative
// instr, with the loop variable bound as a `slot` ScopeBinding inside
// the body. Body statements go through `lowerStmt` (separate from
// `lowerStatementList` — the body is non-tail, no early-return / nested
// closures, just simple statement forms).
//
// Iterables that don't lower to a `(ref|ref_null) $vec_*` ValType throw
// and the function falls back to legacy. The iterator-protocol path
// (Map / Set / generators) lands in #1182.

// ---------------------------------------------------------------------------
// yield lowering (slice 7a — #1169f)
// ---------------------------------------------------------------------------

/**
 * Slice 7a/7b (#1169f): lower a yield expression-statement. The yielded
 * value is pushed onto the generator's `__gen_buffer` Wasm-local slot
 * via `gen.push`, which the lowerer expands to a typed `__gen_push_*`
 * host call dispatched on the value's IrType (f64 → push_f64,
 * i32 → push_i32, otherwise externref → push_ref).
 *
 * Slice 7b adds three extensions:
 *   - **Bare `yield;`** — emits a null-externref const + `gen.push`,
 *     matching legacy's "yield with no value" semantics (every
 *     consumer sees `IteratorResult { value: undefined, done: false }`
 *     for that step).
 *   - **`yield <non-numeric>`** — strings, booleans-as-i32 stay native;
 *     ref/object/class/closure values coerce to externref via
 *     `coerce.to_externref` (the `extern.convert_any` Wasm op), then
 *     flow through `__gen_push_ref(buf, externref)`.
 *   - **`yield* <iterable>`** — coerces the iterable to externref and
 *     emits `gen.yieldStar`, which lowers to
 *     `__gen_yield_star(buf, iterable)`. The host iterator-protocol
 *     drains every value from the inner iterable into the outer
 *     buffer (see `runtime.ts:2999`).
 *
 * Defensive: throws if the enclosing function isn't a generator. The
 * selector should have rejected the function in that case, but a
 * defensive check here surfaces selector regressions as a clean
 * fall-back to legacy rather than malformed Wasm.
 */
function lowerYield(expr: ts.YieldExpression, cx: LowerCtx): void {
  if (cx.funcKind !== "generator") {
    throw new Error(`ir/from-ast: yield outside generator function in ${cx.funcName}`);
  }

  // ---------------------------------------------------------------
  // `yield* <iterable>` — slice 7b.
  // ---------------------------------------------------------------
  if (expr.asteriskToken) {
    if (!expr.expression) {
      // TS parser enforces this; keep as defense-in-depth.
      throw new Error(`ir/from-ast: yield* requires an iterable in ${cx.funcName}`);
    }
    // Lower the iterable with an externref hint; the iterable's
    // actual IrType might be vec/string/object/externref. Coerce to
    // externref via the slice-6-part-3 helper so the host
    // `__gen_yield_star(externref, externref)` import sees the
    // right Wasm value type.
    const inner = lowerExpr(expr.expression, cx, irVal({ kind: "externref" }));
    const innerExt = coerceYieldValueToExternref(inner, cx);
    cx.builder.emitGenYieldStar(innerExt);
    return;
  }

  // ---------------------------------------------------------------
  // Bare `yield;` (no value) — slice 7b.
  // ---------------------------------------------------------------
  if (!expr.expression) {
    // Materialize a null externref and push as ref. Legacy emits
    // the same shape (`__gen_push_ref(buf, ref.null.extern)`) when
    // a `yield;` statement appears in a generator body.
    const nullExt = cx.builder.emitConst(
      { kind: "null", ty: irVal({ kind: "externref" }) },
      irVal({ kind: "externref" }),
    );
    cx.builder.emitGenPush(nullExt);
    return;
  }

  // ---------------------------------------------------------------
  // `yield <expr>` — slice 7a (numeric) and 7b (any Phase-1 type).
  // ---------------------------------------------------------------
  // Lower with an externref hint as a fallback shape; the IR type
  // recovered via `typeOf` drives the dispatch below. For numeric
  // and bool yields the lowerer's downstream typing keeps them as
  // f64/i32 — `lowerExpr`'s `hint` is advisory, not authoritative.
  const value = lowerExpr(expr.expression, cx, irVal({ kind: "externref" }));
  const valueType = cx.builder.typeOf(value);
  const valTy = asVal(valueType);
  if (valTy?.kind === "f64" || valTy?.kind === "i32") {
    // Native primitive yield — `gen.push` lowerer dispatches to
    // `__gen_push_f64` / `__gen_push_i32` directly.
    cx.builder.emitGenPush(value);
    return;
  }
  // Reference-shaped yield — coerce to externref so the lowerer's
  // `__gen_push_ref(buf, externref)` arm sees the right Wasm type.
  const valueExt = coerceYieldValueToExternref(value, cx);
  cx.builder.emitGenPush(valueExt);
}

/**
 * Slice 7b helper: coerce a yielded SSA value to externref for the
 * `__gen_push_ref` / `__gen_yield_star` arms. Skips the coerce when
 * the value's underlying Wasm valtype is ALREADY externref —
 * emitting `extern.convert_any` on an already-externref operand is
 * actually a Wasm validation error (the op expects an `anyref`
 * subtype, and `externref` is NOT a subtype of `anyref`).
 *
 * Cases that skip the coerce:
 *   - `IrType.val` with `val.kind === "externref"` — directly externref.
 *   - `IrType.string` in HOST-strings mode — `resolveString()` returns
 *     externref for the host backend (the wasm:js-string imports take
 *     externref), so the value flowing through is already externref.
 *
 * Cases that DO coerce:
 *   - `IrType.string` in NATIVE-strings mode — value is `(ref $AnyString)`,
 *     a struct ref subtype of anyref, so `extern.convert_any` re-tags it.
 *   - `IrType.val` with `val.kind === "ref"` / `"ref_null"` —
 *     struct/array refs are anyref subtypes; coerce is valid.
 *   - `IrType.object` / `class` / `closure` — all backed by struct refs,
 *     anyref subtypes; coerce is valid.
 *
 * Reuses `coerce.to_externref` (#1182) so the generator path and the
 * iter-host for-of path share one IR primitive — the lowerer emits
 * `extern.convert_any` for both.
 */
function coerceYieldValueToExternref(value: IrValueId, cx: LowerCtx): IrValueId {
  const t = cx.builder.typeOf(value);
  if (t.kind === "val" && t.val.kind === "externref") {
    return value;
  }
  // #2955 — de-polymorph on string mode. A string operand IS externref in
  // host-strings mode and `(ref $AnyString)` (an anyref subtype needing
  // `extern.convert_any`) in native-strings mode. That per-mode decision no
  // longer branches here in the front-end: emit the abstract
  // `coerce.to_externref` unconditionally and let the lowerer resolve the
  // mode (host → the convert is elided because the value is already
  // externref; native → `extern.convert_any`). The lowered bytes stay
  // byte-identical to the previous `!nativeStrings` guard in both modes,
  // and the produced IR is now identical across string modes.
  return cx.builder.emitCoerceToExternref(value);
}

/**
 * #1798 — reconcile a lowered return value with the function's declared
 * result type before terminating with `return`.
 *
 * The return expression is lowered with `cx.returnType` as an *advisory*
 * hint, but several expression kinds honestly produce their concrete type
 * regardless of the hint (most notably `new C()` → `IrType.class` (struct
 * ref), object literals → struct ref). When the function declares `: any`
 * (which `resolvePositionType` maps to `externref`, see
 * `src/codegen/index.ts:438`), a `(ref $C) → externref` mismatch would reach
 * `return` and the emitted body fails Wasm validation
 * (`return[0] expected externref, got (ref null N)`).
 *
 * The legacy return path (`compileReturnStatement` →
 * `coerceType(exprType, fctx.returnType)`) coerces here; the IR return-tail
 * previously did not. This mirrors that coercion for the externref case:
 *
 *   - Declared result is `externref` and the value is reference-shaped
 *     (class / object / closure / vec ref / ref_null / native-string) →
 *     coerce via `coerceYieldValueToExternref` (`extern.convert_any`). This
 *     is a zero-cost re-tag valid for any anyref subtype, agnostic to the
 *     exact struct typeIdx (so type compaction cannot break it).
 *   - Declared result is `externref` but the value is a native scalar
 *     (`f64` / `i32`) → throw a clean "not in slice" fallback. Boxing a
 *     number to externref needs `__box_number`; the IR has no box primitive
 *     yet, and the legacy path boxes correctly. Deferring mirrors the
 *     existing numeric-throw deferral in `lowerThrowStatement`.
 *
 * All other cases (matching kinds, already-externref values, non-externref
 * declared results) pass through unchanged.
 */
function coerceReturnValue(value: IrValueId, cx: LowerCtx): IrValueId {
  const declared = cx.returnType;
  // (#2856 C3) externref value into a NUMBER (f64) declared result —
  // `return hit;` where `hit = cache.get(n)` is the externref Map_get
  // result. Unbox through `__unbox_number`, exactly what legacy emits for
  // the same site (import registered by legacy's own compile in the
  // dual-compile model). Host lane only — standalone demotes. Before this
  // arm such returns slipped to the verifier's #1798 gate and demoted;
  // now they lower like legacy.
  if (declared && declared.kind === "val" && declared.val.kind === "f64") {
    const actualT = cx.builder.typeOf(value);
    const actualV = asVal(actualT);
    if (actualV && actualV.kind === "externref" && cx.resolver?.nativeStrings?.() === false) {
      const unboxed = cx.builder.emitCall({ kind: "func", name: "__unbox_number" }, [value], irVal({ kind: "f64" }));
      if (unboxed === null) {
        throw new Error(`ir/from-ast: __unbox_number produced no result in ${cx.funcName}`);
      }
      return unboxed;
    }
    return value;
  }
  // Only the externref (TS `any`) declared-result case can mismatch here;
  // native scalar / matching-ref returns already line up via the hint.
  if (!declared || declared.kind !== "val" || declared.val.kind !== "externref") {
    return value;
  }
  const actual = cx.builder.typeOf(value);
  // Already externref — nothing to do.
  if (actual.kind === "val" && actual.val.kind === "externref") {
    return value;
  }
  // Native scalar → externref needs a box helper the IR lacks; defer the whole
  // function to legacy. (#2785) Legacy's box is now TYPE-AWARE — `coerceType(i32
  // → externref)` picks `__box_boolean` / `__box_symbol` / `__box_number` from
  // the value's brand — so this demote is type-correct for a `boolean`/`symbol`
  // scalar too, not only a number. The IR still has no box primitive of its own;
  // it inherits the type-aware box for free via demote-to-legacy.
  const actualVal = asVal(actual);
  // #2782 (hybrid Row 5) — the no-box NUMBER escape edge. An unboxed `f64`
  // number returned into an `any` (externref) result is the canonical "number
  // local / value sinks to an `any` sink" case: the IR keeps numbers unboxed
  // (no runtime tag), so handing one to the dynamic `any` result without an
  // explicit box would lose its identity. The IR has no box primitive, so the
  // SAFE lowering is to demote to legacy (which boxes via `__box_number`). This
  // is the reachable, claimable counterpart to the `lowerVarDecl` declaration
  // gate (`proveUnboxedNumberLocal`): together they keep the value unboxed only
  // while it is provably a pure number AND box it at the proven escape edge.
  if (actualVal && actualVal.kind === "f64") {
    throw new Error(
      `ir/from-ast: unboxed f64 number returned into an 'any' (externref) result — the ` +
        `no-box number representation is unsound at this escape sink; demote to the SAFE ` +
        `boxed legacy lowering (boxes via __box_number) in ${cx.funcName} (#2782)`,
    );
  }
  if (actualVal && (actualVal.kind === "i32" || actualVal.kind === "i64")) {
    throw new Error(
      `ir/from-ast: return of numeric ${actualVal.kind} into an 'any' (externref) result ` +
        `needs the box helper — deferring to legacy in ${cx.funcName}`,
    );
  }
  // Reference-shaped (class / object / closure / vec ref / ref_null /
  // native-string) → extern.convert_any. `coerceYieldValueToExternref` is a
  // no-op for host-strings (already externref) and re-tags all anyref
  // subtypes otherwise.
  return coerceYieldValueToExternref(value, cx);
}

/**
 * Lower a `for (const|let <id> of <expr>) <body>` statement using the
 * vec fast path. The iterable expression must lower to an IR value
 * whose ValType is `(ref $vec_*)` or `(ref_null $vec_*)`. The vec's
 * struct shape (`{ length: i32, data: (ref $arr_<elem>) }`) is read at
 * lowering time via `inferVecElementValType` so we can pre-allocate
 * the element slot with the right ValType.
 */
function lowerForOfStatement(stmt: ts.ForOfStatement, cx: LowerCtx): void {
  // 1. Lower the iterable. Pass an externref hint — the actual IR type
  //    is inferred from the lowered value.
  const iterableV = lowerExpr(stmt.expression, cx, irVal({ kind: "externref" }));
  const iterableT = cx.builder.typeOf(iterableV);

  // 2. Resolve the loop-variable name. The selector enforces a single
  //    Identifier-named decl in `(const|let)` form. Shared between vec
  //    and iter-host arms.
  const init = stmt.initializer;
  if (!ts.isVariableDeclarationList(init) || init.declarations.length !== 1) {
    throw new Error(`ir/from-ast: for-of init shape unexpected (${cx.funcName})`);
  }
  const decl = init.declarations[0]!;
  if (!ts.isIdentifier(decl.name)) {
    throw new Error(`ir/from-ast: for-of destructuring init not in slice 6 (${cx.funcName})`);
  }
  const loopVarName = decl.name.text;

  // 3. Strategy dispatch.
  //
  //   - `(val) ref|ref_null`        → vec path (slice 6 part 2 — #1181).
  //                                    The lowerer's resolveVec validates
  //                                    the struct's `{ length, data }`
  //                                    shape; if it isn't a vec, lowering
  //                                    throws and the function falls back
  //                                    to legacy.
  //   - `string` (native mode)      → string fast path (slice 6 part 4 — #1183).
  //                                    Counter loop with `__str_charAt`.
  //   - `string` (host mode)         → fall through to iter-host. The
  //                                    string IR value is already
  //                                    externref-backed in host mode, so
  //                                    no coercion is needed.
  //   - `(val) externref`           → iter-host (slice 6 part 3 — #1182).
  //   - `class` / `object`           → iter-host (with extern.convert_any
  //                                    coercion).
  //   - anything else                → throw, fall back to legacy.
  const valTy = asVal(iterableT);
  if (valTy && (valTy.kind === "ref" || valTy.kind === "ref_null")) {
    lowerForOfVec(stmt, cx, iterableV, valTy, loopVarName);
    return;
  }
  if (iterableT.kind === "string") {
    if (cx.resolver?.nativeStrings?.()) {
      lowerForOfString(stmt, cx, iterableV, loopVarName);
      return;
    }
    // Host-strings mode: fall through to iter-host. The string's
    // underlying ValType is already externref, so no coercion is
    // needed — the iter-host arm passes `iterableV` straight to
    // `__iterator`. We bind the loop variable as externref (host
    // strings only have host-side string semantics; the iter-host
    // element is opaque externref by design).
    lowerForOfIterFromExternrefValue(stmt, cx, iterableV, loopVarName, /* alreadyExternref */ true);
    return;
  }

  // Iter-host arm: externref / class / object iterables.
  const isIterHostEligible = valTy?.kind === "externref" || iterableT.kind === "class" || iterableT.kind === "object";
  if (!isIterHostEligible) {
    throw new Error(
      `ir/from-ast: for-of iterable type ${describeIrType(iterableT)} not supported in slice 6 (${cx.funcName})`,
    );
  }
  lowerForOfIterFromExternrefValue(stmt, cx, iterableV, loopVarName, valTy?.kind === "externref");
}

// ---------------------------------------------------------------------------
// Slice 12 (#1280) — generic structured loops (`while` / `for`)
// ---------------------------------------------------------------------------

/**
 * Slice 12 (#1280): lower `while (cond) body` to an IR `while.loop`
 * declarative instruction.
 *
 * Pattern: collect the cond expression's IR into a buffer, capture the
 * resulting i32 SSA value, collect the body statements into another
 * buffer, then emit `while.loop`. The lowerer emits the canonical
 * `block { loop { <cond>; i32.eqz; br_if 1; <body>; br 0 } }` Wasm
 * pattern.
 *
 * The body uses a fresh scope (cloned from `cx.scope`) so any
 * `let`-decls inside the body don't leak out — the selector's
 * `mutatedLets` analysis already tagged any outer `let` whose name
 * the body reassigns as slot-bound, so cross-iteration writes go
 * through `slot.read` / `slot.write` and survive the loop.
 */
/**
 * #2136 — coerce a loop condition SSA value to an i32 boolean via ToBoolean.
 *
 * The `{while,for}.loop` lowerer emits `<condValue>; i32.eqz; br_if 1`, which
 * requires an i32 condValue. An f64 (numeric) condition is converted with the
 * NaN-safe ToBoolean `abs(x) > 0` — `f64.abs` folds `-0` to `0` and `NaN > 0`
 * is false, so `0`, `-0` and `NaN` are all falsy (matching JS ToBoolean and
 * the linear backend's `emitTruthyCoercion`, #1937). An i32 value is already a
 * bool and passes through. Any other value type (ref/string) is out of scope
 * for this slice and keeps the legacy fallback by throwing the same diagnostic
 * the loops used before (#1980).
 *
 * MUST be called inside the `collectBodyInstrs` closure that builds the cond
 * buffer so the coercion instructions re-run each iteration.
 */
function coerceLoopCondToBool(condValue: IrValueId, cx: LowerCtx, loopKind: "while" | "for" | "do" | "if"): IrValueId {
  const irType = cx.builder.typeOf(condValue);
  // #2949 S5.1 — a boxed-any (dynamic) condition lowers ToBoolean via
  // `dyn.truthy` (→ `__any_unbox_bool` gc / `__is_truthy` host), the same
  // JS-truthiness the legacy condition path emits. Emitted INTO the current
  // (cond) buffer so it re-runs each iteration, exactly like the numeric arm
  // below. This arm is reachable only once the selector admits a dynamic
  // condition (S5.P); until then the move-only gate rejects such functions,
  // so it is exercised only by hand-built-IR unit tests (byte-inert).
  if (irType.kind === "dynamic") {
    return cx.builder.emitDynTruthy(condValue);
  }
  const kind = asVal(irType)?.kind;
  if (kind === "i32") return condValue;
  if (kind === "f64") {
    // ToBoolean(f64) = abs(x) > 0  (false for 0, -0, NaN; true otherwise).
    const absV = cx.builder.emitUnary("f64.abs", condValue, irVal({ kind: "f64" }));
    const zero = cx.builder.emitConst({ kind: "f64", value: 0 }, irVal({ kind: "f64" }));
    return cx.builder.emitBinary("f64.gt", absV, zero, irVal({ kind: "i32" }));
  }
  // ref/string/other — not yet supported; bail to legacy (#2136 scopes numeric).
  throw new Error(`ir/from-ast: ${loopKind} condition must be bool in ${cx.funcName}`);
}

function lowerWhileStatement(stmt: ts.WhileStatement, cx: LowerCtx): void {
  // Capture the value id `lowerExpr` returns rather than the cond buffer's
  // last instruction result — the latter is fragile (e.g. a trailing store
  // produces no value). (#1980)
  let condResult: IrValueId | null = null;
  const condInstrs = cx.builder.collectBodyInstrs(() => {
    const raw = lowerExpr(stmt.expression, cx, irVal({ kind: "i32" }));
    // #2136 — an f64 (numeric-truthiness) condition was previously bailed to
    // legacy (#1980) because the lowerer's unconditional `i32.eqz` on an f64
    // emitted invalid Wasm. Instead, coerce it to an i32 bool via ToBoolean
    // INSIDE the cond buffer (so the coercion re-runs each iteration) and use
    // the coerced value as `condValue`. Non-numeric, non-bool conditions
    // (ref/string) still bail — those need a different ToBoolean path (#2136
    // scopes to numeric).
    condResult = coerceLoopCondToBool(raw, cx, "while");
  });
  if (condResult === null || condResult === undefined) {
    throw new Error(`ir/from-ast: while cond produced no SSA value (${cx.funcName})`);
  }
  // #2952 slice 2 — synthesise the loop's label and thread it as the
  // innermost loop for the body, so unlabeled break/continue resolve here.
  const loopLabel = cx.builder.freshLoopLabel();
  const bodyCx: LowerCtx = { ...cx, scope: new Map(cx.scope), loopLabel };
  const bodyInstrs = cx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });
  cx.builder.emitWhileLoop({
    cond: condInstrs,
    condValue: condResult,
    body: bodyInstrs,
    loopLabel,
  });
}

/**
 * #2952 slice 1 — lower `do { body } while (cond)` to a `while.loop` IR
 * instr with `postCond: true`. A do-while is a POST-test loop: the body
 * runs once unconditionally, then the cond decides whether to repeat. It
 * reuses the `while.loop` node (same cond / body buffers) so no pass needs
 * a new instr kind; the lowerer's `postCond` flag flips the emission order
 * (body → cond-check) to `block { loop { <body>; <cond>; i32.eqz; br_if 1;
 * br 0 } }`.
 *
 * Bodies containing `break` / `continue` are rejected up-front by the
 * selector (`isPhase1BodyStatement` has no break/continue arm — same as
 * the already-adopted `while` / `for`), so this slice only claims the
 * multi-exit-free subset and never reaches a demote channel post-claim.
 */
function lowerDoStatement(stmt: ts.DoStatement, cx: LowerCtx): void {
  // Body first (buffer built exactly as `while`, just emitted before cond
  // at lower time). Scope mirrors the while path. (#2952 slice 2) The
  // synthesised label makes this loop the innermost break/continue target;
  // a continue falls through to the cond (post-test semantics).
  const loopLabel = cx.builder.freshLoopLabel();
  const bodyCx: LowerCtx = { ...cx, scope: new Map(cx.scope), loopLabel };
  const bodyInstrs = cx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });

  // Cond buffer — re-evaluated each iteration (after the body).
  let condResult: IrValueId | null = null;
  const condInstrs = cx.builder.collectBodyInstrs(() => {
    const raw = lowerExpr(stmt.expression, cx, irVal({ kind: "i32" }));
    condResult = coerceLoopCondToBool(raw, cx, "do");
  });
  if (condResult === null || condResult === undefined) {
    throw new Error(`ir/from-ast: do-while cond produced no SSA value (${cx.funcName})`);
  }

  cx.builder.emitWhileLoop({
    cond: condInstrs,
    condValue: condResult,
    body: bodyInstrs,
    postCond: true,
    loopLabel,
  });
}

/**
 * Slice 12 (#1280): lower `for (init; cond; update) body` to an IR
 * `for.loop` declarative instruction.
 *
 * The init clause is emitted INLINE before the for.loop instr (a
 * `let` declaration becomes a `lowerVarDecl`; an expression init
 * becomes a `lowerExpr` whose result is dropped). Cond, update, and
 * body are collected into separate buffers carried on the for.loop
 * instr. The loop variable's binding enters scope before
 * cond/update/body are lowered.
 */
/**
 * #2766 — does the `for`'s initializer declare `indexVar` with a non-negative
 * numeric-literal initializer (`let i = 0`, `let i = 5`, …)? Part of the
 * counted-loop in-bounds proof's lower-bound half. Conservative: anything that
 * is not a plain non-negative numeric literal (a prefix `-1`, a computed init,
 * an index declared outside the loop) returns false → the read falls to the SAFE
 * lowering rather than being (unsoundly) trusted.
 */
function forInitsIndexNonNegative(stmt: ts.ForStatement, indexVar: string): boolean {
  const init = stmt.initializer;
  if (!init || !ts.isVariableDeclarationList(init)) return false;
  for (const decl of init.declarations) {
    if (ts.isIdentifier(decl.name) && decl.name.text === indexVar) {
      const ini = decl.initializer;
      if (ini && ts.isNumericLiteral(ini)) {
        const v = Number(ini.text.replace(/_/g, ""));
        return Number.isFinite(v) && v >= 0;
      }
      return false;
    }
  }
  return false;
}

/**
 * #2766 — the counted-loop in-bounds proof for the IR. Returns the
 * `"arrayVar:indexVar"` key when the `for` provably keeps its index in
 * `[0, array.length)` across the whole body, else `null`.
 *
 * This is a *real* proof (per the hybrid invariant — a compiler-checked fact,
 * not the mere presence of a `: number[]` type), and it is intentionally
 * STRICTER than legacy's `safeIndexedArrays` population (which checked only the
 * `i < arr.length` condition + body non-mutation): the IR fast path emits an
 * UNCHECKED `array.get` that *traps* on OOB, so the proof must also pin the lower
 * bound. We therefore additionally require a non-negative-literal init and a
 * strictly-increasing step, giving `0 <= i` at entry, `i` only increases, and
 * the strict `i < arr.length` condition ⇒ `0 <= i < arr.length` at every body
 * point. Anything not fully proven returns `null` and gets the SAFE read.
 */
function detectCountedLoopSafeIndex(stmt: ts.ForStatement): string | null {
  if (!stmt.condition || !ts.isBinaryExpression(stmt.condition)) return null;
  const cond = stmt.condition;
  const op = cond.operatorToken.kind;
  let indexExpr: ts.Expression | undefined;
  let lengthExpr: ts.Expression | undefined;
  // Strict `i < arr.length`
  if (op === ts.SyntaxKind.LessThanToken) {
    indexExpr = cond.left;
    lengthExpr = cond.right;
  } else if (op === ts.SyntaxKind.GreaterThanToken) {
    // Strict `arr.length > i`
    indexExpr = cond.right;
    lengthExpr = cond.left;
  } else {
    return null; // `<=` / `>=` would admit `i == arr.length` (OOB)
  }
  if (
    !indexExpr ||
    !lengthExpr ||
    !ts.isIdentifier(indexExpr) ||
    !ts.isPropertyAccessExpression(lengthExpr) ||
    !ts.isIdentifier(lengthExpr.name) ||
    lengthExpr.name.text !== "length" ||
    !ts.isIdentifier(lengthExpr.expression)
  ) {
    return null;
  }
  const indexVar = indexExpr.text;
  const arrayVar = lengthExpr.expression.text;
  // Lower bound: i starts >= 0 and strictly increases.
  if (!forInitsIndexNonNegative(stmt, indexVar)) return null;
  if (!isIncreasingStep(stmt.incrementor, indexVar)) return null;
  // Stability: body must not reassign i / arr / arr.length, call a method on arr
  // (could change length), or contain a nested function (could capture+mutate).
  if (loopBodyMutatesIndexOrArray(stmt.statement, indexVar, arrayVar)) return null;
  return arrayVar + ":" + indexVar;
}

function lowerForStatement(stmt: ts.ForStatement, cx: LowerCtx): void {
  if (!stmt.condition) {
    throw new Error(`ir/from-ast: for without cond not in slice 12 (${cx.funcName})`);
  }
  const innerCx: LowerCtx = { ...cx, scope: new Map(cx.scope) };

  // 1. Init — emit inline before the for.loop instr.
  if (stmt.initializer) {
    if (ts.isVariableDeclarationList(stmt.initializer)) {
      // Synthesize a VariableStatement so we can re-use lowerVarDecl.
      // The flags carry let/const-ness (already validated by the selector).
      const synthStmt = ts.factory.createVariableStatement(undefined, stmt.initializer);
      lowerVarDecl(synthStmt, innerCx);
    } else {
      // Expression init — lower as a value, drop the result.
      void lowerExpr(stmt.initializer, innerCx, irVal({ kind: "f64" }));
    }
  }

  // 2. Cond — collect its IR into a buffer.
  // Capture the value id `lowerExpr` returns rather than the buffer's last
  // instruction result (fragile — see #1980).
  let condResult: IrValueId | null = null;
  const condInstrs = innerCx.builder.collectBodyInstrs(() => {
    const raw = lowerExpr(stmt.condition!, innerCx, irVal({ kind: "i32" }));
    // #2136 — coerce a numeric-truthiness `for` cond (e.g. `for (...; k; ...)`
    // with f64 `k`) to an i32 bool via ToBoolean inside the cond buffer,
    // instead of bailing to legacy (#1980). Mirrors the while-loop arm.
    condResult = coerceLoopCondToBool(raw, innerCx, "for");
  });
  if (condResult === null || condResult === undefined) {
    throw new Error(`ir/from-ast: for cond produced no SSA value (${cx.funcName})`);
  }

  // 3. Body — collect into a buffer.
  // (#2766) Counted-loop in-bounds proof (port of legacy `safeIndexedArrays`):
  // when this `for` is provably `for (let i = <k≥0>; i < arr.length; i++/+=k>0)`
  // and the body never mutates `i` / `arr` / `arr.length` and has no nested
  // function, every `arr[i]` in the body is provably `0 <= i < arr.length`, so it
  // keeps the fast unchecked `vec.get`. Thread the proven pair onto a body-scoped
  // cx (immutable copy → no leak to siblings; nested loops accumulate outward).
  const provenPair = detectCountedLoopSafeIndex(stmt);
  // #2952 slice 2 — synthesise the loop's label; the body cx carries it as
  // the innermost break/continue target (a continue jumps to the update).
  const loopLabel = innerCx.builder.freshLoopLabel();
  const bodyCx: LowerCtx = provenPair
    ? { ...innerCx, safeIndexedArrays: new Set([...(innerCx.safeIndexedArrays ?? []), provenPair]), loopLabel }
    : { ...innerCx, loopLabel };
  const bodyInstrs = innerCx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });

  // 4. Update — collect into a buffer (or empty if absent).
  const updateInstrs: IrInstr[] = stmt.incrementor
    ? innerCx.builder.collectBodyInstrs(() => {
        lowerForUpdateExpr(stmt.incrementor!, innerCx);
      })
    : [];

  innerCx.builder.emitForLoop({
    cond: condInstrs,
    condValue: condResult,
    body: bodyInstrs,
    update: updateInstrs,
    loopLabel,
  });
}

/**
 * Slice 12 (#1280): lower the update clause of a `for` loop. Mirrors
 * the body-statement dispatcher's expression-statement branch (postfix
 * `i++` / `i--`, prefix, plain assignment, compound assignment) but
 * drops the result.
 */
function lowerForUpdateExpr(expr: ts.Expression, cx: LowerCtx): void {
  if (ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr)) {
    const op = expr.operator;
    if ((op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) && ts.isIdentifier(expr.operand)) {
      lowerIncrementDecrement(expr.operand, op, cx);
      return;
    }
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken && ts.isIdentifier(expr.left)) {
      lowerIdentifierAssignment(expr.left, expr.right, cx);
      return;
    }
    if (
      (op === ts.SyntaxKind.PlusEqualsToken ||
        op === ts.SyntaxKind.MinusEqualsToken ||
        op === ts.SyntaxKind.AsteriskEqualsToken ||
        op === ts.SyntaxKind.SlashEqualsToken) &&
      ts.isIdentifier(expr.left)
    ) {
      lowerCompoundAssignment(expr.left, op, expr.right, cx);
      return;
    }
  }
  // Fallback: lower as an expression and drop the result.
  void lowerExpr(expr, cx, irVal({ kind: "f64" }));
}

/**
 * Slice 6 part 3 (#1182) iter-host emit helper, factored out of
 * `lowerForOfStatement` so the string-arm host-strings fall-through can
 * reuse it. `alreadyExternref` skips the `extern.convert_any` coercion
 * when the input value is already externref-typed at the Wasm level
 * (true for `(val) externref` and for `IrType.string` in host mode).
 */
function lowerForOfIterFromExternrefValue(
  stmt: ts.ForOfStatement,
  cx: LowerCtx,
  iterableV: IrValueId,
  loopVarName: string,
  alreadyExternref: boolean,
): void {
  let iterableExt = iterableV;
  if (!alreadyExternref) {
    iterableExt = cx.builder.emitCoerceToExternref(iterableV);
  }

  const iterSlot = cx.builder.declareSlot("__forof_iter", { kind: "externref" });
  const resultSlot = cx.builder.declareSlot("__forof_result", { kind: "externref" });
  const elementSlot = cx.builder.declareSlot("__forof_elem", { kind: "externref" });

  const elemIrT: IrType = irVal({ kind: "externref" });
  const bodyScope = new Map(cx.scope);
  bodyScope.set(loopVarName, { kind: "slot", slotIndex: elementSlot, type: elemIrT });
  // #2952 slice 2 — this loop is the innermost break/continue target.
  // (#2856) …and an early-return BARRIER (iter cleanup / conservative).
  const loopLabel = cx.builder.freshLoopLabel();
  const bodyCx: LowerCtx = { ...cx, scope: bodyScope, loopLabel, noEarlyReturn: true };

  const body = cx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });

  cx.builder.emitForOfIter({
    iterable: iterableExt,
    iterSlot,
    resultSlot,
    elementSlot,
    body,
    loopLabel,
  });
}

/**
 * Slice 6 part 4 (#1183) — native-strings string for-of. Iterates code
 * units via `__str_charAt(str, i)`. The element IR type is `string`
 * (single-char string ref); body code can compose with slice-1 string
 * ops. The slot ValType is `(ref $AnyString)`, supplied by
 * `nativeStringRefValType` (the lowering-time resolver shape — we
 * synthesize the same shape here so from-ast doesn't need a resolver
 * thread-through). The lowerer cross-checks the slot type against
 * `resolver.resolveString()` at emit time.
 */
function lowerForOfString(stmt: ts.ForOfStatement, cx: LowerCtx, strV: IrValueId, loopVarName: string): void {
  // Native-strings mode requires the resolver's `resolveString()` to
  // produce a `(ref $AnyString)` ValType. If the resolver is absent,
  // the function falls back to legacy via the throw — same outcome
  // as before #1185, just wired through one indirection.
  const strRef = cx.resolver?.resolveString?.();
  if (!strRef || strRef.kind !== "ref") {
    throw new Error(`ir/from-ast: native-strings for-of needs resolver.resolveString() (${cx.funcName})`);
  }

  const counterSlot = cx.builder.declareSlot("__forof_si", { kind: "i32" });
  const lengthSlot = cx.builder.declareSlot("__forof_slen", { kind: "i32" });
  const strSlot = cx.builder.declareSlot("__forof_str", strRef);
  const elementSlot = cx.builder.declareSlot("__forof_selem", strRef);

  // The loop variable is bound as a slot of `(ref $AnyString)`. In
  // native-strings mode the `IrType.string` lowering also produces
  // `(ref $AnyString)`, so as a Wasm value the slot read result and a
  // string-typed SSA value are interchangeable.
  //
  // Slice 6 part 4 refactor (#1185): we tag the binding with
  // `asType: IrType.string` so identifier reads of the loop var
  // produce SSA values typed `IrType.string` rather than
  // `irVal((ref $AnyString))`. This lets body code compose with
  // slice-1 string ops (`c + "world"`, `c.length`, etc.). The
  // underlying Wasm op is unchanged — `slot.read` against the
  // externref-or-ref slot — only the SSA type tag is rewritten.
  const elemIrT: IrType = irVal(strRef);
  const bodyScope = new Map(cx.scope);
  bodyScope.set(loopVarName, {
    kind: "slot",
    slotIndex: elementSlot,
    type: elemIrT,
    asType: { kind: "string" },
  });
  // #2952 slice 2 — this loop is the innermost break/continue target.
  // (#2856) …and an early-return BARRIER (iter cleanup / conservative).
  const loopLabel = cx.builder.freshLoopLabel();
  const bodyCx: LowerCtx = { ...cx, scope: bodyScope, loopLabel, noEarlyReturn: true };

  const body = cx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });

  cx.builder.emitForOfString({
    str: strV,
    counterSlot,
    lengthSlot,
    strSlot,
    elementSlot,
    body,
    loopLabel,
  });
}

/**
 * Slice 6 part 2 (#1181) vec fast-path — extracted into a helper so
 * `lowerForOfStatement` can dispatch between vec and iter-host arms.
 */
function lowerForOfVec(
  stmt: ts.ForOfStatement,
  cx: LowerCtx,
  iterableV: IrValueId,
  valTy: ValType,
  loopVarName: string,
): void {
  // Slice 6 part 4 refactor (#1185): ask the resolver for the vec
  // shape rather than hard-coding `f64` element / `vecTypeIdx - 1`
  // data-array assumptions. The resolver inspects the actual
  // registered struct fields and returns the correct element
  // ValType + array typeIdx; we synthesize the data-field ValType
  // (a non-null ref to the array type) from the latter.
  //
  // Fall back to the legacy heuristic only if the resolver is
  // absent (older callers / tests) — same behavior as before #1185.
  let elemValType: ValType | null = null;
  let dataValType: ValType | null = null;
  const vec = cx.resolver?.resolveVec?.(valTy);
  if (vec) {
    elemValType = vec.elementValType;
    dataValType = { kind: "ref", typeIdx: vec.arrayTypeIdx };
  } else {
    elemValType = inferVecElementValTypeFromContext(valTy, cx);
    dataValType = inferVecDataValTypeFromContext(valTy, cx);
  }
  if (!elemValType) {
    throw new Error(`ir/from-ast: for-of iterable's IR type is not a recognisable vec in ${cx.funcName}`);
  }
  const elemIrT = irVal(elemValType);

  if (!dataValType) {
    throw new Error(`ir/from-ast: for-of vec has unexpected data field shape (${cx.funcName})`);
  }
  const counterSlot = cx.builder.declareSlot("__forof_i", { kind: "i32" });
  const lengthSlot = cx.builder.declareSlot("__forof_len", { kind: "i32" });
  const vecSlot = cx.builder.declareSlot("__forof_vec", valTy);
  const dataSlot = cx.builder.declareSlot("__forof_data", dataValType);
  const elementSlot = cx.builder.declareSlot("__forof_elem", elemValType);

  const bodyScope = new Map(cx.scope);
  bodyScope.set(loopVarName, { kind: "slot", slotIndex: elementSlot, type: elemIrT });
  // #2952 slice 2 — this loop is the innermost break/continue target.
  // (#2856) …and an early-return BARRIER (iter cleanup / conservative).
  const loopLabel = cx.builder.freshLoopLabel();
  const bodyCx: LowerCtx = { ...cx, scope: bodyScope, loopLabel, noEarlyReturn: true };

  const body = cx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });

  cx.builder.emitForOfVec({
    vec: iterableV,
    elementType: elemIrT,
    counterSlot,
    lengthSlot,
    vecSlot,
    dataSlot,
    elementSlot,
    body,
    loopLabel,
  });
}

/**
 * Recover the element ValType of a vec from its `(ref|ref_null) $vec_*`
 * ValType by walking the legacy type registry (same lookup the
 * resolver's `resolveVec` performs at lowering time, but inlined here
 * because the from-ast layer doesn't have direct access to the
 * resolver). Returns `null` if the struct shape isn't recognisable as
 * a vec.
 *
 * The IR builder doesn't have access to `ctx.mod.types` directly —
 * we'd need to thread the resolver through `LowerCtx` for that. For
 * slice-6 part 2 we reuse the typeOf+structInspect mechanism the
 * resolver itself uses, but inline. Future cleanup can hoist this
 * into the resolver and pass it through `LowerCtx`.
 */
function inferVecElementValTypeFromContext(_valTy: ValType, _cx: LowerCtx): ValType | null {
  // Slice 6 part 2 deferred design: the legacy vec IS always shaped as
  // `{ length: i32, data: (ref $arr_<elem>) }` for f64-element vecs
  // (the only variety the IR-claimable Array<number> path produces in
  // slice 6). The lowerer's resolveVec verifies the shape; from-ast
  // just needs the element ValType to size the element slot. For
  // slice-6's narrow vec scope we hardcode `f64` — the resolver will
  // throw at lowering time if the actual struct shape differs.
  //
  // A cleaner design (deferred to a follow-up) threads the resolver
  // through `LowerCtx` so this function can call `resolveVec(valTy)`
  // and read `elementValType` off the result. The current shape works
  // for the slice-6 vec test cases and matches the spec's deferred-
  // design stance.
  return { kind: "f64" };
}

/**
 * Recover the vec's data-array ValType (the `data` field type, a
 * non-null `(ref $arr_<elem>)`). Same caveats as
 * `inferVecElementValTypeFromContext` — slice-6 hardcodes the
 * data-field as `(ref $arr_f64)` since that's what the legacy
 * `getOrRegisterVecType("f64", ...)` produces and matches every
 * IR-claimable Array<number> param.
 */
function inferVecDataValTypeFromContext(valTy: ValType, _cx: LowerCtx): ValType | null {
  // The data-array typeIdx for a vec at typeIdx N is N - 1 in the
  // legacy registry (the array type is registered first, then the
  // wrapping vec struct). This is brittle but matches the layout the
  // legacy `getOrRegisterArrayType` + `getOrRegisterVecType` produce.
  // Revisit when threading the resolver through LowerCtx (see the
  // note on `inferVecElementValTypeFromContext`).
  if (valTy.kind !== "ref" && valTy.kind !== "ref_null") return null;
  const vecTypeIdx = (valTy as { typeIdx: number }).typeIdx;
  // Default: data is always at vecTypeIdx - 1 in the legacy layout.
  return { kind: "ref", typeIdx: vecTypeIdx - 1 };
}

/**
 * Slice 6 part 2 (#1181): body-statement dispatcher. Mirrors the
 * `isPhase1BodyStatement` selector arm in `src/ir/select.ts` —
 * accepts Block (recurses), VariableStatement, identifier-LHS /
 * property-LHS / compound-assignment ExpressionStatements, bare
 * CallExpression, and nested ForOfStatement.
 *
 * No fall-through if/else, no nested closures, no early-return —
 * those are statement-list / tail-context features that don't make
 * sense inside a non-terminating loop body.
 */
function lowerStmt(stmt: ts.Statement, cx: LowerCtx): void {
  if (ts.isBlock(stmt)) {
    const childCx: LowerCtx = { ...cx, scope: new Map(cx.scope) };
    for (const s of stmt.statements) {
      lowerStmt(s, childCx);
      // #2952 slice 2 — a break/continue terminates its buffer (the
      // verifier requires br.label to be last); statements after it are
      // dead code — skip them rather than emit unreachable instrs.
      if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) break;
    }
    return;
  }
  if (ts.isVariableStatement(stmt)) {
    lowerVarDecl(stmt, cx);
    return;
  }
  if (ts.isExpressionStatement(stmt)) {
    if (ts.isCallExpression(stmt.expression)) {
      // (#2856) Method-shaped statement calls in body position — statement
      // position, so void extern/console methods are legal.
      if (ts.isPropertyAccessExpression(stmt.expression.expression) && !stmt.expression.questionDotToken) {
        void lowerMethodCall(stmt.expression, cx, /* statementPosition */ true);
        return;
      }
      // (#2856 C4) Statement position — a VOID direct call is legal.
      void lowerCall(stmt.expression, cx, /* statementPosition */ true);
      return;
    }
    // Slice 7a (#1169f): `yield <expr>;` inside a for-of body. The
    // selector accepts this shape; the lowerer enforces the enclosing
    // function is a generator via `lowerYield`.
    if (ts.isYieldExpression(stmt.expression)) {
      lowerYield(stmt.expression, cx);
      return;
    }
    if (ts.isBinaryExpression(stmt.expression)) {
      const op = stmt.expression.operatorToken.kind;
      // Plain assignment `<id> = <expr>` — id MUST resolve to a `slot`
      // binding (mutation pre-pass should have detected it). For
      // property assignment, dispatch to `lowerPropertyAssignment`
      // (the slice-4 helper).
      if (op === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(stmt.expression.left)) {
          lowerIdentifierAssignment(stmt.expression.left, stmt.expression.right, cx);
          return;
        }
        if (ts.isPropertyAccessExpression(stmt.expression.left)) {
          lowerPropertyAssignment(stmt.expression, cx);
          return;
        }
        // (#2856 C2) element store `arr[i] = v;` in a body buffer.
        if (ts.isElementAccessExpression(stmt.expression.left)) {
          lowerElementStore(stmt.expression.left, stmt.expression.right, cx);
          return;
        }
      }
      // Compound assignment `<id> <op>= <expr>` — desugar to
      // `<id> = <id> <binop> <expr>`. The binop maps from the
      // compound-assignment token kind. This keeps the lowering
      // straightforward; the optimizer can fold redundant reads later.
      if (
        op === ts.SyntaxKind.PlusEqualsToken ||
        op === ts.SyntaxKind.MinusEqualsToken ||
        op === ts.SyntaxKind.AsteriskEqualsToken ||
        op === ts.SyntaxKind.SlashEqualsToken
      ) {
        if (ts.isIdentifier(stmt.expression.left)) {
          lowerCompoundAssignment(stmt.expression.left, op, stmt.expression.right, cx);
          return;
        }
      }
    }
    // Slice 12 (#1280): postfix `i++` / `i--` and prefix `++i` / `--i`
    // as expression statements. Desugar to compound assignment by
    // synthesizing a `PlusEquals`/`MinusEquals` lowering against
    // an i32(1)/f64(1) literal — the value semantics for use as an
    // expression-statement match: the RHS is read, modified, written
    // back, the result is dropped.
    if (ts.isPostfixUnaryExpression(stmt.expression) || ts.isPrefixUnaryExpression(stmt.expression)) {
      const op = stmt.expression.operator;
      if (
        (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(stmt.expression.operand)
      ) {
        lowerIncrementDecrement(stmt.expression.operand, op, cx);
        return;
      }
    }
    throw new Error(`ir/from-ast: unsupported body ExpressionStatement shape in ${cx.funcName}`);
  }
  if (ts.isForOfStatement(stmt)) {
    lowerForOfStatement(stmt, cx);
    return;
  }
  // Slice 12 (#1280): nested while / for loops inside a body buffer.
  if (ts.isWhileStatement(stmt)) {
    lowerWhileStatement(stmt, cx);
    return;
  }
  if (ts.isForStatement(stmt)) {
    lowerForStatement(stmt, cx);
    return;
  }
  // #2952 slice 1: nested `do { body } while (cond)` inside a body buffer.
  if (ts.isDoStatement(stmt)) {
    lowerDoStatement(stmt, cx);
    return;
  }
  // Slice 9 (#1169h) — throw / try inside a body-statement context.
  if (ts.isThrowStatement(stmt)) {
    lowerThrowStatement(stmt, cx);
    return;
  }
  if (ts.isTryStatement(stmt)) {
    lowerTryStatement(stmt, cx);
    return;
  }
  // #2952 slice 2 — statement-level if inside a body buffer.
  if (ts.isIfStatement(stmt)) {
    lowerIfBodyStatement(stmt, cx);
    return;
  }
  // #2952 slice 2 — unlabeled break / continue against the innermost loop.
  if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) {
    lowerBreakContinueStatement(stmt, cx);
    return;
  }
  // (#2856 C1) Early `return` inside a body buffer — `if (v === target)
  // return mid;` inside a while loop. Lowers to the Wasm `return` op via
  // the `early.return` instr. Guarded against contexts where that is
  // unsound (generators, try/finally, iterator-protocol for-of) — the
  // selector mirrors these guards so accepted shapes always lower.
  if (ts.isReturnStatement(stmt)) {
    lowerEarlyReturn(stmt, cx);
    return;
  }
  throw new Error(`ir/from-ast: unsupported body statement ${ts.SyntaxKind[stmt.kind]} in ${cx.funcName}`);
}

/**
 * #2952 slice 2 — lower a statement-position `if (cond) then [else]` inside
 * a body buffer to the void `if.stmt` IR instr. Unlike the top-level
 * statement-list `if` (which uses the block-CFG layer), nested buffers have
 * no CFG access, so this stays fully structured: cond is lowered INLINE in
 * the current buffer (evaluated once), each arm is collected into its own
 * sub-buffer with a cloned scope (arm-local `let`s don't leak).
 */
function lowerIfBodyStatement(stmt: ts.IfStatement, cx: LowerCtx): void {
  const raw = lowerExpr(stmt.expression, cx, irVal({ kind: "i32" }));
  // Numeric-truthiness conds coerce via the shared NaN-safe ToBoolean
  // (#2136); ref/string conds throw → legacy fallback, same discipline as
  // the loop conds.
  const cond = coerceLoopCondToBool(raw, cx, "if");
  const thenCx: LowerCtx = { ...cx, scope: new Map(cx.scope) };
  const thenInstrs = cx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.thenStatement, thenCx);
  });
  const elseInstrs = stmt.elseStatement
    ? cx.builder.collectBodyInstrs(() => {
        lowerStmt(stmt.elseStatement!, { ...cx, scope: new Map(cx.scope) });
      })
    : [];
  cx.builder.emitIfStmt({ cond, then: thenInstrs, else: elseInstrs });
}

/**
 * #2952 slice 2 — lower an unlabeled `break;` / `continue;` to `br.label`
 * against the innermost enclosing loop's synthesised label (threaded on
 * `cx.loopLabel` by every loop lowerer). The selector's `inLoop` gate
 * guarantees a label is in scope and the statement is unlabeled; the
 * throws are internal-invariant assertions, not fallback paths.
 */
function lowerBreakContinueStatement(stmt: ts.BreakStatement | ts.ContinueStatement, cx: LowerCtx): void {
  const kind = ts.isBreakStatement(stmt) ? "break" : "continue";
  if (stmt.label) {
    throw new Error(`ir/from-ast: labeled ${kind} not in #2952 slice 2 (${cx.funcName})`);
  }
  if (cx.loopLabel === undefined) {
    throw new Error(`ir/from-ast: ${kind} outside a claimed loop — selector gate failed (${cx.funcName})`);
  }
  cx.builder.emitBrLabel(cx.loopLabel, kind);
}

/**
 * (#2856 C1) Lower an early `return [expr]` in body-statement position.
 * Mirrors `lowerTail`'s return handling (void discard, value coercion via
 * `coerceReturnValue`) but emits the `early.return` instr instead of a
 * block terminator — the buffer isn't a block, and the Wasm `return` op
 * unwinds the enclosing loop blocks natively.
 */
function lowerEarlyReturn(stmt: ts.ReturnStatement, cx: LowerCtx): void {
  if (cx.funcKind === "generator") {
    // A generator's `return` routes through __gen_set_return / the buffer
    // epilogue — a plain Wasm return would skip the generator wrap. The
    // selector rejects the shape; this is the defensive mirror.
    throw new Error(`ir/from-ast: early return inside a generator not in IR scope (${cx.funcName})`);
  }
  if (cx.noEarlyReturn) {
    // Inside try/catch/finally (would skip inlined finally) or an
    // iterator-protocol for-of body (would skip iter.return cleanup).
    throw new Error(`ir/from-ast: early return inside try/for-of-iter not in IR scope (${cx.funcName})`);
  }
  if (cx.returnType === null) {
    if (stmt.expression) {
      // Lower for side effects but discard the value (void function).
      lowerExpr(stmt.expression, cx, irVal({ kind: "externref" }));
    }
    cx.builder.emitEarlyReturn(null);
    return;
  }
  if (!stmt.expression) {
    throw new Error(`ir/from-ast: early bare return in non-void function in ${cx.funcName}`);
  }
  const v = lowerExpr(stmt.expression, cx, cx.returnType);
  cx.builder.emitEarlyReturn(coerceReturnValue(v, cx));
}

/**
 * Lower `<id> = <expr>` where `<id>` is a slot-bound identifier.
 * Throws if the binding isn't a slot — mutation of a `local` would
 * silently produce wrong results (the reassignment wouldn't be
 * observable through the existing SSA value), so the mutation
 * pre-pass should have flagged the name.
 */
function lowerIdentifierAssignment(id: ts.Identifier, rhs: ts.Expression, cx: LowerCtx): void {
  const binding = cx.scope.get(id.text);
  if (!binding) {
    throw new Error(`ir/from-ast: assignment to undeclared identifier "${id.text}" in ${cx.funcName}`);
  }
  if (binding.kind !== "slot") {
    throw new Error(
      `ir/from-ast: assignment to non-slot binding "${id.text}" — mutation pre-pass should have detected it (${cx.funcName})`,
    );
  }
  // Slice 6 part 4 refactor (#1185): when the binding has an asType
  // widening, the IR type the body sees is `asType`, not the
  // underlying slot ValType. Use `asType` for the lowering hint and
  // type check; the slot.write itself accepts any value of the
  // underlying ValType, which `asType` agrees with at the Wasm
  // level (the asType invariant guarantees this).
  const logicalType = binding.asType ?? binding.type;
  const newValue = lowerExpr(rhs, cx, logicalType);
  const newType = cx.builder.typeOf(newValue);
  if (!irTypeEquals(newType, logicalType)) {
    throw new Error(
      `ir/from-ast: assignment to "${id.text}" (${describeIrType(logicalType)}) got ${describeIrType(newType)} in ${cx.funcName}`,
    );
  }
  cx.builder.emitSlotWrite(binding.slotIndex, newValue);
}

/**
 * Lower `<id> <op>= <expr>` by desugaring to `<id> = <id> <binop> <expr>`.
 * The binop is the arithmetic/comparison operator implied by the
 * compound-assignment token (e.g. `+=` → `f64.add` for f64 operands).
 * Only handles f64 operands in slice 6 — i32 (boolean) compound
 * assignment is rare and deferred.
 */
function lowerCompoundAssignment(id: ts.Identifier, compoundOp: ts.SyntaxKind, rhs: ts.Expression, cx: LowerCtx): void {
  const binding = cx.scope.get(id.text);
  if (!binding) {
    throw new Error(`ir/from-ast: compound assign to undeclared identifier "${id.text}" in ${cx.funcName}`);
  }
  if (binding.kind !== "slot") {
    throw new Error(
      `ir/from-ast: compound assign to non-slot binding "${id.text}" — mutation pre-pass should have detected it (${cx.funcName})`,
    );
  }
  const slotValType = asVal(binding.type);
  if (!slotValType || slotValType.kind !== "f64") {
    throw new Error(
      `ir/from-ast: compound assign to non-f64 slot "${id.text}" (${describeIrType(binding.type)}) not in slice 6 (${cx.funcName})`,
    );
  }

  // Desugar: read the slot, lower the RHS, apply the binop, write back.
  const lhs = cx.builder.emitSlotRead(binding.slotIndex);
  const rhsValue = lowerExpr(rhs, cx, binding.type);
  const rhsType = cx.builder.typeOf(rhsValue);
  if (asVal(rhsType)?.kind !== "f64") {
    throw new Error(`ir/from-ast: compound assign RHS must be f64 (got ${describeIrType(rhsType)}) in ${cx.funcName}`);
  }

  let binop: IrBinop;
  switch (compoundOp) {
    case ts.SyntaxKind.PlusEqualsToken:
      binop = "f64.add";
      break;
    case ts.SyntaxKind.MinusEqualsToken:
      binop = "f64.sub";
      break;
    case ts.SyntaxKind.AsteriskEqualsToken:
      binop = "f64.mul";
      break;
    case ts.SyntaxKind.SlashEqualsToken:
      binop = "f64.div";
      break;
    default:
      throw new Error(`ir/from-ast: unsupported compound assign op ${ts.SyntaxKind[compoundOp]} in ${cx.funcName}`);
  }
  const result = cx.builder.emitBinary(binop, lhs, rhsValue, irVal({ kind: "f64" }));
  cx.builder.emitSlotWrite(binding.slotIndex, result);
}

/**
 * Slice 12 (#1280): `<id>++` / `<id>--` / `++<id>` / `--<id>` as an
 * expression statement. Lowers to a slot read, +/- 1, slot write.
 * Result value is discarded (we're in expression-statement position).
 *
 * Both i32 and f64 slots are supported — the typical loop counter is
 * f64 (typed `number`) but `type i32 = number` annotated counters use
 * i32. The binop dispatches on the slot ValType.
 */
function lowerIncrementDecrement(id: ts.Identifier, op: ts.SyntaxKind, cx: LowerCtx): void {
  const binding = cx.scope.get(id.text);
  if (!binding) {
    throw new Error(`ir/from-ast: increment/decrement of undeclared "${id.text}" in ${cx.funcName}`);
  }
  if (binding.kind !== "slot") {
    throw new Error(
      `ir/from-ast: increment/decrement of non-slot "${id.text}" — mutation pre-pass should have detected it (${cx.funcName})`,
    );
  }
  const slotValType = asVal(binding.type);
  // The IR's binop set only includes f64 arithmetic — i32 add/sub
  // would need additional binop variants. For now, restrict to f64
  // counters (the common case for `let i = 0; i++` where `i: number`).
  // i32-typed counters fall back to legacy via the lowerer's throw.
  if (!slotValType || slotValType.kind !== "f64") {
    throw new Error(
      `ir/from-ast: increment/decrement of non-f64 slot "${id.text}" (${describeIrType(binding.type)}) not in slice 12 (${cx.funcName})`,
    );
  }
  const lhs = cx.builder.emitSlotRead(binding.slotIndex);
  const isAdd = op === ts.SyntaxKind.PlusPlusToken;
  const oneIr: IrType = irVal({ kind: "f64" });
  const one = cx.builder.emitConst({ kind: "f64", value: 1 }, oneIr);
  const binop: IrBinop = isAdd ? "f64.add" : "f64.sub";
  const result = cx.builder.emitBinary(binop, lhs, one, oneIr);
  cx.builder.emitSlotWrite(binding.slotIndex, result);
}

function lowerConditional(expr: ts.ConditionalExpression, cx: LowerCtx): IrValueId {
  const rawCond = lowerExpr(expr.condition, cx, irVal({ kind: "i32" }));
  const condType = cx.builder.typeOf(rawCond);
  // #2949 S5.1 — a boxed-any (dynamic) ternary condition lowers ToBoolean via
  // `dyn.truthy`, emitted before the `if` so it evaluates once. Reachable only
  // when the selector admits a dynamic condition (S5.P); exercised by
  // hand-built-IR unit tests until then (byte-inert on the corpus).
  const cond = condType.kind === "dynamic" ? cx.builder.emitDynTruthy(rawCond) : rawCond;
  if (condType.kind !== "dynamic" && asVal(condType)?.kind !== "i32") {
    throw new Error(`ir/from-ast: ternary condition must be bool in ${cx.funcName}`);
  }

  // #1820 — short-circuit semantics: only the selected arm may run. A prior
  // implementation lowered both arms eagerly and combined them with Wasm
  // `select`, which evaluates BOTH operands. That is fine for pure arms but
  // wrong when an arm has side effects or recurses (e.g.
  // `n <= 1 ? 1 : n * fact(n - 1)` recursed at the base case → non-termination).
  // Lower each arm into its own body buffer and combine with `IrInstrIf`, so
  // the lowerer emits a structured `if`/`else` that runs exactly one arm.
  let whenTrue!: IrValueId;
  const thenBody = cx.builder.collectBodyInstrs(() => {
    whenTrue = lowerExpr(expr.whenTrue, cx, irVal({ kind: "f64" }));
  });
  const ttype = cx.builder.typeOf(whenTrue);

  // Hint the false arm with the true arm's type so both land on the same
  // carrier (matches the `lowerNullish` convention).
  let whenFalse!: IrValueId;
  const elseBody = cx.builder.collectBodyInstrs(() => {
    whenFalse = lowerExpr(expr.whenFalse, cx, ttype);
  });
  const ftype = cx.builder.typeOf(whenFalse);

  const tVal = asVal(ttype);
  const fVal = asVal(ftype);
  if (!tVal || !fVal || tVal.kind !== fVal.kind) {
    throw new Error(
      `ir/from-ast: ternary branches have different types (${describeIrType(ttype)} vs ${describeIrType(ftype)}) in ${cx.funcName}`,
    );
  }

  return cx.builder.emitIfElse({
    cond,
    then: thenBody,
    thenValue: whenTrue,
    else: elseBody,
    elseValue: whenFalse,
    resultType: ttype,
  });
}

function lowerPrefixUnary(expr: ts.PrefixUnaryExpression, cx: LowerCtx): IrValueId {
  // #2135 — capability-table invariant, mirroring `lowerBinary`. A deferred
  // prefix op post-claim is a selector↔table disagreement (compiler bug).
  assertNotDeferred(
    prefixOpCapability(expr.operator),
    `prefix operator '${ts.tokenToString(expr.operator) ?? expr.operator}'`,
    cx.funcName,
  );
  const rand = lowerExpr(expr.operand, cx, irVal({ kind: "f64" }));
  switch (expr.operator) {
    case ts.SyntaxKind.MinusToken: {
      const randType = typeOfValue(rand, cx);
      if (asVal(randType)?.kind !== "f64") {
        throw new Error(`ir/from-ast: unary '-' expects number in ${cx.funcName}`);
      }
      return cx.builder.emitUnary("f64.neg", rand, irVal({ kind: "f64" }));
    }
    case ts.SyntaxKind.PlusToken: {
      const randType = typeOfValue(rand, cx);
      if (asVal(randType)?.kind !== "f64") {
        throw new Error(`ir/from-ast: unary '+' expects number in ${cx.funcName}`);
      }
      return rand;
    }
    case ts.SyntaxKind.ExclamationToken: {
      const randType = typeOfValue(rand, cx);
      if (asVal(randType)?.kind !== "i32") {
        throw new Error(`ir/from-ast: unary '!' expects bool in ${cx.funcName}`);
      }
      return cx.builder.emitUnary("i32.eqz", rand, irVal({ kind: "i32" }));
    }
    default:
      throw new Error(`ir/from-ast: unsupported prefix operator ${ts.SyntaxKind[expr.operator]} in ${cx.funcName}`);
  }
}

/**
 * #2781 (hybrid Row 7) — TS-type-keyed primitive classifier. The reusable
 * operand-type proof shared by the binary fast paths (and, going forward, rows
 * 3 packed-`i32` and 5 unboxed-number-locals, which need the same "provably
 * number / does-not-escape-to-`any`" judgement).
 *
 * Returns the provable primitive class of a TS type for the purpose of
 * discharging a fast-path safety predicate `P`:
 *   - `"number"`  — provably a pure number: `NumberLike` (`Number |
 *     NumberLiteral`, incl. numeric enum literals), or a union whose EVERY
 *     constituent is provably number.
 *   - `"string"`  — provably a pure string: `StringLike` (`String |
 *     StringLiteral`), template-literal / string-mapping types (always strings
 *     at runtime), or an all-string union.
 *   - `"unprovable"` — `any` / `unknown` / `object` / `boolean` (= the
 *     `true | false` union of non-number/string literals) / `bigint` /
 *     `symbol` / `null` / `undefined` / a MIXED `number | string` union /
 *     intersections / anything else. Only the SAFE dynamic lowering is correct.
 *
 * CRITICAL (the Row-7 trap that parked two prior attempts): this keys on the TS
 * *type*, NEVER the lowered Wasm kind. `number`, `boolean` and `symbol` all
 * collapse to `i32` / `f64` at the Wasm level, so the kind cannot distinguish a
 * numeric-add operand from a boolean / `any` one.
 */
const STRING_PROOF_FLAGS = ts.TypeFlags.StringLike | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping;

function classifyPrimitiveProof(t: ts.Type): "number" | "string" | "unprovable" {
  // Union (incl. the intrinsic `boolean`, which is internally `true | false`):
  // every constituent must share the SAME provable class. Any unprovable
  // constituent, a mixed number/string union, or an empty (`never`) union →
  // unprovable.
  if (t.isUnion()) {
    let acc: "number" | "string" | null = null;
    for (const c of t.types) {
      const cc = classifyPrimitiveProof(c);
      if (cc === "unprovable") return "unprovable";
      if (acc === null) acc = cc;
      else if (acc !== cc) return "unprovable";
    }
    return acc ?? "unprovable";
  }
  const f = t.flags;
  if (f & ts.TypeFlags.NumberLike) return "number";
  if (f & STRING_PROOF_FLAGS) return "string";
  return "unprovable";
}

/**
 * #2781 — per-operand wrapper around {@link classifyPrimitiveProof}. Returns
 * `"no-checker"` when no TS checker is available, so the caller can leave the
 * existing kind-based dispatch unchanged (mirrors #2780's no-checker arm: with
 * no checker there is no specialization whose unsoundness we would be masking).
 */
function proveAdditiveOperand(node: ts.Expression, cx: LowerCtx): "number" | "string" | "unprovable" | "no-checker" {
  const checker = cx.checker;
  if (!checker) return "no-checker";
  return classifyPrimitiveProof(checker.getTypeAtLocation(node));
}

/**
 * #2790 — is `t` provably a pure `boolean` (the intrinsic `true | false` union,
 * a `true` / `false` literal, or a union thereof)? Mirrors the recursive shape
 * of {@link classifyPrimitiveProof}, but for the boolean brand — which that
 * function deliberately reports as `"unprovable"` (a `boolean` is NOT a number,
 * so it must never enter the *number* no-box path). Used by the `i32`-arm of
 * {@link proveUnboxedNumberLocal} to recognise the OTHER sound no-box `i32`
 * brand: an unboxed `boolean` carries no runtime tag either, but #2785 made the
 * escape box brand-aware (`coerceType(i32 → externref)` picks `__box_boolean`
 * for a boolean-branded scalar), so a provably-boolean `i32` local is sound to
 * keep unboxed and boxes correctly on escape. `any` / `unknown` / a mixed union
 * are NOT provably boolean → not recognised here → demoted.
 */
function isProvablyBoolean(t: ts.Type): boolean {
  if (t.isUnion()) {
    // Every constituent must itself be provably boolean; an empty (`never`)
    // union is not (mirrors classifyPrimitiveProof's `acc ?? unprovable`).
    return t.types.length > 0 && t.types.every(isProvablyBoolean);
  }
  return (t.flags & ts.TypeFlags.BooleanLike) !== 0;
}

/**
 * #2782 (hybrid Row 5) + #2790 (i32 arm) — the no-box proof for an UNBOXED
 * NUMBER local. Reuses {@link classifyPrimitiveProof} (the #2781 operand-type
 * proof) to discharge the fast-path safety predicate `P` for the "keep a number
 * local unboxed" specialization.
 *
 * `lowerVarDecl` binds a local with a native, UNBOXED scalar representation
 * whenever its value lowers to (or is annotated) `f64` / `i32`. Per the Hybrid
 * Invariant that no-box specialization is only sound when the local's value
 * provably cannot be anything but a pure number: an unboxed scalar carries no
 * runtime tag, so at any later `any` / union / externref use it would be read
 * with the wrong identity (e.g. `typeof`, `===` against a string, a
 * boxed-`Number` round-trip). When the local's TS type is NOT provably a pure
 * number — `any` / `unknown` / `number | string` / etc. — the no-box path is
 * unsound and codegen must demote to the SAFE boxed legacy lowering (which
 * carries the dynamic tag).
 *
 * Returns `true` to KEEP the no-box fast path, `false` to DEMOTE.
 *
 * CRITICAL (the trap that parked two prior Row-1 attempts): this keys on the TS
 * *type* via `classifyPrimitiveProof`, NEVER the lowered Wasm kind. `number`,
 * `boolean` and `symbol` all collapse to `f64` / `i32`, so the Wasm kind cannot
 * tell a genuine numeric local from a boolean / `any` one.
 *
 * Scope by representation:
 *   - `f64` (#2782): keep ONLY when the TS type is provably a pure `number`;
 *     anything else (`any` / `number | string` opaquely coerced by the f64 hint)
 *     is unsound → demote.
 *   - `i32` (#2790): the `i32` representation hosts TWO sound, brand-determinable
 *     primitives — a `number` (e.g. `arr.length`, a native-`i32` typed number;
 *     boxes via `__box_number`) AND a `boolean` (boxes via `__box_boolean` since
 *     #2785 made `coerceType(i32 → externref)` brand-aware). Keep BOTH unboxed;
 *     demote only a genuinely-unprovable `i32` local (`any` / `unknown` / a mixed
 *     union — no determinable brand for the escape box). CRITICAL: a `boolean` is
 *     recognised by {@link isProvablyBoolean}, NOT by the number proof — it must
 *     never enter the *number* no-box path (which would box it via
 *     `__box_number`, corrupting it). Demoting every boolean (the naive
 *     "gate i32 on `classifyPrimitiveProof === 'number'`" trap that deferred this
 *     arm in #2782) would route every boolean-local function to legacy and grow
 *     an IR-fallback bucket — explicitly avoided here.
 *   - `i64` (bigint) / reference / string locals are out of scope (unaffected).
 *
 * No checker → there is no specialization whose unsoundness we would be masking
 * (every boundary use is still type-checked), so keep the existing behavior
 * unchanged (mirrors #2780 / #2781's no-checker arm).
 */
function proveUnboxedNumberLocal(name: ts.Identifier, boundType: IrType, cx: LowerCtx): boolean {
  const bv = asVal(boundType);
  if (!bv || (bv.kind !== "f64" && bv.kind !== "i32")) return true; // not a no-box scalar NUMBER representation — out of scope.
  const checker = cx.checker;
  if (!checker) return true; // no checker → leave behavior unchanged.
  const tsType = checker.getTypeAtLocation(name);
  if (classifyPrimitiveProof(tsType) === "number") return true; // provable number — keep (boxes __box_number on escape).
  // f64 hosts only the number brand: a non-number f64 was opaquely coerced and
  // is unsound to keep unboxed → demote.
  if (bv.kind === "f64") return false;
  // i32 arm (#2790): the OTHER sound i32 brand is a provable `boolean`, kept
  // unboxed and boxed via `__box_boolean` (#2785) at the escape edge. Anything
  // else i32 (`any` / mixed union — no determinable brand) → demote.
  return isProvablyBoolean(tsType);
}

function lowerBinary(expr: ts.BinaryExpression, cx: LowerCtx, hint: IrType): IrValueId {
  const op = expr.operatorToken.kind;

  // `??` nullish coalescing — IR-native short-circuit over a reference-
  // shaped lhs (`lhs ?? rhs`). Handled before the slice-11 early-throw
  // because, unlike `%` / `**` / `in` / `instanceof`, it has a lowering
  // when both arms are the same reference type. `lowerNullish` throws
  // clean fallback for non-reference / mismatched-type operands.
  if (op === ts.SyntaxKind.QuestionQuestionToken) {
    return lowerNullish(expr, cx, hint);
  }

  // #1820 — `&&` / `||` short-circuit. A prior implementation lowered both
  // operands eagerly and combined them with `i32.and` / `i32.or`, which
  // evaluates the right operand unconditionally — losing JS short-circuit
  // semantics (e.g. `guard && risky()` ran `risky()` even when `guard` was
  // false). Lower the right operand into its own body buffer and combine with
  // `IrInstrIf` so it runs only on the branch that needs it. Handled before
  // the eager operand lowering below, like `??`.
  if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    return lowerLogicalAndOr(expr, op, cx);
  }

  // #2135 — capability-table invariant (shared with the selector via
  // `src/ir/capability.ts`). The old slice-11 "shape-only acceptance" list
  // (`%` / `**` / `in` / `instanceof` claimed by the selector, thrown here)
  // is retired: those ops are table-deferred, the selector rejects them
  // up-front, and an op arriving here with a "defer" capability is a
  // claim-path BUG (loud internal error), not a legitimate legacy fallback.
  // Checked BEFORE operand lowering so a violation reports cleanly without
  // cascading operand errors.
  assertNotDeferred(binaryOpCapability(op), `binary operator '${ts.tokenToString(op) ?? op}'`, cx.funcName);

  // === / !== / == / != with a `null` literal: slice 1 has no nullable IR
  // types yet, so every operand we can lower trivially evaluates to false
  // for === null / true for !== null. Try this fold first; it short-
  // circuits the standard f64-hint lowering below (which would otherwise
  // recurse into a bare NullKeyword and throw).
  const nullFold = tryFoldNullCompare(expr, op, cx);
  if (nullFold !== null) return nullFold;

  // (#2856 C3) STRICT undefined-compare — `hit !== undefined`. Dispatch on
  // the non-undefined operand's IrType (mirrors the selector's acceptance):
  //   - externref-shaped (externref val / extern class / host string):
  //     runtime `__extern_is_undefined(v)` (the legacy check for the same
  //     shape), inverted for `!==`.
  //   - representations that can never hold the JS `undefined` VALUE
  //     (unboxed f64/i32 scalars, non-null WasmGC refs incl. vecs/classes/
  //     native strings — strict equality: `null !== undefined` is true too):
  //     constant fold, evaluating the operand for side effects.
  //   - anything else (boxed / union / dynamic): clean demote.
  const undefCompare = tryLowerUndefinedCompare(expr, op, cx);
  if (undefCompare !== null) return undefCompare;

  // #2781 (hybrid Row 7) — `+` operand-type proof gate. Run BEFORE operand
  // lowering (mirrors #2780's pre-element widening gate), so no dead operand
  // instrs are emitted and the demotion cause is the explicit HI reason rather
  // than an incidental downstream "mixed string/non-string" / `requireF64`
  // throw. `+` is string-concat-OR-numeric-add chosen at RUNTIME (ToPrimitive on
  // each operand, then "if either is a string → concatenate, else add"). The
  // kind-based dispatch below picks concat-vs-add from the lowered Wasm kind,
  // but per the Hybrid Invariant a T-directed specialization must be discharged
  // by a proof on the TS *type*, never the Wasm kind: number / boolean / symbol
  // all collapse to f64 / i32, so the kind alone cannot tell a genuine
  // numeric-add operand from an `any` / string / `string | number` one the f64
  // hint coerced opaquely (the Row-7 trap). Prove BOTH operands number (→ the
  // unboxed numeric add below) or BOTH string (→ `emitStringConcat`); anything
  // unprovable — `any` / union / a MIXED number+string pair — demotes to the
  // SAFE legacy dynamic `+` (`binary-ops.ts` `emitAnyAdd`, ToPrimitive +
  // string-concat-or-add). No checker → leave the existing kind-based dispatch
  // unchanged (#2780's no-checker arm). The same operand proof
  // (`proveAdditiveOperand` / `classifyPrimitiveProof`) is the reusable
  // infrastructure rows 3 / 5 adopt.
  if (op === ts.SyntaxKind.PlusToken) {
    const lProof = proveAdditiveOperand(expr.left, cx);
    const rProof = proveAdditiveOperand(expr.right, cx);
    if (lProof !== "no-checker" && rProof !== "no-checker") {
      if (lProof === "unprovable" || rProof === "unprovable" || lProof !== rProof) {
        throw new Error(
          `ir/from-ast: '+' operands not provably both-number or both-string ` +
            `(${lProof}/${rProof}) — the unboxed numeric-add / string-concat fast ` +
            `path is unsound here; demote to the SAFE dynamic '+' (emitAnyAdd) in ${cx.funcName}`,
        );
      }
    }
  }

  const lhs = lowerExpr(expr.left, cx, irVal({ kind: "f64" }));
  const rhs = lowerExpr(expr.right, cx, irVal({ kind: "f64" }));
  const lt = typeOfValue(lhs, cx);
  const rt = typeOfValue(rhs, cx);

  // #2949 S5.2 — dynamic equality: `===`/`!==`/`==`/`!=` where either operand
  // is a boxed-any carrier. The concrete operand is boxed into the carrier
  // (refining the box tag from a literal's kind where known), the dyn operand
  // is left as-is, and `dyn.eq` lowers through the CANONICAL
  // `__any_strict_eq`/`__any_eq` helpers (D4). Must precede the string-operand
  // path below (a `dyn === "s"` mixes dynamic + string). The payload-less
  // STRICT `dyn === null`/`dyn === undefined` cases were already handled by
  // `tryFoldNullCompare`/`tryLowerUndefinedCompare`'s dynamic arms (cheaper
  // exact `tag.test`), so they never reach here. Reachable only once the S5.P
  // selector scan admits dynamic-eq bodies; today the move-only gate rejects
  // them, so this arm is byte-inert.
  if (lt.kind === "dynamic" || rt.kind === "dynamic") {
    const dynEq = tryLowerDynamicEq(expr, op, lhs, rhs, lt, rt, cx);
    if (dynEq !== null) return dynEq;
    // #2949 S5.3 — dynamic relational: `<`/`>`/`<=`/`>=` where either operand
    // is a boxed-any carrier. Each dynamic operand is ToNumber'd to f64 via
    // `dyn.to_number` (routing to the CANONICAL `__any_to_f64` gc /
    // `__unbox_number` host — D4), then the existing `f64.lt`/`gt`/`le`/`ge`
    // compare runs. SCOPE — numeric-abstract only: a non-f64 concrete operand
    // (and hence the string×string lexicographic case) demotes cleanly. Same
    // byte-inertness as the eq arm — reachable only once the S5.P scan admits
    // dynamic-relational bodies (restricted to a numeric-literal counter-
    // operand, where ARC never takes the both-strings branch).
    const dynRel = tryLowerDynamicRelational(op, lhs, rhs, lt, rt, cx);
    if (dynRel !== null) return dynRel;
  }

  // String operand path (slice 1, #1169a) — `+`, `===`, `!==`, `==`, `!=`.
  // Any other operator with a string operand throws so the function falls
  // back to legacy.
  if (lt.kind === "string" || rt.kind === "string") {
    if (lt.kind !== "string" || rt.kind !== "string") {
      throw new Error(
        `ir/from-ast: mixed string/non-string operand for '${ts.tokenToString(op)}' is not in slice 1 (${cx.funcName})`,
      );
    }
    switch (op) {
      case ts.SyntaxKind.PlusToken:
        return cx.builder.emitStringConcat(lhs, rhs);
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
        return cx.builder.emitStringEq(lhs, rhs, false);
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        return cx.builder.emitStringEq(lhs, rhs, true);
      default:
        throw new Error(`ir/from-ast: string operator '${ts.tokenToString(op)}' not in slice 1 (${cx.funcName})`);
    }
  }

  const ltVal = asVal(lt);
  const rtVal = asVal(rt);
  if (!ltVal || !rtVal || ltVal.kind !== rtVal.kind) {
    throw new Error(
      `ir/from-ast: Phase 1 requires matching operand types for '${ts.tokenToString(op)}' in ${cx.funcName}`,
    );
  }

  const isF64 = ltVal.kind === "f64";
  const isI32 = ltVal.kind === "i32";

  // #1126 Stage 3 — when both operands are i32-typed, the operands' IR
  // signedness facts (set by Stage 1 when lowering the lattice) decide
  // signed-vs-unsigned ops. Both operands "signed" means:
  //   • bool/compare results (default-signed via `irVal`) → signed cmp
  //   • i32-domain (int32) values → signed cmp, signed shift, signed cast
  // Both operands "unsigned" (from u32-domain values) → unsigned variants.
  // Mixed signedness on the same i32 storage kind widens to signed
  // (the conservative choice — matches `i32.shr_s` semantics for values
  // that fit in [-2^31, 2^31)). The `?? true` mirrors `irTypeEquals`'s
  // default-is-signed convention.
  const lhsSigned = lt.kind === "val" ? (lt.signed ?? true) : true;
  const rhsSigned = rt.kind === "val" ? (rt.signed ?? true) : true;
  const i32Unsigned = isI32 && !lhsSigned && !rhsSigned;

  let binop: IrBinop;
  let resultType: IrType;

  switch (op) {
    case ts.SyntaxKind.PlusToken:
      requireF64(isF64, "+", cx.funcName);
      binop = "f64.add";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.MinusToken:
      requireF64(isF64, "-", cx.funcName);
      binop = "f64.sub";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.AsteriskToken:
      requireF64(isF64, "*", cx.funcName);
      binop = "f64.mul";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.SlashToken:
      requireF64(isF64, "/", cx.funcName);
      binop = "f64.div";
      resultType = irVal({ kind: "f64" });
      break;
    // #2945 — `a % b` lowers to a call of the Wasm-native exact-remainder
    // helper (`__fmod`, #2056): the SAME helper legacy's `emitModulo` emits,
    // so IR and legacy agree bit-for-bit on every edge (`x % 0` → NaN,
    // `-0 % x` → -0, `Inf % x` → NaN, `x % Inf` → x, large-quotient
    // exactness). Deliberately NOT the naive `a - trunc(a/b)*b` sequence —
    // legacy tried that and replaced it (ULP drift, collapse-to-0 for large
    // quotients, overflow to ±Inf; see `src/codegen/fmod.ts`). The symbolic
    // `__fmod` func ref is materialized on demand by the integration
    // resolver (`resolveFunc` calls `ensureFmod` — append-only, idempotent).
    // f64 operands only: i32-typed operands demote to legacy, which keeps
    // its `emitSafeI32Rem` i32 fast mode (trap-free rem semantics).
    case ts.SyntaxKind.PercentToken: {
      requireF64(isF64, "%", cx.funcName);
      const fmodResult = cx.builder.emitCall({ kind: "func", name: FMOD_FN }, [lhs, rhs], irVal({ kind: "f64" }));
      if (fmodResult === null) {
        // Unreachable: a non-null resultType always yields a value id.
        throw new Error(`ir/from-ast: internal — __fmod call produced no value in ${cx.funcName}`);
      }
      return fmodResult;
    }
    // #1126 Stage 3 — magnitude compares accept f64 OR i32 operands.
    // i32 operands emit native `i32.{lt,le,gt,ge}_{s,u}` based on
    // signedness; f64 keeps the legacy `f64.lt` etc. The result is
    // always i32 (bool).
    case ts.SyntaxKind.LessThanToken:
      if (!isF64 && !isI32) requireF64(isF64, "<", cx.funcName);
      binop = isF64 ? "f64.lt" : i32Unsigned ? "i32.lt_u" : "i32.lt_s";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.LessThanEqualsToken:
      if (!isF64 && !isI32) requireF64(isF64, "<=", cx.funcName);
      binop = isF64 ? "f64.le" : i32Unsigned ? "i32.le_u" : "i32.le_s";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.GreaterThanToken:
      if (!isF64 && !isI32) requireF64(isF64, ">", cx.funcName);
      binop = isF64 ? "f64.gt" : i32Unsigned ? "i32.gt_u" : "i32.gt_s";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      if (!isF64 && !isI32) requireF64(isF64, ">=", cx.funcName);
      binop = isF64 ? "f64.ge" : i32Unsigned ? "i32.ge_u" : "i32.ge_s";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      // Slice 14 (#1228) — externref operands need ref-equality semantics
      // that the IR doesn't model (no `ref.eq` between externrefs in
      // WasmGC). Throw cleanly so the function falls back to legacy
      // rather than emitting an invalid `i32.eq` on externref operands.
      if (!isF64 && !isI32) {
        throw new Error(
          `ir/from-ast: '${ts.tokenToString(op)}' on ${ltVal.kind} operands not supported in IR (${cx.funcName})`,
        );
      }
      binop = isF64 ? "f64.eq" : "i32.eq";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      // Slice 14 (#1228) — same fallback rationale as `===`/`==` above.
      if (!isF64 && !isI32) {
        throw new Error(
          `ir/from-ast: '${ts.tokenToString(op)}' on ${ltVal.kind} operands not supported in IR (${cx.funcName})`,
        );
      }
      binop = isF64 ? "f64.ne" : "i32.ne";
      resultType = irVal({ kind: "i32" });
      break;
    // `&&` / `||` are intercepted at the top of `lowerBinary` (#1820) and
    // lowered to a short-circuiting `IrInstrIf` before the eager operand
    // lowering above — they never reach this switch.
    // Slice 11 (#1169n) — bitwise ops on f64 operands. Each lowers to
    // ToInt32 + i32 op + convert back; the lowerer's `case "binary"`
    // arm dispatches on the `js.*` prefix to emit the multi-instr
    // sequence using a per-function scratch local pair. Result is
    // always f64.
    //
    // #1126 Stage 3 — also accept i32 operands. The lowerer's fast path
    // (in `lower.ts:case "binary"`) detects two i32 operands and emits
    // the native `i32.*` op directly, skipping the ToInt32 dance. The
    // result type stays f64 here so callers / returns / arithmetic
    // consumers don't need to be aware of an i32-narrowed value — the
    // lowerer tails the fast path with `f64.convert_i32_*`. Chained
    // bitwise composition (where the f64 round-trip could be skipped)
    // is left for a future Stage; the per-op fast path already covers
    // the cost-dominant cases (bool|bool, bool&bool, compare-result
    // bitwise reductions).
    case ts.SyntaxKind.AmpersandToken:
      if (!isF64 && !isI32) requireF64(isF64, "&", cx.funcName);
      binop = "js.bitand";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.BarToken:
      if (!isF64 && !isI32) requireF64(isF64, "|", cx.funcName);
      binop = "js.bitor";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.CaretToken:
      if (!isF64 && !isI32) requireF64(isF64, "^", cx.funcName);
      binop = "js.bitxor";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.LessThanLessThanToken:
      if (!isF64 && !isI32) requireF64(isF64, "<<", cx.funcName);
      binop = "js.shl";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      if (!isF64 && !isI32) requireF64(isF64, ">>", cx.funcName);
      binop = "js.shr_s";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      if (!isF64 && !isI32) requireF64(isF64, ">>>", cx.funcName);
      binop = "js.shr_u";
      resultType = irVal({ kind: "f64" });
      break;
    // Slice 11 (#1169n) — `%`, `**`, `in`, `instanceof` are intercepted by
    // the early-fallback check at the top of `lowerBinary`; `??` is handled
    // by `lowerNullish`. If any reach here the early-dispatch is missing.
    default:
      throw new Error(`ir/from-ast: unsupported binary operator ${ts.tokenToString(op)} in ${cx.funcName}`);
  }

  return cx.builder.emitBinary(binop, lhs, rhs, resultType);
}

/**
 * Lower `lhs ?? rhs` (nullish coalescing) IR-natively.
 *
 * Semantics: evaluate `lhs`; if it is `null` OR `undefined`, the result is
 * `rhs`, else `lhs`. IR Phase 1 has no nullable-union ValType, so the only
 * representation that can carry "a value that might be null" is a Wasm
 * reference (externref / ref_null). We therefore lower only when:
 *   - `lhs` lowers to a reference-shaped IrType (extern / externref / ref_null),
 *     so `ref.is_null` is a valid test; and
 *   - `rhs` lowers to the SAME reference type, so both `emitIfElse` arms agree
 *     on the carrier Wasm type (no union to widen into).
 *
 * Anything else (numeric/string lhs, mismatched arm types) throws clean
 * fallback to legacy — exactly like the optional-chaining null-arm guard in
 * `lowerOptionalExternPropertyAccess`.
 *
 * Note on `undefined`: a reference-shaped lhs that is JS-`undefined` is
 * represented at the Wasm level as a null externref (the host shim maps
 * `undefined ↔ ref.null.extern`), so the single `ref.is_null` test covers
 * both the `null` and `undefined` cases the spec requires.
 */
function lowerNullish(expr: ts.BinaryExpression, cx: LowerCtx, hint: IrType): IrValueId {
  // Lower the lhs with the caller's hint so a reference-shaped consumer
  // (e.g. an externref slot / return) propagates the right carrier type.
  const lhs = lowerExpr(expr.left, cx, hint);
  const lhsType = cx.builder.typeOf(lhs);
  const lhsVal = asVal(lhsType);
  const lhsIsRef =
    lhsType.kind === "extern" || (lhsVal !== null && (lhsVal.kind === "externref" || lhsVal.kind === "ref_null"));
  if (!lhsIsRef) {
    throw new Error(
      `ir/from-ast: '??' on non-reference lhs (${describeIrType(lhsType)}) is not supported in IR (${cx.funcName})`,
    );
  }

  // The result carrier type is the lhs reference type. Both arms must land
  // on it: the rhs is lowered with `lhsType` as its hint and must agree.
  const resultType: IrType = lhsType;

  const cond = cx.builder.emitRefIsNull(lhs);

  // then-arm (lhs IS null/undefined) → evaluate and yield rhs.
  let thenValue!: IrValueId;
  const thenBody = cx.builder.collectBodyInstrs(() => {
    thenValue = lowerExpr(expr.right, cx, resultType);
  });
  const rhsType = cx.builder.typeOf(thenValue);
  if (!irTypeEquals(rhsType, resultType)) {
    throw new Error(
      `ir/from-ast: '??' arm type mismatch (lhs ${describeIrType(resultType)} vs rhs ${describeIrType(rhsType)}) is not supported in IR (${cx.funcName})`,
    );
  }

  // else-arm (lhs is non-null) → yield `lhs` directly. The lowerer records
  // `elseValue` as a cross-block use (lower.ts:479 `recordUse(elseValue, -1)`)
  // so the outer `lhs` SSA value is pre-materialized into a Wasm local before
  // the `if`, and the empty else arm just `local.get`s it as its carrier.
  return cx.builder.emitIfElse({
    cond,
    then: thenBody,
    thenValue,
    else: [],
    elseValue: lhs,
    resultType,
  });
}

/**
 * #1820 — short-circuiting lowering for `&&` / `||`.
 *
 * The previous lowering eagerly evaluated both operands and combined them with
 * `i32.and` / `i32.or`, running the right operand unconditionally. JS requires
 * the right operand to be evaluated only when the left does not already decide
 * the result:
 *   - `a && b` → if `a` is truthy yield `b`, else yield `a` (the falsy value).
 *   - `a || b` → if `a` is truthy yield `a`, else yield `b`.
 *
 * We keep the existing IR scope (both operands `i32`/bool); anything else
 * throws clean fallback to legacy, exactly as the old `requireI32` did. The
 * right operand is lowered into its own body buffer (only the taken branch
 * runs it) and the two arms are combined with a structured `IrInstrIf`.
 */
function lowerLogicalAndOr(expr: ts.BinaryExpression, op: ts.SyntaxKind, cx: LowerCtx): IrValueId {
  const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
  const opName = isAnd ? "&&" : "||";

  const lhs = lowerExpr(expr.left, cx, irVal({ kind: "i32" }));
  const lhsType = cx.builder.typeOf(lhs);
  if (asVal(lhsType)?.kind !== "i32") {
    throw new Error(`ir/from-ast: operator '${opName}' requires bool operands in ${cx.funcName}`);
  }

  const resultType: IrType = irVal({ kind: "i32" });

  // Lower the right operand into its own buffer so it executes only on the
  // branch that needs it.
  let rhs!: IrValueId;
  const rhsBody = cx.builder.collectBodyInstrs(() => {
    rhs = lowerExpr(expr.right, cx, resultType);
  });
  if (asVal(cx.builder.typeOf(rhs))?.kind !== "i32") {
    throw new Error(`ir/from-ast: operator '${opName}' requires bool operands in ${cx.funcName}`);
  }

  // `cond = lhs`. For `&&`, the rhs is the then-arm (lhs truthy) and lhs is the
  // else-arm value. For `||`, lhs is the then-arm value and rhs is the
  // else-arm. The empty arm yields the already-materialized `lhs` (the lowerer
  // records it as a cross-block use, like `lowerNullish`'s else arm).
  if (isAnd) {
    return cx.builder.emitIfElse({
      cond: lhs,
      then: rhsBody,
      thenValue: rhs,
      else: [],
      elseValue: lhs,
      resultType,
    });
  }
  return cx.builder.emitIfElse({
    cond: lhs,
    then: [],
    thenValue: lhs,
    else: rhsBody,
    elseValue: rhs,
    resultType,
  });
}

function requireF64(isF64: boolean, op: string, fn: string): void {
  if (!isF64) throw new Error(`ir/from-ast: operator '${op}' requires number operands in ${fn}`);
}

function typeOfValue(v: IrValueId, cx: LowerCtx): IrType {
  return cx.builder.typeOf(v);
}

/**
 * Compile-time fold for `expr === null` / `expr !== null` / `expr == null` /
 * `expr != null` when the non-null operand has a non-nullable IR type.
 *
 * Slice 1 (#1169a) has no nullable IR types yet (no `nullable union`,
 * no `boxed-null`), so any operand we can lower is provably non-null:
 *   - `expr === null`  → `false`
 *   - `expr !== null`  → `true`
 *
 * The non-null operand IS lowered (rather than skipped) so its side
 * effects are preserved; the IR DCE pass strips the unused value when
 * the producing instructions are pure. If the operand's IR type is
 * `boxed` (deferred to a later slice), we return `null` so the fold
 * doesn't fire and the caller's standard binary path throws cleanly,
 * letting the function fall back to legacy.
 *
 * Returns `null` when this isn't a `null`-compare (so the caller
 * proceeds with the normal lowering).
 */
/**
 * (#2856 C3) Lower a STRICT undefined-compare — `<expr> !== undefined` /
 * `<expr> === undefined` (`undefined` as a free identifier, not shadowed).
 * Returns null when the expression isn't that shape (caller proceeds with
 * the normal lowering).
 *
 * Dispatch by the non-undefined operand's IrType:
 *   - externref-shaped (externref val / extern class / host-mode string) —
 *     the runtime CAN hold the host `undefined`: emit the same
 *     `__extern_is_undefined(v)` check legacy emits for this shape (import
 *     registered by legacy's own lowering of the identical site in the
 *     dual-compile model), `i32.eqz`-inverted for `!==`.
 *   - representations that can never hold the JS `undefined` VALUE —
 *     unboxed f64/i32 scalars and WasmGC refs (vecs, classes, objects,
 *     closures, native strings; STRICT equality means even a null ref
 *     compares false against undefined): constant-fold, keeping the
 *     operand's side effects (DCE drops the value only when pure).
 *   - anything else (boxed / union / dynamic) — clean demote to legacy.
 *
 * LOOSE `==`/`!=` never reach here (selector rejects them against
 * `undefined`): `null == undefined` is true, so nullable-ref operands would
 * need a runtime null check this slice doesn't emit.
 */
function tryLowerUndefinedCompare(expr: ts.BinaryExpression, op: ts.SyntaxKind, cx: LowerCtx): IrValueId | null {
  const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!isStrictEq && !isStrictNeq) return null;
  const isUndefIdent = (e: ts.Expression): boolean =>
    ts.isIdentifier(e) && e.text === "undefined" && !cx.scope.has("undefined");
  const leftU = isUndefIdent(expr.left);
  const rightU = isUndefIdent(expr.right);
  if (!leftU && !rightU) return null;
  if (leftU && rightU) {
    // `undefined === undefined` → true / `!==` → false.
    return cx.builder.emitConst({ kind: "bool", value: isStrictEq }, irVal({ kind: "i32" }));
  }
  const other = leftU ? expr.right : expr.left;
  const v = lowerExpr(other, cx, irVal({ kind: "externref" }));
  const t = cx.builder.typeOf(v);
  // #2949 S5.2 — a dynamic (boxed-any) operand: strict `=== undefined` /
  // `!== undefined` is the exact Undefined-partition tag test (cheaper and
  // more precise than boxing `undefined` into the carrier + the general
  // helper). Only strict ops reach here (`isStrictEq`/`isStrictNeq` gate).
  if (t.kind === "dynamic") {
    const flag = cx.builder.emitTagTest(v, JsTag.Undefined);
    return isStrictNeq ? cx.builder.emitUnary("i32.eqz", flag, irVal({ kind: "i32" })) : flag;
  }
  const tv = asVal(t);
  const externrefShaped =
    (tv !== null && tv.kind === "externref") ||
    t.kind === "extern" ||
    (t.kind === "string" && cx.resolver?.nativeStrings?.() === false);
  if (externrefShaped) {
    const flag = cx.builder.emitCall({ kind: "func", name: "__extern_is_undefined" }, [v], irVal({ kind: "i32" }));
    if (flag === null) {
      throw new Error(`ir/from-ast: __extern_is_undefined produced no result in ${cx.funcName}`);
    }
    return isStrictNeq ? cx.builder.emitUnary("i32.eqz", flag, irVal({ kind: "i32" })) : flag;
  }
  // Never-undefined representations: fold — but ONLY when the operand's TS
  // static type proves the VALUE cannot be `undefined`. The Wasm-level rep
  // alone is not enough: the IR erases `void x` (static type `undefined`)
  // into an f64 NaN, so a rep-based fold would answer `void x === undefined`
  // with false where JS says true (caught by
  // tests/equivalence/logical-conditional-identity.test.ts). Types that
  // include undefined/void/any/unknown demote to legacy, which tracks
  // undefined-ness through its own lowering.
  const staticTypeMayBeUndefined = (): boolean => {
    if (!cx.checker) return true; // no checker — cannot prove; demote
    const tsType = cx.checker.getTypeAtLocation(other);
    const UNDEF_LIKE = ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown;
    if (tsType.flags & UNDEF_LIKE) return true;
    if (tsType.isUnion() && tsType.types.some((m) => (m.flags & UNDEF_LIKE) !== 0)) return true;
    return false;
  };
  const neverUndefinedRep =
    (tv !== null && (tv.kind === "f64" || tv.kind === "i32" || tv.kind === "ref" || tv.kind === "ref_null")) ||
    t.kind === "class" ||
    t.kind === "object" ||
    t.kind === "closure" ||
    t.kind === "string"; // native-strings mode only (host mode took the branch above)
  if (neverUndefinedRep && !staticTypeMayBeUndefined()) {
    return cx.builder.emitConst({ kind: "bool", value: isStrictNeq }, irVal({ kind: "i32" }));
  }
  throw new Error(`ir/from-ast: undefined-compare on ${describeIrType(t)} not in IR scope (${cx.funcName})`);
}

function tryFoldNullCompare(expr: ts.BinaryExpression, op: ts.SyntaxKind, cx: LowerCtx): IrValueId | null {
  const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEq && !isNeq) return null;

  let other: ts.Expression | null = null;
  if (expr.left.kind === ts.SyntaxKind.NullKeyword) other = expr.right;
  else if (expr.right.kind === ts.SyntaxKind.NullKeyword) other = expr.left;
  else return null;

  // Lower the non-null side to learn its IrType AND keep any side effects
  // emitted (the IR DCE pass drops the unused result if the producing
  // instructions are pure).
  const v = lowerExpr(other, cx, irVal({ kind: "f64" }));
  const otherType = cx.builder.typeOf(v);

  // #2949 S5.2 — a dynamic (boxed-any) operand: STRICT `=== null` / `!== null`
  // is the exact Null-partition tag test. LOOSE `== null` / `!= null` matches
  // BOTH null and undefined (§7.2.15) — NOT a single tag test — so it is left
  // to legacy (return null → demote), NOT folded.
  if (otherType.kind === "dynamic") {
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      const flag = cx.builder.emitTagTest(v, JsTag.Null);
      return isNeq ? cx.builder.emitUnary("i32.eqz", flag, irVal({ kind: "i32" })) : flag;
    }
    return null;
  }

  // Slice 1 only knows non-nullable types: `val<...>`, `string`, and
  // unions whose members are non-null (V1 unions only carry f64/i32).
  // `boxed` is deferred; bail so the caller errors cleanly.
  if (otherType.kind === "boxed") return null;
  // Slice 10 (#1169i): extern-class values are externref-shaped at
  // the Wasm level and CAN be null at runtime — `RegExp.exec()` and
  // similar host imports are documented to return `externref|null`.
  // Bail so the caller falls back to legacy, which has a runtime
  // `ref.is_null` check on the receiver. (TODO follow-up: emit
  // `ref.is_null` directly from the IR.)
  if (otherType.kind === "extern") return null;
  // #1981: `class`, `object`, and `closure` IrTypes lower to nullable WasmGC
  // ref shapes (`(ref null $Struct)`). A class/object/closure-typed value can
  // be `null` at runtime (e.g. a host call passing `null` for a class-typed
  // parameter), so the defensive `=== null` / `!== null` guard must NOT be
  // folded to a constant — folding it deletes the guard, which either returns
  // the wrong value (`=== null` → false) or dereferences null (`!== null` →
  // true, then `p.v` traps). Bail so the caller falls back to legacy, which
  // emits a runtime `ref.is_null` check. The slice-1 fold is only sound for
  // statically non-nullable kinds.
  if (otherType.kind === "class" || otherType.kind === "object" || otherType.kind === "closure") {
    return null;
  }
  // #2713 — a `string` IrType lowers to a nullable ref shape: host-strings
  // backend → `externref`, native-strings backend → `(ref null $AnyString)`.
  // A host caller can pass `null` for a `string`-typed parameter (JS has no
  // type enforcement), so the slice-1 "string is provably non-null"
  // assumption is unsound. Folding `s === null` → `false` / `s !== null` →
  // `true` then silently miscompiles the defensive guard (legacy emits the
  // correct runtime `ref.is_null` check, returning the spec result). Bail so
  // the caller falls back to legacy — same fix class as the #1981 class/
  // object/closure arm above, left open for the string arm.
  if (otherType.kind === "string") return null;
  // Slice 10 (#1169i): a `val { externref }` operand is similarly
  // nullable. Functions that compare externref-typed values against
  // null (e.g. through extern.call results assigned to a local) need
  // a runtime null check, not a static fold.
  const otherVal = asVal(otherType);
  if (otherVal && (otherVal.kind === "externref" || otherVal.kind === "ref_null")) {
    return null;
  }

  return cx.builder.emitConst({ kind: "bool", value: isNeq }, irVal({ kind: "i32" }));
}

/**
 * #2949 S5.2 — lower `dyn === x` / `dyn !== x` / `dyn == x` / `dyn != x` (either
 * or both operands dynamic) to a `dyn.eq` node. Boxes the concrete operand into
 * the boxed-any carrier (refining the box tag from a literal's kind where
 * known) and leaves the dyn operand as-is, so `dyn.eq` sees two carriers — the
 * `(ref null $AnyValue, ref null $AnyValue)` shape the canonical
 * `__any_strict_eq`/`__any_eq` helpers take. Returns `null` (clean demote) for a
 * concrete operand this slice cannot soundly box into the carrier (union / ref /
 * an un-refinable non-literal `i32` whose number-vs-boolean brand is ambiguous),
 * or for a non-equality operator.
 */
function tryLowerDynamicEq(
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
  lhs: IrValueId,
  rhs: IrValueId,
  lt: IrType,
  rt: IrType,
  cx: LowerCtx,
): IrValueId | null {
  const loose = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  const strict = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!loose && !strict) return null;
  const negate = op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;

  const dynL = lt.kind === "dynamic" ? lhs : boxConcreteToDynamic(lhs, lt, expr.left, cx);
  if (dynL === null) return null;
  const dynR = rt.kind === "dynamic" ? rhs : boxConcreteToDynamic(rhs, rt, expr.right, cx);
  if (dynR === null) return null;
  return cx.builder.emitDynEq(dynL, dynR, { loose, negate });
}

/**
 * #2949 S5.2 — box a CONCRETE equality operand into the boxed-any carrier, tag-
 * refined from its literal kind / IR type. Returns `null` when the operand has
 * no sound carrier box in this slice, so the caller demotes cleanly rather than
 * mis-tagging (e.g. a boxed boolean must carry tag-4, never the number default).
 */
function boxConcreteToDynamic(v: IrValueId, t: IrType, operand: ts.Expression, cx: LowerCtx): IrValueId | null {
  if (t.kind === "string") {
    return cx.builder.emitBox(v, irDynamic(JsTag.String));
  }
  const tv = asVal(t);
  if (!tv) return null;
  // Boolean literal (`true`/`false`) → tag-4 box; without the refinement the i32
  // would box as a NUMBER and `dyn === true` would fail against a boxed boolean.
  if (operand.kind === ts.SyntaxKind.TrueKeyword || operand.kind === ts.SyntaxKind.FalseKeyword) {
    return cx.builder.emitBox(v, irDynamic(JsTag.Boolean));
  }
  // Numeric literal or an f64-typed value → number box (f64 hosts only the
  // number brand).
  if (tv.kind === "f64" || ts.isNumericLiteral(operand)) {
    return cx.builder.emitBox(v, irDynamic(JsTag.NumberF64));
  }
  // A bare non-literal `i32` is number-vs-boolean-ambiguous with no cheap proof
  // here — demote rather than risk a wrong tag. S5.P can refine with the
  // checker (isProvablyBoolean) when it opens the scan.
  return null;
}

/**
 * #2949 S5.3 — lower `dyn < x` / `dyn > x` / `dyn <= x` / `dyn >= x` (either or
 * both operands dynamic) as a NUMERIC-ABSTRACT relational compare: each dynamic
 * operand is ToNumber'd to `f64` via `dyn.to_number`, then the existing
 * `f64.lt`/`gt`/`le`/`ge` compare (result `i32`) runs. Returns `null` (clean
 * demote) for a non-relational operator, or for a concrete operand this slice
 * cannot feed the f64 compare (see {@link relOperandToF64}) — including the
 * string×string lexicographic case, which is DEFERRED (a boxed-string operand
 * ToNumbers to NaN in gc / `Number(s)` in host: spec-correct ONLY against a
 * numeric counter-operand, which is why the S5.P scan restricts admission to a
 * numeric-literal counter-operand).
 */
function tryLowerDynamicRelational(
  op: ts.SyntaxKind,
  lhs: IrValueId,
  rhs: IrValueId,
  lt: IrType,
  rt: IrType,
  cx: LowerCtx,
): IrValueId | null {
  let binop: IrBinop;
  switch (op) {
    case ts.SyntaxKind.LessThanToken:
      binop = "f64.lt";
      break;
    case ts.SyntaxKind.LessThanEqualsToken:
      binop = "f64.le";
      break;
    case ts.SyntaxKind.GreaterThanToken:
      binop = "f64.gt";
      break;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      binop = "f64.ge";
      break;
    default:
      return null;
  }
  const lf = relOperandToF64(lhs, lt, cx);
  if (lf === null) return null;
  const rf = relOperandToF64(rhs, rt, cx);
  if (rf === null) return null;
  return cx.builder.emitBinary(binop, lf, rf, irVal({ kind: "i32" }));
}

/**
 * #2949 S5.3 — coerce ONE relational operand to `f64` for the numeric-abstract
 * compare: a dynamic carrier ToNumbers via `dyn.to_number`; a concrete `f64` is
 * used as-is. Any other concrete kind (i32/ref/string) returns `null` so the
 * caller demotes cleanly — this slice only converts the dynamic side, and adds
 * no i32/string→number coercion (numeric literals lower to `f64` under the f64
 * hint the operands were lowered with, so `dyn > 0` / `dyn <= 10` are covered).
 */
function relOperandToF64(v: IrValueId, t: IrType, cx: LowerCtx): IrValueId | null {
  if (t.kind === "dynamic") return cx.builder.emitDynToNumber(v);
  const tv = asVal(t);
  if (tv && tv.kind === "f64") return v;
  return null;
}

// ---------------------------------------------------------------------------
// Closure / nested-function lowering (#1169c — IR Phase 4 Slice 3)
// ---------------------------------------------------------------------------

/**
 * Lower an arrow function or function expression as an IR closure
 * value. Lifts the body to a top-level IR function (with __self as
 * param 0) and emits a `closure.new` that materialises the closure
 * struct. Returns the SSA value of the closure (its IrType is
 * `IrType.closure` with the resolved signature).
 *
 * Mutable captures: rebinds `cx.scope[capName]` to the refcell ref, so
 * subsequent outer reads/writes of `capName` route through
 * `refcell.get` / `refcell.set` automatically (see the identifier
 * handler in `lowerExpr`).
 */
function lowerClosureExpression(expr: ts.ArrowFunction | ts.FunctionExpression, cx: LowerCtx): IrValueId {
  const params: IrType[] = expr.parameters.map((p) => {
    if (!ts.isIdentifier(p.name) || !p.type) {
      throw new Error(`ir/from-ast: closure params must be Identifier-named with annotations (${cx.funcName})`);
    }
    // #2713 — rest (`...xs`), default (`x = 5`) and optional (`x?`) params keep
    // an Identifier name, so the gate above lets them through and the lowering
    // below silently drops their arity/defaulting semantics (a regression
    // against #1372's intent). Reject them to legacy here, mirroring the
    // top-level selector gate (`select.ts` param-shape-rejected). Demote-to-
    // legacy is the documented contract; legacy applies the default initializer
    // / rest gathering correctly.
    if (p.questionToken || p.dotDotDotToken || p.initializer) {
      throw new Error(`ir/from-ast: closure rest/default/optional param not in IR scope (${cx.funcName})`);
    }
    return typeNodeToIr(p.type, `param ${p.name.text} of ${cx.funcName}.<closure>`);
  });
  if (!expr.type) {
    throw new Error(`ir/from-ast: closure must have a return type annotation (${cx.funcName})`);
  }
  const returnType = typeNodeToIr(expr.type, `return type of ${cx.funcName}.<closure>`);
  const signature: IrClosureSignature = { params, returnType };

  const captures = analyseCaptures(expr, cx);

  const liftedName = `${cx.funcName}__closure_${cx.liftedCounter.value++}`;

  // Materialize capture args. Mutable captures need a refcell; if the
  // outer doesn't already have one (a sibling closure may have built
  // one earlier), create it now and rebind the outer scope.
  const captureArgs: IrValueId[] = [];
  const captureFieldTypes: IrType[] = [];
  for (const cap of captures) {
    if (cap.mutable) {
      const innerVal = asVal(cap.type);
      if (!innerVal) {
        throw new Error(`ir/from-ast: mutable closure capture "${cap.name}" must be a primitive (${cx.funcName})`);
      }
      // #1926 — boxed.inner is an IrType; wrap the scalar ValType with irVal.
      const fieldType: IrType = { kind: "boxed", inner: irVal(innerVal) };
      captureFieldTypes.push(fieldType);
      const live = cx.scope.get(cap.name);
      if (live?.kind === "local" && live.type.kind === "boxed") {
        captureArgs.push(live.value);
      } else if (live?.kind === "local") {
        const cell = cx.builder.emitRefCellNew(live.value, innerVal);
        cx.scope.set(cap.name, { kind: "local", value: cell, type: fieldType });
        captureArgs.push(cell);
      } else {
        throw new Error(`ir/from-ast: closure mutable capture "${cap.name}" not in scope (${cx.funcName})`);
      }
    } else {
      // Read-only — pass the current scalar value. If a sibling closure
      // already upgraded the binding to a refcell, deref now so the
      // captured value is the unboxed scalar (the lifted body sees it
      // as the scalar IrType, which matches our `cap.type`).
      const live = cx.scope.get(cap.name);
      let v: IrValueId;
      if (live?.kind === "local" && live.type.kind === "boxed") {
        v = cx.builder.emitRefCellGet(live.value, live.type.inner);
      } else if (live?.kind === "local") {
        v = live.value;
      } else {
        throw new Error(`ir/from-ast: closure capture "${cap.name}" not in scope (${cx.funcName})`);
      }
      captureFieldTypes.push(cap.type);
      captureArgs.push(v);
    }
  }

  // Lift body. The lifted function takes (__self: IrType.closure,
  // ...sig.params) and reads captures via `closure.cap`.
  const lifted = liftClosureBody(liftedName, expr, signature, captures, captureFieldTypes, cx);
  cx.lifted.push(lifted);

  return cx.builder.emitClosureNew({ kind: "func", name: liftedName }, signature, captureFieldTypes, captureArgs);
}

/**
 * Lower a nested function declaration. Adds a `nestedFunc` scope
 * binding (name-only — no SSA value) and lifts the body to a
 * top-level function with prepended capture params (no __self struct).
 * Direct call: `call $lifted` with capture args first, then user args.
 */
function lowerNestedFunctionDeclaration(fn: ts.FunctionDeclaration, cx: LowerCtx): void {
  if (!fn.name || !fn.body) {
    throw new Error(`ir/from-ast: nested function without name or body in ${cx.funcName}`);
  }
  const innerName = fn.name.text;
  const params: IrType[] = fn.parameters.map((p) => {
    if (!ts.isIdentifier(p.name) || !p.type) {
      throw new Error(`ir/from-ast: nested func params must be Identifier-named with annotations (${cx.funcName})`);
    }
    return typeNodeToIr(p.type, `param ${p.name.text} of ${cx.funcName}.${innerName}`);
  });
  if (!fn.type) {
    throw new Error(`ir/from-ast: nested func must have a return type annotation (${cx.funcName})`);
  }
  const returnType = typeNodeToIr(fn.type, `return type of ${cx.funcName}.${innerName}`);
  const signature: IrClosureSignature = { params, returnType };

  const captures = analyseCaptures(fn, cx);
  const liftedName = `${cx.funcName}__nested_${innerName}_${cx.liftedCounter.value++}`;

  const lifted = liftNestedFunction(liftedName, fn, signature, captures, cx);
  cx.lifted.push(lifted);

  // Add to the OUTER scope.
  cx.scope.set(innerName, { kind: "nestedFunc", liftedName, signature, captures });
}

/**
 * Lift a nested function body to a top-level IR function. The body's
 * params are: [capture0, capture1, ..., innerParam0, ...]. Mutable
 * captures are typed `boxed<T>`; the body's identifier handler
 * dereferences them via refcell.get on read.
 */
function liftNestedFunction(
  liftedName: string,
  fn: ts.FunctionDeclaration,
  signature: IrClosureSignature,
  captures: readonly NestedCapture[],
  cx: LowerCtx,
): IrFunction {
  const builder = new IrFunctionBuilder(liftedName, [signature.returnType], false, cx.allocRegistry);
  const scope = new Map<string, ScopeBinding>();

  // Prepend capture params before the user's params.
  for (const cap of captures) {
    const innerVal = asVal(cap.type);
    // #1926 — boxed.inner is an IrType; wrap the scalar ValType with irVal.
    const paramType: IrType = cap.mutable && innerVal ? { kind: "boxed", inner: irVal(innerVal) } : cap.type;
    const v = builder.addParam(cap.name, paramType);
    scope.set(cap.name, { kind: "local", value: v, type: paramType });
  }
  for (let i = 0; i < fn.parameters.length; i++) {
    const p = fn.parameters[i]!;
    const name = (p.name as ts.Identifier).text;
    const t = signature.params[i]!;
    const v = builder.addParam(name, t);
    scope.set(name, { kind: "local", value: v, type: t });
  }

  builder.openBlock();

  const innerCx: LowerCtx = {
    builder,
    scope,
    funcName: liftedName,
    returnType: signature.returnType,
    calleeTypes: cx.calleeTypes,
    classShapes: cx.classShapes,
    resolver: cx.resolver,
    lifted: cx.lifted,
    liftedCounter: cx.liftedCounter,
    // Slice 6 part 2 (#1181) — nested-function bodies have their own
    // mutated-let scope (collected per-body when slice 6 extends to
    // closures). Empty here keeps the slice-3 nested-fn behavior intact.
    mutatedLets: collectMutatedLetNames(fn),
    // Slice 7a (#1169f) — nested function decls are NEVER generators
    // in slice 7a (the selector rejects `function*` nesting via
    // `isPhase1NestedFunc`).
    funcKind: "regular",
    allocRegistry: cx.allocRegistry,
  };
  if (!fn.body) {
    throw new Error(`ir/from-ast: nested function ${innerName(fn)} has no body`);
  }
  lowerStatementList(fn.body.statements, innerCx);

  return builder.finish();
}

function innerName(fn: ts.FunctionDeclaration): string {
  return fn.name?.text ?? "<anon>";
}

/**
 * Lift a closure expression body. The lifted function has __self at
 * param 0 (typed `IrType.closure`); captures are read inside the body
 * via `closure.cap` rather than as prepended params. Mutable captures
 * land as `boxed<T>` field types so `cap` returns the refcell ref;
 * subsequent identifier reads inside the body deref via refcell.get.
 *
 * The returned IrFunction carries `closureSubtype` metadata so the
 * lowerer can emit the correct `ref.cast` on closure.cap.
 */
function liftClosureBody(
  liftedName: string,
  expr: ts.ArrowFunction | ts.FunctionExpression,
  signature: IrClosureSignature,
  captures: readonly NestedCapture[],
  captureFieldTypes: readonly IrType[],
  cx: LowerCtx,
): IrFunction {
  const builder = new IrFunctionBuilder(liftedName, [signature.returnType], false, cx.allocRegistry);
  const scope = new Map<string, ScopeBinding>();

  const selfType: IrType = { kind: "closure", signature };
  const selfV = builder.addParam("__self", selfType);

  for (let i = 0; i < expr.parameters.length; i++) {
    const p = expr.parameters[i]!;
    const name = (p.name as ts.Identifier).text;
    const t = signature.params[i]!;
    const v = builder.addParam(name, t);
    scope.set(name, { kind: "local", value: v, type: t });
  }

  builder.openBlock();

  // Read each capture out of __self. captureFieldTypes is parallel to
  // captures; lifted body sees captures at index 0..N-1.
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    const fieldType = captureFieldTypes[i]!;
    const v = builder.emitClosureCap(selfV, i, fieldType);
    scope.set(cap.name, { kind: "local", value: v, type: fieldType });
  }

  const innerCx: LowerCtx = {
    builder,
    scope,
    funcName: liftedName,
    returnType: signature.returnType,
    calleeTypes: cx.calleeTypes,
    classShapes: cx.classShapes,
    resolver: cx.resolver,
    lifted: cx.lifted,
    liftedCounter: cx.liftedCounter,
    // Slice 6 part 2 (#1181) — closure-body mutated lets are scanned
    // per closure (block bodies) or empty (concise expression bodies,
    // which can't host a let declaration).
    mutatedLets:
      ts.isBlock(expr.body) && (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr))
        ? collectMutatedLetNamesFromBlock(expr.body)
        : new Set<string>(),
    // Slice 7a (#1169f) — closures are never generator/async in 7a
    // (the selector rejects them in `isPhase1ClosureLiteral`).
    funcKind: "regular",
    allocRegistry: cx.allocRegistry,
  };

  if (ts.isArrowFunction(expr) && !ts.isBlock(expr.body)) {
    // Concise body — wrap as `return <expr>`.
    const v = lowerExpr(expr.body, innerCx, signature.returnType);
    if (!irTypeEquals(builder.typeOf(v), signature.returnType)) {
      throw new Error(
        `ir/from-ast: closure body type ${describeIrType(builder.typeOf(v))} != declared return ${describeIrType(signature.returnType)} (${liftedName})`,
      );
    }
    builder.terminate({ kind: "return", values: [v] });
  } else {
    if (!ts.isBlock(expr.body)) {
      throw new Error(`ir/from-ast: closure body must be a block (got ${ts.SyntaxKind[expr.body.kind]})`);
    }
    lowerStatementList(expr.body.statements, innerCx);
  }

  return builder.finish({ signature, captureFieldTypes: [...captureFieldTypes] });
}

/**
 * Walk a closure / nested-function body and collect identifiers that
 * reference outer-scope `local` bindings. Classifies each capture as
 * mutable (the body OR the outer writes to it) or read-only.
 *
 * Outer writes are conservatively detected by walking the entire
 * outer body — any identifier-LHS write to `name` upgrades it to
 * mutable, even if the closure body itself is read-only. This is the
 * safe-and-simple approach the legacy path uses too.
 */
function analyseCaptures(
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
  cx: LowerCtx,
): NestedCapture[] {
  const referenced = new Set<string>();
  const written = new Set<string>();
  const ownParams = new Set<string>();
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name)) ownParams.add(p.name.text);
  }

  const visit = (node: ts.Node): void => {
    // Don't descend into nested function-likes — they have their own
    // capture analysis run when they're lowered.
    if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      return;
    }
    if (ts.isIdentifier(node)) {
      referenced.add(node.text);
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        if (ts.isIdentifier(node.left)) written.add(node.left.text);
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        if (ts.isIdentifier(node.operand)) written.add(node.operand.text);
      }
    }
    forEachChild(node, visit);
  };
  if (fn.body) {
    if (ts.isBlock(fn.body)) {
      for (const s of fn.body.statements) visit(s);
    } else {
      visit(fn.body);
    }
  }

  const outerWrites = collectOuterWrites(fn);

  const captures: NestedCapture[] = [];
  for (const name of referenced) {
    if (ownParams.has(name)) continue;
    const binding = cx.scope.get(name);
    if (!binding) continue;
    if (binding.kind !== "local") {
      // Slice 3 doesn't yet capture closure / nested-fn bindings — that
      // would require either lifting the inner closure to a top-level
      // ref.func or adding closure VALUE fields to the capture struct.
      // Defer.
      throw new Error(
        `ir/from-ast: closure inside ${cx.funcName} captures non-local binding "${name}" — not in slice 3`,
      );
    }
    // If the local is already a refcell (a sibling closure boxed it),
    // the capture's logical type is the inner IrType — we deref on
    // read in `lowerClosureExpression`. #1926 — boxed.inner is already an
    // IrType, so use it directly (no irVal re-wrap).
    const logicalType: IrType = binding.type.kind === "boxed" ? binding.type.inner : binding.type;
    const isMutable = written.has(name) || outerWrites.has(name);
    captures.push({
      name,
      type: logicalType,
      mutable: isMutable,
      outerValue: binding.value,
    });
  }
  return captures;
}

/**
 * Slice 3 (#1169c): walk the OUTER function body to find any
 * identifier-LHS write to a name. Used to upgrade captures to mutable
 * when the outer mutates a captured variable (even if the closure
 * body itself is read-only). Conservative: any write anywhere in the
 * outer counts.
 */
function collectOuterWrites(fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): Set<string> {
  const writes = new Set<string>();
  let outer: ts.Node | undefined = fn.parent;
  while (
    outer &&
    !ts.isFunctionDeclaration(outer) &&
    !ts.isFunctionExpression(outer) &&
    !ts.isArrowFunction(outer) &&
    !ts.isSourceFile(outer)
  ) {
    outer = outer.parent;
  }
  if (!outer || !("body" in outer) || !outer.body) return writes;
  const body = outer.body as ts.Node;
  const visit = (node: ts.Node): void => {
    if (node === fn) return;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        if (ts.isIdentifier(node.left)) writes.add(node.left.text);
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        if (ts.isIdentifier(node.operand)) writes.add(node.operand.text);
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return writes;
}

// ---------------------------------------------------------------------------
// Throw / try / catch / finally lowering (#1169h — IR Phase 4 Slice 9)
// ---------------------------------------------------------------------------

/**
 * Slice 9 (#1169h): lower a `throw <expr>;` statement. The thrown value
 * is coerced to externref (the `__exn` tag's signature is
 * `(externref)`) before the IR `throw` instr.
 *
 * Coercion strategy mirrors the legacy
 * `compileThrowStatement` in `src/codegen/statements/exceptions.ts`:
 *   - f64 / i32                → `__box_number(value)` host import.
 *                                 Slice 9 defers numeric throws — they
 *                                 require the box helper; numeric
 *                                 throws are rare and the function falls
 *                                 back to legacy via the unsupported-
 *                                 expression error.
 *   - externref                → no-op; passed through.
 *   - object / class /
 *     closure / string / ref / ref_null
 *                              → `extern.convert_any` via
 *                                 `coerce.to_externref`.
 *
 * Lowering produces a single `throw` instr with no fall-through; the
 * caller's surrounding block is responsible for any subsequent
 * unreachable terminator (top-level throws in tail position) or for
 * embedding the throw within a try buffer (where the catch_all wrapping
 * implicitly catches the unreachability).
 */
function lowerThrowStatement(stmt: ts.ThrowStatement, cx: LowerCtx): void {
  if (!stmt.expression) {
    throw new Error(`ir/from-ast: bare 'throw' (no expression) not in slice 9 (${cx.funcName})`);
  }
  const value = lowerExpr(stmt.expression, cx, irVal({ kind: "externref" }));
  const valueType = cx.builder.typeOf(value);
  const valTy = asVal(valueType);
  if (valTy?.kind === "f64" || valTy?.kind === "i32") {
    // Numeric throws would need a box helper. Slice 9 defers — fall back
    // to legacy by throwing here so the function compilation aborts
    // cleanly and the legacy path takes over.
    throw new Error(`ir/from-ast: throw of numeric type (${valTy.kind}) not in slice 9 (${cx.funcName})`);
  }
  // Reference-shaped — coerce to externref. The helper is a no-op
  // when the value is already externref or `IrType.string` in host
  // mode (mirrors the slice-7b yield value coercion).
  const valueExt = coerceYieldValueToExternref(value, cx);
  cx.builder.emitThrow(valueExt);
}

/**
 * Slice 9 (#1169h): lower a `try { ... } [catch (e) { ... }] [finally
 * { ... }]` statement.
 *
 * Each sub-block (try body, catch body, finally body) is lowered into a
 * self-contained `IrInstr[]` buffer via `collectBodyInstrs`. The catch
 * variable, when present, is bound as a slot of `(externref)` — the
 * lowerer's `try` op emit prepends a `local.set $payloadSlot` at handler
 * entry to capture the externref payload off the Wasm stack.
 *
 * The finally body is lowered ONCE here; the lowerer is responsible for
 * inlining it at every exit path (normal try-exit, normal catch-exit,
 * synthesized catch_all that re-throws). This matches the legacy
 * `cloneFinally` shape but the duplication happens entirely on the
 * Wasm-emit side, not the IR layer.
 */
function lowerTryStatement(stmt: ts.TryStatement, cx: LowerCtx): void {
  // ── Try body ────────────────────────────────────────────────────────
  const tryScope = new Map(cx.scope);
  const tryCx: LowerCtx = { ...cx, scope: tryScope, noEarlyReturn: true };
  const tryBody = cx.builder.collectBodyInstrs(() => {
    for (const s of stmt.tryBlock.statements) {
      lowerStmt(s, tryCx);
    }
  });

  // ── Catch handler ───────────────────────────────────────────────────
  let catchClause: { payloadSlot: number; body: readonly IrInstr[] } | undefined;
  if (stmt.catchClause) {
    let payloadSlot = -1;
    const catchScope = new Map(cx.scope);
    if (stmt.catchClause.variableDeclaration && ts.isIdentifier(stmt.catchClause.variableDeclaration.name)) {
      // Allocate an externref slot to receive the caught exception. The
      // lowerer prepends a `local.set` at handler entry to pop the
      // payload off the Wasm stack into this slot.
      const varName = stmt.catchClause.variableDeclaration.name.text;
      payloadSlot = cx.builder.declareSlot(`__catch_${varName}`, { kind: "externref" });
      // Bind the catch variable as a slot read so identifier reads
      // inside the handler emit `local.get` against the slot.
      catchScope.set(varName, {
        kind: "slot",
        slotIndex: payloadSlot,
        type: irVal({ kind: "externref" }),
      });
    } else if (stmt.catchClause.variableDeclaration) {
      // Destructuring catch — selector should have rejected this.
      throw new Error(`ir/from-ast: destructuring catch param not in slice 9 (${cx.funcName})`);
    }
    const catchCx: LowerCtx = { ...cx, scope: catchScope, noEarlyReturn: true };
    const catchBody = cx.builder.collectBodyInstrs(() => {
      for (const s of stmt.catchClause!.block.statements) {
        lowerStmt(s, catchCx);
      }
    });
    catchClause = { payloadSlot, body: catchBody };
  }

  // ── Finally body ────────────────────────────────────────────────────
  let finallyBody: readonly IrInstr[] | undefined;
  if (stmt.finallyBlock) {
    const finallyScope = new Map(cx.scope);
    const finallyCx: LowerCtx = { ...cx, scope: finallyScope, noEarlyReturn: true };
    finallyBody = cx.builder.collectBodyInstrs(() => {
      for (const s of stmt.finallyBlock!.statements) {
        lowerStmt(s, finallyCx);
      }
    });
  }

  cx.builder.emitTry({
    body: tryBody,
    catchClause,
    finallyBody,
  });
}
