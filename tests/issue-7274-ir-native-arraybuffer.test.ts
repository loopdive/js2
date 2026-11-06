// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7274 slice 1 — the native ArrayBuffer surface lowers through the IR on a
// host-free lane: construction, `byteLength` / `maxByteLength` / `resizable`
// and `slice`, on a certified receiver, each a direct adapter call.
//
// What these tests protect:
//   - the three target test262 files claim `<module-init>` and still pass;
//   - a claimed body is built from the `__ir_ab_*` adapters (the IR inliner
//     may splice their bodies in; the functions stay), computes the JS values
//     and adds no host import;
//   - the plan's refusals: a shadowed `ArrayBuffer`, a non-literal options
//     argument, a subclass, a var with a non-buffer write, and a member outside
//     the table keep `<module-init>` on the legacy route and still pass;
//   - the gc lane never claims (byte-identity is measured separately).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { originalHarnessCompileOptions, parseMeta, runTest262File } from "./test262-runner.js";

const TARGETS = [
  "built-ins/ArrayBuffer/options-maxbytelength-undefined.js",
  "built-ins/ArrayBuffer/prototype/maxByteLength/return-maxbytelength-resizable.js",
  "built-ins/ArrayBuffer/prototype/slice/end-default-if-undefined.js",
].map((rel) => resolve("test262/test", rel));

const probeDir = mkdtempSync(join(tmpdir(), "issue-7274-"));
let probeCount = 0;

/** A test262-format file holding `body`. */
function probe(body: string): string {
  const path = join(probeDir, `probe-${probeCount++}.js`);
  writeFileSync(path, `/*---\ndescription: issue 7274 probe\n---*/\n${body}\n`);
  return path;
}

/** Compile `path` as the runner does and report the `<module-init>` route. */
async function route(path: string, target?: "standalone" | "wasi") {
  const source = readFileSync(path, "utf8");
  const meta = parseMeta(source);
  const variant = assembleOriginalHarness(source, meta).primary;
  const result = await compile(variant.source, {
    ...originalHarnessCompileOptions(meta, "standalone"),
    ...(target ? { target } : { target: undefined }),
    fileName: path,
    trackIrOutcomes: true,
    emitWat: true,
  });
  expect(result.success, result.errors?.[0]?.message).toBe(true);
  const init = (result.irOutcomes ?? []).find((o) => o.unitKind === "module-init");
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((i) => `${i.module}.${i.name}`);
  return { claimed: init?.irBodyEmitted === true, wat: (result as { wat?: string }).wat ?? "", imports };
}

async function passes(path: string): Promise<void> {
  const result = await runTest262File(path, "built-ins", 15000, "standalone");
  expect(result.status, String(result.error ?? "")).toBe("pass");
}

describe("#7274 IR native ArrayBuffer (standalone)", () => {
  it.each(TARGETS)("claims and passes %s", async (path) => {
    expect((await route(path, "standalone")).claimed).toBe(true);
    await passes(path);
  });

  it("builds the body from the adapters, computes the JS values, adds no host import", async () => {
    const path = probe(`
      var ab = new ArrayBuffer(8, { maxByteLength: 16 });
      var fixed = new ArrayBuffer(5.9);
      var part = ab.slice(2, 6);
      assert.sameValue(ab.byteLength + ab.maxByteLength + part.byteLength, 28);
      assert.sameValue(fixed.byteLength, 5);
      assert.sameValue(fixed.maxByteLength, 5);
      assert.sameValue(fixed.slice(-2).byteLength, 2);
      assert.sameValue(fixed.slice(4, 1).byteLength, 0);
      assert.sameValue(ab.resizable, true);
      assert.sameValue(fixed.resizable, false);
      assert.sameValue(part.resizable, false);
    `);
    const { claimed, wat } = await route(path, "standalone");
    expect(claimed).toBe(true);
    for (const adapter of [
      "__ir_ab_new",
      "__ir_ab_new_resizable",
      "__ir_ab_slice",
      "__ir_ab_byte_length",
      "__ir_ab_max_byte_length",
      "__ir_ab_resizable",
    ]) {
      expect(wat, adapter).toContain(`(func $${adapter} `);
    }
    // The wasi harness keeps `<module-init>` legacy for reasons of its own; both lanes stay env-free.
    for (const target of ["standalone", "wasi"] as const) {
      const { imports } = await route(path, target);
      expect(
        imports.filter((name) => name.startsWith("env.")),
        target,
      ).toEqual([]);
    }
    await passes(path);
  });

  it.each([
    [
      "a shadowed constructor",
      "function ArrayBuffer(n) { this.byteLength = n * 2; } var ab = new ArrayBuffer(4); assert.sameValue(typeof ab.byteLength, 'number');",
    ],
    [
      "a non-literal options argument",
      "var o = { maxByteLength: 8 }; var ab = new ArrayBuffer(4, o); assert.sameValue(ab.byteLength, 4);",
    ],
    ["a subclass", "class B extends ArrayBuffer {} var ab = new B(4); assert(ab instanceof B);"],
    ["a non-buffer write", "var ab = new ArrayBuffer(4); assert.sameValue(ab.byteLength, 4); ab = 3;"],
    ["a member outside the table", "var ab = new ArrayBuffer(4); assert.sameValue(ab.transfer().byteLength, 4);"],
  ])("keeps %s on the legacy route", async (_label, body) => {
    const path = probe(body);
    const { claimed, wat } = await route(path, "standalone");
    expect(claimed).toBe(false);
    expect(wat).not.toContain("__ir_ab_");
    await passes(path);
  });

  it("never claims on the gc lane", async () => {
    const { wat } = await route(TARGETS[2]!);
    expect(wat).not.toContain("__ir_ab_");
  });
});

/** Count the defined functions named `name` in a WAT dump. */
function definitions(wat: string, name: string): number {
  return wat.split(`(func $${name} `).length - 1;
}

async function compileModule(source: string) {
  const result = await compile(source, { fileName: "test.ts", target: "standalone", emitWat: true });
  expect(result.success, result.errors?.[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return { wat: (result as { wat?: string }).wat ?? "", test: instance.exports.test as () => number };
}

// The adapters are compiler-owned functions, registered by the exact handle
// they were minted as. A source declaration sharing an adapter's name lives
// in the same `funcMap` namespace and must be neither picked as the provider
// nor displaced.
describe("#7274 adapter ownership vs a same-name source function", () => {
  it.each([
    ["a matching ABI", "function __ir_ab_byte_length(x) { return 777; }", "ab.byteLength", 8],
    ["a different ABI", 'function __ir_ab_slice(a) { return "s" + a; }', "ab.slice(2).byteLength", 6],
  ])("keeps the IR claim and the adapter with %s", async (_label, namesake, read, expected) => {
    const path = probe(`${namesake} var ab = new ArrayBuffer(8); assert.sameValue(${read}, ${expected});`);
    expect((await route(path, "standalone")).claimed).toBe(true);
    await passes(path);
  });

  it("keeps both the adapter result and the source function's result", async () => {
    const { wat, test } = await compileModule(`
      export function __ir_ab_byte_length(x: any): number { return 777; }
      const n = new ArrayBuffer(8).byteLength;
      const m = new ArrayBuffer(4, { maxByteLength: 9 }).slice(1).byteLength;
      export function test(): number { return n * 1000000 + m * 1000 + __ir_ab_byte_length(null); }
    `);
    expect(test()).toBe(8_003_777);
    expect(definitions(wat, "__ir_ab_byte_length")).toBeLessThanOrEqual(2);
  });

  it("keeps the Map adapters apart from a same-name source function", async () => {
    const { wat, test } = await compileModule(`
      export function __ir_map_new(): number { return 5; }
      const cache = new Map<number, number>();
      function put(k: number, v: number): number {
        cache.set(k, v);
        const hit = cache.get(k);
        return hit !== undefined ? hit : -1;
      }
      export function test(): number { return put(3, 4) * 10 + __ir_map_new(); }
    `);
    expect(test()).toBe(45);
    expect(definitions(wat, "__ir_map_new")).toBe(2);
  });

  it("mints each adapter once however many sites call it", async () => {
    const path = probe(`
      var a = new ArrayBuffer(3);
      var b = new ArrayBuffer(5);
      assert.sameValue(a.byteLength + b.byteLength + a.slice(1).byteLength + b.slice(1).byteLength, 14);
    `);
    const { claimed, wat } = await route(path, "standalone");
    expect(claimed).toBe(true);
    for (const adapter of ["__ir_ab_new", "__ir_ab_byte_length", "__ir_ab_slice"]) {
      expect(definitions(wat, adapter), adapter).toBe(1);
    }
    await passes(path);
  });
});
