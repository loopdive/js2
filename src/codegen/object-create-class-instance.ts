// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// object-create-class-instance.ts — (#5239) `Object.create(<compiled class>.prototype)`
// when the class arrives as a VALUE, not as a syntactic identifier.
//
// ## The gap this closes
//
// `tryCompileObjectCreateStaticPrototype` (expressions/call-object-builtins.ts)
// already lowers `Object.create(Foo.prototype)` to `struct.new $Foo` with
// defaulted fields, so the created object IS a compiled instance and every
// later member read dispatches through the ordinary struct surface. That fast
// path is keyed on the SYNTAX `<identifier>.prototype`, so it sees only the
// spelling a hand-written program uses.
//
// A bundler-minified library reaches the same class through a variable:
//
//     const n = ce("%Temporal.PlainDate%");        // intrinsics registry
//     const r = Object.create(n.prototype);        // ← misses the fast path
//
// That call falls through to the `__object_create` host import, which returns a
// plain JS object whose `[[Prototype]]` is the opaque WasmGC prototype struct.
// Native lookup on such an object finds nothing (a WasmGC struct exposes no
// JS properties and terminates the chain), and the runtime's host-object tail
// cannot recover: `_resolveClassMember` needs a receiver its `ref.test` cascade
// accepts, and a host object never passes one. Measured on the
// @js-temporal/polyfill bundle compiled as ONE module with no linker at all:
//
//     Temporal.PlainDate.from("2020-03-04").toString()  →  "[object Object]"
//     Temporal.PlainDate.from("2020-03-04").year        →  undefined
//
// and reproduced in twelve lines of plain user code (tests/issue-5239-*.test.ts).
//
// ## Why the fix is here and not in the runtime's property-read tail
//
// The obvious-looking runtime fix — on an own-property miss, walk
// `Object.getPrototypeOf` and dispatch a hit on a compiled prototype with the
// original host object as receiver — CANNOT work for this shape. A compiled
// class's methods take their receiver as a concrete `(ref $Class)`, and the
// generated `__member_kind_*` / `__class_call_*` bridges select an arm with
// `ref.test`. A host object fails every arm, and there is no representation in
// which it could pass one. Binding the bridge to the PROTOTYPE instead (what
// `selectBridgeReceiver` falls back to) runs the method against the prototype
// struct, which is exactly the failure #5237 measured as `"Pnull:null"` — and
// for a polyfill that keeps its state in a WeakMap keyed by the created object
// it throws "Missing slots" instead. The state lives on the object the program
// created, so the object the program created must BE the compiled instance.
//
// ## Shape
//
// One export, `__object_create_class_instance(proto) -> externref`:
//
//   * `null` when `proto` is not one of this module's class prototypes — the
//     runtime then performs the ordinary `Object.create(proto)`, so every other
//     shape (`Object.create(null)`, plain objects, host prototypes) is
//     untouched;
//   * otherwise a freshly defaulted struct of that class, with its `__tag`
//     field set exactly as a `new`-built instance has it, converted to
//     externref.
//
// The match is by REFERENCE IDENTITY against the class's lazily-initialised
// prototype global, never by `ref.test` alone: an INSTANCE of the class passes
// the same `ref.test` as its prototype, and `Object.create(someInstance)` must
// keep meaning "a plain object inheriting from that instance".
//
// Gated on the module both importing `__object_create` and having at least one
// materialised class prototype global, so a module that never calls
// `Object.create` emits identical bytes.

import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { noJsHost } from "./js-errors.js";
import { exportFunc } from "./emit-helpers.js";
import { addFuncType } from "./registry/types.js";

export const OBJECT_CREATE_CLASS_INSTANCE_EXPORT = "__object_create_class_instance";

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

export function emitObjectCreateClassInstanceExport(ctx: CodegenContext): void {
  if (ctx.wasi || ctx.standalone || noJsHost(ctx)) return;
  if (ctx.funcMap.has(OBJECT_CREATE_CLASS_INSTANCE_EXPORT)) return; // idempotent
  // Only modules that actually call `Object.create` through the host import can
  // reach this dispatcher; everything else keeps byte-identical output.
  if (!ctx.funcMap.has("__object_create")) return;

  const mod = ctx.mod;
  const arms: Array<{ typeIdx: number; globalIdx: number; fields: Instr[] }> = [];
  for (const [className, globalIdx] of ctx.protoGlobals) {
    const typeIdx = ctx.structMap.get(className);
    const fields = ctx.structFields.get(className);
    if (typeIdx === undefined || fields === undefined || fields.length === 0) continue;
    const fieldInstrs: Instr[] = [];
    for (const field of fields) {
      if (field.name === "__tag") fieldInstrs.push({ op: "i32.const", value: ctx.classTagMap.get(className) ?? 0 });
      else fieldInstrs.push(defaultFieldInstr(field.type));
    }
    arms.push({ typeIdx, globalIdx, fields: fieldInstrs });
  }
  if (arms.length === 0) return;

  const externRef: ValType = { kind: "externref" };
  const typeIdx = addFuncType(ctx, [externRef], [externRef], "$__object_create_class_instance_type");
  const funcIdx = ctx.numImportFuncs + mod.functions.length;

  // local 0 = proto (externref param), local 1 = the same value as anyref.
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  for (const arm of arms) {
    // Reference identity, guarded so neither `ref.cast` can see a null or a
    // foreign carrier: the argument must ref.test as this class, the
    // prototype global must be initialised and ref.test as this class, and the
    // two must be the same object.
    const identity: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: arm.typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "global.get", index: arm.globalIdx },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: arm.typeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: 1 },
              { op: "ref.cast", typeIdx: arm.typeIdx },
              { op: "global.get", index: arm.globalIdx },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: arm.typeIdx },
              { op: "ref.eq" },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
    ];
    body.push(...identity, {
      op: "if",
      blockType: { kind: "empty" },
      then: [...arm.fields, { op: "struct.new", typeIdx: arm.typeIdx }, { op: "extern.convert_any" }, { op: "return" }],
      else: [],
    });
  }
  body.push({ op: "ref.null.extern" });

  mod.functions.push({
    name: OBJECT_CREATE_CLASS_INSTANCE_EXPORT,
    typeIdx,
    locals: [{ name: "__proto_any", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as WasmFunction);
  exportFunc(mod, OBJECT_CREATE_CLASS_INSTANCE_EXPORT, funcIdx);
  ctx.funcMap.set(OBJECT_CREATE_CLASS_INSTANCE_EXPORT, funcIdx);
}
