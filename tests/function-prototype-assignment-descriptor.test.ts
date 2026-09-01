// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("standalone ordinary-function prototype assignment", () => {
  it("preserves descriptor flags and refuses deletion through an erased alias", async () => {
    const result = await compile(
      `
        function F() {}
        const alias: any = F;
        const first = { marker: 1 };
        const second = { marker: 2 };
        alias.prototype = first;
        alias.prototype = second;
        const arrow: any = () => 1;
        const bound: any = alias.bind(null);
        export function test(): number {
          const d = Object.getOwnPropertyDescriptor(alias, "prototype");
          let mask = 0;
          if (d !== undefined) mask += 1;
          if (d !== undefined && d.value === second) mask += 2;
          if (d !== undefined && d.writable === true) mask += 4;
          if (d !== undefined && d.enumerable === false) mask += 8;
          if (d !== undefined && d.configurable === false) mask += 16;
          if (Reflect.deleteProperty(alias, "prototype") === false) mask += 32;
          if (alias.prototype === second) mask += 64;
          if (Object.getOwnPropertyDescriptor(arrow, "prototype") === undefined && Reflect.deleteProperty(arrow, "prototype") === true) mask += 128;
          if (Object.getOwnPropertyDescriptor(bound, "prototype") === undefined && Reflect.deleteProperty(bound, "prototype") === true) mask += 256;
          return mask;
        }
      `,
      { target: "standalone", fileName: "function-prototype-assignment-descriptor.ts", deferTopLevelInit: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as WebAssembly.Exports & { __module_init?: () => void; test: () => number };
    exports.__module_init?.();
    expect(exports.test()).toBe(511);
  });
});
