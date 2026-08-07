// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4159 S3/S5 — typed-lane plain-array element access must consult the #3251
 * vec-overlay companion (standalone).
 *
 * `Object.defineProperty(arr, "1", { get, set })` on a statically-typed array
 * was silently ignored by the typed inline `array.get`/`array.set` lane: the
 * read returned the stale element and the write overwrote the raw backing.
 * The dynamic lane was already correct (its chokepoints carry the
 * finalize-spliced overlay prologues), so the same array answered differently
 * depending on the static type of the reference.
 *
 * The fix routes typed element reads/writes through those same chokepoints,
 * gated on the compile-time pre-scan flag `ctx.vecAccessorDescriptorDirty`
 * (#4159 Work Item A) — a module with no non-data descriptor define anywhere
 * emits byte-identical code (pinned below).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  expect(WebAssembly.validate(result.binary!), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { main: () => unknown }).main();
}

describe("#4159 typed-lane overlay routing (standalone)", () => {
  // Repro A from the issue: typed read through a getter. RED on main (20).
  it("typed read invokes an accessor getter", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          const arr: number[] = [10, 20, 30];
          Object.defineProperty(arr, "1", { get: function () { return 99; }, configurable: true });
          return arr[1];
        }
      `),
    ).toBe(99);
  });

  // Repro B: typed write through a setter. RED on main (0).
  it("typed write invokes an accessor setter", async () => {
    expect(
      await runStandalone(`
        let seen: number = 0;
        export function main(): number {
          const arr: number[] = [10, 20, 30];
          Object.defineProperty(arr, "1", {
            set: function (v: number) { seen = v; },
            get: function () { return 99; },
            configurable: true,
          });
          arr[1] = 5;
          return seen;
        }
      `),
    ).toBe(5);
  });

  // OOB accessor index (define does not extend the vec) — the test262
  // propertyHelper shape (`var arrObj = []` + define at "1"). RED on main.
  it("typed read of an out-of-bounds accessor index invokes the getter", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          const arr: number[] = [];
          Object.defineProperty(arr, "1", { get: function () { return 12; } });
          return (arr[1] as any) as number;
        }
      `),
    ).toBe(12);
  });

  // String-spelled key on a typed receiver via a monomorphized helper — the
  // exact propertyHelper monomorphization shape. RED on main (null).
  it("string-key read through a vec-typed helper param consults the companion", async () => {
    expect(
      await runStandalone(`
        function read(o: number[], n: string): any { return (o as any)[n]; }
        export function main(): number {
          const arr: number[] = [];
          Object.defineProperty(arr, "1", { get: function () { return 12; } });
          return read(arr, "1");
        }
      `),
    ).toBe(12);
  });

  // CONTROL (green on both): data descriptor keeps the value write-back.
  it("control: data descriptor define still reads the written value", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          const arr: number[] = [10, 20, 30];
          Object.defineProperty(arr, "1", { value: 77, writable: true, configurable: true });
          return arr[1];
        }
      `),
    ).toBe(77);
  });

  // CONTROL (green on both): dirty-module plain array still grows on OOB write.
  it("control: OOB write in a dirty module still grows the array", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          const other: number[] = [];
          Object.defineProperty(other, "0", { get: function () { return 1; } }); // dirties the module
          const a: number[] = [1, 2, 3];
          a[5] = 9;
          return a.length * 100 + (a[5] as any);
        }
      `),
    ).toBe(609);
  });

  // CONTROL (green on both): typed loop over a clean array in a dirty module.
  it("control: counted loop sum still correct when the module is dirty", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          const other: number[] = [];
          Object.defineProperty(other, "0", { get: function () { return 1; } });
          const a: number[] = [1, 2, 3, 4];
          let s: number = 0;
          for (let i = 0; i < a.length; i++) { s += a[i]; }
          return s;
        }
      `),
    ).toBe(10);
  });

  // BYTE-IDENTITY: a flag-clear module (no descriptor define anywhere) must
  // compile to exactly the bytes main produces — the pre-scan gate guarantees
  // the routing helpers are never consulted. Pinned structurally: the emitted
  // binary of a dense-loop program contains no `__extern_get_idx` import/name
  // beyond what main already had. (A branch-vs-main sha diff can't run in CI,
  // so pin the structural property instead.)
  it("flag-clear module: dense loop emits no overlay-routing calls", async () => {
    const source = `
      export function main(): number {
        const a: number[] = [1, 2, 3, 4];
        let s: number = 0;
        for (let i = 0; i < a.length; i++) { s += a[i]; }
        a[2] = 9;
        return s + a[2];
      }
    `;
    const result = await compile(source, { target: "standalone" });
    expect(result.success).toBe(true);
    // The routing chokepoint name must not appear in a flag-clear module.
    const bytes = result.binary!;
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.includes("__extern_get_idx")).toBe(false);
    // Determinism guard for the same compile (sanity that the sha is stable).
    const r2 = await compile(source, { target: "standalone" });
    expect(createHash("sha256").update(r2.binary!).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });
});
