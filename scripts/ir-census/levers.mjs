// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Census reason label → the lever (mechanism, and its issue) that removes it.
 *
 * The first lever whose `match` accepts a label owns it, so order matters
 * where patterns overlap (a named harness function before the built-in
 * globals, `new Object` before the other constructors). `issue` is
 * "no issue yet" when no open issue owns the mechanism (checked 2026-11-19).
 */

const BUILTINS =
  "Object|Function|String|Number|Boolean|Array|Math|JSON|RegExp|Date|Error|TypeError|RangeError|SyntaxError|" +
  "ReferenceError|EvalError|URIError|parseInt|parseFloat|isNaN|isFinite|encodeURI|encodeURIComponent|decodeURI|" +
  "decodeURIComponent|escape|unescape|NaN|Infinity|undefined|globalThis|Symbol";
const named = (names) =>
  new RegExp(`^(?:expr-ident-not-in-scope|external-call|expr-new-ctor-unknown)\\((?:${names})\\)$`);

const ASSERT_JS = "assert|Test262Error|compareArray|\\$ERROR|\\$DONOTEVALUATE|\\$DONE";
const PROPERTY_HELPER =
  "verifyProperty|verifyEqualTo|verifyWritable|verifyNotWritable|verifyEnumerable|verifyNotEnumerable|" +
  "verifyConfigurable|verifyNotConfigurable|verifyCallableProperty|verifyAccessorProperty|isWritable|" +
  "isConfigurable|isEnumerable|isSameValue|verifyPrimordialProperty|verifyPrimordialCallableProperty|" +
  "verifyPrimordialAccessorProperty";

/** @type {{ id: string, issue: string, match: RegExp }[]} */
export const LEVERS = [
  {
    id: "harness-assert-sta",
    issue: "#7106",
    match: new RegExp(`^harness:(?:assert|sta)\\.js$|${named(ASSERT_JS).source}`),
  },
  {
    id: "harness-propertyHelper",
    issue: "#7342",
    match: new RegExp(`^harness:propertyHelper\\.js$|${named(PROPERTY_HELPER).source}`),
  },
  { id: "harness-other", issue: "no issue yet", match: /^harness:/ },
  {
    id: "dynamic-code",
    issue: "#3630 (eval); `with`: no issue yet",
    match:
      /^(?:expr-global-eval-statement|with-|fn-runtime-eval-boundary|late-preparation|external-call\((?:eval|Function)\)|expr-ident-not-in-scope\(eval\)|expr-new-ctor-unknown\(Function\))/,
  },
  { id: "new-Object", issue: "#7341", match: /^expr-new-ctor-unknown\(Object\)$/ },
  {
    id: "wrappers",
    issue: "#7340",
    match: /^(?:expr-new-wrapper-|expr-new-ctor-unknown\((?:String|Number|Boolean)\)$)/,
  },
  { id: "object-statics", issue: "#7338", match: /^expr-object-static-/ },
  {
    id: "own-property",
    issue: "#7339",
    match: /^expr-module-scalar-method\(\.(?:hasOwnProperty|propertyIsEnumerable)\)$/,
  },
  { id: "builtin-globals", issue: "#7350", match: named(BUILTINS) },
  {
    id: "function-values",
    issue: "#7349",
    match:
      /^(?:vardecl-let-closure|expr-call-callee-nonident|body-exprstmt-other\(expr-(?:call|new)-callee-nonident\)|body-exprstmt-other\(expr-local-call-target\)|expr-local-call-target|expr-new-module-binding-callee|closure-|expr-new-callee-nonident|expr-new-ctor-unknown\()/,
  },
  { id: "literals", issue: "#7352", match: /^(?:vardecl-module-storage-unrepresentable|objectlit-)/ },
  {
    id: "param-carriers",
    issue: "#7353",
    match:
      /^(?:param-dynamic-carrier-diverges-from-legacy|param-type-unresolved|move-only\[|expr-logical-value-family|return-type-unresolved)/,
  },
  { id: "call-graph", issue: "#7333", match: /^call-graph-closure$/ },
  {
    id: "storage-agreement",
    issue: "#7348 (parked)",
    match:
      /^(?:expr-module-extern-|forin-receiver-not-dynamic-externref|forin-head-module-var|compound-dynamic-module-operand|vardecl-module-value-flow|throw-module-scalar-unboxed|condition-module-value-nonbool|expr-module-value-|vardecl-module-binding-alias|vardecl-redeclared-write)/,
  },
  { id: "regexp", issue: "no issue yet", match: /^expr-(?:regexp-|new-regexp-)/ },
  { id: "delete", issue: "no issue yet", match: /^(?:body-exprstmt-other\()?expr-delete-no-ir-lowering\)?$/ },
  { id: "post-claim", issue: "no issue yet", match: /^post-claim\(/ },
];

const cache = new Map();

/** The lever that owns a reason label, or undefined. */
export function leverOf(reason) {
  if (!cache.has(reason))
    cache.set(
      reason,
      LEVERS.find((lever) => lever.match.test(reason)),
    );
  return cache.get(reason);
}
