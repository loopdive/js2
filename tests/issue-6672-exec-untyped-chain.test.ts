// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6672) `RegExp.prototype.exec` on a RegExp whose static type was erased to
// `any` — read through an untyped property chain (marked's rules table,
// `this.rules.block.heading.exec(src)`), a helper parameter, or an array
// element — `--target standalone`.
//
// Before: the closed-method dispatcher `__call_m_exec_1` had a `$NativeRegExp`
// brand arm for `test` only, so `exec` fell to `__extern_method_call`, whose
// `[[Get]]` finds no `exec` on the RegExp struct and answered `undefined`:
// every such exec read as "no match" and marked's lexer threw
// `Infinite loop on byte: 35`. Now the dispatcher routes a runtime RegExp to
// `__regexp_exec_carrier` (src/codegen/regexp-exec-carrier.ts).
//
// Every case returns 1 exactly when the result equals Node's; the untyped
// sources run under Node too, as the oracle.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const OPTS = { fileName: "test.js", allowJs: true, skipSemanticDiagnostics: true, target: "standalone" } as const;

async function runCase(src: string): Promise<number> {
  const r = await compile(src, OPTS);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(r.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test: () => number }).test();
}

async function runInNode(src: string): Promise<number> {
  const url = `data:text/javascript;base64,${Buffer.from(src).toString("base64")}`;
  const mod = (await import(url)) as { test: () => number };
  return mod.test();
}

const PRELUDE = `var heading = /^ {0,3}(#{1,6})(?=\\s|$)(.*)(?:\\n+|$)/;
var rules = { block: { heading: heading, newline: /^(?:[ \\t]*(?:\\n|$))+/ }, inline: { g: /a(\\d)/g } };
`;

const CASES: ReadonlyArray<readonly [string, string]> = [
  [
    "nested_object_chain",
    `${PRELUDE}function head(r, s) { var t = r.block.heading.exec(s); return t ? t[2].length : -1; }
export function test() { return head(rules, "# npm-compat\\n\\nA short") === 11 ? 1 : 0; }`,
  ],
  [
    "untyped_param",
    `${PRELUDE}function ex(re, s) { var t = re.exec(s); return t ? t[0].length * 100 + t.length : -1; }
export function test() { return ex(/b(c)/, "abcd") === 202 && ex(heading, "# npm") === 503 ? 1 : 0; }`,
  ],
  [
    "miss_is_null",
    `${PRELUDE}function ex(re, s) { return re.exec(s); }
export function test() { return ex(rules.block.newline, "x\\n") === null ? 1 : 0; }`,
  ],
  [
    "index_and_input",
    `${PRELUDE}function ex(re, s) { return re.exec(s); }
export function test() { var t = ex(/c(d)/, "abcd"); return t.index === 2 && t.input === "abcd" && t[1] === "d" ? 1 : 0; }`,
  ],
  [
    "global_lastindex",
    `${PRELUDE}function ex(re, s) { return re.exec(s); }
export function test() {
  var g = rules.inline.g; var a = ex(g, "a1a2"); var b = ex(g, "a1a2"); var c = ex(g, "a1a2");
  return a[1] === "1" && b[1] === "2" && c === null && g.lastIndex === 0 ? 1 : 0;
}`,
  ],
  [
    "array_element",
    `var list = [/x/, /^(#+) /];
function first(rs, s) { for (var i = 0; i < rs.length; i++) { var m = rs[i].exec(s); if (m) return m[1] ? m[1].length : 0; } return -1; }
export function test() { return first(list, "## h") === 2 ? 1 : 0; }`,
  ],
  [
    "non_string_subject",
    `function ex(re, s) { var t = re.exec(s); return t ? t[0] : "none"; }
export function test() { return ex(/\\d+/, 12345) === "12345" ? 1 : 0; }`,
  ],
  [
    "user_exec_method_still_wins",
    `var o = { exec: function (s) { return "user:" + s; } };
function ex(re, s) { return re.exec(s); }
export function test() { return ex(o, "q") === "user:q" && ex(/q/, "q")[0] === "q" ? 1 : 0; }`,
  ],
];

describe("#6672 standalone RegExp exec through an untyped receiver", () => {
  for (const [name, src] of CASES) {
    it(name, async () => {
      expect(await runInNode(src)).toBe(1);
      expect(await runCase(src)).toBe(1);
    });
  }
});
