// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4521) The ONE definition of the caller-direction demotion policy.
 *
 * Both selection paths — the structural selector (`select.ts`) and the
 * production identity selector (`select-identity.ts`) — run the same Step-2
 * call-graph closure, and both must key its CALLER direction on the same
 * mode fact: a claimed function with an unclaimed legacy caller is demoted
 * only OUTSIDE JS-host mode (`jsHostExterns !== true`, i.e. standalone/WASI),
 * where IR coverage gaps can surface latent post-claim failures that the
 * closure incidentally masks (#2858). In host mode the caller direction is
 * relaxed entirely; see the rationale comment at the consult site in
 * `select.ts`.
 *
 * Consult contract: the policy is never read alone. Each consult site pairs
 * it with the per-declaration `legacyCallerAbiIsProjected` escape hatch —
 * the caller direction demotes a unit only when
 * `demoteOnLegacyCallerPolicy(options) && !legacyCallerAbiIsProjected(...)`.
 * A future policy change edits THIS module; the two selectors must keep
 * consulting it rather than re-deriving the mode fact (the copy-pair drift
 * this module retires was flagged by the #3518 2026-08-15 notes, which had
 * to patch "two mirrored places" in lockstep).
 */

interface HostExternsOptions {
  readonly jsHostExterns?: boolean;
}

/**
 * True when the target compiles with ambient JS host externs available
 * (`jsHostExterns === true`). The negated spelling `jsHostExterns !== true`
 * must not appear outside this module — route through this helper so the
 * policy grep (`#4521` AC) stays single-hit.
 */
export function jsHostExternsEnabled(options: HostExternsOptions | undefined): boolean {
  return options?.jsHostExterns === true;
}

/**
 * Should the Step-2 call-graph closure demote a claimed unit whose CALLER is
 * unclaimed (legacy)? True exactly in host-free lanes (standalone/WASI).
 */
export function demoteOnLegacyCallerPolicy(options: HostExternsOptions | undefined): boolean {
  return options?.jsHostExterns !== true;
}
