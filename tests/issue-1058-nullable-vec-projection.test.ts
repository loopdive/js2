// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, wrapExports } from "../src/index.js";

describe("#1058 nullable vec projection", () => {
  it("keeps undefined distinct from a real empty NodeArray", async () => {
    const result = await compile(
      `
        interface Node { kind: number; }
        interface NodeArray<T extends Node> extends Array<T> {
          pos: number;
          end: number;
        }

        function makeEmptyNodeArray(): NodeArray<Node> {
          const values = [] as NodeArray<Node>;
          values.pos = 17;
          values.end = 29;
          return values;
        }

        function maybeNodes(present: boolean): readonly Node[] | undefined {
          return present ? makeEmptyNodeArray() : undefined;
        }

        export function absent(): number {
          return maybeNodes(false) === undefined ? 42 : 0;
        }

        export function sourceMetadata(): number {
          const values = makeEmptyNodeArray();
          return values.length * 10_000 + values.pos * 100 + values.end;
        }

        export function projectedMetadata(): number {
          const values = maybeNodes(true) as NodeArray<Node>;
          return values.length * 10_000 + values.pos * 100 + values.end;
        }

        export function present(): number {
          const values = maybeNodes(true);
          if (values === undefined) return -1;
          return values.length;
        }
      `,
      {
        fileName: "issue-1058-nullable-empty-node-array.ts",
        target: "gc",
        platform: "node",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as {
      absent(): number;
      sourceMetadata(): number;
      projectedMetadata(): number;
      present(): number;
    };

    expect(exports.sourceMetadata()).toBe(1729);
    expect(exports.projectedMetadata()).toBe(1729);
    expect(exports.absent()).toBe(42);
    expect(exports.present()).toBe(0);
  });

  it("preserves undefined and copies present elements into the wider vec carrier", async () => {
    const result = await compile(
      `
        interface Node { kind: number; }
        interface Heritage extends Node { value: number; }

        function asNodes(values: readonly Node[] | undefined): readonly Node[] | undefined {
          return values;
        }

        function forward(values: readonly Heritage[] | undefined): readonly Node[] | undefined {
          return asNodes(values);
        }

        export function absent(): number {
          return forward(undefined) === undefined ? 42 : 0;
        }

        export function present(): number {
          const values = forward([{ kind: 7, value: 11 }, { kind: 3, value: 5 }]);
          if (values === undefined) return -1;
          return values.length * 100 + values[0]!.kind * 10 + values[1]!.kind;
        }
      `,
      {
        fileName: "issue-1058-nullable-vec-projection.ts",
        target: "gc",
        platform: "node",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as {
      absent(): number;
      present(): number;
    };

    expect(exports.absent()).toBe(42);
    expect(exports.present()).toBe(273);
  });
});
