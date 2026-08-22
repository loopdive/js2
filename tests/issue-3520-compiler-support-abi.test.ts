// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SINGLE_HOST_ENTRIES } from "../scripts/check-ir-only.js";
import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import {
  ASYNC_FRAME_MACHINERY_PART,
  ASYNC_FRAME_MACHINERY_ROLE,
  CLOSURE_ARGC_DISPATCHER_ROLE,
  STDLIB_MATH_ABI_NAMES,
  STDLIB_MATH_HELPER_ROLE,
  stdlibMathHelperOrdinal,
  VEC_FROM_EXTERN_ROLE,
  vecFromExternShapeOrder,
} from "../src/codegen/compiler-support-abi.js";
import {
  PROGRAM_ABI_CALLABLE_ROLE,
  programAbiCallableRoleOrdinalsAreDistinct,
} from "../src/codegen/program-abi-planning.js";
import { emitBinary } from "../src/emit/binary.js";
import { compile } from "../src/index.js";
import { irSupportFuncRef } from "../src/ir/callable-bindings.js";
import { SELF_HOSTED_MATH } from "../src/stdlib/math.js";

// Register the expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const RETAINED_MODULE_FUNCTION_ROLE = "retained-module-function";
const ASYNC_ENTRY = "website/playground/examples/js/async.ts";
const BUILTINS_ENTRY = "website/playground/examples/js/builtins.ts";

/** Display-name shape each C35 role is allowed to own. */
const FAMILY_NAME_SHAPE: Readonly<Record<string, (name: string) => boolean>> = {
  [CLOSURE_ARGC_DISPATCHER_ROLE]: (name) => /^__\0js2_call_fn_method_argc_\d+$/.test(name),
  [ASYNC_FRAME_MACHINERY_ROLE]: (name) =>
    /^__async_resume_f/.test(name) || /^__cb_\d+$/.test(name) || /^__async_step_f.*_(fulfill|reject)$/.test(name),
  [VEC_FROM_EXTERN_ROLE]: (name) => /^__vec_from_extern_\d+$/.test(name),
  [STDLIB_MATH_HELPER_ROLE]: (name) => STDLIB_MATH_ABI_NAMES.includes(name),
};

interface AbiEntryView {
  readonly id: string;
  readonly displayName?: string;
  readonly intent?: { readonly kind?: string };
}

function hardErrors(result: ReturnType<typeof generateModule>) {
  return result.errors.filter((error) => error.severity !== "warning");
}

function compileFixture(source: string, fileName: string, trackIrOutcomes = true) {
  const ast = analyzeSource(source, fileName);
  const result = generateModule(ast, { experimentalIR: true, trackIrOutcomes });
  expect(
    hardErrors(result),
    hardErrors(result)
      .map((error) => error.message)
      .join("\n"),
  ).toEqual([]);
  return result;
}

function compileEntry(entry: string, fileName = entry, extraSource = "") {
  return compileFixture(`${readFileSync(resolve(entry), "utf8")}${extraSource}`, fileName);
}

function abiEntries(result: ReturnType<typeof generateModule>): readonly AbiEntryView[] {
  const publication = (result as unknown as { programAbi?: { abi: { entries(): readonly AbiEntryView[] } } })
    .programAbi;
  expect(publication, "compilation published no Program ABI").toBeDefined();
  return publication!.abi.entries();
}

/**
 * Callable rows only. An export alias carries the same `displayName` as the
 * callable it aliases, so an unfiltered name match sees two rows per function.
 */
function callableRowsForRole(entries: readonly AbiEntryView[], role: string): readonly AbiEntryView[] {
  return entries.filter((entry) => entry.intent?.kind === "callable" && String(entry.id).includes(`:${role}:`));
}

/** The trailing ordinal component of an `IrBindingId`. */
function bindingOrdinal(id: string): number {
  return Number(id.slice(id.lastIndexOf(":") + 1));
}

describe("#3520 C35 compiler-support callable Program ABI ownership", () => {
  it("leaves no compiler-support callable on the positional fallback across the five host entries", () => {
    // Deliberately NOT an absolute-count census. Every C30–C33 slice pinned its
    // own five-entry denominators and every one of those numbers has since
    // drifted, so those suites now report that the playground corpus changed
    // rather than the property they were written to defend. This asserts the
    // property, self-derived from whatever the corpus contains. The
    // denominators live in the issue file, where a stale number is a stale note
    // rather than a red gate.
    let definedFunctions = 0;
    let genericRows = 0;
    const familyRows = new Map<string, number>();

    for (const entry of SINGLE_HOST_ENTRIES) {
      const result = compileEntry(entry);
      definedFunctions += result.module.functions.length;
      const entries = abiEntries(result);
      genericRows += callableRowsForRole(entries, RETAINED_MODULE_FUNCTION_ROLE).length;
      for (const [role, shape] of Object.entries(FAMILY_NAME_SHAPE)) {
        const rows = callableRowsForRole(entries, role);
        familyRows.set(role, (familyRows.get(role) ?? 0) + rows.length);
        // A role that captured a function outside its family would be a
        // mis-attribution, not an ownership win.
        for (const row of rows) {
          expect(shape(row.displayName ?? ""), `${role} owns unexpected ${row.displayName}`).toBe(true);
        }
      }
    }

    // Anti-vacuity: the corpus must actually contain functions, or "none are
    // generic" is trivially true. Measured at origin/main 81edcbcaa this is 139.
    expect(definedFunctions).toBeGreaterThan(0);
    // Every family must be represented, or the roles are not being exercised.
    for (const role of Object.keys(FAMILY_NAME_SHAPE)) {
      expect(familyRows.get(role) ?? 0, `${role} has no rows`).toBeGreaterThan(0);
    }
    // The positional `retained-module-function` fallback is now EMPTY on this
    // corpus — the C30–C35 sequence's terminal state.
    expect(genericRows).toBe(0);
  });

  it("reserves four distinct callable role ordinals", () => {
    expect(programAbiCallableRoleOrdinalsAreDistinct()).toBe(true);
    expect(PROGRAM_ABI_CALLABLE_ROLE.closureArgcDispatcher).toBe(15);
    expect(PROGRAM_ABI_CALLABLE_ROLE.asyncFrameMachinery).toBe(16);
    expect(PROGRAM_ABI_CALLABLE_ROLE.vecFromExternMaterializer).toBe(17);
    expect(PROGRAM_ABI_CALLABLE_ROLE.stdlibMathHelper).toBe(18);
  });

  it("keys every family by role and ordinal only — the display label is not part of it", () => {
    const owner = "ir-source:v1:0000000000000000:entry:label.ts";
    for (const role of Object.keys(FAMILY_NAME_SHAPE)) {
      const labelled = irSupportFuncRef(owner as never, role, "__a_plausible_label", 2);
      const relabelled = irSupportFuncRef(owner as never, role, "totally-unrelated", 2);
      const otherOrdinal = irSupportFuncRef(owner as never, role, "__a_plausible_label", 3);
      expect(labelled.binding.kind).toBe("support");
      if (
        labelled.binding.kind !== "support" ||
        relabelled.binding.kind !== "support" ||
        otherOrdinal.binding.kind !== "support"
      ) {
        continue;
      }
      // Label-not-key: a same-spelled source function cannot occupy the role.
      expect(relabelled.binding.bindingId, role).toBe(labelled.binding.bindingId);
      // ...and the ordinal really is the key.
      expect(otherOrdinal.binding.bindingId, role).not.toBe(labelled.binding.bindingId);
    }
  });

  it("gives each argc wrapper the ordinal of its own dispatcher arity", () => {
    const entries = abiEntries(compileEntry(ASYNC_ENTRY));
    const rows = callableRowsForRole(entries, CLOSURE_ARGC_DISPATCHER_ROLE);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      const arity = Number(/_(\d+)$/.exec(row.displayName ?? "")![1]);
      expect(bindingOrdinal(String(row.id)), row.displayName).toBe(arity);
    }
    // Contiguous from zero: the family is the complete emitted arity range, so
    // the ordinals are not merely distinct but positionally meaningful.
    expect(rows.map((row) => bindingOrdinal(String(row.id))).sort((a, b) => a - b)).toEqual(
      rows.map((_, index) => index),
    );
  });

  it("anchors async frame machinery to its own unit, one part triple per async function", () => {
    const entries = abiEntries(compileEntry(ASYNC_ENTRY));
    const rows = callableRowsForRole(entries, ASYNC_FRAME_MACHINERY_ROLE);
    expect(rows.length).toBeGreaterThan(0);
    const byOwner = new Map<string, number[]>();
    for (const row of rows) {
      const id = String(row.id);
      // `ir-binding:v1:support:<owner>:<role>:<ordinal>` — the owner is a UNIT,
      // not the entry source, so a second async function cannot renumber this
      // one.
      const owner = id.split(":")[3] ?? "";
      expect(decodeURIComponent(owner), row.displayName).toMatch(/^ir-unit:v1:/);
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), bindingOrdinal(id)]);
    }
    // Every async function contributes the same three parts, and only those.
    for (const [owner, ordinals] of byOwner) {
      expect(
        ordinals.sort((a, b) => a - b),
        owner,
      ).toEqual([
        ASYNC_FRAME_MACHINERY_PART.resume,
        ASYNC_FRAME_MACHINERY_PART.stepFulfill,
        ASYNC_FRAME_MACHINERY_PART.stepReject,
      ]);
    }
    expect(byOwner.size).toBe(rows.length / 3);
  });

  it("derives vec-materializer order from the shape name, independent of emission order", () => {
    const forward = vecFromExternShapeOrder(["__vec_f64", "__vec_anyref", "__vec_i32"]);
    const reversed = vecFromExternShapeOrder(["__vec_f64", "__vec_anyref", "__vec_i32"].reverse());
    expect(forward).toEqual(["__vec_anyref", "__vec_f64", "__vec_i32"]);
    expect(reversed).toEqual(forward);

    // Elision invariance: dropping a shape from the SURVIVING set must not be
    // allowed to renumber its neighbours, which is why the planner derives the
    // order from the PRE-elision record. Deriving it from survivors would give
    // `__vec_i32` a different ordinal purely because `__vec_f64` was eliminated.
    const survivorsOnly = vecFromExternShapeOrder(["__vec_anyref", "__vec_i32"]);
    expect(survivorsOnly.indexOf("__vec_i32")).toBe(1);
    expect(forward.indexOf("__vec_i32")).toBe(2);
  });

  it("keys stdlib Math helpers by a closed constant table, not by what a module emits", () => {
    // Closed: every self-hosted builtin the emitter can produce is on it.
    for (const builtin of SELF_HOSTED_MATH.values()) {
      expect(STDLIB_MATH_ABI_NAMES, builtin.name).toContain(builtin.name);
    }
    for (const name of ["Math_random", "Math_atan", "Math_atan2", "Math_pow", "__math_reduce_trig"]) {
      expect(stdlibMathHelperOrdinal(name), name).toBeTypeOf("number");
    }
    expect(stdlibMathHelperOrdinal("not_a_math_helper")).toBeUndefined();
    // Canonical and deduplicated.
    expect([...STDLIB_MATH_ABI_NAMES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([...STDLIB_MATH_ABI_NAMES]);
    expect(new Set(STDLIB_MATH_ABI_NAMES).size).toBe(STDLIB_MATH_ABI_NAMES.length);

    // The table is a compile-time constant, so a module that emits a DIFFERENT
    // subset resolves the same name to the same ordinal. This is strictly
    // stronger than a sorted-survivor order.
    const rows = callableRowsForRole(abiEntries(compileEntry(BUILTINS_ENTRY)), STDLIB_MATH_HELPER_ROLE);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(bindingOrdinal(String(row.id)), row.displayName).toBe(stdlibMathHelperOrdinal(row.displayName ?? ""));
    }
  });

  it("keeps every family's identity fixed while unrelated growth moves the final indices", () => {
    const extra = `
export function c35ExtraOne(v: number): number { return v + 1; }
export function c35ExtraTwo(v: number): number { return v + 2; }
export function c35ExtraThree(v: number): number { return v + 3; }
`;
    const base = compileEntry(ASYNC_ENTRY, ASYNC_ENTRY);
    const grown = compileEntry(ASYNC_ENTRY, ASYNC_ENTRY, extra);

    const idsFor = (result: ReturnType<typeof generateModule>, role: string) =>
      callableRowsForRole(abiEntries(result), role)
        .map((row) => String(row.id))
        .sort();

    for (const role of [CLOSURE_ARGC_DISPATCHER_ROLE, ASYNC_FRAME_MACHINERY_ROLE, VEC_FROM_EXTERN_ROLE]) {
      expect(idsFor(base, role).length, role).toBeGreaterThan(0);
      expect(idsFor(grown, role), role).toEqual(idsFor(base, role));
    }

    // Control: the positions really did move. Under the old positional
    // `retained-module-function` fallback the derived ordinal IS the final
    // index, so this shift is exactly what used to rewrite the identity.
    const indexOfName = (result: ReturnType<typeof generateModule>, prefix: string) =>
      result.module.functions.findIndex((func) => func.name.startsWith(prefix));
    expect(grown.module.functions.length).toBeGreaterThan(base.module.functions.length);
    expect(indexOfName(grown, "__vec_from_extern_")).not.toBe(indexOfName(base, "__vec_from_extern_"));
  });

  /**
   * (#2980 guard regression) A unit whose machinery was lowered TWICE must
   * decline the role, not abort the compile.
   *
   * When the #2980 async host fallback fires, the same declaration is lowered a
   * second time and BOTH lowerings' functions stay live: measured on this
   * fixture, one `async function* g()` yields two `__async_resume_fg` objects,
   * two `__async_step_fg_fulfill` and two `__async_step_fg_reject`. C35's first
   * cut treated the second claimant as an ownership contradiction and let the
   * session's plan-contract invariant abort the compile — strictly worse than
   * the behaviour it replaced, where both objects simply took generic
   * `retained-module-function` owners and the module built.
   *
   * An ambiguous slot now declines the unit role and every claimant falls to
   * the generic sweep, which still makes the function space total. This asserts
   * both halves: the compile succeeds, AND the duplicate stays visible as
   * generic rows rather than being silently absorbed.
   */
  it("declines the unit role when one unit's machinery was lowered twice (#2980 fallback)", async () => {
    const source = `
      let error = 1;
      let callCount = 0;
      var gen = async function* g() { callCount += 1; yield Promise.reject(error); yield 2; };
      export function test(): number { const it: any = gen(); void it; return callCount; }
    `;
    // The exact shape and options the #2980 guard suite compiles. Before the
    // ambiguous-slot fix this threw
    // `ABI draft …:async-frame-machinery:0 was observed with a different plan
    // contract` and the whole compile failed.
    const result = await compile(source, { fileName: "t.ts", target: "standalone", nativeStrings: true });
    expect(result.success, result.errors?.[0]?.message ?? "").toBe(true);

    // Same fixture through `generateModule`, which publishes the Program ABI
    // the public `compile` result does not carry.
    const ast = analyzeSource(source, "t.ts");
    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
      standalone: true,
      nativeStrings: true,
    });
    expect(
      hardErrors(generated),
      hardErrors(generated)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    // The duplicate really is present — otherwise everything below is vacuous.
    expect(generated.module.functions.filter((func) => func.name === "__async_resume_fg")).toHaveLength(2);

    const entries = abiEntries(generated);
    // Neither rival claims the unit role...
    const asyncRows = callableRowsForRole(entries, ASYNC_FRAME_MACHINERY_ROLE).filter(
      (row) => row.displayName === "__async_resume_fg",
    );
    expect(asyncRows).toEqual([]);
    // ...and BOTH stay owned by the generic fallback, so the function space is
    // still total — the pre-C35 outcome for this shape, restored.
    const genericRows = callableRowsForRole(entries, RETAINED_MODULE_FUNCTION_ROLE).filter(
      (row) => row.displayName === "__async_resume_fg",
    );
    expect(genericRows).toHaveLength(2);
  });

  it("keeps tracked and untracked binaries byte-identical", () => {
    const source = readFileSync(resolve(BUILTINS_ENTRY), "utf8");
    const untracked = compileFixture(source, BUILTINS_ENTRY, false);
    const tracked = compileFixture(source, BUILTINS_ENTRY, true);
    expect(Buffer.from(emitBinary(tracked.module))).toEqual(Buffer.from(emitBinary(untracked.module)));
  });
});
