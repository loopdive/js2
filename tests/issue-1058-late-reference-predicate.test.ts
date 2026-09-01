// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti, wrapExports } from "../src/index.js";

const SOURCES = {
  "./types.ts": `
export interface Node { kind: number; }
export interface Expression extends Node { value: number; }
`,
  "./core.ts": `
export function cast<T, U extends T>(value: T, test: (value: T) => value is U): U | undefined {
  return test(value) ? value as U : undefined;
}
`,
  "./nodeTests.ts": `
import type { Expression, Node } from "./types.js";
export function isExpression(node: Node): node is Expression {
  return node.kind === 1;
}
`,
  "./entry.ts": `
import { cast } from "./core.js";
import { isExpression } from "./nodeTests.js";
import type { Expression } from "./types.js";

export function test(): number {
  const expression: Expression = { kind: 1, value: 41 };
  return cast(expression, isExpression)?.value ?? -1;
}
`,
} as const;

describe("#1058 late reference predicate dispatch", () => {
  it.each(["gc", "standalone"] as const)(
    "finalizes a generic cast helper after its %s predicate wrapper exists",
    async (target) => {
      const result = await compileMulti(SOURCES, "./entry.ts", {
        target,
        platform: "node",
        skipSemanticDiagnostics: true,
        experimentalIR: false,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);

      const imports = result.importObject ?? {};
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
      const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as {
        test(): number;
      };
      expect(exports.test()).toBe(41);
      if (target === "standalone") {
        expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      }
    },
  );
});
