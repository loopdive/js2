// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(body: string): Promise<unknown> {
  const result = await compile(`export function test(): number { ${body} }`, { fileName: "test.ts" });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join("\n"));
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3469 Reflect.ownKeys observes Object.create own properties", () => {
  it("returns only the assigned own keys", async () => {
    expect(
      await run(`
        const proto: any = { foo: 1 };
        const o: any = Object.create(proto);
        o.p1 = 42;
        o.p2 = 43;
        o.p3 = 44;
        const keys: any = Reflect.ownKeys(o);
        return keys.length;
      `),
    ).toBe(3);
  });

  it("agrees with Object.getOwnPropertyNames", async () => {
    expect(
      await run(`
        const proto: any = { foo: 1 };
        const o: any = Object.create(proto);
        o.p1 = 42;
        o.p2 = 43;
        o.p3 = 44;
        const reflectKeys: any = Reflect.ownKeys(o);
        const objectKeys: any = Object.getOwnPropertyNames(o);
        return reflectKeys.length === objectKeys.length ? reflectKeys.length : 100 + objectKeys.length;
      `),
    ).toBe(3);
  });

  it("preserves the compiled prototype's reads and identity", async () => {
    expect(
      await run(`
        const proto: any = { foo: 1 };
        const o: any = Object.create(proto);
        return o.foo === 1 && Object.getPrototypeOf(o) === proto ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("writes through a writable prototype property onto the receiver", async () => {
    expect(
      await run(`
        const proto: any = { value: 1 };
        const o: any = Object.create(proto);
        o.value = 2;
        const keys: any = Reflect.ownKeys(o);
        return proto.value === 1 && o.value === 2 && keys.length === 1 ? 1 : 0;
      `),
    ).toBe(1);
  });
});
