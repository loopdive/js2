// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

function envImportNames(bytes: Uint8Array): string[] {
  const mod = new WebAssembly.Module(bytes);
  return WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env")
    .map((i) => i.name);
}

function assertNoReflectHostImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const hits = imports.filter((i) => i.module === "env" && i.name.startsWith("__reflect_"));
  expect(
    hits.map((i) => `${i.module}::${i.name}`),
    "standalone Reflect object subset must not leak env::__reflect_*",
  ).toEqual([]);
}

async function runStandaloneNumber(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoReflectHostImports(r.imports);
  expect(envImportNames(r.binary).filter((name) => name.startsWith("__reflect_"))).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#1905 standalone native Reflect object subset", () => {
  it("Reflect.get/set/has/deleteProperty operate on open $Object values", async () => {
    expect(
      await runStandaloneNumber(`
        export function run(): number {
          const o: any = {};
          const setX = Reflect.set(o, "x", 40);
          const setY = Reflect.set(o, "y", (Reflect.get(o, "x") as number) + 2);
          const hadX = Reflect.has(o, "x") ? 4 : 0;
          const hadMissing = Reflect.has(o, "missing") ? 100 : 0;
          const deletedX = Reflect.deleteProperty(o, "x") ? 8 : 0;
          const hasDeletedX = Reflect.has(o, "x") ? 1000 : 0;
          return (setX ? 1 : 0) + (setY ? 2 : 0) + hadX + deletedX
            + (Reflect.get(o, "y") as number) + hadMissing + hasDeletedX;
        }
      `),
    ).toBe(57);
  });

  it("Reflect.set returns false when the native $Object write gate refuses", async () => {
    expect(
      await runStandaloneNumber(`
        export function run(): number {
          const frozen: any = {};
          Reflect.set(frozen, "x", 1);
          Object.freeze(frozen);
          const frozenOk = Reflect.set(frozen, "x", 2);

          const fixed: any = {};
          Object.preventExtensions(fixed);
          const fixedOk = Reflect.set(fixed, "newKey", 3);

          return (frozenOk ? 100 : 0)
            + (fixedOk ? 1000 : 0)
            + (Reflect.get(frozen, "x") as number)
            + (Reflect.has(fixed, "newKey") ? 10 : 0);
        }
      `),
    ).toBe(1);
  });

  it("unsupported standalone Reflect methods still refuse without __reflect_* imports", async () => {
    // NOTE: defineProperty is no longer in this list — #2046 routes it to the
    // native __obj_define_from_desc applier (the same path backing standalone
    // Object.defineProperty). getOwnPropertyDescriptor was likewise removed by
    // the #2046 S5 slice. getPrototypeOf / setPrototypeOf were removed by the
    // #2046 PR-C slice (routed to __getPrototypeOf / __object_setPrototypeOf,
    // the same natives backing standalone Object.getPrototypeOf/setPrototypeOf).
    // apply still needs CreateListFromArrayLike + a call/spread analog.
    // Reflect.construct moved to its dedicated #3371 lowering.
    const cases: ReadonlyArray<[string, string]> = [
      ["apply", `export function f(fn: any, t: any, a: any): any { return Reflect.apply(fn, t, a); }`],
    ];

    for (const [method, source] of cases) {
      const r = await compile(source, { target: "standalone" });
      expect(r.success, `Reflect.${method} should refuse in standalone`).toBe(false);
      const joined = r.errors.map((e) => e.message).join("\n");
      expect(joined).toMatch(new RegExp(`Reflect\\.${method} not supported in standalone mode`));
      expect(joined).toMatch(/#1472 Phase C/);
      assertNoReflectHostImports(r.imports);
    }
  });

  it("default target still uses the host Reflect bridge", async () => {
    const r = await compile(
      `
        export function f(o: any): number {
          Reflect.set(o, "x", 7);
          const v: any = Reflect.get(o, "x");
          const ok = Reflect.has(o, "x") && Reflect.deleteProperty(o, "x");
          return ok ? v : 0;
        }
      `,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const names = r.imports.filter((i) => i.module === "env").map((i) => i.name);
    expect(names).toContain("__reflect_get");
    expect(names).toContain("__reflect_set");
    expect(names).toContain("__reflect_has");
    expect(names).toContain("__reflect_deleteProperty");
  });
});
