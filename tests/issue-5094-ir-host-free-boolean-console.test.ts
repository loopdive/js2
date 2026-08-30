// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";

const HOST_BRIDGE = { hostBridge: "always" } as const;

const BRANDED_BOOLEAN_SOURCE = `
export function main(flag: boolean): void {
  const local: boolean = flag;
  console.log(flag);
  console.warn(!flag);
  console.error(flag === true);
  console.info(1 < 0);
  console.debug(local);
  console.log(true);
  console.warn(false);
}
`;

const EXPECTED_BRANDED_BOOLEAN_STDOUT = "true\nfalse\ntrue\nfalse\ntrue\ntrue\nfalse\n";

type StandaloneRun = {
  readonly result: CompileResult;
  readonly stdout: string;
  readonly importCount: number;
};

async function runStandalone(
  source: string,
  mainArgs: readonly number[] = [],
  experimentalIR = true,
): Promise<StandaloneRun> {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    experimentalIR,
    trackIrOutcomes: true,
    ...HOST_BRIDGE,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) throw new Error("standalone compilation failed");

  const module = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(module, {});
  const exports = instance.exports as Record<string, unknown>;
  const init = exports.__module_init as (() => void) | undefined;
  init?.();
  const main = exports.main as (...args: number[]) => void;
  main(...mainArgs);

  const prepare = exports.__stdout_prepare as () => number;
  const char = exports.__stdout_char as (index: number) => number;
  const length = prepare();
  let stdout = "";
  for (let i = 0; i < length; i++) stdout += String.fromCharCode(char(i));

  return {
    result,
    stdout,
    importCount: WebAssembly.Module.imports(module).length,
  };
}

function outcomeFor(outcomes: readonly IrObservedOutcome[], displayName: string): IrObservedOutcome {
  const outcome = outcomes.find((candidate) => candidate.displayName === displayName);
  expect(outcome, `missing IR outcome for ${displayName}`).toBeDefined();
  if (!outcome) throw new Error(`missing IR outcome for ${displayName}`);
  return outcome;
}

describe("issue #5094: host-free console boolean lowering", () => {
  it("renders every exact branded boolean producer with no imports", async () => {
    const { result, stdout, importCount } = await runStandalone(BRANDED_BOOLEAN_SOURCE, [1]);

    expect(stdout).toBe(EXPECTED_BRANDED_BOOLEAN_STDOUT);
    expect(importCount).toBe(0);

    const main = outcomeFor(result.irOutcomes ?? [], "main");
    expect(main).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });
    expect((result.irOutcomes ?? []).filter((outcome) => outcome.kind === "invariant")).toEqual([]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps an unbranded i32 number on the numeric rendering path", async () => {
    const { result, stdout, importCount } = await runStandalone(
      `
export function main(): void {
  const s: string = "a";
  console.log(s.length);
}
`,
    );

    expect(stdout).toBe("1\n");
    expect(importCount).toBe(0);
    expect(outcomeFor(result.irOutcomes ?? [], "main")).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
      legacyBodyEmitted: false,
    });
    expect((result.irOutcomes ?? []).filter((outcome) => outcome.kind === "invariant")).toEqual([]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("does not claim an excluded console selector shape", async () => {
    const result = await compile(
      `
export function main(): void {
  console.log(true, false);
}
`,
      {
        fileName: "test.ts",
        target: "standalone",
        experimentalIR: true,
        trackIrOutcomes: true,
        ...HOST_BRIDGE,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const main = outcomeFor(result.irOutcomes ?? [], "main");
    expect(main).toMatchObject({ kind: "unsupported", code: "host-surface-unavailable" });
    expect((result.irOutcomes ?? []).filter((outcome) => outcome.kind === "invariant")).toEqual([]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("preserves the legacy control when experimental IR is disabled", async () => {
    const { result, stdout, importCount } = await runStandalone(BRANDED_BOOLEAN_SOURCE, [1], false);

    // The legacy standalone scalar fallback intentionally drops bare boolean
    // carriers; this control only proves the direct path still compiles and
    // executes without introducing imports. Boolean spelling belongs to IR.
    expect(stdout).toBe("\n".repeat(7));
    expect(importCount).toBe(0);
    expect(result.success).toBe(true);
  });
});
