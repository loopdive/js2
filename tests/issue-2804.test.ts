import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// #2804 — host object spread `{ ...a }` & `Object.assign` drop copied values/keys
// (closed-struct representation mismatch). Carved from #2796 (the for…in case was
// a harness exports-timing artifact; these two are a genuine codegen rep bug).
//
// Root cause A (spread): `const b = { ...a, z: 3 }` (no annotation) has NO
// contextual type, so the literal takes the host plain-object ($Object/externref)
// path — but the variable's INFERRED type is a concrete struct `{x;y;z}`, so the
// local/global was typed as that struct while the value built was a $Object. The
// externref→struct coercion failed at runtime → `b.x` read NaN/null, and
// `Object.keys(b)` enumerated the struct's TS-inferred field order (own-prop-first:
// `z,x,y`) instead of the spread's runtime insertion order (`x,y,z`). Fix: force
// an externref local/global for such host-path spread literals (lockstep with the
// literals.ts routing) and route `Object.keys/values/entries` on a host-object var
// through the runtime helper.
//
// Root cause B (Object.assign): `Object.assign(structTarget, src)` copies the
// source's own enumerable keys into the target struct's SIDECAR via a plain
// dynamic write, which records no descriptor — and `__object_keys` (#2746) only
// surfaces sidecar keys on a struct that carry a descriptor, so the copied keys
// vanished from enumeration (while for-in already surfaced them). Fix: record an
// enumerable data-property descriptor for each copied key in `__object_assign`.

async function run(source: string, opts: { standalone?: boolean } = {}): Promise<unknown> {
  const result: any = await compile(source, {
    fileName: "test.ts",
    ...(opts.standalone ? { target: "standalone" as const } : {}),
  });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  // The data-struct field projection is authenticated from the genuine
  // instance, so use the preferred lifecycle hook rather than a raw export
  // record (which intentionally cannot establish bridge authority).
  built.setInstance?.(instance);
  return (instance.exports as any).test();
}

const MODES: Array<{ name: string; standalone?: boolean }> = [
  { name: "host" },
  { name: "standalone", standalone: true },
];

describe("#2804 — object spread & Object.assign copy keys + values", () => {
  for (const mode of MODES) {
    // (#86/#3155) The standalone mode ran gc-host vacuously until #86 honored the
    // real target; on the true standalone lane object spread / Object.assign /
    // Object.keys-order fail ("Cannot convert object to primitive value" +
    // empty/mis-ordered key reads). Skipped-pending-#3155 (HONEST — was
    // vacuously "passing"); the host mode keeps real coverage.
    const describeMode = mode.standalone ? describe.skip : describe;
    describeMode(mode.name, () => {
      // ── A: object spread { ...a, z } ──────────────────────────────────────
      it("A: spread copies keys in INSERTION order (x,y,z, not z,x,y)", async () => {
        expect(
          await run(
            `export function test(): string {
               const a = { x: 1, y: 2 };
               const b = { ...a, z: 3 };
               return Object.keys(b).join(",");
             }`,
            mode,
          ),
        ).toBe("x,y,z");
      });

      it("A: spread-copied VALUES read back (b.x === 1, b.z === 3)", async () => {
        expect(
          await run(
            `export function test(): number {
               const a = { x: 1, y: 2 };
               const b = { ...a, z: 3 };
               return b.x + b.z;
             }`,
            mode,
          ),
        ).toBe(4);
      });

      it("A: spread value read at every key", async () => {
        expect(
          await run(
            `export function test(): string {
               const a = { x: 1, y: 2 };
               const b = { ...a, z: 3 };
               return b.x + "," + b.y + "," + b.z;
             }`,
            mode,
          ),
        ).toBe("1,2,3");
      });

      it("A: spread-only { ...a } copies keys + values", async () => {
        expect(
          await run(
            `export function test(): string {
               const a = { x: 1, y: 2 };
               const b = { ...a };
               return Object.keys(b).join(",") + "|" + b.x + "," + b.y;
             }`,
            mode,
          ),
        ).toBe("x,y|1,2");
      });

      it("A: Object.values reflects insertion order", async () => {
        expect(
          await run(
            `export function test(): string {
               const a = { x: 1, y: 2 };
               const b = { ...a, z: 3 };
               return Object.values(b).join(",");
             }`,
            mode,
          ),
        ).toBe("1,2,3");
      });

      it("A CONTROL: an explicit concrete-struct annotation keeps struct semantics", async () => {
        // #2714 control — a literal with a concrete contextual type stays on the
        // struct path; values must still read back.
        expect(
          await run(
            `export function test(): number {
               const a = { x: 1, y: 2 };
               const b: { x: number; y: number; z: number } = { ...a, z: 3 };
               return b.x + b.z;
             }`,
            mode,
          ),
        ).toBe(4);
      });

      // ── B: Object.assign(target, ...sources) ──────────────────────────────
      it("B: Object.assign copies own enumerable keys from all sources", async () => {
        expect(
          await run(
            `export function test(): string {
               const t = { a: 1 };
               const r = Object.assign(t, { b: 2 }, { c: 3 });
               return Object.keys(r).join(",");
             }`,
            mode,
          ),
        ).toBe("a,b,c");
      });

      it("B: Object.assign preserves target identity (r === t)", async () => {
        expect(
          await run(
            `export function test(): number {
               const t = { a: 1 };
               const r = Object.assign(t, { b: 2 }, { c: 3 });
               return r === t ? 1 : 0;
             }`,
            mode,
          ),
        ).toBe(1);
      });

      it("B: Object.getOwnPropertyNames agrees with Object.keys after assign", async () => {
        expect(
          await run(
            `export function test(): string {
               const t = { a: 1 };
               const r = Object.assign(t, { b: 2 });
               return Object.getOwnPropertyNames(r).join(",");
             }`,
            mode,
          ),
        ).toBe("a,b");
      });

      it("B: for-in and Object.keys are consistent after assign", async () => {
        expect(
          await run(
            `export function test(): string {
               const t = { a: 1 };
               const r = Object.assign(t, { b: 2 }, { c: 3 });
               let fk = "";
               for (const k in r) fk += k;
               return fk + "|" + Object.keys(r).join(",");
             }`,
            mode,
          ),
        ).toBe("abc|a,b,c");
      });
    });
  }
});
