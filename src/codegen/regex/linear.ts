// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2723 Slice A — reference linear (non-backtracking) matcher: a PikeVM over
 * the SAME `[op, a, b]` bytecode the backtracking VM runs (`vm.ts`).
 *
 * This is the executable specification for the Wasm twin
 * (`__regex_search_linear`, `src/codegen/regex-runtime/linear-search.ts`), which
 * mirrors it step for step.
 *
 * Algorithm (Thompson simulation with Pike's priority-ordered thread lists,
 * arXiv:2311.17620 §3): all live threads advance over the subject in
 * lockstep, one code unit per step. A thread is a program state plus its own
 * capture array. Within a list, order is backtracking priority: `SPLIT a,b`
 * enqueues the `a` closure before the `b` closure, exactly the order the
 * backtracker would try them. Each state is admitted at most once per
 * position — the first (highest-priority) arrival wins, which is sound
 * because, without backreferences, whether a thread can still match depends
 * only on its state and position, never on its captures. When a thread
 * reaches MATCH every lower-priority thread is dropped, so the result is the
 * leftmost match the backtracker would report, with the same captures. Time is
 * O(|prog| · |input|) per search: no step cap is needed and none exists.
 *
 * The program must be linear-safe ({@link isLinearSafe}). Excluded, and kept
 * on the backtracking VM with its step cap:
 *   - BACKREF — backreference matching is NP-hard; the cap is the right
 *     defence there;
 *   - LOOKAROUND — needs the §4.3/§4.4 oracle or streaming construction
 *     (later slices);
 *   - PROGRESS — the empty-iteration guard of a nullable-body loop makes a
 *     thread's future depend on a scratch slot, which breaks the
 *     state-plus-position dedup above (the §4.1 BEGIN_LOOP/END_LOOP
 *     construction is the later fix).
 *
 * State encoding: a state `s < n` is "about to execute instruction `s`". A
 * state `n + pc` is "CPCLASS `pc` consumed the lead half of a surrogate pair;
 * the trail half is consumed on the next step, resuming at `pc + 1`" — the
 * one consumer that spans two code units.
 */
import { INSTR_WIDTH, ReOp } from "./bytecode.js";
import { assertionHolds, classMatch, forwardCodePoint, unitMatches } from "./match-units.js";

/** Opcodes the linear simulation executes. Anything else declines. */
const LINEAR_OPS: ReadonlySet<number> = new Set([
  ReOp.CHAR,
  ReOp.CHARI,
  ReOp.ANY,
  ReOp.CLASS,
  ReOp.CPCLASS,
  ReOp.SPLIT,
  ReOp.JMP,
  ReOp.SAVE,
  ReOp.CLEAR,
  ReOp.BOL,
  ReOp.EOL,
  ReOp.WBOUND,
  ReOp.MATCH,
]);

/** Can `prog` run on the linear PikeVM? (See the module header for the exclusions.) */
export function isLinearSafe(prog: number[]): boolean {
  for (let i = 0; i < prog.length; i += INSTR_WIDTH) {
    if (!LINEAR_OPS.has(prog[i]!)) return false;
  }
  return true;
}

interface Thread {
  state: number;
  caps: Int32Array;
}

/** One position's thread list plus the per-state admission stamps it shares with every list. */
class ThreadList {
  readonly threads: Thread[] = [];
  constructor(
    private readonly seen: Int32Array,
    private readonly stamp: number,
  ) {}
  /** Admit `state` unless an earlier (higher-priority) thread already holds it at this position. */
  admit(state: number): boolean {
    if (this.seen[state] === this.stamp) return false;
    this.seen[state] = this.stamp;
    return true;
  }
}

/**
 * Add the epsilon closure of `(state, caps)` at position `sp` to `list`, in
 * priority order. The explicit stack is a pre-order DFS: SPLIT pushes `b`
 * under `a`, so `a`'s whole closure is admitted before `b`'s, as the recursive
 * formulation (and the backtracker) would.
 */
function addThread(prog: number[], input: string, list: ThreadList, state: number, caps: Int32Array, sp: number): void {
  const n = prog.length / INSTR_WIDTH;
  const stack: Thread[] = [{ state, caps }];
  for (let t = stack.pop(); t !== undefined; t = stack.pop()) {
    if (!list.admit(t.state)) continue;
    if (t.state >= n) {
      list.threads.push(t);
      continue;
    }
    const pc = t.state;
    const op = prog[pc * INSTR_WIDTH]!;
    const a = prog[pc * INSTR_WIDTH + 1]!;
    const b = prog[pc * INSTR_WIDTH + 2]!;
    switch (op) {
      case ReOp.JMP:
        stack.push({ state: a, caps: t.caps });
        break;
      case ReOp.SPLIT:
        stack.push({ state: b, caps: t.caps }, { state: a, caps: t.caps });
        break;
      case ReOp.SAVE:
      case ReOp.CLEAR: {
        // Copy-on-write: other threads may share `t.caps`.
        const next = t.caps.slice();
        if (op === ReOp.SAVE) next[a] = sp;
        else next.fill(-1, a, b + 1);
        stack.push({ state: pc + 1, caps: next });
        break;
      }
      case ReOp.BOL:
      case ReOp.EOL:
      case ReOp.WBOUND:
        if (assertionHolds(op, a, input, sp)) stack.push({ state: pc + 1, caps: t.caps });
        break;
      default:
        // A consumer or MATCH: it waits in the list for the step at `sp`.
        list.threads.push(t);
    }
  }
}

/**
 * Advance one thread over the code unit at `sp` into `next` (the list for
 * `sp + 1`). Returns true when the thread is at MATCH.
 */
function step(prog: number[], classTable: number[], input: string, t: Thread, sp: number, next: ThreadList): boolean {
  const n = prog.length / INSTR_WIDTH;
  if (t.state >= n) {
    addThread(prog, input, next, t.state - n + 1, t.caps, sp + 1);
    return false;
  }
  const op = prog[t.state * INSTR_WIDTH]!;
  if (op === ReOp.MATCH) return true;
  if (sp >= input.length) return false;
  const a = prog[t.state * INSTR_WIDTH + 1]!;
  const b = prog[t.state * INSTR_WIDTH + 2]!;
  if (op === ReOp.CPCLASS) {
    const cp = forwardCodePoint(input, sp);
    if (cp < 0 || !classMatch(classTable, a, cp, b !== 0)) return false;
    if (cp > 0xffff) addThread(prog, input, next, n + t.state, t.caps, sp + 1);
    else addThread(prog, input, next, t.state + 1, t.caps, sp + 1);
  } else if (unitMatches(op, a, b, classTable, input.charCodeAt(sp))) {
    addThread(prog, input, next, t.state + 1, t.caps, sp + 1);
  }
  return false;
}

/**
 * Leftmost-first search from `startIdx` (only `startIdx` itself when
 * `sticky`). Returns the capture array (`nSlots` slots, -1 = unset) of the
 * match the backtracking VM would report, or null when there is none.
 */
export function searchLinear(
  prog: number[],
  classTable: number[],
  nSlots: number,
  input: string,
  startIdx: number,
  sticky: boolean,
): Int32Array | null {
  const len = input.length;
  const start = Math.max(0, startIdx);
  // Admission stamps: the list for position p stamps its states with p + 1.
  const seen = new Int32Array((2 * prog.length) / INSTR_WIDTH);
  let current = new ThreadList(seen, start + 1);
  let matched: Int32Array | null = null;
  for (let sp = start; sp <= len; sp++) {
    // A new attempt starting here has the lowest priority of all live threads.
    if (matched === null && (!sticky || sp === start)) {
      addThread(prog, input, current, 0, new Int32Array(nSlots).fill(-1), sp);
    }
    if (current.threads.length === 0 && (matched !== null || sticky)) break;
    const next = new ThreadList(seen, sp + 2);
    for (const t of current.threads) {
      if (step(prog, classTable, input, t, sp, next)) {
        matched = t.caps;
        break;
      }
    }
    current = next;
  }
  return matched;
}
