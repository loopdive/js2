// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SINGLE_HOST_ENTRIES } from "../scripts/check-ir-only.js";
import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { eliminateDeadLayoutAndPlanProgramAbi } from "../src/codegen/program-abi-finalization.js";
import {
  PROGRAM_ABI_CALLABLE_ROLE,
  resolveProgramAbiSupportCallableHandle,
} from "../src/codegen/program-abi-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { eliminateDeadImports } from "../src/codegen/dead-elimination.js";
import { ensureDateCivilHelper } from "../src/codegen/expressions/builtins.js";
import { ensureLateImport, flushLateImportShifts } from "../src/codegen/expressions/late-imports.js";
import { definedFuncAt } from "../src/codegen/func-space.js";
import { generateModule } from "../src/codegen/index.js";
import { irSupportFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, createIrBindingId } from "../src/ir/identity.js";
import { nonExecutableOutcomeDefect } from "../src/ir/outcomes.js";
import { createEmptyModule } from "../src/ir/types.js";
import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";

// Register the expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const DATE_CIVIL_SUPPORT_ROLE = "date-civil-support";
const DATE_CIVIL_SUPPORT_ORDINAL = 0;
const DATE_CIVIL_HELPER = "__date_civil_from_days";

const CALENDAR_SOURCE = `
  export function stamp(): number {
    const value = new Date(Date.UTC(2024, 1, 29));
    return value.getUTCFullYear() * 10000 + (value.getUTCMonth() + 1) * 100 + value.getUTCDate();
  }
`;

function hardErrors(result: ReturnType<typeof generateModule>) {
  return result.errors.filter((error) => error.severity !== "warning");
}

function entrySourceRecord(source = CALENDAR_SOURCE) {
  const ast = analyzeSource(source, "issue-3520-date-civil-support.ts");
  return buildIrUnitInventory([ast.sourceFile], {
    entrySource: ast.sourceFile,
    checker: ast.checker,
  }).sources.find((candidate) => candidate.kind === "entry")!;
}

function collisionSource(kind: "bigint" | "number"): string {
  const literal = kind === "bigint" ? "5n" : "5";
  const delta = kind === "bigint" ? "17n" : "17";
  return `
    function ${DATE_CIVIL_HELPER}(days: ${kind}): ${kind} {
      return days + ${delta};
    }
    export function userProbe(): ${kind} {
      return ${DATE_CIVIL_HELPER}(${literal});
    }
    export function dateProbe(): number {
      const value = new Date(0);
      return value.getUTCFullYear() * 10000 + (value.getUTCMonth() + 1) * 100 + value.getUTCDate();
    }
  `;
}

async function compileCollision(
  kind: "bigint" | "number",
  trackIrOutcomes: boolean,
): Promise<Awaited<ReturnType<typeof compile>>> {
  return compile(collisionSource(kind), {
    fileName: `issue-3520-date-civil-${kind}-collision.ts`,
    experimentalIR: true,
    trackIrOutcomes,
    target: "standalone",
  });
}

describe("#3520 C32 date civil support Program ABI ownership", () => {
  it("publishes one exact entry-source owner with no duplicate generic owner", () => {
    const ast = analyzeSource(CALENDAR_SOURCE, "issue-3520-date-civil-support.ts");
    const result = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
      standalone: true,
    });
    expect(
      hardErrors(result),
      hardErrors(result)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const entrySource = entrySourceRecord();
    const expectedId = createIrBindingId({
      ownerId: entrySource.id,
      domain: "support",
      role: DATE_CIVIL_SUPPORT_ROLE,
      ordinal: DATE_CIVIL_SUPPORT_ORDINAL,
    });
    const matchingEntries = result.programAbi!.abi.entries().filter((entry) => entry.displayName === DATE_CIVIL_HELPER);
    expect(matchingEntries).toHaveLength(1);
    expect(matchingEntries[0]).toMatchObject({
      id: expectedId,
      intent: {
        kind: "callable",
        origin: "support",
        sourceId: entrySource.id,
      },
    });

    const slot = result.programAbi!.abi.resolveFinalIndex(expectedId);
    expect(slot?.space).toBe("function");
    if (!slot || slot.space !== "function") throw new Error("missing date civil support slot");
    const importCount = result.module.imports.filter((entry) => entry.desc.kind === "func").length;
    expect(result.module.functions[slot.index - importCount]?.name).toBe(DATE_CIVIL_HELPER);
  });

  it("re-resolves the exact stable allocator after a late import and DCE compaction", () => {
    const sourceFile = ts.createSourceFile(
      "/repo/entry.ts",
      "export function entry(): number { return 1; }",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
    const entrySource = inventory.sources.find((source) => source.kind === "entry")!;
    const module = createEmptyModule();
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);

    const stableHandle = ensureDateCivilHelper(ctx);
    const helper = definedFuncAt(ctx, stableHandle);
    expect(helper?.name).toBe(DATE_CIVIL_HELPER);
    const expectedId = createIrBindingId({
      ownerId: entrySource.id,
      domain: "support",
      role: DATE_CIVIL_SUPPORT_ROLE,
      ordinal: DATE_CIVIL_SUPPORT_ORDINAL,
    });
    expect(session.hasLocator(expectedId, helper)).toBe(true);
    expect(session.locatorBindingId(helper!)).toBe(expectedId);
    expect(session.getDraft(expectedId)?.structuralOrder).toMatchObject({
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.dateCivilSupport,
      derivedOrdinal: DATE_CIVIL_SUPPORT_ORDINAL,
    });
    const ref = irSupportFuncRef(
      entrySource.id,
      DATE_CIVIL_SUPPORT_ROLE,
      DATE_CIVIL_HELPER,
      DATE_CIVIL_SUPPORT_ORDINAL,
    );
    expect(resolveProgramAbiSupportCallableHandle(ctx, ref, helper!)).toBe(0);

    ensureLateImport(ctx, "unused_late_date_import", [], []);
    flushLateImportShifts(ctx, null);
    expect(ctx.numImportFuncs).toBe(1);
    expect(ensureDateCivilHelper(ctx)).toBe(stableHandle);
    expect(resolveProgramAbiSupportCallableHandle(ctx, ref, helper!)).toBe(1);

    eliminateDeadImports(module, ctx);
    expect(module.imports).toEqual([]);
    expect(ensureDateCivilHelper(ctx)).toBe(stableHandle);
    expect(resolveProgramAbiSupportCallableHandle(ctx, ref, helper!)).toBe(0);
    eliminateDeadLayoutAndPlanProgramAbi(ctx);
    ctx.indexSpaceFrozen = true;
    const publication = session.publish(module);
    expect(publication.abi.resolveFinalIndex(expectedId)).toEqual({ space: "function", index: 0 });
    expect(module.functions[0]).toBe(helper);
  });

  it.each(["bigint", "number"] as const)(
    "preserves Date and same-named user %s functions in tracked and untracked lanes",
    async (kind) => {
      const untracked = await compileCollision(kind, false);
      const tracked = await compileCollision(kind, true);
      for (const result of [untracked, tracked]) {
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(result.imports).toEqual([]);
        expect(WebAssembly.validate(result.binary)).toBe(true);
        const { instance } = await WebAssembly.instantiate(result.binary, {});
        const exports = instance.exports as {
          userProbe: () => bigint | number;
          dateProbe: () => number;
        };
        expect(exports.userProbe()).toBe(kind === "bigint" ? 22n : 22);
        expect(exports.dateProbe()).toBe(19700101);
      }
      expect(tracked.binary).toEqual(untracked.binary);

      const ast = analyzeSource(collisionSource(kind), `issue-3520-date-civil-${kind}-collision.ts`);
      const generated = generateModule(ast, {
        experimentalIR: true,
        trackIrOutcomes: true,
        standalone: true,
      });
      expect(
        hardErrors(generated),
        hardErrors(generated)
          .map((error) => error.message)
          .join("\n"),
      ).toEqual([]);
      const entries = generated.programAbi!.abi.entries();
      const dateEntries = entries.filter((entry) => entry.id.includes(`:${DATE_CIVIL_SUPPORT_ROLE}:`));
      expect(dateEntries).toHaveLength(1);
      expect(dateEntries[0]).toMatchObject({
        displayName: DATE_CIVIL_HELPER,
        intent: { kind: "callable", origin: "support" },
      });
      expect(entries.filter((entry) => entry.displayName === DATE_CIVIL_HELPER)).toHaveLength(2);
    },
  );

  it("keeps tracked and untracked Date modules byte-identical", async () => {
    const options = {
      fileName: "issue-3520-date-civil-byte-parity.ts",
      experimentalIR: true,
      target: "standalone",
    } as const;
    const untracked = await compile(CALENDAR_SOURCE, options);
    const tracked = await compile(CALENDAR_SOURCE, { ...options, trackIrOutcomes: true });
    expect(untracked.success, untracked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(tracked.success, tracked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(tracked.binary).toEqual(untracked.binary);
  });

  it("preserves leap-day calendar behavior", async () => {
    const result = await compile(CALENDAR_SOURCE, {
      fileName: "issue-3520-date-civil-runtime.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports).toEqual([]);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.stamp as () => number)()).toBe(20240229);
  });

  /**
   * Deliberately NOT an absolute-count census (#3520 C35 follow-up).
   *
   * This assertion used to pin `definedFunctions: 166`, `dataRows: 5`,
   * `genericRows: 74 - vec - data` and the routing tuple `37/30/7/0/37/30`. Every
   * one of those numbers has since moved while the five corpus FILES are
   * byte-for-byte unchanged, so the test reported compiler evolution rather than
   * the ownership property it was written to defend — and stayed red for weeks.
   * The measured moves are recorded in the issue file's drift table; the largest
   * is legacy bodies 37 → 5, i.e. the R-series moving bodies onto the IR path.
   *
   * What is asserted here instead is self-derived from whatever the corpus
   * contains: every emitted civil-date helper has exactly one owner, it carries
   * this role, and none is left on the positional fallback.
   */
  it("owns every emitted civil-date helper across the five host entries", () => {
    let definedFunctions = 0;
    let dateHelperFunctions = 0;
    let dateRows = 0;
    let genericDateRows = 0;
    // Counts OUTCOME ROWS, not terminal units: since #3523's `non-executable`
    // arm a source can contribute an observational row that mints no terminal
    // unit at all. `scripts/check-ir-only.ts:403-416` draws the same partition.
    let outcomeRows = 0;
    let emitted = 0;
    let unsupported = 0;
    let invariants = 0;
    let nonExecutable = 0;

    for (const entry of SINGLE_HOST_ENTRIES) {
      const source = readFileSync(resolve(entry), "utf8");
      const ast = analyzeSource(source, entry);
      const result = generateModule(ast, {
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      const errors = hardErrors(result);
      expect(errors, `${entry}\n${errors.map((error) => error.message).join("\n")}`).toEqual([]);
      definedFunctions += result.module.functions.length;
      dateHelperFunctions += result.module.functions.filter((func) => func.name === DATE_CIVIL_HELPER).length;
      const entries = result.programAbi!.abi.entries();
      const callableRows = entries.filter((candidate) => candidate.intent?.kind === "callable");
      dateRows += callableRows.filter((candidate) => candidate.id.includes(`:${DATE_CIVIL_SUPPORT_ROLE}:`)).length;
      genericDateRows += callableRows.filter(
        (candidate) =>
          candidate.id.includes(":retained-module-function:") && candidate.displayName === DATE_CIVIL_HELPER,
      ).length;
      for (const outcome of result.irOutcomes ?? []) {
        outcomeRows++;
        if (outcome.kind === "emitted") emitted++;
        if (outcome.kind === "unsupported") unsupported++;
        if (outcome.kind === "invariant") invariants++;
        if (outcome.kind === "non-executable") {
          nonExecutable++;
          // The widened total below subtracts these rows, so they must be
          // proven well-formed here: a malformed observational row would
          // otherwise be excused rather than caught.
          expect(nonExecutableOutcomeDefect(outcome), `${entry} ${outcome.key}`).toBeUndefined();
        }
      }
    }

    // Anti-vacuity: the corpus must actually contain functions and at least one
    // civil-date helper, or every claim below is trivially true.
    expect(definedFunctions).toBeGreaterThan(0);
    expect(dateHelperFunctions).toBeGreaterThan(0);
    // One structural callable owner per emitted helper...
    expect(dateRows).toBe(dateHelperFunctions);
    // ...and none of them left on the positional fallback.
    expect(genericDateRows).toBe(0);
    // Routing stays total and invariant-free. The emitted/unsupported SPLIT is a
    // corpus denominator and deliberately not pinned here; `check:ir-only` is the
    // gate that owns it.
    expect(outcomeRows).toBeGreaterThan(0);
    expect(emitted + unsupported + invariants).toBe(outcomeRows - nonExecutable);
    expect(invariants).toBe(0);
  });
});
