// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, wrapExports } from "../src/index.js";

describe("#1058 array filter structural-union callbacks", () => {
  it("preserves a union member passed to an open structural predicate", async () => {
    const result = await compile(
      `
        interface MapLike<T> { [key: string]: T }
        interface OptionBase { name: string; transpileOptionValue?: boolean }
        interface StringOption extends OptionBase { kind: "string"; value: string }
        interface NumberOption extends OptionBase { kind: "number"; value: number }
        type Option = StringOption | NumberOption;

        const hasOwnProperty = Object.prototype.hasOwnProperty;
        function hasProperty(map: MapLike<any>, key: string): boolean {
          return hasOwnProperty.call(map, key);
        }

        const options: Option[] = [
          { name: "plain", kind: "string", value: "x" },
          { name: "kept", kind: "number", value: 1, transpileOptionValue: true },
        ];
        const selected = options.filter(option => hasProperty(option, "transpileOptionValue"));

        export function count(): number { return selected.length; }
        export function selectedName(): string { return selected[0]?.name ?? ""; }
      `,
      {
        fileName: "issue-1058-array-filter-structural-union.ts",
        target: "gc",
        platform: "node",
        nativeStrings: false,
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });

    expect(exports.count()).toBe(1);
    expect(exports.selectedName()).toBe("kept");
  });
});
