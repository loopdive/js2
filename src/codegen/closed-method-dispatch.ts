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
import type { CodegenContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";

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

  // Signature: (recv, arg0..arg{arity-1}) all externref → externref.
  const params: ValType[] = Array.from({ length: arity + 1 }, () => ({ kind: "externref" }) as ValType);
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `$closed_method_dispatch_type_${arity}`);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
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

  // Signature: (recv: externref, args: externref) -> externref.
  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$closed_method_dispatch_vararg_type",
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
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
    const funcDef = mod.functions[funcIdx - ctx.numImportFuncs];
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
    const dispFn = mod.functions[dispIdx - ctx.numImportFuncs];
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

    for (const entry of entries) {
      const callAndCoerce = buildEntryArm(ci, anyLocalIdx, entry, (a) => [{ op: "local.get", index: 1 + a } as Instr]);
      current = [
        { op: "local.get", index: anyLocalIdx } as Instr,
        { op: "ref.test", typeIdx: entry.typeIdx } as Instr,
        { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: callAndCoerce, else: current },
      ];
    }

    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    if (arity > 0 && objVecNewIdx !== undefined && objVecPushIdx !== undefined) {
      locals.push({ name: "__argvec", type: { kind: "externref" } });
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
    const dispFn = mod.functions[dispIdx - ctx.numImportFuncs];
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

    dispFn.locals = [{ name: "__any", type: { kind: "anyref" } }];
    dispFn.body = [
      { op: "local.get", index: 0 } as Instr,
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: anyLocalIdx } as Instr,
      ...current,
    ];
    void (dispFn as WasmFunction);
  }
}
