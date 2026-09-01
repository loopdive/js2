// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, wrapExports } from "../src/index.js";

describe("#1058 NodeArray vec projection", () => {
  it("preserves expando metadata while widening the element carrier", async () => {
    const result = await compile(
      `
        interface Node { kind: number; }
        interface DerivedNode extends Node { value: number; }
        interface NodeArray<T extends Node> extends ReadonlyArray<T> {
          readonly pos: number;
          readonly end: number;
          readonly hasTrailingComma: boolean;
        }
        interface MutableNodeArray<T extends Node> extends Array<T> {
          pos: number;
          end: number;
          hasTrailingComma: boolean;
        }

        export function makeDerived(): NodeArray<DerivedNode> {
          const nodes = [{ kind: 7, value: 11 }] as MutableNodeArray<DerivedNode>;
          nodes.pos = 13;
          nodes.end = 29;
          nodes.hasTrailingComma = true;
          return nodes;
        }

        function widen(nodes: readonly DerivedNode[]): readonly Node[] {
          return nodes;
        }

        function forEachChild(
          node: { children: NodeArray<DerivedNode> },
          cbNode: (node: Node) => void,
          cbNodes?: (nodes: NodeArray<Node>) => void,
        ): void {
          if (cbNodes) cbNodes(widen(node.children) as NodeArray<Node>);
          else for (const child of node.children) cbNode(child);
        }

        function fingerprint(nodes: NodeArray<Node>): number {
          return nodes.length * 100_000 + nodes[0]!.kind * 10_000 + nodes.pos * 100 + nodes.end * 10
            + (nodes.hasTrailingComma ? 1 : 0);
        }

        function fingerprintWidened(nodes: readonly unknown[]): number {
          return fingerprint(nodes as NodeArray<Node>);
        }

        export function getFingerprintWidened() {
          return fingerprintWidened;
        }

        function fingerprintFromExtern(value: unknown): number {
          return fingerprint(value as NodeArray<Node>);
        }

        export function getFingerprintFromExtern() {
          return fingerprintFromExtern;
        }

        export function sourceMetadata(): number {
          return fingerprint(makeDerived());
        }

        export function test(): number {
          const nodes = widen(makeDerived()) as NodeArray<Node>;
          return fingerprint(nodes);
        }

        export function callbackTest(): number {
          let result = 0;
          forEachChild(
            { children: makeDerived() },
            () => {},
            nodes => {
              result = fingerprint(nodes);
            },
          );
          return result;
        }
      `,
      {
        fileName: "issue-1058-node-array-vec-projection.ts",
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
      test(): number;
      callbackTest(): number;
      sourceMetadata(): number;
    };
    expect(exports.sourceMetadata()).toBe(171591);
    expect(exports.test()).toBe(171591);
    expect(exports.callbackTest()).toBe(171591);

    // The parser's NodeFactory methods cross this host-facing dispatcher. An
    // erased readonly-array formal forces the incoming ref-element vec through
    // __vec_from_extern's cross-representation branch; the projected vec must
    // inherit the NodeArray sidecar just like the typed vec-to-vec path above.
    const rawExports = instance.exports as unknown as {
      makeDerived(): unknown;
      getFingerprintFromExtern(): unknown;
      getFingerprintWidened(): unknown;
      __call_fn_method_1(receiver: unknown, closure: unknown, value: unknown): number;
    };
    expect(rawExports.__call_fn_method_1(undefined, rawExports.getFingerprintWidened(), rawExports.makeDerived())).toBe(
      171591,
    );
    const mirroredNodes = (imports as { env: { __make_iterable(value: unknown): unknown } }).env.__make_iterable(
      rawExports.makeDerived(),
    );
    expect(rawExports.__call_fn_method_1(undefined, rawExports.getFingerprintWidened(), mirroredNodes)).toBe(171591);
    expect(rawExports.__call_fn_method_1(undefined, rawExports.getFingerprintFromExtern(), mirroredNodes)).toBe(171591);
  });
});
