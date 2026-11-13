// #2992 (slice 4) — standalone: `delete` on an empty-`{}`-widened receiver
// must observe real deletion semantics.
//
// Root cause (documented in the issue's slice-1 findings): the empty-object
// widening pre-pass (declarations.ts) promoted an all-prop-access `{}` var to
// a closed nominal struct. The struct-delete arm (typeof-delete.ts) can only
// write a type-shaped SENTINEL into the fixed field (f64 → NaN, ref → null),
// and a statically-f64 read makes `o.k === undefined` CONST-FOLD to
// `i32.const 0` — the read can never observe the deletion (nor can `in` /
// hasOwnProperty).
//
// Fix: `delete varName.prop` / `delete varName[k]` is now an `$Object`-hash
// consumer for the widening decision (standalone-gated — the host lane keeps
// its sidecar + live-mirror struct-delete handling byte-identical). The var
// stays a `$Object`, where `__delete_property` tombstones (slice 1, #2872)
// give correct delete → read / `in` / hasOwnProperty / typeof semantics.
//
// Documented residuals (fail identically on unmodified main — NOT regressions):
//   - NON-EMPTY literal receivers (`const o = { name: "hello" }; delete
//     o.name`) — closed-struct-literal shape, fails in the gc lane too
//     (tests/equivalence/delete-sentinel.test.ts "delete string property").
//   - TWO `{}` vars where another var's widening interns the shared `{}`
//     literal type in `anonTypeMap` — the poisoned var's literal can still
//     compile to the OTHER var's struct (pre-existing type-identity hazard).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string, target: "gc" | "standalone"): Promise<any> {
  const result: any = await compile(src, {
    fileName: "test.ts",
    target,
    skipSemanticDiagnostics: true,
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  // (#7014) setInstance: raw setExports(instance.exports) lost data-struct authority in 708ebbd56d (#5337).
  importObject.__setInstance?.(instance);
  return (instance.exports as any).test?.();
}

// The top-level and parenthesized variants ALSO fail in the gc lane on
// unmodified main (the gc widened-struct delete writes the same sentinel and
// hits the same const-fold) — that gc residual is pre-existing and out of this
// standalone-gated slice; those two cases run standalone-only.
for (const target of ["gc", "standalone"] as const) {
  describe(`#2992 S4 — delete on widened {} receiver (${target})`, () => {
    (target === "standalone" ? it : it.skip)(
      "top-level all-prop-access {}: delete then read observes undefined (headline repro)",
      async () => {
        const ret = await run(
          `
const o: any = {};
o.k = 1;
delete o.k;
export function test(): number { return o.k === undefined ? 1 : 0; }
`,
          target,
        );
        expect(ret).toBe(1);
      },
    );

    it("in-function: delete then read / 'in' / hasOwnProperty / typeof all observe the deletion", async () => {
      const ret = await run(
        `
export function test(): number {
  const o: any = {};
  o.k = 1;
  delete o.k;
  return (o.k === undefined && !("k" in o) && !o.hasOwnProperty("k") && typeof o.k === "undefined") ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("string-typed field: delete makes it undefined", async () => {
      const ret = await run(
        `
export function test(): number {
  const o: any = {};
  o.s = "hello";
  delete o.s;
  return o.s === undefined ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("delete → redefine cycle (verifyProperty shape) round-trips", async () => {
      const ret = await run(
        `
export function test(): number {
  const o: any = {};
  o.k = 1;
  delete o.k;
  o.k = 2;
  return (o.k === 2 && o.hasOwnProperty("k")) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    (target === "standalone" ? it : it.skip)("parenthesized delete target still poisons the widening", async () => {
      const ret = await run(
        `
export function test(): number {
  const o: any = {};
  o.k = 1;
  delete (o.k);
  return o.k === undefined ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("no-delete control: the widening fast path is unaffected", async () => {
      const ret = await run(
        `
export function test(): number {
  const o: any = {};
  o.k = 1;
  o.j = 2;
  return (o.k === 1 && o.j === 2) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("element-access delete on the widened var works too", async () => {
      const ret = await run(
        `
export function test(): number {
  const o: any = {};
  o.k = 1;
  delete o["k"];
  return o.k === undefined ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });
  });
}
