// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { normalizeScriptHtmlLikeComments } from "../src/compiler/html-like-comments.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

type CompileTarget = undefined | "standalone";

const TEST262_HTML_COMMENT_CASES = [
  "multi-line-html-close.js",
  "single-line-html-close.js",
  "single-line-html-open.js",
  "single-line-html-close-first-line-1.js",
  "single-line-html-close-first-line-2.js",
  "single-line-html-close-first-line-3.js",
  "single-line-html-close-unicode-separators.js",
] as const;

async function instantiate(result: CompileResult): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const imports = (result.importObject ?? {}) as WebAssembly.Imports & {
    setExports?: (exports: WebAssembly.Exports) => void;
    __setExports?: (exports: WebAssembly.Exports) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  imports.__setExports?.(instance.exports);
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

function probeOutcome(result: CompileResult): IrObservedOutcome | undefined {
  return result.irOutcomes?.find((outcome) => outcome.displayName === "probe");
}

describe("#833 — Annex B HTML-like comments", () => {
  it("masks Script-goal open and close comments without moving source positions", () => {
    const source = [
      "--> first-line close",
      "  /* prefix */ --> close",
      "value = 1; <!-- open",
      "value\u2028--> unicode close",
      "/* multi",
      "line */--> close after multiline comment",
    ].join("\n");
    const normalized = normalizeScriptHtmlLikeComments(source);

    expect(normalized).toHaveLength(source.length);
    expect([...normalized.matchAll(/[\n\r\u2028\u2029]/gu)].map((match) => match.index)).toEqual(
      [...source.matchAll(/[\n\r\u2028\u2029]/gu)].map((match) => match.index),
    );
    expect(normalized).not.toContain("first-line close");
    expect(normalized).not.toContain("open");
    expect(normalized).not.toContain("unicode close");
    expect(normalized).toContain("/* prefix */");
    expect(normalized).toContain("/* multi\nline */");
  });

  it("leaves marker text in literals and ordinary comments untouched", () => {
    const source = [
      `const string = "<!-- -->";`,
      "const regexp = /<!--|-->/;",
      "const template = `<!-- ${1 + 2} -->`;",
      "// <!-- -->",
      "/* <!-- --> */",
    ].join("\n");
    expect(normalizeScriptHtmlLikeComments(source)).toBe(source);
  });

  it("does not accept an HTML close marker after code on the same line", () => {
    const source = ";--> not a comment";
    expect(normalizeScriptHtmlLikeComments(source)).toBe(source);
  });

  it.each<CompileTarget>([undefined, "standalone"])(
    "sends normalized Script source through IR (%s)",
    async (target) => {
      const result = await compile(
        `export function probe() {
          let counter = 0;
          <!-- ignored open comment
          counter += 1;
          /* prefix */ --> ignored close comment
          counter += 2;
          return counter;
        }`,
        {
          fileName: "issue-833-html-like-comments.js",
          allowJs: true,
          skipSemanticDiagnostics: true,
          inferModuleStrictArguments: false,
          experimentalIR: true,
          trackIrOutcomes: true,
          ...(target ? { target } : {}),
        },
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(probeOutcome(result)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      if (target === "standalone") {
        expect(WebAssembly.Module.imports(await WebAssembly.compile(result.binary))).toEqual([]);
      }
      const exports = await instantiate(result);
      expect(exports.probe!()).toBe(3);
    },
  );

  it("keeps HTML close comments invalid in Module goal", async () => {
    const source = "export {};\n--> module comment";
    const result = await compile(source, {
      fileName: "issue-833-module.js",
      allowJs: true,
      inferModuleStrictArguments: true,
    });
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.severity === "error")).toBe(true);
    expect(normalizeScriptHtmlLikeComments(source)).not.toBe(source);
  });

  it.each<CompileTarget>([undefined, "standalone"])(
    "passes the seven exact-current Test262 compile-error cases (%s)",
    async (target) => {
      for (const file of TEST262_HTML_COMMENT_CASES) {
        const result = await runTest262File(
          resolve("test262/test/annexB/language/comments", file),
          "annexB/language",
          30_000,
          target,
        );
        expect(result.status, `${file}: ${result.error ?? result.reason ?? "unknown failure"}`).toBe("pass");
      }
    },
    120_000,
  );
});
