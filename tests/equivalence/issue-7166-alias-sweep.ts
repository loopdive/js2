// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7166 — generated sweep of the ways an alias of an externref-element vec can
// be used: `const r = a` / `let r = a.sort()` and friends, module-level and
// function-local, `const` and `let`, over every recognised safe use and every
// escape (copy into a typed place, reassignment, closure write, destructuring,
// redeclaration). Shared by issue-7166-sort-reverse-identity.test.ts and the
// head-vs-base probe used in review. Each program exports `test()` returning a
// number digest of a string result, so all lanes compare plain numbers.

const ENC = `function enc(s) { let h = s.length; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n`;

/** Fills for the source array `a`: evolving `[]` whose global / local is the externref carrier. */
const SOURCES: Record<string, string> = {
  str: `const a = [];\na.push("b"); a.push("a");\n`,
  mixed: `const a = [];\na.push("b"); a.push(1);\n`,
  forin: `const a = [];\nfor (const k in { b: 1, a: 2 }) a.push(k);\n`,
};

/** Initialisers of the alias `r`. */
const INITS: Record<string, string> = { plain: `a`, sort: `a.sort()`, reverse: `a.reverse()` };

/**
 * Uses of `r`: [name, statements run inside `test()`, result expression, `let`-only].
 * `other` is a typed `string[]`, `g` / `id` / `flag` are declared in the prelude.
 */
const USES: [string, string, string, boolean][] = [
  ["element read", ``, `String(r[0]) + String(r[1])`, false],
  ["element write", `r[0] = "z";`, `String(a[0]) + (r === a)`, false],
  ["length", ``, `String(r.length)`, false],
  ["length write", `r.length = 1;`, `String(a.length)`, false],
  ["push", `r.push("p");`, `String(a.length) + a[a.length - 1]`, false],
  ["pop", `r.pop();`, `String(a.length)`, false],
  ["typeof element", ``, `typeof r[0] + typeof r[1]`, false],
  ["typeof === element", ``, `String(typeof r[0] === "string") + (typeof r[1] === "number")`, false],
  ["join", ``, `r.join("-")`, false],
  ["indexOf", ``, `String(r.indexOf("b"))`, false],
  ["map", ``, `r.map((x) => String(x) + "!").join()`, false],
  ["chain sort().reverse()", `r.sort().reverse();`, `String(a[0]) + (r === a)`, false],
  ["chain result compared", ``, `String(r.sort() === a)`, false],
  ["=== source", ``, `String(r === a) + (r !== a)`, false],
  ["for…of", `let s = ""; for (const x of r) s += String(x);`, `s`, false],
  ["spread literal", `const c = [...r]; c.push("q");`, `String(c.length) + a.length`, false],
  ["spread call", ``, `String(Math.max(...r.map((x) => String(x).length)))`, false],
  // Escapes: the vec reaches a place typed from the checker's `T[]`.
  ["const t = r", `const t = r; t.push("z");`, `String(a.length) + (t === r)`, false],
  ["[r]", `const box = [r]; box[0].push("z");`, `String(a.length) + (box[0] === r)`, false],
  ["{ v: r }", `const o = { v: r }; o.v.push("z");`, `String(a.length) + (o.v === r)`, false],
  ["id(r)", `const t = id(r); t.push("z");`, `String(a.length) + (t === r)`, false],
  ["return r", `const t = g(); t.push("z");`, `String(a.length) + (t === r)`, false],
  ["?: branch", `const t = flag ? r : []; t.push("z");`, `String(a.length) + (t === r)`, false],
  ["|| operand", `const t = r || []; t.push("z");`, `String(a.length) + (t === r)`, false],
  ["destructure", `const [t] = [r]; t.push("z");`, `String(a.length) + (t === r)`, false],
  ["r = other", `r = other; r.push("o");`, `other.join() + (r === other)`, true],
  ["closure write", `const f = () => { r = ["q"]; }; f();`, `r.join()`, true],
  ["destructuring write", `[r] = [other]; r.push("o");`, `other.join() + (r === other)`, true],
];

/** Full sweep: every source × init × use × module/local × const/let. */
export function aliasSweepCases(full: boolean): [string, string][] {
  const cases: [string, string][] = [];
  const sources = full ? Object.entries(SOURCES) : [["mixed", SOURCES.mixed!] as const];
  const inits = full ? Object.entries(INITS) : [Object.entries(INITS)[1]!];
  for (const [sname, fill] of sources) {
    for (const [iname, init] of inits) {
      for (const [uname, stmts, result, letOnly] of USES) {
        for (const kw of ["const", "let"] as const) {
          if (letOnly && kw === "const") continue;
          for (const where of ["module", "local"] as const) {
            const decl = `${fill}${kw} r = ${init};\nconst other = ["m"];\nconst flag = a.length > 0;\n`;
            // `g` returns `r`, so it exists only in the row that tests that escape.
            const helpers = `function id(x) { return x; }\n${uname === "return r" ? "function g() { return r; }\n" : ""}`;
            const body = `${stmts}\nreturn enc(${result});`;
            const src =
              where === "module"
                ? `${ENC}${decl}${helpers}export function test() {\n${body}\n}`
                : `${ENC}export function test() {\n${decl}${helpers}${body}\n}`;
            cases.push([`${where} ${kw} ${sname} r = ${iname}: ${uname}`, src]);
          }
        }
      }
    }
  }
  return cases;
}
