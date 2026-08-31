// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Host class objects use a WasmGC carrier rather than a native JavaScript
// constructor. Static misses must still delegate to a host builtin parent with
// the child class as the receiver (Annex B RegExp accessors intentionally
// reject that receiver).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SOURCE = `
  class MyRegExp extends RegExp {}
  class Plain {}

  export function test(): number {
    let thrown = 0;
    for (let i = 1; i <= 9; i++) {
      try {
        MyRegExp["$" + i];
      } catch (error) {
        if (error instanceof TypeError) thrown++;
      }
    }
    return thrown;
  }

  export function controls(): number {
    let directThrows = 0;
    try {
      RegExp["$1"];
    } catch {
      directThrows++;
    }
    return directThrows * 10 + (typeof Plain["$1"] === "undefined" ? 1 : 0);
  }
`;

describe("host class static inheritance", () => {
  it("delegates RegExp legacy static reads with the subclass receiver", async () => {
    const result = await compile(SOURCE, {
      fileName: "regexp-host-static-inheritance.ts",
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const importObject = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, importObject);
    (importObject as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports as { test: () => number }).test()).toBe(9);
    expect((instance.exports as { controls: () => number }).controls()).toBe(1);
  });
});
