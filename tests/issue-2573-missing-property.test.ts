// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2573 — a plain-object missing property is undefined, while explicit null,
// inherited data, and an accessor result remain observable in standalone.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const CONTROLS = `
  export function missing(): number {
    const obj: any = {};
    return obj.missing === undefined ? 1 : 0;
  }

  export function explicitNull(): number {
    const obj: any = { missing: null };
    return obj.missing === null ? 1 : 0;
  }

  export function inherited(): number {
    const proto: any = { missing: 7 };
    const obj: any = Object.create(proto);
    return obj.missing === 7 ? 1 : 0;
  }

  export function getterUndefined(): number {
    const obj: any = {};
    Object.defineProperty(obj, "missing", { get: () => undefined });
    return obj.missing === undefined ? 1 : 0;
  }
`;

describe("#2573 standalone missing-property controls", () => {
  it("keeps missing, null, inherited, and getter values distinct", async () => {
    const result = await compile(CONTROLS, { target: "standalone", fileName: "issue-2573.ts" });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports.filter((entry) => entry.module === "env")).toEqual([]);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, () => number>;
    expect(exports.missing()).toBe(1);
    expect(exports.explicitNull()).toBe(1);
    expect(exports.inherited()).toBe(1);
    expect(exports.getterUndefined()).toBe(1);
  });
});
