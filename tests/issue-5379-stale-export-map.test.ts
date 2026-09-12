// #5379 — a value built by instantiation N must never be dispatched through
// instantiation N−1's export map.
//
// WHAT THIS FILE PINS, AND WHAT IT DELIBERATELY DOES NOT CLAIM.
//
// The issue was filed from a trace captured by dev-5377 (`.tmp/dbgM5.log`,
// 2026-09-06 23:46) in which an instance minted by provider instantiation 2
// (`classObj=object#125`, whose module's exports are `object#127`) reached a
// member read carrying `exports=object#3` — instantiation 1's export map.
// That trace was taken on a base WITHOUT #5364: `640f6939d0` (the #5364 merge)
// landed on main at 01:29 the following morning, and #5377's ownership gate
// `4654f50e5f` does not contain it either. #5364 put BOTH per-instantiation
// resets — `resetLinkedProjectRegistry` and `resetTemporalRealmGlobals` — on
// the single test262 instantiate seam, and the strict rerun of a row goes
// through that seam like any other instantiation. Re-measured on this branch
// (main + #5377), the arrival does not happen: over the four linked Temporal
// probe rows the #5377 gate `_classObjectOwnedBy` is evaluated 1,927 times and
// answers "foreign" ZERO times, with five distinct registering export sets in
// the process, and `Instant.epochNanoseconds` is a correct bigint both in a
// fresh process and after ten other Temporal rows in the same one.
//
// So the integration test below is a REGRESSION GUARD, not a repro: it passes
// on base. It is here because the property it asserts — project 2's instance
// dispatching through project 2's exports — is the one #5364 restored and the
// one that silently rots when a module-level cache starts answering for a
// project that is gone.
//
// The registry tests ARE base-failing, and they cover the one holder in the
// plan's candidate list that genuinely survives an instantiation boundary: the
// `owners` WeakMap inside `createCrossModuleStructOwners`
// (`src/runtime/cross-module-struct-owners.ts`), written at `decoderFor`'s
// three `owners.set(...)` sites and explicitly NOT cleared by `reset()`. Its
// old justification — the entries "become unreachable with" the retiring
// project — is false: `classStaticParent`'s `classParentsByName` is a
// process-global STRONG map of class objects keyed by class NAME, so project
// 1's objects outlive project 1 by construction.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileProject, instantiateLinkedProject } from "../src/index.js";
import { createCrossModuleStructOwners } from "../src/runtime/cross-module-struct-owners.js";

/**
 * One module's export surface. `owns` is what it minted; `aliases` is what it
 * can merely NAME. Two instances of one binary share canonical WasmGC types, so
 * each names the other's structs — that is what `aliases` models.
 */
function fakeModule(owns: Set<object>, aliases: Set<object>): Record<string, Function> {
  return {
    __struct_field_names: (obj: object) => (owns.has(obj) || aliases.has(obj) ? "year,month,day" : ""),
  };
}

describe("#5379 — a retired module never answers ahead of a live one", () => {
  it("a cache entry from the previous project loses to the live project", () => {
    const registry = createCrossModuleStructOwners(() => true);
    const struct = {};
    const provider1 = fakeModule(new Set([struct]), new Set());
    const consumer1 = fakeModule(new Set(), new Set());
    // Project 2 is a second instance of the SAME binary, so it can name the
    // struct type — which is exactly why the stale entry is dangerous.
    const provider2 = fakeModule(new Set(), new Set([struct]));
    const consumer2 = fakeModule(new Set(), new Set());

    registry.registerModule(provider1);
    registry.registerModule(consumer1);
    // Project 1 reads it once, so the cache learns struct -> provider1.
    expect(registry.decoderFor(struct, consumer1)).toBe(provider1);

    registry.reset();
    registry.registerModule(provider2);
    registry.registerModule(consumer2);

    // Base answers `provider1` straight out of the cache — a module the
    // registry has already retired, chosen over the live project without ever
    // probing it.
    expect(registry.decoderFor(struct, consumer2)).toBe(provider2);
  });

  it("the retired entry is KEPT as the fallback when no live module can decode", () => {
    // Dropping the entry instead of demoting it would turn a working read of a
    // surviving cross-project value into the `ref.test`-miss default (0). The
    // retired module's Wasm instance is alive for as long as the struct is.
    const registry = createCrossModuleStructOwners(() => true);
    const struct = {};
    const provider1 = fakeModule(new Set([struct]), new Set());
    const consumer1 = fakeModule(new Set(), new Set());
    const provider2 = fakeModule(new Set(), new Set());
    const consumer2 = fakeModule(new Set(), new Set());

    registry.registerModule(provider1);
    registry.registerModule(consumer1);
    expect(registry.decoderFor(struct, consumer1)).toBe(provider1);

    registry.reset();
    registry.registerModule(provider2);
    registry.registerModule(consumer2);

    expect(registry.decoderFor(struct, consumer2)).toBe(provider1);
  });

  it("the negative cache still short-circuits — the #3903 hot-path guarantee", () => {
    // `__extern_get` runs ~10k times per `run()`, and every host object it sees
    // is a NONE. That arm must not pay the retired-module re-probe.
    const registry = createCrossModuleStructOwners(() => true);
    const hostObject = {};
    const provider1 = fakeModule(new Set(), new Set());
    let consumerProbes = 0;
    const consumer1: Record<string, Function> = {
      __struct_field_names: () => {
        consumerProbes++;
        return "";
      },
    };
    registry.registerModule(provider1);
    registry.registerModule(consumer1);

    expect(registry.decoderFor(hostObject, consumer1)).toBeUndefined();
    const afterFirst = consumerProbes;
    for (let i = 0; i < 5; i++) expect(registry.decoderFor(hostObject, consumer1)).toBeUndefined();
    expect(consumerProbes).toBe(afterFirst);
  });

  it("a live cache entry is still answered without re-probing", () => {
    const registry = createCrossModuleStructOwners(() => true);
    const struct = {};
    let providerProbes = 0;
    const provider: Record<string, Function> = {
      __struct_field_names: () => {
        providerProbes++;
        return "year,month,day";
      },
    };
    const consumer = fakeModule(new Set(), new Set());
    registry.registerModule(provider);
    registry.registerModule(consumer);

    expect(registry.decoderFor(struct, consumer)).toBe(provider);
    const afterFirst = providerProbes;
    for (let i = 0; i < 5; i++) expect(registry.decoderFor(struct, consumer)).toBe(provider);
    expect(providerProbes).toBe(afterFirst);
  });
});

describe("#5379 — two instantiations of one provider binary in one process", () => {
  it("each project's instance dispatches through its OWN module's exports", async () => {
    const { resetLinkedProjectRegistry } = await import("../src/runtime.js");

    const root = mkdtempSync(join(tmpdir(), "issue-5379-"));
    const packageRoot = join(root, "node_modules", "box5379");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "box5379", version: "0.0.0", main: "index.js" }),
    );
    // `built` is the MODULE-IDENTIFYING export the plan asks for: a counter in
    // provider module scope, incremented once per construction. Project 1 makes
    // three boxes and project 2 makes one, so a `builtInThisModule()` of 3 read
    // off project 2's instance is proof the call landed in project 1's module.
    writeFileSync(
      join(packageRoot, "index.js"),
      `let built = 0;
       export class Box {
         constructor(v) { built = built + 1; this.v = v; }
         get() { return this.v; }
         builtInThisModule() { return built; }
         valueOf() { return built * 1000 + this.v; }
         toString() { return "Box(" + built + "," + this.v + ")"; }
       }`,
    );
    const entry = join(root, "main.js");
    writeFileSync(
      entry,
      `import { Box } from "box5379";
       export function make(n) { return new Box(n); }
       export function theClass() { return Box; }
       export function instOf(b) { return b instanceof Box; }`,
    );
    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    // Load-bearing: a `bundled` plan inlines the package and would instantiate
    // ONE module twice instead of a provider+consumer pair twice.
    expect(result.linkPlan?.mode, `fallbackReason=${result.linkPlan?.fallbackReason}`).toBe("separate");

    // ONE compiled binary, instantiated twice — the shape a test262 fork runs
    // for every Temporal row, and the shape an embedder holding two graphs runs.
    const instantiate = async (builds: number) => {
      const project = await instantiateLinkedProject(result);
      const exports = project.instance.exports as unknown as Record<string, (arg?: unknown) => unknown>;
      let instance: any;
      for (let i = 0; i < builds; i++) instance = exports.make!(i + 1);
      return { exports, instance, builds };
    };

    const read = (project: { exports: Record<string, (arg?: unknown) => unknown>; instance: any; builds: number }) => ({
      instanceOf: project.exports.instOf!(project.instance) === 1 || project.exports.instOf!(project.instance) === true,
      constructorIsC: project.instance.constructor === project.exports.theClass!(),
      builtInThisModule: project.instance.builtInThisModule(),
      number: Number(project.instance),
      string: String(project.instance),
    });

    const first = await instantiate(3);
    expect(read(first)).toEqual({
      instanceOf: true,
      constructorIsC: true,
      builtInThisModule: 3,
      number: 3003,
      string: "Box(3,3)",
    });

    // What the ONE test262 instantiate seam does between rows.
    resetLinkedProjectRegistry();

    const second = await instantiate(1);
    // The whole issue in one assertion: every one of these reads crosses the
    // host boundary, and every one of them must land in the SECOND module.
    expect(read(second)).toEqual({
      instanceOf: true,
      constructorIsC: true,
      builtInThisModule: 1,
      number: 1001,
      string: "Box(1,1)",
    });

    // …and project 1, still live and still holding its own instance, is not
    // dragged into project 2's module either.
    expect(read(first).builtInThisModule).toBe(3);
  }, 300_000);
});
