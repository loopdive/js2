// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, compileMulti, wrapExports } from "../src/index.js";

describe("#1058 optional method argument padding", () => {
  it("passes undefined for omitted optional numeric arguments", async () => {
    const result = await compile(
      `
        interface ScannerLike {
          setText(text: string | undefined, start?: number, length?: number): void;
          getEnd(): number;
        }

        function createScanner(): ScannerLike {
          var text = "";
          var end = 0;

          function setText(newText: string | undefined, start: number | undefined, length: number | undefined): void {
            text = newText || "";
            end = length === undefined ? text.length : start! + length;
          }

          function getEnd(): number { return end; }

          setText(undefined, undefined, undefined);
          var scanner: ScannerLike = { setText, getEnd };
          return scanner;
        }

        export function test(): number {
          const scanner = createScanner();
          scanner.setText("abcd");
          return scanner.getEnd();
        }
      `,
      { fileName: "issue-1058-optional-method-padding.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.test()).toBe(4);
  });

  it("recognizes undefined in a nullable generic array carrier", async () => {
    const result = await compile(
      `
        interface Item { value: number }

        function append<T extends {}>(to: T[], value: T | undefined): T[];
        function append<T extends {}>(to: T[] | undefined, value: T): T[];
        function append<T extends {}>(to: T[] | undefined, value: T | undefined): T[] | undefined;
        function append<T extends {}>(to: T[] | undefined, value: T | undefined): T[] | undefined {
          if (value === undefined) return to;
          if (to === undefined) return [value];
          to.push(value);
          return to;
        }

        export function test(): number {
          const items = append<Item>(undefined, { value: 7 });
          return items === undefined ? -1 : items[0].value;
        }
      `,
      { fileName: "issue-1058-nullable-generic-array.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.test()).toBe(7);
  });

  it("recognizes undefined across an overloaded generic array import", async () => {
    const result = await compileMulti(
      {
        "./core.ts": `
          export function append<T extends {}>(to: T[], value: T | undefined): T[];
          export function append<T extends {}>(to: T[] | undefined, value: T): T[];
          export function append<T extends {}>(to: T[] | undefined, value: T | undefined): T[] | undefined;
          export function append<T extends {}>(to: T[] | undefined, value: T | undefined): T[] | undefined {
            if (value === undefined) return to;
            if (to === undefined) return [value];
            to.push(value);
            return to;
          }
        `,
        "./scanner.ts": `
          import { append } from "./core.js";
          interface Item { value: number }
          export function test(): number {
            const items = append<Item>(undefined, { value: 7 });
            return items[0].value;
          }
        `,
      },
      "./scanner.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.test()).toBe(7);
  });

  it("keeps TypeScript comment-directive RegExp misses null", async () => {
    const result = await compile(
      `
        const singleLine = /^\\/\\/\\/?\\s*@(ts-expect-error|ts-ignore)/;
        const multiLine = /^(?:\\/|\\*)*\\s*@(ts-expect-error|ts-ignore)/;

        function directive(text: string, regexp: RegExp): number {
          const match = regexp.exec(text);
          if (!match) return 0;
          return match[1] === "ts-ignore" ? 1 : match[1] === "ts-expect-error" ? 2 : 3;
        }

        export function test(): number {
          return directive("// @internal", singleLine) * 1000
            + directive("/** @internal */", multiLine) * 100
            + directive("// @ts-ignore", singleLine) * 10
            + directive("/** @ts-expect-error */", multiLine);
        }
      `,
      { fileName: "issue-1058-comment-directive-regexp.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.test()).toBe(12);
  });

  it("preserves undefined from a nested enum-returning helper when arrays contain holes", async () => {
    const result = await compile(
      `
        const holeWitness = [1, , 3];
        const enum Directive { Ignore = 1, ExpectError = 2 }
        interface Item { type: Directive }

        function append<T extends {}>(to: T[] | undefined, value: T): T[] {
          if (to === undefined) return [value];
          to.push(value);
          return to;
        }

        function scan(text: string): number {
          let items: Item[] | undefined;

          function classify(value: string): Directive | undefined {
            return value === "ignore" ? Directive.Ignore : undefined;
          }

          function appendIfDirective(value: string): void {
            const type = classify(value);
            if (type === undefined) return;
            items = append(items, { type });
          }

          appendIfDirective(text);
          return items === undefined ? 7 : items.length;
        }

        export function test(): number {
          return holeWitness.length + scan("ordinary");
        }
      `,
      { fileName: "issue-1058-nested-mixed-undefined-return.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.test()).toBe(10);
  });

  it("dispatches a later zero-argument boolean callback through a generic helper", async () => {
    const result = await compile(
      `
        function speculationHelper<T>(callback: () => T, isLookahead: boolean): T {
          const result = callback();
          if (!result || isLookahead) {
            // The scanner restores its saved state here.
          }
          return result;
        }

        function lookAhead<T>(callback: () => T): T {
          return speculationHelper(callback, true);
        }

        export function test(): number {
          return lookAhead(() => 3 > 2) ? 7 : 0;
        }
      `,
      { fileName: "issue-1058-generic-zero-arg-boolean-callback.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.test()).toBe(7);
  });

  it("dispatches a later captured zero-argument struct callback through a generic helper", async () => {
    const result = await compile(
      `
        interface NodeLike { kind: number }

        function parser(): number {
          let nextKind = 7;

          function parseListElement<T extends NodeLike | undefined>(parseElement: () => T): T {
            return parseElement();
          }

          function parseStatement(): NodeLike {
            return { kind: nextKind };
          }

          return parseListElement(parseStatement)!.kind;
        }

        export function test(): number {
          return parser();
        }
      `,
      { fileName: "issue-1058-generic-zero-arg-struct-callback.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.test()).toBe(7);
  });
});
