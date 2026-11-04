// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7233) Two class-member projection helpers for the IR.
 *
 * 1. The legacy storage of a static private field, as an IR global.
 *
 * Legacy registers every `static #x` of class `C` as one mutable module global,
 * `__static_C___priv_x` (`class-bodies.ts`, keyed `C___priv_x` in
 * `ctx.staticProps`), and lowers `this.#x` / `C.#x` inside `C`'s static methods
 * to `global.get` / `global.set` of it. A private name is never reflected onto
 * the class object, so that global is the field's only store: an IR static
 * body may read and write it directly and stay observably identical.
 *
 * The global is planned as a support binding of its source, ordered by its
 * legacy allocation index (role `classStaticField`), exactly once per global;
 * every referrer receives the same reference. Only representations the IR has
 * a type for are answered: `f64`, `i32`, the active lane's dynamic carrier for
 * an untyped field, and the active string carrier for a `string` field.
 * Anything else answers `undefined`, and the caller demotes to legacy.
 *
 * 2. `irJsInstanceMethodMaySkip`, the JS-only best-effort rule of the
 *    `buildIrClassShapes` instance-method loop (see its comment).
 */
import { irSupportGlobalRef } from "../ir/abi-bindings.js";
import { privateMemberMangledName } from "../ir/identity.js";
import { irDynamic, irVal, type IrClassShape, type IrGlobalRef, type IrType } from "../ir/nodes.js";
import { resolveIrDynamicCarrierType } from "./any-helpers.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { PROGRAM_ABI_GLOBAL_ROLE, planProgramAbiGlobal } from "./program-abi-planning.js";
import { localGlobalIdx } from "./registry/imports.js";

export interface IrClassStaticFieldStorage {
  readonly globalRef: IrGlobalRef;
  readonly type: IrType;
}

export function resolveIrClassStaticFieldStorage(
  ctx: CodegenContext,
  owner: ts.ClassDeclaration,
  field: ts.PrivateIdentifier,
): IrClassStaticFieldStorage | undefined {
  const className = owner.name?.text;
  if (className === undefined || !ctx.classSet.has(className)) return undefined;
  const globalIdx = ctx.staticProps.get(`${className}_${privateMemberMangledName(field)}`);
  if (globalIdx === undefined) return undefined;
  const localIdx = localGlobalIdx(ctx, globalIdx);
  const global = ctx.mod.globals[localIdx];
  if (!global || !global.mutable || global.name !== `__static_${className}_${privateMemberMangledName(field)}`) {
    return undefined;
  }
  const sourceId = ctx.irPlanningIdentityContext?.sourceIdBySourceFile.get(owner.getSourceFile());
  if (sourceId === undefined) return undefined;
  const declaration = owner.members.find(
    (member) =>
      ts.isPropertyDeclaration(member) && ts.isPrivateIdentifier(member.name) && member.name.text === field.text,
  );
  if (!declaration) return undefined;
  const type = staticFieldIrType(ctx, declaration, global.type);
  if (type === undefined) return undefined;
  const globalRef = irSupportGlobalRef(sourceId, "class-static-field", global.name, localIdx);
  planProgramAbiGlobal(ctx, {
    ref: globalRef,
    anchor: { kind: "source", sourceId },
    roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.classStaticField,
    derivedOrdinal: localIdx,
    global,
  });
  return { globalRef, type };
}

function staticFieldIrType(
  ctx: CodegenContext,
  declaration: ts.ClassElement,
  storage: import("../ir/types.js").ValType,
): IrType | undefined {
  if (storage.kind === "f64" || storage.kind === "i32") return irVal({ kind: storage.kind });
  const fact = ctx.oracle.typeFactOf(declaration).kind;
  if (fact === "any" || fact === "unknown") {
    return sameValType(storage, resolveIrDynamicCarrierType(ctx)) ? irDynamic() : undefined;
  }
  if (fact === "string") {
    const carrier = ctx.nativeStrings
      ? ctx.anyStrTypeIdx < 0
        ? undefined
        : ({ kind: "ref_null", typeIdx: ctx.anyStrTypeIdx } as const)
      : ({ kind: "externref" } as const);
    return carrier && sameValType(storage, carrier) ? { kind: "string" } : undefined;
  }
  return undefined;
}

function sameValType(a: import("../ir/types.js").ValType, b: import("../ir/types.js").ValType): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "ref" || a.kind === "ref_null") && (b.kind === "ref" || b.kind === "ref_null")) {
    return a.typeIdx === b.typeIdx;
  }
  return true;
}

/**
 * (#7233) May `buildIrClassShapes` skip an unprojectable instance method of a
 * class in `sourceFile`, leaving that one method on its legacy body and slot,
 * instead of dropping the whole class? JS sources only (`NodeFlags.
 * JavaScriptFile`), so typed classes keep their all-or-nothing shapes and
 * bytes. Never when an ancestor shape carries a member of the same name: the
 * IR's inherited-member walk would otherwise reach the ancestor descriptor for
 * a name the skipped override shadows.
 */
export function irJsInstanceMethodMaySkip(
  sourceFile: ts.SourceFile,
  parentShape: IrClassShape | undefined,
  name: string,
): boolean {
  if ((sourceFile.flags & ts.NodeFlags.JavaScriptFile) === 0) return false;
  for (let shape = parentShape; shape; shape = shape.parent) {
    if (shape.methods.some((m) => m.name === name) || shape.fields.some((f) => f.name === name)) return false;
  }
  return true;
}
