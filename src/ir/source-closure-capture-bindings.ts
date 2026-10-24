// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "./builder.js";
import type { IrType, IrValueId } from "./core/nodes.js";
import { irTypeEquals } from "./core/types.js";
import { collectOuterWrites, collectTransitiveClosureCaptures } from "./closure-captures.js";
import { isFunctionScopeBoundary } from "./analysis/ast-scope.js";
import { IrInvariantError, IrUnsupportedError } from "./outcomes.js";
import { makeIrClassValueBindingResolver, type IrClassValueBinding } from "./class-binding-resolution.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";
import { SOURCE_LEXICAL_FLAG_TYPE, SOURCE_LEXICAL_VALUE_TYPE } from "./source-lexical-bindings.js";
type Member = ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;
export interface SourceClosureCaptureInput {
  readonly declaration: ts.VariableDeclaration | ts.ParameterDeclaration | ts.ClassDeclaration | ts.ClassExpression;
  readonly fieldType: IrType;
  readonly initializedFieldType?: IrType;
}
export interface ClosureCaptureBinding {
  readonly name: string;
  readonly withField?: { readonly name: string; readonly type: IrType };
  readonly fieldIndex?: number;
  readonly lexical?: { readonly initializedFieldIndex: number; readonly mutable: boolean };
}

/** A retained lexical binding owns two adjacent fields; ordinary captures own one. */
export function sourceClosureCaptureBindings(
  captures: readonly {
    readonly name: string;
    readonly withField?: ClosureCaptureBinding["withField"];
    readonly lexicalMutable?: boolean;
  }[],
): readonly ClosureCaptureBinding[] {
  let fieldIndex = 0;
  return Object.freeze(
    captures.map((capture, index) => {
      const offset = fieldIndex++;
      const lexical =
        capture.lexicalMutable === undefined
          ? undefined
          : Object.freeze({
              initializedFieldIndex: fieldIndex++,
              mutable: capture.lexicalMutable,
            });
      return Object.freeze({
        name: capture.name,
        ...(capture.withField ? { withField: capture.withField } : {}),
        ...(offset === index ? {} : { fieldIndex: offset }),
        ...(lexical ? { lexical } : {}),
      });
    }),
  );
}

/** Shared by original terminal entries and ordinary lifted closure entries. */
export function bindSourceClosureCaptures(
  captures: readonly ClosureCaptureBinding[],
  fieldTypes: readonly IrType[],
  self: IrValueId,
  builder: IrFunctionBuilder,
  bind: (capture: ClosureCaptureBinding, value: IrValueId, fieldType: IrType, initialized?: IrValueId) => void,
): void {
  for (const [index, capture] of captures.entries()) {
    const fieldIndex = capture.fieldIndex ?? index,
      fieldType = fieldTypes[fieldIndex]!;
    const value = builder.emitClosureCap(self, fieldIndex, fieldType);
    const initialized =
      capture.lexical &&
      builder.emitClosureCap(
        self,
        capture.lexical.initializedFieldIndex,
        fieldTypes[capture.lexical.initializedFieldIndex]!,
      );
    bind(capture, value, fieldType, initialized);
  }
}

export function sourceClosureEntryInvalid(detail: string): never {
  throw new IrInvariantError("selection-preparation-mismatch", "build", `source closure entry: ${detail}`);
}

export function sourceClosureDeclarationAttached(node: ts.Node, source: ts.SourceFile): boolean {
  for (let current = node; current !== source; ) {
    const parent = current.parent;
    if (!parent || !ts.forEachChild(parent, (child) => (child === current ? true : undefined))) return false;
    current = parent;
  }
  return true;
}

const invalid: (detail: string) => never = sourceClosureEntryInvalid;
const attached = sourceClosureDeclarationAttached;

function classCaptureBinding(
  identity: IrPlanningIdentityContext,
  checker: ts.TypeChecker,
  capture: SourceClosureCaptureInput,
  references: readonly ts.Identifier[],
): IrClassValueBinding | undefined {
  if (!ts.isClassLike(capture.declaration)) return undefined;
  const resolve = makeIrClassValueBindingResolver(checker, capture.declaration.getSourceFile(), identity);
  const first = references[0] && resolve(references[0]);
  if (
    !first ||
    first.declaration !== capture.declaration ||
    references.some((reference) => {
      const current = resolve(reference);
      return (
        !current ||
        current.classId !== first.classId ||
        current.kind !== first.kind ||
        current.mutable !== first.mutable
      );
    })
  )
    invalid("class capture lacks one exact source binding role");
  return first;
}

function captureTypeNode(declaration: SourceClosureCaptureInput["declaration"]) {
  return ts.isClassLike(declaration) ? undefined : declaration.type;
}

interface CaptureContext {
  readonly checker: ts.TypeChecker;
  readonly identity: IrPlanningIdentityContext;
  readonly declaration: Member;
  readonly syntax: (node: ts.Node) => string;
}
type FreeBindings = ReturnType<typeof collectTransitiveClosureCaptures>["bindings"];
type FreeBinding = FreeBindings extends ReadonlyMap<ts.Symbol, infer Binding> ? Binding : never;

function declaringScope(member: Member, binding: ts.Declaration, role?: IrClassValueBinding): ts.Node {
  if (role?.kind === "class-name") return role.declaration;
  let scope: ts.Node | undefined = binding.parent;
  while (scope && !isFunctionScopeBoundary(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  if (!scope || ts.isSourceFile(scope))
    throw new IrUnsupportedError(
      "body-shape-rejected",
      "build",
      "module binding capture needs its actual storage owner",
    );
  let lexicalScope: ts.Node = scope;
  if (
    ts.isClassDeclaration(binding) ||
    (ts.isVariableDeclaration(binding) &&
      ((ts.isVariableDeclarationList(binding.parent) && (binding.parent.flags & ts.NodeFlags.BlockScoped) !== 0) ||
        ts.isCatchClause(binding.parent)))
  ) {
    for (let node: ts.Node | undefined = binding.parent; node && node !== scope; node = node.parent)
      if (
        ts.isBlock(node) ||
        ts.isCaseBlock(node) ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isCatchClause(node)
      ) {
        lexicalScope = node;
        break;
      }
  }
  let enclosed = false;
  for (let node: ts.Node | undefined = member.parent; node; node = node.parent)
    if (node === lexicalScope) {
      enclosed = true;
      break;
    }
  if (!enclosed) invalid("capture declaration is outside the member's lexical evaluation scope");
  return scope;
}

function snapshotSourceCapture(
  context: CaptureContext,
  capture: SourceClosureCaptureInput,
  symbol: ts.Symbol,
  binding: FreeBinding,
) {
  const { checker, declaration, syntax } = context;
  const name = (capture.declaration.name as ts.Identifier).text;
  const role = classCaptureBinding(context.identity, checker, capture, binding.references);
  const scope = declaringScope(declaration, capture.declaration, role);
  const outerWrites = collectOuterWrites(declaration, scope);
  const logical = capture.fieldType.kind === "boxed" ? capture.fieldType.inner : capture.fieldType;
  const sourceType = checker.getTypeAtLocation(capture.declaration.name!);
  const expected: IrType | undefined = role
    ? SOURCE_LEXICAL_VALUE_TYPE
    : sourceType.flags & ts.TypeFlags.NumberLike
      ? { kind: "val", val: { kind: "f64" } }
      : sourceType.flags & ts.TypeFlags.BooleanLike
        ? { kind: "val", val: { kind: "i32", boolean: true } }
        : sourceType.flags & ts.TypeFlags.StringLike
          ? { kind: "string" }
          : undefined;
  if (
    !expected ||
    !irTypeEquals(logical, expected) ||
    ((binding.written || outerWrites.has(name)) && capture.fieldType.kind !== "boxed")
  )
    invalid("capture storage differs from its source value or writes");
  if (
    role
      ? capture.fieldType.kind !== "boxed" ||
        !capture.initializedFieldType ||
        !irTypeEquals(capture.initializedFieldType, { kind: "boxed", inner: SOURCE_LEXICAL_FLAG_TYPE })
      : capture.initializedFieldType !== undefined
  )
    invalid("lexical capture requires its exact value and initialized cells");
  return {
    name,
    declaration: capture.declaration,
    kind: capture.declaration.kind,
    parent: capture.declaration.parent,
    parentFlags: capture.declaration.parent.flags,
    type: captureTypeNode(capture.declaration),
    syntax: syntax(capture.declaration),
    scope,
    symbol,
    written: binding.written,
    outerWritten: outerWrites.has(name),
    references: [...binding.references],
    fieldType: structuredClone(capture.fieldType),
    initializedFieldType: capture.initializedFieldType && structuredClone(capture.initializedFieldType),
    role,
  };
}
type CaptureSnapshot = ReturnType<typeof snapshotSourceCapture>;

function captureLayout(captures: readonly CaptureSnapshot[]) {
  const fields: IrType[] = [];
  for (const capture of captures) {
    fields.push(structuredClone(capture.fieldType));
    if (capture.initializedFieldType) fields.push(structuredClone(capture.initializedFieldType));
  }
  return {
    captures: sourceClosureCaptureBindings(
      captures.map((capture) => ({ name: capture.name, lexicalMutable: capture.role?.mutable })),
    ),
    captureFieldTypes: Object.freeze(fields),
  };
}

function assertCaptureSnapshot(
  context: CaptureContext,
  captures: readonly CaptureSnapshot[],
  actual: FreeBindings,
  fieldTypes: readonly IrType[],
): void {
  const { checker, declaration, syntax } = context;

  if (actual.size !== captures.length) invalid("changed free binding population");
  let fieldIndex = 0;
  for (const [index, capture] of captures.entries()) {
    const binding = actual.get(capture.symbol);
    const role = binding && classCaptureBinding(context.identity, checker, capture, binding.references);
    const currentOuterWrites = collectOuterWrites(declaration, capture.scope);
    if (
      capture.declaration.kind !== capture.kind ||
      !attached(capture.declaration, declaration.getSourceFile()) ||
      capture.declaration.parent !== capture.parent ||
      capture.declaration.parent.flags !== capture.parentFlags ||
      captureTypeNode(capture.declaration) !== capture.type ||
      syntax(capture.declaration) !== capture.syntax ||
      declaringScope(declaration, capture.declaration, role) !== capture.scope ||
      role?.classId !== capture.role?.classId ||
      role?.kind !== capture.role?.kind ||
      role?.mutable !== capture.role?.mutable
    )
      invalid("changed captured declaration or source type");
    if (
      !binding ||
      [...actual.keys()][index] !== capture.symbol ||
      binding.written !== capture.written ||
      currentOuterWrites.has(capture.name) !== capture.outerWritten ||
      !irTypeEquals(fieldTypes[fieldIndex]!, capture.fieldType) ||
      binding.references.length !== capture.references.length ||
      binding.references.some((reference, index) => reference !== capture.references[index])
    )
      invalid("changed capture identity");
    fieldIndex++;
    if (capture.initializedFieldType && !irTypeEquals(fieldTypes[fieldIndex++]!, capture.initializedFieldType))
      invalid("changed lexical initialization capture");
  }
  if (fieldIndex !== fieldTypes.length) invalid("changed capture field population");
}

export function prepareSourceClosureCaptures(
  input: Omit<CaptureContext, "syntax"> & { readonly captures: readonly SourceClosureCaptureInput[] },
  syntax: CaptureContext["syntax"],
) {
  const { checker, declaration } = input;
  const context = { ...input, syntax };
  const free = () => collectTransitiveClosureCaptures(declaration, declaration, checker).bindings;
  const bindings = free(),
    orderedSymbols = [...bindings.keys()],
    seen = new Set<ts.Symbol>();
  const captures = input.captures.map((capture, index) => {
    if (
      !capture.declaration.name ||
      !ts.isIdentifier(capture.declaration.name) ||
      capture.declaration.name.text === "this"
    )
      invalid("capture name");
    const name = capture.declaration.name.text;
    const symbol = checker.getSymbolAtLocation(capture.declaration.name);
    const binding = symbol && bindings.get(symbol);
    if (
      !symbol ||
      !binding ||
      seen.has(symbol) ||
      symbol !== orderedSymbols[index] ||
      declaration.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)
    )
      invalid("capture is not one exact free source binding");
    seen.add(symbol);
    return snapshotSourceCapture(context, capture, symbol, binding);
  });
  if (seen.size !== bindings.size) invalid("incomplete free binding population");
  return {
    ...captureLayout(captures),
    assertCurrent(fieldTypes: readonly IrType[]) {
      assertCaptureSnapshot(context, captures, free(), fieldTypes);
    },
  };
}
