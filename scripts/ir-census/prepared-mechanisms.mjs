// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Prepared-path first gap → mechanism, and mechanism → slice / issue.
 *
 * A gap's detail names what refused (`unknown class "RegExp"`, `module binding
 * o has no exact typed storage`), not the mechanism that removes it. The rules
 * below sort it by mechanism: a built-in name goes to the built-in globals, a
 * local one by what the source declares under that name (`outOfScopeName`); a
 * script-var home gap goes by the kind of the binding's initialiser
 * (`initialiserKind`), a nested-var gap by the construct that holds the `var`
 * (`nestedVarKind`). All three read the test source, with its includes.
 * Slices are the #7354 ladder (H, T, X, Str, Fa, O, Fb, C, B, M).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const TEST262 = resolve(import.meta.dirname, "../../test262");

const BUILTIN = new Set(
  (
    "Object Function String Number Boolean Array Math JSON RegExp Date Error TypeError RangeError SyntaxError " +
    "ReferenceError EvalError URIError parseInt parseFloat isNaN isFinite encodeURI encodeURIComponent decodeURI " +
    "decodeURIComponent escape unescape NaN Infinity undefined globalThis Symbol eval Intl ArrayBuffer"
  ).split(" "),
);

/** slice / issue per mechanism; the mechanism label is the key. */
export const MECHANISMS = {
  "Object static not admitted": "#7368",
  "compound assignment with a non-numeric RHS": "#7375",
  "boxing a native call result": "Fb follow-up · #7349",
  "ToPrimitive of an object": "O2 · #7354 slice O",
  "function value in + or ToString": "integration alarm: Fa × Str2 / Ty per-kind tables",
  "script-var home: repeated var": "S10 · #7372 slice 1b",
  "script-var home: object literal": "O · #7352",
  "script-var home: array literal": "O · #7352",
  "script-var home: function expression": "Fa · #7349",
  "script-var home: new expression": "C / B · #7349, #7350",
  "script-var home: call result": "Fb / B · #7349, #7350",
  "script-var home: member read": "O · #7352",
  "script-var home: RegExp literal": "B · #7350",
  "script-var home: string": "H / Str follow-up · no issue yet",
  "script-var home: IIFE result": "Fb · #7349",
  "script-var home: primitive literal": "H follow-up · no issue yet",
  "script-var home: no initialiser":
    "O · #7352 (19, `var arg; Object.defineProperty(arg, …)`) / #7372 (4: non-writable global names 3, a `var` read through `this[…]` 1)",
  "script-var home: other": "H follow-up · no issue yet",
  "array literals": "O · #7352",
  "member get / set on a dynamic value": "O · #7352",
  "function expression or closure as a value": "Fa · #7349",
  "function declaration read as a value": "Fa · #7349",
  "arguments object": "C · #7354 (`arguments` subsection)",
  "read of an undeclared name": "#7372 slice 3 (needs ReferenceError #7350 + catch X to pass)",
  "call through a value": "Fb · #7349",
  "new on a plain function, this, instanceof": "C · #7349",
  "built-in global as a value": "B · #7350",
  "built-in constructor (new X)": "B · #7350",
  "built-in call or method": "B · #7350",
  "native intrinsic provider missing": "B · #7350",
  typeof: "T",
  "dynamic operators (+, compare, update)": "Str2 (`__ir_dyn_add`) · #7354",
  "for-in head var": "O follow-up · #7352 follow-up, plus a for-in runtime",
  "var in a with body": "deferred · no issue",
  "var nested in top-level code": "no issue yet",
  "assignment to an undeclared global": "S10 · #7372 slice 3",
  "function declaration in a block": "S10 · #7372 slice 2",
  "async test": "out of scope of the stand-in",
  "direct call into a refused callee": "cascade (callee's own gap)",
  eval: "#7363 (slices 2+)",
  with: "deferred · no issue",
  delete: "O / C / S10 · by operand: #7352 (member), #7349 / #7350 (`this.x`), #7372 slices 3/4 (a name, `arguments`)",
  "RegExp constructor, global and methods": "B · #7369",
  "parameter carriers": "#7353",
  "crash: RegExp capability-deferred": "#7364 (refusal), #7369 (RegExp)",
  "crash: eval owning predicate": "#7363 slice 1",
  "crash: Object static not admitted": "#7364 (refusal), #7368",
  "crash: other": "#7364",
  other: "",
};

/** The source of a test262 file with the harness files it includes: the text the rules below read. */
export function sourceWithIncludes(file) {
  const text = readFileSync(join(TEST262, "test", file), "utf8");
  const includes =
    /includes:\s*\[([^\]]*)\]/
      .exec(text)?.[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  return [text, ...includes.map((name) => readFileSync(join(TEST262, "harness", name), "utf8"))].join("\n");
}

const escaped = (name) => name.replace(/\$/g, "\\$");

/** `text` without comments and string literals: an assertion message quotes its source (`'#1: var x = 1; …'`). */
const codeOf = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "");

/**
 * A script `var` declared more than once (`var x = +0; … var x = -0;`), also as a later name of a declaration
 * list. An earlier declarator's initialiser ends at a bracket, so a comma inside it (`var o = f({}, x)`) is not
 * read as the list's separator.
 */
function declaredTwice(name, text) {
  const declaration = new RegExp(String.raw`\bvar\s+(?:[\w$]+\s*(?:=[^,;([{]*)?,\s*)*${escaped(name)}\b`, "g");
  return (codeOf(text).match(declaration)?.length ?? 0) > 1;
}

function initialiserKind(name, text) {
  const init =
    new RegExp(`\\b(?:var|let|const)\\s+${escaped(name)}\\s*=\\s*([^;\\n]{0,40})`).exec(text)?.[1]?.trim() ?? "";
  if (init.startsWith("{")) return "object literal";
  if (init.startsWith("[")) return "array literal";
  if (/^function\b|^\(?[\w$,\s]*\)?\s*=>/.test(init)) return "function expression";
  if (init.startsWith("new ")) return "new expression";
  if (/^[\w$.]+\s*\(/.test(init)) return "call result";
  if (/^[-+]?(?:\d|\.\d)|^(?:true|false|null)\b/.test(init)) return "primitive literal";
  if (/^[\w$]+(?:\.[\w$]+|\[)/.test(init)) return "member read";
  if (/^\(\s*function\b/.test(init)) return "IIFE result";
  if (init.startsWith("/")) return "RegExp literal";
  if (/^["']/.test(init)) return "string";
  if (init === "") return "no initialiser";
  return "other";
}

/**
 * The construct that holds the unmodelled `var` of a "nested var declaration" refusal. A file with a for-in head
 * is charged to it, also when it has a `with` body too.
 */
function nestedVarKind(text) {
  const code = codeOf(text);
  if (/\bfor\s*\(\s*var\s+[\w$]+\s+in\b/.test(code)) return "for-in head var";
  if (/\bwith\s*\(/.test(code)) return "var in a with body";
  return "var nested in top-level code";
}

/** What a name that "is not in scope" is: a built-in, `arguments`, a function the source declares, or none of them. */
function outOfScopeName(name, text) {
  if (BUILTIN.has(name)) return "built-in global as a value";
  if (name === "arguments") return "arguments object";
  // `Test262Error` is the stand-in's function; every other one is declared by the test or an include.
  const declared = name === "Test262Error" || new RegExp(`\\bfunction\\s+${escaped(name)}\\b`).test(codeOf(text));
  return declared ? "function declaration read as a value" : "read of an undeclared name";
}

const quoted = (detail) => /"([^"]+)"|'([^']+)'/.exec(detail)?.slice(1).find(Boolean) ?? "";

/** Mechanism of one prepared-census row's first gap; `text` is the row's `sourceWithIncludes`. */
export function mechanismOf(row, text) {
  const d = row.detail ?? "";
  if (row.status === "crash") {
    if (/capability-deferred/.test(d)) return "crash: RegExp capability-deferred";
    if (/owning predicate/.test(d)) return "crash: eval owning predicate";
    if (/not an admitted Object static/.test(d)) return "crash: Object static not admitted";
    return "crash: other";
  }
  if (/\beval\b/.test(d)) return "eval";
  if (/WithStatement|\bwith target/.test(d)) return "with";
  if (/\bdelete\b/.test(d)) return "delete";
  if (/\.(?:exec|test)\b.*capability-deferred|"RegExp"|RegExp literal has no provider/.test(d))
    return "RegExp constructor, global and methods";
  if (/not an admitted Object static/.test(d)) return "Object static not admitted";
  if (/compound assign RHS has no numeric carrier/.test(d)) return "compound assignment with a non-numeric RHS";
  if (/dyn\.arguments_length/.test(d)) return "arguments object";
  if (/box of a native call result/.test(d)) return "boxing a native call result";
  if (/ToPrimitive of an object/.test(d)) return "ToPrimitive of an object";
  if (/dyn\.current_this/.test(d)) return "new on a plain function, this, instanceof";
  if (/(?:\+|ToString) of a function value/.test(d)) return "function value in + or ToString";
  const binding =
    /module binding ([\w$]+) has no exact typed storage|proven dynamic binding '([\w$]+)' initializer/.exec(d);
  if (binding) {
    const name = binding[1] ?? binding[2];
    return `script-var home: ${declaredTwice(name, text) ? "repeated var" : initialiserKind(name, text)}`;
  }
  if (/unknown class/.test(d))
    return BUILTIN.has(quoted(d)) ? "built-in constructor (new X)" : "new on a plain function, this, instanceof";
  if (/is not in scope/.test(d)) return outOfScopeName(quoted(d), text);
  if (/direct call to "/.test(d))
    return BUILTIN.has(quoted(d)) ? "built-in call or method" : "direct call into a refused callee";
  if (/__ir_dyn_call_value|__ir_dyn_method_call|only direct calls supported|non-constructible callable/.test(d))
    return "call through a value";
  if (/closure|nested func|function declarations are required/.test(d))
    return "function expression or closure as a value";
  if (/\bthis'? reference|class-constructor|instanceof|only direct constructor names/.test(d))
    return "new on a plain function, this, instanceof";
  if (/array literal|empty array|\bvec\b/.test(d)) return "array literals";
  if (/dyn\.member_(?:get|set)|property-write/.test(d)) return "member get / set on a dynamic value";
  if (/method call \.|not in IR whitelist/.test(d)) return "built-in call or method";
  if (/physical setup cannot be materialized|intrinsic callable/.test(d)) return "native intrinsic provider missing";
  if (/dyn\.typeof|typeof test for function/.test(d)) return "typeof";
  if (/operands not provably|matching operand types|__ir_dyn_add|prefix update|PostfixUnary|undefined-compare/.test(d))
    return "dynamic operators (+, compare, update)";
  if (/nested var declaration/.test(d)) return nestedVarKind(text);
  if (/undeclared identifier/.test(d)) return "assignment to an undeclared global";
  if (/unsupported body statement FunctionDeclaration/.test(d)) return "function declaration in a block";
  if (/provider unavailable/.test(d)) return "built-in call or method";
  if (/host provider or async demand/.test(d)) return "async test";
  if (/param/.test(d)) return "parameter carriers";
  return "other";
}
