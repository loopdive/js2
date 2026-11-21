// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7372) The source globals of a Prepared whole program: one row per module-init global binding
 * (`isModuleInitGlobalDeclaration`), with its storage and how the program instantiates it. The producer
 * (`prepareIrProgramSources`) asks this registry for the program input's globals and for the declaration → global
 * lookup its resolver reads.
 *
 * The instantiation is the startup plan's (`IrModuleInitBindingIntent.initialization`), so the plan and the
 * storage cannot disagree: a script `var` is `undefined` from instantiation, a lexical binding is in its TDZ
 * until its declaration runs and has the TDZ flag global. A repeated script `var` is one row: every declarator resolves to the first one's
 * binding id.
 */
import { ts } from "../ts-api.js";
import { irSourceGlobalRef } from "./abi-bindings.js";
import type { ModuleBindingGlobal } from "./ast-lowering-plans.js";
import type { IrUnitId } from "../shared/contracts/ir-identity.js";
import type { IrType } from "./core/types.js";
import type { IrModuleBindingIdentity, IrModuleBindingResolver } from "./module-bindings.js";
import { isModuleInitGlobalDeclaration, moduleInitBindings } from "./module-init-vars.js";
import { IrUnsupportedError } from "./outcomes.js";
import { requireIrPlanningOwnerUnitId, type IrPlanningIdentityContext } from "./planning-identity.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import type { IrModuleInitBindingIntent, IrModuleInitPlan } from "./program/startup.js";

/** A global as the program input carries it. */
export interface ProgramSourceGlobal {
  readonly binding: ModuleBindingGlobal;
  readonly identity: IrModuleBindingIdentity;
}

export interface ProgramSourceGlobals {
  readonly globals: readonly ProgramSourceGlobal[];
  readonly byDeclaration: ReadonlyMap<ts.Declaration, ProgramSourceGlobal>;
}

interface ProgramSourceGlobalsInput {
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly identity: IrPlanningIdentityContext;
  readonly resolver: Pick<IrModuleBindingResolver, "inspectDirectBinding">;
  readonly startup: readonly IrModuleInitPlan[];
  /** The producer's diagnostic cursor: a refusal names the unit it is set to. */
  readonly diagnostic: { active: IrUnitId | undefined };
}

/** Every module-init global of the program's sources, in source order. */
export function collectProgramSourceGlobals(input: ProgramSourceGlobalsInput): ProgramSourceGlobals {
  const { identity, resolver, diagnostic } = input;
  const instantiationById = new Map(
    input.startup.flatMap((plan) => plan.bindings).map((intent) => [intent.globalBindingId, intent.initialization]),
  );
  const globalById = new Map<string, ProgramSourceGlobal>();
  const byDeclaration = new Map<ts.Declaration, ProgramSourceGlobal>();
  for (const source of input.sourceFiles) {
    for (const bound of source.statements.flatMap(moduleInitBindings)) {
      const declaration = "unmapped" in bound ? bound.unmapped : bound.declaration;
      diagnostic.active = requireIrPlanningOwnerUnitId(identity, declaration);
      if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name))
        unsupported("whole-program binding pattern requires the existing destructuring producer");
      if (!isModuleInitGlobalDeclaration(declaration)) continue; // (#7372) a nested `var` is a global in a script
      const inspected = resolver.inspectDirectBinding(declaration.name);
      if (inspected.kind !== "supported")
        unsupported(`module binding ${declaration.name.text} has no exact typed storage: ${inspected.kind}`);
      const global = inspected.identity;
      diagnostic.active = global.storageOwnerUnitId;
      const instantiation = instantiationById.get(global.globalBindingId);
      if (instantiation === undefined)
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          `module binding ${declaration.name.text} has no startup binding to instantiate it`,
        );
      const entry = globalById.get(global.globalBindingId) ?? {
        binding: moduleBindingGlobal(declaration.name.text, global, instantiation),
        identity: global,
      };
      globalById.set(global.globalBindingId, entry);
      byDeclaration.set(declaration, entry);
    }
  }
  return { globals: [...globalById.values()], byDeclaration };
}

/** A global in its TDZ until its declaration runs (a `let` or `const`) also has the TDZ flag global. */
function moduleBindingGlobal(
  name: string,
  global: IrModuleBindingIdentity,
  instantiation: IrModuleInitBindingIntent["initialization"],
): ModuleBindingGlobal {
  const lexical = instantiation === "tdz";
  return {
    ownerUnitId: global.ownerUnitId,
    globalRef: irSourceGlobalRef(global.globalBindingId, name),
    tdzGlobalRef: lexical ? irSourceGlobalRef(global.tdzBindingId, `${name}$tdz`) : null,
    globalName: name,
    tdzGlobalName: lexical ? `${name}$tdz` : null,
    type: storageType(global),
  };
}

function storageType(identity: IrModuleBindingIdentity): IrType {
  const value = identity.valueKind;
  switch (value.kind) {
    case "f64":
      return { kind: "val", val: { kind: "f64" } };
    case "i32":
      return { kind: "val", val: { kind: "i32", boolean: true } };
    case "string":
      return { kind: "string" };
    case "dynamic":
      return { kind: "dynamic" };
    default:
      return unsupported(`whole-program source storage has no typed carrier for ${value.kind}`);
  }
}

function unsupported(detail: string): never {
  throw new IrUnsupportedError("type-resolution-unsupported", "build", detail);
}
