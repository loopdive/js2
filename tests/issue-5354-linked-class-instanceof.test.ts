// #5354 — a consumer-constructed instance of a LINKED provider class must keep
// its object identity: `instanceof`, `[[Prototype]]` and `constructor`.
//
// Measured from the consumer side of the #2527 linked-provider seam (the same
// shape the #4628 Temporal provider has), with instances the consumer builds
// itself. Base, on this branch's merge base:
//
//                        LINKED lane        CONTROL lane (single module)
//   instOf               false            → true      true
//   protoIsProto         false            → true      true
//   ctorTypeof           "undefined"      → "function" "function"
//   ctorIsPoint          false            → true      true
//   protoConstructorType "undefined"      → "function" "function"
//   protoOfProtoDesc     "null"           → "object"  "object"
//   madeInstOf           false            → true      true   (static factory)
//   madeCtorIsPoint      false            → true      true
//   subInstOfSub         false            → true      true
//   subInstOfBase        false            → true      true
//   subProtoChain        false            → true      false  (see below)
//
// The control lane answered the post-fix value for everything but the last row
// on base ALREADY, and is byte-for-byte unchanged by this fix — that is what
// pins the defect as seam-only rather than a general class-identity gap.
//
// THE RULE (root cause):
//
//   A class reaching the host as a VALUE is presented by
//   `_makeClassCtorMirrorForHost` as a Function proxy whose `.prototype` is a
//   chain-aware FACADE object. An instance minted by that mirror — or by any
//   provider-side factory — is a `_wrapForHost` proxy, and that proxy's
//   `getPrototypeOf` trap answered a hardcoded `Object.prototype`.
//
//   So `C.prototype` and `getPrototypeOf(new C())` were two unrelated objects.
//   OrdinaryHasInstance (§7.3.20) reads the first and walks from the second,
//   never meets, and answers false — with `constructor` unreachable for the
//   same reason (a get trap serves inherited reads itself; the engine does not
//   consult [[Prototype]] once a trap is installed).
//
//   The fix is at IDENTITY: the instance proxy answers the class mirror's
//   facade, so `instanceof`, `getPrototypeOf` and `constructor` all follow from
//   one edge. Which class a foreign struct belongs to is a `__tag` read only the
//   OWNING module can do, so it publishes it: `__class_object_of` (and
//   `__class_parent_object_of` for the `extends` link) — see
//   src/codegen/class-object-of.ts.
//
// Reported, NOT fixed here (both pre-existing, both measured on base):
//
//   * `subProtoChain` — `getPrototypeOf(getPrototypeOf(new Sub()))` in the
//     SINGLE-MODULE lane is not the base class's prototype. That is the raw-
//     struct arm of the `__getPrototypeOf` import, deliberately untouched: in
//     that lane `C.prototype` is the RAW prototype struct, so answering the
//     host facade there would introduce the very identity split this fixes.
//   * `typeof C[Symbol.hasInstance]` is "undefined" through the seam and
//     "function" in the control lane. It does not affect `instanceof` — the
//     spec path only consults a CUSTOM @@hasInstance, and `_instanceofResult`
//     explicitly skips `Function.prototype[Symbol.hasInstance]`.
//   * `({x:1}) instanceof Point` fails to COMPILE in the single-module lane
//     ("struct.get[0] expected type (ref null 16), found struct.new of type
//     (ref 27)"), on base as well as here. Unrelated static-lowering bug; kept
//     out of the probes so it cannot mask this measurement.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

/** One provider module, used verbatim by BOTH lanes. */
const PROVIDER_SOURCE = `
export class Point {
  constructor(x, y) { this.x = x; this.y = y; }
  label() { return "P" + this.x + ":" + this.y; }
  static make(x, y) { return new Point(x, y); }
}
export class Point3 extends Point {
  constructor(x, y, z) { super(x, y); this.z = z; }
}
`;

const CONSUMER_PROBES = `
export function instOf() { return new Point(1,2) instanceof Point; }
export function protoIsProto() { return Object.getPrototypeOf(new Point(1,2)) === Point.prototype; }
export function protoStable() { return Point.prototype === Point.prototype; }
export function ctorTypeof() { return typeof new Point(1,2).constructor; }
export function ctorIsPoint() { return new Point(1,2).constructor === Point; }
export function protoConstructorTypeof() { return typeof Point.prototype.constructor; }
// Two statements deliberately: the INLINE \`Object.getPrototypeOf(Point.prototype)\`
// takes a static fold that answers "null" in the single-module lane, on base as
// well as here. Reading through a binding is the shape both lanes agree on.
export function protoOfProtoDesc() { const p = Point.prototype; const q = Object.getPrototypeOf(p); return q === null ? "null" : typeof q; }
export function madeInstOf() { return Point.make(1,2) instanceof Point; }
export function madeCtorIsPoint() { return Point.make(1,2).constructor === Point; }
export function instOfObject() { return new Point(1,2) instanceof Object; }
export function subInstOfSub() { return new Point3(1,2,3) instanceof Point3; }
export function subInstOfBase() { return new Point3(1,2,3) instanceof Point; }
export function baseNotInstOfSub() { return new Point(1,2) instanceof Point3; }
export function methodStillWorks() { return new Point(1,2).label(); }
export function madeLabel() { return Point.make(1,2).label(); }
`;

/**
 * `subProtoChain` is deliberately outside this map — it is the one row the two
 * lanes legitimately differ on (see the header). Everything here must be equal
 * in both lanes.
 */
const EXPECTED: Record<string, unknown> = {
  instOf: true,
  protoIsProto: true,
  protoStable: true,
  ctorTypeof: "function",
  ctorIsPoint: true,
  protoConstructorTypeof: "function",
  protoOfProtoDesc: "object",
  madeInstOf: true,
  madeCtorIsPoint: true,
  instOfObject: true,
  subInstOfSub: true,
  subInstOfBase: true,
  baseNotInstOfSub: false,
  methodStillWorks: "P1:2",
  madeLabel: "P1:2",
};

/** Wasm answers i32 for a boolean-returning export; normalize before comparing. */
function readAll(exports: Record<string, unknown>): Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  for (const name of Object.keys(EXPECTED)) {
    try {
      const raw = (exports[name] as (() => unknown) | undefined)?.();
      observed[name] = typeof EXPECTED[name] === "boolean" ? raw === true || raw === 1 : raw;
    } catch (error) {
      observed[name] = `THREW: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return observed;
}

describe("#5354 — a linked provider class keeps its object identity", () => {
  it("a separately linked package's instances answer instanceof / getPrototypeOf / constructor", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5354-"));
    const packageRoot = join(root, "node_modules", "cls5354");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "cls5354", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(entry, `import { Point, Point3 } from "cls5354";\n${CONSUMER_PROBES}`);

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
  }, 300_000);

  it("the single-module control answers identically (and did on base)", async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/provider.js": PROVIDER_SOURCE,
        [entry]: `import { Point, Point3 } from "./provider";\n${CONSUMER_PROBES}`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const imports = result.importObject as WebAssembly.Imports & {
      __setInstance?: (i: WebAssembly.Instance) => void;
    };
    const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
    imports.__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  }, 300_000);
});
