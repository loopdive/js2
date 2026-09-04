// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3522 W1-C) `super.<accessor>` — a READ and a WRITE of a parent accessor
// from inside a derived method — compiles once, through the same bounded class
// family W1-A (the private-method declaration) and W1-B (its call sites) opened.
//
// `super` is a KEYWORD, not an expression. `isPhase1Expr` has explicit arms for
// `super(...)` and `super.m(...)` for exactly that reason; a BARE `super.<name>`
// is an ordinary `PropertyAccessExpression` and fell through to the generic
// receiver check, which ends in `isPhase1Expr(<SuperKeyword>)` and answers
// `false`. Measured on `origin/main` 5c90d7069a, both lanes, on the annotated
// twin of `tests/dogfood/corpus/classes.js`:
//
//   Dog_speak  (`super.label` read)   body-shape-rejected @select
//                                     arm `expr-unhandled:SuperKeyword`
//   Dog_rename (`super.label = v`)    body-shape-rejected @select, same arm
//   Animal_new / Dog_new / Animal_make
//                                     late-preparation-unsupported @resolve —
//                                     sealing collateral of the two rows above,
//                                     NOT a constructor defect
//
// Five sites moved together:
//   S0 `nodes.ts` / `builder.ts` / `lower.ts` — `class.super_call` gains
//      `memberKind`, the field `class.call` has threaded since #3144. Absent
//      still means `"method"`, so every pre-#3522 producer resolves the exact
//      slot it always did; `"getter"` / `"setter"` reach `<Parent>_get_<p>` /
//      `<Parent>_set_<p>` through the SAME `IrClassLowering.memberFunc` the
//      `this.prop` accessor arm uses. A member kind, not a new instruction.
//   S1 `select.ts` — a `SuperKeyword`-receiver arm in the property-access
//      block, gated on `superAccessorProjection` (parent-chain accessor walk).
//   S2 `select.ts` — the same arm on all THREE reachable `super.<p> = v`
//      statement positions (non-tail, void-tail, nested-body), plus a named
//      refusal for the compound / update forms this slice does not ship.
//   S3 `from-ast.ts::lowerPropertyAccess` — intercept before receiver lowering,
//      resolve the getter on `parentShape`, emit `class.super_call`.
//   S4 `from-ast.ts::lowerPropertyAssignment` — the setter twin.
//
// Every positive assertion runs with the direct class-body emitter POISONED for
// the named slots, so a hidden direct compile followed by an IR patch cannot
// satisfy it.
//
// This file runs with `JS2WASM_IR_SHAPE_DIAG=1` so the REFUSAL rows can assert
// the reject ARM by name, not just the reason bucket — the arm label is what
// keeps these shapes out of the anonymous `body-shape-rejected` pile, and it is
// only populated under that flag. The flag is documented byte-identical for
// emission (it only records a label a discarded walk already computed), and the
// compiler modules are therefore loaded by dynamic import BELOW the assignment:
// `SHAPE_DIAG_ON` in `select.ts` is a module-load-time constant, so a static
// import would read the flag before this line runs.

import { describe, expect, it } from "vitest";

process.env.JS2WASM_IR_SHAPE_DIAG = "1";

const { compile } = await import("../src/index.js");
const { buildImports } = await import("../src/runtime.js");
const { createIrClassId } = await import("../src/ir/identity.js");
const { lowerIrFunctionToWasm } = await import("../src/ir/lower.js");
const { createTestIrFunctionIdentityFactory } = await import("./helpers/ir-identities.js");
type IrLowerResolver = import("../src/ir/lower.js").IrLowerResolver;
type IrClassLowering = import("../src/ir/lower.js").IrClassLowering;
type IrClassShape = import("../src/ir/nodes.js").IrClassShape;
type IrFuncRef = import("../src/ir/nodes.js").IrFuncRef;
type IrFunction = import("../src/ir/nodes.js").IrFunction;
type IrBlockId = import("../src/ir/nodes.js").IrBlockId;
type IrValueId = import("../src/ir/nodes.js").IrValueId;
type CompileResult = Awaited<ReturnType<typeof compile>>;
type IrObservedOutcome = NonNullable<CompileResult["irOutcomes"]>[number];

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

/**
 * The proximate reject arm recorded by `shapeNo` (`<arm>:<NodeKind>`).
 *
 * Only populated for the `body-shape-rejected` bucket: `planIrCompilation`
 * attaches `takeShapeRejectDetail()` exclusively when the reason IS that
 * bucket (a capability code is its own attribution, so the arm is not
 * re-published). So the two `class-member-unsupported` guards below assert the
 * CODE, and their arm (`super-property-not-accessor`) is recorded in the issue
 * file from a `JS2WASM_IR_SHAPE_DIAG` probe instead of here.
 */
function rejectArm(result: CompileResult, displayName: string): string {
  return (outcome(result, displayName) as { detail?: string }).detail ?? "<no detail>";
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(exports);
  return exports;
}

/**
 * Two extra exports that read `run()`'s string result one code unit at a time.
 *
 * The STANDALONE lane represents a string as a WasmGC `i16` array, so `run()`
 * hands back a ref rather than a JS string — measured, and true of
 * `super.method()` on base too, so it is a lane property and not this slice's.
 * The `length`/`charCodeAt` read-back is the pattern the existing standalone
 * suites use (`tests/es5-standalone-primitive-tail.test.ts`).
 */
const STRING_READBACK = `
export function __len(): number { return run().length; }
export function __at(i: number): number { return run().charCodeAt(i); }
`;

/** `run()`'s string answer on either lane. */
async function runStringResult(result: CompileResult): Promise<string> {
  const exports = await instantiate(result);
  const direct = exports.run!();
  if (typeof direct === "string") return direct;
  const n = (exports.__len as () => number)();
  let out = "";
  for (let i = 0; i < n; i++) out += String.fromCharCode((exports.__at as (index: number) => number)(i));
  return out;
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

// ---------------------------------------------------------------------------
// Fixtures. Every expected value was cross-checked in node (`.tmp/node-answers.mjs`).
// ---------------------------------------------------------------------------

// node: "max barks". The annotated twin of `tests/dogfood/corpus/classes.js`,
// with the write twin (`rename`) added. Both `super.label` forms in one class.
const TWIN = `class Animal {
  static species: string = "generic";
  #secret: number = 42;
  legs: number = 0;
  name: string = "";
  constructor(name: string) { this.name = name; }
  get label(): string { return this.name; }
  set label(v: string) { this.name = v; }
  #privateMethod(): number { return this.#secret; }
  static make(n: string): Animal { return new Animal(n); }
}
class Dog extends Animal {
  constructor(name: string) { super(name); this.legs = 4; }
  speak(): string { return super.label + " barks"; }
  rename(v: string): void { super.label = v; }
}
export function run(): string { const d = new Dog("rex"); d.rename("max"); return d.speak(); }
`;

// node: "rex/dog". `Dog` OVERRIDES `get label`, so the two spellings must
// resolve to two different slots: `super.label` → `Animal_get_label`,
// `this.label` → `Dog_get_label`. Resolving `super` against the receiver's
// shape instead of the parent's would answer "dog/dog".
const OVERRIDE = `class Animal {
  name: string = "";
  constructor(name: string) { this.name = name; }
  get label(): string { return this.name; }
}
class Dog extends Animal {
  constructor(name: string) { super(name); }
  get label(): string { return "dog"; }
  fromSuper(): string { return super.label; }
  fromThis(): string { return this.label; }
}
export function run(): string { const d = new Dog("rex"); return d.fromSuper() + "/" + d.fromThis(); }
`;

// node: "max". The WRITE in NON-TAIL position, followed by a read — the shape
// that proves the statement-list walker's arm, not just the void-tail one.
const NON_TAIL_WRITE = `class Animal {
  name: string = "";
  constructor(name: string) { this.name = name; }
  get label(): string { return this.name; }
  set label(v: string) { this.name = v; }
}
class Dog extends Animal {
  constructor(name: string) { super(name); }
  renameAndRead(v: string): string { super.label = v; return super.label; }
}
export function run(): string { const d = new Dog("rex"); return d.renameAndRead("max"); }
`;

// node: "max". The WRITE nested inside an `if` block — `isPhase1BodyStatement`,
// a third walker with its own copy of the property-store arm.
const NESTED_WRITE = `class Animal {
  name: string = "";
  constructor(name: string) { this.name = name; }
  get label(): string { return this.name; }
  set label(v: string) { this.name = v; }
}
class Dog extends Animal {
  constructor(name: string) { super(name); }
  maybe(v: string, c: boolean): void { if (c) { super.label = v; } }
}
export function run(): string { const d = new Dog("rex"); d.maybe("max", true); return d.label; }
`;

// node: "undefined". The parent declares `label` as a FIELD, so `super.label`
// reads the PROTOTYPE, finds nothing, and is `undefined`. There is no accessor
// to static-dispatch to, so the selector must refuse — with a NAMED arm, or the
// shape hides in the anonymous bucket.
const PARENT_FIELD = `class Animal {
  label: string = "cat";
  constructor(label: string) { this.label = label; }
}
class Dog extends Animal {
  constructor(name: string) { super(name); }
  fromSuper(): string { return super.label; }
}
export function run(): string { return new Dog("rex").fromSuper(); }
`;

// node THROWS ("Cannot set property label of #<Animal> which has only a
// getter") — compile-only fixture. The parent has a GETTER but no setter, so a
// `super.label = v` write has no slot; the same arm as PARENT_FIELD refuses it.
const GETTER_ONLY_WRITE = `class Animal {
  name: string = "";
  constructor(name: string) { this.name = name; }
  get label(): string { return this.name; }
}
class Dog extends Animal {
  constructor(name: string) { super(name); }
  rename(v: string): void { super.label = v; }
}
export function run(): string { const d = new Dog("rex"); d.rename("max"); return d.label; }
`;

// node: "rex!". `super.label += "!"` is a read-modify-write needing TWO static
// dispatches around one value; out of scope for W1-C and named as such.
const COMPOUND = `class Animal {
  name: string = "";
  constructor(name: string) { this.name = name; }
  get label(): string { return this.name; }
  set label(v: string) { this.name = v; }
}
class Dog extends Animal {
  constructor(name: string) { super(name); }
  bang(): string { super.label += "!"; return this.name; }
}
export function run(): string { const d = new Dog("rex"); return d.bang(); }
`;

// The `++` twin of COMPOUND, on a numeric accessor. node: 2.
const UPDATE = `class Animal {
  n: number = 0;
  constructor(n: number) { this.n = n; }
  get size(): number { return this.n; }
  set size(v: number) { this.n = v; }
}
class Dog extends Animal {
  constructor(n: number) { super(n); }
  grow(): number { super.size++; return this.n; }
}
export function run(): number { const d = new Dog(1); return d.grow(); }
`;

// node: "". The parent is a BUILTIN (`Error`), which has no projected IR class
// shape at all — the parent-shape arm, not the member arm.
const EXTERN_PARENT = `class Boom extends Error {
  constructor(m: string) { super(m); }
  info(): string { return super.message; }
}
export function run(): string { return new Boom("x").info(); }
`;

describe("#3522 W1-C super accessor read and write compile once", () => {
  // (a) The slice's headline rows, plus the sealing collateral they were
  // holding down. Red on `origin/main` 5c90d7069a: both `Dog_*` rows are
  // `body-shape-rejected` and all three ctor/static rows are
  // `late-preparation-unsupported`.
  it.each(TARGETS)("claims both super-accessor methods and unseals the class on %s", async (target) => {
    const result = await compilePoisoned(TWIN, `w1c-twin-${target}.ts`, target, [
      "Dog_speak",
      "Dog_rename",
      "Animal_get_label",
      "Animal_set_label",
      "Animal_new",
      "Dog_new",
    ]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectIrOwned(result, [
      "Dog_speak",
      "Dog_rename",
      "Animal_get_label",
      "Animal_set_label",
      "Animal_new",
      "Dog_new",
      "Animal_make",
      "Animal___priv_privateMethod",
    ]);
    // (h) selector↔lowering parity: nothing this slice admits may be demoted
    // AFTER the claim.
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  // (b) It runs, and it agrees with node, with every direct body poisoned.
  it.each(TARGETS)("runs the twin to node's answer with direct bodies poisoned on %s", async (target) => {
    const result = await compilePoisoned(TWIN + STRING_READBACK, `w1c-twin-run-${target}.ts`, target, [
      "Dog_speak",
      "Dog_rename",
      "Animal_get_label",
      "Animal_set_label",
      "Animal_new",
      "Dog_new",
    ]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    await expect(runStringResult(result)).resolves.toBe("max barks");
  });

  // (c) The override pin — the whole reason the member resolves against
  // `parentShape` and not against the receiver's shape.
  it.each(TARGETS)("resolves super.<accessor> on the PARENT, bypassing an override on %s", async (target) => {
    const result = await compilePoisoned(OVERRIDE + STRING_READBACK, `w1c-override-${target}.ts`, target, [
      "Dog_fromSuper",
      "Dog_fromThis",
      "Animal_get_label",
      "Dog_get_label",
    ]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectIrOwned(result, ["Dog_fromSuper", "Dog_fromThis", "Animal_get_label", "Dog_get_label"]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    await expect(runStringResult(result)).resolves.toBe("rex/dog");
  });

  // The WRITE in the two statement positions the void-tail arm does not cover.
  it.each(TARGETS)("claims a non-tail super setter write on %s", async (target) => {
    const result = await compilePoisoned(NON_TAIL_WRITE + STRING_READBACK, `w1c-nontail-${target}.ts`, target, [
      "Dog_renameAndRead",
      "Animal_get_label",
      "Animal_set_label",
    ]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectIrOwned(result, ["Dog_renameAndRead", "Animal_get_label", "Animal_set_label"]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    await expect(runStringResult(result)).resolves.toBe("max");
  });

  it.each(TARGETS)("claims a super setter write nested in an if-block on %s", async (target) => {
    const result = await compilePoisoned(NESTED_WRITE + STRING_READBACK, `w1c-nested-${target}.ts`, target, [
      "Dog_maybe",
      "Animal_get_label",
      "Animal_set_label",
    ]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectIrOwned(result, ["Dog_maybe", "Animal_get_label", "Animal_set_label"]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    await expect(runStringResult(result)).resolves.toBe("max");
  });

  // No new dispatch, cast or boxing surface: a super accessor is ONE static
  // call, exactly like `super.method()`.
  it.each(TARGETS)("emits a static call with no dispatch or boxing surface on %s", async (target) => {
    const result = await compilePoisoned(TWIN, `w1c-wat-${target}.ts`, target, ["Dog_speak"]);
    expect(result.success).toBe(true);
    const wat = result.wat ?? "";
    const start = wat.indexOf("(func $Dog_speak");
    expect(start, "the claimed reader must be present in WAT").toBeGreaterThanOrEqual(0);
    const next = wat.indexOf("\n  (func $", start + 1);
    const body = wat.slice(start, next < 0 ? wat.length : next);
    for (const forbidden of ["call_ref", "call_indirect", "ref.test", "__box_number", "__call_m_"]) {
      expect(body, `${forbidden} must not appear in the claimed reader`).not.toContain(forbidden);
    }
    expect(body, "the super getter must lower to a static call").toMatch(/\b(return_call|call) \d+/);
  });
});

describe("#3522 W1-C guards and out-of-scope boundaries", () => {
  // (d) An own FIELD of that name on the parent shadows nothing to dispatch to
  // — `super.<field>` is `undefined` in JS. Refused, and the arm is named so
  // the shape stays visible in the histogram.
  it.each(TARGETS)("refuses super.<field> with a typed capability code on %s", async (target) => {
    const result = await compilePlain(PARENT_FIELD, `w1c-field-${target}.ts`, target);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    // On `origin/main` 5c90d7069a this row is `body-shape-rejected` under the
    // anonymous `expr-unhandled:SuperKeyword` arm; the typed code IS the move,
    // and asserting it excludes the base state.
    expect(outcomeCode(result, "Dog_fromSuper")).toBe("class-member-unsupported");
    expect(outcome(result, "Dog_fromSuper")).toMatchObject({ legacyBodyEmitted: true, irBodyEmitted: false });
  });

  // (e) A getter with no setter has no write slot. Same arm, `"setter"` kind.
  // Green on base too — but on base via `expr-class-property-write-member`
  // (the checker resolves `super`'s STATIC type to `Animal`, so the ordinary
  // property-write preflight answered first). This slice puts it on the
  // super-specific arm; the reason code is deliberately the same one.
  it.each(TARGETS)("refuses a super write with no parent setter on %s", async (target) => {
    const result = await compilePlain(GETTER_ONLY_WRITE, `w1c-getteronly-${target}.ts`, target);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(outcomeCode(result, "Dog_rename")).toBe("class-member-unsupported");
    expect(outcome(result, "Dog_rename")).toMatchObject({ legacyBodyEmitted: true, irBodyEmitted: false });
  });

  // (f) Compound and update forms need two static dispatches around one
  // read-modify-write; W1-C ships the single-dispatch read and write only.
  //
  // NOT run here: `super.<string accessor> += "!"` is a PRE-EXISTING legacy
  // miscompile — the module fails to instantiate with `f64.add[0] expected type
  // f64, found block of type externref` on BOTH lanes, at byte-identical
  // offsets on base and on this branch, and identically with
  // `experimentalIR: false`. It is a direct-route defect, not this slice's; the
  // numeric `++` twin below carries the behavioural assertion.
  it.each(TARGETS)("refuses super.<accessor> += with a named arm on %s", async (target) => {
    const result = await compilePlain(COMPOUND, `w1c-compound-${target}.ts`, target);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(outcomeCode(result, "Dog_bang")).toBe("body-shape-rejected");
    expect(rejectArm(result, "Dog_bang")).toBe("super-property-compound:PropertyAccessExpression");
    expect(outcome(result, "Dog_bang")).toMatchObject({ legacyBodyEmitted: true, irBodyEmitted: false });
  });

  it.each(TARGETS)("refuses super.<accessor>++ with the same named arm on %s", async (target) => {
    const result = await compilePlain(UPDATE, `w1c-update-${target}.ts`, target);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(outcomeCode(result, "Dog_grow")).toBe("body-shape-rejected");
    expect(rejectArm(result, "Dog_grow")).toBe("super-property-compound:PropertyAccessExpression");
    expect((await instantiate(result)).run!()).toBe(2);
  });

  // (g) A builtin parent has no projected shape at all. `Boom_info` must stay
  // refused and legacy-owned; the answer is unchanged from base.
  it.each(TARGETS)("refuses a super accessor on a builtin parent on %s", async (target) => {
    const result = await compilePlain(EXTERN_PARENT, `w1c-extern-${target}.ts`, target);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(outcomeCode(result, "Boom_info")).toBe("class-member-unsupported");
    expect(outcome(result, "Boom_info")).toMatchObject({ legacyBodyEmitted: true, irBodyEmitted: false });
  });

  // `super.method()` is a DIFFERENT arm (the call block), and S0's absent
  // `memberKind` must keep it on the `<Parent>_<method>` slot. Pinned here
  // beside the accessor rows so a future kind change cannot silently move it.
  it.each(TARGETS)("leaves super.method() on the method slot on %s", async (target) => {
    const source = `class Animal {
  name: string = "";
  constructor(name: string) { this.name = name; }
  describe(): string { return this.name; }
}
class Dog extends Animal {
  constructor(name: string) { super(name); }
  describe(): string { return "dog:" + super.describe(); }
}
export function run(): string { return new Dog("rex").describe(); }
`;
    const result = await compilePoisoned(source + STRING_READBACK, `w1c-method-${target}.ts`, target, [
      "Dog_describe",
      "Animal_describe",
    ]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectIrOwned(result, ["Dog_describe", "Animal_describe"]);
    await expect(runStringResult(result)).resolves.toBe("dog:rex");
  });
});

// ---------------------------------------------------------------------------
// S0 — the `memberKind` payload, pinned where it is OBSERVABLE.
//
// Reverting S0 alone leaves all 24 assertions above GREEN and every emitted
// binary byte-identical across 22 compiles (11 fixtures x 2 lanes, including a
// three-level inheritance chain). The reason is `IrClassLowering.memberFunc`:
// its FIRST act is `preparedMemberTarget(target)`, which returns the exact
// symbolic callable and never consults the kind. Every `class.super_call` this
// slice emits carries such a target — `prepared-component-dependencies.ts`
// records `class-member-callable-unavailable` and refuses the component if it
// does not — so on the production path the kind is DESCRIPTIVE, exactly as it
// already is for `class.call` (#3144), not load-bearing.
//
// It is still shipped, because without it the instruction would tell every
// consumer that an accessor dispatch is a `"method"` dispatch, and
// `memberFunc`'s name-resolution fallback would compute `Animal_label` instead
// of `Animal_get_label` the moment a target is absent. That is a latent wrong
// NAME, not merely an unexercised widening — so it is pinned here at the one
// seam where it is observable: the resolver call `lower.ts` makes.
// ---------------------------------------------------------------------------

const s0Identities = createTestIrFunctionIdentityFactory("issue-3522-super-accessor");

const S0_PARENT: IrClassShape = {
  classId: createIrClassId({ ownerId: s0Identities.sourceId, path: "root", kind: "declaration", ordinal: 0 }),
  className: "Animal",
  fields: [],
  methods: [],
  constructorParams: [],
};

function superCallFunction(memberKind?: "method" | "getter" | "setter"): IrFunction {
  const self = 0 as IrValueId;
  const result = 1 as IrValueId;
  return {
    ...s0Identities.next(`w1c_s0_${memberKind ?? "absent"}`),
    params: [{ value: self, type: { kind: "class", shape: S0_PARENT }, name: "this" }],
    resultTypes: [{ kind: "val", val: { kind: "f64" } }],
    exported: false,
    valueCount: 2,
    blocks: [
      {
        id: 0 as IrBlockId,
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "class.super_call",
            parentShape: S0_PARENT,
            receiver: self,
            methodName: "label",
            ...(memberKind ? { memberKind } : {}),
            args: [],
            result,
            resultType: { kind: "val", val: { kind: "f64" } },
          },
        ],
        terminator: { kind: "return", values: [result] },
      },
    ],
  } as IrFunction;
}

/** Records every `memberFunc(kind, name)` the lowering asks the resolver for. */
function recordingResolver(seen: string[]): IrLowerResolver {
  let nextType = 0;
  const runtimeRef = (name: string): IrFuncRef => ({ name, binding: { kind: "runtime" } }) as unknown as IrFuncRef;
  const lowering = {
    structTypeIdx: 7,
    fieldIdx: () => 0,
    constructorFunc: runtimeRef("Animal_new"),
    initFunc: runtimeRef("Animal_init"),
    instanceOfTags: [],
    memberFunc: (kind: string, name: string): IrFuncRef => {
      seen.push(`${kind}:${name}`);
      return runtimeRef(`Animal_${kind}_${name}`);
    },
  } as unknown as IrClassLowering;
  return {
    resolveFunc: () => 3,
    resolveGlobal: () => {
      throw new Error("resolveGlobal is not used by this lowering");
    },
    resolveType: () => 7,
    internFuncType: () => nextType++,
    resolveClass: () => lowering,
  } as unknown as IrLowerResolver;
}

describe("#3522 W1-C class.super_call member kind", () => {
  it.each([
    [undefined, "method:label"],
    ["method" as const, "method:label"],
    ["getter" as const, "getter:label"],
    ["setter" as const, "setter:label"],
  ])("resolves the parent slot for memberKind=%s", (memberKind, expected) => {
    const seen: string[] = [];
    lowerIrFunctionToWasm(superCallFunction(memberKind), recordingResolver(seen));
    expect(seen).toEqual([expected]);
  });
});
