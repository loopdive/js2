// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4222) `delete arr[k]` on a vec-backed array must make the index ABSENT.
//
// The runtime half has worked since #4010: `__delete_property`'s vec arm
// tombstones the index as a `FLAG_DELETED_INDEX` entry in the #3251 overlay
// companion, and `__extern_get_idx` / `__vec_gopd` honour it. What did NOT
// honour it was every PRESENCE surface — `__extern_has_idx` had no overlay
// consult at all, and the typed lanes (`n in arr`, the for-in index loop, the
// `Object.keys` vec arm, the HOF visit gates) answered from `0 <= i < length`,
// which `delete` does not change. So `arr[1]` was already `undefined` while
// `1 in arr` still said `true` — §7.3.12 HasProperty disagreeing with §7.3.2
// Get about the same index.
//
// Two mechanisms, both compile-time-gated so a module with no
// `delete arr[i]` is byte-identical:
//   1. `vecIndexDeleteDirty` (scanForArrayHoles) joins `vecAccessorDescriptorDirty`
//      in `overlayRouteActive`, so the typed lanes defer to the dynamic
//      chokepoints;
//   2. a finalize-spliced presence prologue on `__extern_has_idx` answers 0 for
//      a `FLAG_DELETED_INDEX` companion entry.
//
// The overlay is standalone-only (`overlayRouteActive` requires
// `ctx.standalone`), so the gc lane keeps its host-import behaviour — the
// assertions below are therefore standalone-scoped, with the gc lane exercised
// only for "still compiles and runs" parity where its answer is the same.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string, target: "standalone" | "gc"): Promise<unknown> {
  const opts = target === "standalone" ? { target: "standalone" as const } : {};
  const r = await compile(src, opts);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const imports = target === "standalone" ? {} : buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => unknown }).test();
}

/** The receiver is left UNANNOTATED so the checker keeps it `number[]` and the
 *  access lowers through the TYPED vec lane — the path test262's untyped JS
 *  takes, and the one that used to bypass the overlay. */
const DECL = "const arr = [0, 1, 2, 3];\n";

describe("#4222 — `delete arr[k]` makes the index absent (standalone)", () => {
  it("`k in arr` is false after the delete", async () => {
    expect(await run(`${DECL}export function test(): boolean { delete arr[1]; return 1 in arr; }`, "standalone")).toBe(
      0,
    );
  });

  it("the string form of the same key agrees", async () => {
    expect(
      await run(`${DECL}export function test(): boolean { delete arr[1]; return "1" in arr; }`, "standalone"),
    ).toBe(0);
  });

  it("a surviving index is still present", async () => {
    expect(await run(`${DECL}export function test(): boolean { delete arr[1]; return 2 in arr; }`, "standalone")).toBe(
      1,
    );
  });

  it("a dynamic read of the deleted index yields undefined", async () => {
    // `__extern_get_idx`'s overlay read prologue (#3251) — pinned here because
    // the presence answer above is only correct if Get agrees with HasProperty.
    // Asserted as `=== undefined` rather than by reading the value out: an
    // f64-returning export encodes `undefined` as NaN, which would pin the
    // ENCODING instead of the semantics.
    expect(
      await run(
        `${DECL}const dyn: any = arr;
        export function test(): boolean { delete arr[1]; return dyn[1] === undefined; }`,
        "standalone",
      ),
    ).toBe(1);
  });

  it("getOwnPropertyDescriptor reports the index as absent", async () => {
    expect(
      await run(
        `${DECL}export function test(): boolean {
          delete arr[1];
          return Object.getOwnPropertyDescriptor(arr, "1") !== undefined;
        }`,
        "standalone",
      ),
    ).toBe(0);
  });

  it("for-in skips the deleted index", async () => {
    expect(
      await run(
        `${DECL}export function test(): number {
          delete arr[1];
          let n = 0;
          for (const k in arr) { n = n + 1; }
          return n;
        }`,
        "standalone",
      ),
    ).toBe(3);
  });

  it("Object.keys skips the deleted index", async () => {
    expect(
      await run(
        `${DECL}export function test(): number { delete arr[1]; return Object.keys(arr).length; }`,
        "standalone",
      ),
    ).toBe(3);
  });

  it("length is unchanged by the delete (§10.4.2 — delete is not a truncation)", async () => {
    expect(await run(`${DECL}export function test(): number { delete arr[1]; return arr.length; }`, "standalone")).toBe(
      4,
    );
  });
});

describe("#4222 — array HOFs skip a deleted index", () => {
  // test262 `built-ins/Array/prototype/filter/15.4.4.20-9-3`: the callback
  // deletes indices out from under the iteration, and §23.1.3.7 step 5.b
  // re-evaluates HasProperty per index, so the deleted ones are never visited.
  it("filter does not visit an index the callback deleted (15.4.4.20-9-3)", async () => {
    expect(
      await run(
        `const srcArr = [1, 2, 3, 4, 5];
        export function test(): number {
          const resArr = srcArr.filter(function (val: number): boolean {
            delete srcArr[2];
            delete srcArr[4];
            return val > 0;
          });
          return resArr.length;
        }`,
        "standalone",
      ),
    ).toBe(3);
  });

  it("filter skips an index deleted before the call", async () => {
    expect(
      await run(
        `${DECL}export function test(): number {
          delete arr[1];
          return arr.filter(function (): boolean { return true; }).length;
        }`,
        "standalone",
      ),
    ).toBe(3);
  });

  it("the same holds through an `any`-typed alias (dynamic HOF lane)", async () => {
    expect(
      await run(
        `${DECL}const dyn: any = arr;
        export function test(): number {
          delete arr[1];
          return dyn.filter(function (): boolean { return true; }).length;
        }`,
        "standalone",
      ),
    ).toBe(3);
  });
});

describe("#4222 — the delete-free path is untouched", () => {
  // The pre-scan flag is what arms all of the above; a module with no
  // `delete <elementAccess>` must keep the dense answers on BOTH lanes.
  for (const target of ["standalone", "gc"] as const) {
    it(`presence, for-in and keys are unchanged without a delete (${target})`, async () => {
      expect(await run(`${DECL}export function test(): boolean { return 1 in arr; }`, target)).toBe(1);
      expect(await run(`${DECL}export function test(): boolean { return 9 in arr; }`, target)).toBe(0);
      expect(
        await run(
          `${DECL}export function test(): number { let n = 0; for (const k in arr) { n = n + 1; } return n; }`,
          target,
        ),
      ).toBe(4);
      expect(
        await run(
          `${DECL}export function test(): number { return arr.filter(function (): boolean { return true; }).length; }`,
          target,
        ),
      ).toBe(4);
    });
  }
});
