// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";

describe("#1058 parser fingerprint arithmetic", () => {
  it.each(["gc", "standalone"] as const)("hashes the native Builder AST value stream in %s", async (target) => {
    const fixture = ts.createSourceFile(
      "fixture.ts",
      readFileSync(new URL("./dogfood/fixtures/typescript-parser-standalone-workload.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    let sourceText: string | undefined;
    for (const statement of fixture.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          declaration.name.getText(fixture) === "builderStatePublicSource" &&
          declaration.initializer &&
          ts.isStringLiteral(declaration.initializer)
        ) {
          sourceText = declaration.initializer.text;
        }
      }
    }
    expect(sourceText).toBeDefined();
    const source = ts.createSourceFile("input.ts", sourceText!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const values: number[] = [];
    let nodeCount = 0;
    const text = (value: string): void => {
      values.push(0x9e3779b9, value.length);
      for (let index = 0; index < value.length; index++) values.push(value.charCodeAt(index));
    };
    const visitArray = (nodes: ts.NodeArray<ts.Node>): void => {
      values.push(0xa119f1a1, nodes.pos, nodes.end, nodes.length, nodes.hasTrailingComma ? 1 : 0);
      for (const node of nodes) visit(node);
    };
    const visit = (node: ts.Node): void => {
      nodeCount++;
      values.push(node.kind, node.pos, node.end, node.flags);
      if (ts.isIdentifier(node)) text(node.escapedText as string);
      else if (ts.isStringLiteral(node)) text(node.text);
      ts.forEachChild(node, visit, visitArray);
    };
    visit(source);
    expect(nodeCount).toBe(44);
    expect(source.statements.length).toBe(3);
    const expectedHash = values.reduce((hash, value) => Math.imul(hash ^ value, 0x01000193) >>> 0, 0x811c9dc5);
    expect(expectedHash).toBe(3419126609);
    const result = await compile(
      `
      const values: number[] = ${JSON.stringify(values)};
      export function probe(): number {
        let hash = 0x811c9dc5;
        const mix = (value: number): void => { hash = Math.imul(hash ^ value, 0x01000193) >>> 0; };
        for (const value of values) mix(value);
        return hash + 44 * 4294967296 + 3 * 4398046511104;
      }
    `,
      { target, experimentalIR: false },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
    const imports = result.importObject ?? {};
    const instance = await WebAssembly.instantiate(module, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(13386537220945);
  });
});
