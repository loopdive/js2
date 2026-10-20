// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { IrClassId, IrSourceId, IrUnitId } from "../shared/contracts/ir-identity.js";
import { createIrBindingId } from "../shared/contracts/identity-values.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";
import type {
  IrJsClassBody,
  IrJsClassCapture,
  IrJsClassDefinition,
  IrJsClassMember,
  IrJsClassInstanceElement,
  IrJsClassStartup,
} from "./js-class-contracts.js";
import type { IrType } from "./core/types.js";
import { irDynamic, irSupportRef, irVal } from "./core/types.js";
import { irUnitFuncRef } from "./core/callable-bindings.js";
import { irJsClassBinding, irJsClassRoleRefs } from "./program/js-class-abi.js";
import { assertPreparedIrJsClassDefinitions, irJsClassDefinitionBindingId } from "./program/js-class-definition.js";
import { copyIrJsClassData } from "./runtime/js-class-verify.js";
import type { TypedIrProgramGlobal } from "./program/input-contracts.js";
import { IrUnsupportedError } from "./outcomes.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";

type ClassNode = ts.ClassDeclaration | ts.ClassExpression;
export interface SourceJsClassDefinitionPlan {
  readonly declaration: ClassNode;
  readonly definition: IrJsClassDefinition;
  readonly bodies: ReadonlyMap<
    IrUnitId,
    ts.MethodDeclaration | ts.ConstructorDeclaration | ts.PropertyDeclaration | ClassNode
  >;
}
export interface SourceJsClassDefinitions {
  readonly plans: readonly SourceJsClassDefinitionPlan[];
  readonly definitions: readonly IrJsClassDefinition[];
  readonly byClassId: ReadonlyMap<IrClassId, SourceJsClassDefinitionPlan>;
  assertCurrent(): void;
}
const currentSourcePlans = new WeakMap<
  SourceJsClassDefinitions,
  { readonly current: () => void; readonly checker: ts.TypeChecker; readonly identity: IrPlanningIdentityContext }
>();
/** Resolve genuine checker expression facts before freezing all original node flags.
 * TypeScript may set TypeCached while answering a later flow-type query. This
 * owner phase completes these checker cache writes before capture and exempts
 * no flag from custody. */
function resolveOriginalSourceExpressionFacts(checker: ts.TypeChecker, sources: Iterable<ts.SourceFile>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node)) checker.getTypeAtLocation(node);
    ts.forEachChild(node, visit);
  };
  for (const source of sources) visit(source);
}

/** Only the actual original-source producer owns this live pre-preparation association. */
export function assertSourceJsClassDefinitionsCurrent(
  plans: SourceJsClassDefinitions,
  checker?: ts.TypeChecker,
  identity?: IrPlanningIdentityContext,
): void {
  const current = currentSourcePlans.get(plans);
  if (!current)
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "untracked original native JS class source plans",
    );
  if (
    (checker !== undefined && current.checker !== checker) ||
    (identity !== undefined && current.identity !== identity)
  )
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native JS class source checker/identity changed",
    );
  current.current();
}
function unsupported(node: ts.Node, detail: string): never {
  const source = node.getSourceFile(),
    position = source.getLineAndCharacterOfPosition(node.getStart(source));
  throw new IrUnsupportedError(
    "class-member-unsupported",
    "build",
    `native JS class ${source.fileName}:${position.line + 1}:${position.character + 1}: ${detail}`,
  );
}
function has(node: ts.Node, modifier: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((item) => item.kind === modifier);
}
function name(node: ts.PropertyName): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return unsupported(node, "computed/private property key requires its original semantic owner");
}

/** Collect the original live module captures and refuse unsupported lexical/closure captures. */
function prepareSourceJsClassCaptures(
  declaration: ClassNode,
  checker: ts.TypeChecker,
  globals: ReadonlyMap<ts.Declaration, TypedIrProgramGlobal>,
): IrJsClassCapture[] {
  const captures: IrJsClassCapture[] = [],
    captured = new Set<string>();
  const capture = (node: ts.Node, sourceOwner: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const target = symbol?.valueDeclaration;
      if (
        target &&
        ts.isVariableDeclaration(target) &&
        ts.isVariableDeclarationList(target.parent) &&
        ts.isVariableStatement(target.parent.parent) &&
        ts.isSourceFile(target.parent.parent.parent)
      ) {
        const storage = globals.get(target);
        if (!storage) unsupported(node, "live module capture requires its authentic original storage plan");
        if (!captured.has(storage.binding.globalRef.binding.bindingId)) {
          captured.add(storage.binding.globalRef.binding.bindingId);
          captures.push({
            bindingId: storage.binding.globalRef.binding.bindingId,
            mode: "live-global",
            type: storage.binding.type,
            valueGlobal: storage.binding.globalRef,
            tdzGlobal: storage.binding.tdzGlobalRef,
          });
        }
      } else if (
        target &&
        (ts.isVariableDeclaration(target) || ts.isParameter(target)) &&
        (target.getStart() < sourceOwner.getStart() || target.getEnd() > sourceOwner.getEnd())
      )
        unsupported(node, "live outer lexical cell capture requires its original source/frame owner");
    }
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node !== sourceOwner)
      unsupported(node, "class closure/frame capture requires its original semantic owner");
    ts.forEachChild(node, (child) => capture(child, sourceOwner));
  };
  for (const member of declaration.members) {
    if (ts.isPropertyDeclaration(member) && member.initializer) capture(member.initializer, member);
    else if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && member.body)
      capture(member.body, member);
  }
  return captures;
}

/** Original source census first; this is neither a physical recipe nor permission to issue a sealed program. */
export function prepareSourceJsClassDefinitions(
  checker: ts.TypeChecker,
  identity: IrPlanningIdentityContext,
  globals: ReadonlyMap<ts.Declaration, TypedIrProgramGlobal> = new Map(),
): SourceJsClassDefinitions {
  const inventory = identity.inventory,
    roles = irJsClassRoleRefs(inventory);
  const snapshots = new Map<ts.SourceFile, string>();
  const nodes = new Map<ts.Node, { source: ts.SourceFile; start: number; end: number }>();
  const plans: SourceJsClassDefinitionPlan[] = [],
    byClassId = new Map<IrClassId, SourceJsClassDefinitionPlan>();
  const remember = (node: ts.Node) => {
    const source = node.getSourceFile();
    snapshots.set(source, source.text);
    nodes.set(node, { source, start: node.getStart(source), end: node.getEnd() });
    return { start: node.getStart(source), end: node.getEnd() };
  };
  const typeOf = (type: ts.Type, node: ts.Node): IrType | null => {
    if (type.flags & ts.TypeFlags.Void) return null;
    if (type.flags & ts.TypeFlags.NumberLike) return irVal({ kind: "f64" });
    if (type.flags & ts.TypeFlags.BooleanLike) return irVal({ kind: "i32", boolean: true });
    if (type.flags & ts.TypeFlags.Undefined) return irDynamic();
    const declaration = type.symbol?.valueDeclaration;
    if (
      declaration &&
      (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) &&
      identity.classIdByDeclaration.has(declaration)
    )
      return irSupportRef(type.getConstructSignatures().length ? roles.constructor : roles.object, false);
    return unsupported(node, "logical value contract is not prepared; annotation cannot prove a runtime carrier");
  };
  for (const original of inventory.classes) {
    const declaration = identity.declarationByClassId.get(original.id);
    if (!declaration || identity.classIdByDeclaration.get(declaration) !== original.id)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        "native JS class original bidirectional identity missing",
      );
    if (has(declaration, ts.SyntaxKind.DeclareKeyword))
      unsupported(declaration, "ambient class execution requires its erased source contract");
    if (declaration.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword))
      unsupported(declaration, "derived/super semantics remain with their held original owner");
    if (ts.canHaveDecorators(declaration) && ts.getDecorators(declaration)?.length)
      unsupported(declaration, "decorator definition evaluation is not prepared");
    const captures = prepareSourceJsClassCaptures(declaration, checker, globals);
    const className = declaration.name?.text ?? "";
    const innerBinding = className ? irJsClassBinding(original.id, className, "cell", false, roles, "inner") : null;
    const frameCaptures: readonly IrJsClassCapture[] = [
      ...captures,
      ...(innerBinding
        ? [
            {
              bindingId: innerBinding.id,
              mode: "live-cell" as const,
              type: innerBinding.valueType,
              valueGlobal: null,
              tdzGlobal: null,
            },
          ]
        : []),
    ];
    const module = ts.isClassDeclaration(declaration) && ts.isSourceFile(declaration.parent);
    const owner = module
      ? identity.moduleInitUnitIdBySourceId.get(original.sourceId)
      : identity.inventory.allUnits.find((unit) => unit.id === original.lexicalOwnerId)?.terminalOwnerId;
    if (!owner) unsupported(declaration, "definition lacks its actual original evaluation unit");
    const bodies = new Map<
      IrUnitId,
      ts.MethodDeclaration | ts.ConstructorDeclaration | ts.PropertyDeclaration | ClassNode
    >();
    const body = (
      node: ts.MethodDeclaration | ts.ConstructorDeclaration | ts.PropertyDeclaration | ClassNode,
      kind: IrJsClassBody["sourceBodyKind"],
      params: readonly IrType[],
      result: IrType | null,
      isStatic = false,
    ): IrJsClassBody => {
      const unitId = identity.unitIdByDeclaration.get(node),
        unit = unitId && identity.unitByUnitId.get(unitId);
      if (!unitId || !unit || unit.lexicalOwnerId !== original.id || !unit.terminalOwnerId)
        unsupported(node, "original class body/initializer unit population is incomplete");
      bodies.set(unitId, node);
      return {
        unitId,
        target: irUnitFuncRef({ unitId, name: unit.displayName }),
        sourceBodyKind: kind,
        lexicalOwnerId: original.id,
        terminalOwnerId: unit.terminalOwnerId,
        ordinal: unit.ordinal,
        span: remember(node),
        frame: {
          type: roles.frame,
          thisType: irSupportRef(isStatic ? roles.constructor : roles.object, false),
          environmentType: irSupportRef(roles.environment, false),
          homeObjectType: irSupportRef(isStatic ? roles.constructor : roles.prototype, false),
          newTargetType: irSupportRef(roles.constructor, true),
          captures: frameCaptures,
        },
        params,
        result,
      };
    };
    const parameters = (member: ts.MethodDeclaration | ts.ConstructorDeclaration): readonly IrType[] =>
      member.parameters.map((parameter) => {
        if (
          !ts.isIdentifier(parameter.name) ||
          parameter.name.text === "this" ||
          parameter.dotDotDotToken ||
          parameter.initializer ||
          parameter.modifiers?.length
        )
          unsupported(parameter, "default/rest/destructured/parameter-property semantics are not prepared");
        // TypeScript annotations and optional markers do not change actual USER transport.
        return irDynamic();
      });
    const members: IrJsClassMember[] = [],
      elements: IrJsClassInstanceElement[] = [];
    let constructorNode: ts.ConstructorDeclaration | undefined;
    for (const [sourceOrdinal, member] of declaration.members.entries()) {
      remember(member);
      if (ts.isConstructorDeclaration(member)) {
        if (!member.body || constructorNode) unsupported(member, "constructor body census ambiguous");
        constructorNode = member;
      } else if (ts.isPropertyDeclaration(member)) {
        if (has(member, ts.SyntaxKind.StaticKeyword))
          unsupported(member, "static field initialization order is not prepared");
        const key = name(member.name),
          annotation = checker.getTypeAtLocation(member);
        if (!(annotation.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)))
          unsupported(member, "field value/reference/array contract requires its original semantic representation");
        if (member.initializer) typeOf(checker.getTypeAtLocation(member.initializer), member.initializer);
        const result = member.initializer ? irDynamic() : null;
        elements.push({
          sourceOrdinal,
          name: key,
          span: remember(member),
          valueType: irDynamic(),
          defaultIntent: member.initializer ? "initializer" : "undefined",
          initializer: member.initializer ? body(member, "field-initializer", [], result) : null,
          attributes: { writable: true, enumerable: true, configurable: true },
        });
      } else if (ts.isMethodDeclaration(member)) {
        if (!member.body || member.asteriskToken || has(member, ts.SyntaxKind.AsyncKeyword))
          unsupported(member, "method async/generator/overload body contract is not prepared");
        const signature = checker.getSignatureFromDeclaration(member);
        if (!signature) unsupported(member, "authentic method signature missing");
        const isStatic = has(member, ts.SyntaxKind.StaticKeyword);
        members.push({
          sourceOrdinal,
          name: name(member.name),
          static: isStatic,
          span: remember(member),
          body: body(
            member,
            "method",
            parameters(member).map(() => irDynamic()),
            irDynamic(),
            isStatic,
          ),
          attributes: { writable: true, enumerable: false, configurable: true },
        });
      } else unsupported(member, "held accessor/static/private class member semantics are not prepared");
    }
    const ctor = body(
      constructorNode ?? declaration,
      "constructor",
      constructorNode ? parameters(constructorNode) : [],
      irSupportRef(roles.object, false),
    );
    const entry = inventory.sources.find((source) => source.kind === "entry")!;
    const realm = (role: string) =>
      createIrBindingId({ ownerId: entry.id, domain: "global", role: `native-js-class-realm:${role}` });
    const definition = copyIrJsClassData<IrJsClassDefinition>({
      schema: "native-js-class-definition-v1",
      sourceClassId: original.id,
      sourceId: original.sourceId,
      span: remember(declaration),
      evaluationOwnerUnitId: owner,
      form: original.declarationKind,
      name: className,
      outerBinding:
        ts.isClassDeclaration(declaration) && className
          ? irJsClassBinding(original.id, className, module ? "module" : "cell", true, roles, "outer")
          : null,
      innerBinding,
      constructorKind: "base",
      constructor: ctor,
      implicitConstructor: !constructorNode,
      members,
      instanceElements: elements,
      captures,
      roles,
      realm: {
        objectPrototype: realm("Object.prototype"),
        functionPrototype: realm("Function.prototype"),
        referenceError: realm("ReferenceError"),
        typeError: realm("TypeError"),
      },
    });
    const plan = Object.freeze({ declaration, definition, bodies });
    plans.push(plan);
    byClassId.set(original.id, plan);
  }
  assertPreparedIrJsClassDefinitions(
    inventory,
    plans.map((plan) => plan.definition),
  );
  resolveOriginalSourceExpressionFacts(checker, snapshots.keys());
  const observed = new Map<
    ts.Node,
    { children: readonly ts.Node[]; primitive: readonly unknown[]; parent: ts.Node | undefined }
  >();
  const observe = (node: ts.Node): void => {
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
      observe(child);
    });
    const leaf = node as ts.Node & { text?: string; escapedText?: string };
    observed.set(node, {
      children,
      primitive: [node.kind, node.flags, node.pos, node.end, leaf.text, leaf.escapedText],
      parent: node.parent,
    });
  };
  for (const source of snapshots.keys()) observe(source);
  const mapSnapshots = plans.map((plan) => ({ plan, entries: [...plan.bodies] }));
  const classEntries = [...byClassId];
  const current = (): void => {
    if (
      byClassId.size !== classEntries.length ||
      classEntries.some(([id, plan]) => byClassId.get(id) !== plan) ||
      mapSnapshots.some(
        ({ plan, entries }) =>
          plan.bodies.size !== entries.length || entries.some(([id, node]) => plan.bodies.get(id) !== node),
      )
    )
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        "native JS class original body/class map changed",
      );
    for (const [source, text] of snapshots)
      if (source.text !== text)
        throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native JS class original source changed");
    for (const [node, snapshot] of nodes)
      if (
        node.getSourceFile() !== snapshot.source ||
        node.getStart(snapshot.source) !== snapshot.start ||
        node.getEnd() !== snapshot.end
      )
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          "native JS class original source node changed",
        );
    for (const [node, snapshot] of observed) {
      const children: ts.Node[] = [];
      ts.forEachChild(node, (child) => {
        children.push(child);
      });
      const leaf = node as ts.Node & { text?: string; escapedText?: string };
      const primitive = [node.kind, node.flags, node.pos, node.end, leaf.text, leaf.escapedText];
      if (
        node.parent !== snapshot.parent ||
        children.length !== snapshot.children.length ||
        children.some((child, index) => child !== snapshot.children[index]) ||
        primitive.some((value, index) => value !== snapshot.primitive[index])
      )
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          "native JS class original child order/value changed",
        );
    }
  };
  const result = Object.freeze({
    plans: Object.freeze(plans),
    definitions: Object.freeze(plans.map((plan) => plan.definition)),
    byClassId,
    assertCurrent(): void {
      assertSourceJsClassDefinitionsCurrent(result);
    },
  });
  currentSourcePlans.set(result, { current, checker, identity });
  return result;
}

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native JS class startup: ${detail}`);
}

/** Original class declaration evaluations, distinct from the legacy queue observer. */
export function prepareIrJsClassStartup(
  source: ts.SourceFile,
  sourceId: IrSourceId,
  unitId: IrUnitId | null,
  definitions: readonly IrJsClassDefinition[],
): IrJsClassStartup {
  const actual = source.statements.flatMap((statement, statementOrdinal) =>
    ts.isClassDeclaration(statement) &&
    !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
      ? [{ statement, statementOrdinal }]
      : [],
  );
  const owned = definitions.filter(
    (definition) => definition.sourceId === sourceId && definition.evaluationOwnerUnitId === unitId,
  );
  if (owned.length !== actual.length) invalid("original module definition census differs");
  return copyIrJsClassData({
    schema: "native-js-class-startup-v1",
    definitions: actual.map(({ statement, statementOrdinal }, index) => {
      const definition = owned[index]!;
      if (
        statement.parent !== source ||
        definition.form !== "declaration" ||
        definition.span.start !== statement.getStart(source) ||
        definition.span.end !== statement.getEnd()
      )
        invalid("module declaration identity/order/span differs");
      return {
        definitionId: irJsClassDefinitionBindingId(definition),
        sourceClassId: definition.sourceClassId,
        statementOrdinal,
        span: definition.span,
      };
    }),
  });
}
