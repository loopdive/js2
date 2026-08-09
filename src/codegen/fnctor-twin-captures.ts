import { CLOSURE_CAPTURE_FIELD_BASE } from "./closures/funcref-wrapper-types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { refCellValueType } from "./registry/types.js";
import type { Instr, StructTypeDef, ValType } from "../ir/types.js";

/**
 * (#4139) Materialize a fnctor constructor twin's sibling-capture bindings
 * from the constructor's own closure value.
 *
 * The twin compiles the ctor body in a FRESH frame, so a body that calls
 * capturing sibling functions (acorn's UMD wrapper: `getOptions`,
 * `wordsRegexp` — captures of the module IIFE's frame) had its capture
 * arguments prepended from `cap.outerLocalIdx` — slots the twin does not
 * have. That emitted a read of whatever the twin's same-numbered local held:
 * an engine validation error when the types disagreed, a silently wrong value
 * when they did not.
 *
 * The values already travel to the twin: on standalone every call site passes
 * the constructor's closure VALUE as the hidden `__constructor_identity`
 * param (fnctor-constructor-identity.ts), and the closure struct's capture
 * fields carry exactly the bindings the body needs — `compileArrowAsClosure`
 * unions in the transitive captures of every called sibling, which is why the
 * closure compilation of the same body works. So the twin prologue casts the
 * identity param to the closure struct and spills each capture field into a
 * frame local registered under the capture's own name. Sibling-call prepends
 * then resolve in-frame (`capture-source-slot.ts`), and direct reads of the
 * captured names inside the ctor body resolve the same way the closure body's
 * do (cells register in `boxedCaptures`).
 *
 * The cast is guarded by `ref.test`: a null or foreign identity value leaves
 * the locals at their defaults — exactly the pre-existing behaviour, never a
 * trap.
 */
export function materializeFnctorTwinCaptures(
  ctx: CodegenContext,
  ctorFctx: FunctionContext,
  closureStructTypeIdx: number,
  identityParamIdx: number,
): void {
  const def = ctx.mod.types[closureStructTypeIdx];
  if (!def || def.kind !== "struct") return;
  const fields = (def as StructTypeDef).fields;

  const spills: { fieldIdx: number; local: number }[] = [];
  for (let fieldIdx = CLOSURE_CAPTURE_FIELD_BASE; fieldIdx < fields.length; fieldIdx++) {
    const field = fields[fieldIdx]!;
    // Layout: [funcref, arity, ...captures, ...__tdz_* flags, __constructible?].
    if (field.name.startsWith("__tdz_") || field.name === "__constructible") continue;
    // The ctor body's own bindings win: a user param or hoisted local with the
    // captured name shadows the outer capture, matching the closure body.
    if (ctorFctx.localMap.has(field.name)) continue;

    const local = allocLocal(ctorFctx, field.name, field.type);
    ctorFctx.localMap.set(field.name, local);
    spills.push({ fieldIdx, local });

    // A ref-cell field is a boxed (mutable / already-boxed) capture: register
    // it so reads/writes inside the body dereference the cell, sharing writes
    // with every other holder of the same cell.
    const fieldType = field.type as ValType;
    if (fieldType.kind === "ref_null" || fieldType.kind === "ref") {
      const typeIdx = (fieldType as { typeIdx: number }).typeIdx;
      if (ctx.typeIdxToStructName.get(typeIdx)?.startsWith("__ref_cell_")) {
        const valType = refCellValueType(ctx, typeIdx);
        if (valType) {
          if (!ctorFctx.boxedCaptures) ctorFctx.boxedCaptures = new Map();
          ctorFctx.boxedCaptures.set(field.name, { refCellTypeIdx: typeIdx, valType });
        }
      }
    }
  }
  if (spills.length === 0) return;

  const castLocal = allocLocal(ctorFctx, "__ctor_closure_cast", {
    kind: "ref_null",
    typeIdx: closureStructTypeIdx,
  });
  ctorFctx.body.push({ op: "local.get", index: identityParamIdx });
  ctorFctx.body.push({ op: "any.convert_extern" });
  ctorFctx.body.push({ op: "ref.test", typeIdx: closureStructTypeIdx });
  ctorFctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: identityParamIdx },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: closureStructTypeIdx },
      { op: "local.set", index: castLocal },
      ...spills.flatMap((spill): Instr[] => [
        { op: "local.get", index: castLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: closureStructTypeIdx, fieldIdx: spill.fieldIdx },
        { op: "local.set", index: spill.local },
      ]),
    ],
  });
}
