// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#743) Receiver-provenance ATTRIBUTION — the 2026-08-08 spec's slice, and the
// pin census's binding constraint on `Parser.pos`: the 22 `state.pos = …`
// writes in acorn's `regexp_*` methods are `"all"`-attributed (untracked
// receiver), so the sound name-based over-approximation drags EVERY owner's
// `pos` fact to DYNAMIC. Their receiver is always the same
// `RegExpValidationState` instance, provably: `state` traces through method
// params to the `||`-caching local `var state = this.regexpState ||
// (this.regexpState = new RegExpValidationState(this))`.
//
// This pass re-attributes such writes to that single owner. ATTRIBUTION-ONLY:
// no new lattice dimension (the locals spec §6 priced full value-provenance as
// XL; this is the narrow variant its "What remains" section scoped).
//
// Sound rule: an `"all"` write with receiver identifier `r` may be
// re-attributed to tracked owner `R` iff every value reaching `r` is (a) the
// result of `new R(…)` with no constructor-return-override possible, or (b) a
// value that reaches NO tracked slot — `null`/`undefined` (the write throws;
// vacuous) or a host builtin's construction result (the §4 carve-out's trust
// class, restated below).
//
// Domain per receiver: ⊥ ("reaches no tracked slot") | R (single owner) | ⊤.
// Join: ⊥∨x=x · R∨R=R · R∨R'=⊤. Everything unprovable is ⊤ and the write
// KEEPS its `"all"` attribution — this pass can only remove writes from
// buckets they provably cannot hit, never add reach.
//
// Feeding: parameter provenance joins over the SAME `state.edges[].argExprs`
// the value fixpoint feeds from, with the same poison gates (a poisoned/
// escaped callee's params stay ⊤ — narrowing is what needs proof here, so any
// gap must widen). `new R(…)` counts as R only when R's constructor body has
// no `return <expr>` — `new` returns the ctor's return value when it is an
// object, which could be ANY instance. A `this.<f>` read (the `||`-idiom's
// first arm) joins the provenance of every write reaching that field, under
// exactly `readFieldFact`'s poison/interception guards; an unassigned read
// yields `undefined`, which is ⊥ here (a property write to it throws), so no
// definiteness snapshot is needed — provenance is about identity, not value.
//
// Placement: AFTER `buildEdges`, BEFORE `runFixpoint` — attribution must be
// static input to the value fixpoint; rewriting mid-iteration would be
// non-monotone. Rewrite rule: only `"all"` → R, only when R already has the
// field name in `fieldNamesByOwner` (a re-attributed write must not
// manufacture field-presence evidence), and the write keeps `attribution:
// "all"` semantics (no snapshot, never definite). ⊥ receivers stay in the
// all-bucket unchanged — dropping them entirely is a later, separately-argued
// cut.
//
// Trust boundary (same class as the §4 carve-out and the module header of
// `fnctor-method-edges.ts`): cross-module, `globalThis.SyntaxError =
// TrackedCtor` or an external caller handing a foreign object into an exported
// entrypoint could defeat the in-module proof; the consumer is f64-only, so a
// violating write coerces through the numeric unbox path — never a
// reinterpreted reference.
import { ts } from "../ts-api.js";
import type { IrUnitId } from "./identity.js";
import { type AnalysisState, type FieldWrite, unwrap } from "./fnctor-graph-model.js";
import { assignedIdentifierSymbols } from "./fnctor-field-writes.js";
import { buildWriteIndex } from "./fnctor-field-lattice.js";
import { enclosingThisBinder, isClassMemberLike } from "./fnctor-graph-model.js";

type Prov = "bot" | "top" | IrUnitId;

function provJoin(a: Prov, b: Prov): Prov {
  if (a === "bot") return b;
  if (b === "bot") return a;
  return a === b ? a : "top";
}

const MAX_ITERS = 50;

export function refineFieldWriteAttribution(state: AnalysisState): void {
  const allWrites: FieldWrite[] = state.fieldWrites.filter((w) => w.owner === "all" && w.receiver !== undefined);
  if (allWrites.length === 0 && state.deferredFieldPoisons.length === 0) return;

  const assigned = assignedIdentifierSymbols(state);
  const writeIndex = buildWriteIndex(state);

  // Identifier-parameter symbols of population nodes → (nodeId, index).
  const paramInfo = new Map<ts.Symbol, { nodeId: IrUnitId; index: number }>();
  for (const node of state.nodes.values()) {
    node.fn.parameters.forEach((p, index) => {
      if (!ts.isIdentifier(p.name)) return;
      const sym = state.checker.getSymbolAtLocation(p.name);
      if (sym !== undefined) paramInfo.set(sym, { nodeId: node.id, index });
    });
  }

  const paramProv = new Map<IrUnitId, Prov[]>();
  for (const node of state.nodes.values()) {
    paramProv.set(
      node.id,
      node.fn.parameters.map(() => (node.poisoned ? "top" : "bot")),
    );
  }

  /** `new <Ident>(…)` → the constructed owner, ⊥ for a host builtin, else ⊤. */
  const newProvenance = (site: ts.NewExpression): Prov => {
    const callee = unwrap(site.expression);
    if (!ts.isIdentifier(callee)) return "top";
    const sym = state.checker.getSymbolAtLocation(callee);
    const nodeId = sym !== undefined ? state.nodeIdBySymbol.get(sym) : undefined;
    if (nodeId !== undefined) {
      const node = state.nodes.get(nodeId);
      if (node === undefined) return "top";
      // `new F(…)` yields F's RETURN VALUE when the ctor returns an object —
      // which could be any instance at all. Only a return-free body pins the
      // identity. (Poisoned-ness is about unseen VALUE flows and does not
      // change what `new F` itself constructs.)
      return ctorHasExpressionReturn(node.fn) ? "top" : nodeId;
    }
    // Entirely out-of-file and never written in-file: a host builtin's
    // construction result predates the module and reaches no tracked slot —
    // the §4 carve-out's exact argument, expressed as ⊥.
    if (sym === undefined) return "top";
    for (const d of sym.getDeclarations() ?? []) {
      if (d.getSourceFile() === state.sourceFile) return "top";
    }
    return assigned.has(sym) ? "top" : "bot";
  };

  const ctorReturnCache = new Map<ts.Node, boolean>();
  function ctorHasExpressionReturn(fn: ts.FunctionDeclaration | ts.FunctionExpression): boolean {
    const cached = ctorReturnCache.get(fn);
    if (cached !== undefined) return cached;
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (n !== fn && ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression !== undefined) {
        found = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    if (fn.body !== undefined) visit(fn.body);
    ctorReturnCache.set(fn, found);
    return found;
  }

  const fieldReadProv = (owner: IrUnitId, name: string, visitingFields: Set<string>): Prov => {
    if (state.poisonAllFields) return "top";
    const node = state.nodes.get(owner);
    if (node === undefined || node.poisoned) return "top";
    if (state.fieldPoisonedOwners.has(owner)) return "top";
    if (state.protoPoisoned.has(owner)) return "top";
    if (state.runtimeDefinedProtoKeys.get(owner)?.has(name) === true) return "top";
    if (state.fieldDynamicNames.has(name)) return "top";
    if (state.fieldDynamicPerOwner.get(owner)?.has(name) === true) return "top";
    if (state.fieldNamesByOwner.get(owner)?.has(name) !== true) return "top";
    // Space-separated like `writeKey` (an `IrUnitId` never contains one). The
    // first cut used a literal NUL byte here, which made git/tooling treat the
    // whole FILE as binary (#4246 shipped that way) — fixed alongside #4250.
    const key = `${owner} ${name}`;
    if (visitingFields.has(key)) return "bot"; // SCC re-entry: outer join already covers it
    visitingFields.add(key);
    try {
      let joined: Prov = "bot"; // an unassigned read is `undefined` — ⊥ (a write to it throws)
      for (const w of writeIndex.get(owner)?.get(name) ?? []) {
        // `+=` and the numeric compounds store primitives — never an instance.
        const contribution: Prov =
          w.kind === "numeric-op" || w.kind === "plus-assign"
            ? "bot"
            : w.carrier !== undefined
              ? exprProv(w.carrier, new Set(), visitingFields)
              : "top";
        joined = provJoin(joined, contribution);
        if (joined === "top") break;
      }
      return joined;
    } finally {
      visitingFields.delete(key);
    }
  };

  function exprProv(expr: ts.Expression, visitingSyms: Set<ts.Symbol>, visitingFields: Set<string>): Prov {
    let e = unwrap(expr);
    while (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      e = unwrap(e.right);
    }
    if (e.kind === ts.SyntaxKind.NullKeyword) return "bot";
    if (ts.isVoidExpression(e)) return "bot";
    // (#4250) Fresh non-instance values: an object/array LITERAL is a new
    // plain object (acorn's dictionary receivers — `this.undefinedExports =
    // {}` — are exactly this shape), and a primitive can never be a tracked
    // instance at all. Both are ⊥ — a computed write through them reaches no
    // tracked slot.
    if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) return "bot";
    if (
      ts.isStringLiteralLike(e) ||
      ts.isNumericLiteral(e) ||
      ts.isRegularExpressionLiteral(e) ||
      e.kind === ts.SyntaxKind.TrueKeyword ||
      e.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return "bot";
    }
    if (ts.isNewExpression(e)) return newProvenance(e);
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        return provJoin(
          exprProv(e.left, visitingSyms, visitingFields),
          exprProv(e.right, visitingSyms, visitingFields),
        );
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        // `a && b` yields `a` only when `a` is falsy, and no object is falsy —
        // the a-outcome reaches no tracked slot (⊥), so only `b` contributes.
        return exprProv(e.right, visitingSyms, visitingFields);
      }
      return "top";
    }
    if (ts.isConditionalExpression(e)) {
      return provJoin(
        exprProv(e.whenTrue, visitingSyms, visitingFields),
        exprProv(e.whenFalse, visitingSyms, visitingFields),
      );
    }
    if (ts.isPropertyAccessExpression(e) && !ts.isPrivateIdentifier(e.name)) {
      if (unwrap(e.expression).kind !== ts.SyntaxKind.ThisKeyword) return "top";
      const binder = enclosingThisBinder(e);
      if (binder === undefined || isClassMemberLike(binder)) return "top";
      const nodeId = state.nodeIdByFn.get(binder);
      const node = nodeId !== undefined ? state.nodes.get(nodeId) : undefined;
      if (node?.kind !== "proto-method" || node.ownerId === undefined) return "top";
      return fieldReadProv(node.ownerId, e.name.text, visitingFields);
    }
    if (ts.isIdentifier(e)) {
      if (e.text === "undefined") return "bot";
      const sym = state.checker.getSymbolAtLocation(e);
      if (sym === undefined) return "top";
      const asParam = paramInfo.get(sym);
      if (asParam !== undefined) return paramProv.get(asParam.nodeId)![asParam.index] ?? "top";
      const decls = sym.getDeclarations() ?? [];
      if (decls.length !== 1) return "top";
      const decl = decls[0]!;
      // Single-assignment local: one initialized `var`/`let`/`const` declarator
      // (not a loop/catch/destructuring binding), never reassigned in-file.
      if (
        !ts.isVariableDeclaration(decl) ||
        !ts.isIdentifier(decl.name) ||
        decl.initializer === undefined ||
        decl.getSourceFile() !== state.sourceFile ||
        !ts.isVariableDeclarationList(decl.parent) ||
        !ts.isVariableStatement(decl.parent.parent) ||
        assigned.has(sym)
      ) {
        return "top";
      }
      if (visitingSyms.has(sym)) return "bot"; // `var a = a` reads undefined — ⊥
      visitingSyms.add(sym);
      try {
        return exprProv(decl.initializer, visitingSyms, visitingFields);
      } finally {
        visitingSyms.delete(sym);
      }
    }
    return "top";
  }

  // Parameter-provenance fixpoint over the SAME edge set as the value fixpoint.
  // All rules are joins over a height-2 domain — convergence is fast; a bailout
  // rewrites nothing (strictly safe: everything stays `"all"`).
  const runParamProvFixpoint = (): boolean => {
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      let changed = false;
      for (const edge of state.edges) {
        const target = state.nodes.get(edge.callee);
        if (target === undefined || target.poisoned) continue;
        const provs = paramProv.get(edge.callee)!;
        const n = Math.min(provs.length, edge.argExprs.length);
        for (let i = 0; i < n; i++) {
          const next = provJoin(provs[i]!, exprProv(edge.argExprs[i]!, new Set(), new Set()));
          if (next !== provs[i]) {
            provs[i] = next;
            changed = true;
          }
        }
        // An under-applied call leaves the missing parameters `undefined` — ⊥,
        // which joins as identity; nothing to do.
      }
      if (!changed) return true;
    }
    return false; // unconverged
  };

  // (#4250) Apply the poisons whose owner needed provenance to name. Returns
  // whether any state changed. Poisons only ever WIDEN provenance answers
  // (poisoned reads go ⊤), and provenance answers only ever widen poisons, so
  // the outer loop below is monotone over two finite sets and terminates.
  const applyDeferredPoisons = (): boolean => {
    let changed = false;
    const diag = process.env.JS2WASM_LOG_FNCTOR_GRAPH === "1";
    for (const poison of state.deferredFieldPoisons) {
      const prov = exprProv(poison.receiver, new Set(), new Set());
      if (diag) {
        const line = state.sourceFile.getLineAndCharacterOfPosition(poison.receiver.getStart()).line + 1;
        // eslint-disable-next-line no-console
        console.error(
          `[#4250 deferred-poison] :${line} recv=${poison.receiver.getText().slice(0, 40)} name=${poison.name ?? "*"} prov=${String(prov)}`,
        );
      }
      if (prov === "bot") continue; // null/undefined/builtin instance — reaches no tracked slot
      if (prov === "top") {
        if (poison.name !== undefined) {
          if (!state.fieldDynamicNames.has(poison.name)) {
            state.fieldDynamicNames.add(poison.name);
            changed = true;
          }
        } else if (!state.poisonAllFields) {
          state.poisonAllFields = true;
          changed = true;
        }
        continue;
      }
      if (poison.name !== undefined) {
        let set = state.fieldDynamicPerOwner.get(prov);
        if (set === undefined) {
          set = new Set();
          state.fieldDynamicPerOwner.set(prov, set);
        }
        if (!set.has(poison.name)) {
          set.add(poison.name);
          changed = true;
        }
      } else if (!state.fieldPoisonedOwners.has(prov)) {
        state.fieldPoisonedOwners.add(prov);
        changed = true;
      }
    }
    return changed;
  };

  // Alternate until stable: provenance informs the poisons, and a poison
  // widens the provenance of anything read through the poisoned fields.
  for (let round = 0; round < MAX_ITERS; round++) {
    if (!runParamProvFixpoint()) {
      // Unconverged: rewrite nothing — and the deferred poisons MUST NOT be
      // dropped (a dropped poison reads as a clean field to the #4250
      // write-kind verdict, which is optimism in the forbidden direction).
      // Apply every one at worst-case severity instead.
      for (const poison of state.deferredFieldPoisons) {
        if (poison.name !== undefined) state.fieldDynamicNames.add(poison.name);
        else state.poisonAllFields = true;
      }
      return;
    }
    if (!applyDeferredPoisons()) break;
  }

  for (const w of allWrites) {
    const receiver = unwrap(w.receiver!);
    if (!ts.isIdentifier(receiver)) continue;
    const prov = exprProv(receiver, new Set(), new Set());
    if (prov === "bot" || prov === "top") continue;
    if (state.fieldNamesByOwner.get(prov)?.has(w.name) !== true) continue;
    w.owner = prov;
  }
}
