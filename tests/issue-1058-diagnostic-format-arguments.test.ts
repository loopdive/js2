// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each(["direct", "generic", "asserted"])("formats captured diagnostic arguments (%s)", async (checked) => {
  const result = await compile(
    `function checkDefined<T>(value: T | undefined): T {
      if (value === undefined) throw new Error("missing diagnostic argument");
      return value;
    }
    function assertIsDefined<T>(value: T): asserts value is NonNullable<T> {
      if (value === undefined || value === null) throw new Error("missing diagnostic argument");
    }
    function checkedAssert<T>(value: T | null | undefined): T {
      assertIsDefined(value);
      return value;
    }
    function format(text: string, args: (string | number)[]): string {
      return text.replace(/\\{(\\d+)\\}/g, (_match, index: string) => "" + ${checked === "direct" ? "args[+index]" : checked === "generic" ? "checkDefined(args[+index])" : "checkedAssert(args[+index])"});
    }
    function diagnostic(text: string, ...args: (string | number)[]): string { return format(text, args); }
    function forward(text: string, ...args: (string | number)[]): string { return diagnostic(text, ...args); }
    export function run(): number {
      if (forward("Cannot redeclare '{0}'.", "x") !== "Cannot redeclare 'x'.") return -1;
      if (forward("{1}/{0}/{1}", "x", 42) !== "42/x/42") return -2;
      return 1;
    }`,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as () => number)()).toBe(1);
});
