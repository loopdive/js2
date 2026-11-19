// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Prepared-path first gap → mechanism, and mechanism → slice / issue.
 *
 * A gap's detail names what refused (`unknown class "RegExp"`, `module binding
 * o has no exact typed storage`), not the mechanism that removes it. The rules
 * below sort it by mechanism: a built-in name goes to the built-in globals, a
 * local one to function values; a script-var home gap goes by the kind of the
 * binding's initialiser, read from the test source (`initialiserKind`).
 * Slices are the #7354 ladder (H, T, X, Str, Fa, O, Fb, C, B, M).
 */

const BUILTIN = new Set(
  (
    "Object Function String Number Boolean Array Math JSON RegExp Date Error TypeError RangeError SyntaxError " +
    "ReferenceError EvalError URIError parseInt parseFloat isNaN isFinite encodeURI encodeURIComponent decodeURI " +
    "decodeURIComponent escape unescape NaN Infinity undefined globalThis Symbol eval"
  ).split(" "),
);

/** slice / issue per mechanism; the mechanism label is the key. */
export const MECHANISMS = {
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
  "script-var home: no initialiser": "H follow-up · no issue yet",
  "script-var home: other": "H follow-up · no issue yet",
  "array literals": "O · #7352",
  "member get / set on a dynamic value": "O · #7352",
  "function expression or closure as a value": "Fa · #7349",
  "function declaration read as a value": "Fa · #7349",
  "call through a value": "Fb · #7349",
  "new on a plain function, this, instanceof": "C · #7349",
  "built-in global as a value": "B · #7350",
  "built-in constructor (new X)": "B · #7350",
  "built-in call or method": "B · #7350",
  "native intrinsic provider missing": "B · #7350",
  typeof: "T",
  "dynamic operators (+, compare, update)": "Str / T follow-up · no issue yet",
  "var nested in top-level code": "no issue yet",
  "assignment to an undeclared global": "no issue yet",
  "function declaration in a block": "no issue yet",
  "async test": "out of scope of the stand-in",
  "direct call into a refused callee": "cascade (callee's own gap)",
  eval: "#3630",
  with: "no issue yet",
  delete: "no issue yet",
  "RegExp methods": "B · #7350",
  "parameter carriers": "#7353",
  "compile crash": "invariant (file per message)",
  other: "",
};

function initialiserKind(name, text) {
  const escaped = name.replace(/\$/g, "\\$");
  const init = new RegExp(`\\b(?:var|let|const)\\s+${escaped}\\s*=\\s*([^;\\n]{0,40})`).exec(text)?.[1]?.trim() ?? "";
  if (init.startsWith("{")) return "object literal";
  if (init.startsWith("[")) return "array literal";
  if (/^function\b|^\(?[\w$,\s]*\)?\s*=>/.test(init)) return "function expression";
  if (init.startsWith("new ")) return "new expression";
  if (/^[\w$.]+\s*\(/.test(init)) return "call result";
  if (/^[\w$]+(?:\.[\w$]+|\[)/.test(init)) return "member read";
  if (/^\(\s*function\b/.test(init)) return "IIFE result";
  if (/^[-+]?(?:\d|\.\d)|^(?:true|false|null)\b/.test(init)) return "primitive literal";
  if (init.startsWith("/")) return "RegExp literal";
  if (/^["']/.test(init)) return "string";
  if (init === "") return "no initialiser";
  return "other";
}

const quoted = (detail) => /"([^"]+)"|'([^']+)'/.exec(detail)?.slice(1).find(Boolean) ?? "";

/** Mechanism of one prepared-census row's first gap; `text` is the test source with its includes. */
export function mechanismOf(row, text) {
  const d = row.detail ?? "";
  if (row.status === "crash") return "compile crash";
  if (/\beval\b/.test(d)) return "eval";
  if (/WithStatement|\bwith target/.test(d)) return "with";
  if (/\bdelete\b/.test(d)) return "delete";
  if (/\.(?:exec|test)\b.*capability-deferred|regexp/i.test(d)) return "RegExp methods";
  const binding =
    /module binding ([\w$]+) has no exact typed storage|proven dynamic binding '([\w$]+)' initializer/.exec(d);
  if (binding) return `script-var home: ${initialiserKind(binding[1] ?? binding[2], text)}`;
  if (/unknown class/.test(d))
    return BUILTIN.has(quoted(d)) ? "built-in constructor (new X)" : "new on a plain function, this, instanceof";
  if (/is not in scope/.test(d))
    return BUILTIN.has(quoted(d)) ? "built-in global as a value" : "function declaration read as a value";
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
  if (/dyn\.typeof/.test(d)) return "typeof";
  if (/operands not provably|matching operand types|__ir_dyn_add|prefix update|PostfixUnary|undefined-compare/.test(d))
    return "dynamic operators (+, compare, update)";
  if (/nested var declaration/.test(d)) return "var nested in top-level code";
  if (/undeclared identifier/.test(d)) return "assignment to an undeclared global";
  if (/unsupported body statement FunctionDeclaration/.test(d)) return "function declaration in a block";
  if (/provider unavailable/.test(d)) return "built-in call or method";
  if (/host provider or async demand/.test(d)) return "async test";
  if (/param/.test(d)) return "parameter carriers";
  return "other";
}
