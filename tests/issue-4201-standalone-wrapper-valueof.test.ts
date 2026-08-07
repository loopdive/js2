// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4201 — `<primitive wrapper>.valueOf()` on a DYNAMIC receiver under
 * `--target standalone` returned the WRAPPER instead of `[[PrimitiveValue]]`.
 *
 * The receiver type is the whole story: `compileReceiverMethodCall` resolves
 * `new Number(x).valueOf()` and friends from the receiver's STATIC TypeScript
 * type, then ends with a blanket "valueOf() returns the object itself" for
 * everything else. A receiver typed `any` — every receiver in compiled
 * JavaScript, which is what test262 is — reached only the blanket arm, so the
 * wrapper intrinsic AND a user-defined `valueOf` were both swallowed.
 *
 * The `_static` cases below are the PRECONDITION: they were already green
 * before the fix and must stay green. Their job is to prove the fixture
 * actually reaches the standalone wrapper substrate, so an `any`-receiver
 * assertion that fails is a real defect and not a fixture that never got
 * there. `to_primitive_precondition` does the same for the slot itself:
 * `String(b)` reads `[[PrimitiveValue]]` and was ALWAYS right, which is what
 * proves the slot is populated and only the intrinsic `valueOf` was missing.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

const wrap = (body: string) => `export function run(): number { ${body} }`;

describe("#4201 — standalone valueOf() on a dynamic receiver", () => {
  // ── Precondition: green BEFORE and AFTER. A failure here means the fixture
  // never reached the substrate, not that the fix regressed.
  it("[precondition] the [[PrimitiveValue]] slot is populated — String(b) reads it", async () => {
    expect(await runStandalone(wrap(`const b: any = new Boolean(true); return (String(b) === "true") ? 1 : 0;`))).toBe(
      1,
    );
  });

  it("[precondition] a STATICALLY typed wrapper receiver already worked", async () => {
    expect(await runStandalone(wrap(`const b = new Boolean(true); return (b.valueOf() === true) ? 1 : 0;`))).toBe(1);
    expect(await runStandalone(wrap(`const n = new Number(5); return (n.valueOf() === 5) ? 1 : 0;`))).toBe(1);
  });

  // ── The defect (RED on the base commit).
  it("Boolean wrapper: valueOf() returns the primitive, not the wrapper", async () => {
    expect(await runStandalone(wrap(`const b: any = new Boolean(true); return (b.valueOf() === true) ? 1 : 0;`))).toBe(
      1,
    );
    expect(await runStandalone(wrap(`const b: any = new Boolean(true); return (b.valueOf() === b) ? 1 : 0;`))).toBe(0);
    expect(
      await runStandalone(wrap(`const b: any = new Boolean(true); return (typeof b.valueOf() === "boolean") ? 1 : 0;`)),
    ).toBe(1);
  });

  it("Number wrapper: valueOf() returns [[NumberData]]", async () => {
    expect(await runStandalone(wrap(`const n: any = new Number(5); return (n.valueOf() === 5) ? 1 : 0;`))).toBe(1);
    expect(await runStandalone(wrap(`const n: any = Object(5); return (n.valueOf() === 5) ? 1 : 0;`))).toBe(1);
  });

  it("String wrapper: valueOf() returns [[StringData]]", async () => {
    expect(await runStandalone(wrap(`const s: any = new String("x"); return (s.valueOf() === "x") ? 1 : 0;`))).toBe(1);
  });

  it("a user-defined valueOf beats Object.prototype.valueOf", async () => {
    expect(
      await runStandalone(
        wrap(`const o: any = { valueOf: function () { return 7; } }; return (o.valueOf() === 7) ? 1 : 0;`),
      ),
    ).toBe(1);
  });

  // ── Non-regression: these were green before and must stay green. Together
  // with the preconditions they are the control side of the change — the
  // blanket identity is still the answer whenever nothing overrides it.
  it("[control] a plain object still gets Object.prototype.valueOf (this)", async () => {
    expect(await runStandalone(wrap(`const o: any = { a: 1 }; return (o.valueOf() === o) ? 1 : 0;`))).toBe(1);
  });

  it("[control] a primitive receiver is unchanged", async () => {
    expect(await runStandalone(wrap(`const n: any = 5; return (n.valueOf() === 5) ? 1 : 0;`))).toBe(1);
    expect(await runStandalone(wrap(`const s: any = "x"; return (s.valueOf() === "x") ? 1 : 0;`))).toBe(1);
    expect(await runStandalone(wrap(`const b: any = true; return (b.valueOf() === true) ? 1 : 0;`))).toBe(1);
  });

  it("[control] toString on a wrapper is untouched", async () => {
    expect(
      await runStandalone(wrap(`const b: any = new Boolean(true); return (b.toString() === "true") ? 1 : 0;`)),
    ).toBe(1);
    expect(await runStandalone(wrap(`const n: any = new Number(5); return (n.toString() === "5") ? 1 : 0;`))).toBe(1);
  });
});
