// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, wrapExports } from "../src/index.js";

async function instantiate(result: Awaited<ReturnType<typeof compile>>) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures });
}

describe("#1058 generic identity returns", () => {
  it("bridges an erased generic identity through a concrete callable property", async () => {
    const result = await compile(`
      interface Box { value: number; }
      interface Rules { apply(value: Box): Box; }

      function identity<T>(value: T): T {
        return value;
      }

      const rules: Rules = { apply: identity };

      export function test(): number {
        return rules.apply({ value: 42 }).value;
      }
    `);

    expect((await instantiate(result)).test()).toBe(42);
  });

  it("does not freeze a T-to-T result to the first sibling layout", async () => {
    const result = await compile(`
      type Mutable<T> = { -readonly [P in keyof T]: T[P] };
      interface Node { readonly pos: number; readonly end: number; }
      interface LeftNode extends Node { left: number; }
      interface RightNode extends Node { right: number; }

      function finishNode<T extends Node>(node: T, pos: number): T {
        (node as Mutable<Node>).pos = pos;
        (node as Mutable<Node>).end = pos + 1;
        return node;
      }

      function makeLeft(): LeftNode { return { pos: 0, end: 0, left: 10 }; }
      function makeRight(): RightNode { return { pos: 0, end: 0, right: 20 }; }

      export function test(): number {
        const left = finishNode(makeLeft(), 1);
        const right = finishNode(makeRight(), 2);
        return left.left + left.pos + left.end + right.right + right.pos + right.end;
      }
    `);

    expect((await instantiate(result)).test()).toBe(38);
  });
});
