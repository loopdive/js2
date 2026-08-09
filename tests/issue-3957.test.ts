/**
 * #3957 — standalone `Object.defineProperties`, two root causes behind the
 * `unsupported descriptor shape in standalone mode (#1906)` refusal:
 *
 *  RC1 the per-key descriptor was read out of the `$PropEntry` value SLOT
 *      instead of via `[[Get]]` (§20.1.2.3.1 step 3.b).
 *      `__defineProperty_accessor` deliberately CLEARS that slot to null for an
 *      accessor entry, so the read produced null, the null-descriptor guard
 *      rejected it, and the whole call was refused — even for a plain `{}` map.
 *  RC2 a statically-shaped `Properties` map is closed into a nominal struct and
 *      fails the helper's `ref.test $Object` gate. #3782's static expansion is
 *      the remedy; its receiver gate now accepts a bare identifier, not only a
 *      function `prototype`.
 *
 * Kill-switch (2026-08-01): restore the raw `struct.get fieldIdx 1` read and
 * the RC1 tests fail with the `#1906` refusal; restore the
 * `<fn>.prototype`-only receiver gate and the RC2 tests fail the same way.
 *
 * The last test is equally load-bearing and pins a shape that must KEEP
 * throwing: `__object_keys` carries the same `ref.test $Object` gate and
 * returns an EMPTY vec for a wrapper receiver, so accepting that shape would
 * define NOTHING and return normally. A silent no-op passes every
 * "hasOwnProperty(p) === false" test VACUOUSLY — measured on this issue, where
 * the naive widening scored +5 of which 4 were fake. The refusal stays until
 * the exotic-receiver own-key MOP substrate lands (#2992 / #3251).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: { name: string }[] };

async function compileStandalone(src: string): Promise<Compiled> {
  const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  return r;
}

/** Instantiating with NO import object also asserts host-import freedom. */
async function runStandalone(src: string): Promise<unknown> {
  const r = await compileStandalone(src);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#3957 standalone Object.defineProperties", () => {
  it("RC1: reads an ACCESSOR-defined descriptor entry through [[Get]]", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const obj: any = {};
          const props: any = {};
          Object.defineProperty(props, "prop", {
            get: function () { return { value: 42, enumerable: true }; },
            enumerable: true,
          });
          Object.defineProperties(obj, props);
          return obj.hasOwnProperty("prop") ? obj["prop"] : -1;
        }
      `),
    ).toBe(42);
  });

  it("RC1: runs a descriptor getter for its SIDE EFFECTS", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const obj: any = {};
          const props: any = {};
          let seen = 0;
          Object.defineProperty(props, "prop", {
            get: function () { seen = 1; return { value: 7 }; },
            enumerable: true,
          });
          Object.defineProperties(obj, props);
          return seen;
        }
      `),
    ).toBe(1);
  });

  it("RC2: applies a statically-shaped Properties map to an identifier receiver", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const obj: any = {};
          const properties = {
            a: { value: 100, enumerable: true, writable: true, configurable: true },
            c: { value: 200, enumerable: true, writable: true, configurable: true },
          };
          Object.defineProperties(obj, properties);
          return obj["a"] + obj["c"];
        }
      `),
    ).toBe(300);
  });

  it("RC2: a statically-shaped map with an accessor entry still applies", async () => {
    expect(
      await runStandalone(`
        function get_b(): number { return 20; }
        export function test(): number {
          const obj: any = {};
          const properties = {
            a: { value: 100, enumerable: true, writable: true, configurable: true },
            b: { get: get_b, enumerable: true, configurable: true },
          };
          Object.defineProperties(obj, properties);
          return obj["a"] + obj["b"];
        }
      `),
    ).toBe(120);
  });

  // A `Properties` map the native gather cannot enumerate must either APPLY or
  // THROW — never return normally having defined nothing.
  //
  // This is deliberately stated as the INVARIANT rather than "it throws". The
  // shapes below are legitimate per §20.1.2.3.1 and a future substrate fix
  // (#2992 / #3251) may well make them apply; that must not require editing
  // this test. What must never happen is the third outcome — a silent no-op,
  // which is what removing the `ref.test $Object` gate produces today, because
  // `__object_keys` carries the same gate and answers with an EMPTY vec. A
  // silent no-op satisfies every "hasOwnProperty(p) === false" test vacuously:
  // measured on this issue, the naive widening scored +5 of which 4 were fake.
  for (const [name, setup] of [
    ["boxed Boolean", "const props: any = new Boolean(true);"],
    ["RegExp", 'const props: any = new RegExp("a");'],
    ["Function object", "const props: any = function () {};"],
    ["Array object", "const props: any = [];"],
  ] as const) {
    it(`never SILENTLY no-ops on a ${name} Properties map`, async () => {
      let outcome: "threw" | unknown;
      try {
        outcome = await runStandalone(`
          export function test(): number {
            const obj: any = {};
            ${setup}
            Object.defineProperty(props, "prop", { value: 5, enumerable: true });
            Object.defineProperties(obj, props);
            return obj.hasOwnProperty("prop") ? 1 : 0;
          }
        `);
      } catch {
        outcome = "threw";
      }
      // 1 = applied (a future substrate fix), "threw" = refused loudly.
      // 0 = defined nothing and returned normally — the forbidden outcome.
      expect(outcome, "silent no-op: returned normally having defined nothing").not.toBe(0);
      expect(outcome === "threw" || outcome === 1).toBe(true);
    });
  }
});
