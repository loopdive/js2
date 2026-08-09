// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3143 — the IR-first ALLOWLIST skip predicate + caller graph.
//
// Pure, checker-free AST helpers used by `computeIrFirstSkipSet` in
// `src/codegen/index.ts` (and unit-tested directly — this lives in its own
// module so tests can import it without pulling the whole codegen entry
// module and its init-order-sensitive cycles).
//
// History: this module previously held per-shape DENYLIST gate predicates
// (`irFirstBodyReadsHostNode` / `…ReadsStringElement` / `…HasNullish` /
// `…StoresTypedArrayView` / `…MutatesParam` / `…CallsUnloweredArrayMethod`).
// #3143 replaced the denylist with the ALLOWLIST below (the denylist could not
// safely close the ~22 from-ast throw classes the equivalence corpus revealed),
// so those predicates were deleted — git history preserves them if the
// allowlist-widening track (#2855/#2856) ever wants to reference them.
import ts from "typescript";
import { compareIrIdentity, type IrUnitId } from "../ir/identity.js";
import { collectModuleInitPopulation } from "../ir/module-init.js";
import {
  IrPlanningIdentityInvariantError,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
} from "../ir/planning-identity.js";

// ===========================================================================
// (#3143) ALLOWLIST skip predicate — the safe-by-construction IR-first skip.
//
// The IR-first flip's divergence surface is BROAD: the selector claims a wide
// range of shapes the from-ast builder cannot lower (a `result.errors` scan of
// the equivalence inline corpus found ~22 distinct from-ast throw classes over
// core operations — string methods, class-member resolution, call/ctor arity,
// type-mismatched arith, property assignment, coercion, `new Date`, …). A
// per-shape DENYLIST cannot close that set (unbounded; a single miss ships a
// skipped-slot HARD error / equivalence regression).
//
// So the skip decision is inverted to an ALLOWLIST: skip the legacy body ONLY
// for a function whose ENTIRE body is a small, PROVEN-lowerable subset. This is
// safe by construction — a construct the allowlist does not recognise keeps the
// function COMPILE-TWICE (correct, just no compile-once), whereas a denylist
// miss is a hard error. The subset starts intentionally narrow (matched-type
// numeric/boolean arithmetic, control flow, correctly-typed local variable
// mutation, exact-arity calls to other claimed functions, returns) and widens
// as the IR gains real lowering for more kinds (#2855/#2856) — each widening
// unlocks more of the gated-G1 legacy deletion.
//
// This predicate covers only the BODY shape; the caller
// (`computeIrFirstSkipSet`) additionally verifies the function's params/return
// are numeric/boolean and that it has no default/optional/rest/destructuring
// params (those from-ast throw arms are not observable from the body walk).
// ===========================================================================

/**
 * (#3203) The value-domain an allowlist expression evaluates to. `number` = JS
 * `number` (Wasm `f64`); `bool` = JS `boolean` (Wasm `i32`, disambiguated from
 * native-int by the caller via an explicit `boolean` annotation — see
 * `computeIrFirstSkipSet`). from-ast's Phase-1 arithmetic requires MATCHED
 * operand types and its logical/`!` ops require BOOLEAN operands; tracking a
 * per-expression domain (checker-free) is how the walk enforces that split.
 */
export type ValueDomain = "number" | "bool";

/**
 * (#3143/#3203) Return true iff `fn`'s body is entirely within the
 * proven-lowerable subset, given:
 *   - `claimedArity` — name → parameter count for every claimed function with a
 *     PURE-`f64` signature (all params `f64`, `f64` return). A call to a
 *     non-claimed / wrong-arity / non-f64-signature callee is NOT allowlisted;
 *     in v1 calls are number-domain only (the callee's number signature is the
 *     invariant that keeps the call result domain sound — see
 *     `computeIrFirstSkipSet`).
 *   - `paramDomains` — per-parameter value domain (parallel to `fn.parameters`).
 *     Omitted ⇒ every param is `number` (preserves the pre-#3203 f64-only
 *     behaviour and the 2-arg call sites).
 *   - `returnDomain` — the function's return domain (`"void"` for a
 *     value-less body). Defaults to `number`.
 *
 * **Domain-tracked, safe-by-construction (#3203 widen).** Every identifier is
 * resolved to a `number`/`bool` domain via a per-name map (params seeded from
 * `paramDomains`, locals inferred from their initializer). `exprDomain` returns
 * the domain of an expression or `null` when it is outside the subset:
 *   - arithmetic / bit / shift over two NUMBERS → number;
 *   - relational (`< > <= >=`) over two NUMBERS → bool;
 *   - equality (`== === != !==`) over two operands of the SAME domain → bool;
 *   - `&&` / `||` / `!` over BOOLS → bool;
 *   - `?:` — bool condition, same-domain branches → that domain;
 *   - `=` preserves the target local's domain; `+=`…`^=` and `++`/`--` are
 *     number-only local mutation (PARAMETER mutation is rejected);
 *   - a call to a claimed pure-`f64` callee with exact arity and number args →
 *     number.
 * if/while/do/for conditions must be `bool`; `return <e>` must match
 * `returnDomain`. No string/array/object/closure/class/extern/dynamic/member/
 * element/`new`/coercion constructs — all stay COMPILE-TWICE (a shape the walk
 * does not recognise returns `null`/`false`, never a hard error).
 */
export function irFirstBodyIsProvenLowerable(
  fn: ts.FunctionDeclaration,
  claimedArity: ReadonlyMap<string, number>,
  paramDomains?: readonly ValueDomain[],
  returnDomain: ValueDomain | "void" = "number",
): boolean {
  if (!fn.body) return false;
  const params = new Set<string>();
  // Per-name value domain. Params seeded from the caller-provided domains
  // (default `number`); locals populated as their declarations are walked
  // (declare-before-use holds for the tail shapes; a not-yet-seen name resolves
  // to `null` ⇒ reject, which is safe — it can only keep a function
  // compile-twice, never wrongly skip it).
  const domain = new Map<string, ValueDomain>();
  for (let i = 0; i < fn.parameters.length; i++) {
    const p = fn.parameters[i]!;
    if (!ts.isIdentifier(p.name)) return false; // destructuring param — reject
    params.add(p.name.text);
    domain.set(p.name.text, paramDomains?.[i] ?? "number");
  }

  // `+=`…`^=` compound arithmetic assignment (number-only). `=` handled apart.
  const isCompoundAssignToken = (k: ts.SyntaxKind): boolean =>
    k >= ts.SyntaxKind.PlusEqualsToken && k <= ts.SyntaxKind.CaretEqualsToken;
  // Numeric binary ops (arith / bit / shift) — NOT comparisons, NOT logical.
  const isNumericBinaryToken = (k: ts.SyntaxKind): boolean =>
    k === ts.SyntaxKind.PlusToken ||
    k === ts.SyntaxKind.MinusToken ||
    k === ts.SyntaxKind.AsteriskToken ||
    k === ts.SyntaxKind.SlashToken ||
    k === ts.SyntaxKind.PercentToken ||
    k === ts.SyntaxKind.AsteriskAsteriskToken ||
    k === ts.SyntaxKind.AmpersandToken ||
    k === ts.SyntaxKind.BarToken ||
    k === ts.SyntaxKind.CaretToken ||
    k === ts.SyntaxKind.LessThanLessThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
  // Relational — produce a bool from two NUMBERS.
  const isRelationalToken = (k: ts.SyntaxKind): boolean =>
    k === ts.SyntaxKind.LessThanToken ||
    k === ts.SyntaxKind.GreaterThanToken ||
    k === ts.SyntaxKind.LessThanEqualsToken ||
    k === ts.SyntaxKind.GreaterThanEqualsToken;
  // Equality — produce a bool from two operands of the SAME domain.
  const isEqualityToken = (k: ts.SyntaxKind): boolean =>
    k === ts.SyntaxKind.EqualsEqualsToken ||
    k === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    k === ts.SyntaxKind.ExclamationEqualsToken ||
    k === ts.SyntaxKind.ExclamationEqualsEqualsToken;

  // An assignable target: a local that is NOT a parameter (param mutation is a
  // from-ast non-slot throw; a mutated `let` slot-promotes).
  const isAssignableLocal = (e: ts.Expression): boolean =>
    ts.isIdentifier(e) && domain.has(e.text) && !params.has(e.text);

  // The value domain of `e`, or `null` when outside the proven-lowerable subset.
  const exprDomain = (e: ts.Expression): ValueDomain | null => {
    switch (e.kind) {
      case ts.SyntaxKind.NumericLiteral:
        return "number";
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
        return "bool";
      case ts.SyntaxKind.Identifier:
        return domain.get((e as ts.Identifier).text) ?? null;
      case ts.SyntaxKind.ParenthesizedExpression:
        return exprDomain((e as ts.ParenthesizedExpression).expression);
      case ts.SyntaxKind.PrefixUnaryExpression: {
        const u = e as ts.PrefixUnaryExpression;
        if (u.operator === ts.SyntaxKind.PlusPlusToken || u.operator === ts.SyntaxKind.MinusMinusToken) {
          // ++x / --x — number-local mutation only.
          return isAssignableLocal(u.operand) && domain.get((u.operand as ts.Identifier).text) === "number"
            ? "number"
            : null;
        }
        if (u.operator === ts.SyntaxKind.ExclamationToken) {
          return exprDomain(u.operand) === "bool" ? "bool" : null; // `!` over a bool
        }
        // `+x` / `-x` / `~x` are numeric.
        if (
          u.operator === ts.SyntaxKind.PlusToken ||
          u.operator === ts.SyntaxKind.MinusToken ||
          u.operator === ts.SyntaxKind.TildeToken
        ) {
          return exprDomain(u.operand) === "number" ? "number" : null;
        }
        return null;
      }
      case ts.SyntaxKind.PostfixUnaryExpression: {
        const u = e as ts.PostfixUnaryExpression;
        return isAssignableLocal(u.operand) && domain.get((u.operand as ts.Identifier).text) === "number"
          ? "number"
          : null; // x++ / x-- — number-local mutation only
      }
      case ts.SyntaxKind.BinaryExpression: {
        const b = e as ts.BinaryExpression;
        const op = b.operatorToken.kind;
        if (op === ts.SyntaxKind.EqualsToken) {
          // `x = <rhs>` — preserves the target local's domain.
          if (!isAssignableLocal(b.left)) return null;
          const d = domain.get((b.left as ts.Identifier).text)!;
          return exprDomain(b.right) === d ? d : null;
        }
        if (isCompoundAssignToken(op)) {
          // `x += <rhs>` … — number-only.
          if (!isAssignableLocal(b.left) || domain.get((b.left as ts.Identifier).text) !== "number") return null;
          return exprDomain(b.right) === "number" ? "number" : null;
        }
        if (isNumericBinaryToken(op)) {
          return exprDomain(b.left) === "number" && exprDomain(b.right) === "number" ? "number" : null;
        }
        if (isRelationalToken(op)) {
          return exprDomain(b.left) === "number" && exprDomain(b.right) === "number" ? "bool" : null;
        }
        if (isEqualityToken(op)) {
          const l = exprDomain(b.left);
          const r = exprDomain(b.right);
          return l !== null && l === r ? "bool" : null; // matched domains only
        }
        if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
          return exprDomain(b.left) === "bool" && exprDomain(b.right) === "bool" ? "bool" : null;
        }
        return null;
      }
      case ts.SyntaxKind.ConditionalExpression: {
        const c = e as ts.ConditionalExpression;
        if (exprDomain(c.condition) !== "bool") return null;
        const t = exprDomain(c.whenTrue);
        const f = exprDomain(c.whenFalse);
        return t !== null && t === f ? t : null;
      }
      case ts.SyntaxKind.CallExpression: {
        const c = e as ts.CallExpression;
        if (!ts.isIdentifier(c.expression)) return null; // no method calls
        const arity = claimedArity.get(c.expression.text);
        if (arity === undefined || arity !== c.arguments.length) return null; // exact arity to a claimed f64 fn
        for (const a of c.arguments) {
          if (ts.isSpreadElement(a) || exprDomain(a) !== "number") return null;
        }
        return "number"; // claimedArity holds pure-f64-signature callees only
      }
      default:
        return null; // strings/member/element/new/array/object/arrow/this/… → reject
    }
  };

  const stmtOk = (s: ts.Statement): boolean => {
    switch (s.kind) {
      case ts.SyntaxKind.Block:
        return (s as ts.Block).statements.every(stmtOk);
      case ts.SyntaxKind.EmptyStatement:
      case ts.SyntaxKind.BreakStatement:
      case ts.SyntaxKind.ContinueStatement:
        return true;
      case ts.SyntaxKind.ReturnStatement: {
        const r = s as ts.ReturnStatement;
        if (r.expression === undefined) return true; // bare `return;`
        return returnDomain !== "void" && exprDomain(r.expression) === returnDomain;
      }
      case ts.SyntaxKind.ExpressionStatement:
        return exprDomain((s as ts.ExpressionStatement).expression) !== null;
      case ts.SyntaxKind.IfStatement: {
        const i = s as ts.IfStatement;
        return (
          exprDomain(i.expression) === "bool" &&
          stmtOk(i.thenStatement) &&
          (i.elseStatement === undefined || stmtOk(i.elseStatement))
        );
      }
      case ts.SyntaxKind.WhileStatement: {
        const w = s as ts.WhileStatement;
        return exprDomain(w.expression) === "bool" && stmtOk(w.statement);
      }
      case ts.SyntaxKind.DoStatement: {
        const d = s as ts.DoStatement;
        return exprDomain(d.expression) === "bool" && stmtOk(d.statement);
      }
      case ts.SyntaxKind.ForStatement: {
        const f = s as ts.ForStatement;
        if (f.initializer) {
          if (ts.isVariableDeclarationList(f.initializer)) {
            if (!f.initializer.declarations.every(varDeclOk)) return false;
          } else if (exprDomain(f.initializer) === null) return false;
        }
        if (f.condition && exprDomain(f.condition) !== "bool") return false;
        if (f.incrementor && exprDomain(f.incrementor) === null) return false;
        return stmtOk(f.statement);
      }
      case ts.SyntaxKind.VariableStatement:
        return (s as ts.VariableStatement).declarationList.declarations.every(varDeclOk);
      default:
        return false; // throw/try/switch/for-of/for-in/labeled/nested-fn/class/… → reject
    }
  };

  function varDeclOk(d: ts.VariableDeclaration): boolean {
    if (!ts.isIdentifier(d.name)) return false; // destructuring
    if (d.initializer === undefined) return false; // uninitialized — reject (conservative)
    const dom = exprDomain(d.initializer);
    if (dom === null) return false;
    domain.set(d.name.text, dom); // record so later statements resolve this local
    return true;
  }

  return fn.body.statements.every(stmtOk);
}

/** Structural local-call edges for one exact source in a shared planning context. */
export interface IrIdentityLocalCallEdges {
  readonly callees: ReadonlyMap<IrUnitId, ReadonlySet<IrUnitId>>;
  /** Local targets reached from AST regions that have no R0 executable owner. */
  readonly calleesFromUnownedCallers: ReadonlySet<IrUnitId>;
}

/**
 * Bare identifier calls use conservative, checker-free resolution, but
 * candidates are restricted to top-level functions in this exact source.
 * Duplicate declarations retain every candidate ID. Nested callbacks keep
 * their terminal executable owner, while module population is attributed to
 * the source-owned module-init unit.
 */
export function collectLocalCallEdgesByIdentity(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
): IrIdentityLocalCallEdges {
  const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
  if (identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    throw new IrPlanningIdentityInvariantError(
      "source-record-mismatch",
      `source ${sourceId} does not resolve back to the exact planning SourceFile`,
    );
  }
  const unitById = new Map(identityContext.inventory.allUnits.map((unit) => [unit.id, unit]));
  const requireDeclarationUnitId = (declaration: ts.Node): IrUnitId => {
    const unitId = identityContext.unitIdByDeclaration.get(declaration);
    if (!unitId) {
      throw new IrPlanningIdentityInvariantError(
        "missing-unit-declaration",
        `executable ${ts.SyntaxKind[declaration.kind]} has no structural IR unit`,
      );
    }
    if (unitById.get(unitId)?.sourceId !== sourceId) {
      throw new IrPlanningIdentityInvariantError(
        "unit-record-mismatch",
        `unit ${unitId} does not belong to authoritative source ${sourceId}`,
      );
    }
    return unitId;
  };

  const candidatesByName = new Map<string, IrUnitId[]>();
  const activeTopLevelFunctionIds = new Set<IrUnitId>();
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.body) continue;
    const unitId = requireDeclarationUnitId(statement);
    if (identityContext.declarationByUnitId.get(unitId) !== statement) {
      throw new IrPlanningIdentityInvariantError(
        "unit-record-mismatch",
        `top-level function ${unitId} is not its exact declaration for ${sourceId}`,
      );
    }
    activeTopLevelFunctionIds.add(unitId);
    if (!statement.name) continue;
    const candidates = candidatesByName.get(statement.name.text) ?? [];
    candidates.push(unitId);
    candidatesByName.set(statement.name.text, candidates);
  }
  for (const unit of identityContext.inventory.allUnits) {
    const declaration = identityContext.declarationByUnitId.get(unit.id);
    const representsTopLevelFunction =
      unit.kind === "top-level-function" ||
      (unit.kind === "synthetic-support" &&
        unit.lexicalOwnerId === null &&
        declaration !== undefined &&
        ts.isFunctionDeclaration(declaration) &&
        declaration.parent === sourceFile);
    if (unit.sourceId !== sourceId || !representsTopLevelFunction) continue;
    if (
      !declaration ||
      !ts.isFunctionDeclaration(declaration) ||
      declaration.getSourceFile() !== sourceFile ||
      !declaration.body ||
      !activeTopLevelFunctionIds.has(unit.id)
    ) {
      throw new IrPlanningIdentityInvariantError(
        "missing-unit-declaration",
        `function unit ${unit.id} is absent from the active top-level population for ${sourceId}`,
      );
    }
  }
  for (const candidates of candidatesByName.values()) candidates.sort(compareIrIdentity);

  // A boundary may deliberately reset ownership to null (for example an
  // export-assignment support unit). Support callbacks retain their terminal
  // owner, which preserves the old enclosing-owner over-approximation without
  // putting their own structural support IDs into the caller graph.
  const ownerByBoundary = new Map<ts.Node, IrUnitId | null>();
  const terminalOwnerFor = (declaration: ts.Node, required: boolean): IrUnitId | null | undefined => {
    const unitId = identityContext.unitIdByDeclaration.get(declaration);
    if (unitId === undefined) return required ? requireDeclarationUnitId(declaration) : undefined;
    const unit = unitById.get(unitId);
    if (!unit || unit.sourceId !== sourceId) return requireDeclarationUnitId(declaration);
    return unit.terminalOwnerId;
  };
  const recordCallableBoundaries = (
    declaration: ts.Node,
    body: ts.Node | undefined,
    parameters: readonly ts.ParameterDeclaration[],
  ): void => {
    const owner = terminalOwnerFor(declaration, body !== undefined);
    if (owner === undefined) return;
    if (body) ownerByBoundary.set(body, owner);
    for (const parameter of parameters) {
      ownerByBoundary.set(parameter.name, owner);
      if (parameter.initializer) ownerByBoundary.set(parameter.initializer, owner);
    }
  };
  const collectBoundaries = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      recordCallableBoundaries(node, node.body, node.parameters);
    } else if (ts.isClassStaticBlockDeclaration(node)) {
      const owner = terminalOwnerFor(node, true);
      if (owner !== undefined) ownerByBoundary.set(node.body, owner);
    } else if (ts.isPropertyDeclaration(node) && node.initializer) {
      const owner = terminalOwnerFor(node, true);
      if (owner !== undefined) ownerByBoundary.set(node.initializer, owner);
    } else if (ts.isExportAssignment(node)) {
      const owner = terminalOwnerFor(node, true);
      if (owner !== undefined) ownerByBoundary.set(node.expression, owner);
    }
    ts.forEachChild(node, collectBoundaries);
  };
  collectBoundaries(sourceFile);

  const modulePopulation = collectModuleInitPopulation(sourceFile);
  const authoritativeModulePopulation = identityContext.moduleInitPopulationBySourceFile.get(sourceFile);
  if (!authoritativeModulePopulation) {
    throw new IrPlanningIdentityInvariantError(
      "source-record-mismatch",
      `source ${sourceId} has no authoritative module-init population`,
    );
  }
  if (
    modulePopulation.length !== authoritativeModulePopulation.length ||
    modulePopulation.some((statement, index) => statement !== authoritativeModulePopulation[index])
  ) {
    throw new IrPlanningIdentityInvariantError(
      "invalid-module-init",
      `source ${sourceId} has a stale active module-init population`,
    );
  }
  const moduleInitId = identityContext.moduleInitUnitIdBySourceFile.get(sourceFile);
  if (modulePopulation.length > 0 && !moduleInitId) {
    throw new IrPlanningIdentityInvariantError(
      "invalid-module-init",
      `source ${sourceId} has module population but no structural module-init unit`,
    );
  }
  if (moduleInitId) {
    for (const statement of modulePopulation) ownerByBoundary.set(statement, moduleInitId);
  }

  const callees = new Map<IrUnitId, Set<IrUnitId>>();
  const calleesFromUnownedCallers = new Set<IrUnitId>();
  const recordCall = (caller: IrUnitId | null, name: string): void => {
    const candidates = candidatesByName.get(name);
    if (!candidates) return; // no same-source target: external or dynamic
    if (caller === null) {
      for (const candidate of candidates) calleesFromUnownedCallers.add(candidate);
      return;
    }
    let targets = callees.get(caller);
    if (!targets) {
      targets = new Set<IrUnitId>();
      callees.set(caller, targets);
    }
    for (const candidate of candidates) targets.add(candidate);
  };
  const walk = (node: ts.Node, inheritedOwner: IrUnitId | null): void => {
    const boundaryOwner = ownerByBoundary.get(node);
    const owner = boundaryOwner === undefined ? inheritedOwner : boundaryOwner;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) recordCall(owner, node.expression.text);
    ts.forEachChild(node, (child) => walk(child, owner));
  };
  walk(sourceFile, null);

  return Object.freeze({ callees, calleesFromUnownedCallers });
}
