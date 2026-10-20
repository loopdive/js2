// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { IrValueId } from "./core/nodes.js";
import { irDynamic, irSupportRef, irVal, type IrType } from "./core/types.js";
import type { IrJsClassBody, IrJsClassBindingStorage } from "./js-class-contracts.js";
import type { IrFunctionBuilder } from "./builder.js";
import { JS_TAG_IDS } from "./js-tag-domain.js";
import { IrUnsupportedError } from "./outcomes.js";
import { irJsClassDefinitionBindingId } from "./program/js-class-definition.js";
import {
  assertSourceJsClassDefinitionsCurrent,
  type SourceJsClassDefinitions,
  type SourceJsClassDefinitionPlan,
} from "./source-js-class-definition.js";

export interface NativeJsClassSourceContext {
  readonly plans: SourceJsClassDefinitions;
  readonly checker: ts.TypeChecker;
  readonly builder: IrFunctionBuilder;
  readonly plan?: SourceJsClassDefinitionPlan;
  readonly body?: IrJsClassBody;
  readonly frame?: IrValueId;
}
export function refuseNativeJsClassSource(node: ts.Node, detail: string): never {
  const source = node.getSourceFile(),
    point = source.getLineAndCharacterOfPosition(node.getStart(source));
  throw new IrUnsupportedError(
    "class-member-unsupported",
    "build",
    `native JS class ${source.fileName}:${point.line + 1}:${point.character + 1}: ${detail}`,
  );
}
function defined(value: IrValueId | null): IrValueId {
  if (value === null) throw new Error("native JS class result was not produced");
  return value;
}
function sourcePlan(node: ts.Expression, cx: NativeJsClassSourceContext): SourceJsClassDefinitionPlan | undefined {
  let symbol = cx.checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = cx.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  return cx.plans.plans.find((plan) => plan.declaration === declaration);
}
function managed(type: IrType): boolean {
  return type.kind === "support-ref";
}
/** Store a genuine immutable tagged value; the box has its own real allocation occurrence. */
export function nativeJsClassStoredValue(node: ts.Node, builder: IrFunctionBuilder, value: IrValueId): IrValueId {
  const type = builder.typeOf(value);
  if (type.kind === "dynamic") return value;
  if (type.kind === "val" && type.val.kind === "f64") return builder.emitBox(value, irDynamic(JS_TAG_IDS.NumberF64));
  if (type.kind === "val" && type.val.kind === "i32" && type.val.boolean)
    return builder.emitBox(value, irDynamic(JS_TAG_IDS.Boolean));
  return refuseNativeJsClassSource(node, "stored value needs its genuine tagged object/string/symbol carrier");
}

/** Native class protocols intercept original expressions before annotation-based nominal folding. */
export function lowerNativeJsClassExpression(
  expression: ts.Expression,
  cx: NativeJsClassSourceContext,
  lower: (node: ts.Expression, hint: IrType) => IrValueId,
): IrValueId | undefined {
  const builder = cx.builder,
    plan = cx.plan,
    body = cx.body;
  if (expression.kind === ts.SyntaxKind.ThisKeyword && plan && body && cx.frame !== undefined)
    return defined(
      builder.emitJsClassInstruction(
        { kind: "js.class.frame.get", frame: cx.frame, access: { kind: "this" } },
        body.frame.thisType,
      ),
    );
  if (
    ts.isMetaProperty(expression) &&
    expression.keywordToken === ts.SyntaxKind.NewKeyword &&
    expression.name.text === "target" &&
    body &&
    cx.frame !== undefined
  )
    return defined(
      builder.emitJsClassInstruction(
        { kind: "js.class.frame.get", frame: cx.frame, access: { kind: "new-target" } },
        body.frame.newTargetType,
      ),
    );
  if (
    ts.isIdentifier(expression) &&
    expression.text === "undefined" &&
    !cx.checker.getSymbolAtLocation(expression)?.valueDeclaration
  )
    return builder.emitConst({ kind: "undefined" }, irDynamic(JS_TAG_IDS.Undefined));
  if (ts.isIdentifier(expression)) {
    const classPlan = sourcePlan(expression, cx);
    if (classPlan) {
      let storage: IrJsClassBindingStorage;
      if (classPlan === plan && body && cx.frame !== undefined && plan.definition.innerBinding) {
        const inner = plan.definition.innerBinding;
        const index = body.frame.captures.findIndex((capture) => capture.bindingId === inner.id);
        if (index < 0)
          return refuseNativeJsClassSource(expression, "inner class name lacks its definition-owned live cell");
        const cell = defined(
          builder.emitJsClassInstruction(
            {
              kind: "js.class.frame.get",
              frame: cx.frame,
              access: { kind: "capture", definitionId: irJsClassDefinitionBindingId(plan.definition), index },
            },
            irSupportRef(plan.definition.roles["binding-cell"], false),
          ),
        );
        storage = { kind: "cell", bindingId: inner.id, cell };
      } else {
        const outer = classPlan.definition.outerBinding;
        if (!outer || outer.storage !== "module")
          return refuseNativeJsClassSource(expression, "local class binding requires its original lexical cell");
        storage = { kind: "module", bindingId: outer.id };
      }
      return defined(
        builder.emitJsClassInstruction(
          { kind: "js.class.binding.read", storage },
          irSupportRef(classPlan.definition.roles.constructor, false),
        ),
      );
    }
    if (plan && body && cx.frame !== undefined) {
      let symbol = cx.checker.getSymbolAtLocation(expression);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = cx.checker.getAliasedSymbol(symbol);
      const target = symbol?.valueDeclaration;
      if (
        target &&
        ts.isVariableDeclaration(target) &&
        ts.isVariableStatement(target.parent.parent) &&
        ts.isSourceFile(target.parent.parent.parent)
      ) {
        const captureIndex = body.frame.captures.findIndex((capture) => capture.valueGlobal?.name === expression.text);
        if (captureIndex < 0)
          return refuseNativeJsClassSource(expression, "original module reference lacks its authentic live capture");
        const capture = body.frame.captures[captureIndex]!;
        if (capture.mode !== "live-global")
          return refuseNativeJsClassSource(expression, "source capture storage mode is not prepared");
        return defined(
          builder.emitJsClassInstruction(
            {
              kind: "js.class.frame.get",
              frame: cx.frame,
              access: {
                kind: "capture",
                definitionId: irJsClassDefinitionBindingId(plan.definition),
                index: captureIndex,
              },
            },
            capture.type,
          ),
        );
      }
    }
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    if (
      [expression.left, expression.right].some(
        (node) =>
          ts.isIdentifier(node) && node.text === "undefined" && cx.checker.getSymbolAtLocation(node)?.valueDeclaration,
      )
    )
      return refuseNativeJsClassSource(expression, "shadowed Undefined equality requires its actual value comparison");
    const isUndefined = (node: ts.Expression) =>
      ts.isIdentifier(node) && node.text === "undefined" && !cx.checker.getSymbolAtLocation(node)?.valueDeclaration;
    const left = isUndefined(expression.left),
      right = isUndefined(expression.right);
    if (left !== right) {
      const value = lower(left ? expression.right : expression.left, irDynamic());
      const actual = builder.typeOf(value);
      if (actual.kind === "dynamic") {
        const result = builder.emitTagTest(value, JS_TAG_IDS.Undefined);
        return expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
          ? builder.emitUnary("i32.eqz", result, irVal({ kind: "i32", boolean: true }))
          : result;
      }
      // Even native scalar operands retain the original scalar equality algorithm.
      if (actual.kind === "support-ref" && actual.nullable)
        return refuseNativeJsClassSource(
          expression,
          "nullable constructor absence requires its actual Undefined projection",
        );
      if (managed(actual))
        return builder.emitConst(
          { kind: "bool", value: expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken },
          irVal({ kind: "i32", boolean: true }),
        );
      return builder.emitConst(
        { kind: "bool", value: expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken },
        irVal({ kind: "i32", boolean: true }),
      );
    }
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const receiver = lower(expression.expression, irDynamic());
    if (!managed(builder.typeOf(receiver)))
      return refuseNativeJsClassSource(expression, "native class member receiver has no managed value contract");
    // A declaration does not prove the current property value: fields and writes can shadow methods.
    return defined(
      builder.emitJsClassInstruction(
        { kind: "js.class.property.get", receiver, key: { kind: "string", value: expression.name.text } },
        irDynamic(),
      ),
    );
  }
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    if (
      expression.questionDotToken ||
      expression.expression.questionDotToken ||
      expression.arguments.some(ts.isSpreadElement)
    )
      return refuseNativeJsClassSource(expression, "optional/spread method evaluation is not prepared");
    const member = expression.expression;
    const receiver = lower(member.expression, irDynamic());
    if (!managed(builder.typeOf(receiver)))
      return refuseNativeJsClassSource(member.expression, "method receiver has no managed value contract");
    const callable = defined(
      builder.emitJsClassInstruction(
        { kind: "js.class.property.get", receiver, key: { kind: "string", value: member.name.text } },
        irDynamic(),
      ),
    );
    const args = expression.arguments.map((argument) =>
      nativeJsClassStoredValue(argument, builder, lower(argument, irDynamic())),
    );
    return defined(
      builder.emitJsClassInstruction(
        {
          kind: "js.class.invoke",
          callable,
          receiver,
          args,
          signature: { params: args.map((value) => builder.typeOf(value)), result: irDynamic() },
        },
        irDynamic(),
      ),
    );
  }
  if (ts.isNewExpression(expression)) {
    const constructorPlan = sourcePlan(expression.expression, cx);
    if (!constructorPlan)
      return refuseNativeJsClassSource(expression, "constructor does not have its genuine source class contract");
    const constructorValue = lower(
      expression.expression,
      irSupportRef(constructorPlan.definition.roles.constructor, false),
    );
    const args = expression.arguments ?? [];
    if (args.some(ts.isSpreadElement))
      return refuseNativeJsClassSource(expression, "spread constructor argument iteration is not prepared");
    const values = args.map((arg) => nativeJsClassStoredValue(arg, builder, lower(arg, irDynamic())));
    return defined(
      builder.emitJsClassInstruction(
        { kind: "js.class.construct", constructor: constructorValue, newTarget: constructorValue, args: values },
        irSupportRef(constructorPlan.definition.roles.object, false),
      ),
    );
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(expression.left)
  ) {
    const receiver = lower(expression.left.expression, irDynamic());
    if (!managed(builder.typeOf(receiver)))
      return refuseNativeJsClassSource(expression, "native class write receiver lacks managed identity");
    const value = lower(expression.right, irDynamic());
    builder.emitJsClassInstruction(
      {
        kind: "js.class.property.set",
        receiver,
        key: { kind: "string", value: expression.left.name.text },
        value: nativeJsClassStoredValue(expression.right, builder, value),
        strict: true,
      },
      null,
    );
    return value;
  }
  return undefined;
}

/** Only original class bodies are admitted; body maps and source custody must remain current. */
export function originalNativeJsClassBody(plans: SourceJsClassDefinitions, unitId: string) {
  assertSourceJsClassDefinitionsCurrent(plans);
  for (const plan of plans.plans) {
    const body = [
      plan.definition.constructor,
      ...plan.definition.members.map((member) => member.body),
      ...plan.definition.instanceElements.flatMap((field) => (field.initializer ? [field.initializer] : [])),
    ].find((body) => body.unitId === unitId);
    if (body) {
      const node = plan.bodies.get(body.unitId);
      if (!node) return refuseNativeJsClassSource(plan.declaration, "original class body missing");
      return { plan, body, node };
    }
  }
  throw new Error("native JS class body is not in the complete original census");
}

/** Original declaration evaluation creates fresh identities before publishing the outer binding. */
export function lowerNativeJsClassDeclaration(node: ts.ClassDeclaration, cx: NativeJsClassSourceContext): void {
  const plan = cx.plans.plans.find((plan) => plan.declaration === node);
  if (!plan) refuseNativeJsClassSource(node, "declaration is absent from its complete original census");
  const outer = plan.definition.outerBinding;
  if (!outer || outer.storage !== "module")
    refuseNativeJsClassSource(node, "local lexical class cell instantiation is not prepared");
  if (plan.definition.captures.some((capture) => capture.mode !== "live-global"))
    refuseNativeJsClassSource(node, "definition external capture operands are not prepared");
  const value = defined(
    cx.builder.emitJsClassInstruction(
      { kind: "js.class.define", definition: irJsClassDefinitionBindingId(plan.definition), captures: [] },
      irSupportRef(plan.definition.roles.constructor, false),
    ),
  );
  cx.builder.emitJsClassInstruction(
    { kind: "js.class.binding.init", storage: { kind: "module", bindingId: outer.id }, value },
    null,
  );
}
