// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4542 — an INDEPENDENT balance checker for handle IR.
//
// This is the harness the issue's negative-test criterion asks for: "a
// deliberate double-free and a deliberate missing-release are both caught by
// the test suite". It shares no bookkeeping with `handle-scope.ts` — it walks
// the FINISHED program, abstractly interpreting reference counts along every
// path, and reports what it finds. Feed it a hand-broken program and it must
// complain; feed it the pass's output and it must not.
//
// ── What it can prove without the engine ────────────────────────────────
//
// The acceptance criteria ask for a flat heap under a stress fixture, which
// needs the pinned QuickJS artifact. The artifact-independent half of the same
// property is checkable here and is checked: at a loop's back edge the
// reference counts must be IDENTICAL to those on entry to the iteration
// ({@link RefcountFinding} kind `loop-drift`). A loop whose counts are
// stationary cannot grow the heap through the handles this pass manages —
// which is the mechanism the heap fixture would be measuring. It is not a
// substitute for the fixture: it says nothing about allocations the pass does
// not model, or about the engine's own accounting.
//
// ── Paths ───────────────────────────────────────────────────────────────
//
// Every `if` forks; every call that can throw forks into normal and unwind;
// loops are explored to a bounded iteration count. Path count is capped and
// exceeding the cap is REPORTED (`path-budget-exhausted`), never silently
// truncated — an unexplored path is exactly where a refcount bug hides, and a
// checker that quietly stops looking is worse than no checker.

import { type HandleFunction, type HandleId, type HandleStmt, nestedBodies } from "./handle-ir.js";
import type { ResolvedOwnership } from "./ownership.js";

export type RefcountFindingKind =
  /** A reference is still held where control leaves the function. */
  | "leak"
  /** More releases than references held. */
  | "over-release"
  /** A reference we do not hold was handed to a `consumes` parameter. */
  | "consumed-unowned"
  /** A handle was read after its last reference was released. */
  | "use-after-free"
  /** The declared owned result was not handed back with exactly one reference. */
  | "result-transfer-mismatch"
  /** Reference counts differ between two iterations of the same loop. */
  | "loop-drift"
  /** The path budget ran out; the verdict is INCOMPLETE. */
  | "path-budget-exhausted";

export interface RefcountFinding {
  kind: RefcountFindingKind;
  handle?: HandleId;
  message: string;
  /** How control was leaving when the problem was observed. */
  path: "fall-through" | "return" | "unwind" | "loop-back-edge" | "any";
}

export interface VerifyOptions {
  /** Iterations to explore per loop. Two is the minimum that can see drift. */
  maxLoopIterations?: number;
  /** Hard cap on explored paths. */
  maxPaths?: number;
}

type Origin = "owned" | "borrowed";

interface State {
  counts: Map<HandleId, number>;
  origin: Map<HandleId, Origin>;
}

type Outcome =
  | { kind: "fall" }
  | { kind: "return"; value?: HandleId }
  | { kind: "break"; label: string }
  | { kind: "continue"; label: string }
  | { kind: "unwind"; value?: HandleId };

interface Path {
  outcome: Outcome;
  state: State;
}

function cloneState(s: State): State {
  return { counts: new Map(s.counts), origin: new Map(s.origin) };
}

function get(s: State, h: HandleId): number {
  return s.counts.get(h) ?? 0;
}

/**
 * Verify that a (already-rewritten) handle function is refcount-balanced on
 * every path. An empty finding list is the pass verdict.
 */
export function verifyRefcountBalance(
  func: HandleFunction,
  ownership: ReadonlyMap<string, ResolvedOwnership>,
  options: VerifyOptions = {},
): RefcountFinding[] {
  const maxLoopIterations = options.maxLoopIterations ?? 2;
  const maxPaths = options.maxPaths ?? 20000;
  const findings: RefcountFinding[] = [];
  const seen = new Set<string>();
  let pathsExplored = 0;
  let budgetExhausted = false;

  const report = (f: RefcountFinding): void => {
    const key = `${f.kind}|${f.handle ?? "-"}|${f.path}|${f.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  const own = (callee: string): ResolvedOwnership => {
    const found = ownership.get(callee);
    if (found === undefined) {
      throw new Error(
        `refcount verifier: no ownership annotation for callee '${callee}'. ` +
          "The verifier reads the same declared table as the pass; an unannotated import is " +
          "unverifiable, not assumed-safe.",
      );
    }
    return found;
  };

  /** A read through `h` requires that we (or a provable owner) still hold it. */
  const checkAlive = (state: State, h: HandleId, what: string, path: Outcome["kind"]): void => {
    if (state.origin.get(h) !== "owned") return; // borrowed: someone else's count, unknowable here
    if (get(state, h) > 0) return;
    report({
      kind: "use-after-free",
      handle: h,
      path: path === "unwind" ? "unwind" : "fall-through",
      message: `${what}: h${h} is read but this frame holds no reference to it.`,
    });
  };

  function exec(stmts: readonly HandleStmt[], start: number, state: State): Path[] {
    for (let i = start; i < stmts.length; i++) {
      const s = stmts[i];
      switch (s.kind) {
        case "call": {
          const o = own(s.callee);
          const applyArgs = (st: State): void => {
            for (let k = 0; k < s.args.length; k++) {
              const h = s.args[k];
              if (h === null) continue;
              if (o.args[k] === "consumes") {
                const before = get(st, h);
                if (before <= 0) {
                  report({
                    kind: "consumed-unowned",
                    handle: h,
                    path: "any",
                    message:
                      `call to '${s.callee}' hands h${h} to a 'consumes' parameter, but this frame holds ` +
                      "no reference to give away. The callee will release a reference we never took.",
                  });
                }
                st.counts.set(h, before - 1);
              } else {
                checkAlive(st, h, `call to '${s.callee}'`, "fall");
              }
            }
          };

          const paths: Path[] = [];
          if (o.throws) {
            // The unwind fork. `consumes` transfers on every outcome including
            // failure, so argument consumption applies here too; the result
            // does NOT, because it was never produced.
            const thrown = cloneState(state);
            applyArgs(thrown);
            paths.push({ outcome: { kind: "unwind" }, state: thrown });
          }
          applyArgs(state);
          if (s.dest !== undefined && o.result === "owned") {
            state.counts.set(s.dest, get(state, s.dest) + 1);
            state.origin.set(s.dest, "owned");
          } else if (s.dest !== undefined) {
            if (!state.origin.has(s.dest)) state.origin.set(s.dest, "borrowed");
          }
          if (paths.length > 0) {
            return [...paths, ...exec(stmts, i + 1, state)];
          }
          break;
        }

        case "use":
          checkAlive(state, s.value, "use", "fall");
          break;

        case "dup":
          // A dup READS its source and PRODUCES an independent owned handle.
          checkAlive(state, s.value, "dup", "fall");
          state.counts.set(s.dest, get(state, s.dest) + 1);
          state.origin.set(s.dest, "owned");
          break;

        case "free": {
          const before = get(state, s.value);
          if (before <= 0) {
            report({
              kind: "over-release",
              handle: s.value,
              path: s.reason === "unwind" ? "unwind" : "fall-through",
              message:
                `free h${s.value} (${s.reason}) releases a reference this frame does not hold ` +
                `(count ${before}). One more release than acquire is a use-after-free inside the engine.`,
            });
          }
          state.counts.set(s.value, before - 1);
          break;
        }

        case "opaque":
          if (s.throws !== false) {
            return [{ outcome: { kind: "unwind" }, state: cloneState(state) }, ...exec(stmts, i + 1, state)];
          }
          break;

        case "scope":
          return joinInto(exec(s.body, 0, state), (st) => exec(stmts, i + 1, st));

        case "if": {
          const thenPaths = exec(s.then, 0, cloneState(state));
          const elsePaths: Path[] = s.else
            ? exec(s.else, 0, cloneState(state))
            : [{ outcome: { kind: "fall" }, state }];
          return joinInto([...thenPaths, ...elsePaths], (st) => exec(stmts, i + 1, st));
        }

        case "block": {
          const inner = exec(s.body, 0, state).map((p) =>
            p.outcome.kind === "break" && p.outcome.label === s.label
              ? ({ outcome: { kind: "fall" }, state: p.state } as Path)
              : p,
          );
          return joinInto(inner, (st) => exec(stmts, i + 1, st));
        }

        case "loop": {
          const inner = runLoop(s.label, s.body, state);
          return joinInto(inner, (st) => exec(stmts, i + 1, st));
        }

        case "cleanup": {
          const inner = exec(s.body, 0, state).map((p) => {
            if (p.outcome.kind !== "unwind") return p;
            // The handler runs, then the exception continues outward.
            const after = p.state;
            const handled = exec(s.unwind, 0, after);
            // The unwind body is straight-line by construction; take its state.
            const st = handled.length > 0 ? handled[handled.length - 1].state : after;
            return { outcome: p.outcome, state: st } as Path;
          });
          return joinInto(inner, (st) => exec(stmts, i + 1, st));
        }

        case "break":
          return [{ outcome: { kind: "break", label: s.label }, state }];
        case "continue":
          return [{ outcome: { kind: "continue", label: s.label }, state }];
        case "return":
          return [{ outcome: { kind: "return", value: s.value }, state }];
        case "throw":
          return [{ outcome: { kind: "unwind", value: s.value }, state }];
      }
    }
    return [{ outcome: { kind: "fall" }, state }];
  }

  /** Continue only the fall-through paths; pass the rest straight up. */
  function joinInto(paths: Path[], cont: (state: State) => Path[]): Path[] {
    const out: Path[] = [];
    for (const p of paths) {
      if (++pathsExplored > maxPaths) {
        budgetExhausted = true;
        return out;
      }
      if (p.outcome.kind === "fall") out.push(...cont(p.state));
      else out.push(p);
    }
    return out;
  }

  function signature(state: State): string {
    return [...state.counts.entries()]
      .filter(([, n]) => n !== 0)
      .sort((a, b) => a[0] - b[0])
      .map(([h, n]) => `${h}:${n}`)
      .join(",");
  }

  function runLoop(label: string, body: readonly HandleStmt[], entry: State): Path[] {
    const out: Path[] = [];
    let current = entry;
    for (let iter = 0; iter < maxLoopIterations; iter++) {
      const entrySig = signature(current);
      const paths = exec(body, 0, cloneState(current));
      let next: State | undefined;
      for (const p of paths) {
        if (++pathsExplored > maxPaths) {
          budgetExhausted = true;
          return out;
        }
        if (p.outcome.kind === "continue" && p.outcome.label === label) {
          const backSig = signature(p.state);
          if (backSig !== entrySig) {
            report({
              kind: "loop-drift",
              path: "loop-back-edge",
              message:
                `loop '${label}': reference counts at the back edge (${backSig || "empty"}) differ from ` +
                `iteration entry (${entrySig || "empty"}). Repeating the loop changes the held set, so the ` +
                "heap grows with iterations — the failure the flat-heap fixture exists to catch.",
            });
          }
          // One representative continuation is enough: the drift check above is
          // what makes further iterations informative, and it already fired.
          if (next === undefined) next = p.state;
        } else if (p.outcome.kind === "break" && p.outcome.label === label) {
          out.push({ outcome: { kind: "fall" }, state: p.state });
        } else {
          out.push(p);
        }
      }
      if (next === undefined) return out;
      current = next;
    }
    return out;
  }

  const state: State = { counts: new Map(), origin: new Map() };
  for (const p of func.params) {
    state.origin.set(p.id, p.ownership === "owned" ? "owned" : "borrowed");
    state.counts.set(p.id, p.ownership === "owned" ? 1 : 0);
  }

  const finalPaths = exec(func.body, 0, state);
  for (const p of finalPaths) {
    const st = p.state;
    const outcome = p.outcome;

    // Which handle, if any, legitimately carries one reference OUT of the frame.
    let transferred: HandleId | undefined;
    if (outcome.kind === "return" && func.result === "owned") transferred = outcome.value;
    else if (outcome.kind === "unwind") transferred = outcome.value;

    if (outcome.kind === "return" && func.result === "owned" && outcome.value !== undefined) {
      const n = get(st, outcome.value);
      if (n !== 1) {
        report({
          kind: "result-transfer-mismatch",
          handle: outcome.value,
          path: "return",
          message:
            `${func.name} declares an owned result but leaves h${outcome.value} with ${n} reference(s) at ` +
            "the return. Exactly one must transfer to the caller.",
        });
      }
    }

    const exitPath = outcome.kind === "return" ? "return" : outcome.kind === "unwind" ? "unwind" : "fall-through";
    for (const [h, n] of st.counts) {
      if (n <= 0) continue;
      if (h === transferred && n === 1) continue;
      report({
        kind: "leak",
        handle: h,
        path: exitPath,
        message:
          `h${h} still holds ${n} reference(s) where control leaves ${func.name} via ${outcome.kind}. ` +
          "A missing release leaks silently — nothing fails at the point of the bug.",
      });
    }
  }

  if (budgetExhausted) {
    report({
      kind: "path-budget-exhausted",
      path: "any",
      message:
        `refcount verification of ${func.name} stopped after ${maxPaths} paths. The verdict is INCOMPLETE: ` +
        "unexplored paths were not checked. Raise maxPaths or shrink the fixture.",
    });
  }

  return findings;
}

/** Every handle mentioned by a body — used by tests to size local frames. */
export function handlesMentioned(stmts: readonly HandleStmt[]): Set<HandleId> {
  const ids = new Set<HandleId>();
  const visit = (list: readonly HandleStmt[]): void => {
    for (const s of list) {
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
  visit(stmts);
  return ids;
}
