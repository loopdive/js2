// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3520 W1-E cluster D — the `#3116` write-back pair (`__vec_set_elem` /
// `__vec_set_len`) is now owned structurally, as ordinals 9 and 10 of the
// closed `vec-host-bridge` table, instead of falling through to the positional
// `retained-module-function` role.
//
// The property under test is IDENTITY STABILITY, not presence: the generic
// role's derived ordinal is the function's final index, so appending any
// unrelated exported function used to renumber both helpers. A closed
// compile-time table cannot be moved by anything a program contains.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import {
  VEC_HOST_BRIDGE_ROLE,
  vecHostBridgeMaterializerOrdinal,
  vecHostBridgeWritebackOrdinal,
} from "../src/codegen/vec-access-exports.js";
import {
  PROGRAM_ABI_CALLABLE_ROLE,
  programAbiCallableRoleOrdinalsAreDistinct,
} from "../src/codegen/program-abi-planning.js";
import { emitBinary } from "../src/emit/binary.js";

// Register the expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const RETAINED_MODULE_FUNCTION_ROLE = "retained-module-function";
const ASYNC_ENTRY = "website/playground/examples/js/async.ts";
/** A module with no defineProperty / dynamic-set import ⇒ no write-back pair. */
const NO_WRITEBACK_ENTRY = "tests/fixtures/add.ts";

interface AbiEntryView {
  readonly id: string;
  readonly displayName?: string;
  readonly intent?: { readonly kind?: string };
}

function hardErrors(result: ReturnType<typeof generateModule>) {
  return result.errors.filter((error) => error.severity !== "warning");
}

function compileEntry(entry: string, extraSource = "") {
  const source = `${readFileSync(resolve(entry), "utf8")}${extraSource}`;
  const ast = analyzeSource(source, entry);
  const result = generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
  expect(
    hardErrors(result),
    hardErrors(result)
      .map((error) => error.message)
      .join("\n"),
  ).toEqual([]);
  return result;
}

function abiEntries(result: ReturnType<typeof generateModule>): readonly AbiEntryView[] {
  const publication = (result as unknown as { programAbi?: { abi: { entries(): readonly AbiEntryView[] } } })
    .programAbi;
  expect(publication, "compilation published no Program ABI").toBeDefined();
  return publication!.abi.entries();
}

/**
 * Callable rows only. An export alias carries the same `displayName` as the
 * callable it aliases, so an unfiltered match sees two rows per function.
 */
function callableRowsForRole(entries: readonly AbiEntryView[], role: string): readonly AbiEntryView[] {
  return entries.filter((entry) => entry.intent?.kind === "callable" && String(entry.id).includes(`:${role}:`));
}

function bindingIdOf(entries: readonly AbiEntryView[], role: string, displayName: string): string | undefined {
  return callableRowsForRole(entries, role).find((entry) => entry.displayName === displayName)?.id;
}

/** The trailing ordinal component of an `IrBindingId`, decoded. */
function bindingOrdinal(id: string): number {
  return Number(id.slice(id.lastIndexOf(":") + 1));
}

describe("#3520 W1-E vec write-back helper Program ABI ownership", () => {
  it("publishes the write-back pair as vec-host-bridge ordinals 9 and 10, not on the positional fallback", () => {
    const entries = abiEntries(compileEntry(ASYNC_ENTRY));

    const setElem = bindingIdOf(entries, VEC_HOST_BRIDGE_ROLE, "__vec_set_elem");
    const setLen = bindingIdOf(entries, VEC_HOST_BRIDGE_ROLE, "__vec_set_len");
    expect(setElem, "__vec_set_elem has no vec-host-bridge row").toBeDefined();
    expect(setLen, "__vec_set_len has no vec-host-bridge row").toBeDefined();
    expect(bindingOrdinal(setElem!)).toBe(9);
    expect(bindingOrdinal(setLen!)).toBe(10);

    // Anti-vacuity: the six core bridges must still be present and unmoved, or
    // "the pair joined the family" could be true of an empty family.
    expect(callableRowsForRole(entries, VEC_HOST_BRIDGE_ROLE)).toHaveLength(8);

    // The positional fallback must not merely be *smaller* — on this entry it
    // is now empty, which is what the C35 census asserts corpus-wide.
    const generic = callableRowsForRole(entries, RETAINED_MODULE_FUNCTION_ROLE);
    expect(
      generic.map((entry) => entry.displayName ?? "<unnamed>"),
      "a compiler-support callable is still on the positional fallback",
    ).toEqual([]);
  });

  it("keeps both binding ids fixed while unrelated growth moves the final indices", () => {
    const before = abiEntries(compileEntry(ASYNC_ENTRY));
    const after = abiEntries(
      compileEntry(ASYNC_ENTRY, "\nexport function __w1eUnrelatedGrowth(x: number): number {\n  return x + 1;\n}\n"),
    );

    // The growth is real: one more defined function, one more callable row.
    expect(after.length).toBeGreaterThan(before.length);

    for (const name of ["__vec_set_elem", "__vec_set_len"]) {
      const grown = bindingIdOf(after, VEC_HOST_BRIDGE_ROLE, name);
      expect(grown, `${name} lost its vec-host-bridge row under growth`).toBeDefined();
      expect(grown, `${name} binding id moved under unrelated growth`).toBe(
        bindingIdOf(before, VEC_HOST_BRIDGE_ROLE, name),
      );
    }

    // ...and the id they used to carry WOULD have moved: the generic role's
    // ordinal is the final function index, which this growth shifts. Pin that
    // the pair's final index really does move, so the stability above is a
    // property of the role and not of a static layout.
    const positionOf = (result: ReturnType<typeof generateModule>, name: string) =>
      result.module.functions.findIndex((func) => func.name === name);
    const beforeModule = compileEntry(ASYNC_ENTRY);
    const afterModule = compileEntry(
      ASYNC_ENTRY,
      "\nexport function __w1eUnrelatedGrowth(x: number): number {\n  return x + 1;\n}\n",
    );
    expect(positionOf(beforeModule, "__vec_set_elem")).toBeGreaterThanOrEqual(0);
    expect(positionOf(afterModule, "__vec_set_elem")).not.toBe(positionOf(beforeModule, "__vec_set_elem"));
  });

  it("claims no ordinal on a module that emits no write-back pair", () => {
    const result = compileEntry(NO_WRITEBACK_ENTRY);
    const entries = abiEntries(result);

    const binary = Buffer.from(emitBinary(result.module));
    expect(binary.toString("latin1")).not.toContain("__vec_set_elem");
    expect(binary.toString("latin1")).not.toContain("__vec_set_len");

    // No over-claim: ordinals 9/10 must be absent, not merely unnamed.
    for (const row of callableRowsForRole(entries, VEC_HOST_BRIDGE_ROLE)) {
      expect(bindingOrdinal(row.id), `${row.displayName} claimed a write-back ordinal`).toBeLessThan(9);
    }
  });

  it("pins the closed ordinal table the pair now shares with the bridges", () => {
    expect(vecHostBridgeWritebackOrdinal("setElem")).toBe(9);
    expect(vecHostBridgeWritebackOrdinal("setLen")).toBe(10);
    // Contiguous with the materializer sub-family (6/7/8) it follows.
    expect(vecHostBridgeMaterializerOrdinal("externref")).toBe(8);
    // The pair rides the EXISTING role — W1-E adds no role ordinal.
    expect(PROGRAM_ABI_CALLABLE_ROLE.vecHostBridge).toBe(8);
    expect(programAbiCallableRoleOrdinalsAreDistinct()).toBe(true);
  });
});
