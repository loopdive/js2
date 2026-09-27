// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6464, #5383 S13) `Object.create(<value>.prototype)` under `--target
// standalone` must produce a real compiled instance, exactly as the JS-host
// lane's #5239 mechanism does.
//
// ## The gap
//
// `object-create-class-instance.ts` opens with
// `if (ctx.wasi || ctx.standalone || noJsHost(ctx)) return;` — #5239 was built
// as an EXPORT the JS runtime's `__object_create` calls back into, so it has no
// meaning without a JS host and was gated off. Nothing replaced it, so the
// standalone lane still falls through to the native `__object_create`, which
// returns a plain `$Object` with a `$proto` link to the class's prototype
// object.
//
// A later member read then finds the accessor on that prototype but cannot
// bind the receiver: a compiled class member takes `this` as a concrete
// `(ref $C)`, which a plain `$Object` can never satisfy, so the bridge falls
// back to binding the PROTOTYPE. Measured 2026-09-13 in ONE standalone module,
// no provider, no link (`.tmp/s13/c7.out`):
//
// | carrier                                   | `o.self() === o` | `o.day` |
// | ----------------------------------------- | ---------------- | ------- |
// | `Object.create(K.prototype)`, `K` a VALUE  | **false**        | **−1**  |
// | `Object.create(C.prototype)`, `C` a class  | true             | 18      |
// | `new C()`                                  | true             | 18      |
//
// Any polyfill that keeps per-instance state in a WeakMap keyed by the object
// it created therefore misses every slot. The @js-temporal/polyfill bundle
// emits that spelling seven times — once per `X.from(…)` result builder:
//
//     function pn(e,t){ const n = ce("%Temporal.PlainDate%");
//                       const r = Object.create(n.prototype); return yn(r,e,t), r; }
//
// which is why `Temporal.PlainDate.from("1976-11-18").day` answered `null`
// while `new Temporal.PlainDate(1976,11,18).day` answered `18`, and why
// `typeof …from(…).calendarId` answered `"object"` — the 20-row
// `calendar must be string in canonicalizeCalendarEra` bucket is literally
// `assert.sameValue(typeof calendarId, "string", …)`.
//
// ## Why identity, and why `eq` rather than `ref.test $C`
//
// The match is by REFERENCE IDENTITY against the class's prototype global:
// `Object.create(someInstance)` must keep meaning "a plain object inheriting
// from that instance", and under WasmGC a class object, its instances and its
// prototype are not separable by `ref.test` (struct types are canonicalised
// structurally — #5195 F1).
//
// #5239 tests `ref.test $C` on the incoming prototype first. That is sound on
// the host lane, where a class's prototype IS a `$C` struct. It is NOT sound
// here: #3976's `emitStandaloneClassProtoObject` builds the standalone
// prototype as a real `$Object`, so the shape test would reject every arm. The
// `eq`-typed compare needs no shape agreement at all.
//
// ## A lazy prototype global reads as "no match", and that is the right answer
//
// `__proto_<C>` is null until something materialises it. Nothing can be holding
// that prototype as a value before then, so a null global cannot produce a
// false negative. The #6457 dynamic-`prototype` arm force-builds through
// `__class_proto_build_<C>` before it answers, so by the time
// `Object.create(K.prototype)` runs the global holds the very singleton the
// argument is.
//
// ## Reserve-then-fill
//
// The call site needs a function index while bodies are still being compiled;
// the body needs `ctx.protoGlobals`, which is complete only at finalize. So the
// handle is MINTED at the first call site (`mintDefinedFunc` — a stable handle
// no late-import shifter touches) and the body is PUSHED at finalize. A
// minted-but-never-pushed handle throws at resolution, so the fill pushes
// unconditionally once reserved; with no admissible class it pushes the refusal
// body `ref.null.extern`, which makes every call site behave exactly as it did
// before this module existed.

import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

export const STANDALONE_OBJECT_CREATE_CLASS_INSTANCE = "__standalone_object_create_class_instance";

/** WasmGC `eq` abstract heap type, as the encoder spells it in `ref.test`/`ref.cast`. */
const EQ_HEAP_TYPE = -19;

const EXTERNREF: ValType = { kind: "externref" };

/** Default value for one struct field, mirroring #5239's prologue. */
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

/** True when this module may need the dispatcher at all. */
export function standaloneObjectCreateClassInstanceApplies(ctx: CodegenContext): boolean {
  return ctx.standalone === true && ctx.classSet.size > 0;
}

/**
 * Resolve-or-reserve the dispatcher's handle. Returns `undefined` for a module
 * the mechanism does not apply to, so the caller keeps its previous emission.
 */
export function reserveStandaloneObjectCreateClassInstance(ctx: CodegenContext): number | undefined {
  if (!standaloneObjectCreateClassInstanceApplies(ctx)) return undefined;
  const existing = ctx.funcMap.get(STANDALONE_OBJECT_CREATE_CLASS_INSTANCE);
  if (existing !== undefined) return existing;
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(STANDALONE_OBJECT_CREATE_CLASS_INSTANCE, funcIdx);
  return funcIdx;
}

/**
 * Emit the `Object.create` result, given the proto already on the stack.
 *
 * ```wat
 * ;; stack: proto : externref
 * local.tee $p
 * call $__standalone_object_create_class_instance
 * local.tee $r
 * ref.is_null
 * if (result externref) local.get $p  call $__object_create
 * else                  local.get $r
 * end
 * ```
 *
 * The dispatcher answers null for every shape it does not own — `null`, plain
 * objects, host prototypes, instances — so the fall-back arm is the previous
 * emission verbatim, and the ordinary `Object.create(instance)` semantics are
 * untouched.
 */
export function emitStandaloneObjectCreateClassInstance(
  fctx: FunctionContext,
  dispatchIdx: number,
  objectCreateIdx: number,
): void {
  const protoLocal = allocLocal(fctx, `__ocreate_proto_${fctx.locals.length}`, EXTERNREF);
  const madeLocal = allocLocal(fctx, `__ocreate_made_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push(
    { op: "local.tee", index: protoLocal },
    { op: "call", funcIdx: dispatchIdx },
    { op: "local.tee", index: madeLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [
        { op: "local.get", index: protoLocal },
        { op: "call", funcIdx: objectCreateIdx },
      ],
      else: [{ op: "local.get", index: madeLocal }],
    },
  );
}

/** One class the dispatcher can answer for. */
function collectArms(ctx: CodegenContext): Array<{ typeIdx: number; globalIdx: number; fields: Instr[] }> {
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
  return arms;
}

/**
 * Push the reserved dispatcher's body. Runs at finalize, after
 * `ctx.protoGlobals` is complete. No-op unless a call site reserved the handle.
 */
export function fillStandaloneObjectCreateClassInstance(ctx: CodegenContext): void {
  const funcIdx = ctx.funcMap.get(STANDALONE_OBJECT_CREATE_CLASS_INSTANCE);
  if (funcIdx === undefined) return;
  const typeIdx = addFuncType(ctx, [EXTERNREF], [EXTERNREF], "$__standalone_object_create_class_instance_type");

  // local 0 = proto (externref param), local 1 = the same value as anyref.
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  const arms = collectArms(ctx);
  if (arms.length > 0) {
    const inner: Instr[] = [];
    for (const arm of arms) {
      inner.push(
        // The prototype singleton is LAZY: null until first materialisation,
        // and a null is not eq-castable — so test castability per global rather
        // than casting blind.
        { op: "global.get", index: arm.globalIdx },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
            { op: "global.get", index: arm.globalIdx },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
            { op: "ref.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...arm.fields,
                { op: "struct.new", typeIdx: arm.typeIdx },
                { op: "extern.convert_any" },
                { op: "return" },
              ],
            },
          ],
        },
      );
    }
    // One outer guard so the per-arm `ref.cast eq` on the ARGUMENT can never
    // see a non-eq carrier (a primitive box, a host value, a null).
    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
      { op: "if", blockType: { kind: "empty" }, then: inner },
    );
  }
  body.push({ op: "ref.null.extern" });

  pushDefinedFunc(ctx, funcIdx, {
    name: STANDALONE_OBJECT_CREATE_CLASS_INSTANCE,
    typeIdx,
    locals: [{ name: "__proto_any", type: { kind: "anyref" } }],
    body,
    exported: false,
  } as WasmFunction);
}
