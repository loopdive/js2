// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1121 parameter/return numeric-type inference. Pure AST + checker analyses
 * that return a ValType/Map and mutate nothing on ctx. Extracted verbatim from
 * codegen/declarations.ts (#3268).
 */
import { isVoidType, unwrapPromiseType } from "../../checker/type-mapper.js";
import { isSyntacticallyBooleanExpr } from "../../checker/oracle.js";
import { forEachChild, ts } from "../../ts-api.js";
import { isStandalonePromiseActive } from "../async-scheduler.js";
import { hasAsyncModifier, resolveWasmType } from "../index.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

export function resolveGenericCallSiteTypes(
  ctx: CodegenContext,
  funcName: string,
  sourceFile: ts.SourceFile,
): { params: ValType[]; results: ValType[] } | null {
  let found: { params: ValType[]; results: ValType[] } | null = null;

  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === funcName) {
      const sig = ctx.checker.getResolvedSignature(node);
      if (sig) {
        const params: ValType[] = [];
        const sigParams = sig.getParameters();
        for (let i = 0; i < sigParams.length; i++) {
          const paramType = ctx.checker.getTypeOfSymbol(sigParams[i]!);
          params.push(resolveWasmType(ctx, paramType));
        }
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        // (#2905) Carrier own-return guard. resolveWasmType(Promise<T>) lowers to
        // externref under the native $Promise carrier (index.ts), but an async
        // callee's OWN wasm result is the unwrapped T — its body returns raw T;
        // wrapAsyncReturn boxes to $Promise only at the *call* site. So for an
        // async callee under the carrier, pre-unwrap to keep this inferred
        // signature matching the actually-compiled fn (else externref-result vs
        // f64-body = invalid Wasm). Gated on the carrier so off-carrier bytes are
        // identical (effRet === retType). Non-async fns returning Promise<T> keep
        // retType → resolveWasmType → externref, which is correct (body returns a
        // real promise). Mirrors the main async-return sites (e.g. :2930).
        const callDecl = sig.getDeclaration();
        const calleeIsAsync = callDecl ? hasAsyncModifier(callDecl) : false;
        const effRetType =
          isStandalonePromiseActive(ctx) && calleeIsAsync ? unwrapPromiseType(retType, ctx.checker) : retType;
        const results: ValType[] = isVoidType(effRetType) ? [] : [resolveWasmType(ctx, effRetType)];
        found = { params, results };
      }
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  return found;
}

/**
 * Infer a concrete type for an untyped function parameter by scanning call sites.
 * When a parameter has no type annotation (TS gives it `any`), we look at every
 * call to that function and collect the argument types at the given index.
 * If all call sites agree on a single concrete wasm type, we return it.
 * Returns null if no call site found or types disagree.
 */
export function inferParamTypeFromCallSites(
  ctx: CodegenContext,
  funcName: string,
  paramIndex: number,
  sourceFile: ts.SourceFile,
): ValType | null {
  let agreed: ValType | null = null;
  let conflict = false;

  function visit(node: ts.Node) {
    if (conflict) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === funcName) {
      const arg = node.arguments[paramIndex];
      if (arg) {
        const argType = ctx.checker.getTypeAtLocation(arg);
        // Skip if the argument itself is also `any` — no useful info
        if (argType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
          // Don't count this call site — it doesn't help
        } else {
          const wasmType = resolveWasmType(ctx, argType);
          if (agreed === null) {
            agreed = wasmType;
          } else if (agreed.kind !== wasmType.kind) {
            conflict = true;
          } else if (
            (agreed.kind === "ref" || agreed.kind === "ref_null") &&
            (wasmType.kind === "ref" || wasmType.kind === "ref_null") &&
            (agreed as { typeIdx: number }).typeIdx !== (wasmType as { typeIdx: number }).typeIdx
          ) {
            conflict = true;
          }
        }
      }
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  return conflict ? null : agreed;
}

/**
 * #1121: Fallback param-type inference from body usage. Used when
 * `inferParamTypeFromCallSites` finds no call sites (e.g. an exported
 * entrypoint that is only called from JS host) but the function body
 * itself reveals how the parameter is used.
 *
 * Recognises three numeric-flow patterns:
 *  1. `param` passed as an argument to a function whose return is in
 *     `ctx.numericReturnTypes` (the recursive numeric kernels detected
 *     by inferNumericReturnTypes).
 *  2. `param` used as an operand of a numeric binary operator
 *     (+, -, *, /, %, **, |, &, ^, <<, >>, >>>, ToInt32 coercion).
 *  3. `param` used as a numeric loop bound / comparison operand
 *     (<, <=, >, >=).
 *
 * Returns null if none of those patterns are found, leaving the param
 * unchanged. This is intentionally conservative — the call-site path
 * is still preferred when it has information.
 */
export function inferParamTypeFromBody(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  paramIndex: number,
): ValType | null {
  if (!decl.body) return null;
  const param = decl.parameters[paramIndex];
  if (!param || !ts.isIdentifier(param.name)) return null;
  const paramName = param.name.text;

  let foundNumericUse = false;
  function visit(node: ts.Node) {
    if (foundNumericUse) return;
    // Don't descend into nested functions — the param doesn't propagate there
    // unless captured, and we don't track capture flow here.
    if (
      node !== decl &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isAccessor(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      return;
    }

    // (1) param passed to a known numeric function
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const calleeName = node.expression.text;
      if (ctx.numericReturnTypes?.has(calleeName)) {
        for (const arg of node.arguments) {
          if (ts.isIdentifier(arg) && arg.text === paramName) {
            foundNumericUse = true;
            return;
          }
        }
      }
    }

    // (2) param used in a numeric binary expression
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const numericOps = new Set<ts.SyntaxKind>([
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AmpersandToken,
        ts.SyntaxKind.BarToken,
        ts.SyntaxKind.CaretToken,
        ts.SyntaxKind.LessThanLessThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
      ]);
      if (numericOps.has(op)) {
        const isParamId = (e: ts.Expression): boolean => ts.isIdentifier(e) && e.text === paramName;
        // Skip when the OTHER operand is a string literal — `+` could mean
        // string concatenation. The TS checker will already have given us
        // a string-typed param in that case, so this guard is defensive.
        if (op === ts.SyntaxKind.PlusToken) {
          if (
            (isParamId(node.left) && !ts.isStringLiteral(node.right)) ||
            (isParamId(node.right) && !ts.isStringLiteral(node.left))
          ) {
            foundNumericUse = true;
            return;
          }
        } else {
          if (isParamId(node.left) || isParamId(node.right)) {
            foundNumericUse = true;
            return;
          }
        }
      }
    }

    forEachChild(node, visit);
  }
  forEachChild(decl.body, visit);
  return foundNumericUse ? { kind: "f64" } : null;
}

/**
 * #1121: Infer numeric (f64) return types for functions whose body is a
 * purely-numeric kernel even when TypeScript reports the return as
 * `any`/`unknown` (e.g. unannotated recursive helpers like
 * `function fib(n) { ... }`).
 *
 * We do a fixpoint over the entire source file:
 *  1. Seed: every function declaration whose TS return type is implicit
 *     any/unknown becomes a candidate for f64 promotion (assuming numeric).
 *  2. Iterate: a candidate stays in the set only while every `return X`
 *     in its body produces a value whose type is structurally numeric
 *     under the assumption that all other candidates also return f64.
 *  3. The fixpoint converges in O(N * passes) where passes is bounded by
 *     the number of candidates.
 *
 * This intentionally does NOT consider parameter types — by the time we
 * are called, the param-inference pass has already retyped each
 * implicit-any parameter via `inferParamTypeFromCallSites`. We only need
 * to fix the return-type side, which is what TS gives up on for
 * recursive numeric kernels.
 */
export function inferNumericReturnTypes(ctx: CodegenContext, sourceFile: ts.SourceFile): Map<string, ValType> {
  // Collect all function declarations whose return type TS reports as any/unknown.
  // These are the only functions we may promote.
  const candidates = new Map<string, ts.FunctionDeclaration>();
  function collectFns(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      // Skip if explicit return type annotation is present
      if (node.type) {
        return; // explicit annotation — TS already told us the answer
      }
      // Skip generator/async functions — return type semantics differ
      if (node.asteriskToken || node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        return;
      }
      const sig = ctx.checker.getSignatureFromDeclaration(node);
      if (!sig) return;
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      const isImplicitAny = (retType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      if (isImplicitAny) {
        candidates.set(node.name.text, node);
      }
    }
    forEachChild(node, collectFns);
  }
  forEachChild(sourceFile, collectFns);
  if (candidates.size === 0) return new Map();

  // Inference set: starts with all candidates, and shrinks as we eliminate
  // any whose body cannot uniformly return numeric.
  const numeric = new Set<string>(candidates.keys());

  /**
   * Returns true if `expr` produces a value that is structurally numeric
   * under the optimistic assumption that every name in `numeric` returns
   * f64.
   *
   * Conservative: any unrecognised construct returns false. A depth
   * guard (MAX_DEPTH = 64) bails out for pathological deeply-nested
   * source — the answer for those is conservatively `false`, leaving the
   * function on its TS-derived return type. This keeps the inference
   * runtime worst-case O(body_size) per call instead of growing with
   * unbounded source-AST depth.
   */
  const MAX_NUMERIC_DEPTH = 64;
  function isNumericExpr(expr: ts.Expression, paramNames: Set<string>, depth = 0): boolean {
    if (depth > MAX_NUMERIC_DEPTH) return false;
    if (ts.isParenthesizedExpression(expr)) {
      return isNumericExpr(expr.expression, paramNames, depth + 1);
    }
    if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
      return isNumericExpr(expr.expression, paramNames, depth + 1);
    }
    if (ts.isNumericLiteral(expr)) return true;
    if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isPrefixUnaryExpression(expr)) {
      const o = expr.operator;
      if (o === ts.SyntaxKind.PlusToken || o === ts.SyntaxKind.MinusToken || o === ts.SyntaxKind.TildeToken) {
        return isNumericExpr(expr.operand, paramNames, depth + 1);
      }
      if (o === ts.SyntaxKind.ExclamationToken) {
        return true; // !X is boolean → i32, treat as numeric
      }
      return false;
    }
    if (ts.isPostfixUnaryExpression(expr)) {
      // ++ / -- on a numeric local
      return isNumericExpr(expr.operand, paramNames, depth + 1);
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      const numericOps = new Set<ts.SyntaxKind>([
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AmpersandToken,
        ts.SyntaxKind.BarToken,
        ts.SyntaxKind.CaretToken,
        ts.SyntaxKind.LessThanLessThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
      ]);
      const cmpOps = new Set<ts.SyntaxKind>([
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ]);
      if (numericOps.has(op)) {
        return isNumericExpr(expr.left, paramNames, depth + 1) && isNumericExpr(expr.right, paramNames, depth + 1);
      }
      if (cmpOps.has(op)) {
        // Comparisons return boolean (i32), counted as numeric for our purposes.
        return isNumericExpr(expr.left, paramNames, depth + 1) && isNumericExpr(expr.right, paramNames, depth + 1);
      }
      // && / || / ?? return one of the operand types — accept only when both are numeric
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return isNumericExpr(expr.left, paramNames, depth + 1) && isNumericExpr(expr.right, paramNames, depth + 1);
      }
      return false;
    }
    if (ts.isConditionalExpression(expr)) {
      return (
        isNumericExpr(expr.whenTrue, paramNames, depth + 1) && isNumericExpr(expr.whenFalse, paramNames, depth + 1)
      );
    }
    if (ts.isIdentifier(expr)) {
      // Param of the function being checked → assumed numeric (we only run
      // this analysis when all params are already numeric).
      if (paramNames.has(expr.text)) return true;
      // Other identifiers: rely on the TS checker. This catches
      // numeric local variables, numeric module globals, etc. Implicit-any
      // identifiers fail this test (return false) — that is the safe answer.
      const t = ctx.checker.getTypeAtLocation(expr);
      if (
        (t.flags &
          (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral | ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
        0
      ) {
        return true;
      }
      return false;
    }
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      const calleeName = expr.expression.text;
      // Self-recursion / mutual recursion within our candidate set → assumed numeric
      if (numeric.has(calleeName)) {
        // Also require all arguments to be numeric (body still needs to
        // produce numeric values for the call to be a numeric kernel call)
        return expr.arguments.every((a) => isNumericExpr(a as ts.Expression, paramNames, depth + 1));
      }
      // Any other call: trust TS's reported return type
      const t = ctx.checker.getTypeAtLocation(expr);
      if (
        (t.flags &
          (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral | ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
        0
      ) {
        return true;
      }
      return false;
    }
    return false;
  }

  // One-time scan: collect all return expressions inside each candidate's
  // body, plus the param-name set and a precomputed param-numericness
  // check. Caching these means the fixpoint loop below does NOT re-walk
  // the AST on each iteration — it only re-runs `isNumericExpr` against
  // the cached return expressions. This bounds total work to O(candidates
  // × cached returns × MAX_NUMERIC_DEPTH) instead of repeating an O(body
  // size) walk per candidate per iteration.
  type FnInfo = {
    paramNames: Set<string>;
    returns: ts.Expression[];
    sawBareReturn: boolean;
    paramsAllNumeric: boolean;
  };
  const fnInfo = new Map<string, FnInfo>();
  for (const [fnName, fnDecl] of candidates) {
    const paramNames = new Set<string>();
    let paramsAllNumeric = true;
    for (const p of fnDecl.parameters) {
      if (ts.isIdentifier(p.name)) paramNames.add(p.name.text);
      const pt = ctx.checker.getTypeAtLocation(p);
      const isNumericTs =
        (pt.flags &
          (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral | ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
        0;
      const isImplicitAny = !p.type && (pt.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      if (!isNumericTs && !isImplicitAny) {
        paramsAllNumeric = false;
      }
    }
    const returns: ts.Expression[] = [];
    let sawBareReturn = false;
    if (fnDecl.body) {
      const visit = (node: ts.Node): void => {
        // Don't descend into nested function-likes — their returns belong to them
        if (
          node !== fnDecl &&
          (ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isAccessor(node) ||
            ts.isConstructorDeclaration(node))
        ) {
          return;
        }
        if (ts.isReturnStatement(node)) {
          if (node.expression) {
            returns.push(node.expression);
          } else {
            sawBareReturn = true;
          }
        }
        forEachChild(node, visit);
      };
      forEachChild(fnDecl.body, visit);
    }
    fnInfo.set(fnName, { paramNames, returns, sawBareReturn, paramsAllNumeric });
  }

  // Iterate to fixpoint: drop candidates that fail under the current set.
  // The set can only shrink, so the loop terminates in <= candidates.size
  // iterations. Each iteration is O(candidates × cached returns ×
  // MAX_NUMERIC_DEPTH) — no repeated AST walks of the function bodies.
  let changed = true;
  let safety = candidates.size + 1;
  while (changed && safety-- > 0) {
    changed = false;
    for (const fnName of candidates.keys()) {
      if (!numeric.has(fnName)) continue;
      const info = fnInfo.get(fnName)!;
      if (!info.paramsAllNumeric || info.sawBareReturn || info.returns.length === 0) {
        numeric.delete(fnName);
        changed = true;
        continue;
      }
      let allNumeric = true;
      for (const r of info.returns) {
        if (!isNumericExpr(r, info.paramNames)) {
          allNumeric = false;
          break;
        }
      }
      if (!allNumeric) {
        numeric.delete(fnName);
        changed = true;
      }
    }
  }

  // (#2795) Among the numeric kernels, identify the PURELY-BOOLEAN ones — every
  // `return` is a boolean-valued expression (literal `true`/`false`, a
  // comparison, `!x`, a boolean `&&`/`||`/`?:`, or a recursive call to another
  // boolean kernel). These promote to a boolean-BRANDED i32 instead of f64, so
  // when the result is later boxed into an `any`/externref slot (e.g. passed to
  // the host `console.log` of a mutually-recursive predicate) it crosses as the
  // JS boolean `true`/`false` rather than the number 1/0 (#2795 closures/10-mutual).
  // A boolean kernel's body still produces i32 0/1, so the brand is the only
  // change; arithmetic kernels keep f64.
  // (#1930 Slice 3) The boolean-producing SPINE is now defined once in the
  // oracle module (`isSyntacticallyBooleanExpr`, src/checker/oracle.ts —
  // Q-TAG's syntactic layer; see the issue's three-question doctrine). This
  // closure keeps ONLY what is local to the kernel fixpoint: live membership
  // of the evolving `boolean` candidate set, passed as the callable hook.
  // Accept-set is verbatim-identical to the pre-extraction matcher
  // (byte-diff-verified); MAX_NUMERIC_DEPTH (64) matches the spine's bound.
  const isBooleanExpr = (expr: ts.Expression, depth = 0): boolean =>
    isSyntacticallyBooleanExpr(expr, (name) => boolean.has(name) || name === "Boolean", depth);

  // Boolean kernels are a subset of the numeric kernels — seed with all of them
  // and shrink by the same fixpoint discipline (a candidate stays boolean only
  // while every return is boolean under the optimistic assumption that the other
  // candidates are boolean too).
  const boolean = new Set<string>(numeric);
  let bChanged = true;
  let bSafety = boolean.size + 1;
  while (bChanged && bSafety-- > 0) {
    bChanged = false;
    for (const fnName of [...boolean]) {
      const info = fnInfo.get(fnName)!;
      if (!info.returns.every((r) => isBooleanExpr(r))) {
        boolean.delete(fnName);
        bChanged = true;
      }
    }
  }

  const result = new Map<string, ValType>();
  for (const fnName of numeric) {
    result.set(fnName, boolean.has(fnName) ? { kind: "i32", boolean: true } : { kind: "f64" });
  }
  return result;
}
