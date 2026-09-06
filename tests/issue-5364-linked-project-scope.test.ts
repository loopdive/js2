// #5364 — the #5225 cross-module decoder registry assumes ONE live linked
// project per process, and a test262 fork runs many.
//
// WHAT GOES WRONG. `registerLinkedProviderModule` / `registerLinkedConsumerModule`
// add exports to a module-level Set that nothing ever removes. Two instances of
// the SAME provider binary — the compile-once Temporal provider, re-instantiated
// once per row since #5353 — share canonical WasmGC types, so project 1's
// `__struct_field_names` answers a NON-EMPTY name list for a struct project 2
// minted. `decoderFor` iterates the Set in insertion order, meets project 1
// first, and hands back project 1's exports. Nothing throws: #5354's
// `__class_object_of` then returns project 1's class-object singleton, so the
// consumer's live `C` and the instance's resolved constructor are two complete,
// internally consistent, unrelated mirrors — `x instanceof C` false while
// `x.constructor.name` reads right.
//
// WHY THE UNIT LANE IS THE PRIMARY TEST HERE. The end-to-end symptom needs the
// Temporal polyfill's surface: three back-to-back linked projects built from a
// small class provider all answer correctly on base (dev-5363's
// `.tmp/probe-twoproject.mts`), so an integration assertion of "project 2's
// instanceof is true" is VACUOUS — it passes without the fix. The registry's own
// resolution order is where the defect lives and is decidable exactly, so that
// is what the first test pins, with the two-instances-of-one-binary aliasing
// modelled the way the real thing behaves. The integration test below is the
// regression guard for the reverted attempt 1 (project scoping broke the #5225
// consumer→provider literal route from the second project on), not the repro.
//
// REPORTED, NOT FIXED. `resetLinkedProjectRegistry` RETIRES the previous project
// rather than scoping the registry per project, so two linked projects that are
// live SIMULTANEOUSLY are still unsupported — reading project 1 after project 2
// has been instantiated takes the miss path. That is #5364 deliverable B.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileProject, instantiateLinkedProject } from "../src/index.js";
import { createCrossModuleStructOwners } from "../src/runtime/cross-module-struct-owners.js";

/**
 * A stand-in for one module's export surface.
 *
 * `owns` is the set of structs this module actually minted; `aliases` is the set
 * it can NAME without having minted them. Real modules do not get to choose:
 * two instances of one binary share canonical types, so each names the other's
 * structs, which is exactly `aliases`.
 */
function fakeModule(owns: Set<object>, aliases: Set<object>): Record<string, Function> {
  return {
    __struct_field_names: (obj: object) => (owns.has(obj) || aliases.has(obj) ? "year,month,day" : ""),
  };
}

describe("#5364 — the cross-module decoder registry is scoped to one live project", () => {
  it("without a reset, project 2's struct resolves through project 1's exports", () => {
    const registry = createCrossModuleStructOwners(() => true);
    const struct2 = {};
    // Two instances of ONE provider binary: each names the other's structs.
    const provider1 = fakeModule(new Set(), new Set([struct2]));
    const consumer1 = fakeModule(new Set(), new Set());
    const provider2 = fakeModule(new Set([struct2]), new Set());
    const consumer2 = fakeModule(new Set(), new Set());

    registry.registerModule(provider1);
    registry.registerModule(consumer1);
    registry.registerModule(provider2);
    registry.registerModule(consumer2);

    // Consumer 2 reads a struct provider 2 minted. The right answer is
    // provider2; insertion order reaches the aliasing provider1 first.
    expect(registry.decoderFor(struct2, consumer2)).toBe(provider1);
  });

  it("with a reset between projects, it resolves through project 2's own exports", () => {
    const registry = createCrossModuleStructOwners(() => true);
    const struct2 = {};
    const provider1 = fakeModule(new Set(), new Set([struct2]));
    const consumer1 = fakeModule(new Set(), new Set());
    const provider2 = fakeModule(new Set([struct2]), new Set());
    const consumer2 = fakeModule(new Set(), new Set());

    registry.registerModule(provider1);
    registry.registerModule(consumer1);
    registry.reset();
    registry.registerModule(provider2);
    registry.registerModule(consumer2);

    expect(registry.decoderFor(struct2, consumer2)).toBe(provider2);
  });

  it("a reset restores the single-module fast path — one module answers nothing", () => {
    const registry = createCrossModuleStructOwners(() => true);
    const struct = {};
    const provider1 = fakeModule(new Set(), new Set([struct]));
    const consumer1 = fakeModule(new Set(), new Set());
    registry.registerModule(provider1);
    registry.registerModule(consumer1);
    registry.reset();
    // `enabled` is back to false, so the miss path is not even entered — this is
    // the #3903 hot-path guarantee (`__extern_get` runs ~10k times per `run()`).
    registry.registerModule(provider1);
    expect(registry.decoderFor(struct, consumer1)).toBeUndefined();
  });

  it("two linked projects back to back: the second still decodes a consumer literal (#5225 route)", async () => {
    const { resetLinkedProjectRegistry } = await import("../src/runtime.js");

    const build = async (tag: string) => {
      const root = mkdtempSync(join(tmpdir(), `issue-5364-${tag}-`));
      const packageRoot = join(root, "node_modules", "box5364");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "box5364", version: "0.0.0", main: "index.js" }),
      );
      // `addFrom` / `fromLiteral` are the #5225 route: an object literal the
      // CONSUMER mints, read by the PROVIDER's `__extern_get`. That is what
      // attempt 1's project scoping broke ("invalid duration-like" from the
      // second program on). They are METHODS rather than a bare exported
      // `function sum(o)` deliberately — a top-level function with an inferred
      // `any` parameter alongside a class export drops the whole graph to
      // `mode: "bundled"` ("inferred/any package signatures require
      // side-effect-free engine validation"), which would silently test the
      // single-module lane twice.
      writeFileSync(
        join(packageRoot, "index.js"),
        `export class Box {
           constructor(v) { this.v = v; }
           get() { return this.v; }
           addFrom(o) { return this.v + o.a + o.b; }
           static fromLiteral(o) { return new Box(o.a + o.b); }
         }`,
      );
      const entry = join(root, "main.js");
      writeFileSync(
        entry,
        `import { Box } from "box5364";
         export function boxInstOf() { return new Box(7) instanceof Box; }
         export function boxRead() { return new Box(7).get(); }
         export function literalSum() { return new Box(0).addFrom({ a: 2, b: 5 }); }
         export function literalStatic() { return Box.fromLiteral({ a: 2, b: 5 }).get(); }`,
      );
      const result = await compileProject(entry, {
        allowJs: true,
        skipSemanticDiagnostics: true,
        packageCacheDir: join(root, "providers"),
      });
      expect(result.success).toBe(true);
      // Load-bearing: a `bundled` plan inlines the package and would test the
      // single-module lane twice.
      expect(result.linkPlan?.mode, `fallbackReason=${result.linkPlan?.fallbackReason}`).toBe("separate");
      return result;
    };

    const first = await build("p1");
    const second = await build("p2");

    const read = (instance: WebAssembly.Instance) => {
      const e = instance.exports as unknown as Record<string, () => unknown>;
      return {
        instOf: e.boxInstOf?.() === true || e.boxInstOf?.() === 1,
        read: e.boxRead?.(),
        sum: e.literalSum?.(),
        madeFromLiteral: e.literalStatic?.(),
      };
    };

    const p1 = await instantiateLinkedProject(first);
    expect(read(p1.instance)).toEqual({ instOf: true, read: 7, sum: 7, madeFromLiteral: 7 });

    // What the test262 instantiate seam does between rows.
    resetLinkedProjectRegistry();

    const p2 = await instantiateLinkedProject(second);
    expect(read(p2.instance)).toEqual({ instOf: true, read: 7, sum: 7, madeFromLiteral: 7 });
  }, 300_000);
});
