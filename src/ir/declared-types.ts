// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4605 — module-level DECLARED-TYPE tables for the IR verifier.
//
// The IR resolves globals and callables lazily through symbolic refs, so until
// this module existed the verifier had no record anywhere in scope of "the
// signature this callable declares" or "the IrType this global declares":
// `IrFuncRef`/`IrGlobalRef` carry a debug name plus a structural binding, and
// `IrModule` held only `functions`. #4603's `call` / `global.get` /
// `global.set` rules therefore had to settle for intra-function COHERENCE —
// two references to one binding must agree with each other — which catches the
// defect class but not its most common shape: ONE mistaken reference that is
// perfectly coherent with itself.
//
// The design decision recorded in #4605: the tables live ON the module
// (`IrModule extends IrModuleDeclarations`) rather than being projected out of
// `ProgramAbiMap` (#3520 R1). That keeps `verifyIrFunction` standalone — it
// does not learn about the prepared pipeline — and matches #3030's
// self-describing serializable module, at the cost of one more record for
// preparation to cross-check against.
//
// Everything here is CONSERVATIVE by construction: a binding with no
// declaration is skipped, not flagged. A verify error demotes the function to
// the legacy compiler, so a rule that guesses costs conformance.

import type { IrDeclaredSignature, IrFunction, IrModuleDeclarations, IrType } from "./nodes.js";
import type { ValType } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A stable structural key for an `IrGlobalRef` / `IrFuncRef` binding (#4603,
 * generalized here by #4605).
 *
 * This is the SHARED vocabulary between producer and verifier — the tables
 * above are keyed by exactly this string — so there must be one key function,
 * never two. `name` is explicitly a debug label and never the identity, so the
 * key is built from the binding discriminant alone.
 */
export function irBindingKey(binding: unknown): string | null {
  if (!isRecord(binding)) return null;
  const kind = binding.kind;
  if (typeof kind !== "string") return null;
  const id = binding.bindingId ?? binding.unitId ?? binding.symbol;
  if (typeof id === "string") return `${kind}:${id}`;
  if (kind === "import" && typeof binding.module === "string" && typeof binding.field === "string") {
    return `import:${binding.module}:${binding.field}`;
  }
  return null;
}

/**
 * The result type a function DECLARES to its callers, or `null` when no single
 * carrier is declarable.
 *
 * `async` and `generator` bodies are the `null` case, and this is a measured
 * constraint rather than caution (#4605): `async function fetchUser(): Promise<number>`
 * lowers to an `IrFunction` whose `resultTypes` is the UNWRAPPED `f64` (#1373b
 * unwraps `Promise<T>` for the awaiting caller), while a call site that does
 * not await legitimately receives the Promise object as `externref`. Both
 * carriers are correct for the same callee, so a declared-result rule over
 * them reports contradictions that are not contradictions — it demoted three
 * functions in `website/playground/examples/js/async.ts` before this guard.
 * Generators divide the same way: the lowerer picks `externref` for the
 * Generator object regardless of the source-level annotation `resultTypes`
 * records. Arity is unaffected and still checked for both.
 */
function declarableResultType(fn: IrFunction): IrType | null {
  if (fn.funcKind === "async" || fn.funcKind === "generator") return null;
  return fn.resultTypes.length > 0 ? fn.resultTypes[0]! : null;
}

/**
 * Derive the declared-signature table a module implies for its own functions,
 * merged with whatever declarations the module already carries.
 *
 * Every `IrFunction` in the module IS the declaration for its own unit
 * binding — `params` and `resultTypes` are the signature the lowerer will
 * emit — so the common case needs no new bookkeeping at the producer. Explicit
 * tables already on the module WIN over the derived entries: a producer that
 * knows better (an import's declared ABI, say) states it, and this helper never
 * overwrites it.
 *
 * Globals are pass-through — nothing in `functions` declares a global's type.
 */
export function irModuleDeclarations(
  module: { readonly functions: readonly IrFunction[] } & IrModuleDeclarations,
): IrModuleDeclarations {
  const declaredSignatures = new Map<string, IrDeclaredSignature>();
  for (const fn of module.functions) {
    const key = irBindingKey({ kind: "unit", unitId: fn.unitId });
    // A duplicate unit id would make "the" declaration ambiguous; first wins,
    // and `integration.ts`'s module-level identity checks own the real
    // complaint about it.
    if (key === null || declaredSignatures.has(key)) continue;
    declaredSignatures.set(key, {
      params: fn.params.map((p) => p.type),
      result: declarableResultType(fn),
    });
  }
  for (const [key, signature] of module.declaredSignatures ?? []) declaredSignatures.set(key, signature);
  return { declaredSignatures, declaredGlobals: module.declaredGlobals };
}

/**
 * Contradictions between ONE `call` site and the module-declared signature for
 * its target, at the same carrier-kind granularity as every other #4603 rule.
 *
 * `resultKind` / `declaredResultKind` are `null` when the carrier is unknown or
 * not a `val` (a declared-void callable, a `dynamic` result); either being null
 * skips the result comparison. Returns an empty array when the call is
 * consistent with the declaration.
 */
export function declaredCallProblems(
  targetName: string,
  argCount: number,
  resultKind: ValType["kind"] | null,
  declared: IrDeclaredSignature,
  declaredResultKind: ValType["kind"] | null,
): string[] {
  const problems: string[] = [];
  if (argCount !== declared.params.length) {
    problems.push(
      `call ${targetName} passes ${argCount} argument(s) but the module declares ${declared.params.length} parameter(s)`,
    );
  }
  if (resultKind !== null && declaredResultKind !== null && resultKind !== declaredResultKind) {
    problems.push(
      `call ${targetName} resultType ${resultKind} contradicts the module-declared result ${declaredResultKind}`,
    );
  }
  return problems;
}

/**
 * The contradiction, if any, between the carrier ONE `global.get`/`global.set`
 * commits to and the module-declared carrier for that global. `null` when the
 * declared carrier is unknown or the two agree.
 */
export function declaredGlobalProblem(
  instrKind: "global.get" | "global.set",
  targetName: string,
  observed: ValType["kind"],
  declaredKind: ValType["kind"] | null,
): string | null {
  if (declaredKind === null || declaredKind === observed) return null;
  return `${instrKind} ${targetName} carrier ${observed} contradicts the module-declared ${declaredKind}`;
}
