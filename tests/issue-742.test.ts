// #742 — extract early-guard handlers from compileCallExpression into
// calls-guards.ts. These tests pin the behaviour of the extracted guards
// (namespace-non-callable, Object(x) coercion, RegExp(...) constructor) so the
// decomposition stays behaviour-preserving: the wasm output must match JS.
//
// Functions return numbers (not bare booleans) because assertEquivalent does a
// strict `toBe`, and a wasm boolean export is an i32 (1/0) while JS returns
// true/false. Mapping booleans through `? 1 : 0` keeps the comparison clean.
import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("#742 compileCallExpression guard extraction", () => {
  it("Math()/JSON() as a function throw TypeError (namespace non-callable)", async () => {
    await assertEquivalent(
      `export function mathCall(): number { try { (Math as any)(); return 0; } catch { return 1; } }
       export function jsonCall(): number { try { (JSON as any)(); return 0; } catch { return 1; } }`,
      [
        { fn: "mathCall", args: [] },
        { fn: "jsonCall", args: [] },
      ],
    );
  });

  it("Object(x) coercion matches JS", async () => {
    await assertEquivalent(
      `export function boxNumber(): number { const o = Object(42) as any; return o.valueOf(); }
       export function boxFresh(): number { return Object() ? 1 : 0; }
       export function boxNullFresh(): number { return Object(null) ? 1 : 0; }`,
      [
        { fn: "boxNumber", args: [] },
        { fn: "boxFresh", args: [] },
        { fn: "boxNullFresh", args: [] },
      ],
    );
  });

  it("RegExp(pattern) without new matches a literal regex", async () => {
    await assertEquivalent(
      `export function reMatch(): number { return RegExp("a.c").test("axc") ? 1 : 0; }
       export function reNoMatch(): number { return RegExp("a.c").test("zzz") ? 1 : 0; }`,
      [
        { fn: "reMatch", args: [] },
        { fn: "reNoMatch", args: [] },
      ],
    );
  });
});
