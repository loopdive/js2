// #5241 — a compiled-class method reached through the host bridge on an
// `any`-typed receiver must CALL, not answer `undefined`.
//
// ROOT CAUSE (measured on this branch's base, PR #5347 / #5239):
//
//   The defect is a NAME collision, not an arity one. For a method call on an
//   `any`-typed receiver, `tryExternClassMethodOnAny` (calls-closures.ts) binds
//   the FIRST registered extern class declaring that method name — and it
//   returns BEFORE the compiled-class dispatcher in call-receiver-method.ts is
//   ever consulted. Its guard against hijacking a user method,
//   `sourceDefinesFunctionMember` (#3033), is scoped to ONE SOURCE FILE, so it
//   silently stops applying when the class and the call site live in different
//   modules — the ordinary provider/consumer shape.
//
//   So `class K { add(n) {…} }` in a provider, called as `inst.add(2)` from a
//   consumer, compiled to `env::Set_add(inst, 2)` (Set.prototype.add is the
//   first extern class declaring `add`) and answered `undefined`. And because
//   the extern arm short-circuits, the `__class_call_add_1` bridge export was
//   never even DEMANDED when that was the only `add` call site: a minimal probe
//   on base exported `__class_call_plusOne_1` for a sibling method of the SAME
//   arity on the SAME instance, and nothing at all for `add`.
//
// That is why the issue looked like "parametered methods don't dispatch":
// the members that failed (`add`, and the `get`/`set`/`has` collection family)
// all collide with a builtin, and every Temporal arithmetic member is in that
// set. The controls below pin the distinction — `subtract` and a 2-arg `two`
// answer correctly on base, `add` does not, on the identical instance.
//
// Base / after, single-module lane (probe run 2026-08-31):
//
//   staticAdd       "undefined"  → "A3"     ← Object.create(K.prototype)
//   dynamicAdd      "undefined"  → "A3"     ← Object.create(<value>.prototype)
//   newAdd          "A2" already            (typed receiver, never took the arm)
//   staticSubtract  "S-1" already           (no extern class declares it)
//   staticTwo       "T6" already            (2-arg control — NOT an arity bug)
//   staticHas       false        → "H3"    (Map/Set collision family)
//
// Linked lane, base: `add` answers correctly (the linker's consumer rewrite
// puts it on a different path) but `has` answers `false` — the `env::Set_has`
// binding. Both lanes answer the table above after the fix.
//
// A second, PRE-EXISTING defect surfaced while measuring this one and is fixed
// here because the fix above widens its reach: the class-method bridges boxed
// an `i32` result with `__box_number`, so a BOOLEAN-returning method answered
// `1`/`0` across the bridge (`String(inst.bigger(0))` → `"1"` on an `any`
// receiver, `"true"` on a typed one — measured on base, where `bigger` collides
// with nothing and so was never hijacked). Both bridges now honour the
// `boolean` marker the ValType already carries, which the closed dispatcher's
// ARGUMENT coercion honoured all along. Without it this PR would have turned
// `Temporal.PlainDate.from(…).equals(…)` from `true` into `1`.
//
// The `plainCollections` probe is the counter-control: a genuine Map/Set in the
// same program must keep working, since the fix DECLINES the extern binding for
// these names program-wide and lets the runtime-shape dispatch resolve them.

import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROVIDER_SOURCE = `
const slots = new WeakMap();
const registry = {};
function intrinsic(key) { return registry[key]; }

export class K {
  constructor() {}
  get v() { const s = slots.get(this); return s ? s.v : -1; }
  zero() { const s = slots.get(this); return "Z" + (s ? s.v : -1); }
  /** Collides with Set.prototype.add — the #5241 shape. */
  add(n) { const s = slots.get(this); return "A" + ((s ? s.v : 0) + n); }
  /** Collides with Map.prototype.get / .has / .set — the same family. */
  get_(n) { return n; }
  has(n) { const s = slots.get(this); return "H" + ((s ? s.v : 0) + n); }
  /** No extern class declares these: the control for "not an arity bug". */
  subtract(n) { const s = slots.get(this); return "S" + ((s ? s.v : 0) - n); }
  two(a, b) { const s = slots.get(this); return "T" + ((s ? s.v : 0) + a + b); }
  /** BOOLEAN returns: the bridge boxed these as numbers (see boolean probes). */
  equals(n) { const s = slots.get(this); return (s ? s.v : 0) === n; }
  bigger(n) { const s = slots.get(this); return (s ? s.v : 0) > n; }

  /** The hand-written spelling, lowered to \`struct.new\` before #5239. */
  static makeStatic(v) { const o = Object.create(K.prototype); slots.set(o, { v: v }); return o; }
  /** The minified-bundle spelling: the class arrives as a VALUE (#5239). */
  static makeDynamic(v) { const C = intrinsic("%K%"); const o = Object.create(C.prototype); slots.set(o, { v: v }); return o; }
}
registry["%K%"] = K;
`;

const CONSUMER_PROBES = `
export function staticZero() { return K.makeStatic(1).zero(); }
export function staticAdd() { return K.makeStatic(1).add(2); }
export function staticHas() { return K.makeStatic(1).has(2); }
export function staticSubtract() { return K.makeStatic(1).subtract(2); }
export function staticTwo() { return K.makeStatic(1).two(2, 3); }
export function dynamicZero() { return K.makeDynamic(1).zero(); }
export function dynamicAdd() { return K.makeDynamic(1).add(2); }
export function dynamicHas() { return K.makeDynamic(1).has(2); }
export function dynamicTwo() { return K.makeDynamic(1).two(2, 3); }
export function staticEquals() { return String(K.makeStatic(1).equals(1)); }
export function staticBigger() { return String(K.makeStatic(1).bigger(0)); }
export function typedEquals() { const o = new K(); return String(o.equals(0)); }
export function newAdd() { const o = new K(); return o.add(2); }
export function typeofAdd() { return typeof K.makeStatic(1).add; }
export function plainCollections() {
  const s = new Set();
  s.add(7);
  const m = new Map();
  m.set("k", 9);
  return String(s.has(7)) + "/" + String(m.get("k")) + "/" + String(s.size);
}
`;

const EXPECTED: Record<string, unknown> = {
  staticZero: "Z1",
  staticAdd: "A3",
  staticHas: "H3",
  staticSubtract: "S-1",
  staticTwo: "T6",
  dynamicZero: "Z1",
  dynamicAdd: "A3",
  dynamicHas: "H3",
  dynamicTwo: "T6",
  staticEquals: "true",
  staticBigger: "true",
  typedEquals: "true",
  newAdd: "A2",
  typeofAdd: "function",
  plainCollections: "true/9/1",
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

describe("#5241 — builtin-colliding class method names on an any-typed receiver", () => {
  it("the single-module lane calls the class method, not the extern builtin", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/provider.js": PROVIDER_SOURCE,
        [entry]: `import { K } from "./provider";\n${CONSUMER_PROBES}`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    // No package edge: the defect and the fix are module-linking-independent.
    expect(result.linkedModules ?? []).toHaveLength(0);

    // Consistency pin, not the base-failing assertion. Measured on the minimal
    // probe (one `add` call site, the any-receiver one) base exported
    // `__class_call_plusOne_1` for a same-arity sibling and NOTHING for `add`,
    // because the extern arm returned before the demand was registered. THIS
    // file also contains `newAdd()` (a typed `new K()` receiver), which demands
    // the export by itself — so on base the export is present and only the
    // VALUES below are wrong. Keep the pin: it fails loudly if the bridge
    // surface ever stops being emitted for a colliding name.
    //
    // Deliberately NOT asserted: absence of the `env.Set_add` import. The
    // `plainCollections` counter-control uses a genuine `new Set()`, so that
    // import is legitimately present in this very module — which is the point:
    // the fix declines the extern binding for the CLASS receiver while the real
    // Set keeps it.
    const mod = await WebAssembly.compile(result.binary as unknown as BufferSource);
    const exportNames = WebAssembly.Module.exports(mod).map((e) => e.name);
    expect(exportNames).toContain("__class_call_add_1");
    expect(exportNames).toContain("__class_call_subtract_1");

    const importObject = result.importObject as WebAssembly.Imports & {
      __setInstance?: (i: WebAssembly.Instance) => void;
    };
    const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, importObject);
    importObject.__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });

  it("a separately linked provider answers identically", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5241-"));
    const packageRoot = join(root, "node_modules", "pm5241");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "pm5241", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(entry, `import { K } from "pm5241";\n${CONSUMER_PROBES}`);

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    // Load-bearing: a `bundled` plan would silently re-test the control.
    expect({ mode: result.linkPlan?.mode, reason: result.linkPlan?.fallbackReason }).toEqual({
      mode: "separate",
      reason: undefined,
    });

    const { instance } = await instantiateLinkedProject(result);
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });
});
