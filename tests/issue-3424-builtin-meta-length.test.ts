import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#3424 standalone reified builtin metadata", () => {
  it("keeps same-signature names exact and reads each spec arity", async () => {
    const result = await compile(
      `
        export function names(): number {
          const keys: any = Object.keys;
          const ownKeys: any = Reflect.ownKeys;
          const isArray: any = Array.isArray;
          const isFinite: any = Number.isFinite;
          const isInteger: any = Number.isInteger;
          const isSafeInteger: any = Number.isSafeInteger;
          return keys.name === "keys"
            && ownKeys.name === "ownKeys"
            && isArray.name === "isArray"
            && isFinite.name === "isFinite"
            && isInteger.name === "isInteger"
            && isSafeInteger.name === "isSafeInteger"
            ? 1
            : 0;
        }

        export function lengths(): number {
          const keys: any = Object.keys;
          const ownKeys: any = Reflect.ownKeys;
          const isArray: any = Array.isArray;
          const isFinite: any = Number.isFinite;
          const isInteger: any = Number.isInteger;
          const isSafeInteger: any = Number.isSafeInteger;
          return (keys.length === 1 ? 1 : 0)
            + (ownKeys.length === 1 ? 2 : 0)
            + (isArray.length === 1 ? 4 : 0)
            + (isFinite.length === 1 ? 8 : 0)
            + (isInteger.length === 1 ? 16 : 0)
            + (isSafeInteger.length === 1 ? 32 : 0);
        }

        export function deleteLength(): number {
          const fn: any = Number.isInteger;
          const before = fn.length;
          const deleted = delete fn.length;
          return before === 1 && deleted && fn.length === 0 ? 1 : 0;
        }
      `,
      { fileName: "issue-3424.ts", target: "standalone", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, () => number>;
    expect(exports.names!()).toBe(1);
    expect(exports.lengths!()).toBe(63);
    expect(exports.deleteLength!()).toBe(1);
  });
});
