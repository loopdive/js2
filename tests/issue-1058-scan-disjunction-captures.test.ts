// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

describe("#1058 cross-container sibling capture planning", () => {
  it("forwards ancestor-declaration captures through a sibling loop call chain", async () => {
    const result = await compile(
      `
        export function test(): number {
          var token = 1;
          var tokenFlags = 2;

          function write(value: number): void {
            token += value;
            tokenFlags += value * 2;
          }

          function worker(count: number): void {
            function scanDisjunction(): void {
              while (count > 0) {
                scanAlternative();
                count--;
              }
            }

            function scanAlternative(): void {
              scanGroupName();
            }

            function scanGroupName(): void {
              write(3);
            }

            scanDisjunction();
          }

          worker(1);
          return token * 10 + tokenFlags;
        }
      `,
      { target: "standalone", fileName: "issue-1058-scan-disjunction-captures.ts" },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(48);
  });
});
