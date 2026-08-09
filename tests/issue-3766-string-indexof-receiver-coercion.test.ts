// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

type Target = "gc" | "standalone";

async function run(source: string, target: Target): Promise<number> {
  const result = await compile(source, {
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  if (target === "standalone") expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports.test as () => number)();
}

describe.each<Target>(["gc", "standalone"])("#3766 String receiver coercion (%s)", (target) => {
  it("treats a void toString result as the primitive undefined", async () => {
    expect(
      await run(
        `
          var value = { toString: function () {} };
          var observed = String(value).indexOf(void 0);
          export function test(): number { return observed; }
        `,
        target,
      ),
    ).toBe(0);
  });

  it("falls through a non-callable toString to a void valueOf", async () => {
    expect(
      await run(
        `
          var value = { valueOf: function () {}, toString: void 0 };
          var observed = new String(value).indexOf(function () {}());
          export function test(): number { return observed; }
        `,
        target,
      ),
    ).toBe(0);
  });

  it("invokes the successful conversion method exactly once", async () => {
    expect(
      await run(
        `
          var calls = 0;
          var value = {
            toString: function () {
              calls++;
            }
          };
          var text = String(value);
          export function test(): number {
            return text.indexOf(void 0) === 0 && calls === 1 ? 1 : 0;
          }
        `,
        target,
      ),
    ).toBe(1);
  });

  it("keeps ordinary string-returning toString precedence", async () => {
    expect(
      await run(
        `
          var calls = 0;
          var valueOfCalls = 0;
          var value = {
            toString: function () {
              calls++;
              return "ok";
            },
            valueOf: function () {
              valueOfCalls++;
              return "wrong";
            }
          };
          var observed = new String(value).indexOf("ok");
          export function test(): number {
            return observed === 0 && calls === 1 && valueOfCalls === 0 ? 1 : 0;
          }
        `,
        target,
      ),
    ).toBe(1);
  });

  it("falls through an object-returning toString to a numeric valueOf", async () => {
    expect(
      await run(
        `
          var value = {
            toString: function () {
              return new Object();
            },
            valueOf: function () {
              return 1;
            }
          };
          var observed = String(value);
          export function test(): number {
            return observed === "1" ? 1 : 0;
          }
        `,
        target,
      ),
    ).toBe(1);
  });
});

describe("#3762 merge-queue ToPrimitive regression controls", () => {
  it("classifies an opaque toString result before falling through to valueOf", async () => {
    expect(
      await run(
        `
          var calls = 0;
          var value = {
            toString: function () {
              return function returnedObject() {};
            },
            valueOf: function () {
              calls++;
              return "ok";
            }
          };
          var observed = String(value).indexOf("ok");
          export function test(): number {
            return observed === 0 && calls === 1 ? 1 : 0;
          }
        `,
        "gc",
      ),
    ).toBe(1);
  });

  it.runIf(existsSync(resolve("test262")))(
    "keeps BigInt on default-hint valueOf-before-toString ordering",
    async () => {
      const result = await runTest262File(
        resolve("test262/test/built-ins/BigInt/call-value-of-when-to-string-present.js"),
        "built-ins/BigInt",
      );
      expect(result.status, String(result.error ?? result.reason ?? "")).toBe("pass");
    },
    60_000,
  );

  it.runIf(existsSync(resolve("test262")))(
    "falls through an object-returning toString to valueOf",
    async () => {
      const result = await runTest262File(
        resolve("test262/test/built-ins/String/S15.5.2.1_A1_T13.js"),
        "built-ins/String",
      );
      expect(result.status, String(result.error ?? result.reason ?? "")).toBe("pass");
    },
    60_000,
  );

  it.runIf(existsSync(resolve("test262")))(
    "falls through an object-returning toString to a numeric valueOf",
    async () => {
      const result = await runTest262File(resolve("test262/test/built-ins/String/S8.12.8_A2.js"), "built-ins/String");
      expect(result.status, String(result.error ?? result.reason ?? "")).toBe("pass");
    },
    60_000,
  );
});
