// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2151 — standalone any-receiver method dispatch over CLOSED object-literal
 * structs.
 *
 * Under `--target standalone` / `--target wasi` an object literal `{ m(){…} }`
 * compiles to a **closed nominal WasmGC struct** (a distinct type whose methods
 * are emitted as `<__anon_N>_<m>(structRef, …args)` funcs, with the struct as
 * the `this` param). The any-receiver method-call fallback
 * (`compileCallExpression`, calls.ts) routes through the native
 * `__extern_method_call`, which only handles the OPEN `$Object` open-hash-map
 * receiver (`ref.test $Object`); a closed struct fails that test and falls to
 * the `ref.null.extern` arm, so `o.m()` silently returns `undefined`/0 and the
 * method never runs (the standalone analog of the JS-host #2015 bug).
 *
 * Fix: a per-method-name **closed-struct dispatcher** `__call_m_<name>` that
 * type-switches over every closed struct having `<Struct>_<name>`:
 *
 *   __call_m_<name>(recv: externref) -> externref
 *     any = any.convert_extern(recv)
 *     if ref.test S1: ref.cast S1; call S1_<name>; <box-coerce>
 *     elif ref.test S2: …
 *     else: __extern_method_call(recv, "<name>", emptyObjVec)   ;; open $Object fallback
 *
 * The struct is passed as the method's first param ⇒ `this` is threaded for
 * free, so `this.x` works. Result is box-coerced to externref (f64/i32 →
 * __box_number, ref → extern.convert_any) so the call site sees a uniform
 * externref.
 *
 * Reserve-then-fill (#1719): the dispatcher is reserved at the call site (where
 * the method name is a static string) with a placeholder `unreachable` body, and
 * filled at FINALIZE by {@link fillClosedMethodDispatch} — after every
 * object-literal struct and its `<Struct>_<name>` funcs are registered.
 *
 * Slice 1 scope: ZERO-arg method calls (covers `next()`, `getx()`, the iterator
 * protocol, and the bulk of test262 any-method patterns). Methods invoked with
 * arguments fall through to the existing path (the dispatcher is not used).
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { ensureExternSameValueZeroHelper, ensureExternStrictEqHelper, undefinedExternInstrs } from "./any-helpers.js";
import { buildClosureRefTestArms } from "./closure-classifier.js"; // (#3125) IsCallable arms
import type { CodegenContext, OptionalParamInfo } from "./context/types.js";
import { classMemberFuncKey } from "./class-member-keys.js";
import { ensureNativeArrayHof, NATIVE_HOF_METHODS } from "./hof-native.js";
import { COLLECTION_KIND, ensureMapHelpers, MAP_LAYOUT } from "./map-runtime.js"; // (#3309) $Map brand arm
import { ensureSetHelpers } from "./set-runtime.js"; // (#3309) __set_add for the `add` arm
import { ensureNativeIterHof, isIterHofForm, NATIVE_ITER_HOF_METHODS } from "./iter-hof-native.js"; // (#2903)
import { ensureNativeLazyIter, isLazyIterForm, LAZY_ITER_METHODS } from "./iter-lazy-native.js"; // (#2903 R3)
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js"; // nullish-receiver TypeError (§13.3 EvaluateCall step 5)
import { addFuncType, getOrRegisterVecBaseType } from "./registry/types.js";
import { addUnionImportsViaRegistry } from "./shared.js";
import { ensureArgcGlobal } from "./statements/nested-declarations.js"; // (#3673 round 13) direct-call argc preset
import { CLOSURE_ARITY_FIELD_IDX, getFuncRefWrapperRootTypeIdx } from "./closures/funcref-wrapper-types.js"; // (#3673 round 13) under-application gate
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2 read chokepoint / S3b stable-regime minting)
import { wrapClosureCallFastArm } from "./closure-call-fast.js"; // (#4185) closure-receiver fast `.call` arm
import { buildFnctorArrayHofTargetTest } from "./fnctor-array-prototype.js";
import { resolveVecHostBridgeHelper } from "./vec-access-exports.js";
import { ensureLateImport } from "./expressions/late-imports.js";
import { defaultValueInstrs } from "./type-coercion.js";

/**
 * (#2583) The callback-free, argument-taking array search/predicate methods
 * that get a native `$__vec_base` brand arm in the closed-method dispatcher so a
 * genuinely-`any` array receiver (`const a:any=[…]; a.indexOf(x)`) runs instead
 * of falling to the open-`$Object` arm (which returns `undefined`). Slice 1 of
 * the deferred #1888 Slice-4 brand-arm residual. `includes` uses SameValueZero;
 * `indexOf`/`lastIndexOf` use Strict Equality.
 */
const VEC_SEARCH_METHODS = new Set(["indexOf", "lastIndexOf", "includes"]);

/**
 * (#2927 / #2784 residual) The in-place array MUTATION methods that get a native
 * `$__vec_base` brand arm in the closed-method dispatcher so a genuinely-`any`
 * array receiver (`const a:any=[…]; a.push(x)` / `a.pop()`) actually mutates the
 * backing WasmGC vec instead of falling to the open-`$Object` arm (which returns
 * `undefined` and silently DROPS the element — a host-free data-loss bug: on
 * `--target standalone` `[1,2].push(3)` left `.length===2` and returned 0). The
 * native-vec push/pop dispatch in `calls.ts` (#2784 S3) is JS-host/gc gated, so
 * standalone/wasi `.push`/`.pop` on an `any`/externref vec previously no-op'd.
 *
 * `push` is arity 1 (`recv, arg0`), `pop` is arity 0 (`recv`). Both route to the
 * carrier-generic `__vec_push` / `__vec_pop` helpers (grow-and-append / pop-last
 * over every registered vec carrier), so no per-element-kind specialization is
 * needed here.
 */
const VEC_MUTATE_METHODS = new Set(["push", "pop"]);

/** True when `methodName`/`arity` is a supported native-vec mutation form. */
function isVecMutateForm(methodName: string, arity: number): boolean {
  return (methodName === "push" && arity === 1) || (methodName === "pop" && arity === 0);
}

/**
 * (#3309) The Map/Set/WeakMap/WeakSet collection methods that get a native
 * `$Map` brand arm in the closed-method dispatcher so a genuinely-`any`
 * collection receiver (`const m: any = new Map(); m.set(k, v)`) dispatches to
 * the WasmGC-native Map/Set runtime instead of leaking `env.WeakMap_*` /
 * `env.Set_*` host imports (unsatisfiable standalone — the
 * `tryExternClassMethodOnAny` first-match hijack, refused there under
 * standalone/wasi so the call reaches this dispatcher). All four collections
 * share the `$Map` struct with an immutable `kind` brand tag
 * (COLLECTION_KIND, #3171), so ONE `ref.test $Map` arm serves them with a
 * per-method kind guard.
 */
const COLLECTION_METHODS = new Set(["get", "set", "has", "add", "delete", "clear"]);

/** True when `methodName`/`arity` is a supported native-collection form. */
function isCollectionMethodForm(methodName: string, arity: number): boolean {
  switch (methodName) {
    case "set":
      return arity === 2;
    case "get":
    case "has":
    case "add":
    case "delete":
      return arity === 1;
    case "clear":
      return arity === 0;
    default:
      return false;
  }
}

/**
 * Mangle a method name + arg count into the reserved dispatcher export/funcMap
 * name. (#2151 Slice 2) The arity is part of the key so `o.m()` and `o.m(a,b)`
 * get distinct dispatchers with the right number of externref arg params.
 */
function dispatcherName(methodName: string, arity: number): string {
  return `__call_m_${methodName}_${arity}`;
}

/**
 * (#2151 Slice 4) Mangle a method name into the VARARG dispatcher name. The
 * vararg dispatcher takes the receiver plus a single `args` externref (a runtime
 * `$ObjVec` or wasm vec) and reads each declared param from it by index — for a
 * DYNAMIC spread `o.m(...xs)` whose arity is unknown at compile time.
 */
function varargDispatcherName(methodName: string): string {
  return `__call_m_${methodName}_vararg`;
}

/**
 * §13.3 EvaluateCall step 5 / §7.3.14: `undefined.m(...)` / `null.m(...)` must
 * throw TypeError BEFORE any dispatch. The standalone dispatchers historically
 * fell through every receiver arm to a silent `undefined` result, so the
 * test262 TypedArray harness's own negative test
 * (harness/testTypedArray-conversions-call-error.js — `values.forEach(...)` on
 * an absent `bcv.values`) saw no throw at all. One shared message per method;
 * registered at RESERVE time (with `__new_TypeError` + the exn tag) so the
 * fill stays funcMap-read-only.
 */
function nullishReceiverMessage(methodName: string): string {
  return `Cannot read properties of undefined (reading '${methodName}')`;
}

/** Reserve-time registration of the nullish-receiver TypeError machinery. */
function reserveNullishReceiverThrow(ctx: CodegenContext, methodName: string): void {
  if (!ctx.standalone && !ctx.wasi) return;
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  ensureExnTag(ctx);
  addStringConstantGlobal(ctx, nullishReceiverMessage(methodName));
}

/**
 * Fill-time guard instrs: throw TypeError when the receiver is nullish.
 * `__nullish_to_null` canonicalizes the (#2106 S1) undefined singleton to
 * null first; a bare null receiver is caught either way. Empty when the
 * machinery is absent (host lane, or the reserve never ran).
 */
function nullishReceiverGuardInstrs(ctx: CodegenContext, methodName: string): Instr[] {
  if (!ctx.standalone && !ctx.wasi) return [];
  // (#4394) `.then` is exempt: the standalone then-chain native (async-scheduler
  // + then-thenable-miss) OWNS then-receiver semantics — its thenable/miss arms
  // must observe the receiver themselves, and guarding here composes into an
  // illegal cast on a user-thenable receiver (measured: the guard alone flips
  // harness/asyncHelpers-throwsAsync-func-never-settles.js pass→fail).
  if (methodName === "then") return [];
  const newTypeErrIdx = ctx.funcMap.get("__new_TypeError");
  if (newTypeErrIdx === undefined || ctx.exnTagIdx < 0) return [];
  const nullishIdx = ctx.funcMap.get("__nullish_to_null");
  return [
    { op: "local.get", index: 0 },
    ...(nullishIdx !== undefined ? ([{ op: "call", funcIdx: nullishIdx }] satisfies Instr[]) : []),
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...stringConstantExternrefInstrs(ctx, nullishReceiverMessage(methodName)),
        { op: "call", funcIdx: newTypeErrIdx },
        { op: "throw", tagIdx: ctx.exnTagIdx },
      ],
    },
  ];
}

/**
 * Reserve (or fetch) the closed-struct dispatcher `__call_m_<name>_<arity>`
 * funcIdx with a placeholder body. The real body is built by
 * {@link fillClosedMethodDispatch} at finalize. Idempotent; records the
 * (method name, arity) pair in `ctx.closedMethodDispatchNames` (encoded as
 * `<name>/<arity>`). Returns the reserved funcIdx.
 *
 * The dispatcher signature is `(recv: externref, arg0..arg{arity-1}: externref)
 * -> externref`; the call site coerces each argument to externref before the
 * call, and the fill side coerces each back to the method's declared param type.
 *
 * The JS-host lane also uses this for ambiguous user methods on an `any`
 * receiver; its fallback builds a real host argument array.
 */
export function reserveClosedMethodDispatch(ctx: CodegenContext, methodName: string, arity = 0): number {
  const name = dispatcherName(methodName, arity);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  // Register the open-$Object fallback-arm dependencies NOW (during
  // compilation), not at fill time — adding funcs/globals/imports at FINALIZE
  // would shift baked call/global indices (the addUnionImports hazard the
  // reserve-then-fill pattern exists to avoid). `fillClosedMethodDispatch` then
  // only READS funcMap. `ensureObjVecBuilders` pulls in the object runtime +
  // `__objvec_new`/`__objvec_push`/`__extern_method_call`; the method-name
  // string constant is materialized for the fallback
  // `__extern_method_call(recv, "<name>", [args…])`.
  if (ctx.standalone || ctx.wasi) {
    ensureObjVecBuilders(ctx);
  } else {
    ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
    ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
    ensureLateImport(
      ctx,
      "__extern_method_call",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    // A dynamic JS call may omit a formal parameter even when the source was
    // allowJs and TypeScript did not preserve an `?` marker.  The closed
    // dispatcher must pass the host's real `undefined`, not a null externref,
    // so the callee's defaulting and null checks see the same value as Node.
    ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
    addUnionImportsViaRegistry(ctx);
  }
  addStringConstantGlobal(ctx, methodName);
  reserveNullishReceiverThrow(ctx, methodName);

  // (#3117) The fill adds FIELD-STORED-closure arms (a pre-shaped closed struct
  // whose externref FIELD `<name>` holds a boxed closure — `o.f = function(){}`
  // on a `{}` literal). Those arms invoke through `__apply_closure`; reserve it
  // NOW so `fillApplyClosure` (which runs before this module's fill) gives it a
  // real body and the fill only READS funcMap (#1719). Degrades to the
  // undefined sentinel when no closure dispatcher exists — never traps.
  if (ctx.standalone || ctx.wasi) reserveApplyClosure(ctx);

  // (#2583) For the callback-free array search/predicate methods, the fill adds
  // a native `$__vec_base` brand arm so a genuinely-`any` array receiver runs
  // instead of falling to the open-`$Object` arm. Register ALL of that arm's
  // dependencies NOW (reserve time) so their funcIdx values are stable before
  // `fillClosedMethodDispatch` (which only READS funcMap — #1719). The arm is
  // standalone-only (the helpers self-gate on `ctx.standalone || ctx.wasi`);
  // `ensureObjVecBuilders`→`ensureObjectRuntime` already pulled in
  // `__extern_length`/`__extern_get_idx`, and the $__vec_base supertype is
  // idempotently registered here.
  if ((ctx.standalone || ctx.wasi) && VEC_SEARCH_METHODS.has(methodName) && arity >= 1) {
    getOrRegisterVecBaseType(ctx);
    ensureExternStrictEqHelper(ctx); // indexOf / lastIndexOf (also a SameValueZero dep)
    if (methodName === "includes") ensureExternSameValueZeroHelper(ctx);
    // `__box_boolean` (for `includes`) is a union import; `__box_number`
    // (for indexOf/lastIndexOf) too. Register them so both are in funcMap by fill.
    addUnionImportsViaRegistry(ctx);
  }

  // #3507 — the `$NativeRegExp` test/1 brand arm returns a real JS boolean.
  // Register boxing before the call site mints the helper so finalize remains
  // read-only and no import shift can invalidate baked indices.
  if (ctx.standalone && methodName === "test" && arity === 1) {
    addUnionImportsViaRegistry(ctx);
  }

  // (#2927) For the in-place array MUTATION methods (`push`/`pop`), register the
  // native `$__vec_base` brand-arm deps NOW so the fill only READS funcMap
  // (#1719): the `$__vec_base` supertype and `__box_number` (push returns an i32
  // length that the arm boxes). The carrier-generic helper is reserved by the
  // CALL SITE (`calls.ts`, which already imports
  // `reserveVecMethodHelper` from `../index.js` — importing it here would form an
  // eval-time circular-import cycle). Standalone/wasi only.
  if ((ctx.standalone || ctx.wasi) && VEC_MUTATE_METHODS.has(methodName) && isVecMutateForm(methodName, arity)) {
    getOrRegisterVecBaseType(ctx);
    addUnionImportsViaRegistry(ctx); // __box_number for the push new-length result
  }

  // (#3309) For the collection methods (`get`/`set`/`has`/`add`/`delete`/
  // `clear`), emit the native Map/Set runtime NOW — union imports first
  // (`__box_boolean` for the has/delete results; imports before defined funcs,
  // the #1677/#2043 index-shift hazard), then the `$Map` runtime helpers
  // (defined funcs, append-only) — so `fillClosedMethodDispatch` only READS
  // `ctx.mapHelpers`/`funcMap` (#1719). The module edge → map-runtime.ts is
  // eval-time-cycle-safe (the hof-native.ts ↔ this-module precedent; all uses
  // are inside function bodies). Standalone/wasi only.
  if ((ctx.standalone || ctx.wasi) && COLLECTION_METHODS.has(methodName) && isCollectionMethodForm(methodName, arity)) {
    addUnionImportsViaRegistry(ctx);
    ensureMapHelpers(ctx);
    ensureSetHelpers(ctx);
  }

  // (#3098) For the callback-taking array HOFs (map/filter/forEach/find*/
  // every/some/reduce/reduceRight), emit the native loop helper `__hof_<name>`
  // NOW (append-only defined funcs; the fill only READS funcMap — #1719) and
  // register the `$__vec_base` supertype for the fill's brand test. The fill
  // adds a `$__vec_base`/`$ObjVec` arm that runs the loop natively and invokes
  // the callback through `__apply_closure` — retiring the `env.__make_callback`
  // host bridge on this lane (unsatisfiable standalone: the import leak made
  // the whole module fail to instantiate). Standalone only: the
  // `__extern_get_idx` vec/array-like arms the loop reads through are emitted
  // only under `ctx.standalone` (see `objArrayLikeArms` in object-runtime.ts —
  // same gate as the vararg dispatcher above).
  if (ctx.standalone && NATIVE_HOF_METHODS.has(methodName) && arity >= 1) {
    getOrRegisterVecBaseType(ctx);
    ensureNativeArrayHof(ctx, methodName);
  }

  // (#2903) For the EAGER Iterator-helper methods (find/every/some/forEach/
  // reduce/toArray), emit the native stepped loop `__iter_hof_<name>` NOW
  // (append-only defined funcs; the fill only READS funcMap — #1719). The fill
  // adds an ITERATOR fallback arm under the open-`$Object` split: a receiver
  // that is neither a closed struct with the method, nor a vec/$ObjVec, nor a
  // `$Object`, is exactly the generator/driven-frame/iterator-carrier set that
  // previously fell to `__extern_method_call`'s non-`$Object` arm and silently
  // answered `undefined`. Standalone only.
  if (ctx.standalone && NATIVE_ITER_HOF_METHODS.has(methodName) && isIterHofForm(methodName, arity)) {
    ensureNativeIterHof(ctx, methodName);
  }

  // (#2903 R3) For the LAZY Iterator-helper methods (map/filter/take/drop on an
  // iterator receiver, arity ≥1), emit the native wrapper constructor
  // `__iter_lazy_<name>` + shared steppers NOW (append-only; the fill only READS
  // funcMap — #1719). The fill adds a lazy arm under the same non-vec/non-$Object
  // iterator split as the eager arm; for map/filter it sits UNDER the #3098 vec
  // HOF arm so a vec receiver still eager-maps. Standalone only.
  if (ctx.standalone && LAZY_ITER_METHODS.has(methodName) && isLazyIterForm(methodName, arity)) {
    ensureNativeLazyIter(ctx, methodName);
  }

  // Signature: (recv, arg0..arg{arity-1}) all externref → externref.
  const params: ValType[] = Array.from({ length: arity + 1 }, () => ({ kind: "externref" }) as ValType);
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `$closed_method_dispatch_type_${arity}`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [],
    // Placeholder; filled by fillClosedMethodDispatch. `unreachable` keeps the
    // stub valid (externref result) if the fill is ever skipped.
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  (ctx.closedMethodDispatchNames ??= new Set<string>()).add(`${methodName}/${arity}`);
  return funcIdx;
}

/**
 * (#2151 Slice 4) Reserve (or fetch) the VARARG closed-struct dispatcher
 * `__call_m_<name>_vararg(recv: externref, args: externref) -> externref` for a
 * DYNAMIC-spread method call `o.m(...xs)` whose arity is unknown at compile time.
 *
 * The fill (in {@link fillClosedMethodDispatch}) type-switches over every closed
 * struct having `<Struct>_<name>` exactly like the fixed-arity dispatcher, but
 * sources each declared param from `__extern_get_idx(args, i)` (0..K-1, K = that
 * method's declared param count) instead of from a fixed dispatcher param. The
 * bottom arm forwards the SAME `args` externref to
 * `__extern_method_call(recv, "<name>", args)` for the open-`$Object` case.
 *
 * Like the fixed-arity reserve, all fallback-arm dependencies are registered NOW
 * (during compilation) so the fill only READS funcMap — `ensureObjVecBuilders`
 * pulls in the object runtime including `__extern_get_idx` / `__extern_length`,
 * which the per-struct arms read args through. Idempotent. Only meaningful under
 * `ctx.standalone || ctx.wasi`.
 */
export function reserveClosedMethodDispatchVararg(ctx: CodegenContext, methodName: string): number {
  const name = varargDispatcherName(methodName);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  // Pulls in the object runtime (`__objvec_new`/`__objvec_push`/
  // `__extern_method_call` AND `__extern_get_idx`/`__extern_length`) so the fill
  // is read-only. The method-name string constant backs the fallback call.
  if (ctx.standalone || ctx.wasi) {
    ensureObjVecBuilders(ctx);
  } else {
    ensureLateImport(
      ctx,
      "__extern_method_call",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    ensureLateImport(ctx, "__extern_get_idx", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
    addUnionImportsViaRegistry(ctx);
  }
  addStringConstantGlobal(ctx, methodName);
  reserveNullishReceiverThrow(ctx, methodName);
  // (#3117) Field-stored-closure arms invoke via `__apply_closure` — see the
  // fixed-arity reserve above.
  if (ctx.standalone || ctx.wasi) reserveApplyClosure(ctx);

  // Signature: (recv: externref, args: externref) -> externref.
  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$closed_method_dispatch_vararg_type",
  );
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [],
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  (ctx.closedMethodDispatchVarargNames ??= new Set<string>()).add(methodName);
  return funcIdx;
}

/** One candidate closed struct that carries `<Struct>_<methodName>`. */
type MethodEntry = {
  typeIdx: number;
  funcIdx: number;
  paramTypes: ValType[];
  resultType: ValType;
  optionalParams: OptionalParamInfo[];
  /** Host dynamic calls follow JavaScript's missing-argument semantics. */
  hostDynamic: boolean;
};

/**
 * Collect every closed object-literal struct with a `<Struct>_<methodName>`
 * method of the requested arity (`exactArity`), or — for the vararg dispatcher —
 * EVERY arity (`exactArity === null`). Param 0 is always the receiver struct
 * (`this`); `paramTypes` excludes it. Skips wrapper/internal carriers.
 */
function collectMethodEntries(ctx: CodegenContext, methodName: string, exactArity: number | null): MethodEntry[] {
  const mod = ctx.mod;
  const entries: MethodEntry[] = [];
  for (const [structName] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_") ||
      structName.startsWith("$")
    )
      continue;

    // Class bodies use the collision-aware key helper when a class member
    // shares a name with a top-level function (or with a static member of the
    // same class).  The closed dispatcher must resolve the exact same key;
    // looking up the legacy spelling silently drops the class arm and sends
    // the call to the host fallback (`inline is not a function` in marked).
    const fullName = `${structName}_${methodName}`;
    const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "instance"));
    if (process.env.DEBUG_MARKED_CODEGEN === "1" && (methodName === "lexer" || methodName === "parseInline")) {
      console.error(
        "[marked-collect-lexer]",
        structName,
        fullName,
        ctx.classMethodSet.has(fullName),
        funcIdx,
        funcIdx === undefined ? undefined : definedFuncAt(ctx, funcIdx)?.typeIdx,
        ctx.funcOptionalParams.get(fullName),
      );
    }
    if (funcIdx === undefined) continue;
    const funcDef = definedFuncAt(ctx, funcIdx);
    const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
    if (!funcType || funcType.kind !== "func") continue;
    const paramTypes = funcType.params.slice(1);
    const optionalParams = ctx.funcOptionalParams.get(fullName) ?? [];
    const hostDynamic = !ctx.standalone && !ctx.wasi && ctx.hostDynamicClassMethodNames.has(methodName);
    // A fixed-arity call may under-apply a method only when every omitted
    // formal has a default/optional marker AND `buildEntryArm` can faithfully
    // stand in for it. Those are two different questions, and (#4466) treating
    // them as one is what broke `({ m({} = {}) {} }).m()`: an omitted formal
    // whose default is a non-constant EXPRESSION has to be evaluated by the
    // callee, which needs to know the argument was absent. Only the f64 lane
    // carries a sentinel the prologue recognizes; for every other lane the arm
    // can push nothing better than a typed zero/null, which the callee cannot
    // tell apart from an explicitly passed value — so it destructures a null
    // instead of running `= {}`. Admit only what the arm can express; the rest
    // falls back to the host path exactly as it did before.
    const canSynthesizeOmitted = (index: number, type: ValType | undefined): boolean => {
      const opt = optionalParams.find((o) => o.index === index);
      if (!opt) return false;
      if (!opt.hasExpressionDefault) return true; // constant default, or `?` with none
      return type?.kind === "f64"; // the one lane with an absence sentinel
    };
    if (exactArity !== null) {
      if (paramTypes.length < exactArity) continue;
      if (!hostDynamic && paramTypes.slice(exactArity).some((type, i) => !canSynthesizeOmitted(exactArity + i, type))) {
        continue;
      }
    }
    if (funcType.params.length < 1) continue;
    const resultType: ValType = funcType.results.length > 0 ? funcType.results[0]! : { kind: "externref" };
    entries.push({ typeIdx, funcIdx, paramTypes, resultType, optionalParams, hostDynamic });
  }
  return entries;
}

/**
 * (#3117) One candidate closed struct whose externref FIELD `<methodName>`
 * holds a (boxed) closure — the `o.f = function(){}`-on-a-pre-shaped-`{}`
 * shape. The arm reads the field and invokes through `__apply_closure`.
 */
type FieldEntry = { typeIdx: number; fieldIdx: number };

/**
 * (#3117) Collect every closed struct (same filter as `collectMethodEntries`)
 * that has an externref FIELD named `<methodName>` but NO `<Struct>_<name>`
 * method (a method arm would shadow the field arm anyway — methods win).
 * Before these arms, `const o: any = {}; o.f = function () {…}; o.f()` stored
 * the closure fine (`struct.set` on the pre-shaped struct) but the dispatcher
 * had no arm for it — the call silently returned undefined while the
 * computed-key twin (`o["f"] = fn`, a genuine `$Object` store) worked.
 */
function collectFieldEntries(ctx: CodegenContext, methodName: string): FieldEntry[] {
  const entries: FieldEntry[] = [];
  for (const [structName, fields] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_") ||
      structName.startsWith("$")
    )
      continue;
    const methodKey = classMemberFuncKey(ctx, `${structName}_${methodName}`, "instance");
    if (ctx.funcMap.has(methodKey)) continue; // method wins
    const fieldIdx = fields.findIndex((f) => f.name === methodName && f.type.kind === "externref");
    if (fieldIdx < 0) continue;
    entries.push({ typeIdx, fieldIdx });
  }
  return entries;
}

/** Coerce helper funcIdxs, read once per fill pass (registered at reserve). */
type CoerceIdxs = {
  boxNumIdx?: number;
  unboxNumIdx?: number;
  unboxBoolIdx?: number;
  undefinedIdx?: number;
};

/**
 * Build one closed-struct call arm: cast recv→`this`, push each declared arg
 * (sourced via `pushArg(a)` — fixed dispatcher params OR `__extern_get_idx`),
 * coerce each externref arg to the method's declared param type, call, and
 * box-coerce the result back to externref. Shared by the fixed-arity and vararg
 * fills so the coercion logic stays single-sourced.
 */
function buildEntryArm(
  ci: CoerceIdxs,
  anyLocalIdx: number,
  entry: MethodEntry,
  pushArg: (a: number) => Instr[],
  providedArity: number | null = null,
): Instr[] {
  const { boxNumIdx, unboxNumIdx, unboxBoolIdx } = ci;
  const arm: Instr[] = [
    { op: "local.get", index: anyLocalIdx },
    { op: "ref.cast", typeIdx: entry.typeIdx }, // `this`
  ];
  for (let a = 0; a < entry.paramTypes.length; a++) {
    const want = entry.paramTypes[a] ?? { kind: "externref" };
    const missing = providedArity !== null && a >= providedArity;
    if (missing) {
      const opt = entry.optionalParams.find((candidate) => candidate.index === a);
      if (entry.hostDynamic) {
        if (want.kind === "externref" && ci.undefinedIdx !== undefined) {
          arm.push({ op: "call", funcIdx: ci.undefinedIdx });
        } else if (want.kind === "f64") {
          // The regular parameter prologue uses this NaN payload as its
          // omitted-argument sentinel for expression defaults.
          arm.push({ op: "i64.const", value: 0x7ff00000deadc0den }, { op: "f64.reinterpret_i64" });
        } else {
          arm.push(...defaultValueInstrs(want));
        }
      } else if (!opt) {
        return [{ op: "ref.null.extern" }];
      } else if (opt.constantDefault) {
        arm.push(
          opt.constantDefault.kind === "f64"
            ? { op: "f64.const", value: opt.constantDefault.value }
            : { op: "i32.const", value: opt.constantDefault.value },
        );
      } else if (want.kind === "f64" && opt.hasExpressionDefault) {
        arm.push({ op: "i64.const", value: 0x7ff00000deadc0den }, { op: "f64.reinterpret_i64" });
      } else {
        arm.push(...defaultValueInstrs(want));
      }
      continue;
    }
    arm.push(...pushArg(a)); // the arg, as externref, onto the stack
    if (want.kind === "f64") {
      if (unboxNumIdx !== undefined) arm.push({ op: "call", funcIdx: unboxNumIdx });
      else arm.push({ op: "drop" }, { op: "f64.const", value: 0 });
    } else if (want.kind === "i32") {
      if ((want as { boolean?: true }).boolean && unboxBoolIdx !== undefined) {
        arm.push({ op: "call", funcIdx: unboxBoolIdx });
      } else if (unboxNumIdx !== undefined) {
        arm.push({ op: "call", funcIdx: unboxNumIdx });
        arm.push({ op: "i32.trunc_sat_f64_s" });
      } else {
        arm.push({ op: "drop" }, { op: "i32.const", value: 0 });
      }
    } else if (want.kind === "ref" || want.kind === "ref_null") {
      arm.push({ op: "any.convert_extern" });
      arm.push({ op: "ref.cast", typeIdx: (want as { typeIdx: number }).typeIdx });
    }
    // externref param: already externref — no coercion.
  }
  arm.push({ op: "call", funcIdx: entry.funcIdx });
  // Box-coerce the result back to externref.
  if (entry.resultType.kind === "ref" || entry.resultType.kind === "ref_null") {
    arm.push({ op: "extern.convert_any" });
  } else if (entry.resultType.kind === "f64") {
    if (boxNumIdx !== undefined) arm.push({ op: "call", funcIdx: boxNumIdx });
    else arm.push({ op: "drop" }, { op: "ref.null.extern" });
  } else if (entry.resultType.kind === "i32") {
    arm.push({ op: "f64.convert_i32_s" });
    if (boxNumIdx !== undefined) arm.push({ op: "call", funcIdx: boxNumIdx });
    else arm.push({ op: "drop" }, { op: "ref.null.extern" });
  }
  // externref result: no coercion.
  return arm;
}

/**
 * Fill every reserved `__call_m_<name>_<arity>` AND `__call_m_<name>_vararg`
 * dispatcher body at FINALIZE. Mirrors `fillApplyClosure` (object-runtime.ts).
 * Must run AFTER all object-literal struct types and their `<Struct>_<name>`
 * method funcs are registered, and after `addUnionImports` (so
 * `__box_number`/`__box_boolean` exist). No-op when nothing was reserved.
 */
export function fillClosedMethodDispatch(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const ci: CoerceIdxs = {
    boxNumIdx: ctx.funcMap.get("__box_number"),
    unboxNumIdx: ctx.funcMap.get("__unbox_number"),
    unboxBoolIdx: ctx.funcMap.get("__unbox_boolean"),
    undefinedIdx: ctx.funcMap.get("__get_undefined"),
  };
  const methodCallIdx = ctx.funcMap.get("__extern_method_call");
  const objVecNewIdx = ctx.funcMap.get(ctx.standalone || ctx.wasi ? "__objvec_new" : "__js_array_new");
  const objVecPushIdx = ctx.funcMap.get(ctx.standalone || ctx.wasi ? "__objvec_push" : "__js_array_push");

  // ── Fixed-arity dispatchers (#2151 Slices 1–3) ──────────────────────────
  for (const key of ctx.closedMethodDispatchNames ?? []) {
    // key is `<methodName>/<arity>`. Split from the LAST `/` (method names never
    // contain `/`) so the arity parses cleanly.
    const slash = key.lastIndexOf("/");
    const methodName = slash >= 0 ? key.slice(0, slash) : key;
    const arity = slash >= 0 ? Number.parseInt(key.slice(slash + 1), 10) || 0 : 0;
    const dispIdx = ctx.funcMap.get(dispatcherName(methodName, arity));
    if (dispIdx === undefined) continue;
    const dispFn = definedFuncAt(ctx, dispIdx);
    if (!dispFn) continue;

    // Param layout: local 0 = recv, locals 1..arity = externref args,
    // local (arity+1) = the `any` temp.
    const anyLocalIdx = arity + 1;
    const entries = collectMethodEntries(ctx, methodName, arity);

    // Bottom arm: open-$Object fallback — build a $ObjVec of the fixed args.
    let current: Instr[];
    if (methodCallIdx !== undefined && objVecNewIdx !== undefined && (arity === 0 || objVecPushIdx !== undefined)) {
      const argVec: Instr[] = [];
      if (arity > 0 && objVecPushIdx !== undefined) {
        const vecTmp = anyLocalIdx + 1;
        argVec.push({ op: "call", funcIdx: objVecNewIdx });
        argVec.push({ op: "local.set", index: vecTmp });
        for (let a = 0; a < arity; a++) {
          argVec.push({ op: "local.get", index: vecTmp });
          argVec.push({ op: "local.get", index: 1 + a });
          argVec.push({ op: "call", funcIdx: objVecPushIdx });
        }
        argVec.push({ op: "local.get", index: vecTmp });
      } else {
        argVec.push({ op: "call", funcIdx: objVecNewIdx });
      }
      current = [
        { op: "local.get", index: 0 },
        ...stringConstantExternrefInstrs(ctx, methodName),
        ...argVec,
        { op: "call", funcIdx: methodCallIdx },
      ];
    } else {
      current = [{ op: "ref.null.extern" }];
    }

    // (#3673 round 13) Cached-method DIRECT-call arm, wrapped around the
    // innermost open fallback only (closed-struct / HOF / iterator /
    // collection arms keep their existing precedence). On a
    // `__method_cache_lookup` hit — the receiver's fnctor-prototype method
    // was already resolved once through the slow path — call
    // `__call_fn_method_<arity>` directly with the unpacked args, skipping
    // the per-call `$ObjVec` allocation, `__extern_method_call`, and
    // `__apply_closure`. argc is preset to the actual count and reset to the
    // -1 sentinel after, exactly mirroring `fillApplyClosure`.
    // The scratch local's slot is only known once the fill's `locals` array is
    // finalized far below (`dispFn.locals = locals`), so the arm is built with
    // placeholder indices collected in `mcPatchInstrs` and patched there.
    const mcPatchInstrs: Instr[] = [];
    {
      const lookupIdx = ctx.funcMap.get("__method_cache_lookup");
      const callFnMethodIdx = ctx.funcMap.get(`__call_fn_method_${arity}`);
      const nullishIdx = ctx.funcMap.get("__nullish_to_null");
      const rootIdx = getFuncRefWrapperRootTypeIdx(ctx);
      // These mixed-arity carriers do not share a single cache ABI: a cached
      // prototype closure can be selected for the wrong receiver shape and
      // recursively re-enter the dispatcher. Keep br/del on nominal arms until
      // the cache records receiver signature as well as method name.
      if (
        lookupIdx !== undefined &&
        callFnMethodIdx !== undefined &&
        rootIdx !== undefined &&
        methodName !== "br" &&
        methodName !== "del"
      ) {
        const mLocal = (op: "local.get" | "local.set" | "local.tee"): Instr => {
          const instr: Instr = { op, index: -1 };
          mcPatchInstrs.push(instr);
          return instr;
        };
        const argcGlobalIdx = ensureArgcGlobal(ctx);
        current = [
          { op: "local.get", index: 0 },
          ...stringConstantExternrefInstrs(ctx, methodName),
          { op: "call", funcIdx: lookupIdx },
          ...(nullishIdx !== undefined ? ([{ op: "call", funcIdx: nullishIdx }] satisfies Instr[]) : []),
          mLocal("local.tee"),
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          // Direct-call eligibility: the exact-arity export only carries
          // closures with formals <= call-site arity. An UNDER-applied call
          // (declared > arity) must take the legacy path, whose
          // `__apply_closure` #3592 widening pads the missing args — so gate
          // on the root wrapper's declared-$arity field.
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              mLocal("local.get"),
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx: rootIdx },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  mLocal("local.get"),
                  { op: "any.convert_extern" },
                  { op: "ref.cast", typeIdx: rootIdx },
                  { op: "struct.get", typeIdx: rootIdx, fieldIdx: CLOSURE_ARITY_FIELD_IDX },
                  { op: "i32.const", value: arity },
                  { op: "i32.le_s" },
                ],
                else: [{ op: "i32.const", value: 0 }],
              },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [
              { op: "i32.const", value: arity },
              { op: "global.set", index: argcGlobalIdx },
              { op: "local.get", index: 0 },
              mLocal("local.get"),
              ...Array.from({ length: arity }, (_, a): Instr => ({ op: "local.get", index: 1 + a })),
              { op: "call", funcIdx: callFnMethodIdx },
              mLocal("local.set"),
              { op: "i32.const", value: -1 },
              { op: "global.set", index: argcGlobalIdx },
              mLocal("local.get"),
            ],
            else: current,
          },
        ];
      }
    }

    // (#2903) ITERATOR fallback arm for the eager Iterator-helper methods
    // (find/every/some/forEach/reduce arity ≥1, toArray arity 0). Splits the
    // bottom arm: `$Object` receivers keep the open-hash-map
    // `__extern_method_call` route; every OTHER receiver — generators, driven
    // frames, Map/Set/array iterators, custom closed-struct iterables — routes
    // to the native stepped loop `__iter_hof_<name>` (emitted at reserve time,
    // iter-hof-native.ts), which drives `__iterator`/`__iterator_next` and
    // invokes the predicate via `__apply_closure`. Previously these receivers
    // fell to `__extern_method_call`'s non-`$Object` arm and silently answered
    // `undefined` (the #2903 re-grounded residual). Vec/$ObjVec receivers are
    // EXCLUDED here: the callback methods are caught by the #3098 HOF arm
    // wrapped outside, and `toArray` (not an Array.prototype method) keeps the
    // legacy undefined rather than draining an array. Sits at the BOTTOM so
    // closed-struct arms (a user `{ find(){…} }`) and field-closure arms win.
    {
      const iterHofIdx = ctx.funcMap.get(`__iter_hof_${methodName}`);
      const objTypeIdxForIter = ctx.objectRuntimeTypes?.objectTypeIdx;
      const objVecTypeIdxForIter = ctx.objectRuntimeTypes?.objVecTypeIdx;
      if (
        ctx.standalone &&
        iterHofIdx !== undefined &&
        NATIVE_ITER_HOF_METHODS.has(methodName) &&
        isIterHofForm(methodName, arity) &&
        objTypeIdxForIter !== undefined
      ) {
        const iterCall: Instr[] =
          methodName === "toArray"
            ? [
                // `__iter_hof_toArray(recv)` — stepped drain → $ObjVec.
                { op: "local.get", index: 0 },
                { op: "call", funcIdx: iterHofIdx },
              ]
            : [
                { op: "local.get", index: 0 }, // recv
                { op: "local.get", index: 1 }, // cb
                ...((methodName === "reduce"
                  ? [
                      ...((arity >= 2
                        ? [{ op: "local.get", index: 2 }]
                        : [{ op: "ref.null.extern" }]) satisfies Instr[]), // init
                      { op: "i32.const", value: arity >= 2 ? 1 : 0 }, // hasInit
                    ]
                  : []) satisfies Instr[]),
                { op: "call", funcIdx: iterHofIdx },
              ];
        // isNotIterTarget = null ∨ ref.test $Object ∨ ref.test $__vec_base ∨
        // ref.test $ObjVec — a NULL receiver keeps the legacy open-arm route
        // (`__extern_method_call` answers undefined for null) instead of
        // trapping inside `__iterator`.
        const notIterTest: Instr[] = [
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.is_null" },
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.test", typeIdx: objTypeIdxForIter },
          { op: "i32.or" },
        ];
        if (ctx.vecBaseTypeIdx >= 0) {
          notIterTest.push(
            { op: "local.get", index: anyLocalIdx },
            { op: "ref.test", typeIdx: ctx.vecBaseTypeIdx },
            { op: "i32.or" },
          );
        }
        if (objVecTypeIdxForIter !== undefined) {
          notIterTest.push(
            { op: "local.get", index: anyLocalIdx },
            { op: "ref.test", typeIdx: objVecTypeIdxForIter },
            { op: "i32.or" },
          );
        }
        current = [
          ...notIterTest,
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: current,
            else: iterCall,
          },
        ];
      }
    }

    // (#2903 R3) LAZY Iterator-helper arm (map/filter/take/drop, arity ≥1).
    // Same non-vec/non-$Object iterator split as the eager arm above: a
    // generator / driven frame / Map-Set-array iterator / lazy-wrapper receiver
    // routes to the native wrapper constructor `__iter_lazy_<name>(recv, arg0)`
    // (returns a `$LazyIterHelper` iterator, iter-lazy-native.ts). For map/filter
    // this sits UNDER the #3098 vec HOF arm (wrapped outside), so a vec receiver
    // still eager-maps; take/drop have no vec arm (arrays lack them → the legacy
    // undefined on a vec receiver, unchanged). Previously these receivers fell to
    // `__extern_method_call`'s non-`$Object` arm and silently answered undefined.
    {
      const lazyCtorIdx = ctx.funcMap.get(`__iter_lazy_${methodName}`);
      const objTypeIdxForLazy = ctx.objectRuntimeTypes?.objectTypeIdx;
      const objVecTypeIdxForLazy = ctx.objectRuntimeTypes?.objVecTypeIdx;
      if (
        ctx.standalone &&
        lazyCtorIdx !== undefined &&
        LAZY_ITER_METHODS.has(methodName) &&
        isLazyIterForm(methodName, arity) &&
        objTypeIdxForLazy !== undefined
      ) {
        const lazyCall: Instr[] = [
          { op: "local.get", index: 0 }, // recv
          { op: "local.get", index: 1 }, // arg0 (mapper/predicate | count)
          { op: "call", funcIdx: lazyCtorIdx },
        ];
        // isNotIterTarget = null ∨ $Object ∨ $__vec_base ∨ $ObjVec — a NULL/
        // $Object/vec receiver keeps the legacy route; everything else (iterator
        // carriers) constructs the lazy wrapper.
        const notIterTest: Instr[] = [
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.is_null" },
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.test", typeIdx: objTypeIdxForLazy },
          { op: "i32.or" },
        ];
        if (ctx.vecBaseTypeIdx >= 0) {
          notIterTest.push(
            { op: "local.get", index: anyLocalIdx },
            { op: "ref.test", typeIdx: ctx.vecBaseTypeIdx },
            { op: "i32.or" },
          );
        }
        if (objVecTypeIdxForLazy !== undefined) {
          notIterTest.push(
            { op: "local.get", index: anyLocalIdx },
            { op: "ref.test", typeIdx: objVecTypeIdxForLazy },
            { op: "i32.or" },
          );
        }
        current = [
          ...notIterTest,
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: current,
            else: lazyCall,
          },
        ];
      }
    }

    // (#2583) `$__vec_base` brand arm for callback-free array search/predicate
    // methods (indexOf/lastIndexOf/includes, arity 1). A genuinely-`any` array
    // receiver compiles to a `$__vec_base`-subtyped struct, NOT an object-literal
    // struct, so it never matches an `entries` arm; without this arm it would
    // fall to the open-`$Object` bottom arm and return `undefined`. We service it
    // natively (no closure bridge) via `__extern_length`/`__extern_get_idx` +
    // `__extern_strict_eq`/`__extern_same_value_zero`, mirroring the typed
    // array-method path's semantics (#1461/#54). Standalone/wasi only — gated on
    // the deps being present (all registered at reserve time).
    //
    // Scratch locals `$len`/`$i` (f64) sit AFTER `__any`/`__argvec`; their
    // indices are computed from the locals array below so they stay in sync.
    const externLengthIdx = ctx.funcMap.get("__extern_length");
    const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
    const boxBoolIdx = ctx.funcMap.get("__box_boolean");
    const strictEqIdx = ctx.funcMap.get("__extern_strict_eq");
    const sameValueZeroIdx = ctx.funcMap.get("__extern_same_value_zero");
    const eqIdx = methodName === "includes" ? sameValueZeroIdx : strictEqIdx;
    const wantVecArm =
      (ctx.standalone || ctx.wasi) &&
      VEC_SEARCH_METHODS.has(methodName) &&
      arity >= 1 &&
      ctx.vecBaseTypeIdx >= 0 &&
      externLengthIdx !== undefined &&
      externGetIdxIdx !== undefined &&
      ci.boxNumIdx !== undefined &&
      eqIdx !== undefined &&
      (methodName !== "includes" || boxBoolIdx !== undefined);

    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    if (arity > 0 && objVecNewIdx !== undefined && objVecPushIdx !== undefined) {
      locals.push({ name: "__argvec", type: { kind: "externref" } });
    }
    if (wantVecArm) {
      const lenLocalIdx = arity + 1 + locals.length; // first slot after the existing locals
      const iLocalIdx = lenLocalIdx + 1;
      locals.push({ name: "__veclen", type: { kind: "f64" } });
      locals.push({ name: "__veci", type: { kind: "f64" } });

      const boxNum = ci.boxNumIdx as number;
      // Per-iteration: eq = eqIdx(__extern_get_idx(recv, i), arg0)
      const elemEq: Instr[] = [
        { op: "local.get", index: 0 },
        { op: "local.get", index: iLocalIdx },
        { op: "call", funcIdx: externGetIdxIdx },
        { op: "local.get", index: 1 }, // search target (arg0)
        { op: "call", funcIdx: eqIdx },
      ];
      // On match: return boxed index (indexOf/lastIndexOf) or boxed-true (includes).
      const onMatch: Instr[] =
        methodName === "includes"
          ? [{ op: "i32.const", value: 1 }, { op: "call", funcIdx: boxBoolIdx as number }, { op: "return" }]
          : [{ op: "local.get", index: iLocalIdx }, { op: "call", funcIdx: boxNum }, { op: "return" }];
      // Not-found result (loop fell through): boxed-false / boxed -1.
      const notFound: Instr[] =
        methodName === "includes"
          ? [
              { op: "i32.const", value: 0 },
              { op: "call", funcIdx: boxBoolIdx as number },
            ]
          : [
              { op: "f64.const", value: -1 },
              { op: "call", funcIdx: boxNum },
            ];

      const forward = methodName !== "lastIndexOf";
      // len = __extern_length(recv)
      const setLen: Instr[] = [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: externLengthIdx },
        { op: "local.set", index: lenLocalIdx },
      ];
      // (#3170) `fromIndex` support. The generic `$__vec_base` search arm
      // previously IGNORED the 2nd argument, so `indexOf(x, n)` /
      // `lastIndexOf(x, n)` / `includes(x, n)` over an any-array receiver always
      // scanned the whole array (wrong per §23.1.3.14/.20/.15). When a
      // `fromIndex` arg is present (arity ≥ 2) it overrides the scan START:
      //   n = ToIntegerOrInfinity(fromIndex)  — `__unbox_number` then NaN→0,
      //       else trunc toward zero.
      //   forward (indexOf/includes): k = n≥0 ? n : max(len+n, 0)
      //   backward (lastIndexOf):     k = n≥0 ? min(n, len-1) : len+n
      // ±∞ falls out naturally: forward n=+∞ → k=+∞ ≥ len → 0 iterations → miss;
      // backward n=-∞ → k=len+(-∞)=-∞ < 0 → 0 iterations → miss. arity 1 (no
      // fromIndex) keeps the byte-identical default start (forward 0 / len-1).
      // A non-numeric fromIndex (`__unbox_number` → NaN → 0) matches
      // ToIntegerOrInfinity for the numeric/undefined cases; a fromIndex that is
      // an object/string requiring ToPrimitive/StringToNumber is out of scope
      // (deferred residual — see #3170).
      const hasFromIndex = arity >= 2 && ci.unboxNumIdx !== undefined;
      const nLocalIdx = iLocalIdx + 1;
      if (hasFromIndex) locals.push({ name: "__vecfrom", type: { kind: "f64" } });
      // n = ToIntegerOrInfinity(fromIndex) into __vecfrom.
      const toInteger: Instr[] = hasFromIndex
        ? [
            { op: "local.get", index: 2 }, // fromIndex (arg1)
            { op: "call", funcIdx: ci.unboxNumIdx as number },
            { op: "local.tee", index: nLocalIdx },
            { op: "local.get", index: nLocalIdx },
            { op: "f64.ne" }, // n !== n ⇒ NaN
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "f64.const", value: 0 },
                { op: "local.set", index: nLocalIdx },
              ],
              else: [
                { op: "local.get", index: nLocalIdx },
                { op: "f64.trunc" }, // toward zero
                { op: "local.set", index: nLocalIdx },
              ],
            },
          ]
        : [];

      // Loop body. Forward: i=k; while i<len { … i+=1 }. Backward: i=k; while i>=0 { … i-=1 }.
      let loopInit: Instr[];
      let loopExitTest: Instr[];
      let loopStep: Instr[];
      if (forward) {
        loopInit = hasFromIndex
          ? [
              ...toInteger,
              // k = n≥0 ? n : max(len+n, 0)
              { op: "local.get", index: nLocalIdx },
              { op: "f64.const", value: 0 },
              { op: "f64.ge" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "f64" } },
                then: [{ op: "local.get", index: nLocalIdx }],
                else: [
                  { op: "local.get", index: lenLocalIdx },
                  { op: "local.get", index: nLocalIdx },
                  { op: "f64.add" },
                  { op: "f64.const", value: 0 },
                  { op: "f64.max" },
                ],
              },
              { op: "local.set", index: iLocalIdx },
            ]
          : [
              { op: "f64.const", value: 0 },
              { op: "local.set", index: iLocalIdx },
            ];
        loopExitTest = [
          { op: "local.get", index: iLocalIdx },
          { op: "local.get", index: lenLocalIdx },
          { op: "f64.ge" }, // i >= len → exit
        ];
        loopStep = [
          { op: "local.get", index: iLocalIdx },
          { op: "f64.const", value: 1 },
          { op: "f64.add" },
          { op: "local.set", index: iLocalIdx },
        ];
      } else {
        loopInit = hasFromIndex
          ? [
              ...toInteger,
              // k = n≥0 ? min(n, len-1) : len+n
              { op: "local.get", index: nLocalIdx },
              { op: "f64.const", value: 0 },
              { op: "f64.ge" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "f64" } },
                then: [
                  { op: "local.get", index: nLocalIdx },
                  { op: "local.get", index: lenLocalIdx },
                  { op: "f64.const", value: 1 },
                  { op: "f64.sub" },
                  { op: "f64.min" },
                ],
                else: [
                  { op: "local.get", index: lenLocalIdx },
                  { op: "local.get", index: nLocalIdx },
                  { op: "f64.add" },
                ],
              },
              { op: "local.set", index: iLocalIdx },
            ]
          : [
              { op: "local.get", index: lenLocalIdx },
              { op: "f64.const", value: 1 },
              { op: "f64.sub" },
              { op: "local.set", index: iLocalIdx },
            ];
        loopExitTest = [
          { op: "local.get", index: iLocalIdx },
          { op: "f64.const", value: 0 },
          { op: "f64.lt" }, // i < 0 → exit
        ];
        loopStep = [
          { op: "local.get", index: iLocalIdx },
          { op: "f64.const", value: 1 },
          { op: "f64.sub" },
          { op: "local.set", index: iLocalIdx },
        ];
      }
      // (block $done (loop $scan exitTest br_if $done; if(eq) onMatch; step; br $scan)) notFound
      const vecArmBody: Instr[] = [
        ...setLen,
        ...loopInit,
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                ...loopExitTest,
                { op: "br_if", depth: 1 }, // exit to $done
                ...elemEq,
                { op: "if", blockType: { kind: "empty" }, then: onMatch },
                ...loopStep,
                { op: "br", depth: 0 }, // continue $scan
              ],
            },
          ],
        },
        ...notFound,
      ];
      current = [
        { op: "local.get", index: anyLocalIdx },
        { op: "ref.test", typeIdx: ctx.vecBaseTypeIdx },
        { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: vecArmBody, else: current },
      ];
    }

    // (#2927) `$__vec_base` brand arm for the in-place array MUTATION methods
    // (`push` arity 1 / `pop` arity 0). A genuinely-`any` array receiver is a
    // `$__vec_base`-subtyped struct that matches no `entries` arm; without this
    // it falls to the open-`$Object` bottom arm which returns `undefined` and (for
    // push) silently drops the element — a host-free data-loss bug on
    // `--target standalone` (the #2784 S3 JS-host/gc-gated native-vec dispatch
    // never fires standalone). Route to the carrier-generic `__vec_push` /
    // `__vec_pop` helpers (reserved at reserve-time; body filled in the finalize
    // vec-export pass).
    const vecPushIdx = resolveVecHostBridgeHelper(ctx, "push");
    const vecPopIdx = resolveVecHostBridgeHelper(ctx, "pop");
    const wantVecMutArm =
      (ctx.standalone || ctx.wasi) &&
      VEC_MUTATE_METHODS.has(methodName) &&
      isVecMutateForm(methodName, arity) &&
      ctx.vecBaseTypeIdx >= 0;
    if (wantVecMutArm) {
      let mutArmBody: Instr[] | undefined;
      if (methodName === "push" && vecPushIdx !== undefined && ci.boxNumIdx !== undefined) {
        // __vec_push(recv, arg0) -> i32 new length, or -1 when the vec's element
        // kind is NOT push-supported (e.g. a native-string carrier — see
        // `mutEntries` in index.ts, which covers only externref/f64/i32). On the
        // -1 sentinel we must NOT box -1 as a bogus "new length"; instead return
        // `undefined` (ref.null.extern), matching the pre-#2927 open-`$Object`
        // fall-through so an unsupported carrier is no WORSE than before (its
        // `.length` was already unchanged). A scratch i32 holds the result across
        // the sign test.
        const pushLenLocalIdx = arity + 1 + locals.length;
        locals.push({ name: "__vpushlen", type: { kind: "i32" } });
        mutArmBody = [
          { op: "local.get", index: 0 }, // recv (externref)
          { op: "local.get", index: 1 }, // arg0 (externref)
          { op: "call", funcIdx: vecPushIdx },
          { op: "local.tee", index: pushLenLocalIdx },
          { op: "i32.const", value: 0 },
          { op: "i32.lt_s" }, // newLen < 0 → unsupported carrier
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "ref.null.extern" }], // undefined (pre-#2927 behavior)
            else: [
              { op: "local.get", index: pushLenLocalIdx },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: ci.boxNumIdx },
            ],
          },
        ];
      } else if (methodName === "pop" && vecPopIdx !== undefined) {
        // __vec_pop(recv) -> externref (already-boxed last element; null.extern for
        // an empty OR unsupported-carrier vec — both map to `undefined`, which is
        // exactly the pre-#2927 fall-through result, so no guard is needed).
        mutArmBody = [
          { op: "local.get", index: 0 }, // recv (externref)
          { op: "call", funcIdx: vecPopIdx },
        ];
      }
      if (mutArmBody !== undefined) {
        current = [
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.test", typeIdx: ctx.vecBaseTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: mutArmBody,
            else: current,
          },
        ];
      }
    }

    // (#3309) `$Map` brand arm for the collection methods (`get`/`set`/`has`/
    // `add`/`delete`/`clear`) on a genuinely-`any` receiver. All four
    // collections (Map/Set/WeakMap/WeakSet) share the `$Map` struct; the
    // immutable `kind` tag (COLLECTION_KIND, #3171) carries the brand, so a
    // per-method kind guard routes only the kinds that actually declare the
    // method — a guard miss returns `undefined` (`ref.null.extern`), matching
    // the pre-#3309 open-`$Object` fall-through (`Set` has no `get`; the
    // brand-check TypeError refinement is #2604-family follow-up territory).
    // Helpers were emitted at reserve time (`ensureMapHelpers`/
    // `ensureSetHelpers` — this fill only READS `ctx.mapHelpers`, #1719). Args
    // arrive as externref and convert via `any.convert_extern` — the SAME
    // boxed rep `coerceArgToAnyref` produces on the typed path (numbers boxed
    // via `__box_number` at the dispatcher call site), so key hashing /
    // SameValueZero agree across the typed and any-receiver lanes. Sits UNDER
    // the closed-struct/field arms (a user `{ get(){…} }` still wins); a
    // `$Map` never matches a vec/DV test, so order among brand arms is
    // behavior-neutral. Standalone/wasi only.
    if (
      (ctx.standalone || ctx.wasi) &&
      ctx.mapTypeIdx >= 0 &&
      COLLECTION_METHODS.has(methodName) &&
      isCollectionMethodForm(methodName, arity)
    ) {
      const boxBoolIdx = ctx.funcMap.get("__box_boolean");
      // helper + allowed kinds per method (null kinds = no guard needed —
      // all four collections declare has/delete).
      let helperIdx: number | undefined;
      let allowedKinds: number[] | null = null;
      let resultShape: "anyref" | "bool" | "void" = "anyref";
      switch (methodName) {
        case "get":
          helperIdx = ctx.mapHelpers.get("__map_get");
          allowedKinds = [COLLECTION_KIND.MAP, COLLECTION_KIND.WEAKMAP];
          break;
        case "set":
          helperIdx = ctx.mapHelpers.get("__map_set");
          allowedKinds = [COLLECTION_KIND.MAP, COLLECTION_KIND.WEAKMAP];
          break;
        case "has":
          helperIdx = ctx.mapHelpers.get("__map_has");
          resultShape = "bool";
          break;
        case "delete":
          helperIdx = ctx.mapHelpers.get("__map_delete");
          resultShape = "bool";
          break;
        case "add":
          helperIdx = ctx.mapHelpers.get("__set_add");
          allowedKinds = [COLLECTION_KIND.SET, COLLECTION_KIND.WEAKSET];
          break;
        case "clear":
          helperIdx = ctx.mapHelpers.get("__map_clear");
          allowedKinds = [COLLECTION_KIND.MAP, COLLECTION_KIND.SET]; // weak collections have no clear
          resultShape = "void";
          break;
      }
      if (helperIdx !== undefined && (resultShape !== "bool" || boxBoolIdx !== undefined)) {
        // receiver (ref $Map) + anyref-converted args → helper → externref.
        const helperCall: Instr[] = [
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.cast", typeIdx: ctx.mapTypeIdx },
        ];
        for (let a = 0; a < arity; a++) {
          helperCall.push({ op: "local.get", index: 1 + a });
          helperCall.push({ op: "any.convert_extern" });
        }
        helperCall.push({ op: "call", funcIdx: helperIdx });
        const undefExternCol = undefinedExternInstrs(ctx);
        if (resultShape === "bool") {
          helperCall.push({ op: "call", funcIdx: boxBoolIdx as number }); // i32 → externref
        } else if (resultShape === "void") {
          // (#3331) JS-visible `undefined` result — materialize the singleton
          // under the #2106 regime; legacy keeps `ref.null.extern`.
          helperCall.push(...(undefExternCol ?? [{ op: "ref.null.extern" } as Instr]));
        } else {
          // anyref value (get) or the chainable `ref $Map` receiver (set/add)
          // — both anyref subtypes. A `get` MISS arrives as the $undefined
          // singleton from `__map_get` itself under the #2106 regime (#3331,
          // producer-honest miss), so no boundary materialization is needed.
          helperCall.push({ op: "extern.convert_any" });
        }
        let mapArmBody: Instr[];
        if (allowedKinds === null) {
          mapArmBody = helperCall;
        } else {
          // ckind = recv.kind; (ckind == k0) | (ckind == k1) ? helper : undefined
          const kindLocalIdx = arity + 1 + locals.length;
          locals.push({ name: "__ckind", type: { kind: "i32" } });
          mapArmBody = [
            { op: "local.get", index: anyLocalIdx },
            { op: "ref.cast", typeIdx: ctx.mapTypeIdx },
            { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: MAP_LAYOUT.M_KIND },
            { op: "local.set", index: kindLocalIdx },
            { op: "local.get", index: kindLocalIdx },
            { op: "i32.const", value: allowedKinds[0]! },
            { op: "i32.eq" },
            { op: "local.get", index: kindLocalIdx },
            { op: "i32.const", value: allowedKinds[1]! },
            { op: "i32.eq" },
            { op: "i32.or" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: helperCall,
              else: [{ op: "ref.null.extern" }],
            },
          ];
        }
        current = [
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.test", typeIdx: ctx.mapTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: mapArmBody,
            else: current,
          },
        ];
      }
    }

    // (#3098) Native array-HOF arm for a genuinely-`any` array receiver
    // (`const a: any = […]; a.map(cb)`). Matches BOTH dynamic array reps:
    // the `$__vec_base`-subtyped wasm vec carriers (array literals held in
    // `any`) AND the `$ObjVec` boxed-any carrier (enumeration results,
    // `map`/`filter` outputs — so chained HOFs work). Routes to the
    // `__hof_<name>` native loop (emitted at reserve time), which invokes the
    // callback via `__apply_closure` — no `env.__make_callback` host bridge.
    // Callback signature per §23.1.3.*: predicate/map family
    // `__hof_<name>(recv, cb, thisArg)` — dispatcher arity 1 passes
    // undefined thisArg, arity ≥2 forwards arg1 (extra args ignored per
    // spec); reduce family `__hof_<name>(recv, cb, init, hasInit)` — arity 1
    // means no initial value. Standalone only (gated at reserve; the helper
    // is simply absent otherwise). Sits UNDER the closed-struct arms so a
    // user object-literal `{ map(cb){…} }` still wins.
    {
      const hofFuncIdx = ctx.funcMap.get(`__hof_${methodName}`);
      const objVecTypeIdx = ctx.objectRuntimeTypes?.objVecTypeIdx;
      if (
        ctx.standalone &&
        arity >= 1 &&
        hofFuncIdx !== undefined &&
        ctx.vecBaseTypeIdx >= 0 &&
        objVecTypeIdx !== undefined
      ) {
        const isReduceForm = methodName === "reduce" || methodName === "reduceRight";
        const hofCall: Instr[] = [
          { op: "local.get", index: 0 }, // recv (externref)
          { op: "local.get", index: 1 }, // cb
          ...((arity >= 2 ? [{ op: "local.get", index: 2 }] : [{ op: "ref.null.extern" }]) satisfies Instr[]), // thisArg | init
          ...((isReduceForm ? [{ op: "i32.const", value: arity >= 2 ? 1 : 0 }] : []) satisfies Instr[]), // hasInit
          { op: "call", funcIdx: hofFuncIdx },
        ];
        const arrayHofTargetTest = buildFnctorArrayHofTargetTest(ctx, anyLocalIdx, ctx.vecBaseTypeIdx, objVecTypeIdx);
        current = [
          ...arrayHofTargetTest,
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: hofCall,
            else: current,
          },
        ];
      }
    }

    // (#3173) `$__dv_window` brand arm for the DataView.prototype get*/set*
    // accessors on a genuinely-`any` receiver (`var sample; sample = new
    // DataView(b); … () => sample.getUint8(Infinity)` — the assert.throws
    // callback shape where the receiver widens to `any`). Routes to the shared
    // `__dv_m_<name>` native helper (brand → ToIndex → [ToNumber] → detached →
    // bounds → op, minted at the CALL SITE in calls.ts — the fill only READS
    // funcMap, #1719). Sits UNDER the closed-struct arms (a user `{ getUint8(){…} }`
    // still wins); a `$__dv_window` can never match a closed-struct arm, so the
    // relative order is behavior-neutral there. Standalone/wasi only.
    {
      const dvHelperIdx = ctx.funcMap.get(`__dv_m_${methodName}`);
      if ((ctx.standalone || ctx.wasi) && dvHelperIdx !== undefined && ctx.dvWindowTypeIdx >= 0) {
        // Helper signature: recv + (get → offset, le | set → offset, value, le).
        const helperArgs = methodName.startsWith("get") ? 2 : 3;
        const dvCall: Instr[] = [{ op: "local.get", index: 0 }];
        for (let i = 0; i < helperArgs; i++) {
          dvCall.push(i < arity ? { op: "local.get", index: 1 + i } : { op: "ref.null.extern" });
        }
        dvCall.push({ op: "call", funcIdx: dvHelperIdx });
        current = [
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.test", typeIdx: ctx.dvWindowTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: dvCall,
            else: current,
          },
        ];
      }
    }

    // #3507 — helper/object/array carriers erase a native RegExp to externref.
    // Dispatch `.test(subject)` by the runtime `$NativeRegExp` brand, not by
    // the first ambient extern class named `test`. User closed-struct methods
    // are wrapped outside this arm below and therefore retain precedence.
    let wrapNativeRegExpTest: ((fallback: Instr[]) => Instr[]) | undefined;
    {
      const regexpTypeIdx = ctx.structMap.get("__StandaloneRegExp");
      const regexpTestIdx = ctx.funcMap.get("__regexp_test_carrier");
      const boxBoolIdx = ctx.funcMap.get("__box_boolean");
      if (
        ctx.standalone &&
        methodName === "test" &&
        arity === 1 &&
        regexpTypeIdx !== undefined &&
        regexpTestIdx !== undefined &&
        boxBoolIdx !== undefined
      ) {
        wrapNativeRegExpTest = (fallback: Instr[]): Instr[] => [
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.test", typeIdx: regexpTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: regexpTestIdx },
              { op: "call", funcIdx: boxBoolIdx },
            ],
            else: fallback,
          },
        ];
        if (process.env.JS2WASM_REGEXP_TEST_OUTER_BRAND === "0") {
          current = wrapNativeRegExpTest(current);
        }
      }
    }

    // (#3117) FIELD-stored-closure arms — a pre-shaped closed struct whose
    // externref field `<name>` holds a boxed closure (`o.f = function(){}` on
    // a `{}` literal). Read the field and invoke via `__apply_closure` (args
    // marshaled to a fresh $ObjVec, same shape as the bottom arm). Sits UNDER
    // the real method arms (methods win via the wrap order below) and ABOVE
    // the vec/HOF/open-$Object arms. Empty slot → undefined (the pre-#3117
    // miss semantics, not a TypeError — that refinement rides the error lane).
    const applyClosureIdx = ctx.funcMap.get("__apply_closure");
    const canMarshalArgs = objVecNewIdx !== undefined && (arity === 0 || objVecPushIdx !== undefined);
    const fieldEntries = applyClosureIdx !== undefined && canMarshalArgs ? collectFieldEntries(ctx, methodName) : [];
    if (fieldEntries.length > 0) {
      const fnLocalIdx = arity + 1 + locals.length;
      locals.push({ name: "__fieldfn", type: { kind: "externref" } });
      for (const fe of fieldEntries) {
        const argVec: Instr[] = [];
        if (arity > 0) {
          const vecTmp = anyLocalIdx + 1; // the __argvec local (declared above)
          argVec.push({ op: "call", funcIdx: objVecNewIdx as number });
          argVec.push({ op: "local.set", index: vecTmp });
          for (let a = 0; a < arity; a++) {
            argVec.push({ op: "local.get", index: vecTmp });
            argVec.push({ op: "local.get", index: 1 + a });
            argVec.push({ op: "call", funcIdx: objVecPushIdx as number });
          }
          argVec.push({ op: "local.get", index: vecTmp });
        } else {
          argVec.push({ op: "call", funcIdx: objVecNewIdx as number });
        }
        const armBody: Instr[] = [
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.cast", typeIdx: fe.typeIdx },
          { op: "struct.get", typeIdx: fe.typeIdx, fieldIdx: fe.fieldIdx },
          { op: "local.tee", index: fnLocalIdx },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "ref.null.extern" }],
            else: [
              { op: "local.get", index: fnLocalIdx },
              { op: "local.get", index: 0 },
              ...argVec,
              { op: "call", funcIdx: applyClosureIdx! },
            ],
          },
        ];
        current = [
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.test", typeIdx: fe.typeIdx },
          { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: armBody, else: current },
        ];
      }
    }

    for (const entry of entries) {
      const callAndCoerce = buildEntryArm(ci, anyLocalIdx, entry, (a) => [{ op: "local.get", index: 1 + a }], arity);
      current = [
        { op: "local.get", index: anyLocalIdx },
        { op: "ref.test", typeIdx: entry.typeIdx },
        { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: callAndCoerce, else: current },
      ];
    }

    // A `$NativeRegExp` is representation-disjoint from every user closed
    // struct and field-carrier arm wrapped above. Put the same native `test`
    // brand arm outermost so tokenizer calls do one ref.test before entering
    // the regex engine instead of walking the generated user-method ladder.
    // The inner arm remains the fallback under the kill switch and keeps the
    // construction order of all unrelated dispatchers byte-identical.
    if (process.env.JS2WASM_REGEXP_TEST_OUTER_BRAND !== "0" && wrapNativeRegExpTest !== undefined) {
      current = wrapNativeRegExpTest(current);
    }

    // (#4185) Closure-receiver fast `.call` arm, outermost (see
    // closure-call-fast.ts) — appends its own scratch local BEFORE the
    // round-13 patch below computes its slot, so both stay distinct.
    current = wrapClosureCallFastArm(ctx, methodName, arity, anyLocalIdx, current, locals);

    // (#3673 round 13) Patch the cached-direct-call arm's scratch-local slot
    // now that the locals array is final.
    if (mcPatchInstrs.length > 0) {
      const mResLocal = arity + 1 + locals.length;
      locals.push({ name: "__mc_m", type: { kind: "externref" } });
      for (const instr of mcPatchInstrs) (instr as { index: number }).index = mResLocal;
    }

    dispFn.locals = locals;
    dispFn.body = [
      ...nullishReceiverGuardInstrs(ctx, methodName),
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: anyLocalIdx },
      ...current,
    ];
    if (process.env.DEBUG_MARKED_CODEGEN === "1" && (methodName === "lexer" || methodName === "parseInline")) {
      console.error("[marked-fill-lexer]", dispIdx, entries.length, dispFn.body.slice(-5));
    }
    void (dispFn as WasmFunction);
  }

  // ── Vararg dispatchers (#2151 Slice 4 — dynamic spread `o.m(...xs)`) ─────
  // Signature `(recv: externref, args: externref) -> externref`. Each candidate
  // struct's declared param i is sourced from `__extern_get_idx(args, i)` (a
  // native index read over the runtime $ObjVec / wasm vec; out-of-range → null,
  // matching `undefined`). The bottom arm forwards the SAME `args` externref to
  // `__extern_method_call(recv, name, args)` for the open-$Object case.
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  for (const methodName of ctx.closedMethodDispatchVarargNames ?? []) {
    const dispIdx = ctx.funcMap.get(varargDispatcherName(methodName));
    if (dispIdx === undefined) continue;
    const dispFn = definedFuncAt(ctx, dispIdx);
    if (!dispFn) continue;

    // Param layout: local 0 = recv, local 1 = args (externref), local 2 = `any`.
    const argsLocalIdx = 1;
    const anyLocalIdx = 2;
    const entries = collectMethodEntries(ctx, methodName, null);

    // Bottom arm: open-$Object fallback forwards `args` directly.
    let current: Instr[] =
      methodCallIdx !== undefined
        ? [
            { op: "local.get", index: 0 },
            ...stringConstantExternrefInstrs(ctx, methodName),
            { op: "local.get", index: argsLocalIdx },
            { op: "call", funcIdx: methodCallIdx },
          ]
        : [{ op: "ref.null.extern" }];

    // (#3117) FIELD-stored-closure arms — same as the fixed-arity fill, but the
    // dispatcher's `args` externref forwards to `__apply_closure` unchanged.
    const varargLocals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    const applyClosureIdx = ctx.funcMap.get("__apply_closure");
    const fieldEntries = applyClosureIdx !== undefined ? collectFieldEntries(ctx, methodName) : [];
    if (fieldEntries.length > 0) {
      const fnLocalIdx = anyLocalIdx + varargLocals.length; // after __any
      varargLocals.push({ name: "__fieldfn", type: { kind: "externref" } });
      for (const fe of fieldEntries) {
        const armBody: Instr[] = [
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.cast", typeIdx: fe.typeIdx },
          { op: "struct.get", typeIdx: fe.typeIdx, fieldIdx: fe.fieldIdx },
          { op: "local.tee", index: fnLocalIdx },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "ref.null.extern" }],
            else: [
              { op: "local.get", index: fnLocalIdx },
              { op: "local.get", index: 0 },
              { op: "local.get", index: argsLocalIdx },
              { op: "call", funcIdx: applyClosureIdx! },
            ],
          },
        ];
        current = [
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.test", typeIdx: fe.typeIdx },
          { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: armBody, else: current },
        ];
      }
    }

    for (const entry of entries) {
      // arg a ← __extern_get_idx(args, a). If the helper is absent, the arm can't
      // source args → skip (defensive; it is always present via reserve).
      const callAndCoerce =
        externGetIdxIdx !== undefined
          ? buildEntryArm(ci, anyLocalIdx, entry, (a) => [
              { op: "local.get", index: argsLocalIdx },
              { op: "f64.const", value: a },
              { op: "call", funcIdx: externGetIdxIdx },
            ])
          : current;
      current = [
        { op: "local.get", index: anyLocalIdx },
        { op: "ref.test", typeIdx: entry.typeIdx },
        { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: callAndCoerce, else: current },
      ];
    }

    dispFn.locals = varargLocals;
    dispFn.body = [
      ...nullishReceiverGuardInstrs(ctx, methodName),
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: anyLocalIdx },
      ...current,
    ];
    void (dispFn as WasmFunction);
  }
}

/**
 * (#3125) Fill the reserved `__promise_has_callable_then(value) -> i32`
 * predicate at FINALIZE — the §27.2.1.3.2 steps 8–11 "Get(resolution, "then")
 * + IsCallable(then)" test for the native-Promise resolve path
 * (`__promise_resolve_value`, async-scheduler.ts).
 *
 * Lives HERE (not async-scheduler.ts) so its arms are built from the SAME
 * collectors as `__call_m_then_vararg` — the dispatcher the thenable job
 * invokes — and the two can never drift apart:
 *   - a closed struct with a compiled `<Struct>_then` METHOD (any declared
 *     arity — matching the vararg dispatcher's `exactArity: null`) → callable;
 *   - a closed struct whose externref FIELD `then` holds a closure (#3117
 *     `o.then = function(){}` on a pre-shaped literal, and the dominant
 *     `{ then: function(resolve){…} }` object-literal shape) → test the stored
 *     value against the closure base wrappers (#2175 single classifier);
 *   - an open `$Object` → `__extern_get(value, "then")` — which RUNS a stored
 *     accessor, so a poisoned getter THROWS out of this predicate (the caller
 *     catches and rejects, step 9) — then the closure test;
 *   - anything else (strings, boxed primitives, vecs, closures, null) → 0.
 *
 * Only READS funcMap/type space (#1719): `__extern_get` + the "then" string
 * constant were registered at reserve time (`reserveClosedMethodDispatchVararg`
 * from `ensurePromiseThenableSubstrate`). No-op unless the substrate reserved
 * the predicate (`ctx.promiseThenableReserved` — standalone/wasi only, so
 * gc/host stays byte-identical).
 */
export function fillPromiseThenableHelpers(ctx: CodegenContext): void {
  if (!ctx.promiseThenableReserved) return;
  const predIdx = ctx.funcMap.get("__promise_has_callable_then");
  if (predIdx === undefined) return;
  const predFn = definedFuncAt(ctx, predIdx);
  if (!predFn) return;

  // ── `__promise_peel_value(value) -> externref` ─────────────────────────
  // Unwrap an `$AnyValue`-boxed resolution so the predicate / thenable-job
  // dispatch `ref.test` the RAW payload: tag 6 → refval (the GC object),
  // tag 5 → externval (string OR tag-5-carried object — the classifier arms
  // below reject non-objects anyway), every other tag / non-box → unchanged.
  // Left as the identity placeholder when `$AnyValue` was never registered.
  const peelIdx = ctx.funcMap.get("__promise_peel_value");
  const peelFn = peelIdx !== undefined ? definedFuncAt(ctx, peelIdx) : undefined;
  const anyValueTypeIdx = ctx.anyValueTypeIdx;
  if (peelFn && anyValueTypeIdx >= 0) {
    // $AnyValue field layout (ensureAnyValueType): 0 tag · 3 refval · 4 externval.
    const AV_TAG = 0;
    const AV_REF = 3;
    const AV_EXT = 4;
    const peelAnyLocal = 1;
    peelFn.locals = [{ name: "__any", type: { kind: "anyref" } }];
    peelFn.body = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: peelAnyLocal },
      { op: "local.get", index: peelAnyLocal },
      { op: "ref.test", typeIdx: anyValueTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // tag 6 (object) → extern.convert_any(refval)
          { op: "local.get", index: peelAnyLocal },
          { op: "ref.cast", typeIdx: anyValueTypeIdx },
          { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: AV_TAG },
          { op: "i32.const", value: 6 },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: peelAnyLocal },
              { op: "ref.cast", typeIdx: anyValueTypeIdx },
              { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: AV_REF },
              { op: "extern.convert_any" },
              { op: "return" },
            ],
          },
          // tag 5 (string/extern payload) → externval
          { op: "local.get", index: peelAnyLocal },
          { op: "ref.cast", typeIdx: anyValueTypeIdx },
          { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: AV_TAG },
          { op: "i32.const", value: 5 },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: peelAnyLocal },
              { op: "ref.cast", typeIdx: anyValueTypeIdx },
              { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: AV_EXT },
              { op: "return" },
            ],
          },
        ],
      },
      { op: "local.get", index: 0 },
    ];
  }

  // ── `__promise_has_callable_then(value) -> i32` ────────────────────────
  const peeledLocalIdx = 1; // param 0 = value externref
  const anyLocalIdx = 2;
  const thenAnyLocalIdx = 3;
  const body: Instr[] = [
    // peeled = __promise_peel_value(value) — classify the RAW payload.
    { op: "local.get", index: 0 },
    ...((peelIdx !== undefined ? [{ op: "call", funcIdx: peelIdx }] : []) satisfies Instr[]),
    { op: "local.set", index: peeledLocalIdx },
    // null externref (JS null / absent) → not a thenable.
    { op: "local.get", index: peeledLocalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: peeledLocalIdx },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocalIdx },
  ];

  // Shared tail: test the externref left on the stack against the closure
  // base wrappers; 1 on a hit, else 0.
  const closureTest = (loadThen: Instr[]): Instr[] => [
    ...loadThen,
    { op: "any.convert_extern" },
    { op: "local.set", index: thenAnyLocalIdx },
    ...buildClosureRefTestArms(ctx, thenAnyLocalIdx, [{ op: "i32.const", value: 1 }, { op: "return" }]),
    { op: "i32.const", value: 0 },
    { op: "return" },
  ];

  // Closed-struct METHOD arms — a compiled `then` method is always callable.
  const seenMethodType = new Set<number>();
  for (const entry of collectMethodEntries(ctx, "then", null)) {
    if (seenMethodType.has(entry.typeIdx)) continue;
    seenMethodType.add(entry.typeIdx);
    body.push({ op: "local.get", index: anyLocalIdx });
    body.push({ op: "ref.test", typeIdx: entry.typeIdx });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    });
  }

  // Closed-struct ACCESSOR arms (#1888 S5c) — MUST run BEFORE the field arms:
  // `Object.defineProperty(o, 'then', {get})` on a closed-struct target stores
  // the getter closure in a per-(struct,prop) module GLOBAL
  // (`ctx.structAccessorClosure`), invisible to `__extern_get` — while the
  // struct may ALSO carry a pre-shaped (runtime-null) `then` FIELD that would
  // wrongly classify it non-thenable if tested first. Spec Get REQUIRES running
  // the getter here — a poisoned getter must throw OUT of this predicate
  // (resolve-poisoned-then), and a returned closure classifies the value as a
  // thenable. A runtime-null getter global (define-site never executed) falls
  // through to the field/$Object arms below.
  const callAccessorGetIdx = ctx.funcMap.get("__call_accessor_get");
  if (callAccessorGetIdx !== undefined) {
    for (const [key, entry] of ctx.structAccessorClosure) {
      if (!key.endsWith("_then") || entry.getGlobal === undefined) continue;
      const structName = key.slice(0, -"_then".length);
      const structTypeIdx = ctx.structMap.get(structName);
      if (structTypeIdx === undefined) continue;
      body.push({ op: "local.get", index: anyLocalIdx });
      body.push({ op: "ref.test", typeIdx: structTypeIdx });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: entry.getGlobal },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: closureTest([
              // then = getter.call(value) — §7.3.2 GetV via the S5b driver.
              { op: "local.get", index: peeledLocalIdx },
              { op: "global.get", index: entry.getGlobal },
              { op: "call", funcIdx: callAccessorGetIdx },
            ]),
          },
        ],
      });
    }
  }

  // Closed-struct FIELD arms — `{ then: <value> }`: callable iff the stored
  // value is a closure.
  for (const fe of collectFieldEntries(ctx, "then")) {
    body.push({ op: "local.get", index: anyLocalIdx });
    body.push({ op: "ref.test", typeIdx: fe.typeIdx });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: closureTest([
        { op: "local.get", index: anyLocalIdx },
        { op: "ref.cast", typeIdx: fe.typeIdx },
        { op: "struct.get", typeIdx: fe.typeIdx, fieldIdx: fe.fieldIdx },
      ]),
    });
  }

  // Open `$Object` arm — spec Get (runs accessors; a poisoned getter throws
  // OUT of this predicate) + closure test.
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  if (externGetIdx !== undefined && objectTypeIdx !== undefined) {
    body.push({ op: "local.get", index: anyLocalIdx });
    body.push({ op: "ref.test", typeIdx: objectTypeIdx });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: closureTest([
        { op: "local.get", index: peeledLocalIdx },
        ...stringConstantExternrefInstrs(ctx, "then"),
        { op: "call", funcIdx: externGetIdx },
      ]),
    });
  }

  body.push({ op: "i32.const", value: 0 });
  predFn.locals = [
    { name: "__peeled", type: { kind: "externref" } },
    { name: "__any", type: { kind: "anyref" } },
    { name: "__thenAny", type: { kind: "anyref" } },
  ];
  predFn.body = body;
}
