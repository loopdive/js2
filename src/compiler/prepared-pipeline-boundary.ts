// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CompileError, CompileOptions, CompileResult } from "../index.js";
import type { PipelineInput } from "../compiler.js";
import type { MultiTypedAST } from "../checker/index.js";
import type { PreparedIrPipelinePresentationResult } from "./ir-program-presentation.js";
import { freezePreparedIrValue, type PreparedIrBackendOptions } from "../ir/program.js";
import { detectEarlyErrors, validateSafeMode, validateHardenedMode } from "./validation.js";
import { failResult } from "./output.js";

export interface PreparedFrontendRejectionObservation {
  readonly schema: "prepared-frontend-rejection-v1";
  readonly phase: "syntax" | "early";
  readonly diagnostics: readonly CompileError[];
}

/** Each compiler instance keeps its own private issuance maps; other factories cannot issue into it. */
export function createPreparedFrontendBoundary() {
  const earlySourceRejections = new WeakMap<CompileResult, readonly CompileError[]>();
  const preparedFrontendRejections = new WeakMap<object, PreparedFrontendRejectionObservation>();
  function rememberPreparedFrontendRejection(
    result: PreparedIrPipelinePresentationResult,
    phase: PreparedFrontendRejectionObservation["phase"],
    diagnostics: readonly CompileError[],
  ): void {
    preparedFrontendRejections.set(
      result,
      freezePreparedIrValue({
        schema: "prepared-frontend-rejection-v1",
        phase,
        diagnostics: diagnostics.map((row) => ({ ...row })),
      }) as PreparedFrontendRejectionObservation,
    );
  }

  /** The existing pre-generation validation, shared by both internal routes. */
  function validatePipelineSource(input: PipelineInput): CompileResult | undefined {
    const { errors, options, entryAst, userSourceFiles } = input;
    // Each validation pass below gates on the errors IT produced, NOT on the whole
    // accumulated `errors` array. This is load-bearing (#1927 regression fix): the
    // pre-collected `errors` may already hold non-fatal TS diagnostics of severity
    // "error" — e.g. TS2678 "Type '2' is not comparable to type '1'" on a switch
    // case — which the single-source path has always TOLERATED (it compiles and
    // succeeds, leaving the diagnostic in `errors`). The legacy single-source
    // driver gated each pass only on that pass's fresh output; gating on the whole
    // array here would turn every tolerated non-hard TS error into a hard failure.
    const hasNewError = (added: { severity: string }[]) => added.some((e) => e.severity !== "warning");

    // Step 1a: ES early-error detection — catch spec syntax errors TS misses, on
    // EVERY user source file (#1931). allowJs dependency files are skipped (their
    // JS may use patterns we cannot control) — same scoping as the diagnostic
    // loop in the adapters. #1958 — EXCEPT the single-source path
    // (`runEarlyErrorsOnAllowJs`), whose lone source IS the entry: the legacy
    // `compileSourceSync` ran this pass unconditionally, and the `eval` host shim
    // (always `allowJs: true`) depends on it to reject e.g. `export` in eval code.
    if (!options.allowJs || input.runEarlyErrorsOnAllowJs) {
      const earlyErrors: CompileError[] = [];
      // #3419 — module-goal signal for rules where Script vs Module top level
      // genuinely differ (duplicate top-level function declarations). The test262
      // runner passes `inferModuleStrictArguments` as an EXPLICIT boolean — `true`
      // exactly for `flags: [module]` tests (whose sources often carry no
      // syntactic import/export the checker could infer module-ness from), `false`
      // for script tests. Product compiles leave it undefined and are covered by
      // the real `ts.isExternalModule` indicator inside the rule.
      const moduleGoal = options.inferModuleStrictArguments === true;
      // (#6491 r3) Script goal is an EXPLICIT opt-in, never `!moduleGoal` — see
      // the `scriptGoal` doc comment in index.ts for why the negation is unsafe.
      const scriptGoal = options.scriptGoal === true;
      const scriptTopLevel = options.inferModuleStrictArguments === false; // (#6988) synthetic-`export` Script
      for (const sf of userSourceFiles) {
        earlyErrors.push(...detectEarlyErrors(sf, { moduleGoal, scriptGoal, scriptTopLevel }));
      }
      errors.push(...earlyErrors);
      if (hasNewError(earlyErrors)) {
        const rejected = failResult(errors);
        earlySourceRejections.set(rejected, earlyErrors);
        return rejected;
      }
    }

    // Step 1b: Safe mode validation for all user source files.
    if (options.safe) {
      const safeErrors: CompileError[] = [];
      for (const sf of userSourceFiles) {
        safeErrors.push(...validateSafeMode(sf, entryAst.checker, options));
      }
      errors.push(...safeErrors);
      if (hasNewError(safeErrors)) {
        return failResult(errors);
      }
    }

    // Step 1c: Hardened mode validation for all user source files. #1927 — moving
    // this into the shared core gives the multi paths hardened-mode parity (they
    // previously skipped it entirely).
    if (options.hardened) {
      const hardenedErrors: CompileError[] = [];
      for (const sf of userSourceFiles) {
        hardenedErrors.push(...validateHardenedMode(sf));
      }
      errors.push(...hardenedErrors);
      if (hasNewError(hardenedErrors)) {
        return failResult(errors);
      }
    }

    return undefined;
  }

  function rememberSyntax(
    result: PreparedIrPipelinePresentationResult,
    diagnostics: Pick<MultiTypedAST, "syntacticDiagnostics" | "sourceFiles">,
    errors: readonly CompileError[],
    collectedDiagnosticStart: number,
  ): void {
    const syntaxDiagnostics = errors.slice(collectedDiagnosticStart).filter(
      (error) =>
        error.severity === "error" &&
        diagnostics.syntacticDiagnostics.some((diagnostic) => {
          if (
            diagnostic.category !== 1 ||
            diagnostic.file === undefined ||
            !diagnostics.sourceFiles.includes(diagnostic.file) ||
            diagnostic.code !== error.code ||
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") !== error.message ||
            error.file !== diagnostic.file.fileName
          )
            return false;
          const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
          return error.line === position.line + 1 && error.column === position.character + 1;
        }),
    );
    if (syntaxDiagnostics.length) rememberPreparedFrontendRejection(result, "syntax", syntaxDiagnostics);
  }
  function carryEarly(sourceFailure: CompileResult, result: PreparedIrPipelinePresentationResult): void {
    const early = earlySourceRejections.get(sourceFailure);
    if (early) rememberPreparedFrontendRejection(result, "early", early);
  }
  function observe(result: PreparedIrPipelinePresentationResult): PreparedFrontendRejectionObservation | undefined {
    return preparedFrontendRejections.get(result);
  }
  return Object.freeze({ validate: validatePipelineSource, syntax: rememberSyntax, early: carryEarly, observe });
}

/** Source policy and backend projection share one requested-output profile. */
export function checkPreparedPresentationProfile(
  options: CompileOptions,
  backend: PreparedIrBackendOptions,
  policy: Pick<PreparedIrBackendOptions, "target" | "backend">,
  gap: (field: string, code: string, detail: string) => void,
): void {
  const outputTarget = options.target ?? "gc";
  if (!["gc", "linear", "standalone", "wasi"].includes(outputTarget))
    gap("options.target", "unknown-target", "prepared presentation requires an explicit known output target");
  const requestedTarget = outputTarget === "standalone" ? "standalone" : outputTarget === "wasi" ? "wasi" : "host";
  if (
    backend.target !== requestedTarget ||
    policy.target !== backend.target ||
    policy.backend !== backend.backend ||
    (backend.backend !== "wasmgc" && backend.backend !== "linear")
  )
    gap("backend", "option-association", "source policy, backend and requested output target must match");
}
