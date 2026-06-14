// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #2009 (PR-1, names) — structurally-identical anon struct types share
 * field names at the host boundary.
 *
 * `{ aa: 1 }` and `{ bb: 2 }` compile to DISTINCT anon struct typeIdxs
 * (`fieldsHashKey` includes field names), but they are structurally identical
 * (`struct (field (mut f64))`) so WasmGC iso-recursive canonicalization makes
 * them indistinguishable to `ref.test`. `__struct_field_names`'s `ref.test`
 * chain therefore returned the FIRST-registered shape's names for EVERY
 * same-shape instance — mislabelling Object.keys / JSON.stringify / for-in /
 * Object.assign / spread:
 *
 *   const a: any = { aa: 1 }; const b: any = { bb: 2 };
 *   JSON.stringify(a) + "|" + JSON.stringify(b)
 *   // wasm (buggy): {"aa":1}|{"aa":2}   node: {"aa":1}|{"bb":2}
 *
 * Fix: every host-enumerable anon object-literal struct carries a hidden
 * trailing `$shape` i32 field, stamped at construction with a shape-id keyed by
 * the ordered field-name list. `__struct_field_names` reads `struct.get $shape`
 * and selects the field-name CSV by VALUE (not by the ambiguous type), so each
 * instance reports its OWN names. The `$`-prefix keeps `$shape` out of
 * Object.keys/values/entries/for-in/JSON.
 *
 * NOTE: the spread source-order / value-resolution bug (R2 Object.assign value
 * merge, R3 `{...a,...b,x:9}` value resolution) is tracked as a separate
 * follow-up (issue #2009 PR-2 / #2076) — this PR fixes the NAME collision only.
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#2009 — per-instance struct field names (host boundary)", () => {
  it("JSON.stringify of two same-shape literals reports each one's own keys", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { aa: 1 };
          const b: any = { bb: 2 };
          return JSON.stringify(a) + "|" + JSON.stringify(b);
        }
      `),
    ).toBe('{"aa":1}|{"bb":2}');
  });

  it("Object.keys of two same-shape literals returns each one's own keys", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { aa: 1 };
          const b: any = { bb: 2 };
          return Object.keys(a).join(",") + "|" + Object.keys(b).join(",");
        }
      `),
    ).toBe("aa|bb");
  });

  it("three distinct-name same-shape literals each report their own key", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { p: 1 };
          const b: any = { q: 2 };
          const c: any = { r: 3 };
          return JSON.stringify(a) + JSON.stringify(b) + JSON.stringify(c);
        }
      `),
    ).toBe('{"p":1}{"q":2}{"r":3}');
  });

  it("same-name literals still share names (no per-literal bloat)", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { aa: 1 };
          const b: any = { aa: 9 };
          return JSON.stringify(a) + "|" + JSON.stringify(b);
        }
      `),
    ).toBe('{"aa":1}|{"aa":9}');
  });

  it("the hidden $shape field does not leak into Object.keys / values / entries", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const o: any = { p: 1, q: 2 };
          return Object.keys(o).length + "," + Object.values(o).length + "," + Object.entries(o).length;
        }
      `),
    ).toBe("2,2,2");
  });

  it("multi-field same-shape literals report distinct key sets", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { aa: 1, bb: 2 };
          const b: any = { cc: 3, dd: 4 };
          return JSON.stringify(a) + "|" + JSON.stringify(b);
        }
      `),
    ).toBe('{"aa":1,"bb":2}|{"cc":3,"dd":4}');
  });

  it("a struct with a unique field-name shape (no collision) reports its names", async () => {
    // No other same-TYPE-shape struct exists, so this struct is NOT stamped with
    // $shape (opt-in collision resolution) — verifies the non-colliding path
    // still enumerates correctly and stays on the legacy typeIdx arm.
    expect(
      await runWasm(`
        export function test(): string {
          const o: any = { onlyMe: 1, alsoMe: 2 };
          return JSON.stringify(o);
        }
      `),
    ).toBe('{"onlyMe":1,"alsoMe":2}');
  });

  it("Object.assign onto a struct target keeps the target's own field value (writeback shape-guard)", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          return JSON.stringify(Object.assign({ a: 1 }, { b: 2 }));
        }
      `),
    ).toBe('{"a":1,"b":2}');
  });
});
