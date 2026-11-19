// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7363 A1 — a "called" module init: startup does not run it, its call site does.
// Only a literal eval's relation (A2) will make a plan "called". Until then this test wraps
// `buildIrModuleInitPlan` to mark one named script's plan "called" (and re-verifies it), so every
// consumer below runs on a plan of the shape A2 will produce.
import { describe, expect, it, vi } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { absoluteFuncIndex } from "../src/emit/resolve-layout.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import {
  buildIrModuleInitPlan,
  IrModuleInitPlanInvariantError,
  runsAtStartup,
  verifyIrModuleInitPlan,
  type IrModuleInitPlan,
} from "../src/ir/module-init-plan.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import {
  acceptPreparedIrProgram,
  emitAcceptedIrProgram,
  emittedStartupAdapterIndex,
} from "../src/ir/program-consumer.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { compileMulti, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";
import { requireProgram, sourceInput } from "./helpers/typed-program-fixtures.js";

const state = vi.hoisted(() => ({ calledFile: undefined as string | undefined }));

vi.mock("../src/ir/module-init-plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/module-init-plan.js")>();
  return {
    ...actual,
    buildIrModuleInitPlan(input: Parameters<typeof actual.buildIrModuleInitPlan>[0]) {
      const plan = actual.buildIrModuleInitPlan(input);
      if (state.calledFile === undefined || !input.sourceFile.fileName.endsWith(state.calledFile)) return plan;
      const called = Object.freeze({
        ...plan,
        invocation: Object.freeze({ ...plan.invocation, kind: "called" as const, exactlyOnce: false }),
      });
      actual.verifyIrModuleInitPlan(called, input.sourceFile);
      return called;
    },
  };
});

function withCalled<T>(file: string | undefined, run: () => T): T {
  state.calledFile = file;
  try {
    return run();
  } finally {
    state.calledFile = undefined;
  }
}

const options = {
  wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
  backend: "wasmgc",
  target: "standalone",
  sourceMap: false,
  optimize: false,
  emitWat: false,
  allowJs: true,
} as Test262CompileOptions;

/** Prepare and emit two TS scripts; name the unit each call of the startup adapter reaches. */
function adapterTargets(called: string | undefined) {
  const files = {
    "./called.ts": "function f(): number { return 1; } f();",
    "./entry.ts": "function g(): number { return 2; } g();",
  };
  const program = withCalled(called, () => requireProgram(prepareWholeIrProgram(sourceInput(files))));
  const accepted = acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone"));
  if (accepted.kind !== "accepted") throw new Error(accepted.detail);
  const emitted = emitAcceptedIrProgram(accepted);
  const { module, emittedUnitIds } = emitted;
  // Emitted units occupy the first function positions, in `emittedUnitIds` order; the adapter follows them.
  const targets = module.functions[emittedStartupAdapterIndex(emitted)!]!.body.map((instruction) =>
    instruction.op === "call" ? emittedUnitIds[absoluteFuncIndex(module, instruction.funcIdx)] : instruction.op,
  );
  return { program, emitted: emittedUnitIds, targets };
}

/** Compile the two scripts through the strict Prepared entry and run the module's startup. */
async function startup(files: Record<string, string>, called: string | undefined): Promise<"returned" | "threw"> {
  // `compileMulti` prepares synchronously before its promise settles, so the wrapper sees every plan.
  const result = await withCalled(called, () => compileMulti(files, "test.js", options));
  expect(result.errors.map((error) => error.message)).toEqual([]);
  try {
    const exports = instantiatePreparedArtifact(result).instance.exports;
    (exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

describe("#7363 A1 — a called module init", () => {
  it("is emitted, and the startup adapter calls only the other init", () => {
    const uncalled = adapterTargets(undefined);
    expect(uncalled.targets).toEqual(uncalled.program.startup.map((plan) => plan.unitId));
    const { program, emitted, targets } = adapterTargets("called.ts");
    const called = program.startup.find((plan) => plan.invocation.kind === "called")!;
    const other = program.startup.find((plan) => plan !== called)!;
    expect(called.invocation).toEqual({ target: "standalone", kind: "called", exactlyOnce: false });
    expect(other.invocation.kind).toBe("wasm-start");
    expect(program.startup.map(runsAtStartup)).toEqual(program.startup.map((plan) => plan === other));
    expect(targets).toEqual([other.unitId]);
    expect(emitted).toContain(called.unitId);
  });

  it("does not run at startup; the same script uncalled does", async () => {
    const files = { "called.js": "throw 1;", "test.js": "if (1 + 1 !== 2) throw 2;" };
    expect(await startup(files, "called.js")).toBe("returned");
    expect(await startup(files, undefined)).toBe("threw");
  });

  it("compiles a program whose only executable init is called, with no startup to run", async () => {
    const files = { "called.js": "throw 1;", "test.js": "function f() { return 1; }" };
    expect(await startup(files, "called.js")).toBe("returned");
    expect(await startup(files, undefined)).toBe("threw");
  });
});

describe("#7363 A1 — the verifier ties exactlyOnce to the invocation kind", () => {
  /** The real plan of `source` with its invocation replaced, verified against the same source. */
  const verify = (source: string, kind: IrModuleInitPlan["invocation"]["kind"], exactlyOnce: boolean) => {
    const { sourceFile, checker } = analyzeSource(source, "verify.ts");
    const identityContext = buildIrPlanningIdentityContext(
      buildIrUnitInventory([sourceFile], { entrySource: sourceFile, checker }),
    );
    const plan = buildIrModuleInitPlan({
      sourceFile,
      checker,
      identityContext,
      target: "standalone",
      deferTopLevelInit: false,
    });
    return () => verifyIrModuleInitPlan({ ...plan, invocation: { ...plan.invocation, kind, exactlyOnce } }, sourceFile);
  };
  const startupKinds = ["wasm-start", "deferred-export", "wasi-start-export"] as const;

  it("accepts called with exactlyOnce false and every other kind with true", () => {
    expect(verify("throw 1;", "called", false)).not.toThrow();
    for (const kind of startupKinds) expect(verify("throw 1;", kind, true)).not.toThrow();
    expect(verify("function f() {}", "none", true)).not.toThrow();
  });

  it("refuses called with exactlyOnce true, and exactlyOnce false with any other kind", () => {
    const inconsistent = /invocation policy is inconsistent/;
    expect(verify("throw 1;", "called", true)).toThrow(IrModuleInitPlanInvariantError);
    expect(verify("throw 1;", "called", true)).toThrow(inconsistent);
    for (const kind of startupKinds) expect(verify("throw 1;", kind, false)).toThrow(inconsistent);
    expect(verify("function f() {}", "none", false)).toThrow(inconsistent);
    // A called init is executable: a source with nothing to run cannot be called.
    expect(verify("function f() {}", "called", false)).toThrow(inconsistent);
  });
});
