// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileMulti, wrapExports } from "../src/index.js";

describe("#1058 optional callable property ABI", () => {
  it.each(["gc", "standalone"] as const)("preserves optional scalars in %s", async (target) => {
    const result = await compileMulti(
      {
        "./entry.ts": `
        interface Rules { flag(value?: boolean): number; count(value?: number): number; }
        function flag(value?: boolean): number { return value === undefined ? 7 : value ? 3 : 5; }
        function count(value?: number): number { return value === undefined ? 11 : value + 1; }
        const named: Rules = { flag, count };
        const arrows: Rules = {
          flag: (value?: boolean) => value === undefined ? 7 : value ? 3 : 5,
          count: (value?: number) => value === undefined ? 11 : value + 1,
        };
        let effects = 0;
        function observe(): boolean { effects++; return false; }
        function check(rules: Rules): number {
          return rules.flag() + rules.flag(undefined) + rules.flag(true) + rules.flag(observe())
            + rules.count() + rules.count(undefined) + rules.count(0) + rules.count(41);
        }
        export function runNamed(): number { return check(named); }
        export function runArrow(): number { return check(arrows); }
        export function runElements(): number {
          const flags: ((value?: boolean) => number)[] = [flag, arrows.flag];
          return flags[0]() + flags[1](undefined) + flags[0](true) + flags[1](false);
        }
        export function getEffects(): number { return effects; }
      `,
      },
      "./entry.ts",
      { target, ...(target === "gc" ? { platform: "node" as const } : {}), skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    if (target === "standalone") expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports =
      target === "standalone"
        ? (instance.exports as Record<string, () => number>)
        : wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.runNamed()).toBe(87);
    expect(exports.runArrow()).toBe(87);
    expect(exports.runElements()).toBe(22);
    expect(exports.getEffects()).toBe(2);
  });
});
