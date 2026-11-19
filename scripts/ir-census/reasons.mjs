// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Reason labels for the ES5 IR-only census (see census.mts).
 *
 * A blocked file's reasons are the set of labels of its legacy units:
 * - a harness function unit counts once per harness file (`harness:assert.js`);
 * - a `<module-init>` unit contributes one label per refused statement (its
 *   detail lists them, `code@arm:Kind «text» | …`, under
 *   `JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`);
 * - any other unit contributes the label of its first refusal;
 * - a unit that failed after the claim (stage past `select`) is
 *   `post-claim(<stage>)`.
 *
 * A label is the selector arm, refined where the arm alone hides the lever:
 * the identifier for `expr-ident-not-in-scope` and `expr-new-ctor-unknown`,
 * the callee for `external-call`, the method for `expr-module-scalar-method`,
 * the initialiser shape for `vardecl-module-storage-unrepresentable`, and
 * `[IIFE]` / `[other]` for a non-identifier callee.
 */

const ARM = /^(?:[\w-]+@)?([^\s:«]+(?:\([^)]*\))?(?:\[[^\]]*\])?):([A-Z]\w*)(?: «(.*?)»?)?$/s;
const NAMED = new Set(["expr-ident-not-in-scope", "expr-new-ctor-unknown"]);
const NONIDENT_CALLEE = /expr-call-callee-nonident\)?$/;

function storageShape(text) {
  const init = text.replace(/^[\w$]+\s*=\s*/, "").trim();
  if (init === "[]") return "empty-array";
  if (init === "{}") return "empty-object";
  if (init.startsWith("{")) return "object-literal";
  if (init.startsWith("[")) return "array-literal";
  if (init.startsWith("new ")) return "new";
  if (/^function\b/.test(init)) return "function";
  if (/^[\w$.]+\(/.test(init)) return "call";
  return "other";
}

function armLabel(arm, kind, text = "") {
  const base = arm.replace(/\(([A-Za-z_$][\w$]*)\)$/, "");
  if (NAMED.has(base)) return `${base}(${text.replace(/^new\s+/, "").split(/[\s(.]/)[0]})`;
  if (base === "expr-module-scalar-method") return `${base}(.${/\.([\w$]+)\s*\(/.exec(text)?.[1] ?? "?"})`;
  if (base === "vardecl-module-storage-unrepresentable") return `${base}[${storageShape(text)}]`;
  if (NONIDENT_CALLEE.test(base)) {
    const iife = /^\(?\s*(?:function\b|\()/.test(text) && kind !== "CallExpression";
    return `${base}[${iife ? "IIFE" : "other"}]`;
  }
  return base;
}

/** Label of one refusal text (a function unit's detail, or one `|` part of a module-init detail). */
export function refusalLabel(part, code) {
  const text = part.trim();
  const callee = /^callee:([\w$.]+)/.exec(text);
  if (callee) return `${code ?? "external-call"}(${callee[1]})`;
  const arm = ARM.exec(text);
  if (arm) return armLabel(arm[1], arm[2], arm[3]);
  if (/rejected by IR selection \(([\w-]+)\)/.test(text)) return /\(([\w-]+)\)\s*$/.exec(text)[1];
  if (code === "late-preparation-unsupported")
    return `late-preparation(${text
      .replace(/[«'"`].*$/s, "")
      .slice(0, 60)
      .trim()})`;
  return code ?? (text.slice(0, 60) || "no-detail");
}

/** The set of reason labels of one compiled, blocked census row. */
export function fileReasons(row) {
  const reasons = new Set();
  for (const unit of row.legacy) {
    if (unit.origin.startsWith("harness:")) reasons.add(unit.origin);
    else if (unit.stage !== "select") reasons.add(`post-claim(${unit.stage})`);
    else if (unit.kind === "module-init") {
      for (const part of (unit.detail ?? "").split(" | ")) reasons.add(refusalLabel(part, unit.code));
    } else reasons.add(refusalLabel(unit.detail ?? "", unit.code));
  }
  return reasons;
}
