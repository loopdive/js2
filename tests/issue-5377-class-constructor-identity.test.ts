// #5377 — `i.constructor === C` for a compiled class instance read through an
// any-typed receiver.
//
// Measured before this change (single-module lane, `.tmp/step1.mts`):
//
//   backing                          `i.constructor` answered   `=== C`
//   struct-backed  `class P {}`      %Object%                   0
//   host-backed    `class B extends Array {}`  the synthetic Sub  0
//
// Two different defects, one per backing, and neither value is the one the
// compiled `C` identifier resolves to:
//
//   - struct-backed: `__extern_get`'s ordinary-fields arm answers `%Object%`
//     for any WasmGC data struct, and a class instance IS one.
//   - host-backed: the instance is a real host object whose `[[Prototype]]` is
//     a SYNTHETIC `class Sub extends Parent {}` minted by `__set_subclass_proto`
//     and cached by class NAME (#1455/#1933). Nothing mapped it back.
//
// The fix records instance → class-object by IDENTITY (never by name — #5280
// is what name keying costs) and answers `constructor` with the class object's
// host mirror, which `_hostStrictEqual` unwraps to the same raw struct the bare
// `C` identifier resolves to.
//
// Why it lands together with #5373's fourth site (the member READ
// `const f = x.toString`): jsbi's `__toPrimitive` / `__isBigInt` / `BigInt` all
// open with `x.constructor === JSBI`. With that false, fixing the read path
// ALONE makes `i.valueOf` resolve to jsbi's deliberately-throwing `valueOf` —
// 9 measured `built-ins/Temporal/Instant/**` rows. With the identity fix in
// place the short-circuit fires first, exactly as it does in node.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

/**
 * Both backings live in the provider, as jsbi lives inside the Temporal
 * polyfill. Neither class is exported: a class on the export surface makes the
 * planner fall back to `bundled`, which would run the single-module lane twice.
 */
const PROVIDER_SOURCE = `
class P {
  constructor(v) { this.v = v; }
  toString() { return "P(" + this.v + ")"; }
  valueOf() { return 7; }
}
class B extends Array {
  constructor(n) { super(n); this.tag = "b"; }
  toString(radix) { return "B(" + this.length + ":" + radix + ")"; }
  valueOf() { return 42; }
}
export function mkP() { return new P(1); }
export function mkB() { const b = new B(3); b[0] = 1; b[1] = 2; b[2] = 3; return b; }
export function pvStructTyped() { const i = new P(1); return i.constructor === P ? 1 : 0; }
export function pvHostTyped() { const i = new B(3); return i.constructor === B ? 1 : 0; }
export function pvStructAny() { return eq(readCtor(new P(1)), P); }
export function pvHostAny() { return eq(readCtor(new B(3)), B); }
export function pvStructProtoAny() { return anyProtoIsP(new P(1)); }
export function pvHostProtoAny() { return anyProtoIsB(new B(3)); }
export function pvStructInstanceofAny() { return anyInstanceofP(new P(1)); }
export function pvHostInstanceofAny() { return anyInstanceofB(new B(3)); }
export function pvStructTypeofCtor() { const i = new P(1); return typeof anyCtor(i); }
export function pvHostTypeofCtor() { const i = new B(3); return typeof anyCtor(i); }
// The read shape jsbi takes verbatim.
export function pvHostReadToString() { const i = new B(3); return anyReadCall(i); }
export function pvHostReadValueOf() { const i = new B(3); return anyReadValueOf(i); }
export function pvStructReadToString() { const i = new P(1); return anyReadCall(i); }
// jsbi's own short-circuit, transcribed.
export function pvJsbiShortCircuit() { const i = new B(3); return toPrimLikeJsbi(i); }
export function pvJsbiShortCircuitPlain() { return toPrimLikeJsbi({ valueOf: function () { return 5; } }); }

function anyCtor(x) { return x.constructor; }
function readCtor(i) { return i.constructor; }
function readProto(i) { return Object.getPrototypeOf(i); }
function eq(a, b) { return a === b ? 1 : 0; }
function anyProtoIsP(x) { return eq(readProto(x), P.prototype); }
function anyProtoIsB(x) { return eq(readProto(x), B.prototype); }
function anyInstanceofP(x) { return x instanceof P ? 1 : 0; }
function anyInstanceofB(x) { return x instanceof B ? 1 : 0; }
function anyReadCall(x) { const f = x.toString; if (!f) { return "ABSENT"; } return String(f.call(x)); }
function anyReadValueOf(x) { const f = x.valueOf; if (!f) { return "ABSENT"; } return String(f.call(x)); }
function toPrimLikeJsbi(x) {
  if (typeof x !== "object") { return "NOTOBJ"; }
  if (x.constructor === B) { return "SHORTCIRCUIT"; }
  const v = x.valueOf;
  if (v) { const r = v.call(x); if (typeof r !== "object") { return String(r); } }
  const t = x.toString;
  if (t) { const r = t.call(x); if (typeof r !== "object") { return String(r); } }
  return "NOPRIM";
}
`;

/**
 * Consumer-side probes. Across the linked seam every receiver is `any`, so the
 * any-typed shape is the only one observable from here.
 */
const CONSUMER_PROBES = `
function anyCtor(x) { return x.constructor; }
function anySameCtor(a, b) { return a.constructor === b.constructor ? 1 : 0; }
function anyReadCall(x) { const f = x.toString; if (!f) { return "ABSENT"; } return String(f.call(x)); }

export function pStructTyped() { return pvStructTyped(); }
export function pHostTyped() { return pvHostTyped(); }
export function pStructAny() { return pvStructAny(); }
export function pHostAny() { return pvHostAny(); }
export function pStructProtoAny() { return pvStructProtoAny(); }
export function pHostProtoAny() { return pvHostProtoAny(); }
export function pStructInstanceofAny() { return pvStructInstanceofAny(); }
export function pHostInstanceofAny() { return pvHostInstanceofAny(); }
export function pStructTypeofCtor() { return pvStructTypeofCtor(); }
export function pHostTypeofCtor() { return pvHostTypeofCtor(); }
export function pHostReadToString() { return pvHostReadToString(); }
export function pHostReadValueOf() { return pvHostReadValueOf(); }
export function pStructReadToString() { return pvStructReadToString(); }
export function pJsbiShortCircuit() { return pvJsbiShortCircuit(); }
export function pJsbiShortCircuitPlain() { return pvJsbiShortCircuitPlain(); }

// Stability of the read itself: two reads of the same instance's constructor,
// and two instances of the same class, must agree.
export function pStructStable() { return anySameCtor(mkP(), mkP()); }
export function pHostStable() { return anySameCtor(mkB(), mkB()); }
// …and two DIFFERENT classes must not.
export function pCrossClass() { return anySameCtor(mkP(), mkB()); }

// Plain controls — an ordinary object and a plain array keep %Object% / %Array%.
export function cPlainObjectCtor() { return anyCtor({ a: 1 }) === Object ? 1 : 0; }
export function cPlainArrayCtor() { return anyCtor([1, 2, 3]) === Array ? 1 : 0; }
export function cPlainArrayRead() { return anyReadCall([1, 2, 3]); }
`;

const CONSUMER_IMPORT = `import { mkP, mkB, pvStructTyped, pvHostTyped, pvStructAny, pvHostAny, pvStructProtoAny, pvHostProtoAny, pvStructInstanceofAny, pvHostInstanceofAny, pvStructTypeofCtor, pvHostTypeofCtor, pvHostReadToString, pvHostReadValueOf, pvStructReadToString, pvJsbiShortCircuit, pvJsbiShortCircuitPlain } from `;

/** Cells with the same answer in both lanes. */
const COMMON: Record<string, unknown> = {
  pStructTyped: 1,
  pHostTyped: 1,
  pStructStable: 1,
  pHostStable: 1,
  pCrossClass: 0,
  cPlainObjectCtor: 1,
  cPlainArrayCtor: 1,
  // REPORTED, NOT FIXED and pinned at the MEASURED value rather than node's
  // ("1,2,3"): reading a method off a PLAIN array through an any-typed
  // parameter answers `undefined`, a pre-existing gap in the vec's host view
  // (#5373 pinned the same cell). Unchanged by this issue.
  cPlainArrayRead: "ABSENT",
  // REPORTED, NOT FIXED — pinned at the measured value (identical before and
  // after; node says 1). `Object.getPrototypeOf(hostBackedInstance)` answers
  // the SYNTHETIC `Sub.prototype` minted by `__set_subclass_proto`, not the
  // compiled `B.prototype` carrier. This issue unifies the CONSTRUCTOR
  // identity, which is what jsbi's short-circuits read; unifying the two
  // prototype objects as well is a separate change (`__set_subclass_proto`
  // would have to point the instance at the compiled carrier, which would
  // break the `instanceof Parent` walk it exists to preserve).
  pHostProtoAny: 0,
};

/**
 * Single-module lane: node's answers. Trailing comments give the base value
 * measured on the parent of this change.
 */
const EXPECTED_SINGLE: Record<string, unknown> = {
  ...COMMON,
  pStructAny: 1, // base: 0
  pHostAny: 1, // base: 0
  pStructProtoAny: 1,
  pStructInstanceofAny: 1,
  pHostInstanceofAny: 1,
  // REPORTED, NOT FIXED — pinned at the measured value, identical before and
  // after. `typeof` of a compiled class object is "object" in the
  // single-module lane and "function" across the linked seam: the constructible
  // mirror (#4618) is only minted on the crossing. node says "function" for
  // both. Independent of this issue's identity question, which the `===` cells
  // above answer.
  pStructTypeofCtor: "object",
  pHostTypeofCtor: "function", // the class object crosses as its callable mirror
  pHostReadToString: "B(3:undefined)", // base: "1,2,3" — #5373's fourth site
  pHostReadValueOf: "42", // base: "1,2,3" (the built-in returned the receiver)
  pStructReadToString: "P(1)",
  pJsbiShortCircuit: "SHORTCIRCUIT", // base: "42"/"1,2,3" — the identity never fired
  pJsbiShortCircuitPlain: "5",
};

/**
 * Linked lane. The cross-module class-member gap (#5223, pinned by #5373) is
 * NOT closed here: a consumer that never declares `B` has no
 * `__class_call_B_*` bridge for `_resolveClassMember`, so a member READ across
 * the seam still takes the built-in. Every probe below is therefore driven from
 * INSIDE the provider (the `pv*` forwarders), which is also how the Temporal
 * polyfill uses jsbi — the class and its consumer are in the same module.
 */
const EXPECTED_LINKED: Record<string, unknown> = {
  ...COMMON,
  pStructAny: 1,
  pHostAny: 1,
  pStructProtoAny: 1,
  pStructInstanceofAny: 1,
  pHostInstanceofAny: 1,
  pStructTypeofCtor: "function",
  pHostTypeofCtor: "function",
  pHostReadToString: "B(3:undefined)",
  pHostReadValueOf: "42",
  pStructReadToString: "P(1)",
  pJsbiShortCircuit: "SHORTCIRCUIT",
  pJsbiShortCircuitPlain: "5",
};

/**
 * The same-name control: TWO classes named `Q`, one in a PROVIDER and one in
 * its CONSUMER — two separately compiled modules, each checking its OWN
 * identity internally.
 *
 * That is what discriminates the two keyings. The instance → class-object link
 * is process-global; if it were keyed by class NAME, the second module's
 * registration would overwrite the first's and ONE of the two self-checks would
 * read 0 while the other read 1. Keyed by object identity, both read 1. This is
 * the #5280 hazard in miniature — there a stale NAME-keyed class parent
 * survived across files inside one sharded test262 worker and parked three PRs
 * on 2026-09-02.
 *
 * Two deliberate shapes:
 *
 *  - The LINKED lane, not one compilation. Within a single compilation the
 *    compiler COLLAPSES two same-named classes into one (measured on
 *    `origin/main` and unchanged here, for two blocks in one file AND for two
 *    modules of one `compileMulti`: `mkFirst().who()` answers "second"). A
 *    separate, pre-existing defect — and a shape that cannot distinguish the
 *    two keyings at all.
 *  - Each side checks an instance it minted ITSELF. A cross-side check would
 *    read 0 for a second reason — an instance that crosses the seam arrives as
 *    a host mirror, not the raw carrier — so it is not evidence about keying.
 *    `who()` pins that the two classes really are distinct.
 */
const SAME_NAME_PROVIDER = `
class Q { constructor() { this.side = "provider"; } who() { return this.side; } }
function readCtor(i) { return i.constructor; }
function eq(a, b) { return a === b ? 1 : 0; }
export function providerSelfIdentity() { return eq(readCtor(new Q()), Q); }
export function providerWho() { return new Q().who(); }
`;

const SAME_NAME_CONSUMER = `
class Q { constructor() { this.side = "consumer"; } who() { return this.side; } }
function readCtor(i) { return i.constructor; }
function eq(a, b) { return a === b ? 1 : 0; }
export function consumerSelfIdentity() { return eq(readCtor(new Q()), Q); }
export function consumerWho() { return new Q().who(); }
export function providerSelf() { return providerSelfIdentity(); }
export function providerName() { return providerWho(); }
`;

function readAll(exports: Record<string, unknown>, expected: Record<string, unknown>): Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  for (const name of Object.keys(expected)) {
    try {
      const value = (exports[name] as (() => unknown) | undefined)?.();
      observed[name] = Array.isArray(value) ? Array.from(value) : value;
    } catch (error) {
      observed[name] = `THREW: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return observed;
}

async function runSingleModule(sources: Record<string, string>, entry: string): Promise<WebAssembly.Instance> {
  const result = await compileMulti(sources, entry, { allowJs: true, skipSemanticDiagnostics: true });
  expect(result.success).toBe(true);
  expect(result.linkedModules ?? []).toHaveLength(0);
  const imports = result.importObject as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
  const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance;
}

describe("#5377 — a compiled class instance answers its own class object for `constructor`", () => {
  it("the single-module lane answers node", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const instance = await runSingleModule(
      {
        "/provider.js": PROVIDER_SOURCE,
        [entry]: `${CONSUMER_IMPORT}"./provider";\n${CONSUMER_PROBES}`,
      },
      entry,
    );
    expect(readAll(instance.exports as unknown as Record<string, unknown>, EXPECTED_SINGLE)).toEqual(EXPECTED_SINGLE);
  });

  it("a separately linked provider answers the same", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5377-"));
    const packageRoot = join(root, "node_modules", "ident5377");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "ident5377", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(entry, `${CONSUMER_IMPORT}"ident5377";\n${CONSUMER_PROBES}`);

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    // Load-bearing: a `bundled` plan would run the single-module lane twice.
    expect(result.linkPlan?.mode).toBe("separate");
    const { instance } = await instantiateLinkedProject(result);
    expect(readAll(instance.exports as unknown as Record<string, unknown>, EXPECTED_LINKED)).toEqual(EXPECTED_LINKED);
  });

  it("maps by class-object identity, not by class name", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5377-name-"));
    const packageRoot = join(root, "node_modules", "samename5377");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "samename5377", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), SAME_NAME_PROVIDER);
    const entry = join(root, "main.js");
    writeFileSync(entry, `import { providerSelfIdentity, providerWho } from "samename5377";\n${SAME_NAME_CONSUMER}`);

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    expect(result.linkPlan?.mode).toBe("separate");
    const { instance } = await instantiateLinkedProject(result);
    const expected = {
      providerSelf: 1,
      consumerSelfIdentity: 1,
      providerName: "provider",
      consumerWho: "consumer",
    };
    expect(readAll(instance.exports as unknown as Record<string, unknown>, expected)).toEqual(expected);
  });
});
