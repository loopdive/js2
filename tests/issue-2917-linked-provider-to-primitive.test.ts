// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2917 — ToPrimitive of a PROVIDER-owned class instance in a linked
 * `--target standalone` consumer must run the provider's method with the
 * receiver bound.
 *
 * `Temporal.Duration.from(…).toString()` threw "invalid receiver" in the two
 * test262 `argument-duration-precision-exact-numerical-values.js` rows. The
 * consumer lowers `x.toString()` / `String(x)` / `` `${x}` `` / `"" + x` on an
 * `any` receiver to ToPrimitive; for a foreign class instance that reaches the
 * `__class_to_primitive` runtime walk, which resolved `toString` through the
 * link (`__extern_get` → provider) and then INVOKED the provider's closure with
 * the consumer's own arity bridge. That bridge binds `this` through the
 * CONSUMER's `__current_this`, while the provider's trampoline reads the
 * provider's copy — so the method ran against a stale receiver. The walk now
 * hands a provider-owned receiver's step to `__js2wasm_link_method_call`, which
 * resolves and invokes on the owner's side (the #5383 S2h terminal).
 *
 * Base (ecabf41935): `toStringDefault`/`string`/`template`/`add` answered
 * "[object Object]" and `toStringArity0` threw; the consumer-local controls
 * were already right and must stay so.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject, instantiateLinkedProject } from "../src/index.js";

const PROVIDER = `
const slots = new WeakMap();
function check(x) { if (!x || typeof x !== "object" || !slots.has(x)) throw new TypeError("invalid receiver"); }
export class D {
  constructor(v) { slots.set(this, { v: v }); }
  toString(options = undefined) { check(this); return "D" + slots.get(this).v; }
  toJSON() { check(this); return "J" + slots.get(this).v; }
}
export class E {
  constructor(v) { slots.set(this, { v: v }); }
  toString() { check(this); return "E" + slots.get(this).v; }
}
export function make(v) { return new D(v); }
export function makeE(v) { return new E(v); }
`;

// 1 = expected string, 2 = "[object Object]", -1 = threw, 0 = other.
const CONSUMER = `
import { make, makeE } from "pm2917";
function r(f, want) {
  let s;
  try { s = String(f()); } catch (e) { return -1; }
  if (s === want) return 1;
  return s === "[object Object]" ? 2 : 0;
}
export function toStringDefault() { return r(() => make(1).toString(), "D1"); }
export function toStringArity0() { return r(() => makeE(2).toString(), "E2"); }
export function string() { return r(() => String(make(3)), "D3"); }
export function template() { return r(() => \`\${make(4)}\`, "D4"); }
export function add() { return r(() => "" + make(5), "D5"); }
export function methodControl() { return r(() => make(6).toJSON(), "J6"); }
export function localClass() {
  class L { constructor(v) { this.v = v; } toString() { return "L" + this.v; } }
  return r(() => String(new L(7)), "L7");
}
export function localPlain() {
  class N { constructor(v) { this.v = v; } }
  return r(() => String(new N(8)), "[object Object]");
}
export function localProto() {
  function F(v) { this.v = v; }
  F.prototype.toString = function () { return "F" + this.v; };
  return r(() => String(new F(9)), "F9");
}
`;

const NAMES = [
  "toStringDefault",
  "toStringArity0",
  "string",
  "template",
  "add",
  "methodControl",
  "localClass",
  "localPlain",
  "localProto",
] as const;

describe("#2917 — linked standalone ToPrimitive of a provider class instance", () => {
  it("binds the receiver on the provider side", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-2917-"));
    const pkg = join(root, "node_modules", "pm2917");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pm2917", version: "0.0.0", main: "index.js" }));
    writeFileSync(join(pkg, "index.js"), PROVIDER);
    const entry = join(root, "main.js");
    writeFileSync(entry, CONSUMER);

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
      hostBridge: "off",
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    // Load-bearing: a `bundled` plan is the single-module lane, which never had
    // the defect.
    expect(result.linkPlan?.mode).toBe("separate");

    const { instance } = await instantiateLinkedProject(result);
    const exports = instance.exports as unknown as Record<string, () => number>;
    const observed = Object.fromEntries(NAMES.map((name) => [name, exports[name]!()]));
    expect(observed).toEqual(Object.fromEntries(NAMES.map((name) => [name, 1])));
  });
});
