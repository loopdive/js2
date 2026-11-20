// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { B1_FACTORY_PATH } from "./helpers/native-delay-combinator-b1-inverse.mjs";
import { beforePromiseExportMain } from "./helpers/promise-export-main-port.js";
import { beforeEarlierPromiseMain } from "./helpers/promise-earlier-main-port.js";
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
  validateArm,
  verifyForwardDelayHistorical,
} from "./helpers/native-delay-combinator-source-receipts.mjs";

const root = resolve(import.meta.dirname, ".."),
  rawRead = readerAt(root),
  read = (path: string): string => beforeEarlierPromiseMain(path, beforePromiseExportMain(path, rawRead(path)));
const verifyCurrent = (reader: (path: string) => string) => verifyForwardDelayHistorical(reader).historical;
describe("eight historical combinator bodies reconstructed from mandatory live owners", () => {
  for (const missing of [combinatorPath, delayPath, donorPath, delayAdapterPath, allAdapterPath, B1_FACTORY_PATH]) {
    it(`rejects missing mandatory source ${missing}`, () =>
      expect(() =>
        verifyCurrent((path: string) => {
          if (path === missing) throw new Error("missing source");
          return read(path);
        }),
      ).toThrow());
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
