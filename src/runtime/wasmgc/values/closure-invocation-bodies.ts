// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { TypeDef } from "../../../wasm/model/module-records.js";
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import { CLOSURE_ARITY_FIELD_IDX } from "./closure-layouts.js";
import type { ClosureInvocationArityEntry, ClosureInvocationLayout } from "./closure-invocation-types.js";

export function buildClosureFuncrefExtraction(
  layout: ClosureInvocationLayout,
  entries: readonly { readonly selfTypeIdx: number }[],
  anyLocal: number,
  funcLocal: number,
): Instr[] {
  // (#3673) Root-collapse: every shared-signature wrapper AND every
  // capture-carrying closure struct subtypes the canonical root wrapper
  // (mintClosureStructTypes / getOrCreateFuncRefWrapperTypes), and field 0 is
  // funcref on the root itself — so ONE `ref.test <root>` arm extracts the
  // funcref for all of them. Only shapes with no path to the root (named
  // function expressions, wrapper-less fallbacks) keep per-shape arms. The
  // old one-arm-per-shape ladder ran per dynamic call/arity-probe and scaled
  // with the number of closures in the program (hundreds for acorn).
  const rootIdx = layout.rootTypeIdx;
  const isRootDescendant = (typeIdx: number): boolean => {
    if (rootIdx === undefined) return false;
    let cur: number | undefined = typeIdx;
    let guard = 0;
    while (cur !== undefined && cur >= 0 && guard++ < 64) {
      if (cur === rootIdx) return true;
      const t: { kind: string; superTypeIdx?: number } | undefined = layout.types[cur];
      cur = t && t.kind === "struct" ? t.superTypeIdx : undefined;
    }
    return false;
  };
  const out: Instr[] = [];
  const seenShape = new Set<number>();
  let needRootArm = false;
  const ladderShapes: number[] = [];
  for (const entry of entries) {
    if (seenShape.has(entry.selfTypeIdx)) continue;
    seenShape.add(entry.selfTypeIdx);
    if (isRootDescendant(entry.selfTypeIdx)) needRootArm = true;
    else ladderShapes.push(entry.selfTypeIdx);
  }
  if (needRootArm) {
    out.push({ op: "local.get", index: anyLocal });
    out.push({ op: "ref.test", typeIdx: rootIdx! });
    out.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: rootIdx! },
        { op: "struct.get", typeIdx: rootIdx!, fieldIdx: 0 },
        { op: "local.set", index: funcLocal },
      ],
    });
  }
  for (const selfTypeIdx of ladderShapes) {
    out.push({ op: "local.get", index: anyLocal });
    out.push({ op: "ref.test", typeIdx: selfTypeIdx });
    out.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: selfTypeIdx },
        { op: "struct.get", typeIdx: selfTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: funcLocal },
      ],
    });
  }
  return out;
}

export function buildClosureArityProbe(
  layout: ClosureInvocationLayout,
  entries: readonly ClosureInvocationArityEntry[],
  valueLocal: number,
  anyLocal: number,
  funcLocal: number,
): Instr[] | undefined {
  if (entries.length === 0) return undefined;
  // (#3673) Root fast path: every closure struct in the wrapper hierarchy
  // carries its declared arity as field CLOSURE_ARITY_FIELD_IDX, so ONE
  // `ref.test <root>` + `struct.get` answers the probe — the per-func-type
  // `ref.test` chain (90 arms on compiled acorn) survives only for closure
  // shapes OUTSIDE the hierarchy (e.g. fnctor ctor closures).
  const rootIdx = layout.rootTypeIdx;
  const isRootDescendant = (typeIdx: number): boolean => {
    if (rootIdx === undefined) return false;
    let cur: number | undefined = typeIdx;
    let guard = 0;
    while (cur !== undefined && cur >= 0 && guard++ < 64) {
      if (cur === rootIdx) return true;
      const t: { kind: string; superTypeIdx?: number } | undefined = layout.types[cur];
      cur = t && t.kind === "struct" ? t.superTypeIdx : undefined;
    }
    return false;
  };
  const ladderEntries = entries.filter((e) => !isRootDescendant(e.selfTypeIdx));
  // Nested if/else so exactly ONE arm wins (the export twin uses early `return`,
  // which is unavailable mid-body).
  let chain: Instr[] = [{ op: "i32.const", value: -1 }];
  for (let i = ladderEntries.length - 1; i >= 0; i--) {
    chain = [
      { op: "local.get", index: funcLocal },
      { op: "ref.test", typeIdx: ladderEntries[i]!.funcTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: ladderEntries[i]!.closureArity }],
        else: chain,
      },
    ];
  }
  const slowPath: Instr[] = [
    { op: "ref.null.func" },
    { op: "local.set", index: funcLocal },
    ...buildClosureFuncrefExtraction(layout, ladderEntries, anyLocal, funcLocal),
    ...chain,
  ];
  if (rootIdx === undefined) {
    return [
      { op: "local.get", index: valueLocal },
      { op: "any.convert_extern" },
      { op: "local.set", index: anyLocal },
      ...slowPath,
    ];
  }
  return [
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "local.tee", index: anyLocal },
    { op: "ref.test", typeIdx: rootIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: rootIdx },
        { op: "struct.get", typeIdx: rootIdx, fieldIdx: CLOSURE_ARITY_FIELD_IDX },
      ],
      else: slowPath,
    },
  ];
}

/** The actual legacy export body, shared by ledger-owned native invocation. */
export function buildClosureArityBody(
  layout: ClosureInvocationLayout,
  entries: readonly ClosureInvocationArityEntry[],
): Instr[] {
  // Locals: 0 = value externref (param), 1 = anyref, 2 = funcref.
  const anyLocal = 1;
  const funcLocal = 2;
  // (#3673) Root fast path — mirror of buildClosureArityProbe: one
  // struct.get on the wrapper root answers every in-hierarchy closure; the
  // per-func-type chain survives only for shapes outside the hierarchy.
  const rootIdxForExport = layout.rootTypeIdx;
  const isRootDescendantExport = (typeIdx: number): boolean => {
    if (rootIdxForExport === undefined) return false;
    let cur: number | undefined = typeIdx;
    let guard = 0;
    while (cur !== undefined && cur >= 0 && guard++ < 64) {
      if (cur === rootIdxForExport) return true;
      const t: { kind: string; superTypeIdx?: number } | undefined = layout.types[cur];
      cur = t && t.kind === "struct" ? t.superTypeIdx : undefined;
    }
    return false;
  };
  const ladderEntriesExport = entries.filter((e) => !isRootDescendantExport(e.selfTypeIdx));
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocal },
  ];
  if (rootIdxForExport !== undefined) {
    body.push(
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: rootIdxForExport },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: rootIdxForExport },
          { op: "struct.get", typeIdx: rootIdxForExport, fieldIdx: CLOSURE_ARITY_FIELD_IDX },
          { op: "return" },
        ],
      },
    );
  }
  body.push(...buildClosureFuncrefExtraction(layout, ladderEntriesExport, anyLocal, funcLocal));
  for (const entry of ladderEntriesExport) {
    body.push({ op: "local.get", index: funcLocal });
    body.push({ op: "ref.test", typeIdx: entry.funcTypeIdx });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: entry.closureArity }, { op: "return" }],
    });
  }
  body.push({ op: "i32.const", value: -1 });

  return body;
}

export interface ClosureArgumentState {
  readonly argc: number;
  readonly extrasArgv: number;
  readonly extrasVecTypeIdx: number;
  readonly extrasArrTypeIdx: number;
}

/** The legacy method dispatcher's actual argc/extras setup. */
export function buildClosureMethodArgumentState(
  arity: number,
  closureArity: number,
  state: ClosureArgumentState,
): Instr[] {
  const setupInstrs: Instr[] = [
    { op: "global.get", index: state.argc },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "global.get", index: state.argc },
        { op: "i32.const", value: closureArity },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "global.get", index: state.argc }],
          else: [{ op: "i32.const", value: closureArity }],
        },
      ],
      else: [{ op: "i32.const", value: closureArity }],
    },
    { op: "global.set", index: state.argc },
  ];
  if (arity > closureArity) {
    const extrasCount = arity - closureArity;
    setupInstrs.push({ op: "i32.const", value: extrasCount });
    for (let i = closureArity; i < arity; i++) {
      setupInstrs.push({ op: "local.get", index: i + 2 });
    }
    setupInstrs.push({ op: "array.new_fixed", typeIdx: state.extrasArrTypeIdx, length: extrasCount });
    setupInstrs.push({ op: "struct.new", typeIdx: state.extrasVecTypeIdx });
    setupInstrs.push({ op: "global.set", index: state.extrasArgv });
  } else {
    setupInstrs.push({ op: "ref.null", typeIdx: state.extrasVecTypeIdx });
    setupInstrs.push({ op: "global.set", index: state.extrasArgv });
  }

  return setupInstrs;
}

export function orderClosureDispatchEntries<T extends { funcTypeIdx: number; rest?: unknown }>(
  types: readonly TypeDef[],
  entries: T[],
): T[] {
  const breadth = (type: ValType | undefined): number =>
    type?.kind === "externref" || type?.kind === "anyref" ? 1 : 0;
  const score = (entry: T) => {
    const def = types[entry.funcTypeIdx];
    if (!def || def.kind !== "func") return { params: 0, results: 0 };
    // Skip the lifted self parameter. Host dispatch only converts user args.
    const params = def.params.slice(1).reduce((sum, type) => sum + breadth(type), 0);
    const results = def.results.reduce((sum, type) => sum + breadth(type), 0);
    return { params, results };
  };
  const ordered = entries
    .map((entry, index) => ({ entry, index, score: score(entry) }))
    .sort((a, b) => {
      // Shape-qualified rest entries must win over a same-signature ordinary
      // vec entry.  The stable index tie-break preserves deterministic output.
      const restOrder = Number(Boolean(b.entry.rest)) - Number(Boolean(a.entry.rest));
      if (restOrder !== 0) return restOrder;
      // Function-parameter contravariance: broad host-facing parameters first.
      if (a.score.params !== b.score.params) return b.score.params - a.score.params;
      // Function-result covariance: concrete results first, broad externref
      // results last, so a broad result arm cannot claim a narrower closure.
      if (a.score.results !== b.score.results) return a.score.results - b.score.results;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
  return ordered;
}

/** Shared executable call core; conversion and state inputs are explicit operand sequences. */
export function buildClosureMethodCallBody(
  entry: Pick<ClosureInvocationArityEntry, "selfTypeIdx" | "funcTypeIdx">,
  anyLocal: number,
  funcLocal: number,
  setupInstrs: readonly Instr[],
  argumentInstrs: readonly Instr[],
): Instr[] {
  return [
    ...structuredClone([...setupInstrs]),
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: entry.selfTypeIdx },
    ...structuredClone([...argumentInstrs]),
    { op: "local.get", index: funcLocal },
    { op: "ref.cast", typeIdx: entry.funcTypeIdx },
    { op: "call_ref", typeIdx: entry.funcTypeIdx },
  ];
}
