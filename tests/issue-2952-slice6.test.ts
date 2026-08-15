// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2952 slice 6 — the remaining IR control-flow residuals.
//
//   6a  TAIL-position switch. Slice 4 claimed only the non-tail form
//       (switch + trailing return); a function ENDING in a switch fell out
//       of `isPhase1Tail` as `tail-unhandled`. It now claims when either the
//       function is void (control may fall out into the implicit empty
//       return) or an all-paths-terminate analysis over the clauses holds
//       (every clause returns/throws — empty clauses fall through to the
//       next — AND a `default` covers the no-match path). Lowering reuses
//       the slice-4 `IrInstrSwitch` ladder; only the block terminator is new.
//
//   6b  STRING-literal case tests. No new IR node/field: the disc is
//       compared against each literal with the IR's abstract `string.eq`
//       (mode-resolved at lower time — host `string_equals` / native
//       `__str_equals`) and the matching CLAUSE INDEX becomes the i32
//       discriminant of the ordinary numeric ladder. Mixed numeric/string
//       test sets reject; so do discs whose IR carrier is not the string
//       carrier (an indexed read off a string array).
//
//   6c  FOR-IN head-value reads + labeled for-in. The #2964 ABI already
//       materialised the key into the head slot every iteration (slice 5
//       simply had no reader); the widening is selector-side plus an
//       `asType: string` tag on the binding. Head WRITES, captures and
//       redeclarations stay rejected, and a native-strings lane (where the
//       key externref is not the string carrier) does not claim head uses.
//
// The IR-vs-legacy divergence risk (#3566/#3567/#3568) is covered by
// dual-run value-equality tests, each of which asserts the IR claim FIRST so
// it can never silently compare legacy against legacy.

import { describe, expect, it } from "vitest";

import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { planIrCompilation } from "../src/ir/select.js";

type SelectOpts = Record<string, unknown>;

/** Bare-selector claim set. Capability callbacks are opt-in, as in slice 5. */
function selectionFor(source: string, extra: SelectOpts = {}): Set<string> {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  return new Set(planIrCompilation(sf, { experimentalIR: true, ...extra }).funcs);
}

/** Selector options that certify the slice-5/6c for-in capability. */
const FORIN_OPTS: SelectOpts = {
  isDynamicForInReceiver: () => true,
  forInHeadValueIsHostString: true,
};

async function instantiate(
  source: string,
  experimentalIR: boolean,
  compileOpts: Record<string, unknown> = {},
): Promise<{ test: (a?: unknown) => unknown; emitted: ReadonlySet<string> }> {
  const r = await compile(source, {
    fileName: "test.ts",
    experimentalIR,
    trackIrOutcomes: true,
    ...compileOpts,
  });
  if (!r.success) {
    throw new Error(
      `compile failed (${experimentalIR ? "IR" : "legacy"}):\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    );
  }
  const imports = buildImports(r.imports as never, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as never);
  const withSetExports = imports as { setExports?: (e: unknown) => void };
  if (typeof withSetExports.setExports === "function") withSetExports.setExports(instance.exports);
  const emitted = new Set((r.irOutcomes ?? []).filter((o) => o.kind === "emitted").map((o) => o.displayName));
  return { test: (instance.exports as { test: (a?: unknown) => unknown }).test, emitted };
}

/** True iff the REAL compile (checker-backed capabilities) emitted an IR body. */
async function irEmitsTest(source: string, compileOpts: Record<string, unknown> = {}): Promise<boolean> {
  const { emitted } = await instantiate(source, true, compileOpts);
  return emitted.has("test");
}

/** Dual-run: assert the IR claim, then require identical values on every arg. */
async function expectLegacyIrAgree(
  source: string,
  args: readonly unknown[],
  compileOpts: Record<string, unknown> = {},
): Promise<void> {
  const ir = await instantiate(source, true, compileOpts);
  expect(ir.emitted.has("test"), "IR must claim `test` — otherwise this compares legacy to legacy").toBe(true);
  const legacy = await instantiate(source, false, compileOpts);
  for (const a of args) {
    expect(ir.test(a), `arg ${JSON.stringify(a)}`).toStrictEqual(legacy.test(a));
  }
}

// ---------------------------------------------------------------------------
// 6a — tail-position switch
// ---------------------------------------------------------------------------

describe("#2952 slice 6a — tail-position switch: selector claims", () => {
  it("claims a tail switch whose clauses all return, with a default", () => {
    expect(
      selectionFor(`
        export function test(n: number): number {
          switch (n) { case 1: return 10; case 2: return 20; default: return 99; }
        }
      `).has("test"),
    ).toBe(true);
  });

  it("claims empty clauses that fall through to a terminating clause", () => {
    expect(
      selectionFor(`
        export function test(n: number): number {
          switch (n) { case 1: case 2: return 12; case 3: return 3; default: return 0; }
        }
      `).has("test"),
    ).toBe(true);
  });

  it("claims a clause ending in an if/else where BOTH arms terminate", () => {
    expect(
      selectionFor(`
        export function test(n: number): number {
          switch (n) { case 1: if (n > 0) { return 5; } else { return 6; } default: return 0; }
        }
      `).has("test"),
    ).toBe(true);
  });

  it("claims a VOID function ending in a switch (falls out to the implicit return)", () => {
    expect(
      selectionFor(`
        export function sink(x: number): number { return x; }
        export function test(n: number): void {
          switch (n) { case 1: sink(10); break; default: sink(99); }
        }
      `).has("test"),
    ).toBe(true);
  });
});

describe("#2952 slice 6a — tail-position switch: negative boundaries", () => {
  it("rejects a non-void tail switch with NO default (no-match falls out)", () => {
    expect(
      selectionFor(`
        export function test(n: number): number {
          switch (n) { case 1: return 10; case 2: return 20; }
        }
      `).has("test"),
    ).toBe(false);
  });

  it("rejects a non-void tail switch whose clause ends in `break` (break IS the fall-out)", () => {
    expect(
      selectionFor(`
        export function test(n: number): number {
          switch (n) { case 1: break; default: return 1; }
        }
      `).has("test"),
    ).toBe(false);
  });

  it("rejects a non-void tail switch whose LAST clause is empty", () => {
    expect(
      selectionFor(`
        export function test(n: number): number {
          switch (n) { case 1: return 1; default: }
        }
      `).has("test"),
    ).toBe(false);
  });

  it("rejects an empty tail switch in a non-void function", () => {
    expect(
      selectionFor(`
        export function test(n: number): number {
          switch (n) {}
        }
      `).has("test"),
    ).toBe(false);
  });
});

describe("#2952 slice 6a — tail-position switch: runtime semantics", () => {
  it("dispatches, falls through empty clauses, and takes the default", async () => {
    const { test, emitted } = await instantiate(
      `export function test(n: number): number {
         switch (n) { case 1: case 2: return 12; case 3: return 3; default: return 99; }
       }`,
      true,
    );
    expect(emitted.has("test")).toBe(true);
    expect(test(1)).toBe(12);
    expect(test(2)).toBe(12);
    expect(test(3)).toBe(3);
    expect(test(4)).toBe(99);
    // §7.2.16 for free: NaN matches nothing, -0 === 0 under f64.eq.
    expect(test(NaN)).toBe(99);
    expect(test(-0)).toBe(99);
    expect(test(1.5)).toBe(99);
  });

  it("runs a void function whose tail is a switch", async () => {
    const { test, emitted } = await instantiate(
      `let acc = 0;
       export function bump(x: number): number { acc = acc + x; return acc; }
       export function test(n: number): void {
         switch (n) { case 1: bump(10); break; default: bump(1); }
       }`,
      true,
    );
    expect(emitted.has("test")).toBe(true);
    expect(test(1)).toBe(undefined);
    expect(test(7)).toBe(undefined);
  });
});

describe("#2952 slice 6a — dual-run legacy↔IR value equality", () => {
  const SHAPES: ReadonlyArray<readonly [string, string, readonly unknown[]]> = [
    [
      "tail dispatch + default",
      `export function test(n: number): number {
         switch (n) { case 1: return 10; case 2: return 20; default: return 99; }
       }`,
      [0, 1, 2, 3, -1, 1.5, NaN],
    ],
    [
      "tail empty-clause fallthrough",
      `export function test(n: number): number {
         switch (n) { case 1: case 2: return 12; case 3: return 3; default: return 0; }
       }`,
      [1, 2, 3, 9],
    ],
    [
      "tail clause with terminating if/else",
      `export function test(n: number): number {
         switch (n) { case 1: if (n > 0) { return 5; } else { return 6; } default: return 7; }
       }`,
      [1, 2],
    ],
    [
      "mid-position default in a tail switch",
      `export function test(n: number): number {
         switch (n) { case 1: return 1; default: return 50; case 2: return 2; }
       }`,
      [1, 2, 3],
    ],
  ];
  for (const [name, src, args] of SHAPES) {
    it(`legacy and IR agree: ${name}`, async () => {
      await expectLegacyIrAgree(src, args);
    });
  }
});

// ---------------------------------------------------------------------------
// 6b — string-literal case dispatch
// ---------------------------------------------------------------------------

describe("#2952 slice 6b — string case tests: selector claims", () => {
  it("claims a string switch with breaks and a default", () => {
    expect(
      selectionFor(`
        export function test(s: string): number {
          let r = 0;
          switch (s) { case "a": r = 1; break; case "b": r = 2; break; default: r = 9; }
          return r;
        }
      `).has("test"),
    ).toBe(true);
  });

  it("claims a TAIL string switch (6a + 6b together)", () => {
    expect(
      selectionFor(`
        export function test(s: string): number {
          switch (s) { case "x": return 1; case "yy": return 2; default: return -1; }
        }
      `).has("test"),
    ).toBe(true);
  });
});

describe("#2952 slice 6b — string case tests: negative boundaries", () => {
  it("rejects a MIXED numeric/string test set", () => {
    expect(
      selectionFor(`
        export function test(s: string): number {
          let r = 0;
          switch (s) { case "a": r = 1; break; case 2: r = 2; break; default: r = 9; }
          return r;
        }
      `).has("test"),
    ).toBe(false);
  });

  it("rejects a non-literal case test (unchanged slice-4 boundary)", () => {
    expect(
      selectionFor(`
        export function test(s: string, t: string): number {
          let r = 0;
          switch (s) { case t: r = 1; break; default: r = 9; }
          return r;
        }
      `).has("test"),
    ).toBe(false);
  });

  it("rejects a disc whose IR carrier is the string-VEC element, not the string carrier", async () => {
    // `keys[i]` is checker-`string` but lowers to the externref vec-element
    // carrier, which `string.eq` cannot consume. Under IR-first a post-claim
    // build throw is a hard compile error, so this must be a PRE-claim reject
    // — asserted against the real, checker-backed compile.
    const src = `export function test(i: number): number {
        const keys = ["a", "b"];
        const s = keys[i];
        let r = 0;
        switch (s) { case "a": r = 1; break; default: r = 9; }
        return r;
      }`;
    expect(await irEmitsTest(src)).toBe(false);
  });
});

describe("#2952 slice 6b — string case tests: runtime semantics", () => {
  const DISPATCH = `export function test(s: string): number {
      let r = 0;
      switch (s) { case "a": r = 1; break; case "bb": r = 2; break; default: r = 9; }
      return r;
    }`;

  it("dispatches per clause and takes the default on no match", async () => {
    const { test, emitted } = await instantiate(DISPATCH, true);
    expect(emitted.has("test")).toBe(true);
    expect(test("a")).toBe(1);
    expect(test("bb")).toBe(2);
    expect(test("zz")).toBe(9);
    expect(test("")).toBe(9);
    // Strict equality: no prefix / case-insensitive matching.
    expect(test("A")).toBe(9);
    expect(test("b")).toBe(9);
  });

  it("keeps first-clause-wins on duplicate string literals", async () => {
    const { test, emitted } = await instantiate(
      `export function test(s: string): number {
         let r = 0;
         switch (s) { case "a": r = 1; break; case "a": r = 2; break; default: r = 9; }
         return r;
       }`,
      true,
    );
    expect(emitted.has("test")).toBe(true);
    expect(test("a")).toBe(1);
    expect(test("b")).toBe(9);
  });

  it("falls through string clauses and through a mid-position default", async () => {
    const { test, emitted } = await instantiate(
      `export function test(s: string): number {
         let r = 0;
         switch (s) { case "a": r = 1; break; default: r = r + 50; case "b": r = r + 7; break; }
         return r;
       }`,
      true,
    );
    expect(emitted.has("test")).toBe(true);
    expect(test("a")).toBe(1);
    expect(test("b")).toBe(7);
    expect(test("zz")).toBe(57);
  });

  it("runs on every string carrier (host js-string, native strings, standalone)", async () => {
    // No JS↔wasm string boundary: the disc is built inside the module, so the
    // native-strings lanes are callable from the harness.
    const src = `export function test(i: number): number {
        const s = i === 0 ? "a" : (i === 1 ? "bb" : "zz");
        let r = 0;
        switch (s) { case "a": r = 1; break; case "bb": r = 2; break; default: r = 9; }
        return r;
      }`;
    for (const opts of [{}, { nativeStrings: true }, { target: "standalone" as const }]) {
      const { test, emitted } = await instantiate(src, true, opts);
      expect(emitted.has("test"), JSON.stringify(opts)).toBe(true);
      expect([test(0), test(1), test(2)], JSON.stringify(opts)).toStrictEqual([1, 2, 9]);
    }
  });
});

describe("#2952 slice 6b — dual-run legacy↔IR value equality", () => {
  const ARGS = ["a", "b", "bb", "c", "zz", "", "A"];
  const SHAPES: ReadonlyArray<readonly [string, string]> = [
    [
      "string dispatch + default",
      `export function test(s: string): number {
         let r = 0;
         switch (s) { case "a": r = 1; break; case "bb": r = 2; break; default: r = 9; }
         return r;
       }`,
    ],
    [
      "string fallthrough chain",
      `export function test(s: string): number {
         let r = 0;
         switch (s) { case "a": r = r + 1; case "b": r = r + 10; break; case "c": r = r + 100; default: r = r + 1000; }
         return r;
       }`,
    ],
    [
      "string switch, no default",
      `export function test(s: string): number {
         let r = 0;
         switch (s) { case "a": r = 1; break; case "b": r = 2; break; }
         return r;
       }`,
    ],
    [
      "tail string switch",
      `export function test(s: string): number {
         switch (s) { case "a": return 1; case "bb": return 2; default: return -1; }
       }`,
    ],
    [
      "string switch with mid default",
      `export function test(s: string): number {
         let r = 0;
         switch (s) { case "a": r = 1; break; default: r = r + 50; case "b": r = r + 7; break; }
         return r;
       }`,
    ],
  ];
  for (const [name, src] of SHAPES) {
    it(`legacy and IR agree: ${name}`, async () => {
      await expectLegacyIrAgree(src, ARGS);
    });
  }
});

// ---------------------------------------------------------------------------
// 6c — for-in head value + labeled for-in
// ---------------------------------------------------------------------------

const FORIN_ARGS: readonly unknown[] = [{}, { a: 1 }, { a: 1, b: 2 }, Object.create({ inh: 9 })];

describe("#2952 slice 6c — for-in head value: selector claims", () => {
  it("claims a body that READS the head key", () => {
    expect(
      selectionFor(
        `export function test(obj: any): string {
           let out = "";
           for (var k in obj) { out = out + k; }
           return out;
         }`,
        FORIN_OPTS,
      ).has("test"),
    ).toBe(true);
  });

  it("claims a labeled for-in", () => {
    expect(
      selectionFor(
        `export function test(obj: any): boolean {
           outer: for (var _ in obj) { break outer; }
           return false;
         }`,
        FORIN_OPTS,
      ).has("test"),
    ).toBe(true);
  });
});

describe("#2952 slice 6c — for-in head value: negative boundaries", () => {
  const NEGATIVES: ReadonlyArray<readonly [string, string]> = [
    [
      "head WRITTEN in the body",
      `export function test(obj: any): string {
         let out = "";
         for (var k in obj) { k = "x"; out = out + k; }
         return out;
       }`,
    ],
    [
      "head CAPTURED by a nested closure",
      `export function test(obj: any): string {
         let out = "";
         for (var k in obj) { const f = () => k; out = out + f(); }
         return out;
       }`,
    ],
    [
      "head REDECLARED in the body",
      `export function test(obj: any): string {
         let out = "";
         for (var k in obj) { var k = "z"; out = out + k; }
         return out;
       }`,
    ],
  ];
  for (const [name, src] of NEGATIVES) {
    it(`rejects a for-in with the ${name}`, () => {
      expect(selectionFor(src, FORIN_OPTS).has("test")).toBe(false);
    });
  }

  it("rejects head-value uses when the string carrier is NOT the host externref", () => {
    const src = `export function test(obj: any): string {
        let out = "";
        for (var k in obj) { out = out + k; }
        return out;
      }`;
    // Same source, capability withheld (a native-strings lane): the #2964 key
    // externref is not `(ref $AnyString)`, so the head cannot be read as a
    // string. Fail-closed BEFORE the claim, never a post-claim demote.
    expect(selectionFor(src, { ...FORIN_OPTS, forInHeadValueIsHostString: false }).has("test")).toBe(false);
    expect(selectionFor(src, FORIN_OPTS).has("test")).toBe(true);
  });

  it("still rejects the unproven / typed receiver (slice-5 boundary unchanged)", () => {
    const src = `export function test(obj: any): string {
        let out = "";
        for (var k in obj) { out = out + k; }
        return out;
      }`;
    expect(selectionFor(src, { forInHeadValueIsHostString: true }).has("test")).toBe(false);
  });
});

describe("#2952 slice 6c — for-in head value: runtime semantics", () => {
  it("concatenates the enumerated keys (own + inherited, snapshot order)", async () => {
    const { test, emitted } = await instantiate(
      `export function test(obj: any): string {
         let out = "";
         for (var k in obj) { out = out + k; }
         return out;
       }`,
      true,
    );
    expect(emitted.has("test")).toBe(true);
    expect(test({})).toBe("");
    expect(test({ a: 1 })).toBe("a");
    expect(test({ a: 1, b: 2 })).toBe("ab");
    expect(test(Object.create({ inh: 9 }))).toBe("inh");
  });

  it("compares the head against a string literal and measures its length", async () => {
    const eq = await instantiate(
      `export function test(obj: any): number {
         let n = 0;
         for (var k in obj) { if (k === "a") { n = n + 1; } }
         return n;
       }`,
      true,
    );
    expect(eq.emitted.has("test")).toBe(true);
    expect(eq.test({ a: 1, b: 2 })).toBe(1);
    expect(eq.test({ b: 2 })).toBe(0);

    const len = await instantiate(
      `export function test(obj: any): number {
         let n = 0;
         for (var k in obj) { n = n + k.length; }
         return n;
       }`,
      true,
    );
    expect(len.emitted.has("test")).toBe(true);
    expect(len.test({ ab: 1, c: 2 })).toBe(3);
  });

  it("runs labeled `break lbl` / `continue lbl` on a for-in", async () => {
    const brk = await instantiate(
      `export function test(obj: any): string {
         let out = "";
         outer: for (var k in obj) { out = out + k; break outer; }
         return out;
       }`,
      true,
    );
    expect(brk.emitted.has("test")).toBe(true);
    expect(brk.test({ a: 1, b: 2 })).toBe("a");
    expect(brk.test({})).toBe("");

    const cont = await instantiate(
      `export function test(obj: any): string {
         let out = "";
         outer: for (var k in obj) { out = out + k; continue outer; }
         return out;
       }`,
      true,
    );
    expect(cont.emitted.has("test")).toBe(true);
    expect(cont.test({ a: 1, b: 2 })).toBe("ab");
  });
});

describe("#2952 slice 6c — dual-run legacy↔IR value equality", () => {
  const SHAPES: ReadonlyArray<readonly [string, string]> = [
    [
      "head concat",
      `export function test(obj: any): string {
         let out = "";
         for (var k in obj) { out = out + k; }
         return out;
       }`,
    ],
    [
      "head compared to a literal",
      `export function test(obj: any): number {
         let n = 0;
         for (var k in obj) { if (k === "a") { n = n + 1; } }
         return n;
       }`,
    ],
    [
      "head length accumulation",
      `export function test(obj: any): number {
         let n = 0;
         for (var k in obj) { n = n + k.length; }
         return n;
       }`,
    ],
    [
      "head read then break",
      `export function test(obj: any): string {
         let out = "";
         for (var k in obj) { out = k; break; }
         return out;
       }`,
    ],
    [
      "labeled for-in break",
      `export function test(obj: any): string {
         let out = "";
         outer: for (var k in obj) { out = out + k; break outer; }
         return out;
       }`,
    ],
    [
      "labeled for-in continue",
      `export function test(obj: any): string {
         let out = "";
         outer: for (var k in obj) { out = out + k; continue outer; }
         return out;
       }`,
    ],
  ];
  for (const [name, src] of SHAPES) {
    it(`legacy and IR agree: ${name}`, async () => {
      await expectLegacyIrAgree(src, FORIN_ARGS);
    });
  }
});
