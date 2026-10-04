// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext } from "./context/types.js";
import type { Instr } from "../ir/types.js";
import { closedWellKnownSymbolFields } from "./closed-symbol-fields.js";
import { presenceSlotOf, presenceTestInstrs } from "./fnctor-presence-bits.js";
import { buildTombstoneScreen, buildTombstoneSkip } from "./instance-tombstones.js";
import { buildBagPushKeys } from "./carrier-bag-visibility.js";

/** Extend native reflection from the same declaration-proven computed fields
 * as the getter. Never infer well-known Symbol identity from escaped names. */
export function fillClosedScriptSymbolReflection(ctx: CodegenContext): void {
  if (!ctx.standaloneScriptReflectionExports || ctx.symbolTypeIdx < 0) return;
  const box = ctx.funcMap.get("__box_symbol"),
    push = ctx.funcMap.get("__objvec_push");
  const gops = ctx.mod.functions.find((fn) => fn.name === "__getOwnPropertySymbols");
  if (box === undefined || push === undefined || !gops)
    throw new Error("native Script symbol reflection dependencies missing");
  const init = gops.body.findIndex(
    (i, n) =>
      i.op === "call" &&
      i.funcIdx === ctx.funcMap.get("__objvec_new") &&
      gops.body[n + 1]?.op === "local.set" &&
      (gops.body[n + 1] as { index: number }).index === 7,
  );
  if (init < 0) throw new Error("native Script symbol enumeration initializer missing");
  const enumArms: Instr[] = [];
  const ownArms: Instr[] = [];
  for (const [name, keys] of closedWellKnownSymbolFields(ctx)) {
    const fields = ctx.structFields.get(name),
      typeIdx = ctx.structMap.get(name);
    if (!fields || typeIdx === undefined) continue;
    const shapeField = fields.findIndex((field) => field.name === "$shape"),
      shapeId = ctx.shapeIdByStructName.get(name);
    const guard = (body: Instr[]): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then:
          shapeField >= 0 && shapeId !== undefined
            ? [
                { op: "local.get", index: 0 },
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx },
                { op: "struct.get", typeIdx, fieldIdx: shapeField },
                { op: "i32.const", value: shapeId },
                { op: "i32.eq" },
                { op: "if", blockType: { kind: "empty" }, then: body },
              ]
            : body,
      },
    ];
    const enumBody: Instr[] = [],
      ownBody: Instr[] = [];
    for (const [field, id] of keys) {
      if (!fields.some((candidate) => candidate.name === field)) continue;
      const presence = presenceSlotOf(fields, field);
      const live = (): Instr[] =>
        presence
          ? [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx },
              ...presenceTestInstrs(typeIdx, presence),
            ]
          : [{ op: "i32.const", value: 1 }];
      enumBody.push(...live(), {
        op: "if",
        blockType: { kind: "empty" },
        then: buildTombstoneSkip(
          ctx,
          [
            { op: "i32.const", value: id },
            { op: "call", funcIdx: box },
          ],
          [
            { op: "local.get", index: 7 },
            { op: "i32.const", value: id },
            { op: "call", funcIdx: box },
            { op: "call", funcIdx: push },
          ],
        ),
      });
      ownBody.push(
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.symbolTypeIdx },
        { op: "struct.get", typeIdx: ctx.symbolTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: id },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: [...live(), { op: "return" }] },
      );
    }
    enumBody.push(
      ...buildBagPushKeys(ctx, { vecLocal: 7, includeNonEnum: true, symbolsOnly: true }),
      { op: "local.get", index: 7 },
      { op: "return" },
    );
    enumArms.push(...guard(enumBody));
    ownArms.push(...guard(ownBody));
  }
  gops.body.splice(init + 2, 0, ...enumArms);
  for (const name of ["__hasOwnProperty", "__object_hasOwn"]) {
    const fn = ctx.mod.functions.find((candidate) => candidate.name === name);
    if (!fn) continue;
    // Fresh trees per target: finalizers remap instructions in place.
    // Symbol arms are built per invocation by this recursive leaf below.
    const copy = (body: Instr[]): Instr[] => structuredClone(body);
    fn.body.unshift(
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...buildTombstoneScreen(ctx, [{ op: "i32.const", value: 0 }, { op: "return" }]), ...copy(ownArms)],
      },
    );
  }
}
