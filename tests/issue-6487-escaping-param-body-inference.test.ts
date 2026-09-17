// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6487 — the #3471 NaN miscompile reached through the ESCAPE door.
//
// #3471 gated the body-usage fallback on `!sawCallSite`: body usage is only a
// signal when the function is genuinely uncalled. But "no call site in this
// file" is not the same as "no caller". A function referenced as a VALUE —
// `export const __h_x = verifyEqualTo;`, the alias form every linked test262
// harness provider is materialized with — has callers this file cannot see, and
// the body route narrowed its implicit-any parameter to f64 anyway. The
// provider's `verifyEqualTo(obj, name, value)` compiled to
// `(externref, externref, f64)`, so a consumer's string argument crossed the
// `__call_fn_3` dispatcher and arrived as NaN:
//   "Expected obj[foo] to equal NaN, actually abcd".
//
// `callSites.escapesAsValue` was already computed and already withdrew the
// native-string `ref` route for exactly this reason (#2867 S2). The fix
// withdraws the f64 body route on the same evidence — but keeps it BELOW the
// `.d.ts` seed (#743), because a declared type is a contract about the unseen
// callers and outranks both heuristics.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * The `(param …)` signature string of `func`. A function that escapes as a
 * value shares its type with the dispatcher, so the `(func $f (type $f_type))`
 * spelling must be followed to the type section — reading only the inline
 * `(param …)` form silently reports `""` for exactly the case under test.
 */
async function paramSig(src: string, func: string): Promise<string> {
  const r = await compile(src, { fileName: "t.js", emitWat: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const wat = r.wat ?? "";
  const inline = wat.match(new RegExp(`\\(func \\$${func} \\(param ([^)]*)\\)`));
  if (inline) return inline[1]!;
  const shared = wat.match(new RegExp(`\\(func \\$${func} \\(type ([^)]*)\\)`));
  expect(shared, `no signature for $${func}`).not.toBeNull();
  const ref = shared![1]!;
  const named = wat.match(new RegExp(`\\(type \\$?${ref.replace("$", "\\$")} \\(func \\(param ([^)]*)\\)`));
  if (named) return named[1]!;
  // Numeric reference: the type section is emitted in index order, names and
  // all, so resolve positionally rather than by spelling.
  const decls = wat.split("\n").filter((l) => /^\s*\(type /.test(l));
  const decl = decls[Number(ref)];
  expect(decl, `type ${ref} not found among ${decls.length} declarations`).toBeTruthy();
  const m = decl!.match(/\(func \(param ([^)]*)\)/);
  expect(m, `type ${ref} is not a function type: ${decl}`).not.toBeNull();
  return m![1]!;
}

/** `f` is never CALLED here; only the trailing export line differs per case. */
const UNCALLED_NUMERIC_BODY = `
function f(v) { return v * 2; }
`;

describe("#6487 — body inference withdrawn for a function that escapes as a value", () => {
  it("keeps the dynamic carrier when the function escapes through an export alias", async () => {
    const sig = await paramSig(`${UNCALLED_NUMERIC_BODY}export const g = f;\n`, "f");
    expect(sig).toBe("externref");
  });

  // Deliberately NOT changed: `export { f }` is an export specifier, which
  // `valueReferencedNames` excludes, so it behaves exactly like `export
  // function f` — the #743 "truly-uncalled exported entrypoint" case, where the
  // export boundary itself coerces (ToNumber for f64) and body inference is the
  // sanctioned signal. The alias form is different precisely because the value
  // travels through the internal `__call_fn_N` dispatcher, which has no such
  // coercion. Pinned so a future widening of the escape rule is a deliberate
  // decision rather than a silent one.
  it("still narrows for a plain `export { f }` specifier (exported-entrypoint case)", async () => {
    const sig = await paramSig(`${UNCALLED_NUMERIC_BODY}export { f };\n`, "f");
    expect(sig).toBe("f64");
  });

  // The honest control: with no value reference, nothing about the function
  // changed, so the #1121/#3471 body narrowing must still fire. This is the
  // half of the pair that proves the fix is scoped to the escape and did not
  // simply disable body inference.
  it("still narrows to f64 when the same function does not escape", async () => {
    const sig = await paramSig(`${UNCALLED_NUMERIC_BODY}export function run() { return 1; }\n`, "f");
    expect(sig).toBe("f64");
  });

  it("an escaping function's string argument survives the indirect call (not NaN)", async () => {
    const src = `
function verify(name, value) {
  if (value * 2 === 4) { return "numeric"; }
  return name + ":" + value;
}
export const alias = verify;
export function test() {
  const fn = alias;
  return fn("foo", "abcd");
}
`;
    const r = await compile(src, { fileName: "t.js" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { buildImports } = await import("../src/runtime.js");
    const imports = buildImports(r.imports, {}, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
    const exports = instance.exports as Record<string, () => unknown>;
    (imports as { setExports?: (e: unknown) => void }).setExports?.(exports);
    expect(exports.test()).toBe("foo:abcd");
  });
});
