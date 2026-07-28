/**
 * #3719 — `p = new F()` (assignment) must bind like `var p = new F()`
 * (declaration initializer) in the fnctor escape gate.
 *
 * `bindingOf` recognised only the declaration form. For any other shape the
 * classifier lost the binding, fell to its inline branch, saw no property
 * access directly on the `new`, and settled on `keep-static`. The class then
 * never entered `approvedNames`, its prototype methods were never lifted or
 * compiled, and a later `p.m()` resolved to NOTHING at runtime — silently
 * answering `undefined` rather than trapping.
 *
 * What pinned the cause: adding ANY separate typed use — even a DEAD one that
 * never runs — made the same call work, which proves the defect was
 * compile-time registration, not runtime dispatch.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function run(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "t.mjs", skipSemanticDiagnostics: true, target: "standalone" });
  expect(r.binary?.length ?? 0).toBeGreaterThan(0);
  const module = await WebAssembly.compile(r.binary as BufferSource);
  expect(WebAssembly.Module.imports(module).length).toBe(0);
  const { exports } = await WebAssembly.instantiate(module, {});
  return (exports as { test?: () => unknown }).test?.();
}

const Q = `function Q(){ this.v = 9; } Q.prototype.inc = function(){ return 1000; };`;
const P = `function P(v){ this.v = v; } P.prototype.inc = function(){ return 1; };`;

describe("#3719 — new-expression assigned to a binding (standalone)", () => {
  it("calls a prototype method after `var p; p = new Q()`", async () => {
    expect(await run(`${Q}\nexport function test(){ var p; p = new Q(); return p.inc(); }`)).toBe(1000);
  });

  it("reads a prototype method as a value (not just calls it)", async () => {
    expect(await run(`${Q}\nexport function test(){ var p; p = new Q(); return p.inc ? 1 : 0; }`)).toBe(1);
  });

  it("dispatches on the RUNTIME class after reassignment", async () => {
    // The binding is declared holding a P and reassigned to a Q; the call must
    // reach Q.prototype.inc, not P's and not undefined.
    expect(await run(`${P}\n${Q}\nexport function test(){ var p = new P(0); p = new Q(); return p.inc(); }`)).toBe(
      1000,
    );
  });

  it("works when the method name exists on only the second class", async () => {
    expect(
      await run(
        `function P(v){ this.v = v; }\n${Q}\nexport function test(){ var p = new P(0); p = new Q(); return p.inc(); }`,
      ),
    ).toBe(1000);
  });

  it("does not depend on an unrelated typed use existing", async () => {
    // The regression's tell: a DEAD typed use used to be what made it work.
    // Both forms must now agree.
    const withDead = `${Q}\nfunction dead(){ var q = new Q(); return q.inc(); }\nexport function test(){ var p; p = new Q(); return p.inc(); }`;
    const without = `${Q}\nexport function test(){ var p; p = new Q(); return p.inc(); }`;
    expect(await run(without)).toBe(await run(withDead));
    expect(await run(without)).toBe(1000);
  });

  it("still reads own fields correctly through the assigned binding", async () => {
    expect(await run(`${Q}\nexport function test(){ var p; p = new Q(); return p.v; }`)).toBe(9);
  });
});
