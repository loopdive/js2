// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4159 Work Item A / #4160 slice 1) The shared AST pre-scan flags.
//
// `scanForArrayHoles` is the single pre-pass that decides, before any body is
// compiled, whether the module may contain (a) array holes, (b) a prototype
// INDEX write, (c) a non-data descriptor define, (d) dynamic code. Flags (b)-(d)
// gate the generic/spec-correct arms of #4159 and #4160; when they are clear the
// emission is byte-identical to today, which is the whole no-regression
// argument. So the predicates are the thing worth pinning.
import { describe, expect, it } from "vitest";
// `src/index.js` first, deliberately: importing `array-holes.js` on its own
// initialises the codegen module graph in a different order than the compiler
// does (array-holes -> expressions/late-imports -> calls -> collections-brand)
// and trips a circular-import TDZ on `COLLECTION_KIND`. Pulling the entry point
// in first establishes the normal order.
import "../src/index.js";
import { ts } from "../src/ts-api.js";
import { scanForArrayHoles } from "../src/codegen/array-holes.js";
import type { CodegenContext } from "../src/codegen/context/types.js";

/** Run the pre-scan over `src` and return just the four flags it sets. */
function scan(src: string) {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.ES2022, true);
  // The pass touches only these four fields.
  const ctx = {
    usesArrayHoles: false,
    protoIndexDirty: false,
    vecAccessorDescriptorDirty: false,
    dynamicCodeDirty: false,
  } as unknown as CodegenContext;
  scanForArrayHoles(ctx, sf);
  return {
    holes: ctx.usesArrayHoles,
    proto: ctx.protoIndexDirty,
    accessor: ctx.vecAccessorDescriptorDirty,
    dynamic: ctx.dynamicCodeDirty,
  };
}

describe("#4160 — protoIndexDirty covers Object.prototype as well as Array.prototype", () => {
  it("Object.prototype[1] = v sets it (the 15.4.4.18-7-b-12 shape, 135 files)", () => {
    expect(scan(`(Object.prototype as any)[1] = 111;`).proto).toBe(true);
  });

  it("Object.defineProperty(Object.prototype, '1', …) sets it", () => {
    expect(scan(`Object.defineProperty(Object.prototype, "1", { value: 1 });`).proto).toBe(true);
  });

  it("the pre-existing Array.prototype shapes still set it", () => {
    expect(scan(`(Array.prototype as any)[0] = 1;`).proto).toBe(true);
    expect(scan(`Object.defineProperty(Array.prototype, "0", { value: 1 });`).proto).toBe(true);
    expect(scan(`Reflect.defineProperty(Array.prototype, "0", { value: 1 });`).proto).toBe(true);
  });

  it("a non-literal index still counts — Array.prototype[i] = v", () => {
    expect(scan(`declare const i: number; (Array.prototype as any)[i] = 1;`).proto).toBe(true);
  });

  it("a NAME write does NOT set it — it cannot make an integer index inherited", () => {
    expect(scan(`(Object.prototype as any).foo = 1;`).proto).toBe(false);
    expect(scan(`(Array.prototype as any).foo = 1;`).proto).toBe(false);
  });

  it("a plain program sets nothing", () => {
    const f = scan(`export function f(): number { const a = [1, 2, 3]; return a[1]; }`);
    expect(f).toEqual({ holes: false, proto: false, accessor: false, dynamic: false });
  });
});

describe("#4159 — vecAccessorDescriptorDirty fires only when a descriptor is not provably data-only", () => {
  it("an accessor descriptor sets it", () => {
    expect(scan(`Object.defineProperty(a, "1", { get: function () { return 9; } });`).accessor).toBe(true);
    expect(scan(`Object.defineProperty(a, "1", { set: function (v) {} });`).accessor).toBe(true);
  });

  it("a shorthand accessor METHOD sets it", () => {
    expect(scan(`Object.defineProperty(a, "1", { get() { return 9; } });`).accessor).toBe(true);
  });

  it("a real get/set accessor declaration in the literal sets it", () => {
    expect(scan(`Object.defineProperty(a, "1", { get x() { return 9; } });`).accessor).toBe(true);
  });

  it("a data-only descriptor does NOT set it — #3251's write-back keeps that coherent", () => {
    expect(scan(`Object.defineProperty(a, "1", { value: 77, writable: true, configurable: true });`).accessor).toBe(
      false,
    );
    expect(scan(`Object.defineProperty(a, "1", { value: 1, enumerable: false });`).accessor).toBe(false);
  });

  it("a descriptor held in a VARIABLE sets it — unprovable at the call site", () => {
    expect(scan(`const d = { value: 1 }; Object.defineProperty(a, "1", d);`).accessor).toBe(true);
  });

  it("a spread sets it — the over-approximation must not see through it", () => {
    expect(scan(`Object.defineProperty(a, "1", { ...base, value: 1 });`).accessor).toBe(true);
  });

  it("a computed key sets it", () => {
    expect(scan(`Object.defineProperty(a, "1", { [k]: 1 });`).accessor).toBe(true);
  });

  it("defineProperties / Object.create recurse ONE level into the bag", () => {
    expect(scan(`Object.defineProperties(o, { a: { value: 1 } });`).accessor).toBe(false);
    expect(scan(`Object.defineProperties(o, { a: { get: g } });`).accessor).toBe(true);
    expect(scan(`Object.create(p, { a: { value: 1 } });`).accessor).toBe(false);
    expect(scan(`Object.create(p, { a: { get: g } });`).accessor).toBe(true);
  });

  it("Object.create with no descriptor bag installs nothing", () => {
    expect(scan(`Object.create(proto);`).accessor).toBe(false);
  });

  it("Reflect.defineProperty is covered too", () => {
    expect(scan(`Reflect.defineProperty(a, "1", { get: g });`).accessor).toBe(true);
  });
});

describe("#4159/#4160 — dynamic code forces both flags", () => {
  // Load-bearing: static eval inlining (#1163) splices statements in during BODY
  // compilation, AFTER this pre-scan has run, so `eval('Array.prototype[0]=1')`
  // sets nothing on today's main. Dynamic code therefore dirties everything.
  it("eval(...) forces proto + accessor", () => {
    const f = scan(`eval("Array.prototype[0] = 1");`);
    expect(f.dynamic).toBe(true);
    expect(f.proto).toBe(true);
    expect(f.accessor).toBe(true);
  });

  it("Function(...) and new Function(...) both count", () => {
    expect(scan(`Function("return 1");`).dynamic).toBe(true);
    expect(scan(`new Function("return 1");`).dynamic).toBe(true);
  });

  it("a MEMBER call named eval is not the global eval", () => {
    expect(scan(`foo.eval("x");`).dynamic).toBe(false);
  });
});

describe("the pre-scan still finds array holes, and finds flags AFTER a hole", () => {
  it("array-literal elision sets usesArrayHoles", () => {
    expect(scan(`const a = [1, , 3];`).holes).toBe(true);
  });

  // Regression guard for the early-exit: it must not bail once the flags it knew
  // about before #4159 are set, or a later node never gets visited.
  it("a hole EARLY does not stop the scan from finding a later accessor define", () => {
    const f = scan(`const a = [1, , 3]; Object.defineProperty(o, "k", { get: g });`);
    expect(f.holes).toBe(true);
    expect(f.accessor).toBe(true);
  });

  it("a proto write EARLY does not stop the scan from finding a later hole", () => {
    const f = scan(`(Array.prototype as any)[0] = 1; const a = [1, , 3];`);
    expect(f.proto).toBe(true);
    expect(f.holes).toBe(true);
  });
});
