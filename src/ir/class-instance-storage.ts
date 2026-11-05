// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7252) The physical struct a `class` IR value lowers to, shared by the
 * class lowering resolver and the `class-instance` module-binding arm so the
 * two cannot disagree on which struct an exact class owns.
 */
import type { ValType } from "./types.js";
import type { IrClassId } from "./identity.js";
import type { IrClassShape, IrType } from "./nodes.js";
import { IrUnsupportedError } from "./outcomes.js";
import { ts } from "../ts-api.js";

/** What the struct lookup reads of the codegen context (the IR takes no codegen edge). */
interface ClassStructRegistry {
  readonly programAbiTypes?: { layoutForClass(classId: IrClassId): { readonly typeIdx: number } | undefined };
  readonly structMap: ReadonlyMap<string, number>;
}

/** The allocator-owned struct of this exact class. */
export function exactClassStructTypeIdx(
  ctx: ClassStructRegistry,
  classId: IrClassId,
  className: string,
): number | undefined {
  return (
    ctx.programAbiTypes?.layoutForClass(classId)?.typeIdx ??
    (ctx.programAbiTypes ? undefined : ctx.structMap.get(className))
  );
}

/**
 * The projected shape a `class-instance` binding reads as, and the struct its
 * legacy slot must hold. A class with no projected shape on this compile
 * demotes the unit rather than guessing a carrier.
 */
export function classInstanceBindingStorage(
  ctx: ClassStructRegistry,
  name: string,
  { classDeclaration }: { readonly classDeclaration: ts.ClassDeclaration },
  classShapes: ReadonlyMap<string, IrClassShape> | undefined,
): { readonly type: IrType; readonly storageType: ValType } {
  const shape = classDeclaration.name ? classShapes?.get(classDeclaration.name.text) : undefined;
  const typeIdx = shape ? exactClassStructTypeIdx(ctx, shape.classId, shape.className) : undefined;
  if (!shape || typeIdx === undefined) {
    throw new IrUnsupportedError(
      "module-init-legacy-coupling",
      "build",
      `module-init: class-instance binding '${name}' has no projected class shape`,
    );
  }
  return { type: { kind: "class", shape }, storageType: { kind: "ref_null", typeIdx } };
}
