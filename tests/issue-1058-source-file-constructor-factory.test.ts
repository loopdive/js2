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

describe("#1058 late-assigned SourceFile constructor", () => {
  it("uses the runtime constructor's Node receiver in a SourceFile factory", async () => {
    const result = await compile(
      `
        type Mutable<T> = { -readonly [P in keyof T]: T[P] };

        interface Node {
          kind: number;
          pos: number;
          end: number;
        }

        interface Declaration extends Node {
          symbol: number;
        }

        interface LocalsContainer extends Node {
          locals: number;
        }

        interface SourceFile extends Declaration, LocalsContainer {
          statements: number[];
          endOfFileToken: number;
          flags: number;
          text: string;
        }

        interface BaseNodeFactory {
          createBaseSourceFileNode(kind: number): Node;
        }

        function createNodeFactory(baseFactory: BaseNodeFactory) {
          function createSourceFile(statements: number[], endOfFileToken: number, flags: number): SourceFile {
            const node = baseFactory.createBaseSourceFileNode(100) as Mutable<SourceFile>;
            node.statements = statements;
            node.endOfFileToken = endOfFileToken;
            node.flags = flags;
            node.text = "";
            return node;
          }

          return { createSourceFile };
        }

        function RuntimeNode(this: Mutable<Node>, kind: number, pos: number, end: number): void {
          this.kind = kind;
          this.pos = pos;
          this.end = end;
        }

        const objectAllocator = {
          getSourceFileConstructor: (): new (kind: number, pos: number, end: number) => SourceFile => RuntimeNode as any,
        };

        namespace Parser {
          var SourceFileConstructor: new (kind: number, pos: number, end: number) => SourceFile;

          function countNode(node: SourceFile): SourceFile { return node; }

          var baseFactory: BaseNodeFactory = {
            createBaseSourceFileNode: (kind: number): SourceFile => countNode(new SourceFileConstructor(kind, 0, 0)),
          };
          var factory = createNodeFactory(baseFactory);

          function initializeState(): void {
            SourceFileConstructor = objectAllocator.getSourceFileConstructor();
          }

          export function createSourceFile(): SourceFile {
            initializeState();
            return factory.createSourceFile([1, 2], 7, 8);
          }
        }

        export function createSourceFile(
          fileName: string,
          sourceText: string,
          languageVersion: number,
          setParentNodes = false,
          scriptKind?: number,
        ): SourceFile {
          return Parser.createSourceFile();
        }

        export function test(): number {
          const source = createSourceFile("input.ts", "", 99, true, 3);
          return source.kind + source.pos + source.end + source.statements.length + source.endOfFileToken + source.flags;
        }
      `,
      { fileName: "issue-1058-source-file-constructor-factory.ts", skipSemanticDiagnostics: true },
    );
    const exports = await instantiate(result);
    expect(exports.test()).toBe(117);
  });
});
