// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each(["", "NamedMap", "Named_Map"])(
  "constructs a prewarmed Map subclass with lexical class name '%s'",
  async (name) => {
    const result = await compile(
      `
    const existing = new Map();
    export function probe():number {
      const SafeMap = class ${name} extends Map {
        constructor(input:any) { if(input==null) { super(); return; } super(input); }
      };
      const value = new SafeMap(undefined);
      value.set("answer", 42);
      return value.get("answer") + existing.size;
    }
  `,
      { target: "standalone", platform: "deno" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
    try {
      expect((instance.exports.probe as () => number)()).toBe(42);
    } catch (error: any) {
      if (error.getArg && instance.exports.__exn_render_prepare) {
        const payload = error.getArg(instance.exports.__exn_tag, 0);
        const length = (instance.exports.__exn_render_prepare as (payload: unknown) => number)(payload);
        const char = instance.exports.__exn_render_char as (index: number) => number;
        throw new Error(Array.from({ length }, (_, index) => String.fromCharCode(char(index))).join(""));
      }
      throw error;
    }
  },
);
