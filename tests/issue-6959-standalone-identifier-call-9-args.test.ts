// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6959 — a call with 9+ arguments through an untyped local that holds a
 * function value (`var fn; fn = p[2]; fn(1, …, 9)`) must invoke the callee on
 * `--target standalone`.
 *
 * `tryEmitNullishIdentifierCalleeTypeError` (and four sibling arms) admitted
 * the `__apply_closure` bridge only for `argc <= 8`; above that they compiled
 * the callee and arguments for side effects and pushed `undefined` without
 * calling. The cap predates #6655, which gave the bridge an above-8 arm. This
 * was the first blocker of Octane earley-boyer on standalone
 * (`BgL_parsezd2ze3treesz31` calls `parse[9]` with nine arguments).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string, sloppy: boolean): Promise<string> {
  // Read the string result back char by char (a standalone string is a WasmGC
  // value, opaque to JS).
  const program =
    source.replace("export function main", "function main") +
    `\nvar __s = "";\nexport function p() { __s = "" + main(); return __s.length; }\n` +
    `/** @param {number} i */ export function at(i) { return __s.charCodeAt(i); }\n`;
  const result = await compile(program, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    ...(sloppy ? { inferModuleStrictArguments: false, runtimeEvalProvider: false } : {}),
  });
  if (!result.success) return `COMPILE FAIL ${result.errors.map((e) => String(e.message)).join(" | ")}`;
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as unknown as Record<string, (index?: number) => number>;
  try {
    const length = exports.p!();
    let text = "";
    for (let at = 0; at < length; at++) text += String.fromCharCode(exports.at!(at));
    return text;
  } catch (error) {
    return `TRAP ${(error as Error)?.message ?? String(error)}`;
  }
}

const MAKERS = `
function mk() {
  var f8; var f9;
  { f8 = function (a, b, c, d, e, f, g, h) { return a + b + c + d + e + f + g + h; };
    f9 = function (a, b, c, d, e, f, g, h, i) { return a + b + c + d + e + f + g + h + i; }; }
  return [0, f8, f9];
}
`;

const CASES: [name: string, body: string, expected: string][] = [
  // The Octane shape (minimized repro .tmp/m2.js): 8 args worked, 9 answered null.
  [
    "earley-shape",
    `function call8(p) { var fn; return ((fn = p[1]), fn(1, 1, 1, 1, 1, 1, 1, 1)); }
     function call9(p) { var fn; return ((fn = p[2]), fn(1, 1, 1, 1, 1, 1, 1, 1, 1)); }
     function call9direct(p) { return p[2](1, 1, 1, 1, 1, 1, 1, 1, 1); }
     export function main() { var p = mk(); return call8(p) + "," + call9(p) + "," + call9direct(p); }`,
    "8,9,9",
  ],
  // Over-application into the 9-formal closure: extras are ignored.
  [
    "ten-into-nine",
    `function c(p) { var fn; fn = p[2]; return fn(1, 1, 1, 1, 1, 1, 1, 1, 1, 100); }
     export function main() { return String(c(mk())); }`,
    "9",
  ],
  // Over-application into the 8-formal closure (module has a 9-formal one).
  [
    "nine-into-eight",
    `function c(p) { var fn; fn = p[1]; return fn(1, 1, 1, 1, 1, 1, 1, 1, 100); }
     export function main() { return String(c(mk())); }`,
    "8",
  ],
  // Over-application in a module with NO closure above eight formals (no
  // above-cap dispatcher is minted at all).
  [
    "nine-into-five-no-high-closure",
    `function mk5() { var f; { f = function (a, b, c, d, e) { return a + b + c + d + e; }; } return [0, f]; }
     function c(p) { var fn; fn = p[1]; return fn(1, 1, 1, 1, 1, 1, 1, 1, 100); }
     export function main() { return String(c(mk5())); }`,
    "5",
  ],
  // Stored member closure called with nine arguments (`o.f(…)` arm).
  [
    "stored-member",
    `export function main() { var o = { a: 1 }; o.f = mk()[2]; return String(o.f(1, 2, 3, 4, 5, 6, 7, 8, 9)); }`,
    "45",
  ],
  // Control: the #4640 nullish-callee TypeError must still fire first.
  [
    "null-callee-throws",
    `function c() { var fn; fn = null; try { fn(1, 2, 3, 4, 5, 6, 7, 8, 9); return "no throw"; }
       catch (e) { return e instanceof TypeError ? "TypeError" : "other"; } }
     export function main() { mk(); return c(); }`,
    "TypeError",
  ],
  // Control: argument side effects are evaluated once, in order.
  [
    "arg-side-effects",
    `function c(p) { var fn; var log = ""; fn = p[2];
       var r = fn((log += "a", 1), (log += "b", 1), 1, 1, 1, 1, 1, 1, (log += "c", 1));
       return log + r; }
     export function main() { return c(mk()); }`,
    "abc9",
  ],
];

describe("#6959 standalone 9+-argument call through an untyped local", () => {
  for (const sloppy of [false, true]) {
    for (const [name, body, expected] of CASES) {
      it(`${name} (${sloppy ? "script/sloppy" : "module"})`, async () => {
        expect(await runStandalone(body.includes("mk()") ? MAKERS + body : body, sloppy)).toBe(expected);
      });
    }
  }
});
