import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function run(body: string): Promise<unknown> {
  const src = `export function test(): any {\n${body}\n}`;
  const ex = (await compileToWasm(src)) as { test?: () => unknown };
  return ex.test!();
}

// (#1629a) When Object.defineProperty's descriptor argument is a *variable*
// (not an ObjectLiteralExpression at the call site), the compiler used to
// drop the descriptor on the floor — it had no inline AST to extract `value`,
// `get`, `set`, or `writable`/`enumerable`/`configurable` from. The fall-through
// to `emitExternDefinePropertyNoValue` then emitted empty flags, so spec
// invariants (data+accessor mix → TypeError, non-object desc → TypeError,
// value persistence) were silently ignored.
//
// The fix routes the dynamic-descriptor case to the runtime's
// `__defineProperty_desc` helper, which materializes the WasmGC-struct
// descriptor via struct-aware getField (sidecar + `__sget_<f>` exports) and
// applies it via native Object.defineProperty. Mirrors the sibling
// Object.create dynamic-descriptor path (#1631).
//
// Accessor read-back through `o.foo` after a dynamic accessor descriptor is
// OUT OF SCOPE here (struct-field vs sidecar reconciliation — see #1629b,
// #1630, #1631). This issue covers the TypeError + value-dispatch surface.
describe("#1629a dynamic-descriptor — Object.defineProperty", () => {
  it("data+accessor mix throws TypeError per §6.2.5.6 step 4", async () => {
    const r = await run(`
      const o: any = {};
      const desc: any = { get: function(): any { return 42; }, value: 99 };
      try {
        Object.defineProperty(o, "foo", desc);
        return "no-throw";
      } catch (e: any) {
        if (e instanceof TypeError) return "TypeError";
        return "other-throw:" + String(e);
      }`);
    expect(r).toBe("TypeError");
  });

  it("non-object descriptor (number) throws TypeError per §10.1.6 step 1", async () => {
    const r = await run(`
      const o: any = {};
      const desc: any = 42;
      try {
        Object.defineProperty(o, "foo", desc);
        return "no-throw";
      } catch (e: any) {
        if (e instanceof TypeError) return "TypeError";
        return "other-throw:" + String(e);
      }`);
    expect(r).toBe("TypeError");
  });

  it("first-arg null throws TypeError per §19.1.2.4 step 1", async () => {
    const r = await run(`
      const desc: any = { value: 1 };
      try {
        Object.defineProperty(null as any, "foo", desc);
        return "no-throw";
      } catch (e: any) {
        if (e instanceof TypeError) return "TypeError";
        return "other-throw:" + String(e);
      }`);
    expect(r).toBe("TypeError");
  });

  it("does not regress inline object-literal descriptors (data path)", async () => {
    const r = await run(`
      const o: any = {};
      Object.defineProperty(o, "foo", { value: 42, writable: true, configurable: true, enumerable: true });
      return o.foo;`);
    expect(r).toBe(42);
  });
});
