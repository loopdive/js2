// #6426 — an object-REST source loses every value across a separately-linked
// package boundary.
//
// MECHANISM. The host helper `__extern_rest_object` (and its `Object.values` /
// `Object.entries` / tuple-slice siblings) read a WasmGC struct in two steps:
// `_getStructFieldNames` for the key list, then `exports["__sget_<key>"]` for
// each value. Since #5225 the NAME step routes through `_decoderExportsFor`, so
// it answers with the struct OWNER's decoder — but the VALUE step still used
// the READER's own exports. When a consumer mints the options bag and a linked
// provider does `const { strict, ...rest } = options`, the provider's
// same-named `__sget_` getter `ref.test`-misses the consumer's struct type and
// returns its miss default instead of trapping: every key survives, every value
// comes back `null` (references) or `0` (numbers). `typeof null === "object"`
// is why a copied FUNCTION looked like a different defect from a copied object;
// it is one lost value in both rows.
//
// The fix is `_decoderExportsFor` on the value read too, at the four sites with
// this exact names-then-values shape.
//
// Counts, measured 2026-09-13 at one HEAD, 12 rows x 3 lanes:
//   parent  single 0 wrong / multi 0 / linked 6 = 6
//   fix     single 0 wrong / multi 0 / linked 0 = 0
// The 6 are restObj / restFn / restNum / restKeys / restValues / restEntries.
// Everything else is an anti-vacuity control that already passed on the parent:
// a direct `Object.assign(this, options)`, a `{ ...options }` spread source, a
// plain `this.x = options.x`, `Object.keys` (names-only, never broken) and the
// two single-unit lanes of every row.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

/**
 * The provider half — deliberately untyped `.js` and CLASSES ONLY. A provider
 * that exports untyped *functions* makes the linker fall back to a `bundled`
 * plan (inferred/`any` package signatures), which would silently run the
 * single-unit lane a third time; the `linkPlan.mode === "separate"` assertion
 * below is the guard, and class exports are what keeps it true.
 */
const LIB_SOURCE = `
export class R {
  constructor() { this.name = "R"; }
}
/** THE BUG: the option bag reaches the ctor through an object-rest binding. */
export class RestSrc {
  router;
  getPath;
  n;
  constructor(options = {}) {
    const { strict, ...rest } = options;
    Object.assign(this, rest);
  }
}
/** Same rest binding, read directly instead of copied — key vs value split. */
export class RestProbe {
  keys;
  val;
  constructor(options = {}) {
    const { strict, ...rest } = options;
    this.keys = Object.keys(rest).join("|");
    this.val = rest.router ? "has" : "no";
  }
}
/** CONTROL: no rest binding, the bag is assigned as it arrived. */
export class DirectSrc {
  router;
  constructor(options = {}) { Object.assign(this, options); }
}
/** CONTROL: a spread copy as the assign source. */
export class SpreadSrc {
  router;
  constructor(options = {}) { Object.assign(this, { ...options }); }
}
/** CONTROL: a plain field store off the bag. */
export class FieldSrc {
  router;
  constructor(options = {}) { this.router = options.router; }
}
/** Object.values of a consumer-minted struct, read inside the provider. */
export class ValuesProbe {
  types;
  constructor(options = {}) { this.types = Object.values(options).map((v) => typeof v).join(","); }
}
/** Object.entries of a consumer-minted struct, read inside the provider. */
export class EntriesProbe {
  pairs;
  constructor(options = {}) { this.pairs = Object.entries(options).map(([k, v]) => k + ":" + typeof v).join(","); }
}
/** Object.keys — names only, correct before the fix; pins that half in place. */
export class KeysProbe {
  keys;
  constructor(options = {}) { this.keys = Object.keys(options).join(","); }
}
`;

const PROBES = `
const nm = (v) => (v === null || v === undefined ? String(v) : String(v.name));

// --- THE BUG -------------------------------------------------------------
export function restObj() { return nm(new RestSrc({ router: new R() }).router); }
export function restFn() { return typeof new RestSrc({ getPath: (x) => x }).getPath; }
export function restNum() { return String(new RestSrc({ n: 7 }).n); }
export function restKeys() { const p = new RestProbe({ router: new R() }); return p.keys + "|" + p.val; }
export function restValues() { return new ValuesProbe({ a: 1, b: "s" }).types; }
export function restEntries() { return new EntriesProbe({ a: 1, b: "s" }).pairs; }

// --- CONTROLS (already correct on the parent) -----------------------------
export function directObj() { return nm(new DirectSrc({ router: new R() }).router); }
export function spreadObj() { return nm(new SpreadSrc({ router: new R() }).router); }
export function fieldObj() { return nm(new FieldSrc({ router: new R() }).router); }
export function keysOnly() { return new KeysProbe({ a: 1, b: "s" }).keys; }
export function restExcludes() { const p = new RestProbe({ strict: 1, router: new R() }); return p.keys; }
export function restEmpty() { return new RestProbe({}).keys + "|" + new RestProbe({}).val; }
`;

/** Node's answers. Shared by all three lanes — that is the point. */
const EXPECTED: Record<string, unknown> = {
  restObj: "R",
  restFn: "function",
  restNum: "7",
  restKeys: "router|has",
  restValues: "number,string",
  restEntries: "a:number,b:string",
  directObj: "R",
  spreadObj: "R",
  fieldObj: "R",
  keysOnly: "a,b",
  restExcludes: "router",
  restEmpty: "|no",
};

/** The rows that are wrong on the parent, in the linked lane only. */
const REGRESSED_ROWS = ["restObj", "restFn", "restNum", "restKeys", "restValues", "restEntries"];

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

async function instantiateSingle(result: unknown): Promise<Record<string, unknown>> {
  const r = result as {
    binary: BufferSource;
    importObject: WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
  };
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  r.importObject.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Record<string, unknown>;
}

describe("#6426 — an object-rest source keeps its values across a package boundary", () => {
  it("single module", { timeout: 300_000 }, async () => {
    const result = await compile(`${LIB_SOURCE}\n${PROBES}`, {
      allowJs: true,
      skipSemanticDiagnostics: true,
    } as never);
    const observed = readAll(await instantiateSingle(result));
    expect(observed).toEqual(EXPECTED);
  });

  it("two untyped .js modules in one compilation unit", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/lib.js": LIB_SOURCE,
        [entry]: `import { R, RestSrc, RestProbe, DirectSrc, SpreadSrc, FieldSrc, ValuesProbe, EntriesProbe, KeysProbe } from "./lib";\n${PROBES}`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    expect(result.linkedModules ?? []).toHaveLength(0);
    expect(readAll(await instantiateSingle(result))).toEqual(EXPECTED);
  });

  it("library in a separately linked package", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-6426-"));
    const packageRoot = join(root, "node_modules", "bag6426");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "bag6426", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), LIB_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(
      entry,
      `import { R, RestSrc, RestProbe, DirectSrc, SpreadSrc, FieldSrc, ValuesProbe, EntriesProbe, KeysProbe } from "bag6426";\n${PROBES}`,
    );

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    // Load-bearing: a `bundled` plan would inline the package and silently
    // test the single-module lane a third time.
    expect(result.linkPlan?.mode).toBe("separate");

    const { instance } = await instantiateLinkedProject(result);
    const observed = readAll(instance.exports as unknown as Record<string, unknown>);
    // Anti-vacuity: the six rows the fix is about must actually be exercised
    // in THIS lane, not silently absent from the linked module's exports.
    for (const row of REGRESSED_ROWS) expect(Object.keys(observed)).toContain(row);
    expect(observed).toEqual(EXPECTED);
  });
});
