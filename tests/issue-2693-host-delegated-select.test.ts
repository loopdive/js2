// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2693 milestone wiring confirmation — DUAL host-delegation seam.
//
// The real eslint Linter.verify host-delegates BOTH (a) PARSE (espree) and
// (b) SELECTOR MATCHING (esquery — its native compile is blocked, #2700), while
// the COMPILED wasm runs the lint orchestration (rules / disable-directives /
// messages / code-path). This test proves that exact seam end to end in a
// compiled `Linter`: the wasm calls host espree (tokenize) AND host esquery
// (parse + matches) — using the REAL Node packages on the host — and produces a
// correct `semi`-rule diagnostic.
//
// This is the architecture the full real-eslint run uses (gated only on #2688
// for apply-disable-directives + the bounded-compile setup-eslint-deps fixtures).
// Here we confirm the host seam is sound with the real parsers, independent of
// those gates.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { createRequireFromEslint, ESLINT_DEV_DEPENDENCY_SKIP, resolveEslintFile } from "./helpers/eslint.js";

// Compiled Linter: host-delegates parse (espree) AND select (esquery).
const LINTER_SRC = `
declare function __host_is_statement(code: string): boolean;   // esquery.matches over espree AST
declare function __host_last_is_semi(code: string): boolean;   // espree tokenize: last token === ';'
declare function __host_last_line(code: string): number;
declare function __host_last_col(code: string): number;

class Linter {
  verify(code: string): string {
    // host esquery selects whether the root is a statement that requires a
    // terminating ';'; host espree supplies the token position. The rule logic
    // + message assembly run in wasm.
    if (__host_is_statement(code) && !__host_last_is_semi(code)) {
      return "Missing semicolon. (" + __host_last_line(code) + ":" + __host_last_col(code) + ")";
    }
    return "";
  }
}
export function verify(code: string): string { return new Linter().verify(code); }
`;

const ESLINT_LINTER = resolveEslintFile("lib/linter/linter.js");

interface EslintHostDependencies {
  espree: typeof import("espree");
  esquery: any;
}

let eslintHostDependencies: EslintHostDependencies | null = null;

function loadEslintHostDependencies(): EslintHostDependencies {
  if (eslintHostDependencies !== null) return eslintHostDependencies;

  const req = createRequireFromEslint();
  const espree: typeof import("espree") = req("espree");
  let esquery: any = req("esquery");
  // esquery ships as a namespace or default-export bundle.
  if (typeof esquery.matches !== "function" && esquery.default) esquery = esquery.default;
  eslintHostDependencies = { espree, esquery };
  return eslintHostDependencies;
}

describe("#2693 — dual host-delegation seam (host espree parse + host esquery select)", () => {
  it.skipIf(ESLINT_LINTER === null)(
    `loads real espree + esquery from ESLint's importer context ${ESLINT_DEV_DEPENDENCY_SKIP}`,
    () => {
      const { espree, esquery } = loadEslintHostDependencies();
      expect(typeof espree.parse).toBe("function");
      expect(typeof espree.tokenize).toBe("function");
      expect(typeof esquery.parse).toBe("function");
      expect(typeof esquery.matches).toBe("function");
    },
  );

  it.skipIf(ESLINT_LINTER === null)(
    `a compiled Linter calls host espree + host esquery and emits the semi diagnostic ${ESLINT_DEV_DEPENDENCY_SKIP}`,
    async () => {
      const { espree, esquery } = loadEslintHostDependencies();

      const r = await compile(LINTER_SRC, {
        fileName: "linter.ts",
        target: "gc",
        platform: "node",
      });
      expect(r.success, r.errors.map((error) => error.message).join("\n")).toBe(true);
      if (!r.success) return;
      expect(WebAssembly.validate(r.binary)).toBe(true);

      const STMT_SELECTOR = esquery.parse("VariableDeclaration, ExpressionStatement");
      const tokensOf = (code: string) => espree.tokenize(code, { ecmaVersion: 2022, loc: true });

      const imports = buildImports(
        r.imports,
        {
          __host_is_statement: (code: string): boolean => {
            try {
              const ast = espree.parse(code, { ecmaVersion: 2022, loc: true });
              const first = (ast as any).body?.[0];
              return !!first && esquery.matches(first, STMT_SELECTOR, []);
            } catch {
              return false;
            }
          },
          __host_last_is_semi: (code: string): boolean => {
            const t = tokensOf(code);
            const last = t[t.length - 1];
            return !!last && last.value === ";";
          },
          __host_last_line: (code: string): number => {
            const t = tokensOf(code);
            const last = t[t.length - 1];
            return last?.loc?.start?.line ?? 0;
          },
          __host_last_col: (code: string): number => {
            const t = tokensOf(code);
            const last = t[t.length - 1];
            return last ? (last.loc?.start?.column ?? 0) + 1 : 0;
          },
        },
        r.stringPool,
      );
      const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
      imports.setExports?.(instance.exports as Record<string, Function>);
      const verify = instance.exports.verify as (c: string) => string;

      // Real espree tokenization + real esquery selector matching, wasm rule logic.
      expect(verify("var x = 1")).toBe("Missing semicolon. (1:9)");
      expect(verify("var x = 1;")).toBe("");
      expect(verify("foo()")).toBe("Missing semicolon. (1:5)");
      expect(verify("foo();")).toBe("");
    },
    30_000,
  );
});
