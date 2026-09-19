// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Module / source-file level ES early-error rules (#1931): default-export of a
// declaration, duplicate export names, module-item position, reserved
// yield/await identifiers, HTML close comments, and duplicate class
// constructors. Extracted verbatim from detectEarlyErrors; the only change is
// threading an EarlyErrorContext and importing the shared predicate helpers.
import { ts, forEachChild } from "../../ts-api.js";
import type { EarlyErrorContext } from "./context.js";
import { findInnermostNodeAtPosition, isInYieldParamContext, isStrictMode } from "./predicates.js";

/**
 * `export default const/var/let` — always a SyntaxError.
 * ES spec: ExportDeclaration : export default HoistableDeclaration |
 *          export default ClassDeclaration | export default [LAE] AssignmentExpression ;
 * VariableStatement and LexicalDeclaration are not valid after export default.
 */
export function checkExportDefaultDeclaration(ctx: EarlyErrorContext): void {
  const { sourceFile } = ctx;
  for (const stmt of sourceFile.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      // TS models `export default expr` as ExportAssignment.
      // But `export default const x = 1` is parsed differently — TS may parse it
      // as ExportAssignment with the expression being an error node.
      // Check the raw source for the pattern.
      const start = stmt.getStart(sourceFile);
      const rawText = sourceFile.text.substring(start, start + 30);
      if (/^export\s+default\s+(?:const|let|var)\b/.test(rawText)) {
        ctx.addError(stmt, "A default export may not be a variable/lexical declaration");
      }
    }
  }
}

/**
 * Duplicate IMPORTED bound names (source-file level check).
 *
 * §16.2.1.1: ModuleItemList's LexicallyDeclaredNames include ImportedBindings,
 * and it is a Syntax Error if they contain duplicate entries — so
 * `import { x } from "a"; import { y as x } from "b";` is an early error even
 * though neither declaration is duplicated on its own.
 *
 * (#6491) Nothing enforced this rule. The single-source path only APPEARED to:
 * its import preprocessing rewrites unresolvable imports into declarations, and
 * `checkDuplicateLexicalDeclarations` then reported the rewritten pair. The
 * multi-file path resolves imports through the TS program and never rewrites,
 * so the SAME source compiled clean there (`language/import/dup-bound-names.js`
 * in the linked test262 lane). The rule belongs in the early-error pass, where
 * it holds for every path.
 *
 * Deliberately narrow: import-vs-import only. The import-vs-top-level-lexical
 * half of §16.2.1.1 needs the module-goal scoping rules
 * `checkDuplicateLexicalDeclarations` owns and is not folded in here.
 */
export function checkDuplicateImportedBindings(ctx: EarlyErrorContext): void {
  const seen = new Map<string, ts.Node>();
  const add = (name: string, node: ts.Node): void => {
    if (seen.has(name)) {
      ctx.addError(node, `Duplicate identifier '${name}'`);
      return;
    }
    seen.set(name, node);
  };
  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const clause = stmt.importClause;
    if (clause.name) add(clause.name.text, clause.name);
    if (!clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      add(clause.namedBindings.name.text, clause.namedBindings.name);
    } else {
      for (const element of clause.namedBindings.elements) add(element.name.text, element.name);
    }
  }
}

/**
 * Duplicate export names (source-file level check).
 * ES spec: It is a Syntax Error if ExportedNames contains any duplicate entries.
 */
export function checkDuplicateExportNames(ctx: EarlyErrorContext): void {
  const { sourceFile } = ctx;
  const exportedNames = new Map<string, ts.Node>();
  // TypeScript overload signatures are erased and therefore do not each add
  // an ECMAScript runtime export. Only the same-name body-bearing
  // implementation contributes the exported name (#4267).
  const overloadImplementations = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      overloadImplementations.add(statement.name.text);
    }
  }
  for (const stmt of sourceFile.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          const exportedAs = spec.name.text;
          if (exportedNames.has(exportedAs)) {
            ctx.addError(spec, `Duplicate export name '${exportedAs}'`);
          } else {
            exportedNames.set(exportedAs, spec);
          }
        }
      }
      // export * as name — adds 'name' to exported names
      if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
        const exportedAs = stmt.exportClause.name.text;
        if (exportedNames.has(exportedAs)) {
          ctx.addError(stmt.exportClause, `Duplicate export name '${exportedAs}'`);
        } else {
          exportedNames.set(exportedAs, stmt.exportClause);
        }
      }
    }
    if (ts.isExportAssignment(stmt)) {
      if (exportedNames.has("default")) {
        ctx.addError(stmt, "Duplicate export name 'default'");
      } else {
        exportedNames.set("default", stmt);
      }
    }
    // export function/class/variable declarations contribute to exported names
    if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.name &&
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (!stmt.body && overloadImplementations.has(stmt.name.text)) continue;
      const isDefault = ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      const name = isDefault ? "default" : stmt.name.text;
      if (exportedNames.has(name)) {
        ctx.addError(stmt.name, `Duplicate export name '${name}'`);
      } else {
        exportedNames.set(name, stmt.name);
      }
    }
    if (
      ts.isClassDeclaration(stmt) &&
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const isDefault = ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      const name = isDefault ? "default" : (stmt.name?.text ?? "default");
      if (exportedNames.has(name)) {
        ctx.addError(stmt.name ?? stmt, `Duplicate export name '${name}'`);
      } else {
        exportedNames.set(name, stmt.name ?? stmt);
      }
    }
    if (
      ts.isVariableStatement(stmt) &&
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          if (exportedNames.has(decl.name.text)) {
            ctx.addError(decl.name, `Duplicate export name '${decl.name.text}'`);
          } else {
            exportedNames.set(decl.name.text, decl.name);
          }
        }
      }
    }
  }
}

/**
 * Detect the test262-runner wrapTest sentinel — `export function test(): number`.
 * The wrapper buries the original test body inside that function, so legitimately
 * top-level import/export and bare yield/await end up nested. The module-item and
 * reserved-identifier checks skip wrapped sources.
 */
function isWrapTestSource(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (s) =>
      ts.isFunctionDeclaration(s) &&
      s.name?.text === "test" &&
      ts.canHaveModifiers(s) &&
      ts.getModifiers(s as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      s.type &&
      s.type.kind === ts.SyntaxKind.NumberKeyword,
  );
}

/**
 * Import/Export declaration position (ES static semantics).
 * ImportDeclaration / ExportDeclaration / ExportAssignment are ModuleItems —
 * they may only appear at the top level of a Module.
 */
/**
 * (#6491 round 3) ModuleItems in a **Script**.
 *
 * `import` / `export` declarations are ModuleItems (§16.2.1) and `import.meta`
 * is a MetaProperty whose production is only reachable from a Module
 * (§13.3.12.1: "It is a Syntax Error if the syntactic goal symbol is not
 * Module"). In a Script all three are SyntaxErrors — which is what
 * `global-code/{export,import}.js` and `import.meta/syntax/goal-script.js`
 * assert.
 *
 * Gated on `ctx.scriptGoal`, never on `!ctx.moduleGoal`. That distinction is
 * the whole reason these three rows were left unfixed in round 2: every
 * ordinary product compile leaves the module-goal flag absent, and product
 * `.ts` files are full of legitimate `export`s. Only a caller that KNOWS the
 * goal — the test262 runner, reading `flags: [module]` — sets the flag, so the
 * rule cannot reach code whose goal is merely unstated.
 */
export function checkScriptGoalModuleItems(ctx: EarlyErrorContext): void {
  if (!ctx.scriptGoal) return;
  const { sourceFile } = ctx;
  if (isWrapTestSource(sourceFile)) return;
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      ctx.addError(stmt, "'import' declarations are only allowed in a module");
    } else if (ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) {
      ctx.addError(stmt, "'export' declarations are only allowed in a module");
    } else if (
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt)?.some((m: ts.Modifier) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      // `export function f() {}` / `export class C {}` / `export var x` — the
      // export is a MODIFIER on the declaration rather than its own statement.
      ctx.addError(stmt, "'export' declarations are only allowed in a module");
    }
  }
  const walk = (node: ts.Node): void => {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      ctx.addError(node, "'import.meta' is only allowed in a module");
      return;
    }
    forEachChild(node, walk);
  };
  walk(sourceFile);
}

/**
 * (#6491 round 3) `await` / `arguments` inside a ClassStaticBlock (§15.7.1).
 *
 * "It is a Syntax Error if ClassStaticBlockStatementList Contains `arguments`"
 * and likewise for `await`. The AwaitExpression half is already handled in
 * node-checks; what was missing is the IDENTIFIER-shaped half, which is how all
 * three corpus rows are written:
 *
 *   static { function await() {} }          — BindingIdentifier
 *   static { ((x = await) => 0); }          — IdentifierReference in an arrow's
 *                                             parameter default
 *   static { (class { [arguments]() {} }); } — a computed key, evaluated in the
 *                                             static block's own scope
 *
 * The walk descends through ARROW functions — `Contains` is transparent for
 * them, which is exactly what the second row depends on — and stops at ordinary
 * functions, methods and accessors, which introduce their own `arguments` and
 * their own [Await] parameterisation. A function's own NAME is stepped past
 * rather than skipped: `function await() {}` declares `await` IN the static
 * block, which is the first row.
 */
export function checkClassStaticBlockReservedNames(ctx: EarlyErrorContext): void {
  const RESERVED = new Set(["await", "arguments"]);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && RESERVED.has(node.text)) {
      const parent = node.parent;
      // A property/member NAME is not a reference (`o.arguments`, `{arguments: 1}`).
      const isMemberName =
        parent &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isMethodDeclaration(parent) && parent.name === node) ||
          (ts.isPropertyDeclaration(parent) && parent.name === node));
      if (!isMemberName) {
        ctx.addError(node, `'${node.text}' is not allowed in a class static initialization block`);
        return;
      }
    }
    if (ts.isFunctionDeclaration(node)) {
      // A DECLARATION's BindingIdentifier is declared in the enclosing scope —
      // the static block — so `static { function await() {} }` is an error even
      // though the body is not inspected.
      if (node.name) visit(node.name);
      return;
    }
    if (
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      // A function EXPRESSION's name is bound INSIDE the function, and its
      // parameters belong to the function too, so neither is "contained" by the
      // static block. Measured, not assumed: flagging the name here broke
      // `expressions/generators/static-init-await-binding.js`, whose whole
      // point is that `static { (function * await (await) {}); }` is LEGAL.
      // A computed method key is still inspected below via its own node.
      if (node.name && ts.isComputedPropertyName(node.name)) visit(node.name);
      return;
    }
    forEachChild(node, visit);
  };
  const walk = (node: ts.Node): void => {
    if (ts.isClassStaticBlockDeclaration(node)) {
      forEachChild(node.body, visit);
      return;
    }
    forEachChild(node, walk);
  };
  walk(ctx.sourceFile);
}

/**
 * (#6491 round 3) A generator/async FunctionExpression may not be named `yield`
 * or `await` (§15.5.1 / §15.6.1).
 *
 * A function EXPRESSION's BindingIdentifier is bound inside the function's own
 * scope — that is the whole point of a named function expression — and inside a
 * generator `yield` is reserved, inside an async function `await` is. So
 * `var g = function* yield() {};` and `(async function* yield() {})` are
 * SyntaxErrors.
 *
 * Deliberately NOT extended to generator DECLARATIONS: there the name is bound
 * in the ENCLOSING scope, where the reservation does not apply, and flagging it
 * would reject code the corpus does not call an error.
 */
export function checkGeneratorExpressionName(ctx: EarlyErrorContext): void {
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionExpression(node) && node.name) {
      const isGenerator = node.asteriskToken !== undefined;
      const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
      const name = node.name.text;
      if ((isGenerator && name === "yield") || (isAsync && name === "await")) {
        ctx.addError(node.name, `'${name}' is not a valid name for this function expression`);
      }
    }
    forEachChild(node, walk);
  };
  walk(ctx.sourceFile);
}

/**
 * (#6491 round 3) Module export clauses (§16.2.3.1).
 *
 * Two rules, both on an `export { … }` clause with NO `from` (a LOCAL export
 * clause — a re-export names the OTHER module's bindings and neither rule
 * applies):
 *
 * 1. Every ReferencedBindings entry must be declared in the module. `export {
 *    Number }` and `export { unresolvable }` are SyntaxErrors even though the
 *    names resolve (or don't) at run time — being a global is not being a
 *    module-level declaration.
 * 2. A string ModuleExportName may only appear as the local side of a
 *    RE-export; `export { "foo" as "bar" }` has no binding to name.
 *
 * Gated on `ctx.moduleGoal` rather than the syntactic module indicator: this
 * needs the complete set of declared names, and a product compile reaches here
 * with TypeScript's own (stronger) resolution already applied.
 */
export function checkExportedBindingsDeclared(ctx: EarlyErrorContext): void {
  if (!ctx.moduleGoal) return;
  const { sourceFile } = ctx;
  if (isWrapTestSource(sourceFile)) return;
  const declared = new Set<string>();
  const addBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      declared.add(name.text);
      return;
    }
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) addBindingName(el.name);
    }
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) addBindingName(d.name);
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      declared.add(node.name.text);
      return;
    }
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) declared.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings) {
        if (ts.isNamespaceImport(bindings)) declared.add(bindings.name.text);
        else for (const spec of bindings.elements) declared.add(spec.name.text);
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      declared.add(node.name.text);
      return;
    }
    // `var` hoists out of blocks/loops, so keep descending through statements
    // while stopping at anything that starts its own scope.
    if (
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isClassExpression(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return;
    }
    forEachChild(node, collect);
  };
  for (const stmt of sourceFile.statements) collect(stmt);

  for (const stmt of sourceFile.statements) {
    if (!ts.isExportDeclaration(stmt) || stmt.moduleSpecifier) continue;
    if (stmt.isTypeOnly) continue;
    const clause = stmt.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    for (const spec of clause.elements) {
      if (spec.isTypeOnly) continue;
      const local = spec.propertyName ?? spec.name;
      if (ts.isStringLiteral(local)) {
        ctx.addError(spec, "A string module export name requires a 'from' clause");
        continue;
      }
      if (!declared.has(local.text)) {
        ctx.addError(spec, `Export '${local.text}' is not declared in this module`);
      }
    }
  }
}

/**
 * (#6491 round 3) `for (let in o)` in strict code (§14.7.5.1).
 *
 * Here `let` is an IdentifierReference used as the for-in LeftHandSideExpression
 * — sloppy-legal, and a SyntaxError in strict code, where `let` is reserved.
 * The strict-reserved-word rule in node-checks cannot see it because that rule
 * only fires on BindingIdentifier positions, and this `let` binds nothing.
 *
 * TypeScript parses this one shape as a VariableDeclarationList with ZERO
 * declarations (the whole initializer is the bare word `let`), which is not
 * reachable from any other syntax — so the empty list IS the discriminator.
 */
export function checkForInLetReference(ctx: EarlyErrorContext): void {
  const walk = (node: ts.Node): void => {
    if (ts.isForInStatement(node)) {
      const init = node.initializer;
      if (ts.isVariableDeclarationList(init) && init.declarations.length === 0 && isStrictMode(node)) {
        ctx.addError(init, "'let' is not allowed as an identifier in strict mode");
      }
    }
    forEachChild(node, walk);
  };
  walk(ctx.sourceFile);
}

export function checkModuleItemPosition(ctx: EarlyErrorContext): void {
  const { sourceFile } = ctx;
  if (isWrapTestSource(sourceFile)) return;
  const walk = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node)
    ) {
      if (node.parent && !ts.isSourceFile(node.parent)) {
        const kind = ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) ? "import" : "export";
        ctx.addError(node, `${kind} declarations may only appear at the top level of a module`);
        return;
      }
    }
    forEachChild(node, walk);
  };
  walk(sourceFile);
}

/**
 * Reserved words `yield` / `await` used as an identifier.
 * `yield` is reserved in strict-mode code and inside generator bodies;
 * `await` is reserved in module code and inside async function bodies.
 */
export function checkReservedIdentifiers(ctx: EarlyErrorContext): void {
  const { sourceFile } = ctx;
  if (isWrapTestSource(sourceFile)) return;
  const sourceFileIsModule = ts.isExternalModule(sourceFile);
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && (node.text === "yield" || node.text === "await")) {
      // Skip cases where the identifier is a member / property name or
      // import / export name — those are IdentifierName positions and are
      // always allowed.
      const parent = node.parent;
      if (parent) {
        if (
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isQualifiedName(parent) && parent.right === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isMethodDeclaration(parent) && parent.name === node) ||
          (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
          (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
          (ts.isPropertyDeclaration(parent) && parent.name === node) ||
          (ts.isImportSpecifier(parent) && parent.propertyName === node) ||
          (ts.isExportSpecifier(parent) && parent.propertyName === node) ||
          (ts.isExportSpecifier(parent) && parent.name === node) ||
          (ts.isImportSpecifier(parent) && parent.name === node)
        ) {
          return; // property / import / export name position — allowed
        }
      }

      const name = node.text;
      if (name === "yield") {
        // Reserved in strict mode or inside any enclosing generator.
        // (#5141) The enclosing-generator walk must stop at the first
        // non-arrow function boundary — a nested ordinary function resets
        // [Yield], so `function*g(){ function h(){ yield = 1; } }` is legal —
        // and a function's own BindingIdentifier is not judged by its own
        // context. `isInYieldParamContext` implements both (mirrors the
        // `await` rule below, which already walks to the function boundary).
        const reserved = isStrictMode(node) || sourceFileIsModule || isInYieldParamContext(node);
        if (reserved) {
          ctx.addError(node, "'yield' is a reserved word and may not be used as an identifier in strict mode");
        }
      } else if (name === "await") {
        // ES spec §13.2.5.1: `await` is reserved at module top level
        // ([+Await] goal) and inside async function bodies. A non-async
        // function body uses [~Await], so `await` is a valid identifier
        // there even within a module. Walk up to the nearest function
        // boundary to determine the context.
        let reserved = false;
        let c: ts.Node | undefined = node.parent;
        while (c) {
          if (ts.isArrowFunction(c)) {
            // Arrow functions inherit [+Await] from their enclosing context —
            // they do NOT reset it. If async, mark reserved and stop.
            // If non-async, keep walking outward.
            if (c.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
              reserved = true;
              break;
            }
            // non-async arrow: continue to enclosing scope
          } else if (ts.isFunctionDeclaration(c) || ts.isFunctionExpression(c) || ts.isMethodDeclaration(c)) {
            // Non-arrow function boundary resets [Await] context.
            // Exception: if 'await' is the BindingIdentifier (name) of THIS
            // function, it's evaluated in the ENCLOSING scope's [Await] context,
            // not the function's own body. Keep walking up. (#1068)
            if ((c as any).name === node) {
              c = c.parent;
              continue;
            }
            reserved = !!c.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
            break;
          }
          c = c.parent;
        }
        // No enclosing function — module top level is [+Await]
        if (!c && sourceFileIsModule) {
          reserved = true;
        }
        if (reserved) {
          ctx.addError(
            node,
            "'await' is a reserved word and may not be used as an identifier in module code or async functions",
          );
        }
      }
    }
    forEachChild(node, walk);
  };
  walk(sourceFile);
}

/**
 * HTML close comment (-->) in module code.
 * HTML-like comments are allowed in scripts but not in modules.
 */
export function checkHtmlCloseComment(ctx: EarlyErrorContext): void {
  const { sourceFile } = ctx;
  if (!ts.isExternalModule(sourceFile)) return;
  for (const line of sourceFile.text.split(/\r?\n/u)) {
    if (/^\s*(?:;+\s*)?-->/.test(line)) {
      const offset = sourceFile.text.indexOf(line);
      const lineNode = findInnermostNodeAtPosition(sourceFile, offset);
      ctx.addError(lineNode, "HTML close comments are not allowed in module code");
      break;
    }
  }
}

/**
 * Duplicate class constructors.
 * ES spec: It is a Syntax Error if PrototypePropertyNameList of ClassElementList
 * contains more than one occurrence of "constructor".
 */
function isStaticCtorMethodMember(member: ts.ClassElement): boolean {
  // (#5195 r3-4) Local twin of `codegen/ast-modifiers.ts::isStaticCtorMethod`,
  // kept local so early-errors takes no codegen import. `static constructor(){}`
  // is a static METHOD named "constructor" (§15.7), not the class's
  // constructor, so it must not count toward the duplicate-constructor rule.
  const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
}

export function checkDuplicateConstructors(ctx: EarlyErrorContext): void {
  const checkClass = (classNode: ts.ClassDeclaration | ts.ClassExpression): void => {
    let ctorCount = 0;
    for (const member of classNode.members) {
      if (ts.isConstructorDeclaration(member) && !isStaticCtorMethodMember(member)) {
        // Only count constructors with a body (declarations without bodies are overloads)
        if (member.body) {
          ctorCount++;
          if (ctorCount > 1) {
            ctx.addError(member, "A class may only have one constructor");
            break;
          }
        }
      }
    }
  };
  const walk = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      checkClass(node);
    }
    forEachChild(node, walk);
  };
  walk(ctx.sourceFile);
}
