// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7363 A1 — a "called" module init: startup does not run it, its call site does.
// A2's literal-eval relation is the producer: the Prepared entry adds a top-level literal eval's text as the script
// `<eval:0>.js`, and that script's plan is "called". The site sits after `break`, so it is never lowered (it refuses
// by name until A4) and the program compiles. Every consumer below runs on the plan the real relation produces.
import { describe, expect, it } from "vitest";
import { analyzeMultiSource, analyzeSource } from "../src/checker/index.js";
import { absoluteFuncIndex } from "../src/emit/resolve-layout.js";
import { literalDynamicCodeFileName, pairLiteralDynamicCodeSources } from "../src/ir/literal-dynamic-code.js";
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
import { requireProgram, typedOptions } from "./helpers/typed-program-fixtures.js";

const literalEvalFileName = (index: number) => literalDynamicCodeFileName("eval", index);

const options = {
  wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
  backend: "wasmgc",
  target: "standalone",
  sourceMap: false,
  optimize: false,
  emitWat: false,
  allowJs: true,
} as Test262CompileOptions;

/** A qualifying literal direct eval of `text` that is never lowered. */
const site = (text: string) => `do { break; eval(${JSON.stringify(text)}); } while (false);`;

/** Prepare and emit the entry and its eval script; name the unit each call of the startup adapter reaches. */
function adapterTargets(related: boolean) {
  const text = "1 + 1;";
  const files = {
    "test.ts": `function g(): number { return 2; }\ng();\n${site(text)}`,
    [literalEvalFileName(0)]: text,
  };
  const ast = analyzeMultiSource(files, "test.ts", undefined, { allowJs: true });
  const program = requireProgram(
    prepareWholeIrProgram({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: typedOptions.policy,
      deferTopLevelInit: false,
      literalDynamicCodeSources: related ? pairLiteralDynamicCodeSources(ast.entryFile, ast.sourceFiles, 1) : [],
    }),
  );
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

/** Compile through the strict Prepared entry and run the module's startup. */
async function startup(files: Record<string, string>): Promise<"returned" | "threw"> {
  const result = await compileMulti(files, "test.js", options);
  expect(result.errors.filter((error) => error.severity === "error").map((error) => error.message)).toEqual([]);
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
    const unrelated = adapterTargets(false);
    expect(unrelated.targets).toEqual(unrelated.program.startup.map((plan) => plan.unitId));
    const { program, emitted, targets } = adapterTargets(true);
    const called = program.startup.find((plan) => plan.invocation.kind === "called")!;
    const other = program.startup.find((plan) => plan !== called)!;
    expect(called.invocation).toEqual({ target: "standalone", kind: "called", exactlyOnce: false });
    expect(other.invocation.kind).toBe("wasm-start");
    expect(program.startup.map(runsAtStartup)).toEqual(program.startup.map((plan) => plan === other));
    expect(targets).toEqual([other.unitId]);
    expect(emitted).toContain(called.unitId);
  });

  it("does not run at startup; the same text as an ordinary script does", async () => {
    const entry = `${site("throw 1;")}\nif (1 + 1 !== 2) throw 2;`;
    expect(await startup({ "test.js": entry })).toBe("returned");
    expect(await startup({ "called.js": "throw 1;", "test.js": entry })).toBe("threw");
  });
  // The entry holds the site's statement, so the relation cannot make a program whose only executable init is called.
});

describe("#7363 A1 — the verifier ties exactlyOnce to the invocation kind", () => {
  /** The real plan of `source`, built with `called`. */
  const plan = (source: string, called = false) => {
    const { sourceFile, checker } = analyzeSource(source, "verify.ts");
    const identityContext = buildIrPlanningIdentityContext(
      buildIrUnitInventory([sourceFile], { entrySource: sourceFile, checker }),
    );
    const built = buildIrModuleInitPlan({
      sourceFile,
      checker,
      identityContext,
      target: "standalone",
      deferTopLevelInit: false,
      called,
    });
    return { built, sourceFile };
  };
  /** The real plan of `source` with its invocation replaced, verified against the same source. */
  const verify = (source: string, kind: IrModuleInitPlan["invocation"]["kind"], exactlyOnce: boolean) => {
    const { built, sourceFile } = plan(source);
    return () =>
      verifyIrModuleInitPlan({ ...built, invocation: { ...built.invocation, kind, exactlyOnce } }, sourceFile);
  };
  const startupKinds = ["wasm-start", "deferred-export", "wasi-start-export"] as const;

  it("builds a called plan only for a called source with something to run", () => {
    expect(plan("throw 1;", true).built.invocation).toEqual({
      target: "standalone",
      kind: "called",
      exactlyOnce: false,
    });
    expect(plan("function f() {}", true).built.invocation.kind).toBe("none");
    expect(plan("throw 1;").built.invocation.kind).toBe("wasm-start");
  });

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
