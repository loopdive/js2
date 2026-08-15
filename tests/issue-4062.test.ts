// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4062) A named expando on a STATICALLY-TYPED array receiver is visible to the
// read path and to gOPD / gOPN / Object.keys, but `hasOwnProperty`,
// `propertyIsEnumerable` and `in` answered a compile-time constant `false`: with
// a receiver the compiler sees as a `__vec_<k>` struct and a key it resolves
// statically, both fold sites answer from the vec's field list (`length`,
// `data`) plus the checker's properties, neither of which can see the #3537
// expando bag.
//
// Every expectation below is Node's answer for the same program. The host lane
// is asserted for the cells where it already agrees; the two presence cells are
// standalone-only (host's `env::__hasOwnProperty` sidecar answers `false` for an
// array expando — a separate, pre-existing host defect, see the issue file).
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, lane === "standalone" ? { target: "standalone" } : {});
  expect(
    result.success,
    `compile failed (${lane}):\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports as Record<string, () => number>).t!();
}

const fn = (body: string): string => `export function t(): number {\n${body}\n}`;

// Each case is its own module: a module that ALSO performs an indexed define
// arms the #3673 numeric-companion flag and later queries then work for the
// wrong reason (#4434's instrument warning applies to this family too).
describe("#4062 named-key presence on a statically-typed array receiver", () => {
  const PRESENT: Array<[string, string]> = [
    ["hasOwnProperty", `const a: any[] = []; (a as any).foo = 7; return a.hasOwnProperty("foo") ? 1 : 0;`],
    [
      "hasOwnProperty, non-empty",
      `const a: any[] = [1, 2]; (a as any).foo = 7; return a.hasOwnProperty("foo") ? 1 : 0;`,
    ],
    ["hasOwnProperty, f64 vec", `const a: number[] = [1]; (a as any).foo = 7; return a.hasOwnProperty("foo") ? 1 : 0;`],
    ["propertyIsEnumerable", `const a: any[] = []; (a as any).foo = 7; return a.propertyIsEnumerable("foo") ? 1 : 0;`],
    ["in", `const a: any[] = []; (a as any).foo = 7; return ("foo" in (a as any[])) ? 1 : 0;`],
    ["Object.hasOwn", `const a: any[] = []; (a as any).foo = 7; return (Object as any).hasOwn(a, "foo") ? 1 : 0;`],
  ];
  for (const [name, body] of PRESENT) {
    it(`standalone: ${name} sees the expando`, async () => {
      expect(await run(fn(body), "standalone")).toBe(1);
    });
  }

  // The read path already agreed — asserted alongside so a future change cannot
  // fix presence by breaking the read.
  it("standalone: the read still answers the stored value", async () => {
    expect(
      await run(fn(`const a: any[] = []; (a as any).foo = 7; return (a as any).foo === 7 ? 1 : 0;`), "standalone"),
    ).toBe(1);
  });

  it("standalone: gOPD still describes the expando", async () => {
    const body = `const a: any[] = []; (a as any).foo = 7;
      const d = Object.getOwnPropertyDescriptor(a, "foo");
      return d !== undefined && (d as any).value === 7 ? 1 : 0;`;
    expect(await run(fn(body), "standalone")).toBe(1);
  });

  // Only a folded FALSE is routed to the runtime; every affirmative answer and
  // every index answer is unchanged. These are the guards on that claim.
  const UNCHANGED: Array<[string, string, number]> = [
    ["absent named key stays absent", `const a: any[] = [1, 2]; return a.hasOwnProperty("nope") ? 1 : 0;`, 0],
    ["length is own", `const a: any[] = [1, 2]; return a.hasOwnProperty("length") ? 1 : 0;`, 1],
    ["index 0 is own", `const a: any[] = [1, 2]; return a.hasOwnProperty("0") ? 1 : 0;`, 1],
    ["index out of range is not own", `const a: any[] = [1, 2]; return a.hasOwnProperty("5") ? 1 : 0;`, 0],
    ["'0' in arr", `const a: any[] = [1, 2]; return ("0" in (a as any[])) ? 1 : 0;`, 1],
    ["'length' in arr", `const a: any[] = [1, 2]; return ("length" in (a as any[])) ? 1 : 0;`, 1],
    // an inherited method is named by the checker, so the fold answers 1 for
    // `in` (correct: HasProperty walks the prototype chain) and the routing
    // predicate never sees it.
    ["'concat' in arr", `const a: any[] = [1]; return ("concat" in (a as any[])) ? 1 : 0;`, 1],
    // …but it is NOT an own property.
    ["concat is not own", `const a: any[] = [1]; return a.hasOwnProperty("concat") ? 1 : 0;`, 0],
  ];
  for (const [name, body, want] of UNCHANGED) {
    it(`standalone: ${name}`, async () => {
      expect(await run(fn(body), "standalone")).toBe(want);
    });
    it(`host: ${name}`, async () => {
      expect(await run(fn(body), "host")).toBe(want);
    });
  }

  // The plain-object control: standalone is the spec answer, host is NOT — and
  // was not before this change either (verified by file-copy revert on the same
  // instrument). Asserted in both directions so the host gap stays visible and
  // this fix cannot be blamed for it.
  const PLAIN_OBJ = fn(`const o: any = {}; o.foo = 7; return o.hasOwnProperty("foo") ? 1 : 0;`);
  it("standalone: plain object receiver (control) is own", async () => {
    expect(await run(PLAIN_OBJ, "standalone")).toBe(1);
  });
  it("host: plain object receiver answers false (PRE-EXISTING host gap, base-verified)", async () => {
    expect(await run(PLAIN_OBJ, "host")).toBe(0);
  });

  // The host lane is gated OUT of the route entirely (`ctx.standalone`), so its
  // answers — including the ones it gets wrong — are unchanged by this fix.
  it("host: array expando presence is unchanged (pre-existing host gap)", async () => {
    expect(
      await run(fn(`const a: any[] = []; (a as any).foo = 7; return a.hasOwnProperty("foo") ? 1 : 0;`), "host"),
    ).toBe(0);
  });
});
