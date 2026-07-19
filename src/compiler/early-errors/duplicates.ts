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
  collectBindingNamesWithDuplicateCheck,
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
  // `seen` is shared across every parameter so an INTER-param duplicate
  // (`(x, x) => …`) is caught; `collectBindingNamesWithDuplicateCheck` also
  // records INTRA-param duplicates that a single destructuring parameter binds
  // more than once (`([x, x]) => …`, `({y: x, x}) => …`) — a plain Set collapses
  // those, which is why the previous per-param Set missed them. BoundNames of a
  // FormalParameterList / ArrowFormalParameters must contain no duplicates.
  const seen = new Set<string>();
  for (const param of params) {
    const dupes = new Set<string>();
    collectBindingNamesWithDuplicateCheck(param.name, seen, dupes);
    for (const name of dupes) {
      ctx.addError(param, `Duplicate parameter name '${name}' not allowed`);
    }
  }
}

/**
 * Check for duplicate lexical declarations (let, const, class, function) in a
 * block or at the top level of a SourceFile.
 *
 * Scoping of FunctionDeclarations (#3419 — this distinction is load-bearing):
 *
 * - **Script top level**: VAR-scoped. §16.1.1 gates duplicates on the
 *   LexicallyDeclaredNames of ScriptBody, which is TopLevelLexicallyDeclaredNames
 *   (§8.2.8) and EXCLUDES HoistableDeclarations. `function f(){} function f(){}`
 *   at script top level is legal — strict OR sloppy — with last-wins binding
 *   (GlobalDeclarationInstantiation §16.1.7 instantiates the LAST definition per
 *   name). The test262 harness concatenation (assert.js + testTypedArray.js both
 *   define `isPrimitive`) depends on this.
 * - **Function-body / class-static-block top level**: VAR-scoped, same reason
 *   (§10.2.11 / §15.7.1 use the TopLevel* operations).
 * - **Module top level**: LEXICAL (§16.2.1.1 — LexicallyDeclaredNames of
 *   ModuleItemList includes HoistableDeclarations). Duplicates are SyntaxErrors
 *   (test262 `language/module-code/early-dup-top-function*.js`).
 * - **Genuine nested Block**: LEXICAL (§14.2.1) — but Annex B §B.3.2.1 lifts the
 *   duplicate-entries rule in sloppy mode when EVERY binding for the name is a
 *   plain (non-async, non-generator) FunctionDeclaration.
 *
 * Var-scoped function names still conflict with genuinely lexical names in the
 * same statement list (§16.1.1: LexicallyDeclaredNames ∩ VarDeclaredNames must
 * be empty), so `function f(){} let f;` remains a SyntaxError in both orders.
 */
export function checkDuplicateLexicalDeclarations(
  ctx: EarlyErrorContext,
  block: ts.Block | ts.SourceFile,
  moduleGoal = false,
): void {
  const stmts = block.statements;
  const functionsAreLexical = ts.isSourceFile(block)
    ? moduleGoal || ts.isExternalModule(block)
    : !isFunctionBodyBlock(block);
  // Annex B §B.3.2.1 applies only to Blocks (never module/script top level).
  const annexBEligible = ts.isBlock(block);
  const lexNames = new Map<string, ts.Node>();
  /** Lexical names bound (so far) ONLY by plain FunctionDeclarations (Annex B). */
  const fnOnlyLexNames = new Set<string>();
  /** Var-scoped top-level FunctionDeclaration names (script / function-body). */
  const varFnNames = new Map<string, ts.Node>();

  function addLexName(name: string, errorNode: ts.Node, viaPlainFunction = false) {
    if (lexNames.has(name)) {
      // Annex B §B.3.2.1: sloppy-mode Blocks tolerate duplicate entries when
      // every binding for the name is a plain FunctionDeclaration.
      if (viaPlainFunction && fnOnlyLexNames.has(name) && annexBEligible && !isStrictMode(errorNode)) {
        return;
      }
      ctx.addError(errorNode, `Duplicate identifier '${name}'`);
      return;
    }
    if (varFnNames.has(name)) {
      // A lexical declaration colliding with a var-scoped function name
      // (§16.1.1 LexicallyDeclaredNames ∩ VarDeclaredNames).
      ctx.addError(errorNode, `Duplicate identifier '${name}'`);
      return;
    }
    lexNames.set(name, errorNode);
    if (viaPlainFunction) {
      fnOnlyLexNames.add(name);
    } else {
      fnOnlyLexNames.delete(name);
    }
  }

  for (const stmt of stmts) {
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      addLexName(stmt.name.text, stmt.name);
    }
    // Skip overload signatures (no body) — TypeScript allows multiple signatures.
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      if (functionsAreLexical) {
        const isPlain =
          stmt.asteriskToken === undefined && !stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
        addLexName(stmt.name.text, stmt.name, isPlain);
      } else {
        // Var-scoped: duplicates among functions are legal (last-wins), but a
        // collision with a lexical (let/const/class) name is a SyntaxError.
        if (lexNames.has(stmt.name.text)) {
          ctx.addError(stmt.name, `Duplicate identifier '${stmt.name.text}'`);
        } else {
          varFnNames.set(stmt.name.text, stmt.name);
        }
      }
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

/**
 * A switch CaseBlock may contain at most one DefaultClause. ES2015+
 * (`SwitchStatement` → `CaseBlock`) Static Semantics: Early Errors —
 * `CaseBlock : { CaseClauses_opt DefaultClause CaseClauses_opt }` — it is a
 * Syntax Error if a CaseBlock contains more than one DefaultClause. TypeScript's
 * parser accepts a second `default:` clause with no diagnostic, so nothing else
 * detects it. Covers test262 `language/statements/switch/S12.11_A2_T1.js`.
 */
export function checkDuplicateDefaultClause(ctx: EarlyErrorContext, caseBlock: ts.CaseBlock): void {
  let seenDefault = false;
  for (const clause of caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) {
      if (seenDefault) {
        ctx.addError(clause, "More than one default clause in switch statement");
      } else {
        seenDefault = true;
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

/**
 * True when `block` is the *body* of a function-like node (function
 * declaration/expression, arrow, method, constructor, or accessor).
 *
 * At the top level of such a body — exactly as at SourceFile (Script/Module)
 * scope — a FunctionDeclaration is VAR-scoped, not lexical: the top-level
 * statement list uses TopLevelLexicallyDeclaredNames, which excludes
 * HoistableDeclarations (ES §15.2.2 / FunctionBody §10.2.11). So a same-name
 * `var` and function declaration legally coexist there
 * (`function test(){ var f; function f(){} }` is valid, matching V8).
 *
 * Only inside a *genuine nested Block statement* (parent is a statement — if /
 * for / while / labeled / a `{ }` block, etc.) is a FunctionDeclaration
 * lexically scoped (ES §14.2.1), where `{ var f; function f(){} }` IS a
 * SyntaxError in both strict and sloppy mode — Annex B relaxes only the
 * duplicate-FunctionDeclaration rule, never lexical-vs-var.
 */
function isFunctionBodyBlock(block: ts.Block | ts.SourceFile): boolean {
  if (!ts.isBlock(block)) return false;
  const parent = block.parent;
  return (
    !!parent &&
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isConstructorDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      // ClassStaticBlockBody uses the TopLevel* static semantics too (§15.7.1):
      // its top-level FunctionDeclarations are var-scoped, same as a function body.
      ts.isClassStaticBlockDeclaration(parent))
  );
}

/** Check for var/lexical declaration conflicts in a block or source file. */
export function checkVarLexicalConflicts(ctx: EarlyErrorContext, block: ts.Block | ts.SourceFile): void {
  // A FunctionDeclaration contributes a lexical binding (that a same-name `var`
  // conflicts with) only inside a genuine nested Block statement — not at
  // SourceFile scope nor at the top level of a function body, where it is
  // var-scoped. See isFunctionBodyBlock.
  const functionsAreLexical = ts.isBlock(block) && !isFunctionBodyBlock(block);
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
      // At SourceFile scope AND at the top level of a function body, function
      // declarations are var-scoped — no conflict with a same-name var
      // (TopLevelLexicallyDeclaredNames excludes HoistableDeclarations,
      // ES §15.2.2 / §10.2.11). Only inside a genuine nested Block are they
      // lexically scoped (ES §14.2.1 + §B.3.2).
      if (functionsAreLexical) {
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
