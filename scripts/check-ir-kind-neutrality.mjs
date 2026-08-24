#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4551 — the per-kind neutrality verdict for #3954 phase 2.
//
// #3954 phase 2 splits the IR instruction set into a language-neutral core
// (`src/ir/nodes.ts`) and an ECMAScript dialect (`src/ir/dialect/js.ts`). The
// first slice moved the 23 UNCONTESTED kinds. What was missing — and what this
// gate supplies — is a PER-KIND VERDICT for everything else, each with cited
// evidence, so the remaining moves are argued rather than guessed.
//
// `scripts/check-ir-dialect.mjs` is the sibling gate: it enforces the boundary
// (who may import the dialect, what must be re-exported). This one enforces the
// CLASSIFICATION (every kind has a verdict; the verdicts do not silently rot).
//
// ---------------------------------------------------------------------------
// 1. THE POPULATION RULE  (acceptance criterion 1 — a rule, not a grep)
// ---------------------------------------------------------------------------
//
// #4551 exists because two counts of "the instruction kinds" made hours apart
// disagreed by four: `grep -c '^  readonly kind:' src/ir/nodes.ts` answers 85
// (62 today, plus 23 that moved to the dialect), while the `IrInstr` union has
// 78 arms. Neither number was wrong; there was no definition to be wrong about.
//
// The definition this gate uses:
//
//   A KIND IS IN SCOPE iff it is the `readonly kind: "<literal>"` discriminant
//   of a top-level `export interface` that appears as an arm of the `IrInstr`
//   union or the `IrTerminator` union declared in `src/ir/nodes.ts`.
//
// Arms are resolved to their DECLARING interface, which may live in
// `src/ir/nodes.ts` or in `src/ir/dialect/*.ts`. The three deliberately
// excluded symbolic references may also live in `src/ir/value-references.ts`.
// Where a declaration lives is the thing being decided, so it cannot also be
// the thing that defines the population.
//
// IN SCOPE:      78 `IrInstr` arms + 4 `IrTerminator` arms = 82.
//
//   Terminators are in scope because they are instructions that end a block: a
//   new terminator kind is exactly as capable of encoding a language semantic
//   as a new instruction kind, and R-LOUD ("every dispatcher has a throwing
//   default arm", docs/architecture/target-architecture.md) applies to it the
//   same way. All four are neutral CFG primitives today, which is a result, not
//   an assumption.
//
// OUT OF SCOPE, and exactly why:
//
//   `IrFuncRef` / `IrGlobalRef` / `IrTypeRef` — the three SYMBOLIC REFERENCE
//   types, discriminants `"func"` / `"global"` / `"type"`. They are operands
//   (a reference to a call target, a global, a type), never members of an
//   instruction buffer, so there is nothing about them for a dialect split to
//   place. (#4551's prose calls these "declaration kinds"; they are references.
//   The count is the same, the reading is not.)
//
//   Every other `readonly kind:` in the scanned files belongs to an INLINE union
//   member of a payload type — `IrConst`, `IrType`, `IrCallableBinding`,
//   `IrIntrinsicProvider`, `IrStringLengthProvider`, … — not to a top-level
//   `export interface`, so it is never a candidate in the first place.
//
// THE RECONCILIATION IS ASSERTED, NOT ASSUMED. Every run checks
//
//     in-scope (82) + out-of-scope references (3) == kind-bearing top-level
//     `export interface`s == the anchored `^  readonly kind:` grep count (85)
//
// and fails if a kind-bearing interface turns up that is neither an instruction
// nor one of the three named references. That is the check that makes the two
// denominators unable to drift apart again unnoticed.
//
// ---------------------------------------------------------------------------
// 2. WHAT A VERDICT MEANS
// ---------------------------------------------------------------------------
//
// The verdict answers ONE question: does this declaration belong in the JS
// dialect? Not "does JavaScript use it" (JavaScript uses all of them).
//
//   neutral    The instruction's contract is settled by its operands and their
//              types. A non-ECMAScript producer emitting it gets the behaviour
//              ITS language prescribes. Stays in core.
//
//   js         The contract states a behaviour that only ECMAScript specifies,
//              and a non-ECMAScript producer would have to WORK AROUND it — an
//              out-of-range sentinel, an implicit coercion, a protocol. Belongs
//              in `src/ir/dialect/js.ts`.
//
//   unresolved The evidence does not settle the placement. Two shapes recur:
//              (a) the kind is a neutral envelope over a payload VOCABULARY that
//              mixes both (an opcode enum), so moving the declaration is not the
//              unit of the fix; (b) the contract is language-committed but the
//              commitment is SHARED with a language family, which a two-way
//              split cannot express. Every entry names what would settle it.
//
// `unresolved` is a first-class answer, not a gap. An accurate unresolved count
// is the useful output of this exercise; a confident wrong split would give a
// guess the authority of a CI gate. Kinds are also allowed to carry a RESIDUAL:
// a placement that IS settled, plus a named leak that belongs to a different
// seam (#3954 phase 1's `TagDomain`, or the backend axis of
// docs/architecture/codegen-axes.md). Residuals are reported, never gated —
// they are somebody else's phase.
//
// ---------------------------------------------------------------------------
// 3. THE RULES
// ---------------------------------------------------------------------------
//
//   R1  Every in-scope kind has a verdict. An unclassified kind is a HARD
//       FAILURE naming the kind (R-LOUD). Adding an instruction now costs one
//       sentence of classification, which is the entire point.
//
//   R2  Every verdict's evidence must still exist. Evidence is a `{file, quote}`
//       pair, and the quote is checked as a literal substring of the file (plus,
//       for one family, an ABSENCE claim checked across a directory). A citation
//       that has rotted away means the verdict was derived from something that
//       is no longer there, so it fails rather than reporting a stale answer.
//
//   R3  A kind declared in `src/ir/dialect/` must have verdict `js`. Anything
//       else is a placement error already committed.
//
//   R4  Ratchet, against `scripts/ir-kind-neutrality-baseline.json`:
//         - `unresolved` must not grow (target 0);
//         - `jsInCore` — kinds judged `js` that still sit in core, i.e. phase
//           2's remaining move list — must not grow.
//       Any other change to the table (a new kind, a changed verdict, changed
//       evidence) requires the baseline to be refreshed and the diff reviewed.
//
// ---------------------------------------------------------------------------
// 4. USAGE
// ---------------------------------------------------------------------------
//
//   pnpm run check:ir-kind-neutrality                        gate
//   pnpm run check:ir-kind-neutrality -- --verbose           + full table
//   pnpm run check:ir-kind-neutrality -- --json              machine-readable
//   pnpm run check:ir-kind-neutrality -- --update            rewrite baseline
//   pnpm run check:ir-kind-neutrality -- --update-on-decrease
//                                                            gate, but bank an
//                                                            improvement into
//                                                            the baseline on
//                                                            disk (the PR author
//                                                            commits the diff)

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const NODES = "src/ir/nodes.ts";
const VALUE_REFERENCES = "src/ir/value-references.ts";
const DIALECT_DIR = path.join("src", "ir", "dialect");
const IR_DIR = path.join("src", "ir");
const BASELINE = "scripts/ir-kind-neutrality-baseline.json";

/**
 * Kind-bearing top-level interfaces that are deliberately NOT instructions.
 * A fourth one appearing is a real event: it means someone added a discriminated
 * top-level type that this gate cannot see, and the population rule needs a
 * decision rather than a silent default.
 */
const OUT_OF_SCOPE = {
  IrFuncRef: "func",
  IrGlobalRef: "global",
  IrTypeRef: "type",
};

// ---------------------------------------------------------------------------
// The verdict table (#4551). One entry per in-scope kind.
// ---------------------------------------------------------------------------
//
// `evidence` is where the language-specific semantics actually live, or the
// site that shows none does. Quotes are verified against the file on every run.

const VERDICTS = {
  // ── core: values, calls, arithmetic ──────────────────────────────────────
  const: {
    verdict: "neutral",
    why: "Materializes a typed constant; the operation is fixed by the IrConst payload's own type.",
    evidence: [{ file: NODES, quote: '| { readonly kind: "undefined" };' }],
    residual:
      "Value model, not operation: IrConst carries BOTH `null` and `undefined` — the ECMAScript " +
      "two-sentinel model, i.e. the JsTag.Null / JsTag.Undefined partitions (src/ir/js-tag.ts). " +
      "Owned by #3954 phase 1 (TagDomain), not by the dialect split.",
  },
  call: {
    verdict: "neutral",
    why: "Direct call to a symbolic target with exact arity. No `this`, no arguments object, no arity padding.",
    evidence: [{ file: NODES, quote: "Call a function by symbolic reference" }],
  },
  intrinsic: {
    verdict: "unresolved",
    why:
      "Neutral envelope, ECMAScript-sourced vocabulary. `IntrinsicId` is 12 `math.*` ids drawn " +
      "explicitly from the JS `Math` surface, but ECMA-262 §21.3 leaves the transcendentals " +
      "implementation-approximated, so most of them carry no ECMAScript commitment at all — while " +
      "`math.pow` does (§21.3.2.26 mandates pow(1, NaN) = NaN, where C99 pow returns 1).",
    settledBy:
      "State whether a `math.*` id denotes an ECMA-262 clause or an IEEE/libm operation. If the " +
      "former, the vocabulary (not the instruction) is what moves; if the latter, `intrinsic` is " +
      "neutral outright and `math.pow` needs an ECMAScript-specific sibling.",
    evidence: [
      { file: "src/ir/intrinsics.ts", quote: "exact-arity f64 Math surface certified by" },
      { file: "src/ir/intrinsics.ts", quote: '"math.pow"' },
    ],
  },
  "global.get": {
    verdict: "neutral",
    why: "Symbolic module-global read.",
    evidence: [{ file: NODES, quote: "Read a global by symbolic reference" }],
  },
  "global.set": {
    verdict: "neutral",
    why: "Symbolic module-global write.",
    evidence: [{ file: NODES, quote: "Write a global by symbolic reference" }],
  },
  binary: {
    verdict: "unresolved",
    why:
      "The kind is a neutral envelope; its OPCODE ENUM is not. `IrBinop` mixes ~30 one-to-one Wasm " +
      "primitives with six `js.*` COMPOSITES (`js.bitand|bitor|bitxor|shl|shr_s|shr_u`), each " +
      "documented as ToInt32(lhs); ToInt32(rhs); i32.<op>; convert back to f64 — ECMA-262 §7.1.6. " +
      "`i64.rem_s` is likewise labelled a guarded JS Number remainder fast path. So the declaration " +
      "cannot be placed on either side: moving `IrInstrBinary` would exile `f64.add`, leaving it in " +
      "core keeps six ECMAScript operators there. (#4551's contested-family list does not mention " +
      "`binary`; this is a finding, not a restatement.)",
    settledBy:
      "Split `IrBinop`: the six `js.*` composites (and the `i64.rem_s` fast path's ECMAScript " +
      "justification) move to the dialect as a separate opcode union; the Wasm primitives stay. The " +
      "unit of the fix is the enum, not the interface.",
    evidence: [
      { file: NODES, quote: '| "js.bitand"' },
      { file: NODES, quote: "Slice 11 (#1169n) — JS bitwise ops on f64 operands." },
    ],
  },
  unary: {
    verdict: "neutral",
    why:
      "Every `IrUnop` member is a single Wasm opcode (`f64.neg`, `i32.eqz`, `i32.trunc_sat_f64_s`, " +
      "`ref.is_null`, the Math f64 family). Their USES are JS-motivated; the operations are not. " +
      "Contrast `binary`, whose enum carries composite `js.*` ops.",
    evidence: [{ file: NODES, quote: "export type IrUnop =" }],
  },
  select: {
    verdict: "neutral",
    why: "Wasm `select`: both arms evaluated, no short-circuit, no coercion.",
    evidence: [{ file: NODES, quote: "Both arms are evaluated" }],
  },
  if: {
    verdict: "neutral",
    why: "Value-producing short-circuiting if/else over an i32 condition. Truthiness is NOT part of it — `dyn.truthy` is, and that already lives in the dialect.",
    evidence: [{ file: NODES, quote: "SHORT-CIRCUITS — only one branch's instructions are executed" }],
  },
  "raw.wasm": {
    verdict: "neutral",
    why: "An opaque backend instruction sequence. Nothing about it is language-specific.",
    evidence: [{ file: NODES, quote: "Escape hatch: a raw backend instruction sequence" }],
    residual:
      "Backend axis, not the language axis: it carries `Instr[]`, i.e. concrete backend opcodes, " +
      "so it is a backend-agnosticism leak (docs/architecture/codegen-axes.md), not an ECMAScript one.",
  },

  // ── core: tagged values (#3954 phase 1 territory) ─────────────────────────
  box: {
    verdict: "neutral",
    why:
      "One boxing concept over a tagged carrier. It also serves plain scalar tagged unions with no " +
      "JS involvement, so it is not a JS-only operation and moving it to the dialect would be wrong.",
    evidence: [{ file: NODES, quote: "ONE boxing concept in the IR" }],
    residual:
      'The JS content is TYPE-LEVEL, via `toType.kind === "dynamic"` and the dynamic leaf\'s ' +
      "`tag?: TagId` refinement — #3954 phase 1's `TagDomain` seam, not a dialect question. Phase 1 " +
      "made the refinement neutral at the declaration; what is still ECMAScript is the LOWERING, " +
      "which crosses `TagId -> JsTag` (`lower.ts` `jsTagOf`) to meet the #3029-S1-frozen " +
      "`IrDynamicLowering` contract. That is #3954 phase 3's W2/W6, and it moves no declaration.",
  },
  unbox: {
    verdict: "neutral",
    why: "Payload extraction from a tagged carrier after the tag is proven; the union operand form has no JS content.",
    evidence: [{ file: NODES, quote: "readonly tagId?: TagId;" }],
    residual:
      "Same as `box`. #3954 phase 3 (W4/W5) made the operand itself neutral — the field is " +
      "`tagId?: TagId` and `IrFunctionBuilder` asks a `TagDomain` — so the residual is now only the " +
      "`TagId -> JsTag` crossing in the lowering pass (W2/W6), which is a seam question.",
  },
  "tag.test": {
    verdict: "neutral",
    why: "Runtime tag discriminator over a tagged carrier; serves scalar unions as well as the dynamic carrier.",
    evidence: [{ file: NODES, quote: "Runtime tag discriminator" }],
    residual:
      "Same as `unbox`: the operand is a neutral `tagId?: TagId` since #3954 phase 3 (W4/W5); the " +
      "residual is the `TagId -> JsTag` crossing in the lowering pass (W2/W6), a seam question.",
  },

  // ── core: strings ────────────────────────────────────────────────────────
  //
  // #4551's hypothesis was that the JS shape here is the OPERATION SET, not the
  // encoding, because `IrStringEncoding` (ascii | utf8-guaranteed | wtf16)
  // already parameterizes the backends. Confirmed: three of six are neutral,
  // two are unambiguously ECMAScript, one is a family commitment.
  "string.const": {
    verdict: "neutral",
    why: "Materializes a literal; storage/materializer are backend selections made during preparation.",
    evidence: [{ file: NODES, quote: "Raw JS string; the lowerer treats" }],
    residual:
      "Carrier: the literal's length is counted in UTF-16 code units, the same family commitment " +
      "that leaves `string.len` unresolved. Settling `string.len` settles this too.",
  },
  "string.concat": {
    verdict: "neutral",
    why: "Concatenation of two values already statically known to be strings — no ToString, no `+` overload.",
    evidence: [{ file: NODES, quote: "Concatenate two strings" }],
  },
  "string.repeat": {
    verdict: "js",
    why:
      "ECMAScript String.prototype.repeat owns both the f64 count normalization through " +
      "ToIntegerOrInfinity and the negative/+Infinity RangeError. A non-JS producer would " +
      "have to work around that language contract rather than merely select a backend provider.",
    evidence: [
      {
        file: path.join(DIALECT_DIR, "js.ts"),
        quote: "Repeat a string using ECMAScript `String.prototype.repeat` count semantics.",
      },
      {
        file: "src/ir/string-runtime.ts",
        quote: 'readonly negative: "range-error-or-backend-trap";',
      },
    ],
  },
  "string.eq": {
    verdict: "neutral",
    why: "Value equality of two strings. No abstract equality, no coercion — `dyn.eq` covers that and is already in the dialect.",
    evidence: [{ file: NODES, quote: "String equality." }],
  },
  "string.len": {
    verdict: "unresolved",
    why:
      "The MEANING is settled and it is not encoding-parameterized: every backend returns the UTF-16 " +
      "CODE-UNIT count. The linear backend calls `__str_length_utf16` regardless of `inputEncoding`, " +
      "and the WasmGC native provider reads a field documented as the UTF-16 code-unit length. What " +
      "is NOT settled is the placement: that commitment is shared verbatim with Java/C#/the whole " +
      "UTF-16 family, so it is not ECMAScript-specific the way `char_at`'s out-of-range sentinel is, " +
      "yet it is a language commitment a Rust or Python producer could not use.",
    settledBy:
      "A policy call phase 2 has to make anyway: does `js` mean ECMAScript-SPECIFIC, or " +
      "LANGUAGE-COMMITTED? If the former, `string.len` stays in core with a documented commitment; if " +
      "the latter it moves — and the same answer then governs a future `utf16-string` dialect shared " +
      "by the family, which is the third option.",
    evidence: [
      { file: NODES, quote: "field 0 is the UTF-16 code-unit length" },
      { file: "src/ir/backend/linear-integration.ts", quote: "__str_length_utf16" },
      {
        file: "src/ir/string-runtime.ts",
        quote: 'export type IrStringEncoding = "ascii" | "utf8-guaranteed" | "wtf16";',
      },
    ],
  },
  "string.char_at": {
    verdict: "js",
    why:
      "ECMAScript §22.1.3.1, twice over: the index is normalized by ToIntegerOrInfinity (§7.1.5) and " +
      "an out-of-range index yields the EMPTY STRING rather than trapping. That total-function " +
      "convention is the thing a non-JS producer would have to work around — Java throws, Rust panics.",
    evidence: [
      {
        file: path.join(DIALECT_DIR, "js.ts"),
        quote: "Return one UTF-16 code unit as a string, or the empty string out of bounds.",
      },
      {
        file: "src/ir/string-runtime.ts",
        quote: "ECMAScript ToIntegerOrInfinity after the caller has performed ToNumber.",
      },
    ],
  },
  "string.char_code_at": {
    verdict: "js",
    why:
      "ECMAScript §22.1.3.2: out-of-range yields NaN. The repo even carries `utf16CharCodeAt` as the " +
      "reference semantics for backend-independent evidence tests, which is a spec obligation, not a " +
      "representation choice.",
    evidence: [
      { file: path.join(DIALECT_DIR, "js.ts"), quote: "Return one UTF-16 code unit as f64, or NaN out of bounds." },
      { file: "src/ir/string-runtime.ts", quote: "export function utf16CharCodeAt" },
    ],
  },

  // ── core: objects ────────────────────────────────────────────────────────
  //
  // #4551 framed this as "open-map semantics vs a declared record layout". It is
  // the declared record layout, decisively: `IrObjectShape` is a fixed, sorted
  // field list and lowering is `struct.get`/`struct.set` by index. The open-map
  // half of JS objects is `dyn.member_get`/`dyn.member_set`, already in the
  // dialect — so the split this family was suspected of needing already exists.
  "object.new": {
    verdict: "neutral",
    why: "Constructs a record from a declared field layout. No prototype, no descriptors, no insertion order semantics.",
    evidence: [
      { file: NODES, quote: "export interface IrObjectShape {" },
      { file: NODES, quote: "readonly shape: IrObjectShape;" },
    ],
  },
  "object.get": {
    verdict: "neutral",
    why: "Static field read by name, resolved to a struct index at lowering. Dynamic keys are `dyn.member_get`, which is in the dialect.",
    evidence: [
      { file: NODES, quote: "Read a named field from an object." },
      { file: path.join(DIALECT_DIR, "js.ts"), quote: '"dyn.member_get"' },
    ],
  },
  "object.set": {
    verdict: "neutral",
    why: "Static field write by name. The JS `[[Set]]` path is `dyn.member_set`, which is in the dialect.",
    evidence: [
      { file: NODES, quote: "Write a named field on an object." },
      { file: path.join(DIALECT_DIR, "js.ts"), quote: '"dyn.member_set"' },
    ],
  },

  // ── core: closures + ref cells ───────────────────────────────────────────
  "closure.new": {
    verdict: "neutral",
    why: "Lifted function plus a capture struct — the standard closure conversion, older than JS.",
    evidence: [{ file: NODES, quote: "Materialize a closure value." }],
  },
  "closure.cap": {
    verdict: "neutral",
    why: "Reads capture slot N out of the closure's own self parameter.",
    evidence: [{ file: NODES, quote: "SSA value of the closure-typed __self param" }],
  },
  "closure.call": {
    verdict: "neutral",
    why: "Indirect call through a typed funcref with EXACT arity — not the ECMAScript call model.",
    evidence: [{ file: NODES, quote: "Invoke a compiler-owned closure or a boundary callable." }],
    residual:
      "`IrClosureSignature.defaultParamStart` lets a caller omit a trailing numeric suffix, padded " +
      "with a reserved missing-argument sentinel. Optional parameters are widely shared, but the " +
      "sentinel is a value-model artifact — phase 1 territory, and a signature field rather than an " +
      "instruction, so it does not move with this kind either way.",
  },
  "refcell.new": {
    verdict: "neutral",
    why: "One-field mutable cell — the standard boxing of a mutable capture.",
    evidence: [{ file: NODES, quote: "Wrap a primitive value in a fresh ref cell." }],
  },
  "refcell.get": {
    verdict: "neutral",
    why: "Reads the cell's single field.",
    evidence: [{ file: NODES, quote: "Read the inner value out of a ref cell." }],
  },
  "refcell.set": {
    verdict: "neutral",
    why: "Writes the cell's single field.",
    evidence: [{ file: NODES, quote: "Write a new value through a ref cell." }],
  },

  // ── core: nominal function-style constructors ---------------------------
  "fnctor.new": {
    verdict: "neutral",
    why: "Materializes a nominal function-style constructor through an exact ABI handle; the operation is not an ECMAScript protocol by itself.",
    evidence: [{ file: NODES, quote: "Materialize one source-qualified function-style constructor instance." }],
  },
  "fnctor.get": {
    verdict: "neutral",
    why: "Reads a declared field from a nominal constructor carrier; field identity and representation come from the resolved layout.",
    evidence: [{ file: NODES, quote: "Read one field from a nominal function-style constructor instance." }],
  },

  // ── core: classes ────────────────────────────────────────────────────────
  //
  // #4551 calls this family "genuinely open — single-inheritance prototype
  // flavoured, but shared with Java/Kotlin/Dart". The evidence sharpens that: it
  // is not prototype-flavoured at all. `IrClassShape` is nominal (classId,
  // fields, methods, constructorParams, one `parent`), instances are WasmGC
  // structs with a hidden tag at slot 0, dispatch is a direct call to a resolved
  // slot, and the JS-only machinery — prototype objects, `Symbol.hasInstance`,
  // `new.target`, property descriptors, the derived-`this` TDZ — has no
  // representation anywhere in the family. Where a JS class cannot be projected
  // onto that model (an externref-backed parent), from-ast declines and demotes
  // to legacy rather than widening the IR. Every member is neutral.
  "class.new": {
    verdict: "neutral",
    why: "Allocates a nominal class instance through the class-owned constructor wrapper. No `new.target`, no constructor-returns-object override.",
    evidence: [
      { file: NODES, quote: "export interface IrClassShape {" },
      { file: NODES, quote: "Construct a class instance through the class-owned AST-free" },
    ],
  },
  "class.super_init": {
    verdict: "neutral",
    why:
      "Runs the parent's initializer on an ALREADY-ALLOCATED `self`. That is the C++/Java " +
      "allocate-then-initialize order, which is precisely NOT ECMAScript's derived-constructor " +
      "protocol (where the base creates `this` and it is in TDZ until `super()` returns).",
    evidence: [{ file: NODES, quote: "Runs the PARENT class's" }],
  },
  "class.super_call": {
    verdict: "neutral",
    why: "Statically dispatches to the parent's method slot, bypassing the override — the same operation as Java's `super.m()`.",
    evidence: [{ file: NODES, quote: "Static-dispatches" }],
  },
  "class.get": {
    verdict: "neutral",
    why: "Struct field read by declared name.",
    evidence: [{ file: NODES, quote: "Read a named field from a class instance." }],
  },
  "class.set": {
    verdict: "neutral",
    why: "Struct field write by declared name.",
    evidence: [{ file: NODES, quote: "Write a named field on a class instance." }],
  },
  "class.call": {
    verdict: "neutral",
    why: "Virtual dispatch against the receiver's shape with the receiver prepended. Accessors are a member kind, shared with Kotlin/C#/Dart.",
    evidence: [{ file: NODES, quote: "Invoke an instance method or accessor." }],
  },
  "class.instanceof": {
    verdict: "neutral",
    why:
      "A CLOSED-WORLD NOMINAL TYPE TEST, not the JS operator it is named after: the operand must be " +
      "statically `IrType.class`, and the test compares a hidden tag against the target's tag plus " +
      "its transitive children. No prototype chain walk, no `Symbol.hasInstance`, no TypeError on a " +
      "non-callable right-hand side. This is Java's `instanceof` / Kotlin's `is`.",
    evidence: [{ file: NODES, quote: "compare against the TARGET class's tag + all descendant tags" }],
  },
  "class.static_call": {
    verdict: "neutral",
    why: "Direct call to a static member slot, no receiver.",
    evidence: [{ file: NODES, quote: "Static method call" }],
  },

  // ── core: slots ──────────────────────────────────────────────────────────
  "slot.read": {
    verdict: "neutral",
    why: "Reads a function-level Wasm local.",
    evidence: [{ file: NODES, quote: "Read a Wasm-local slot." }],
  },
  "slot.write": {
    verdict: "neutral",
    why: "Writes a function-level Wasm local.",
    evidence: [{ file: NODES, quote: "Write a value to a Wasm-local slot." }],
  },

  // ── core: vectors ────────────────────────────────────────────────────────
  //
  // #4551's leading suspicion — that `vec.*` carries JS array holes — is
  // REFUTED, and the refutation is mechanical: `src/codegen/array-holes.ts` (the
  // `$Hole` sentinel that makes a JS array sparse) has no importer anywhere
  // under `src/ir/`. The IR does not model holes; it REFUSES them. A sparse
  // array literal is excluded from `vec.new_fixed`, and a store into an array
  // known to be holey is routed to a runtime helper instead of `vec.set`. What
  // is left is a dense growable vector with i32 indices and planned in-bounds
  // access — no hole, no out-of-range-yields-undefined, no index coercion, no
  // prototype lookup on miss.
  "vec.len": {
    verdict: "neutral",
    why: "Reads a dense vector's logical length. Element count is a language-independent unit (contrast `string.len`, whose unit is a language commitment).",
    evidence: [{ file: NODES, quote: "(i32) from a vec struct" }],
    residual:
      "The result defaults to f64 to compose with the JS number model; `integer?: true` opts back " +
      "into a physical i32, which is what shows it is a REPRESENTATION default rather than part of " +
      "the operation. #3954 phase 1.",
  },
  "vec.get": {
    verdict: "neutral",
    why: "Planned in-bounds `array.get` at an i32 index.",
    evidence: [{ file: NODES, quote: "Index into a vec struct's data array." }],
    absence: {
      dir: IR_DIR,
      pattern: "array-holes",
      note: "JS array holes ($Hole sentinel) live in src/codegen/array-holes.ts, ABOVE the IR, and nothing under src/ir/ imports it.",
    },
  },
  "vec.set": {
    verdict: "neutral",
    why: "One planned in-bounds store. Bounds and growth policy stay explicit in the surrounding IR; a holey-array store is routed to a runtime helper instead.",
    evidence: [
      { file: NODES, quote: "Mutate one already-allocated dense-vector element." },
      { file: "src/ir/from-ast.ts", quote: "isHoleyArrayElementStore" },
    ],
  },
  "vec.set_length": {
    verdict: "neutral",
    why: "Writes a resizable vector's logical length.",
    evidence: [{ file: NODES, quote: "Update the logical length of an already-allocated vector." }],
  },
  "vec.new_fixed": {
    verdict: "neutral",
    why: "Builds a dense vector from statically-known elements. Sparse literals are explicitly out of scope and fall back to legacy, so no hole can reach this node.",
    evidence: [{ file: "src/ir/from-ast.ts", quote: "elision holes" }],
  },
  "forof.vec": {
    verdict: "neutral",
    why:
      "An index counter over a dense vector — and deliberately NOT ECMAScript's ArrayIterator: the " +
      "length is read ONCE into a slot before the loop, where §23.1.5.1 re-reads it every step. A " +
      "producer whose language wants a snapshot loop gets exactly that.",
    evidence: [{ file: NODES, quote: "struct.get $vec length" }],
  },

  // ── core: host boundary ──────────────────────────────────────────────────
  "coerce.to_externref": {
    verdict: "neutral",
    why:
      "A representation conversion (`extern.convert_any`, or a no-op when the input is already " +
      "externref). Crossing to the host is a HOST-boundary concern, not a language one — the same " +
      "reading #4551 records for the backend's emitToExternref/emitFromExternref.",
    evidence: [{ file: NODES, quote: "extern.convert_any" }],
  },

  // ── core: strings, iterated ──────────────────────────────────────────────
  "forof.string": {
    verdict: "js",
    why:
      "This is `%String.prototype%[@@iterator]` inlined as a statement form. The per-iteration " +
      "element is a CODE POINT rendered as a one-element string — the intent field resolves to " +
      "`__str_charAt_cp`, deliberately not the code-unit `string.char_at` next door. Its general " +
      "sibling `forof.iter` is already in the dialect, so keeping the string specialization in core " +
      "splits one protocol across the boundary.",
    evidence: [
      { file: path.join(DIALECT_DIR, "js.ts"), quote: "Code-point extraction intent" },
      { file: "src/ir/integration.ts", quote: "__str_charAt_cp" },
    ],
  },

  // ── core: exceptions ─────────────────────────────────────────────────────
  throw: {
    verdict: "neutral",
    why:
      "Raises through one Wasm tag with a reference payload. No Error hierarchy, no completion " +
      "record, no type-based dispatch — a typed language would test in the handler, which this model " +
      "permits.",
    evidence: [{ file: NODES, quote: "Slice 9 (#1169h) — throw an exception." }],
  },
  try: {
    verdict: "neutral",
    why:
      "Structured try/catch/finally with one untyped handler. Notably it does NOT model completion " +
      "records: `early.return` is REFUSED inside these buffers rather than being made to run the " +
      "inlined finally, so the ECMAScript machinery is excluded rather than encoded.",
    evidence: [{ file: NODES, quote: "try / catch / finally as a declarative statement-level" }],
  },

  // ── core: structured control flow ────────────────────────────────────────
  "early.return": {
    verdict: "neutral",
    why:
      "A Wasm `return` from inside a nested buffer. Its soundness scope cites ECMAScript, but as a " +
      "RESTRICTION against dialect kinds (it is refused inside `try` and `forof.iter`), not as a " +
      "semantic of its own.",
    evidence: [{ file: NODES, quote: "SOUNDNESS SCOPE (selector-enforced, mirrored in from-ast):" }],
  },
  "while.loop": {
    verdict: "neutral",
    why: "Pre-test loop over a condition buffer whose value is an i32. Truthiness conversion happens before it, in `dyn.truthy`.",
    evidence: [{ file: NODES, quote: "Instructions that compute the condition. Re-evaluated per iteration." }],
  },
  "for.loop": {
    verdict: "neutral",
    why: "Pre-test loop with an update buffer. The init clause is ordinary IR emitted before it.",
    evidence: [{ file: NODES, quote: "The instr carries cond, body, update." }],
  },
  "br.label": {
    verdict: "neutral",
    why: "Branch to a named enclosing loop frame in break or continue mode. Labeled break/continue is C-family, not ECMAScript-specific.",
    evidence: [{ file: NODES, quote: "branch to an enclosing loop frame identified by" }],
  },
  "if.stmt": {
    verdict: "neutral",
    why: "Statement-level if/else over an i32 condition, no carrier values.",
    evidence: [{ file: NODES, quote: "there are no carrier values and no result" }],
  },
  "labeled.block": {
    verdict: "neutral",
    why: "A break-only labeled frame lowering to one Wasm block.",
    evidence: [{ file: NODES, quote: "a break-only labeled frame" }],
  },
  switch: {
    verdict: "neutral",
    why:
      "The C-family fall-through ladder. Case selection compares literals in the discriminant's own " +
      "value type, so the NaN/-0 behaviour it documents is IEEE-754's, reached through `f64.eq`, not " +
      "an ECMAScript rule.",
    evidence: [{ file: NODES, quote: "the classic block-per-case ladder" }],
  },

  // ── terminators ──────────────────────────────────────────────────────────
  return: {
    verdict: "neutral",
    why: "Block terminator returning the function's results.",
    evidence: [{ file: NODES, quote: "export interface IrTerminatorReturn {" }],
  },
  br: {
    verdict: "neutral",
    why: "Unconditional branch with block arguments in place of phi nodes.",
    evidence: [{ file: NODES, quote: "Block args replace phi" }],
  },
  br_if: {
    verdict: "neutral",
    why: "Two-target conditional branch on an i32 condition.",
    evidence: [{ file: NODES, quote: "export interface IrTerminatorBrIf {" }],
  },
  unreachable: {
    verdict: "neutral",
    why: "Unreachable terminator.",
    evidence: [{ file: NODES, quote: "export interface IrTerminatorUnreachable {" }],
  },

  // ── dialect: already placed by #3954 phase 2 slice 1 ─────────────────────
  //
  // These 23 were moved because they are uncontested. Their verdicts are
  // recorded here anyway: R3 checks that nothing in the dialect is classified
  // neutral, which only means something if the dialect's kinds are classified.
  "dyn.truthy": {
    verdict: "js",
    why: "ECMAScript ToBoolean over a dynamically-tagged value (§7.1.2).",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "general truthiness is this node" }],
  },
  "dyn.to_number": {
    verdict: "js",
    why: "ECMAScript ToNumber over a dynamically-tagged value (§7.1.4).",
    evidence: [
      { file: path.join(DIALECT_DIR, "js.ts"), quote: "spec-correct ONLY when the OTHER operand is a number" },
    ],
  },
  "dyn.eq": {
    verdict: "js",
    why: "ECMAScript abstract/strict equality over dynamically-tagged values (§7.2.13/§7.2.15).",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "helper always computes the positive" }],
  },
  "dyn.member_get": {
    verdict: "js",
    why: "ECMAScript property lookup [[Get]] by dynamic key — the open-map half of JS objects.",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "receiver in a member read" }],
  },
  "dyn.member_set": {
    verdict: "js",
    why: "ECMAScript [[Set]] by dynamic key, with spec evaluation order.",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "delegates the actual" }],
  },
  "iter.new": {
    verdict: "js",
    why: "GetIterator — the @@iterator protocol (§7.4.2).",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "$__iterator " }],
  },
  "iter.next": {
    verdict: "js",
    why: "IteratorNext (§7.4.3).",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "$__iterator_next" }],
  },
  "iter.done": {
    verdict: "js",
    why: "IteratorComplete — reads `done` off a result object (§7.4.4).",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "$__iterator_done" }],
  },
  "iter.value": {
    verdict: "js",
    why: "IteratorValue — reads `value` off a result object (§7.4.5).",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "$__iterator_value" }],
  },
  "iter.return": {
    verdict: "js",
    why: "IteratorClose — the protocol's cleanup call (§7.4.9).",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "$__iterator_return" }],
  },
  "forof.iter": {
    verdict: "js",
    why: "`for (x of it)` over the @@iterator protocol, as a statement form.",
    evidence: [{ file: NODES, quote: "widens the for-of bridge to the host iterator protocol" }],
  },
  "gen.push": {
    verdict: "js",
    why: "Appends a yielded value to a generator object's buffer.",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "$__gen_push_f64" }],
  },
  "gen.epilogue": {
    verdict: "js",
    why: "Materializes the Generator object a generator function returns (§27.5).",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "the Generator object" }],
  },
  "gen.yieldStar": {
    verdict: "js",
    why: "`yield*` delegation (§27.5.3.7).",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "Under the eager-buffer model this is discarded" }],
  },
  "gen.setReturn": {
    verdict: "js",
    why: "Records a generator's return completion value.",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "$__gen_set_return" }],
  },
  "extern.new": {
    verdict: "js",
    why: "Constructs a JS host class instance through its registered import surface.",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "call $<className>_new" }],
  },
  "extern.call": {
    verdict: "js",
    why: "Calls a method on a JS host class instance.",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "call $<className>_<method>" }],
  },
  "extern.prop": {
    verdict: "js",
    why: "Reads a property off a JS host class instance.",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "call $<className>_get_<property>" }],
  },
  "extern.propSet": {
    verdict: "js",
    why: "Writes a property on a JS host class instance.",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "call $<className>_set_<property>" }],
  },
  "extern.regex": {
    verdict: "js",
    why: "A RegExp literal — an ECMAScript language form with its own grammar.",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: 'className: "RegExp"' }],
  },
  await: {
    verdict: "js",
    why: "Suspends on a Promise, wrapping a non-Promise via Promise.resolve (§27.2.1.4).",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "Promise.resolve" }],
  },
  "async.return": {
    verdict: "js",
    why: "Resolves an async function's Promise with the returned value.",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "inside an async" }],
  },
  "async.throw": {
    verdict: "js",
    why: "Rejects an async function's Promise.",
    evidence: [{ file: path.join(DIALECT_DIR, "js.ts"), quote: "state = REJECTED" }],
  },
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const fileCache = new Map();
function read(file) {
  let text = fileCache.get(file);
  if (text === undefined) {
    text = readFileSync(file, "utf8");
    fileCache.set(file, text);
  }
  return text;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Top-level `export interface`s that declare a `readonly kind: "…"` discriminant. */
function kindBearingInterfaces(file) {
  const text = read(file);
  const out = new Map();
  for (const m of text.matchAll(/^export interface (\w+)[^{]*\{/gm)) {
    const start = m.index + m[0].length;
    const end = text.indexOf("\n}", start);
    if (end < 0) continue;
    const body = text.slice(start, end);
    const km = body.match(/^ {2}readonly kind: "([^"]+)";/m);
    if (!km) continue;
    out.set(m[1], { kind: km[1], file, line: lineOf(text, start + body.indexOf(km[0])) });
  }
  return out;
}

/** Arm names of a top-level union type, comments stripped. */
function unionArms(file, name) {
  const text = read(file);
  const anchor = new RegExp(`^export type ${name} =`, "m").exec(text);
  if (!anchor) return null;
  const lines = text.slice(anchor.index).split("\n");
  const kept = [];
  let closed = false;
  for (const raw of lines) {
    const code = raw.replace(/\/\/.*$/, "");
    kept.push(code);
    if (code.trimEnd().endsWith(";")) {
      closed = true;
      break;
    }
  }
  if (!closed) return null;
  return kept
    .join(" ")
    .replace(new RegExp(`^export type ${name} =`), "")
    .replace(/;\s*$/, "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const verbose = args.includes("--verbose");
const update = args.includes("--update");
const updateOnDecrease = args.includes("--update-on-decrease");

const failures = [];
const fail = (msg) => failures.push(msg);

function die() {
  console.error("IR kind-neutrality gate: FAILED\n");
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(
    `${failures.length} violation(s). The verdict table lives in scripts/check-ir-kind-neutrality.mjs; ` +
      `see #4551 and #3954 phase 2.`,
  );
  process.exit(1);
}

// ── population ────────────────────────────────────────────────────────────
const dialectFiles = (() => {
  try {
    return walk(DIALECT_DIR);
  } catch {
    return [];
  }
})();
const sourceFiles = [NODES, VALUE_REFERENCES, ...dialectFiles];

const declared = new Map(); // interface name -> {kind, file, line}
for (const file of sourceFiles) {
  for (const [name, info] of kindBearingInterfaces(file)) {
    if (declared.has(name))
      fail(`duplicate kind-bearing interface \`${name}\` in ${file} and ${declared.get(name).file}`);
    declared.set(name, info);
  }
}

const instrArms = unionArms(NODES, "IrInstr");
const termArms = unionArms(NODES, "IrTerminator");
if (!instrArms || !termArms) {
  fail(
    `${NODES}: could not parse the \`IrInstr\` / \`IrTerminator\` union declarations. The population ` +
      "rule is defined in terms of those two unions (see this script's header) — if they were " +
      "renamed or restructured, the rule has to be restated here, not silently skipped.",
  );
  die();
}

const population = new Map(); // kind -> {interface, file, line, union}
for (const [union, arms] of [
  ["IrInstr", instrArms],
  ["IrTerminator", termArms],
]) {
  for (const arm of arms) {
    if (!/^\w+$/.test(arm)) {
      fail(
        `${NODES}: \`${union}\` has a non-interface arm \`${arm}\`. The population rule resolves every ` +
          "arm to a named interface with a `kind` discriminant; an inline member cannot carry a verdict.",
      );
      continue;
    }
    const info = declared.get(arm);
    if (!info) {
      fail(`${NODES}: \`${union}\` arm \`${arm}\` has no top-level interface declaring a \`readonly kind\` field.`);
      continue;
    }
    population.set(info.kind, { interface: arm, file: info.file, line: info.line, union });
  }
}

// ── reconciliation: every kind-bearing interface is accounted for ─────────
const populationInterfaces = new Set([...population.values()].map((p) => p.interface));
const excluded = [...declared.entries()].filter(([name]) => !populationInterfaces.has(name));
for (const [name, info] of excluded) {
  if (OUT_OF_SCOPE[name] !== info.kind) {
    fail(
      `${info.file}:${info.line}: \`${name}\` declares kind "${info.kind}" but is neither an \`IrInstr\`/` +
        "`IrTerminator` arm nor one of the three symbolic-reference types the population rule excludes " +
        `(${Object.keys(OUT_OF_SCOPE).join(", ")}). Decide whether it is in scope and say so in this ` +
        "script's header — do not let a fourth category default silently.",
    );
  }
}
for (const name of Object.keys(OUT_OF_SCOPE)) {
  if (!declared.has(name)) {
    fail(
      `${NODES}/${VALUE_REFERENCES}: the population rule excludes \`${name}\`, which no longer exists. Update the rule in ` +
        "this script's header so the reconciliation keeps describing reality.",
    );
  }
}

const grepCount = sourceFiles.reduce((n, file) => n + (read(file).match(/^ {2}readonly kind:/gm) ?? []).length, 0);
if (grepCount !== population.size + excluded.length) {
  fail(
    `reconciliation broke: the anchored grep finds ${grepCount} \`readonly kind:\` fields across ` +
      `${sourceFiles.length} file(s), but the population rule accounts for ${population.size} in-scope + ` +
      `${excluded.length} excluded = ${population.size + excluded.length}. A kind is declared somewhere ` +
      "the parser does not look (a non-exported interface, or a nested shape at two-space indent). " +
      "#4551 exists because two counts of this population disagreed once already.",
  );
}

if (failures.length > 0) die();

// ── R1 / R3: verdicts ─────────────────────────────────────────────────────
const inDialect = (file) => path.normalize(file).startsWith(path.normalize(DIALECT_DIR) + path.sep);

const table = {};
for (const [kind, info] of [...population.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const entry = VERDICTS[kind];
  if (!entry) {
    fail(
      `UNCLASSIFIED KIND "${kind}" (${info.interface}, ${info.file}:${info.line}).\n` +
        `    Every IR instruction kind needs a neutral / js / unresolved verdict with cited evidence ` +
        `before it can merge (#4551; R-LOUD in docs/architecture/target-architecture.md).\n` +
        `    Add an entry to VERDICTS in scripts/check-ir-kind-neutrality.mjs:\n` +
        `      "${kind}": { verdict: "neutral" | "js" | "unresolved", why: "…",\n` +
        `                  evidence: [{ file: "…", quote: "…" }] }\n` +
        `    "unresolved" is a legitimate answer and needs a settledBy: — a guess is not, because the ` +
        `gate would then lend it authority.`,
    );
    continue;
  }
  if (!["neutral", "js", "unresolved"].includes(entry.verdict)) {
    fail(`"${kind}": verdict "${entry.verdict}" is not one of neutral / js / unresolved.`);
    continue;
  }
  if (entry.verdict === "unresolved" && !entry.settledBy) {
    fail(`"${kind}": an \`unresolved\` verdict must state what would settle it (\`settledBy\`).`);
  }
  const dialect = inDialect(info.file);
  if (dialect && entry.verdict !== "js") {
    fail(
      `"${kind}" is declared in the JS dialect (${info.file}:${info.line}) but its verdict is ` +
        `"${entry.verdict}". A kind in \`${DIALECT_DIR}/\` is asserted to encode ECMAScript; if that is ` +
        "wrong, the declaration moves back to the core, not the verdict.",
    );
  }

  // R2 — the evidence must still exist.
  const cites = [];
  for (const cite of entry.evidence ?? []) {
    let text;
    try {
      text = read(cite.file);
    } catch {
      fail(`"${kind}": cited evidence file ${cite.file} does not exist. Re-derive the verdict.`);
      continue;
    }
    const at = text.indexOf(cite.quote);
    if (at < 0) {
      fail(
        `"${kind}": the cited evidence is gone from ${cite.file} — ${JSON.stringify(cite.quote)}. The ` +
          "verdict was derived from something that no longer exists, so it has to be re-derived rather " +
          "than re-stated.",
      );
      continue;
    }
    cites.push(`${cite.file}:${lineOf(text, at)}`);
  }
  if (cites.length === 0 && !entry.absence) {
    fail(`"${kind}": a verdict needs at least one piece of cited evidence.`);
  }
  if (entry.absence) {
    const hits = walk(entry.absence.dir).filter((f) => read(f).includes(entry.absence.pattern));
    if (hits.length > 0) {
      fail(
        `"${kind}": the verdict rests on ${JSON.stringify(entry.absence.pattern)} being ABSENT from ` +
          `${entry.absence.dir}/, and it now appears in ${hits.length} file(s), e.g. ${hits[0]}. ` +
          `${entry.absence.note}`,
      );
    }
    cites.push(`(absent from ${entry.absence.dir}/: ${entry.absence.pattern})`);
  }

  table[kind] = {
    verdict: entry.verdict,
    where: dialect ? "dialect" : "core",
    declaredAt: `${info.file}:${info.line}`,
    why: entry.why,
    evidence: cites,
    ...(entry.settledBy ? { settledBy: entry.settledBy } : {}),
    ...(entry.residual ? { residual: entry.residual } : {}),
  };
}

for (const kind of Object.keys(VERDICTS)) {
  if (!population.has(kind)) {
    fail(
      `"${kind}" has a verdict but is no longer an instruction kind. Remove it from VERDICTS and refresh ` +
        `the baseline (--update).`,
    );
  }
}

if (failures.length > 0) die();

// ── R4: ratchet ───────────────────────────────────────────────────────────
const kinds = Object.keys(table);
const counts = {
  total: kinds.length,
  neutral: kinds.filter((k) => table[k].verdict === "neutral").length,
  js: kinds.filter((k) => table[k].verdict === "js").length,
  unresolved: kinds.filter((k) => table[k].verdict === "unresolved").length,
  core: kinds.filter((k) => table[k].where === "core").length,
  dialect: kinds.filter((k) => table[k].where === "dialect").length,
  // Phase 2's remaining move list: judged ECMAScript, still declared in core.
  jsInCore: kinds.filter((k) => table[k].verdict === "js" && table[k].where === "core").length,
  residuals: kinds.filter((k) => table[k].residual).length,
};

const computed = {
  generated: new Date().toISOString().slice(0, 10),
  populationRule:
    "A kind is in scope iff it is the `readonly kind` discriminant of a top-level `export interface` " +
    "that is an arm of the `IrInstr` or `IrTerminator` union in src/ir/nodes.ts. Excluded: the " +
    "symbolic-reference types IrFuncRef/IrGlobalRef/IrTypeRef (kinds func/global/type) and every " +
    "inline union member of a payload type. See scripts/check-ir-kind-neutrality.mjs.",
  ratchet: { unresolved: counts.unresolved, jsInCore: counts.jsInCore },
  counts,
  kinds: table,
};

let baseline = null;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  baseline = null;
}

const write = (reason) => {
  writeFileSync(BASELINE, `${JSON.stringify(computed, null, 2)}\n`);
  console.log(`IR kind-neutrality gate: wrote ${BASELINE} (${reason}).`);
};

if (update) {
  write("--update");
  process.exit(0);
}

if (!baseline) {
  fail(`${BASELINE} is missing or unreadable. Create it with \`pnpm run check:ir-kind-neutrality -- --update\`.`);
  die();
}

const grew = [];
for (const key of ["unresolved", "jsInCore"]) {
  const before = baseline.ratchet?.[key];
  if (typeof before !== "number") {
    fail(`${BASELINE}: missing ratchet counter \`${key}\`. Refresh it with --update.`);
    continue;
  }
  if (computed.ratchet[key] > before) grew.push({ key, before, after: computed.ratchet[key] });
}
if (failures.length > 0) die();

if (grew.length > 0) {
  for (const g of grew) {
    const which =
      g.key === "unresolved"
        ? kinds.filter((k) => table[k].verdict === "unresolved" && baseline.kinds?.[k]?.verdict !== "unresolved")
        : kinds.filter(
            (k) =>
              table[k].verdict === "js" &&
              table[k].where === "core" &&
              !(baseline.kinds?.[k]?.verdict === "js" && baseline.kinds?.[k]?.where === "core"),
          );
    fail(
      `ratchet \`${g.key}\` grew ${g.before} -> ${g.after}` +
        (which.length > 0 ? ` (new: ${which.join(", ")})` : "") +
        (g.key === "unresolved"
          ? ". An unresolved kind is honest, but the set is meant to shrink toward zero — it is #3954 " +
            "phase 2's agenda, not a parking lot."
          : ". A kind judged ECMAScript belongs in src/ir/dialect/js.ts. If you are adding one, declare " +
            "it there; the dialect's own header says so."),
    );
  }
  die();
}

const sameTable =
  JSON.stringify({ ratchet: computed.ratchet, counts, kinds: table }) ===
  JSON.stringify({ ratchet: baseline.ratchet, counts: baseline.counts, kinds: baseline.kinds });

if (!sameTable) {
  if (updateOnDecrease) {
    write("--update-on-decrease: nothing grew");
  } else {
    fail(
      `the verdict table no longer matches ${BASELINE} (nothing grew, so this is an improvement or a ` +
        "re-classification). Re-run with `-- --update-on-decrease` and commit the baseline diff so the " +
        "change is reviewed alongside the reasoning.",
    );
    die();
  }
}

// ── report ────────────────────────────────────────────────────────────────
if (asJson) {
  console.log(JSON.stringify(computed, null, 2));
  process.exit(0);
}

console.log(
  `IR kind-neutrality gate: OK — ${counts.total} instruction kinds ` +
    `(${instrArms.length} IrInstr arms + ${termArms.length} terminators; ${excluded.length} symbolic-reference ` +
    `kinds excluded, ${grepCount} \`readonly kind:\` fields reconciled).`,
);
console.log(
  `  verdicts: ${counts.neutral} neutral · ${counts.js} js · ${counts.unresolved} unresolved` +
    `   |   placement: ${counts.core} in core, ${counts.dialect} in dialect`,
);
console.log(
  `  phase 2 move list (js, still in core): ${counts.jsInCore || "none"}` +
    (counts.jsInCore
      ? ` — ${kinds.filter((k) => table[k].verdict === "js" && table[k].where === "core").join(", ")}`
      : ""),
);
if (counts.unresolved > 0) {
  console.log(`  unresolved (${counts.unresolved}):`);
  for (const k of kinds.filter((x) => table[x].verdict === "unresolved")) {
    console.log(`    ${k} — ${table[k].settledBy.split(". ")[0].replace(/\.$/, "")}.`);
  }
}
if (counts.residuals > 0) {
  console.log(
    `  residuals (${counts.residuals}, reported not gated — other seams own these): ` +
      kinds.filter((k) => table[k].residual).join(", "),
  );
}

if (verbose) {
  console.log("");
  for (const verdict of ["js", "unresolved", "neutral"]) {
    console.log(`── ${verdict} ──────────────────────────────────────────────`);
    for (const k of kinds.filter((x) => table[x].verdict === verdict)) {
      const t = table[k];
      console.log(`  ${k}  [${t.where}]  ${t.declaredAt}`);
      console.log(`      ${t.why}`);
      console.log(`      evidence: ${t.evidence.join(" · ")}`);
      if (t.settledBy) console.log(`      settled by: ${t.settledBy}`);
      if (t.residual) console.log(`      residual: ${t.residual}`);
    }
  }
}
