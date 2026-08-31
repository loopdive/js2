// #5242 — `new <compiled class>(…)` when the class arrives as a VALUE.
//
// THE RULE (measured on this branch's merge base, 2026-08-31):
//
//   A compiled class that crosses to the host is presented as a constructible
//   function mirror (`_makeClassCtorMirrorForHost`). Its `[[Construct]]` trap
//   had exactly one route back into Wasm — the GENERIC closure bridge
//   `__call_fn_<N>` — and that route is unavailable in two ways at once:
//
//     * it is emitted only for N ≤ 4, so a five-or-more-parameter constructor
//       can never be dispatched (`@js-temporal/polyfill`'s `Duration` takes
//       TEN);
//     * it is emitted at all only when the module needs generic closure
//       dispatch for some other reason.
//
//   Worse, the mirror froze a SNAPSHOT of the export view taken at the first
//   crossing. For a class declared at top level that crossing happens inside
//   the wasm `start` section, where the only view is the partial #5202
//   start-export registry — so even a module that DOES publish `__call_fn_4`
//   answered from a view that does not contain it, for the module's whole life.
//
//   Both failures surface as the same TypeError:
//   `compiled class constructor <Name> bridge unavailable`.
//
// Base measurements for the assertions below (`viaRegistry*` rows fail; the
// `direct*` rows are the passing control that proves the class itself is fine):
//
//                        BASE                                        AFTER
//   viaRegistryLabel     THREW "compiled class constructor K       → "K1|2|3|4|5|6"
//                         bridge unavailable"
//   viaRegistryField     same throw                                → "1/6"
//   viaRegistryGetter    same throw                                → "21"
//   viaRegistryToString  same throw                                → "T1"
//   initConstructed      same throw (construction at module init)  → "K7|8|9|10|11|12"
//   direct*              already correct on base — SINGLE-MODULE. In the
//                        linked lane those three rows fail on base too, for an
//                        unrelated reason; see the pinned expectation there.
//
// On base the module-init construct throws during `WebAssembly.instantiate`
// itself, so base does not merely answer wrong — the whole program refuses to
// start. Both lanes, measured 2026-08-31.
//
// The class is reached through a `Map` deliberately: a registry object literal
// or an array element is still resolved statically by the compiler, so those
// spellings never reach the host mirror and would test the control twice. A
// `Map.get` result is opaque — which is exactly the shape a minified bundle's
// intrinsics registry has (`ce("%Temporal.Duration%")`).

import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The class plus both factories, used verbatim by every lane. SIX constructor
 * parameters, one more than the highest generic closure dispatcher, so the
 * arity half of the defect is exercised as well as the export-view half.
 */
const PROVIDER_SOURCE = `
const registry = new Map();
function intrinsic(key) { return registry.get(key); }

export class K {
  constructor(a, b, c, d, e, f) {
    this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
  }
  get sum() { return this.a + this.b + this.c + this.d + this.e + this.f; }
  label() { return "K" + this.a + "|" + this.b + "|" + this.c + "|" + this.d + "|" + this.e + "|" + this.f; }
  toString() { return "T" + this.a; }
}
registry.set("%K%", K);

/*
 * DEFAULT parameters — Temporal's Duration shape, and the reason the bridge
 * carries an explicit argc. <Class>_new tells an omitted argument from an
 * explicit undefined through the mutable module global __argc; a bridge that
 * does not write it inherits whatever the last compiled call site left there.
 * Both stale values are silently wrong and look unrelated: -1 means "caller
 * unknown" so nothing defaults and the padding arrives as NaN, while a stale
 * small count defaults every parameter past the first and DISCARDS the real
 * arguments.
 */
export class D {
  constructor(a = 0, b = 0, c = 0, d = 0, e = 0, f = 0) {
    this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
  }
  read() { return [this.a, this.b, this.c, this.d, this.e, this.f].join(","); }
}
registry.set("%D%", D);

export function defaultedDynamicFull() { const C = intrinsic("%D%"); return new C(11, 12, 13, 14, 15, 16).read(); }
/** The INLINE construct spelling — no local binding between the lookup and \`new\`. */
export function defaultedInlineFull() { return new (intrinsic("%D%"))(11, 12, 13, 14, 15, 16).read(); }
export function defaultedDynamicPartial() { const C = intrinsic("%D%"); return new C(11, 12).read(); }
export function defaultedDirectFull() { return new D(11, 12, 13, 14, 15, 16).read(); }
export function defaultedDirectPartial() { return new D(11, 12).read(); }

/** The minified-bundle shape: the class is a VALUE. */
export function makeDynamic(base) {
  const C = intrinsic("%K%");
  return new C(base, base + 1, base + 2, base + 3, base + 4, base + 5);
}

/** The hand-written shape, lowered without ever reaching the host mirror. */
export function makeDirect(base) {
  return new K(base, base + 1, base + 2, base + 3, base + 4, base + 5);
}

/** Constructed through the class VALUE while the module is still initialising. */
const AT_INIT = makeDynamic(7).label();
export function initConstructed() { return AT_INIT; }
`;

const CONSUMER_PROBES = `
export function viaRegistryLabel() { return makeDynamic(1).label(); }
export function viaRegistryField() { return String(makeDynamic(1).a) + "/" + String(makeDynamic(1).f); }
export function viaRegistryGetter() { return String(makeDynamic(1).sum); }
export function viaRegistryToString() { return String(makeDynamic(1)); }
export function viaRegistryAtInit() { return initConstructed(); }
export function directLabel() { return makeDirect(1).label(); }
export function directGetter() { return String(makeDirect(1).sum); }
export function directToString() { return String(makeDirect(1)); }
export function defaultedFull() { return defaultedDynamicFull(); }
export function defaultedPartial() { return defaultedDynamicPartial(); }
export function defaultedFullControl() { return defaultedDirectFull(); }
export function defaultedPartialControl() { return defaultedDirectPartial(); }
export function defaultedInline() { return defaultedInlineFull(); }
`;

/** Every probe's expected answer. Identical for both lanes — that is the point. */
const EXPECTED: Record<string, unknown> = {
  viaRegistryLabel: "K1|2|3|4|5|6",
  viaRegistryField: "1/6",
  viaRegistryGetter: "21",
  viaRegistryToString: "T1",
  viaRegistryAtInit: "K7|8|9|10|11|12",
  directLabel: "K1|2|3|4|5|6",
  directGetter: "21",
  directToString: "T1",
  // Parameter defaults must behave EXACTLY as they do on the direct-`new`
  // control — same values supplied, same values omitted.
  defaultedFull: "11,12,13,14,15,16",
  defaultedPartial: "11,12,0,0,0,0",
  defaultedFullControl: "11,12,13,14,15,16",
  defaultedPartialControl: "11,12,0,0,0,0",
  defaultedInline: "11,12,13,14,15,16",
};

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

describe("#5242 — constructing a compiled class reached as a value", () => {
  it("the single-module lane constructs a real instance", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/provider.js": PROVIDER_SOURCE,
        [entry]: `import { makeDynamic, makeDirect, initConstructed, defaultedInlineFull, defaultedDynamicFull, defaultedDynamicPartial, defaultedDirectFull, defaultedDirectPartial } from "./provider";\n${CONSUMER_PROBES}`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    // No package edge, so nothing is linked — this proves the defect and the
    // fix are module-independent, not a provider-seam artefact.
    expect(result.linkedModules ?? []).toHaveLength(0);

    const imports = result.importObject as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
    const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
    imports.__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });

  it("a separately linked provider answers identically", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5242-"));
    const packageRoot = join(root, "node_modules", "cv5242");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "cv5242", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(
      entry,
      `import { makeDynamic, makeDirect, initConstructed, defaultedInlineFull, defaultedDynamicFull, defaultedDynamicPartial, defaultedDirectFull, defaultedDirectPartial } from "cv5242";\n${CONSUMER_PROBES}`,
    );

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    // Load-bearing: a `bundled` plan would silently test the control twice.
    expect({ mode: result.linkPlan?.mode, reason: result.linkPlan?.fallbackReason }).toEqual({
      mode: "separate",
      reason: undefined,
    });

    const { instance } = await instantiateLinkedProject(result);
    // Reported, NOT fixed here — and the direction is the surprising part. The
    // `direct*` rows are the CONTROL: a plain `new K(…)` inside the provider,
    // whose instance then crosses the linked seam. Measured on base with the
    // module-init construct swapped to `makeDirect` (so base gets past
    // instantiation at all): those three rows already answer `undefined` /
    // "label is not a function" / "[object Object]" in this lane while the
    // single-module control answers correctly. That is the #5237 cross-module
    // member-identity family, not #5242.
    //
    // The `viaRegistry*` rows — the ones this change is about — answer
    // correctly in BOTH lanes, because an instance minted through the host
    // ctor mirror comes back as a `_wrapForHost` view whose owning module the
    // runtime knows (#5222), which the raw struct handed across the seam does
    // not. So the constructed-through-a-value path is now the BETTER-behaved
    // one across the seam, which is why this asymmetry is pinned rather than
    // asserted away.
    //
    // (#5225) TWO OF THE THREE PINNED ROWS ARE FIXED, and by the general
    // mechanism this comment predicted: the runtime now resolves a struct's
    // DECODER (its `__struct_field_names` / `__sget_*` / `__shas_*`) from the
    // module that MINTED it rather than the module that is reading, so the raw
    // struct crossing the seam is no longer worse off than the mirrored one.
    //   directGetter  "undefined"                      → "21"
    //   directLabel   "THREW: label is not a function" → "K1|2|3|4|5|6"
    // `directToString` still answers "[object Object]" — that is the
    // `Symbol.toStringTag` wiring gap (#5223's `instanceToStringTag`), which
    // reproduces on a plain user class in ONE module and is not a seam defect.
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual({
      ...EXPECTED,
      directToString: "[object Object]",
    });
  });
});
