// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B9) Does this program REPLACE one of
 * `RegExp.prototype`'s well-known-symbol methods?
 *
 * ```js
 * RegExp.prototype[Symbol.match] = function () { … };
 * RegExp.prototype[Symbol.match];     // must read the user function back
 * 'target'.match('string source');    // §22.1.3.11 step 5: Invoke(rx, @@match)
 * ```
 *
 * ## What was already true, measured
 *
 * The WRITE lands: in `--target standalone` the assignment goes through
 * `__extern_set`'s `$NativeProto` arm into the RegExp brand's companion
 * `$Object` (proto-index-store.ts; `__protoidx_norm_key` admits native Symbol
 * carriers). Every RUNTIME-keyed reader then sees it — an aliased
 * `p[Symbol.match]`, `gOPD(RegExp.prototype, Symbol.match).value`, and
 * `r[Symbol.match]` on a RegExp instance all answered the user function on the
 * base tree. What did not see it were the two COMPILE-TIME answers:
 *
 *  1. `tryCompileStandaloneBuiltinProtoIteratorRead` folds the literal
 *     spelling `RegExp.prototype[Symbol.match]` to the builtin method
 *     singleton, so the read-back returned the builtin.
 *  2. `String.prototype.{match,search}` with a non-RegExp argument lowers
 *     RegExpCreate + the builtin body inline (`string-search-value.ts`), with
 *     no Invoke of `rx[@@match]` at all.
 *
 * Both are correct exactly when the program never replaces the member, which is
 * what this module answers — syntactically and for the whole file, like
 * `sourceOverridesBuiltinPrototypeMember` (builtin-proto-member-override.ts):
 * writing `RegExp.prototype[Symbol.match]` affects every RegExp in the module,
 * so there is no per-receiver question to get wrong.
 *
 * ## What counts as a write
 *
 * `RegExp.prototype[Symbol.<m>] <assign-op> …`, `delete RegExp.prototype[Symbol.<m>]`
 * and `Object|Reflect.defineProperty(RegExp.prototype, Symbol.<m>, …)`, for the
 * five §22.2.6 symbol members. A write through an ALIAS
 * (`var p = RegExp.prototype; p[Symbol.match] = f`) is not recognised; such a
 * program keeps the pre-B9 compile-time answers (a recorded boundary, not a
 * regression).
 *
 * Pure syntax (no codegen imports) so the `scanForArrayHoles` pre-scan can use
 * it without an import cycle.
 */
import { ts } from "../ts-api.js";

/** The §22.2.6 well-known-symbol members of `RegExp.prototype`. */
const REGEXP_SYMBOL_MEMBERS: ReadonlySet<string> = new Set(["match", "matchAll", "replace", "search", "split"]);

function unwrap(n: ts.Expression): ts.Expression {
  let e = n;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** `RegExp.prototype` (type-only wrappers allowed on both halves). */
function isRegExpPrototype(raw: ts.Expression): boolean {
  const n = unwrap(raw);
  if (!ts.isPropertyAccessExpression(n) || n.name.text !== "prototype") return false;
  const ctor = unwrap(n.expression);
  return ts.isIdentifier(ctor) && ctor.text === "RegExp";
}

/** `Symbol.<m>` for one of the five members → `<m>`, else undefined. */
function regExpSymbolKey(raw: ts.Expression): string | undefined {
  const n = unwrap(raw);
  if (!ts.isPropertyAccessExpression(n)) return undefined;
  const base = unwrap(n.expression);
  if (!ts.isIdentifier(base) || base.text !== "Symbol") return undefined;
  return REGEXP_SYMBOL_MEMBERS.has(n.name.text) ? n.name.text : undefined;
}

/** `RegExp.prototype[Symbol.<m>]` → `<m>`, else undefined. */
function protoSymbolAccessMember(raw: ts.Expression): string | undefined {
  const n = unwrap(raw);
  if (!ts.isElementAccessExpression(n) || !isRegExpPrototype(n.expression)) return undefined;
  return regExpSymbolKey(n.argumentExpression);
}

/**
 * The member name `node` writes onto `RegExp.prototype`, or undefined when
 * `node` is not such a write.
 */
function writtenRegExpProtoSymbol(node: ts.Node): string | undefined {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return protoSymbolAccessMember(node.left);
  }
  if (ts.isDeleteExpression(node)) return protoSymbolAccessMember(node.expression);
  if (ts.isCallExpression(node) && node.arguments.length >= 2) {
    const callee = unwrap(node.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "defineProperty") return undefined;
    const owner = unwrap(callee.expression);
    if (!ts.isIdentifier(owner) || (owner.text !== "Object" && owner.text !== "Reflect")) return undefined;
    if (!isRegExpPrototype(node.arguments[0]!)) return undefined;
    return regExpSymbolKey(node.arguments[1]!);
  }
  return undefined;
}

/** Pre-scan predicate (array-holes.ts): is `node` such a write? */
export function isRegExpProtoSymbolWrite(node: ts.Node): boolean {
  return writtenRegExpProtoSymbol(node) !== undefined;
}

const writtenBySourceFile = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/**
 * Does the file containing `anchor` replace `RegExp.prototype[Symbol.<member>]`?
 * Whole-file, computed once per source file.
 */
export function sourceWritesRegExpProtoSymbol(anchor: ts.Node, member: string): boolean {
  const sf = anchor.getSourceFile();
  if (!sf) return false;
  let written = writtenBySourceFile.get(sf);
  if (written === undefined) {
    const found = new Set<string>();
    const visit = (node: ts.Node): void => {
      const m = writtenRegExpProtoSymbol(node);
      if (m !== undefined) found.add(m);
      ts.forEachChild(node, visit);
    };
    visit(sf);
    written = found;
    writtenBySourceFile.set(sf, written);
  }
  return written.has(member);
}
