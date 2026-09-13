// #5366 — `this.field = options.value ?? new Default()` must keep the
// caller-supplied value.
//
// MECHANISM. `compileNullishCoalescing` joined the two arms by taking the RIGHT
// arm's wasm type outright (`unifiedType = rType`). The left arm was then run
// through `coerceType(lhs → rhs)`, and an unproven reference narrowing there is
// lowered as a GUARDED downcast — `ref.test $Default`, else `ref.null`. So a
// left value of some OTHER class did not trap: it silently became `null`.
//
// hono is the canonical shape:
//   this.router = options.router ?? new SmartRouter({ routers: [...] })
// `new Hono()` (the default arm, an actual SmartRouter) worked, and
// `new Hono({ router: new RegExpRouter() })` read back `app.router === null`.
// `&&`/`||` have always joined a non-numeric mismatch at externref, and the
// conditional operator joins two internal refs at their nearest declared common
// ancestor; `??` was the outlier. `nullish-join-carrier.ts` gives it the same
// discipline.
//
// Counts, measured on this branch 2026-09-12, 19 rows x 3 lanes:
//   parent  single 4 wrong / multi 4 / linked 5 = 13
//   fix     single 0 wrong / multi 0 / linked 2 = 2
// Parent's wrong rows are optionRouter "null", optionRouterIdentity
// "different", optionRouterThroughField "null" in every lane, plus
// nullishShortCircuits "THREW: dereferencing a null pointer" in the two
// single-unit lanes. The 2 that remain are the linked lane's baseObjectAssign /
// otherOptionKey, wrong identically on BOTH sides and pinned in
// LINKED_RESIDUALS below. Every other row is an anti-vacuity control that
// already passed on the parent: the default arm, a same-class option, a
// post-construction store, and the primitive-default `??` shapes.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

/**
 * The library half — deliberately untyped `.js`: a base class that declares an
 * uninitialised field and copies constructor options onto `this`, and a derived
 * class that re-assigns that field from `options.x ?? new Default()`.
 */
const LIB_SOURCE = `
export class RegExpRouter {
  constructor() { this.name = "RegExpRouter"; this.patterns = []; }
  add(m, p) { this.patterns.push(m + " " + p); return this.patterns.length; }
}
export class SmartRouter {
  constructor(init) {
    this.name = "SmartRouter";
    this.routers = (init && init.routers) || [];
    this.activeRouter = null;
  }
  add(m, p) { return this.routers.length; }
  pick() { return this.routers.length; }
}
export class Base {
  router;
  getPath;
  constructor(options = {}) {
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
  }
}
export class App extends Base {
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({ routers: [new RegExpRouter()] });
  }
}
`;

const PROBES = `
const nameOf = (v) => (v === null || v === undefined ? String(v) : String(v.name));

// --- THE BUG -------------------------------------------------------------
// A class the default arm knows nothing about, handed in through the options
// object. On the parent this read back "null".
export function optionRouter() { return nameOf(new App({ router: new RegExpRouter() }).router); }
// The very same object must come back, not a copy or a null.
export function optionRouterIdentity() {
  const r = new RegExpRouter();
  return new App({ router: r }).router === r ? "same" : "different";
}
// The stored value must still be usable as the object it is.
export function optionRouterThroughField() {
  const app = new App({ router: new RegExpRouter() });
  if (app.router === null || app.router === undefined) return "null";
  app.router.add("GET", "/x");
  return app.router.name + ":" + app.router.patterns.length;
}

// --- ANTI-VACUITY CONTROLS (all correct on the parent) --------------------
// The default arm: the right operand's own type, so no downcast was involved.
export function defaultRouter() { return nameOf(new App().router); }
export function defaultRouterUsable() { const a = new App(); return a.router.name + ":" + a.router.pick(); }
// An option whose class IS the default arm's class: the guarded cast succeeded.
export function sameClassOption() {
  return nameOf(new App({ router: new SmartRouter({ routers: [] }) }).router);
}
// No \`??\` in sight — the base class's own copy of the same value.
export function baseObjectAssign() { return nameOf(new Base({ router: new RegExpRouter() }).router); }
// A plain store after construction, also without \`??\`.
export function postConstructionStore() {
  const app = new App();
  app.router = new RegExpRouter();
  return nameOf(app.router);
}
// Another option key flows through the same \`Object.assign\`.
export function otherOptionKey() { return typeof new App({ getPath: (r) => "/p" }).getPath; }

// --- \`??\` SHAPES THAT MUST NOT MOVE --------------------------------------
export function nullishNumberDefault() { const o = {}; return (o.n ?? 5) + 1; }
export function nullishNumberPresent() { const o = { n: 2 }; return (o.n ?? 5) + 1; }
export function nullishStringDefault() { const o = {}; return (o.s ?? "fallback") + "!"; }
export function nullishStringPresent() { const o = { s: "given" }; return (o.s ?? "fallback") + "!"; }
export function nullishZeroIsKept() { const o = { n: 0 }; return o.n ?? 7; }
export function nullishEmptyStringIsKept() { const o = { s: "" }; return (o.s ?? "x") + "|"; }
export function nullishArrayDefault() { const o = {}; return (o.list ?? [1, 2, 3]).length; }
export function nullishArrayPresent() { const o = { list: [1] }; return (o.list ?? [1, 2, 3]).length; }
export function nullishObjectDefault() { return nameOf(undefined ?? new SmartRouter({ routers: [] })); }
// The right operand is evaluated ONLY when the left is nullish.
export function nullishShortCircuits() {
  let n = 0;
  const bump = () => { n++; return new SmartRouter({ routers: [] }); };
  const o = { router: new RegExpRouter() };
  const picked = o.router ?? bump();
  return nameOf(picked) + ":" + n;
}
`;

const EXPECTED: Record<string, unknown> = {
  // the bug
  optionRouter: "RegExpRouter",
  optionRouterIdentity: "same",
  optionRouterThroughField: "RegExpRouter:1",
  // controls
  defaultRouter: "SmartRouter",
  defaultRouterUsable: "SmartRouter:1",
  sameClassOption: "SmartRouter",
  baseObjectAssign: "RegExpRouter",
  postConstructionStore: "RegExpRouter",
  otherOptionKey: "function",
  // `??` shapes
  nullishNumberDefault: 6,
  nullishNumberPresent: 3,
  nullishStringDefault: "fallback!",
  nullishStringPresent: "given!",
  nullishZeroIsKept: 0,
  nullishEmptyStringIsKept: "|",
  nullishArrayDefault: 3,
  nullishArrayPresent: 1,
  nullishObjectDefault: "SmartRouter",
  nullishShortCircuits: "RegExpRouter:0",
};

/** The rows that were wrong on the parent — named so the test says so. */
const REGRESSED_ROWS = [
  "optionRouter",
  "optionRouterIdentity",
  "optionRouterThroughField",
  "nullishShortCircuits",
] as const;

/**
 * Two rows that are wrong in the separately-linked lane on BOTH sides of this
 * fix, asserted at the value the compiler actually produces (measured
 * 2026-09-12, parent and fix identical). Neither contains a `??`:
 * `baseObjectAssign` is `Object.assign(this, {...rest})` in the base class, and
 * `otherOptionKey` reads a FUNCTION copied by that same `Object.assign` and
 * gets `"object"`. So the option-bag copy loses the value's identity across a
 * separately-linked package boundary — a different defect, tracked as #6426.
 * Asserting them here makes that claim testable: if #6426 lands, this override
 * fails and is deleted; if this fix ever starts moving them, it fails first.
 */
const LINKED_RESIDUALS: Record<string, unknown> = {
  baseObjectAssign: "null", // node: "RegExpRouter"
  otherOptionKey: "object", // node: "function"
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

describe("#5366 — `??` joins on a carrier that holds both arms", () => {
  it("single module", { timeout: 300_000 }, async () => {
    const result = await compile(`${LIB_SOURCE}\n${PROBES}`, {
      allowJs: true,
      skipSemanticDiagnostics: true,
    } as never);
    const observed = readAll(await instantiateSingle(result));
    expect(observed).toEqual(EXPECTED);
    // Anti-vacuity: the three rows the fix is about must be exercised, not
    // silently absent from the module's exports.
    for (const row of REGRESSED_ROWS) expect(Object.keys(observed)).toContain(row);
  });

  it("two untyped .js modules in one compilation unit", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/lib.js": LIB_SOURCE,
        [entry]: `import { RegExpRouter, SmartRouter, Base, App } from "./lib";\n${PROBES}`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    expect(result.linkedModules ?? []).toHaveLength(0);
    expect(readAll(await instantiateSingle(result))).toEqual(EXPECTED);
  });

  it("library in a separately linked package", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5366-"));
    const packageRoot = join(root, "node_modules", "router5366");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "router5366", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), LIB_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(entry, `import { RegExpRouter, SmartRouter, Base, App } from "router5366";\n${PROBES}`);

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    expect(result.linkPlan?.mode).toBe("separate");

    const { instance } = await instantiateLinkedProject(result);
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual({
      ...EXPECTED,
      ...LINKED_RESIDUALS,
    });
  });
});
