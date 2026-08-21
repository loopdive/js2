// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";

const ORIGINAL_LINEAR_IR = process.env.JS2WASM_LINEAR_IR;

afterEach(() => {
  if (ORIGINAL_LINEAR_IR === undefined) Reflect.deleteProperty(process.env, "JS2WASM_LINEAR_IR");
  else process.env.JS2WASM_LINEAR_IR = ORIGINAL_LINEAR_IR;
});

async function numberFormatter(overlay: boolean) {
  process.env.JS2WASM_LINEAR_IR = overlay ? "1" : "0";
  const result = await compile(`export function format(x: number): string { return x.toString(); }`, {
    target: "linear",
    fileName: `linear-number-${overlay ? "ir" : "direct"}.ts`,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const memory = instance.exports.memory as WebAssembly.Memory;
  const format = instance.exports.format as (value: number) => number;
  return (value: number): string => {
    const pointer = format(value);
    const buffer = memory.buffer;
    const length = new DataView(buffer).getUint32(pointer + 8, true);
    return new TextDecoder().decode(new Uint8Array(buffer, pointer + 12, length));
  };
}

describe("linear Number::toString", () => {
  it.each([false, true])("matches ECMAScript boundary values with IR overlay=%s", async (overlay) => {
    const format = await numberFormatter(overlay);
    const values = [
      0,
      -0,
      1,
      -42,
      0.1,
      0.1 + 0.2,
      1 / 3,
      1e21,
      1e-7,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
    ];
    for (const value of values) expect(format(value), `value=${String(value)}`).toBe(String(value));
  });

  it("shares the shortest-roundtrip Ryū implementation across deterministic f64 bit patterns", async () => {
    const format = await numberFormatter(true);
    const bits = new DataView(new ArrayBuffer(8));
    let state = 0x1712_3646;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    for (let i = 0; i < 512; i++) {
      bits.setUint32(0, next(), true);
      bits.setUint32(4, next(), true);
      const value = bits.getFloat64(0, true);
      expect(format(value), `bits=${bits.getBigUint64(0, true).toString(16)}`).toBe(String(value));
    }
  });

  it("keeps compiler-injected timer wrappers outside linear attempt-root telemetry", async () => {
    process.env.JS2WASM_LINEAR_IR = "1";
    const result = await compile(
      `export function user(x: number): number { return x + 1; }\nsetTimeout(() => {}, 1);`,
      { target: "linear", fileName: "linear-timer-provenance.ts" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const report = getLastLinearIrReport();
    expect(report).toBeDefined();
    expect(report?.ownerEvidence.map((entry) => entry.legacyName)).not.toContain("setTimeout");
    expect(report?.legacySlots.map((entry) => entry.legacyName)).not.toContain("setTimeout");
    expect(report?.rejected.some((entry) => entry.reason === "select:external-call")).toBe(false);

    const userTimer = await compile(
      `export function setTimeout(delay: number): number { return delay; }
export function user(x: number): number { return setTimeout(x) + 1; }`,
      { target: "linear", fileName: "linear-user-timer.ts" },
    );
    expect(userTimer.success, userTimer.errors.map((error) => error.message).join("\n")).toBe(true);
    const userReport = getLastLinearIrReport();
    expect(userReport?.ownerEvidence.map((entry) => entry.legacyName)).toContain("setTimeout");
    expect(userReport?.legacySlots.map((entry) => entry.legacyName)).toContain("setTimeout");
  });
});
