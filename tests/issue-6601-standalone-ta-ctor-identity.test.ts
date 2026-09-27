// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6601 (#5383 S14) — the `%TypedArray%.of/from` and dynamic-`new` arms must use
// the BRAND-CHECKED `$__ta_ctor` identity test, not a bare `ref.test`.
//
// WHY THIS REDUCTION EXISTS. `$__ta_ctor` is two immutable i32 fields, which is
// exactly the shape #2158/#2009 gives a field-less class ROOT. WasmGC
// canonicalizes structurally-identical struct types, so in a module that holds a
// TypedArray constructor VALUE and links a standalone provider, every provider
// CLASS OBJECT passes a bare `ref.test $__ta_ctor` — and the `of`/`from` arm
// then builds a typed array out of it.
//
// Measured against the real linked `@js-temporal/polyfill` provider on
// 2026-09-13: with ONE `function mk(K) { return new K(); }` in the consumer —
// never called — `Temporal.PlainDate.from("2020-12-24").day` answered
// `undefined` instead of `24`, `Object.getOwnPropertyNames` of the result was
// `["length"]`, `Object.prototype.toString` said `[object Array]`, and
// `new Temporal.PlainDate(1976,11,18).length` read back `1976` — the first
// constructor argument, out of a struct the consumer had no right to decode.
// `test262/harness/temporalHelpers.js` contains that spelling
// (`new construct(...constructArgs)` in `checkSubclassConstructorNotObject`),
// so every Temporal test that `includes:` it inherited the failure: 71 of the
// 169 failing rows in #5383's three-family sample.
//
// `taCtorIdentityTestInstrs` (#5383 S2f R11) already existed for this exact
// collision; the two arms below simply did not use it. It adds the `brand`
// FIELD-VALUE check, so it can only ever REMOVE a false positive.
//
// WHICH ARM HAS TEETH. The first `describe` FAILS on the base tree (`day`
// answered `undefined`, own-property names answered `["length"]`). The second is
// the control: the same read in a consumer with NO TypedArray constructor value
// passes on both trees, which is what pins the cause to the `$__ta_ctor` test
// rather than to the link.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/**
 * A FIELD-LESS class whose per-instance state lives in a WeakMap — the polyfill
 * shape, and the shape whose class OBJECT collides with `$__ta_ctor`. The static
 * `from` / `of` names are the two the TypedArray arm claims.
 */
const PROVIDER = `
const slots = new WeakMap();
export class Box {
  constructor() {}
  get day() { const s = slots.get(this); return s ? s.day : -1; }
  static from(v) { const o = new Box(); slots.set(o, { day: v }); return o; }
  static of(v) { const o = new Box(); slots.set(o, { day: v + 100 }); return o; }
}
export const NS = { Box };
`;

/** Reading `Int8Array` as a VALUE is what registers `$__ta_ctor` in the consumer. */
const TA_CTOR_VALUE = `function seed(n) { const T = Int8Array; return T.of(1, 2, 3).length + n; }`;

type Artifact = {
  namespace: string;
  exportBoundaries: Record<string, { field: string }>;
};

async function buildProvider(): Promise<Artifact> {
  const root = mkdtempSync(join(tmpdir(), "issue-6601-"));
  const packageRoot = join(root, "node_modules", "ns6474");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6474", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), PROVIDER);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6474";\nexport function __probe() { return typeof NS; }\n`);
  const built = (await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never)) as unknown as { success: boolean; errors?: { message: string }[]; linkedModules?: Artifact[] };
  expect(built.success, (built.errors ?? []).map((e) => e.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find(
    (item) => (item as unknown as { packageName?: string }).packageName === "ns6474",
  );
  expect(artifact).toBeDefined();
  return artifact as Artifact;
}

/** Compile ONE consumer module against the linked provider and run `probe()`. */
async function runLinked(artifact: Artifact, body: string): Promise<string> {
  const field = artifact.exportBoundaries.NS!.field;
  const entry = "/__main.js";
  const source = `import { ${field} } from "/__ns_stub";
const NS = ${field}();
let __s = "";
export function prepare() { try { __s = "" + (() => { ${body} })(); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }
export function at(i) { return __s.charCodeAt(i); }`;
  const result = (await compileMulti(
    { "/__ns_stub.ts": `export declare function ${field}(): any;\n`, [entry]: source },
    entry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
      ...STANDALONE,
    } as never,
  )) as unknown as { success: boolean; errors?: { message: string }[]; linkedModules?: Artifact[] };
  result.linkedModules = [artifact];
  expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result as never, {});
  const exports = instance.exports as unknown as { prepare(): number; at(i: number): number };
  const len = exports.prepare();
  let out = "";
  for (let i = 0; i < Math.min(len, 400); i++) out += String.fromCharCode(exports.at(i));
  return out;
}

describe("#6601 provider class objects are not TypedArray constructors", () => {
  it(
    "keeps `<providerClass>.from(…)` / `.of(…)` on the provider when the consumer holds a TA ctor value",
    { timeout: 600_000 },
    async () => {
      const artifact = await buildProvider();
      const observed: Record<string, string> = {
        from: await runLinked(artifact, `${TA_CTOR_VALUE} return String(NS.Box.from(18).day);`),
        of: await runLinked(artifact, `${TA_CTOR_VALUE} return String(NS.Box.of(18).day);`),
        ownKeys: await runLinked(
          artifact,
          `${TA_CTOR_VALUE} return Object.getOwnPropertyNames(NS.Box.from(18)).join(",");`,
        ),
        // the TypedArray arm this guard protects must still work
        taStillWorks: await runLinked(artifact, `${TA_CTOR_VALUE} return String(seed(0));`),
      };
      expect(observed).toEqual({ from: "18", of: "118", ownKeys: "", taStillWorks: "3" });
    },
  );

  it(
    "answers the same in a consumer with no TypedArray constructor value (the control)",
    { timeout: 600_000 },
    async () => {
      const artifact = await buildProvider();
      expect(await runLinked(artifact, `return String(NS.Box.from(18).day);`)).toBe("18");
    },
  );
});
