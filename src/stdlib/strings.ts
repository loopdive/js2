// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Self-hosted native-string builtins (#3256 — string family Tier-1, porffor
 * model, following the #3141 Math pilot and the #3159/#3160 typed-def path).
 *
 * Each builtin is ORDINARY TypeScript source in the IR-claimable subset,
 * compiled through the compiler's OWN pipeline (`src/codegen/stdlib-selfhost.ts`,
 * with the #3256 Tier-1 resolver widening) and registered exactly where the
 * hand-emitted `Instr[]` bodies used to be pushed (inside
 * `ensureNativeStringHelpers`, native-strings mode only).
 *
 * DIALECT (beyond the #3141/#3159 headers):
 *   - Strings are plain `: string` params/locals (`IrType.string`, lowered to
 *     `(ref $AnyString)` by the driver's `resolveString()`). Char access uses
 *     STRING METHOD syntax — `s.charCodeAt(i)` / `s.substring(a, b)` — which
 *     from-ast lowers via the native `stringMethodPlan` (the driver installs a
 *     context-free native-mode plan table; see `dialect: "native-strings"`).
 *     The plan inserts the f64→i32 index truncs itself, so index arithmetic
 *     stays f64 (`number`) exactly like the #3159 Timsort kernels.
 *   - `+` on two string-typed operands lowers to `string.concat`
 *     (→ `__str_concat`), `.length` to `string.len` (→ `struct.get $AnyString
 *     len` + f64 convert), `""` to an inline native `string.const`.
 *   - Scan-based bodies flatten their string params ONCE at entry via the
 *     retained `__str_flatten` kernel (declared as a `(string) -> string`
 *     callee; its real Wasm result `(ref $NativeString)` is a subtype of the
 *     declared `(ref $AnyString)`, so the call validates). Without this, each
 *     `charCodeAt` on a cons-string receiver would re-flatten (copy) the whole
 *     rope — O(n²). This mirrors the deleted hand bodies'
 *     `wrapBodyWithFlatten` preamble. (Params are NOT reassignable in the IR
 *     subset — the flattened value binds to a fresh `let`.)
 *   - Mutated string `let`s (`out = out + out`) bind as string SLOTS, whose
 *     Wasm-local type comes from the build resolver's `resolveString()` —
 *     a ctx-bound typeIdx. String defs therefore set NO `memoKey` (the IR is
 *     rebuilt per compilation, bounded to once by the driver's funcMap
 *     early-return, same as the #3161 typed families).
 *   - Numeric-ABI compatibility: the legacy helper signatures take i32
 *     position/count params and the callers (string-ops.ts arms, sibling
 *     helpers, from-ast's own `stringMethodPlan` lowerings) bake that ABI.
 *     Bodies here take f64 (`number`) and each such helper is registered
 *     behind a tiny hand THUNK with the EXACT legacy signature that widens
 *     i32 → f64 (`f64.convert_i32_s`) and forwards — the same "external ABI
 *     preserved by a small hand thunk" move as #3159's `__timsort_<k>`.
 *     Helpers whose legacy ABI has no numeric params (the trim family)
 *     register the lowered function directly under the canonical name.
 *
 * OVERFLOW BEHAVIOR (repeat/pad doubling): `out = out + out` doubles a rope in
 * O(1); the loop also exits when `out.length` stops being positive — i32 length
 * wraparound past 2^31, the same regime where the deleted hand kernel's
 * `i32.mul`-wrapped `array.new_default` trapped. The final `.substring()`
 * flattens the rope, and flattening a wrapped-negative-length rope hits the
 * identical `array.new_default` trap — so the observable failure class
 * (RuntimeError on impossible allocations) is preserved without the loop ever
 * spinning unbounded.
 *
 * Behaviour mirrors the deleted hand bodies step-for-step (same clamps —
 * incl. the #2875 min/max position clamps — same scan directions, same
 * whitespace table (#1963), same empty-needle/early-return arms). Validated
 * by tests/issue-3256.test.ts (host JS-semantics lane vs standalone lane on
 * the same corpus) — see the issue file for the A/B + containment probes.
 */

import type { SelfHostedFuncDef } from "../codegen/stdlib-selfhost.js";
import { irVal, type IrType } from "../ir/nodes.js";

const STR: IrType = { kind: "string" };
const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });

type Sig = { params: readonly IrType[]; returnType: IrType | null };

/** Retained rep kernel: flatten a (possibly cons) string to a FlatString. */
const FLATTEN_CALLEE: [string, Sig] = ["__str_flatten", { params: [STR], returnType: STR }];
/**
 * (#3899) Retained rep kernel: caller-proven-in-bounds fixed-offset compare of
 * `len` code units. Numeric params are declared `f64` per the caller-side
 * dialect rule (no implicit f64→i32 arg coercion); the kernel truncs once.
 */
const REGION_EQ_CALLEE: [string, Sig] = ["__str_region_eq", { params: [STR, F64, STR, F64, F64], returnType: I32 }];
/**
 * (#3899) Retained rep kernels for the trim boundary scans — `(s, from, to)`
 * → the first non-whitespace index / one past the last one, as an f64 index so
 * the callers keep doing ordinary `number` arithmetic.
 */
const WS_START_CALLEE: [string, Sig] = ["__str_ws_start", { params: [STR, F64, F64], returnType: F64 }];
const WS_END_CALLEE: [string, Sig] = ["__str_ws_end", { params: [STR, F64, F64], returnType: F64 }];

/**
 * §22.1.3.32 TrimString whitespace class (#1963): WhiteSpace + LineTerminator.
 * Mirrors the deleted hand `__str_isWhitespace` OR-chain (and the regex `\s`
 * SPACE table in src/codegen/regex/parse.ts): 0x09-0x0D, 0x20, 0xA0, 0x1680,
 * 0x2000-0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF.
 */
const IS_WS_SOURCE = `
export function __sh_str_isWs(ch: number): boolean {
  if (ch === 0x20) { return true; }
  if (ch >= 0x09 && ch <= 0x0d) { return true; }
  if (ch === 0xa0) { return true; }
  if (ch === 0x1680) { return true; }
  if (ch >= 0x2000 && ch <= 0x200a) { return true; }
  if (ch === 0x2028) { return true; }
  if (ch === 0x2029) { return true; }
  if (ch === 0x202f) { return true; }
  if (ch === 0x205f) { return true; }
  if (ch === 0x3000) { return true; }
  if (ch === 0xfeff) { return true; }
  return false;
}
`;

/**
 * Forward whitespace scan, then substring view — mirrors hand `__str_trimStart`.
 * (#3899) The scan is the `__str_ws_start` rep kernel: the `charCodeAt` +
 * `__sh_str_isWs` loop this replaces cost ~25 Wasm ops and one non-inlined call
 * PER CODE UNIT. See the kernel doc in `src/codegen/native-strings-ws.ts` —
 * `__sh_str_isWs` is still the single source of truth for the spec table, the
 * kernel only fast-paths ASCII.
 */
const TRIM_START_SOURCE = `
export function __str_trimStart(str0: string): string {
  let s: string = __str_flatten(str0);
  let len: number = s.length;
  return s.substring(__str_ws_start(s, 0, len), len);
}
`;

/** Backward whitespace scan — mirrors hand `__str_trimEnd`. (#3899: rep kernel.) */
const TRIM_END_SOURCE = `
export function __str_trimEnd(str0: string): string {
  let s: string = __str_flatten(str0);
  let len: number = s.length;
  return s.substring(0, __str_ws_end(s, 0, len));
}
`;

/**
 * §22.1.3.34 Trim — ONE fused pass (#3899).
 *
 * The former body was `__str_trimEnd(__str_trimStart(s))`, which paid the whole
 * per-call preamble twice: two `__str_flatten` guards, two cross-function calls,
 * and two `struct.new $NativeString` view allocations, of which the
 * intermediate one is immediately garbage.
 *
 * MEASURED CAVEAT (#3899): fusing on its own moved `string/trim` by ~0 %. That
 * scaffolding was NOT the cost — the per-code-unit `charCodeAt` + `__sh_str_isWs`
 * scan was, which is why the scans now go through the rep kernels. Fusing is
 * kept because it is free and strictly less work, not because it is the fix.
 *
 * Fusing is behaviour-preserving: trimStart yields the view `[i, len)`, and
 * trimEnd then scans that view backwards from its end down to its own start —
 * which is exactly the `from = i` bound passed to `__str_ws_end` below. One view
 * is allocated, and the backward scan can never cross `i`, so the
 * all-whitespace case still yields the empty string `[i, i)`.
 */
const TRIM_SOURCE = `
export function __str_trim(str0: string): string {
  let s: string = __str_flatten(str0);
  let len: number = s.length;
  let i: number = __str_ws_start(s, 0, len);
  return s.substring(i, __str_ws_end(s, i, len));
}
`;

/**
 * §22.1.3.23 StartsWith. Clamps mirror the hand body incl. #2875:
 * position = min(max(position, 0), sLen), then a fixed-offset compare.
 *
 * (#3899) The compare itself delegates to the `__str_region_eq` rep kernel
 * instead of a `charCodeAt` loop. The clamps above PROVE `pos + pLen <= sLen`,
 * which is exactly the kernel's in-bounds precondition — see the kernel doc in
 * `src/codegen/native-strings-search.ts` for why the scan does not belong in
 * the self-hosted spec layer. `.length` reads `$AnyString.len` directly, so a
 * cons receiver needs no pre-flatten here (the kernel flattens, guarded).
 */
const STARTS_WITH_SOURCE = `
export function __sh_str_startsWith(str0: string, prefix0: string, position: number): boolean {
  let sLen: number = str0.length;
  let pLen: number = prefix0.length;
  let pos: number = position;
  if (pos < 0) { pos = 0; }
  if (pos > sLen) { pos = sLen; }
  if (pos + pLen > sLen) { return false; }
  return __str_region_eq(str0, pos, prefix0, 0, pLen);
}
`;

/**
 * §22.1.3.7 EndsWith. Clamps mirror the hand body incl. #2875:
 * endPos = min(max(endPos, 0), sLen); start = endPos - suffix.length.
 * (#3899) Same `__str_region_eq` delegation as `startsWith`: `start >= 0` and
 * `start + xLen === end <= sLen` are the kernel's in-bounds precondition.
 */
const ENDS_WITH_SOURCE = `
export function __sh_str_endsWith(str0: string, suffix0: string, endPos: number): boolean {
  let xLen: number = suffix0.length;
  let sLen: number = str0.length;
  let end: number = endPos;
  if (end < 0) { end = 0; }
  if (end > sLen) { end = sLen; }
  let start: number = end - xLen;
  if (start < 0) { return false; }
  return __str_region_eq(str0, start, suffix0, 0, xLen);
}
`;

/**
 * §22.1.3.17 repeat core. Same empty arms as the hand kernel (count <= 0 or
 * empty receiver → ""), then rope-doubling to ≥ sLen·count and one substring
 * view. The `out.length > 0` guard is the overflow exit (see module header).
 */
const REPEAT_SOURCE = `
export function __sh_str_repeat(s: string, count: number): string {
  let sLen: number = s.length;
  if (count <= 0) { return ""; }
  if (sLen === 0) { return ""; }
  let newLen: number = sLen * count;
  let out: string = s;
  while (out.length > 0 && out.length < newLen) {
    out = out + out;
  }
  return out.substring(0, newLen);
}
`;

/**
 * §22.1.3.15 padStart. Same early arms as the hand body (already long enough,
 * or empty pad → receiver unchanged); fill built by rope-doubling the pad
 * string (content-identical to the hand repeat+substring composition).
 */
const PAD_START_SOURCE = `
export function __sh_str_padStart(s: string, targetLen: number, padStr: string): string {
  let sLen: number = s.length;
  if (sLen >= targetLen) { return s; }
  let padLen: number = padStr.length;
  if (padLen === 0) { return s; }
  let fillLen: number = targetLen - sLen;
  let fill: string = padStr;
  while (fill.length > 0 && fill.length < fillLen) {
    fill = fill + fill;
  }
  return fill.substring(0, fillLen) + s;
}
`;

/** §22.1.3.14 padEnd — as padStart with the concat order swapped. */
const PAD_END_SOURCE = `
export function __sh_str_padEnd(s: string, targetLen: number, padStr: string): string {
  let sLen: number = s.length;
  if (sLen >= targetLen) { return s; }
  let padLen: number = padStr.length;
  if (padLen === 0) { return s; }
  let fillLen: number = targetLen - sLen;
  let fill: string = padStr;
  while (fill.length > 0 && fill.length < fillLen) {
    fill = fill + fill;
  }
  return s + fill.substring(0, fillLen);
}
`;

/**
 * One self-hosted string helper unit, in leaf-first emission order.
 *
 * `canonicalName` — the lowered function's ABI already matches the legacy
 * helper exactly (no numeric params), so it is registered in
 * `ctx.nativeStrHelpers` directly under that name.
 *
 * `thunk` — the legacy ABI takes i32 numeric params; a tiny hand thunk with
 * the EXACT legacy signature is registered under `thunk.name`, widening each
 * `"i32"` param via `f64.convert_i32_s` and forwarding to the self-hosted
 * body (whose numeric params are f64). Results need no conversion: string
 * results are `(ref $AnyString)` in both, and boolean results are already
 * i32 in the IR.
 */
export interface SelfHostedStringHelper {
  readonly def: SelfHostedFuncDef;
  readonly canonicalName?: string;
  readonly thunk?: {
    readonly name: string;
    /** Positional param kinds of the LEGACY signature. */
    readonly params: readonly ("str" | "i32")[];
    readonly result: "str" | "i32";
  };
}

function def(
  name: string,
  source: string,
  paramTypes: readonly IrType[],
  returnType: IrType,
  callees: readonly [string, Sig][],
): SelfHostedFuncDef {
  return {
    name,
    source,
    paramTypes,
    returnType,
    calleeTypes: new Map<string, Sig>(callees),
    // NO memoKey: the build resolver's resolveString() bakes a ctx-bound
    // string-slot ValType into the IR (see module header), so the IR must be
    // rebuilt per compilation — bounded to once by emitSelfHostedFunc's
    // funcMap early-return.
    dialect: "native-strings",
  };
}

/**
 * The Tier-1 self-hosted string family, leaf-first. Emitted by
 * `emitSelfHostedStringHelpers` (src/codegen/native-strings-selfhost.ts) at
 * the exact position in `ensureNativeStringHelpers` where the hand builders
 * (`emitStrTrimHelpers`, `emitStrPadRepeatHelpers`, and the
 * startsWith/endsWith blocks of `emitStrSearchHelpers`) used to run.
 */
export const SELF_HOSTED_STRING_HELPERS: readonly SelfHostedStringHelper[] = [
  { def: def("__sh_str_isWs", IS_WS_SOURCE, [F64], I32, []) },
  {
    def: def("__str_trimStart", TRIM_START_SOURCE, [STR], STR, [FLATTEN_CALLEE, WS_START_CALLEE]),
    canonicalName: "__str_trimStart",
  },
  {
    def: def("__str_trimEnd", TRIM_END_SOURCE, [STR], STR, [FLATTEN_CALLEE, WS_END_CALLEE]),
    canonicalName: "__str_trimEnd",
  },
  {
    def: def("__str_trim", TRIM_SOURCE, [STR], STR, [FLATTEN_CALLEE, WS_START_CALLEE, WS_END_CALLEE]),
    canonicalName: "__str_trim",
  },
  {
    def: def("__sh_str_startsWith", STARTS_WITH_SOURCE, [STR, STR, F64], I32, [REGION_EQ_CALLEE]),
    thunk: { name: "__str_startsWith", params: ["str", "str", "i32"], result: "i32" },
  },
  {
    def: def("__sh_str_endsWith", ENDS_WITH_SOURCE, [STR, STR, F64], I32, [REGION_EQ_CALLEE]),
    thunk: { name: "__str_endsWith", params: ["str", "str", "i32"], result: "i32" },
  },
  {
    def: def("__sh_str_repeat", REPEAT_SOURCE, [STR, F64], STR, []),
    thunk: { name: "__str_repeat", params: ["str", "i32"], result: "str" },
  },
  {
    def: def("__sh_str_padStart", PAD_START_SOURCE, [STR, F64, STR], STR, []),
    thunk: { name: "__str_padStart", params: ["str", "i32", "str"], result: "str" },
  },
  {
    def: def("__sh_str_padEnd", PAD_END_SOURCE, [STR, F64, STR], STR, []),
    thunk: { name: "__str_padEnd", params: ["str", "i32", "str"], result: "str" },
  },
];
