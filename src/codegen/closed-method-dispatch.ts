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
import { ensureExternSameValueZeroHelper, ensureExternStrictEqHelper } from "./any-helpers.js";
import { buildClosureRefTestArms } from "./closure-classifier.js"; // (#3125) IsCallable arms
import type { CodegenContext } from "./context/types.js";
import { ensureNativeArrayHof, NATIVE_HOF_METHODS } from "./hof-native.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType, getOrRegisterVecBaseType } from "./registry/types.js";
import { addUnionImportsViaRegistry } from "./shared.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2 read chokepoint / S3b stable-regime minting)

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
 * Only meaningful under `ctx.standalone || ctx.wasi` — callers gate on that.
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
  ensureObjVecBuilders(ctx);
  addStringConstantGlobal(ctx, methodName);

  // (#3117) The fill adds FIELD-STORED-closure arms (a pre-shaped closed struct
  // whose externref FIELD `<name>` holds a boxed closure — `o.f = function(){}`
  // on a `{}` literal). Those arms invoke through `__apply_closure`; reserve it
  // NOW so `fillApplyClosure` (which runs before this module's fill) gives it a
  // real body and the fill only READS funcMap (#1719). Degrades to the
  // undefined sentinel when no closure dispatcher exists — never traps.
  reserveApplyClosure(ctx);

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

  // (#2927) For the in-place array MUTATION methods (`push`/`pop`), register the
  // native `$__vec_base` brand-arm deps NOW so the fill only READS funcMap
  // (#1719): the `$__vec_base` supertype and `__box_number` (push returns an i32
  // length that the arm boxes). The carrier-generic `__vec_push` / `__vec_pop`
  // helper is reserved by the CALL SITE (`calls.ts`, which already imports
  // `reserveVecMethodHelper` from `../index.js` — importing it here would form an
  // eval-time circular-import cycle: `index.ts` imports this module for
  // `fillClosedMethodDispatch`). Standalone/wasi only.
  if ((ctx.standalone || ctx.wasi) && VEC_MUTATE_METHODS.has(methodName) && isVecMutateForm(methodName, arity)) {
    getOrRegisterVecBaseType(ctx);
    addUnionImportsViaRegistry(ctx); // __box_number for the push new-length result
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
    body: [{ op: "unreachable" } as Instr],
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
  ensureObjVecBuilders(ctx);
  addStringConstantGlobal(ctx, methodName);
  // (#3117) Field-stored-closure arms invoke via `__apply_closure` — see the
  // fixed-arity reserve above.
  reserveApplyClosure(ctx);

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
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  (ctx.closedMethodDispatchVarargNames ??= new Set<string>()).add(methodName);
  return funcIdx;
}

/** One candidate closed struct that carries `<Struct>_<methodName>`. */
type MethodEntry = { typeIdx: number; funcIdx: number; paramTypes: ValType[]; resultType: ValType };

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

    const funcIdx = ctx.funcMap.get(`${structName}_${methodName}`);
    if (funcIdx === undefined) continue;
    const funcDef = definedFuncAt(ctx, funcIdx);
    const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
    if (!funcType || funcType.kind !== "func") continue;
    // Must be `this` + (exactArity) declared params, unless vararg (any arity).
    if (exactArity !== null && funcType.params.length !== 1 + exactArity) continue;
    if (funcType.params.length < 1) continue;
    const resultType: ValType = funcType.results.length > 0 ? funcType.results[0]! : { kind: "externref" };
    entries.push({ typeIdx, funcIdx, paramTypes: funcType.params.slice(1), resultType });
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
    if (ctx.funcMap.has(`${structName}_${methodName}`)) continue; // method wins
    const fieldIdx = fields.findIndex((f) => f.name === methodName && f.type.kind === "externref");
    if (fieldIdx < 0) continue;
    entries.push({ typeIdx, fieldIdx });
  }
  return entries;
}

/** Coerce helper funcIdxs, read once per fill pass (registered at reserve). */
type CoerceIdxs = { boxNumIdx?: number; unboxNumIdx?: number; unboxBoolIdx?: number };

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
): Instr[] {
  const { boxNumIdx, unboxNumIdx, unboxBoolIdx } = ci;
  const arm: Instr[] = [
    { op: "local.get", index: anyLocalIdx } as Instr,
    { op: "ref.cast", typeIdx: entry.typeIdx } as Instr, // `this`
  ];
  for (let a = 0; a < entry.paramTypes.length; a++) {
    const want = entry.paramTypes[a] ?? { kind: "externref" };
    arm.push(...pushArg(a)); // the arg, as externref, onto the stack
    if (want.kind === "f64") {
      if (unboxNumIdx !== undefined) arm.push({ op: "call", funcIdx: unboxNumIdx } as Instr);
      else arm.push({ op: "drop" } as Instr, { op: "f64.const", value: 0 } as Instr);
    } else if (want.kind === "i32") {
      if ((want as { boolean?: true }).boolean && unboxBoolIdx !== undefined) {
        arm.push({ op: "call", funcIdx: unboxBoolIdx } as Instr);
      } else if (unboxNumIdx !== undefined) {
        arm.push({ op: "call", funcIdx: unboxNumIdx } as Instr);
        arm.push({ op: "i32.trunc_sat_f64_s" } as Instr);
      } else {
        arm.push({ op: "drop" } as Instr, { op: "i32.const", value: 0 } as Instr);
      }
    } else if (want.kind === "ref" || want.kind === "ref_null") {
      arm.push({ op: "any.convert_extern" } as Instr);
      arm.push({ op: "ref.cast", typeIdx: (want as { typeIdx: number }).typeIdx } as Instr);
    }
    // externref param: already externref — no coercion.
  }
  arm.push({ op: "call", funcIdx: entry.funcIdx } as Instr);
  // Box-coerce the result back to externref.
  if (entry.resultType.kind === "ref" || entry.resultType.kind === "ref_null") {
    arm.push({ op: "extern.convert_any" } as Instr);
  } else if (entry.resultType.kind === "f64") {
    if (boxNumIdx !== undefined) arm.push({ op: "call", funcIdx: boxNumIdx } as Instr);
    else arm.push({ op: "drop" } as Instr, { op: "ref.null.extern" } as Instr);
  } else if (entry.resultType.kind === "i32") {
    arm.push({ op: "f64.convert_i32_s" } as Instr);
    if (boxNumIdx !== undefined) arm.push({ op: "call", funcIdx: boxNumIdx } as Instr);
    else arm.push({ op: "drop" } as Instr, { op: "ref.null.extern" } as Instr);
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
  };
  const methodCallIdx = ctx.funcMap.get("__extern_method_call");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");

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
        argVec.push({ op: "call", funcIdx: objVecNewIdx } as Instr);
        argVec.push({ op: "local.set", index: vecTmp } as Instr);
        for (let a = 0; a < arity; a++) {
          argVec.push({ op: "local.get", index: vecTmp } as Instr);
          argVec.push({ op: "local.get", index: 1 + a } as Instr);
          argVec.push({ op: "call", funcIdx: objVecPushIdx } as Instr);
        }
        argVec.push({ op: "local.get", index: vecTmp } as Instr);
      } else {
        argVec.push({ op: "call", funcIdx: objVecNewIdx } as Instr);
      }
      current = [
        { op: "local.get", index: 0 } as Instr,
        ...stringConstantExternrefInstrs(ctx, methodName),
        ...argVec,
        { op: "call", funcIdx: methodCallIdx } as Instr,
      ];
    } else {
      current = [{ op: "ref.null.extern" } as Instr];
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
        { op: "local.get", index: 0 } as Instr,
        { op: "local.get", index: iLocalIdx } as Instr,
        { op: "call", funcIdx: externGetIdxIdx } as Instr,
        { op: "local.get", index: 1 } as Instr, // search target (arg0)
        { op: "call", funcIdx: eqIdx } as Instr,
      ];
      // On match: return boxed index (indexOf/lastIndexOf) or boxed-true (includes).
      const onMatch: Instr[] =
        methodName === "includes"
          ? [
              { op: "i32.const", value: 1 } as Instr,
              { op: "call", funcIdx: boxBoolIdx as number } as Instr,
              { op: "return" } as Instr,
            ]
          : [
              { op: "local.get", index: iLocalIdx } as Instr,
              { op: "call", funcIdx: boxNum } as Instr,
              { op: "return" } as Instr,
            ];
      // Not-found result (loop fell through): boxed-false / boxed -1.
      const notFound: Instr[] =
        methodName === "includes"
          ? [{ op: "i32.const", value: 0 } as Instr, { op: "call", funcIdx: boxBoolIdx as number } as Instr]
          : [{ op: "f64.const", value: -1 } as Instr, { op: "call", funcIdx: boxNum } as Instr];

      const forward = methodName !== "lastIndexOf";
      // len = __extern_length(recv)
      const setLen: Instr[] = [
        { op: "local.get", index: 0 } as Instr,
        { op: "call", funcIdx: externLengthIdx } as Instr,
        { op: "local.set", index: lenLocalIdx } as Instr,
      ];
      // Loop body. Forward: i=0; while i<len { … i+=1 }. Backward: i=len-1; while i>=0 { … i-=1 }.
      let loopInit: Instr[];
      let loopExitTest: Instr[];
      let loopStep: Instr[];
      if (forward) {
        loopInit = [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: iLocalIdx } as Instr];
        loopExitTest = [
          { op: "local.get", index: iLocalIdx } as Instr,
          { op: "local.get", index: lenLocalIdx } as Instr,
          { op: "f64.ge" } as Instr, // i >= len → exit
        ];
        loopStep = [
          { op: "local.get", index: iLocalIdx } as Instr,
          { op: "f64.const", value: 1 } as Instr,
          { op: "f64.add" } as Instr,
          { op: "local.set", index: iLocalIdx } as Instr,
        ];
      } else {
        loopInit = [
          { op: "local.get", index: lenLocalIdx } as Instr,
          { op: "f64.const", value: 1 } as Instr,
          { op: "f64.sub" } as Instr,
          { op: "local.set", index: iLocalIdx } as Instr,
        ];
        loopExitTest = [
          { op: "local.get", index: iLocalIdx } as Instr,
          { op: "f64.const", value: 0 } as Instr,
          { op: "f64.lt" } as Instr, // i < 0 → exit
        ];
        loopStep = [
          { op: "local.get", index: iLocalIdx } as Instr,
          { op: "f64.const", value: 1 } as Instr,
          { op: "f64.sub" } as Instr,
          { op: "local.set", index: iLocalIdx } as Instr,
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
                { op: "br_if", depth: 1 } as Instr, // exit to $done
                ...elemEq,
                { op: "if", blockType: { kind: "empty" }, then: onMatch } as Instr,
                ...loopStep,
                { op: "br", depth: 0 } as Instr, // continue $scan
              ],
            } as Instr,
          ],
        } as Instr,
        ...notFound,
      ];
      current = [
        { op: "local.get", index: anyLocalIdx } as Instr,
        { op: "ref.test", typeIdx: ctx.vecBaseTypeIdx } as Instr,
        { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: vecArmBody, else: current } as Instr,
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
    const vecPushIdx = ctx.funcMap.get("__vec_push");
    const vecPopIdx = ctx.funcMap.get("__vec_pop");
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
          { op: "local.get", index: 0 } as Instr, // recv (externref)
          { op: "local.get", index: 1 } as Instr, // arg0 (externref)
          { op: "call", funcIdx: vecPushIdx } as Instr,
          { op: "local.tee", index: pushLenLocalIdx } as Instr,
          { op: "i32.const", value: 0 } as Instr,
          { op: "i32.lt_s" } as Instr, // newLen < 0 → unsupported carrier
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "ref.null.extern" } as Instr], // undefined (pre-#2927 behavior)
            else: [
              { op: "local.get", index: pushLenLocalIdx } as Instr,
              { op: "f64.convert_i32_s" } as Instr,
              { op: "call", funcIdx: ci.boxNumIdx } as Instr,
            ],
          } as Instr,
        ];
      } else if (methodName === "pop" && vecPopIdx !== undefined) {
        // __vec_pop(recv) -> externref (already-boxed last element; null.extern for
        // an empty OR unsupported-carrier vec — both map to `undefined`, which is
        // exactly the pre-#2927 fall-through result, so no guard is needed).
        mutArmBody = [
          { op: "local.get", index: 0 } as Instr, // recv (externref)
          { op: "call", funcIdx: vecPopIdx } as Instr,
        ];
      }
      if (mutArmBody !== undefined) {
        current = [
          { op: "local.get", index: anyLocalIdx } as Instr,
          { op: "ref.test", typeIdx: ctx.vecBaseTypeIdx } as Instr,
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: mutArmBody,
            else: current,
          } as Instr,
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
          { op: "local.get", index: 0 } as Instr, // recv (externref)
          { op: "local.get", index: 1 } as Instr, // cb
          ...(arity >= 2 ? [{ op: "local.get", index: 2 } as Instr] : [{ op: "ref.null.extern" } as Instr]), // thisArg | init
          ...(isReduceForm ? [{ op: "i32.const", value: arity >= 2 ? 1 : 0 } as Instr] : []), // hasInit
          { op: "call", funcIdx: hofFuncIdx } as Instr,
        ];
        current = [
          { op: "local.get", index: anyLocalIdx } as Instr,
          { op: "ref.test", typeIdx: ctx.vecBaseTypeIdx } as Instr,
          { op: "local.get", index: anyLocalIdx } as Instr,
          { op: "ref.test", typeIdx: objVecTypeIdx } as Instr,
          { op: "i32.or" } as Instr,
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: hofCall,
            else: current,
          } as Instr,
        ];
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
          argVec.push({ op: "call", funcIdx: objVecNewIdx as number } as Instr);
          argVec.push({ op: "local.set", index: vecTmp } as Instr);
          for (let a = 0; a < arity; a++) {
            argVec.push({ op: "local.get", index: vecTmp } as Instr);
            argVec.push({ op: "local.get", index: 1 + a } as Instr);
            argVec.push({ op: "call", funcIdx: objVecPushIdx as number } as Instr);
          }
          argVec.push({ op: "local.get", index: vecTmp } as Instr);
        } else {
          argVec.push({ op: "call", funcIdx: objVecNewIdx as number } as Instr);
        }
        const armBody: Instr[] = [
          { op: "local.get", index: anyLocalIdx } as Instr,
          { op: "ref.cast", typeIdx: fe.typeIdx } as Instr,
          { op: "struct.get", typeIdx: fe.typeIdx, fieldIdx: fe.fieldIdx } as Instr,
          { op: "local.tee", index: fnLocalIdx } as Instr,
          { op: "ref.is_null" } as Instr,
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "ref.null.extern" } as Instr],
            else: [
              { op: "local.get", index: fnLocalIdx } as Instr,
              { op: "local.get", index: 0 } as Instr,
              ...argVec,
              { op: "call", funcIdx: applyClosureIdx } as Instr,
            ],
          } as Instr,
        ];
        current = [
          { op: "local.get", index: anyLocalIdx } as Instr,
          { op: "ref.test", typeIdx: fe.typeIdx } as Instr,
          { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: armBody, else: current },
        ];
      }
    }

    for (const entry of entries) {
      const callAndCoerce = buildEntryArm(ci, anyLocalIdx, entry, (a) => [{ op: "local.get", index: 1 + a } as Instr]);
      current = [
        { op: "local.get", index: anyLocalIdx } as Instr,
        { op: "ref.test", typeIdx: entry.typeIdx } as Instr,
        { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: callAndCoerce, else: current },
      ];
    }

    dispFn.locals = locals;
    dispFn.body = [
      { op: "local.get", index: 0 } as Instr,
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: anyLocalIdx } as Instr,
      ...current,
    ];
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
            { op: "local.get", index: 0 } as Instr,
            ...stringConstantExternrefInstrs(ctx, methodName),
            { op: "local.get", index: argsLocalIdx } as Instr,
            { op: "call", funcIdx: methodCallIdx } as Instr,
          ]
        : [{ op: "ref.null.extern" } as Instr];

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
          { op: "local.get", index: anyLocalIdx } as Instr,
          { op: "ref.cast", typeIdx: fe.typeIdx } as Instr,
          { op: "struct.get", typeIdx: fe.typeIdx, fieldIdx: fe.fieldIdx } as Instr,
          { op: "local.tee", index: fnLocalIdx } as Instr,
          { op: "ref.is_null" } as Instr,
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "ref.null.extern" } as Instr],
            else: [
              { op: "local.get", index: fnLocalIdx } as Instr,
              { op: "local.get", index: 0 } as Instr,
              { op: "local.get", index: argsLocalIdx } as Instr,
              { op: "call", funcIdx: applyClosureIdx } as Instr,
            ],
          } as Instr,
        ];
        current = [
          { op: "local.get", index: anyLocalIdx } as Instr,
          { op: "ref.test", typeIdx: fe.typeIdx } as Instr,
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
              { op: "local.get", index: argsLocalIdx } as Instr,
              { op: "f64.const", value: a } as Instr,
              { op: "call", funcIdx: externGetIdxIdx } as Instr,
            ])
          : current;
      current = [
        { op: "local.get", index: anyLocalIdx } as Instr,
        { op: "ref.test", typeIdx: entry.typeIdx } as Instr,
        { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: callAndCoerce, else: current },
      ];
    }

    dispFn.locals = varargLocals;
    dispFn.body = [
      { op: "local.get", index: 0 } as Instr,
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: anyLocalIdx } as Instr,
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
      { op: "local.get", index: 0 } as Instr,
      { op: "ref.is_null" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 } as Instr, { op: "return" } as Instr],
      } as Instr,
      { op: "local.get", index: 0 } as Instr,
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: peelAnyLocal } as Instr,
      { op: "local.get", index: peelAnyLocal } as Instr,
      { op: "ref.test", typeIdx: anyValueTypeIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // tag 6 (object) → extern.convert_any(refval)
          { op: "local.get", index: peelAnyLocal } as Instr,
          { op: "ref.cast", typeIdx: anyValueTypeIdx } as Instr,
          { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: AV_TAG } as Instr,
          { op: "i32.const", value: 6 } as Instr,
          { op: "i32.eq" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: peelAnyLocal } as Instr,
              { op: "ref.cast", typeIdx: anyValueTypeIdx } as Instr,
              { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: AV_REF } as Instr,
              { op: "extern.convert_any" } as Instr,
              { op: "return" } as Instr,
            ],
          } as Instr,
          // tag 5 (string/extern payload) → externval
          { op: "local.get", index: peelAnyLocal } as Instr,
          { op: "ref.cast", typeIdx: anyValueTypeIdx } as Instr,
          { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: AV_TAG } as Instr,
          { op: "i32.const", value: 5 } as Instr,
          { op: "i32.eq" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: peelAnyLocal } as Instr,
              { op: "ref.cast", typeIdx: anyValueTypeIdx } as Instr,
              { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: AV_EXT } as Instr,
              { op: "return" } as Instr,
            ],
          } as Instr,
        ],
      } as Instr,
      { op: "local.get", index: 0 } as Instr,
    ];
  }

  // ── `__promise_has_callable_then(value) -> i32` ────────────────────────
  const peeledLocalIdx = 1; // param 0 = value externref
  const anyLocalIdx = 2;
  const thenAnyLocalIdx = 3;
  const body: Instr[] = [
    // peeled = __promise_peel_value(value) — classify the RAW payload.
    { op: "local.get", index: 0 } as Instr,
    ...(peelIdx !== undefined ? [{ op: "call", funcIdx: peelIdx } as Instr] : []),
    { op: "local.set", index: peeledLocalIdx } as Instr,
    // null externref (JS null / absent) → not a thenable.
    { op: "local.get", index: peeledLocalIdx } as Instr,
    { op: "ref.is_null" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 } as Instr, { op: "return" } as Instr],
    } as Instr,
    { op: "local.get", index: peeledLocalIdx } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "local.set", index: anyLocalIdx } as Instr,
  ];

  // Shared tail: test the externref left on the stack against the closure
  // base wrappers; 1 on a hit, else 0.
  const closureTest = (loadThen: Instr[]): Instr[] => [
    ...loadThen,
    { op: "any.convert_extern" } as Instr,
    { op: "local.set", index: thenAnyLocalIdx } as Instr,
    ...buildClosureRefTestArms(ctx, thenAnyLocalIdx, [
      { op: "i32.const", value: 1 } as Instr,
      { op: "return" } as Instr,
    ]),
    { op: "i32.const", value: 0 } as Instr,
    { op: "return" } as Instr,
  ];

  // Closed-struct METHOD arms — a compiled `then` method is always callable.
  const seenMethodType = new Set<number>();
  for (const entry of collectMethodEntries(ctx, "then", null)) {
    if (seenMethodType.has(entry.typeIdx)) continue;
    seenMethodType.add(entry.typeIdx);
    body.push({ op: "local.get", index: anyLocalIdx } as Instr);
    body.push({ op: "ref.test", typeIdx: entry.typeIdx } as Instr);
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 } as Instr, { op: "return" } as Instr],
    } as Instr);
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
      body.push({ op: "local.get", index: anyLocalIdx } as Instr);
      body.push({ op: "ref.test", typeIdx: structTypeIdx } as Instr);
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: entry.getGlobal } as Instr,
          { op: "ref.is_null" } as Instr,
          { op: "i32.eqz" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: closureTest([
              // then = getter.call(value) — §7.3.2 GetV via the S5b driver.
              { op: "local.get", index: peeledLocalIdx } as Instr,
              { op: "global.get", index: entry.getGlobal } as Instr,
              { op: "call", funcIdx: callAccessorGetIdx } as Instr,
            ]),
          } as Instr,
        ],
      } as Instr);
    }
  }

  // Closed-struct FIELD arms — `{ then: <value> }`: callable iff the stored
  // value is a closure.
  for (const fe of collectFieldEntries(ctx, "then")) {
    body.push({ op: "local.get", index: anyLocalIdx } as Instr);
    body.push({ op: "ref.test", typeIdx: fe.typeIdx } as Instr);
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: closureTest([
        { op: "local.get", index: anyLocalIdx } as Instr,
        { op: "ref.cast", typeIdx: fe.typeIdx } as Instr,
        { op: "struct.get", typeIdx: fe.typeIdx, fieldIdx: fe.fieldIdx } as Instr,
      ]),
    } as Instr);
  }

  // Open `$Object` arm — spec Get (runs accessors; a poisoned getter throws
  // OUT of this predicate) + closure test.
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  if (externGetIdx !== undefined && objectTypeIdx !== undefined) {
    body.push({ op: "local.get", index: anyLocalIdx } as Instr);
    body.push({ op: "ref.test", typeIdx: objectTypeIdx } as Instr);
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: closureTest([
        { op: "local.get", index: peeledLocalIdx } as Instr,
        ...(stringConstantExternrefInstrs(ctx, "then") as Instr[]),
        { op: "call", funcIdx: externGetIdx } as Instr,
      ]),
    } as Instr);
  }

  body.push({ op: "i32.const", value: 0 } as Instr);
  predFn.locals = [
    { name: "__peeled", type: { kind: "externref" } },
    { name: "__any", type: { kind: "anyref" } },
    { name: "__thenAny", type: { kind: "anyref" } },
  ];
  predFn.body = body;
}
