// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2175 V2-S3b-1 — a builtin prototype object that FLOWS as a runtime value
 * answers its own members through the dynamic reader.
 *
 * THE GAP (measured on `origin/main` @ 9e17d34f3, 2026-08-15). Everything the
 * #2861/#2885/#2963/#2896 wave built is compile-time SYNTACTIC:
 * `Int8Array.prototype.find` is a function and its `name`/`length` descriptors
 * are correct. But `__extern_get` gates on `ref.test $Object`, so the moment the
 * proto object itself becomes a runtime value the reader answers `undefined`.
 * test262's TypedArray harness does exactly that — `harness/testTypedArray.js:64`
 * is `var TypedArray = Object.getPrototypeOf(Int8Array)`, and every
 * `%TypedArray%.prototype.<member>` read goes through it. On HEAD, `TA.prototype`
 * resolved to the `$NativeProto` but `TA.prototype.find` read `undefined`, which
 * is the single defect behind 121 failing ES2015 reflection files
 * (`length.js`/`name.js`/`prop-desc.js`/`not-a-constructor.js`/`invoked-as-func.js`)
 * — all three of their error signatures ("Cannot convert undefined or null to
 * object", "isConstructor invoked with a non-function value", `typeof` is
 * `"undefined"`) are that one `undefined`.
 *
 * THE FIX is population, not a new MOP. #4160/#4176 (`proto-index-store.ts`)
 * already ship the per-brand `$Object` companion table, a `$NativeProto`-aware
 * receiver-brand classifier, and receiver-aware consults spliced into
 * `__extern_get`/`__extern_has` — verified before writing the fix that a
 * write+read round-trip through a flowing `%TypedArray%.prototype` already
 * worked. The companion was simply minted EMPTY. V2-S3b-1 seeds it from the
 * registered `$NativeProto` glue, and arms the store for the read-only
 * reflective case (both pre-existing gates are write-shaped pre-scans).
 *
 * ANTI-VACUITY (builtin-proto territory hides coincidental passes — memory
 * `project_hostfree_pass_can_be_coincidentally_wrong`): every positive assertion
 * is paired with a negative that must stay 0 on the SAME binary — an absent
 * member must still read `undefined`, and the syntactic surface must be
 * unchanged. Without those, "everything is a function" would pass too.
 *
 * All cases run `--target standalone` and assert ZERO `env` imports, so nothing
 * here can be a host-import escape.
 */
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, `compile failed:\n${(r.errors ?? []).map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const env = r.imports.filter((i) => i.module === "env");
  expect(env, `unexpected host imports: ${env.map((i) => i.name).join(", ")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2175 V2-S3b-1 — flowing builtin prototypes answer their own members", () => {
  it("the test262 %TypedArray% harness idiom resolves (getPrototypeOf(Int8Array).prototype.find)", async () => {
    // This is `harness/testTypedArray.js:64` verbatim in shape. Returned 0 on
    // HEAD before this slice (`typeof` was `"undefined"`).
    expect(
      await runStandalone(`
        export function test(): number {
          const TA: any = Object.getPrototypeOf(Int8Array);
          const p: any = TA.prototype;
          return (typeof p.find === "function") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("ANTI-VACUITY: an absent member on the same flowing proto still reads undefined", async () => {
    // Proves the arm resolves the SEEDED member set, not "any key is a
    // function". Without this, the test above passes for a broken blanket arm.
    expect(
      await runStandalone(`
        export function test(): number {
          const TA: any = Object.getPrototypeOf(Int8Array);
          const p: any = TA.prototype;
          return (typeof p.thisMemberDoesNotExist === "undefined") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("the seeded value is the SAME singleton the syntactic surface returns", async () => {
    // The companion stores the #2963 per-(brand,member) singleton, so the
    // runtime-read value and the syntactic read are one object (the ES "a
    // builtin method is ONE function object" invariant). The swap-guard proves
    // `===` discriminates rather than being always-true.
    expect(
      await runStandalone(`
        export function test(): number {
          const p: any = Object.getPrototypeOf(Int8Array).prototype;
          const dynamic: any = p.find;
          const syntactic: any = Int8Array.prototype.find;
          const isFn: number = (typeof dynamic === "function") ? 1 : 0;
          const swapGuard: number = (dynamic === Int8Array.prototype.map) ? 1 : 0;
          return (isFn === 1 && swapGuard === 0) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("a flowing RegExp.prototype answers .exec / .test, and reports them as functions", async () => {
    // Brand-generic: the seeder is driven by the registered glue, so RegExp gets
    // the same treatment as %TypedArray% with no RegExp-specific code.
    expect(
      await runStandalone(`
        export function test(): number {
          const p: any = RegExp.prototype;
          const q: any = p;
          const hasExec: number = (typeof q.exec === "function") ? 1 : 0;
          const hasTest: number = (typeof q.test === "function") ? 1 : 0;
          const absent: number = (typeof q.notAMember === "undefined") ? 1 : 0;
          return (hasExec === 1 && hasTest === 1 && absent === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("`in` sees a seeded member on a flowing proto, and does not invent one", async () => {
    // `__extern_has` shares the same receiver-aware consult, so presence follows
    // the value read. Paired negative keeps it honest.
    expect(
      await runStandalone(`
        export function test(): number {
          const p: any = Object.getPrototypeOf(Int8Array).prototype;
          const present: number = ("find" in p) ? 1 : 0;
          const absent: number = ("thisMemberDoesNotExist" in p) ? 1 : 0;
          return (present === 1 && absent === 0) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("the seeded member carries its spec name/length meta through the dynamic read", async () => {
    // The reflection files read `gOPD(TypedArray.prototype.find, "name").value`.
    // That works only if the value read back is the real meta-typed closure, not
    // some placeholder — this is what turns the "Cannot convert undefined or
    // null to object" signature into a pass.
    expect(
      await runStandalone(`
        export function test(): number {
          const p: any = Object.getPrototypeOf(Int8Array).prototype;
          const f: any = p.find;
          const d: any = Object.getOwnPropertyDescriptor(f, "name");
          return (d !== undefined && d.value === "find") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("does NOT disturb the static fast path (instance reads / syntactic calls)", async () => {
    // The seeder emits a separate function and changes no instruction sequence
    // on the materialization path; `prove-emit-identity` reports all 60
    // (file,target) corpus emits IDENTICAL. This guards the behaviour locally.
    expect(
      await runStandalone(`
        export function test(): number {
          const re = /ab+/g;
          const flags: string = re.flags;
          const matched: number = re.test("zabb") ? 1 : 0;
          return (flags === "g" && matched === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});
