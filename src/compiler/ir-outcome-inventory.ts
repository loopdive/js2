// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { elideDeadTopLevelBindings } from "../deadcode-elide.js";
import { buildIrUnitInventory, type BuildIrUnitInventoryOptions } from "../ir/identity.js";
import type { PositionMap } from "../position-map.js";
import { ts } from "../ts-api.js";

export type IrInventoryOptions = BuildIrUnitInventoryOptions;

export function makeIrInventoryOptions(positionMap: PositionMap): IrInventoryOptions {
  return {
    compilerOriginAt: (_sourceFile, offset) => positionMap.compilerOriginAtOutputOffset(offset),
  };
}

export function maybe(positionMap: PositionMap, enabled: boolean): IrInventoryOptions | undefined {
  return enabled ? makeIrInventoryOptions(positionMap) : undefined;
}

/**
 * Preserve pre-elision structural ordinals for retained support units while
 * keeping the final inventory limited to nodes that remain in the target AST.
 */
export function elideWithIrIds(
  source: string,
  fileName: string,
  scriptKind: ts.ScriptKind,
  inventoryOptions: IrInventoryOptions | undefined,
): { source: string; inventoryOptions: IrInventoryOptions | undefined } {
  const elision = elideDeadTopLevelBindings(source, scriptKind);
  if (!inventoryOptions || elision.elided.length === 0) {
    return { source: elision.source, inventoryOptions };
  }

  const identitySource = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const canonical = buildIrUnitInventory([identitySource], {
    entrySource: identitySource,
    compilerOriginAt: inventoryOptions.compilerOriginAt,
  });
  const unitOrdinals = new Map(
    canonical.allUnits.map((unit) => [
      `${unit.declarationStart}\u0000${unit.declarationEnd}\u0000${unit.kind}`,
      unit.ordinal,
    ]),
  );
  const classOrdinals = new Map(
    canonical.classes.map((record) => [
      `${record.declarationStart}\u0000${record.declarationEnd}\u0000${record.declarationKind}`,
      record.ordinal,
    ]),
  );
  return {
    source: elision.source,
    inventoryOptions: {
      ...inventoryOptions,
      canonicalUnitOrdinalAt: (_sourceFile, declarationStart, declarationEnd, kind) =>
        unitOrdinals.get(`${declarationStart}\u0000${declarationEnd}\u0000${kind}`),
      canonicalClassOrdinalAt: (_sourceFile, declarationStart, declarationEnd, declarationKind) =>
        classOrdinals.get(`${declarationStart}\u0000${declarationEnd}\u0000${declarationKind}`),
    },
  };
}
