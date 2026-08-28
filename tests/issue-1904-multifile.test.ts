// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileMultiSource } from "../src/compiler.js";

describe("#1904 multi-source native Array.isArray", () => {
  it("finalizes the array predicate over a recursively decoded any[]", async () => {
    const result = await compileMultiSource(
      {
        "decoder.ts": `
          export function decode(value: any[]): any {
            const tag = value[0];
            if (tag === "d" || tag === "s") return value[1];
            if (tag === "a") {
              const decoded: any[] = [];
              for (let index = 0; index < value[1].length; index++) {
                decoded[index] = decode(value[1][index]);
              }
              return decoded;
            }
            return undefined;
          }
        `,
        "entry.ts": `
          import { decode } from "./decoder.ts";

          export function test(): number {
            const packet: any[] = ["a", [["d", 1], ["s", "two"]]];
            const decoded: any = decode(packet);
            if (!Array.isArray(decoded)) return -1;
            if (decoded.length !== 2) return -2;
            if (decoded[0] !== 1 || decoded[1] !== "two") return -3;
            return decoded.length;
          }
        `,
      },
      "entry.ts",
      {
        target: "standalone",
        platform: "deno",
        allowJs: true,
        skipSemanticDiagnostics: true,
      },
      undefined,
      { "entry.ts": { "./decoder.ts": "decoder.ts" } },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(2);
  });

  it("finalizes dynamic array reads and own-key enumeration", async () => {
    const result = await compileMultiSource(
      {
        "reflection.ts": `
          export function getNamed(target: any, key: any): any {
            return target[key];
          }

          export function setNamed(target: any, key: any, value: any): void {
            target[key] = value;
          }

          export function ownKeys(target: any): string[] {
            return Object.keys(target);
          }
        `,
        "entry.ts": `
          import { getNamed, ownKeys, setNamed } from "./reflection.ts";

          export function test(): number {
            const list: any = [7, 8];
            if (getNamed(list, "length") !== 2) return -1;
            if (getNamed(list, "0") !== 7) return -2;
            setNamed(list, 1, 9);
            if (getNamed(list, "1") !== 9) return -3;
            setNamed(list, "length", 1);
            if (getNamed(list, "length") !== 1) return -4;
            const keys = ownKeys(list);
            if (keys.length !== 1 || keys[0] !== "0") return -5;

            const arrayLike = { 0: 11, 1: 12, length: 2 };
            const reduced: any = Array.prototype.reduce.call(
              arrayLike,
              (sum: any, value: any) => sum + value,
              0,
            );
            if (reduced !== 23) return -6;
            return 1;
          }
        `,
      },
      "entry.ts",
      {
        target: "standalone",
        platform: "deno",
        allowJs: true,
        skipSemanticDiagnostics: true,
      },
      undefined,
      { "entry.ts": { "./reflection.ts": "reflection.ts" } },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });
});
