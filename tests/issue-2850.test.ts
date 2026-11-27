/**
 * #2850 — dynamic-receiver `+=` must be JS `+` (string concat), not numeric.
 *
 * compiled-acorn threw validating ANY regex with two named groups
 * ("Duplicate capture group name") and ANY `\p{…}/u` property escape
 * ("Invalid property name"). Root cause (isolated to a 3-line no-acorn repro):
 * `compilePropertyCompoundAssignmentExternref`'s Path B lowered
 * `obj.prop += rhs` on an externref/any receiver UNCONDITIONALLY as
 * `__unbox_number → f64.add → __box_number`, so acorn's
 * `state.lastStringValue += codePointToString(ch)` accumulated NaN — both
 * group names keyed "NaN" (spurious duplicate), and the unicode property
 * name string arrived as NaN (invalid). The fix routes `+=` through the
 * runtime-dispatched JS `+` (`__host_add`, the emitAnyAdd/#2058 bridge) on
 * the host lane.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function run(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as never as Record<string, () => unknown>)[fn]!();
}

describe("#2850 — dynamic-receiver += string concatenation", { timeout: 30000 }, () => {
  it("concatenates string += on a class instance through an any param", async () => {
    const out = await run(`
      class S { v = ""; }
      function build(state: any): any { state.v += "a"; state.v += "b"; return state.v; }
      export function test(): any { return build(new S()); }
    `);
    expect(out).toBe("ab");
  });

  it("concatenates string += on a plain object literal through an any param", async () => {
    const out = await run(`
      function build(state: any): any { state.v += "a"; return state.v; }
      export function test(): any { return build({ v: "" }); }
    `);
    expect(out).toBe("a");
  });

  it("string += number coerces per §13.15.3 (concat, not add)", async () => {
    const out = await run(`
      function build(state: any): any { state.v += 1; return state.v; }
      export function test(): any { return build({ v: "n" }); }
    `);
    expect(out).toBe("n1");
  });

  it("number += number on a dynamic receiver stays numeric", async () => {
    const out = await run(`
      function build(state: any): any { state.n += 2; state.n += 0.5; return state.n; }
      export function test(): any { return build({ n: 1 }); }
    `);
    expect(out).toBe(3.5);
  });

  it("number += string produces string concat (JS + semantics)", async () => {
    // NOTE: asserts the EXPRESSION value. Reading `state.n` back still returns
    // NaN — the store of a string into the receiver's NUMERIC f64 struct slot
    // coerces on write (the #2853-documented typed-slot residual family), which
    // is a separate representational issue, not the += operator semantics.
    const out = await run(`
      function build(state: any): any { return state.n += "x"; }
      export function test(): any { return build({ n: 1 }); }
    `);
    expect(out).toBe("1x");
  });

  it("-= stays numeric on a dynamic receiver", async () => {
    const out = await run(`
      function build(state: any): any { state.n -= 2; return state.n; }
      export function test(): any { return build({ n: 5 }); }
    `);
    expect(out).toBe(3);
  });

  it("+= result is usable as the expression value", async () => {
    const out = await run(`
      function build(state: any): any { return state.v += "z"; }
      export function test(): any { return build({ v: "y" }); }
    `);
    expect(out).toBe("yz");
  });

  it("accumulation loop mirrors acorn's lastStringValue build", async () => {
    // acorn regexp_eatGroupName: state.lastStringValue += codePointToString(ch)
    const out = await run(`
      function fromCode(c: number): string { return String.fromCharCode(c); }
      function build(state: any): any {
        state.lastStringValue = "";
        const codes = [121, 101, 97, 114];
        for (const c of codes) {
          state.lastStringValue += fromCode(c);
        }
        return state.lastStringValue;
      }
      export function test(): any { return build({ lastStringValue: "" }); }
    `);
    expect(out).toBe("year");
  });
});
