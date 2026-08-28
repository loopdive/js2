// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure Wasm implementations of Math transcendental functions.
 *
 * These replace host imports for Math.sin, Math.cos, Math.exp, Math.log,
 * Math.tan, Math.atan, Math.asin, Math.acos, Math.atan2, Math.pow,
 * Math.log2, Math.log10, Math.sinh, Math.cosh, Math.tanh,
 * Math.asinh, Math.acosh, Math.atanh, Math.cbrt, Math.expm1, Math.log1p.
 *
 * All implementations use polynomial (minimax/Chebyshev) approximations
 * with arithmetic range reduction. Precision target: within 4 ULP of
 * IEEE 754 for the common range.
 *
 * #3141/#3204/#3233/#3226 — nearly the whole family is now SELF-HOSTED: written
 * as ordinary TS source in `src/stdlib/math.ts`, compiled through the compiler's
 * own IR pipeline (`stdlib-selfhost.ts`) instead of hand-emitted `Instr[]` —
 * the derived family (sinh/cosh/tanh, asinh/acosh/atanh, cbrt, expm1, log1p),
 * the log/trig cores (log/log2, reduce_trig, sin/cos/tan, atan/asin/acos),
 * atan2 (#3233), and exp/pow/log10 (#3226 established none needs new dialect
 * intrinsics — the presumed i32-bit-op / reinterpret / f64.nearest gaps are all
 * avoidable in pure f64). The ONLY Math core still hand-written here is
 * `random` — a host RNG import, not a dialect gap.
 */
import type { Instr, ValType } from "../ir/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import { recordStdlibMathHelper } from "./compiler-support-abi.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { emitSelfHostedMathFunc } from "./stdlib-selfhost.js"; // (#3141) self-hosted stdlib driver
import {
  SELF_HOSTED_MATH,
  LOG_BUILTIN,
  LOG2_BUILTIN,
  REDUCE_TRIG_BUILTIN,
  SIN_BUILTIN,
  COS_BUILTIN,
  ATAN_BUILTIN,
  TAN_BUILTIN,
  ASIN_BUILTIN,
  ACOS_BUILTIN,
  ATAN2_BUILTIN,
  EXP_BUILTIN,
  LOG10_BUILTIN,
  POW_BUILTIN,
} from "../stdlib/math.js"; // (#3141/#3204/#3233/#3226) TS-source builtin bodies

// ─── Instruction shorthand helpers ──────────────────────────────────
// Only `Math.random` remains hand-emitted (WASI `random_get` host import —
// not a dialect gap); every other Math core is self-hosted TS source in
// `src/stdlib/math.ts`. These are the few shorthands its body still needs.
const f64c = (v: number): Instr => ({ op: "f64.const", value: v });
const mul: Instr = { op: "f64.mul" };
const i32const = (v: number): Instr => ({ op: "i32.const", value: v });

// ─── Type aliases ───────────────────────────────────────────────────
const f64Type: ValType = { kind: "f64" };
const f64Result: ValType[] = [f64Type];

type MathFuncDef = {
  name: string;
  params: ValType[];
  results: ValType[];
  locals: { name: string; type: ValType }[];
  body: Instr[];
};

/**
 * Build the host-free standalone Math.random body.
 *
 * ECMAScript deliberately leaves the algorithm implementation-defined. A
 * module-local xorshift64 state gives standalone modules a changing value in
 * [0, 1) without inventing an entropy capability or retaining env.Math_random.
 * This is not a cryptographic generator; callers needing entropy must use an
 * explicit platform capability.
 */
function nativeStandaloneRandomBody(ctx: CodegenContext): Instr[] {
  const stateIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__math_random_state",
    type: { kind: "i64" },
    mutable: true,
    init: [{ op: "i64.const", value: 0x123456789abcdefn }],
  });
  const mix = (shift: bigint, op: "i64.shl" | "i64.shr_u"): Instr[] => [
    { op: "global.get", index: stateIdx },
    { op: "global.get", index: stateIdx },
    { op: "i64.const", value: shift },
    { op },
    { op: "i64.xor" },
    { op: "global.set", index: stateIdx },
  ];
  return [
    ...mix(13n, "i64.shl"),
    ...mix(7n, "i64.shr_u"),
    ...mix(17n, "i64.shl"),
    { op: "global.get", index: stateIdx },
    { op: "i64.const", value: 11n },
    { op: "i64.shr_u" },
    { op: "f64.convert_i64_s" },
    f64c(1 / 9007199254740992),
    mul,
  ];
}

/**
 * Emit pure Wasm implementations for the requested Math methods.
 * Methods are added as module functions (not imports) and registered
 * in ctx.funcMap under "Math_<method>".
 */
export function emitInlineMathFunctions(ctx: CodegenContext, needed: Set<string>): void {
  const addedFuncs = new Map<string, number>();

  function addMathFunc(def: MathFuncDef): number {
    const typeIdx = addFuncType(ctx, def.params, def.results, def.name + "_type");
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: def.name,
      typeIdx,
      locals: def.locals,
      body: def.body,
      exported: false,
    });
    ctx.funcMap.set(def.name, funcIdx);
    addedFuncs.set(def.name, funcIdx);
    return funcIdx;
  }

  // ─── Math.random ──────────────────────────────────────────────────
  // #1322: WASI/standalone path. Uses `wasi_snapshot_preview1.random_get`
  // (registered as an import in declarations.ts:collectMathImports finalize)
  // to fill 8 bytes of linear memory, reads them as i64, masks to 53 bits,
  // and multiplies by 2^-53 to produce a float in [0, 1).
  //
  // The scratch buffer lives at memory offset 64 — well inside the
  // 1024-byte reserved area registerWasiImports sets aside via the
  // bump pointer (which initialises to 1024). offsets 0..15 are used by
  // __wasi_write_string for iovec/nwritten; we pick 64 to stay clear of
  // any future stdout/stderr work.
  if (needed.has("random")) {
    const randomGetIdx = ctx.funcMap.get("random_get");
    if (randomGetIdx === undefined) {
      // A pure standalone module has no entropy provider. Use the native,
      // implementation-defined PRNG; WASI continues through random_get below.
      addMathFunc({
        name: "Math_random",
        params: [],
        results: f64Result,
        locals: [],
        body:
          ctx.standalone || ctx.targetProfile.semanticProviders === "native-first"
            ? nativeStandaloneRandomBody(ctx)
            : [f64c(0)],
      });
    } else {
      // The IR doesn't include `i64.load`, so we read 8 bytes as TWO `i32.load`s
      // (low half at offset 0, high half at offset 4), zero-extend each to i64,
      // and combine as `(hi << 32) | lo`. Then shift right 11 to keep the upper
      // 53 significant bits and multiply by 2^-53 → uniform float in [0, 1).
      addMathFunc({
        name: "Math_random",
        params: [],
        results: f64Result,
        locals: [],
        body: [
          // random_get(ptr=64, len=8) — fills memory[64..72] with entropy
          i32const(64),
          i32const(8),
          { op: "call", funcIdx: randomGetIdx },
          { op: "drop" }, // ignore errno (best-effort)
          // Low 32 bits: i64.extend_i32_u(i32.load offset=0 align=2)
          i32const(64),
          { op: "i32.load", offset: 0, align: 2 },
          { op: "i64.extend_i32_u" },
          // High 32 bits: i64.extend_i32_u(i32.load offset=4) << 32
          i32const(64),
          { op: "i32.load", offset: 4, align: 2 },
          { op: "i64.extend_i32_u" },
          { op: "i64.const", value: 32n },
          { op: "i64.shl" },
          // OR low + high
          { op: "i64.or" },
          // Shift right 11 → keep upper 53 bits in unsigned i64
          { op: "i64.const", value: 11n },
          { op: "i64.shr_u" },
          // Convert to f64 and multiply by 2^-53. After `shr_u 11` the value
          // fits in 53 unsigned bits (max ~9e15), so `convert_i64_s` (which the
          // backend supports — `convert_i64_u` is not in the IR union) gives
          // an identical result.
          { op: "f64.convert_i64_s" },
          f64c(1 / 9007199254740992), // 2^-53
          mul,
        ],
      });
    }
  }

  // Determine which core functions we need based on what's requested
  const needSinCos = needed.has("sin") || needed.has("cos") || needed.has("tan");
  const needExp =
    needed.has("exp") ||
    needed.has("sinh") ||
    needed.has("cosh") ||
    needed.has("tanh") ||
    needed.has("pow") ||
    needed.has("expm1");
  const needLog =
    needed.has("log") ||
    needed.has("log2") ||
    needed.has("log10") ||
    needed.has("pow") ||
    needed.has("asinh") ||
    needed.has("acosh") ||
    needed.has("atanh") ||
    needed.has("log1p");
  const needAtan = needed.has("atan") || needed.has("asin") || needed.has("acos") || needed.has("atan2");

  // ─── Phase 1: Core functions ──────────────────────────────────────

  // Range reduction helper for sin/cos — self-hosted (#3204 follow-up).
  if (needSinCos) {
    addedFuncs.set("__math_reduce_trig", emitSelfHostedMathFunc(ctx, REDUCE_TRIG_BUILTIN));
  }

  // ─── Math.sin ─────────────────────────────────────────────────────
  // Self-hosted; calls __math_reduce_trig (registered just above).
  if (needed.has("sin") || needed.has("tan")) {
    addedFuncs.set("Math_sin", emitSelfHostedMathFunc(ctx, SIN_BUILTIN));
  }

  // ─── Math.cos ─────────────────────────────────────────────────────
  // Self-hosted; calls __math_reduce_trig.
  if (needed.has("cos") || needed.has("tan")) {
    addedFuncs.set("Math_cos", emitSelfHostedMathFunc(ctx, COS_BUILTIN));
  }

  // ─── Math.exp ─────────────────────────────────────────────────────
  // Self-hosted (#3226): 2^n by pure-f64 repeated squaring (no i32 bit-ops /
  // reinterpret needed). Early core — emitted before its callers (sinh/cosh/
  // tanh/expm1/pow) so their `Math_exp` calls resolve by funcMap name.
  if (needExp) {
    addedFuncs.set("Math_exp", emitSelfHostedMathFunc(ctx, EXP_BUILTIN));
  }

  // ─── Math.log ─────────────────────────────────────────────────────
  // log(x) using range reduction to [0.5, 2) then atanh series
  if (needLog) {
    addedFuncs.set("Math_log", emitSelfHostedMathFunc(ctx, LOG_BUILTIN));
  }

  // ─── Math.atan ────────────────────────────────────────────────────
  // Self-hosted (#3204 follow-up). Leaf — no callees. The nested mid-body
  // statement-if range reduction is the NATURAL form (works post-#2856/#2981).
  if (needAtan) {
    addedFuncs.set("Math_atan", emitSelfHostedMathFunc(ctx, ATAN_BUILTIN));
  }

  // ─── Phase 2: Derived functions ───────────────────────────────────

  // Math.tan = sin/cos — self-hosted; calls Math_sin / Math_cos.
  if (needed.has("tan")) {
    addedFuncs.set("Math_tan", emitSelfHostedMathFunc(ctx, TAN_BUILTIN));
  }

  // Math.asin = atan(x / sqrt(1 - x*x)) — self-hosted; calls Math_atan.
  if (needed.has("asin")) {
    addedFuncs.set("Math_asin", emitSelfHostedMathFunc(ctx, ASIN_BUILTIN));
  }

  // Math.acos = pi/2 - atan(x/sqrt(1-x*x)) — self-hosted; calls Math_atan.
  if (needed.has("acos")) {
    addedFuncs.set("Math_acos", emitSelfHostedMathFunc(ctx, ACOS_BUILTIN));
  }

  // Math.atan2(y, x) — self-hosted (#3233): binary, pure f64, calls the
  // self-hosted Math_atan (registered just above via `needAtan`).
  if (needed.has("atan2")) {
    addedFuncs.set("Math_atan2", emitSelfHostedMathFunc(ctx, ATAN2_BUILTIN));
  }

  // Math.log2(x) = e + log2(f), computed via range reduction (exact for powers of 2)
  // Locals: 0=x, 1=e, 2=f, 3=t, 4=t2
  if (needed.has("log2")) {
    addedFuncs.set("Math_log2", emitSelfHostedMathFunc(ctx, LOG2_BUILTIN));
  }

  // Math.log10 — self-hosted (#3226): `Math.floor(result + 0.5)` replaces the
  // hand `f64.nearest` (bit-identical within the <1e-12 correction guard).
  // Calls the early-core self-hosted Math_log (registered above).
  if (needed.has("log10")) {
    addedFuncs.set("Math_log10", emitSelfHostedMathFunc(ctx, LOG10_BUILTIN));
  }

  // Math.pow — self-hosted (#3226): pure-f64 exp-by-squaring + exp(e·log b)
  // general path, calling the self-hosted Math_exp / Math_log. Binary (arity 2).
  if (needed.has("pow")) {
    addedFuncs.set("Math_pow", emitSelfHostedMathFunc(ctx, POW_BUILTIN));
  }

  // ─── Self-hosted subset (#3141) ───────────────────────────────────
  // sinh/cosh/tanh, asinh/acosh/atanh, cbrt, round, sign, expm1 and log1p are no
  // longer hand-emitted `Instr[]`. Their bodies are ordinary TS source
  // in `src/stdlib/math.ts`, compiled through the compiler's own IR
  // pipeline (`stdlib-selfhost.ts`) and registered here, at the same
  // point in the emission order the hand-written versions occupied.
  // Phase-1 cores (Math_exp / Math_log) are already in ctx.funcMap, so
  // the source-level sibling calls resolve. Numeric behavior is
  // bit-identical (op-for-op mirrors — see src/stdlib/math.ts header).
  for (const [method, builtin] of SELF_HOSTED_MATH) {
    if (needed.has(method)) {
      addedFuncs.set(builtin.name, emitSelfHostedMathFunc(ctx, builtin));
    }
  }

  // (#3520 C35) Record the whole emitted family for Program ABI ownership.
  // Most of these are already owned by an `intrinsic-provider` row, because the
  // IR asked for the intrinsic by name. The ones that are NOT are the helpers
  // pulled in as CALLEES of a requested intrinsic — `__math_reduce_trig` behind
  // `Math.sin`, `Math_atan` behind `Math.atan2` — and those were the last two
  // Math functions still landing on the positional fallback. Recording the
  // whole family and letting the planner skip anything already owned keeps that
  // distinction out of this emitter.
  for (const [name, funcIdx] of addedFuncs) {
    const func = definedFuncAt(ctx, funcIdx);
    if (func) recordStdlibMathHelper(ctx, name, func);
  }
}
