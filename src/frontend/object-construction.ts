// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "./typescript.js";
import type { IrFunctionBuilder } from "../ir/builder.js";
import type { IrType, IrValueId } from "../ir/core/nodes.js";
import {
  IR_ALLOCATION_SOURCE_FACTS as SOURCE_OBJECT_CONSTRUCTION,
  type IrSourceObjectConstruction,
} from "../shared/contracts/allocation-source-facts.js";

/** Preserve source property order independently of canonical storage coordinates. */
export function emitSourceObjectNew(
  builder: IrFunctionBuilder,
  built: readonly { readonly name: string; readonly type: IrType; readonly value: IrValueId }[],
  source: ts.ObjectLiteralExpression,
): IrValueId {
  const prototypeSetter = source.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      !ts.isComputedPropertyName(property.name) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === "__proto__",
  );
  const metadata: IrSourceObjectConstruction = {
    schema: "source-object-construction-v1",
    kind: prototypeSetter ? "prototype-setter" : source.properties.some(ts.isMethodDeclaration) ? "method" : "data",
    keys: built.map((field) => field.name),
  };
  const layout = [...built].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return builder.emitObjectNew(
    { fields: layout.map(({ name, type }) => ({ name, type })) },
    layout.map(({ value }) => value),
    { namespace: SOURCE_OBJECT_CONSTRUCTION, value: metadata },
  );
}
