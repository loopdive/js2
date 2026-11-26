// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * What a static RegExp pair (a literal, or `new RegExp` over string literals)
 * builds to (#7369 R1a). Legacy codegen, the IR selector and the IR resolvers
 * all ask here, so a lane can never admit a pair whose build another lane would
 * refuse.
 */
import {
  parseFlags,
  RE_FLAG_D,
  RE_FLAG_G,
  RE_FLAG_I,
  RE_FLAG_M,
  RE_FLAG_S,
  RE_FLAG_U,
  RE_FLAG_V,
  RE_FLAG_Y,
} from "./bytecode.js";
import { compilePattern } from "./compile.js";

// g/i/y from Phase 2a, m/s from 2c, d/u/v from 2d (#1911 — `d` does not
// change MATCHING semantics; the `.indices` result surface is #1914's lane;
// u/v code-point atoms resolve via compile-time host enumeration, Slice B).
export const REGEXP_ENGINE_FLAGS =
  RE_FLAG_G | RE_FLAG_I | RE_FLAG_Y | RE_FLAG_M | RE_FLAG_S | RE_FLAG_D | RE_FLAG_U | RE_FLAG_V;

/**
 * Genuine (pattern, flags) SyntaxErrors vs. engine limitations (#1912).
 *
 * The compiler runs on a JS host whose `RegExp` constructor is a spec-exact
 * validity oracle: any pair the host rejects with a SyntaxError is invalid per
 * §22.2.3.2 and must throw a *runtime* SyntaxError when the compiled
 * `new RegExp(...)` evaluates — not fail the whole compile (test262's
 * S15.10.1/S15.10.2.15 families catch exactly this). Host-VALID patterns our
 * matcher can't handle stay compile-time narrowed refusals.
 */
export function staticRegExpPairSyntaxError(pattern: string, flags: string): string | null {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags);
    return null;
  } catch (e) {
    if (e instanceof SyntaxError) return e.message;
    return e instanceof Error ? e.message : "Invalid regular expression";
  }
}

/** Whether the engine compiles the pair, silently: a `false` leaves no diagnostic behind. */
export function staticRegExpPairEngineCompiles(pattern: string, flags: string): boolean {
  try {
    const flagBits = parseFlags(flags);
    if ((flagBits & ~REGEXP_ENGINE_FLAGS) !== 0) return false;
    // u/v mode is strict (no Annex B): a host-invalid pair must not ride a
    // lenient parser path (#1911 Slice B).
    if ((flagBits & (RE_FLAG_U | RE_FLAG_V)) !== 0 && staticRegExpPairSyntaxError(pattern, flags) !== null)
      return false;
    compilePattern(pattern, flagBits);
    return true;
  } catch {
    return false;
  }
}

/**
 * (#7106 lever R) Whether a static construction builds without a diagnostic:
 * the engine compiles the pair, or the pair is invalid and throws SyntaxError
 * when it evaluates.
 */
export function staticRegExpPairCompiles(pattern: string, flags: string): boolean {
  return staticRegExpPairEngineCompiles(pattern, flags) || staticRegExpPairSyntaxError(pattern, flags) !== null;
}
