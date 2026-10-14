// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createIrBindingId } from "../../shared/contracts/identity-values.js";
import type { IrClassId, IrSourceId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrUnitInventory } from "../../shared/contracts/ir-unit-inventory.js";
import type { IrClassShape } from "../core/types.js";
import type { IrModule } from "../core/nodes.js";
import { preparedIrDataMismatch } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

/** Defaults are JavaScript semantic intents, never chosen physical bit patterns. */
export interface IrPreparedClassField {
  readonly name: string;
  readonly sourceOrdinal: number;
  readonly default: "undefined";
  readonly initializerUnitId: IrUnitId | null;
}
export interface IrPreparedSourceClass {
  readonly classId: IrClassId;
  readonly sourceId: IrSourceId;
  readonly constructorUnitId: IrUnitId;
  readonly constructorKind: "explicit" | "implicit";
  readonly shape: IrClassShape;
  readonly fieldIntents: readonly IrPreparedClassField[];
}

export function assertSourceClassPreparation(
  inventory: IrUnitInventory,
  classes: readonly IrPreparedSourceClass[],
  ir?: IrModule,
): void {
  const invalid = (message: string): never => {
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", `source class preparation: ${message}`);
  };
  const fields = (value: object, names: readonly string[]) => {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== names.length ||
      keys.some((key) => typeof key !== "string" || !names.includes(key)) ||
      names.some((key) => !descriptors[key] || !("value" in descriptors[key]!))
    )
      invalid("class DATA is not closed own fields");
  };
  if (!Array.isArray(classes) || classes.length !== inventory.classes.length)
    invalid("incomplete original class census");
  const seen = new Set<IrClassId>();
  for (const row of classes) {
    fields(row, ["classId", "sourceId", "constructorUnitId", "constructorKind", "shape", "fieldIntents"]);
    if (row.constructorKind !== "explicit" && row.constructorKind !== "implicit") invalid("unknown constructor kind");
    const original = inventory.classes.find((c) => c.id === row.classId);
    const ctor = inventory.terminalUnits.find((u) => u.id === row.constructorUnitId);
    if (!original || seen.has(row.classId) || original.sourceId !== row.sourceId || row.shape.classId !== row.classId)
      invalid("duplicate, missing or foreign class identity");
    seen.add(row.classId);
    if (
      !ctor ||
      ctor.lexicalOwnerId !== row.classId ||
      ctor.sourceId !== row.sourceId ||
      ctor.kind !== (row.constructorKind === "explicit" ? "class-constructor" : "class-implicit-constructor") ||
      row.shape.constructorInitTarget?.binding.kind !== "unit" ||
      row.shape.constructorInitTarget.binding.unitId !== row.constructorUnitId ||
      row.shape.constructorTarget?.binding.kind !== "support" ||
      row.shape.constructorTarget.binding.bindingId !==
        createIrBindingId({ ownerId: row.classId, domain: "support", role: "class-constructor-new" })
    )
      invalid("constructor source/support ownership contradicts the class");
    if (!Array.isArray(row.fieldIntents) || row.fieldIntents.length !== row.shape.fields.length)
      invalid("incomplete field/default census");
    const fieldNames = new Set<string>();
    let previous = -1;
    for (const field of row.fieldIntents) {
      fields(field, ["name", "sourceOrdinal", "default", "initializerUnitId"]);
      if (
        !row.shape.fields.some((f) => f.name === field.name) ||
        fieldNames.has(field.name) ||
        !Number.isSafeInteger(field.sourceOrdinal) ||
        field.sourceOrdinal <= previous ||
        field.default !== "undefined"
      )
        invalid("field defaults or original evaluation order contradict the layout");
      previous = field.sourceOrdinal;
      fieldNames.add(field.name);
      if (field.initializerUnitId !== null) {
        const unit = inventory.allUnits.find((u) => u.id === field.initializerUnitId);
        if (
          !unit ||
          unit.kind !== "class-instance-field-initializer" ||
          unit.lexicalOwnerId !== row.classId ||
          unit.terminalOwnerId !== row.constructorUnitId
        )
          invalid("field initializer has a foreign or missing constructor owner");
      }
    }
    const initialized = inventory.allUnits.filter(
      (u) => u.kind === "class-instance-field-initializer" && u.lexicalOwnerId === row.classId,
    );
    const ids = row.fieldIntents.flatMap((f) => (f.initializerUnitId === null ? [] : [f.initializerUnitId]));
    if (
      new Set(ids).size !== ids.length ||
      initialized.length !== ids.length ||
      initialized.some((u) => !ids.includes(u.id))
    )
      invalid("missing or duplicate original field initializer");
    const methods = new Set<IrUnitId>();
    for (const method of row.shape.methods) {
      const placement = method.placement;
      const unit = inventory.terminalUnits.find((u) => u.id === placement?.unitId);
      if (
        !placement ||
        !unit ||
        methods.has(unit.id) ||
        placement.classId !== row.classId ||
        unit.lexicalOwnerId !== row.classId ||
        method.target?.binding.kind !== "unit" ||
        method.target.binding.unitId !== unit.id ||
        unit.kind !== (placement.staticClassMember ? "class-static-method" : "class-instance-method") ||
        (method.memberKind === "static") !== placement.staticClassMember
      )
        invalid("member placement/target census differs");
      methods.add(placement!.unitId);
      if (ir) {
        const fn = ir.functions.find((f) => f.unitId === placement!.unitId);
        const params = placement!.staticClassMember
          ? method.params
          : [{ kind: "class", shape: row.shape }, ...method.params];
        if (
          !fn ||
          preparedIrDataMismatch(
            fn.params.map((p) => p.type),
            params,
          ) !== undefined ||
          preparedIrDataMismatch(fn.resultTypes, method.returnType ? [method.returnType] : []) !== undefined
        )
          invalid("method body signature contradicts its original contract");
      }
    }
    const expected = inventory.terminalUnits.filter(
      (u) =>
        u.lexicalOwnerId === row.classId && (u.kind === "class-instance-method" || u.kind === "class-static-method"),
    );
    if (expected.length !== methods.size || expected.some((u) => !methods.has(u.id)))
      invalid("missing original method");
    if (ir) {
      const fn = ir.functions.find((f) => f.unitId === row.constructorUnitId);
      const params = [...row.shape.constructorParams, { kind: "class", shape: row.shape }];
      if (
        !fn ||
        preparedIrDataMismatch(
          fn.params.map((p) => p.type),
          params,
        ) !== undefined ||
        preparedIrDataMismatch(fn.resultTypes, [{ kind: "class", shape: row.shape }]) !== undefined
      )
        invalid("constructor init body signature contradicts its original contract");
    }
  }
}
