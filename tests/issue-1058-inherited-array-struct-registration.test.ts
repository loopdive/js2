// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

describe("#1058 inherited array signature registration", () => {
  it("keeps an optional NodeArray-like parameter on the vec carrier", async () => {
    const result = await compile(
      `
        export function probe(value: number): number {
          interface Node {
            kind: number;
          }

          interface NodeArray<T extends Node> extends Array<T> {
            pos: number;
            end: number;
          }

          function sibling(): number {
            return value;
          }

          function count(nodes: NodeArray<Node> | undefined): number {
            return nodes === undefined ? 42 + sibling() : nodes.length;
          }

          const nodes = [{ kind: 1 }] as NodeArray<Node>;
          return count(undefined) + count(nodes);
        }
      `,
      {
        target: "standalone",
        fileName: "issue-1058-inherited-array-struct-registration.ts",
        emitWat: true,
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.wat).not.toMatch(/\(type \$__anon_\d+ \(struct [^\n]*\(field \$pos [^\n]*\(field \$push /);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.probe as (value: number) => number)(3)).toBe(46);
  });
});
