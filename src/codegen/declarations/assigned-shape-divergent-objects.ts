// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 V10c) The ASSIGNMENT twin of `collectRedeclaredShapeDivergentObjects`
 * (object-shape-widening.ts, #5270 step 3): a module binding initialized with
 * one object literal and later ASSIGNED a differently shaped one.
 *
 * ## The defect
 *
 * In a JavaScript source the checker types `var u` from its initializer, and
 * the later literal in `u = { flags: Symbol.split }` is compiled against that
 * contextual type — i.e. INTO the initializer's closed struct. A property the
 * struct cannot carry is dropped and replaced by its default:
 *
 * ```wat
 * i32.const 10      ;; Symbol.split
 * drop
 * ref.null $flags   ;; the nested `{ toString() {…} }` field type
 * struct.new $u
 * ```
 *
 * `Get(u, "flags")` then answers `null`, so `RegExp.prototype[@@split]`'s
 * step-7 `ToString(flags)` produced `"null"` and the splitter constructor
 * threw SyntaxError (`"nully"`) instead of ToString(Symbol)'s TypeError
 * (`built-ins/RegExp/prototype/Symbol.split/coerce-flags-err.js`).
 *
 * ## The lowering
 *
 * Exactly the redeclaration sibling's: the declaration is pinned to the
 * externref slot (`redeclaredObjectIdentityDeclarations`, consulted by every
 * module/local slot typer) and every participating literal to the open
 * `$Object` builder (`redeclaredObjectIdentityLiterals`). Standalone only, like
 * the sibling.
 *
 * ## Why the predicate is narrow
 *
 * Only plain data literals are compared (`name: value` members); a method,
 * accessor, shorthand, spread or computed key makes the pair "not comparable"
 * and leaves the existing lowering alone. Two shapes diverge when their
 * property-name sets differ, or a shared property's statically resolved JS
 * tags differ, or (recursively) a shared property holds two diverging data
 * literals. Unresolvable (`mixed`) tags never count as divergence.
 */
import { forEachChild, ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

type Oracle = CodegenContext["oracle"];

function stripParens(expr: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  return expr;
}

/** Name → value of a plain data object literal, or null when any member is not a `name: value` data property. */
function literalDataProperties(literal: ts.ObjectLiteralExpression): Map<string, ts.Expression> | null {
  const props = new Map<string, ts.Expression>();
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) return null;
    const name = property.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) return null;
    props.set(name.text, property.initializer);
  }
  return props;
}

/** True when two data literals cannot share one closed struct shape. */
function literalShapesDiverge(oracle: Oracle, initial: ts.Expression, assigned: ts.Expression): boolean {
  initial = stripParens(initial);
  assigned = stripParens(assigned);
  if (!ts.isObjectLiteralExpression(initial) || !ts.isObjectLiteralExpression(assigned)) return false;
  const a = literalDataProperties(initial);
  const b = literalDataProperties(assigned);
  if (a === null || b === null) return false;
  if (a.size !== b.size) return true;
  for (const [name, initialValue] of a) {
    const assignedValue = b.get(name);
    if (assignedValue === undefined) return true;
    const ta = oracle.staticJsTypeOf(initialValue);
    const tb = oracle.staticJsTypeOf(assignedValue);
    if (ta !== "mixed" && tb !== "mixed" && ta !== tb) return true;
    if (literalShapesDiverge(oracle, initialValue, assignedValue)) return true;
  }
  return false;
}

/** An unannotated, non-`const` binding whose initializer is an object literal. */
function isLiteralInitializedMutableBinding(decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name) || decl.type !== undefined || decl.initializer === undefined) return false;
  if (!ts.isObjectLiteralExpression(stripParens(decl.initializer))) return false;
  const list = decl.parent;
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) === 0;
}

/**
 * Mark every module binding whose object-literal initializer and some later
 * `binding = { … }` assignment have diverging shapes. `isModuleScoped` and
 * `markOpenConsumers` are the caller's (object-shape-widening.ts) own helpers,
 * passed in so this leaf module imports nothing from the widening pass.
 */
export function collectAssignedShapeDivergentObjects(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  isModuleScoped: (decl: ts.VariableDeclaration) => boolean,
  markOpenConsumers: (decl: ts.VariableDeclaration) => void,
): void {
  if (!ctx.standalone) return;
  const assignedLiterals = new Map<ts.VariableDeclaration, ts.ObjectLiteralExpression[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = stripParens(node.left);
      const value = stripParens(node.right);
      if (ts.isIdentifier(target) && ts.isObjectLiteralExpression(value)) {
        const decl = ctx.oracle.variableDeclarationOf(target);
        if (decl !== undefined && isLiteralInitializedMutableBinding(decl) && isModuleScoped(decl)) {
          const literals = assignedLiterals.get(decl) ?? [];
          literals.push(value);
          assignedLiterals.set(decl, literals);
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const [decl, literals] of assignedLiterals) {
    const initializer = stripParens(decl.initializer!) as ts.ObjectLiteralExpression;
    if (!literals.some((literal) => literalShapesDiverge(ctx.oracle, initializer, literal))) continue;
    ctx.redeclaredObjectIdentityDeclarations.add(decl);
    ctx.redeclaredObjectIdentityLiterals.add(initializer);
    for (const literal of literals) ctx.redeclaredObjectIdentityLiterals.add(literal);
    markOpenConsumers(decl);
  }
}
