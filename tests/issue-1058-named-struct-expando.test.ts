// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#1058 named structural carrier own properties", () => {
  it.each(["interface", "type"] as const)(
    "retains expandos on a source %s without exposing builtin slots",
    async (declaration) => {
      const shape =
        declaration === "interface"
          ? "interface RecordShape { marker: number }"
          : "type RecordShape = { marker: number };";
      const result = await compile(
        `
      ${shape}
      function create(): RecordShape { return { marker: 7 }; }
      export function probe(): number {
        const record = create();
        const dynamic: any = record;
        dynamic.extra = 11;
        if (dynamic.extra !== 11 || record.marker !== 7) return -1;
        if (!("extra" in dynamic) || !Object.prototype.hasOwnProperty.call(dynamic, "extra")) return -2;
        if (Object.keys(dynamic).length !== 2) return -3;
        if (Object.keys(new Map()).length !== 0 || Object.keys(new Date(0)).length !== 0) return -4;
        return 1;
      }
    `,
        { target: "standalone", experimentalIR: false },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = await WebAssembly.instantiate(module, {});
      expect((instance.exports.probe as () => number)()).toBe(1);
    },
  );
});
