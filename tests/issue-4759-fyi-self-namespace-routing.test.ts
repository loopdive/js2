// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4759 — test262.fyi needs an explicit empty module graph for the narrow
// namespace self-import shape. These tests preserve the literal harness source
// and verify the reader/executor/worker boundary without changing verdicts.

import { beforeAll, describe, expect, it } from "vitest";
import { loadOriginalHarnessTests } from "../scripts/test262-fyi-reader.mjs";
import { runTest } from "../scripts/run-test262-fyi.mjs";

const SELF_NAMESPACE_PATH = "language/module-code/namespace/Symbol.iterator.js";
const CIRCULAR_FIXTURE_PATH = "language/module-code/instn-star-props-circular.js";
const NON_NAMESPACE_PROXY_PATH = "built-ins/Proxy/preventExtensions/trap-is-undefined-target-is-proxy.js";
const SYNTHETIC_SELF_NAMESPACE_PATH = "language/module-code/namespace/fyi-self-route-control.js";

type OriginalHarnessRecord = Awaited<ReturnType<typeof loadOriginalHarnessTests>>[number];
type SelfGraphRecord = OriginalHarnessRecord & {
  entryFile?: string;
  fixtureFiles?: Record<string, string>;
  selfModuleGraph?: boolean;
};

let records = new Map<string, SelfGraphRecord>();

function record(path: string): SelfGraphRecord {
  const value = records.get(path);
  if (!value) throw new Error(`missing original-harness record: ${path}`);
  return value;
}

function syntheticSelfNamespaceRecord(): SelfGraphRecord {
  return {
    file: SYNTHETIC_SELF_NAMESPACE_PATH,
    contents: `
      import * as ns from "./fyi-self-route-control.js";
      export const answer = 42;
      if (ns.answer !== 42) throw new Error("self namespace did not link");
    `,
    flags: { module: true },
    negative: undefined,
    strictRerun: false,
    entryFile: `./${SYNTHETIC_SELF_NAMESPACE_PATH}`,
    fixtureFiles: {},
    selfModuleGraph: true,
  };
}

describe("#4759 FYI namespace self-import routing", () => {
  beforeAll(async () => {
    records = new Map(
      (await loadOriginalHarnessTests([SELF_NAMESPACE_PATH, CIRCULAR_FIXTURE_PATH, NON_NAMESPACE_PROXY_PATH])).map(
        (test) => [test.file, test as SelfGraphRecord],
      ),
    );
  }, 60_000);

  it("marks only the literal namespace self-import as an empty static graph", () => {
    const self = record(SELF_NAMESPACE_PATH);
    const circular = record(CIRCULAR_FIXTURE_PATH);
    const proxy = record(NON_NAMESPACE_PROXY_PATH);

    expect(self.entryFile).toBe(`./${SELF_NAMESPACE_PATH}`);
    expect(self.fixtureFiles).toEqual({});
    expect(self.selfModuleGraph).toBe(true);

    expect(circular.selfModuleGraph).toBeUndefined();
    expect(Object.keys(circular.fixtureFiles ?? {})).toHaveLength(2);
    expect(proxy.entryFile).toBeUndefined();
    expect(proxy.selfModuleGraph).toBeUndefined();
  });

  it.each(["gc", "standalone"] as const)("links an empty self graph in %s", { timeout: 60_000 }, async (target) => {
    await expect(runTest(syntheticSelfNamespaceRecord(), target)).resolves.toMatchObject({
      pass: true,
      phase: "runtime",
    });
  });

  it.each(["gc", "standalone"] as const)(
    "runs the exact namespace original through the linked graph in %s",
    { timeout: 60_000 },
    async (target) => {
      await expect(runTest(record(SELF_NAMESPACE_PATH), target)).resolves.toMatchObject({
        pass: true,
        phase: "runtime",
        reachedTest: true,
      });
    },
  );

  it.each(["gc", "standalone"] as const)(
    "retains the original single-source failure when the graph flag is disabled in %s",
    { timeout: 60_000 },
    async (target) => {
      const result = await runTest(
        {
          ...record(SELF_NAMESPACE_PATH),
          selfModuleGraph: false,
        },
        target,
      );

      expect(result).toMatchObject({
        pass: false,
        phase: "runtime",
      });
      expect(result.detail ?? "").toContain("ns is not defined");
    },
  );

  it.each(["gc", "standalone"] as const)(
    "retains the genuinely linked circular fixture graph in %s",
    { timeout: 60_000 },
    async (target) => {
      await expect(runTest(record(CIRCULAR_FIXTURE_PATH), target)).resolves.toMatchObject({
        pass: true,
        phase: "runtime",
      });
    },
  );

  it.each(["gc", "standalone"] as const)(
    "rejects a forged non-namespace self-graph request in %s",
    { timeout: 60_000 },
    async (target) => {
      const proxy = record(NON_NAMESPACE_PROXY_PATH);
      const result = await runTest(
        {
          ...proxy,
          entryFile: `./${NON_NAMESPACE_PROXY_PATH}`,
          fixtureFiles: {},
          selfModuleGraph: true,
        },
        target,
      );

      expect(result).toMatchObject({ pass: false });
      expect(result.detail ?? "").toContain("ns is not defined");
    },
  );
});
