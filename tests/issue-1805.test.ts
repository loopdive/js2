import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { runTest262File } from "./test262-runner.js";
import { TEST262_ROOT } from "./helpers/repo-paths.js";

// #1805 — early-error enforcement: references to a switch CaseBlock's
// lexically-declared names (let/const/class/function) outside the switch
// must be rejected. Per ES spec the LexicallyDeclaredNames of a CaseBlock are
// scoped to that block, so `switch (0) { default: const x = 1; } x;` throws a
// runtime ReferenceError. TypeScript flags this (TS2304), but the test262
// runner compiles with skipSemanticDiagnostics, so the compiler must
// re-detect it syntactically and emit a diagnostic. The runtime-negative
// runner path treats any compiler warning as the expected error.

const SWITCH_LEAK_MSG = "switch-case lexical binding does not leak";

async function compileFlag(src: string) {
  return compile(src, { fileName: "test.ts", emitWat: false, skipSemanticDiagnostics: true });
}

describe("#1805 switch-case lexical-declaration leak (unit)", () => {
  const leaks: { name: string; src: string }[] = [
    { name: "const", src: `switch (0) { default: const x = 1; } x; export {};` },
    { name: "let", src: `switch (0) { default: let x = 1; } var z = x + 1; export {};` },
    { name: "class", src: `switch (0) { default: class x {} } x; export {};` },
    { name: "generator function", src: `switch (0) { default: function* x() {} } x; export {};` },
    { name: "async function", src: `switch (0) { default: async function x() {} } x; export {};` },
    { name: "async generator", src: `switch (0) { default: async function* x() {} } x; export {};` },
  ];

  for (const { name, src } of leaks) {
    it(`flags a leaked ${name} declaration referenced after the switch`, async () => {
      const r = await compileFlag(src);
      const hit = r.errors.find((e) => e.message.includes(SWITCH_LEAK_MSG));
      expect(hit, `expected a switch-leak diagnostic for: ${src}`).toBeTruthy();
    });
  }

  const legal: { name: string; src: string }[] = [
    {
      name: "outer let shadows switch-scoped name",
      src: `let x = 0; switch (0) { default: { let x = 1; } } x; export {};`,
    },
    {
      name: "var declared in switch is function-scoped (legal leak)",
      src: `switch (0) { default: var x = 1; } x; export {};`,
    },
    {
      name: "name only referenced inside the switch",
      src: `switch (0) { default: { const x = 1; const y = x + 1; } } export {};`,
    },
    {
      name: "outer function declaration with same name",
      src: `function x() { return 1; } switch (0) { default: { let x = 2; } } x(); export {};`,
    },
    {
      name: "outer const reused inside switch case",
      src: `const v = 5; switch (v) { case 5: { let w = v; } } v; export {};`,
    },
  ];

  for (const { name, src } of legal) {
    it(`does not flag legal program: ${name}`, async () => {
      const r = await compileFlag(src);
      const hit = r.errors.find((e) => e.message.includes(SWITCH_LEAK_MSG));
      expect(hit, `unexpected switch-leak diagnostic for: ${src}`).toBeFalsy();
    });
  }
});

describe("#1805 switch scope-lex test262 negative tests now pass", () => {
  const files = [
    "test/language/statements/switch/scope-lex-const.js",
    "test/language/statements/switch/scope-lex-class.js",
    "test/language/statements/switch/scope-lex-generator.js",
    "test/language/statements/switch/scope-lex-async-function.js",
    "test/language/statements/switch/scope-lex-async-generator.js",
  ];

  for (const rel of files) {
    it(`${rel}`, async () => {
      const r = await runTest262File(join(TEST262_ROOT, rel), "language/statements", 20000);
      expect(r.status).toBe("pass");
    });
  }
});
