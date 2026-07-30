// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildLandingModuleSizeRows, minifiedJavaScriptByteLength } from "../scripts/lib/landing-module-size.mjs";

describe("displayed Wasmtime module-size artifact", () => {
  it("emits the existing chart schema from same-run artifact byte sizes", () => {
    expect(
      buildLandingModuleSizeRows({
        programId: "fib",
        jsBytes: 123,
        aotBytes: 456,
        interpreterBytes: 3_049,
        engineBytes: 14_817_187,
      }),
    ).toEqual([
      { name: "AOT compiled", path: "fib", value: 456, label: "0.5 kB", jsUs: 123 },
      { name: "Interpreter", path: "fib", value: 3_049, label: "3.0 kB", jsUs: 123 },
      { name: "Engine", path: "fib", value: 14_817_187, label: "14.8 MB", jsUs: 123 },
    ]);
  });

  it("uses a real minified JavaScript byte baseline", async () => {
    const source = `
      export function run(value) {
        const doubled = value * 2;
        return doubled + 1;
      }
    `;
    const minifiedBytes = await minifiedJavaScriptByteLength(source);
    expect(minifiedBytes).toBeGreaterThan(0);
    expect(minifiedBytes).toBeLessThan(Buffer.byteLength(source));
  });
});
