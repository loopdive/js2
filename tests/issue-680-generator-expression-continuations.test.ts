// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #680 expression continuations — bounded native-generator state-machine slice.
 *
 * These fixtures deliberately stay in statement position. They pin the small
 * grammar admitted by the native planner and make every adjacent expression
 * shape fail closed in standalone mode rather than accidentally replaying work
 * after a suspension.
 *
 * `Generator<TYield, TReturn, TNext>` describes a bare `yield` as producing
 * `undefined`; fixtures with one therefore include `undefined` in `TYield`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function watFunctionBody(wat: string, name: string): string {
  const matches = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].filter((match) => match[1] === name);
  expect(matches, `unique WAT function $${name}`).toHaveLength(1);
  return watBalancedExpression(wat, matches[0]!.index!);
}

/** Resolve a numeric global index through imports and definitions, as in #4577. */
function watGlobalIndex(wat: string, name: string): number | undefined {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(global(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(global \$([^\s(]+)/gm)].map((match) => match[1]!);
  const index = [...imports, ...definitions].indexOf(name);
  return index < 0 ? undefined : index;
}

function watBalancedExpression(wat: string, start: number): string {
  let depth = 0;
  for (let index = start; index < wat.length; index++) {
    if (wat[index] === "(") depth++;
    if (wat[index] === ")" && --depth === 0) return wat.slice(start, index + 1);
  }
  throw new Error("unterminated WAT expression");
}

type WatEmittedTypeDefinition = {
  name: string;
  expression: string;
  order: number;
};

function watAppendTypeDefinition(definitions: WatEmittedTypeDefinition[], expression: string): void {
  const match = /^\(type \$([^\s()]+)/.exec(expression);
  if (match === null) throw new Error("unnamed emitted WAT type definition");
  definitions.push({ name: match[1]!, expression, order: definitions.length });
}

/**
 * Read the emitter's leading type table as balanced expressions, including
 * direct entries nested in `(rec ...)`, rather than assuming source-line
 * positions are Wasm type indices.
 */
function watEmittedTypeDefinitions(wat: string): WatEmittedTypeDefinition[] {
  const moduleStart = wat.indexOf("(module");
  expect(moduleStart, "WAT module").toBeGreaterThanOrEqual(0);
  const definitions: WatEmittedTypeDefinition[] = [];
  let offset = moduleStart + "(module".length;

  while (offset < wat.length) {
    while (offset < wat.length && /\s/.test(wat[offset]!)) offset++;
    if (offset >= wat.length || wat[offset] === ")") break;
    if (wat[offset] !== "(") throw new Error("unrecognised top-level WAT type-table entry");
    const expression = watBalancedExpression(wat, offset);
    if (expression.startsWith("(type ")) {
      watAppendTypeDefinition(definitions, expression);
    } else if (expression.startsWith("(rec")) {
      let recordOffset = "(rec".length;
      while (recordOffset < expression.length - 1) {
        while (recordOffset < expression.length - 1 && /\s/.test(expression[recordOffset]!)) {
          recordOffset++;
        }
        if (recordOffset >= expression.length - 1 || expression[recordOffset] === ")") break;
        if (expression[recordOffset] !== "(") throw new Error("unrecognised WAT rec type entry");
        const recordType = watBalancedExpression(expression, recordOffset);
        watAppendTypeDefinition(definitions, recordType);
        recordOffset += recordType.length;
      }
    } else {
      // `emitWat` writes all type definitions before imports, globals, and
      // functions. Stop at the first later module item so its strings cannot
      // be mistaken for type syntax.
      break;
    }
    offset += expression.length;
  }

  return definitions;
}

/** The emitter names explicit numeric type anchors `$typeN`; Binaryen may use `$N`. */
function watNumericTypeAnchor(name: string): number | undefined {
  const match = /^(?:type)?(\d+)$/.exec(name);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Recover a named type's numeric Wasm index from the complete emitted order.
 * Both adjacent numeric anchors must prove that no omitted inlineable type can
 * shift the target; otherwise the proof fails closed.
 */
function watNamedTypeIndex(wat: string, name: string): { index: number; expression: string } {
  const definitions = watEmittedTypeDefinitions(wat);
  const targets = definitions.filter((definition) => definition.name === name);
  expect(targets, `one named WAT type $${name}`).toHaveLength(1);
  const target = targets[0]!;
  const anchors = definitions.flatMap((definition) => {
    const index = watNumericTypeAnchor(definition.name);
    return index === undefined ? [] : [{ ...definition, index }];
  });

  for (let index = 1; index < anchors.length; index++) {
    const previous = anchors[index - 1]!;
    const current = anchors[index]!;
    if (current.index <= previous.index) {
      throw new Error("emitted WAT numeric type anchors are not unique and ordered");
    }
  }

  const before = anchors.filter((anchor) => anchor.order < target.order).at(-1);
  const after = anchors.find((anchor) => anchor.order > target.order);
  if (before === undefined || after === undefined) {
    throw new Error(`cannot resolve named WAT type $${name} without surrounding numeric anchors`);
  }
  if (after.index - before.index !== after.order - before.order) {
    throw new Error(`numeric WAT type anchors around $${name} leave an unresolved index gap`);
  }

  return { index: before.index + target.order - before.order, expression: target.expression };
}

/** Bind the allowed f64 carrier to this module's own native number boxer. */
function watNativeNumberWrapperType(wat: string): string {
  const nativeBox = watFunctionBody(wat, "__box_number");
  const structNews = [...nativeBox.matchAll(/\bstruct\.new (\d+)\b/g)].map((match) => match[1]!);
  expect(structNews, "one native number-wrapper allocation in $__box_number").toHaveLength(1);
  const wrapperType = structNews[0]!;

  const wrapper = watNamedTypeIndex(wat, "__box_number_struct");
  expect(wrapperType, "native number boxer allocates its resolved wrapper type").toBe(String(wrapper.index));
  expect(wrapper.expression.replace(/\s+/g, " ").trim(), "native number-wrapper is one immutable f64 field").toBe(
    "(type $__box_number_struct (struct (field $value f64)))",
  );
  expect(nativeBox, "native number-wrapper is converted directly to externref").toMatch(
    new RegExp(`\\blocal\\.get 0\\s+struct\\.new ${wrapperType}\\s+extern\\.convert_any\\b`),
  );
  return wrapperType;
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

/** Return an immediate WAT `then` or `else` arm, never one nested inside it. */
function watDirectIfArm(expression: string, arm: "then" | "else"): string | undefined {
  let depth = 0;
  for (let index = 0; index < expression.length; index++) {
    if (expression[index] === "(") {
      const afterName = expression[index + arm.length + 1];
      if (
        depth === 1 &&
        expression.startsWith(`(${arm}`, index) &&
        (afterName === undefined || /[\s)]/.test(afterName))
      ) {
        return watBalancedExpression(expression, index);
      }
      depth++;
    } else if (expression[index] === ")") {
      depth--;
    }
  }
  return undefined;
}

type WatDispatchStateArm = {
  stateType: string;
  state: number;
  start: number;
  body: string;
};

/** Recover direct trampoline state arms so a spill proof cannot cross state boundaries. */
function watDispatchStateArms(body: string): WatDispatchStateArm[] {
  const predicates = [
    ...body.matchAll(/\blocal\.get 0\s+struct\.get (\d+) 0\s+i32\.const (\d+)\s+i32\.eq\s+(\(if\b)/g),
  ];
  return predicates.map((predicate) => {
    if (predicate.index === undefined) throw new Error("state predicate has no WAT position");
    const ifStart = predicate.index + predicate[0].lastIndexOf("(if");
    const thenArm = watDirectIfArm(watBalancedExpression(body, ifStart), "then");
    if (thenArm === undefined) throw new Error("state predicate has no direct then arm");
    const start = body.indexOf(thenArm, ifStart);
    if (start < 0) throw new Error("state then arm has no WAT position");
    return { stateType: predicate[1]!, state: Number(predicate[2]), start, body: thenArm };
  });
}

/** Split only a bounded linear WAT segment; nested expressions remain one instruction. */
function watTopLevelInstructions(value: string): string[] {
  const instructions: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    while (offset < value.length && /\s/.test(value[offset]!)) offset++;
    if (offset === value.length) break;
    if (value[offset] === "(") {
      const expression = watBalancedExpression(value, offset);
      instructions.push(expression);
      offset += expression.length;
      continue;
    }
    const lineEnd = value.indexOf("\n", offset);
    const end = lineEnd < 0 ? value.length : lineEnd;
    const instruction = value.slice(offset, end).trim();
    if (instruction) instructions.push(instruction);
    offset = lineEnd < 0 ? value.length : lineEnd + 1;
  }
  return instructions;
}

function watInstructionHead(instruction: string): string {
  const head = /^\(?([a-z0-9_.]+)/.exec(instruction.trim())?.[1];
  if (head === undefined) throw new Error(`unrecognised WAT instruction: ${instruction}`);
  return head;
}

type WatInlineToken = {
  value: string;
  index: number;
};

type WatInlineInstruction =
  | {
      kind: "flat";
      opcode: string;
      immediate?: string;
      index: number;
    }
  | {
      kind: "if";
      result: string;
      thenBranch: readonly WatInlineInstruction[];
      elseBranch: readonly WatInlineInstruction[];
      index: number;
    }
  | {
      kind: "block";
      result: string;
      body: readonly WatInlineInstruction[];
      index: number;
    };

type WatNumberBoxValue =
  | "sent-f64"
  | "sent-i32"
  | "sent-f64-roundtrip"
  | "sent-sign-bits"
  | "i32-zero"
  | "i32-one"
  | "i64-zero"
  | "integral"
  | "sent-i32-shifted"
  | "sent-i32-31bit-roundtrip"
  | "fits-i31"
  | "integral-fits-i31"
  | "nonzero-i31"
  | "negative-sign-bit"
  | "not-negative-zero"
  | "i31-condition"
  | "i31-reference"
  | "number-wrapper-reference"
  | "externref";

const watNumberBoxImmediateOpcodes = new Set([
  "local.get",
  "local.set",
  "local.tee",
  "i32.const",
  "i64.const",
  "f64.const",
  "struct.new",
]);
const watNumberBoxPlainOpcodes = new Set([
  "i32.trunc_sat_f64_s",
  "f64.convert_i32_s",
  "i64.reinterpret_f64",
  "i32.eqz",
  "f64.eq",
  "i32.shl",
  "i32.shr_s",
  "i32.eq",
  "i32.and",
  "i32.ne",
  "i32.or",
  "i64.lt_s",
  "ref.i31",
  "extern.convert_any",
]);

function watInlineTokens(value: string): WatInlineToken[] {
  const tokens: WatInlineToken[] = [];
  for (let index = 0; index < value.length; ) {
    const character = value[index]!;
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === "(" || character === ")") {
      tokens.push({ value: character, index });
      index++;
      continue;
    }
    const start = index;
    while (index < value.length && !/\s/.test(value[index]!) && value[index] !== "(" && value[index] !== ")") {
      index++;
    }
    tokens.push({ value: value.slice(start, index), index: start });
  }
  return tokens;
}

function watNumberBoxFailure(token: WatInlineToken | undefined, message: string): never {
  const location = token === undefined ? "end of expression" : "offset " + token.index;
  throw new Error(message + " at " + location);
}

function watInlineResult(tokens: readonly WatInlineToken[], index: number): [string, number] {
  if (tokens[index]?.value !== "(" || tokens[index + 1]?.value !== "result") {
    return watNumberBoxFailure(tokens[index], "missing number-box externref result annotation");
  }
  const result = tokens[index + 2];
  if (result?.value !== "externref" || tokens[index + 3]?.value !== ")") {
    return watNumberBoxFailure(result, "number-box result must be externref");
  }
  return [result.value, index + 4];
}

function watInlineSequence(
  tokens: readonly WatInlineToken[],
  index: number,
): [readonly WatInlineInstruction[], number] {
  const instructions: WatInlineInstruction[] = [];
  while (index < tokens.length && tokens[index]!.value !== ")") {
    const token = tokens[index]!;
    if (token.value === "(") {
      const [instruction, next] = watInlineFoldedInstruction(tokens, index);
      instructions.push(instruction);
      index = next;
      continue;
    }
    const [instruction, next] = watInlineFlatInstruction(tokens, index);
    instructions.push(instruction);
    index = next;
  }
  if (tokens[index]?.value !== ")") {
    return watNumberBoxFailure(tokens[index], "unterminated number-box WAT expression");
  }
  return [instructions, index + 1];
}

function watInlineArm(
  tokens: readonly WatInlineToken[],
  index: number,
  name: "then" | "else",
): [readonly WatInlineInstruction[], number] {
  if (tokens[index]?.value !== "(" || tokens[index + 1]?.value !== name) {
    return watNumberBoxFailure(tokens[index], "missing direct number-box " + name + " arm");
  }
  return watInlineSequence(tokens, index + 2);
}

function watInlineFoldedInstruction(tokens: readonly WatInlineToken[], index: number): [WatInlineInstruction, number] {
  const opening = tokens[index];
  const head = tokens[index + 1];
  if (opening?.value !== "(" || head === undefined) {
    return watNumberBoxFailure(opening, "malformed folded number-box WAT instruction");
  }
  if (head.value === "if") {
    let next = index + 2;
    const [result, afterResult] = watInlineResult(tokens, next);
    next = afterResult;
    const [thenBranch, afterThen] = watInlineArm(tokens, next, "then");
    next = afterThen;
    const [elseBranch, afterElse] = watInlineArm(tokens, next, "else");
    next = afterElse;
    if (tokens[next]?.value !== ")") {
      return watNumberBoxFailure(tokens[next], "number-box if has trailing or missing arm content");
    }
    return [{ kind: "if", result, thenBranch, elseBranch, index: opening.index }, next + 1];
  }
  if (head.value === "block") {
    const [result, next] = watInlineResult(tokens, index + 2);
    const [body, afterBody] = watInlineSequence(tokens, next);
    return [{ kind: "block", result, body, index: opening.index }, afterBody];
  }
  return watNumberBoxFailure(head, "unmodelled number-box WAT opcode: " + head.value);
}

function watInlineFlatInstruction(tokens: readonly WatInlineToken[], index: number): [WatInlineInstruction, number] {
  const token = tokens[index];
  if (token === undefined || token.value === "(" || token.value === ")") {
    return watNumberBoxFailure(token, "malformed flat number-box WAT instruction");
  }
  if (watNumberBoxPlainOpcodes.has(token.value)) {
    return [{ kind: "flat", opcode: token.value, index: token.index }, index + 1];
  }
  if (watNumberBoxImmediateOpcodes.has(token.value)) {
    const immediate = tokens[index + 1];
    if (immediate === undefined || immediate.value === "(" || immediate.value === ")") {
      return watNumberBoxFailure(immediate, "missing number-box WAT immediate for " + token.value);
    }
    return [{ kind: "flat", opcode: token.value, immediate: immediate.value, index: token.index }, index + 2];
  }
  return watNumberBoxFailure(token, "unmodelled number-box WAT opcode: " + token.value);
}

function watInlineNumberBoxExpression(value: string): WatInlineInstruction {
  const tokens = watInlineTokens(value);
  const [instruction, next] = watInlineFoldedInstruction(tokens, 0);
  if (next !== tokens.length) {
    return watNumberBoxFailure(tokens[next], "trailing number-box WAT token");
  }
  return instruction;
}

function watNumberBoxPop(stack: WatNumberBoxValue[], label: string): WatNumberBoxValue {
  const value = stack.pop();
  if (value === undefined) throw new Error(label + " has no number-box WAT stack input");
  return value;
}

function watNumberBoxRequire(value: WatNumberBoxValue, expected: WatNumberBoxValue, label: string): void {
  if (value !== expected) throw new Error(`${label} consumed ${value}, expected ${expected}`);
}

function watNumberBoxBranchValue(
  branch: readonly WatInlineInstruction[],
  locals: ReadonlyMap<string, WatNumberBoxValue>,
  numericWrapperType: string,
): WatNumberBoxValue {
  const stack = watNumberBoxEvaluateSequence(branch, new Map(locals), numericWrapperType);
  if (stack.length !== 1 || stack[0] !== "externref") {
    throw new Error("number-box branch must return exactly one payload-preserving externref");
  }
  return stack[0]!;
}

/**
 * Symbolically execute only the native `__box_number` decision tree.
 *
 * The symbols deliberately distinguish the original f64 from its saturated
 * i32 conversion and from every eligibility predicate. A data dependency is
 * insufficient: `ref.i31` receives only that exact conversion and the struct
 * fallback receives only the untouched f64, so value-collapsing masks fail.
 */
function watNumberBoxEvaluateSequence(
  instructions: readonly WatInlineInstruction[],
  locals: Map<string, WatNumberBoxValue>,
  numericWrapperType: string,
): WatNumberBoxValue[] {
  const stack: WatNumberBoxValue[] = [];
  for (const [index, instruction] of instructions.entries()) {
    if (instruction.kind === "if") {
      if (instruction.result !== "externref") {
        throw new Error("nested number-box if must return externref");
      }
      watNumberBoxRequire(
        watNumberBoxPop(stack, "nested number-box if condition"),
        "i31-condition",
        "nested number-box if condition",
      );
      watNumberBoxBranchValue(instruction.thenBranch, locals, numericWrapperType);
      watNumberBoxBranchValue(instruction.elseBranch, locals, numericWrapperType);
      stack.push("externref");
      continue;
    }
    if (instruction.kind === "block") {
      if (instruction.result !== "externref" || stack.length !== 0) {
        throw new Error("number-box block must begin empty and return externref");
      }
      stack.push(watNumberBoxBranchValue(instruction.body, locals, numericWrapperType));
      continue;
    }

    const { opcode, immediate } = instruction;
    if (opcode === "local.get") {
      const value = locals.get(immediate!);
      if (value === undefined) throw new Error("number-box local.get " + immediate + " has no symbolic source");
      stack.push(value);
      continue;
    }
    if (opcode === "local.set") {
      const value = watNumberBoxPop(stack, "number-box local.set");
      watNumberBoxRequire(value, "sent-f64", "number-box local.set");
      locals.set(immediate!, value);
      continue;
    }
    if (opcode === "local.tee") {
      const value = stack[stack.length - 1];
      if (value === undefined) throw new Error("number-box local.tee has no stack input");
      if (value !== "sent-f64" && value !== "sent-i32") {
        throw new Error("number-box local.tee may preserve only the exact sent carrier or truncation");
      }
      locals.set(immediate!, value);
      continue;
    }
    if (opcode === "i32.const") {
      if (immediate === "0") stack.push("i32-zero");
      else if (immediate === "1") stack.push("i32-one");
      else throw new Error("number-box permits only i32.const 0 or 1");
      continue;
    }
    if (opcode === "i64.const") {
      if (immediate !== "0") throw new Error("number-box permits only i64.const 0");
      stack.push("i64-zero");
      continue;
    }
    if (opcode === "f64.const") {
      throw new Error("number-box does not admit f64 constants");
    }
    if (opcode === "i32.trunc_sat_f64_s") {
      watNumberBoxRequire(watNumberBoxPop(stack, opcode), "sent-f64", opcode);
      stack.push("sent-i32");
      continue;
    }
    if (opcode === "f64.convert_i32_s") {
      watNumberBoxRequire(watNumberBoxPop(stack, opcode), "sent-i32", opcode);
      stack.push("sent-f64-roundtrip");
      continue;
    }
    if (opcode === "i64.reinterpret_f64") {
      watNumberBoxRequire(watNumberBoxPop(stack, opcode), "sent-f64", opcode);
      stack.push("sent-sign-bits");
      continue;
    }
    if (opcode === "i32.eqz") {
      watNumberBoxRequire(watNumberBoxPop(stack, opcode), "negative-sign-bit", opcode);
      stack.push("not-negative-zero");
      continue;
    }
    if (opcode === "f64.eq") {
      const right = watNumberBoxPop(stack, opcode);
      const left = watNumberBoxPop(stack, opcode);
      if (left !== "sent-f64-roundtrip" || right !== "sent-f64") {
        throw new Error("f64.eq must be the exact sent integer round-trip check");
      }
      stack.push("integral");
      continue;
    }
    if (opcode === "i32.shl") {
      const right = watNumberBoxPop(stack, opcode);
      const left = watNumberBoxPop(stack, opcode);
      if (left !== "sent-i32" || right !== "i32-one") {
        throw new Error("i32.shl must be the native signed-31 range check");
      }
      stack.push("sent-i32-shifted");
      continue;
    }
    if (opcode === "i32.shr_s") {
      const right = watNumberBoxPop(stack, opcode);
      const left = watNumberBoxPop(stack, opcode);
      if (left !== "sent-i32-shifted" || right !== "i32-one") {
        throw new Error("i32.shr_s must complete the native signed-31 range check");
      }
      stack.push("sent-i32-31bit-roundtrip");
      continue;
    }
    if (opcode === "i32.eq") {
      const right = watNumberBoxPop(stack, opcode);
      const left = watNumberBoxPop(stack, opcode);
      if (left !== "sent-i32-31bit-roundtrip" || right !== "sent-i32") {
        throw new Error("i32.eq must compare the signed-31 round-trip to the exact truncation");
      }
      stack.push("fits-i31");
      continue;
    }
    if (opcode === "i32.ne") {
      const right = watNumberBoxPop(stack, opcode);
      const left = watNumberBoxPop(stack, opcode);
      if (left !== "sent-i32" || right !== "i32-zero") {
        throw new Error("i32.ne must be the native nonzero check for the exact truncation");
      }
      stack.push("nonzero-i31");
      continue;
    }
    if (opcode === "i64.lt_s") {
      const right = watNumberBoxPop(stack, opcode);
      const left = watNumberBoxPop(stack, opcode);
      if (left !== "sent-sign-bits" || right !== "i64-zero") {
        throw new Error("i64.lt_s must be the native negative-zero sign-bit check");
      }
      stack.push("negative-sign-bit");
      continue;
    }
    if (opcode === "i32.or") {
      const right = watNumberBoxPop(stack, opcode);
      const left = watNumberBoxPop(stack, opcode);
      if (left !== "nonzero-i31" || right !== "not-negative-zero") {
        throw new Error("i32.or must be the native nonzero-or-not-negative-zero check");
      }
      stack.push("not-negative-zero");
      continue;
    }
    if (opcode === "i32.and") {
      const right = watNumberBoxPop(stack, opcode);
      const left = watNumberBoxPop(stack, opcode);
      if (left === "integral" && right === "fits-i31") {
        stack.push("integral-fits-i31");
        continue;
      }
      if (left === "integral-fits-i31" && right === "not-negative-zero") {
        stack.push("i31-condition");
        continue;
      }
      throw new Error("i32.and must combine only native number-box predicates, never a payload");
    }
    if (opcode === "ref.i31") {
      watNumberBoxRequire(watNumberBoxPop(stack, "ref.i31"), "sent-i32", "ref.i31");
      stack.push("i31-reference");
      continue;
    }
    if (opcode === "struct.new") {
      const next = instructions[index + 1];
      const immediatelyConverts = next !== undefined && next.kind === "flat" && next.opcode === "extern.convert_any";
      if (immediate !== numericWrapperType || !immediatelyConverts) {
        throw new Error(
          `number-box struct carrier must use native wrapper type ${numericWrapperType} and convert directly`,
        );
      }
      watNumberBoxRequire(watNumberBoxPop(stack, "number-box struct carrier"), "sent-f64", "number-box struct carrier");
      stack.push("number-wrapper-reference");
      continue;
    }
    if (opcode === "extern.convert_any") {
      const value = watNumberBoxPop(stack, "extern.convert_any");
      if (value !== "i31-reference" && value !== "number-wrapper-reference") {
        throw new Error("extern.convert_any consumed a non-number-box reference");
      }
      stack.push("externref");
      continue;
    }
    throw new Error("unmodelled number-box WAT opcode: " + opcode);
  }
  return stack;
}

/** Parse one exact native number-box expression and prove its payload carriers. */
function expectInlineNumberBox(box: string, sentLocal: string, numericWrapperType: string): void {
  const expression = watInlineNumberBoxExpression(box);
  if (expression.kind !== "block" || expression.result !== "externref") {
    throw new Error("inline number box must be one externref block expression");
  }
  watNumberBoxBranchValue(
    expression.body,
    new Map<string, WatNumberBoxValue>([[sentLocal, "sent-f64"]]),
    numericWrapperType,
  );
}

/** Exercise a branch-only negative without widening the canonical control count. */
function expectInlineNumberBoxArms(
  box: string,
  locals: ReadonlyMap<string, WatNumberBoxValue>,
  numericWrapperType: string,
): void {
  const expression = watInlineNumberBoxExpression(box);
  if (expression.kind !== "if" || expression.result !== "externref") {
    throw new Error("inline number-box arms must be one externref if expression");
  }
  watNumberBoxBranchValue(expression.thenBranch, locals, numericWrapperType);
  watNumberBoxBranchValue(expression.elseBranch, locals, numericWrapperType);
}

/** Prove exact canonical/sent/null array operands and the native sent-number box payload. */
function expectCanonicalArrayOperandFlow(
  segment: string,
  captureLocal: string,
  sentLocal: string,
  numericWrapperType: string,
): void {
  const instructions = watTopLevelInstructions(segment);
  expect(instructions.length, "bounded rebuilt-array instruction count").toBeGreaterThanOrEqual(4);
  expect(instructions[0], "rebuilt array starts with the canonical capture").toBe(`local.get ${captureLocal}`);
  expect(instructions[1], "rebuilt array next reads the sent value").toBe(`local.get ${sentLocal}`);
  expect(instructions[instructions.length - 2], "rebuilt array third operand").toBe("ref.null extern");
  expect(instructions[instructions.length - 1], "rebuilt array constructor").toMatch(/^array\.new_fixed \d+ 3$/);
  const boxIndexes = instructions.flatMap((instruction, index) =>
    watInstructionHead(instruction) === "if" ? [index] : [],
  );
  expect(boxIndexes, "one native number-box expression before the array tail").toEqual([instructions.length - 3]);
  const numberBox = [
    "(block (result externref)",
    ...instructions.slice(1, -2).map((instruction) => `  ${instruction}`),
    ")",
  ].join("\n");
  expectInlineNumberBox(numberBox, sentLocal, numericWrapperType);
}

/** Prove the optimizer-inlined boolean box branch in one resumed generator body. */
function expectInlinedBooleanBoxBranch(body: string, trueIndex: number, falseIndex: number): void {
  const trueGet = new RegExp(`\\bglobal\\.get ${trueIndex}\\b`, "g");
  const falseGet = new RegExp(`\\bglobal\\.get ${falseIndex}\\b`, "g");
  expect(countMatches(body, trueGet), "one resumed true boolean carrier read").toBe(1);
  expect(countMatches(body, falseGet), "one resumed false boolean carrier read").toBe(1);

  const matchingBranches = [...body.matchAll(/\(if \(result externref\)/g)]
    .map((match) => watBalancedExpression(body, match.index!))
    .filter((branch) => {
      const thenArm = watDirectIfArm(branch, "then");
      const elseArm = watDirectIfArm(branch, "else");
      return (
        thenArm !== undefined &&
        elseArm !== undefined &&
        countMatches(thenArm, trueGet) === 1 &&
        countMatches(elseArm, falseGet) === 1 &&
        /\bextern\.convert_any\b/.test(thenArm) &&
        /\bextern\.convert_any\b/.test(elseArm)
      );
    });
  expect(matchingBranches, "one inlined boolean-box if with true/false carrier arms").toHaveLength(1);
}

/** Prove the canonical undefined value is the actual pre-yield spill, not an unrelated read. */
function expectCanonicalUndefinedContinuationSpill(
  body: string,
  undefinedIndex: number,
  numericWrapperType: string,
): void {
  const canonicalCapture = new RegExp(
    `\\bglobal\\.get ${undefinedIndex}\\b\\s+extern\\.convert_any\\s+local\\.set (\\d+)`,
    "g",
  );
  const captures = [...body.matchAll(canonicalCapture)];
  expect(captures, "one canonical undefined continuation capture").toHaveLength(1);
  const capture = captures[0]!;
  const captureLocal = capture[1]!;
  if (capture.index === undefined) throw new Error("canonical undefined capture has no WAT position");
  const captureIndex = capture.index;

  // The capture's state arm gives a real successor boundary. The successor has
  // an early abrupt-resume spill store, so a lexical cutoff at that store would
  // miss the normal rebuilt expression later in the same arm.
  const stateArms = watDispatchStateArms(body);
  const captureArms = stateArms.filter(
    (arm) => captureIndex >= arm.start && captureIndex < arm.start + arm.body.length,
  );
  expect(captureArms, "one dispatch state owns the canonical capture").toHaveLength(1);
  const captureArm = captureArms[0]!;
  const captureOffset = captureIndex - captureArm.start;
  const spillStores = [
    ...captureArm.body.matchAll(
      new RegExp(`\\blocal\\.get 0\\s+local\\.get ${captureLocal}\\s+struct\\.set (\\d+) (\\d+)`, "g"),
    ),
  ].filter((store) => store.index !== undefined && store.index > captureOffset);
  expect(spillStores, "one canonical capture spill before suspension").toHaveLength(1);
  const spillStore = spillStores[0]!;
  const stateType = spillStore[1]!;
  const spillField = spillStore[2]!;

  const stateTransitions = [
    ...captureArm.body.matchAll(
      new RegExp(`\\blocal\\.get 0\\s+i32\\.const (\\d+)\\s+struct\\.set ${stateType} 0\\b`, "g"),
    ),
  ].filter((transition) => transition.index !== undefined && transition.index > spillStore.index!);
  expect(stateTransitions, "one post-spill transition to the successor state").toHaveLength(1);
  const successorState = Number(stateTransitions[0]![1]);
  const successorArms = stateArms.filter((arm) => arm.stateType === stateType && arm.state === successorState);
  expect(successorArms, "one exact successor dispatch state").toHaveLength(1);
  const successorArm = successorArms[0]!;

  const reloads = [
    ...body.matchAll(
      new RegExp(`\\blocal\\.get 0\\s+struct\\.get ${stateType} ${spillField}\\s+local\\.set ${captureLocal}\\b`, "g"),
    ),
  ];
  expect(reloads, "one same-field reload into the canonical capture local").toHaveLength(1);
  expect(reloads[0]!.index!, "spill reload occurs in the resume prologue before dispatch").toBeLessThan(
    Math.min(...stateArms.map((arm) => arm.start)),
  );

  // This fixture's only non-store read of the capture local must be the first
  // input to its rebuilt three-element array, inside that exact successor arm.
  const rebuiltReads = [
    ...successorArm.body.matchAll(new RegExp(`\\blocal\\.get ${captureLocal}\\b(?!\\s+struct\\.set\\b)`, "g")),
  ];
  expect(rebuiltReads, "one non-store canonical capture read in the exact successor state").toHaveLength(1);
  const rebuiltArrays = [...successorArm.body.matchAll(/\barray\.new_fixed \d+ 3\b/g)];
  expect(rebuiltArrays, "one rebuilt three-element array in the exact successor state").toHaveLength(1);
  const rebuiltRead = rebuiltReads[0]!;
  const rebuiltArray = rebuiltArrays[0]!;
  expect(rebuiltRead.index!, "canonical capture feeds the rebuilt array before allocation").toBeLessThan(
    rebuiltArray.index!,
  );

  // Keep this direct-order diagnostic readable, but do not treat it as operand
  // flow evidence: the complete bounded stack/provenance proof follows below.
  const rebuiltPrefix = successorArm.body.slice(rebuiltRead.index!, rebuiltArray.index!);
  const firstAndSecondOperands = new RegExp(`^\\blocal\\.get ${captureLocal}\\b\\s+local\\.get (\\d+)\\b`).exec(
    rebuiltPrefix,
  );
  expect(firstAndSecondOperands, "canonical capture is the direct first rebuilt array operand").not.toBeNull();
  const sentLocal = firstAndSecondOperands![1]!;
  expect(sentLocal, "sent operand is distinct from the canonical capture").not.toBe(captureLocal);
  const canonicalOperand = firstAndSecondOperands![0]!.slice(
    0,
    firstAndSecondOperands![0]!.lastIndexOf(`local.get ${sentLocal}`),
  );
  expect(canonicalOperand, "direct-order diagnostic has no canonical numeric conversion").not.toMatch(
    /\bf64\.convert_i32_[su]\b/,
  );

  const sentReloads = [
    ...successorArm.body.matchAll(
      new RegExp(`\\blocal\\.get 0\\s+struct\\.get ${stateType} 1\\s+local\\.set (\\d+)\\b`, "g"),
    ),
  ];
  expect(sentReloads, "one sent-field reload in the exact successor state").toHaveLength(1);
  const sentFieldLocal = sentReloads[0]![1]!;
  expect(sentFieldLocal, "array sent operand is the exact successor sent-field reload").toBe(sentLocal);
  const rebuiltSegment = successorArm.body.slice(rebuiltRead.index!, rebuiltArray.index! + rebuiltArray[0]!.length);
  expectCanonicalArrayOperandFlow(rebuiltSegment, captureLocal, sentFieldLocal, numericWrapperType);
}

/** The conditional fixture has one f64 condition; its two arms set distinct successor states. */
function watCanonicalF64BranchTargets(body: string): number[] {
  const condition = /f64\.abs\s+f64\.const 0\s+f64\.gt\s+(\(if\b)/.exec(body);
  expect(condition, "canonical f64 ToBoolean followed by a branch").not.toBeNull();
  const ifStart = condition!.index! + condition![0].lastIndexOf("(if");
  const branchBody = watBalancedExpression(body, ifStart);
  return [...branchBody.matchAll(/local\.get 0\s+i32\.const (\d+)\s+struct\.set \d+ 0\s+br \d+/g)].map((match) =>
    Number(match[1]),
  );
}

async function compileStandalone(source: string) {
  const result = await compile(source, {
    fileName: "issue-680-generator-expression-continuations.ts",
    target: "standalone",
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "standalone output must validate").toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  return result;
}

async function compileDefault(source: string) {
  const result = await compile(source, {
    fileName: "issue-680-generator-expression-continuations-host.ts",
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "default-target output must validate").toBe(true);
  return result;
}

async function runStandalone(source: string): Promise<number> {
  const result = await compileStandalone(source);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

async function expectStandaloneRefusal(source: string): Promise<void> {
  const result = await compile(source, {
    fileName: "issue-680-generator-expression-continuation-refusal.ts",
    target: "standalone",
  });
  expect(result.success, `expected standalone refusal for:\n${source}`).toBe(false);
  expect(result.errors.length, "standalone refusal reports a diagnostic").toBeGreaterThan(0);
}

describe("#680 native generator expression continuations", () => {
  it("admits a parenthesized bare yield in an object-literal generator method", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const holder = {
            *run(): Generator<number | undefined, number, unknown> {
              ((yield));
              return 19;
            },
          };
          const iterator = holder.run();
          const first = iterator.next();
          const done = iterator.next(7);
          return (first.done ? 100 : 0) + (done.done ? 10 : 0) + (done.value as number);
        }
      `),
    ).toBe(29);
  });

  it("evaluates the state prelude before an array-continuation capture", async () => {
    expect(
      await runStandalone(`
        function* g(): Generator<number | undefined, number, unknown> {
          let i = 10;
          [i++, yield];
          return i;
        }
        export function test(): number {
          const iterator = g();
          const first = iterator.next();
          const done = iterator.next(0);
          return (first.done ? 100 : 0) + (done.done ? 0 : 1_000) + (done.value as number);
        }
      `),
    ).toBe(11);
  });

  it("keeps consecutive array-continuation states resumable", async () => {
    expect(
      await runStandalone(`
        function* g(): Generator<number | undefined, number, unknown> {
          let i = 0;
          [i++, yield];
          [i++, yield];
          return i;
        }
        export function test(): number {
          const iterator = g();
          const first = iterator.next();
          const second = iterator.next(0);
          const done = iterator.next(0);
          return (first.done ? 100 : 0) + (second.done ? 10 : 0) + (done.done ? 1 : 0) + (done.value as number);
        }
      `),
    ).toBe(3);
  });

  it("captures object-data-property operands once before yielding", async () => {
    expect(
      await runStandalone(`
        function* g(): Generator<number | undefined, number, unknown> {
          let i = 0;
          ({ before: i++, sent: yield });
          return i;
        }
        export function test(): number {
          const iterator = g();
          const first = iterator.next();
          const done = iterator.next(0);
          return (first.done ? 100 : 0) + (done.done ? 10 : 0) + (done.value as number);
        }
      `),
    ).toBe(11);
  });

  it("does not replay the exact comma-prefix effect after resume", async () => {
    expect(
      await runStandalone(`
        function* g(): Generator<number | undefined, number, unknown> {
          let i = 0;
          ((i++), yield);
          return i;
        }
        export function test(): number {
          const iterator = g();
          const first = iterator.next();
          const done = iterator.next(0);
          return (first.done ? 100 : 0) + (done.done ? 10 : 0) + (done.value as number);
        }
      `),
    ).toBe(11);
  });

  it("routes a raw boolean capture through normal array-element boxing", async () => {
    const result = await compileStandalone(`
      function* g(): Generator<number | undefined, number, unknown> {
        [true, yield, null];
        return 7;
      }
      export function test(): number {
        const iterator = g();
        const first = iterator.next();
        const done = iterator.next(0);
        return (first.done ? 100 : 0) + (done.done ? 10 : 0) + (done.value as number);
      }
    `);
    // A later `null` forces this array's ordinary externref-element path, while
    // the pre-yield `true` capture remains a raw boolean i32. wasm-opt inlines
    // __box_boolean, so resolve the interned carrier globals and prove their
    // exact branch inside THIS generator's resume body.
    const resume = watFunctionBody(result.wat, "__gen_resume_g");
    const trueIndex = watGlobalIndex(result.wat, "__box_boolean_true");
    const falseIndex = watGlobalIndex(result.wat, "__box_boolean_false");
    if (trueIndex === undefined || falseIndex === undefined) {
      throw new Error("missing interned boolean carrier globals");
    }
    expect(trueIndex, "distinct interned boolean carrier globals").not.toBe(falseIndex);
    expectInlinedBooleanBoxBranch(resume, trueIndex, falseIndex);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(17);
  });

  it("captures undefined through the canonical externref carrier without numeric boxing", async () => {
    const result = await compileStandalone(`
      function* g(): Generator<number | undefined, number, unknown> {
        [undefined, yield, null];
        return 7;
      }
      export function test(): number {
        const iterator = g();
        const first = iterator.next();
        const done = iterator.next(0);
        return (first.done ? 100 : 0) + (done.done ? 10 : 0) + (done.value as number);
      }
    `);
    const resume = watFunctionBody(result.wat, "__gen_resume_g");
    const undefinedIndex = watGlobalIndex(result.wat, "__undefined");
    const numericWrapperType = watNativeNumberWrapperType(result.wat);
    expect(undefinedIndex, "canonical standalone undefined global").not.toBeUndefined();
    expectCanonicalUndefinedContinuationSpill(resume, undefinedIndex!, numericWrapperType);

    // These pure helper regressions stay in the existing canonical control, so
    // the 27-case manifest cannot change. The native number-box verifier must
    // reject nested/unmodelled result construction, constants, payload masks,
    // and a carrier type that differs from this module's resolved wrapper.
    const adversarialFoldedSentBox = [
      "(if (result externref)",
      "  (then",
      "    local.get 2",
      "    i32.const 0 i32.const 0 i32.const 1 select ref.i31 extern.convert_any)",
      "  (else",
      "    local.get 3",
      "    ref.i31",
      "    extern.convert_any))",
    ].join("\n");
    expect(() =>
      expectInlineNumberBoxArms(
        adversarialFoldedSentBox,
        new Map<string, WatNumberBoxValue>([
          ["2", "sent-i32"],
          ["3", "sent-i32"],
        ]),
        numericWrapperType,
      ),
    ).toThrow("unmodelled number-box WAT opcode: select");

    const adversarialConstantRefI31 = [
      "(if (result externref)",
      "  (then",
      "    i32.const 0 ref.i31 extern.convert_any)",
      "  (else",
      "    local.get 3",
      "    ref.i31",
      "    extern.convert_any))",
    ].join("\n");
    expect(() =>
      expectInlineNumberBoxArms(
        adversarialConstantRefI31,
        new Map<string, WatNumberBoxValue>([["3", "sent-i32"]]),
        numericWrapperType,
      ),
    ).toThrow("ref.i31 consumed i32-zero, expected sent-i32");

    const adversarialZeroMask = [
      "(if (result externref)",
      "  (then",
      "    local.get 2",
      "    i32.const 0",
      "    i32.and",
      "    ref.i31",
      "    extern.convert_any)",
      "  (else",
      "    local.get 3",
      "    ref.i31",
      "    extern.convert_any))",
    ].join("\n");
    expect(() =>
      expectInlineNumberBoxArms(
        adversarialZeroMask,
        new Map<string, WatNumberBoxValue>([
          ["2", "sent-i32"],
          ["3", "sent-i32"],
        ]),
        numericWrapperType,
      ),
    ).toThrow("i32.and must combine only native number-box predicates, never a payload");

    // Index 0 is a real, separately declared f64 struct. The surrounding
    // `$typeN` anchors make the named wrapper's actual index (1) explicit,
    // rather than letting its source order masquerade as an index.
    const unrelatedCarrierModule = [
      "(module",
      "  (type $type0 (struct (field $other f64)))",
      "  (type $__box_number_struct (struct (field $value f64)))",
      "  (type $type2 (struct (field $tail f64)))",
      "  (func $__box_number (param f64) (result externref)",
      "    local.get 0",
      "    struct.new 1",
      "    extern.convert_any)",
      ")",
    ].join("\n");
    const syntheticNumericWrapperType = watNativeNumberWrapperType(unrelatedCarrierModule);
    expect(syntheticNumericWrapperType, "synthetic native wrapper index").toBe("1");
    const adversarialUnrelatedStruct = [
      "(if (result externref)",
      "  (then",
      "    local.get 3",
      "    ref.i31",
      "    extern.convert_any)",
      "  (else",
      "    local.get 2",
      "    struct.new 0",
      "    extern.convert_any))",
    ].join("\n");
    expect(() =>
      expectInlineNumberBoxArms(
        adversarialUnrelatedStruct,
        new Map<string, WatNumberBoxValue>([
          ["2", "sent-f64"],
          ["3", "sent-i32"],
        ]),
        syntheticNumericWrapperType,
      ),
    ).toThrow("number-box struct carrier must use native wrapper type 1 and convert directly");

    // This is the former false positive: the named wrapper is at index 1, but
    // the native boxer allocates the unrelated index-0 f64 struct. The helper
    // must reject the name/index split before the carrier body is admitted.
    const invertedCarrierModule = [
      "(module",
      "  (type $type0 (struct (field $other f64)))",
      "  (type $__box_number_struct (struct (field $value f64)))",
      "  (type $type2 (struct (field $tail f64)))",
      "  (func $__box_number (param f64) (result externref)",
      "    local.get 0",
      "    struct.new 0",
      "    extern.convert_any)",
      ")",
    ].join("\n");
    expect(() => watNativeNumberWrapperType(invertedCarrierModule)).toThrow(
      "native number boxer allocates its resolved wrapper type",
    );

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(17);

    // A checker-only `undefined` assertion can hide an otherwise admitted
    // assignment. It must decline the bounded native plan rather than skip the
    // assignment and synthesize a canonical value.
    await expectStandaloneRefusal(`
      function* g(): Generator<number | undefined, number, unknown> {
        let i = 0;
        [((i = 1) as unknown as undefined), yield, null];
        return i;
      }
      export function test(): number {
        const iterator = g();
        iterator.next();
        return iterator.next().value as number;
      }
    `);

    // A local or parameter spelling `undefined` is a user value, never the
    // ambient singleton. The planner must refuse rather than erase it.
    await expectStandaloneRefusal(`
      function* g(undefined: number): Generator<number | undefined, number, unknown> {
        [undefined, yield, null];
        return 7;
      }
      export function test(): number {
        const iterator = g(1);
        iterator.next();
        return iterator.next().value as number;
      }
    `);

    // The safe grammar recognizes the raw boolean, but an outer `void`
    // assertion is not a proven continuation carrier and must gate before
    // boolean branding.
    await expectStandaloneRefusal(`
      function* g(): Generator<number | undefined, number, unknown> {
        [(true as unknown as void), yield, null];
        return 7;
      }
      export function test(): number {
        const iterator = g();
        iterator.next();
        return iterator.next().value as number;
      }
    `);

    // Each outer `as number` is safe, but its unwrapped identifier remains a
    // nullish union. These prove the gate consults both checker types before
    // capture emission, even when this invocation sends a number.
    await expectStandaloneRefusal(`
      function* g(value: number | undefined): Generator<number | undefined, number, unknown> {
        [(value as number), yield, null];
        return 7;
      }
      export function test(): number {
        const iterator = g(1);
        iterator.next();
        return iterator.next().value as number;
      }
    `);
    await expectStandaloneRefusal(`
      function* g(value: number | void): Generator<number | undefined, number, unknown> {
        [(value as number), yield, null];
        return 7;
      }
      export function test(): number {
        const iterator = g(1);
        iterator.next();
        return iterator.next().value as number;
      }
    `);
    await expectStandaloneRefusal(`
      function* g(value: number | null): Generator<number | undefined, number, unknown> {
        [(value as number), yield, null];
        return 7;
      }
      export function test(): number {
        const iterator = g(1);
        iterator.next();
        return iterator.next().value as number;
      }
    `);

    // The outer assertion can launder a non-nullish operand to a nullish
    // union. Inspecting both nodes must refuse it before capture emission.
    await expectStandaloneRefusal(`
      function* g(value: number): Generator<number | undefined, number, unknown> {
        [(value as number | undefined), yield, null];
        return 7;
      }
      export function test(): number {
        const iterator = g(1);
        iterator.next();
        return iterator.next().value as number;
      }
    `);

    // A direct `null` literal stays on the ordinary externref capture route;
    // only nullish *unions* are denied by the bounded representation gate.
    expect(
      await runStandalone(`
        function* g(): Generator<number | undefined, number, unknown> {
          [null, yield, 0];
          return 7;
        }
        export function test(): number {
          const iterator = g();
          const first = iterator.next();
          const done = iterator.next(0);
          return (first.done ? 100 : 0) + (done.done ? 10 : 0) + (done.value as number);
        }
      `),
    ).toBe(17);
  });

  it("compiles and resumes a raw-reference capture without a representation claim", async () => {
    // The bounded statement-position grammar has no faithful representation
    // observation for this raw reference. This remains compile/validate/run
    // coverage, not evidence for a specific ref coercion or boxing route.
    expect(
      await runStandalone(`
        function* g(): Generator<number | undefined, number, unknown> {
          const reference: unknown = "captured";
          [reference, yield];
          return 7;
        }
        export function test(): number {
          const iterator = g();
          const first = iterator.next();
          const done = iterator.next(0);
          return (first.done ? 100 : 0) + (done.done ? 10 : 0) + (done.value as number);
        }
      `),
    ).toBe(17);
  });

  it("emits canonical ToBoolean and distinct successor states for a three-yield conditional", async () => {
    const result = await compileStandalone(`
        function* g(): Generator<number | undefined, number, unknown> {
          (yield) ? yield : yield;
          return 9;
        }
        function drive(sent: number): number {
          const iterator = g();
          const condition = iterator.next();
          const branch = iterator.next(sent);
          const done = iterator.next(0);
          return (condition.done ? 100 : 0) + (branch.done ? 10 : 0) + (done.done ? 1 : 0);
        }
        export function test(): number {
          return drive(0) + drive(1);
        }
      `);
    const resume = watFunctionBody(result.wat, "__gen_resume_g");
    const branchTargets = watCanonicalF64BranchTargets(resume);
    expect(branchTargets).toHaveLength(2);
    expect(new Set(branchTargets).size).toBe(2);

    // This runtime result only proves both drives complete the expected three
    // resume steps. The scoped WAT checks above own branch-selection evidence.
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(2);
  });

  it("keeps adjacent sequential yield controls intact", async () => {
    expect(
      await runStandalone(`
        function* g(): Generator<number | undefined, number, unknown> {
          yield 3;
          ((yield));
          yield 5;
          return 7;
        }
        export function test(): number {
          const iterator = g();
          const first = iterator.next();
          const continuation = iterator.next(1);
          const third = iterator.next(2);
          const done = iterator.next(3);
          return (
            (first.value as number) * 1000 +
            (continuation.done ? 100 : 0) +
            (third.value as number) * 10 +
            (done.done ? 1 : 0)
          );
        }
      `),
    ).toBe(3051);
  });

  it("runs the prelude-sensitive continuation on the default gc/host target", async () => {
    const result = await compileDefault(`
      function* g(): Generator<number | undefined, number, unknown> {
        let i = 10;
        [i++, yield];
        return i;
      }
      export function test(): number {
        const iterator = g();
        const first = iterator.next();
        const done = iterator.next(0);
        return (first.done ? 100 : 0) + (done.done ? 0 : 1_000) + (done.value as number);
      }
    `);
    expect(result.imports.filter(({ module }) => module === "env").map(({ name }) => name)).not.toContain(
      "__create_generator",
    );
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    expect((instance.exports as { test(): number }).test()).toBe(11);

    const canonicalPrefix = await compileDefault(`
      function* g(): Generator<number | undefined, number, unknown> {
        [undefined, yield, null];
        return 7;
      }
      export function test(): number {
        const iterator = g();
        iterator.next();
        return iterator.next().done ? 1 : 0;
      }
    `);
    expect(canonicalPrefix.imports.filter(({ module }) => module === "env").map(({ name }) => name)).toContain(
      "__create_generator",
    );
  });

  it.each([
    [
      "bare block",
      `
        function* g(): Generator<undefined, void, unknown> {
          { [yield]; }
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "if then arm",
      `
        function* g(): Generator<undefined, void, unknown> {
          if (true) { [yield]; }
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "else arm",
      `
        function* g(): Generator<undefined, void, unknown> {
          if (false) {} else { [yield]; }
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "while body",
      `
        function* g(): Generator<undefined, void, unknown> {
          while (false) { [yield]; }
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "do body",
      `
        function* g(): Generator<undefined, void, unknown> {
          do { [yield]; } while (false);
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "for body",
      `
        function* g(): Generator<undefined, void, unknown> {
          for (let i = 0; i < 0; i++) { [yield]; }
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "try body",
      `
        function* g(): Generator<undefined, void, unknown> {
          try { [yield]; } catch {}
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "catch body",
      `
        function* g(): Generator<undefined, void, unknown> {
          try { throw 1; } catch { [yield]; }
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "finally body",
      `
        function* g(): Generator<number | undefined, void, unknown> {
          try { yield 1; } finally { [yield]; }
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "yield-star operand",
      `
        function* g(): Generator<number, void, unknown> {
          [yield* [1]];
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "async generator",
      `
        async function* g(): AsyncGenerator<undefined, void, unknown> {
          [yield];
        }
        export async function test(): Promise<number> { return (await g().next()).done ? 1 : 0; }
      `,
    ],
    [
      "call operand",
      `
        function sink(_value: unknown): void {}
        function* g(): Generator<undefined, void, unknown> {
          sink(yield);
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "property access",
      `
        function* g(): Generator<undefined, void, unknown> {
          ({ value: yield }).value;
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "spread operand",
      `
        function* g(): Generator<undefined, void, number[]> {
          [...yield];
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "computed object key",
      `
        function* g(): Generator<undefined, void, unknown> {
          ({ [yield]: 1 });
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
    [
      "destructuring assignment",
      `
        function* g(): Generator<undefined, void, number> {
          let value: number | undefined;
          const source: { value?: number } = {};
          ({ value = yield } = source);
        }
        export function test(): number { return g().next().done ? 1 : 0; }
      `,
    ],
  ])("fails closed for %s", async (_name, source) => {
    await expectStandaloneRefusal(source);
  });
});
