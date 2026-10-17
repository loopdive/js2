import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

// #2731 — delete + re-add read/write asymmetry (HOST mode).
//
// In a module that uses `delete`, any/anon-object-literal-receiver property
// READS already route through the tombstone-aware host `__extern_get`, but the
// matching WRITE took the native `struct.set` fast-path, bypassing `_safeSet`'s
// tombstone-clear. So `delete o.x; o.x = 9` left `_wasmStructDeletedKeys`'s
// tombstone set, and every tombstone-consulting reader suppressed the re-added
// key (`o.x === undefined`, `"x" in o === false`, for-in dropped `x`).
//
// Fix: `tryEmitDeleteAwareDynamicSet` reroutes the write through
// `__extern_set_strict` → `_safeSet` (clears the tombstone, mirrors the native
// field, re-inserts the sidecar), and `_wasmStructShadowedFields` makes the
// re-added struct-shape field enumerate at insertion-order END.
async function runHost(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const imp = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown> & {
    // (#7014) setInstance: raw setExports(instance.exports) lost data-struct authority in 708ebbd56d (#5337).
    setInstance?: (e: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary, imp);
  if (typeof imp.setInstance === "function") imp.setInstance(instance);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2731 for-in delete+re-add read/write symmetry", () => {
  it("concrete `var o = {…}`: re-added field enumerates at insertion-order END", async () => {
    expect(
      await runHost(`export function test(): string {
  var o = { a: 1, b: 2, c: 3 };
  delete o.a; delete o.c; o.a = 9;
  var s = ""; for (var k in o) s += k + ",";
  return s;
}`),
    ).toBe("b,a,");
  });

  it("any `o.x` re-add: value + presence + for-in all recover", async () => {
    expect(
      await runHost(`export function test(): string {
  var o: any = { x: 1, y: 2 };
  delete o.x; o.x = 9;
  var s = ""; for (var k in o) s += k + ",";
  return "for=" + s + " val=" + o.x + " in=" + ("x" in o);
}`),
    ).toBe("for=y,x, val=9 in=true");
  });

  it("order-simple-object (test262): integer keys ascending, then insertion order, re-added last", async () => {
    expect(
      await runHost(`export function test(): string {
  var o: any = { p1: 'p1', p2: 'p2', p3: 'p3' };
  o.p4 = 'p4'; o[2] = '2'; o[0] = '0'; o[1] = '1';
  delete o.p1; delete o.p3; o.p1 = 'p1';
  var keys: any[] = []; for (var key in o) { keys.push(key); }
  return keys.join(',');
}`),
    ).toBe("0,1,2,p2,p4,p1");
  });

  it("plain re-assign of a never-deleted field keeps its struct position (no shadow)", async () => {
    expect(
      await runHost(`export function test(): string {
  var o = { a: 1, b: 2 };
  o.a = 9; // never deleted — must stay first
  var s = ""; for (var k in o) s += k + ",";
  return s;
}`),
    ).toBe("a,b,");
  });

  it("delete WITHOUT re-add still removes the key from for-in", async () => {
    expect(
      await runHost(`export function test(): string {
  var o = { a: 1, b: 2 };
  delete o.a;
  var s = ""; for (var k in o) s += k + ",";
  return s;
}`),
    ).toBe("b,");
  });
});
