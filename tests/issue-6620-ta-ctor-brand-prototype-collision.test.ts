// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6620 / #5383 S33 — #6617 R1: a dynamic `.prototype` read on a PROVIDER-owned
// class value answered `undefined` instead of the class's prototype object,
// whenever the CONSUMER module also contained ANY dynamic `new <any>(...)`
// construct anywhere (unrelated to the class being read) — blocking all 45
// `built-ins/Temporal/**/subclassing-ignored.js` test262 files.
//
// ROOT CAUSE (reduced 2026-09-16 via bisection: forcing `ctx.moduleUsesDynTaView`
// true with no real TA construct in source still broke it; disabling ONLY the
// `__extern_get` `$__ta_ctor` receiver arm in `ta-dyn-mop.ts` restored the
// correct answer with every other TA-dyn-view arm still active). That arm used
// a BARE `ref.test $__ta_ctor` to decide "this receiver is a TypedArray
// constructor value" — a purely STRUCTURAL WasmGC question. `$__ta_ctor` is
// `{kind: i32, brand: i32}` (`registry/types.ts`), which is EXACTLY the shape
// of a field-less class's compiled root (`{__tag: i32, __shape_brand: i32}`,
// `class-bodies.ts` #2158/#2009) — so WasmGC's structural type canonicalization
// merges the two, and a class object/instance with that exact two-i32-field
// root shape passes the bare `ref.test` and is misclassified as a TypedArray
// constructor. `Temporal.Duration` (and other Temporal classes) compile to
// exactly this shape in the linked provider — their instance data lives in an
// expando side-table, not native struct fields — so once ANY dynamic
// `new <any>(...)` in the CONSUMER armed `ctx.taCtorTypeIdx`, every dynamic
// `.prototype` read on such a provider class hit the misclassified arm's
// "prototype" key check and returned the wrong per-kind TypedArray-view
// prototype glue (or its `undefined` fallback), instead of falling through to
// the correct cross-module boundary call (`__js2wasm_link_member_get`).
//
// This exact collision shape (`$__ta_ctor`'s widened 2-field brand vs. an
// empty class root) was already discovered and fixed ONCE — the brand-VALUE
// check `taCtorIdentityTestInstrs` in `registry/types.ts` (#5194 r3 review F1),
// whose own doc comment measures the IDENTICAL symptom on
// `new qi.Duration(...)` / `new qi.PlainDate(...)` on this SAME provider. That
// fix was applied at two call sites (`builtin-callable-brand.ts`,
// `reflect-construct-native.ts`) but not at `ta-dyn-mop.ts`'s
// `__extern_get $__ta_ctor` receiver arm, which is the one this fix touches.
//
// Every `it` below links the REAL `@js-temporal/polyfill` provider (the same
// one `pnpm run test:262`'s standalone lane uses) as a SEPARATE compiled
// module, because the defect requires a receiver whose class is NOT locally
// declared in the consumer — `#6457`'s local-class `.prototype` arm masks
// this bug for any class the consumer itself defines (tried first, see the
// #6620 issue notes; a same-module repro with a local field-less+subclass
// class does not show it). Host-free (`hostBridge: "off"`); results come back
// through a string-readback channel, one char code at a time, so nothing
// depends on a JS host import.
//
// MEASURED on BOTH trees by file-copy revert of `src/codegen/ta-dyn-mop.ts`
// (2026-09-16, `JS2WASM_TEMPORAL_CACHE` default dir, provider `cacheHit: true`
// on both — the PROVIDER binary is byte-identical on both trees; only the
// CONSUMER differs):
//   base tree:   fix-witness rows read `undef`   branch: `object`
import { describe, expect, it } from "vitest";
import { instantiateLinkedProject } from "../src/index.js";
import { buildTemporalProvider, compileWithTemporalGlobal } from "../src/temporal-provider.js";
import { linkPolyfillSource, setupTemporalPolyfill } from "./dogfood/setup-temporal-polyfill.mjs";
import { temporalCacheDir } from "../scripts/test262-temporal.mjs";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

let providerPromise: ReturnType<typeof buildTemporalProvider> | undefined;
function getProvider() {
  if (!providerPromise) {
    const linked = linkPolyfillSource(setupTemporalPolyfill());
    providerPromise = buildTemporalProvider({
      polyfillSource: linked.source,
      cacheDir: temporalCacheDir(),
      compileOptions: STANDALONE,
    } as never);
  }
  return providerPromise;
}

/** Link the real Temporal provider, run one `__run()` body, read the string back. */
async function runLinked(body: string): Promise<string> {
  const provider = await getProvider();
  const src = `${body}
let __s = "";
export function prepare() { try { __s = "" + (__run()); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }
export function at(i) { return __s.charCodeAt(i); }`;
  const result = await compileWithTemporalGlobal(src, provider, {
    target: "standalone",
    hostBridge: "off",
    fileName: "/issue-6620-probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as never);
  if (!result.success) throw new Error(`compile failed: ${result.errors?.map((e) => e.message).join("; ")}`);
  const { instance } = await instantiateLinkedProject(result, {});
  const exports = instance.exports as unknown as { prepare: () => number; at: (i: number) => number };
  const length = exports.prepare();
  let out = "";
  for (let index = 0; index < Math.min(length, 400); index++) out += String.fromCharCode(exports.at(index));
  return out;
}

/** `tag(v)` distinguishes null / undefined / object / other without relying on `typeof` alone. */
const TAG = `function tag(v) { return v === null ? "null" : v === undefined ? "undef" : typeof v; }\n`;

describe("#6620 — `$__ta_ctor` bare ref.test collides with a provider class's empty-root shape", () => {
  it(
    "a dynamic `.prototype` read on a provider class answers `object`, not `undef`, when an " +
      "UNRELATED dynamic `new <any>(...)` elsewhere arms the module (base tree: `undef`)",
    async () => {
      // TEETH — mirrors #5383 S32/S33's r1f.js reduction verbatim: the dynamic
      // `new` and the `.prototype` read are on two DIFFERENT parameters in two
      // DIFFERENT functions, tied only by module-wide pre-scan arming.
      const out = await runLinked(
        `${TAG}function readOnly(c) { return tag(c.prototype); }
function justNew(c) { return new c(1); }
function __run() { justNew(Temporal.Duration); return readOnly(Temporal.Duration); }`,
      );
      expect(out).toBe("object");
    },
  );

  it(
    "the SAME unrelated arming does not corrupt an ORDINARY named member read on the same " +
      "receiver (`.name` already worked pre-fix — this pins it, not a regression target)",
    async () => {
      const out = await runLinked(
        `${TAG}function readOnly(c) { return tag(c.name); }
function justNew(c) { return new c(1); }
function __run() { justNew(Temporal.Duration); return readOnly(Temporal.Duration); }`,
      );
      expect(out).toBe("string");
    },
  );

  it("a lone `.prototype` read with NO dynamic `new` anywhere stays correct (control, unchanged both trees)", async () => {
    const out = await runLinked(
      `${TAG}function readProto(c) { return tag(c.prototype); }
function __run() { return readProto(Temporal.PlainDate); }`,
    );
    expect(out).toBe("object");
  });

  it(
    "a GENUINE TypedArray constructor's `.prototype`/`.BYTES_PER_ELEMENT` still answer " +
      "correctly (control — the fix narrows the arm's receiver test, it must not disable it)",
    async () => {
      const out = await runLinked(
        `${TAG}var ctors = [Uint8Array, Int32Array];
function dynBpe(c) { return c.BYTES_PER_ELEMENT; }
function dynProto(c) { return tag(c.prototype); }
function __run() { return "bpe=" + dynBpe(ctors[1]) + " proto=" + dynProto(ctors[0]); }`,
      );
      expect(out).toBe("bpe=4 proto=object");
    },
  );
});
