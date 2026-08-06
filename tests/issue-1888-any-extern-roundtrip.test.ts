// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #1888 — round-trip safety of the standalone `any` ⇄ externref bridge.
//
// The `__any_to_extern` / `__any_from_extern` pair carries boxed `$AnyValue`
// values across the standalone closure-dispatch externref boundary. An earlier
// revision of `__any_to_extern` UNWRAPPED every tag — including tag 0 (null),
// tag 5 (string) and tag 6 (internal GC object/array) — which was NOT
// round-trip safe:
//   - tag 0 (null) emitted `ref.null.extern`, so `__any_from_extern` recovered
//     it as tag 1 (undefined): `null` silently became `undefined` across every
//     boundary (`x === null`, `typeof x`).
//   - tag 6 (raw struct) was emitted unwrapped, so `__any_from_extern` mis-tagged
//     it as tag 5 (string) via its fallback arm.
// That regressed ~793 standalone test262 cases (concentrated in class dstr).
//
// The fix: `__any_to_extern` unwraps numeric/boolean carriers (tags 2/3/4) and
// a tag-5 payload only after proving it is a native string. For tags 0/1/6 and
// overloaded non-string tag 5 it keeps the WHOLE `$AnyValue` box wrapped via
// `extern.convert_any`, which `__any_from_extern` recovers exactly through its
// `ref.test $AnyValue` arm — preserving null/object tags and identity.

const BANNED_STANDALONE_IMPORTS = [
  /^env::__get_builtin$/,
  /^env::__extern_/,
  /^env::__object_/,
  /^env::__new_plain_object$/,
  /^env::global_/,
];

function assertNoStandaloneObjectImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED_STANDALONE_IMPORTS) {
    const hits = labels.filter((label) => re.test(label));
    expect(hits, `standalone leaked ${re}: ${hits.join(", ")}`).toEqual([]);
  }
}

async function compileStandalone(source: string): Promise<Awaited<ReturnType<typeof compile>>> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoStandaloneObjectImports(r.imports);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  return r;
}

async function runStandalone(source: string): Promise<number> {
  const r = await compileStandalone(source);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

/** Extract the `$__any_to_extern` function body (one block) from emitted WAT. */
function extractAnyToExternBody(wat: string): string[] {
  const lines = wat.split("\n");
  const start = lines.findIndex((l) => /func \$__any_to_extern\b/.test(l));
  expect(start, "module did not emit __any_to_extern").toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && /^\s*\(func /.test(l));
  return lines.slice(start, end < 0 ? lines.length : end).map((l) => l.trim());
}

describe("#1888 any⇄externref bridge round-trip safety", () => {
  // ── Structural regression guard ─────────────────────────────────────────
  // Locks the helper shape so a future change can't silently re-introduce the
  // tag-5/tag-6 unwrap that broke null/object/string round-trips.
  it("__any_to_extern unwraps only primitive carriers and keeps object/null boxes", async () => {
    // `a + b` over open-any method args forces the numeric dispatch path that
    // materialises the bridge.
    const r = await compileStandalone(`
      export function run(): number {
        const o: any = {};
        o["two"] = (a: any, b: any) => a + b;
        return o.two(2, 3);
      }
    `);
    const body = extractAnyToExternBody(r.wat);

    // Field 0 = tag, field 1 = i32val (tags 2/4), field 2 = f64val (tag 3),
    // field 3 = refval (eqref, tag 6), field 4 = externval (string, tag 5).
    // Tag 6 must never unwrap. Field 4 is read only by the guarded native-string
    // arm; non-string tag-5 overloads still reach the wrapped tail.
    const readsField3 = body.some((l) => /struct\.get \d+ 3\b/.test(l));
    const readsField4 = body.some((l) => /struct\.get \d+ 4\b/.test(l));
    expect(readsField3, "tag-6 (GC ref) must NOT be unwrapped via field 3").toBe(false);
    expect(readsField4, "tag-5 native strings should use the guarded field-4 arm").toBe(true);

    // The non-numeric tail keeps the whole $AnyValue box: the body ends with
    // `local.get 0 / ref.as_non_null / extern.convert_any` (no per-tag unwrap).
    const tail = body.slice(-4).join(" ");
    expect(tail).toMatch(/local\.get 0[\s)]*ref\.as_non_null[\s)]*extern\.convert_any/);
  });

  // ── Behavioural: numeric carriers still cross correctly (Slice-2 fix) ────
  it("round-trips an integer through the open-any dispatch bridge", async () => {
    expect(
      await runStandalone(`
        export function run(): number {
          const o: any = {};
          o["two"] = (a: any, b: any) => a + b;
          return o.two(2, 3);
        }
      `),
    ).toBe(5);
  });

  it("round-trips a float through the open-any dispatch bridge", async () => {
    expect(
      await runStandalone(`
        export function run(): number {
          const o: any = {};
          o["two"] = (a: any, b: any) => a + b;
          return o.two(2.5, 3.25) === 5.75 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps a computed string primitive across consecutive any-external hops", async () => {
    expect(
      await runStandalone(`
        function add(a: any, b: any): any {
          return a + b;
        }
        export function run(): number {
          const first: any = add("", "a");
          const second: any = add(first, "b");
          return typeof second === "string" && second === "ab" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("propagates NaN (undefined arg) through the bridge instead of corrupting it", async () => {
    // undefined + number === NaN; NaN !== NaN, so a self-inequality detects it.
    expect(
      await runStandalone(`
        export function run(): number {
          const o: any = {};
          o["two"] = (a: any, b: any) => a + b;
          const r: any = o.two(undefined, 5);
          return (r !== r) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("drives the documented 2-4 arg open-any method dispatch host-free", async () => {
    expect(
      await runStandalone(`
        export function run(): number {
          const o: any = {};
          o["two"] = (a: any, b: any) => a + b;
          o["three"] = (a: any, b: any, c: any) => a + b + c;
          o["four"] = (a: any, b: any, c: any, d: any) => a + b + c + d;
          return o.two(2, 3) + o.three(1, 2, 4) + o.four(1, 2, 3, 4);
        }
      `),
    ).toBe(22);
  });

  // ── Behavioural: null/object identity preserved across an any⇄externref hop ─
  // These exercise the wrapped-box path through `any[]` element storage, which
  // shares the `$AnyValue` representation the bridge round-trips.
  it("preserves null identity through any-typed storage", async () => {
    expect(
      await runStandalone(`
        export function run(): number {
          const a: any[] = [null];
          const x: any = a[0];
          return (x === null) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("preserves object identity (typeof object) through any-typed storage", async () => {
    expect(
      await runStandalone(`
        export function run(): number {
          const inner: any = { v: 5 };
          const a: any[] = [inner];
          const x: any = a[0];
          return (typeof x === "object") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("compiles the open-any dispatch shape under --target wasi to a valid module", async () => {
    // WASI shares the standalone any-helper codepath; it routes the open-object
    // store through the host object runtime (env::__extern_set), so we only
    // assert compile success + binary validity here. The round-trip semantics
    // are covered by the standalone instantiation tests above.
    const r = await compile(
      `
        export function run(): number {
          const o: any = {};
          o["two"] = (a: any, b: any) => a + b;
          return o.two(40, 2);
        }
      `,
      { target: "wasi" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
