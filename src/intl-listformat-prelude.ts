// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6839 — Wasm-native `Intl.ListFormat` for the host-free targets, as a source
 * prelude.
 *
 * `Intl.ListFormat` used to register as an extern class on every target, so a
 * `--target standalone` binary that merely CONTAINED `new Intl.ListFormat(..)`
 * (prettier's doc-printer error path) kept `env.Intl_ListFormat_new` /
 * `_format` imports and could not be instantiated host-free (#2961).
 *
 * Unlike `Intl.DateTimeFormat` (#5355 — calendar + tzdata, refused), list
 * formatting needs four separators per (type, style), so the data is carried:
 * the CLDR `en` list patterns, measured against Node's ICU, for the available
 * locales `en` and `en-US` (default `en-US`). Every other locale resolves to the
 * default through ECMA-402 `ResolveLocale` — the documented bound of this
 * shim, not an error.
 *
 * Mechanism (mirrors #3146 `iterator-statics-prelude.ts`): the class is
 * ordinary JavaScript, inserted after the directive prologue of any file that
 * references `Intl.ListFormat` on the GLOBAL `Intl`, and every such access is
 * rewritten to the prelude binding. The text is valid both as JS (prettier's
 * `.mjs`) and as TS (declared fields, untyped parameters), so no grammar
 * override is needed. A file that declares its own top-level `Intl` is left
 * alone. The caller gates on the host-free targets; JS-host mode keeps the
 * ICU-backed host object.
 */
import { PositionMap, type CompilerSourceOriginSpan } from "./position-map.js";
import { ts } from "./ts-api.js";

/** The binding every `Intl.ListFormat` access is rewritten to. */
const LIST_FORMAT_BINDING = "__js2wasm_Intl_ListFormat";

export interface IntlListFormatPreludeResult {
  /** Transformed source (prelude inserted + accesses rewritten), or the input unchanged. */
  source: string;
  /** Output→input position map (identity when nothing was injected). */
  positionMap: PositionMap;
  /** True when the prelude was injected. */
  injected: boolean;
}

function declaresTopLevelIntl(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === "Intl") return true;
      }
    } else if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isModuleDeclaration(stmt)) &&
      stmt.name !== undefined &&
      ts.isIdentifier(stmt.name) &&
      stmt.name.text === "Intl"
    ) {
      return true;
    }
  }
  return false;
}

/** `Intl.ListFormat` spans whose receiver is the bare `Intl` identifier. */
function findListFormatAccesses(sf: ts.SourceFile): { start: number; end: number }[] {
  if (declaresTopLevelIntl(sf)) return [];
  const spans: { start: number; end: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "ListFormat" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Intl"
    ) {
      spans.push({ start: node.getStart(sf), end: node.end });
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return spans;
}

/** Offset just past the leading directive prologue (`"use strict";`, …). */
function directivePrologueEnd(sf: ts.SourceFile): number {
  let end = 0;
  for (const stmt of sf.statements) {
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
      end = stmt.end;
      continue;
    }
    break;
  }
  return end;
}

function preludeOrigins(prelude: string): CompilerSourceOriginSpan[] {
  const sf = ts.createSourceFile("__intl_listformat_prelude__.ts", prelude, ts.ScriptTarget.Latest, true);
  const origins: CompilerSourceOriginSpan[] = [];
  for (const statement of sf.statements) {
    origins.push({
      start: statement.getStart(sf),
      end: statement.end,
      origin: {
        producer: "intl-listformat-prelude",
        role: ts.isClassDeclaration(statement) ? "list-format-class" : "list-format-support",
      },
    });
  }
  return origins;
}

/** The host-free environments the prelude serves; JS-host keeps the ICU host object. */
function servesEnvironment(environment: string): boolean {
  return environment === "none" || environment === "wasi";
}

/**
 * Single-source entry: inject for a host-free `environment`, identity
 * otherwise. The file name defaults like `compileSourceSync`'s own
 * (`allowJs` ⇒ a JS unit).
 */
export function applyIntlListFormatPrelude(
  environment: string,
  source: string,
  options: { readonly fileName?: string; readonly allowJs?: boolean },
): IntlListFormatPreludeResult {
  if (!servesEnvironment(environment)) return { source, positionMap: PositionMap.identity(), injected: false };
  return injectIntlListFormatPrelude(source, options.fileName ?? (options.allowJs === true ? "input.js" : "input.ts"));
}

/** Multi-file entry: inject per file (keyed by file name) for a host-free `environment`. */
export function applyIntlListFormatPreludeToFiles(
  environment: string,
  files: Record<string, string>,
): Record<string, string> {
  if (!servesEnvironment(environment)) return files;
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, injectIntlListFormatPrelude(v, k).source]));
}

/**
 * Inject the standalone `Intl.ListFormat` prelude when `source` references
 * `Intl.ListFormat`. Byte-neutral (identity map, unchanged source) otherwise.
 * `fileName` selects the script kind (a TS file also gets the intrinsic
 * declarations).
 */
function injectIntlListFormatPrelude(source: string, fileName: string): IntlListFormatPreludeResult {
  if (!source.includes("ListFormat") || !source.includes("Intl")) {
    return { source, positionMap: PositionMap.identity(), injected: false };
  }
  const scriptKind = /\.[cm]?jsx?$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile("__intl_listformat_scan__", source, ts.ScriptTarget.Latest, true, scriptKind);
  const accesses = findListFormatAccesses(sf);
  if (accesses.length === 0) {
    return { source, positionMap: PositionMap.identity(), injected: false };
  }

  // TS-kind files need ambient signatures for the intrinsics (a JS file
  // cannot carry \`declare\`, and does not need it). The #3146 prelude, when
  // already injected ahead of this one, declares the same four.
  const declare = scriptKind === ts.ScriptKind.TS && !source.includes("declare function __j2w_iter_rec(");
  const prelude = (declare ? ITERATOR_INTRINSIC_DECLARATIONS : "") + INTL_LIST_FORMAT_PRELUDE;
  const insertAt = directivePrologueEnd(sf);
  const positionMap = new PositionMap([
    { origStart: insertAt, origEnd: insertAt, newLength: prelude.length, compilerOrigins: preludeOrigins(prelude) },
    ...accesses.map((a) => ({ origStart: a.start, origEnd: a.end, newLength: LIST_FORMAT_BINDING.length })),
  ]);

  // Replace last-first so earlier offsets stay valid, then insert the prelude.
  let body = source;
  for (const a of [...accesses].sort((x, y) => y.start - x.start)) {
    body = body.substring(0, a.start) + LIST_FORMAT_BINDING + body.substring(a.end);
  }
  body = body.substring(0, insertAt) + prelude + body.substring(insertAt);
  return { source: body, positionMap, injected: true };
}

const ITERATOR_INTRINSIC_DECLARATIONS = `
declare function __j2w_iter_rec(o: any): any;
declare function __j2w_iter_step(rec: any): number;
declare function __j2w_iter_value(): any;
declare function __j2w_iter_close(rec: any): void;
`;

/**
 * The prelude. ECMA-402 §13 (Intl.ListFormat) with §9.2 locale negotiation
 * reduced to the two available locales. Separators per (type, style) are
 * [start/middle, pair, end] — measured against Node 22 ICU 77 for `en`:
 * conjunction `and` / `&` / `,`; disjunction `or` in every style; unit `, `
 * except narrow, which joins with a bare space. Structural BCP 47 validation
 * and case canonicalisation are implemented; CLDR alias replacement is not
 * (no alias tables), which only affects the echo of an unsupported tag.
 */
const INTL_LIST_FORMAT_PRELUDE = `
// Subtag shape as a number: 0 = empty or a non-[A-Za-z0-9] unit, 1 = all
// letters, 2 = all digits, 3 = mixed alphanumerics. Inputs are coerced to a
// string and every test is a plain number comparison (the standalone-safe
// dialect: no truthiness of compound relational results on untyped values).
function __js2wasm_lf_kind(s0) {
  const s = \`\${s0}\`;
  const n = s.length;
  if (n === 0) return 0;
  let alpha = 0;
  let digit = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i) | 0;
    if (c >= 65 && c <= 90) alpha = 1;
    else if (c >= 97 && c <= 122) alpha = 1;
    else if (c >= 48 && c <= 57) digit = 1;
    else return 0;
  }
  return alpha + 2 * digit;
}
// ASCII case mapping; upper === 1 upper-cases, otherwise lower-cases.
function __js2wasm_lf_case(s0, upper) {
  const s = \`\${s0}\`;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) | 0;
    if (upper === 1 && c >= 97 && c <= 122) out += String.fromCharCode(c - 32);
    else if (upper !== 1 && c >= 65 && c <= 90) out += String.fromCharCode(c + 32);
    else out += String.fromCharCode(c);
  }
  return out;
}
// IsStructurallyValidLanguageTag (unicode_locale_id) + case canonicalisation.
// Returns "" for an invalid tag.
function __js2wasm_lf_canonTag(tag0) {
  const tag = \`\${tag0}\`;
  const parts = tag.split("-");
  const n = parts.length | 0;
  const lang = parts[0];
  const langLen = lang.length | 0;
  if (__js2wasm_lf_kind(lang) !== 1 || langLen < 2 || langLen > 8 || langLen === 4) return "";
  let out = __js2wasm_lf_case(lang, 0);
  let i = 1;
  if (i < n && (parts[i].length | 0) === 4 && __js2wasm_lf_kind(parts[i]) === 1) {
    out += "-" + __js2wasm_lf_case(parts[i].slice(0, 1), 1) + __js2wasm_lf_case(parts[i].slice(1), 0);
    i++;
  }
  if (i < n) {
    const len = parts[i].length | 0;
    const kind = __js2wasm_lf_kind(parts[i]);
    if ((len === 2 && kind === 1) || (len === 3 && kind === 2)) {
      out += "-" + __js2wasm_lf_case(parts[i], 1);
      i++;
    }
  }
  let variants = "-";
  while (i < n) {
    const p = parts[i];
    const len = p.length | 0;
    const kind = __js2wasm_lf_kind(p);
    let variant = 0;
    if (kind !== 0 && len >= 5 && len <= 8) variant = 1;
    if (kind !== 0 && len === 4 && __js2wasm_lf_kind(p.slice(0, 1)) === 2) variant = 1;
    if (variant === 0) break;
    const v = __js2wasm_lf_case(p, 0);
    if (variants.indexOf("-" + v + "-") >= 0) return "";
    variants += v + "-";
    out += "-" + v;
    i++;
  }
  let singletons = "";
  while (i < n) {
    const p = parts[i];
    if ((p.length | 0) !== 1 || __js2wasm_lf_kind(p) === 0) return "";
    const single = __js2wasm_lf_case(p, 0);
    if (single === "x") break;
    if (singletons.indexOf(single) >= 0) return "";
    singletons += single;
    out += "-" + single;
    i++;
    const first = i;
    while (i < n && (parts[i].length | 0) >= 2 && (parts[i].length | 0) <= 8 && __js2wasm_lf_kind(parts[i]) !== 0) {
      out += "-" + __js2wasm_lf_case(parts[i], 0);
      i++;
    }
    if (i === first) return "";
  }
  if (i < n) {
    out += "-x";
    i++;
    const first = i;
    while (i < n && (parts[i].length | 0) >= 1 && (parts[i].length | 0) <= 8 && __js2wasm_lf_kind(parts[i]) !== 0) {
      out += "-" + __js2wasm_lf_case(parts[i], 0);
      i++;
    }
    if (i === first) return "";
  }
  if (i !== n) return "";
  return out;
}
function __js2wasm_lf_addTag(list, value) {
  const tag = \`\${value}\`;
  const canon = __js2wasm_lf_canonTag(tag);
  if (canon === "") throw new RangeError("Incorrect locale information provided: " + tag);
  if (list.indexOf(canon) < 0) list.push(canon);
}
// CanonicalizeLocaleList (ECMA-402 9.2.1).
function __js2wasm_lf_localeList(locales) {
  const list = new Array();
  if (locales === undefined) return list;
  if (typeof locales === "string") {
    __js2wasm_lf_addTag(list, locales);
    return list;
  }
  if (locales === null) throw new TypeError("Cannot convert null to object");
  let len = +locales.length;
  if (!(len > 0)) len = 0;
  len = Math.floor(len);
  for (let k = 0; k < len; k++) {
    if (k in Object(locales)) {
      const v = locales[k];
      if (typeof v !== "string" && (typeof v !== "object" || v === null)) {
        throw new TypeError("Language ID should be string or object.");
      }
      __js2wasm_lf_addTag(list, v);
    }
  }
  return list;
}
// BestAvailableLocale over { en, en-US } after RemoveUnicodeExtensions;
// "" when nothing matches.
function __js2wasm_lf_bestAvailable(tag0) {
  const tag = \`\${tag0}\`;
  const parts = tag.split("-");
  const n = parts.length | 0;
  let candidate = parts[0];
  let inU = 0;
  for (let i = 1; i < n; i++) {
    const p = parts[i];
    if (p === "x") {
      for (let j = i; j < n; j++) candidate += "-" + parts[j];
      break;
    }
    if ((p.length | 0) === 1) inU = p === "u" ? 1 : 0;
    if (inU === 0) candidate += "-" + p;
  }
  while (candidate !== "en" && candidate !== "en-US") {
    let pos = candidate.lastIndexOf("-") | 0;
    if (pos < 0) return "";
    if (pos >= 2 && candidate.charAt(pos - 2) === "-") pos -= 2;
    candidate = candidate.slice(0, pos);
  }
  return candidate;
}
function __js2wasm_lf_option(options, prop, a, b, c, fallback) {
  const v = options[prop];
  if (v === undefined) return fallback;
  const s = \`\${v}\`;
  if (s === a || s === b || s === c) return s;
  throw new RangeError("Value " + s + " out of range for Intl.ListFormat options property " + prop);
}
function __js2wasm_lf_isObject(v) {
  if (typeof v === "function") return 1;
  return typeof v === "object" && v !== null ? 1 : 0;
}
// StringListFromIterable (ECMA-402 13.5.3) over the native iterator runtime
// (the #3146 \`__j2w_iter_*\` intrinsics: full GetIterator ladder, IteratorClose).
// A non-string value closes the iterator; the TypeError wins over any error
// thrown while closing (IteratorClose with a throw completion).
function __js2wasm_lf_strings(list) {
  const out = new Array();
  if (list === undefined) return out;
  const rec = __j2w_iter_rec(list);
  while (__j2w_iter_step(rec) === 0) {
    const v = __j2w_iter_value();
    if (typeof v !== "string") {
      const err = new TypeError("Iterable yielded " + typeof v + " which is not a string");
      try {
        __j2w_iter_close(rec);
      } catch (ignored) {}
      throw err;
    }
    out.push(v);
  }
  return out;
}
function __js2wasm_lf_part(type, value) {
  return { type: type, value: value };
}
class ${LIST_FORMAT_BINDING} {
  _locale = "en-US";
  _type = "conjunction";
  _style = "long";
  _middle = ", ";
  _pair = " and ";
  _end = ", and ";
  constructor(locales, options) {
    const requested = __js2wasm_lf_localeList(locales);
    let type = "conjunction";
    let style = "long";
    if (options !== undefined) {
      if (__js2wasm_lf_isObject(options) === 0) throw new TypeError("Options must be an object");
      __js2wasm_lf_option(options, "localeMatcher", "lookup", "best fit", "best fit", "best fit");
      type = __js2wasm_lf_option(options, "type", "conjunction", "disjunction", "unit", "conjunction");
      style = __js2wasm_lf_option(options, "style", "long", "short", "narrow", "long");
    }
    let locale = "en-US";
    for (let i = 0; i < requested.length; i++) {
      const found = __js2wasm_lf_bestAvailable(requested[i]);
      if (found !== "") {
        locale = found;
        break;
      }
    }
    this._locale = locale;
    this._type = type;
    this._style = style;
    this._middle = type === "unit" && style === "narrow" ? " " : ", ";
    if (type === "disjunction") {
      this._pair = " or ";
      this._end = ", or ";
    } else if (type === "unit") {
      this._pair = this._middle;
      this._end = this._middle;
    } else if (style === "long") {
      this._pair = " and ";
      this._end = ", and ";
    } else if (style === "short") {
      this._pair = " & ";
      this._end = ", & ";
    } else {
      this._pair = ", ";
      this._end = ", ";
    }
  }
  format(list) {
    if (!(this instanceof ${LIST_FORMAT_BINDING})) {
      throw new TypeError("Method Intl.ListFormat.prototype.format called on incompatible receiver");
    }
    const xs = __js2wasm_lf_strings(list);
    const n = xs.length | 0;
    if (n === 0) return "";
    let out = \`\${xs[0]}\`;
    for (let i = 1; i < n; i++) {
      const sep = n === 2 ? this._pair : i === n - 1 ? this._end : this._middle;
      out = \`\${out}\${sep}\${xs[i]}\`;
    }
    return out;
  }
  formatToParts(list) {
    if (!(this instanceof ${LIST_FORMAT_BINDING})) {
      throw new TypeError("Method Intl.ListFormat.prototype.formatToParts called on incompatible receiver");
    }
    const xs = __js2wasm_lf_strings(list);
    const n = xs.length | 0;
    const parts = new Array();
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const sep = n === 2 ? this._pair : i === n - 1 ? this._end : this._middle;
        parts.push(__js2wasm_lf_part("literal", sep));
      }
      parts.push(__js2wasm_lf_part("element", xs[i]));
    }
    return parts;
  }
  resolvedOptions() {
    if (!(this instanceof ${LIST_FORMAT_BINDING})) {
      throw new TypeError("Method Intl.ListFormat.prototype.resolvedOptions called on incompatible receiver");
    }
    return { locale: this._locale, type: this._type, style: this._style };
  }
  static supportedLocalesOf(locales, options) {
    const requested = __js2wasm_lf_localeList(locales);
    if (options !== undefined) {
      if (options === null) throw new TypeError("Cannot convert null to object");
      __js2wasm_lf_option(Object(options), "localeMatcher", "lookup", "best fit", "best fit", "best fit");
    }
    const out = new Array();
    for (let i = 0; i < requested.length; i++) {
      if (__js2wasm_lf_bestAvailable(requested[i]) !== "") out.push(requested[i]);
    }
    return out;
  }
}
`;
