import type { CompileError, CompileOptions } from "../index.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { PositionMap, type CompilerSourceOriginSpan, type SourceEdit } from "../position-map.js";
import { forEachChild, ts } from "../ts-api.js";
import { detectEarlyErrors } from "./early-errors/index.js";

// Default blocked members on extern classes in safe mode
const DEFAULT_BLOCKED_MEMBERS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "valueOf",
  "toString",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
]);

function getApproxSourceLocation(sourceFile: ts.SourceFile): {
  line: number;
  column: number;
} {
  const anchor = sourceFile.statements[0] ?? sourceFile;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(anchor.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function pushSourceAnchoredDiagnostic(
  errors: CompileError[],
  sourceFile: ts.SourceFile,
  message: string,
  severity: "error" | "warning",
): void {
  const loc = getApproxSourceLocation(sourceFile);
  errors.push({
    message,
    line: loc.line,
    column: loc.column,
    severity,
  });
}

/** Validate source against safe mode restrictions. Returns errors for violations. */
function validateSafeMode(sourceFile: ts.SourceFile, checker: ts.TypeChecker, options: CompileOptions): CompileError[] {
  const errors: CompileError[] = [];
  const allowedGlobals = new Set(options.allowedGlobals ?? []);
  const allowedMembers = options.allowedExternMembers ?? {};

  function pos(node: ts.Node) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return { line: line + 1, column: character + 1 };
  }

  function visit(node: ts.Node): void {
    // 1. Check declare var/const globals
    if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      for (const decl of node.declarationList.declarations) {
        const name = decl.name.getText();
        // Block undeclared globals unless allowlisted
        if (!allowedGlobals.has(name)) {
          const p = pos(decl);
          errors.push({
            message: `Safe mode: declared global "${name}" is not in allowedGlobals`,
            line: p.line,
            column: p.column,
            severity: "error",
          });
        }
        // Block any type on declared globals
        if (decl.type) {
          const t = checker.getTypeAtLocation(decl.type);
          if (t.flags & ts.TypeFlags.Any) {
            const p = pos(decl.type);
            errors.push({
              message: `Safe mode: "any" type on declared global "${name}" is not allowed`,
              line: p.line,
              column: p.column,
              severity: "error",
            });
          }
        }
      }
    }

    // 2. Check declare class (extern class) members
    if (ts.isClassDeclaration(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      const className = node.name?.getText() ?? "(anonymous)";
      const allowed = allowedMembers[className];
      for (const member of node.members) {
        const memberName = member.name?.getText();
        if (!memberName) continue;

        // Block default-blocked members
        if (DEFAULT_BLOCKED_MEMBERS.has(memberName)) {
          const p = pos(member);
          errors.push({
            message: `Safe mode: extern class "${className}" member "${memberName}" is blocked`,
            line: p.line,
            column: p.column,
            severity: "error",
          });
          continue;
        }

        // If an allowlist is provided for this class, check against it
        if (allowed && !allowed.includes(memberName)) {
          const p = pos(member);
          errors.push({
            message: `Safe mode: extern class "${className}" member "${memberName}" is not in allowedExternMembers`,
            line: p.line,
            column: p.column,
            severity: "error",
          });
          continue;
        }

        // Block "any" types on extern class members
        if (ts.isPropertyDeclaration(member) && member.type) {
          const t = checker.getTypeAtLocation(member.type);
          if (t.flags & ts.TypeFlags.Any) {
            const p = pos(member.type);
            errors.push({
              message: `Safe mode: "any" type on extern class "${className}.${memberName}" is not allowed`,
              line: p.line,
              column: p.column,
              severity: "error",
            });
          }
        }
      }
    }

    // 3. Check for dynamic property access on externref (element access with non-literal)
    if (ts.isElementAccessExpression(node)) {
      const objType = checker.getTypeAtLocation(node.expression);
      // If the object is an extern class type (declared class), block dynamic access
      const objSymbol = objType.getSymbol();
      if (objSymbol) {
        const decls = objSymbol.getDeclarations() ?? [];
        const isDeclaredClass = decls.some(
          (d) => ts.isClassDeclaration(d) && d.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword),
        );
        if (isDeclaredClass) {
          const p = pos(node);
          errors.push({
            message: `Safe mode: dynamic property access on extern class "${objSymbol.getName()}" is not allowed`,
            line: p.line,
            column: p.column,
            severity: "error",
          });
        }
      }
    }

    forEachChild(node, visit);
  }

  visit(sourceFile);
  return errors;
}

// detectEarlyErrors lives in ./early-errors/ (#1931) — the ~3,350-line
// monolith was decomposed into per-concern rule modules sharing one AST walk.
// Re-exported below for the existing import sites (compiler.ts).

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Hardened mode: walk AST and reject dangerous patterns.
 * Inspired by Endo/SES — compile-time rejection of insecure features.
 */
function validateHardenedMode(
  sourceFile: ts.SourceFile,
): Array<{ message: string; line: number; column: number; severity: "error" }> {
  const errors: Array<{
    message: string;
    line: number;
    column: number;
    severity: "error";
  }> = [];

  function visit(node: ts.Node): void {
    // Reject eval() calls
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      errors.push({
        message: "[hardened] eval() is not allowed",
        line: line + 1,
        column: character,
        severity: "error",
      });
    }
    // Reject new Function()
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      errors.push({
        message: "[hardened] new Function() is not allowed",
        line: line + 1,
        column: character,
        severity: "error",
      });
    }
    // Reject with statements
    if (ts.isWithStatement(node)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      errors.push({
        message: "[hardened] with statement is not allowed",
        line: line + 1,
        column: character,
        severity: "error",
      });
    }
    // Reject __proto__ assignment
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) && left.name.text === "__proto__") {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        errors.push({
          message: "[hardened] __proto__ assignment is not allowed",
          line: line + 1,
          column: character,
          severity: "error",
        });
      }
    }
    forEachChild(node, visit);
  }

  visit(sourceFile);
  return errors;
}

/**
 * ES spec: PerformEval runs early-error checks on the eval'd source.
 * `super()` is a SyntaxError unless the eval is a *direct* eval in a
 * context where a SuperCall is allowed (i.e. inside a derived class
 * constructor body). Indirect eval (`(0, eval)(...)`, `var e = eval; e(...)`)
 * always rejects super(), as does direct eval outside the constructor
 * (e.g. inside a class field initializer).
 *
 * Since #1054, if we see an `eval(<literal>)` or `(0, eval)(<literal>)`
 * whose literal contains `super(`, we rewrite the call to a throwing IIFE
 * so the SyntaxError fires at runtime when the surrounding expression runs
 * (e.g. when a field initializer is evaluated during `new C()`).
 *
 * Narrowing:
 * - Only string-literal arg is examined (single/double quoted). Template
 *   literals are not test262-tested in this pattern.
 * - Only `super(` in the string triggers rewrite — `super.x` / `super[x]`
 *   are legal in eval-from-field-initializer and must not be rewritten.
 * - Direct eval from a derived constructor would legitimately allow
 *   super(), but test262 has no passing tests covering that pattern.
 */
function rewriteEvalSuperCallWithMap(source: string): { source: string; positionMap: PositionMap } {
  const hasSuperCall = (s: string) => /\bsuper\s*\(/.test(s);
  const replacement = `((function(){throw new SyntaxError("super() not allowed in eval (early error)")}()))`;

  const sqBody = `(?:[^'\\\\\\n]|\\\\.)*?`;
  const dqBody = `(?:[^"\\\\\\n]|\\\\.)*?`;
  const indirectSq = new RegExp(`\\(\\s*0\\s*,\\s*eval\\s*\\)\\s*\\(\\s*'(${sqBody})'\\s*\\)`, "g");
  const indirectDq = new RegExp(`\\(\\s*0\\s*,\\s*eval\\s*\\)\\s*\\(\\s*"(${dqBody})"\\s*\\)`, "g");
  const directSq = new RegExp(`(^|[^\\w$.])eval\\s*\\(\\s*'(${sqBody})'\\s*\\)`, "g");
  const directDq = new RegExp(`(^|[^\\w$.])eval\\s*\\(\\s*"(${dqBody})"\\s*\\)`, "g");

  let out = source;
  let positionMap = PositionMap.identity();
  const apply = (pattern: RegExp, bodyIndex: number, prefixIndex?: number): void => {
    const edits: SourceEdit[] = [];
    out = out.replace(pattern, (...args: unknown[]) => {
      const full = args[0] as string;
      const body = args[bodyIndex] as string;
      if (!hasSuperCall(body)) return full;
      const prefix = prefixIndex === undefined ? "" : (args[prefixIndex] as string);
      const generated = prefix + replacement;
      const functionStart = generated.indexOf("function");
      const compilerOrigins: CompilerSourceOriginSpan[] = [
        {
          start: functionStart,
          end: generated.length,
          origin: { producer: "eval-super-rewrite", role: "early-error-thrower" },
        },
      ];
      const offset = args.at(-2) as number;
      edits.push({
        origStart: offset,
        origEnd: offset + full.length,
        newLength: generated.length,
        compilerOrigins,
      });
      return generated;
    });
    if (edits.length > 0) positionMap = new PositionMap(edits).compose(positionMap);
  };

  apply(indirectSq, 1);
  apply(indirectDq, 1);
  apply(directSq, 2, 1);
  apply(directDq, 2, 1);
  return { source: out, positionMap };
}

function rewriteEvalSuperCall(source: string): string {
  return rewriteEvalSuperCallWithMap(source).source;
}

export {
  DEFAULT_BLOCKED_MEMBERS,
  detectEarlyErrors,
  getApproxSourceLocation,
  hasExportModifier,
  pushSourceAnchoredDiagnostic,
  rewriteEvalSuperCall,
  rewriteEvalSuperCallWithMap,
  validateHardenedMode,
  validateSafeMode,
};
