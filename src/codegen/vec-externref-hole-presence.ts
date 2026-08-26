// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Standalone presence bridge for externref-element vectors.
 *
 * A sparse numeric literal may first be emitted as an f64 vector and then be
 * widened to the canonical externref carrier at an opaque boundary.  The
 * conversion preserves the private `$Hole` marker; this finalize-time arm
 * makes `HasProperty` treat that marker as an absent own index while retaining
 * an accessor stored in the descriptor overlay as present.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { definedFuncAt } from "./func-space.js";
import { holeTestInstrs } from "./array-holes.js";
import { protoIndexGetIdxMissInstrs, protoIndexHasIdxInstrs } from "./proto-index-store.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import { fillF64HoleHasIdxArms } from "./vec-f64-hole-presence.js";
import { holeCompanionNoOwnDescriptor } from "./vec-hole-companion.js";
import { walkChildren } from "./walk-instructions.js";

/**
 * Add the externref `$Hole` presence arm to `__extern_has_idx`.
 *
 * A companion entry takes precedence over the marker: an own accessor may
 * deliberately leave the backing slot as `$Hole` while still making the index
 * present.  A marker with no own descriptor continues through the numeric
 * prototype store, exactly as an ordinary `HasProperty` miss should.
 */
export function fillExternrefHoleHasIdxArms(ctx: CodegenContext): void {
  if (!ctx.standalone || !ctx.usesArrayHoles) return;
  const funcIdx = ctx.funcMap.get("__extern_has_idx");
  if (funcIdx === undefined) return;
  const fn = definedFuncAt(ctx, funcIdx);
  if (!fn || fn.locals.some((local) => local.name === "__externrefhole_has_any")) return;

  const seen = new Set<number>();
  const carriers: { typeIdx: number; arrTypeIdx: number }[] = [];
  for (const vecTypeIdx of ctx.vecTypeMap.values()) {
    if (seen.has(vecTypeIdx)) continue;
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) continue;
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array" || arrDef.element.kind !== "externref") continue;
    seen.add(vecTypeIdx);
    carriers.push({ typeIdx: vecTypeIdx, arrTypeIdx });
  }
  if (carriers.length === 0) return;
  carriers.sort((a, b) => a.typeIdx - b.typeIdx);

  const anyLocal = 2 + fn.locals.length;
  const indexLocal = anyLocal + 1;
  const compLocal = anyLocal + 2;
  const types = ctx.objectRuntimeTypes;
  const noOwnDescriptor = holeCompanionNoOwnDescriptor(ctx, anyLocal, compLocal);
  fn.locals.push(
    { name: "__externrefhole_has_any", type: { kind: "anyref" } },
    { name: "__externrefhole_has_i", type: { kind: "i32" } },
  );
  if (noOwnDescriptor !== undefined) {
    fn.locals.push({ name: "__externrefhole_has_comp", type: { kind: "ref_null", typeIdx: types!.objectTypeIdx } });
  }

  const holeMiss = (): Instr[] => protoIndexHasIdxInstrs(ctx, 1, 1) ?? [{ op: "i32.const", value: 0 }];
  const arms: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocal },
  ];
  for (const { typeIdx, arrTypeIdx } of carriers) {
    const inDomain: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "i32.trunc_sat_f64_s" },
      { op: "local.tee", index: indexLocal },
      { op: "i32.const", value: 0 },
      { op: "i32.ge_s" },
      { op: "local.get", index: indexLocal },
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx },
      { op: "struct.get", typeIdx, fieldIdx: 0 },
      { op: "i32.lt_s" },
      { op: "i32.and" },
      { op: "local.get", index: indexLocal },
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx },
      { op: "struct.get", typeIdx, fieldIdx: 1 },
      { op: "array.len" },
      { op: "i32.lt_s" },
      { op: "i32.and" },
    ];
    arms.push(
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...inDomain,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: anyLocal },
              { op: "ref.cast", typeIdx },
              { op: "struct.get", typeIdx, fieldIdx: 1 },
              { op: "local.get", index: indexLocal },
              { op: "array.get", typeIdx: arrTypeIdx },
              ...holeTestInstrs(ctx),
              ...(noOwnDescriptor ?? [{ op: "i32.const", value: 1 }]),
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...holeMiss(), { op: "return" }],
              },
            ],
          },
        ],
      },
    );
  }
  fn.body.splice(0, 0, ...arms);
}

/**
 * Translate a `$Hole` loaded from an externref vec at the dynamic read
 * boundary. The overlay read prologue runs before the typed vec arms, so an
 * own accessor/value remains authoritative; only a raw marker reaches this
 * patch. Editing the existing `array.get` keeps the eager helper's import and
 * late-index bookkeeping intact.
 */
export function fillExternrefHoleGetIdxArms(ctx: CodegenContext): void {
  if (!ctx.standalone || !ctx.usesArrayHoles || !ctx.externGetIdxReserved) return;
  const funcIdx = ctx.funcMap.get("__extern_get_idx");
  if (funcIdx === undefined) return;
  const fn = definedFuncAt(ctx, funcIdx);
  if (!fn || fn.locals.some((local) => local.name === "__externrefhole_get_v")) return;

  const arrTypes = new Set<number>();
  for (const vecTypeIdx of ctx.vecTypeMap.values()) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) continue;
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (arrDef?.kind === "array" && arrDef.element.kind === "externref") arrTypes.add(arrTypeIdx);
  }
  if (arrTypes.size === 0) return;

  const hits: { body: Instr[]; index: number }[] = [];
  const pending: Instr[][] = [fn.body];
  while (pending.length > 0) {
    const body = pending.pop()!;
    for (let index = 0; index < body.length; index++) {
      const instr = body[index]!;
      if (instr.op === "array.get" && arrTypes.has(instr.typeIdx)) hits.push({ body, index });
      walkChildren(instr, (child) => pending.push(child));
    }
  }
  if (hits.length === 0) return;

  const valueLocal = 2 + fn.locals.length;
  fn.locals.push({ name: "__externrefhole_get_v", type: { kind: "externref" } });
  const holeMiss = (): Instr[] =>
    protoIndexGetIdxMissInstrs(ctx, 0, 1, 1) ?? undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
  const byBody = new Map<Instr[], number[]>();
  for (const hit of hits) {
    const indexes = byBody.get(hit.body);
    if (indexes === undefined) byBody.set(hit.body, [hit.index]);
    else indexes.push(hit.index);
  }
  for (const [body, indexes] of byBody) {
    indexes.sort((a, b) => b - a);
    for (const index of indexes) {
      body.splice(
        index + 1,
        0,
        {
          op: "local.tee",
          index: valueLocal,
        },
        ...holeTestInstrs(ctx),
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: holeMiss(),
          else: [{ op: "local.get", index: valueLocal }],
        },
      );
    }
  }
}

/** Fill both scalar-hole representations in their required finalize order. */
export function fillSparseHoleHasIdxArms(ctx: CodegenContext): void {
  fillF64HoleHasIdxArms(ctx);
  fillExternrefHoleHasIdxArms(ctx);
  fillExternrefHoleGetIdxArms(ctx);
}
