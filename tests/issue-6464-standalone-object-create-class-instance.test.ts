// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6464 (#5383 S13) — `Object.create(<value>.prototype)` under `--target
// standalone` must produce a real compiled instance.
//
// WHY THIS REDUCTION EXISTS. The symptom reported against the linked Temporal
// provider was "every `Temporal.X.from(…)` result answers `null` for every
// accessor, while `new Temporal.X(…)` answers correctly". Measured 2026-09-13,
// that is neither a link defect nor an `Object.create` defect in general — it is
// the SPELLING of the prototype argument, and it reproduces in one standalone
// module with no provider and no linker:
//
// |                                            | `o.self() === o` | `o.day` |
// | ------------------------------------------ | ---------------- | ------- |
// | `Object.create(K.prototype)`, `K` a VALUE   | **false**        | **−1**  |
// | `Object.create(C.prototype)`, `C` a class   | true             | 18      |
// | `new C()`                                   | true             | 18      |
//
// #5239 fixed this for the JS-host lane; its emitter returns early on
// `ctx.standalone`, and nothing replaced it. The polyfill emits the dynamic
// spelling seven times — `function pn(e,t){ const n = ce("%Temporal.PlainDate%");
// const r = Object.create(n.prototype); return yn(r,e,t), r; }` — once per
// `X.from(…)` result builder.
//
// WHICH ARM HAS TEETH. The first `describe` is the behavioural witness and it
// FAILS on the base tree (`dynGetter` answered `-1`, `dynSelfIsSelf` answered
// `false`). The second is the byte-neutrality guard: a module with no dynamic
// `Object.create` and the `gc` lane must be untouched.
import { describe, expect, it } from "vitest";

import { compile, compileMulti } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/**
 * The class plus BOTH factories. State lives in a WeakMap keyed by the created
 * object — the shape a polyfill uses, and the reason the created object must BE
 * the compiled instance rather than a plain object that merely inherits from
 * its prototype.
 */
const SOURCE = `
const slots = new WeakMap();
const registry = {};
function intrinsic(k) { return registry[k]; }

class C {
  constructor() {}
  get day() { const s = slots.get(this); return s ? s.day : -1; }
  self() { return this; }
  label() { const s = slots.get(this); return s ? ("Y" + s.day) : "NOSLOT"; }
}
registry["%C%"] = C;

/** the minified-bundle shape: the class arrives as a VALUE */
function makeDynamic() {
  const K = intrinsic("%C%");
  const o = Object.create(K.prototype);
  slots.set(o, { day: 18 });
  return o;
}
/** the hand-written shape, already lowered to \`struct.new\` before this issue */
function makeStatic() {
  const o = Object.create(C.prototype);
  slots.set(o, { day: 18 });
  return o;
}

export function dynGetter() { return makeDynamic().day; }
export function dynSelfIsSelf() { const o = makeDynamic(); return o.self() === o ? 1 : 0; }
export function dynMethod() { return makeDynamic().label() === "Y18" ? 1 : 0; }
export function dynTypeofMethod() { return typeof makeDynamic().label === "function" ? 1 : 0; }
export function dynInstanceof() { return makeDynamic() instanceof C ? 1 : 0; }
export function staticGetter() { return makeStatic().day; }
export function newGetter() { const o = new C(); slots.set(o, { day: 18 }); return o.day; }

/** \`Object.create(<an instance>)\` must stay a plain object inheriting from it. */
export function createOnInstanceStaysPlain() {
  const base = makeDynamic();
  const derived = Object.create(base);
  return derived === base ? 0 : 1;
}
/** \`Object.create(null)\` and \`Object.create(<plain object>)\` are untouched. */
export function createNullStillPlain() {
  const o = Object.create(null);
  o.a = 5;
  return o.a;
}
export function createPlainStillLinks() {
  const p = { a: 7 };
  const o = Object.create(p);
  return Object.getPrototypeOf(o) === p ? 1 : 0;
}
`;

/** Probe → expected answer. Every probe answers a NUMBER: a standalone string is a WasmGC array. */
const EXPECTED: Record<string, number> = {
  dynGetter: 18,
  dynSelfIsSelf: 1,
  dynMethod: 1,
  dynTypeofMethod: 1,
  dynInstanceof: 1,
  staticGetter: 18,
  newGetter: 18,
  createOnInstanceStaysPlain: 1,
  createNullStillPlain: 5,
  createPlainStillLinks: 1,
};

async function instantiateStandalone(source: string): Promise<Record<string, () => unknown>> {
  const entry = "/main.js";
  const result = await compileMulti({ [entry]: source }, entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...STANDALONE,
  } as never);
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const imports = (result.importObject ?? {}) as WebAssembly.Imports & {
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Record<string, () => unknown>;
}

describe("#6464 Object.create(<value>.prototype) on the standalone lane", () => {
  it("produces a compiled instance whose members bind the created object", { timeout: 300_000 }, async () => {
    const exports = await instantiateStandalone(SOURCE);
    const observed: Record<string, unknown> = {};
    for (const name of Object.keys(EXPECTED)) {
      try {
        observed[name] = exports[name]?.();
      } catch (error) {
        observed[name] = `THREW: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    expect(observed).toEqual(EXPECTED);
  });
});

describe("#6464 byte neutrality", () => {
  // The mechanism is reserved only at a standalone `Object.create` site whose
  // prototype argument is not the syntactic `<ClassIdentifier>.prototype` fast
  // path. A module without one must not gain the dispatcher, and the `gc` lane
  // must not gain it at all.
  const NO_DYNAMIC_CREATE = `
    class C { constructor(d) { this.d = d; } get day() { return this.d; } }
    export function f() { return new C(3).day; }
    export function g() { return Object.create(C.prototype).day; }
  `;

  it("emits no dispatcher for a standalone module with no dynamic Object.create", async () => {
    const result = await compile(NO_DYNAMIC_CREATE, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      fileName: "/n.ts",
      ...STANDALONE,
    } as never);
    expect(result.success).toBe(true);
    expect(result.wat ?? "").not.toContain("__standalone_object_create_class_instance");
  });

  it("emits no dispatcher on the gc lane, dynamic Object.create or not", async () => {
    const result = await compile(SOURCE, { allowJs: true, skipSemanticDiagnostics: true, fileName: "/g.ts" } as never);
    expect(result.success).toBe(true);
    expect(result.wat ?? "").not.toContain("__standalone_object_create_class_instance");
  });
});
