import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

describe("#1058 scanner callback-object captures", () => {
  it("returns a self-referential callback object", async () => {
    const result = await compile(`
      interface Scanner {
        get(): number;
        self(): number;
      }

      function createScanner(): Scanner {
        var pos = 2;
        var scanner: Scanner = {
          get: () => pos,
          self: () => scanner.get(),
        };
        return scanner;
      }

      export function test(): number {
        const scanner = createScanner();
        return scanner.get() * 10 + scanner.self();
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setInstance?.(instance);
    expect((instance.exports.test as Function)()).toBe(22);
  });

  it("does not poison a returned var when a later conditional getter captures it", async () => {
    const result = await compile(`
      interface Scanner { get(): number; }

      function createScanner(debug: boolean): Scanner {
        var scanner: Scanner = { get: () => 42 };
        if (debug) {
          Object.defineProperty(scanner, "debug", {
            get: () => scanner.get(),
          });
        }
        return scanner;
      }

      export function test(debug: boolean): number {
        return createScanner(debug).get();
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setInstance?.(instance);
    expect((instance.exports.test as Function)(false)).toBe(42);
    expect((instance.exports.test as Function)(true)).toBe(42);
  });

  it("keeps retained getter captures isolated and ignores getter-local shadows", async () => {
    const result = await compile(
      `
        interface Scanner {
          getText(): string;
          readonly debug?: number;
        }

        function createScanner(debug: boolean, value: string): Scanner {
          var text = value;
          var scanner: Scanner = { getText: () => text };
          if (debug) {
            Object.defineProperty(scanner, "debug", {
              get: () => {
                const text = scanner.getText();
                return text.length;
              },
            });
          }
          return scanner;
        }

        export function test(): number {
          const first = createScanner(true, "abcd");
          const second = createScanner(false, "x");
          return first.debug! * 10 + second.getText().length;
        }
      `,
      { emitWat: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.wat).not.toContain("$__captured_text");
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setInstance?.(instance);
    expect((instance.exports.test as Function)()).toBe(41);
  });

  it("keeps accessor-bearing factory objects in the externref return ABI", async () => {
    const result = await compile(`
      interface Factory {
        readonly lazy: number;
        make(): number;
      }

      function createFactory(): Factory {
        const read = () => factory.make();
        const factory: Factory = {
          get lazy() { return read(); },
          make() { return 42; },
        };
        return factory;
      }

      export function test(): number {
        const factory = createFactory();
        return factory.make() * 10 + factory.lazy;
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setInstance?.(instance);
    expect((instance.exports.test as Function)()).toBe(462);
  });

  it("keeps a namespace-local scanner distinct from the factory's local scanner", async () => {
    const result = await compile(`
      interface Scanner {
        getText(): string;
        setText(value: string): void;
      }

      function createScanner(debug: boolean): Scanner {
        var text = "";
        function getText(): string { return text; }
        function setText(value: string): void { text = value; }
        var scanner: Scanner = { getText, setText };
        if (debug) {
          Object.defineProperty(scanner, "debug", {
            get: () => scanner.getText().length,
          });
        }
        return scanner;
      }

      namespace Parser {
        var scanner = createScanner(false);

        export function initializeState(sourceText: string): number {
          scanner.setText(sourceText);
          return scanner.getText().length;
        }
      }

      export function test(): number {
        return Parser.initializeState("typescript");
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setInstance?.(instance);
    expect((instance.exports.test as Function)()).toBe(10);
  });

});
