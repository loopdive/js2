// #5376 — an ACCESSOR-backed coercion method (`get valueOf()`) must survive
// being stored in, and read back out of, an object field.
//
// NOT a ToPrimitive defect, despite how it presents. `compileObjectLiteralWithAccessors`
// (#1239) builds every accessor-bearing literal as a HOST externref so V8 sees real
// accessor descriptors, but TypeScript types the ENCLOSING property from the getter's
// RETURN type — so the anon-struct field for `v` in `{ v: { get valueOf() {…} } }` was
// typed `(ref null $__anon_N)`. The guarded store emits `any.convert_extern` +
// `ref.test $__anon_N`, which a host object always fails, and the `else` arm writes
// `ref.null`. `o.v` read back NULL, `Number(null)` is 0, and the getter never ran —
// so the failure was a silent `0`, not a throw, and the observer's `calls` array was
// EMPTY. Fixed by widening that field to externref (`ensureStructForType`), which is
// exactly what #1589A already does for an EMPTY object literal in the same loop.
//
// This is the shape `TemporalHelpers.toPrimitiveObserver` mints, handed to a Temporal
// entry point as a property of an options bag — hence the 3
// `intl402/Temporal/**/infinity-throws-rangeerror.js` rows and the observer family.
//
// The rows below are the issue's a–g table. On base, `fieldRead*` / `observer*`
// answer 0 / empty calls; every other row already passed and is here as a control
// that the fix did not disturb the struct or direct-coercion paths.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

/** Provider side of the linked lane: every export coerces a value the CONSUMER minted. */
const PROVIDER_SOURCE = `
export function num(o) { return Number(o.v); }
export function str(o) { return String(o.v); }
`;

/**
 * The issue's rows a–g, plus `get toString()` and `get [Symbol.toPrimitive]()`.
 * Written against a `num`/`str` pair so the identical text compiles in the
 * single-module lane and against a separately-linked provider.
 */
const PROBES = `
// row a — accessor read directly off its own literal
export function rowA() { const o = { get v() { return 3 } }; return o.v; }
// row b — DIRECT coercion of an accessor-backed object (control: passed on base)
export function rowB() { return Number({ get valueOf() { return () => 3 } }); }
// row d — same, with the call-order observer (control: passed on base)
export function rowD() {
  const calls = [];
  const n = Number({ get valueOf() { calls.push("g"); return () => { calls.push("c"); return 3 } } });
  return n + ":" + calls.join(",");
}
// row f — THE BUG: accessor-backed valueOf read out of a field
export function fieldReadValueOf() {
  return num({ v: { get valueOf() { return () => 3 } } });
}
// row e — THE BUG, with the observer: base answered "0:" (calls EMPTY)
export function observerCallOrder() {
  const calls = [];
  const n = num({ v: { get valueOf() { calls.push("g"); return () => { calls.push("c"); return 3 } } } });
  return n + ":" + calls.join(",");
}
// row g — method shorthand through the same field read (control: passed on base)
export function rowG() { return num({ v: { valueOf() { return 3 } } }); }
// accessor-backed toString through a field read, string hint
export function fieldReadToString() {
  return str({ v: { get toString() { return () => "seven" } } });
}
export function observerToStringOrder() {
  const calls = [];
  const s = str({ v: { get toString() { calls.push("g"); return () => { calls.push("c"); return "x" } } } });
  return s + ":" + calls.join(",");
}
// accessor-backed @@toPrimitive through a field read. The extra \`tag\` field is
// load-bearing: a literal whose ONLY member is a computed key is unnameable by
// \`__struct_field_names\` (recorded on #5374), which is a different gap.
export function fieldReadToPrimitive() {
  return num({ v: { tag: 1, get [Symbol.toPrimitive]() { return (hint) => (hint === "string" ? 99 : 7) } } });
}
// A getter that THROWS must propagate, not be swallowed.
export function throwingGetter() {
  try {
    num({ v: { get valueOf() { throw new RangeError("boom") } } });
    return "no-throw";
  } catch (e) {
    return (e instanceof RangeError ? "RangeError" : "other") + ":" + e.message;
  }
}
// --- DIRECT-COERCION TWINS of the three residual rows below. These never go
// through a field read at all, so they are unaffected by this fix; they are here
// to prove the residuals belong to the accessor-backed WALKER, not to #5376.
export function directToPrimitive() {
  return Number({ tag: 1, get [Symbol.toPrimitive]() { return (hint) => (hint === "string" ? 99 : 7) } });
}
export function directThrowingGetter() {
  try {
    Number({ get valueOf() { throw new RangeError("boom") } });
    return "no-throw";
  } catch (e) {
    return (e instanceof RangeError ? "RangeError" : "other") + ":" + e.message;
  }
}
export function directToStringOrder() {
  const calls = [];
  const s = String({ get toString() { calls.push("g"); return () => { calls.push("c"); return "x" } } });
  return s + ":" + calls.join(",");
}
// Method-shorthand twins: these DO answer correctly, which is what makes the
// three residuals specifically an ACCESSOR-backed walker gap.
export function methodToPrimitive() {
  return Number({ tag: 1, [Symbol.toPrimitive](hint) { return hint === "string" ? 99 : 7 } });
}
export function methodThrowingValueOf() {
  try {
    Number({ valueOf() { throw new RangeError("boom") } });
    return "no-throw";
  } catch (e) {
    return (e instanceof RangeError ? "RangeError" : "other") + ":" + e.message;
  }
}
// The getter is a PROPERTY read: it must run once per coercion, not be cached
// at literal-construction time.
export function getterRunsPerCoercion() {
  let n = 0;
  const o = { v: { get valueOf() { n++; return () => n } } };
  const a = num(o);
  const b = num(o);
  return a + "," + b;
}
`;

const EXPECTED: Record<string, unknown> = {
  rowA: 3,
  rowB: 3,
  rowD: "3:g,c",
  fieldReadValueOf: 3,
  observerCallOrder: "3:g,c",
  rowG: 3,
  fieldReadToString: "seven",
  getterRunsPerCoercion: "1,2",

  // --- THREE RESIDUALS, deliberately asserted at the value the compiler
  // actually produces. All three are PRE-EXISTING gaps in the host
  // `_toPrimitive` walker's handling of an ACCESSOR-backed coercion method,
  // measured 2026-09-06 on this branch: their DIRECT-coercion twins (no field
  // read anywhere) are wrong in the same way, and their METHOD-SHORTHAND twins
  // are right. So they are not caused by, and are not reachable by, #5376 —
  // which is exclusively about the field STORE dropping the object. The paired
  // assertions below make that claim testable rather than a comment.

  // node: 7. `get [Symbol.toPrimitive]()` returning a function is read but the
  // returned function is never called. Direct twin identical.
  fieldReadToPrimitive: NaN,
  directToPrimitive: NaN,
  methodToPrimitive: 7, // method shorthand is correct

  // node: "RangeError:boom". A THROWING accessor is swallowed. Direct twin
  // identical; method shorthand propagates correctly.
  throwingGetter: "no-throw",
  directThrowingGetter: "no-throw",
  methodThrowingValueOf: "RangeError:boom",

  // node: "x:g,c". The `toString` GETTER runs twice (the walker probes the slot
  // and then re-reads it to call). Direct twin identical — the extra `g` is
  // present with no field read in sight.
  observerToStringOrder: "x:g,g,c",
  directToStringOrder: "x:g,g,c",
};

/**
 * Each residual field-read row must answer EXACTLY what its no-field-read twin
 * answers. This is the load-bearing assertion of the "pre-existing, not ours"
 * claim: if the walker is fixed later both flip together and this still holds,
 * and if the field read regresses on its own it fails here first.
 */
const RESIDUAL_TWINS: ReadonlyArray<readonly [string, string]> = [
  ["fieldReadToPrimitive", "directToPrimitive"],
  ["throwingGetter", "directThrowingGetter"],
  ["observerToStringOrder", "directToStringOrder"],
];

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

describe("#5376 — an accessor-backed coercion method survives a field read", () => {
  it("single module", { timeout: 300_000 }, async () => {
    const result = await compile(`${PROVIDER_SOURCE}\n${PROBES}`, {
      allowJs: true,
      skipSemanticDiagnostics: true,
    } as never);
    const observed = readAll(await instantiateSingle(result));
    expect(observed).toEqual(EXPECTED);
    for (const [fieldRow, directRow] of RESIDUAL_TWINS) {
      expect(observed[fieldRow], `${fieldRow} must match its no-field-read twin ${directRow}`).toEqual(
        observed[directRow],
      );
    }
  });

  it("two modules in one compilation unit", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/provider.js": PROVIDER_SOURCE,
        [entry]: `import { num, str } from "./provider";\n${PROBES}`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    // No package edge, so nothing is linked — this is the in-unit control.
    expect(result.linkedModules ?? []).toHaveLength(0);
    expect(readAll(await instantiateSingle(result))).toEqual(EXPECTED);
  });

  it("separately linked provider", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5376-"));
    const packageRoot = join(root, "node_modules", "prim5376");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "prim5376", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(entry, `import { num, str } from "prim5376";\n${PROBES}`);

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    // Load-bearing: a `bundled` plan would inline the package and silently test
    // the single-module lane a third time.
    expect(result.linkPlan?.mode).toBe("separate");

    const { instance } = await instantiateLinkedProject(result);
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });
});
