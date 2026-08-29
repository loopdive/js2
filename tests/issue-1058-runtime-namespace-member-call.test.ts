// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, compileMulti } from "../src/index.js";

async function instantiate(result: Awaited<ReturnType<typeof compile>>) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return instance.exports as Record<string, Function>;
}

describe("#1058 runtime namespace member calls", () => {
  it("resolves a local namespace function without materializing a null receiver", async () => {
    const result = await compile(`
      namespace Debug {
        export function assert(value: boolean): void {
          if (!value) throw new Error("assertion failed");
        }
      }

      export function test(): number {
        Debug.assert(true);
        return 42;
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(42);
  });

  it("initializes and preserves mutable state declared inside a runtime namespace", async () => {
    const result = await compile(`
      namespace Counter {
        var value = 40;
        export function next(): number { return ++value; }
      }

      export function test(): number {
        return Counter.next() * 100 + Counter.next();
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(4142);
  });

  it("keeps namespace lexical and destructured values separate from same-named top-level bindings", async () => {
    const result = await compile(`
      let NodeConstructor = 100;
      const factory = 7;

      namespace Parser {
        let NodeConstructor = 40;
        const { factory } = { factory: 2 };

        export function run(): number {
          NodeConstructor += factory;
          return NodeConstructor;
        }
      }

      export function test(): number {
        return Parser.run() + Parser.run() + NodeConstructor + factory;
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(193);
  });

  it("stores a normalized parameter in same-named namespace parser state", async () => {
    const result = await compile(`
      function normalizePath(path: string): string {
        return path.replace(/\\\\/g, "/");
      }

      namespace Parser {
        var fileName: string;

        function initializeState(_fileName: string): void {
          fileName = normalizePath(_fileName);
        }

        function parseSourceFileWorker(): number {
          return fileName.length;
        }

        export function parseSourceFile(fileName: string): number {
          initializeState(fileName);
          return parseSourceFileWorker();
        }
      }

      export function test(): number {
        return Parser.parseSourceFile("input.ts");
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(8);
  });

  it("keeps a same-named parameter assignment local to the namespace function", async () => {
    const result = await compile(`
      namespace Parser {
        var fileName = "module.ts";

        function normalize(fileName: string): string {
          fileName = "local.ts";
          return fileName;
        }

        export function run(): string {
          return normalize("input.ts") + ":" + fileName;
        }
      }

      export function test(): string {
        return Parser.run();
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe("local.ts:module.ts");
  });

  it("keeps simple writes to same-named sibling namespace state isolated", async () => {
    const result = await compile(`
      namespace Left {
        var value = 1;
        export function set(): void { value = 2; }
        export function get(): number { return value; }
      }

      namespace Right {
        var value = 40;
        export function set(): void { value = 41; }
        export function get(): number { return value; }
      }

      export function test(): number {
        Left.set();
        Right.set();
        return Left.get() * 100 + Right.get();
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(241);
  });

  it("allows a nested namespace function to write ancestor namespace state", async () => {
    const result = await compile(`
      namespace Parser {
        var state = 1;

        export namespace Worker {
          export function setState(): void { state = 42; }
        }

        export function run(): number {
          Worker.setState();
          return state;
        }
      }

      export function test(): number {
        return Parser.run();
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(42);
  });

  it("isolates namespace call metadata from a same-named capturing nested function", async () => {
    const result = await compile(`
      namespace Parser {
        function invoke(callback: () => number): number { return callback(); }
        export function lookAhead(callback: () => number): number {
          return invoke(callback) + 1;
        }
      }

      export function test(): number {
        let captured = 10;
        function lookAhead(callback: () => number): number {
          return captured + callback();
        }
        const local = lookAhead(() => 1);
        return local * 100 + Parser.lookAhead(() => 2);
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(1103);
  });

  it("projects ancestor namespace bindings into nested namespace functions", async () => {
    const result = await compile(`
      namespace Parser {
        let state = 40;

        function skipWhitespace(): number {
          return ++state;
        }

        function lookAhead(callback: () => number): number {
          return callback() + state;
        }

        export namespace JSDocParser {
          export function parse(): number {
            return lookAhead(() => skipWhitespace());
          }
        }

        export function parseJSDoc(): number {
          return JSDocParser.parse();
        }
      }

      export function test(): number {
        return Parser.parseJSDoc();
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(82);
  });

  it("captures an owner local before considering same-named projected function bindings", async () => {
    const result = await compile(`
      function token(): number { return 8; }

      export function test(): number {
        let token = 7;
        function first(): number { return second(); }
        function second(): number { return token; }
        return first() * 10 + token;
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(77);
  });

  it("resolves a named namespace import through a pure barrel", async () => {
    const result = await compileMulti(
      {
        "./entry.ts": `
          import { run } from "./consumer.js";
          export function test(): number { return run(); }
        `,
        "./consumer.ts": `
          import { Debug } from "./barrel.js";
          export function run(): number {
            Debug.assert(true);
            return 42;
          }
        `,
        "./barrel.ts": `export * from "./debug.js";`,
        "./debug.ts": `
          export namespace Debug {
            export function assert(value: boolean): void {
              if (!value) throw new Error("assertion failed");
            }
          }
        `,
      },
      "./entry.ts",
      { resolve: { consumerDrivenBarrels: true } },
    );

    const exports = await instantiate(result);
    expect(exports.test()).toBe(42);
  });

  it("reads an exported namespace variable through a pure barrel during module initialization", async () => {
    const result = await compileMulti(
      {
        "./entry.ts": `
          import { observed } from "./scanner.js";
          export function test(): number { return observed; }
        `,
        "./scanner.ts": `
          import { Debug } from "./barrel.js";
          export const observed = Debug.isDebugging ? 1 : 42;
        `,
        "./barrel.ts": `export * from "./debug.js";`,
        "./debug.ts": `
          export namespace Debug {
            export let isDebugging = false;
          }
        `,
      },
      "./entry.ts",
      { resolve: { consumerDrivenBarrels: true } },
    );

    const exports = await instantiate(result);
    expect(exports.test()).toBe(42);
  });

  it("preserves the TDZ for an exported namespace variable read through the namespace", async () => {
    const result = await compile(`
      namespace Values {
        export const observed = Values.later;
        export let later = 42;
      }

      export function test(): number {
        return Values.observed;
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    await expect(WebAssembly.instantiate(result.binary, result.importObject ?? {})).rejects.toBeInstanceOf(
      WebAssembly.Exception,
    );
  });

  it("keeps same-named namespace and top-level live bindings isolated", async () => {
    const result = await compile(`
      let value = 7;

      namespace Left {
        export let value = 1;
      }

      namespace Right {
        export let value = 40;
        export function bump(): void { value++; }
      }

      export function test(): number {
        Right.bump();
        return Left.value * 10000 + Right.value * 100 + value;
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(14107);
  });

  it("reads a namespace constructor assigned after an object arrow is created", async () => {
    const result = await compile(`
      interface Token { kind: number }

      class LiveToken implements Token {
        kind: number;
        constructor(kind: number) { this.kind = kind; }
      }

      class TopLevelToken implements Token {
        kind: number;
        constructor(kind: number) { this.kind = kind + 1000; }
      }

      var TokenConstructor: new (kind: number) => Token = TopLevelToken;

      namespace Parser {
        var TokenConstructor: new (kind: number) => Token;

        var baseFactory = {
          createBaseTokenNode: (kind: number): Token => new TokenConstructor(kind),
        };

        function initializeState(): void {
          TokenConstructor = LiveToken;
        }

        export function run(): number {
          initializeState();
          return baseFactory.createBaseTokenNode(42).kind;
        }
      }

      export function test(): number {
        return Parser.run();
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(42);
  });

  it("constructs a late-assigned function value through a namespace factory", async () => {
    const result = await compile(`
      interface ReadonlyTextRange {
        readonly pos: number;
        readonly end: number;
      }

      interface Token extends ReadonlyTextRange {
        readonly kind: number;
        readonly flags: number;
        readonly parent: Token;
        original?: Token;
        emitNode?: unknown;
      }

      type Mutable<T extends object> = { -readonly [P in keyof T]: T[P] };

      function LiveToken(this: Mutable<Token>, kind: number): void {
        this.pos = 0;
        this.end = 0;
        this.kind = kind;
        this.flags = 0;
        this.parent = undefined!;
        this.original = undefined;
        this.emitNode = undefined;
      }

      function TopLevelToken(this: Mutable<Token>, kind: number): void {
        this.pos = 0;
        this.end = 0;
        this.kind = kind + 1000;
        this.flags = 0;
        this.parent = undefined!;
        this.original = undefined;
        this.emitNode = undefined;
      }

      var TokenConstructor: new (kind: number) => Token = TopLevelToken as any;
      const objectAllocator = {
        getTokenConstructor: (): new (kind: number) => Token => LiveToken as any,
      };

      namespace Parser {
        var TokenConstructor: new (kind: number) => Token;

        function countNode(node: Token): Token { return node; }

        var baseFactory = {
          createBaseTokenNode: (kind: number): Token => countNode(new TokenConstructor(kind)),
        };

        function initializeState(): void {
          TokenConstructor = objectAllocator.getTokenConstructor();
        }

        export function run(): number {
          initializeState();
          return baseFactory.createBaseTokenNode(42).kind;
        }
      }

      export function test(): number {
        return Parser.run();
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(42);
  });
});
