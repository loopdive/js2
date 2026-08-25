// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#4707 — module Proxy iterator carrier", () => {
  it("keeps an escaping Proxy in its target-shaped global slot", async () => {
    const result = await compile(
      `var target = []; var proxy = new Proxy(target, {}); Object.prototype.toString.call(proxy); export function test() { return 1; }`,
      { fileName: "t.ts" },
    );
    expect(result.success).toBe(true);
    const proxyGlobal = result.wat.split("\n").find((line) => /\(global \$__mod_proxy\s/.test(line));
    expect(proxyGlobal).toBeDefined();
    expect(proxyGlobal).not.toMatch(/externref/);
  });

  it("keeps a non-escaping Proxy returned as an iterator in an externref slot", async () => {
    const result = await compile(
      `var iterator = { next: function () { return { value: 1, done: true }; } }; var proxy = new Proxy(iterator, {}); export function getIterator() { return proxy; }`,
      { fileName: "t.ts" },
    );
    expect(result.success).toBe(true);
    const proxyGlobal = result.wat.split("\n").find((line) => /\(global \$__mod_proxy\s/.test(line));
    expect(proxyGlobal).toBeDefined();
    expect(proxyGlobal).toMatch(/externref/);
  });
});
