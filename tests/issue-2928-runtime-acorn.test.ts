// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2928 E3/E6 — package the real pinned Acorn parser and interpreter as one
 * ordered, zero-import provider, then link a separately compiled user module
 * and execute indirect eval against the caller's global object.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

describe("#2928 — real Acorn runtime-eval provider", () => {
  it("executes linked indirect eval with one ordered zero-import provider", { timeout: 1_200_000 }, async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--max-old-space-size=3072", "--import", "tsx", join(HERE, "interp", "runtime-acorn-package-probe.mjs")],
      {
        cwd: join(HERE, ".."),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const report = JSON.parse(stdout);

    expect(report.success).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.bytes).toBeGreaterThan(0);
    expect(report.imports).toEqual([]);
    expect(report.exports).toEqual([
      { name: "__runtime_new_function", kind: "function" },
      { name: "__runtime_indirect_eval", kind: "function" },
      { name: "__runtime_direct_eval", kind: "function" },
      { name: "__runtime_apply_interpreted", kind: "function" },
      { name: "__runtime_eval_canary", kind: "function" },
      { name: "__runtime_function_canary", kind: "function" },
      { name: "__runtime_direct_eval_canary", kind: "function" },
      { name: "__runtime_apply_interpreted_canary", kind: "function" },
      { name: "__runtime_positive_corpus_canary", kind: "function" },
    ]);
    expect(report.userSuccess).toBe(true);
    expect(report.userErrors).toEqual([]);
    expect(report.userImports).toEqual([
      {
        module: "js2wasm:runtime-eval",
        name: "__runtime_apply_interpreted",
        kind: "function",
      },
      {
        module: "js2wasm:runtime-eval",
        name: "__runtime_new_function",
        kind: "function",
      },
      {
        module: "js2wasm:runtime-eval",
        name: "__runtime_indirect_eval",
        kind: "function",
      },
      {
        module: "js2wasm:runtime-eval",
        name: "__runtime_direct_eval",
        kind: "function",
      },
    ]);
    expect(report.executionErrors).toEqual({});
    expect(report.values).toEqual({
      function: 3,
      linkedFunction: 3,
      linkedFunctionImmediate: 3,
      linkedFunctionCall: 5,
      linkedSloppyThis: 1,
      linkedStrictThis: 1,
      eval: 3,
      directEval: 84,
      applyInterpreted: 3,
      positiveCorpus: 30,
      linkedEval: 42,
      linkedDirectEval: 84,
      linkedDirectSloppyVarMutation: 1,
      linkedDirectVarPersistence: 2,
      linkedNestedDirectVarPersistence: 240,
      linkedDirectMappedParameterAssignment: 202,
      linkedDirectMappedArgumentsAssignment: 303,
      linkedDirectMappedArgumentsDelete: 2,
      linkedDirectMappedDeletePersistsToAot: 6,
      linkedDirectMappedArgumentsDefine: 45,
      linkedDirectDefaultParameter: 5,
      linkedDirectParameterWriteBeforeEval: 6,
      linkedDirectStrictSourceVarIsolation: 41,
      linkedDirectStrictCallerVarIsolation: 41,
      linkedDirectLexicalIsolation: 41,
      linkedDirectLexicalTdz: 1,
      linkedDirectLowerLexicalCollision: 1,
      linkedDirectNestedLexicalShadow: 1,
      linkedDirectBlockClosureCapture: 3,
      linkedDirectNestedLexicalTdz: 1,
      linkedDirectBlockBreakCleanup: 1,
      linkedDirectBlockCatchCleanup: 7,
      linkedDirectStrictBlockFunctionLifetime: 1,
      linkedDirectSloppyBlockFunction: 2,
      linkedDirectSloppyBlockFunctionPersistence: 4,
      linkedDirectBlockFunctionLexicalConflict: 3,
      linkedDirectBlockFunctionOuterLexicalConflict: 3,
      linkedLiteralBlockFunctionLowerLexicalCancellation: 3,
      linkedDirectBlockFunctionSkippedInit: 1,
      linkedDirectSloppyIfFunction: 5,
      linkedIndirectSloppyIfFunction: 6,
      linkedDirectSwitchFlow: 5,
      linkedDirectSwitchAnnexB: 6,
      linkedDirectSwitchFunctionCompletion: 8,
      linkedDirectSwitchSkippedAnnexB: 1,
      linkedDirectSwitchLexical: 7,
      linkedDirectSwitchFunctionInitialization: 4,
      linkedDirectSwitchExistingVarInside: 1,
      linkedDirectRealHarnessSwitchExistingVar: 1,
      linkedDirectSwitchExistingVarWriteback: 1,
      linkedDirectSwitchBlockBindingIdentity: 127,
      linkedDirectForInOfLexical: 31,
      linkedDirectForOfClosure: 12,
      linkedDirectForInKeys: 232,
      linkedDirectStringAdd: 287,
      linkedDirectReferenceErrorValue: 1,
      linkedDirectClassBasic: 7,
      linkedDirectClassInstanceMethod: 4,
      linkedDirectClassConstructorField: 5,
      linkedDirectClassBlockLifetime: 1,
      linkedDirectClassCallGuard: 1,
      linkedDirectClassExpression: 4,
      linkedDirectStrictEarlyError: 1,
      linkedIndirectStrictVarIsolation: 41,
      linkedThrow: 1,
      linkedErrorThrow: 1,
      linkedNumberBuiltin: 4,
      linkedMathBuiltin: 7,
      linkedAotCall: 5,
      linkedIndirectAotGlobalSeed: 42,
      linkedFunctionAotGlobalSeed: 42,
      linkedIndirectAotGlobalWriteback: 42,
      linkedFunctionAotLiveRead: 42,
      linkedFunctionAotWriteback: 43,
      linkedEvalCallsAotWithFreshGlobal: 44,
      linkedEvalAotCallbackWriteback: 4545,
      linkedDirectAotHarnessLookup: 1,
      linkedDirectAotAssertThrows: 1,
      linkedDirectAotAssertSameValue: 1,
      linkedIndirectFunctionBindingWriteback: 17,
      linkedAotFunctionBindingUpdateVisibleToEval: 8,
      linkedIndirectVarCallableWriteback: 17,
      linkedIndirectCreatedGlobalNumber: 42,
      linkedIndirectIifeVarIsolation: 1,
      linkedIndirectTypedEvalAlias: 7,
    });
  });
});
