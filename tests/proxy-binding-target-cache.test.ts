// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

async function moduleTargetGlobal(source: string): Promise<string | undefined> {
  const result = await compile(source, { fileName: "proxy-target-cache.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result.wat.split("\n").find((line) => /\(global \$__mod_target\s/.test(line));
}

describe("Proxy target binding census", () => {
  it("normalizes escaped Proxy identifiers before taking the no-Proxy fast path", async () => {
    const global = await moduleTargetGlobal(
      String.raw`var target = { value: 1 }; var proxy = new P\u0072oxy(target, {}); export function test() { return proxy.value; }`,
    );
    expect(global).toMatch(/externref/);
  });

  it("unwraps transparent target expressions before indexing declaration identity", async () => {
    const global = await moduleTargetGlobal(
      `var target = { value: 1 }; var record = Proxy.revocable((target as unknown as { value: number }), {}); export function test() { return record.proxy.value; }`,
    );
    expect(global).toMatch(/externref/);
  });

  it("finds a captured module target inside a nested executable", async () => {
    const global = await moduleTargetGlobal(
      `var target = { value: 1 }; function wrap() { return new Proxy(target, {}); } export function test() { return wrap().value; }`,
    );
    expect(global).toMatch(/externref/);
  });

  it("does not confuse a nested binding that shadows the Proxy target", async () => {
    const exports = await compileAndInstantiate(`
      export function test(): number {
        const target = { value: 1 };
        const proxy = new Proxy(target, { get() { return 10; } });
        function readInner(): number {
          const target = { value: 2 };
          return target.value;
        }
        return proxy.value + readInner();
      }
    `);
    expect((exports as { test: () => number }).test()).toBe(12);
  });
});
