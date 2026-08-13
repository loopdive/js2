// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — `<dynamic>.valueOf()` in the host/GC lane must resolve the receiver's
 * REAL `valueOf` **without** losing ordinary-object identity.
 *
 * The blanket "valueOf() returns the receiver" fallback is
 * `Object.prototype.valueOf`, correct only when nothing earlier in the
 * prototype chain overrides it — and a receiver typed `any` (every receiver in
 * compiled JavaScript) reached none of the static arms that resolve the
 * overriding cases. #4201 fixed this for `--target standalone`; the host lane
 * kept the shortcut, so a primitive wrapper unboxed to ITSELF.
 *
 * The third case below is the one that makes the naive repair wrong: simply
 * falling through to the generic dynamic method call resolves the wrapper and
 * the override but round-trips an ordinary object through the host, so
 * `o.valueOf() === o` becomes false. `host-dyn-valueof.ts` therefore decides
 * in-module and returns the ORIGINAL externref for the identity arm.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runJs(source: string): Promise<string[]> {
  const result = await compile(source, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const logged: string[] = [];
  const imports = buildImports(result.imports, undefined, result.stringPool) as any;
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const { instance } = await WebAssembly.instantiate(result.binary!, imports);
    imports.setInstance?.(instance);
    imports.setExports?.(instance.exports);
    const exports = instance.exports as Record<string, unknown>;
    if (typeof exports.__module_init === "function") (exports.__module_init as () => void)();
  } finally {
    console.log = originalLog;
  }
  return logged;
}

describe("#4394 — host-lane dynamic-receiver valueOf", () => {
  it("unboxes a primitive wrapper built by Object(primitive)", async () => {
    const logged = await runJs(`
function unbox(v) { return v.valueOf(); }
var s = unbox(Object("a"));
var n = unbox(Object(1));
var b = unbox(Object(true));
console.log("string: " + typeof s + " " + (s === "a"));
console.log("number: " + typeof n + " " + (n === 1));
console.log("boolean: " + typeof b + " " + (b === true));
`);
    expect(logged).toContain("string: string true");
    expect(logged).toContain("number: number true");
    expect(logged).toContain("boolean: boolean true");
  });

  it("prefers a user valueOf override over the identity shortcut", async () => {
    const logged = await runJs(`
function unbox(v) { return v.valueOf(); }
console.log("override: " + unbox({ valueOf: function () { return 7; } }));
`);
    expect(logged).toContain("override: 7");
  });

  it("KEEPS identity for an ordinary object (Object.prototype.valueOf)", async () => {
    const logged = await runJs(`
function unbox(v) { return v.valueOf(); }
var o = { a: 1 };
console.log("identity: " + (unbox(o) === o));
`);
    expect(logged).toContain("identity: true");
  });

  it("keeps identity when the result is compared inline as well as via a local", async () => {
    const logged = await runJs(`
function unbox(v) { return v.valueOf(); }
var o = { a: 1 };
var r = unbox(o);
console.log("viaLocal: " + (r === o));
console.log("inline: " + (unbox(o) === o));
`);
    expect(logged).toContain("viaLocal: true");
    expect(logged).toContain("inline: true");
  });

  it("unboxes a wrapper reached through a reassigned parameter", async () => {
    // The harness's own `comparePrimitiveEquality` shape. `wasBoxed` is hoisted
    // out of the `if` on purpose: spelling the condition as the inline call
    // `if (isBoxed(a))` trips an UNRELATED parameter-carrier bug (the param slot
    // is typed from its call sites as the String WRAPPER, so storing the
    // unboxed primitive back into it coerces to the wrapper again) — that is
    // tracked separately in plan/issues/4394.
    const logged = await runJs(`
function isBoxed(value) {
  return value instanceof String || value instanceof Number || value instanceof Boolean;
}
function cmp(a, b) {
  var aBoxed = isBoxed(a);
  if (aBoxed) a = a.valueOf();
  return a === b;
}
console.log("boxed-eq: " + cmp(Object("a"), "a"));
console.log("boxed-ne: " + cmp(Object("a"), "b"));
`);
    expect(logged).toContain("boxed-eq: true");
    expect(logged).toContain("boxed-ne: false");
  });
});
