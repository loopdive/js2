// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { forEachInstrDeep, type IrFunction, type IrInstr, type IrType, type IrValueId } from "../ir/core/nodes.js";
import { IrUnsupportedError } from "../ir/outcomes.js";

const EXTERNREF: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });

/** Unproved loop/switch exits do not certify the absence of implicit undefined. */
function definitelyExits(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isBlock(statement)) return statement.statements.some(definitelyExits);
  if (ts.isIfStatement(statement))
    return (
      !!statement.elseStatement && definitelyExits(statement.thenStatement) && definitelyExits(statement.elseStatement)
    );
  if (ts.isTryStatement(statement))
    return (
      (!!statement.finallyBlock && definitelyExits(statement.finallyBlock)) ||
      (definitelyExits(statement.tryBlock) && (!statement.catchClause || definitelyExits(statement.catchClause.block)))
    );
  return false;
}

/** A checker candidate only; the actual lowered returns must separately prove boxing. */
export function sourceBooleanAnyResult(
  checker: ts.TypeChecker,
  declaration: ts.FunctionDeclaration,
): IrType | undefined {
  if (
    declaration.type?.kind !== ts.SyntaxKind.AnyKeyword ||
    !declaration.body ||
    declaration.asteriskToken ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  )
    return undefined;
  let returns = 0,
    valid = true;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    // These exits need their own target-sensitive completion proof, not a later return.
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) valid = false;
    if (ts.isReturnStatement(node)) {
      returns++;
      if (!node.expression || !(checker.getTypeAtLocation(node.expression).flags & ts.TypeFlags.BooleanLike))
        valid = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return valid && returns > 0 && definitelyExits(declaration.body) ? EXTERNREF : undefined;
}

function isExternref(type: IrType | undefined): boolean {
  return type?.kind === "val" && !type.typeRef && type.val.kind === "externref";
}

/** Audit the actual body, including nested early returns and SSA value joins. */
export function assertSourceBooleanAnyReturns(
  checker: ts.TypeChecker,
  declaration: ts.FunctionDeclaration,
  fn: IrFunction,
): void {
  if (!sourceBooleanAnyResult(checker, declaration)) return;
  const fail = (): never => {
    throw new IrUnsupportedError(
      "return-type-legacy-coupling",
      "build",
      `source Boolean return boundary requires actual canonical Boolean boxing in ${fn.name}`,
    );
  };
  if (fn.asyncPlan || fn.resultTypes.length !== 1 || !isExternref(fn.resultTypes[0])) fail();
  const definitions = new Map<IrValueId, IrInstr>(),
    types = new Map<IrValueId, IrType>();
  const incoming = new Map<IrValueId, IrValueId[]>(),
    returns: (readonly IrValueId[])[] = [];
  const blocks = new Map(fn.blocks.map((block) => [block.id, block]));
  fn.params.forEach((param) => types.set(param.value, param.type));
  for (const block of fn.blocks) {
    block.blockArgs.forEach((value, index) => types.set(value, block.blockArgTypes[index]!));
    for (const root of block.instrs)
      forEachInstrDeep(root, (instruction) => {
        if (instruction.result !== null) {
          if (definitions.has(instruction.result) || !instruction.resultType) fail();
          definitions.set(instruction.result, instruction);
          types.set(instruction.result, instruction.resultType!);
        }
        if (instruction.kind === "early.return") returns.push(instruction.value === null ? [] : [instruction.value]);
      });
    const term = block.terminator;
    if (term.kind === "return") returns.push(term.values);
    const branches = term.kind === "br" ? [term.branch] : term.kind === "br_if" ? [term.ifTrue, term.ifFalse] : [];
    for (const branch of branches) {
      const target = blocks.get(branch.target);
      if (!target || target.blockArgs.length !== branch.args.length) fail();
      target!.blockArgs.forEach((value, index) => {
        const values = incoming.get(value) ?? [];
        values.push(branch.args[index]!);
        incoming.set(value, values);
      });
    }
  }
  const active = new Set<IrValueId>();
  const prove = (value: IrValueId): boolean => {
    if (active.has(value) || !isExternref(types.get(value))) return false;
    active.add(value);
    try {
      const instruction = definitions.get(value);
      if (instruction?.kind === "intrinsic" && instruction.id === "js.boolean.box" && instruction.args.length === 1) {
        const input = types.get(instruction.args[0]!);
        return input?.kind === "val" && !input.typeRef && input.val.kind === "i32" && input.val.boolean === true;
      }
      if (instruction?.kind === "coerce.to_externref") return prove(instruction.value);
      const aliases =
        instruction?.kind === "select"
          ? [instruction.whenTrue, instruction.whenFalse]
          : instruction?.kind === "if"
            ? [instruction.thenValue, instruction.elseValue]
            : incoming.get(value);
      return !!aliases?.length && aliases.every(prove);
    } finally {
      active.delete(value);
    }
  };
  if (!returns.length || returns.some((values) => values.length !== 1 || !prove(values[0]!))) fail();
}
