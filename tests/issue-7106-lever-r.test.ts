// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 lever R1 — RegExp on the host-free lanes. A literal and
// `new RegExp(<literal>?, <literal>?)` lower to one `extern.regex` whose
// provider is an in-module wrapper over legacy's static construction
// (`ensureIrRegExpLiteralHelper` in `codegen/regexp-standalone.ts`); `.test(subject)` calls the existing
// `__regexp_test_carrier` on any IR RegExp value. R3: beside a string, `+`
// prints a RegExp as `RegExp.prototype.toString` through legacy's rendering
// (`__regexp_to_string_carrier`). No host import.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { lane, TARGETS, type Target } from "./helpers/ambient-intrinsic-probe.js";
import { assembleHarnessBody, moduleInit } from "./helpers/harness-module-init.js";

/** Run `body`'s `<module-init>` on `target` (an assert failure throws); report whether the IR claimed it. */
async function runBody(target: Target, body: string): Promise<boolean> {
  const result = await compile(assembleHarnessBody(body), {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    deferTopLevelInit: true,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  expect(result.imports.filter((entry) => /RegExp/.test(entry.name))).toEqual([]);
  const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (instance.exports.__module_init as () => void)();
  return moduleInit(result)?.irBodyEmitted === true;
}

const CLAIMED: Record<string, string> = {
  literalTest: "if (!/b/.test('abc')) { throw new Test262Error('#1'); }",
  anchoredMiss: "if (/^m/.test('pairs\\u000amakes')) { throw new Test262Error('#1'); }",
  multilineFlag: "var hit = /^m/m.test('pairs\\u000amakes');\nif (!hit) { throw new Test262Error('#1'); }",
  constructed: "if (!new RegExp('b').test('abc')) { throw new Test262Error('#1'); }",
  constructedFlags:
    "if (new RegExp('B', '').test('abc') || !new RegExp('B', 'i').test('abc')) { throw new Test262Error('#1'); }",
  emptyPattern: "if (!new RegExp().test('')) { throw new Test262Error('#1'); }",
  // §22.2.3.2: an invalid pair throws SyntaxError when the construction evaluates.
  invalidPattern:
    "try { new RegExp('a**'); throw new Test262Error('#1'); } catch (e) { if (!(e instanceof SyntaxError)) { throw new Test262Error('#2'); } }",
  // Each evaluation of a literal is a fresh object, so a `g` literal in a loop always starts at lastIndex 0.
  freshPerEvaluation:
    "function f() { var n = 0; for (var i = 0; i < 3; i++) { if (/a/g.test('aa')) { n++; } } return n; }\n" +
    "if (f() !== 3) { throw new Test262Error('#1'); }",
  // R3: ToString of a RegExp beside a string (§22.2.6.17 "/" + source + "/" + flags).
  concatLiteral: "if (('#' + /a+b/gi) !== '#/a+b/gi') { throw new Test262Error('#1'); }",
  concatLeft: "if ((/x/m + '!') !== '/x/m!') { throw new Test262Error('#1'); }",
  concatConstructed: "if (('' + new RegExp('a/b', 'g')) !== '/a\\\\/b/g') { throw new Test262Error('#1'); }",
  concatEmpty: "if (('' + new RegExp()) !== '/(?:)/') { throw new Test262Error('#1'); }",
  // The S15.10.1 shape: the invalid pair throws SyntaxError before the message is built.
  concatInvalid:
    "try { throw new Test262Error('#1: ' + (new RegExp('a**'))); } catch (e) { if (!(e instanceof SyntaxError)) { throw new Test262Error('#2'); } }",
};

const REFUSED: Record<string, string> = {
  // R2: `exec` and its match array.
  exec: "if (/a/.exec('a') === null) { throw new Test262Error('#1'); }",
  // A dynamic pattern needs the runtime compiler.
  dynamicPattern: "var p = 'a';\nif (!new RegExp(p).test('a')) { throw new Test262Error('#1'); }",
  // A RegExp lowers only as a `.test` receiver, a discarded statement or a string `+` operand.
  sourceRead: "if (/1/.source !== '1') { throw new Test262Error('#1'); }",
  // R3 reads a RegExp only as a string `+` operand: not beside a number or another RegExp.
  plusNumber: "if ((/a/ + 1) !== '/a/1') { throw new Test262Error('#1'); }",
  plusRegExp: "if ((/a/ + /b/) !== '/a//b/') { throw new Test262Error('#1'); }",
  // A script's own `RegExp` is not the built-in, though the checker binds `new RegExp` to lib alone.
  userRegExp:
    "function RegExp(p) { this.test = function () { return 'mine'; }; }\n" +
    "function h() { return new RegExp('a').test('a'); }\ntry { h(); } catch (e) {}",
  boundScript: "var __re = new RegExp;\nif (__re.global !== false) { throw new Test262Error('#1'); }",
  boundLocal:
    "function h() { var re = /a/g; re.test('aa'); return re.test('aa'); }\nif (!h()) { throw new Test262Error('#1'); }",
};

describe("#7106 lever R1 — RegExp on the host-free lanes", () => {
  for (const target of TARGETS) {
    describe(lane(target), () => {
      for (const [name, body] of Object.entries(CLAIMED)) {
        it(`claims and runs: ${name}`, async () => {
          expect(await runBody(target, body)).toBe(true);
        });
      }
      for (const [name, body] of Object.entries(REFUSED)) {
        it(`refuses at selection, never withdraws: ${name}`, async () => {
          expect(await runBody(target, body)).toBe(false);
        });
      }
    });
  }
});
