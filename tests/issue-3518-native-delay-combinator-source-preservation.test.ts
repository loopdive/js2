// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  allAdapterPath,
  combinatorPath,
  delayAdapterPath,
  delayPath,
  donorPath,
  donorNames,
  executeArm,
  fn,
  parse,
  readerAt,
  receipt,
  semanticReceipt,
  RETAINED_DECLARATIONS,
  validateArm,
  verifyHistorical,
  verifyForwardDelayHistorical,
  DELAY_EH_FORWARD_EVIDENCE,
  verifyRetainedDeclarations,
} from "./helpers/native-delay-combinator-source-receipts.mjs";

const root = resolve(import.meta.dirname, ".."),
  read = readerAt(root);
const verifyCurrent = (reader: (path: string) => string) => verifyForwardDelayHistorical(reader).historical;
describe("eight historical combinator bodies reconstructed from mandatory live owners", () => {
  it("retains the eight-donor denominator and separately accounts for delay/vector/dispatch", () => {
    expect(donorNames).toHaveLength(8);
    expect(verifyCurrent(read)).toEqual({
      historicalDonors: 8,
      delayRows: 4,
      vectorLoops: 1,
      sharedDispatchHelpers: 1,
    });
  });
  for (const missing of [combinatorPath, delayPath, donorPath, delayAdapterPath, allAdapterPath]) {
    it(`rejects missing mandatory source ${missing}`, () =>
      expect(() =>
        verifyCurrent((path: string) => {
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
        verifyCurrent((file: string) => (file === path ? read(file).replace(before!, after!) : read(file))),
      ).toThrow();
    });
  }
  for (const name of donorNames)
    it(`rejects removed or renamed historical donor ${name}`, () => {
      const text = read(combinatorPath),
        node = fn(text, name),
        renamed = text.slice(0, node.name!.pos) + " missingHistoricalDonor" + text.slice(node.name!.end);
      expect(() => verifyCurrent((path: string) => (path === combinatorPath ? renamed : read(path)))).toThrow();
    });
  it("rejects duplicate live declarations", () => {
    const text = read(combinatorPath),
      duplicate = fn(text, "buildRejectBody").getText();
    expect(() =>
      verifyCurrent((path: string) => (path === combinatorPath ? text + "\n" + duplicate : read(path))),
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
    expect(() => verifyCurrent((path: string) => (path === combinatorPath ? changed : read(path)))).toThrow();
  });
});

describe("landed standard-EH forwarding with unchanged historical ledgers", () => {
  function changeGuard(text: string, change: (call: ts.CallExpression) => string): string {
    const provider = fn(text, "buildNativePromiseDelayProviderBody");
    const result = provider.body!.statements.at(-1);
    assert(
      result && ts.isReturnStatement(result) && result.expression && ts.isArrayLiteralExpression(result.expression),
    );
    const call = result.expression.elements[6];
    assert(call && ts.isCallExpression(call));
    return text.slice(0, call.getStart()) + change(call) + text.slice(call.end);
  }
  function replaceHandlers(call: ts.CallExpression, indices: number[]): string {
    const handlers = call.arguments[2];
    assert(handlers && ts.isArrayLiteralExpression(handlers));
    const prefix = call.getText().slice(0, handlers.getStart() - call.getStart());
    const suffix = call.getText().slice(handlers.end - call.getStart());
    return prefix + "[" + indices.map((index) => handlers.elements[index]!.getFullText()).join(",") + "]" + suffix;
  }
  const helperImport = 'import { buildStandardTryTable } from "../../../wasm/physical/exception-control.js";';
  it("proves the forward delta separately and keeps the old verifier strict", () => {
    expect(DELAY_EH_FORWARD_EVIDENCE.commit).toBe("d4108568d43f14c361ecc3a58c82633027eaae39");
    expect(verifyForwardDelayHistorical(read)).toEqual({
      historical: { historicalDonors: 8, delayRows: 4, vectorLoops: 1, sharedDispatchHelpers: 1 },
      forwardEh: { reference: DELAY_EH_FORWARD_EVIDENCE.commit, tagged: 1, foreign: 1 },
    });
    expect(() => verifyHistorical(read)).toThrow("historical body delay-provider");
  });
  for (const [label, changedImport, guard] of [
    [
      "with attributes",
      helperImport.slice(0, -1) + ' with { type: "json" };',
      "ordinary EH import without attributes or assertions",
    ],
    [
      "assert clause",
      helperImport.slice(0, -1) + ' assert { type: "json" };',
      "ordinary EH import without attributes or assertions",
    ],
    ["defer phase", helperImport.replace("import {", "import defer {"), "ordinary EH import without a phase modifier"],
  ] as const) {
    it(`rejects ${label} before erasing the projected import`, () => {
      expect(verifyCurrent(read).delayRows).toBe(4);
      const original = read(delayPath),
        changed = original.replace(helperImport, changedImport);
      expect(changed).not.toBe(original);
      expect(() => parse(changed)).not.toThrow();
      expect(() => verifyForwardDelayHistorical((path: string) => (path === delayPath ? changed : read(path)))).toThrow(
        guard,
      );
    });
  }
  const mutations: [string, (text: string) => string][] = [
    ["missing downward import", (text) => text.replace(helperImport, "")],
    ["duplicate downward import", (text) => text + "\n" + helperImport],
    ["missing canonical call", (text) => changeGuard(text, () => '{ op: "nop" }')],
    [
      "wrong helper",
      (text) => changeGuard(text, (call) => call.getText().replace("buildStandardTryTable", "buildTargetTaggedTry")),
    ],
    [
      "duplicate canonical call",
      (text) => {
        let duplicate = "";
        changeGuard(text, (call) => {
          duplicate = call.getText();
          return duplicate;
        });
        return text + "\n" + duplicate + ";\n";
      },
    ],
    ["lost tagged route", (text) => changeGuard(text, (call) => replaceHandlers(call, [1]))],
    ["lost foreign route", (text) => changeGuard(text, (call) => replaceHandlers(call, [0]))],
    ["reordered routes", (text) => changeGuard(text, (call) => replaceHandlers(call, [1, 0]))],
    ["duplicate foreign route", (text) => changeGuard(text, (call) => replaceHandlers(call, [0, 1, 1]))],
    ["wrong tag", (text) => text.replace("tagIdx: resources.exnTagIdx", "tagIdx: 0")],
    [
      "wrong tagged payload type",
      (text) => text.replace('payloadType: { kind: "externref" }', 'payloadType: { kind: "f64" }'),
    ],
    [
      "wrong rejection target",
      (text) => text.replace("funcIdx: resources.rejectFuncIdx", "funcIdx: resources.timerFuncIdx"),
    ],
    [
      "changed foreign sentinel",
      (text) =>
        changeGuard(text, (call) => {
          const handlers = call.arguments[2];
          assert(handlers && ts.isArrayLiteralExpression(handlers));
          const foreign = handlers.elements[1]!;
          const body = foreign.getText().replace('op: "ref.null.extern"', 'op: "ref.null.any"');
          return (
            call.getText().slice(0, foreign.getStart() - call.getStart()) +
            body +
            call.getText().slice(foreign.end - call.getStart())
          );
        }),
    ],
  ];
  for (const [label, change] of mutations) {
    it(`rejects ${label} before accepting a historical projection`, () => {
      const original = read(delayPath),
        changed = change(original);
      expect(original).toContain(helperImport);
      expect(changed).not.toBe(original);
      expect(() => parse(changed)).not.toThrow();
      expect(() =>
        verifyForwardDelayHistorical((path: string) => (path === delayPath ? changed : read(path))),
      ).toThrow();
    });
  }
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
      expect(() => verifyCurrent((file: string) => (file === path ? changed : read(file)))).toThrow(expectedFailure);
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
