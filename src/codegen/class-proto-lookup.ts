// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#5195 Step 1.7) Runtime-keyed reads on a class INSTANCE consult the class's
 * prototype `$Object`.
 *
 * A member installed under a runtime key (`class C { [ID('d')]() {} }`,
 * #5195 Step 1) exists only as an own property of the prototype `$Object` —
 * there is no source-spellable name for it, so none of the syntactic dispatch
 * ladders (`__get_member_<name>`, the closed-struct field arms, the funcMap
 * method lookup) can ever reach it. The only route is the dynamic one:
 * `new C()[k]`, which lowers to `__extern_get(instance, key)`.
 *
 * `__extern_get` handles `$Object` receivers and, since #4232/#4194, the OWN
 * declared fields and expando bag of a closed `$ClassName` struct — but it has
 * no notion of that struct's prototype, so an inherited key answers `undefined`.
 * This adds the missing link: a finalize-minted `__class_proto_lookup` maps a
 * class-instance receiver to its prototype `$Object`, and one prepended arm in
 * `__extern_get` delegates the read there when the key is not an own property.
 *
 * ## Why the `__hasOwnProperty` guard rather than arm ordering
 *
 * §7.3.2: an own property shadows the prototype chain. The own answers live in
 * several places (declared field arms, the #4194 expando bag, the #3468 closure
 * bag), some prepended before this arm and some spliced deep inside the body's
 * non-`$Object` branch — so "be ordered after all of them" is not a property
 * this arm can state locally. Asking `__hasOwnProperty` states it directly and
 * is order-independent. It costs one extra call, and only on a receiver that is
 * an instance of a class this pass emitted an arm for.
 *
 * ## Scope
 *
 * Deliberately narrow: an arm is emitted only for a class that HAS a
 * runtime-keyed member (`ctx.classDynamicMembers`). Those are exactly the
 * classes whose prototype `$Object` is force-initialized at
 * ClassDefinitionEvaluation (Step 1.5), so `global.get __proto_<C>` is non-null
 * by the time any read can run; for every other class the global is lazy and a
 * null answer would silently degrade to today's miss anyway. A module with no
 * runtime-keyed class member compiles to identical bytes. Widening this to
 * every class with a `$Object` prototype is #5195 Step 4.3, which needs the
 * force-init question answered for the general case first.
 */

import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { standaloneClassProtoObjectApplies } from "./class-proto-object.js";
import { classStaticSidecarApplies } from "./class-static-sidecar.js"; // (#5195 Step 2)

const LOOKUP_NAME = "__class_proto_lookup";

interface ProtoLookupEntry {
  className: string;
  structTypeIdx: number;
  /**
   * (#5195 F1) `__tag` field index and this class's tag value.
   *
   * `ref.test` CANNOT identify a class on its own: WasmGC canonicalizes struct
   * types structurally, so two unrelated classes with the same field shape
   * (`class C { x } / class D { y }` — field NAMES do not exist in wasm) are
   * literally the same type, and the first arm swallows the other's instances.
   * Measured: `d[ID('add')]` answered `undefined` because C's arm matched and
   * returned C's prototype. `__tag` is the compiler's per-class discriminator
   * (the same field `tryEmitConstructorViaTag` reads), so every arm tests it.
   */
  tagFieldIdx: number;
  tagValue: number;
  /**
   * (#5195 F1) The prototype singletons to try, nearest first: this class's own,
   * then each ancestor's. A class is only force-built at
   * ClassDefinitionEvaluation when it DECLARES a runtime-keyed member, so a
   * plain `class D extends C {}` can still hold a null `__proto_D` at the time a
   * read runs; the nearest ancestor that WAS built is then the right answer, and
   * it is the same object `__proto_D` would have been linked to.
   */
  protoGlobalIdxs: number[];
  /** Inheritance depth — arms are emitted most-derived first (see below). */
  depth: number;
  /** (#5195 Step 2) The static sidecar `$Object`, when this class has one. */
  sidecarGlobalIdx?: number;
  /** The class-object singleton to compare the receiver against, for the above. */
  classObjectGlobalIdx?: number;
}

/**
 * (#5195 F1) Classes that need a lookup arm: the ones with a runtime-keyed
 * member of their own, PLUS every descendant of one.
 *
 * A subclass has no funcMap alias for an inherited runtime-keyed member — the
 * synthetic `__cmdyn$<ordinal>` name is the parent's and carries no spec key,
 * so aliasing it makes the program-ABI planner reject the module. The member is
 * reached through the prototype chain instead, and that walk starts at the
 * CHILD's prototype `$Object` (linked to the parent's by
 * `emitStandaloneClassProtoObject`), so the child needs its own arm.
 */
function classesNeedingLookup(ctx: CodegenContext): Set<string> {
  const seeds = new Set(ctx.classDynamicMembers.keys());
  if (seeds.size === 0) return seeds;
  const out = new Set(seeds);
  for (const className of ctx.classSet) {
    let depth = 0;
    for (
      let ancestor = ctx.classParentMap.get(className);
      ancestor !== undefined && depth < 64;
      ancestor = ctx.classParentMap.get(ancestor), depth++
    ) {
      if (seeds.has(ancestor)) {
        out.add(className);
        break;
      }
    }
  }
  return out;
}

function collectEntries(ctx: CodegenContext): ProtoLookupEntry[] {
  const entries: ProtoLookupEntry[] = [];
  for (const className of classesNeedingLookup(ctx)) {
    if (!standaloneClassProtoObjectApplies(ctx, className)) continue;
    const structTypeIdx = ctx.structMap.get(className);
    if (structTypeIdx === undefined) continue;
    const tagFieldIdx = (ctx.structFields.get(className) ?? []).findIndex((field) => field.name === "__tag");
    const tagValue = ctx.classTagMap.get(className);
    // No tag ⇒ no way to tell this class apart from a structurally identical
    // one. Decline rather than risk answering another class's prototype.
    if (tagFieldIdx < 0 || tagValue === undefined) continue;
    const protoGlobalIdxs: number[] = [];
    let walkDepth = 0;
    for (
      let current: string | undefined = className;
      current !== undefined && walkDepth < 64;
      current = ctx.classParentMap.get(current), walkDepth++
    ) {
      if (!standaloneClassProtoObjectApplies(ctx, current)) continue;
      const idx = ctx.protoGlobals.get(current);
      if (idx !== undefined) protoGlobalIdxs.push(idx);
    }
    if (protoGlobalIdxs.length === 0) continue;
    let depth = 0;
    for (let c = className; ctx.classParentMap.has(c) && depth < 64; c = ctx.classParentMap.get(c)!) depth++;
    // (#5195 F1) Static members inherit too: `class D extends C {}` must answer
    // `D[ID('s')]` from C's sidecar. D has no sidecar of its own, so walk up to
    // the nearest ancestor that has one — §15.7.14 step 5 makes D's own
    // [[Prototype]] the parent CLASS OBJECT, and this is that link for the one
    // surface a `$ClassName` struct cannot carry.
    let sidecarGlobalIdx: number | undefined;
    let sidecarDepth = 0;
    for (
      let current: string | undefined = className;
      current !== undefined && sidecarDepth < 64 && sidecarGlobalIdx === undefined;
      current = ctx.classParentMap.get(current), sidecarDepth++
    ) {
      if (classStaticSidecarApplies(ctx, current)) sidecarGlobalIdx = ctx.classStaticSidecarGlobals.get(current);
    }
    const classObjectGlobalIdx = ctx.classObjectGlobals.get(className);
    entries.push({
      className,
      structTypeIdx,
      tagFieldIdx,
      tagValue,
      protoGlobalIdxs,
      depth,
      // (#5195 F2) The class-object global is recorded whenever the class HAS
      // one, independently of whether a sidecar exists: the identity test is
      // what keeps the class object off the instance prototype, and that is
      // needed most precisely when there is no sidecar to send it to.
      ...(classObjectGlobalIdx !== undefined ? { classObjectGlobalIdx } : {}),
      ...(sidecarGlobalIdx !== undefined ? { sidecarGlobalIdx } : {}),
    });
  }
  // `ref.test` succeeds for a SUBTYPE too, so a base-class arm placed first
  // would swallow every derived instance and hand back the base prototype.
  // Most-derived first makes the first match the exact one.
  entries.sort((a, b) => b.depth - a.depth);
  return entries;
}

/**
 * Mint `__class_proto_lookup(externref) -> externref` and prepend the delegating
 * arm to `__extern_get`. No-op (byte-identical output) unless the module has a
 * class with a runtime-keyed member.
 */
export function fillClassProtoLookupArm(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  if (ctx.funcMap.has(LOOKUP_NAME)) return; // idempotence
  const entries = collectEntries(ctx);
  if (entries.length === 0) return;
  const externGetFn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty");
  if (!externGetFn || externGetIdx === undefined || hasOwnIdx === undefined) return;

  const body: Instr[] = [];
  for (const entry of entries) {
    // (#5195 Step 2 / F2) The class-OBJECT singleton (`__class_<C>`) is ALSO a
    // `$C` struct, so it matches the instance test below. Its member lookup
    // belongs to the STATIC surface, never to the instance prototype — answering
    // the prototype for it made `C[ID('m')]` hand back an INSTANCE method where
    // the spec (and the pre-#5195 compiler) says `undefined`. So the identity
    // test is emitted unconditionally, and its answer is the static sidecar when
    // the hierarchy has one and NULL when it does not; a null answer means "no
    // delegation", which is exactly the miss the class object should produce.
    // `global.get` may still be null (the class object is lazily built);
    // `ref.eq` with a null side is simply false, which is the right answer for
    // "not that object".
    const classObjectArm: Instr[] =
      entry.classObjectGlobalIdx === undefined
        ? []
        : [
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
                  then: [
                    entry.sidecarGlobalIdx === undefined
                      ? ({ op: "ref.null.extern" } satisfies Instr)
                      : ({ op: "global.get", index: entry.sidecarGlobalIdx } satisfies Instr),
                    { op: "return" },
                  ],
                },
              ],
            },
          ];
    body.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: entry.structTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        // `ref.test` narrows the SHAPE; `__tag` names the class (see the field
        // doc on ProtoLookupEntry).
        else: [],
        // For a class that kept the legacy defaulted prototype the prototype
        // singleton is also a `$C` struct, but such a class has no `$Object`
        // prototype and therefore no entry here at all.
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: entry.structTypeIdx },
          { op: "struct.get", typeIdx: entry.structTypeIdx, fieldIdx: entry.tagFieldIdx },
          { op: "i32.const", value: entry.tagValue },
          { op: "i32.ne" },
          { op: "br_if", depth: 0 },
          ...classObjectArm,
          // Nearest built prototype wins; a null one means that class was never
          // force-built and carries nothing this lookup could answer with.
          ...entry.protoGlobalIdxs.flatMap((protoGlobalIdx, position): Instr[] =>
            position === entry.protoGlobalIdxs.length - 1
              ? [{ op: "global.get", index: protoGlobalIdx }, { op: "return" }]
              : [
                  { op: "global.get", index: protoGlobalIdx },
                  { op: "ref.is_null" },
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "global.get", index: protoGlobalIdx }, { op: "return" }],
                  },
                ],
          ),
        ],
      },
    );
  }
  body.push({ op: "ref.null.extern" });

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], `${LOOKUP_NAME}_type`);
  const lookupIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(LOOKUP_NAME, lookupIdx);
  pushDefinedFunc(ctx, lookupIdx, { name: LOOKUP_NAME, typeIdx, locals: [], body, exported: false });

  // Both helpers take two params, so the first appended local sits at
  // 2 + locals.length. Locals are APPENDED, never renumbered, so every
  // previously-baked index in either body stays valid.
  //
  // (#5195 Step 2) `C[1]` / `new C()[2]` lower to `__extern_get_idx(recv, f64)`,
  // not to `__extern_get` — and that native's `$Object` arm (which delegates to
  // `__extern_get` under the canonical decimal key) is `ref.test $Object`-gated,
  // so a class receiver fell straight to its undefined miss. Route it back into
  // `__extern_get` under the same canonical key, where the arm below applies.
  // Numeric computed keys are exactly how `class C { [ID(2)]() {} }` spells its
  // member, so without this the whole numeric half of the cluster is unreachable.
  const externGetIdxFn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get_idx");
  const numberToStringIdx = ctx.funcMap.get("number_toString");
  if (externGetIdxFn && numberToStringIdx !== undefined) {
    const idxScratch = 2 + externGetIdxFn.locals.length;
    externGetIdxFn.locals.push({ name: "__class_proto_target", type: { kind: "externref" } });
    externGetIdxFn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: lookupIdx },
      { op: "local.tee", index: idxScratch },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: numberToStringIdx },
          { op: "call", funcIdx: externGetIdx },
          { op: "return" },
        ],
      },
    );
  }

  // (#5195 F4) `key in c` has the same gap as the read: `__extern_has` knows
  // nothing about a class instance's prototype, so an inherited runtime-keyed
  // member answered `false` while `c[key]` answered the function. Same
  // delegation, same own-property guard — an own answer must win, and
  // `__extern_has` returning 1 already IS that answer, so the guard is simply
  // "ask the chain only after the ordinary body has said no", which is what
  // appending rather than prepending would give. Prepend with an explicit
  // own-check instead, for the same order-independence reason as the read.
  const externHasFn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_has");
  const externHasIdx = ctx.funcMap.get("__extern_has");
  if (externHasFn && externHasIdx !== undefined) {
    const hasScratch = 2 + externHasFn.locals.length;
    externHasFn.locals.push({ name: "__class_proto_target", type: { kind: "externref" } });
    externHasFn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: lookupIdx },
      { op: "local.tee", index: hasScratch },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: hasOwnIdx },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: hasScratch },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: externHasIdx },
              { op: "return" },
            ],
          },
        ],
      },
    );
  }

  const scratch = 2 + externGetFn.locals.length;
  externGetFn.locals.push({ name: "__class_proto_target", type: { kind: "externref" } });
  externGetFn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: lookupIdx },
    { op: "local.tee", index: scratch },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: hasOwnIdx },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // The delegate receiver is an `$Object`, so this re-entry takes the
            // `$Object` branch and cannot reach this arm again.
            { op: "local.get", index: scratch },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: externGetIdx },
            { op: "return" },
          ],
        },
      ],
    },
  );
}
