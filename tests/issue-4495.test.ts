// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4495 — a string-initialised JS binding keeps a native-string slot, and a
// later store of a non-string value into it answers `null` (the coercion into
// a typed-string slot deliberately refuses a generic ToString), so the next
// `'' + x` traps in `__str_concat`.
//
// The fix is definition-side: the slot widens to `externref` when some
// REACHING WRITE is not provably the initializer's type. The plain `x = f()`
// write was already covered (#4206, bbe50022de for module bindings; the
// function-local mixed-assignment carrier). This file pins the issue's own
// repros plus the write forms both analyses used to miss — destructuring,
// logical assignment, for-of targets, `++`/`--` and numeric compound
// assignment — and the `typeof` fold on a widened function local.
//
// Every program runs as an untyped JS SCRIPT on both lanes, at top level
// (module binding) and inside a function (local binding). `chk` throws only on
// a wrong value, so "no throw" means spec-correct.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const PRELUDE = `function id(x) { return x; }
function chk(a, e) { if (a !== e) throw new Error('got ' + a + ' want ' + e); }
`;

async function runScript(body: string, lane: "standalone" | "gc", inFunction: boolean): Promise<void> {
  const src = inFunction ? `${PRELUDE}function f() { ${body} }\nf();\n` : `${PRELUDE}${body}\n`;
  const r = await compile(src, {
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
    fileName: "issue-4495.js",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = lane === "standalone" ? {} : buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
  (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
  (instance.exports as { __module_init: () => void }).__module_init();
}

function bothLanesBothScopes(name: string, body: string, scopes: readonly boolean[] = [false, true]): void {
  for (const lane of ["standalone", "gc"] as const) {
    for (const inFunction of scopes) {
      it(`${name} [${lane}, ${inFunction ? "function local" : "module binding"}]`, async () => {
        await runScript(body, lane, inFunction);
      });
    }
  }
}

describe("#4495 issue repros (acceptance criterion 1)", () => {
  bothLanesBothScopes("id(1) into a string slot", `var result = 'r'; result = id(1); chk('' + result, '1');`);
  // Script top level only, exactly as the issue states them: `this.p1` inside a
  // sloppy function is the #4500 global-binding defect, not this one.
  bothLanesBothScopes(
    "this.p1 global into a string slot",
    `this.p1 = 1; var result = 'r'; result = p1; chk('' + result, '1');`,
    [false],
  );
  bothLanesBothScopes(
    "runtime string stays a string",
    `this.p1 = 's'; var result = 'r'; result = p1; chk('' + result, 's');`,
    [false],
  );
});

describe("#4495 reaching writes the slot analyses used to miss", () => {
  bothLanesBothScopes("array destructuring", `var r = 'r'; [r] = [id(1)]; chk('' + r, '1');`);
  bothLanesBothScopes(
    "object shorthand destructuring",
    `var r = 'r'; var o = { r: id(3) }; ({ r } = o); chk('' + r, '3');`,
  );
  bothLanesBothScopes("&&= with a dynamic value", `var r = 'r'; r &&= id(1); chk('' + r, '1');`);
  bothLanesBothScopes("||= with a dynamic value", `var r = ''; r ||= id(1); chk('' + r, '1');`);
  bothLanesBothScopes("for-of identifier target", `var r = 'r'; for (r of [id(1)]) {} chk('' + r, '1');`);
  bothLanesBothScopes("++ on a string", `var r = '5'; r++; chk('' + r, '6');`);
  bothLanesBothScopes("-= on a string", `var r = '5'; r -= 1; chk('' + r, '4');`);
  bothLanesBothScopes("++ on a boolean", `var r = true; r++; chk('' + r, '2');`);
});

describe("#4495 typeof reads the widened slot, not the initializer's type", () => {
  bothLanesBothScopes("typeof after a dynamic store", `var r = 'r'; r = id(1); chk(typeof r, 'number');`);
  bothLanesBothScopes("typeof after ++", `var r = '5'; ++r; chk(typeof r, 'number');`);
});

describe("#4495 controls — provably same-type writes keep working", () => {
  bothLanesBothScopes("string-only reassignment", `var r = 'a'; r = r + 'b'; r = 'c' + r; chk(r, 'cab');`);
  bothLanesBothScopes("String() of a dynamic value", `var r = 'a'; r = String(id(1)); chk(r, '1');`);
  bothLanesBothScopes("numeric swap destructuring", `var a = 1, b = 2; [a, b] = [b, a]; chk('' + a + b, '21');`);
  bothLanesBothScopes("numeric counter ++", `var n = 0; for (var i = 0; i < 3; i++) n++; chk(n, 3);`);
  bothLanesBothScopes("for-of over a string array", `var w = 'w'; for (w of ['p', 'q']) {} chk(w, 'q');`);
});

// Review round 1. Every row below failed on base (`b6250f09f8`) or on the
// first head (`b7701d9c83`). `FUNCTION_ONLY` rows still fail at module scope,
// on base too, for a lowering reason outside slot typing — see the issue
// file's residuals.
const FUNCTION_ONLY = [true] as const;

describe("#4495 review 1 — writes the shared enumerator now names", () => {
  bothLanesBothScopes(
    "+= of a string into a number slot",
    `var n = 1; n += 'x'; chk('' + n, '1x'); chk(typeof n, 'string');`,
  );
  bothLanesBothScopes("+= of a dynamic value into a number slot", `var n = 1; n += id('x'); chk('' + n, '1x');`);
  bothLanesBothScopes("var re-declaration", `var r = 'r'; var r = id(1); chk('' + r, '1');`);
  bothLanesBothScopes("var re-declaration by a pattern", `var r = 'r'; var { r } = { r: id(1) }; chk('' + r, '1');`);
  bothLanesBothScopes(
    "for (var … in) re-declaration",
    `var r = 1; for (var r in { a: 1 }) {} chk(typeof r, 'string');`,
  );
  bothLanesBothScopes("parenthesised target", `var r = 'r'; (r) = id(1); chk('' + r, '1');`);
  bothLanesBothScopes(
    "for-in key into a number local",
    `var k = 1; for (k in { a: 1 }) {} chk(typeof k + k, 'stringa');`,
    FUNCTION_ONLY,
  );
  bothLanesBothScopes(
    "for-of pattern head",
    `var a = 5; for ([a] of id([['x']])) {} chk(typeof a, 'string');`,
    FUNCTION_ONLY,
  );
  bothLanesBothScopes(
    "for-of pattern head into a string slot",
    `var a = 's'; for ([a] of id([[1]])) {} chk('' + a, '1');`,
  );
});

describe("#4495 review 1 — a rest target stores into the binding's own slot", () => {
  bothLanesBothScopes(
    "guarded rest into an array local",
    `var y = [9]; if (id(false)) { [...y] = [1, 2]; } chk(y.length, 1);`,
  );
  bothLanesBothScopes(
    "looped rest into an array local",
    `var y = [9, 9]; var n = 0; for (var i = 0; i < 2; i++) { n += y.length; [...y] = [1]; } chk(n + y.length, 4);`,
  );
  bothLanesBothScopes(
    "guarded rest into an uninitialised var",
    `var y; if (id(false)) [...y] = [1, 2]; chk(typeof y, 'undefined');`,
  );
  bothLanesBothScopes(
    "rest into a string local",
    `var y = 's'; [...y] = [1, 2]; chk(typeof y, 'object'); chk('' + y, '1,2');`,
  );
  bothLanesBothScopes("guarded rest into a string local", `var y = 's'; if (id(false)) [...y] = [1]; chk(y, 's');`);
});

describe("#4495 review 1 — a nested pattern's default does not hide its source", () => {
  bothLanesBothScopes("source element present", `var r = 'r'; var a = id([[1]]); [[r] = ['z']] = a; chk('' + r, '1');`);
  bothLanesBothScopes("default taken", `var r = 'r'; var a = id([undefined]); [[r] = ['z']] = a; chk(r, 'z');`);
});

describe("#4495 review 1 — a literal source keeps its own values", () => {
  bothLanesBothScopes("[r] = [1]", `var r = 'r'; [r] = [1]; chk('' + r, '1');`);
  bothLanesBothScopes("[[r]] = [[1]]", `var r = 'r'; [[r]] = [[1]]; chk('' + r, '1');`);
  bothLanesBothScopes("[, r] = ['a', 1]", `var r = 'r'; [, r] = ['a', 1]; chk('' + r, '1');`);
  bothLanesBothScopes("[{ a: r }] = [{ a: 1 }]", `var r = 'r'; [{ a: r }] = [{ a: 1 }]; chk('' + r, '1');`);
  bothLanesBothScopes("({ r } = { r: 'a', r: 1 })", `var r = 'r'; ({ r } = { r: 'a', r: 1 }); chk('' + r, '1');`);
  bothLanesBothScopes("({ a: r } = { a: 1 })", `var r = 'r'; ({ a: r } = { a: 1 }); chk('' + r, '1');`);
  bothLanesBothScopes("({ a: r } = { a: id(1) })", `var r = 'r'; ({ a: r } = { a: id(1) }); chk('' + r, '1');`);
  bothLanesBothScopes("swap across types", `var a = 'x', b = 1; [a, b] = [b, a]; chk('' + a + b, '1x');`);
  bothLanesBothScopes("boolean slot", `var b = true; [b] = ['s']; chk('' + b, 's');`);
  bothLanesBothScopes("number slot", `var n = 0; ({ n } = { n: 'q' }); chk('' + n, 'q');`);
});

describe("#4495 review 1 — typeof of a local a closure writes", () => {
  bothLanesBothScopes("arrow", `var r = '5'; var g = () => { r -= 1; }; g(); chk(typeof r, 'number');`);
  bothLanesBothScopes(
    "function expression",
    `var r = '5'; var g = function () { r -= 1; }; g(); chk(typeof r, 'number');`,
  );
});

// Precision ratchet: the new write forms must widen ONLY when the stored value
// is not provably the initializer's type. Each of these locals keeps its
// specialised slot — a regression here is a silent slowdown, not a red test
// anywhere else.
describe("#4495 precision — provably same-type writes keep the specialised slot", () => {
  const PRECISE = `
export function run(n) {
  var s = 'a', t = 'x', w = 'w';
  var a = 1, b = 2, k = 0;
  for (var i = 0; i < n; i++) {
    s ||= 'seed';
    s &&= t;
    [a, b] = [b, a];
    k++;
    k -= 1;
  }
  for (w of ['p', 'q']) s = s + w;
  return s.length + a + b + k;
}`;
  for (const lane of ["standalone", "gc"] as const) {
    it(`no local of run() is widened to externref [${lane}]`, async () => {
      const r = await compile(PRECISE, {
        ...(lane === "standalone" ? { target: "standalone" as const } : {}),
        fileName: "issue-4495-precision.js",
        skipSemanticDiagnostics: true,
      });
      expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
      const start = r.wat.indexOf("(func $run ");
      const body = r.wat.slice(start, r.wat.indexOf("\n  (func ", start + 1));
      for (const name of ["s", "t", "w", "a", "b", "k"]) {
        const slot = new RegExp(`\\(local \\$${name} ([^\\n]+)\\)`).exec(body)?.[1];
        expect(slot, `local $${name}`).toBeDefined();
        expect(slot, `local $${name}`).not.toBe("externref");
      }
    });
  }
});

// Review 1, finding 4: an annotated function local is not demoted by a write
// TypeScript checked against its annotation. The first head widened `x` below
// to the boxed carrier and pulled in the dynamic runtime (standalone
// 32,872 B → 91,919 B). An unchecked `any` value still keeps the carrier: `ys`
// must alias `o` (#7154 — skipping every annotated declaration broke this).
describe("#4495 review 1 — an annotated local keeps its declared slot", () => {
  const TYPED = `
export function nested(): number {
  let x: number = 0;
  let vals: number[][] = [[7]];
  [[x]] = vals;
  return x;
}
export function aliased(): number {
  const n: number[] = [1];
  const o: any = n;
  let ys: any[] = [];
  const xs: any[] = (ys = o);
  xs.push(2);
  return n.length * 10 + ys.length;
}`;
  for (const lane of ["standalone", "gc"] as const) {
    it(`a typed local written through a nested pattern stays f64; an any value still aliases [${lane}]`, async () => {
      const r = await compile(TYPED, {
        ...(lane === "standalone" ? { target: "standalone" as const } : {}),
        fileName: "issue-4495-typed.ts",
      });
      expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
      const start = r.wat.indexOf("(func $nested ");
      const body = r.wat.slice(start, r.wat.indexOf("\n  (func ", start + 1));
      expect(/\(local \$x ([^\n]+)\)/.exec(body)?.[1]).toBe("f64");
      const imports = lane === "standalone" ? {} : buildImports(r.imports, undefined, r.stringPool);
      const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
      (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
      const exports = instance.exports as { nested: () => number; aliased: () => number };
      expect(exports.nested()).toBe(7);
      expect(exports.aliased()).toBe(22);
    });
  }
});
