// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6432 — a Symbol used as a PROPERTY KEY must never be sent through
// OrdinaryToPrimitive.
//
// WHY THIS REDUCTION EXISTS. #6432 was filed as "a standalone module that
// contains `eval` AND links a provider throws `Object.prototype.toString is not
// yet implemented` at MODULE INIT", which made every one of the 360 measured
// linked test262 Temporal rows fail before its first statement (#5383 S5/S6).
// Measured 2026-09-12, the wasm stack under that throw was:
//
//   __protoidx_companion
//    → __nativeproto_seed_<Array>
//      → __defineProperty_accessor(Array, @@species, …)
//        → __obj_find → __to_property_key → __to_primitive
//          → __class_to_primitive        ← the Symbol was treated as an OBJECT
//            → __call_fn_method_0 → Object.prototype.toString glue → REFUSAL
//
// `eval` and the linked provider were only the two things that made the
// generated native-prototype seeding run eagerly at init and gave
// `__class_to_primitive` its generic runtime walk. The DEFECT is one line
// earlier: `__to_primitive`'s §7.1.1-step-1 "already a primitive" early-out
// cascade (i31 · $BoxedNumber · $BoxedBoolean · $AnyString · $Error) had no
// `$Symbol` arm, so a Symbol fell past the `$Object` test into
// `__class_to_primitive`, whose walk guards on
// `__typeof_object(v) || __typeof_function(v)` — and `__typeof_object` has no
// Symbol arm either, so it answered "object" and a property read was sent at
// the Symbol.
//
// That is the FOURTH instance of the action-at-a-distance hazard the
// boxed-boolean and error-struct arms in the same cascade already document: the
// wrong answer appears only once some *other* part of the module contributes a
// `__class_to_primitive` body.
//
// WHICH ARM HAS TEETH — say it plainly. The first `describe` below is a
// host-free two-module link project (`hostBridge: "off"`, EMPTY import object)
// that asserts the intended Symbol-key semantics. It passes on the base tree
// too: measured 2026-09-12, a hand-written provider is not enough to reproduce
// the failure, because the throw needs the native-prototype seeding to be
// MID-FLIGHT — that is what made the Symbol's `toString` resolve to the
// `Object.prototype` glue rather than being absent — and that state is only
// reached through a full realm seed (`eval` + a linked provider, i.e. the
// 3.3 MB Temporal compile, which is too expensive for this suite). So it is a
// SEMANTICS GUARD, not the regression witness.
// The second `describe` is the regression witness: it asserts structurally that
// the `$Symbol` carrier is in `__to_primitive`'s early-out cascade, and it FAILS
// on the base tree.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/** The provider half — present only so the consumer is a LINKED module. */
const PROVIDER = `
  export const NS = Object.freeze({
    __proto__: null,
    ok() { return 7; },
    mkPlain() { return { a: 1 }; },
  });`;

/**
 * Compile `provider` as a linked npm package and `consumer` as the standalone
 * entry that links it, then instantiate the pair with an EMPTY import object.
 * `NS` is the provider's frozen export record, bound in the consumer's scope.
 * (Same seam as `tests/issue-5406-standalone-link-boundary-tostring.test.ts`.)
 */
async function linkedPair(provider: string, consumer: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6432-"));
  const packageRoot = join(root, "node_modules", "ns6432");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6432", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6432";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6432")!;
  const field = artifact.exportBoundaries!.NS!.field;
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      [consumerEntry]: `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\n${consumer}`,
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
  return instance.exports as unknown as Record<string, () => unknown>;
}

// Every probe answers a NUMBER: a standalone module's string is a WasmGC array
// the host cannot decode, so the comparisons happen INSIDE the module.
describe("#6432 a Symbol property key in a linked standalone module", () => {
  it(
    "round-trips through a dynamic member write/read instead of being ToPrimitive'd",
    { timeout: 600_000 },
    async () => {
      const ex = await linkedPair(
        PROVIDER,
        `
        // Opaque so the key cannot be folded to a static string at compile time
        // — the static path never reaches __to_property_key.
        function opaqueKey() { return Symbol.iterator; }
        function opaqueSpecies() { return Symbol.species; }
        export function ok() { return NS.ok(); }
        // The realm-object seed is what ran at module init in the field report:
        // __native_globalThis_ensure -> __protoidx_companion ->
        // __nativeproto_seed_<Array> -> defineProperty(Array, @@species, ...).
        // Touching globalThis is the host-free way to make that seed run.
        export function seedRealm() {
          try { return typeof globalThis === "object" ? 1 : 2; } catch (e) { return 0; }
        }
        // 0 = threw · 1 = the symbol key round-tripped · 2 = wrong value
        export function symKeyRoundTrip() {
          try {
            const o = {};
            o[opaqueKey()] = 5;
            return o[opaqueKey()] === 5 ? 1 : 2;
          } catch (e) { return 0; }
        }
        // A Symbol key and the STRING its Symbol.prototype.toString would
        // produce must not collide: sending the key through OrdinaryToPrimitive
        // is exactly what made them the same slot.
        export function symKeyIsNotItsString() {
          try {
            const o = {};
            o[opaqueKey()] = 5;
            o[opaqueSpecies()] = 6;
            return o[opaqueKey()] === 5 && o[opaqueSpecies()] === 6 ? 1 : 2;
          } catch (e) { return 0; }
        }
        // The literal operation the failing module-init did: define a property
        // under a well-known symbol key via the reflective path.
        export function defineUnderSymbolKey() {
          try {
            const o = {};
            Object.defineProperty(o, opaqueKey(), { value: 11, enumerable: false, configurable: true });
            return o[opaqueKey()] === 11 ? 1 : 2;
          } catch (e) { return 0; }
        }
        // ToPrimitive of a Symbol is the Symbol itself (§7.1.1 step 1), so a
        // Symbol still compares equal to itself after the round trip.
        export function symIdentityPreserved() {
          try {
            const a = opaqueKey();
            const b = opaqueKey();
            return a === b ? 1 : 2;
          } catch (e) { return 0; }
        }
      `,
      );
      // Base tree: every symbol-keyed arm answers 0 (the
      // `Object.prototype.toString is not yet implemented` refusal) or 2 (the
      // key silently stringified into one shared slot).
      expect({
        ok: ex.ok(),
        seedRealm: ex.seedRealm(),
        symKeyRoundTrip: ex.symKeyRoundTrip(),
        symKeyIsNotItsString: ex.symKeyIsNotItsString(),
        defineUnderSymbolKey: ex.defineUnderSymbolKey(),
        symIdentityPreserved: ex.symIdentityPreserved(),
      }).toEqual({
        ok: 7,
        seedRealm: 1,
        symKeyRoundTrip: 1,
        symKeyIsNotItsString: 1,
        defineUnderSymbolKey: 1,
        symIdentityPreserved: 1,
      });
    },
  );
});

/**
 * The arm with teeth. The behavioural reduction above needs the whole
 * native-prototype seeding to be MID-FLIGHT to reproduce (that is what made the
 * Symbol's `toString` resolve to the `Object.prototype` glue instead of being
 * absent), and that state is reachable only through a full realm seed — in
 * practice `eval` plus a linked provider, i.e. the 3.3 MB Temporal compile. So
 * the fix itself is pinned STRUCTURALLY: the native `$Symbol` carrier must
 * appear among `__to_primitive`'s §7.1.1-step-1 early-out `ref.test` operands,
 * i.e. BEFORE the `$Object` test that sends everything else to
 * `__class_to_primitive`.
 *
 * Name-free by construction: the carrier's type index is read back from
 * `__box_symbol`'s own `struct.new`, so this cannot drift with type numbering.
 * Measured 2026-09-12 — base tree `-20,61,62,6,70`; with the fix
 * `-20,61,62,6,70,73`, where 73 is `__box_symbol`'s `struct.new`.
 */
describe("#6432 __to_primitive's already-a-primitive cascade", () => {
  it("includes the native $Symbol carrier, ahead of the $Object test", { timeout: 600_000 }, async () => {
    const result = await compile(
      `function opaqueKey() { return Symbol.iterator; }
       export function f() { const o = {}; o[opaqueKey()] = 5; return o[opaqueKey()] === 5 ? 1 : 0; }`,
      { allowJs: true, skipSemanticDiagnostics: true, emitWat: true, fileName: "/m.js", ...STANDALONE } as never,
    );
    expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
    const lines = ((result as { wat?: string }).wat ?? "").replace(/\0/g, "").split("\n");
    const bodyOf = (name: string): string[] => {
      const start = lines.findIndex((line) => line.startsWith(`  (func $${name} `));
      expect(start, `${name} not emitted`).toBeGreaterThanOrEqual(0);
      const out: string[] = [];
      for (let i = start + 1; i < lines.length; i++) {
        if (lines[i]!.startsWith("  (func ")) break;
        out.push(lines[i]!.trim());
      }
      return out;
    };
    const carrier = bodyOf("__box_symbol")
      .map((line) => /^struct\.new (\d+)$/.exec(line)?.[1])
      .find((value) => value !== undefined);
    expect(carrier, "__box_symbol mints no struct").toBeDefined();
    const toPrimitive = bodyOf("__to_primitive");
    // The cascade ends at the `$Object` test — the first `ref.test` whose next
    // instruction is `i32.eqz` (the "not an object" branch).
    const cut = toPrimitive.findIndex((line, i) => line.startsWith("ref.test") && toPrimitive[i + 1] === "i32.eqz");
    expect(cut, "no $Object test in __to_primitive").toBeGreaterThan(0);
    const cascade = toPrimitive
      .slice(0, cut)
      .map((line) => /^ref\.test \(ref (-?\d+)\)$/.exec(line)?.[1])
      .filter((value): value is string => value !== undefined);
    expect(cascade, `cascade was ${cascade.join(",")}, carrier ${carrier}`).toContain(carrier);
  });
});
