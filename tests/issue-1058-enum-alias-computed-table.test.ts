// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, wrapExports } from "../src/index.js";

const SOURCE = `
const enum Kind {
  Zero,
  AliasZero = Zero,
  Spread,
  Source,
}

interface Node {
  kind: Kind;
}

interface SpreadNode extends Node {
  kind: Kind.Spread;
  expression: number;
}

interface SourceNode extends Node {
  kind: Kind.Source;
  statements: number;
}

const visitors: Record<number, any> = {
  [Kind.Spread]: function visitSpread(node: SpreadNode): number {
    return node.expression;
  },
  [Kind.Source]: function visitSource(node: SourceNode): number {
    return node.statements;
  },
};

export function test(): number {
  // Use the enum's true runtime value. A collector that advances past the
  // AliasZero alias incorrectly writes visitSpread into this slot.
  const node = { kind: 2, statements: 42 } as SourceNode;
  return visitors[node.kind](node);
}
`;

describe("#1058 enum aliases in computed visitor tables", () => {
  it("advances implicit members from an alias's resolved value", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-1058-enum-alias-computed-table.ts",
      skipSemanticDiagnostics: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.test()).toBe(42);
  });
});
