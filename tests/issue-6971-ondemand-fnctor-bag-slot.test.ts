// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6971 — an ON-DEMAND fnctor struct (a constructor function the escape gate
 * did not approve, registered at its `new F()` site in `new-super.ts`) gets the
 * carrier-intrinsic `$bag` slot too.
 *
 * Before: only the up-front reserved fnctors (`reserveFnctorStructTypes`) got
 * `$bag`; an on-demand one fell to the global `$ClosurePropEntry` registry.
 * Every instance that grew a property through the generic setter (here:
 * `Base.call(this, s)` writing `this.strength`, the Octane deltablue
 * `superConstructor.call(this, …)` shape) was prepended to that never-pruned
 * list, and every later bag lookup on ANY slotless carrier walked it — linear in
 * the number of such instances ever created. Octane deltablue standalone spent
 * ~35 % self-time in `__closure_bag_lookup` and ran ~157 ms/rep; after: ~92.
 *
 * Standalone-only by construction (`appendInstanceBagSlot` returns on a
 * non-standalone context), so the host lane is byte-identical.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** `new Child(…)` as a bare statement + `this` escaping through `all.push` keeps
 *  `Child` off the escape gate's approved list, i.e. on the on-demand path. */
const PRELUDE = `
var all = [];
function Base(s) { this.strength = s; all.push(this); }
function Child(a, s) { Base.call(this, s); this.a = a; }
`;

async function build(src: string, emitWat = false) {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-6971.js",
    skipSemanticDiagnostics: true,
    emitWat,
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  return r;
}

async function run(src: string): Promise<unknown> {
  const r = await build(src);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  const init = instance.exports.__module_init as (() => void) | undefined;
  if (typeof init === "function") init();
  return (instance.exports.test as () => unknown)();
}

describe("#6971 — on-demand fnctor instances carry an intrinsic $bag", () => {
  it("the on-demand struct is laid out with $bag (it no longer feeds the registry)", async () => {
    const r = await build(`${PRELUDE}\nexport function test() { new Child(1, 2); return all.length; }`, true);
    const line = r.wat.split("\n").find((l) => /\(type \$__fnctor_Child \(struct/.test(l));
    expect(line, "on-demand $__fnctor_Child struct not found in WAT").toBeDefined();
    expect(line).toContain("$$bag");
  });

  it("negative control: a reserved (approved) fnctor keeps exactly one $bag", async () => {
    const r = await build(
      `function K(n) { this.n = n; }\nexport function test() { var k = new K(1); k.x = 2; return k.x + k.n; }`,
      true,
    );
    const line = r.wat.split("\n").find((l) => /\(type \$__fnctor_K \(struct/.test(l));
    expect(line).toBeDefined();
    expect(line!.split("$$bag").length - 1).toBe(1);
  });

  it("generic-setter writes, expandos and declared fields round-trip on many instances", async () => {
    // Node answers 179400 for the sum.
    expect(
      await run(`${PRELUDE}
export function test() {
  for (var i = 0; i < 300; i++) { new Child(i, i * 2); }
  for (var j = 0; j < all.length; j++) { all[j].extra = j; }
  var sum = 0;
  for (var k = 0; k < all.length; k++) sum += all[k].strength + all[k].extra + all[k].a;
  return sum;
}`),
    ).toBe(179400);
  });

  it("reflective surfaces agree with the slot-backed bag (independent per instance)", async () => {
    // Each check is a node-verified fact; the bitmask keeps one compile.
    expect(
      await run(`${PRELUDE}
export function test() {
  for (var i = 0; i < 20; i++) { new Child(i, i * 2); }
  var c = all[7];
  c.extra = 7;
  var bits = 0;
  if (c.hasOwnProperty("strength")) bits |= 1;
  if ("extra" in c) bits |= 2;
  if (!("nope" in c) && c.nope === undefined) bits |= 4;
  delete c.extra;
  if (c.extra === undefined && !("extra" in c)) bits |= 8;
  Object.defineProperty(c, "ro", { value: 1, writable: false, enumerable: false });
  try { c.ro = 2; } catch (e) {}
  if (c.ro === 1 && Object.keys(c).length === 2) bits |= 16;
  Object.freeze(all[8]);
  try { all[8].strength = 99; } catch (e) {}
  if (all[8].strength === 16 && Object.isFrozen(all[8])) bits |= 32;
  if (all[9].strength === 18 && all[10].strength === 20 && !all[9].hasOwnProperty("extra")) bits |= 64;
  return bits;
}`),
    ).toBe(127);
  });
});
