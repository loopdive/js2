// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { BlockType, Instr, TryTableCatch, ValType } from "./types.js";

function walkChildren(instr: Instr, visit: (children: Instr[]) => void): void {
  const nested = instr as Instr & {
    body?: Instr[];
    then?: Instr[];
    else?: Instr[];
    catches?: { body: Instr[] }[];
    catchAll?: Instr[];
  };
  if (Array.isArray(nested.body)) visit(nested.body);
  if (Array.isArray(nested.then)) visit(nested.then);
  if (Array.isArray(nested.else)) visit(nested.else);
  for (const clause of nested.catches ?? []) {
    if (Array.isArray(clause.body)) visit(clause.body);
  }
  if (Array.isArray(nested.catchAll)) visit(nested.catchAll);
}

/** One handler in source/legacy selection order. */
export interface StandardEhHandler {
  kind: "catch" | "catch_all";
  tagIdx?: number;
  /** Values delivered to the handler block by the catch branch. */
  payloadType?: ValType;
  body: Instr[];
}

function isLabelOp(op: string): boolean {
  return op === "block" || op === "loop" || op === "if" || op === "try" || op === "try_table";
}

/**
 * Retarget branches after standardized-EH handler blocks are inserted.
 *
 * Legacy `try` contributes one label. In a `try_table` body that label remains
 * the `try_table` label, while the synthesized handler blocks plus join block
 * sit between it and every outer target. In a handler body the legacy try
 * label itself becomes the synthesized join block.
 */
function bumpBranches(instrs: Instr[], delta: number, includeLegacyTryLabel: boolean, localDepth = 0): void {
  if (delta === 0) return;
  for (const instr of instrs) {
    const op = instr.op;
    const targetsLegacyTryOrOuter = (depth: number): boolean =>
      includeLegacyTryLabel ? depth >= localDepth : depth > localDepth;

    if (op === "br" || op === "br_if") {
      if (targetsLegacyTryOrOuter(instr.depth)) instr.depth += delta;
    } else if (op === "br_table") {
      for (let i = 0; i < instr.targets.length; i++) {
        if (targetsLegacyTryOrOuter(instr.targets[i]!)) instr.targets[i] = instr.targets[i]! + delta;
      }
      if (targetsLegacyTryOrOuter(instr.defaultDepth)) instr.defaultDepth += delta;
    }

    const childDepth = isLabelOp(op) ? localDepth + 1 : localDepth;
    walkChildren(instr, (children) => bumpBranches(children, delta, includeLegacyTryLabel, childDepth));
  }
}

/**
 * Build the standardized `try_table` control-flow scaffold from handler bodies
 * that were compiled for one legacy `try` label.
 *
 * The result is ordinary block IR around a raw `try_table` instruction:
 *
 *   block $join
 *     block $handlerN
 *       ... block $handler0
 *         try_table (catch ... $handler0) ...
 *         br $join
 *       end
 *       handler0; br $join
 *     end
 *     handlerN; br $join
 *   end
 *
 * Keeping the synthesized blocks in IR (rather than hiding them in the binary
 * encoder) lets all existing control-flow, stack, liveness, and fixup passes
 * observe the real label depths.
 */
export function buildStandardTryTable(blockType: BlockType, body: Instr[], handlers: StandardEhHandler[]): Instr {
  if (handlers.length === 0) {
    throw new Error("try_table requires at least one catch handler");
  }

  const handlerCount = handlers.length;
  // The try_table label replaces the legacy try label. Only branches escaping
  // that label cross the N handler blocks plus the join block.
  bumpBranches(body, handlerCount + 1, false);

  const catches: TryTableCatch[] = handlers.map((handler, depth) => ({
    kind: handler.kind,
    ...(handler.tagIdx === undefined ? {} : { tagIdx: handler.tagIdx }),
    depth,
  }));

  let nested: Instr[] = [
    { op: "try_table", blockType, body, catches },
    { op: "br", depth: handlerCount },
  ];

  // Handler 0 is the innermost block and therefore catch depth 0. Each handler
  // runs just after its own target block closes, still enclosed by the
  // remaining handler blocks and the join block.
  for (let i = 0; i < handlerCount; i++) {
    const handler = handlers[i]!;
    const remainingHandlerBlocks = handlerCount - i - 1;
    bumpBranches(handler.body, remainingHandlerBlocks, true);
    nested = [
      {
        op: "block",
        blockType: handler.payloadType ? { kind: "val", type: handler.payloadType } : { kind: "empty" },
        body: nested,
      },
      ...handler.body,
      { op: "br", depth: remainingHandlerBlocks },
    ];
  }

  return { op: "block", blockType, body: nested };
}

/** Preserve legacy host output while selecting standardized EH for no-JS-host targets. */
export function buildTargetTaggedTry(
  target: { wasi: boolean; standalone: boolean },
  blockType: BlockType,
  body: Instr[],
  catches: { tagIdx: number; body: Instr[] }[],
  catchAll?: Instr[],
): Instr {
  if (!target.wasi && !target.standalone) {
    return { op: "try", blockType, body, catches, ...(catchAll === undefined ? {} : { catchAll }) };
  }
  return buildStandardTryTable(
    blockType,
    body,
    catches.map((clause) => ({
      kind: "catch",
      tagIdx: clause.tagIdx,
      payloadType: { kind: "externref" },
      body: clause.body,
    })),
  );
}
