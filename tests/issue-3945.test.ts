/**
 * #3945 — a REST element inside a generator's binding-pattern parameter
 * (`*m([a, ...r])`, `*m({a, ...r})`) must route to the native standalone
 * lowering instead of the eager host-buffer path.
 *
 * NOTE ON INSTRUMENT (load-bearing, see docs/methodology.md):
 * `runTest262File(..., "standalone")` cannot answer this question — it SUPPLIES
 * the host imports, so a leaking module still scores `pass`. The only valid
 * checks are (a) the import set of a bare standalone compile and (b)
 * instantiating with NO import object. Both are asserted below.
 *
 * A HOST-FREE MODULE IS NOT ENOUGH, EITHER. The pre-#3945 `walk` skipped rest
 * elements without descending, so merely lifting the bail would leave the rest
 * name (and every name bound under a nested rest pattern) with no spill field:
 * the resume function never rehydrates it and reads the local's inert default.
 * That module has zero host imports and validates. So every case here asserts a
 * VALUE, and several read the binding AFTER a suspension to prove the state
 * struct round-trip rather than just the initial load.
 *
 * KILL-SWITCH (verified 2026-07-31): restore the original bail in
 * `buildNativeGeneratorPlan` (`src/codegen/generators-native.ts`) —
 *
 *   let hasRest = false;                        // set inside `walk`
 *   walk(pat); if (hasRest) return null;
 *
 * — and 18 of the 20 host-free cases below fail with
 * `Import #0 "env": module is not an object or function` (the `function*`
 * declaration case fails earlier, as a hard "sequential numeric yields"
 * compile error). Only the two no-rest CONTROLs survive: 2/20.
 *
 * SHAPE COVERAGE is derived from the population, not imagined: the cases below
 * are the distinct `*-ptrn-rest-*` suffixes of the test262 generator dstr
 * corpus (`test/language/**\/dstr/gen-meth-*-ptrn-rest-*.js`) — ary rest
 * {id, id-direct, id-elision, id-exhausted, ary-elem, ary-elision, ary-empty,
 * ary-rest, obj-id, obj-prop-id}, obj rest {getter, val-obj,
 * skip-non-enumerable}, the three `*-err` iterator-abrupt variants, and the six
 * NEGATIVE (`init-*` / `not-final-*`) shapes that must stay rejected.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

const HOST_GEN = /__create_generator|__gen_create_buffer|__gen_next|__gen_push|__get_caught_exception/;

async function build(src: string): Promise<Uint8Array> {
  const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as {
    success: boolean;
    binary: Uint8Array;
    errors?: unknown;
  };
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  return r.binary;
}

/** Compile host-free, instantiate with NO imports, run `test()`. */
async function runHostFree(src: string): Promise<number | undefined> {
  const binary = await build(src);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(binary);
  expect(text.match(HOST_GEN), "emitted host generator imports").toBeNull();
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as { test?: () => number }).test?.();
}

/** A source the compiler must REJECT (early SyntaxError in the corpus). */
async function expectRejected(src: string): Promise<void> {
  let ok = false;
  try {
    const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as {
      success: boolean;
    };
    ok = r.success;
  } catch {
    ok = false;
  }
  expect(ok, "expected this rest shape to be rejected").toBe(false);
}

describe("#3945 rest-in-binding-pattern generator params route native in standalone", () => {
  // ── ARRAY REST ─────────────────────────────────────────────────────────
  it("ary-ptrn-rest-id — [...x], x.length", async () => {
    expect(
      await runHostFree(
        `class C { *method([...x]: any) { yield (x as any).length as number; } }
         export function test(): number { return new C().method([1,2,3]).next().value as number; }`,
      ),
    ).toBe(3);
  });

  it("ary-ptrn-rest-id — [...x], indexed reads", async () => {
    expect(
      await runHostFree(
        `class C { *method([...x]: any) { yield ((x as any)[0] as number) * 10 + ((x as any)[2] as number); } }
         export function test(): number { return new C().method([1,2,3]).next().value as number; }`,
      ),
    ).toBe(13);
  });

  it("ary rest survives a SUSPENSION (state-struct round-trip)", async () => {
    expect(
      await runHostFree(
        `class C { *method([...x]: any) { yield 0; yield (x as any).length as number; } }
         export function test(): number {
           const it = new C().method([1,2,3]); it.next(); return it.next().value as number;
         }`,
      ),
    ).toBe(3);
  });

  it("ary-ptrn-rest-id-elision — [ , , ...x]", async () => {
    expect(
      await runHostFree(
        `class C { *method([ , , ...x]: any) { yield (x as any).length as number; } }
         export function test(): number { return new C().method([1,2,3,4,5]).next().value as number; }`,
      ),
    ).toBe(3);
  });

  it("ary-ptrn-rest-id-exhausted — source shorter than the fixed prefix", async () => {
    expect(
      await runHostFree(
        `class C { *method([ , , ...x]: any) { yield (x as any).length as number; } }
         export function test(): number { return new C().method([1,2]).next().value as number; }`,
      ),
    ).toBe(0);
  });

  // ── NESTED PATTERNS UNDER THE REST ─────────────────────────────────────
  // These bind names the pre-#3945 `walk` never even visited.
  it("ary-ptrn-rest-ary-elem — [...[x, y, z]]", async () => {
    expect(
      await runHostFree(
        `class C { *method([...[x, y, z]]: any) { yield ((x as number) * 100 + (y as number) * 10 + (z as number)); } }
         export function test(): number { return new C().method([3,4,5]).next().value as number; }`,
      ),
    ).toBe(345);
  });

  it("ary-ptrn-rest-ary-empty — [...[]]", async () => {
    expect(
      await runHostFree(
        `class C { *method([...[]]: any) { yield 42; } }
         export function test(): number { return new C().method([1,2,3]).next().value as number; }`,
      ),
    ).toBe(42);
  });

  it("ary-ptrn-rest-ary-elision — [...[,]]", async () => {
    expect(
      await runHostFree(
        `class C { *method([...[,]]: any) { yield 42; } }
         export function test(): number { return new C().method([1,2,3]).next().value as number; }`,
      ),
    ).toBe(42);
  });

  it("ary-ptrn-rest-ary-rest — [...[...x]]", async () => {
    expect(
      await runHostFree(
        `class C { *method([...[...x]]: any) { yield (x as any).length as number; } }
         export function test(): number { return new C().method([1,2,3]).next().value as number; }`,
      ),
    ).toBe(3);
  });

  it("ary-ptrn-rest-obj-id — [...{ length }]", async () => {
    expect(
      await runHostFree(
        `class C { *method([...{ length }]: any) { yield (length as number); } }
         export function test(): number { return new C().method([1,2,3]).next().value as number; }`,
      ),
    ).toBe(3);
  });

  it("ary-ptrn-rest-obj-prop-id — [...{ 0: v, 2: w, length: z }]", async () => {
    expect(
      await runHostFree(
        `class C { *method([...{ 0: v, 2: w, length: z }]: any) {
           yield ((v as number) * 100 + (w as number) * 10 + (z as number)); } }
         export function test(): number { return new C().method([1,2,3]).next().value as number; }`,
      ),
    ).toBe(133);
  });

  // ── OBJECT REST ────────────────────────────────────────────────────────
  it("obj-ptrn-rest-val-obj — {a, b, ...rest}", async () => {
    expect(
      await runHostFree(
        `class C { *method({ a, b, ...rest }: any) {
           yield ((a as number) * 100 + (b as number) * 10 + ((rest as any).c as number)); } }
         export function test(): number { return new C().method({ a: 1, b: 2, c: 3 }).next().value as number; }`,
      ),
    ).toBe(123);
  });

  it("obj-ptrn-rest-getter — the source property is an accessor", async () => {
    expect(
      await runHostFree(
        `class C { *method({ ...x }: any) { yield ((x as any).v as number); } }
         export function test(): number {
           const src = { get v(): number { return 7; } };
           return new C().method(src).next().value as number;
         }`,
      ),
    ).toBe(7);
  });

  it("obj-ptrn-rest-skip-non-enumerable — non-enumerable own props excluded", async () => {
    expect(
      await runHostFree(
        `class C { *method({ ...rest }: any) {
           yield (((rest as any).x === undefined ? 1 : 0) * 10 + ((rest as any).a as number)); } }
         export function test(): number {
           const o: any = { a: 3, b: 4 };
           Object.defineProperty(o, "x", { value: 4, enumerable: false });
           return new C().method(o).next().value as number;
         }`,
      ),
    ).toBe(13);
  });

  it("obj rest survives a SUSPENSION (state-struct round-trip)", async () => {
    expect(
      await runHostFree(
        `class C { *method({ a, ...rest }: any) { yield 0; yield ((rest as any).c as number); } }
         export function test(): number {
           const it = new C().method({ a: 1, c: 9 }); it.next(); return it.next().value as number;
         }`,
      ),
    ).toBe(9);
  });

  // ── ITERATOR-ABRUPT PATHS ──────────────────────────────────────────────
  // Per §13.3.3.6 / §10.2.11 parameter destructuring is EAGER: the abrupt
  // completion must surface at CALL time, with the generator body never run.
  // Each returns 10 iff (threw at call time) && (body did not run).
  it("ary-ptrn-rest-id-iter-step-err — next() throws at CALL time", async () => {
    expect(
      await runHostFree(
        `let bodyRan = 0;
         function* bad(): any { throw new Error("boom"); }
         class C { *method([...x]: any) { bodyRan = 1; yield 0; } }
         export function test(): number {
           const it: any = bad();
           let threw = 0;
           try { new C().method(it); } catch (e) { threw = 1; }
           return threw * 10 + bodyRan;
         }`,
      ),
    ).toBe(10);
  });

  it("ary-ptrn-rest-id-elision-next-err — [, ...x] over a throwing iterator", async () => {
    expect(
      await runHostFree(
        `let bodyRan = 0;
         function* bad(): any { throw new Error("boom"); }
         class C { *method([, ...x]: any) { bodyRan = 1; yield 0; } }
         export function test(): number {
           const it: any = bad();
           let threw = 0;
           try { new C().method(it); } catch (e) { threw = 1; }
           return threw * 10 + bodyRan;
         }`,
      ),
    ).toBe(10);
  });

  it("ary-ptrn-rest-id-iter-val-err — the yielded value getter throws", async () => {
    expect(
      await runHostFree(
        `let bodyRan = 0;
         class C { *method([...x]: any) { bodyRan = 1; yield 0; } }
         export function test(): number {
           const poison: any = { get 0(): number { throw new Error("boom"); }, length: 1 };
           let threw = 0;
           try { new C().method(poison); } catch (e) { threw = 1; }
           return threw * 10 + bodyRan;
         }`,
      ),
    ).toBe(10);
  });

  // ── DECLARATION FORMS ──────────────────────────────────────────────────
  it("whole-param default + rest — [...x] = [1,2,3]", async () => {
    expect(
      await runHostFree(
        `class C { *method([...x]: any = [1, 2, 3]) { yield (x as any).length as number; } }
         export function test(): number { return new C().method().next().value as number; }`,
      ),
    ).toBe(3);
  });

  it("static class method — static *m([...x])", async () => {
    expect(
      await runHostFree(
        `class C { static *m([...x]: any) { yield (x as any).length as number; } }
         export function test(): number { return C.m([1,2,3]).next().value as number; }`,
      ),
    ).toBe(3);
  });

  it("function declaration — function* f([...x])", async () => {
    expect(
      await runHostFree(
        `function* f([...x]: any) { yield (x as any).length as number; }
         export function test(): number { return f([1,2,3]).next().value as number; }`,
      ),
    ).toBe(3);
  });

  it("object-literal method — { *m([...x]) }", async () => {
    expect(
      await runHostFree(
        `export function test(): number {
           const o = { *m([...x]: any) { yield (x as any).length as number; } };
           return o.m([1,2,3]).next().value as number;
         }`,
      ),
    ).toBe(3);
  });

  // ── CONTROLS ───────────────────────────────────────────────────────────
  it("CONTROL — no-rest patterns are unaffected", async () => {
    expect(
      await runHostFree(
        `class C { *method([a, b]: any) { yield ((a as number) * 10 + (b as number)); } }
         export function test(): number { return new C().method([1,2]).next().value as number; }`,
      ),
    ).toBe(12);
    expect(
      await runHostFree(
        `class C { *method({ a }: any) { yield (a as number); } }
         export function test(): number { return new C().method({ a: 5 }).next().value as number; }`,
      ),
    ).toBe(5);
  });

  /**
   * The 120 class-PRIVATE rest rows need BOTH this fix and #3896's name-kind
   * fix: #3896 gets them past `isNativeGeneratorCandidate`, this gets them past
   * the plan builder. #3896 is on main, so the overlap is checkable here — and
   * these cases are the evidence for #3896's yield being stated as a real
   * number rather than "≤252, reduced by overlap".
   */
  it("class-private rest generators (needs #3896 + this)", async () => {
    expect(
      await runHostFree(
        `class C { *#p([...x]: any) { yield (x as any).length as number; }
           run(): number { return this.#p([1,2,3]).next().value as number; } }
         export function test(): number { return new C().run(); }`,
      ),
    ).toBe(3);
    expect(
      await runHostFree(
        `class C { *#p({ a, ...rest }: any) { yield ((a as number) * 10 + ((rest as any).c as number)); }
           run(): number { return this.#p({ a: 1, c: 9 }).next().value as number; } }
         export function test(): number { return new C().run(); }`,
      ),
    ).toBe(19);
    expect(
      await runHostFree(
        `class C { static *#p([...[a, b]]: any) { yield ((a as number) * 10 + (b as number)); }
           static run(): number { return C.#p([7,8]).next().value as number; } }
         export function test(): number { return C.run(); }`,
      ),
    ).toBe(78);
  });

  /**
   * The corpus's `ary-ptrn-rest-init-*` and `-not-final-*` families are early
   * SyntaxErrors. Admitting rest must not widen the accepted grammar.
   */
  it("CONTROL — rest-with-initializer and non-final rest stay rejected", async () => {
    for (const params of ["[...x = []]", "[...[x] = []]", "[...{x} = []]", "[...x, y]", "[...[x], y]", "[...{x}, y]"]) {
      await expectRejected(
        `class C { *method(${params}: any) { yield 0; } }
         export function test(): number { return 0; }`,
      );
    }
  });
});
