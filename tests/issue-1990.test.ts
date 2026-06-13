import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

/**
 * #1990 — loose `==` between a WasmGC-struct object carrying a compiled
 * `toString`/`valueOf` and a primitive threw "Cannot convert object to
 * primitive value" because `host_loose_eq` applied JS `==` directly and the
 * struct's funcref field is not a host-callable method. `host_loose_eq` now
 * routes a struct operand through `_toPrimitiveSync` (hint "default") when the
 * other operand is a primitive — mirroring `__extern_has`.
 */
describe("#1990 loose == ToPrimitive on struct operands", () => {
  it("object toString == string", async () => {
    await assertEquivalent(
      `export function test(): string {
        const o: any = { toString() { return "T"; } };
        return String(o == "T");
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  // NOTE: the symmetric `"T" == o` (string literal on the LHS) is lowered
  // through a DIFFERENT codegen path than `host_loose_eq` and is NOT covered by
  // this runtime fix (it still mis-compares). That is a separate codegen issue
  // — #1990 is scoped to the `object == primitive` host_loose_eq path.

  it("object valueOf == number", async () => {
    await assertEquivalent(
      `export function test(): string {
        const o: any = { valueOf() { return 5; } };
        return String(o == 5);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("object valueOf != non-matching number", async () => {
    await assertEquivalent(
      `export function test(): string {
        const o: any = { valueOf() { return 5; } };
        return String(o == 6);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("empty object == [object Object] still works", async () => {
    await assertEquivalent(
      `export function test(): string {
        const o: any = {};
        return String(o == "[object Object]");
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("object == object is reference identity (not coerced)", async () => {
    await assertEquivalent(
      `export function test(): string {
        const a: any = { valueOf() { return 1; } };
        const b: any = { valueOf() { return 1; } };
        return String(a == b) + "," + String(a == a);
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
