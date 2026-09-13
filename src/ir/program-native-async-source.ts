// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Source-bound frontend plans, not runtime authority or physical provider availability.
import { ts } from "../ts-api.js";
import type { IrUnitId } from "../shared/contracts/ir-identity.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";
import { requireExactSourceFunctionOwner, requireExactPlanSiteOwner } from "./planning-sites.js";
import type { IrProgramCallableBindingGraph } from "./program-callable-bindings.js";
import type { IrPromiseDelayLoweringPlan } from "./promise-delay-lowering.js";
import type {
  PreparedAsyncAwaitSite,
  PreparedAsyncFromAstResolver,
  PreparedAsyncPromiseAllPlan,
} from "./async-from-ast.js";
import { irIntrinsicFuncRef, irRuntimeFuncRef } from "./callable-bindings.js";
import { irTypeEquals, irVal, type IrType } from "./core/types.js";
import type { IrFuncRef } from "./core/value-references.js";
import { IrUnsupportedError } from "./outcomes.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import {
  IR_ASYNC_CLOCK_SNAPSHOT_FN,
  IR_ASYNC_CONSOLE_LOG_STRING_FN,
  IR_ASYNC_NUMBER_TO_STRING_FN,
  IR_ASYNC_PROMISE_ALL_NATIVE_FN,
  IR_ASYNC_STRING_CONCAT_5_FN,
} from "./async-semantic-runtime.js";
import {
  buildNativeFamilyLogicalVectors,
  nativeFamilyAmbientSymbol,
  nativeFamilyLogicalType,
  nativeFamilyPromiseFulfillment,
  nativeFamilySignature,
  type NativeFamilyVectorNode,
  type NativeFamilyVectorType,
} from "./program-logical-types.js";

export interface NativeAsyncSourceFunction {
  readonly unitId: IrUnitId;
  readonly declaration: ts.FunctionDeclaration;
  readonly params: readonly IrType[];
  readonly result: IrType | null;
  readonly logicalVectorTypes: ReadonlyMap<NativeFamilyVectorNode, NativeFamilyVectorType>;
  readonly awaitSites: ReadonlyMap<ts.AwaitExpression, PreparedAsyncAwaitSite>;
  readonly resolver: PreparedAsyncFromAstResolver;
}

export interface NativeAsyncSourceFamilies {
  readonly functions: ReadonlyMap<IrUnitId, NativeAsyncSourceFunction>;
  /** Revalidate original AST objects and complete map populations before/after lowering. */
  assertCurrent(ownerUnitId?: IrUnitId): void;
}

interface FamilyInput {
  readonly checker: ts.TypeChecker;
  readonly identity: IrPlanningIdentityContext;
  readonly callGraph: IrProgramCallableBindingGraph;
  readonly certifiedDelays: ReadonlyMap<IrUnitId, IrPromiseDelayLoweringPlan>;
  readonly diagnostic: { active: IrUnitId | undefined };
}

interface FunctionFacts {
  readonly unitId: IrUnitId;
  readonly declaration: ts.FunctionDeclaration;
  readonly params: readonly IrType[];
  readonly result: IrType | null;
  readonly directCalls: Map<ts.CallExpression, IrUnitId>;
  readonly awaitSites: Map<ts.AwaitExpression, PreparedAsyncAwaitSite>;
  readonly awaitedUnits: IrUnitId[];
  readonly promiseAll: Map<ts.CallExpression, PreparedAsyncPromiseAllPlan>;
  readonly dateNow: Map<ts.CallExpression, IrFuncRef>;
  readonly numberString: Map<ts.CallExpression, IrFuncRef>;
  readonly console: Map<ts.CallExpression, IrFuncRef>;
  readonly concat: Map<ts.Expression, IrFuncRef>;
  readonly pushes: ts.CallExpression[];
}

function unsupported(detail: string): never {
  throw new IrUnsupportedError("body-shape-rejected", "build", `native async family: ${detail}`);
}
function invariant(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native async family: ${detail}`);
}
function logicalTypeReceipt(type: IrType | null | undefined): string {
  if (type === null || type === undefined) return String(type);
  const keys = Object.keys(type).sort().join(",");
  if (
    type.kind === "val" &&
    keys === "kind,val" &&
    Object.keys(type.val).join(",") === "kind" &&
    (type.val.kind === "f64" || type.val.kind === "externref")
  )
    return type.val.kind;
  if (type.kind === "vec" && keys === "elementType,kind,nullable" && typeof type.nullable === "boolean")
    return `vec:${type.nullable}:${logicalTypeReceipt(type.elementType)}`;
  if (type.kind === "extern" && keys === "className,kind" && type.className === "Promise") return "Promise";
  return invariant("logical type acquired a foreign element, field or physical layout");
}
function unwrapped(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}
function isAsync(owner: ts.FunctionDeclaration): boolean {
  return owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
}
function isNumber(type: IrType | null): boolean {
  return type !== null && irTypeEquals(type, irVal({ kind: "f64" }));
}
function isNumberVector(type: IrType | undefined): boolean {
  return type?.kind === "vec" && isNumber(type.elementType);
}
function ownedSite(input: FamilyInput, facts: FunctionFacts, node: ts.Node): void {
  const source = facts.declaration.getSourceFile();
  const record = input.identity.terminalByUnitId.get(facts.unitId)!;
  requireExactPlanSiteOwner(source, input.identity, facts.unitId, record.legacyMatchName, node, "native async family");
}

/** Check receiver, member and resolved signature against the actual ambient declarations. */
function requireAmbientCall(input: FamilyInput, call: ts.CallExpression, global?: string): ts.PropertyAccessExpression {
  const target = call.expression;
  if (
    !ts.isPropertyAccessExpression(target) ||
    target.questionDotToken ||
    call.questionDotToken ||
    call.typeArguments ||
    call.arguments.some(ts.isSpreadElement)
  )
    unsupported("ambient operation has an unsupported call shape");
  if (global) {
    const canonical = nativeFamilyAmbientSymbol(input.checker, global, ts.SymbolFlags.Value);
    if (
      !ts.isIdentifier(target.expression) ||
      target.expression.text !== global ||
      input.checker.getSymbolAtLocation(target.expression) !== canonical
    )
      unsupported(`${global} is shadowed or unresolved`);
  }
  const member = input.checker.getSymbolAtLocation(target.name);
  const receiverMember = input.checker.getTypeAtLocation(target.expression).getProperty(target.name.text);
  const signature = input.checker.getResolvedSignature(call);
  if (
    !member?.declarations?.length ||
    member !== receiverMember ||
    !member.declarations.every((node) => node.getSourceFile().isDeclarationFile) ||
    !signature?.declaration ||
    !member.declarations.includes(signature.declaration)
  )
    unsupported(`member ${target.name.text} has no exact ambient signature`);
  return target;
}

function concatOperands(expression: ts.Expression, result: ts.Expression[]): void {
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    concatOperands(expression.left, result);
    concatOperands(expression.right, result);
  } else result.push(expression);
}

function recordAmbientCall(input: FamilyInput, facts: FunctionFacts, call: ts.CallExpression): void {
  if (!ts.isPropertyAccessExpression(call.expression)) unsupported("call has no source-owned or ambient target");
  const name = call.expression.name.text;
  if (name === "all") {
    requireAmbientCall(input, call, "Promise");
    if (call.arguments.length !== 1) unsupported("Promise.all requires exactly one pending vector");
    const argument = nativeFamilyLogicalType(input.checker, input.checker.getTypeAtLocation(call.arguments[0]!));
    const result = nativeFamilyPromiseFulfillment(input.checker, input.checker.getTypeAtLocation(call));
    if (
      argument.kind !== "vec" ||
      !irTypeEquals(argument.elementType, irVal({ kind: "externref" })) ||
      !isNumberVector(result ?? undefined)
    )
      unsupported("Promise.all requires Promise<number>[] and number[] fulfillment");
    facts.promiseAll.set(call, {
      target: irRuntimeFuncRef(IR_ASYNC_PROMISE_ALL_NATIVE_FN),
      argumentType: argument,
      resultType: result!,
    });
  } else if (name === "now") {
    requireAmbientCall(input, call, "Date");
    if (call.arguments.length !== 0) unsupported("Date.now requires no arguments");
    facts.dateNow.set(call, irIntrinsicFuncRef(IR_ASYNC_CLOCK_SNAPSHOT_FN));
  } else if (name === "log") {
    requireAmbientCall(input, call, "console");
    const argument = call.arguments[0];
    if (
      call.arguments.length !== 1 ||
      !argument ||
      (input.checker.getTypeAtLocation(argument).flags & ts.TypeFlags.StringLike) === 0
    )
      unsupported("console.log requires one source-proven string");
    const operands: ts.Expression[] = [];
    concatOperands(argument, operands);
    if (operands.length === 5) {
      if (operands.some((item) => (input.checker.getTypeAtLocation(item).flags & ts.TypeFlags.StringLike) === 0))
        unsupported("five-part console concat has a non-string operand");
      facts.concat.set(argument, irIntrinsicFuncRef(IR_ASYNC_STRING_CONCAT_5_FN));
    } else if (operands.length !== 1) unsupported("console concat is not the complete five-part operation");
    facts.console.set(call, irIntrinsicFuncRef(IR_ASYNC_CONSOLE_LOG_STRING_FN));
  } else if (name === "toString") {
    const target = requireAmbientCall(input, call);
    if (
      call.arguments.length !== 0 ||
      (input.checker.getTypeAtLocation(target.expression).flags & ts.TypeFlags.NumberLike) === 0
    )
      unsupported("number.toString requires the numeric zero-argument member");
    facts.numberString.set(call, irIntrinsicFuncRef(IR_ASYNC_NUMBER_TO_STRING_FN));
  } else if (name === "push") {
    const target = requireAmbientCall(input, call);
    const receiver = nativeFamilyLogicalType(input.checker, input.checker.getTypeAtLocation(target.expression));
    if (
      receiver.kind !== "vec" ||
      !irTypeEquals(receiver.elementType, irVal({ kind: "externref" })) ||
      call.arguments.length !== 1
    )
      unsupported("family push requires one Promise<number> on the exact pending vector");
    const fulfillment = nativeFamilyPromiseFulfillment(
      input.checker,
      input.checker.getTypeAtLocation(call.arguments[0]!),
    );
    if (!isNumber(fulfillment)) unsupported("pending push has a nonnumeric Promise fulfillment");
    facts.pushes.push(call);
  } else unsupported(`unadmitted ambient member ${name}`);
}

function recordAwait(
  input: FamilyInput,
  facts: FunctionFacts,
  node: ts.AwaitExpression,
  owners: ReadonlyMap<IrUnitId, FunctionFacts>,
): void {
  const call = unwrapped(node.expression);
  if (!ts.isCallExpression(call)) unsupported("await operand is not an exact family call");
  const targetId = facts.directCalls.get(call);
  let operandType: IrType;
  let resultType: IrType | null;
  if (targetId) {
    const target = owners.get(targetId)!;
    resultType = target.result;
    operandType = input.certifiedDelays.has(targetId)
      ? { kind: "extern", className: "Promise" }
      : irVal({ kind: "externref" });
    facts.awaitedUnits.push(targetId);
  } else {
    const plan = facts.promiseAll.get(call);
    if (!plan) unsupported("await call has no exact family target");
    resultType = plan.resultType;
    operandType = irVal({ kind: "externref" });
  }
  if (!resultType) unsupported("the five family awaits must have a fulfillment value");
  const actual = nativeFamilyLogicalType(input.checker, input.checker.getTypeAtLocation(node));
  if (!irTypeEquals(actual, resultType)) unsupported("await expression contradicts its target fulfillment");
  facts.awaitSites.set(node, { operandType, resultType });
}

/** Check source returns against the semantic fulfillment, including main's zero-result contract. */
function requireFamilyReturn(input: FamilyInput, facts: FunctionFacts, node: ts.ReturnStatement): void {
  if (facts.result === null) {
    if (!node.expression) return;
    const expression = unwrapped(node.expression);
    const undefinedSymbol = input.checker.resolveName("undefined", undefined, ts.SymbolFlags.Value, false);
    if (
      !ts.isIdentifier(expression) ||
      expression.text !== "undefined" ||
      !undefinedSymbol ||
      input.checker.getSymbolAtLocation(expression) !== undefinedSymbol ||
      (input.checker.getTypeAtLocation(expression).flags & ts.TypeFlags.Undefined) === 0
    )
      unsupported("void family owner requires an effect-free bare or ambient undefined return");
    return;
  }
  if (
    !node.expression ||
    !irTypeEquals(
      nativeFamilyLogicalType(input.checker, input.checker.getTypeAtLocation(node.expression)),
      facts.result,
    )
  )
    unsupported("family return contradicts its declared fulfillment");
}

function inspectFunction(input: FamilyInput, facts: FunctionFacts, owners: ReadonlyMap<IrUnitId, FunctionFacts>): void {
  if (input.certifiedDelays.has(facts.unitId)) return; // Original executor/timer sites are owned by delay certification.
  if (!isAsync(facts.declaration)) unsupported("a dependent family owner is not async");
  const awaits: ts.AwaitExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isFunctionLike(node)) unsupported("family async body contains a nested executable owner");
    if (ts.isCallExpression(node)) {
      ownedSite(input, facts, node);
      const use = input.callGraph.resolveCall(node, facts.unitId);
      if (use) {
        const target = owners.get(use.targetUnitId);
        if (
          !target ||
          input.checker.getResolvedSignature(node)?.declaration !== target.declaration ||
          node.questionDotToken ||
          node.typeArguments ||
          node.arguments.length !== target.params.length ||
          node.arguments.some(ts.isSpreadElement)
        )
          unsupported("direct call is outside the exact checker-bound family closure");
        node.arguments.forEach((argument, index) => {
          const actual = nativeFamilyLogicalType(input.checker, input.checker.getTypeAtLocation(argument));
          if (!irTypeEquals(actual, target.params[index]!))
            unsupported("direct-call argument contradicts its declared family parameter");
        });
        facts.directCalls.set(node, target.unitId);
      } else recordAmbientCall(input, facts, node);
    }
    if (ts.isAwaitExpression(node)) {
      ownedSite(input, facts, node);
      awaits.push(node);
    }
    if (ts.isReturnStatement(node)) requireFamilyReturn(input, facts, node);
    ts.forEachChild(node, visit);
  };
  visit(facts.declaration.body!);
  for (const node of awaits) recordAwait(input, facts, node, owners);
}

/** The role edges are structural; none is selected by a source function's name. */
function requireCompleteFamily(
  input: FamilyInput,
  owners: ReadonlyMap<IrUnitId, FunctionFacts>,
  delay: IrUnitId,
): void {
  const rows = [...owners.values()];
  const one = (matches: FunctionFacts[], role: string): FunctionFacts => {
    if (matches.length !== 1) unsupported(`requires exactly one checker-bound ${role} owner`);
    return matches[0]!;
  };
  const fetch = one(
    rows.filter(
      (f) =>
        f.params.length === 1 &&
        isNumber(f.params[0]!) &&
        isNumber(f.result) &&
        f.awaitSites.size === 1 &&
        f.awaitedUnits[0] === delay,
    ),
    "scalar fetch",
  );
  const sequential = one(
    rows.filter(
      (f) =>
        f.params.length === 1 &&
        isNumberVector(f.params[0]) &&
        isNumber(f.result) &&
        f.awaitSites.size === 1 &&
        f.awaitedUnits[0] === fetch.unitId,
    ),
    "sequential vector",
  );
  const parallel = one(
    rows.filter(
      (f) =>
        f.params.length === 1 &&
        isNumberVector(f.params[0]) &&
        isNumber(f.result) &&
        f.awaitSites.size === 1 &&
        f.promiseAll.size === 1 &&
        f.pushes.length === 1 &&
        [...f.directCalls.values()].includes(fetch.unitId),
    ),
    "parallel vector",
  );
  const main = one(
    rows.filter(
      (f) =>
        f.params.length === 0 &&
        f.result === null &&
        f.awaitSites.size === 2 &&
        f.awaitedUnits[0] === sequential.unitId &&
        f.awaitedUnits[1] === parallel.unitId,
    ),
    "final main",
  );
  input.diagnostic.active = main.unitId;
  if (
    main.dateNow.size !== 4 ||
    main.console.size !== 4 ||
    main.numberString.size !== 4 ||
    main.concat.size !== 2 ||
    main.directCalls.size !== 2 ||
    rows.reduce((n, f) => n + f.awaitSites.size, 0) !== 5 ||
    new Set([delay, fetch.unitId, sequential.unitId, parallel.unitId, main.unitId]).size !== rows.length
  )
    unsupported("family lacks its complete five-owner/five-await/main-operation population");
  for (const f of [fetch, sequential, parallel]) {
    input.diagnostic.active = f.unitId;
    if (
      f.directCalls.size !== 1 ||
      f.dateNow.size ||
      f.console.size ||
      f.numberString.size ||
      f.concat.size ||
      (f !== parallel && (f.promiseAll.size || f.pushes.length))
    )
      unsupported("family owner has operations outside its certified role");
  }
}

function familyOwnerIds(input: FamilyInput, delay: IrUnitId): ReadonlySet<IrUnitId> {
  const owners = new Set([delay]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const use of input.callGraph.uses) {
      if (owners.has(use.targetUnitId) && !owners.has(use.ownerUnitId)) {
        owners.add(use.ownerUnitId);
        changed = true;
      }
    }
  }
  if (owners.size !== 5) unsupported(`certified delay closure has ${owners.size} owners, expected all five`);
  return owners;
}

function createFunctionFacts(input: FamilyInput, unitId: IrUnitId): FunctionFacts {
  input.diagnostic.active = unitId;
  const unit = input.identity.terminalByUnitId.get(unitId);
  const source = unit && input.identity.sourceFileBySourceId.get(unit.sourceId);
  if (!source) invariant("family owner has no authoritative source");
  const declaration = requireExactSourceFunctionOwner(source, input.identity, unitId);
  const signature = nativeFamilySignature(input.checker, declaration);
  return {
    unitId,
    declaration,
    ...signature,
    directCalls: new Map(),
    awaitSites: new Map(),
    awaitedUnits: [],
    promiseAll: new Map(),
    dateNow: new Map(),
    numberString: new Map(),
    console: new Map(),
    concat: new Map(),
    pushes: [],
  };
}

function functionPlan(input: FamilyInput, facts: FunctionFacts): NativeAsyncSourceFunction {
  input.diagnostic.active = facts.unitId;
  const logicalVectorTypes = buildNativeFamilyLogicalVectors(input.checker, facts.declaration, facts.awaitSites);
  const resolver: PreparedAsyncFromAstResolver = {
    preparedAsyncAwaitSite: (node) => facts.awaitSites.get(node) ?? null,
    preparedAsyncPromiseAllPlan: (node) => facts.promiseAll.get(node) ?? null,
    preparedAsyncThenableResultType: (node) => (facts.directCalls.has(node) ? irVal({ kind: "f64" }) : undefined),
    preparedAsyncDateNowTarget: (node) => facts.dateNow.get(node) ?? null,
    preparedAsyncNumberToStringTarget: (node) => facts.numberString.get(node) ?? null,
    preparedAsyncConsoleTarget: (node) => facts.console.get(node) ?? null,
    preparedAsyncConcatFiveTarget: (node) => facts.concat.get(node) ?? null,
  };
  return {
    unitId: facts.unitId,
    declaration: facts.declaration,
    params: facts.params,
    result: facts.result,
    logicalVectorTypes,
    awaitSites: facts.awaitSites,
    resolver,
  };
}

/** Pin the complete owned plan fields, including resolver functions and symbolic target identities. */
function retainPlanFields(value: object): () => void {
  const keys = Reflect.ownKeys(value);
  const fields = keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)!] as const);
  if (fields.some(([, field]) => !("value" in field))) invariant("source plan contains a non-data field");
  return () => {
    if (Reflect.ownKeys(value).length !== keys.length) invariant("source plan field population changed");
    for (const [key, before] of fields) {
      const current = Object.getOwnPropertyDescriptor(value, key);
      if (
        !current ||
        !("value" in current) ||
        current.value !== before.value ||
        current.enumerable !== before.enumerable ||
        current.configurable !== before.configurable ||
        current.writable !== before.writable
      )
        invariant("source plan field or callable identity changed");
    }
  };
}

/** Pin syntax children and literal/binding text, not mutable checker caches or source text alone. */
function retainSourceStructure(owner: ts.FunctionDeclaration): () => void {
  const checks: (() => void)[] = [];
  const childrenOf = (node: ts.Node): ts.Node[] => {
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    return children;
  };
  const atom = (node: ts.Node) =>
    ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
      ? node.escapedText
      : ts.isStringLiteralLike(node) ||
          ts.isNumericLiteral(node) ||
          ts.isBigIntLiteral(node) ||
          ts.isRegularExpressionLiteral(node)
        ? node.text
        : undefined;
  const visit = (node: ts.Node): void => {
    const children = childrenOf(node);
    const { kind, pos, end, parent } = node;
    const text = atom(node);
    const call = ts.isCallExpression(node)
      ? [node.expression, node.arguments, node.typeArguments, node.questionDotToken]
      : undefined;
    checks.push(() => {
      const current = childrenOf(node);
      if (
        node.kind !== kind ||
        node.pos !== pos ||
        node.end !== end ||
        node.parent !== parent ||
        atom(node) !== text ||
        current.length !== children.length ||
        current.some((child, index) => child !== children[index]) ||
        (call &&
          (!ts.isCallExpression(node) ||
            node.expression !== call[0] ||
            node.arguments !== call[1] ||
            node.typeArguments !== call[2] ||
            node.questionDotToken !== call[3]))
      )
        invariant("certified source syntax, operand or target changed");
    });
    children.forEach(visit);
  };
  visit(owner);
  return () => {
    checks.forEach((check) => check());
  };
}

/** Plan the whole connected source family without a legacy context or issuance authority. */
export function prepareNativeAsyncSourceFamilies(input: FamilyInput): NativeAsyncSourceFamilies {
  const functions = new Map<IrUnitId, NativeAsyncSourceFunction>();
  const validations: (() => void)[] = [];
  if (input.certifiedDelays.size === 0) unsupported("full-family projection requires a certified delay owner");
  for (const delay of input.certifiedDelays.keys()) {
    input.diagnostic.active = delay;
    const owners = new Map([...familyOwnerIds(input, delay)].map((id) => [id, createFunctionFacts(input, id)]));
    for (const facts of owners.values()) {
      input.diagnostic.active = facts.unitId;
      inspectFunction(input, facts, owners);
    }
    requireCompleteFamily(input, owners, delay);
    for (const facts of owners.values()) {
      if (functions.has(facts.unitId)) invariant("two delay families share a source owner");
      const plan = functionPlan(input, facts);
      functions.set(facts.unitId, plan);
      const retainedFields = [
        plan,
        plan.resolver,
        plan.params,
        ...plan.awaitSites.values(),
        ...[...facts.promiseAll.values()].flatMap((site) => [site, site.target, site.target.binding]),
      ].map(retainPlanFields);
      const retainedSyntax = retainSourceStructure(facts.declaration);
      const source = facts.declaration.getSourceFile();
      const sourceText = source.text;
      const declarationText = facts.declaration.getText(source);
      const record = input.identity.terminalByUnitId.get(facts.unitId)!;
      const recordFields = Object.entries(record);
      const maps: readonly ReadonlyMap<ts.Node, unknown>[] = [
        plan.logicalVectorTypes,
        plan.awaitSites,
        facts.directCalls,
        facts.promiseAll,
        facts.dateNow,
        facts.numberString,
        facts.console,
        facts.concat,
      ];
      const entries = maps.map((map) => [...map]);
      const typeReceipt = () =>
        [
          ...plan.params.map(logicalTypeReceipt),
          logicalTypeReceipt(plan.result),
          ...[...plan.logicalVectorTypes.values()].map(logicalTypeReceipt),
          ...[...plan.awaitSites.values()].flatMap((site) => [
            logicalTypeReceipt(site.operandType),
            logicalTypeReceipt(site.resultType),
          ]),
          ...[...facts.promiseAll.values()].flatMap((site) => [
            logicalTypeReceipt(site.argumentType),
            logicalTypeReceipt(site.resultType),
          ]),
        ].join(";");
      const initialTypes = typeReceipt();
      validations.push(() => {
        retainedFields.forEach((check) => check());
        retainedSyntax();
        if (
          functions.get(facts.unitId) !== plan ||
          input.identity.terminalByUnitId.get(facts.unitId) !== record ||
          input.identity.unitByUnitId.get(facts.unitId) !== record ||
          !input.identity.inventory.terminalUnits.includes(record) ||
          !input.identity.inventory.allUnits.includes(record) ||
          source.text !== sourceText ||
          facts.declaration.getText(source) !== declarationText ||
          requireExactSourceFunctionOwner(source, input.identity, facts.unitId) !== facts.declaration ||
          recordFields.some(([key, value]) => Object.getOwnPropertyDescriptor(record, key)?.value !== value) ||
          Object.keys(record).length !== recordFields.length ||
          plan.logicalVectorTypes !== maps[0] ||
          plan.awaitSites !== maps[1]
        )
          invariant("source owner or its retained planning population changed");
        if (typeReceipt() !== initialTypes) invariant("logical source type or await operand contract changed");
        maps.forEach((map, index) => {
          if (map.size !== entries[index]!.length || entries[index]!.some(([key, value]) => map.get(key) !== value))
            invariant("source-bound node map population changed");
          for (const [node] of entries[index]!) {
            if (ts.isParameter(node)) {
              if (!facts.declaration.parameters.includes(node))
                invariant("vector parameter no longer belongs to its source owner");
            } else ownedSite(input, facts, node);
          }
        });
      });
    }
  }
  const original = [...functions];
  return {
    functions,
    assertCurrent(ownerUnitId) {
      if (functions.size !== original.length) invariant("source-family owner population changed");
      original.forEach(([id], index) => {
        if (ownerUnitId !== undefined && id !== ownerUnitId) return;
        input.diagnostic.active = id;
        validations[index]!();
      });
    },
  };
}
