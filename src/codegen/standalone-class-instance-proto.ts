// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#6617, #5383 S30) `Object.getPrototypeOf(<compiled class instance>)` through
 * a DYNAMIC value, under `--target standalone`.
 *
 * ## The gap (measured 2026-09-15, `.tmp/s30/cases-a.mjs`, ONE module, no link)
 *
 * ```js
 * class C { constructor(y) { this.y = y; } }
 * const NS = { C };
 * Object.getPrototypeOf(new C(1)) === C.prototype;         // true  — static arm
 * Object.getPrototypeOf(NS.C ? new C(1) : null);           // null  ← the gap
 * ```
 *
 * The statically-typed site folds (`expressions/object-get-prototype-of.ts`
 * resolves the declared type and answers the class's singleton). A site whose
 * argument the checker cannot narrow to one class — a union, an `any` binding,
 * a parameter, EVERY member of a linked provider's namespace — falls to the
 * generic native `__getPrototypeOf`, whose walk reads `$Object.$proto`. A
 * compiled class instance is a closed `$ClassName` struct with no `$proto`
 * field at all, so every arm missed and the helper answered `null`.
 *
 * That null is what test262's 45 `built-ins/Temporal/**\/subclassing-ignored.js`
 * files stop on, through the link:
 *
 * ```js
 * assert.sameValue(Object.getPrototypeOf(result), construct.prototype);
 * ```
 *
 * ## The shape, and why it is the standalone TWIN of `class-instance-proto.ts`
 *
 * `class-instance-proto.ts` (#5347) answers exactly this question for the JS
 * host, and explicitly declines the standalone lane ("standalone answers
 * prototypes through its own native `__getPrototypeOf` and its #802 arms") —
 * which was true only for the classes #802 marks as dynamically re-prototyped.
 * This file is that same dispatcher for the native lane, with three differences
 * that follow from the lane, not from taste:
 *
 *  1. **The prototype singleton is an `$Object`, not a `$ClassName` struct**
 *     (#3976 `emitStandaloneClassProtoObject`). So the host lane's "decline the
 *     prototype singleton, it reuses the class struct type" arm is unnecessary
 *     here: `ref.test $C` cannot match it. Only the CLASS OBJECT singleton
 *     shares the instance's struct type (#3976) and must be declined —
 *     `Object.getPrototypeOf(C)` is `%Function.prototype%`, never `C.prototype`.
 *  2. **Materialisation is a call to `__class_proto_build_<C>`**, the lazy
 *     builder `mintStandaloneClassProtoBuilders` already mints, instead of an
 *     inline defaulted `struct.new`.
 *  3. It is PREPENDED into `__getPrototypeOf` rather than exported: no host
 *     asks.
 *
 * ## Discrimination: `ref.test` + `__tag` + `ref.eq`, all three
 *
 * The same three-part test `standalone-class-prototype-read.ts` (#6457) uses,
 * for the same reasons: WasmGC canonicalises struct types STRUCTURALLY, so two
 * unrelated classes with the same field shape are literally one type (#5195 F1,
 * re-measured as the #5377 regression on the host twin) — hence `__tag`; and a
 * class OBJECT is the same struct type with the SAME tag as its instances —
 * hence the identity compare against `__class_<C>`. A class with no `__tag`
 * field is DECLINED rather than answered, because there is nothing that tells
 * it apart from a structurally identical sibling, and a wrong prototype is
 * worse than the missing one this replaces.
 *
 * ## Position and the #802 disjointness
 *
 * Filled between `fillClassPrototypeReadArm` and `fillDynamicProtoHelpers`, so
 * #802's marked-root arm keeps the FRONT slot of `__getPrototypeOf`: a
 * prototype link MUTATED at runtime must be answered from the mutation, not
 * from a compile-time singleton. Belt and braces, classes in a #802-marked
 * hierarchy are excluded from this dispatcher outright, so the two arm sets are
 * disjoint by construction and the order is not load-bearing.
 *
 * ## Byte-inertness
 *
 * Gated on standalone/WASI, a non-empty demand set
 * (`ctx.standaloneRuntimeKeyClassProtos` — a module records it at a dynamic
 * class-member read, at a dynamic `.prototype` read, and now at a generic
 * `Object.getPrototypeOf` site) and a present native `__getPrototypeOf`. A
 * module with no class, or one that only ever asks the statically folded
 * question, emits identical bytes. The JS-host lane is untouched.
 */

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { standaloneClassProtoObjectApplies } from "./class-proto-object.js";
import { classProtoBuilderName } from "./standalone-class-dyn-member.js";
import { dynamicProtoRootFor } from "./dynamic-proto.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

const EXTERNREF: ValType = { kind: "externref" };

/** The dispatcher's name in `funcMap`; also its identity for idempotence. */
export const STANDALONE_CLASS_INSTANCE_PROTO = "__std_class_instance_proto";

/** One class that can answer `getPrototypeOf(<instance>)`. */
interface InstanceProtoEntry {
  structTypeIdx: number;
  tagFieldIdx: number;
  tagValue: number;
  classObjectGlobalIdx: number;
  protoGlobalIdx: number;
  /** `__class_proto_build_<C>`, when the prototype singleton is lazy. */
  builderName: string;
  /** Inheritance depth — most-derived arms are emitted first. */
  depth: number;
}

function collectEntries(ctx: CodegenContext): InstanceProtoEntry[] {
  const entries: InstanceProtoEntry[] = [];
  for (const className of [...ctx.standaloneRuntimeKeyClassProtos].sort()) {
    if (!standaloneClassProtoObjectApplies(ctx, className)) continue;
    // (#802) A dynamically re-prototyped hierarchy is `__struct_proto_read`'s,
    // and its answer comes from the MUTATED field, not from this singleton.
    if (dynamicProtoRootFor(ctx, className) !== undefined) continue;
    const protoGlobalIdx = ctx.protoGlobals.get(className);
    const classObjectGlobalIdx = ctx.classObjectGlobals.get(className);
    const structTypeIdx = ctx.structMap.get(className);
    if (protoGlobalIdx === undefined || classObjectGlobalIdx === undefined || structTypeIdx === undefined) continue;
    const tagFieldIdx = (ctx.structFields.get(className) ?? []).findIndex((field) => field.name === "__tag");
    const tagValue = ctx.classTagMap.get(className);
    if (tagFieldIdx < 0 || tagValue === undefined) continue;
    let depth = 0;
    for (let c = className; ctx.classParentMap.has(c) && depth < 64; c = ctx.classParentMap.get(c)!) depth++;
    entries.push({
      structTypeIdx,
      tagFieldIdx,
      tagValue,
      classObjectGlobalIdx,
      protoGlobalIdx,
      builderName: classProtoBuilderName(className),
      depth,
    });
  }
  // `ref.test` succeeds for a SUBTYPE too, so a base-class arm placed first
  // would swallow every derived instance. Most-derived first.
  entries.sort((a, b) => b.depth - a.depth);
  return entries;
}

/**
 * The dispatcher body: `[value: externref] -> [prototype-or-null: externref]`,
 * with local 1 holding the value as `anyref`.
 *
 * Every `ref.cast` sits under the `ref.test` that proved it, and a null global
 * makes `ref.eq` simply false, so the sequence is trap-free for a foreign
 * carrier and for an unmaterialised singleton alike.
 */
function dispatcherBody(ctx: CodegenContext, entries: InstanceProtoEntry[]): Instr[] {
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  for (const entry of entries) {
    // Resolved BY NAME at fill time: `funcMap` is shift-maintained, and the
    // builder is simply absent for a class whose ClassDefinitionEvaluation
    // already force-built the global.
    const builderIdx = ctx.funcMap.get(entry.builderName);
    const build: Instr[] =
      builderIdx === undefined
        ? []
        : [
            { op: "global.get", index: entry.protoGlobalIdx },
            { op: "ref.is_null" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "call", funcIdx: builderIdx }] },
          ];
    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: entry.structTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: entry.structTypeIdx },
          { op: "struct.get", typeIdx: entry.structTypeIdx, fieldIdx: entry.tagFieldIdx },
          { op: "i32.const", value: entry.tagValue },
          { op: "i32.ne" },
          // A structurally identical sibling class: fall through to its own arm
          // rather than answer this class's prototype.
          { op: "br_if", depth: 0 },
          // The class OBJECT reuses the instance struct type AND its tag
          // (#3976). `Object.getPrototypeOf(C)` is %Function.prototype%, so
          // decline — the caller keeps its existing answer.
          { op: "global.get", index: entry.classObjectGlobalIdx },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: entry.structTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "ref.cast", typeIdx: entry.structTypeIdx },
              { op: "global.get", index: entry.classObjectGlobalIdx },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: entry.structTypeIdx },
              { op: "ref.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "ref.null.extern" }, { op: "return" }],
              },
            ],
          },
          ...build,
          { op: "global.get", index: entry.protoGlobalIdx },
          { op: "return" },
        ],
      },
    );
  }
  body.push({ op: "ref.null.extern" });
  return body;
}

/**
 * Mint `__std_class_instance_proto` and prepend its arm to the native
 * `__getPrototypeOf`.
 *
 * The arm is a WIDENING of a missing answer, never a replacement of a present
 * one: it runs FIRST but returns only when the dispatcher answers non-null, and
 * the dispatcher answers only for a value that is a tagged instance of one of
 * this module's own classes — precisely the receiver shape on which every
 * existing arm of `__getPrototypeOf` misses (`ref.test $Object` fails, the
 * #4643 fnctor ladder answers null, the boundary import is absent or declines).
 */
export function fillStandaloneClassInstanceProtoArm(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  if (ctx.funcMap.has(STANDALONE_CLASS_INSTANCE_PROTO)) return; // idempotent
  if (ctx.standaloneRuntimeKeyClassProtos.size === 0) return;
  const getPrototypeOfIdx = ctx.funcMap.get("__getPrototypeOf");
  if (getPrototypeOfIdx === undefined) return;
  const getPrototypeOfFn = ctx.mod.functions.find((candidate) => candidate.name === "__getPrototypeOf");
  if (!getPrototypeOfFn?.body) return;
  const entries = collectEntries(ctx);
  if (entries.length === 0) return;

  const funcIdx = mintDispatcher(ctx, entries);
  if (funcIdx === undefined) return;

  // `__getPrototypeOf` takes one param, so the first appended local sits at
  // 1 + locals.length. Locals are APPENDED, never renumbered, so every
  // previously-baked index in the body stays valid.
  const answerSlot = 1 + getPrototypeOfFn.locals.length;
  getPrototypeOfFn.locals.push({ name: "__class_instance_proto", type: { kind: "externref" } });
  getPrototypeOfFn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "call", funcIdx },
    { op: "local.tee", index: answerSlot },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: answerSlot }, { op: "return" }],
    },
  );
}

/** Mint the dispatcher as a DEFINED function (no import ⇒ no funcIdx shift). */
function mintDispatcher(ctx: CodegenContext, entries: InstanceProtoEntry[]): number | undefined {
  const typeIdx = addFuncType(ctx, [EXTERNREF], [EXTERNREF], "$__std_class_instance_proto_type");
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(STANDALONE_CLASS_INSTANCE_PROTO, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: STANDALONE_CLASS_INSTANCE_PROTO,
    typeIdx,
    locals: [{ name: "__value_any", type: { kind: "anyref" } }],
    body: dispatcherBody(ctx, entries),
    exported: false,
  });
  return funcIdx;
}
