// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Erase TypeScript-only syntax by overwriting it with spaces, keeping every
// remaining character at its original offset.
//
// Why not `ts.transpileModule`: it moves code. The AST explorer parses with
// acorn (JavaScript only) but wants to point back into the TypeScript the user
// typed — hover a node, highlight that range in the editor. Offsets survive
// only if the erasure is a same-length blanking, so `const x: number = 1` keeps
// `x` and `1` exactly where they were. This is the `ts-blank-space` idea,
// implemented against the TypeScript AST the playground already loads.
//
// Deliberately partial. Constructs that need real code GENERATION rather than
// deletion — enums, namespaces with values, parameter properties, decorator
// emit — cannot be blanked, so this returns null for them and the caller falls
// back to `ts.transpileModule` (correct JS, shifted offsets, no hover mapping).
// A silent wrong answer would be worse than an honest fallback.

import type * as TS from "typescript";

/** Half-open [start, end) range in the original source. */
type Span = [number, number];

export interface EraseResult {
  /** Source with TS-only syntax blanked out; same length as the input. */
  code: string;
  /** Constructs that forced a bail-out, when `code` is null. */
  unsupported?: string;
}

/**
 * @returns the blanked source, or null when the file uses a construct that
 * cannot be erased by blanking alone (the caller should transpile instead).
 */
export function eraseTypesPreservingOffsets(ts: typeof TS, source: string, fileName = "input.ts"): EraseResult | null {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, /*setParentNodes*/ true, ts.ScriptKind.TS);
  const spans: Span[] = [];
  let unsupported: string | null = null;

  const bail = (what: string) => {
    unsupported ??= what;
  };

  // A node's full width includes leading trivia (comments); blanking that would
  // delete comments the reader can see in the editor. Use the token start.
  const spanOf = (node: TS.Node): Span => [node.getStart(sf), node.getEnd()];

  const blankNode = (node: TS.Node | undefined) => {
    if (node) spans.push(spanOf(node));
  };

  // For `x: T`, the colon sits between the name and the type and must go too.
  const blankTypeAnnotation = (type: TS.TypeNode | undefined) => {
    if (!type) return;
    const end = type.getEnd();
    let start = type.getStart(sf);
    // Walk back over whitespace to the ':' that introduced it.
    let i = start - 1;
    while (i >= 0 && /\s/.test(source[i]!)) i--;
    if (source[i] === ":") start = i;
    spans.push([start, end]);
  };

  const blankTypeArguments = (args: TS.NodeArray<TS.TypeNode> | undefined) => {
    if (!args || args.length === 0) return;
    // `f<A, B>(…)` — blank from the '<' before the first argument through the
    // '>' after the last. pos-1/end+1 are not reliable, so scan.
    let start = args[0]!.getStart(sf);
    while (start > 0 && source[start - 1] !== "<") start--;
    if (start > 0) start -= 1; // include '<'
    let end = args[args.length - 1]!.getEnd();
    while (end < source.length && source[end] !== ">") end++;
    if (end < source.length) end += 1; // include '>'
    spans.push([start, end]);
  };

  const blankModifiers = (node: TS.Node) => {
    const mods = (node as { modifiers?: TS.NodeArray<TS.ModifierLike> }).modifiers;
    if (!mods) return;
    for (const mod of mods) {
      switch (mod.kind) {
        case ts.SyntaxKind.PublicKeyword:
        case ts.SyntaxKind.PrivateKeyword:
        case ts.SyntaxKind.ProtectedKeyword:
        case ts.SyntaxKind.ReadonlyKeyword:
        case ts.SyntaxKind.AbstractKeyword:
        case ts.SyntaxKind.OverrideKeyword:
        case ts.SyntaxKind.DeclareKeyword:
          spans.push(spanOf(mod));
          break;
        case ts.SyntaxKind.Decorator:
          // Decorators are emit, not erasure.
          bail("decorators");
          break;
        default:
          break;
      }
    }
  };

  const visit = (node: TS.Node): void => {
    if (unsupported) return;

    switch (node.kind) {
      // ── Whole-node erasures: type-only declarations ──────────────────────
      case ts.SyntaxKind.InterfaceDeclaration:
      case ts.SyntaxKind.TypeAliasDeclaration:
        blankNode(node);
        return;

      case ts.SyntaxKind.ImportDeclaration: {
        const decl = node as TS.ImportDeclaration;
        if (decl.importClause?.isTypeOnly) {
          blankNode(node);
          return;
        }
        break;
      }
      case ts.SyntaxKind.ExportDeclaration: {
        const decl = node as TS.ExportDeclaration;
        if (decl.isTypeOnly) {
          blankNode(node);
          return;
        }
        break;
      }

      // `import { a, type B }` / `export { a, type B }` — the inline `type`
      // specifier is erased on its own, and must take one adjacent comma with
      // it: `{   , a }` is not legal JS while `{ a,   }` is.
      //
      // Take the FOLLOWING comma by preference, the preceding one only for the
      // last specifier. Preferring the preceding comma breaks a run of type
      // specifiers — `{ type A, type B, c }` would leave B's own trailing comma
      // stranded in front of `c`.
      case ts.SyntaxKind.ImportSpecifier:
      case ts.SyntaxKind.ExportSpecifier: {
        const spec = node as TS.ImportSpecifier | TS.ExportSpecifier;
        if (spec.isTypeOnly) {
          let [start, end] = spanOf(spec);
          let j = end;
          while (j < source.length && /\s/.test(source[j]!)) j++;
          if (source[j] === ",") {
            end = j + 1;
          } else {
            let i = start - 1;
            while (i >= 0 && /\s/.test(source[i]!)) i--;
            if (source[i] === ",") start = i;
          }
          spans.push([start, end]);
        }
        return;
      }

      // ── Constructs that need code generation, not deletion ───────────────
      case ts.SyntaxKind.EnumDeclaration:
        bail("enum");
        return;
      case ts.SyntaxKind.ModuleDeclaration:
        bail("namespace/module");
        return;
      case ts.SyntaxKind.ImportEqualsDeclaration:
        bail("import =");
        return;

      // ── Expression-level type syntax ─────────────────────────────────────
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.SatisfiesExpression: {
        const expr = node as TS.AsExpression | TS.SatisfiesExpression;
        // Blank ` as T` / ` satisfies T`: from the end of the operand to the
        // end of the type.
        spans.push([expr.expression.getEnd(), expr.getEnd()]);
        visit(expr.expression);
        return;
      }
      case ts.SyntaxKind.TypeAssertionExpression: {
        // `<T>value` — the angle-bracket form.
        const expr = node as TS.TypeAssertion;
        spans.push([expr.getStart(sf), expr.expression.getStart(sf)]);
        visit(expr.expression);
        return;
      }
      case ts.SyntaxKind.NonNullExpression: {
        const expr = node as TS.NonNullExpression;
        spans.push([expr.expression.getEnd(), expr.getEnd()]);
        visit(expr.expression);
        return;
      }
      default:
        break;
    }

    // ── Per-node pieces ────────────────────────────────────────────────────
    blankModifiers(node);

    const anyNode = node as TS.Node & {
      type?: TS.TypeNode;
      typeParameters?: TS.NodeArray<TS.TypeParameterDeclaration>;
      typeArguments?: TS.NodeArray<TS.TypeNode>;
      questionToken?: TS.Node;
      exclamationToken?: TS.Node;
      body?: TS.Node;
      heritageClauses?: TS.NodeArray<TS.HeritageClause>;
    };

    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      blankTypeAnnotation(anyNode.type);
    }

    if (anyNode.typeParameters) {
      const first = anyNode.typeParameters[0]!;
      let start = first.getStart(sf);
      while (start > 0 && source[start - 1] !== "<") start--;
      if (start > 0) start -= 1;
      let end = anyNode.typeParameters[anyNode.typeParameters.length - 1]!.getEnd();
      while (end < source.length && source[end] !== ">") end++;
      if (end < source.length) end += 1;
      spans.push([start, end]);
    }

    // `f<T>(x)` / `new C<T>()` — call-site type arguments.
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && anyNode.typeArguments) {
      blankTypeArguments(anyNode.typeArguments);
    }

    // A `this` parameter is a type annotation wearing a parameter's clothes —
    // it declares no binding and must not survive into the JS. Take one
    // adjacent comma with it, same rule as a type-only import specifier.
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === "this") {
      let [start, end] = spanOf(node);
      let j = end;
      while (j < source.length && /\s/.test(source[j]!)) j++;
      if (source[j] === ",") {
        end = j + 1;
      } else {
        let i = start - 1;
        while (i >= 0 && /\s/.test(source[i]!)) i--;
        if (source[i] === ",") start = i;
      }
      spans.push([start, end]);
      return;
    }

    // Optional markers on parameters and properties are type-level.
    if (
      (ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node)) &&
      anyNode.questionToken
    ) {
      blankNode(anyNode.questionToken);
    }
    // Definite-assignment `!` on a property or a `let` binding.
    if ((ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && anyNode.exclamationToken) {
      blankNode(anyNode.exclamationToken);
    }

    // `class C implements I` — the clause is type-only; `extends` is not.
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const clause of anyNode.heritageClauses ?? []) {
        if (clause.token === ts.SyntaxKind.ImplementsKeyword) blankNode(clause);
      }
    }

    // A signature without a body is an overload declaration or an ambient
    // declaration — nothing to emit.
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) &&
      !anyNode.body
    ) {
      blankNode(node);
      return;
    }

    // A constructor parameter with an accessibility modifier declares a field:
    // that is emit, not erasure.
    if (ts.isParameter(node) && node.modifiers?.some((m) => m.kind !== ts.SyntaxKind.Decorator)) {
      const parent = node.parent;
      if (parent && ts.isConstructorDeclaration(parent)) {
        bail("parameter property");
        return;
      }
    }

    // Index signatures and call/construct signatures inside a class body are
    // type-only members.
    if (ts.isIndexSignatureDeclaration(node) || ts.isPropertySignature(node) || ts.isMethodSignature(node)) {
      blankNode(node);
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);

  if (unsupported) return { code: "", unsupported };

  return { code: blankSpans(source, spans) };
}

/**
 * Replace each span with spaces, keeping newlines so line/column numbers — and
 * therefore acorn's error positions — still line up with the editor.
 */
function blankSpans(source: string, spans: Span[]): string {
  if (spans.length === 0) return source;
  const out = source.split("");
  for (const [start, end] of spans) {
    for (let i = Math.max(0, start); i < Math.min(end, out.length); i++) {
      if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
    }
  }
  return out.join("");
}
