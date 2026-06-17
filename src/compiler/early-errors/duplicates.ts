// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Duplicate-binding early-error rules (#1931): duplicate parameters, duplicate
// lexical declarations, switch-case lexical duplicates / leaks, duplicate
// private names, and var/lexical conflicts. Extracted verbatim from
// detectEarlyErrors; the only change is threading an EarlyErrorContext and
// importing the shared predicate helpers.
import { ts, forEachChild } from "../../ts-api.js";
import type { EarlyErrorContext } from "./context.js";
import {
  collectBindingNames,
  collectSwitchClauseLexicalNames,
  collectStatementListBoundNames,
  findNameReference,
  isStrictMode,
} from "./predicates.js";

export function checkDuplicateParams(
  ctx: EarlyErrorContext,
  params: ts.NodeArray<ts.ParameterDeclaration>,
  node: ts.Node,
) {
  // ES spec: Duplicate params are always forbidden in:
  // - strict mode functions
  // - arrow functions
  // - async functions
  // - generator functions
  // - methods
  // - functions with non-simple parameter lists (default, rest, destructuring)
  const alwaysForbid =
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
      (node.asteriskToken !== undefined || node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))) ||
    params.some((p) => p.initializer !== undefined || p.dotDotDotToken !== undefined || !ts.isIdentifier(p.name));
  if (!alwaysForbid && !isStrictMode(node)) return;
  const seen = new Set<string>();
  for (const param of params) {
    const names = new Set<string>();
    collectBindingNames(param.name, names);
    for (const name of names) {
      if (seen.has(name)) {
        ctx.addError(param, `Duplicate parameter name '${name}' not allowed`);
      }
      seen.add(name);
    }
  }
}

/** Check for duplicate lexical declarations (let, const, class, function) in a block. */
export function checkDuplicateLexicalDeclarations(ctx: EarlyErrorContext, block: ts.Block | ts.SourceFile): void {
  const stmts = block.statements;
  const lexNames = new Map<string, ts.Node>();

  function addLexName(name: string, errorNode: ts.Node) {
    if (lexNames.has(name)) {
      ctx.addError(errorNode, `Duplicate identifier '${name}'`);
    } else {
      lexNames.set(name, errorNode);
    }
  }

  for (const stmt of stmts) {
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      addLexName(stmt.name.text, stmt.name);
    }
    // FunctionDeclaration (including async, generator, async generator) in a block
    // are lexically scoped — duplicates are SyntaxErrors per ES spec.
    // Skip overload signatures (no body) — TypeScript allows multiple signatures.
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      addLexName(stmt.name.text, stmt.name);
    }
    if (ts.isVariableStatement(stmt)) {
      const flags = stmt.declarationList.flags;
      if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            addLexName(decl.name.text, decl.name);
          }
        }
      }
    }
  }
}

/** Check duplicate lexical declarations across switch case clauses. */
export function checkSwitchCaseLexicalDuplicates(ctx: EarlyErrorContext, caseBlock: ts.CaseBlock): void {
  const lexNames = new Map<string, ts.Node>(); // name -> first declaration
  const varNames = new Map<string, ts.Node>(); // name -> first var declaration
  for (const clause of caseBlock.clauses) {
    for (const stmt of clause.statements) {
      if (ts.isVariableStatement(stmt)) {
        const flags = stmt.declarationList.flags;
        if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              const name = decl.name.text;
              if (lexNames.has(name)) {
                ctx.addError(decl.name, `Cannot redeclare block-scoped variable '${name}'`);
              } else {
                lexNames.set(name, decl.name);
              }
              // Check var/lex conflict
              if (varNames.has(name)) {
                ctx.addError(decl.name, `Cannot redeclare block-scoped variable '${name}'`);
              }
            }
          }
        } else {
          // var declaration
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              const name = decl.name.text;
              if (!varNames.has(name)) varNames.set(name, decl.name);
              // Check lex/var conflict
              if (lexNames.has(name)) {
                ctx.addError(decl.name, `Cannot redeclare block-scoped variable '${name}'`);
              }
            }
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const name = stmt.name.text;
        if (lexNames.has(name)) {
          ctx.addError(stmt.name, `Cannot redeclare block-scoped variable '${name}'`);
        } else {
          lexNames.set(name, stmt.name);
        }
        // Check var/lex conflict
        if (varNames.has(name)) {
          ctx.addError(stmt.name, `Cannot redeclare block-scoped variable '${name}'`);
        }
      } else if (ts.isClassDeclaration(stmt) && stmt.name) {
        const name = stmt.name.text;
        if (lexNames.has(name)) {
          ctx.addError(stmt.name, `Cannot redeclare block-scoped variable '${name}'`);
        } else {
          lexNames.set(name, stmt.name);
        }
        // Check var/lex conflict
        if (varNames.has(name)) {
          ctx.addError(stmt.name, `Cannot redeclare block-scoped variable '${name}'`);
        }
      }
    }
  }
}

/**
 * Flag references to a switch CaseBlock's lexically-declared names that
 * appear in sibling statements *after* the switch in the same statement
 * list (#1805). Such a reference resolves to no runtime binding and throws
 * a ReferenceError. Emitted as a warning so compilation continues; the
 * test262 runtime-negative path treats any warning as the expected error.
 */
export function checkSwitchLexicalLeak(ctx: EarlyErrorContext, stmts: ts.NodeArray<ts.Statement>): void {
  // Find switch statements that are direct children of this statement list.
  const switchPositions: { index: number; names: Set<string> }[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]!;
    if (ts.isSwitchStatement(stmt)) {
      const names = collectSwitchClauseLexicalNames(stmt.caseBlock);
      if (names.size > 0) switchPositions.push({ index: i, names });
    }
  }
  if (switchPositions.length === 0) return;

  const outerNames = collectStatementListBoundNames(stmts);

  for (const { index, names } of switchPositions) {
    for (const name of names) {
      // If the enclosing scope also binds this name, the reference is legal.
      if (outerNames.has(name)) continue;
      // Scan statements after the switch for a reference to the leaked name.
      for (let j = index + 1; j < stmts.length; j++) {
        const ref = findNameReference(stmts[j]!, name);
        if (ref) {
          const p = ctx.pos(ref);
          ctx.errors.push({
            message: `'${name}' is not defined — switch-case lexical binding does not leak out of the switch block`,
            line: p.line,
            column: p.column,
            severity: "warning",
          });
          break;
        }
      }
    }
  }
}

/** Check for duplicate private names in a class body. */
export function checkDuplicatePrivateNames(
  ctx: EarlyErrorContext,
  classNode: ts.ClassDeclaration | ts.ClassExpression,
): void {
  const privateNames = new Map<string, { kinds: Set<string>; isStatic: boolean }>();
  for (const member of classNode.members) {
    if (member.name && ts.isPrivateIdentifier(member.name)) {
      const name = member.name.text;
      const memberIsStatic = ts.canHaveModifiers(member)
        ? (ts.getModifiers(member as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
        : false;
      let kind: string;
      if (ts.isGetAccessorDeclaration(member)) {
        kind = "get";
      } else if (ts.isSetAccessorDeclaration(member)) {
        kind = "set";
      } else if (ts.isMethodDeclaration(member)) {
        kind = "method";
      } else if (ts.isPropertyDeclaration(member)) {
        kind = "field";
      } else {
        kind = "other";
      }

      const existing = privateNames.get(name);
      if (!existing) {
        privateNames.set(name, {
          kinds: new Set([kind]),
          isStatic: memberIsStatic,
        });
      } else {
        // get+set pair is allowed ONLY if both have the same staticness
        const combined = new Set([...existing.kinds, kind]);
        if (combined.size === 2 && combined.has("get") && combined.has("set") && existing.isStatic === memberIsStatic) {
          // This is fine — getter+setter pair with same staticness
          existing.kinds.add(kind);
        } else {
          ctx.addError(member.name, `Duplicate private name '${name}'`);
        }
      }
    }
  }
}

/** Check for var/lexical declaration conflicts in a block or source file. */
export function checkVarLexicalConflicts(ctx: EarlyErrorContext, block: ts.Block | ts.SourceFile): void {
  // Collect lexically-declared names (let, const, function, class)
  const lexicalNames = new Set<string>();
  for (const stmt of block.statements) {
    if (ts.isVariableStatement(stmt)) {
      const flags = stmt.declarationList.flags;
      if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            lexicalNames.add(decl.name.text);
          }
        }
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      // At SourceFile scope, function declarations are var-scoped — no conflict with var
      // (LexicallyDeclaredNames does not include VarDeclaredNames per ES §13.1.1).
      // Only inside a Block are function declarations lexically scoped (ES §B.3.2).
      if (ts.isBlock(block)) {
        lexicalNames.add(stmt.name.text);
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      lexicalNames.add(stmt.name.text);
    }
  }

  if (lexicalNames.size === 0) return;

  // Check var declarations against lexical names — including vars in nested blocks
  // (var hoists to the enclosing function/module scope, so `{ let x; { var x; } }` is a conflict)
  collectVarDeclaredNamesInBlock(ctx, block, lexicalNames);
}

export function collectVarDeclaredNamesInBlock(ctx: EarlyErrorContext, node: ts.Node, lexicalNames: Set<string>): void {
  if (ts.isVariableStatement(node)) {
    const flags = node.declarationList.flags;
    if ((flags & ts.NodeFlags.Let) === 0 && (flags & ts.NodeFlags.Const) === 0) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && lexicalNames.has(decl.name.text)) {
          ctx.addError(decl.name, `Cannot redeclare block-scoped variable '${decl.name.text}'`);
        }
      }
    }
    return;
  }
  // Don't cross function boundaries (var doesn't hoist past functions)
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  ) {
    return;
  }
  forEachChild(node, (child) => collectVarDeclaredNamesInBlock(ctx, child, lexicalNames));
}
