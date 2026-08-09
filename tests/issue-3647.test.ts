// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3647 — `Object.prototype.propertyIsEnumerable.call(C.prototype, "m")` returned
 * `true` for a class prototype method on the HOST lane, contradicting this
 * compiler's own `getOwnPropertyDescriptor().enumerable`, `Object.keys` and
 * for-in on the same object and key.
 *
 * ROOT CAUSE (measured, not inferred). In host mode the borrowed-method idiom
 * reaches NO `__propertyIsEnumerable` import at all — a positive-controlled
 * instrumentation of `resolveImport` showed no import whose intent mentions
 * "numerable" is ever resolved. The call is dispatched by `__proto_method_call`
 * (`runtime.ts`), which runs the ENGINE's own
 * `Object.prototype.propertyIsEnumerable` against the `_wrapForHost` live-mirror
 * Proxy. §20.1.3.4 therefore reads `[[GetOwnProperty]]` — the proxy's
 * `getOwnPropertyDescriptor` trap — and that trap hardcoded `enumerable: true`
 * for every non-sidecar key, including registered class-prototype members.
 * `_readOwnDescriptor` arm 2a (#1364a) had said `enumerable: false` for those
 * same names all along, and the static-method arm already deferred to it
 * (#3479); only the prototype-method case fell through. Hence the
 * self-inconsistency in the issue title.
 *
 * This is why the two `propertyIsEnumerable` HOST IMPORTS and
 * `_wasmStructPropertyIsEnumerable` are NOT on this path, and why editing them
 * moved nothing.
 *
 * LANE DISCIPLINE — the defect was HOST-ONLY; standalone already answered
 * correctly (it routes through `compilePropertyIntrospection`, which consults
 * `nonEnumerableTsProps`). The fix touches only the host-side proxy trap, and
 * the standalone assertions below are the guard that it stayed that way.
 *
 * HARNESS NOTE — bare `compile()` + `buildImports` under-assembles some
 * host-lane `Object.*` statics, so every test here carries an in-band CONTROL
 * (a plain own property must be enumerable; an absent key must not be). If a
 * control fails the harness is not measuring this question and the test fails
 * loudly rather than passing vacuously.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// `setInstance` + `__module_init` are BOTH load-bearing here, and omitting them
// is not a silent inaccuracy — it flips the answer. Without `setInstance` the
// runtime has no exports record, so `_wrapForHost`'s `fieldNamesForHost()` falls
// back to `_getStructFieldNames(obj, undefined)` → `[]`, every key looks absent,
// and `propertyIsEnumerable` answers `false` for EVERYTHING. That would make the
// class-method rows below pass for entirely the wrong reason. The CONTROL rows
// are what caught it.
async function runHost(source: string): Promise<unknown> {
  const result = await compile(source);
  expect(result.success, `Compile failed: ${result.errors.map((e) => e.message).join("; ")}`).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  imports.setInstance?.(instance);
  const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
  if (typeof moduleInit === "function") (moduleInit as () => void)();
  return (instance.exports as Record<string, () => unknown>).test!();
}

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, `Compile failed: ${result.errors.map((e) => e.message).join("; ")}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
  if (typeof moduleInit === "function") (moduleInit as () => void)();
  return (instance.exports as Record<string, () => unknown>).test!();
}

/** `1` when the control holds, `0` otherwise — asserted before any real row. */
const CONTROLS = `
  const ctl: any = { a: 1 };
  const ctlOwn = Object.prototype.propertyIsEnumerable.call(ctl, "a") === true;
  const ctlAbsent = Object.prototype.propertyIsEnumerable.call(ctl, "zz") === false;
`;

describe("#3647 — host lane: class prototype members are non-enumerable", () => {
  it("CONTROL: the harness can actually observe propertyIsEnumerable", async () => {
    // Guards against a vacuous pass: if this returns 0 every other host row in
    // this file is meaningless, so it is asserted first and separately.
    expect(
      await runHost(`export function test(): number {
        ${CONTROLS}
        return ctlOwn && ctlAbsent ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("propertyIsEnumerable.call(C.prototype, 'm') is false for a method", async () => {
    expect(
      await runHost(`class C { m(): number { return 42; } }
      export function test(): number {
        ${CONTROLS}
        if (!ctlOwn || !ctlAbsent) return -1;
        return Object.prototype.propertyIsEnumerable.call(C.prototype, "m") === false ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("the uncurried Function.prototype.call.bind form agrees", async () => {
    // The shape `propertyHelper.js` actually uses:
    //   var __propertyIsEnumerable =
    //     Function.prototype.call.bind(Object.prototype.propertyIsEnumerable);
    expect(
      await runHost(`class C { m(): number { return 42; } }
      export function test(): number {
        ${CONTROLS}
        if (!ctlOwn || !ctlAbsent) return -1;
        const pIE: any = Function.prototype.call.bind(Object.prototype.propertyIsEnumerable);
        return pIE(C.prototype, "m") === false && pIE(ctl, "a") === true ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("the variable-extracted .call form agrees", async () => {
    expect(
      await runHost(`class C { m(): number { return 42; } }
      export function test(): number {
        ${CONTROLS}
        if (!ctlOwn || !ctlAbsent) return -1;
        const f: any = Object.prototype.propertyIsEnumerable;
        return f.call(C.prototype, "m") === false ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("the direct method form agrees (it was already correct — non-regression)", async () => {
    expect(
      await runHost(`class C { m(): number { return 42; } }
      export function test(): number {
        return (C.prototype as any).propertyIsEnumerable("m") === false ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#3647 — AGREEMENT across reflective routes (the acceptance criterion)", () => {
  // The issue is a SELF-INCONSISTENCY, so the assertion is the agreement
  // itself, not each route in isolation — a future divergence in either
  // direction fails this.
  it("propertyIsEnumerable agrees with Object.keys and for-in", async () => {
    expect(
      await runHost(`class C { m(): number { return 42; } }
      export function test(): number {
        ${CONTROLS}
        if (!ctlOwn || !ctlAbsent) return -1;
        const pIE = Object.prototype.propertyIsEnumerable.call(C.prototype, "m") === true;

        const keys = Object.keys(C.prototype);
        let inKeys = false;
        for (let i = 0; i < keys.length; i++) if (keys[i] === "m") inKeys = true;

        let inForIn = false;
        for (const k in C.prototype) if (k === "m") inForIn = true;

        // All three must report the SAME answer, and that answer must be
        // "not enumerable".
        return pIE === inKeys && pIE === inForIn && pIE === false ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("propertyIsEnumerable agrees with getOwnPropertyDescriptor().enumerable", async () => {
    expect(
      await runHost(`class C { m(): number { return 42; } }
      export function test(): number {
        ${CONTROLS}
        if (!ctlOwn || !ctlAbsent) return -1;
        const pIE = Object.prototype.propertyIsEnumerable.call(C.prototype, "m");
        const d: any = Object.getOwnPropertyDescriptor(C.prototype, "m");
        if (!d) return 0;
        return d.enumerable === pIE && pIE === false ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#3647 — across member shapes", () => {
  // #3642's lesson: an unvaried axis is an assumption, not a measurement.
  const shape = (decl: string, key: string) => `class C { ${decl} }
    export function test(): number {
      ${CONTROLS}
      if (!ctlOwn || !ctlAbsent) return -1;
      return Object.prototype.propertyIsEnumerable.call(C.prototype, ${JSON.stringify(key)}) === false ? 1 : 0;
    }`;

  it("generator method", async () => {
    expect(await runHost(shape("*m(): any { yield 42; }", "m"))).toBe(1);
  });

  it("async method", async () => {
    expect(await runHost(shape("async m(): Promise<number> { return 42; }", "m"))).toBe(1);
  });

  it("getter accessor", async () => {
    expect(await runHost(shape("get m(): number { return 42; }", "m"))).toBe(1);
  });

  it("setter accessor", async () => {
    expect(await runHost(shape("set m(v: number) { }", "m"))).toBe(1);
  });

  it("several methods on one prototype", async () => {
    expect(
      await runHost(`class C { m(): number { return 1; } n(): number { return 2; } }
      export function test(): number {
        ${CONTROLS}
        if (!ctlOwn || !ctlAbsent) return -1;
        const pIE: any = Function.prototype.call.bind(Object.prototype.propertyIsEnumerable);
        return pIE(C.prototype, "m") === false && pIE(C.prototype, "n") === false ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#3647 — what must STAY enumerable (the over-fire guard)", () => {
  // The fix keys strictly on `_prototypeMethodNames`, which `__register_prototype`
  // populates only for CLASS prototypes. These rows fail if it ever widens.
  it("an object-literal method is still enumerable (§13.2.5 makes it so)", async () => {
    expect(
      await runHost(`export function test(): number {
        ${CONTROLS}
        if (!ctlOwn || !ctlAbsent) return -1;
        const o: any = { m(): number { return 1; } };
        return Object.prototype.propertyIsEnumerable.call(o, "m") === true ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a plain instance data property is still enumerable", async () => {
    expect(
      await runHost(`class C { x: number = 1; }
      export function test(): number {
        ${CONTROLS}
        if (!ctlOwn || !ctlAbsent) return -1;
        const c = new C();
        return Object.prototype.propertyIsEnumerable.call(c, "x") === true ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a property ASSIGNED onto the prototype is enumerable (§10.1.6.1)", async () => {
    expect(
      await runHost(`class C { m(): number { return 1; } }
      export function test(): number {
        ${CONTROLS}
        if (!ctlOwn || !ctlAbsent) return -1;
        (C.prototype as any).added = 7;
        return Object.prototype.propertyIsEnumerable.call(C.prototype, "added") === true ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("an explicit defineProperty enumerable:true still wins over the default", async () => {
    // The sidecar flags entry takes precedence over the class-member default,
    // so a deliberate redefinition is still honoured.
    expect(
      await runHost(`class C { m(): number { return 1; } }
      export function test(): number {
        ${CONTROLS}
        if (!ctlOwn || !ctlAbsent) return -1;
        Object.defineProperty(C.prototype, "m", { value: 1, enumerable: true, writable: true, configurable: true });
        return Object.prototype.propertyIsEnumerable.call(C.prototype, "m") === true ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("an absent key on a class prototype is still false, not an error", async () => {
    expect(
      await runHost(`class C { m(): number { return 1; } }
      export function test(): number {
        return Object.prototype.propertyIsEnumerable.call(C.prototype, "nope") === false ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#3647 — standalone lane must be untouched", () => {
  // Standalone already answered correctly before this change and routes through
  // `compilePropertyIntrospection`, not the host proxy. These rows are the guard
  // that the host-side fix did not "correct" the lane that was already right.
  it("standalone: inline borrowed call is false for a class method", async () => {
    expect(
      await runStandalone(`class C { m(): number { return 42; } }
      export function test(): number {
        const ctl: any = { a: 1 };
        const ctlOwn = Object.prototype.propertyIsEnumerable.call(ctl, "a") === true;
        if (!ctlOwn) return -1;
        return Object.prototype.propertyIsEnumerable.call(C.prototype, "m") === false ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("standalone: the direct method form is false for a class method", async () => {
    expect(
      await runStandalone(`class C { m(): number { return 42; } }
      export function test(): number {
        return (C.prototype as any).propertyIsEnumerable("m") === false ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
