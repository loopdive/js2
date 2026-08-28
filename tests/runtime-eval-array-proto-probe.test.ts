import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("runtime-eval Array prototype companion probe", () => {
  it("retains Array prototype methods for dynamic vec reads", async () => {
    const result = await compile(
      `
        const prototypes = new WeakMap<object, any>();
        function __runtime_eval_unwrap_interpreted_callback(value: any): any {
          return value;
        }
        export function __runtime_apply_interpreted(): any {
          return undefined;
        }
        function install(realm: object): void {
          prototypes.set(realm, Array.prototype);
        }
        function buildArrayLiteral(elements: any[]): any {
          const result: any[] = [];
          let i = 0;
          while (i < elements.length) {
            result[i] = elements[i];
            i += 1;
          }
          return result;
        }
        function anySet(obj: any, key: any, value: any): any {
          obj[key] = value;
          return value;
        }
        export function test(): number {
          install({});
          const elements: any[] = [];
          const value: any = buildArrayLiteral(elements);
          anySet(value, 0, 1);
          const key: any = "every";
          const registers: any[] = [];
          for (let i = 0; i < 5; i += 1) registers.push(undefined);
          registers[3] = value[key];
          registers[2] = function (): boolean { return true; };
          const method = __runtime_eval_unwrap_interpreted_callback(registers[3]);
          return typeof method === "function" ? 1 : 0;
        }
      `,
      { fileName: "runtime-eval-array-proto-probe.ts", skipSemanticDiagnostics: true, target: "standalone" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("peels a closure stored through an erased runtime-eval slot", async () => {
    const result = await compile(
      `
        function __runtime_eval_unwrap_interpreted_callback(value: any): any {
          return value;
        }
        export function __runtime_apply_interpreted(): any {
          return undefined;
        }
        function callback(): number {
          return 42;
        }
        export function test(): number {
          const slots: any[] = [];
          slots.push(callback);
          const peeled = __runtime_eval_unwrap_interpreted_callback(slots[0]);
          return peeled();
        }
      `,
      { fileName: "runtime-eval-erased-closure.ts", skipSemanticDiagnostics: true, target: "standalone" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(42);
  });
});
