// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { FieldDef, StructTypeDef } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { hasStaticModifier } from "./ast-modifiers.js";

export interface ClassFieldSource {
  readonly name: string;
  readonly node: ts.PropertyName | ts.MemberName;
}

export interface ClassFieldProvenance {
  readonly kind: "public" | "private" | "synthetic" | "ambiguous" | "unknown";
  readonly sources: readonly ClassFieldSource[];
}

interface ClassFieldCollection {
  readonly sources: readonly ClassFieldSource[];
  readonly ownFields: readonly FieldDef[];
  readonly parentFields: readonly FieldDef[];
}

const layouts = new WeakMap<CodegenContext, WeakMap<StructTypeDef, ReadonlyMap<FieldDef, ClassFieldProvenance>>>();

/** The collector's declaration lookup, including its existing last-declaration policy. */
export function collectDeclaredClassProperties(
  decl: ts.ClassDeclaration | ts.ClassExpression,
  resolveName: (name: ts.PropertyName) => string | undefined,
): Map<string, ts.PropertyDeclaration> {
  const properties = new Map<string, ts.PropertyDeclaration>();
  for (const member of decl.members) {
    if (!ts.isPropertyDeclaration(member) || !member.name || hasStaticModifier(member)) continue;
    const name = resolveName(member.name);
    if (name !== undefined) properties.set(name, member);
  }
  return properties;
}

/** Compile-time source evidence only: neither runtime ownness nor an ABI receipt. */
export function readClassFieldProvenance(
  ctx: CodegenContext,
  type: StructTypeDef,
  field: FieldDef,
): ClassFieldProvenance | undefined {
  const index = ctx.structMap.get(type.name);
  if (index === undefined || ctx.mod.types[index] !== type) return undefined;
  if (ctx.structFields.get(type.name) !== type.fields || !type.fields.includes(field)) return undefined;
  return layouts.get(ctx)?.get(type)?.get(field);
}

/** Publish only after the exact completed layout owns these physical fields. */
export function recordClassFieldProvenance(
  ctx: CodegenContext,
  type: StructTypeDef,
  collection: ClassFieldCollection,
): void {
  const records = new Map<FieldDef, ClassFieldProvenance>();
  const parentType = type.superTypeIdx === undefined ? undefined : ctx.mod.types[type.superTypeIdx];
  for (const field of type.fields) {
    const inherited = collection.parentFields.includes(field);
    const prior =
      inherited && parentType?.kind === "struct" ? readClassFieldProvenance(ctx, parentType, field) : undefined;
    const sources = [...(prior?.sources ?? [])];
    // Resolve with the SAME parent-before-own selection as the collector.
    // Include observations made before its duplicate-field short circuits.
    for (const source of collection.sources) {
      const selected =
        collection.parentFields.find((item) => item.name === source.name) ??
        collection.ownFields.find((item) => item.name === source.name);
      if (selected === field) sources.push(Object.freeze({ ...source }));
    }
    const kinds = new Set<ClassFieldProvenance["kind"]>();
    if (prior) kinds.add(prior.kind);
    else if (inherited) kinds.add("unknown");
    else if (!collection.ownFields.includes(field)) kinds.add("synthetic");
    // The root's admitted dynamic-prototype role reuses an existing __proto__
    // slot too: the collector's no-duplicate condition does not remove that role.
    if (!parentType && ctx.standalone && ctx.dynamicProtoClasses.has(type.name) && field.name === "__proto__") {
      kinds.add("synthetic");
    }
    for (const source of sources) kinds.add(ts.isPrivateIdentifier(source.node) ? "private" : "public");
    // Duplicate physical spellings cannot authenticate which slot source access selects.
    if (type.fields.some((other) => other !== field && other.name === field.name)) kinds.add("ambiguous");
    const kind = kinds.size === 0 ? "unknown" : kinds.size === 1 ? [...kinds][0]! : "ambiguous";
    records.set(field, Object.freeze({ kind, sources: Object.freeze(sources) }));
  }
  let types = layouts.get(ctx);
  if (!types) {
    types = new WeakMap();
    layouts.set(ctx, types);
  }
  types.set(type, records);
}
