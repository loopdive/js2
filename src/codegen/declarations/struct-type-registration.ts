// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Interface- and object-type -> WasmGC struct registration. Maps TS members to
 * FieldDef[] and pushes a struct type. Extracted verbatim from
 * codegen/declarations.ts (#3268).
 */
import { getNullablePrimitiveInfo, isBigIntType, mapTsTypeToWasm } from "../../checker/type-mapper.js";
import { ts } from "../../ts-api.js";
import { fieldsHashKey, resolveWasmType } from "../index.js";
import { registerStructType } from "../registry/types.js";
import type { FieldDef, StructTypeDef } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { usesHostBigIntCarrier } from "../host-bigint-carrier.js";
import { readonlyErasureMappedAliasTarget } from "../readonly-erasure-mapped-type.js";
import {
  hasStructPrefix,
  linkCompatibleDeclaredStructAncestor,
  samePhysicalValType,
  sealNominalStructParent,
} from "../struct-hierarchy-layout.js";

interface RegisteredInterface {
  decl: ts.InterfaceDeclaration;
  name: string;
  typeIdx: number;
  baseNames: string[];
  canLinkNominally: boolean;
  inheritedPrefixLength: number;
  linkedParentIdx?: number;
  openedParent?: boolean;
}

const registeredInterfaces = new WeakMap<CodegenContext, RegisteredInterface[]>();
const collectedInterfaceDeclarations = new WeakMap<CodegenContext, WeakSet<ts.InterfaceDeclaration>>();
const erasedNominalBrandFacts = new WeakMap<CodegenContext, WeakMap<ts.Symbol, boolean>>();

function isRuntimeErasedNominalBrand(ctx: CodegenContext, symbol: ts.Symbol): boolean {
  let facts = erasedNominalBrandFacts.get(ctx);
  if (!facts) {
    facts = new WeakMap();
    erasedNominalBrandFacts.set(ctx, facts);
  }
  const cached = facts.get(symbol);
  if (cached !== undefined) return cached;
  // This is deliberately an exact source-authored contract, not a `/Brand$/`
  // convention. Ordinary programs may store real runtime values in similarly
  // named properties. TypeScript's syntax declarations uniquely document this
  // marker as never valued and zero-runtime-cost.
  if (symbol.name !== "_typeNodeBrand") {
    facts.set(symbol, false);
    return false;
  }

  const allDeclarations = symbol.getDeclarations();
  const declarations = allDeclarations?.filter((declaration): declaration is ts.PropertySignature =>
    ts.isPropertySignature(declaration),
  );
  const symbolType = ctx.checker.getTypeOfSymbol(symbol);
  const owners = declarations
    ?.map((declaration) => declaration.parent)
    .filter((owner): owner is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(owner));
  const sourceFile = owners?.[0]?.getSourceFile();
  const ownerDeclarations = owners?.[0]
    ? ctx.checker
        .getTypeAtLocation(owners[0])
        .getSymbol()
        ?.getDeclarations()
        ?.filter((candidate): candidate is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(candidate))
    : undefined;
  let erased =
    declarations !== undefined &&
    declarations.length === allDeclarations?.length &&
    owners !== undefined &&
    owners.length === declarations.length &&
    owners.every((owner) => owner.name.text === "TypeNode" && owner.getSourceFile() === sourceFile) &&
    ownerDeclarations !== undefined &&
    ownerDeclarations.length > 1 &&
    (symbolType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never)) !== 0 &&
    sourceFile !== undefined &&
    /never actually given values\.\s+At runtime they have zero cost\./.test(sourceFile.getFullText());

  if (erased) {
    const visit = (node: ts.Node): void => {
      if (!erased) return;
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isTypeNode(node)) return;
      if (
        (ts.isIdentifier(node) && node.text === symbol.name) ||
        ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === symbol.name)
      ) {
        erased = false;
        return;
      }
      ts.forEachChild(node, visit);
    };
    for (const sourceFile of ctx.callableSourceFiles ?? [declarations![0]!.getSourceFile()]) visit(sourceFile);
  }

  facts.set(symbol, erased);
  return erased;
}

function mapDeclaredFieldType(ctx: CodegenContext, memberType: ts.Type): FieldDef["type"] {
  // `mapTsTypeToWasm` intentionally models BigInt as the host-free i64
  // carrier. Interface/object fields are value boundaries too, though: in a
  // JS-host module a bigint field must remain an externref, otherwise a wide
  // value is truncated when struct.get/struct.set crosses the field.
  const nullable = getNullablePrimitiveInfo(memberType);
  const isBigIntField =
    usesHostBigIntCarrier(ctx) && (isBigIntType(memberType) || nullable?.primitiveKind === "bigint");
  return isBigIntField ? resolveWasmType(ctx, memberType) : mapTsTypeToWasm(memberType, ctx.checker);
}

export function collectInterface(ctx: CodegenContext, decl: ts.InterfaceDeclaration): void {
  let collected = collectedInterfaceDeclarations.get(ctx);
  if (!collected) {
    collected = new WeakSet<ts.InterfaceDeclaration>();
    collectedInterfaceDeclarations.set(ctx, collected);
  }
  if (collected.has(decl)) return;
  collected.add(decl);

  const interfaceType = ctx.checker.getTypeAtLocation(decl);
  // WasmGC supertypes must precede their subtypes in the type section. Source
  // order does not have that restriction, and TypeScript's own `types.ts`
  // declares `Identifier` before its `PrimaryExpression -> ... -> Expression`
  // base chain. Precollect only same-source, unmerged, property-only bases:
  // their physical layout is complete and recursion cannot pull in a host
  // declaration or a late method field. The declaration WeakSet makes the
  // ordinary source-order pass idempotent and also breaks invalid cycles.
  for (const base of interfaceBaseTypes(ctx, interfaceType)) {
    const stable = interfaceHasStablePhysicalLayout(ctx, base);
    const baseDeclarations = base
      .getSymbol()
      ?.getDeclarations()
      ?.filter((declaration): declaration is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(declaration));
    if (!stable) continue;
    if (baseDeclarations?.length !== 1) continue;
    const baseDeclaration = baseDeclarations[0]!;
    if (baseDeclaration.getSourceFile() !== decl.getSourceFile()) continue;
    collectInterface(ctx, baseDeclaration);
  }

  const name = decl.name.text;
  const fields: FieldDef[] = [];

  const properties = orderedInterfaceProperties(ctx, interfaceType);
  const baseTypes = interfaceBaseTypes(ctx, interfaceType);
  const baseNames = baseTypes
    .map((base) => base.getSymbol()?.name)
    .filter((baseName): baseName is string => baseName !== undefined);
  const declarations = interfaceType
    .getSymbol()
    ?.getDeclarations()
    ?.filter((declaration) => ts.isInterfaceDeclaration(declaration));
  const baseDeclarations = baseTypes[0]
    ?.getSymbol()
    ?.getDeclarations()
    ?.filter((declaration) => ts.isInterfaceDeclaration(declaration));
  const parentIdx = baseNames.length === 1 ? ctx.structMap.get(baseNames[0]!) : undefined;
  const parentFields = baseNames.length === 1 ? ctx.structFields.get(baseNames[0]!) : undefined;
  const canLinkNominally =
    baseNames.length === 1 &&
    declarations?.length === 1 &&
    baseDeclarations?.length === 1 &&
    interfaceHasStablePhysicalLayout(ctx, baseTypes[0]!) &&
    parentIdx !== undefined &&
    parentIdx < ctx.mod.types.length &&
    parentFields !== undefined;
  const canAliasMergedPhantom =
    baseNames.length === 1 &&
    declarations !== undefined &&
    declarations.length > 1 &&
    baseDeclarations?.length === 1 &&
    interfaceHasStablePhysicalLayout(ctx, interfaceType) &&
    interfaceHasStablePhysicalLayout(ctx, baseTypes[0]!) &&
    interfaceType.getProperties().some((property) => isRuntimeErasedNominalBrand(ctx, property)) &&
    parentIdx !== undefined &&
    parentIdx < ctx.mod.types.length &&
    parentFields !== undefined;
  const inheritedNames = new Set<string>();
  if (canLinkNominally || canAliasMergedPhantom) {
    for (const parentField of parentFields) {
      inheritedNames.add(parentField.name);
      fields.push({ ...parentField, type: { ...parentField.type } });
    }
  }

  for (const prop of properties) {
    if (inheritedNames.has(prop.name)) continue;
    const memberType = ctx.checker.getTypeOfSymbol(prop);
    const wasmType = mapDeclaredFieldType(ctx, memberType);
    fields.push({
      name: prop.name,
      type: wasmType,
      mutable: true,
    });
  }

  if (
    canAliasMergedPhantom &&
    parentIdx !== undefined &&
    parentFields !== undefined &&
    fields.length === parentFields.length &&
    fields.every((field, index) => {
      const parentField = parentFields[index];
      return (
        parentField !== undefined &&
        field.name === parentField.name &&
        field.mutable === parentField.mutable &&
        samePhysicalValType(field.type, parentField.type)
      );
    })
  ) {
    // This interface is a checker-only view of its single physical parent:
    // after nominal brand erasure it contributes no runtime field. Reusing the
    // parent's exact type index is what preserves identity across sibling views
    // such as Token -> TypeNode; two separately-declared WasmGC siblings remain
    // nominally distinct when emitted in the same recursive type group even if
    // their layouts are textually identical.
    sealNominalStructParent(ctx, parentIdx);
    ctx.structMap.set(name, parentIdx);
    ctx.structFields.set(name, parentFields);
    return;
  }

  if (canLinkNominally && parentIdx !== undefined) {
    // This is deliberately monotonic and precedes body compilation. Later
    // multi-source resolution may temporarily detach/rebuild the physical edge;
    // dynamic field discovery must still treat the intended parent as frozen.
    sealNominalStructParent(ctx, parentIdx);
  }

  const typeIdx = registerStructType(ctx, name, fields);
  const registrations = registeredInterfaces.get(ctx) ?? [];
  registrations.push({
    decl,
    name,
    typeIdx,
    baseNames,
    // WasmGC has one nominal parent. Multiple inheritance and declaration
    // merging remain flattened structural shapes rather than guessing a
    // hierarchy whose mutable-field contract may not represent TypeScript.
    canLinkNominally,
    inheritedPrefixLength: canLinkNominally ? (parentFields?.length ?? 0) : 0,
  });
  registeredInterfaces.set(ctx, registrations);
}

function physicalInterfacePropertySymbol(ctx: CodegenContext, symbol: ts.Symbol): boolean {
  // TypeScript uses `_...Brand`/`__...Brand` property signatures to make
  // otherwise-structural compiler types nominal to the checker. Those marker
  // properties are never materialized on JavaScript values (the compiler's
  // own Node declarations explicitly describe them as zero-runtime-cost), so
  // giving them WasmGC fields invents state and separates runtime-identical
  // views such as Token and TypeNode. Keep implemented class/object properties
  // physical; this erasure is limited to interface signatures.
  if (isRuntimeErasedNominalBrand(ctx, symbol)) return false;
  return (
    symbol
      .getDeclarations()
      ?.some((declaration) => ts.isPropertySignature(declaration) || ts.isMethodSignature(declaration)) === true
  );
}

function interfaceBaseTypes(ctx: CodegenContext, type: ts.Type): readonly ts.BaseType[] {
  if (!(type.flags & ts.TypeFlags.Object)) return [];
  const objectType = type as ts.InterfaceType;
  if (!(objectType.objectFlags & ts.ObjectFlags.Interface)) return [];
  const bases = ctx.checker.getBaseTypes(objectType) ?? [];
  // A merged interface may repeat the same `extends Base` clause in each
  // constituent. The checker exposes those as duplicate base Type objects;
  // semantically that is still one parent, not TypeScript multiple
  // inheritance. Deduplicate only exact checker Type identity so distinct
  // generic instantiations of the same base symbol remain flattened.
  return bases.filter((base, index) => bases.indexOf(base) === index);
}

/**
 * Whether an interface's physical field prefix is complete during declaration
 * collection. Method/index/call signatures are materialized lazily by later
 * property codegen; using such an interface as a WasmGC parent would let its
 * field list grow after a child has copied the prefix. Require the whole base
 * chain to consist only of property signatures before admitting nominal
 * linkage. Declaration merging is safe when every constituent meets that same
 * restriction: the checker has already supplied the merged property set.
 */
function interfaceHasStablePhysicalLayout(ctx: CodegenContext, type: ts.Type, visiting = new Set<ts.Type>()): boolean {
  // `visiting` is the active recursion stack, not a global visited set. A
  // diamond such as LiteralExpression -> LiteralLikeNode/PrimaryExpression ->
  // Node legitimately reaches Node twice; only reaching a type that is still
  // active denotes a cycle. Treating the completed first branch as a cycle
  // flattened TypeScript's StringLiteral and lost its LiteralExpression
  // runtime identity at the parser's generic return boundary.
  if (visiting.has(type)) return false;
  visiting.add(type);
  try {
    const declarations = type
      .getSymbol()
      ?.getDeclarations()
      ?.filter((declaration): declaration is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(declaration));
    if (!declarations?.length) return false;
    if (!declarations.every((declaration) => declaration.members.every((member) => ts.isPropertySignature(member)))) {
      return false;
    }
    return interfaceBaseTypes(ctx, type).every((base) => interfaceHasStablePhysicalLayout(ctx, base, visiting));
  } finally {
    visiting.delete(type);
  }
}

/**
 * Return every property or method signature in an interface, including
 * inherited ones. A method signature is still a runtime-valued property when
 * an object literal implements the interface (`{ read, write }`); deferring
 * that field until the first member access grows the struct only after the
 * literal has been emitted, so the late-field patch can supply only null.
 * Names follow base-before-derived order. The final interface's symbols retain
 * logical TypeScript override types; `collectInterface` replaces the inherited
 * prefix with the registered parent's physical fields when nominal linking is
 * representable.
 */
function orderedInterfaceProperties(ctx: CodegenContext, type: ts.Type): ts.Symbol[] {
  const finalProperties = new Map(
    type
      .getProperties()
      .filter((property) => physicalInterfacePropertySymbol(ctx, property))
      .map((property) => [property.name, property] as const),
  );
  const orderedNames: string[] = [];
  const seenNames = new Set<string>();
  const seenTypes = new Set<ts.Type>();

  const visit = (current: ts.Type): void => {
    if (seenTypes.has(current)) return;
    seenTypes.add(current);
    for (const base of interfaceBaseTypes(ctx, current)) visit(base);
    for (const property of current.getProperties()) {
      if (!physicalInterfacePropertySymbol(ctx, property) || seenNames.has(property.name)) continue;
      seenNames.add(property.name);
      orderedNames.push(property.name);
    }
  };

  visit(type);
  return orderedNames.map((name) => finalProperties.get(name)).filter((property): property is ts.Symbol => !!property);
}

function wouldCreateStructCycle(ctx: CodegenContext, childIdx: number, parentIdx: number): boolean {
  for (let current = parentIdx, depth = 0; depth < ctx.mod.types.length; depth++) {
    if (current === childIdx) return true;
    const currentType = ctx.mod.types[current];
    if (!currentType || currentType.kind !== "struct") return false;
    const next = currentType.superTypeIdx;
    if (next === undefined || next < 0) return false;
    current = next;
  }
  return true;
}

/**
 * Link the first compatible `extends` target as the nominal WasmGC parent.
 * A forward parent type cannot be named as a supertype outside a recursive
 * group, so that uncommon declaration order keeps the structural-copy path.
 */
function linkInterfaceStructHierarchies(ctx: CodegenContext): void {
  for (const registration of registeredInterfaces.get(ctx) ?? []) {
    if (ctx.structMap.get(registration.name) !== registration.typeIdx) continue;
    const child = ctx.mod.types[registration.typeIdx];
    if (!child || child.kind !== "struct") continue;

    if (!registration.canLinkNominally) {
      // WasmGC has only one nominal parent, but a flattened multiple-heritage
      // interface can still have one unambiguous physical ancestor. This is
      // common in TypeScript's syntax hierarchy: `Identifier` extends the
      // brand-only `PrimaryExpression` chain plus several marker/container
      // interfaces. Keeping Identifier flat makes the runtime value fail an
      // otherwise-valid Identifier -> Expression argument cast.
      //
      // Admit only stable, unmerged declared bases and let the shared layout
      // helper require an exact mutable-field prefix. The largest compatible
      // prefix wins; other TypeScript bases continue to use structural
      // projection, so no multiple-inheritance relationship is invented.
      const interfaceType = ctx.checker.getTypeAtLocation(registration.decl);
      const declarations = interfaceType
        .getSymbol()
        ?.getDeclarations()
        ?.filter((declaration) => ts.isInterfaceDeclaration(declaration));
      if (registration.baseNames.length > 1 && declarations?.length === 1) {
        const candidateParentIdxs = interfaceBaseTypes(ctx, interfaceType)
          .filter((base) => {
            const baseDeclarations = base
              .getSymbol()
              ?.getDeclarations()
              ?.filter((declaration) => ts.isInterfaceDeclaration(declaration));
            return baseDeclarations?.length === 1 && interfaceHasStablePhysicalLayout(ctx, base);
          })
          .map((base) => base.getSymbol()?.name)
          .map((baseName) => (baseName === undefined ? undefined : ctx.structMap.get(baseName)))
          .filter((parentIdx): parentIdx is number => parentIdx !== undefined);
        linkCompatibleDeclaredStructAncestor(ctx, registration.typeIdx, candidateParentIdxs);
      }
      continue;
    }

    if (registration.linkedParentIdx !== undefined) {
      const oldParentIdx = registration.linkedParentIdx;
      const oldParent = ctx.mod.types[oldParentIdx];
      if (
        child.superTypeIdx === oldParentIdx &&
        oldParent?.kind === "struct" &&
        hasStructPrefix(child, oldParent) &&
        !wouldCreateStructCycle(ctx, registration.typeIdx, oldParentIdx)
      ) {
        continue;
      }

      if (child.superTypeIdx === oldParentIdx) child.superTypeIdx = undefined;
      if (
        registration.openedParent &&
        oldParent?.kind === "struct" &&
        oldParent.superTypeIdx === -1 &&
        !ctx.mod.types.some(
          (candidate, candidateIdx) =>
            candidateIdx !== registration.typeIdx &&
            candidate.kind === "struct" &&
            candidate.superTypeIdx === oldParentIdx,
        )
      ) {
        oldParent.superTypeIdx = undefined;
      }
      registration.linkedParentIdx = undefined;
      registration.openedParent = undefined;
    }

    // A different subsystem already owns this hierarchy edge.
    if (child.superTypeIdx !== undefined) continue;

    const parentIdx = ctx.structMap.get(registration.baseNames[0]!);
    if (parentIdx === undefined || parentIdx >= registration.typeIdx) continue;
    const parent = ctx.mod.types[parentIdx];
    if (!parent || parent.kind !== "struct") continue;
    if (!hasStructPrefix(child, parent) || wouldCreateStructCycle(ctx, registration.typeIdx, parentIdx)) continue;

    registration.openedParent = parent.superTypeIdx === undefined;
    if (registration.openedParent) parent.superTypeIdx = -1;
    child.superTypeIdx = parentIdx;
    registration.linkedParentIdx = parentIdx;
  }
}

function resolveFieldsFromProperties(
  ctx: CodegenContext,
  fields: FieldDef[],
  structTypeIdx: number,
  properties: readonly ts.Symbol[],
  startIndex = 0,
): void {
  const propertiesByName = new Map(properties.map((property) => [property.name, property] as const));
  let changed = false;
  for (let fieldIdx = startIndex; fieldIdx < fields.length; fieldIdx++) {
    const field = fields[fieldIdx]!;
    const mayBeHostBigInt = usesHostBigIntCarrier(ctx) && field.type.kind === "i64" && field.type.bigint === true;
    if (field.type.kind !== "externref" && !mayBeHostBigInt) continue;

    const property = propertiesByName.get(field.name);
    if (!property) continue;
    const resolved = resolveWasmType(ctx, ctx.checker.getTypeOfSymbol(property));
    if (resolved.kind === "ref" || resolved.kind === "ref_null" || (mayBeHostBigInt && resolved.kind === "externref")) {
      field.type = resolved;
      changed = true;
    }
  }

  if (!changed) return;
  const typeDef = ctx.mod.types[structTypeIdx];
  if (typeDef && typeDef.kind === "struct") typeDef.fields = fields;
}

/**
 * After all interfaces and type aliases are collected, re-resolve field types
 * that were initially mapped to externref but should be ref $struct.
 * This handles cross-references between interfaces regardless of declaration order.
 */
export function resolveStructFieldTypes(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  // Revisit all interfaces observed so far. This is necessary for both
  // inherited property signatures and references to a struct registered in a
  // later source file; `decl.members` can see neither case reliably.
  for (const registration of registeredInterfaces.get(ctx) ?? []) {
    if (ctx.structMap.get(registration.name) !== registration.typeIdx) continue;
    const typeDef = ctx.mod.types[registration.typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    const interfaceType = ctx.checker.getTypeAtLocation(registration.decl);

    if (registration.canLinkNominally && registration.inheritedPrefixLength > 0) {
      const parentIdx = ctx.structMap.get(registration.baseNames[0]!);
      const parent = parentIdx === undefined ? undefined : ctx.mod.types[parentIdx];
      if (parent?.kind === "struct" && parent.fields.length === registration.inheritedPrefixLength) {
        for (let fieldIdx = 0; fieldIdx < registration.inheritedPrefixLength; fieldIdx++) {
          const parentField = parent.fields[fieldIdx]!;
          typeDef.fields[fieldIdx] = { ...parentField, type: { ...parentField.type } };
        }
      }
    }
    resolveFieldsFromProperties(
      ctx,
      typeDef.fields,
      registration.typeIdx,
      orderedInterfaceProperties(ctx, interfaceType),
      registration.inheritedPrefixLength,
    );
  }

  for (const stmt of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(stmt)) continue;

    const name = stmt.name.text;
    const fields = ctx.structFields.get(name);
    const structTypeIdx = ctx.structMap.get(name);
    if (!fields || structTypeIdx === undefined) continue;
    const aliasType = ctx.checker.getTypeAtLocation(stmt);
    resolveFieldsFromProperties(ctx, fields, structTypeIdx, aliasType.getProperties());
  }

  // Field resolution must precede prefix comparison: mutable WasmGC fields are
  // invariant, so an externref/ref discrepancy is not a representable parent.
  linkInterfaceStructHierarchies(ctx);
}

/**
 * (#4493) Publish every user-declared STRUCTURAL shape (interface / object
 * type alias) into the anonymous-struct dedup index, so an object literal with
 * exactly that shape reuses the declared struct instead of minting a duplicate
 * `__anon_N`.
 *
 * ## The defect
 *
 * TypeScript gives a nested object literal its OWN fresh anonymous type even
 * when a named type contextually types it — `{ a: { arity: 1 } }` under
 * `Record<string, ExportSignature>` has property `a` typed as the fresh
 * `{ arity: number }`, not as `ExportSignature`. `ensureStructForType` deduped
 * that only against other ANONYMOUS shapes, so the module carried two struct
 * types for one declared shape: `$ExportSignature` and `__anon_N`.
 *
 * That was invisible while WasmGC canonicalization merged them — identical
 * layouts are ONE runtime type. The #2853 shape-branding pass then appended a
 * `$shapeBrand` field to the `__anon_N` half (it "collides" with
 * `$ExportSignature` under the shallow layout key), making the two nominally
 * distinct. From then on every consumer typed by the DECLARED name — a
 * parameter, an annotated local, or the value slot of a destructured
 * `Object.entries` pair — failed its `ref.test` (→ null → "Cannot access
 * property on null or undefined" / null-deref) or its `ref.cast`
 * (→ "illegal cast").
 *
 * ## Why here and not in the brand pass
 *
 * Refining branding cannot fix it: a shape must be branded apart from any
 * same-layout DIFFERENTLY-keyed shape, and one such shape anywhere in the
 * module re-separates the `__anon_N` half from its declared twin. The duplicate
 * type is the defect; not minting it is the fix. It also makes the nested case
 * behave exactly like the directly-annotated one, which already resolves to the
 * declared struct (`const s: ExportSignature = { arity: 5 }` →
 * `struct.new $ExportSignature`).
 *
 * Scope: only shapes registered by `collectInterface` / `collectObjectType` —
 * i.e. INTERFACES and object TYPE ALIASES from user (non-`.d.ts`) source. Class
 * structs are nominal (subtyping, methods, `instanceof`) and compiler carriers
 * (`__Date`, vec/arr, tuples, iterator records) are internal, so neither is
 * published. An empty shape is skipped too: it would swallow every `{}`.
 * Existing keys are never overwritten, so declaration order decides ties.
 *
 * Must run AFTER `resolveStructFieldTypes`, whose externref → `ref $Struct`
 * re-resolution changes the very field types the key is built from.
 */
export function publishDeclaredShapesForDedup(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  if (sourceFile.isDeclarationFile) return;
  for (const stmt of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(stmt) && !ts.isTypeAliasDeclaration(stmt)) continue;
    const name = stmt.name.text;
    if (ctx.structMap.get(name) === undefined) continue;
    const fields = ctx.structFields.get(name);
    if (!fields || fields.length === 0) continue;
    const key = fieldsHashKey(fields);
    if (ctx.anonStructHash.has(key)) continue;
    ctx.anonStructHash.set(key, name);
  }
}

export function collectObjectType(ctx: CodegenContext, name: string, type: ts.Type): void {
  // A homomorphic `-readonly` alias is only a compile-time mutability view.
  // resolveWasmType and ensureStructForType canonicalize its instantiations to
  // the source type; declaration collection must likewise avoid publishing a
  // phantom named struct for the generic alias itself.
  if (readonlyErasureMappedAliasTarget(type)) return;

  const fields: FieldDef[] = [];
  for (const prop of type.getProperties()) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    const wasmType = mapDeclaredFieldType(ctx, propType);
    fields.push({
      name: prop.name,
      type: wasmType,
      mutable: true,
    });
  }

  if (fields.length > 0) {
    registerStructType(ctx, name, fields);
  }
}
