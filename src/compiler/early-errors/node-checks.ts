// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Per-node ES early-error checks (#1931). This is the decomposed form of the
// monolithic `visit` walk that detectEarlyErrors used to run inline: a flat
// dispatch over node kinds that delegates to the per-concern rule modules.
// Extracted verbatim — the only changes are threading an EarlyErrorContext and
// importing the shared predicate / rule helpers, so behaviour is identical.
import { ts, forEachChild } from "../../ts-api.js";
import type { EarlyErrorContext } from "./context.js";
import {
  collectBindingNames,
  collectBindingNamesWithDuplicateCheck,
  containsArguments,
  getMemberName,
  hasAsyncModifier,
  hasOptionalChain,
  isArgumentsOrEval,
  isAsiLetExpressionStatement,
  isAssignmentPatternContext,
  isCallExpressionTarget,
  isInsideAsyncFunction,
  isInsideAsyncParams,
  isInsideBreakable,
  isInsideClassConstructor,
  isInsideClassStaticBlock,
  isInsideClassWithPrivateName,
  isInsideFunction,
  isInsideGeneratorFunction,
  isInsideGeneratorParams,
  isInsideIteration,
  isInsideMethod,
  isInsideNestedFunction,
  isInvalidAssignmentTarget,
  isStatementPosition,
  isStrictMode,
  isUsingDeclarationStatement,
} from "./predicates.js";
import { validateArrayAssignmentPattern, validateObjectAssignmentPattern } from "./assignment.js";
import {
  checkDuplicateLexicalDeclarations,
  checkDuplicateParams,
  checkDuplicatePrivateNames,
  checkSwitchCaseLexicalDuplicates,
  checkSwitchLexicalLeak,
  checkVarLexicalConflicts,
  collectVarDeclaredNamesInBlock,
} from "./duplicates.js";
import { checkDuplicateLabelsInBlock } from "./labels.js";
import { checkTDZInStatements } from "./tdz.js";

/**
 * Run all per-node early-error checks rooted at `node`, recursing into its
 * descendants. Equivalent to the original detectEarlyErrors `visit` closure.
 */
export function runNodeChecks(ctx: EarlyErrorContext, node: ts.Node): void {
  // Check prefix/postfix increment/decrement on arguments/eval in strict mode
  // Also check increment/decrement on optional chaining (always invalid)
  // Also check increment/decrement on non-simple assignment targets
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    const name = isArgumentsOrEval(node.operand);
    if (name && isStrictMode(node)) {
      ctx.addError(node, `Invalid use of '${name}' in strict mode`);
    }
    if (hasOptionalChain(node.operand)) {
      ctx.addError(node, "Optional chaining is not valid in the left-hand side of an update expression");
    }
    if (isInvalidAssignmentTarget(node.operand)) {
      ctx.addError(node, "Invalid left-hand side expression in prefix operation");
    }
    // In strict mode, call expressions as update targets are SyntaxErrors
    if (isCallExpressionTarget(node.operand) && isStrictMode(node)) {
      ctx.addError(node, "Invalid left-hand side expression in prefix operation");
    }
  }

  if (
    ts.isPostfixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    const name = isArgumentsOrEval(node.operand);
    if (name && isStrictMode(node)) {
      ctx.addError(node, `Invalid use of '${name}' in strict mode`);
    }
    if (hasOptionalChain(node.operand)) {
      ctx.addError(node, "Optional chaining is not valid in the left-hand side of an update expression");
    }
    if (isInvalidAssignmentTarget(node.operand)) {
      ctx.addError(node, "Invalid left-hand side in postfix operation");
    }
    // In strict mode, call expressions as update targets are SyntaxErrors
    if (isCallExpressionTarget(node.operand) && isStrictMode(node)) {
      ctx.addError(node, "Invalid left-hand side in postfix operation");
    }
    // ES spec: no LineTerminator between LeftHandSideExpression and ++/--.
    // U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) between
    // operand and operator are SyntaxErrors. Regular \n and \r are handled
    // by the TS parser's ASI, but these Unicode separators are not.
    const operandEnd = node.operand.end;
    const opStart = node.operand.end; // operator immediately follows operand in AST
    const textBetween = ctx.sourceFile.text.substring(operandEnd, node.end - 2);
    if (/[\u2028\u2029]/.test(textBetween)) {
      ctx.addError(node, "No line terminator allowed before postfix operator");
    }
  }

  // Check assignment to arguments/eval in strict mode
  // Also check assignment to non-simple targets
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const name = isArgumentsOrEval(node.left);
    if (name && isStrictMode(node)) {
      ctx.addError(node.left, `Cannot assign to '${name}' in strict mode`);
    }
    if (hasOptionalChain(node.left)) {
      ctx.addError(node, "Optional chaining is not valid in the left-hand side of an assignment expression");
    }
    if (isInvalidAssignmentTarget(node.left, /* allowDestructuring */ true)) {
      ctx.addError(node, "Invalid left-hand side in assignment");
    }
    // When LHS is an array or object literal, validate it as an AssignmentPattern
    const lhs = node.left;
    if (ts.isArrayLiteralExpression(lhs)) {
      validateArrayAssignmentPattern(ctx, lhs, isStrictMode(node));
    } else if (ts.isObjectLiteralExpression(lhs)) {
      validateObjectAssignmentPattern(ctx, lhs, isStrictMode(node));
    }
  }

  // Check compound assignment to arguments/eval in strict mode
  // Also check logical assignment (&&=, ||=, ??=) to non-simple targets
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    const compoundOps = [
      ts.SyntaxKind.PlusEqualsToken,
      ts.SyntaxKind.MinusEqualsToken,
      ts.SyntaxKind.AsteriskEqualsToken,
      ts.SyntaxKind.SlashEqualsToken,
      ts.SyntaxKind.PercentEqualsToken,
      ts.SyntaxKind.AmpersandEqualsToken,
      ts.SyntaxKind.BarEqualsToken,
      ts.SyntaxKind.CaretEqualsToken,
      ts.SyntaxKind.LessThanLessThanEqualsToken,
      ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
      ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
      ts.SyntaxKind.AsteriskAsteriskEqualsToken,
      ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.BarBarEqualsToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
    ];
    if (compoundOps.includes(op)) {
      const name = isArgumentsOrEval(node.left);
      if (name && isStrictMode(node)) {
        ctx.addError(node.left, `Cannot assign to '${name}' in strict mode`);
      }
      if (hasOptionalChain(node.left)) {
        ctx.addError(node, "Optional chaining is not valid in the left-hand side of an assignment expression");
      }
      // Compound assignment to non-simple targets (call expressions, binary, etc.)
      if (isInvalidAssignmentTarget(node.left)) {
        ctx.addError(node, "Invalid left-hand side in assignment");
      }
    }
  }

  // Check for-in/for-of with non-simple assignment target as LHS
  if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
    const lhs = node.initializer as ts.Expression;
    if (isInvalidAssignmentTarget(lhs, /* allowDestructuring */ true)) {
      ctx.addError(node.initializer, "Invalid left-hand side in for-in/for-of");
    }
    // When LHS is an array or object literal, validate it as AssignmentPattern
    if (ts.isArrayLiteralExpression(lhs)) {
      validateArrayAssignmentPattern(ctx, lhs, isStrictMode(node));
    } else if (ts.isObjectLiteralExpression(lhs)) {
      validateObjectAssignmentPattern(ctx, lhs, isStrictMode(node));
    }
  }

  // Check duplicate parameters in strict mode functions
  if (ts.isFunctionDeclaration(node) && node.parameters) {
    checkDuplicateParams(ctx, node.parameters, node);
  }
  if (ts.isFunctionExpression(node) && node.parameters) {
    checkDuplicateParams(ctx, node.parameters, node);
  }
  if (ts.isArrowFunction(node) && node.parameters) {
    checkDuplicateParams(ctx, node.parameters, node);
    // ── Arrow function ASI restriction ────────────────────────────
    // ES spec: ArrowFunction : ArrowParameters [no LineTerminator here] => ConciseBody
    // If there is a LineTerminator between parameters and =>, it is a SyntaxError.
    // TypeScript's parser handles this but may still produce an ArrowFunction node.
    // Check by looking at the source text between end of params and the => token.
    if (node.equalsGreaterThanToken) {
      const paramsEnd = node.parameters.end;
      const arrowStart = node.equalsGreaterThanToken.getStart(ctx.sourceFile);
      const textBetween = ctx.sourceFile.text.substring(paramsEnd, arrowStart);
      if (/[\r\n\u2028\u2029]/.test(textBetween)) {
        ctx.addError(node, "Arrow function parameters and '=>' must be on the same line");
      }
    }
  }
  if (ts.isMethodDeclaration(node) && node.parameters) {
    checkDuplicateParams(ctx, node.parameters, node);
  }

  // ── YieldExpression in generator default parameters ──────────────
  // ES spec: It is a SyntaxError if FormalParameters of a generator
  // function Contains YieldExpression. Default parameter values are
  // evaluated before the generator body, so yield is not valid there.
  // Same applies to async generators (AwaitExpression in params).
  if (ts.isYieldExpression(node)) {
    if (isInsideGeneratorParams(node)) {
      ctx.addError(node, "Yield expression is not allowed in generator function parameters");
    }
  }
  if (ts.isAwaitExpression(node)) {
    if (isInsideAsyncParams(node)) {
      ctx.addError(node, "Await expression is not allowed in async function parameters");
    }
  }

  // Check yield used as identifier in generator functions/methods
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "yield") {
    // Check if inside a generator function/method
    let parent: ts.Node | undefined = node.parent;
    while (parent) {
      if (
        ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.asteriskToken) ||
        (ts.isMethodDeclaration(parent) && parent.asteriskToken)
      ) {
        ctx.addError(
          node.name,
          "'yield' is a reserved word and cannot be used as an identifier in generator functions",
        );
        break;
      }
      if (
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isArrowFunction(parent) ||
        ts.isMethodDeclaration(parent)
      ) {
        break; // Found enclosing non-generator function, stop
      }
      parent = parent.parent;
    }
  }

  // Check function declarations in statement position
  // ES spec: GeneratorDeclaration and AsyncFunctionDeclaration are never valid in
  // SingleStatement position. Regular FunctionDeclaration is SyntaxError in strict mode.
  // Annex B relaxes this ONLY for IfStatement in sloppy mode — iteration statements
  // (for, while, do, for-in, for-of) and with statements always forbid it.
  if (ts.isFunctionDeclaration(node)) {
    const parent = node.parent;
    if (parent && isStatementPosition(parent, node)) {
      if (node.asteriskToken) {
        ctx.addError(node, "Generator declarations are not allowed in statement position");
      } else if (hasAsyncModifier(node)) {
        ctx.addError(node, "Async function declarations are not allowed in statement position");
      } else if (isStrictMode(node)) {
        ctx.addError(node, "In strict mode code, functions can only be declared at top level or inside a block");
      } else if (!ts.isIfStatement(parent) && !ts.isLabeledStatement(parent)) {
        // Sloppy mode: Annex B only allows FunctionDeclaration in IfStatement body.
        // In iteration statements (for, while, do, for-in, for-of) and with statements
        // it is always a SyntaxError.
        ctx.addError(node, "Function declarations are not allowed in statement position");
      }
    }
  }

  // Check class declaration in statement position — always a SyntaxError
  // ES spec: ClassDeclaration is not a Statement — only allowed in StatementList
  if (ts.isClassDeclaration(node)) {
    const parent = node.parent;
    if (parent && isStatementPosition(parent, node)) {
      ctx.addError(node, "Class declaration not allowed in statement position");
    }
  }

  // Check labeled function declarations in iteration/if statement positions
  // ES spec: IsLabelledFunction — a labeled function declaration (at any label depth)
  // in the Statement position of for/while/do-while/if/with is always a SyntaxError.
  if (ts.isLabeledStatement(node)) {
    const parent = node.parent;
    if (parent && isStatementPosition(parent, node)) {
      // Check if the innermost statement (through label nesting) is a function/class declaration
      let inner: ts.Statement = node.statement;
      while (ts.isLabeledStatement(inner)) inner = inner.statement;
      if (ts.isFunctionDeclaration(inner)) {
        ctx.addError(node, "Function declaration in a labeled statement within iteration/if body is a SyntaxError");
      }
      if (ts.isClassDeclaration(inner)) {
        ctx.addError(node, "Class declaration not allowed in statement position");
      }
    }
  }

  // Check private name (#x) used outside its declaring class
  if (ts.isPrivateIdentifier(node)) {
    if (!isInsideClassWithPrivateName(node, node.escapedText as string)) {
      ctx.addError(node, `Private field '${node.text}' must be declared in an enclosing class`);
    }
  }

  // Check var redeclaration conflicts with lexical declarations in block/module scope
  // ES spec: It is a Syntax Error if any element of VarDeclaredNames also occurs
  // in LexicallyDeclaredNames of the StatementList.
  if (ts.isBlock(node) || ts.isSourceFile(node)) {
    checkVarLexicalConflicts(ctx, node);
  }

  // Check TDZ violations for let/const in block-like scopes
  // These are also caught by TS checker (2448/2474) as downgraded warnings.
  // We emit them as warnings here so compilation continues — tests expect runtime ReferenceError.
  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    const stmts = ts.isSourceFile(node) ? node.statements : ts.isBlock(node) ? node.statements : node.statements;
    checkTDZInStatements(ctx, stmts);
  }

  // Check references to a switch-case lexical binding outside the switch (#1805).
  // ES spec: the LexicallyDeclaredNames of a CaseBlock are scoped to that block.
  // `switch (0) { default: const x = 1; } x;` therefore throws a runtime
  // ReferenceError on `x` — the binding does not exist in the enclosing scope.
  // TS would flag this (TS2304 "Cannot find name 'x'") but the test262 runner
  // compiles with skipSemanticDiagnostics, so we re-detect it syntactically and
  // emit a warning (the runtime-negative path treats any warning as the expected
  // error). We don't descend into nested functions; var-hoisting is unaffected.
  if (ts.isSourceFile(node) || ts.isBlock(node)) {
    checkSwitchLexicalLeak(ctx, node.statements);
  }

  // Check 'with' statement — SyntaxError in strict mode (all modules are strict)
  if (ts.isWithStatement(node) && isStrictMode(node)) {
    ctx.addError(node, "Strict mode code may not include a with statement");
  }

  // Check legacy octal literals (e.g. 077) and non-octal decimal integers (e.g. 08, 09)
  // — SyntaxError in strict mode
  // ES2015+ octal (0o77) is fine; only legacy forms are illegal
  if (ts.isNumericLiteral(node) && isStrictMode(node)) {
    const text = node.getText(ctx.sourceFile);
    // Legacy octal: starts with 0, followed by digits 0-7
    if (/^0[0-7]+$/.test(text) && text.length > 1) {
      ctx.addError(node, "Octal literals are not allowed in strict mode");
    }
    // Non-octal decimal integer: starts with 0, followed by digits 0-9 (containing 8 or 9)
    // e.g. 08, 09, 089 — these are "NonOctalDecimalIntegerLiteral" per ES spec
    if (/^0\d+$/.test(text) && text.length > 1 && !/^0[oOxXbB]/.test(text)) {
      if (/[89]/.test(text)) {
        ctx.addError(node, "Decimals with leading zeros are not allowed in strict mode");
      }
    }
  }

  // Check 'delete' of an unqualified identifier — SyntaxError in strict mode
  if (ts.isDeleteExpression(node) && isStrictMode(node)) {
    let operand: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(operand)) {
      operand = operand.expression;
    }
    if (ts.isIdentifier(operand)) {
      ctx.addError(node, `Delete of an unqualified identifier in strict mode`);
    }
  }

  // Check 'delete' on private names — always a SyntaxError
  // ES spec: delete MemberExpression.PrivateName and delete CallExpression.PrivateName
  // are early errors (class bodies are always strict mode).
  // Covers: delete this.#x, delete (this.#x), delete g().#x, delete (g().#x)
  if (ts.isDeleteExpression(node)) {
    let operand: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(operand)) {
      operand = operand.expression;
    }
    if (ts.isPropertyAccessExpression(operand) && ts.isPrivateIdentifier(operand.name)) {
      ctx.addError(node, `Deleting a private field is a SyntaxError`);
    }
  }

  // Check for-in loop with initializer — SyntaxError in strict mode for var,
  // always a SyntaxError for let/const (ES2015+)
  // Also: var with destructuring pattern + initializer is always SyntaxError (Annex B)
  if (ts.isForInStatement(node)) {
    const init = node.initializer;
    if (ts.isVariableDeclarationList(init)) {
      const isLexical = (init.flags & ts.NodeFlags.Let) !== 0 || (init.flags & ts.NodeFlags.Const) !== 0;
      // ES spec: 'using' declarations are not allowed in for-in (only for-of)
      const isUsing = (init.flags & ts.NodeFlags.Using) !== 0;
      if (isUsing) {
        ctx.addError(node, "'using' declarations are not allowed in for-in loops");
      } else {
        for (const decl of init.declarations) {
          if (decl.initializer) {
            const hasDestructuring = !ts.isIdentifier(decl.name);
            if (isLexical || isStrictMode(node) || hasDestructuring) {
              ctx.addError(node, "for-in loop head declarations may not have initializers");
              break;
            }
          }
        }
        // for-in/for-of with multiple lexical bindings is always a SyntaxError
        if (isLexical && init.declarations.length > 1) {
          ctx.addError(node, "Only a single declaration is allowed in a for-in statement");
        }
        // ES spec: It is a Syntax Error if BoundNames of ForDeclaration
        // contains any duplicate entries (lexical only) — e.g.
        // `for (let [x, x] in {}) {}` / `for (const [x, x] in {}) {}`.
        if (isLexical) {
          const seen = new Set<string>();
          const dupes = new Set<string>();
          for (const decl of init.declarations) {
            collectBindingNamesWithDuplicateCheck(decl.name, seen, dupes);
          }
          for (const name of dupes) {
            ctx.addError(node, `Duplicate binding '${name}' in for-in declaration`);
          }
        }
      }
    }
  }

  // Check for-of loop: declarations may not have initializers; lexical must be single binding
  // ES spec: ForInOfStatement: for (var ForBinding of AssignmentExpression) — no initializer.
  // Also for let/const: no initializer and only one binding.
  if (ts.isForOfStatement(node)) {
    const init = node.initializer;
    if (ts.isVariableDeclarationList(init)) {
      const isLexical = (init.flags & ts.NodeFlags.Let) !== 0 || (init.flags & ts.NodeFlags.Const) !== 0;
      const isUsing = (init.flags & ts.NodeFlags.Using) !== 0;
      // Both var and lexical: no initializers allowed
      for (const decl of init.declarations) {
        if (decl.initializer) {
          ctx.addError(node, "for-of loop head declarations may not have initializers");
          break;
        }
      }
      if (isLexical && init.declarations.length > 1) {
        ctx.addError(node, "Only a single declaration is allowed in a for-of statement");
      }
      // ES spec: BoundNames of ForDeclaration may not contain duplicates (for-of const)
      if (isLexical) {
        const seen = new Set<string>();
        const dupes = new Set<string>();
        for (const decl of init.declarations) {
          collectBindingNamesWithDuplicateCheck(decl.name, seen, dupes);
        }
        for (const name of dupes) {
          ctx.addError(node, `Duplicate binding '${name}' in for-of declaration`);
        }
      }
      // ES spec: BoundNames of using ForDeclaration may not contain "let"
      if (isUsing) {
        for (const decl of init.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === "let") {
            ctx.addError(decl.name, "Using declarations may not bind 'let'");
          }
        }
        // ES spec: BoundNames of using must not conflict with body var declarations
        const boundNames = new Set<string>();
        for (const decl of init.declarations) {
          if (ts.isIdentifier(decl.name)) boundNames.add(decl.name.text);
        }
        if (boundNames.size > 0 && ts.isBlock(node.statement)) {
          collectVarDeclaredNamesInBlock(ctx, node.statement, boundNames);
        }
      }
    }
    // ES spec: `for (async of ...)` - `async` as LHS before `of` is a SyntaxError
    if (!ts.isVariableDeclarationList(node.initializer) && ts.isIdentifier(node.initializer)) {
      if (node.initializer.text === "async") {
        ctx.addError(node.initializer, "'async' is not allowed as a left-hand side identifier in for-of");
      }
    }
  }

  // Check labeled function declarations in strict mode
  // e.g. label: function f() {} is a SyntaxError in strict mode
  if (ts.isLabeledStatement(node) && isStrictMode(node)) {
    if (ts.isFunctionDeclaration(node.statement)) {
      ctx.addError(node, "In strict mode code, functions can only be declared at top level or inside a block");
    }
  }

  // ── Rest element early errors ──────────────────────────────────────
  // ES spec: Rest element cannot have an initializer (default value).
  // e.g. function f(...a = []) {}, const [...a = []] = arr;
  if (ts.isParameter(node) && node.dotDotDotToken && node.initializer) {
    ctx.addError(node, "Rest parameter may not have a default initializer");
  }
  if (ts.isBindingElement(node) && node.dotDotDotToken && node.initializer) {
    ctx.addError(node, "Rest element may not have a default initializer");
  }

  // ES spec: Rest element must be last — no trailing elements after rest.
  // e.g. const [...a, b] = arr;  function f(...a, b) {}
  if (ts.isArrayBindingPattern(node)) {
    let foundRest = false;
    for (const element of node.elements) {
      if (foundRest) {
        ctx.addError(element, "A rest element must be last in a destructuring pattern");
        break;
      }
      if (ts.isBindingElement(element) && element.dotDotDotToken) {
        foundRest = true;
      }
    }
  }

  // ES spec: Trailing comma after rest parameter is a SyntaxError.
  // e.g. function f(...a,) {}
  // TypeScript's parser accepts this, but ES spec forbids it.
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.parameters.length > 0
  ) {
    const lastParam = node.parameters[node.parameters.length - 1]!;
    if (lastParam.dotDotDotToken) {
      // Check if there's a trailing comma after the rest parameter.
      // The trailing comma is indicated by a comma after the last parameter
      // in the source text.
      const paramEnd = lastParam.end;
      const parenClose = node.parameters.end; // end of the parameter list
      const textBetween = ctx.sourceFile.text.substring(paramEnd, parenClose);
      if (textBetween.includes(",")) {
        ctx.addError(lastParam, "A rest parameter or binding pattern may not have a trailing comma");
      }
    }
  }

  // ── await/yield as identifier in async/generator contexts ──────────
  // ES spec: 'await' is a reserved word inside async functions/generators.
  // 'yield' is a reserved word inside generator functions.
  if (ts.isIdentifier(node) && (node.text === "await" || node.text === "yield")) {
    // Skip if this is the yield/await *expression* (keyword usage, not identifier)
    const parent = node.parent;
    if (parent && !ts.isYieldExpression(parent) && !ts.isAwaitExpression(parent)) {
      // Skip if this is a property name in a member expression or declaration
      const isPropertyName =
        parent &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isMethodDeclaration(parent) && parent.name === node) ||
          (ts.isPropertyDeclaration(parent) && parent.name === node) ||
          (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
          (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
          (ts.isEnumMember(parent) && parent.name === node) ||
          (ts.isPropertySignature(parent) && parent.name === node) ||
          (ts.isMethodSignature(parent) && parent.name === node));
      if (!isPropertyName) {
        if (node.text === "await" && isInsideAsyncFunction(node)) {
          ctx.addError(node, "'await' is not allowed as an identifier in an async function");
        }
        if (node.text === "yield" && isInsideGeneratorFunction(node)) {
          ctx.addError(node, "'yield' is not allowed as an identifier in a generator function");
        }
      }
    }
  }

  // ── Strict mode reserved words as identifiers ──────────────────────
  // ES spec: implements, interface, let, package, private, protected,
  // public, static, yield are reserved in strict mode.
  if (ts.isIdentifier(node) && isStrictMode(node)) {
    const strictReserved = new Set(["implements", "interface", "package", "private", "protected", "public", "static"]);
    if (strictReserved.has(node.text)) {
      // Skip property names — they're fine in strict mode
      const parent = node.parent;
      const isPropertyName =
        parent &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isMethodDeclaration(parent) && parent.name === node) ||
          (ts.isPropertyDeclaration(parent) && parent.name === node) ||
          (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
          (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
          (ts.isPropertySignature(parent) && parent.name === node) ||
          (ts.isMethodSignature(parent) && parent.name === node));
      // Also skip if used as a label name (label: statement)
      const isLabel = parent && ts.isLabeledStatement(parent) && parent.label === node;
      // Skip break/continue target labels
      const isBreakContinueTarget =
        parent &&
        ((ts.isBreakStatement(parent) && parent.label === node) ||
          (ts.isContinueStatement(parent) && parent.label === node));
      if (!isPropertyName && !isLabel && !isBreakContinueTarget) {
        // Flag when used as a binding name (variable, parameter, function name)
        // or as a shorthand property (IdentifierReference context)
        const isBinding =
          parent &&
          ((ts.isVariableDeclaration(parent) && parent.name === node) ||
            (ts.isParameter(parent) && parent.name === node) ||
            (ts.isFunctionDeclaration(parent) && parent.name === node) ||
            (ts.isFunctionExpression(parent) && parent.name === node) ||
            (ts.isClassDeclaration(parent) && parent.name === node) ||
            (ts.isClassExpression(parent) && parent.name === node) ||
            (ts.isBindingElement(parent) && parent.name === node) ||
            // Shorthand property in object literal: {implements} — IdentifierReference
            (ts.isShorthandPropertyAssignment(parent) && parent.name === node));
        if (isBinding) {
          ctx.addError(node, `'${node.text}' is a reserved word in strict mode and cannot be used as an identifier`);
        }
      }
    }
  }

  // ── "use strict" + non-simple parameters ─────────────────────────
  // ES spec: It is a SyntaxError if ContainsUseStrict of FunctionBody is true
  // and IsSimpleParameterList of FormalParameters is false.
  // Non-simple: default values, destructuring patterns, or rest parameters.
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body &&
    ts.isBlock(node.body)
  ) {
    const hasNonSimpleParams = node.parameters.some(
      (p) => p.initializer !== undefined || p.dotDotDotToken !== undefined || !ts.isIdentifier(p.name), // destructuring pattern
    );
    if (hasNonSimpleParams) {
      // Check if body starts with "use strict" directive
      for (const stmt of node.body.statements) {
        if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
          if (stmt.expression.text === "use strict") {
            ctx.addError(stmt, "Illegal 'use strict' directive in function with non-simple parameter list");
            break;
          }
        } else {
          break; // Directives must be at the top
        }
      }
    }
  }

  // ── Parameter names conflicting with lexical body declarations ─────
  // ES spec: It is a SyntaxError if BoundNames of FormalParameters also
  // occurs in the LexicallyDeclaredNames of FunctionBody (for arrow,
  // async, generator, method, constructor, getter, setter).
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body &&
    ts.isBlock(node.body)
  ) {
    const paramNames = new Set<string>();
    for (const p of node.parameters) {
      collectBindingNames(p.name, paramNames);
    }
    if (paramNames.size > 0) {
      for (const stmt of node.body.statements) {
        if (ts.isVariableStatement(stmt)) {
          const flags = stmt.declarationList.flags;
          if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
            for (const decl of stmt.declarationList.declarations) {
              if (ts.isIdentifier(decl.name) && paramNames.has(decl.name.text)) {
                ctx.addError(decl.name, `Duplicate identifier '${decl.name.text}' — parameter and lexical declaration`);
              }
            }
          }
        }
      }
    }
  }

  // ── Labeled declarations (not function declarations) ──────────────
  // ES spec: LabelledItem only allows Statement or FunctionDeclaration.
  // LexicalDeclarations (let, const), class declarations, async generators,
  // and async functions in labeled position are SyntaxErrors.
  if (ts.isLabeledStatement(node)) {
    const stmt = node.statement;
    // label: let x; or label: const x;
    if (ts.isVariableStatement(stmt)) {
      const flags = stmt.declarationList.flags;
      if (
        ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) &&
        !isAsiLetExpressionStatement(ctx.sourceFile, stmt, flags)
      ) {
        ctx.addError(node, "Lexical declaration (let/const) cannot appear in a labeled statement");
      }
    }
    // label: class C {} — always a SyntaxError
    if (ts.isClassDeclaration(stmt)) {
      ctx.addError(node, "Class declaration cannot appear in a labeled statement");
    }
  }

  // ── let/const in single-statement positions ──────────────────────
  // ES spec: LetOrConst is not allowed in the Statement position of
  // if, else, while, do-while, for bodies.
  if (ts.isVariableStatement(node)) {
    const flags = node.declarationList.flags;
    if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
      const parent = node.parent;
      if (parent && isStatementPosition(parent, node) && !isAsiLetExpressionStatement(ctx.sourceFile, node, flags)) {
        ctx.addError(node, "Lexical declaration cannot appear in a single-statement context");
      }
    }
  }

  // ── const without initializer ──────────────────────────────────
  // ES spec: LexicalBinding for `const` must have an Initializer.
  // Exception: `for (const x of ...)` and `for (const x in ...)` — the
  // variable gets its value from the iterable/object, not an initializer.
  // Exception: `declare const x: T` — ambient declarations have no initializer
  // by design (they describe external bindings, not local variables). These are
  // generated by preprocessImports for unused imported bindings (#951).
  if (ts.isVariableDeclaration(node) && !node.initializer) {
    const declList = node.parent;
    if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
      const declListParent = declList.parent;
      const isForOfOrIn =
        declListParent && (ts.isForOfStatement(declListParent) || ts.isForInStatement(declListParent));
      const isAmbient =
        ts.isVariableStatement(declListParent) &&
        declListParent.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
      if (!isForOfOrIn && !isAmbient) {
        ctx.addError(node, "Missing initializer in const declaration");
      }
    }
  }

  // ── 'let' as binding name in lexical declarations ──────────────
  // ES spec: It is a SyntaxError if BoundNames of LetOrConst contains "let".
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "let") {
    const declList = node.parent;
    if (ts.isVariableDeclarationList(declList)) {
      if ((declList.flags & ts.NodeFlags.Let) !== 0 || (declList.flags & ts.NodeFlags.Const) !== 0) {
        ctx.addError(node.name, "'let' is disallowed as a lexically bound name");
      }
    }
  }

  // ── for loop head lexical var conflict ─────────────────────────
  // ES spec: for (let x; ...) { var x; } — var x conflicts with let x
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    const init = ts.isForStatement(node) ? node.initializer : node.initializer;
    if (init && ts.isVariableDeclarationList(init)) {
      const isLexical = (init.flags & ts.NodeFlags.Let) !== 0 || (init.flags & ts.NodeFlags.Const) !== 0;
      if (isLexical) {
        const lexNames = new Set<string>();
        for (const decl of init.declarations) {
          collectBindingNames(decl.name, lexNames);
        }
        if (lexNames.size > 0) {
          const body = ts.isForStatement(node)
            ? node.statement
            : ts.isForInStatement(node)
              ? node.statement
              : node.statement;
          if (ts.isBlock(body)) {
            collectVarDeclaredNamesInBlock(ctx, body, lexNames);
          }
        }
      }
    }
  }

  // ── eval/arguments as binding names in strict mode ────────────────
  // ES spec: It is a SyntaxError to use eval or arguments as a binding
  // identifier in strict mode code (variable declarations, function names, etc.)
  if (ts.isIdentifier(node) && (node.text === "eval" || node.text === "arguments") && isStrictMode(node)) {
    const parent = node.parent;
    // Check if used as a binding name (variable, parameter, function name, catch binding)
    const isBinding =
      parent &&
      ((ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isParameter(parent) && parent.name === node) ||
        (ts.isFunctionDeclaration(parent) && parent.name === node) ||
        (ts.isFunctionExpression(parent) && parent.name === node) ||
        (ts.isClassDeclaration(parent) && parent.name === node) ||
        (ts.isClassExpression(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.name === node) ||
        (ts.isCatchClause(parent) &&
          parent.variableDeclaration &&
          ts.isIdentifier(parent.variableDeclaration.name) &&
          parent.variableDeclaration.name === node));
    if (isBinding) {
      ctx.addError(node, `Binding '${node.text}' in strict mode is not allowed`);
    }
  }

  // ── Switch case duplicate lexical declarations ────────────────────
  // ES spec: It is a Syntax Error if the LexicallyDeclaredNames of CaseBlock
  // contains any duplicate entries.
  if (ts.isCaseBlock(node)) {
    checkSwitchCaseLexicalDuplicates(ctx, node);
  }

  // ── Class body: static prototype method/field ─────────────────────
  // ES spec: It is a SyntaxError if the PropName of a static method or
  // field is "prototype".
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    for (const member of node.members) {
      if (member.name && !ts.isPrivateIdentifier(member.name)) {
        const isStatic = ts.canHaveModifiers(member)
          ? (ts.getModifiers(member as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
          : false;
        if (isStatic) {
          const memberName = ts.isIdentifier(member.name)
            ? member.name.text
            : ts.isStringLiteral(member.name)
              ? member.name.text
              : null;
          if (memberName === "prototype") {
            ctx.addError(member, "Classes may not have a static property named 'prototype'");
          }
        }
      }
    }
  }

  // ── Duplicate private names in class body ─────────────────────────
  // ES spec: It is a Syntax Error if PrivateBoundNames of ClassBody contains
  // any duplicate entries, unless the name is used once for a getter and once
  // for a setter and in no other entries.
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    checkDuplicatePrivateNames(ctx, node);
  }

  // ── Private name `#constructor` is always forbidden ───────────────
  // ES spec: ClassElementName : PrivateName
  //   It is a Syntax Error if StringValue of PrivateName is "#constructor".
  // This applies to fields, methods, getters, setters regardless of static.
  if (ts.isPrivateIdentifier(node) && node.text === "#constructor") {
    ctx.addError(node, "Private field '#constructor' is not allowed");
  }

  // ── Regex literal validation ────────────────────────────────────
  // Validate regex literals using the native RegExp constructor.
  // This catches invalid flags, duplicate flags, invalid Unicode property
  // escapes, invalid modifiers, etc. that TS's semantic checker would
  // catch but we skip with skipSemanticDiagnostics in the worker pool.
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    const text = (node as ts.RegularExpressionLiteral).text;
    const lastSlash = text.lastIndexOf("/");
    if (lastSlash > 0) {
      const pattern = text.slice(1, lastSlash);
      const flags = text.slice(lastSlash + 1);
      try {
        new RegExp(pattern, flags);
      } catch {
        ctx.addError(node, `Invalid regular expression: ${text}`);
      }
    }
  }

  // ── Class method named "constructor" restrictions ─────────────────
  // ES spec: It is a SyntaxError if PropName of a MethodDefinition is "constructor" and
  // the method is a generator, async, getter, or setter.
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    for (const member of node.members) {
      const memberName = getMemberName(member);
      if (memberName === "constructor") {
        const isStaticMember = (member as any).modifiers?.some((m: any) => m.kind === ts.SyntaxKind.StaticKeyword);
        if (isStaticMember) continue; // static "constructor" is fine
        if (ts.isMethodDeclaration(member) && member.asteriskToken) {
          ctx.addError(member, "Class constructor may not be a generator");
        }
        if (
          ts.isMethodDeclaration(member) &&
          member.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.AsyncKeyword)
        ) {
          ctx.addError(member, "Class constructor may not be an async method");
        }
        if (ts.isGetAccessorDeclaration(member)) {
          ctx.addError(member, "Class constructor may not be a getter");
        }
        if (ts.isSetAccessorDeclaration(member)) {
          ctx.addError(member, "Class constructor may not be a setter");
        }
      }
      // TS parses `async constructor()` as a ConstructorDeclaration with
      // AsyncKeyword modifier (not as a MethodDeclaration named "constructor").
      // Catch this case separately.
      if (ts.isConstructorDeclaration(member)) {
        if (member.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
          ctx.addError(member, "Class constructor may not be an async method");
        }
      }
    }
  }

  // ── Direct super() call outside constructor ──────────────────────
  // ES spec: super() is only valid inside a class constructor.
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
    if (!isInsideClassConstructor(node)) {
      ctx.addError(node, "super() is only valid inside a class constructor");
    }
  }

  // ── Direct super property outside method ──────────────────────────
  // super.x and super[x] are only valid in methods (including constructors)
  if (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    node.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    if (!isInsideMethod(node)) {
      ctx.addError(node, "'super' keyword unexpected here");
    }
    // ES spec: SuperProperty only allows IdentifierName and [Expression],
    // NOT PrivateName. super.#x is always a SyntaxError.
    if (ts.isPropertyAccessExpression(node) && ts.isPrivateIdentifier(node.name)) {
      ctx.addError(node, "Private fields cannot be accessed via super");
    }
  }

  // ── Strict mode reserved words as assignment targets ─────────────
  // ES spec: It is a SyntaxError if the LeftHandSideExpression of a simple
  // assignment is a strict mode reserved word (public, private, protected, etc.)
  // and the code is in strict mode.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isStrictMode(node)) {
    let lhs: ts.Node = node.left;
    while (ts.isParenthesizedExpression(lhs)) lhs = lhs.expression;
    if (ts.isIdentifier(lhs)) {
      const strictReservedAssign = new Set([
        "implements",
        "interface",
        "let",
        "package",
        "private",
        "protected",
        "public",
        "static",
        "yield",
      ]);
      if (strictReservedAssign.has(lhs.text)) {
        ctx.addError(lhs, `Assignment to reserved word '${lhs.text}' in strict mode`);
      }
    }
  }

  // ── Duplicate __proto__ in object literal ────────────────────────
  if (ts.isObjectLiteralExpression(node)) {
    let protoCount = 0;
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const propName = ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteral(prop.name)
            ? prop.name.text
            : null;
        if (propName === "__proto__") {
          protoCount++;
          if (protoCount > 1) {
            ctx.addError(prop, "Duplicate __proto__ fields are not allowed in object literals");
            break;
          }
        }
      }
    }
  }

  // ── Getter with parameters ─────────────────────────────────────
  // ES spec: A getter must have exactly zero parameters.
  if (ts.isGetAccessorDeclaration(node) && node.parameters.length > 0) {
    ctx.addError(node, "Getter must not have any formal parameters");
  }

  // ── Setter with wrong param count ──────────────────────────────
  // ES spec: A setter must have exactly one parameter.
  if (ts.isSetAccessorDeclaration(node) && node.parameters.length !== 1) {
    ctx.addError(node, "Setter must have exactly one formal parameter");
  }

  // ── Setter param with destructuring + "use strict" body ────────
  // ES spec: setter parameter is eval/arguments in strict mode
  if (ts.isSetAccessorDeclaration(node) && node.parameters.length === 1) {
    const param = node.parameters[0]!;
    // Check for setter with "use strict" body — this triggers strict mode
    // checks on the parameter (eval/arguments as binding names)
    if (ts.isIdentifier(param.name) && (param.name.text === "eval" || param.name.text === "arguments")) {
      // Check if the body has "use strict"
      if (node.body) {
        for (const stmt of node.body.statements) {
          if (
            ts.isExpressionStatement(stmt) &&
            ts.isStringLiteral(stmt.expression) &&
            stmt.expression.text === "use strict"
          ) {
            ctx.addError(param.name, `Binding '${param.name.text}' in strict mode is not allowed`);
            break;
          } else {
            break;
          }
        }
      }
    }
  }

  // ── Cover initialized name in object literal ───────────────────
  // ES spec: PropertyDefinition : CoverInitializedName always throws SyntaxError.
  // ({ x = 1 }) is a CoverInitializedName — only valid in destructuring context.
  // ShorthandPropertyAssignment with an objectAssignmentInitializer is the TS
  // representation of CoverInitializedName.
  if (ts.isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer) {
    // Check if the parent object literal is NOT in an assignment pattern position
    const objLit = node.parent;
    if (ts.isObjectLiteralExpression(objLit)) {
      if (!isAssignmentPatternContext(objLit)) {
        ctx.addError(node, "Invalid shorthand property initializer");
      }
    }
  }

  // ── 'let' as shorthand property in strict mode ─────────────────
  // ES spec: 'let' is not a reserved word but cannot be used as a binding
  // identifier in strict mode, and shorthand property acts as IdentifierReference.
  if (ts.isShorthandPropertyAssignment(node) && node.name.text === "let" && isStrictMode(node)) {
    ctx.addError(node, "'let' is not allowed as a shorthand property in strict mode");
  }

  // ── Catch clause parameter early errors ─────────────────────────
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    const catchParam = node.variableDeclaration;
    // Check for duplicate names in catch parameter destructuring
    const catchNames = new Set<string>();
    const dupeNames = new Set<string>();
    collectBindingNamesWithDuplicateCheck(catchParam.name, catchNames, dupeNames);
    for (const name of dupeNames) {
      ctx.addError(catchParam, `Duplicate binding '${name}' in catch parameter`);
    }
    // Check catch body for lexical/function declarations that shadow the catch parameter
    if (node.block && catchNames.size > 0) {
      for (const stmt of node.block.statements) {
        if (ts.isVariableStatement(stmt)) {
          const flags = stmt.declarationList.flags;
          if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
            for (const decl of stmt.declarationList.declarations) {
              if (ts.isIdentifier(decl.name) && catchNames.has(decl.name.text)) {
                ctx.addError(decl.name, `Cannot redeclare catch variable '${decl.name.text}' with lexical declaration`);
              }
            }
          }
        }
        // Function declaration with same name as catch parameter
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
          if (catchNames.has(stmt.name.text)) {
            ctx.addError(stmt.name, `Cannot redeclare catch variable '${stmt.name.text}' with function declaration`);
          }
        }
        if (ts.isClassDeclaration(stmt) && stmt.name) {
          if (catchNames.has(stmt.name.text)) {
            ctx.addError(stmt.name, `Cannot redeclare catch variable '${stmt.name.text}' with class declaration`);
          }
        }
      }
    }
  }

  // ── Duplicate lexical declarations in same block ─────────────────
  // Covers class+class, let+let, const+const, class+let, etc.
  if (ts.isBlock(node) || ts.isSourceFile(node)) {
    checkDuplicateLexicalDeclarations(ctx, node);
  }

  // ── Duplicate labels in class static blocks ────────────────────
  // ES spec: ClassStaticBlockBody — It is a Syntax Error if
  // ContainsDuplicateLabels of ClassStaticBlockStatementList is true.
  if (ts.isClassStaticBlockDeclaration(node)) {
    checkDuplicateLabelsInBlock(ctx, node.body);
  }

  // ── break/continue outside valid context ──────────────────────────
  // TS catches these as semantic errors (1104, 1105) but we skip semantic
  // diagnostics in the test262 worker, so detect them here.
  if (ts.isContinueStatement(node)) {
    if (!isInsideIteration(node, node.label?.text)) {
      ctx.addError(
        node,
        node.label
          ? `A 'continue' statement can only jump to a label of an enclosing iteration statement`
          : `A 'continue' statement can only be used within an enclosing iteration statement`,
      );
    }
  }
  if (ts.isBreakStatement(node)) {
    if (!isInsideBreakable(node, node.label?.text)) {
      ctx.addError(
        node,
        node.label
          ? `A 'break' statement can only jump to a label of an enclosing statement`
          : `A 'break' statement can only be used within an enclosing iteration or switch statement`,
      );
    }
  }

  // ── import.X meta-property validation — covers Stage 3 proposals + unknown names ──
  // ES spec (§13.3.10): the only standardized `import.<name>` meta-property is
  // `import.meta`. The Stage 3 proposals add `import.source(...)` (source-phase
  // imports) and `import.defer(...)` (import-defer). Any other meta-property
  // name like `import.UNKNOWN` is a SyntaxError.
  //
  // Test262 has ~190 negative tests under
  // `language/expressions/dynamic-import/syntax/invalid/` covering bare
  // `import.source`, `import.source.X`, `import.UNKNOWN(...)`, `typeof
  // import.source`, etc. The sharded test runner compiles with
  // `skipSemanticDiagnostics: true`, suppressing TS's own diagnostics for these
  // shapes, so the SyntaxError must be emitted by this syntactic pass (#1512).
  //
  // We catch the MetaProperty node itself, which fires for every position the
  // meta-property appears in (call target, bare expression, typeof operand,
  // PropertyAccessExpression base, etc.). The earlier call-only check (#1315)
  // is subsumed by this. The walk runs over the whole AST including
  // unreferenced bodies so we catch dead-code constructs too.
  if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text !== "meta") {
    const name = node.name.text;
    if (name === "defer" || name === "source") {
      ctx.addError(
        node,
        `SyntaxError: import.${name}(...) is not supported (Stage 3 proposal — import-defer / source-phase-imports)`,
      );
    } else {
      ctx.addError(node, `SyntaxError: 'import.${name}' is not a valid meta-property; only 'import.meta' is allowed`);
    }
  }

  // ── new import() — always a SyntaxError ────────────────────────
  // ES spec: ImportCall is a CallExpression, not a NewExpression target.
  // Also applies to import.source() and import.defer() proposals.
  // TS parser splits "new import('x')" into a broken NewExpression (empty identifier)
  // followed by an import CallExpression. We detect this by checking for
  // NewExpression with a missing/empty expression where the source text shows "new import".
  if (ts.isNewExpression(node)) {
    const expr = node.expression;
    if (ts.isIdentifier(expr) && expr.text === "") {
      const start = node.getStart(ctx.sourceFile);
      const textAfter = ctx.sourceFile.text.substring(start, start + 30);
      if (/^new\s+import\s*[\.(]/.test(textAfter)) {
        ctx.addError(node, "Cannot use new with import()");
      }
    }
  }

  // ── typeof import — always a SyntaxError ────────────────────────
  // ES spec: `import` is not a valid UnaryExpression operand (not an identifier).
  // TS parser creates a TypeOfExpression with an empty Identifier when parsing
  // `typeof import`. Detect this by checking source text.
  if (ts.isTypeOfExpression(node)) {
    const expr = node.expression;
    if (ts.isIdentifier(expr) && expr.text === "") {
      const start = node.getStart(ctx.sourceFile);
      const textAfter = ctx.sourceFile.text.substring(start, start + 30);
      if (/^typeof\s+import\b/.test(textAfter)) {
        ctx.addError(node, "Cannot use typeof with import");
      }
    }
  }

  // ── `arguments` in class field initializers ──────────────────────
  // ES spec: FieldDefinition — It is a Syntax Error if ContainsArguments
  // of Initializer is true. `arguments` is not allowed in any class field
  // initializer (instance or static), because field initializers are not
  // "real" function bodies and don't bind `arguments`.
  if (ts.isPropertyDeclaration(node) && node.initializer) {
    if (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) {
      if (containsArguments(node.initializer)) {
        ctx.addError(node.initializer, "'arguments' is not allowed in class field initializers");
      }
    }
  }

  // ── `arguments` in class static blocks ──────────────────────────
  // ES spec: ClassStaticBlockBody — It is a Syntax Error if
  // ContainsArguments of ClassStaticBlockStatementList is true.
  if (ts.isClassStaticBlockDeclaration(node)) {
    if (containsArguments(node.body)) {
      ctx.addError(node, "'arguments' is not allowed in class static initialization blocks");
    }
  }

  // ── await with empty operand in async functions ───────────────
  // When TS parses `void await`, `await:`, or just `await` (as identifier ref)
  // inside an async function, it creates AwaitExpression with empty Identifier
  // operand. This means `await` was used as an identifier, not as the keyword.
  // ES spec: await is a reserved word in async function bodies.
  if (ts.isAwaitExpression(node)) {
    const operand = node.expression;
    if (ts.isIdentifier(operand) && operand.text === "") {
      if (isInsideAsyncFunction(node) || isInsideClassStaticBlock(node)) {
        ctx.addError(node, "'await' is not allowed as an identifier in this context");
      }
    }
    // Also check await: label pattern (TS parses await: as AwaitExpression + colon)
    if (isInsideAsyncFunction(node) || isInsideClassStaticBlock(node)) {
      const endPos = node.end;
      const afterText = ctx.sourceFile.text.substring(endPos, endPos + 5).trimStart();
      if (afterText.startsWith(":")) {
        ctx.addError(node, "'await' is not allowed as a label identifier in this context");
      }
    }
    // ES spec: ClassStaticBlockBody: "It is a Syntax Error if ContainsAwait
    // of ClassStaticBlockStatementList is true." This means a real AwaitExpression
    // (not just the identifier 'await') inside a static block is always invalid,
    // even if the static block is nested inside an async function.
    if (isInsideClassStaticBlock(node)) {
      ctx.addError(node, "'await' is not allowed in class static initialization blocks");
    }
    // ES spec: AwaitExpression is only valid in async functions or module top-level.
    // In module context, TypeScript may produce AwaitExpression for `await 1` inside
    // a regular (non-async) function. That's a SyntaxError per ES spec because the
    // function uses [~Await] formal parameters/body.
    // NOTE: We use isInsideNestedFunction (not isInsideAnyFunction) to avoid false
    // positives from the test262 runner, which wraps module code in
    // `export function test() { ... }`. Code at "module top level" in tests thus
    // appears inside test() (1 function deep). Real nested functions like
    // `function fn() { await 0; }` inside the wrapper are 2+ levels deep.
    // See the same trade-off comment at line ~1492 (import/export in invalid positions).
    if (!isInsideAsyncFunction(node) && !isInsideClassStaticBlock(node) && isInsideNestedFunction(node)) {
      ctx.addError(node, "'await' expressions are only allowed in async functions");
    }
  }

  // ── yield with empty operand in generator functions ──────────
  // Similar to await: when `yield` is used as identifier reference in a generator,
  // TS may create YieldExpression with empty operand.
  if (ts.isYieldExpression(node) && isInsideGeneratorFunction(node)) {
    const operand = node.expression;
    if (operand && ts.isIdentifier(operand) && operand.text === "") {
      ctx.addError(node, "'yield' is not allowed as an identifier in a generator function");
    }
  }

  // ── yield * with newline before * ──────────────────────────────
  // ES spec: YieldExpression : yield [no LineTerminator here] * AssignmentExpression
  // A newline before the `*` makes it a distinct statement — SyntaxError.
  if (ts.isYieldExpression(node) && node.asteriskToken && isInsideGeneratorFunction(node)) {
    const yieldEnd = node.getStart(ctx.sourceFile) + 5; // length of "yield"
    const starStart = node.asteriskToken.getStart(ctx.sourceFile);
    const textBetween = ctx.sourceFile.text.substring(yieldEnd, starStart);
    if (/[\r\n\u2028\u2029]/.test(textBetween)) {
      ctx.addError(node, "A newline may not precede the '*' token in a yield expression");
    }
  }

  // ── yield in class static blocks ──────────────────────────────
  // ES spec: ClassStaticBlockStatementList uses [~Yield], meaning yield
  // is not allowed inside static blocks even if nested within a generator.
  // TS parses `yield;` in static blocks as Identifier("yield"), not
  // YieldExpression, because class bodies are strict mode. TS diagnostic
  // 1214 is downgraded for sloppy-mode compat, so check explicitly.
  if (ts.isIdentifier(node) && node.text === "yield") {
    if (isInsideClassStaticBlock(node) && !isInsideGeneratorFunction(node)) {
      const parent = node.parent;
      // Skip property names (obj.yield, { yield: x })
      const isPropertyName =
        parent &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isMethodDeclaration(parent) && parent.name === node) ||
          (ts.isPropertyDeclaration(parent) && parent.name === node));
      if (!isPropertyName) {
        ctx.addError(node, "'yield' is not allowed in class static initialization blocks");
      }
    }
  }

  // ── Escaped keyword detection ─────────────────────────────────
  // ES spec: Keywords containing Unicode escape sequences are not valid.
  // e.g., \u0061wait is NOT a valid `await` keyword, im\u0070ort is NOT
  // a valid `import` keyword, etc.
  // Check if the raw source text of keyword-like nodes contains \u escapes.
  if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
    const start = node.getStart(ctx.sourceFile);
    const rawText = ctx.sourceFile.text.substring(start, start + 10);
    if (/\\u[0-9a-fA-F]{4}/.test(rawText)) {
      ctx.addError(node, "Keyword must not contain escaped characters");
    }
  }
  // Escaped 'async' modifier
  if (
    (ts.isArrowFunction(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)) &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    for (const mod of node.modifiers!) {
      if (mod.kind === ts.SyntaxKind.AsyncKeyword) {
        const modStart = mod.getStart(ctx.sourceFile);
        const rawText = ctx.sourceFile.text.substring(modStart, modStart + 10);
        if (/\\u[0-9a-fA-F]{4}/.test(rawText)) {
          ctx.addError(mod, "Keyword must not contain escaped characters");
        }
      }
    }
  }

  // ── Escaped reserved/contextual keywords in export/import ──────
  // ES spec: It is a SyntaxError if the source text of an IdentifierName
  // in keyword position contains a UnicodeEscapeSequence.
  // Covers: `export { x \u0061s y }`, `export { x as \u0064efault }`,
  //         `export {} \u0066rom "./x"`, etc.
  if (ts.isExportDeclaration(node) || ts.isImportDeclaration(node)) {
    const nodeStart = node.getStart(ctx.sourceFile);
    const nodeText = ctx.sourceFile.text.substring(nodeStart, node.end);
    if (nodeText.includes("\\u")) {
      ctx.addError(node, "Keyword must not contain escaped characters");
    }
  }
  if (ts.isExportSpecifier(node)) {
    // Check the exported name and the local name for escaped keywords
    const checkEscape = (n: ts.Identifier | ts.StringLiteral) => {
      const s = n.getStart(ctx.sourceFile);
      const raw = ctx.sourceFile.text.substring(s, s + n.text.length + 10);
      if (raw.includes("\\u")) {
        ctx.addError(n, "Keyword must not contain escaped characters");
      }
    };
    checkEscape(node.name);
    if (node.propertyName) checkEscape(node.propertyName);
  }

  // ── import/export in invalid positions ──────────────────────────
  // NOTE: These checks are intentionally REMOVED (#952).
  // Our test262 runner wraps module tests inside `export function test() { try { ... } }`,
  // which places import/export declarations inside a function body. TypeScript's parser
  // doesn't flag this (it's a semantic error, code 1258), and the compiler handles it
  // gracefully. Re-adding these checks would cause ~97 test regressions.
  // TypeScript semantic diagnostics (1258, 1232) catch real cases if needed.

  // ── dynamic import() as assignment target ──────────────────────
  // ES spec: ImportCall is not a valid LeftHandSideExpression for assignment.
  // e.g., import('x')++, import('x') = 1, ++import('x')
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const parent = node.parent;
    if (parent) {
      // import()++ or import()--
      if (ts.isPostfixUnaryExpression(parent) && parent.operand === node) {
        ctx.addError(node, "Invalid left-hand side in postfix operation");
      }
      // ++import() or --import()
      if (
        ts.isPrefixUnaryExpression(parent) &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken) &&
        parent.operand === node
      ) {
        ctx.addError(node, "Invalid left-hand side expression in prefix operation");
      }
      // import() = x
      if (
        ts.isBinaryExpression(parent) &&
        parent.left === node &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        ctx.addError(node, "Invalid left-hand side in assignment");
      }
    }
  }

  // ── await in class static initializer blocks ──────────────────
  // ES spec: It is a Syntax Error if the code matched by this production is
  // nested within a ClassStaticBlock and StringValue of Identifier is "await".
  if (ts.isIdentifier(node) && node.text === "await") {
    if (isInsideClassStaticBlock(node) && !isInsideAsyncFunction(node)) {
      const parent = node.parent;
      // Skip property names
      const isPropertyName =
        parent &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isMethodDeclaration(parent) && parent.name === node) ||
          (ts.isPropertyDeclaration(parent) && parent.name === node));
      if (!isPropertyName) {
        ctx.addError(node, "'await' is not allowed as an identifier in a class static initializer block");
      }
    }
  }

  // ── return outside function ──────────────────────────────────
  // ES spec: A ReturnStatement can only appear in a FunctionBody.
  // ES spec: ClassStaticBlockStatementList uses [~Return], meaning
  // 'return' is not valid directly inside a static block even if the
  // block is nested inside a function. Only returns inside functions
  // WITHIN the static block are valid.
  if (ts.isReturnStatement(node)) {
    if (!isInsideFunction(node)) {
      ctx.addError(node, "A 'return' statement can only be used within a function body");
    } else if (isInsideClassStaticBlock(node)) {
      ctx.addError(node, "A 'return' statement is not allowed in a class static initialization block");
    }
  }

  // ── yield-as-label (TS parses yield: as YieldExpression in generators)
  // Only flag if the colon is a label colon, not a ternary operator colon.
  // A ternary colon is preceded by `?` somewhere before it. Check if the
  // yield is the consequent/alternate of a ConditionalExpression.
  if (ts.isYieldExpression(node) && isInsideGeneratorFunction(node)) {
    const endPos = node.end;
    const afterText = ctx.sourceFile.text.substring(endPos, endPos + 5).trimStart();
    if (afterText.startsWith(":")) {
      // Don't flag if the yield is inside a ConditionalExpression (ternary ? yield : ...)
      const isInTernary =
        node.parent &&
        (ts.isConditionalExpression(node.parent) ||
          // Also check grandparent for nested parens: (yield) ? yield : yield
          (ts.isParenthesizedExpression(node.parent) && ts.isConditionalExpression(node.parent.parent)));
      if (!isInTernary) {
        ctx.addError(node, "'yield' is not allowed as a label identifier in a generator function");
      }
    }
  }

  // ── Escaped 'let' keyword ─────────────────────────────────────
  // \u006Cet is not valid as a keyword
  if (ts.isIdentifier(node) && node.text === "let") {
    const start = node.getStart(ctx.sourceFile);
    const rawText = ctx.sourceFile.text.substring(start, start + 10);
    if (rawText.includes("\\u")) {
      ctx.addError(node, "Keyword must not contain escaped characters");
    }
  }

  // ── private name escape sequences ─────────────────────────────
  // ES spec: It is a Syntax Error if any code point in the PrivateIdentifier
  // is expressed by a UnicodeEscapeSequence, unless it's for a valid start/part.
  // For keywords like 'async', 'generator', 'field' — private names with
  // escape sequences like #\u0061sync are SyntaxErrors.
  // Note: TS represents private identifiers with ts.isPrivateIdentifier.
  // The "cannot-escape-token" tests check that keywords used in private name
  // positions cannot use Unicode escapes.

  // ── Duplicate export names ────────────────────────────────────
  // ES spec: It is a Syntax Error if the ExportedNames of ModuleBody contains
  // any duplicate entries.
  // This is checked at the source file level.

  // ── import() argument validation ──────────────────────────────
  // ES spec: ImportCall takes exactly one AssignmentExpression (plus an
  // optional second options argument per the import-attributes proposal).
  // import() with 0 args, spread args, or 3+ args is a SyntaxError.
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    if (node.arguments.length === 0) {
      ctx.addError(node, "import() requires at least one argument");
    }
    // ES spec / import-attributes proposal: at most 2 arguments (specifier,
    // options). 3+ args is a SyntaxError — covered by the test262
    // `not-extensible-args` negative tests (#1512).
    if (node.arguments.length > 2) {
      ctx.addError(node, "import() takes at most two arguments (specifier and options)");
    }
    for (const arg of node.arguments) {
      if (ts.isSpreadElement(arg)) {
        ctx.addError(arg, "import() does not allow spread arguments");
      }
    }
  }
  // Same arg-count / spread restrictions for the Stage 3 `import.source(...)` and
  // `import.defer(...)` calls. The meta-property itself is already rejected as a
  // SyntaxError above, but test262 has negative tests that combine the bare
  // proposal with extra args or spread, e.g. `import.source('a', {}, '')`. Emit
  // an additional error so the test still fails parse phase even if the prior
  // meta-property diagnostic is later relaxed for the proposal. (#1512)
  if (
    ts.isCallExpression(node) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    (node.expression.name.text === "source" || node.expression.name.text === "defer")
  ) {
    const name = node.expression.name.text;
    if (node.arguments.length === 0) {
      ctx.addError(node, `import.${name}() requires at least one argument`);
    }
    if (node.arguments.length > 2) {
      ctx.addError(node, `import.${name}() takes at most two arguments`);
    }
    for (const arg of node.arguments) {
      if (ts.isSpreadElement(arg)) {
        ctx.addError(arg, `import.${name}() does not allow spread arguments`);
      }
    }
  }

  // ── Escaped 'import' keyword in dynamic import() ──────────────
  // im\u0070ort('x') — escaped form of import keyword is not valid
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const start = node.getStart(ctx.sourceFile);
    const rawText = ctx.sourceFile.text.substring(start, start + 15);
    if (rawText.includes("\\u")) {
      ctx.addError(node, "Keyword must not contain escaped characters");
    }
  }

  // ── VoidExpression / TypeOfExpression with empty operand ─────────
  // When TS encounters `void yield` or `void await` in a generator/async context,
  // it splits them into two statements: void(empty) and yield/await.
  // The void/typeof gets an empty Identifier operand (text === "").
  // In ES spec, `void` always requires a UnaryExpression, so this indicates
  // a parse issue — the construct is a SyntaxError.
  if (ts.isVoidExpression(node)) {
    const expr = node.expression;
    if (ts.isIdentifier(expr) && expr.text === "") {
      // Check what follows in the source — likely `void yield` or `void await`
      const start = node.getStart(ctx.sourceFile);
      const rawText = ctx.sourceFile.text.substring(start, start + 20).trim();
      if (/^void\s+(yield|await)\b/.test(rawText)) {
        ctx.addError(node, `'${rawText.match(/void\s+(\w+)/)?.[1]}' is not a valid operand for 'void' in this context`);
      }
    }
  }
  if (ts.isTypeOfExpression(node)) {
    const expr = node.expression;
    if (ts.isIdentifier(expr) && expr.text === "") {
      const start = node.getStart(ctx.sourceFile);
      const rawText = ctx.sourceFile.text.substring(start, start + 25).trim();
      if (/^typeof\s+(yield|await)\b/.test(rawText)) {
        ctx.addError(
          node,
          `'${rawText.match(/typeof\s+(\w+)/)?.[1]}' is not a valid operand for 'typeof' in this context`,
        );
      }
    }
  }

  // ── Unary prefix (+, -, ~, !) with yield/await in generator/async ──
  // Same issue: `+yield`, `-yield`, etc. TS splits the expression.
  // If a PrefixUnaryExpression (not ++/--) has an empty Identifier operand,
  // check if it's followed by yield/await.
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator !== ts.SyntaxKind.PlusPlusToken &&
    node.operator !== ts.SyntaxKind.MinusMinusToken
  ) {
    const operand = node.operand;
    if (ts.isIdentifier(operand) && operand.text === "") {
      const start = node.getStart(ctx.sourceFile);
      const rawText = ctx.sourceFile.text.substring(start, start + 20).trim();
      if (/^[+\-~!]\s*(yield|await)\b/.test(rawText)) {
        ctx.addError(node, `Invalid use of '${rawText.match(/[+\-~!]\s*(\w+)/)?.[1]}' in this context`);
      }
    }
  }

  // ── Nullish coalescing (??) mixed with || or && without parens ──
  // ES spec: It is a Syntax Error if ShortCircuitExpression includes both
  // CoalesceExpression (??) and LogicalORExpression/LogicalANDExpression
  // without explicit parenthesization.
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken) {
      // Check if either child is a || or && expression (without parens)
      const checkMixed = (child: ts.Node): boolean => {
        if (ts.isParenthesizedExpression(child)) return false; // parens break the chain
        if (ts.isBinaryExpression(child)) {
          const childOp = child.operatorToken.kind;
          if (childOp === ts.SyntaxKind.BarBarToken || childOp === ts.SyntaxKind.AmpersandAmpersandToken) {
            return true;
          }
        }
        return false;
      };
      if (checkMixed(node.left) || checkMixed(node.right)) {
        ctx.addError(node, "Cannot mix '??' with '||' or '&&' without parentheses");
      }
    }
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const checkMixed = (child: ts.Node): boolean => {
        if (ts.isParenthesizedExpression(child)) return false;
        if (ts.isBinaryExpression(child)) {
          if (child.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return true;
        }
        return false;
      };
      if (checkMixed(node.left) || checkMixed(node.right)) {
        ctx.addError(node, "Cannot mix '??' with '||' or '&&' without parentheses");
      }
    }
  }

  // ── Optional chaining with tagged template literal ───────────────
  // ES spec: OptionalChain : ?.TemplateLiteral and OptionalChain TemplateLiteral
  // are always SyntaxErrors. Tagged templates cannot be used with optional chaining.
  if (ts.isTaggedTemplateExpression(node)) {
    // Check if the tag uses optional chaining
    if (hasOptionalChain(node.tag)) {
      ctx.addError(node, "Tagged template cannot be used in an optional chain");
    }
    // Also check for direct ?.` pattern: a?.`hello`
    const tagEnd = node.tag.end;
    const textBetween = ctx.sourceFile.text.substring(tagEnd - 2, tagEnd + 2);
    if (textBetween.includes("?.")) {
      ctx.addError(node, "Tagged template cannot be used in an optional chain");
    }
  }

  // ── new.target outside function ─────────────────────────────────
  // ES spec: new.target is only valid inside functions (including arrow functions
  // which inherit from enclosing function) and class static blocks.
  if (node.kind === ts.SyntaxKind.MetaProperty) {
    const meta = node as ts.MetaProperty;
    if (meta.keywordToken === ts.SyntaxKind.NewKeyword && meta.name.text === "target") {
      if (!isInsideFunction(node) && !isInsideClassStaticBlock(node)) {
        ctx.addError(node, "new.target is only valid inside functions");
      }
    }
  }

  // ── super() in constructor of class without extends ──────────────
  // ES spec: It is a Syntax Error if ConstructorMethod of ClassBody contains
  // SuperCall and ClassHeritage is not present.
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
    // Find the enclosing class
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isConstructorDeclaration(current)) {
        const classNode = current.parent;
        if (
          (ts.isClassDeclaration(classNode) || ts.isClassExpression(classNode)) &&
          !classNode.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
        ) {
          ctx.addError(node, "super() is only valid in a constructor of a derived class");
        }
        break;
      }
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
        break;
      }
      current = current.parent;
    }
  }

  // ── ASI: postfix ++/-- with line terminator before operator ─────
  // ES spec: no LineTerminator between LeftHandSideExpression and ++/--.
  // If a line terminator separates the operand from the operator, ASI applies
  // and the ++ is parsed as a prefix on the next line. But if there's no
  // next operand, it's a SyntaxError.
  // NOTE: This only applies to LINE SEPARATOR (U+2028) and PARAGRAPH SEPARATOR (U+2029)
  // because regular \n and \r are handled by TS parser's ASI behavior.
  // After wrapTest resolves Unicode escapes, these characters appear literally.

  // ── 'using' / 'await using' placement restrictions ───────────────
  if (isUsingDeclarationStatement(node)) {
    const parent = node.parent;
    if (parent && (ts.isCaseClause(parent) || ts.isDefaultClause(parent))) {
      ctx.addError(node, "Using declarations cannot appear directly in switch case/default statement lists");
    }
    if (parent && isStatementPosition(parent, node)) {
      ctx.addError(node, "Using declarations cannot appear in a single-statement context");
    }
    if (ts.isSourceFile(parent) && !ts.isExternalModule(parent)) {
      const isAwaitUsing = (node.declarationList.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing;
      ctx.addError(
        node,
        isAwaitUsing
          ? "'await using' declarations are not allowed at the top level of scripts"
          : "'using' declarations are not allowed at the top level of scripts",
      );
    }
    // ── 'using' binding restrictions ──────────────────────────────
    // ES spec: UsingDeclaration only allows BindingIdentifier, not patterns.
    // `using {} = x` and `using [] = x` are SyntaxErrors.
    // Each binding must also have an initializer (using is always IsConstantDeclaration).
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) {
        ctx.addError(decl.name, "Using declarations require a binding identifier, not a destructuring pattern");
      } else if (!decl.initializer) {
        ctx.addError(decl, "Using declarations require an initializer");
      }
    }
  }

  // ── Fields named "constructor" in class ──────────────────────────
  // ES spec: ClassElement: FieldDefinition ;
  //   It is a Syntax Error if PropName of FieldDefinition is "constructor".
  // ES spec: ClassElement: static FieldDefinition ;
  //   It is a Syntax Error if PropName of FieldDefinition is "prototype" or "constructor".
  // So "constructor" is always forbidden as a field name (static or not).
  if (ts.isPropertyDeclaration(node)) {
    const name = ts.isIdentifier(node.name) ? node.name.text : ts.isStringLiteral(node.name) ? node.name.text : null;
    if (name === "constructor") {
      ctx.addError(node, "Classes may not have a field named 'constructor'");
    }
  }

  // ── Duplicate constructor methods ────────────────────────────────
  // ES spec: It is a Syntax Error if PrototypePropertyNameList of ClassElementList
  // contains more than one occurrence of "constructor".
  // Handled by checkDuplicateConstructors in the class-level check.

  // ── HTML single-line close comment in module ─────────────────────
  // ES spec: HTML-like comments (<!-- and -->) are only valid in scripts.
  // We're always in module mode. Check for --> at the start of a line.
  // Note: TS parser doesn't flag this.

  forEachChild(node, (child) => runNodeChecks(ctx, child));
}
