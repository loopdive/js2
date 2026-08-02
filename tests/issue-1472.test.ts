// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1472 Phase A — `--target standalone` must not leak dynamic-shape
 * object/property JS-host imports (`env::__extern_*`, `env::__object_*`,
 * `env::__for_in_*`, `env::__defineProperty*`, `env::__hasOwnProperty`,
 * `env::__getOwn*`, `env::__delete_property`, `env::__new_plain_object`,
 * `env::__get_builtin`, `env::__proto_method_call`, `env::__register_*`,
 * `env::__proxy_*`). Open-object usage instead fails at compile time with a
 * message pointing at Phase B; Proxy usage fails with the explicit standalone
 * diagnostic from Phase C. Closed-shape struct access (typed object literals /
 * class instances) still compiles to struct.get/struct.set with zero host
 * calls.
 *
 * Phase B (the Wasm-native open-object runtime) is a follow-up.
 */

const BANNED_IMPORTS: ReadonlyArray<RegExp> = [
  /^env::__extern_/,
  /^env::__object_/,
  /^env::__for_in_/,
  /^env::__defineProperty/,
  /^env::__defineProperties/,
  /^env::__getOwn/,
  /^env::__getPrototypeOf$/,
  /^env::__delete_property$/,
  /^env::__new_plain_object$/,
  /^env::__hasOwnProperty$/,
  /^env::__propertyIsEnumerable$/,
  /^env::__isPrototypeOf$/,
  /^env::__get_builtin$/,
  /^env::__proto_method_call$/,
  /^env::__register_prototype$/,
  /^env::__register_class_object$/,
  /^env::__proxy_/,
  /^env::__reflect_/,
];

function assertNoHostObjectImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED_IMPORTS) {
    const hits = labels.filter((l) => re.test(l));
    expect(hits, `--target standalone leaked ${re} (got ${hits.join(", ")})`).toEqual([]);
  }
}

describe("#1472 — --target standalone object/Proxy host-import refusal", () => {
  it("typed object literal (closed shape) compiles with zero host object imports", async () => {
    const r = await compile(
      `
        interface Point { x: number; y: number; }
        export function dist(): number {
          const p: Point = { x: 3, y: 4 };
          return p.x * p.x + p.y * p.y;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
  });

  it("class instance with method dispatch compiles with zero host object imports", async () => {
    const r = await compile(
      `
        class Counter {
          n: number = 0;
          inc(): number { this.n = this.n + 1; return this.n; }
        }
        export function run(): number {
          const c = new Counter();
          c.inc();
          return c.inc();
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
  });

  it("Phase B: dynamic property add/read on an any-typed object compiles native + runs", async () => {
    // #1472 Phase B — open-object new/get/set now lower to the Wasm-native
    // $Object open-hash-map runtime instead of refusing. The module must carry
    // zero env::__extern_* / __new_plain_object host imports and instantiate +
    // run with an empty import object.
    const source = `
        export function run(): number {
          const o: any = {};
          o.x = 41;
          o.y = (o.x as number) + 1;
          return o.y as number;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__new_plain_object")).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });

  it("Phase B: property update + table grow/rehash run correctly", async () => {
    const source = `
        export function run(): number {
          const o: any = {};
          o.a = 1; o.a = 2; o.a = 3;
          o.k0=0; o.k1=1; o.k2=2; o.k3=3; o.k4=4; o.k5=5; o.k6=6; o.k7=7;
          o.k8=8; o.k9=9; o.k10=10; o.k11=11; o.k12=12; o.k13=13; o.k14=14;
          return (o.a as number) + (o.k0 as number) + (o.k7 as number) + (o.k14 as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // 3 (final o.a) + 0 + 7 + 14 = 24
    expect((instance.exports as Record<string, () => number>).run()).toBe(24);
  });

  it("Phase B S2: delete operator removes own property natively (tombstone)", async () => {
    // #1472 Phase B Slice 2 — `delete o.k` lowers to the native __delete_property
    // helper (tombstones the $PropEntry); the slot is reusable on re-add and a
    // subsequent read of the deleted key misses. Zero host object imports.
    const source = `
        export function run(): number {
          const o: any = {};
          o.a = 3; o.b = 5;
          delete o.a;        // tombstone a
          o.a = 41;          // reuse the tombstoned slot
          delete o.zzz;      // no-op delete of a missing key (spec: succeeds)
          // o.a re-added = 41, o.b untouched = 5  → 46
          return (o.a as number) + (o.b as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__delete_property")).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(46);
  });

  it("Phase B Blocker B: Object.keys + indexed read over an open `any` lowers native (no host imports, validates)", async () => {
    // #1472 Phase B Blocker B — the native $ObjVec build/iterate foundation.
    // For an `any`-typed receiver that TypeScript cannot narrow to a closed
    // struct shape (a bare function parameter), `Object.keys(o)` lowers to the
    // native __object_keys helper (walks the $Object PropMap → fresh $ObjVec),
    // and an all-`any` indexed read `(ks as any)[i]` lowers to the native
    // __extern_get_idx ($ObjVec[i]). Both must appear as DEFINED Wasm functions
    // (not env::* imports), the module must validate, and zero object/array
    // host imports may leak.
    //
    // NOTE: a runtime *value* assertion through Object.keys is intentionally
    // NOT made here — standalone has no JS host to hand in an open object, and
    // a locally-built `{}` is narrowed by TS to a closed struct (routed to the
    // struct fast path, not this runtime). Exercising the end-to-end value path
    // depends on the open-`any` receiver-dispatch work (Blocker A) + the
    // enumeration-consumer slice (for-of / string[] coercion / `.length`
    // routing). This test pins the foundation: the helpers emit, validate, and
    // stay host-free.
    const source = `
        export function run(o: any): number {
          const ks: any = Object.keys(o);
          const first: any = (ks as any)[0];
          return first === null ? -1 : 7;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    // No host array bridge leaked either (the $ObjVec is the array).
    expect(r.imports.some((i) => i.module === "env" && i.name.startsWith("__array_from"))).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    // The native runtime helpers are emitted as defined functions, not imports.
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__object_keys\b/);
    expect(wat).toMatch(/\(func \$__objvec_new\b/);
    expect(wat).toMatch(/\(func \$__objvec_push\b/);
    expect(wat).toMatch(/\(func \$__extern_get_idx\b/);
    expect(wat).toMatch(/\(func \$__extern_length\b/);
    // And the module instantiates with an empty import object (pure Wasm).
    await WebAssembly.instantiate(r.binary, {});
  });

  it("Phase B Blocker A Half 1: Object.isFrozen/isSealed/isExtensible lower native (no host imports, validates)", async () => {
    // #1472 Phase B Blocker A Half 1 — the three object-integrity predicates
    // gain Wasm-native readers (__object_isFrozen/isSealed/isExtensible read the
    // $Object.flags field). An externref-typed receiver routes to the native
    // helper instead of the JS-host import, so the standalone module carries
    // zero env::__object_* imports and validates. (The execution-order-blind
    // compile-time fast paths are also gated off in standalone — see the gc
    // regression test below — but their observable effect needs the freeze SET
    // path, which is Half 2.)
    const source = `
        export function chk(o: any): number {
          const a = Object.isFrozen(o) ? 1 : 0;
          const b = Object.isExtensible(o) ? 1 : 0;
          const c = Object.isSealed(o) ? 1 : 0;
          return a * 100 + b * 10 + c;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__object_isFrozen\b/);
    expect(wat).toMatch(/\(func \$__object_isSealed\b/);
    expect(wat).toMatch(/\(func \$__object_isExtensible\b/);
    await WebAssembly.instantiate(r.binary, {});
  });

  it("Phase B Blocker A Half 1: gc-mode static fast path for isFrozen/isSealed is unchanged", async () => {
    // Regression guard: the `!ctx.standalone` gate must NOT disturb the default
    // (gc) target. A local known-frozen at compile time still folds isFrozen to
    // a compile-time constant true (the existing fast path), with the JS-host
    // runtime present.
    const source = `
        export function run(): number {
          const o: any = {};
          o.x = 1;
          Object.freeze(o);
          return Object.isFrozen(o) ? 1 : 0;
        }
      `;
    const r = await compile(source, {}); // default gc target — host runtime present
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // After freeze, the known-frozen identifier folds isFrozen → const 1.
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    const start = wat.split("\n").findIndex((l) => /\(func \$run /.test(l));
    expect(start).toBeGreaterThanOrEqual(0);
  });

  it("Phase B Blocker B Slice 2: Object.keys(any) for-of consumer is host-free (no __array_from_iter)", async () => {
    // #1472 Phase B Blocker B Slice 2 — the typed enumeration consumer chain.
    const source = `
        export function n(o: any): number {
          const ks: string[] = Object.keys(o);
          let c = 0;
          for (const k of ks) { c = c + 1; }
          return c;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(r.imports.some((i) => i.module === "env" && i.name.startsWith("__array_from"))).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    await WebAssembly.instantiate(r.binary, {});
  });

  it("Phase B Blocker B Slice 2: .length on an any value routes to native __extern_length", async () => {
    const source = `
        export function m(o: any): number {
          const ks: any = Object.keys(o);
          return (ks.length as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__extern_length\b/);
    await WebAssembly.instantiate(r.binary, {});
  });

  // NOTE on test shape: a `const o: any = {}` whose property *names* are all
  // statically known (`o.a = 1`) lets the compiler shape-infer `o` into a closed
  // WasmGC struct, which bypasses the open-object runtime entirely (the writes
  // become struct.set and Object.keys reads the struct field list). To force the
  // genuine native $Object open-hash-map path these tests write through
  // *computed* keys (`o[k] = v`), which defeats shape inference and routes
  // __new_plain_object / __extern_set / __object_* through object-runtime.ts.

  it("Phase B Slice 3: Object.values(any) lowers native and counts enumerable own values", async () => {
    // #1472 Phase B Slice 3 — Object.values(o) on an open `any` lowers to the
    // native __object_values helper (walks the $Object PropMap → fresh $ObjVec of
    // boxed values). The result is a $ObjVec, so its `.length` reads back through
    // the native __extern_length. Zero object/array host imports; runs under an
    // empty import object.
    const source = `
        export function run(): number {
          const o: any = {};
          const ka = "a"; const kb = "b"; const kc = "c";
          o[ka] = 1; o[kb] = 2; o[kc] = 3;
          const vs: any = Object.values(o);
          return (vs.length as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__object_values")).toBe(false);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__object_values\b/);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(3);
  });

  it("Phase B Slice 3: Object.entries(any) lowers native; entry is a 2-element $ObjVec", async () => {
    // #1472 Phase B Slice 3 — Object.entries(o) builds a $ObjVec of 2-element
    // $ObjVecs ([key, value]). `.length` of the outer vec = number of enumerable
    // own props. Native __object_entries appears as a defined fn; no host imports.
    const source = `
        export function run(): number {
          const o: any = {};
          const ka = "a"; const kb = "b";
          o[ka] = 10; o[kb] = 20;
          const es: any = Object.entries(o);
          return (es.length as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__object_entries\b/);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(2);
  });

  it("Phase B Slice 3: Object.values elements round-trip through a typed for-of consumer", async () => {
    // The values $ObjVec stores boxed numbers; iterating it as a typed
    // `number[]` for-of (the Blocker B Slice 2 consumer path) unboxes each
    // element correctly. Confirms the values helper stores the right *values*
    // (not just the right count) host-free.
    const source = `
        export function run(): number {
          const o: any = {};
          const ka = "a"; const kb = "b";
          o[ka] = 10; o[kb] = 20;
          const vs: number[] = Object.values(o);
          let s = 0;
          for (const v of vs) { s = s + v; }
          return s;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(30);
  });

  it("Phase B Blocker A Half 2: Object.freeze/seal/preventExtensions lower native SET path (no host imports)", async () => {
    // #1472 Phase B Blocker A Half 2 — the freeze/seal WRITE path.
    const source = `
        export function run(o: any): any {
          Object.preventExtensions(o);
          Object.seal(o);
          return Object.freeze(o);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__object_freeze\b/);
    expect(wat).toMatch(/\(func \$__object_seal\b/);
    expect(wat).toMatch(/\(func \$__object_preventExtensions\b/);
    await WebAssembly.instantiate(r.binary, {});
  });

  it("Phase B Blocker A Half 2: gc-mode Object.freeze still routes to the JS-host import", async () => {
    // Regression guard: standalone-only coercion must NOT disturb the gc target.
    const source = `
        export function run(o: any): any {
          return Object.freeze(o);
        }
      `;
    const r = await compile(source, {}); // default gc target
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__object_freeze")).toBe(true);
  });

  it("Phase B Slice 3: Object.assign copies own enumerable props natively (no host array imports)", async () => {
    // #1472 Phase B Slice 3 — Object.assign(target, ...sources). The variadic
    // sources list is built with the native $ObjVec builders (not the JS-host
    // __js_array_new/__js_array_push), and __object_assign iterates the $ObjVec,
    // copying each source's enumerable own props into target via the native
    // __extern_set. Reads back the merged value; runs under empty imports.
    const source = `
        export function run(): number {
          const ka = "a"; const kb = "b";
          const t: any = {};
          const s1: any = {}; s1[ka] = 5;
          const s2: any = {}; s2[kb] = 7; s2[ka] = 11;  // later source wins on 'a'
          Object.assign(t, s1, s2);
          return (t[ka] as number) + (t[kb] as number);  // 11 + 7 = 18
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    // The JS-host array builders must NOT leak — standalone builds a $ObjVec.
    expect(r.imports.some((i) => i.module === "env" && i.name === "__js_array_new")).toBe(false);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__js_array_push")).toBe(false);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__object_assign")).toBe(false);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__object_assign\b/);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(18);
  });

  it("Phase B Slice 3: object spread {...src} uses native $ObjVec assign in standalone", async () => {
    // The all-spread object-literal fallback (compileObjectLiteralAsExternref)
    // also routes the sources list through the native $ObjVec builders. Validates
    // and instantiates host-free.
    const source = `
        export function run(): number {
          const kx = "x";
          const src: any = {}; src[kx] = 9;
          const o: any = { ...src };
          return (o[kx] as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__js_array_new")).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(9);
  });

  it("Phase B Slice 3: __extern_has_idx resolves to a native defined function (no host import)", async () => {
    // __extern_has_idx is the array-like HasProperty(O, ToString(idx)) helper used
    // by array-method callback loops (filter/map over array-likes) to skip holes.
    // It mirrors __extern_get_idx exactly over a $ObjVec (present iff
    // 0 <= i32(idx) < len). An array-method call over an `any` array-like pulls it
    // in; under standalone it must resolve to the native defined function, never an
    // env::__extern_has_idx host import. (The `in` operator on an object is a
    // *different* helper, __extern_has, which is out of scope for this slice; and
    // the surrounding array-like consumer machinery has independent standalone
    // gaps, so this asserts the helper resolution, not whole-module validity.)
    const source = `
        export function run(o: any): number {
          const out = Array.prototype.filter.call(o, (x: number) => x > 0);
          return (out as any).length as number;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // The helper is provided natively — no env::__extern_has_idx host import leaks.
    expect(r.imports.some((i) => i.module === "env" && i.name === "__extern_has_idx")).toBe(false);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__extern_has_idx\b/);
  });

  it("Phase C: `key in obj` routes to native __extern_has (own + proto) and runs", async () => {
    // #1472 Phase C — keyed HasProperty (`key in obj`, §7.3.12) over the $Object
    // hash-map: own props AND the prototype chain. Native via a proto-walk
    // mirroring __extern_get (boolean instead of value). Present-but-undefined
    // still reports 1 — but standalone conflates undefined/null, so we use a
    // present non-null value to keep the test crisp. The receiver is an open
    // `any` object (computed-key writes defeat closed-struct inference).
    const source = `
        export function run(): number {
          const o: any = {};
          const ka = "a";
          o[ka] = 5;
          return (ka in o ? 1 : 0) + ("missing" in o ? 10 : 0); // present:1 absent:0 → 1
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__extern_has")).toBe(false);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(1);
  });

  it("Phase C: Object.hasOwn(o, k) routes to native __object_hasOwn (own-only) and runs", async () => {
    // #1472 Phase C — Object.hasOwn (§20.1.2.13): own-property presence only
    // (no proto walk), native via __obj_find over the $Object props table.
    const source = `
        export function run(): number {
          const o: any = {};
          const ka = "a";
          o[ka] = 1;
          return (Object.hasOwn(o, ka) ? 1 : 0) + (Object.hasOwn(o, "b") ? 10 : 0); // own:1 absent:0 → 1
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__object_hasOwn")).toBe(false);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(1);
  });

  it("Phase C: Object.create + getPrototypeOf round-trip native over $Object.$proto", async () => {
    // #1472 Phase C — prototype-chain ops over $Object.$proto (field 0).
    // Object.create(proto) builds a fresh $Object whose $proto is `proto`;
    // Object.getPrototypeOf reads it back. The reified prototype still resolves
    // inherited properties through __extern_get's existing proto-walk. Both
    // helpers are native; zero object host imports leak.
    const source = `
        export function run(): number {
          const proto: any = {};
          const kt = "tag";
          proto[kt] = 7;
          const o: any = Object.create(proto);
          const p: any = Object.getPrototypeOf(o);
          // p === proto identity + inherited read via the chain → 1 + 7 = 8
          return (p === proto ? 1 : 0) + (p[kt] as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__getPrototypeOf")).toBe(false);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__object_create")).toBe(false);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(8);
  });

  it("Phase C: getPrototypeOf of a bare open object yields the null prototype", async () => {
    // A bare `{}` open object has a null $proto in standalone (no built-in
    // Object.prototype graph). Object.getPrototypeOf returns null → 5.
    const source = `
        export function run(): number {
          const o: any = {};
          o["x"] = 1;
          const p: any = Object.getPrototypeOf(o);
          return p === null ? 5 : 0;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__getPrototypeOf")).toBe(false);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(5);
  });

  it("Slice 7: Object.setPrototypeOf writes $proto native; getPrototypeOf reads it + inherited read", async () => {
    // #1888 Slice 7 — Object.setPrototypeOf(o, proto) writes $Object.$proto
    // (field 0) under standalone (was a proto-dropping stub in all modes).
    // After the write, Object.getPrototypeOf round-trips proto by identity and
    // the inherited property resolves through __extern_get's existing proto
    // walk. Both helpers native; zero object host imports leak.
    const source = `
        export function run(): number {
          const proto: any = {};
          const kt = "tag";
          proto[kt] = 9;
          const o: any = {};
          o["own"] = 1;
          Object.setPrototypeOf(o, proto);
          const p: any = Object.getPrototypeOf(o);
          // identity (1) + inherited read through the chain (9) → 10
          return (p === proto ? 1 : 0) + (o[kt] as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__object_setPrototypeOf")).toBe(false);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(10);
  });

  it("Slice 7: Object.setPrototypeOf returns its first argument (obj)", async () => {
    // §20.1.2.21: the return value is always O (the first arg), regardless of
    // the [[SetPrototypeOf]] result. Verify the call expression yields obj.
    const source = `
        export function run(): number {
          const proto: any = {};
          proto["v"] = 4;
          const o: any = {};
          const ret: any = Object.setPrototypeOf(o, proto);
          // ret === o identity (1) + inherited read via ret (4) → 5
          return (ret === o ? 1 : 0) + (ret["v"] as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(5);
  });

  it("Slice 7: Object.setPrototypeOf refuses a self-cycle (no infinite proto walk)", async () => {
    // §10.1.2.1 step: a [[SetPrototypeOf]] that would create a cycle returns
    // false and performs NO write. Standalone refuses silently (no throw). After
    // `Object.setPrototypeOf(o, o)` the chain must stay acyclic: getPrototypeOf(o)
    // is still null (the write was refused), so a subsequent walk terminates.
    const source = `
        export function run(): number {
          const o: any = {};
          o["x"] = 1;
          Object.setPrototypeOf(o, o); // self-cycle → refused, $proto stays null
          const p: any = Object.getPrototypeOf(o);
          return p === null ? 7 : 0; // refused write ⇒ null proto ⇒ 7
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(7);
  });

  it("Slice 7: default target (gc) Object.setPrototypeOf keeps the host stub (returns obj)", async () => {
    // Dual-mode guard: in gc mode the call site keeps the existing stub
    // (compile both args, drop proto, return obj). The result is still obj, so
    // the program runs; the native __object_setPrototypeOf is NOT emitted.
    const source = `
        export function run(): number {
          const proto: any = {};
          const o: any = { a: 2 };
          const ret: any = Object.setPrototypeOf(o, proto);
          return (ret === o ? 1 : 0) + ((o as { a: number }).a); // 1 + 2 = 3
        }
      `;
    const r = await compile(source); // default gc target
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // No native __object_setPrototypeOf runtime fn in gc mode (host stub path).
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).not.toMatch(/\(func \$__object_setPrototypeOf\b/);
  });

  it("Phase C: __extern_is_undefined routes native (ref.is_null) — destructuring default compiles + runs", async () => {
    // #1472 Phase C — the undefinedness predicate is the single largest remaining
    // standalone-refusal helper (~6.6k tests). It now lowers to the native
    // `__extern_is_undefined` (a bare `ref.is_null`), matching standalone's
    // undefined≡null conflation (same as `__typeof_undefined`). A destructuring
    // default `[x = 1]` over an empty array binds the default (the slot is
    // missing ⇒ undefined ⇒ ref.is_null true); a provided element is kept.
    const source = `
        export function run(): number {
          function pick(a: number[]): number {
            const [x = 7, y = 9] = a;
            return x + y;
          }
          // a=[5]: x=5 (provided), y=9 (default) → 14
          return pick([5]);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // The helper is provided natively — no env::__extern_is_undefined host import.
    expect(r.imports.some((i) => i.module === "env" && i.name === "__extern_is_undefined")).toBe(false);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(14);
  });

  it("Phase C: default parameter applies when arg omitted under standalone (runs native)", async () => {
    // Default-parameter initialization (§9.2.1 / §10.2.11 IteratorBindingInitialization)
    // checks the bound value via __extern_is_undefined for externref-typed params.
    // A default-valued object param exercises the externref path end-to-end.
    const source = `
        export function run(): number {
          function f(o: { a: number } = { a: 41 }): number { return o.a + 1; }
          return f();   // omitted ⇒ default {a:41} ⇒ 42
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__extern_is_undefined")).toBe(false);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });

  it("new Proxy runs through the standalone native proxy runtime without host imports", async () => {
    const r = await compile(
      `
        export function run(): number {
          const target: any = { value: 1 };
          const proxy: any = new Proxy(target, {
            get: function (): number { return 42; },
          });
          return proxy.value;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });

  it("Proxy.revocable fails explicitly in standalone mode without leaking proxy host imports", async () => {
    for (const source of [
      `
        export function revokeLater(target: any): any {
          return Proxy.revocable(target, {});
        }
      `,
      `
        export function revokeLater(target: any): any {
          return Proxy.revocable(target);
        }
      `,
    ]) {
      const r = await compile(source, { target: "standalone" });
      expect(r.success).toBe(false);
      const joined = r.errors.map((e) => e.message).join("\n");
      expect(joined).toMatch(/Proxy not supported in standalone mode/);
      expect(joined).toMatch(/#1472 Phase C/);
      assertNoHostObjectImports(r.imports);
    }
  });

  it("Phase C: Reflect.ownKeys routes to native __object_keys in standalone (no host import)", async () => {
    // #1472 Phase C — Reflect.ownKeys(o) on an open `any` lowers to the native
    // __object_keys helper (string own keys of the $Object hash-map). Computed
    // keys defeat shape inference and force the genuine open-object path.
    const source = `
        export function run(): number {
          const o: any = {};
          const ka = "a"; const kb = "b";
          o[ka] = 1; o[kb] = 2;
          const ks: any = Reflect.ownKeys(o);
          return (ks.length as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__object_keys\b/);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(2);
  });

  it("Phase C: Reflect descriptor and prototype methods now run natively without __reflect_* imports", async () => {
    const r = await compile(
      `export function run(): number {
        const proto: any = { inherited: 3 };
        const o: any = {};
        const defined = Reflect.defineProperty(o, "own", {
          value: 7,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        const descriptor: any = Reflect.getOwnPropertyDescriptor(o, "own");
        const set = Reflect.setPrototypeOf(o, proto);
        const got: any = Reflect.getPrototypeOf(o);
        return defined && set && descriptor.value === 7 && got === proto ? 1 : 0;
      }`,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name.startsWith("__reflect_"))).toBe(false);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(1);
  });

  it("Phase C: Reflect.apply still refuses explicitly without leaking __reflect_apply", async () => {
    const r = await compile(
      `export function f(fn: any, receiver: any, args: any): any {
        return Reflect.apply(fn, receiver, args);
      }`,
      { target: "standalone" },
    );
    expect(r.success).toBe(false);
    const joined = r.errors.map((e) => e.message).join("\n");
    expect(joined).toMatch(/Reflect\.apply not supported in standalone mode/);
    expect(joined).toMatch(/#1472 Phase C/);
    assertNoHostObjectImports(r.imports);
  });

  it("default target (gc) still routes Reflect.* through the JS-host __reflect_* imports", async () => {
    // Regression guard: the standalone Phase C refusal must not disturb the gc
    // target, which keeps the host Reflect MOP bridge.
    const r = await compile(
      `
        export function f(o: any): boolean {
          return Reflect.has(o, "k");
        }
      `,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__reflect_has")).toBe(true);
  });

  it("default target (gc) still allows Proxy via the JS-host runtime", async () => {
    const r = await compile(
      `
        export function wrap(target: any): any {
          return new Proxy(target, {});
        }
      `,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__proxy_create")).toBe(true);
  });

  it("default target (gc) still uses the JS-host object machinery", async () => {
    // Regression guard: standalone is opt-in. Default mode keeps the host
    // object imports so browser-targeted modules work with the JS runtime.
    const r = await compile(
      `
        export function obj(): number {
          const o: any = { x: 1 };
          o.y = 2;
          return o.y;
        }
      `,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });

  // ── #1888 Slice 5 — native accessor-descriptor RUNTIME LAYER (groundwork) ──
  //
  // Slice 5 adds the runtime groundwork for accessor descriptors under
  // --target standalone: the `$PropEntry.$get/$set` anyref slots + FLAG_ACCESSOR
  // (R3 layout), the native `__defineProperty_accessor` store helper, and the
  // native `__getOwnPropertyDescriptor` read-back (builds a descriptor $Object).
  //
  // These tests pin the runtime layer: accessor `defineProperty` compiles
  // host-free + validates + instantiates, and the GOPD helper routes native
  // (no `env::__getOwnPropertyDescriptor` import). The helpers are not yet
  // reached end-to-end — the call-site routing (compiling getter/setter as
  // host-free closures so they reach `__defineProperty_accessor` instead of the
  // `__make_getter_callback` JS bridge) plus live get/set invocation are
  // #329-gated follow-ups. Landing the helpers + R3 layout now de-risks the
  // layout change in isolation. (~0 test262 on its own; pure foundation.)

  it("Phase 5: accessor defineProperty compiles + validates host-free under standalone", async () => {
    const source = `
        export function run(): number {
          const o: any = {};
          // Accessor descriptor — getter + setter, both enumerable/configurable.
          Object.defineProperty(o, "x", {
            get() { return 1; },
            set(_v: any) {},
            enumerable: true,
            configurable: true,
          });
          // The store must not disturb a sibling DATA property written before
          // and after the accessor define (entry-slot reuse / table integrity).
          o.before = 11;
          Object.defineProperty(o, "y", { get() { return 2; } });
          o.after = 31;
          return (o.before as number) + (o.after as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__defineProperty_accessor")).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // The accessor stores don't clobber the data path: 11 + 31 = 42.
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });

  it("Phase 5: getter-only and setter-only accessor descriptors both store + instantiate", async () => {
    // A descriptor with only `get` (no `set`) and one with only `set` (no `get`)
    // both store: the absent half is a null externref → null anyref in the
    // $PropEntry slot. Must compile + validate + instantiate host-free.
    const source = `
        export function run(): number {
          const o: any = {};
          Object.defineProperty(o, "getterOnly", { get() { return 7; }, configurable: true });
          Object.defineProperty(o, "setterOnly", { set(_v: any) {}, configurable: true });
          o.sentinel = 5;
          return o.sentinel as number;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(5);
  });

  it("Phase 5: getOwnPropertyDescriptor on an externref receiver routes to the native helper (no host import)", async () => {
    // The dynamic getOwnPropertyDescriptor path (non-struct/non-literal receiver)
    // routes to the native `__getOwnPropertyDescriptor` runtime helper under
    // standalone instead of leaking the `env::__getOwnPropertyDescriptor` host
    // import — it reads the $PropEntry back and builds a descriptor $Object. This
    // pins the runtime layer (helper emits as a DEFINED function, host-free); it
    // is not yet reached for accessor *stores* (the call-site routing that
    // compiles getter/setter as host-free closures is a #329-gated follow-up).
    const r = await compile(
      `
        export function f(o: any, k: string): any {
          return Object.getOwnPropertyDescriptor(o, k);
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__getOwnPropertyDescriptor")).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__getOwnPropertyDescriptor\b/);
  });

  // ── #1888 S5b — accessor LIVE get/set (the ~2.7k lever) ────────────────────
  //
  // Builds on the Slice-5 runtime layer: the call-site now compiles getter/setter
  // as HOST-FREE closures into `__defineProperty_accessor` (under standalone,
  // replacing the `__make_getter_callback` JS bridge), and the accessor arms in
  // `__extern_get` / `__extern_set` invoke the stored `$get`/`$set` through the
  // reserve/fill drivers `__call_accessor_get` / `__call_accessor_set` →
  // `__call_fn_method_0/1` (receiver bound as `this` via `__current_this`,
  // #1636-S1). §6.2.5.5 Get / §10.1.5.3 Set, own-accessor scope.

  it("S5b: non-capturing getter returns its computed value (host-free, runs end-to-end)", async () => {
    // The `o["seed"]=0` write forces the open-`$Object` runtime path (TS narrows
    // a bare `{}` to a closed struct that bypasses the runtime — #1472 R2). The
    // getter closure captures nothing, so the accessor dispatch (`__extern_get`
    // FLAG_ACCESSOR arm → `__call_accessor_get` → `__call_fn_method_0`) runs the
    // getter and returns its value with zero host imports.
    const source = `
        export function run(): number {
          const o: any = {};
          o["seed"] = 0;
          Object.defineProperty(o, "x", { get() { return 41 + 1; }, configurable: true });
          return o.x as number;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    // Both the define and the get run native — no JS-host bridge.
    expect(r.imports.some((i) => i.module === "env" && i.name === "__defineProperty_accessor")).toBe(false);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__make_getter_callback")).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });

  it("S5b: getter-only accessor — assignment is a sloppy no-op, does not create a data prop", async () => {
    // §10.1.5.3: writing to an own accessor with no setter is a sloppy no-op;
    // the subsequent get still routes through the getter (returns its constant),
    // NOT a freshly-written data value.
    const source = `
        export function run(): number {
          const o: any = {};
          o["seed"] = 0;
          Object.defineProperty(o, "ro", { get() { return 42; }, configurable: true });
          o.ro = 99;            // no setter → sloppy no-op (NOT a data write)
          return o.ro as number; // getter still returns 42
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });

  it("S5b: data properties on the same object are unaffected by accessor arms", async () => {
    // The FLAG_ACCESSOR branch must only fire for accessor entries; plain data
    // reads/writes on sibling keys keep the fast data path.
    const source = `
        export function run(): number {
          const o: any = {};
          o["seed"] = 0;
          Object.defineProperty(o, "acc", { get() { return 100; }, configurable: true });
          o.d = 7;
          o.d = (o.d as number) + 35; // data update through __extern_set data path
          return o.d as number;       // 42, not the accessor
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });

  // ── S5c — struct-accessor capturing-closure rework (#1888 S5c) ─────────────
  // ROOT CAUSE (sd-1888): `Object.defineProperty(o,k,{get(){…}})` / `{get x(){}}`
  // on `const o:any={}` route to the static-struct accessor path (object-ops.ts
  // ~958-1171, #1629 S3), which compiles `${structName}_get_${prop}` as a BARE
  // `(this) -> result` Wasm function with NO closure-capture environment. So a
  // getter/setter body that closes over OUTER scope reads those captures as 0.
  // The READ (property-access.ts:870) `call`s the getter and the WRITE
  // (assignment.ts) the setter — but the compiled fn has no env to thread. S5c
  // re-represents the accessor as a host-free CLOSURE (capturing env, call_ref-
  // invoked with `this`), per arch-s5c's representation spec.
  //
  // These tests are RED until S5c lands (they assert the post-fix behavior):
  // capturing getter, this-mutating setter round-trip, object-literal accessor.
  // The non-capturing-getter / getter-only / data-unaffected cases above already
  // pass and must STAY green (regression guard for the closure rework).
  it("S5c: capturing getter returns the captured value", async () => {
    // get(){return k} where k is an outer const — must observe k=42, not 0.
    const source = `
        export function run(): number {
          const k = 42;
          const o: any = {};
          Object.defineProperty(o, "x", { get() { return k; }, configurable: true });
          return o.x as number;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });

  it("S5c: capturing getter mixes captured + literal", async () => {
    // get(){return n+37} with outer n=5 — must observe n=5 (→42), not 0 (→37).
    const source = `
        export function run(): number {
          let n = 5;
          const o: any = {};
          Object.defineProperty(o, "x", { get() { return n + 37; }, configurable: true });
          return o.x as number;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });

  it("S5c: setter observes the write via a captured cell; getter reads it back", async () => {
    // set mutates outer `backing`; get reads it — round-trips through the same
    // captured cell. o.v=21 → backing=42; o.v → 42.
    const source = `
        export function run(): number {
          let backing = 0;
          const o: any = {};
          Object.defineProperty(o, "v", {
            get() { return backing; },
            set(nv: number) { backing = nv * 2; },
            configurable: true,
          });
          o.v = 21;
          return o.v as number;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });

  it("S5c: object-literal accessor { get x() {} } runs native end-to-end", async () => {
    // The dominant accessor shape. Routes through compileObjectLiteralWithAccessors
    // → emitObjectLiteralAccessorFn (S5b host-free closure) → __defineProperty_accessor.
    // The remaining standalone failure was the accessor KEY emission using the `-1`
    // string-constant sentinel via `global.get` ("u32 out of range: -1"); C5
    // materializes the key via stringConstantExternrefInstrs (native-string inline
    // under standalone). The capture-bearing closure was already correct from S5b.
    const source = `
        export function run(): number {
          const k = 42;
          const o: any = { get x() { return k; } };
          return o.x as number;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });

  it("default target (gc) still routes accessor defineProperty through the host import", async () => {
    // Regression guard: standalone is opt-in. Default (gc) mode keeps the
    // JS-host descriptor sidecar for accessor descriptors.
    const r = await compile(
      `
        export function f(o: any): any {
          Object.defineProperty(o, "x", { get() { return 1; } });
          return o;
        }
      `,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__defineProperty_accessor")).toBe(true);
  });
});

/**
 * #1888 Slice 2 — standalone open-`any` method dispatch (`recv.m(args)`).
 *
 * The native `__extern_method_call` (object-runtime.ts, gated
 * `S2_OPENANY_DISPATCH_WIRED`) resolves a user method stored on an open
 * `$Object` via `__extern_get` (own + proto walk) and invokes it through the
 * `__apply_closure` arity bridge → `__call_fn_method_0..4` (ES §7.3.14 Call,
 * D6/D7). The receiver's args list is built with the native `$ObjVec` builders
 * under standalone (not the host `__js_array_*`). Zero host imports; the
 * `this`-threaded method path carries the receiver as `this`.
 *
 * Tests force the OPEN path with computed-key writes + `any` function params
 * (TS narrows a literal `{}` to a closed struct that bypasses the runtime —
 * see #1472 R2 / the Slice-0 audit). Method names avoid lib-prototype
 * collisions (e.g. not `add`, which narrows to Set.prototype.add).
 */
describe("#1888 Slice 2 — standalone open-any method dispatch", () => {
  const STD = { target: "standalone" as const };

  it("o['m']=function(){return 42}; o.m() runs native, zero host imports", async () => {
    const source = `
        export function run(): number {
          const o: any = {};
          o["m"] = function () { return 42; };
          return o.m();
        }
      `;
    const r = await compile(source, STD);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // Native dispatch: __extern_method_call is a DEFINED func, not an import.
    expect(r.imports.some((i) => i.module === "env" && i.name === "__extern_method_call")).toBe(false);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });

  it("o['combine']=(a,b)=>a+b; o.combine(2,3) → 5 (2-arg arrow, native args via $ObjVec)", async () => {
    const source = `
        export function run(): number {
          const o: any = {};
          o["combine"] = (a: any, b: any) => a + b;
          return o.combine(2, 3);
        }
      `;
    const r = await compile(source, STD);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__js_array_new")).toBe(false);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__js_array_push")).toBe(false);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(5);
  });

  it("3-arg method dispatch (arity-3 __call_fn_method_3 arm) runs", async () => {
    const source = `
        export function run(): number {
          const o: any = {};
          o["sum3"] = (a: any, b: any, c: any) => a + b + c;
          return o.sum3(1, 2, 4);
        }
      `;
    const r = await compile(source, STD);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(7);
  });

  it("4-arg method dispatch (arity-4 __call_fn_method_4 arm) runs", async () => {
    const source = `
        export function run(): number {
          const o: any = {};
          o["q"] = (a: any, b: any, c: any, d: any) => a + b + c + d;
          return o.q(1, 2, 3, 4);
        }
      `;
    const r = await compile(source, STD);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(10);
  });

  it("method reads this.x through the open object (this-threaded dispatch)", async () => {
    const source = `
        export function run(): number {
          const o: any = {};
          o["x"] = 10;
          o["getX"] = function () { return (this as any).x; };
          return o.getX();
        }
      `;
    const r = await compile(source, STD);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(10);
  });

  it("regression: the same open-method program in default (gc) mode still compiles", async () => {
    // Conservative dual-mode invariant: GC/host path is unchanged. The gc
    // target keeps the host __extern_method_call bridge.
    const r = await compile(
      `
        export function run(): number {
          const o: any = {};
          o["m"] = function () { return 42; };
          return o.m();
        }
      `,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});

/**
 * #1888 Slice 3 — standalone borrowed-method dispatch
 * `Type.prototype.<m>.call(recv, …args)` (ES §7.3.14 Call).
 *
 * The host `__proto_method_call` is refused under --target standalone (no JS
 * runtime). Per "compile away, don't emulate", the dispatch is done STATICALLY
 * at the call site (calls.ts) because typeName + methodName are compile-time
 * constants: the borrowed call is synthesised as `recv.<m>(…args)` and routed
 * through the native member-call path — no new runtime helper, no funcIdx shift.
 *
 * Covered now: the String brand arm (synthesised → compileNativeStringMethodCall
 * → native __str_* over a $NativeString-branded receiver) and the
 * Object.prototype hasOwnProperty/propertyIsEnumerable arms (→ native own-property
 * helpers) plus Object.prototype.isPrototypeOf (→ native prototype-chain helper).
 * Everything else (Array — rides on #2177; Object valueOf — a separate follow-on)
 * refuses-loud with a #1888 cite, never silent-wrong.
 *
 * String-returning methods are asserted via a numeric projection (`.length` /
 * `charCodeAt`) since a $NativeString export return is opaque to the bare
 * `WebAssembly.instantiate` harness (same pattern as the Blocker-B Slice-2 tests).
 */
describe("#1888 Slice 3 — standalone Type.prototype.<m>.call borrowed dispatch", () => {
  const STD = { target: "standalone" as const, nativeStrings: true };
  type NumExports = Record<string, () => number>;

  it("String.prototype.indexOf.call routes native (i32 result), zero host imports", async () => {
    const r = await compile(`export function run(): number { return String.prototype.indexOf.call("abc", "b"); }`, STD);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__proto_method_call")).toBe(false);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as NumExports).run()).toBe(1);
  });

  it("String.prototype.includes.call routes native (bool result)", async () => {
    const r = await compile(
      `export function run(): number { return String.prototype.includes.call("hello", "ell") ? 1 : 0; }`,
      STD,
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as NumExports).run()).toBe(1);
  });

  it("String.prototype.toUpperCase.call result is correct (charCodeAt projection)", async () => {
    const r = await compile(
      `export function run(): number { const s = String.prototype.toUpperCase.call("hi"); return s.charCodeAt(0); }`,
      STD,
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as NumExports).run()).toBe(72); // 'H'
  });

  it("String.prototype.slice.call result is correct (length + charCodeAt projection)", async () => {
    const r = await compile(
      `export function run(): number { const s = String.prototype.slice.call("hello", 1, 3); return s.length * 1000 + s.charCodeAt(0); }`,
      STD,
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as NumExports).run()).toBe(2101); // "el": len 2, 'e'=101
  });

  it("Object.prototype.hasOwnProperty.call routes to native __hasOwnProperty (own-only)", async () => {
    const r = await compile(
      `export function run(): number {
        const o: any = {};
        const k = "key";
        o[k] = 1;
        return (Object.prototype.hasOwnProperty.call(o, k) ? 1 : 0) +
               (Object.prototype.hasOwnProperty.call(o, "absent") ? 10 : 0);
      }`,
      STD,
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__proto_method_call")).toBe(false);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as NumExports).run()).toBe(1);
  });

  it("Array.prototype.push.call on a dynamic receiver refuses loudly instead of trapping", async () => {
    const r = await compile(
      `export function run(): number { const a: any = []; Array.prototype.push.call(a, 5); return 1; }`,
      STD,
    );
    expect(r.success).toBe(false);
    const joined = r.errors.map((e) => e.message).join("\n");
    expect(joined).toMatch(/#1888 Slice 3\/4/);
    expect(joined).toMatch(/Array brand arm rides on #2177/);
    assertNoHostObjectImports(r.imports);
  });

  it("Object.prototype.isPrototypeOf.call routes native (prototype-chain helper)", async () => {
    const r = await compile(
      `export function run(): number {
        const p: any = {};
        const o: any = {};
        Object.setPrototypeOf(o, p);
        return Object.prototype.isPrototypeOf.call(p, o) ? 1 : 0;
      }`,
      STD,
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__proto_method_call")).toBe(false);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as NumExports).run()).toBe(1);
  });

  it("default target (gc) still uses the host __proto_method_call bridge (dual-mode unchanged)", async () => {
    const r = await compile(`export function run(): number { return String.prototype.indexOf.call("abc", "b"); }`, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__proto_method_call")).toBe(true);
  });
});
