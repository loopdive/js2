// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3522 W1-A) A `PrivateIdentifier`-named instance METHOD DECLARATION compiles
// once, through the ordinary bounded class-member family.
//
// Measured on `origin/main` 2510fae02, through the production `compile` seam
// (`experimentalIR: true, trackIrOutcomes: true`), on both lanes:
//
//   class Animal { #secret: number = 42; #privateMethod(): number { … } … }
//     -> Animal_<computed> = class-method @select   (legacy body, IR refused)
//
// Three sites produced that row and had to move together, or the row merely
// shifts arm and claims nothing:
//   1. `src/ir/identity.ts::memberBaseName`     — minted the display and legacy
//      match name `<computed>` for EVERY private member;
//   2. `src/ir/select.ts::phase1MemberName`     — returned null, so
//      `select-identity.ts` stamped `class-method` before any descriptor was
//      consulted;
//   3. the method-descriptor loop in `buildIrClassShapes`
//      (`src/codegen/index.ts`) — skipped the member, so no descriptor existed.
//
// The name is `__priv_<x>`, which is NOT a new convention: it is byte-identical
// to what `class-bodies.ts::resolveClassMemberName` and the field re-derivation
// in `buildIrClassShapes` already mint, so the selected member matches the same
// legacy `ctx.funcMap` key the direct route would have used.
//
// The `<computed>`-for-everything naming ALSO carried a latent collision: two
// private methods in one class shared one legacy match name and one entry in
// the selection set. Inert while both were refused; a silently dropped body the
// moment either is admitted. `s01`/`s02` below pin that closed.
//
// Every positive assertion runs with the direct class/function body emitters
// POISONED, so a hidden direct compile followed by an IR patch cannot satisfy
// it; a control proves the poison seam is live.

import { readFileSync } from "node:fs";

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

function displayNames(result: CompileResult): readonly string[] {
  return (result.irOutcomes ?? []).map((candidate) => candidate.displayName);
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

/**
 * Compile with the direct class/function body emitters poisoned for the named
 * slots, so no positive assertion below can be satisfied by a direct compile
 * that an IR patch later overwrote.
 */
async function compilePoisoned(
  source: string,
  fileName: string,
  target: Target,
  classBodies: readonly string[],
  functionBodies: readonly string[] = [],
): Promise<CompileResult> {
  const previousClass = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
  const previousFunction = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
  try {
    process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = classBodies.join(",");
    process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = functionBodies.join(",");
    return await compile(source, {
      fileName,
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
      ...(target === "standalone" ? { target: "standalone" as const } : {}),
    });
  } finally {
    if (previousClass === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
    else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previousClass;
    if (previousFunction === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
    else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousFunction;
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

/**
 * The pre-existing post-claim entry for a class whose implicit constructor
 * cannot seal because a sibling method is a non-candidate terminal. Measured
 * identical on `origin/main` 2510fae02 with this slice reverted, on both lanes.
 */
function expectPreExistingCtorSealingNote(result: CompileResult): void {
  const postClaim = result.irPostClaimErrors ?? [];
  expect(postClaim).toHaveLength(1);
  expect(postClaim[0]).toMatchObject({ kind: "build", func: "Animal_new" });
  expect(postClaim[0]!.message).toContain("has incomplete dependencies");
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

// node: 42. The private method is DECLARED and never called — the census shape
// (`classes.js:8`), which costs exactly one unit and cascades into nothing.
const DECLARED_ONLY = `class Animal {
  #secret: number = 42;
  #privateMethod(): number { return this.#secret; }
  reveal(): number { return this.#secret; }
}
export function run(): number { return new Animal().reveal(); }
`;

// node: 84. The private method is CALLED from a sibling, so its body is what
// produces the answer — a declaration-only fixture could not prove the IR body
// RUNS. The caller and the constructor keep their pre-slice deferral (the
// call-site lowering is the NEXT slice); the callee is IR-owned.
const CALLED_FROM_SIBLING = `class Animal {
  #secret: number = 42;
  #doubled(): number { return this.#secret * 2; }
  reveal(): number { return this.#doubled(); }
}
export function run(): number { return new Animal().reveal(); }
`;

// node: 42. Called from the CONSTRUCTOR — the other call-site boundary.
const CALLED_FROM_CTOR = `class Animal {
  #secret: number = 42;
  seen: number = 0;
  constructor() { this.seen = this.#privateMethod(); }
  #privateMethod(): number { return this.#secret; }
}
export function run(): number { return new Animal().seen; }
`;

// node: 3. TWO private methods in one class — both were `Animal_<computed>`
// before this slice, sharing one legacy match name and one selection entry.
const TWO_PRIVATE = `class Animal {
  #a: number = 1;
  #b: number = 2;
  #first(): number { return this.#a; }
  #second(): number { return this.#b; }
  reveal(): number { return this.#a + this.#b; }
}
export function run(): number { return new Animal().reveal(); }
`;

// A private method beside a COMPUTED-name method: the private one is admitted,
// the computed one keeps its `class-method` refusal (its key is not a
// compile-time constant, so no stable descriptor name exists).
const PRIVATE_PLUS_COMPUTED = `class Animal {
  #a: number = 1;
  #first(): number { return this.#a; }
  ["tagged"](): number { return this.#a; }
}
export function run(): number { return new Animal().tagged(); }
`;

// node: 40100. Ordering control — field initialization must still precede the
// constructor body read. Every wrong ordering yields 0 or NaN.
const ORDER = `class Animal {
  #base: number = 40100;
  seen: number = 0;
  constructor() { this.seen = this.#base; }
  #echo(): number { return this.#base; }
  reveal(): number { return this.seen; }
}
export function run(): number { return new Animal().reveal(); }
`;

// Negative controls — each measured identical in VERDICT on `origin/main`.
const NEGATIVE_PRIVATE_ACCESSOR = `class Animal {
  #a: number = 1;
  get #hidden(): number { return this.#a; }
  reveal(): number { return this.#a; }
}
export function run(): number { return new Animal().reveal(); }
`;
const NEGATIVE_STATIC_PRIVATE = `class Animal {
  #a: number = 1;
  static #make(): number { return 7; }
  reveal(): number { return this.#a; }
}
export function run(): number { return new Animal().reveal(); }
`;
const NEGATIVE_GENERATOR = `class Animal {
  #secret: number = 42;
  *gen(): Generator<number> { yield this.#secret; }
}
export function run(): number { return new Animal().gen().next().value as number; }
`;
const NEGATIVE_COMPUTED = `class Animal {
  #secret: number = 42;
  ["tagged"](): number { return this.#secret; }
}
export function run(): number { return new Animal().tagged(); }
`;

// An object literal cannot carry a private name, so `objectMemberDisplayName`
// — which shares `memberBaseName` with the class path — must be untouched.
const OBJECT_LITERAL = `const bag = {
  plain(): number { return 1; },
  get lifted(): number { return 2; },
  set lifted(v: number) { void v; },
};
export function run(): number { return bag.plain() + bag.lifted; }
`;

describe("#3522 W1-A private instance-method declarations compile once", () => {
  it.each(TARGETS)("admits the declared-only private method on %s", async (target) => {
    const result = await compilePoisoned(DECLARED_ONLY, `w1a-declared-${target}.ts`, target, [
      "Animal___priv_privateMethod",
      "Animal_reveal",
      "Animal_new",
    ]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);

    // The name is the mangled one, on both the display and the compiled-func
    // ledger — NOT `Animal_<computed>`, which is what base minted.
    expect(displayNames(result)).toContain("Animal___priv_privateMethod");
    expect(displayNames(result)).not.toContain("Animal_<computed>");
    expectIrOwned(result, ["Animal___priv_privateMethod"]);

    // The class's other units are unaffected — no cascade in either direction.
    expectIrOwned(result, ["Animal_reveal", "Animal_new"]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect((await instantiate(result)).run!()).toBe(42);
  });

  it.each(TARGETS)("runs the IR-owned private method body on %s", async (target) => {
    const result = await compilePoisoned(CALLED_FROM_SIBLING, `w1a-runs-${target}.ts`, target, [
      "Animal___priv_doubled",
    ]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectIrOwned(result, ["Animal___priv_doubled"]);
    expectPreExistingCtorSealingNote(result);

    // Runtime parity against the legacy compiler for the same program.
    const legacy = await compile(CALLED_FROM_SIBLING, {
      fileName: `w1a-runs-legacy-${target}.ts`,
      experimentalIR: false,
      ...(target === "standalone" ? { target: "standalone" as const } : {}),
    });
    expect(legacy.success).toBe(true);
    const [irExports, legacyExports] = await Promise.all([instantiate(result), instantiate(legacy)]);
    expect(irExports.run!()).toBe(84);
    expect(irExports.run!()).toBe(legacyExports.run!());
  });

  it.each(TARGETS)("preserves field-init-before-constructor ordering on %s", async (target) => {
    const result = await compilePoisoned(ORDER, `w1a-order-${target}.ts`, target, ["Animal___priv_echo"]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectIrOwned(result, ["Animal___priv_echo"]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect((await instantiate(result)).run!()).toBe(40100);
  });

  it.each(TARGETS)("gives two private methods distinct identities on %s", async (target) => {
    const result = await compilePoisoned(TWO_PRIVATE, `w1a-two-${target}.ts`, target, [
      "Animal___priv_first",
      "Animal___priv_second",
      "Animal_reveal",
      "Animal_new",
    ]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);

    const privateRows = (result.irOutcomes ?? []).filter((row) => row.displayName.includes("__priv_"));
    expect(privateRows).toHaveLength(2);
    expect(new Set(privateRows.map((row) => row.displayName)).size, "distinct display names").toBe(2);
    expect(new Set(privateRows.map((row) => row.unitId)).size, "distinct unit ids").toBe(2);
    expectIrOwned(result, ["Animal___priv_first", "Animal___priv_second"]);
    expect((await instantiate(result)).run!()).toBe(3);
  });

  it.each(TARGETS)("admits the private method beside a computed-name method on %s", async (target) => {
    const result = await compilePoisoned(PRIVATE_PLUS_COMPUTED, `w1a-mixed-${target}.ts`, target, [
      "Animal___priv_first",
    ]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectIrOwned(result, ["Animal___priv_first"]);
    expect(outcomeCode(result, "Animal_<computed>")).toBe("class-method");
    expect(outcome(result, "Animal_<computed>").legacyBodyEmitted).toBe(true);
  });

  it.each(TARGETS)("emits no new call, cast or boxing surface on %s", async (target) => {
    const result = await compilePoisoned(DECLARED_ONLY, `w1a-wat-${target}.ts`, target, [
      "Animal___priv_privateMethod",
    ]);
    expect(result.success).toBe(true);
    const wat = result.wat ?? "";
    const start = wat.indexOf("(func $Animal___priv_privateMethod");
    expect(start, "prepared owner must be present in WAT").toBeGreaterThanOrEqual(0);
    const next = wat.indexOf("\n  (func $", start + 1);
    const body = wat.slice(start, next < 0 ? wat.length : next);
    for (const forbidden of ["call_ref", "call_indirect", "ref.test", "__box_number", "__call_m_"]) {
      expect(body, `${forbidden} must not appear in the prepared owner`).not.toContain(forbidden);
    }
  });
});

describe("#3522 W1-A call sites stay deferred (the NEXT slice's boundary)", () => {
  it.each(TARGETS)("keeps the calling sibling and constructor direct on %s", async (target) => {
    const result = await compilePlain(CALLED_FROM_SIBLING, `w1a-callsite-sibling-${target}.ts`, target);
    expect(result.success).toBe(true);
    expect(outcomeCode(result, "Animal___priv_doubled")).toBe("emitted");
    expect(outcomeCode(result, "Animal_reveal")).toBe("body-shape-rejected");
    expect(outcomeCode(result, "Animal_new")).toBe("late-preparation-unsupported");
    expectDirectOwned(result, ["Animal_reveal", "Animal_new"]);
    expectPreExistingCtorSealingNote(result);
    expect((await instantiate(result)).run!()).toBe(84);
  });

  it.each(TARGETS)("keeps a constructor that calls a private method direct on %s", async (target) => {
    const result = await compilePlain(CALLED_FROM_CTOR, `w1a-callsite-ctor-${target}.ts`, target);
    expect(result.success).toBe(true);
    expect(outcomeCode(result, "Animal___priv_privateMethod")).toBe("emitted");
    expect(outcomeCode(result, "Animal_new")).toBe("body-shape-rejected");
    expectDirectOwned(result, ["Animal_new"]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect((await instantiate(result)).run!()).toBe(42);
  });
});

describe("#3522 W1-A negative controls keep their pre-slice verdict", () => {
  const negatives: readonly (readonly [string, string, string, string])[] = [
    // [label, source, refused display name, refusal code]
    ["private accessor", NEGATIVE_PRIVATE_ACCESSOR, "Animal_get___priv_hidden", "class-method"],
    // The VERDICT is unchanged (refused, direct body). The reason code moves
    // from `class-method` to `class-member-unsupported` because the name is now
    // representable and the missing STATIC descriptor is the true reason — the
    // static defer in `buildIrClassShapes` is what still refuses it.
    ["static private method", NEGATIVE_STATIC_PRIVATE, "Animal___priv_make", "class-member-unsupported"],
    ["generator method", NEGATIVE_GENERATOR, "Animal_gen", "class-member-unsupported"],
    ["computed-name method", NEGATIVE_COMPUTED, "Animal_<computed>", "class-method"],
  ];

  it.each(negatives.flatMap((row) => TARGETS.map((target) => [row[0], target, row[1], row[2], row[3]] as const)))(
    "refuses %s on %s",
    async (_label, target, source, displayName, code) => {
      const result = await compilePlain(source, `w1a-neg-${displayName}-${target}.ts`, target);
      expect(result.success).toBe(true);
      expect(outcomeCode(result, displayName)).toBe(code);
      expectDirectOwned(result, [displayName]);
    },
  );

  it.each(TARGETS)("leaves object-literal members untouched on %s", async (target) => {
    // `memberBaseName` is shared with `objectMemberDisplayName`. An object
    // literal cannot carry a private name AT ALL (asserted below), so the new
    // branch is unreachable from that call site; this pins that an ordinary
    // object literal still compiles and runs unchanged.
    const result = await compilePlain(OBJECT_LITERAL, `w1a-object-${target}.ts`, target);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(displayNames(result).some((name) => name.includes("__priv_"))).toBe(false);
    expect((result.irCompiledFuncs ?? []).some((name) => name.includes("__priv_"))).toBe(false);
    expect((await instantiate(result)).run!()).toBe(3);
  });

  it("rejects a private name in an object literal, so the shared helper cannot be reached there", async () => {
    const result = await compile(
      "const bag = { #x(): number { return 1; } };\nexport function run(): number { return 1; }\n",
      {
        fileName: "w1a-object-private.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "Private identifiers are not allowed outside class bodies",
    );
  });

  it("keeps the DIRECT class-body emitter live (the poison must fire)", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    try {
      // `Animal_new` is direct on this fixture (its constructor calls a private
      // method), so poisoning it MUST fail the compile. If it did not, every
      // poisoned positive above would be vacuous.
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Animal_new";
      const result = await compile(CALLED_FROM_CTOR, {
        fileName: "w1a-poison-live.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n")).toContain("injected direct class-body poison");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
    }
  });
});

describe("#3522 W1-A the A1 (`any` class position) arm must not move", () => {
  // `tests/dogfood/corpus/classes.js` is the census entry that carries the
  // private method. Its two classes take `any`-typed constructor parameters, so
  // they never enter the class-shape sidecar — the A1 arm, which this slice
  // deliberately does NOT touch (it is the `any`-carrier lane's, #5289/#3523).
  //
  // Consequence, stated so it cannot be mistaken for a regression: on THIS file
  // the private method does not reach `emitted`. Admitting the name moves the
  // row from `class-method` to `class-member-unsupported` — the same
  // missing-descriptor arm its six siblings already sit on — because A2 was
  // merely the FIRST stamp on a member that is A1-blocked underneath. The six
  // A1 rows and the module-init row are unchanged, and the emitted binary is
  // byte-identical to base on both lanes.
  const CENSUS_FILE = "tests/dogfood/corpus/classes.js";

  it.each(TARGETS)("keeps every classes.js row on its pre-slice arm on %s", async (target) => {
    const source = readFileSync(CENSUS_FILE, "utf-8");
    const result = await compilePlain(source, CENSUS_FILE, target);
    expect(result.success).toBe(true);

    expect(outcomeCode(result, "Animal_new")).toBe("class-projection-unsupported");
    expect(outcomeCode(result, "Dog_new")).toBe("class-projection-unsupported");
    expect(outcomeCode(result, "Animal_get_label")).toBe("class-member-unsupported");
    expect(outcomeCode(result, "Animal_set_label")).toBe("class-member-unsupported");
    expect(outcomeCode(result, "Animal_make")).toBe("class-member-unsupported");
    expect(outcomeCode(result, "Dog_speak")).toBe("class-member-unsupported");
    expect(outcomeCode(result, "<module-init>")).toBe("static-class-initialization");

    // The one row this slice moves: it is named, and it is still refused —
    // by A1, not by A2.
    expect(displayNames(result)).not.toContain("Animal_<computed>");
    expect(outcomeCode(result, "Animal___priv_privateMethod")).toBe("class-member-unsupported");
    expect((result.irOutcomes ?? []).filter((row) => row.unitKind === "class-member")).toHaveLength(7);
  });
});
