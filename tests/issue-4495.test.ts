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
