// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3522 W1-B) A CALL to a `PrivateIdentifier`-named instance method compiles
// once, through the same bounded class-member family that W1-A opened for the
// declaration.
//
// W1-A (PR #5545) admitted the private method's own body; every CALL SITE stayed
// on the legacy route, which cost the caller AND — through component sealing —
// its class's implicit constructor. Measured on `origin/main` 744203f3c7, both
// lanes, through the production `compile` seam:
//
//   class Animal { #doubled() {…}  reveal() { return this.#doubled(); } }
//     Animal___priv_doubled -> emitted                       (W1-A)
//     Animal_reveal         -> body-shape-rejected @select   (this slice)
//     Animal_new            -> late-preparation-unsupported  (falls out with it)
//
// Three sites moved together here:
//   S1 `select.ts` — a dedicated private-method-call arm BEFORE the
//      identifier-name gate in the generic method-call block. That gate's bare
//      `return false` was the refusal above (the shape diagnostic names no arm).
//   S3 `select.ts::classElementMayName` — an own private member now "names" its
//      own mangled name, so it SHADOWS an inherited descriptor of the same
//      projected name. Private names are per-class: `B`'s `#m` and `A`'s `#m`
//      are different members, and without this the parent walk resolves `A`'s.
//   S5 `from-ast.ts::lowerMethodCall` — accept the private spelling instead of
//      demoting POST-CLAIM ("malformed method call"), and mint `__priv_<x>`
//      via the existing `irPrivateFieldName`, which is the descriptor key
//      W1-A's slot already carries.
//
// Every positive assertion runs with the direct class-body emitter POISONED for
// the named slots, so a hidden direct compile followed by an IR patch cannot
// satisfy it. W1-A's file owns the control that proves the poison seam is live.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;
type Target = (typeof TARGETS)[number];

function outcome(result: CompileResult, displayName: string): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter((candidate) => candidate.displayName === displayName);
  expect(observed, `terminal outcome count for ${displayName}`).toHaveLength(1);
  return observed[0]!;
}

function outcomeCode(result: CompileResult, displayName: string): string {
  const observed = outcome(result, displayName);
  return observed.kind === "emitted" ? "emitted" : ((observed as { code?: string }).code ?? observed.kind);
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

/** Compile with the direct class-body emitter poisoned for the named slots. */
async function compilePoisoned(
  source: string,
  fileName: string,
  target: Target,
  classBodies: readonly string[],
): Promise<CompileResult> {
  const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
  try {
    process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = classBodies.join(",");
    return await compile(source, {
      fileName,
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
      ...(target === "standalone" ? { target: "standalone" as const } : {}),
    });
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
    else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
  }
}

/** Compile with no poison at all — the ordinary production path. */
async function compilePlain(source: string, fileName: string, target: Target): Promise<CompileResult> {
  return compile(source, {
    fileName,
    experimentalIR: true,
    trackIrOutcomes: true,
    emitWat: true,
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
  });
}

function expectIrOwned(result: CompileResult, names: readonly string[]): void {
  for (const name of names) {
    expect(outcome(result, name), `${name} must be prepared IR`).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.irCompiledFuncs ?? [], `${name} must carry genuine IR emission`).toContain(name);
  }
}

function expectDirectOwned(result: CompileResult, names: readonly string[]): void {
  for (const name of names) {
    expect(outcome(result, name), `${name} must stay on the direct route`).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Fixtures. Every expected value was cross-checked in node.
// ---------------------------------------------------------------------------

// node: 84. The call site this slice is about — a sibling method calls the
// private one, so the private BODY produces the answer and the caller's own
// body is the thing that had to be claimed.
const CALLED_FROM_SIBLING = `class Animal {
  #secret: number = 42;
  #doubled(): number { return this.#secret * 2; }
  reveal(): number { return this.#doubled(); }
}
export function run(): number { return new Animal().reveal(); }
`;

// node: 3. Two private methods, each called from the same public method: the
// mangled names must resolve to two distinct slots, not one shared entry.
const TWO_PRIVATE_CALLS = `class Animal {
  #a: number = 1;
  #b: number = 2;
  #first(): number { return this.#a; }
  #second(): number { return this.#b; }
  reveal(): number { return this.#first() + this.#second(); }
}
export function run(): number { return new Animal().reveal(); }
`;

// node: 2. `B`'s own `#m` must win over the INHERITED public `A.m`. The two
// runtime names differ (`__priv_m` vs `m`), so a wrong resolution answers 1.
const INHERITED_SHADOW = `class A {
  m(): number { return 1; }
}
class B extends A {
  #m(): number { return 2; }
  f(): number { return this.#m(); }
}
export function run(): number { return new B().f(); }
`;

// node: 42. Called from the CONSTRUCTOR. The constructor stays on the legacy
// route — see the boundary test below for why that is not this slice's to move.
const CALLED_FROM_CTOR = `class Animal {
  #secret: number = 42;
  seen: number = 0;
  constructor() { this.seen = this.#privateMethod(); }
  #privateMethod(): number { return this.#secret; }
}
export function run(): number { return new Animal().seen; }
`;

// The public twin of the fixture above: identical shape, identical refusal.
const CTOR_CALLS_PUBLIC = `class Animal {
  secret: number = 42;
  seen: number = 0;
  constructor() { this.seen = this.publicMethod(); }
  publicMethod(): number { return this.secret; }
}
export function run(): number { return new Animal().seen; }
`;

// node: 1 (a zero-parameter method ignores the extra argument; JS does not
// throw). The IR has no such tolerance, so selection must refuse the call.
const ARITY_MISMATCH = `class Animal {
  #a: number = 1;
  #m(): number { return this.#a; }
  reveal(): number { return this.#m(1); }
}
export function run(): number { return new Animal().reveal(); }
`;

// node: 8. STATIC private methods are out of scope (W1-A left them without a
// descriptor), so `Animal.#make()` must stay refused and legacy-owned.
const STATIC_PRIVATE_CALL = `class Animal {
  #a: number = 1;
  static #make(): number { return 7; }
  static build(): number { return Animal.#make(); }
  reveal(): number { return this.#a; }
}
export function run(): number { return Animal.build() + new Animal().reveal(); }
`;

// node: 2. `B`'s own `#m` is a GENERATOR, so it has no method descriptor, while
// `A`'s `#m` — a DIFFERENT private name — does. This is the shape S3 exists for.
const GENERATOR_SHADOW = `class A {
  #m(): number { return 1; }
  a(): number { return this.#m(); }
}
class B extends A {
  *#m(): Generator<number> { yield 2; }
  f(): number { return this.#m().next().value as number; }
}
export function run(): number { return new B().f(); }
`;

describe("#3522 W1-B private-method call sites compile once", () => {
  // (a) The slice's headline row. Red on `origin/main` 744203f3c7, where
  // `Animal_reveal` is `body-shape-rejected` and `Animal_new` is
  // `late-preparation-unsupported`.
  it.each(TARGETS)("claims the calling sibling, the callee and the constructor on %s", async (target) => {
    const result = await compilePoisoned(CALLED_FROM_SIBLING, `w1b-sibling-${target}.ts`, target, [
      "Animal___priv_doubled",
      "Animal_reveal",
      "Animal_new",
    ]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectIrOwned(result, ["Animal___priv_doubled", "Animal_reveal", "Animal_new"]);

    // The constructor's sealing note is GONE: it only existed because the
    // sibling was a non-candidate terminal (W1-A measured it, this slice
    // removes its cause).
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect((await instantiate(result)).run!()).toBe(84);
  });

  // (c) Two private methods called from one public method.
  it.each(TARGETS)("gives two called private methods distinct slots on %s", async (target) => {
    const result = await compilePoisoned(TWO_PRIVATE_CALLS, `w1b-two-${target}.ts`, target, [
      "Animal___priv_first",
      "Animal___priv_second",
      "Animal_reveal",
      "Animal_new",
    ]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectIrOwned(result, ["Animal___priv_first", "Animal___priv_second", "Animal_reveal", "Animal_new"]);

    const privateRows = (result.irOutcomes ?? []).filter((row) => row.displayName.includes("__priv_"));
    expect(new Set(privateRows.map((row) => row.unitId)).size, "distinct unit ids").toBe(2);
    expect((await instantiate(result)).run!()).toBe(3);
  });

  // (d) S3's pin. `B.#m` and the inherited `A.m` project to different runtime
  // names, and the answer discriminates them: 2 is B's own body, 1 is A's.
  //
  // The WAT proof the plan asked for is behavioural rather than textual here:
  // this emitter prints call targets as function INDICES (`return_call 2`), not
  // as `call $B___priv_m`, so a name grep on the body cannot state which slot
  // was called. Poisoning both direct bodies and reading the answer can.
  it.each(TARGETS)("resolves an own private method over an inherited public one on %s", async (target) => {
    const result = await compilePoisoned(INHERITED_SHADOW, `w1b-shadow-${target}.ts`, target, ["B___priv_m", "B_f"]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectIrOwned(result, ["B___priv_m", "B_f"]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect((await instantiate(result)).run!()).toBe(2);
  });

  // (g) No new dispatch, cast or boxing surface in the caller.
  it.each(TARGETS)("emits a direct call with no cast or boxing surface on %s", async (target) => {
    const result = await compilePoisoned(CALLED_FROM_SIBLING, `w1b-wat-${target}.ts`, target, [
      "Animal___priv_doubled",
      "Animal_reveal",
    ]);
    expect(result.success).toBe(true);
    const wat = result.wat ?? "";
    const start = wat.indexOf("(func $Animal_reveal");
    expect(start, "the calling sibling must be present in WAT").toBeGreaterThanOrEqual(0);
    const next = wat.indexOf("\n  (func $", start + 1);
    const body = wat.slice(start, next < 0 ? wat.length : next);
    for (const forbidden of ["call_ref", "call_indirect", "ref.test", "__box_number", "__call_m_"]) {
      expect(body, `${forbidden} must not appear in the claimed caller`).not.toContain(forbidden);
    }
    expect(body, "the private call must lower to a static call").toMatch(/\b(return_call|call) \d+/);
  });
});

describe("#3522 W1-B guards and out-of-scope boundaries", () => {
  // (e) Arity is checked at SELECT, so the call never reaches a post-claim
  // demote. On base this shape was refused too, by the unattributed
  // `body-shape-rejected` arm; the guard is what keeps it refused now that the
  // private spelling is admitted.
  it.each(TARGETS)("refuses an arity-mismatched private call at select on %s", async (target) => {
    const result = await compilePlain(ARITY_MISMATCH, `w1b-arity-${target}.ts`, target);
    expect(result.success).toBe(true);
    expect(outcomeCode(result, "Animal_reveal")).toBe("call-arity-unsupported");
    expectDirectOwned(result, ["Animal_reveal"]);
    // The refusal is a SELECT verdict, so the only post-claim entry is the
    // pre-existing implicit-constructor sealing note that any non-candidate
    // sibling produces (W1-A measured the identical note).
    const postClaim = result.irPostClaimErrors ?? [];
    expect(postClaim).toHaveLength(1);
    expect(postClaim[0]).toMatchObject({ kind: "build", func: "Animal_new" });
    expect(postClaim[0]!.message).toContain("has incomplete dependencies");
    expect((await instantiate(result)).run!()).toBe(1);
  });

  // (f) STATIC private methods are the `select-identity` / `buildIrClassShapes`
  // static defer's, not this slice's. The declaration keeps its W1-A verdict;
  // the call site is refused for the same reason (no static descriptor), which
  // moves it off the unattributed shape arm and onto the member arm.
  it.each(TARGETS)("keeps a static private call refused and legacy-owned on %s", async (target) => {
    const result = await compilePlain(STATIC_PRIVATE_CALL, `w1b-static-${target}.ts`, target);
    expect(result.success).toBe(true);
    expect(outcomeCode(result, "Animal___priv_make")).toBe("class-member-unsupported");
    expect(outcomeCode(result, "Animal_build")).toBe("class-member-unsupported");
    expectDirectOwned(result, ["Animal___priv_make", "Animal_build"]);
    expect((await instantiate(result)).run!()).toBe(8);
  });

  // S3's non-vacuity, stated as a guard: `B`'s own generator `#m` has no method
  // descriptor and `A`'s `#m` is a DIFFERENT private name, so the call must be
  // refused at SELECT. With `classElementMayName` reverted the selector CLAIMS
  // this and from-ast demotes it post-claim (measured on this branch), which is
  // the failure class the slice must not introduce.
  it.each(TARGETS)("refuses a private call whose own member has no descriptor on %s", async (target) => {
    const result = await compilePlain(GENERATOR_SHADOW, `w1b-gen-shadow-${target}.ts`, target);
    expect(result.success).toBe(true);
    expect(outcomeCode(result, "B___priv_m")).toBe("class-member-unsupported");
    expect(outcomeCode(result, "B_f")).toBe("class-member-unsupported");
    expectDirectOwned(result, ["B_f"]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect((await instantiate(result)).run!()).toBe(2);
  });

  // (b) The constructor boundary, stated as a characterization rather than a
  // claim. An EXPLICIT constructor that calls any instance method is refused by
  // `constructorHasIrSafeReceiverSemantics` (`select.ts`, the
  // `hasReceiverDerivedCall` branch) — measured identical for the PUBLIC twin
  // on this same branch, so no W1-B site could move it. The callee is still
  // IR-owned and still produces the answer.
  it.each(TARGETS)("leaves a constructor that calls a method direct, private or not, on %s", async (target) => {
    // No poison here: the direct route still has to emit the private method's
    // body for the DIRECT constructor to call, so poisoning that slot fails the
    // compile outright. `legacyBodyEmitted: false` below is the ownership
    // evidence instead.
    const priv = await compilePlain(CALLED_FROM_CTOR, `w1b-ctor-${target}.ts`, target);
    expect(priv.success, priv.errors.map((e) => e.message).join("\n")).toBe(true);
    // The private method IS IR-emitted, but the direct route ALSO emits its
    // body — the legacy constructor calls that slot, so it cannot be skipped.
    // That compile-twice residue is the constructor's, and it disappears with
    // the constructor, not with the call-site sites in this slice.
    expect(priv.irCompiledFuncs ?? []).toContain("Animal___priv_privateMethod");
    expect(outcome(priv, "Animal___priv_privateMethod")).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
      legacyBodyEmitted: true,
    });
    expect(outcomeCode(priv, "Animal_new")).toBe("body-shape-rejected");
    expectDirectOwned(priv, ["Animal_new"]);
    expect((await instantiate(priv)).run!()).toBe(42);

    const publicTwin = await compilePlain(CTOR_CALLS_PUBLIC, `w1b-ctor-public-${target}.ts`, target);
    expect(publicTwin.success).toBe(true);
    expect(outcomeCode(publicTwin, "Animal_new")).toBe("body-shape-rejected");
    expect((await instantiate(publicTwin)).run!()).toBe(42);
  });
});
