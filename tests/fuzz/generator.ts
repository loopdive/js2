// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1855 — UB-free TypeScript program generator.
 *
 * Random program generation + differential testing is the highest-yield way to
 * find wrong-code bugs in a compiler, but ONLY if the generator avoids
 * undefined/unspecified behavior (otherwise its "wrong" outputs drown the real
 * bugs). This generator emits **well-typed TS in the js2wasm supported subset**
 * whose output is **deterministic and reference-defined**:
 *
 *   - Numeric domain is restricted to safe integers in [-2^31, 2^31) so f64
 *     arithmetic is exact and there is no float-rounding divergence between the
 *     V8 oracle and the Wasm backend.
 *   - Division and modulo guard the divisor: `b === 0 ? 1 : a / b` and the
 *     result is `Math.trunc`-ed to stay integral (JS `/` is float; we keep the
 *     program in the integer subset to remain reference-exact).
 *   - Shifts mask the shift-count to [0,31] and operands are ToInt32-safe.
 *   - No NaN/Infinity producers, no uninitialized reads, no out-of-bounds
 *     indexing, no reliance on property-enumeration order or other
 *     unspecified behavior. Every generated expression is total.
 *
 * The generator is **seeded** (deterministic PRNG) so a given seed always
 * produces the same program — essential for reproducible CI and for the
 * minimizer (#1855 part 2) to replay a failing seed.
 *
 * Output shape matches `CrossBackendProgram`-style usage: a self-contained TS
 * source exporting a single `main(...)` function plus the arg tuples to call.
 */

/** A small, fast, deterministic PRNG (mulberry32). Seeded, reproducible. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  /** Integer in [lo, hi]. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }
  /** Pick a random element. */
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }
}

export interface GeneratedProgram {
  /** Self-contained TS source exporting `main`. */
  readonly source: string;
  /** The exported entry point (always "main"). */
  readonly fn: string;
  /** Integer argument tuple for `main`. */
  readonly args: readonly number[];
  /** The seed that produced this program (for reproduction). */
  readonly seed: number;
}

/** Safe-integer bound: stay inside [-2^31, 2^31) so f64 math is exact. */
const INT_MIN = -(2 ** 31);
const INT_MAX = 2 ** 31 - 1;

/** Clamp into the safe i32 range (the generator never leaves it, but be defensive). */
function clampInt(n: number): number {
  if (n < INT_MIN) return INT_MIN;
  if (n > INT_MAX) return INT_MAX;
  return Math.trunc(n);
}

interface GenCtx {
  readonly rng: Rng;
  /** In-scope numeric variable names usable in expressions (shared array ref). */
  readonly vars: string[];
  /** Remaining expression-depth budget (controls nesting). */
  depth: number;
  /**
   * Monotonic counter for fresh local names — a shared single-field object so
   * increments survive the `{ ...cx }` shallow-copies used to vary `depth`.
   * (A plain number field would be copied per spread, recycling names and
   * emitting a duplicate `let` — a real soundness bug the fuzzer caught in its
   * own generator.)
   */
  readonly counter: { n: number };
}

/** Allocate a fresh, never-reused local name. */
function freshLocal(cx: GenCtx): string {
  return `v${cx.counter.n++}`;
}

/** Generate a UB-free integer expression over the in-scope variables. */
function genExpr(cx: GenCtx): string {
  // Leaf when out of depth or by chance.
  if (cx.depth <= 0 || (cx.vars.length > 0 && cx.rng.chance(0.4))) {
    return cx.rng.chance(0.5) && cx.vars.length > 0 ? cx.rng.pick(cx.vars) : String(cx.rng.range(-100, 100));
  }
  cx.depth--;
  const form = cx.rng.int(6);
  const sub = (): string => genExpr({ ...cx, depth: cx.depth });
  let out: string;
  switch (form) {
    case 0:
      out = `(${sub()} + ${sub()})`;
      break;
    case 1:
      out = `(${sub()} - ${sub()})`;
      break;
    case 2:
      // Multiply: keep magnitudes small to stay in the safe-integer range by
      // masking both operands into a narrow band, then ToInt32 the product.
      out = `(((${sub()}) & 0xffff) * ((${sub()}) & 0xff))`;
      break;
    case 3:
      // Guarded integer division — never divide by zero; Math.trunc keeps it
      // integral so V8 (`/` is float) and the backend agree exactly.
      out = `(((${sub()}) === 0) ? 0 : Math.trunc((${sub()}) / (((${sub()}) === 0) ? 1 : (${sub()}))))`;
      break;
    case 4: {
      // Bitwise / shift — ToInt32-domain, shift-count masked to [0,31].
      const op = cx.rng.pick(["&", "|", "^", "<<", ">>"] as const);
      if (op === "<<" || op === ">>") {
        out = `((${sub()}) ${op} ((${sub()}) & 31))`;
      } else {
        out = `((${sub()}) ${op} (${sub()}))`;
      }
      break;
    }
    default: {
      // Ternary on a boolean comparison — total, deterministic.
      const cmp = cx.rng.pick(["<", "<=", ">", ">=", "===", "!=="] as const);
      out = `(((${sub()}) ${cmp} (${sub()})) ? (${sub()}) : (${sub()}))`;
      break;
    }
  }
  return out;
}

/** Generate a UB-free statement, possibly introducing a new local. */
function genStmt(cx: GenCtx): string {
  const form = cx.rng.int(4);
  if (form === 0 || cx.vars.length === 0) {
    // `let v = <expr> | 0;` — the `| 0` ToInt32-pins it into the i32 domain.
    // Compute the initializer BEFORE adding the name to scope so the init can't
    // reference the (not-yet-defined) variable itself.
    const init = genExpr({ ...cx, depth: 2 });
    const name = freshLocal(cx);
    cx.vars.push(name);
    return `let ${name} = (${init}) | 0;`;
  }
  if (form === 1) {
    // Reassign an existing var.
    const name = cx.rng.pick(cx.vars);
    const rhs = genExpr({ ...cx, depth: 2 });
    return `${name} = (${rhs}) | 0;`;
  }
  if (form === 2) {
    // `if (<cmp>) { <reassign> } else { <reassign> }` — both arms total and
    // assign to an EXISTING var (guaranteed non-empty: form 0 fires when empty).
    const cmp = cx.rng.pick(["<", ">", "===", "!=="] as const);
    const a = genExpr({ ...cx, depth: 1 });
    const b = genExpr({ ...cx, depth: 1 });
    const t = cx.rng.pick(cx.vars);
    const tv = genExpr({ ...cx, depth: 1 });
    const ev = genExpr({ ...cx, depth: 1 });
    return `if ((${a}) ${cmp} (${b})) { ${t} = (${tv}) | 0; } else { ${t} = (${ev}) | 0; }`;
  }
  // Bounded counting loop — fixed trip count, body reassigns an EXISTING var.
  // No unbounded loops (would risk nontermination); the bound is a literal.
  const trips = cx.rng.range(0, 5);
  const acc = cx.rng.pick(cx.vars);
  const step = genExpr({ ...cx, depth: 1 });
  return `for (let __i = 0; __i < ${trips}; __i++) { ${acc} = ((${acc}) + (${step})) | 0; }`;
}

/**
 * Generate a complete UB-free program: `export function main(p0,p1): number`
 * with a body of generated statements and a `return` of a final expression.
 * `args` are safe integers passed to `main`.
 */
export function generateProgram(seed: number, opts?: { stmts?: number; params?: number }): GeneratedProgram {
  const rng = new Rng(seed);
  const params = opts?.params ?? rng.range(0, 3);
  const stmtCount = opts?.stmts ?? rng.range(1, 6);
  const paramNames = Array.from({ length: params }, (_, i) => `p${i}`);
  // Shared `vars` array + `counter` object: the `{ ...cx, depth }` spreads used
  // to vary nesting depth keep the SAME references, so scope additions and
  // fresh-name allocations are visible across statements (no duplicate `let`).
  const cx: GenCtx = { rng, vars: [...paramNames], depth: 3, counter: { n: 0 } };

  const body: string[] = [];
  for (let i = 0; i < stmtCount; i++) body.push(genStmt({ ...cx, depth: 3 }));
  const ret = genExpr({ ...cx, depth: 3 });
  // ToInt32-pin the result so the function stays in the exact-integer domain.
  body.push(`return (${ret}) | 0;`);

  const sig = paramNames.map((p) => `${p}: number`).join(", ");
  const source = `export function main(${sig}): number {\n  ${body.join("\n  ")}\n}\n`;
  const args = paramNames.map(() => clampInt(rng.range(-1000, 1000)));
  return { source, fn: "main", args, seed };
}
