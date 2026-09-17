// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6623 (#5383 S36) — a locally-declared class whose `extends` heritage could
// NOT be resolved to a known local class (`class S extends NS.PD {}`, a
// property-access into a linked provider namespace; or `class S extends
// construct {}`, an identifier bound to a runtime PARAMETER — the exact shape
// `TemporalHelpers.checkSubclassingIgnored(construct, ...)` uses) is compiled
// as an INDEPENDENT ROOT struct with no genuine relationship to its true
// superclass (`src/codegen/class-bodies.ts`'s heritage-detection code only
// resolves an `Identifier`/`ClassExpression` base to a real parent; a
// property-access base and an unresolvable identifier both leave
// `parentClassName`/`parentStructTypeIdx` unlinked).
//
// WHY THIS MATTERS. When such a class declares no own fields (the common
// shape — `class MySubclass extends construct { constructor() { super(...);
// } }`, test262's own `checkSubclassConstructorUndefined`/
// `checkSubclassSpeciesXxx` pattern), its struct canonicalizes to the SAME
// WasmGC type as ANY OTHER field-less class — including one exported by a
// LINKED PROVIDER module. `standalone-class-instance-proto.ts`'s
// `__std_class_instance_proto` dispatcher (the #6617/S30 mechanism answering
// `Object.getPrototypeOf` for a compiled class instance through a value the
// checker cannot narrow) disambiguates same-shape classes ONLY by `__tag`, a
// small per-module integer counter (`ctx.classTagCounter`, starting at 0 in
// EVERY module independently — see `class-bodies.ts`). Two field-less classes
// in DIFFERENT modules (the consumer's own subclass, and any provider class)
// can therefore share BOTH the canonical struct shape AND the numeric tag by
// pure coincidence, and the dispatcher then answers the CONSUMER's subclass's
// prototype for a value the PROVIDER genuinely minted — a silently WRONG
// non-null answer, worse than the declined `null` it replaces (the exact
// hazard #6620/S33's `taCtorIdentityTestInstrs` was built to close for a
// sibling collision).
//
// THE FIX. `ctx.classDynamicUnresolvedHeritageSet` (new) is populated at the
// two heritage sites that leave a class unlinked under `--target
// standalone`/`wasi`. `standalone-class-instance-proto.ts`'s `collectEntries`
// excludes a flagged, field-less class from ever claiming a
// `getPrototypeOf` answer — declining (falling through, eventually to `null`)
// rather than risking the false-positive match. A class with genuine own (or
// inherited) fields is NOT flagged out: its struct shape is unique enough
// that the collision cannot occur, so its own instances still answer
// correctly.
//
// WHAT THIS DOES NOT CLAIM TO FIX. The test262 headline (45
// `built-ins/Temporal/**/subclassing-ignored.js` files,
// `checkSubclassConstructorUndefined`'s `Object.getPrototypeOf(result) ===
// construct.prototype`) stays 0/45 — Duration's real `__tag` does not
// coincidentally collide with a lone `class MySubclass` in that test's own
// module, so the base tree ALREADY declines (answers `null`) for that
// specific pair, and this fix changes nothing observable there. What it DOES
// fix, measured directly below: a genuine, silently WRONG (non-null)
// prototype claim reachable whenever the tags DO coincide — a different,
// corpus-wide-relevant defect class, filed and reduced in #6623.
//
// EVERY EXPECTATION BELOW WAS MEASURED ON BOTH TREES by file-copy revert of
// the four touched files to `HEAD~1` equivalents (`.tmp/s36base/*.ts`). The
// base answer is recorded inline on each `it`.
//
// Host-free: `hostBridge: "off"` plus a provider linked purely via
// `compileProject`/`compileMulti` — no real `@js-temporal/polyfill` is
// compiled here (kept synthetic per the S36 slice's constraint). The linked
// probe answers through a string-readback channel, one char code at a time —
// a standalone module's string is a WasmGC array the host cannot decode.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

let packageSeq = 0;

/**
 * Build a provider package + a consumer that links it, and read one string
 * back. Each call uses a FRESH package name (`packageSeq`) — `compileProject`
 * caches by package identity, and several `it`s in this file deliberately
 * compile DIFFERENT provider sources.
 */
async function runLinkedString(provider: string, consumerExpression: string): Promise<string> {
  const seq = packageSeq++;
  const pkgName = `ns6623${seq}`;
  const root = mkdtempSync(join(tmpdir(), `issue-6623-${seq}-`));
  const packageRoot = join(root, "node_modules", pkgName);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: pkgName, version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "${pkgName}";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === pkgName)!;
  const field = artifact.exportBoundaries!.NS!.field;
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      [consumerEntry]:
        `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\nlet __s = "";\n` +
        `export function prepare() { try { __s = "" + (${consumerExpression}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }\n` +
        `export function at(i) { return __s.charCodeAt(i); }\n`,
    },
    consumerEntry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
      ...STANDALONE,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  const exports = instance.exports as unknown as { prepare: () => number; at: (i: number) => number };
  const length = exports.prepare();
  let out = "";
  for (let index = 0; index < length; index++) out += String.fromCharCode(exports.at(index));
  return out;
}

/**
 * Field-less: `PD`'s numeric state lives in a module-private `WeakMap`
 * getter, not a struct field — matching `Temporal.Duration`'s ACTUAL compiled
 * shape (#5383 S33 §1: "its numeric fields live in an expando side-table, not
 * native struct fields"). This is the shape that collides.
 */
const PROVIDER_FIELDLESS = `
  const state = new WeakMap();
  export class PD {
    constructor(y) { state.set(this, y === undefined ? 0 : y); }
    get y() { return state.get(this); }
    m() { return new PD(this.y + 1); }
  }
  export const NS = Object.freeze({ __proto__: null, PD: PD });`;

/** Field-HAVING control: `PD`'s struct is `{__tag, __shape_brand, y}`, structurally unique. */
const PROVIDER_FIELDED = `
  export class PD {
    constructor(y) { this.y = y === undefined ? 0 : y; }
    m() { return new PD(this.y + 1); }
  }
  export const NS = Object.freeze({ __proto__: null, PD: PD });`;

describe("#6623 — cross-module class-tag collision, standalone", () => {
  it("does NOT claim a locally-declared field-less subclass's prototype for an unrelated provider instance (property-access heritage)", async () => {
    // TEETH. Base tree: "WRONG" — `class S extends NS.PD {}` collides with
    // `PD` (both field-less, both `__tag === 0`, the first class in their
    // respective modules), and `plain.m()` — a genuine `new PD(...)` call
    // inside the PROVIDER's own method, on a receiver that never touches `S`
    // at all — answers `S.prototype`.
    await expect(
      runLinkedString(
        PROVIDER_FIELDLESS,
        `(function(){
          class S extends NS.PD {}
          const plain = new NS.PD(9);
          const r = plain.m();
          const p = Object.getPrototypeOf(r);
          return p === S.prototype ? "WRONG" : "OK";
        })()`,
      ),
    ).resolves.toBe("OK");
  });

  it("does NOT claim a subclass's prototype through the FAITHFUL test262 shape (identifier heritage — a function parameter)", async () => {
    // TEETH. Base tree: "WRONG". `class MySubclass extends construct {}`
    // where `construct` is a PARAMETER is exactly
    // `TemporalHelpers.checkSubclassConstructorUndefined`'s own shape.
    await expect(
      runLinkedString(
        PROVIDER_FIELDLESS,
        `(function(construct){
          class MySubclass extends construct { constructor() { super(1); } }
          const instance = new MySubclass();
          const result = instance.m();
          const p = Object.getPrototypeOf(result);
          return p === MySubclass.prototype ? "WRONG" : "OK";
        })(NS.PD)`,
      ),
    ).resolves.toBe("OK");
  });

  it("CONTROL — a module with no colliding local class still answers the provider's real prototype", async () => {
    // CONTROL — "PD.prototype" on both trees. No collision risk when nothing
    // in the consumer module declares a field-less class with unresolved
    // heritage.
    await expect(
      runLinkedString(
        PROVIDER_FIELDLESS,
        `(function(){
          const plain = new NS.PD(9);
          const r = plain.m();
          const p = Object.getPrototypeOf(r);
          return p === NS.PD.prototype ? "PD.prototype" : (p === null ? "null" : "other");
        })()`,
      ),
    ).resolves.toBe("PD.prototype");
  });

  it("CONTROL — a field-HAVING provider is unaffected (the exclusion only applies to field-less classes)", async () => {
    // CONTROL — identical on both trees. `PD`'s struct here carries a real
    // `y` field, so it cannot structurally collide with a field-less local
    // subclass in the first place; this fix's guard never fires for it. (The
    // dynamic method dispatch itself still fails for an unrelated reason —
    // #6623's own write-up sizes that as a SEPARATE, un-fixed mechanism.)
    await expect(
      runLinkedString(
        PROVIDER_FIELDED,
        `(function(construct){
          class MySubclass extends construct { constructor() { super(1); } }
          const instance = new MySubclass();
          try {
            instance.m();
            return "called";
          } catch (e) {
            return "threw:" + (e && e.message ? e.message : String(e));
          }
        })(NS.PD)`,
      ),
    ).resolves.toBe("threw:called value is not a function");
  });

  it("CONTROL — a class with unresolved heritage but its OWN declared field still answers ITS OWN prototype correctly", async () => {
    // CONTROL — "same" on both trees. The exclusion only applies when the
    // class declares NO own fields; one that does is structurally distinct
    // enough that the collision guard would never have applied, so this
    // class's OWN instances keep answering through the (already-fixed,
    // #6617/S30) instance-proto dispatcher exactly as before.
    await expect(
      runLinkedString(
        PROVIDER_FIELDLESS,
        `(function(construct){
          class MySubclass extends construct {
            constructor() { super(1); this.ownField = 42; }
          }
          const instance = new MySubclass();
          const p = Object.getPrototypeOf(instance);
          return p === MySubclass.prototype ? "same" : (p === null ? "null" : "other");
        })(NS.PD)`,
      ),
    ).resolves.toBe("same");
  });
});
