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

const LOOKUP_NAME = "__class_proto_lookup";

interface ProtoLookupEntry {
  className: string;
  structTypeIdx: number;
  protoGlobalIdx: number;
  /** Inheritance depth — arms are emitted most-derived first (see below). */
  depth: number;
}

function collectEntries(ctx: CodegenContext): ProtoLookupEntry[] {
  const entries: ProtoLookupEntry[] = [];
  for (const className of ctx.classDynamicMembers.keys()) {
    if (!standaloneClassProtoObjectApplies(ctx, className)) continue;
    const structTypeIdx = ctx.structMap.get(className);
    const protoGlobalIdx = ctx.protoGlobals.get(className);
    if (structTypeIdx === undefined || protoGlobalIdx === undefined) continue;
    let depth = 0;
    for (let c = className; ctx.classParentMap.has(c) && depth < 64; c = ctx.classParentMap.get(c)!) depth++;
    entries.push({ className, structTypeIdx, protoGlobalIdx, depth });
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
    body.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: entry.structTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        // The class-OBJECT singleton (`__class_<C>`) and, for a class that kept
        // the legacy defaulted prototype, the prototype singleton are also
        // `$C` structs. Neither reaches here in practice for a class with a
        // runtime-keyed member — its prototype is an `$Object`, and a read off
        // the class object is a STATIC-side lookup that this arm does not
        // serve — but returning the instance prototype for them would be a
        // wrong answer rather than a missing one, so the caller's own-property
        // guard, not this map, is what keeps the two apart.
        then: [{ op: "global.get", index: entry.protoGlobalIdx }, { op: "return" }],
      },
    );
  }
  body.push({ op: "ref.null.extern" });

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], `${LOOKUP_NAME}_type`);
  const lookupIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(LOOKUP_NAME, lookupIdx);
  pushDefinedFunc(ctx, lookupIdx, { name: LOOKUP_NAME, typeIdx, locals: [], body, exported: false });

  // `__extern_get(externref obj, externref key)` — two params, so the first
  // appended local sits at 2 + locals.length. Locals are APPENDED, never
  // renumbered, so every previously-baked index in this body stays valid.
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
