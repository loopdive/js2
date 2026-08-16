import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import type { CompileResult } from "../src/index.js";

/**
 * (#4507) Instantiate through the compiler's own import object (#1667).
 *
 * Each site here previously passed a hand-rolled `{ env: { console_log_* } }`,
 * which omits the `string_constants` namespace, so every test in this file died
 * at INSTANTIATION with
 *   Import #0 module="string_constants": module is not an object or function
 * before any assertion ran. The console stubs are kept as a *fallback* overlay:
 * the real host runtime's `env` is spread last so it wins wherever it provides
 * a binding.
 */
async function instantiate(result: CompileResult): Promise<WebAssembly.Instance> {
  const imports = (result.importObject ?? {}) as WebAssembly.Imports & {
    __setInstance?: (instance: WebAssembly.Instance) => void;
  };
  imports.env = {
    console_log_number: () => {},
    console_log_bool: () => {},
    ...((imports.env ?? {}) as Record<string, unknown>),
  } as unknown as WebAssembly.ModuleImports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.__setInstance?.(instance);
  return instance;
}

describe("ClassExpression in various positions (#330)", () => {
  it("class expression in variable initializer with new", async () => {
    const result = await compile(`
      const C = class {
        x: number;
        constructor(x: number) {
          this.x = x;
        }
        get(): number {
          return this.x;
        }
      };
      export function test(): number {
        const obj = new C(42);
        return obj.get();
      }
    `);
    expect(result.success, `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`).toBe(
      true,
    );

    const instance = await instantiate(result);
    const exports = instance.exports as any;
    expect(exports.test()).toBe(42);
  });

  it("named class expression", async () => {
    const result = await compile(`
      const MyClass = class MyClassExpr {
        n: number;
        constructor(n: number) {
          this.n = n;
        }
        getN(): number {
          return this.n;
        }
      };
      export function test(): number {
        const obj = new MyClass(10);
        return obj.getN();
      }
    `);
    expect(result.success, `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`).toBe(
      true,
    );

    const instance = await instantiate(result);
    const exports = instance.exports as any;
    expect(exports.test()).toBe(10);
  });

  it("class expression with extends", async () => {
    const result = await compile(`
      class Base {
        x: number;
        constructor(x: number) {
          this.x = x;
        }
        getX(): number {
          return this.x;
        }
      }
      const Child = class extends Base {
        y: number;
        constructor(x: number, y: number) {
          super(x);
          this.y = y;
        }
        sum(): number {
          return this.x + this.y;
        }
      };
      export function test(): number {
        const c = new Child(3, 4);
        return c.sum();
      }
    `);
    expect(result.success, `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`).toBe(
      true,
    );

    const instance = await instantiate(result);
    const exports = instance.exports as any;
    expect(exports.test()).toBe(7);
  });

  it("class expression inside a function body", async () => {
    const result = await compile(`
      export function test(): number {
        const Inner = class {
          v: number;
          constructor(v: number) {
            this.v = v;
          }
          getV(): number {
            return this.v;
          }
        };
        const obj = new Inner(55);
        return obj.getV();
      }
    `);
    expect(result.success, `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`).toBe(
      true,
    );

    const instance = await instantiate(result);
    const exports = instance.exports as any;
    expect(exports.test()).toBe(55);
  });

  it("class expression in new expression (inline)", async () => {
    const result = await compile(`
      export function test(): number {
        const obj = new (class {
          value: number;
          constructor(v: number) {
            this.value = v;
          }
          getValue(): number {
            return this.value;
          }
        })(100);
        return obj.getValue();
      }
    `);
    expect(result.success, `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`).toBe(
      true,
    );

    const instance = await instantiate(result);
    const exports = instance.exports as any;
    expect(exports.test()).toBe(100);
  });

  it("class expression with static-like pattern (multiple instances)", async () => {
    const result = await compile(`
      const Pair = class {
        a: number;
        b: number;
        constructor(a: number, b: number) {
          this.a = a;
          this.b = b;
        }
        sum(): number {
          return this.a + this.b;
        }
      };
      export function test(): number {
        const p1 = new Pair(1, 2);
        const p2 = new Pair(10, 20);
        return p1.sum() + p2.sum();
      }
    `);
    expect(result.success, `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`).toBe(
      true,
    );

    const instance = await instantiate(result);
    const exports = instance.exports as any;
    expect(exports.test()).toBe(33);
  });

  it("class expression with no constructor", async () => {
    const result = await compile(`
      const Simple = class {
        x: number = 5;
        getX(): number {
          return this.x;
        }
      };
      export function test(): number {
        const obj = new Simple();
        return obj.getX();
      }
    `);
    expect(result.success, `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`).toBe(
      true,
    );

    const instance = await instantiate(result);
    const exports = instance.exports as any;
    expect(exports.test()).toBe(5);
  });

  it("class expression assigned via binary expression with known type", async () => {
    // Use a class expression assigned via = but with proper type inference
    const result = await compile(`
      class Base {
        val: number;
        constructor(v: number) {
          this.val = v;
        }
        getVal(): number {
          return this.val;
        }
      }
      const Derived = class extends Base {
        constructor(v: number) {
          super(v * 2);
        }
      };
      export function test(): number {
        const obj = new Derived(21);
        return obj.getVal();
      }
    `);
    expect(result.success, `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`).toBe(
      true,
    );

    const instance = await instantiate(result);
    const exports = instance.exports as any;
    expect(exports.test()).toBe(42);
  });
});
