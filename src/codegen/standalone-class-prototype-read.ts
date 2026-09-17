// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#6457, #5383 S11) A RUNTIME-key read of `prototype` on a compiled class
 * OBJECT must answer the class's prototype singleton.
 *
 * ## The gap (measured 2026-09-13, `.tmp/s11/c2.mjs`, ONE module, no link)
 *
 * ```js
 * class C { get day() { return 1; } }
 * function f(K) { return K.prototype; }   // K is an `any` parameter
 * f(C);                                   // undefined  (C.prototype -> object)
 * ```
 *
 * | probe, `--target standalone` | static receiver `C` | dynamic receiver `K` |
 * | --- | --- | --- |
 * | `typeof recv.prototype` | `object` | **`undefined`** |
 * | `gOPD(recv.prototype, "day")` | descriptor | **throws `Cannot convert undefined or null to object`** |
 * | `new recv(1) instanceof recv` | `true` | **`false`** |
 *
 * `instanceof` is in that table because §13.10.2 reads `RHS.prototype`, so a
 * dynamic right-hand side goes through exactly this read.
 *
 * ## Why it missed
 *
 * `__extern_get` reaches a class OBJECT through `__class_proto_lookup`'s
 * class-object arm (#5195 F2 / #5383 S2i), which answers the class's STATIC
 * SIDECAR `$Object` — the carrier for static methods and static accessors.
 * `prototype` is not on it, and nothing else in the dynamic ladder knows a
 * class value has a prototype singleton at all, so the read falls to the
 * native's miss.
 *
 * The object itself exists and is already correct: `ctx.protoGlobals` holds it,
 * #3976's `emitStandaloneClassProtoObject` builds it as a real `$Object` with
 * the members installed at §15.7.14 attributes, and the STATIC `C.prototype`
 * read returns it today. Only the dynamic route was missing.
 *
 * ## Why an ARM and not an own property of the sidecar
 *
 * Installing `prototype` on the static sidecar is the more spec-shaped answer —
 * it would serve `gOPD(K, "prototype")` and `"prototype" in K` for free. It is
 * not reachable in one slice: the sidecar body is built inside
 * `mintStandaloneClassStaticBuilders`, which runs BEFORE
 * `mintStandaloneClassProtoBuilders`, so `__class_proto_build_<C>` — the
 * builder an install would have to call for a class whose prototype
 * ClassDefinitionEvaluation left lazy — is not in `funcMap` yet. Closing that
 * needs a resolve-or-reserve handle plus a widened sidecar admission for
 * classes that declare no static at all: two order-sensitive changes to a path
 * that is currently byte-stable. This fill runs LATE, where both builders are
 * resolvable by name, and adds no emission to any existing site.
 *
 * ## Position
 *
 * PREPENDED into `__extern_get` from the fill block, between
 * `fillClassProtoLookupArm` (whose sidecar delegation this must win over — it
 * would only miss) and `fillDynamicProtoHelpers` (#802's dynamic-proto arm must
 * keep the FRONT slot, because a prototype link mutated at runtime has to be
 * answered from the mutation, not from a compile-time singleton).
 *
 * ## Why the receiver test is `ref.test` + `__tag` + `ref.eq`, all three
 *
 * - `ref.test` narrows the SHAPE only. WasmGC canonicalises struct types
 *   structurally, so two unrelated classes with the same field shape are
 *   literally the same type (#5195 F1) — hence `__tag`, the compiler's
 *   per-class discriminator.
 * - A class OBJECT and its INSTANCES are the same wasm struct type (#3976), so
 *   neither test separates them. `d.prototype` must stay `undefined`; the
 *   identity compare against `__class_<C>` is the only thing that says so. A
 *   null class-object global makes `ref.eq` false, which is the same right
 *   answer.
 */

import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import type { ValType } from "../ir/types.js";
import { standaloneClassProtoObjectApplies } from "./class-proto-object.js";
import { classProtoBuilderName, recordStandaloneRuntimeKeyClassMemberRead } from "./standalone-class-dyn-member.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";

/** One class that can answer a dynamic `prototype` read. */
interface PrototypeReadEntry {
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

function collectEntries(ctx: CodegenContext): PrototypeReadEntry[] {
  const entries: PrototypeReadEntry[] = [];
  for (const className of [...ctx.standaloneRuntimeKeyClassProtos].sort()) {
    if (!standaloneClassProtoObjectApplies(ctx, className)) continue;
    const protoGlobalIdx = ctx.protoGlobals.get(className);
    const classObjectGlobalIdx = ctx.classObjectGlobals.get(className);
    const structTypeIdx = ctx.structMap.get(className);
    if (protoGlobalIdx === undefined || classObjectGlobalIdx === undefined || structTypeIdx === undefined) continue;
    const tagFieldIdx = (ctx.structFields.get(className) ?? []).findIndex((field) => field.name === "__tag");
    const tagValue = ctx.classTagMap.get(className);
    // No tag ⇒ no way to tell this class apart from a structurally identical
    // one. Decline rather than risk answering another class's prototype.
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
  // would swallow every derived class object. Most-derived first.
  entries.sort((a, b) => b.depth - a.depth);
  return entries;
}

/**
 * Prepend the dynamic-`prototype` arm to `__extern_get`. No-op — byte-identical
 * output — unless the module is standalone AND has a class the dynamic-read
 * demand admitted AND that class has both a prototype `$Object` and a class
 * object singleton.
 */
export function fillClassPrototypeReadArm(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  if (ctx.standaloneRuntimeKeyClassProtos.size === 0) return;
  const externGetFn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  if (!externGetFn) return;
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (strFlattenIdx === undefined || strEqualsIdx === undefined || anyStrTypeIdx < 0) return;
  const entries = collectEntries(ctx);
  if (entries.length === 0) return;

  // `__extern_get` takes two params, so the first appended local sits at
  // 2 + locals.length. Locals are APPENDED, never renumbered, so every
  // previously-baked index in either body stays valid.
  const keyScratch = 2 + externGetFn.locals.length;
  externGetFn.locals.push({
    name: "__class_prototype_key",
    type: { kind: "ref_null", typeIdx: anyStrTypeIdx },
  });

  const arms: Instr[] = [];
  for (const entry of entries) {
    // Resolved BY NAME at fill time — `funcMap` is shift-maintained, and the
    // builder is simply absent for a class ClassDefinitionEvaluation already
    // force-built, whose global is non-null before any read can run.
    const builderIdx = ctx.funcMap.get(entry.builderName);
    const build: Instr[] =
      builderIdx === undefined
        ? []
        : [
            { op: "global.get", index: entry.protoGlobalIdx },
            { op: "ref.is_null" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "call", funcIdx: builderIdx }] },
          ];
    arms.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: entry.structTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: entry.structTypeIdx },
          { op: "struct.get", typeIdx: entry.structTypeIdx, fieldIdx: entry.tagFieldIdx },
          { op: "i32.const", value: entry.tagValue },
          { op: "i32.ne" },
          { op: "br_if", depth: 0 },
          { op: "global.get", index: entry.classObjectGlobalIdx },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: entry.structTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: entry.structTypeIdx },
              { op: "global.get", index: entry.classObjectGlobalIdx },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: entry.structTypeIdx },
              { op: "ref.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...build, { op: "global.get", index: entry.protoGlobalIdx }, { op: "return" }],
              },
            ],
          },
        ],
      },
    );
  }

  externGetFn.body.unshift(
    // A non-string key can never be `"prototype"`, and the flatten below would
    // trap on one, so the whole arm is gated on the string test first.
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
        { op: "call", funcIdx: strFlattenIdx },
        { op: "local.set", index: keyScratch },
        { op: "local.get", index: keyScratch },
        { op: "ref.as_non_null" },
        ...nativeStringLiteralInstrs(ctx, "prototype"),
        { op: "call", funcIdx: strEqualsIdx },
        { op: "if", blockType: { kind: "empty" }, then: arms },
      ],
    },
  );
}

/**
 * Record the demand a STATICALLY-NAMED `recv.prototype` read makes, when the
 * receiver is dynamic.
 *
 * The existing demand recorders (#5383 S2h/S2i) fire only at COMPUTED-key sites
 * (`recv[k]`), because a computed key is the one that cannot be served by any
 * syntactic ladder. `prototype` is the exception that proves the rule: the name
 * IS known, but on an `any` receiver there is no class to resolve it against,
 * so the read lowers to `__extern_get(recv, "prototype")` exactly like a
 * computed one — measured (`.tmp/s11/c5.mjs`): the identical probe answered
 * `undefined` alone and the prototype object when an unrelated computed read
 * elsewhere in the module happened to raise the demand.
 *
 * Scoped to the ONE name this slice serves. Widening it to every dot read on an
 * `any` receiver would raise the demand — and with it the per-class prototype
 * and sidecar builders — in most standalone modules, for arms that already
 * answer.
 */
export function recordStandaloneDynamicPrototypeRead(
  ctx: CodegenContext,
  receiverWasm: ValType,
  propName: string,
): void {
  if (!ctx.standalone) return;
  if (propName !== "prototype") return;
  if (receiverWasm.kind !== "externref") return;
  recordStandaloneRuntimeKeyClassMemberRead(ctx, undefined);
}
