/**
 * Tests for issue #1364b: `delete C.m` / `delete C.prototype.m` must remove
 * the class method or static from the prototype/class-object allowlist.
 *
 * Slice A (#1364a) made class methods discoverable via
 * `Object.getOwnPropertyDescriptor` with the spec-correct flags
 * (`enumerable: false, configurable: true, writable: true`). Slice B
 * (this file) follows up on the `configurable: true` half of that contract:
 * verifyProperty (test262 harness) reads the descriptor, then performs
 * `delete C.m` and asserts that the subsequent descriptor lookup returns
 * `undefined`. Without this fix, the descriptor stayed put after `delete`
 * and verifyProperty failed its second-pass invariant check.
 *
 * Spec ref: ECMA-262 §10.1.10 [[Delete]] — successful delete removes the
 * own property from `[[OwnPropertyKeys]]`.
 *
 * Implementation: the runtime tracks a per-receiver set of deleted prop
 * names (unified with the existing `_wasmStructDeletedKeys` tombstone used
 * by `__delete_property`). All allowlist-consulting paths
 * (`__getOwnPropertyDescriptor`, `__getOwnPropertyNames`, proxy `has`,
 * `_wrapForHost`'s `fieldNamesForHost`) filter out tombstoned names.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as Record<string, () => unknown>).test!();
}

describe("issue #1364b: delete class method/static removes from allowlist", () => {
  it("delete C.m removes the static method descriptor", async () => {
    const src = `
class C { static m() {} }
export function test(): number {
  if (!Object.getOwnPropertyDescriptor(C, "m")) return 100;
  // @ts-ignore
  if (!(delete (C as any).m)) return 101;
  if (Object.getOwnPropertyDescriptor(C, "m")) return 102;
  return 1;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("delete C.prototype.m removes the instance method descriptor", async () => {
    const src = `
class C { m() {} }
export function test(): number {
  if (!Object.getOwnPropertyDescriptor(C.prototype, "m")) return 100;
  // @ts-ignore
  if (!(delete (C.prototype as any).m)) return 101;
  if (Object.getOwnPropertyDescriptor(C.prototype, "m")) return 102;
  return 1;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("hasOwnProperty returns false after delete", async () => {
    const src = `
class C { m() {} }
export function test(): number {
  // @ts-ignore
  delete (C.prototype as any).m;
  return Object.prototype.hasOwnProperty.call(C.prototype, "m") ? 100 : 1;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("delete leaves sibling methods intact", async () => {
    const src = `
class C { m() {} n() {} }
export function test(): number {
  // @ts-ignore
  delete (C.prototype as any).m;
  if (Object.getOwnPropertyDescriptor(C.prototype, "m")) return 100;
  if (!Object.getOwnPropertyDescriptor(C.prototype, "n")) return 101;
  return 1;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("delete leaves sibling static methods intact", async () => {
    const src = `
class C { static m() {} static n() {} }
export function test(): number {
  // @ts-ignore
  delete (C as any).m;
  if (Object.getOwnPropertyDescriptor(C, "m")) return 100;
  if (!Object.getOwnPropertyDescriptor(C, "n")) return 101;
  return 1;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("verifyProperty-style invariant pass: read → delete → read", async () => {
    // Mirrors the test262 `verifyProperty` helper's second pass which
    // confirms the property is genuinely configurable by deleting it and
    // checking the descriptor is gone afterwards.
    const src = `
class C { static m() {} }
export function test(): number {
  const before = Object.getOwnPropertyDescriptor(C, "m");
  if (!before) return 100;
  if ((before as any).configurable !== true) return 101;
  // @ts-ignore
  const ok = delete (C as any).m;
  if (!ok) return 102;
  const after = Object.getOwnPropertyDescriptor(C, "m");
  if (after) return 103;
  return 1;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("regression: delete on an unknown name still reports true (existing semantics)", async () => {
    // \`delete\` on a non-own property is vacuously true per ECMA-262 §13.5.1.
    const src = `
class C { m() {} }
export function test(): number {
  // @ts-ignore
  return (delete (C.prototype as any).doesNotExist) ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("regression: instance method invocation still works on non-deleted methods", async () => {
    const src = `
class C {
  m(): number { return 42; }
  n(): number { return 7; }
}
export function test(): number {
  // @ts-ignore
  delete (C.prototype as any).m;
  const c = new C();
  // n() is preserved — direct instance call should still resolve.
  return c.n() === 7 ? 1 : 100;
}
`;
    expect(await runTest(src)).toBe(1);
  });
});
