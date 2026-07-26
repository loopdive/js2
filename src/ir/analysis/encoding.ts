// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// String encoding analysis (#1588).
//
// Propagates a per-string-value encoding guarantee through the IR,
// distinguishing strings provably containing only well-formed UTF-8 scalar
// values from strings that may contain unpaired surrogates (WTF-16). The
// motivation is the WebAssembly Component Model `string` type, which is
// UTF-8 by definition: a string proven to be valid UTF-8 can cross a
// Component boundary without the scan-and-re-encode copy that a WTF-16
// string requires.
//
// The analysis is purely advisory. A wrongly-conservative annotation yields
// a slower boundary path; a wrongly-optimistic annotation is a correctness
// bug, so every rule errs conservative: the default is `wtf16`, and only an
// explicit, audited origin/propagation rule promotes a value to
// `utf8-guaranteed` or `ascii`.
//
// It writes its result to the #1586 `AllocSiteRegistry` under the
// `encoding` namespace (`ALLOC_NAMESPACES.encoding`); it never mutates the
// IR, so it can run at any point after the build phase. See the issue file
// `plan/issues/sprints/55/1588-...md` and ADR-0013 (allocation sites).
//
// Phase 1 (this pass) covers the string-producing IR instrs that exist on
// the IR path today and carry an `alloc` id from the builder:
//   - `string.const`  → origin rule (ascii if all chars ≤ 0x7F, else utf8)
//   - `string.concat` → join the operands' encodings per the lattice
// Calls that produce UTF-8-by-construction strings (JSON.parse,
// TextDecoder.decode) and method-based propagation (slice/toUpperCase/…)
// are Phase 2: their IR results do not yet carry string `alloc` ids, so
// there is no attachment point for an annotation. Documented as follow-up
// in the issue.

import { ALLOC_NAMESPACES, type AllocSiteRegistry } from "../alloc-registry.js";
import {
  forEachInstrDeep,
  type AllocSiteId,
  type IrFuncRef,
  type IrFunction,
  type IrInstr,
  type IrValueId,
} from "../nodes.js";
import type { IrStringEncoding } from "../string-runtime.js";

/**
 * Encoding lattice. Ordering (most → least restrictive):
 *   ascii  ⊑  utf8-guaranteed  ⊑  wtf16
 * `wtf16` is top (the conservative default); `ascii` is bottom (the
 * strongest claim). The join of two encodings is their least upper bound:
 * any operand being `wtf16` forces `wtf16`; otherwise `utf8-guaranteed`
 * unless both are `ascii`.
 */
export type Encoding = IrStringEncoding;

/** Rank in the lattice — higher is more permissive (closer to top). */
function rank(e: Encoding): number {
  switch (e) {
    case "ascii":
      return 0;
    case "utf8-guaranteed":
      return 1;
    case "wtf16":
      return 2;
  }
}

/** Least upper bound of two encodings (the conservative join). */
export function joinEncoding(a: Encoding, b: Encoding): Encoding {
  return rank(a) >= rank(b) ? a : b;
}

/**
 * Classify a statically known string literal by its code units.
 *   - all code units ≤ 0x7F           → `ascii`
 *   - else, no lone surrogates        → `utf8-guaranteed`
 *   - else (a lone surrogate present) → `wtf16`
 *
 * A surrogate is lone when a high surrogate (0xD800–0xDBFF) is not
 * immediately followed by a low surrogate (0xDC00–0xDFFF), or a low
 * surrogate appears without a preceding high surrogate. Such a string
 * cannot be encoded as UTF-8, so it must stay `wtf16`.
 */
export function classifyLiteral(value: string): Encoding {
  let ascii = true;
  for (let i = 0; i < value.length; i++) {
    const u = value.charCodeAt(i);
    if (u > 0x7f) ascii = false;
    if (u >= 0xd800 && u <= 0xdbff) {
      // High surrogate — must be followed by a low surrogate.
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // consume the well-formed pair
      } else {
        return "wtf16";
      }
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      // Low surrogate with no preceding high surrogate.
      return "wtf16";
    }
  }
  return ascii ? "ascii" : "utf8-guaranteed";
}

/**
 * Run the encoding analysis over a single IR function, writing `encoding`
 * annotations onto the string allocation sites in `registry`. Read-only on
 * the IR. Idempotent: re-running overwrites the same annotations with the
 * same values.
 *
 * The analysis is a single forward pass. SSA dominance guarantees each
 * value is defined before use within a block, and string values in Phase 1
 * are produced and consumed locally (literals + concat), so a per-function
 * value→encoding map filled in instruction order is sufficient. Values with
 * no tracked origin are absent from the map and treated as `wtf16`.
 */
export function analyzeEncoding(fn: IrFunction, registry: AllocSiteRegistry): void {
  const ns = ALLOC_NAMESPACES.encoding;
  const encodings = new Map<IrValueId, Encoding>();

  const enc = (v: IrValueId): Encoding => encodings.get(v) ?? "wtf16";

  const record = (result: IrValueId | null, alloc: AllocSiteId | undefined, e: Encoding): void => {
    if (result !== null) encodings.set(result, e);
    if (alloc !== undefined) registry.annotate(alloc, ns, e);
  };

  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (nested) => classifyInstr(nested, enc, record));
    }
  }
}

function classifyInstr(
  instr: IrInstr,
  enc: (v: IrValueId) => Encoding,
  record: (result: IrValueId | null, alloc: AllocSiteId | undefined, e: Encoding) => void,
): void {
  switch (instr.kind) {
    case "string.const":
      record(instr.result, instr.alloc, classifyLiteral(instr.value));
      return;
    case "string.concat":
      // Concatenation preserves well-formedness: joining two UTF-8 strings
      // cannot create a lone surrogate, and joining two ASCII strings stays
      // ASCII. (WTF-16 inputs can split surrogate pairs across the seam, but
      // the lattice already forces `wtf16` whenever either operand is.)
      record(instr.result, instr.alloc, instr.encodingEvidence ?? joinEncoding(enc(instr.lhs), enc(instr.rhs)));
      return;
    case "string.char_at":
      record(instr.result, instr.alloc, instr.encodingEvidence);
      return;
    case "call":
      // String-returning calls (Phase 2): origin rules for built-ins that
      // produce UTF-8 by construction, propagation rules for string methods
      // whose result preserves the receiver's encoding. Only fires when the
      // builder minted a string `alloc` id (i.e. resultType is string).
      if (instr.alloc !== undefined) {
        record(instr.result, instr.alloc, classifyCall(instr.target, instr.args, enc));
      }
      return;
    case "extern.call":
      // Extern-class string-returning calls (Phase 2), e.g.
      // `TextDecoder.decode` → utf8-guaranteed (WHATWG Encoding spec).
      if (instr.alloc !== undefined) {
        record(instr.result, instr.alloc, classifyExternCall(instr.className, instr.method, enc(instr.receiver)));
      }
      return;
    default:
      // Any other string-producing instr defaults to `wtf16`. We record
      // nothing so the value stays absent from the map, which `enc` reads
      // back as `wtf16`.
      return;
  }
}

/**
 * Method names (after the `string_` / `__str_` backend prefix) whose result
 * preserves the receiver's encoding: case folding and trimming cannot turn a
 * non-surrogate scalar into a surrogate, so a UTF-8/ASCII receiver yields a
 * UTF-8/ASCII result. `slice`/`substring`/`charAt` are deliberately NOT here
 * — code-unit-indexed slicing can split a surrogate pair, so they
 * conservatively drop to `wtf16` (refining slice with statically-known
 * code-point boundaries is a later refinement).
 */
const ENCODING_PRESERVING_METHODS: ReadonlySet<string> = new Set([
  "toUpperCase",
  "toLowerCase",
  "trim",
  "trimStart",
  "trimEnd",
  "normalize",
  "padStart",
  "padEnd",
  "repeat",
]);

/**
 * Built-in functions whose string result is UTF-8 by construction:
 *   - `JSON.stringify` escapes lone surrogates per ES2019+ (§24.5.2.2).
 *   - `JSON.parse` result strings are UTF-8 (RFC 8259 restricts JSON text).
 * These lower to host-import calls named `JSON_stringify` / `JSON_parse`.
 */
const UTF8_ORIGIN_FUNCS: ReadonlySet<string> = new Set(["JSON_stringify", "JSON_parse"]);

/** Strip the string-backend prefix (`string_` host, `__str_` native) if present. */
function stripStringMethodPrefix(name: string): string | null {
  if (name.startsWith("string_")) return name.slice("string_".length);
  if (name.startsWith("__str_")) return name.slice("__str_".length);
  return null;
}

/** Origin/propagation rule for a `call` instr that produces a string. */
function classifyCall(target: IrFuncRef, args: readonly IrValueId[], enc: (v: IrValueId) => Encoding): Encoding {
  const name =
    target.binding.kind === "import"
      ? target.binding.field
      : target.binding.kind === "runtime" || target.binding.kind === "intrinsic"
        ? target.binding.symbol
        : null;
  // A source unit or compiler-owned support artifact may deliberately share
  // a compatibility label with a builtin. Identity wins over that label: only
  // explicit provider bindings participate in builtin encoding rules.
  if (name === null) return "wtf16";
  if (UTF8_ORIGIN_FUNCS.has(name)) return "utf8-guaranteed";
  const method = stripStringMethodPrefix(name);
  if (method !== null && ENCODING_PRESERVING_METHODS.has(method)) {
    // String methods lower with the receiver as the first argument.
    return args.length > 0 ? enc(args[0]!) : "wtf16";
  }
  // `__str_concat` carries no alloc on its own (string.concat does); any other
  // string-returning call is conservatively WTF-16.
  return "wtf16";
}

/** Origin rule for an `extern.call` instr that produces a string. */
function classifyExternCall(className: string, method: string, _receiver: Encoding): Encoding {
  // TextDecoder.decode yields UTF-8 by construction (WHATWG Encoding spec
  // forbids the decoder from producing unpaired surrogates).
  if (className === "TextDecoder" && method === "decode") return "utf8-guaranteed";
  return "wtf16";
}
