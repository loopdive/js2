// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Interface- and object-type -> WasmGC struct registration. Maps TS members to
 * FieldDef[] and pushes a struct type. Extracted verbatim from
 * codegen/declarations.ts (#3268).
 */
import { mapTsTypeToWasm } from "../../checker/type-mapper.js";
import { ts } from "../../ts-api.js";
import { fieldsHashKey, resolveWasmType } from "../index.js";
import { registerStructType } from "../registry/types.js";
import type { FieldDef } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

export function collectInterface(ctx: CodegenContext, decl: ts.InterfaceDeclaration): void {
  const name = decl.name.text;
  const fields: FieldDef[] = [];

  for (const member of decl.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const memberName = (member.name as ts.Identifier).text;
      const memberType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(memberType, ctx.checker);
      fields.push({
        name: memberName,
        type: wasmType,
        mutable: true,
      });
    }
  }

  registerStructType(ctx, name, fields);
}

/**
 * After all interfaces and type aliases are collected, re-resolve field types
 * that were initially mapped to externref but should be ref $struct.
 * This handles cross-references between interfaces regardless of declaration order.
 */
export function resolveStructFieldTypes(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  for (const stmt of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(stmt) && !ts.isTypeAliasDeclaration(stmt)) continue;

    const name = ts.isInterfaceDeclaration(stmt) ? stmt.name.text : stmt.name.text;
    const fields = ctx.structFields.get(name);
    const structTypeIdx = ctx.structMap.get(name);
    if (!fields || structTypeIdx === undefined) continue;

    let changed = false;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      if (field.type.kind !== "externref") continue;

      // Try to re-resolve using resolveWasmType which knows about structs
      let memberTsType: ts.Type | undefined;
      if (ts.isInterfaceDeclaration(stmt)) {
        for (const member of stmt.members) {
          if (ts.isPropertySignature(member) && member.name) {
            const memberName = (member.name as ts.Identifier).text;
            if (memberName === field.name) {
              memberTsType = ctx.checker.getTypeAtLocation(member);
              break;
            }
          }
        }
      } else {
        const aliasType = ctx.checker.getTypeAtLocation(stmt);
        const props = aliasType.getProperties();
        for (const prop of props) {
          if (prop.name === field.name) {
            memberTsType = ctx.checker.getTypeOfSymbol(prop);
            break;
          }
        }
      }

      if (!memberTsType) continue;
      const resolved = resolveWasmType(ctx, memberTsType);
      if (resolved.kind === "ref" || resolved.kind === "ref_null") {
        field.type = resolved;
        changed = true;
      }
    }

    // If any fields changed, update the type definition in mod.types too
    if (changed) {
      const typeDef = ctx.mod.types[structTypeIdx];
      if (typeDef && typeDef.kind === "struct") {
        (typeDef as any).fields = fields;
      }
    }
  }
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
  const fields: FieldDef[] = [];
  for (const prop of type.getProperties()) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    const wasmType = mapTsTypeToWasm(propType, ctx.checker);
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
