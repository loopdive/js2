// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

describe("#1058 module initializer source order", () => {
  it("interleaves class static initializers with module statements across files", async () => {
    const result = await compileMulti(
      {
        "./dependency.ts": `
          export let order = 0;
          order = order * 10 + 1;

          export class Dependency {
            static value = order = order * 10 + 2;

            static {
              order = order * 10 + 3;
            }
          }

          order = order * 10 + 4;
        `,
        "./entry.ts": `
          import { order } from "./dependency.js";

          class Entry {
            static value = order * 10 + 5;
          }

          export function test(): number {
            return Entry.value;
          }
        `,
      },
      "./entry.ts",
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports.test as () => number)()).toBe(12345);
  });
});
