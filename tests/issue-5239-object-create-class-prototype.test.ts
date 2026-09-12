// #5239 — `Object.create(<class>.prototype)` must produce a real compiled
// instance even when the class arrives as a VALUE, not as a syntactic
// identifier.
//
// THE RULE (measured on this branch's merge base, 2026-08-31):
//
//   `tryCompileObjectCreateStaticPrototype` lowers the SPELLING
//   `Object.create(Foo.prototype)` to `struct.new $Foo`, so the created object
//   IS a compiled instance and every later member read dispatches normally.
//   The gate is syntactic. A bundler-minified library reaches the same class
//   through a variable — `const n = ce("%Temporal.PlainDate%");
//   Object.create(n.prototype)` — misses it, falls through to the
//   `__object_create` host import, and gets a plain JS object whose
//   `[[Prototype]]` is the opaque WasmGC prototype struct. Native lookup on
//   such an object finds nothing (a WasmGC struct exposes no JS properties and
//   TERMINATES the chain, so not even `Object.prototype.toString` is
//   reachable), and the runtime cannot recover: a compiled method's receiver
//   is a concrete `(ref $Foo)` that no host object can ever satisfy.
//
// Base measurements for the assertions below. `static*` rows answer the
// post-fix value on base already — that is what makes this a gate problem and
// not a member-resolution one.
//
//                        BASE                       AFTER
//   dynTypeofMethod      "undefined"              → "function"
//   dynGetter            "undefined"              → "2020"
//   dynMethodCall        THREW "label is not a
//                         function"               → "Y2020"
//   dynToStringCall      "[object Object]"        → "D2020"
//   dynStringCoercion    "[object Object]"        → "D2020"
//   dynProtoIdentity     "true" already (the host object's [[Prototype]] WAS
//                        the prototype struct; it just could not be used)
//   static* rows         already correct on base
//
// Also pinned: `String(instance)` on a compiled class instance runs the
// class's own `toString`, including the declared-PARAMETER shape
// (`toString(options)` — what every Temporal class uses). The historical
// ToPrimitive dispatcher `__call_toString` is zero-argument only, so that
// shape trapped and the coercion fell back to "[object Object]".

import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The class plus BOTH factories, used verbatim by every lane. State lives in a
 * WeakMap keyed by the created object — the shape a polyfill uses, and the
 * reason the created object must BE the compiled instance rather than a host
 * stand-in that merely forwards to it.
 */
const PROVIDER_SOURCE = `
const slots = new WeakMap();
const registry = {};
function intrinsic(key) { return registry[key]; }

export class PlainDate {
  constructor() {}
  get year() { const s = slots.get(this); return s ? s.year : -1; }
  label() { const s = slots.get(this); return s ? ("Y" + s.year) : "NOSLOT"; }
  toString(options) { const s = slots.get(this); return s ? ("D" + s.year + (options ? "!" : "")) : "NOSLOT"; }

  /** The minified-bundle shape: the class is a VALUE. */
  static makeDynamic(y) {
    const K = intrinsic("%PlainDate%");
    const o = Object.create(K.prototype);
    slots.set(o, { year: y });
    return o;
  }

  /** The hand-written shape, already lowered to \`struct.new\` before #5239. */
  static makeStatic(y) {
    const o = Object.create(PlainDate.prototype);
    slots.set(o, { year: y });
    return o;
  }
}
registry["%PlainDate%"] = PlainDate;
`;

const CONSUMER_PROBES = `
export function dynTypeofMethod() { return typeof PlainDate.makeDynamic(2020).label; }
export function dynGetter() { return String(PlainDate.makeDynamic(2020).year); }
export function dynMethodCall() { return PlainDate.makeDynamic(2020).label(); }
export function dynToStringCall() { return PlainDate.makeDynamic(2020).toString(); }
export function dynStringCoercion() { return String(PlainDate.makeDynamic(2020)); }
export function dynProtoIdentity() { return String(Object.getPrototypeOf(PlainDate.makeDynamic(2020)) === PlainDate.prototype); }
export function staticGetter() { return String(PlainDate.makeStatic(2020).year); }
export function staticMethodCall() { return PlainDate.makeStatic(2020).label(); }
export function staticToStringCall() { return PlainDate.makeStatic(2020).toString(); }
export function plainObjectCreateUntouched() {
  const p = { a: 1 };
  const o = Object.create(p);
  return String(Object.getPrototypeOf(o) === p) + "/" + String(o === p) + "/" + String(Object.create(null) instanceof Object);
}
`;

/** Every probe's expected answer. Identical for both lanes — that is the point. */
const EXPECTED: Record<string, unknown> = {
  dynTypeofMethod: "function",
  dynGetter: "2020",
  dynMethodCall: "Y2020",
  dynToStringCall: "D2020",
  dynStringCoercion: "D2020",
  dynProtoIdentity: "true",
  staticGetter: "2020",
  staticMethodCall: "Y2020",
  staticToStringCall: "D2020",
  plainObjectCreateUntouched: "true/false/false",
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

describe("#5239 — Object.create on a compiled class prototype reached as a value", () => {
  it("the single-module lane dispatches every member", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/provider.js": PROVIDER_SOURCE,
        [entry]: `import { PlainDate } from "./provider";\n${CONSUMER_PROBES}`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    // No package edge, so nothing is linked — this proves the defect and the
    // fix are module-independent (the #5237 control that ruled out the seam).
    expect(result.linkedModules ?? []).toHaveLength(0);

    const imports = result.importObject as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
    const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
    imports.__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });

  it("a separately linked provider answers identically", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5239-"));
    const packageRoot = join(root, "node_modules", "oc5239");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "oc5239", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(entry, `import { PlainDate } from "oc5239";\n${CONSUMER_PROBES}`);

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
    // (#5354) `dynProtoIdentity` was PINNED to "false" here — across the seam
    // the consumer's `PlainDate.prototype` answers the ctor-mirror's facade
    // while the instance's [[Prototype]] answered a hardcoded
    // `Object.prototype`, two unrelated objects. #5354 joined them (the
    // instance proxy now answers that same facade), so this lane matches the
    // control and the pin is gone: both lanes assert EXPECTED verbatim.
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });
});
