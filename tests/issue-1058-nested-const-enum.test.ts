// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

describe("#1058 nested const enums", () => {
  it("erases a function-local const enum and folds its numeric and string members", async () => {
    const result = await compile(`
      export function test(): number {
        const enum BoxCharacter {
          horizontal = "----",
        }
        const enum Connection {
          Up = 1 << 0,
          Down = 1 << 1,
          UpDown = Up | Down,
        }
        return BoxCharacter.horizontal.length * 10 + Connection.UpDown;
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setInstance?.(instance);
    expect((instance.exports.test as () => number)()).toBe(43);
  });
});
