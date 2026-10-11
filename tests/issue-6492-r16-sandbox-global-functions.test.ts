// #6492 round 16 — the `$262.createRealm()` cluster: the harness sandbox had
// no ES §19.2 global FUNCTIONS.
//
// `scripts/test262-fyi-runtime.js` builds the foreign realm's global object by
// COPYING builtins off the current global — `parseInt: globalThis.parseInt`
// among them. In the linked lane that prelude is compiled into the harness
// PROVIDER, and a compiled `globalThis.<name>` read resolves through the
// runner's `globalSandbox` bridge. `SANDBOX_GLOBAL_NAMES` listed only
// constructors and namespace objects, so the read answered `undefined` — with
// no throw anywhere along the chain — and
// `$262.createRealm().global.parseInt` was `undefined` instead of a function.
//
// That is the whole of the `*-realm` cluster's first failure: the chain was
// emitted correctly and every hop ran; the VALUE the sandbox handed back was
// missing. Instrumenting the `extern_get` boundary intent in the real runner
// printed it directly:
//
//   [DBG eget2] key=parseInt typeof=object isStruct=false has=false val=undefined
//
// (`has=false` — the property is absent from the sandbox, not shadowed.)
//
// These assertions guard the regression: drop a §19.2 function from the shared
// list and the realm shim silently reverts to handing out `undefined`.
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { SANDBOX_GLOBAL_NAMES, applySandboxGlobalFunctionAttributes } from "../scripts/test262-sandbox-globals.mjs";

/** ES2024 §19.2 — the global object's function-valued properties, plus the
 *  Annex B §B.2.1 pair the corpus exercises. */
const REQUIRED_GLOBAL_FUNCTIONS = [
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
];

// Mirror of buildOriginalHarnessSandbox / _buildFreshSandbox — the single
// behavior under test (same shape as tests/issue-3441.test.ts).
function buildSandbox(names: readonly string[]): Record<string, unknown> {
  const sandbox: Record<string, unknown> = Object.create(null);
  const context = createContext(sandbox);
  for (const name of names) {
    try {
      sandbox[name] = runInContext(name, context);
    } catch {
      /* engine lacks this global — tolerated */
    }
  }
  applySandboxGlobalFunctionAttributes(sandbox);
  sandbox.globalThis = sandbox;
  return sandbox;
}

describe("#6492 r16 — harness sandbox exposes the ES §19.2 global functions", () => {
  it("shared list includes every global function the realm shim copies", () => {
    for (const name of REQUIRED_GLOBAL_FUNCTIONS) {
      expect(SANDBOX_GLOBAL_NAMES, `missing sandbox global: ${name}`).toContain(name);
    }
  });

  it("a sandbox built from the list answers each of them with a callable", () => {
    const sandbox = buildSandbox(SANDBOX_GLOBAL_NAMES);
    for (const name of REQUIRED_GLOBAL_FUNCTIONS) {
      expect(typeof sandbox[name], `sandbox.${name}`).toBe("function");
    }
    // The exact read `language/expressions/new/non-ctor-err-realm.js` depends
    // on, through the realm shim: a foreign-realm `parseInt` that is callable
    // and NOT a constructor.
    const parseIntFn = sandbox.parseInt as (s: string) => number;
    expect(parseIntFn("42")).toBe(42);
  });

  it("defines them with §19.2's attributes — writable, NOT enumerable, configurable", () => {
    // The plain `sandbox[name] = …` copy creates an ENUMERABLE property, and
    // `S15.1.2.2_A9.5` / `S15.1.3.x_A5.5` assert the opposite. Measured: six
    // rows flipped pass→fail in BOTH lanes on the enumerable spelling — and
    // they had been passing only because the property was absent entirely, so
    // adding the names without the attributes is a net-negative trade.
    const sandbox = buildSandbox(SANDBOX_GLOBAL_NAMES);
    for (const name of REQUIRED_GLOBAL_FUNCTIONS) {
      const desc = Object.getOwnPropertyDescriptor(sandbox, name);
      expect(desc, `descriptor for ${name}`).toBeDefined();
      expect(desc, `attributes for ${name}`).toMatchObject({
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    expect(Object.keys(sandbox)).not.toContain("parseInt");
  });

  it("every builtin the realm shim copies off globalThis is on the list", () => {
    // Ties the list to its consumer: the shim's `realmGlobal` literal is the
    // thing whose reads must not silently answer undefined. `Object` is
    // deliberately NOT forwarded by the shim (see its comment), so this scans
    // what the shim actually reads rather than a hand-kept twin.
    const shim = readFileSync(new URL("../scripts/test262-fyi-runtime.js", import.meta.url), "utf8");
    const read = new Set<string>();
    for (const match of shim.matchAll(/globalThis\.([A-Za-z_$][\w$]*)/g)) read.add(match[1]!);
    expect(read.size).toBeGreaterThan(0);
    // KNOWN, DELIBERATE GAP: `Iterator`. Adding it to the sandbox changes what
    // the harness's own `%Iterator%` binding stratum (#6492 round 4/4b) sees,
    // so it is its own measured change, not a free rider on this one.
    // `eval` is not on the NAME list by design — both sandbox builders install
    // it separately via `Object.defineProperties` (it must be the contextified
    // realm's own `eval`), so its absence here is not a gap.
    const KNOWN_GAPS = new Set(["Iterator", "eval"]);
    const missing = [...read].filter((name) => !SANDBOX_GLOBAL_NAMES.includes(name) && !KNOWN_GAPS.has(name));
    expect(missing, `realm shim reads globals absent from the sandbox: ${missing.join(", ")}`).toEqual([]);
  });
});
