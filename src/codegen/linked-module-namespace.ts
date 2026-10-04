// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { pushBody, popBody } from "./context/bodies.js";
import { allocLocal } from "./context/locals.js";
import { coerceType } from "./shared.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

/** Resolve an imported value by declaration identity, including re-export aliases. */
export function linkedModuleImportedBinding(
  ctx: CodegenContext,
  id: ts.Identifier,
): { name: string; key: string } | undefined {
  if (!ctx.standaloneModuleNamespaceImports) return undefined;
  const alias = ctx.checker.getSymbolAtLocation(id);
  if (!alias || (alias.flags & ts.SymbolFlags.Alias) === 0) return undefined;
  const declaration = alias.declarations?.[0];
  if (!declaration || !(ts.isImportSpecifier(declaration) || ts.isImportClause(declaration))) return undefined;
  if (declaration.isTypeOnly || (ts.isImportSpecifier(declaration) && declaration.parent.parent.isTypeOnly))
    return undefined;
  const target = ctx.checker.getAliasedSymbol(alias);
  const source = target.valueDeclaration?.getSourceFile() ?? target.declarations?.[0]?.getSourceFile();
  if (!source || source.isDeclarationFile) return undefined;
  const name = linkedModuleNamespaceName(ctx, source);
  const moduleSymbol = (source as unknown as { symbol?: ts.Symbol }).symbol;
  if (name === undefined || moduleSymbol === undefined) return undefined;
  const exported = ctx.checker
    .getExportsOfModule(moduleSymbol)
    .find(
      (symbol) =>
        ((symbol.flags & ts.SymbolFlags.Alias) !== 0 ? ctx.checker.getAliasedSymbol(symbol) : symbol) === target,
    );
  return exported ? { name, key: exported.getName() } : undefined;
}

export function linkedModuleCall(ctx: CodegenContext, callee: ts.Expression): boolean {
  if (!ctx.standaloneModuleNamespaceImports) return false;
  while (
    ts.isPropertyAccessExpression(callee) ||
    ts.isElementAccessExpression(callee) ||
    ts.isParenthesizedExpression(callee) ||
    ts.isAsExpression(callee) ||
    ts.isTypeAssertionExpression(callee) ||
    ts.isNonNullExpression(callee)
  )
    callee = callee.expression;
  if (!ts.isIdentifier(callee)) return false;
  if (linkedModuleImportedBinding(ctx, callee)) return true;
  return linkedModuleNamespaceBinding(ctx, callee, "") !== undefined;
}

/** Resolve the namespace's native owner, rather than a re-export's source. */
export function linkedModuleNamespaceBinding(
  ctx: CodegenContext,
  identifier: ts.Identifier,
  key: string,
): { name: string; key: string } | undefined {
  if (!ctx.standaloneModuleNamespaceImports) return undefined;
  const alias = ctx.checker.getSymbolAtLocation(identifier);
  if (!alias || (alias.flags & ts.SymbolFlags.Alias) === 0) return undefined;
  const target = ctx.checker.getAliasedSymbol(alias);
  const source = target.declarations?.find(ts.isSourceFile);
  const name = source === undefined ? undefined : linkedModuleNamespaceName(ctx, source);
  return name === undefined ? undefined : { name, key };
}

export function emitLinkedModuleImportRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  binding: { name: string; key: string },
  fallback: () => ValType | null,
): ValType | null {
  reserveLinkedModuleNamespace(ctx, binding.name);
  ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  const key = stringConstantExternrefInstrs(ctx, binding.key);
  flushLateImportShifts(ctx, fctx);
  const saved = pushBody(fctx);
  fctx.blockDepth++;
  let type: ValType | null;
  try {
    type = fallback();
    if (type !== null && type.kind !== "externref") coerceType(ctx, fctx, type, { kind: "externref" });
  } finally {
    fctx.blockDepth--;
  }
  const body = fctx.body;
  popBody(fctx, saved);
  if (type === null) {
    fctx.body.push(...body);
    return null;
  }
  const namespace = allocLocal(fctx, "__linked_module_namespace", { kind: "externref" });
  const capability = ctx.funcMap.get(binding.name);
  const get = ctx.funcMap.get("__extern_get");
  if (capability === undefined || get === undefined) throw new Error("Live module import helpers were not retained");
  fctx.body.push(
    { op: "call", funcIdx: capability },
    { op: "local.tee", index: namespace },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: body,
      else: [{ op: "local.get", index: namespace }, ...key, { op: "call", funcIdx: get }],
    },
  );
  return { kind: "externref" };
}

export function linkedModuleNamespaceName(ctx: CodegenContext, source: ts.SourceFile): string | undefined {
  const provider = ctx.standaloneModuleNamespaceImports;
  if (!provider) return undefined;
  const name = provider.sources[source.fileName];
  if (name === undefined) return undefined;
  if (!ctx.standalone || !ctx.standaloneGlobalThisImport) {
    throw new Error("Module namespace capabilities require a shared standalone realm");
  }
  return name;
}

export function reserveLinkedModuleNamespace(ctx: CodegenContext, name: string): void {
  ensureLateImport(ctx, name, [], [{ kind: "externref" }], ctx.standaloneModuleNamespaceImports!.module);
}

/** Construct the guard before Prepared body identity and resource evidence
 * are sealed. Reservation belongs to preallocation, not this lowering step. */
export function preparedLinkedModuleInitializerBody(
  ctx: CodegenContext,
  source: ts.SourceFile,
  body: Instr[],
): Instr[] {
  const name = linkedModuleNamespaceName(ctx, source);
  if (name === undefined) return body;
  const index = ctx.funcMap.get(name);
  if (index === undefined) throw new Error("Prepared module namespace capability was not reserved");
  return [
    { op: "call", funcIdx: index },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: body, else: [] },
  ];
}

/** Preserve statement scope and ordering while skipping evaluated owners. */
export function withLinkedModuleInitializer(
  ctx: CodegenContext,
  fctx: FunctionContext,
  source: ts.SourceFile,
  emit: () => void,
): void {
  const name = linkedModuleNamespaceName(ctx, source);
  if (name === undefined) {
    emit();
    return;
  }
  reserveLinkedModuleNamespace(ctx, name);
  flushLateImportShifts(ctx, fctx);
  const saved = pushBody(fctx);
  fctx.blockDepth++;
  try {
    emit();
  } finally {
    fctx.blockDepth--;
  }
  const body = fctx.body;
  popBody(fctx, saved);
  const index = ctx.funcMap.get(name);
  if (index === undefined) throw new Error("Module namespace capability was not retained");
  fctx.body.push(
    { op: "call", funcIdx: index },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: body,
      else: [],
    },
  );
}
