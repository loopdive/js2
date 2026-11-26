// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106 A2c) The codegen half of a literal eval: the caller's strictness for the parse, and whether the runtime-eval
 * provider owns its declarations. The pure parse and early errors are `src/frontend/eval/script.ts`.
 */
import type { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { isStrictContext } from "../helpers/is-strict-function.js";
import { parseEvalSource, type ParsedEvalScript } from "../../frontend/eval/script.js";
import type { FoldedEvalDeclarationNames } from "../../frontend/eval/declaration-names.js";

export function parseEvalScript(
  ctx: CodegenContext,
  call: ts.CallExpression,
  directEval: boolean,
  source: string,
): ParsedEvalScript {
  return parseEvalSource(
    source,
    directEval && isStrictContext(call, false),
    directEval && isStrictContext(call, ctx.inferModuleStrictArguments),
  );
}

/**
 * EvalDeclarationInstantiation §19.2.1.3 step 16 / CanDeclareGlobal*: when a
 * sloppy eval's VariableEnvironment is the GlobalEnvironmentRecord, its var and
 * function declarations become own configurable properties of the realm's
 * global object, gated by IsExtensible — runtime state a fold cannot know. The
 * interpreter implements all of it (`prepareGlobalDeclarations`,
 * `src/interp/eval-environment.ts`), so the provider owns such a Script.
 * `varNames` covers top-level FunctionDeclarations too; Annex B block functions
 * keep their own rule in the fold.
 */
export function providerOwnsEvalDeclarations(
  script: ParsedEvalScript,
  declarationNames: FoldedEvalDeclarationNames,
  varEnvIsGlobal: boolean,
): boolean {
  return varEnvIsGlobal && !script.evalIsStrict && declarationNames.varNames.size > 0;
}
