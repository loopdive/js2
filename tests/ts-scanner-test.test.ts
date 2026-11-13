import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports as buildHostImports } from "../src/runtime.js";

// (#7029) This file used to hand-roll the host `env`, listing only the imports
// its programs needed when it was written. The JS-host lane has since grown
// real-semantics imports for the same programs (`__register_prototype` for
// every class, 5ff86e89f5 #5347; real `TypeError` instances via
// `__new_TypeError`, #3287; `__get_undefined`, `__call_function_N`, ...), and
// each one turned a passing test into an instantiate-time LinkError. Link
// against the production resolver instead: it is the import contract the
// compiler actually emits against.
function buildImports(result: CompileResult) {
  return buildHostImports(result.imports, undefined, result.stringPool);
}

async function compileToWasm(source: string) {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

// A minimal scanner/lexer for arithmetic expressions.
// Tests: classes, string.charCodeAt, while loops, switch/case, enums, conditionals.
const scannerSource = `
  enum TokenKind {
    EOF = 0,
    Number = 1,
    Plus = 2,
    Minus = 3,
    Star = 4,
    Slash = 5,
    LParen = 6,
    RParen = 7,
    Whitespace = 8
  }

  class Scanner {
    source: string;
    pos: number;
    len: number;

    constructor(source: string) {
      this.source = source;
      this.pos = 0;
      this.len = source.length;
    }

    isDigit(ch: number): number {
      if (ch >= 48 && ch <= 57) return 1;
      return 0;
    }

    isWhitespace(ch: number): number {
      if (ch === 32) return 1;
      if (ch === 9) return 1;
      if (ch === 10) return 1;
      if (ch === 13) return 1;
      return 0;
    }

    scan(): number {
      if (this.pos >= this.len) return TokenKind.EOF;

      let ch: number = this.source.charCodeAt(this.pos);

      // Skip whitespace
      if (this.isWhitespace(ch) === 1) {
        while (this.pos < this.len && this.isWhitespace(this.source.charCodeAt(this.pos)) === 1) {
          this.pos = this.pos + 1;
        }
        return TokenKind.Whitespace;
      }

      // Number: consume all digits
      if (this.isDigit(ch) === 1) {
        while (this.pos < this.len && this.isDigit(this.source.charCodeAt(this.pos)) === 1) {
          this.pos = this.pos + 1;
        }
        return TokenKind.Number;
      }

      // Single-character tokens
      this.pos = this.pos + 1;
      if (ch === 43) return TokenKind.Plus;
      if (ch === 45) return TokenKind.Minus;
      if (ch === 42) return TokenKind.Star;
      if (ch === 47) return TokenKind.Slash;
      if (ch === 40) return TokenKind.LParen;
      if (ch === 41) return TokenKind.RParen;

      return TokenKind.EOF;
    }
  }
`;

describe("TS Scanner (minimal lexer compiled to Wasm)", () => {
  it("compiles the scanner class without errors", async () => {
    const result = await compile(
      scannerSource +
        `
      export function test(): number { return 1; }
    `,
    );
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
  });

  it("scans a single number token", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function test(): number {
        const s = new Scanner("42");
        return s.scan();
      }
    `,
    );
    // TokenKind.Number = 1
    expect(exports.test()).toBe(1);
  });

  it("scans a plus operator", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function test(): number {
        const s = new Scanner("+");
        return s.scan();
      }
    `,
    );
    // TokenKind.Plus = 2
    expect(exports.test()).toBe(2);
  });

  it("scans parentheses", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function testLParen(): number {
        const s = new Scanner("(");
        return s.scan();
      }
      export function testRParen(): number {
        const s = new Scanner(")");
        return s.scan();
      }
    `,
    );
    // TokenKind.LParen = 6, RParen = 7
    expect(exports.testLParen()).toBe(6);
    expect(exports.testRParen()).toBe(7);
  });

  it("scans multiple tokens from '3+4'", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function testFirst(): number {
        const s = new Scanner("3+4");
        return s.scan();
      }
      export function testSecond(): number {
        const s = new Scanner("3+4");
        s.scan(); // skip 3
        return s.scan();
      }
      export function testThird(): number {
        const s = new Scanner("3+4");
        s.scan(); // skip 3
        s.scan(); // skip +
        return s.scan();
      }
      export function testFourth(): number {
        const s = new Scanner("3+4");
        s.scan(); // 3
        s.scan(); // +
        s.scan(); // 4
        return s.scan();
      }
    `,
    );
    expect(exports.testFirst()).toBe(1); // Number
    expect(exports.testSecond()).toBe(2); // Plus
    expect(exports.testThird()).toBe(1); // Number
    expect(exports.testFourth()).toBe(0); // EOF
  });

  it("scans whitespace-separated tokens", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function testFirst(): number {
        const s = new Scanner("1 + 2");
        return s.scan();
      }
      export function testSecond(): number {
        const s = new Scanner("1 + 2");
        s.scan(); // 1
        return s.scan();
      }
      export function testThird(): number {
        const s = new Scanner("1 + 2");
        s.scan(); // 1
        s.scan(); // whitespace
        return s.scan();
      }
    `,
    );
    expect(exports.testFirst()).toBe(1); // Number
    expect(exports.testSecond()).toBe(8); // Whitespace
    expect(exports.testThird()).toBe(2); // Plus
  });

  it("counts tokens in an expression", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function countTokens(): number {
        const s = new Scanner("(10+20)*3");
        let count: number = 0;
        let tok: number = s.scan();
        while (tok !== TokenKind.EOF) {
          count = count + 1;
          tok = s.scan();
        }
        return count;
      }
    `,
    );
    // "(10+20)*3" => LParen, Number, Plus, Number, RParen, Star, Number = 7 tokens
    expect(exports.countTokens()).toBe(7);
  });

  it("tracks position correctly after scanning", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function posAfterScan(): number {
        const s = new Scanner("123+4");
        s.scan(); // scans "123", pos should be 3
        return s.pos;
      }
    `,
    );
    expect(exports.posAfterScan()).toBe(3);
  });

  it("handles multi-digit numbers correctly", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function testMultiDigit(): number {
        const s = new Scanner("99999");
        s.scan();
        return s.pos;
      }
    `,
    );
    // After scanning "99999", pos should be 5
    expect(exports.testMultiDigit()).toBe(5);
  });

  it("scans all operator types", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function scanOps(): number {
        const s = new Scanner("+-*/");
        let sum: number = 0;
        sum = sum + s.scan(); // Plus=2
        sum = sum + s.scan(); // Minus=3
        sum = sum + s.scan(); // Star=4
        sum = sum + s.scan(); // Slash=5
        return sum;
      }
    `,
    );
    // 2+3+4+5 = 14
    expect(exports.scanOps()).toBe(14);
  });

  it("returns EOF for empty string", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function testEmpty(): number {
        const s = new Scanner("");
        return s.scan();
      }
    `,
    );
    // TokenKind.EOF = 0
    expect(exports.testEmpty()).toBe(0);
  });

  it("handles a realistic expression: (1 + 2) * 3 - 4 / 2", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function countAll(): number {
        const s = new Scanner("(1 + 2) * 3 - 4 / 2");
        let count: number = 0;
        let tok: number = s.scan();
        while (tok !== TokenKind.EOF) {
          if (tok !== TokenKind.Whitespace) {
            count = count + 1;
          }
          tok = s.scan();
        }
        return count;
      }
    `,
    );
    // (1+2)*3-4/2 => LParen,1,+,2,RParen,*,3,-,4,/,2 = 11 non-whitespace tokens
    expect(exports.countAll()).toBe(11);
  });
});
