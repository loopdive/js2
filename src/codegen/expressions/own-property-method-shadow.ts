// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * An own property installed at RUNTIME over a prototype method of the same name
 * must win the method call (§10.1.8.1 OrdinaryGet — the own slot is consulted
 * before `[[Prototype]]`).
 *
 *     class H { pre(x) { return x; } }
 *     const h = new H();
 *     h.pre = (x) => "W" + x;
 *     h.pre("a");            // must be "Wa", not "a"
 *
 * The closed method dispatcher (`__call_m_<name>_<arity>`) answers from the
 * receiver's STATIC class, so for a method name the scan below admits, its
 * user-class arms first ask the receiver for an own slot (the object runtime's
 * native `__hasOwnProperty` / `__extern_method_call`, #7021).
 *
 * (#6979 S7-b) The JS-host lane's per-method guard wrappers
 * (`__ownshadow_<C>_<m>_<n>`) and guarded member read were host-semantic
 * (`env.__hasOwnProperty` + `env.__extern_get`) and were deleted with that lane.
 *
 * ## Scope of the scan
 *
 * Two admissions, both per SourceFile, both keyed on evidence that the file
 * installs a callable member:
 *
 *   1. a LITERAL-named write — `X.<m> = f`, `X["<m>"] = f`,
 *      `Object.defineProperty(X, "<m>", …)` — admits exactly `<m>`;
 *   2. a COMPUTED-key write — `X[k] = f` — admits every class method in the
 *      file, because `k` names nothing at compile time.
 *
 * (2) is the marked case and it is deliberately name-imprecise. Receiver
 * precision was tried first and does not exist to be had: TypeScript types
 * marked's `r` in `for (const o in n.hooks) { r[o] = … }` as `any` (measured
 * 2026-09-03 against the pinned 18.0.2 bundle — all four writes report
 * `symbol=undefined type=any`), so there is no class to key on. Over-admitting
 * costs one host predicate call per invocation of an otherwise-static method;
 * under-admitting returns the wrong value. Files with no callable member write
 * at all — the overwhelming majority — are byte-identical.
 */
import { ts, forEachChild } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { addStringConstantGlobal } from "../registry/imports.js";

/** RHS shapes that can carry a function value. */
function mayBeCallable(rhs: ts.Expression): boolean {
  let node: ts.Expression = rhs;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    node = node.expression;
  }
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
      return false;
    default:
      return true;
  }
}

interface FileMemberWrites {
  /** Property names written with a possibly-callable value. */
  readonly names: Set<string>;
  /** The file writes a possibly-callable value under a key it cannot name. */
  readonly computed: boolean;
}

const _fileWrites = new WeakMap<ts.SourceFile, FileMemberWrites>();

function callableMemberWrites(sourceFile: ts.SourceFile): FileMemberWrites {
  const cached = _fileWrites.get(sourceFile);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  let computed = false;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left;
      if (mayBeCallable(node.right)) {
        if (ts.isPropertyAccessExpression(target) && !ts.isPrivateIdentifier(target.name)) {
          names.add(target.name.text);
        } else if (ts.isElementAccessExpression(target)) {
          const key = target.argumentExpression;
          if (ts.isStringLiteralLike(key)) names.add(key.text);
          else if (ts.isNumericLiteral(key)) names.add(key.text);
          else computed = true;
        }
      }
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      // `Object.defineProperty(X, "<m>", …)` installs an own slot too, and by a
      // route no assignment scan can see (the #4482 pairing).
      const callee = node.expression.name.text;
      if (callee === "defineProperty" && node.arguments.length >= 2) {
        const key = node.arguments[1]!;
        if (ts.isStringLiteralLike(key)) names.add(key.text);
        else computed = true;
      } else if (callee === "defineProperties" && node.arguments.length >= 2) {
        const descriptors = node.arguments[1]!;
        if (ts.isObjectLiteralExpression(descriptors)) {
          for (const property of descriptors.properties) {
            const name = property.name;
            if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) names.add(name.text);
          }
        } else {
          computed = true;
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  const result: FileMemberWrites = { names, computed };
  _fileWrites.set(sourceFile, result);
  return result;
}

/**
 * True when the file containing `anchor` may install an own callable property
 * named `methodName` on some object. See the module header for the precision
 * argument behind the computed-key admission.
 */
export function fileMayInstallOwnCallableMember(anchor: ts.Node, methodName: string): boolean {
  const sourceFile = anchor.getSourceFile();
  if (sourceFile === undefined) return false;
  const writes = callableMemberWrites(sourceFile);
  return writes.computed || writes.names.has(methodName);
}

/**
 * The CLOSED-DISPATCHER half. `__call_m_<name>_<arity>` type-switches over every
 * closed struct that has `<Struct>_<name>` and runs the matching body — so an
 * `any`-typed receiver that happens to be a class instance takes the class arm
 * regardless of what it carries in its own slot. That is the marked path:
 * `i.hooks.preprocess(md)` reaches the dispatcher, the `_Hooks` arm wins, and
 * the installed hook is never seen.
 *
 * The fill runs at finalize with no AST in hand, so the decision is taken HERE,
 * at reserve time. Records nothing when the
 * file shows no evidence of a callable member write, which leaves every other
 * dispatcher byte-identical.
 */
export function noteOwnShadowDispatchCandidate(ctx: CodegenContext, anchor: ts.Node, methodName: string): void {
  if (methodName.startsWith("__priv_") || methodName.startsWith("@@") || methodName.startsWith("__cmdyn$")) return;
  if (!fileMayInstallOwnCallableMember(anchor, methodName)) return;
  // (#7021) The object runtime's NATIVE `__hasOwnProperty` and
  // `__extern_method_call` already see an own slot written onto a class
  // instance (the instance expando bag) — no import. The fill guards only when
  // both natives exist, so a module without them keeps its arms unchanged.
  // (#6979 S7-b) The JS-host `env.__hasOwnProperty` arm went with the
  // host-semantic lane.
  addStringConstantGlobal(ctx, methodName);
  (ctx.ownShadowDispatchNames ??= new Set<string>()).add(methodName);
}

/** True when the closed dispatcher for `methodName` should guard its class arms. */
export function closedDispatchGuardsOwnSlot(ctx: CodegenContext, methodName: string): boolean {
  return ctx.ownShadowDispatchNames?.has(methodName) === true;
}
