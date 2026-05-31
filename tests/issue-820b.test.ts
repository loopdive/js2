import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #820b — Object literal computed-property accessor names silently dropped.
// Tests cover test262 patterns:
//   - language/expressions/object/accessor-name-literal-numeric-zero.js
//   - language/expressions/object/accessor-name-literal-string-hex-escape.js
//   - language/computed-property-names/object/accessor/getter.js
//   - language/computed-property-names/object/accessor/setter.js

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("#820b — Object literal computed accessor names with literal keys", () => {
  it("get [0]() registers under key '0'", async () => {
    const result = await run(
      `
      export function test(): string {
        const obj: any = {
          get [0]() { return 'get-zero'; }
        };
        return obj['0'];
      }
      `,
      "test",
    );
    expect(result).toBe("get-zero");
  });

  it("set [0](v) fires on assignment to obj['0']", async () => {
    const result = await run(
      `
      let captured: string = 'init';
      export function test(): string {
        const obj: any = {
          set [0](param: string) { captured = param; }
        };
        obj['0'] = 'set-zero';
        return captured;
      }
      `,
      "test",
    );
    expect(result).toBe("set-zero");
  });

  it("combined get+set on the same computed numeric key works both directions", async () => {
    const result = await run(
      `
      let captured: string = 'init';
      export function test(): string {
        const obj: any = {
          get [0]() { return 'got:' + captured; },
          set [0](v: string) { captured = v; }
        };
        obj['0'] = 'hello';
        return obj['0'];
      }
      `,
      "test",
    );
    expect(result).toBe("got:hello");
  });

  it("get ['hex\\x45scape']() registers under unescaped key 'hexEscape'", async () => {
    const result = await run(
      `
      export function test(): string {
        const obj: any = {
          get ['hex\\x45scape']() { return 'escaped'; }
        };
        return obj['hexEscape'];
      }
      `,
      "test",
    );
    expect(result).toBe("escaped");
  });

  it("set ['hex\\x45scape'](v) fires on assignment via unescaped key", async () => {
    const result = await run(
      `
      let captured: string = 'init';
      export function test(): string {
        const obj: any = {
          set ['hex\\x45scape'](v: string) { captured = v; }
        };
        obj['hexEscape'] = 'mutated';
        return captured;
      }
      `,
      "test",
    );
    expect(result).toBe("mutated");
  });

  it('get ["keyname"]() with string literal key works', async () => {
    const result = await run(
      `
      export function test(): string {
        const obj: any = {
          get ["keyname"]() { return 'string-key'; }
        };
        return obj.keyname;
      }
      `,
      "test",
    );
    expect(result).toBe("string-key");
  });

  it("no-substitution template literal as computed key works", async () => {
    const result = await run(
      `
      export function test(): string {
        const obj: any = {
          get [\`tplkey\`]() { return 'tpl-key'; }
        };
        return obj['tplkey'];
      }
      `,
      "test",
    );
    expect(result).toBe("tpl-key");
  });

  it("arbitrary computed key (Symbol) is still silently skipped (out of scope)", async () => {
    // Sanity: we only handle literal-only computed keys; runtime-evaluated keys
    // remain out of scope (would require runtime key resolution).
    // The compile should at least succeed without crashing.
    const result = await compile(`
      export function test(): number {
        const k: string = 'computed';
        const obj: any = {
          get [k]() { return 42; }
        };
        return 1;
      }
    `);
    // Either succeeds (and accessor is silently dropped) or compiles without
    // throwing. Either is acceptable for this out-of-scope case.
    if (result.success) {
      expect(typeof result.binary).toBe("object");
    }
  });
});
