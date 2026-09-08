// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allAdapterPath,
  combinatorPath,
  delayAdapterPath,
  delayPath,
  donorPath,
  donorNames,
  executeArm,
  fn,
  readerAt,
  receipt,
  semanticReceipt,
  RETAINED_DECLARATIONS,
  validateArm,
  verifyHistorical,
  verifyRetainedDeclarations,
} from "./helpers/native-delay-combinator-source-receipts.mjs";

const root = resolve(import.meta.dirname, ".."),
  read = readerAt(root);
describe("eight historical combinator bodies reconstructed from mandatory live owners", () => {
  it("retains the eight-donor denominator and separately accounts for delay/vector/dispatch", () => {
    expect(donorNames).toHaveLength(8);
    expect(verifyHistorical(read)).toEqual({
      historicalDonors: 8,
      delayRows: 4,
      vectorLoops: 1,
      sharedDispatchHelpers: 1,
    });
  });
  for (const missing of [combinatorPath, delayPath, donorPath, delayAdapterPath, allAdapterPath]) {
    it(`rejects missing mandatory source ${missing}`, () =>
      expect(() =>
        verifyHistorical((path: string) => {
          if (path === missing) throw new Error("missing source");
          return read(path);
        }),
      ).toThrow());
  }
  for (const [label, path, before, after] of [
    ["callback handle", delayPath, "funcIdx: resources.resolveValueFuncIdx", "funcIdx: resources.boxNumberFuncIdx"],
    ["capture field", delayPath, "fieldIdx: resources.capture.promiseFieldIdx", "fieldIdx: 4"],
    ["timer capture order", delayPath, 'op: "local.get", index: 1', 'op: "local.get", index: 0'],
    ["timer foreign rejection", delayPath, "funcIdx: resources.rejectFuncIdx", "funcIdx: resources.timerFuncIdx"],
    ["capture header", delayAdapterPath, "superTypeIdx: callbackWrapper.structTypeIdx", "superTypeIdx: 0"],
    ["allocation observation", delayAdapterPath, 'ctx, [], [], "host-one-shot"', 'ctx, [], [], "ordinary"'],
    ["closure bag validation", delayAdapterPath, 'bagInit.op !== "ref.null.extern"', "false"],
    ["resolve-value guard", combinatorPath, "ids.resolveValueFuncIdx < 0", "ids.resolveValueFuncIdx < -1"],
    [
      "zero handled binding",
      combinatorPath,
      "ids.markRejectionHandledFuncIdx !== undefined",
      "!!ids.markRejectionHandledFuncIdx",
    ],
    ["reaction dispatch target", combinatorPath, "funcIdx: ids.enqueueFuncIdx", "funcIdx: 0"],
    ["remaining decrement", combinatorPath, 'op: "i32.sub"', 'op: "i32.add"'],
    [
      "results store",
      combinatorPath,
      'op: "array.set", typeIdx: ids.arrTypeIdx',
      'op: "array.set", typeIdx: ids.vecTypeIdx',
    ],
    ["wrapper target", combinatorPath, "buildSettleResultBody(ids, rejectFuncIdx)", "buildSettleResultBody(ids, 0)"],
    ["local index", combinatorPath, "const REM = 4", "const REM = 5"],
    ["empty all", combinatorPath, 'ids.emptyResult.kind === "fulfill-vector"', 'ids.emptyResult.kind === "pending"'],
    ["loop exit depth", combinatorPath, 'op: "br_if", depth: 1', 'op: "br_if", depth: 0'],
    ["loop backedge", combinatorPath, 'op: "br", depth: 0', 'op: "br", depth: 1'],
    [
      "callback reference order",
      combinatorPath,
      "funcIdx: ids.fulfillReactionFuncIdx",
      "funcIdx: ids.rejectReactionFuncIdx",
    ],
    ["documentation", combinatorPath, "LOGICAL length", "backing capacity"],
    ["capture readonly", combinatorPath, "readonly elemCapsTypeIdx", "elemCapsTypeIdx"],
    ["legacy-only fallback", donorPath, "resolveValueFuncIdx >= 0", "resolveValueFuncIdx > 0"],
    [
      "independent mint",
      donorPath,
      "const allFulfillFuncIdx = mintDefinedFunc(ctx)",
      "const allFulfillFuncIdx = subscribeFuncIdx + 1",
    ],
    ["immediate append", donorPath, "fctx.body.push(...body)", "fctx.body = body"],
    ["fresh projection", donorPath, "subscribeFuncIdx: ids.subscribeFuncIdx", "subscribeFuncIdx: 0"],
    ["restoration", allAdapterPath, "ctx.currentFunc = previous", "ctx.currentFunc = null"],
    ["new hidden edge", combinatorPath, 'from "./settlement-bodies.js"', 'from "../../../codegen/async-scheduler.js"'],
  ]) {
    it(`rejects live ${label} mutation, not a mutation of reconstructed output`, () => {
      expect(read(path!).includes(before!)).toBe(true);
      expect(() =>
        verifyHistorical((file: string) => (file === path ? read(file).replace(before!, after!) : read(file))),
      ).toThrow();
    });
  }
  for (const name of donorNames)
    it(`rejects removed or renamed historical donor ${name}`, () => {
      const text = read(combinatorPath),
        node = fn(text, name),
        renamed = text.slice(0, node.name!.pos) + " missingHistoricalDonor" + text.slice(node.name!.end);
      expect(() => verifyHistorical((path: string) => (path === combinatorPath ? renamed : read(path)))).toThrow();
    });
  it("rejects duplicate live declarations", () => {
    const text = read(combinatorPath),
      duplicate = fn(text, "buildRejectBody").getText();
    expect(() =>
      verifyHistorical((path: string) => (path === combinatorPath ? text + "\n" + duplicate : read(path))),
    ).toThrow();
  });
  it("rejects changed declaration order instead of sorting live functions by donor name", () => {
    const text = read(combinatorPath),
      first = fn(text, "buildRaceFulfillBody"),
      second = fn(text, "buildRejectBody");
    const changed =
      text.slice(0, first.getStart()) +
      second.getText() +
      text.slice(first.end, second.getStart()) +
      first.getText() +
      text.slice(second.end);
    expect(() => verifyHistorical((path: string) => (path === combinatorPath ? changed : read(path)))).toThrow();
  });
});

describe("supplemental semantic fields and the original 24-declaration ledger", () => {
  it("checks the fixed 20+4 original declarations independently of candidate glue hashes", () => {
    expect(verifyRetainedDeclarations(read)).toEqual({ combinator: 20, delay: 4 });
  });
  for (const [label, path, name, before, after, expectedFailure] of [
    [
      "new guard unary operator",
      combinatorPath,
      "buildSubscribeBody",
      "!Number.isInteger",
      "~Number.isInteger",
      "live semantic glue/schema",
    ],
    [
      "retained unary operator",
      delayAdapterPath,
      "hasExactIrNativePromiseDelayProvider",
      "!cached",
      "~cached",
      "original retained declaration ledger",
    ],
    [
      "moved const to let",
      combinatorPath,
      "buildAllFulfillBody",
      "const REM = 4",
      "let REM = 4",
      "historical semantic body buildAllFulfillBody",
    ],
    [
      "moved const to var",
      combinatorPath,
      "buildAllFulfillBody",
      "const REM = 4",
      "var REM = 4",
      "historical semantic body buildAllFulfillBody",
    ],
    [
      "retained postfix operator",
      donorPath,
      "emitStandalonePromiseCombinator",
      "i++",
      "i--",
      "original retained declaration ledger",
    ],
  ]) {
    it(`independently detects live ${label} where the unchanged old hash collides`, () => {
      const text = read(path!),
        node = fn(text, name!),
        declaration = node.getText();
      expect(declaration.includes(before!)).toBe(true);
      const changed = text.slice(0, node.getStart()) + declaration.replace(before!, after!) + text.slice(node.end);
      expect(receipt(changed)).toBe(receipt(text));
      expect(semanticReceipt(changed)).not.toBe(semanticReceipt(text));
      expect(() => verifyHistorical((file: string) => (file === path ? changed : read(file)))).toThrow(expectedFailure);
    });
  }
  for (const { path, name } of RETAINED_DECLARATIONS) {
    for (const mutation of ["delete", "rename", "body-change"] as const) {
      it(`rejects ${mutation} of original ${path}:${name} without consulting glue hashes`, () => {
        const text = read(path),
          node = fn(text, name);
        let changed: string;
        if (mutation === "delete") changed = text.slice(0, node.getStart(undefined, true)) + text.slice(node.end);
        else if (mutation === "rename")
          changed = text.slice(0, node.name!.getStart()) + "renamedHistoricalDeclaration" + text.slice(node.name!.end);
        else {
          assert(node.body);
          const position = node.body.getStart() + 1;
          changed = text.slice(0, position) + '\nthrow new Error("changed retained body");\n' + text.slice(position);
        }
        expect(() => verifyRetainedDeclarations((file: string) => (file === path ? changed : read(file)))).toThrow();
      });
    }
  }
  for (const path of [donorPath, delayAdapterPath]) {
    it(`rejects retained declaration reordering in ${path}`, () => {
      const text = read(path),
        names = RETAINED_DECLARATIONS.filter((row) => row.path === path).map((row) => row.name);
      const first = fn(text, names[0]!),
        second = fn(text, names[1]!);
      const changed =
        text.slice(0, first.getStart()) +
        second.getText() +
        text.slice(first.end, second.getStart()) +
        first.getText() +
        text.slice(second.end);
      expect(() => verifyRetainedDeclarations((file: string) => (file === path ? changed : read(file)))).toThrow(
        "declaration order",
      );
    });
    it(`rejects duplicate original declaration/occurrence in ${path}`, () => {
      const text = read(path),
        name = RETAINED_DECLARATIONS.find((row) => row.path === path)!.name;
      const changed = text + "\n" + fn(text, name).getText();
      expect(() => verifyRetainedDeclarations((file: string) => (file === path ? changed : read(file)))).toThrow(
        "declaration order",
      );
    });
  }
  it("covers original attached documentation in the retained ledger", () => {
    const text = read(delayAdapterPath),
      before = "Prove that this context already owns the exact cached native provider.";
    expect(text.includes(before)).toBe(true);
    const changed = text.replace(before, "Changed cached ownership documentation.");
    expect(() =>
      verifyRetainedDeclarations((file: string) => (file === delayAdapterPath ? changed : read(file))),
    ).toThrow("original retained declaration ledger");
  });
});

describe("public-source execution preservation, not full-family physical acceptance", () => {
  it("executes eleven grounded artifacts / nineteen executions, with an explicit optional historical pair", async () => {
    const baseline = process.env.JS2WASM_DELAY_COMBINATOR_BASELINE_ROOT;
    mkdirSync(join(root, ".tmp"), { recursive: true });
    const directory = mkdtempSync(join(root, ".tmp", "delay-combinator-preservation-"));
    const after = await executeArm(root, "candidate", directory);
    let before;
    if (baseline !== undefined) {
      assert.notEqual(realpathSync(baseline), realpathSync(root), "historical root cannot be candidate");
      // Serial, never concurrent. The child independently pins baseline source
      // to 1cb0f5c7 (the complete prerequisite before this extraction).
      before = await executeArm(baseline, "baseline", directory);
    }
    validateArm(after, root);
    if (before) {
      validateArm(before, baseline);
      expect(after.fixtures).toEqual(before.fixtures);
      // Complete bytes, WAT, result/resource order, outcomes and actual values;
      // every execution also pins the exact bytes passed to instantiate.
      expect(after.rows).toEqual(before.rows);
    }
    writeFileSync(
      join(directory, "verdict.json"),
      JSON.stringify(
        {
          currentRootOracles: true,
          historicalPair: before ? "passed" : "NOT_RUN",
          artifacts: 11,
          executionsPerRoot: 19,
          familyScenarios: 8,
          physicalAcceptanceCertified: false,
          retirementCertified: false,
        },
        null,
        2,
      ),
    );
    console.log(
      `preservation-only: 11 artifacts / 19 executions; pair ${before ? "passed" : "NOT RUN (set JS2WASM_DELAY_COMBINATOR_BASELINE_ROOT explicitly)"}; evidence ${directory}; physical acceptance NOT CERTIFIED`,
    );
  }, 0);
});
