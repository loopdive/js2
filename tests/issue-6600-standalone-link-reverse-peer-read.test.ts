// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6600 (#5383 S17) — a CONSUMER-owned property bag read by PROVIDER code.
//
// WHY THIS REDUCTION EXISTS. The #5383 S2d link boundary is consumer→provider
// only: the provider exports its generic terminals and the consumer calls them
// on a miss. The Temporal polyfill uses the OTHER direction for every property
// bag — `PrepareCalendarFields` does `bag[name]` over a sorted key array, on a
// bag the consumer built — and there the provider's own `ref.test` ladder misses
// on every arm, because an object literal and a class instance are CLOSED
// structs the CONSUMER declared. Measured on the base tree: `o[k]` answered
// `undefined`, `Object.keys(o)` answered `[]`, and
// `const a = { year: 1976, … }; Temporal.PlainDate.from(a).day` answered
// nothing while the INLINE literal form answered 18.
//
// WHICH ARM HAS TEETH. Every `it` below is host-free (`hostBridge: "off"`, EMPTY
// import object) and every one of them FAILS on the base tree — the reads
// answer `undefined` / zero keys there. The `Object.create(null)` case is the
// CONTROL: that carrier is a canonical `$Object`, so it crossed correctly before
// this slice and must keep doing so.
//
// Every probe answers a NUMBER: a standalone module's string is a WasmGC array
// the host cannot decode, so the comparisons happen INSIDE the module.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/** The provider half — it reads a bag it did not build, exactly as the polyfill does. */
const PROVIDER = `
  export const NS = Object.freeze({
    __proto__: null,
    get(o, k) { return o[k]; },
    getDot(o) { return o.year; },
    keyCount(o) { return Object.keys(o).length; },
    forInCount(o) { var n = 0; for (var k in o) { n++; } return n; },
    hasKey(o, k) { return k in o ? 1 : 0; },
    // 1 = null, 2 = undefined, 3 = something else. A bag field whose value IS
    // null must not read as an absent key.
    kindOf(o, k) { var v = o[k]; return v === null ? 1 : (v === undefined ? 2 : 3); },
    // The polyfill's own shape: a sorted key array, a computed read per key.
    sumFields(o) {
      var names = ["day", "year"];
      names.sort();
      var total = 0;
      for (var i = 0; i < names.length; i++) {
        var v = o[names[i]];
        if (v !== undefined) total += v;
      }
      return total;
    },
  });`;

async function linkedPair(provider: string, consumer: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6600-"));
  const packageRoot = join(root, "node_modules", "ns6478");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6478", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6478";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6478")!;
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

const CONSUMER = `
  // -1 = threw. Every other answer is the value the provider read back.
  export function litComputed() {
    try { const b = { year: 1976, day: 18 }; return NS.get(b, "year"); } catch (e) { return -1; }
  }
  export function litDot() {
    try { const b = { year: 1976, day: 18 }; return NS.getDot(b); } catch (e) { return -1; }
  }
  export function litVarKey() {
    try { const b = { year: 1976, day: 18 }; const k = "year"; return NS.get(b, k); } catch (e) { return -1; }
  }
  export function classInstance() {
    try {
      class B { constructor() { this.year = 1976; this.day = 18; } }
      return NS.get(new B(), "year");
    } catch (e) { return -1; }
  }
  export function litKeyCount() {
    try { const b = { year: 1976, day: 18, monthCode: 11 }; return NS.keyCount(b); } catch (e) { return -1; }
  }
  export function sortedKeyLoop() {
    try { const b = { year: 1976, day: 18 }; return NS.sumFields(b); } catch (e) { return -1; }
  }
  export function litForIn() {
    try { const b = { year: 1976, day: 18 }; return NS.forInCount(b); } catch (e) { return -1; }
  }
  export function litHas() {
    try { const b = { year: 1976 }; return NS.hasKey(b, "year"); } catch (e) { return -1; }
  }
  export function litHasAbsent() {
    try { const b = { year: 1976 }; return NS.hasKey(b, "nope"); } catch (e) { return -1; }
  }
  // A present key whose VALUE is null, an ABSENT key, and a key whose value is
  // "undefined" must be three distinguishable answers inside the provider. They
  // were not: the null read as absent, which made the polyfill's
  // \"!== undefined\" guard admit it.
  export function nullValued() {
    try { const b = { year: 1976, calendar: null }; return NS.kindOf(b, "calendar"); } catch (e) { return -1; }
  }
  export function absentKey() {
    try { const b = { year: 1976 }; return NS.kindOf(b, "calendar"); } catch (e) { return -1; }
  }
  export function undefinedValued() {
    try { const b = { year: 1976, calendar: undefined }; return NS.kindOf(b, "calendar"); } catch (e) { return -1; }
  }
  // CONTROL: a null-prototype bag is a canonical $Object and already crossed.
  export function nullProtoBag() {
    try { const b = Object.create(null); b.year = 1976; return NS.get(b, "year"); } catch (e) { return -1; }
  }
  // CONTROL: the provider reading a bag it built itself must not change.
  export function providerOwnBag() {
    try { return NS.get({ year: 1976 }, "year"); } catch (e) { return -1; }
  }
`;

describe("#6600 a consumer-owned carrier read inside a linked standalone provider", () => {
  it(
    "answers the consumer's own fields for a literal bag, a class instance and Object.keys",
    { timeout: 600_000 },
    async () => {
      const ex = await linkedPair(PROVIDER, CONSUMER);
      // Teeth: every one of these answered `undefined` (or 0 keys) on the base tree.
      expect(ex.litComputed()).toBe(1976);
      expect(ex.litDot()).toBe(1976);
      expect(ex.litVarKey()).toBe(1976);
      expect(ex.classInstance()).toBe(1976);
      expect(ex.litKeyCount()).toBe(3);
      // The polyfill's own read shape, over a sorted key array.
      expect(ex.sortedKeyLoop()).toBe(1976 + 18);
      // Enumeration and presence, which answered 0 / false on the base tree.
      expect(ex.litForIn()).toBe(2);
      expect(ex.litHas()).toBe(1);
      expect(ex.litHasAbsent()).toBe(0);
      // null · absent · undefined must stay three distinguishable answers.
      expect(ex.nullValued()).toBe(1);
      expect(ex.absentKey()).toBe(2);
      expect(ex.undefinedValued()).toBe(2);
      // Controls: unchanged by this slice, and measured as such.
      expect(ex.nullProtoBag()).toBe(1976);
      expect(ex.providerOwnBag()).toBe(1976);
    },
  );
});
