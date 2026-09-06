// #5374 — a consumer-minted object with a compiled `valueOf` / `toString` /
// `[Symbol.toPrimitive]` must coerce correctly when the coercion runs inside a
// separately-linked PROVIDER.
//
// #5225 fixed the ARGUMENT boundary for FIELD READS: a WasmGC struct minted in
// the consumer reaches the provider's `__extern_get`, whose decoders are the
// CONSUMER's exports, so the read has to consult the #5225 owner registry.
// ToPrimitive is the same seam one step further in: once the provider HAS the
// struct, `Number(x)` walks `__sget_valueOf` / `__call_fn_method_0` — all
// exports of one specific module — resolved from `callbackState.getExports()`,
// i.e. the PROVIDER's. Those cannot name a consumer closure, so the walker saw
// "no valueOf", bottomed out at the `"[object Object]"` fallback and `Number()`
// answered NaN, which the Temporal polyfill's `ToIntegerWithTruncation` maps to
// 0 ("Cannot convert a number less than one to a positive integer", with the
// observer's `calls` array EMPTY).
//
// Reported as Temporal (`TemporalHelpers.toPrimitiveObserver` rows and the 3
// `infinity-throws-rangeerror` rows), but nothing here is Temporal-specific —
// the reduction below is a throwaway npm package with no Temporal in sight.
// The single-module control answers every row on base, which is what makes
// this linking-specific rather than an object-literal gap.
//
// TWO shapes are deliberately NOT asserted here, both because they fail
// IDENTICALLY in the single-module control — they are not seam defects and a
// seam fix cannot reach them:
//
//   1. An accessor-backed coercion method read through a field —
//      `f(o)` with `o = { v: { get valueOf() { return () => 3 } } }` and
//      `f(o) { return Number(o.v) }` — answers 0 with the getter never run, in
//      BOTH lanes. Coercing the same object DIRECTLY (`Number({get valueOf(){…}})`)
//      works in both lanes, so the loss is in the field READ, not ToPrimitive.
//      This is the shape `TemporalHelpers.toPrimitiveObserver` mints, so the
//      observer rows need that separate fix as well as this one.
//   2. An object literal whose ONLY member is a computed `[Symbol.toPrimitive]`
//      key. `__struct_field_names` answers null for it in its own module too,
//      and that CSV is the #5225 registry's sole ownership oracle — so no
//      module claims the struct and the redirect below has nothing to redirect
//      to. Adding one ordinary field (`tag: 1`, as the `pToPrim*` probes do)
//      makes it nameable and it works. Both are recorded in the issue file.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

/**
 * Provider side: every export coerces a value the CONSUMER minted. Used
 * verbatim by both lanes so the only difference is whether the linker compiled
 * the package separately.
 */
const PROVIDER_SOURCE = `
export function num(o) { return Number(o.v); }
export function plus(o) { return +o.v; }
export function trunc(o) { return Math.trunc(Number(o.v)); }
export function direct(x) { return Number(x); }
export function str(o) { return String(o.v); }
export function finite(o) {
  const n = Number(o.v);
  // The message carries the coerced value on purpose: a base run reaches this
  // same throw with NaN (nothing was coerced at all), so a bare "did it throw
  // RangeError?" probe passes on base and proves nothing.
  if (!Number.isFinite(n)) throw new RangeError("invalid number value: " + n);
  return n;
}
`;

const CONSUMER_PROBES = `
export function pNum() { return num({ v: { valueOf() { return 7; } } }); }
export function pPlus() { return plus({ v: { valueOf() { return 7; } } }); }
export function pTrunc() { return trunc({ v: { valueOf() { return 7.9; } } }); }
export function pDirect() { return direct({ valueOf() { return 7; } }); }
export function pStr() { return str({ v: { toString() { return "seven"; } } }); }
export function pToPrimNumber() {
  return num({ v: { tag: 1, [Symbol.toPrimitive](hint) { return hint === "string" ? 99 : 7; } } });
}
export function pToPrimString() {
  return str({ v: { tag: 1, [Symbol.toPrimitive](hint) { return hint === "string" ? "seven" : 99; } } });
}
export function pFinite() {
  try {
    finite({ v: { valueOf() { return Infinity; } } });
    return "no-throw";
  } catch (e) {
    return (e instanceof RangeError ? "RangeError" : "other") + ":" + e.message;
  }
}
export function pOrder() {
  const calls = [];
  const n = num({ v: { valueOf() { calls.push("valueOf"); return 3; } } });
  return n + ":" + calls.join(",");
}
export function pOrderString() {
  const calls = [];
  const s = str({ v: { toString() { calls.push("toString"); return "x"; } } });
  return s + ":" + calls.join(",");
}
`;

/** Every probe's expected answer. Identical for both lanes — that is the point. */
const EXPECTED: Record<string, unknown> = {
  pNum: 7,
  pPlus: 7,
  pTrunc: 7,
  pDirect: 7,
  pStr: "seven",
  pToPrimNumber: 7,
  pToPrimString: "seven",
  pFinite: "RangeError:invalid number value: Infinity",
  pOrder: "3:valueOf",
  pOrderString: "x:toString",
};

const IMPORTS = `import { num, plus, trunc, direct, str, finite } from "prim5374";`;

function readAll(exports: Record<string, unknown>): Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  for (const name of Object.keys(EXPECTED)) {
    try {
      observed[name] = (exports[name] as (() => unknown) | undefined)?.();
    } catch (error) {
      observed[name] = `THREW: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return observed;
}

describe("#5374 — consumer-minted coercion methods fire inside a linked provider", () => {
  it("a separately linked package coerces the consumer's object", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5374-"));
    const packageRoot = join(root, "node_modules", "prim5374");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "prim5374", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(entry, `${IMPORTS}\n${CONSUMER_PROBES}`);

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    // Load-bearing: a `bundled` plan would inline the package and silently test
    // the single-module lane twice.
    expect(result.linkPlan?.mode).toBe("separate");

    const { instance } = await instantiateLinkedProject(result);
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });

  it("the single-module control answers identically", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/provider.js": PROVIDER_SOURCE,
        [entry]: `${IMPORTS.replace('"prim5374"', '"./provider"')}\n${CONSUMER_PROBES}`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    // No package edge, so nothing is linked — this is the control.
    expect(result.linkedModules ?? []).toHaveLength(0);

    const imports = result.importObject as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
    const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
    imports.__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });
});
