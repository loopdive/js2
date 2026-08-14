// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pre-emission ABI finalization for class-owned callables.
 *
 * Prepared IR and the temporary direct route consume the same allocator-owned
 * slots. Neither backend may discover or repair their signatures while
 * emitting a source body. All type identity crosses the TypeOracle boundary;
 * this planning phase never reads the TypeScript checker directly.
 */
import type { FuncTypeDef, ValType, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { findConstructorImplementation, hasStaticModifier } from "./ast-modifiers.js";
import { classMemberFuncKey } from "./class-member-keys.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

function hasFixedForwardClassAbiParameters(parameters: readonly ts.ParameterDeclaration[]): boolean {
  return parameters.every(
    (parameter) =>
      ts.isIdentifier(parameter.name) &&
      parameter.dotDotDotToken === undefined &&
      parameter.questionToken === undefined &&
      parameter.initializer === undefined,
  );
}

function hasClassCallableModifier(
  node: ts.Node & { readonly modifiers?: ts.NodeArray<ts.ModifierLike> },
  kind: ts.SyntaxKind,
): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === kind) === true;
}

function forwardLocalClassRef(
  ctx: CodegenContext,
  owner: ts.ClassDeclaration,
  typeNode: ts.TypeNode | undefined,
): ValType | undefined {
  const identity = ctx.irPlanningIdentityContext;
  if (!identity || !typeNode || !ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
    return undefined;
  }
  const declaration = ctx.oracle
    .declarationsOf(typeNode.typeName)
    .find((candidate): candidate is ts.ClassDeclaration => ts.isClassDeclaration(candidate));
  if (
    !declaration?.name ||
    declaration.getSourceFile() !== owner.getSourceFile() ||
    declaration.getStart(owner.getSourceFile()) <= owner.getStart(owner.getSourceFile())
  ) {
    return undefined;
  }
  const classId = identity.classIdByDeclaration.get(declaration);
  if (classId === undefined || identity.declarationByClassId.get(classId) !== declaration) return undefined;
  const typeIdx = ctx.structMap.get(declaration.name.text);
  return typeIdx === undefined ? undefined : { kind: "ref", typeIdx };
}

function classCallable(
  ctx: CodegenContext,
  fullName: string,
): { readonly func: WasmFunction; readonly signature: FuncTypeDef } | undefined {
  const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName));
  const func = funcIdx === undefined ? undefined : definedFuncAt(ctx, funcIdx);
  const signature = func === undefined ? undefined : ctx.mod.types[func.typeIdx];
  return func && signature?.kind === "func" ? { func, signature } : undefined;
}

function setFinalClassCallableType(
  ctx: CodegenContext,
  fullName: string,
  func: WasmFunction,
  params: readonly ValType[],
  results: readonly ValType[],
): void {
  func.typeIdx = addFuncType(ctx, [...params], [...results], `${fullName}_type`);
}

function replaceForwardParameters(
  ctx: CodegenContext,
  owner: ts.ClassDeclaration,
  declarations: readonly ts.ParameterDeclaration[],
  existing: readonly ValType[],
  offset: number,
): { readonly params: ValType[]; readonly changed: boolean } {
  const params = [...existing];
  let changed = false;
  for (const [index, declaration] of declarations.entries()) {
    const projected = forwardLocalClassRef(ctx, owner, declaration.type);
    if (projected === undefined) continue;
    params[index + offset] = projected;
    changed = true;
  }
  return { params, changed };
}

/**
 * Finalize callable slots whose fixed source ABI refers to a later local class.
 *
 * Class collection reserves slots in source order before the later class struct
 * exists, so those positions are provisionally `externref`. This pass replaces
 * only exact forward-class positions in the already-resolved signature. Every
 * unrelated primitive/native/dynamic position stays byte-for-byte unchanged.
 */
export function finalizeForwardClassCallableAbis(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  if (!ctx.irPlanningIdentityContext) return;
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    const className = statement.name.text;
    const structTypeIdx = ctx.structMap.get(className);
    if (structTypeIdx === undefined || ctx.classExternrefBackedSet.has(className)) continue;
    const receiver: ValType = { kind: "ref", typeIdx: structTypeIdx };

    const ctor = findConstructorImplementation(statement);
    const newName = `${className}_new`;
    const newCallable = classCallable(ctx, newName);
    if (ctor && newCallable && hasFixedForwardClassAbiParameters(ctor.parameters)) {
      const replacement = replaceForwardParameters(ctx, statement, ctor.parameters, newCallable.signature.params, 0);
      if (replacement.changed) {
        setFinalClassCallableType(ctx, newName, newCallable.func, replacement.params, [receiver]);
        const initName = `${className}_init`;
        const initCallable = classCallable(ctx, initName);
        if (initCallable) {
          setFinalClassCallableType(ctx, initName, initCallable.func, [...replacement.params, receiver], [receiver]);
        }
      }
    }

    const methodKinds = new Map<string, number>();
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
      methodKinds.set(member.name.text, (methodKinds.get(member.name.text) ?? 0) | (hasStaticModifier(member) ? 2 : 1));
    }

    for (const member of statement.members) {
      if (
        ts.isMethodDeclaration(member) &&
        member.body &&
        ts.isIdentifier(member.name) &&
        !member.asteriskToken &&
        !hasClassCallableModifier(member, ts.SyntaxKind.AsyncKeyword) &&
        !hasClassCallableModifier(member, ts.SyntaxKind.AbstractKeyword) &&
        methodKinds.get(member.name.text) !== 3 &&
        hasFixedForwardClassAbiParameters(member.parameters)
      ) {
        const fullName = `${className}_${member.name.text}`;
        const callable = classCallable(ctx, fullName);
        if (!callable) continue;
        const replacement = replaceForwardParameters(
          ctx,
          statement,
          member.parameters,
          callable.signature.params,
          hasStaticModifier(member) ? 0 : 1,
        );
        const result = forwardLocalClassRef(ctx, statement, member.type);
        if (replacement.changed || result !== undefined) {
          setFinalClassCallableType(
            ctx,
            fullName,
            callable.func,
            replacement.params,
            result === undefined ? callable.signature.results : [result],
          );
        }
        continue;
      }
      if (
        ts.isGetAccessorDeclaration(member) &&
        member.body &&
        ts.isIdentifier(member.name) &&
        !hasStaticModifier(member)
      ) {
        const result = forwardLocalClassRef(ctx, statement, member.type);
        const fullName = `${className}_get_${member.name.text}`;
        const callable = result === undefined ? undefined : classCallable(ctx, fullName);
        if (result && callable)
          setFinalClassCallableType(ctx, fullName, callable.func, callable.signature.params, [result]);
        continue;
      }
      if (
        ts.isSetAccessorDeclaration(member) &&
        member.body &&
        ts.isIdentifier(member.name) &&
        !hasStaticModifier(member) &&
        member.parameters.length === 1 &&
        hasFixedForwardClassAbiParameters(member.parameters)
      ) {
        const fullName = `${className}_set_${member.name.text}`;
        const callable = classCallable(ctx, fullName);
        if (!callable) continue;
        const replacement = replaceForwardParameters(ctx, statement, member.parameters, callable.signature.params, 1);
        if (replacement.changed) setFinalClassCallableType(ctx, fullName, callable.func, replacement.params, []);
      }
    }
  }
}
