// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const BANNED_STANDALONE_IMPORTS: ReadonlyArray<RegExp> = [
  /^env::__proto_method_call$/,
  /^env::__hasOwnProperty$/,
  /^env::__propertyIsEnumerable$/,
  /^env::__isPrototypeOf$/,
  /^env::__register_prototype$/,
  /^env::__register_class_object$/,
];

function assertNoStandaloneBorrowedHostImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED_STANDALONE_IMPORTS) {
    const hits = labels.filter((l) => re.test(l));
    expect(hits, `standalone leaked ${re} (got ${hits.join(", ")})`).toEqual([]);
  }
}

async function runHost(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "issue-1591.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).run();
}

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { fileName: "issue-1591.ts", target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoStandaloneBorrowedHostImports(r.imports);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#1591 — class element own-property enumerability reconciliation", () => {
  it("host runtime reports class prototype/static methods as own but non-enumerable", async () => {
    const result = await runHost(`
      class C {
        field: number = 1;
        m(): number { return 2; }
        static s(): number { return 3; }
      }

      export function run(): number {
        const proto: any = C.prototype;
        const ctor: any = C;
        const c = new C();
        const protoOwn = proto.hasOwnProperty("m") ? 1 : 0;
        const protoEnum = proto.propertyIsEnumerable("m") ? 1 : 0;
        const staticOwn = ctor.hasOwnProperty("s") ? 1 : 0;
        const staticEnum = ctor.propertyIsEnumerable("s") ? 1 : 0;
        const fieldEnum = c.propertyIsEnumerable("field") ? 1 : 0;
        return protoOwn * 10000 + protoEnum * 1000 + staticOwn * 100 + staticEnum * 10 + fieldEnum;
      }
    `);
    expect(result).toBe(10101);
  });

  it("compile-time C.prototype.propertyIsEnumerable follows method descriptor flags", async () => {
    const result = await runHost(`
      class C {
        field: number = 1;
        m(): number { return 2; }
        static s(): number { return 3; }
      }

      export function run(): number {
        const methodEnum = C.prototype.propertyIsEnumerable("m") ? 1 : 0;
        const staticEnum = C.propertyIsEnumerable("s") ? 1 : 0;
        const fieldEnum = new C().propertyIsEnumerable("field") ? 1 : 0;
        return methodEnum * 100 + staticEnum * 10 + fieldEnum;
      }
    `);
    expect(result).toBe(1);
  });

  it("standalone Object.prototype.propertyIsEnumerable.call handles class fields and methods host-free", async () => {
    const result = await runStandalone(`
      class C {
        field: number = 1;
        m(): number { return 2; }
      }

      export function run(): number {
        const c = new C();
        const methodEnum = Object.prototype.propertyIsEnumerable.call(C.prototype, "m") ? 1 : 0;
        const fieldEnum = Object.prototype.propertyIsEnumerable.call(c, "field") ? 1 : 0;
        const fieldOwn = Object.prototype.hasOwnProperty.call(c, "field") ? 1 : 0;
        return methodEnum * 100 + fieldEnum * 10 + fieldOwn;
      }
    `);
    expect(result).toBe(11);
  });

  it("standalone Object.prototype.isPrototypeOf.call routes to native prototype-chain helper", async () => {
    const result = await runStandalone(`
      export function run(): number {
        const proto: any = {};
        const child: any = {};
        Object.setPrototypeOf(child, proto);
        return Object.prototype.isPrototypeOf.call(proto, child) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});
