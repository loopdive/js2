// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4542 — the handle-scope / destructor-insertion pass.
//
// Places `JS_DupValue` / `JS_FreeValue` so that every reference this frame
// acquires is released exactly once on EVERY path out of the scope that owns
// it: fall-through, `return`, `break`, `continue`, an explicit `throw`, and the
// unwind path raised by any engine call.
//
// ── The three rules, and why each is the one that is safe ───────────────
//
// 1. ACQUIRE-OWNS, SCOPE-RELEASES. A handle that arrives with a `+1` belongs
//    to the innermost enclosing scope and is released when control leaves that
//    scope, in reverse acquisition order. Not at every assignment (the thing
//    the issue's Scope section rules out), and not at last use either — see
//    rule 3 for why last-use release is the trap.
//
// 2. CONSUME-DUPS, NEVER MOVES. Handing an owned handle to a `consumes`
//    parameter emits a `JS_DupValue` and leaves the scope's own release in
//    place, instead of transferring the existing reference and cancelling the
//    release. The transfer would be a MOVE, and a move makes ownership shrink
//    in the middle of a scope, which is what rule 3 is about. The cost is one
//    redundant dup/free pair — precisely the pair the issue's "Elision safety
//    condition" says a later, separate pass may remove when it can prove the
//    conditions, and precisely the direction that section's closing line picks
//    ("When in doubt, keep the pair").
//
// 3. OWNERSHIP ONLY GROWS WITHIN A SCOPE, so the cleanup handler for any throw
//    point is exactly the set of handles acquired before it. This is the whole
//    reason the exceptional path works, and it is why release-at-last-use is
//    rejected: releasing early makes the owned set shrink mid-scope, so a
//    single `catch_all` per scope would double-free anything already released,
//    and the repair is either drop flags (a runtime branch per handle) or
//    non-nesting live ranges (which cannot be expressed as nested `try`
//    regions at all).
//
// ── Why ONE cleanup region per handle ───────────────────────────────────
//
// The other half of the same argument, from the other direction: a single
// `catch_all` covering a whole scope would free handles that had not been
// acquired yet when the throw happened. Consider
//
//     a = acquire();  b = mayThrow();  c = acquire();
//
// A throw at `mayThrow` reaches the handler with `c` uninitialised. So each
// acquisition opens a region covering the REST of its scope. Because ownership
// only grows (rule 3), those regions nest perfectly:
//
//     a = acquire()
//     try {  … ;  c = acquire()
//            try { … } catch_all { free c; rethrow }
//            free c
//     } catch_all { free a; rethrow }
//     free a
//
// The alternative — one handler per scope plus a `JS_UNDEFINED` sentinel in
// every handle slot, which is the idiomatic hand-written QuickJS shape — is
// deliberately NOT taken: it depends on the artifact's value encoding, which
// #4541 extracts at build time and which this pass must not assume. It is a
// legitimate size optimisation once that encoding is available; it is not a
// correctness prerequisite.
//
// A region is only opened when the rest of the scope can actually throw, so a
// program with no throwing calls gets plain frees and no `try` at all.

import { type HandleFunction, type HandleId, type HandleStmt, canThrow, nestedBodies, walk } from "./handle-ir.js";
import type { ResolvedOwnership } from "./ownership.js";

export interface HandleScopeDiagnostic {
  severity: "error" | "warning";
  message: string;
}

/**
 * A dup/free pair the elision follow-up may consider removing, with the facts
 * the issue's safety condition needs. Emitted, not acted on: elision is out of
 * scope for this slice.
 */
export interface ElisionCandidate {
  /** The handle whose retain/release pair this is. */
  handle: HandleId;
  /** Why the dup was inserted. */
  reason: "retain-borrowed" | "consume-arg" | "return-transfer";
  /**
   * Did any call inside the protected region declare that it can drop a
   * reference held in an engine-visible container slot?
   *
   * `true` REJECTS elision against a container-slot owner. This is the
   * mechanised form of the issue's rule: "alive on entry to R" is not
   * sufficient, because engine code called inside R can release the slot the
   * proposed owner lives in.
   */
  containerSlotReleasedInRegion: boolean;
}

export interface HandleScopeResult {
  func: HandleFunction;
  diagnostics: HandleScopeDiagnostic[];
  elisionCandidates: ElisionCandidate[];
}

interface Frame {
  kind: "function" | "scope" | "if" | "block" | "loop";
  label?: string;
  /** Owned handles, in acquisition order. Released in reverse. */
  owned: HandleId[];
}

export class HandleScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandleScopeError";
  }
}

/** Which exit edge a release belongs to (the reasons that cross frames). */
type ExitReason = "return" | "break" | "continue";

/**
 * Resolve a callee's ownership, or REFUSE.
 *
 * This is the "an import without an annotation is a compile error, not a
 * default" rule arriving at the site where the missing fact would have been
 * used. Both directions of the guess are named because both are silent.
 */
function lookupOwnership(
  ownership: ReadonlyMap<string, ResolvedOwnership>,
  callee: string,
  funcName: string,
): ResolvedOwnership {
  const found = ownership.get(callee);
  if (found === undefined) {
    throw new HandleScopeError(
      `refcount pass: no ownership annotation for callee '${callee}' in ${funcName}. ` +
        "Every engine import that carries JSValue handles must declare `ownership` — the pass " +
        "cannot place JS_DupValue/JS_FreeValue without it, and there is no safe default " +
        "(guessing 'borrows' leaks; guessing 'consumes' double-frees).",
    );
  }
  return found;
}

/** Does any call inside these statements declare it can drop a container slot? */
function anyCallReleasesContainerSlots(
  stmts: readonly HandleStmt[],
  lookup: (callee: string) => ResolvedOwnership,
): boolean {
  for (const s of walk(stmts)) {
    if (s.kind === "call" && lookup(s.callee).releasesContainerSlots) return true;
  }
  return false;
}

/** Releases for every frame from the top down to `stopIndex`, inclusive. */
function releasesFromFrames(frames: readonly Frame[], stopIndex: number, reason: ExitReason): HandleStmt[] {
  const out: HandleStmt[] = [];
  for (let f = frames.length - 1; f >= stopIndex; f--) {
    const owned = frames[f].owned;
    for (let k = owned.length - 1; k >= 0; k--) out.push({ kind: "free", value: owned[k], reason });
  }
  return out;
}

/** Index of the frame a `break`/`continue` targets. */
function findLabelFrame(frames: readonly Frame[], label: string, want: "break" | "continue", where: string): number {
  for (let f = frames.length - 1; f >= 0; f--) {
    const fr = frames[f];
    if (fr.label !== label) continue;
    if (want === "continue" && fr.kind !== "loop") {
      throw new HandleScopeError(`refcount pass: 'continue ${label}' in ${where} targets a ${fr.kind}, not a loop.`);
    }
    return f;
  }
  throw new HandleScopeError(`refcount pass: no enclosing '${label}' for ${want} in ${where}.`);
}

/**
 * Insert dup/free into one function body.
 *
 * `ownership` is the resolved import table from
 * {@link import("./ownership.js").requireOwnershipAnnotations}. A callee that
 * is not in it is a hard error, not a guess — that is the "an import without an
 * annotation is a compile error, not a default" criterion arriving at the site
 * where the missing fact would have been used.
 */
export function insertHandleScopes(
  func: HandleFunction,
  ownership: ReadonlyMap<string, ResolvedOwnership>,
): HandleScopeResult {
  const diagnostics: HandleScopeDiagnostic[] = [];
  const elisionCandidates: ElisionCandidate[] = [];
  const ownedNow = new Set<HandleId>();
  const frames: Frame[] = [];

  // Fresh names for the handles a dup produces. Numbered above everything the
  // input mentions so an id is never reused — the whole model rests on one
  // release per name.
  let nextHandle = 1;
  for (const id of collectHandles(func)) if (id >= nextHandle) nextHandle = id + 1;
  const fresh = (): HandleId => nextHandle++;

  /**
   * Rename map for a binding that was retained out of a borrowed handle: every
   * later mention of the borrowed name refers to the owned copy instead.
   */
  const rename = new Map<HandleId, HandleId>();
  const rn = (h: HandleId): HandleId => rename.get(h) ?? h;

  const lookup = (callee: string): ResolvedOwnership => lookupOwnership(ownership, callee, func.name);
  const throwsOf = (callee: string): boolean => lookup(callee).throws;
  const releasesContainerSlots = (stmts: readonly HandleStmt[]): boolean =>
    anyCallReleasesContainerSlots(stmts, lookup);
  const releasesDownTo = (stopIndex: number, reason: ExitReason): HandleStmt[] =>
    releasesFromFrames(frames, stopIndex, reason);
  const findLabel = (label: string, want: "break" | "continue", where: string): number =>
    findLabelFrame(frames, label, want, where);

  /**
   * Take ownership of `id` for the current frame, emit the rest of the scope
   * inside its cleanup region, then release it on the normal path.
   */
  const acquireAndWrap = (id: HandleId, emitRest: () => HandleStmt[]): HandleStmt[] => {
    const frame = frames[frames.length - 1];
    frame.owned.push(id);
    ownedNow.add(id);
    const rest = emitRest();
    frame.owned.pop();
    ownedNow.delete(id);

    const out: HandleStmt[] = [];
    if (canThrow(rest, throwsOf)) {
      out.push({
        kind: "cleanup",
        owner: id,
        body: rest,
        unwind: [{ kind: "free", value: id, reason: "unwind" }],
      });
    } else {
      out.push(...rest);
    }
    // The normal-path release. Skipped when the rest cannot fall through —
    // otherwise it is unreachable code after a `return`/`throw`/branch.
    if (!terminates(rest)) out.push({ kind: "free", value: id, reason: "scope-exit" });
    return out;
  };

  /** Emit a nested statement list as its own scope. */
  const emitScopeBody = (stmts: readonly HandleStmt[], frame: Frame): HandleStmt[] => {
    frames.push(frame);
    const out = emitFrom(stmts, 0);
    frames.pop();
    return out;
  };

  function emitFrom(stmts: readonly HandleStmt[], start: number): HandleStmt[] {
    const out: HandleStmt[] = [];
    for (let i = start; i < stmts.length; i++) {
      const s = stmts[i];
      switch (s.kind) {
        case "dup":
        case "free":
        case "cleanup":
          throw new HandleScopeError(
            `refcount pass: input to ${func.name} already contains a '${s.kind}' node. ` +
              "This pass is the sole producer of refcount traffic; hand-inserted dup/free would " +
              "be double-counted.",
          );

        case "call": {
          const own = lookup(s.callee);
          if (s.args.length !== own.args.length) {
            throw new HandleScopeError(
              `refcount pass: call to '${s.callee}' in ${func.name} passes ${s.args.length} argument(s) ` +
                `but the import declares ${own.args.length} parameter(s).`,
            );
          }
          const args: (HandleId | null)[] = [];
          for (let k = 0; k < s.args.length; k++) {
            const raw = s.args[k];
            const h = raw === null ? null : rn(raw);
            if (h === null || own.args[k] !== "consumes") {
              args.push(h);
              continue;
            }
            // Rule 2. `consumes` means the callee takes the reference on EVERY
            // outcome including failure (the QuickJS contract), so this dup is
            // not leaked when the call throws. The callee receives the DUP, not
            // the frame's own handle, which is what leaves the frame's release
            // valid.
            const copy = fresh();
            const reason = ownedNow.has(h) ? "consume-arg" : "consume-arg-borrowed";
            out.push({ kind: "dup", value: h, dest: copy, reason });
            if (reason === "consume-arg") {
              elisionCandidates.push({
                handle: h,
                reason: "consume-arg",
                containerSlotReleasedInRegion: own.releasesContainerSlots,
              });
            }
            args.push(copy);
          }
          const call: HandleStmt = { ...s, args };
          out.push(call);

          if (s.dest === undefined) break;
          if (own.result === "none") {
            throw new HandleScopeError(
              `refcount pass: call to '${s.callee}' in ${func.name} names a destination handle, ` +
                "but the import's ownership declares no handle result.",
            );
          }
          if (own.result === "owned") {
            return [...out, ...acquireAndWrap(s.dest, () => emitFrom(stmts, i + 1))];
          }
          // Borrowed result. Safe to read through immediately; retaining it
          // past any engine call needs a reference of our own — the elision
          // safety condition, applied at the point the reference is created.
          if (s.binding) {
            const retained = fresh();
            out.push({
              kind: "dup",
              value: s.dest,
              dest: retained,
              reason: "retain-borrowed",
            });
            const borrowed = s.dest;
            return [
              ...out,
              ...acquireAndWrap(retained, () => {
                // Every later mention of the binding means the OWNED copy. The
                // borrowed handle stays valid only until the next engine call.
                const saved = rename.get(borrowed);
                rename.set(borrowed, retained);
                const rest = emitFrom(stmts, i + 1);
                if (saved === undefined) rename.delete(borrowed);
                else rename.set(borrowed, saved);
                elisionCandidates.push({
                  handle: retained,
                  reason: "retain-borrowed",
                  containerSlotReleasedInRegion: releasesContainerSlots(rest),
                });
                return rest;
              }),
            ];
          }
          break;
        }

        case "use":
          out.push({ kind: "use", value: rn(s.value), note: s.note });
          break;

        case "opaque":
          out.push(s);
          break;

        case "scope":
          out.push({
            kind: "scope",
            body: emitScopeBody(s.body, { kind: "scope", owned: [] }),
            note: s.note,
          });
          break;

        case "if": {
          const then = emitScopeBody(s.then, { kind: "if", owned: [] });
          const otherwise = s.else ? emitScopeBody(s.else, { kind: "if", owned: [] }) : undefined;
          out.push({ kind: "if", then, else: otherwise, note: s.note });
          break;
        }

        case "block":
        case "loop": {
          const body = emitScopeBody(s.body, {
            kind: s.kind,
            label: s.label,
            owned: [],
          });
          out.push({ kind: s.kind, label: s.label, body });
          break;
        }

        case "break":
          out.push(...releasesDownTo(findLabel(s.label, "break", func.name), "break"), s);
          break;

        case "continue":
          out.push(...releasesDownTo(findLabel(s.label, "continue", func.name), "continue"), s);
          break;

        case "return": {
          const value = s.value === undefined ? undefined : rn(s.value);
          let handedBack = value;
          if (value !== undefined && func.result === "owned") {
            // The reference handed to the caller. The frame release below then
            // takes back the one this frame owned, so the net transfer is one.
            handedBack = fresh();
            out.push({
              kind: "dup",
              value,
              dest: handedBack,
              reason: "return-transfer",
            });
            if (ownedNow.has(value)) {
              // Uniformity, not oversight: when the returned handle is BORROWED
              // this dup is the only thing that makes the result owned, so the
              // pass always emits it. When we already owned it the pair is
              // redundant and elidable — recorded rather than special-cased,
              // because elision is this issue's stated non-goal.
              elisionCandidates.push({
                handle: value,
                reason: "return-transfer",
                containerSlotReleasedInRegion: false,
              });
            }
          } else if (value !== undefined && ownedNow.has(value)) {
            diagnostics.push({
              severity: "error",
              message:
                `${func.name} returns handle h${value}, which this frame owns, but its result ownership is ` +
                `'${func.result}'. The frame release would leave the caller holding a freed handle. ` +
                "Declare the function's result as 'owned' or hand back a borrowed handle.",
            });
          }
          out.push(...releasesDownTo(0, "return"), {
            kind: "return",
            value: handedBack,
          });
          break;
        }

        case "throw": {
          if (s.value === undefined) {
            out.push(s);
            break;
          }
          // The exception carries a reference. No explicit frees here: the
          // enclosing cleanup regions release, exactly as they do for a throw
          // raised inside an engine call. One unwind path, not two.
          const value = rn(s.value);
          const thrown = fresh();
          out.push({ kind: "dup", value, dest: thrown, reason: "throw-transfer" }, { kind: "throw", value: thrown });
          break;
        }
      }
    }
    return out;
  }

  const ownedParams = func.params.filter((p) => p.ownership === "owned").map((p) => p.id);
  const rootFrame: Frame = { kind: "function", owned: [] };
  frames.push(rootFrame);

  const emitParamsThen = (k: number): HandleStmt[] => {
    if (k >= ownedParams.length) return emitFrom(func.body, 0);
    return acquireAndWrap(ownedParams[k], () => emitParamsThen(k + 1));
  };
  const body = emitParamsThen(0);
  frames.pop();

  return { func: { ...func, body }, diagnostics, elisionCandidates };
}

/**
 * Does this statement list always leave via a terminator?
 *
 * Conservative: a `false` answer only costs an unreachable release. Used to
 * suppress a normal-path free that would sit after a `return`.
 */
export function terminates(stmts: readonly HandleStmt[]): boolean {
  if (stmts.length === 0) return false;
  const last = stmts[stmts.length - 1];
  switch (last.kind) {
    case "return":
    case "throw":
    case "break":
    case "continue":
      return true;
    case "if":
      return last.else !== undefined && terminates(last.then) && terminates(last.else);
    case "cleanup":
      return terminates(last.body);
    case "scope":
      return terminates(last.body);
    default:
      return false;
  }
}

/** All handle ids mentioned anywhere in a body. Used by the lowering. */
export function collectHandles(func: HandleFunction): Set<HandleId> {
  const ids = new Set<HandleId>();
  for (const p of func.params) ids.add(p.id);
  const visit = (stmts: readonly HandleStmt[]): void => {
    for (const s of stmts) {
      if (s.kind === "call") {
        for (const a of s.args) if (a !== null) ids.add(a);
        if (s.dest !== undefined) ids.add(s.dest);
      } else if (s.kind === "use" || s.kind === "free") {
        ids.add(s.value);
      } else if (s.kind === "dup") {
        ids.add(s.value);
        ids.add(s.dest);
      } else if ((s.kind === "return" || s.kind === "throw") && s.value !== undefined) {
        ids.add(s.value);
      }
      for (const body of nestedBodies(s)) visit(body);
    }
  };
  visit(func.body);
  return ids;
}
