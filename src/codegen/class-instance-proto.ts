// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5347) `__class_instance_proto` — the reverse map from a compiled class
// INSTANCE back to the class's prototype carrier, for the JS host.
//
// #5325 taught the host `__getPrototypeOf` import to answer the real built-in
// prototype for a Date / Array / closure carrier, and explicitly declined the
// class instance:
//
//   "It is a named data struct — and so is the class's own prototype singleton,
//    which `emitLazyProtoGet` materializes as a struct of the same type.
//    Nothing the module exports tells them apart, so answering here would need
//    a new codegen-side discriminator plus a way to reach (and lazily
//    materialize) the class's prototype global from the host."
//
// That is exactly what this export is. It answers the question the host cannot:
// given an opaque `externref`, is it an instance of a compiled class, and if so
// which class's prototype singleton does it report — materializing that
// singleton on demand, because a program that never writes `C.prototype`
// syntactically (redux's `new Action()` is one) leaves the global null.
//
// ## Why a compiled dispatcher and not an exported side table
//
// The issue offered two designs: (a) a struct-type-index → prototype-carrier
// table the host consults, (b) a compiled dispatcher that `ref.test`s per class.
// (a) is not actually cheaper — it is (b) plus an indirection. WasmGC structs
// are opaque to JavaScript and there is no "give me this value's type index"
// operation, so the host would first have to call a compiled `ref.test` cascade
// to learn the index, then index a table to get a carrier it still cannot
// materialize. (b) collapses both steps into the one function that already has
// to exist. It is also the shape every neighbouring discriminator already
// takes: `__is_data_struct` (closure-exports.ts) and
// `__object_create_class_instance` (object-create-class-instance.ts) are both
// `ref.test` cascades over the same class-struct set, and the latter is a
// direct structural model for this file.
//
// ## The three `$ClassName`-typed values, and why two must decline
//
// `ref.test $C` matches THREE distinct runtime objects, not one:
//
//   1. a genuine instance (`new C()`)                → answer `C.prototype`
//   2. the prototype singleton (`__proto_<C>`)       → decline
//   3. the class-object singleton (`__class_<C>`)    → decline
//
// (2) and (3) reuse the `$ClassName` struct type by design (see
// `emitLazyProtoGet` / `emitLazyClassObjectGet`), so they are separated by
// REFERENCE IDENTITY against their globals — the same discrimination
// `object-create-class-instance.ts` performs, for the same reason.
//
// Declining (2) is not a nicety: answering `C.prototype` for `C.prototype`
// would make `getPrototypeOf(p) === p`, and redux's `isPlainObject` walks
// `while (getPrototypeOf(proto) !== null) proto = getPrototypeOf(proto)` — an
// infinite loop, in a package that is already in the corpus. Declining returns
// `null`, which the host reads as "no answer" and falls through to its existing
// `__is_data_struct` default (`%Object.prototype%`), i.e. today's behaviour for
// both singletons, unchanged.
//
// ## Subtyping and arm order
//
// A derived class's struct declares its parent as `superTypeIdx`, so
// `ref.test $Base` succeeds for a `$Derived` instance. Arms are therefore
// emitted MOST-DERIVED FIRST (by inheritance depth), the same ordering
// `dynamic-proto.ts::fillDynamicProtoHelpers` uses for `__struct_proto_read`.
//
// ## Materialization, and why `__register_prototype` is called here too
//
// The prototype global is lazily initialised by whichever `C.prototype` read
// runs first. If the host asks before any such read — the redux `isAction`
// shape, where `class Action { type = '…' }` is only ever constructed — the
// global is still null, so this dispatcher builds the singleton with the same
// defaulted-fields prologue `emitLazyProtoGet` uses, and then makes the same
// `__register_prototype(proto, csv)` call. Skipping that call would leave the
// host's method-name allowlist unset for a singleton this path minted, so a
// later `Object.getOwnPropertyNames(C.prototype)` would enumerate the class's
// INSTANCE FIELD names instead of its methods — a silent wrong answer that
// depends on which of the two paths happened to run first. The CSV globals are
// interned in a first pass, before a single global index is baked, because
// interning a string constant inserts an IMPORTED global and shifts the index
// space (the #4618 hazard).

import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { noJsHost } from "./js-errors.js";
import { exportFunc } from "./emit-helpers.js";
import { addFuncType } from "./registry/types.js";
import { addHostStringConstantGlobal } from "./registry/imports.js";

export const CLASS_INSTANCE_PROTO_EXPORT = "__class_instance_proto";

/** Guard against a malformed `classParentMap` cycle while measuring depth. */
const MAX_CLASS_DEPTH = 64;

/** Default value for one struct field, mirroring `emitLazyProtoGet`'s prologue. */
function defaultFieldInstr(type: ValType): Instr {
  switch (type.kind) {
    case "f64":
      return { op: "f64.const", value: 0 };
    case "i64":
      return { op: "i64.const", value: 0n };
    case "externref":
      return { op: "ref.null.extern" };
    case "ref_null":
    case "ref":
      return { op: "ref.null", typeIdx: type.typeIdx };
    default:
      return { op: "i32.const", value: 0 };
  }
}

/** Inheritance depth of `className`, used to order arms most-derived first. */
function classDepth(ctx: CodegenContext, className: string): number {
  let depth = 0;
  let current = className;
  while (depth < MAX_CLASS_DEPTH) {
    const parent = ctx.classParentMap.get(current);
    if (parent === undefined) break;
    current = parent;
    depth++;
  }
  return depth;
}

/**
 * `[cond] -> if (cond) { then… }`, where `cond` is "local 1 is the value of
 * `globalIdx`, and that global is an initialised `$typeIdx` struct".
 *
 * Every `ref.cast` is reached only under a `ref.test` that proved it, so the
 * sequence is trap-free for a null global and for a foreign carrier alike.
 */
function identityGuard(typeIdx: number, globalIdx: number, then: Instr[]): Instr[] {
  return [
    { op: "global.get", index: globalIdx },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx },
        { op: "global.get", index: globalIdx },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx },
        { op: "ref.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
    { op: "if", blockType: { kind: "empty" }, then, else: [] },
  ];
}

/**
 * Emit `__class_instance_proto(externref) -> externref`: the class prototype
 * carrier for a compiled class INSTANCE, or `ref.null.extern` when the value is
 * anything else (including a class's own prototype / class-object singleton).
 *
 * Gated on the module both importing the host `__getPrototypeOf` and having at
 * least one class prototype global, so a module that never asks the host for a
 * prototype emits identical bytes. Host-mode only — standalone answers
 * prototypes through its own native `__getPrototypeOf` and its #802 arms.
 */
export function emitClassInstanceProtoExport(ctx: CodegenContext): void {
  if (ctx.wasi || ctx.standalone || noJsHost(ctx)) return;
  if (ctx.funcMap.has(CLASS_INSTANCE_PROTO_EXPORT)) return; // idempotent
  // Only a module that reaches the host `__getPrototypeOf` import can ask this
  // question; everything else keeps byte-identical output.
  if (!ctx.funcMap.has("__getPrototypeOf")) return;
  if (ctx.protoGlobals.size === 0) return;

  const eligible: string[] = [];
  for (const [className] of ctx.protoGlobals) {
    const typeIdx = ctx.structMap.get(className);
    const fields = ctx.structFields.get(className);
    if (typeIdx === undefined || fields === undefined || fields.length === 0) continue;
    eligible.push(className);
  }
  if (eligible.length === 0) return;

  // (#4618 hazard) Intern EVERY string constant the arms may need BEFORE a
  // single global index is read: `addHostStringConstantGlobal` inserts an
  // IMPORTED global and shifts the whole global index space.
  const registerProtoFuncIdx = ctx.funcMap.get("__register_prototype");
  if (registerProtoFuncIdx !== undefined) {
    for (const className of eligible) {
      if (ctx.classMethodsCsvGlobal.get(className) !== undefined) continue;
      const csv = (ctx.classMethodNames.get(className) ?? []).join(",");
      const csvGlobalIdx = addHostStringConstantGlobal(ctx, csv);
      if (csvGlobalIdx !== undefined) ctx.classMethodsCsvGlobal.set(className, csvGlobalIdx);
    }
  }

  // Most-derived first: `ref.test $Base` also matches a `$Derived` instance.
  eligible.sort((a, b) => classDepth(ctx, b) - classDepth(ctx, a));

  const externRef: ValType = { kind: "externref" };
  const typeIdx = addFuncType(ctx, [externRef], [externRef], "$__class_instance_proto_type");
  const mod = ctx.mod;
  const funcIdx = ctx.numImportFuncs + mod.functions.length;

  // local 0 = the queried value (externref param), local 1 = it as anyref.
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];

  for (const className of eligible) {
    const structTypeIdx = ctx.structMap.get(className)!;
    const fields = ctx.structFields.get(className)!;
    const protoGlobalIdx = ctx.protoGlobals.get(className)!;
    const classObjectGlobalIdx = ctx.classObjectGlobals.get(className);
    const csvGlobalIdx = ctx.classMethodsCsvGlobal.get(className);

    const decline: Instr[] = [{ op: "ref.null.extern" }, { op: "return" }];
    const arm: Instr[] = [
      // (2) the class's own prototype singleton — decline, or the host would
      // answer `getPrototypeOf(p) === p` and hang every chain walk.
      ...identityGuard(structTypeIdx, protoGlobalIdx, decline),
    ];
    // (3) the class-object singleton, which reuses the same struct type.
    if (classObjectGlobalIdx !== undefined) {
      arm.push(...identityGuard(structTypeIdx, classObjectGlobalIdx, decline));
    }
    // (1) a genuine instance: materialize the singleton if nothing has yet.
    const initBody: Instr[] = [];
    for (const field of fields) {
      if (field.name === "__tag") initBody.push({ op: "i32.const", value: ctx.classTagMap.get(className) ?? 0 });
      else initBody.push(defaultFieldInstr(field.type));
    }
    initBody.push({ op: "struct.new", typeIdx: structTypeIdx });
    initBody.push({ op: "extern.convert_any" });
    initBody.push({ op: "global.set", index: protoGlobalIdx });
    if (registerProtoFuncIdx !== undefined && csvGlobalIdx !== undefined) {
      initBody.push({ op: "global.get", index: protoGlobalIdx });
      initBody.push({ op: "global.get", index: csvGlobalIdx });
      initBody.push({ op: "call", funcIdx: registerProtoFuncIdx });
    }
    arm.push(
      { op: "global.get", index: protoGlobalIdx },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: initBody, else: [] },
      { op: "global.get", index: protoGlobalIdx },
      { op: "return" },
    );

    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: structTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: arm, else: [] },
    );
  }
  body.push({ op: "ref.null.extern" });

  mod.functions.push({
    name: CLASS_INSTANCE_PROTO_EXPORT,
    typeIdx,
    locals: [{ name: "__value_any", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as WasmFunction);
  exportFunc(mod, CLASS_INSTANCE_PROTO_EXPORT, funcIdx);
  ctx.funcMap.set(CLASS_INSTANCE_PROTO_EXPORT, funcIdx);
}
