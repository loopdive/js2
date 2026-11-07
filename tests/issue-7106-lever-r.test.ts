// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 lever R — RegExp on the host-free lanes. A literal and
// `new RegExp(<literal>?, <literal>?)` lower to one `extern.regex` whose
// provider is an in-module wrapper over legacy's static construction
// (`ensureIrRegExpLiteralHelper` in `codegen/regexp-standalone.ts`); `.test(subject)` /
// `.exec(subject)` call the existing `__regexp_test_carrier` / `__regexp_exec_carrier` on any IR
// RegExp value (R1, R2). A script `var` holding an `.exec` result binds legacy's #1914 match-result
// slot as a dynamic value (S2). No host import.

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
  // R2: the match array or null, read as a dynamic value.
  execMiss: "if (/a/.exec('b') !== null) { throw new Test262Error('#1'); }",
  execCaptures:
    "if (/a(b)/.exec('xab').length !== 2 || /a(b)/.exec('xab').index !== 1 || /a(b)/.exec('xab')[1] !== 'b') {\n" +
    "  throw new Test262Error('#1');\n}",
  execConstructed: "if (new RegExp('c', 'i').exec('xC')[0] !== 'C') { throw new Test262Error('#1'); }",
  // S2: the result in legacy's typed match-result slot.
  execBound:
    "var __executed = /a(b)/.exec('xab');\n" +
    "assert.sameValue(__executed.length, 2);\nassert.sameValue(__executed.index, 1);\n" +
    "assert.sameValue(__executed.input, 'xab');\nassert.sameValue(__executed[1], 'b');",
  // A bare `null` argument of a function-object call crosses as the externref null.
  execBoundMiss: "var __executed = /q/.exec('xab');\nassert.sameValue(__executed, null);",
};

const REFUSED: Record<string, string> = {
  // R2 takes a proven-string subject only.
  execNumberSubject: "if (/1/.exec(1) === null) { throw new Test262Error('#1'); }",
  // S2: the slot's one IR write is its declaration's `.exec(…)` initializer.
  execReassigned: "var __executed = /a/.exec('a');\n__executed = /b/.exec('b');\nassert.sameValue(__executed[0], 'b');",
  execRedeclared:
    "var __executed = /a/.exec('a');\nvar __executed = /b/.exec('b');\nassert.sameValue(__executed[0], 'b');",
  // A dynamic pattern needs the runtime compiler.
  dynamicPattern: "var p = 'a';\nif (!new RegExp(p).test('a')) { throw new Test262Error('#1'); }",
  // R1 lowers a RegExp only as a `.test` receiver or a discarded statement: no property read, ToString (R3) or binding.
  sourceRead: "if (/1/.source !== '1') { throw new Test262Error('#1'); }",
  concatenated: "try { throw new Test262Error('#1: ' + new RegExp('a**')); } catch (e) {}",
  // A script's own `RegExp` is not the built-in, though the checker binds `new RegExp` to lib alone.
  userRegExp:
    "function RegExp(p) { this.test = function () { return 'mine'; }; }\n" +
    "function h() { return new RegExp('a').test('a'); }\ntry { h(); } catch (e) {}",
  boundScript: "var __re = new RegExp;\nif (__re.global !== false) { throw new Test262Error('#1'); }",
  boundLocal:
    "function h() { var re = /a/g; re.test('aa'); return re.test('aa'); }\nif (!h()) { throw new Test262Error('#1'); }",
};

describe("#7106 lever R — RegExp on the host-free lanes", () => {
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
