// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachInstrDeep, type IrFunction, type IrInstr } from "./nodes.js";
import {
  IR_STRING_COMPARE_FN,
  JSSTR_CHARCODEAT_FN,
  NATIVE_CHARCODEAT_FN,
  FUNCTION_PROTOTYPE_CALL_HELPER,
} from "./runtime-symbols.js";
import { IR_ASYNC_STRING_CONCAT_5_FN } from "./async-semantic-runtime.js";
import { parseIrStringConcatManyArity } from "./string-runtime.js";
import { irGeneratorNumberBoxDemand } from "./generator-support.js";
import { hasLoneSurrogate } from "../string-surrogate.js";

/**
 * (#3526 F2-S1) True when any of `fns` performs a string relational compare.
 *
 * The seam carries no `intrinsic` instruction — from-ast emits a plain `call`
 * through the `IR_STRING_COMPARE_FN` sentinel func-ref — so the demand is read
 * off the call population directly, the way `irGeneratorNumberBoxDemand` reads
 * the `gen.setReturn` one. The same predicate answers the freeze request and
 * the owner-local partition below, so the two can never disagree.
 */
export function irStringCompareDemand(fns: readonly IrFunction[]): boolean {
  for (const fn of fns) {
    let found = false;
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (found || instr.kind !== "call") return;
          const { binding } = instr.target;
          if (binding.kind === "intrinsic" && binding.symbol === IR_STRING_COMPARE_FN) found = true;
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
    if (found) return true;
  }
  return false;
}

/**
 * (#3526 F2-S3) True when any of `fns` compares two strings for equality.
 *
 * Simpler than `irStringCompareDemand`: `string.eq` IS an instruction kind, so
 * the scan is a plain kind test rather than a walk of the `call` population.
 * The same predicate answers the freeze request and the owner-local partition
 * below, so the two can never disagree.
 */
export function irStringEqDemand(fns: readonly IrFunction[]): boolean {
  for (const fn of fns) {
    let found = false;
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "string.eq") found = true;
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
    if (found) return true;
  }
  return false;
}

/**
 * (#3526 F2-S4) True when any of `fns` reads a string's `.length`.
 *
 * A plain `string.len` instruction-kind scan, the twin of `irStringEqDemand`.
 * The same predicate answers the freeze request and the owner-local partition
 * below, so the two can never disagree — and it is deliberately the same
 * enumeration `prepareStrings`'s `usesStringLen` scan performs, so the freeze
 * cannot request a row for a demand the attachment pass will not find.
 */
export function irStringLenDemand(fns: readonly IrFunction[]): boolean {
  for (const fn of fns) {
    let found = false;
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "string.len") found = true;
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
    if (found) return true;
  }
  return false;
}

/**
 * (#3526 F2-S5) Which concat MODES any of `fns` performs.
 *
 * A `string.concat` instruction-kind scan like `irStringLenDemand`, but it
 * returns a PAIR: the seam has two feature rows and the producer maps
 * `concatMode` onto one of two callable symbols
 * (`src/ir/string-support.ts`'s `irStringCallableProviderRef`), so this mirrors
 * that mapping exactly — `instr.concatMode ?? "immutable"`. A module with no
 * builder loop then freezes no `owned-append` row at all.
 *
 * The same predicate answers the freeze request and the owner-local partition
 * below, so the two can never disagree.
 */
export function irStringConcatDemand(fns: readonly IrFunction[]): {
  readonly immutable: boolean;
  readonly owned: boolean;
} {
  let immutable = false;
  let owned = false;
  for (const fn of fns) {
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind !== "string.concat") return;
          if ((instr.concatMode ?? "immutable") === "owned-append") owned = true;
          else immutable = true;
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  }
  return { immutable, owned };
}

/**
 * (#3526 F3-S1) Which host callback MAKER arms any of `fns` crosses.
 *
 * Read off `closure.new`, which is the ONLY lane-free place both arms are
 * visible: `hostOneShot` is set exclusively by `lowerHostVoidCallbackExpression`
 * for a certified void callback that is NOT `standaloneDomReusable`, and
 * `domCallbackAuthority` exclusively for one that is. The maker `call` itself
 * cannot serve as the demand, because on the exact standalone-DOM lane there is
 * no call to find — the packed closure goes straight to the DOM import — and a
 * demand only the host arm can produce would leave the dispatcher lane with no
 * frozen row for the manifest to admit it by.
 *
 * The same predicate answers the freeze request and the owner-local partition
 * below, so the two can never disagree.
 */
export function irHostCallbackWrapDemand(fns: readonly IrFunction[]): {
  readonly host: boolean;
  readonly nativeDispatch: boolean;
} {
  let host = false;
  let nativeDispatch = false;
  for (const fn of fns) {
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind !== "closure.new") return;
          if (instr.hostOneShot === true) host = true;
          if (instr.domCallbackAuthority !== undefined) nativeDispatch = true;
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  }
  return { host, nativeDispatch };
}

/**
 * (#3526 F3-S3) Whether any of `fns` calls the `%Function.prototype%` helper.
 *
 * Exactly the enumeration the preregister scan below repeats, so a demand the
 * freeze requests can never be one the admission then refuses. The seam carries
 * no intrinsic instruction — from-ast emits a plain zero-arg `call` on the
 * runtime symbol — so this is read off `call`, the only place the use is
 * visible before the freeze.
 */
export function irFunctionPrototypeCallDemand(fns: readonly IrFunction[]): boolean {
  let used = false;
  for (const fn of fns) {
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind !== "call" || instr.target.binding.kind !== "runtime") return;
          if (instr.target.binding.symbol === FUNCTION_PROTOTYPE_CALL_HELPER) used = true;
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  }
  return used;
}

/**
 * (#3526 F2-S8) Which literal-storage namespaces any of `fns` needs.
 *
 * TWO producers, exactly the enumeration `prepareStrings`' own literal scan
 * performs: a `string.const` instruction, and an `extern.regex`, whose pattern
 * and flags lower through two `emitStringConst` calls and DO occupy
 * `string_constants` globals on the host lane. Counting the regex is what keeps
 * a regex-only module's frozen `hostCapabilityRecords` truthful about the
 * namespace it imports — even though its two literals still reach emission
 * through the no-storage fallback until that seam carries a `storage` of its
 * own (measured: 2 reaches, REGEX/gc-host, and 0 for `string.const` anywhere).
 *
 * `utf16` is the ONE derivation, `hasLoneSurrogate`, shared with the legacy
 * collector through `src/string-surrogate.ts`. It is a per-literal fact inside
 * the host arm, never an arm of its own — the pair says which feature ROWS the
 * module needs, not which authority answers them.
 */
export function irStringConstDemand(fns: readonly IrFunction[]): {
  readonly literal: boolean;
  readonly utf16: boolean;
} {
  let literal = false;
  let utf16 = false;
  const note = (value: string): void => {
    literal = true;
    utf16 ||= hasLoneSurrogate(value);
  };
  for (const fn of fns) {
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "string.const") note(instr.value);
          if (instr.kind === "extern.regex") {
            note(instr.pattern);
            note(instr.flags);
          }
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  }
  return { literal, utf16 };
}

/**
 * (#3526 F2-S7) True when any of `fns` performs a guarded `charCodeAt` read.
 *
 * TWO producers reach WasmGC codegen and BOTH are demand — this is the only
 * scan in the family that is not a single instruction kind:
 *
 *  * a `string.char_code_at` instruction, minted by `from-ast` only with
 *    receiver-encoding evidence; and
 *  * an `intrinsic` `call` whose symbol is the plan-path pair
 *    `__jsstr_charCodeAt` / `__str_charCodeAt` — the SAME enumeration the host
 *    pre-registration scan performs further down, minus the trusted symbol.
 *
 * The proof-licensed symbols (`__jsstr_charCodeAt_trusted`, and the
 * `__str_flatten` + `__str_flat_charCodeAt` preheader pair) are deliberately
 * NOT demand: they are a different, plan-time-decided feature this slice does
 * not govern, so a hoisted char-read loop freezes no row and its arms are
 * untouched.
 *
 * The same predicate answers the freeze request and the owner-local partition
 * below, so the two can never disagree.
 */
export function irStringCharCodeAtDemand(fns: readonly IrFunction[]): boolean {
  for (const fn of fns) {
    let found = false;
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "string.char_code_at") {
            found = true;
            return;
          }
          if (instr.kind !== "call" || instr.target.binding.kind !== "intrinsic") return;
          if (
            instr.target.binding.symbol === JSSTR_CHARCODEAT_FN ||
            instr.target.binding.symbol === NATIVE_CHARCODEAT_FN
          ) {
            found = true;
          }
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
    if (found) return true;
  }
  return false;
}

/**
 * (#3526 F2-S6) The sorted unique arities any of `fns` concatenates in one
 * batched call.
 *
 * Scanned AFTER the fusion pass, off the BATCHED IR, which is what makes it
 * different from its four siblings: there is no instruction kind to look for,
 * only the `call` targets the pass minted. Both producers are covered — the
 * `string.concat$arityN` family the pass emits, and the fixed
 * `async.string.concat$arity5` symbol async planning emits for the prepared
 * final main, which has its own arm with the identical lowering.
 *
 * A module with no fused root returns `[]` and freezes no family row.
 */
export function irStringConcatManyDemand(fns: readonly IrFunction[]): { readonly arities: readonly number[] } {
  const arities = new Set<number>();
  for (const fn of fns) {
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind !== "call" || instr.target.binding.kind !== "intrinsic") return;
          const symbol = instr.target.binding.symbol;
          if (symbol === IR_ASYNC_STRING_CONCAT_5_FN) {
            arities.add(5);
            return;
          }
          const arity = parseIrStringConcatManyArity(symbol);
          if (arity !== null) arities.add(arity);
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  }
  return { arities: Object.freeze([...arities].sort((left, right) => left - right)) };
}

export function irProgramRuntimeDemands(fn: IrFunction) {
  const functions = [fn];
  return {
    generatorNumberBoxDemand: irGeneratorNumberBoxDemand(functions),
    stringCompareDemand: irStringCompareDemand(functions),
    stringEqDemand: irStringEqDemand(functions),
    stringLenDemand: irStringLenDemand(functions),
    stringConcatDemand: irStringConcatDemand(functions),
    stringCharCodeAtDemand: irStringCharCodeAtDemand(functions),
    stringConcatManyDemand: irStringConcatManyDemand(functions),
    stringConstDemand: irStringConstDemand(functions),
    hostCallbackWrapDemand: irHostCallbackWrapDemand(functions),
    functionPrototypeCallDemand: irFunctionPrototypeCallDemand(functions),
  };
}
