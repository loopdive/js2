// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4780 — a STRUCTURAL floor under all three devirtualization admission routes.
 *
 * ## What this file is for
 *
 * `ad543a660e` killed route (c) — `recv.m()` on a proven non-`this` receiver —
 * for three days on `main`, at **28.5x** on the `method` axis, behind six green
 * required checks (#4775). Three safety nets were present and none fired:
 *
 *   - the six required checks run no perf measurement, by design;
 *   - `tests/issue-3754-numeric-return-twin.test.ts` DID go red, but sat in no
 *     gating lane, so nobody saw it;
 *   - the acorn dogfood corpus is **structurally blind** to route (c): its
 *     devirtualized sites are all `this.m()` (routes a/b), so its census
 *     (`sites=3976 trampolines=545 twinFills=516 …`) is byte-identical with and
 *     without the regression. A corpus is evidence only for the routes it
 *     traverses (#4157 entry 22).
 *
 * This file is the third net, made deterministic: it pins each route SEPARATELY
 * by reading the emitted WAT, and it is listed in `tests/guard-suite.json`, so
 * it runs in the required `quality` job on every PR, merge group and push — not
 * only when someone edits this file. The regression that motivates it was
 * caused by an edit ~1400 lines away in a file this test does not name, which
 * is precisely the shape `test:changed-root` cannot select for.
 *
 * ## Why structure and not a wall-clock floor
 *
 * A timing floor is what the 28.5x reads as, but structure is what actually
 * changed, and structure is deterministic: no noise budget, no shared-runner
 * flake, ~2s per fixture. Byte-for-byte, the assertions below go red on
 * `ad543a660e`'s try-order (verified by reintroducing it — see the issue file's
 * implementation record). The perf-shaped failure mode that structure could
 * MISS — a trampoline that is reserved but silently degrades to the legacy
 * dispatcher at fill time, #3754's point 2, "green but pointless" — is covered
 * too: each trampoline body is asserted to reach a typed twin.
 *
 * ## The three routes, and how each is identified in WAT
 *
 * `tryEmitDirectTwinCall` (`src/codegen/typed-this.ts`) admits through three
 * independent routes, which fail independently:
 *
 *   (a) `this.m()` inside a TYPED TWIN. The receiver-shape proof is the twin's
 *       own `ref.cast`, so the trampoline is emitted UNGUARDED — no `_g`
 *       suffix. Unguarded is exclusive to (a): routes (b) and (c) both set
 *       `guardedReceiver`, so the name alone identifies this route.
 *   (b) `this.m()` inside the GENERIC LIFTED BODY of a pinned prototype method
 *       (#3780). Guarded (`_g`). Identified by its CALLER: a function `N` for
 *       which the module also declares the twin `N__typed_this`.
 *   (c) `recv.m()` on a receiver the flow analysis proves is one approved
 *       fnctor class (#3685 S3). Guarded (`_g`). Identified by its caller being
 *       a plain user function whose source contains no `this` at all — so a
 *       devirtualized call from it can only have come through (c).
 *
 * The caller-class identification in (b)/(c) is fixture-controlled, not a
 * general decision procedure: these fixtures' method bodies contain only
 * `this.m()` calls and `inner` contains only `recv.m()` calls, so there is
 * exactly one route each call could have taken.
 *
 * ## Flag lanes
 *
 * Two, deliberately:
 *
 *   - **Shipped default** — the IR inliner inlines `__dc_*` trampolines
 *     unconditionally (its rule 3, #4157), so at the default the `call $__dc_*`
 *     EDGE is gone from the call site while the trampoline function itself is
 *     still emitted. So the default-lane tests assert (i) the trampoline exists
 *     and (ii) the call site carries none of the dynamic ladder. Both flip
 *     under the regression.
 *   - **`JS2WASM_IR_INLINE=0`** — with the inliner off the call edge survives,
 *     which is what makes per-route attribution readable at all. Pinned per
 *     compile (not file-wide) so the default lane stays genuinely default.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * The `method` axis, verbatim from `benchmarks/cross-engine/axes-core.js` —
 * the axis that read 25.7 ms instead of 0.92 ms for three days.
 *
 * The inner/exported split is load-bearing: `new P(0)` directly inside an
 * EXPORTED function is a construction the escape gate cannot close over, so no
 * trampoline is reserved at all and there is nothing to observe.
 *
 * Route (c) only — `inner` has no `this`, and `inc`'s body calls nothing.
 */
const METHOD_AXIS = `
  function P(v) { this.v = v; }
  P.prototype.inc = function () { this.v = this.v + 1; return this.v; };
  function inner() {
    var p = new P(0);
    var s = 0;
    for (var i = 0; i < 20; i++) { s = s + p.inc(); }
    return s;
  }
  export function run() { return inner(); }
`;
/** 1+2+…+20 */
const METHOD_AXIS_VALUE = 210;

/**
 * All three routes in ONE module: `twice` calls `this.inc()` (routes a and b,
 * from its twin and from its generic lifted body), and `inner` calls
 * `p.twice()` on a fnctor local (route c).
 */
const ALL_ROUTES = `
  function P(v) { this.v = v; }
  P.prototype.inc = function () { this.v = this.v + 1; return this.v; };
  P.prototype.twice = function () { return this.inc() + this.inc(); };
  function inner() {
    var p = new P(0);
    var s = 0;
    for (var i = 0; i < 20; i++) { s = s + p.twice(); }
    return s;
  }
  export function run() { return inner(); }
`;
/** 40 increments in total: 1+2+…+40 */
const ALL_ROUTES_VALUE = 820;

/**
 * The negative control. Two classes flow into `opaque`'s parameter, so the
 * receiver-flow analysis cannot prove a single approved class and route (c)
 * must DECLINE — the call keeps the dynamic ladder.
 *
 * Without this, "the ladder is absent" and "a trampoline exists" could both be
 * satisfied by a compiler that devirtualized indiscriminately, which would be
 * unsound rather than fast.
 */
const TWO_CLASS = `
  function P(v) { this.v = v; }
  P.prototype.inc = function () { this.v = this.v + 1; return this.v; };
  function Q(v) { this.v = v; }
  Q.prototype.inc = function () { this.v = this.v + 10; return this.v; };
  function opaque(o) { return o.inc(); }
  function inner() { var p = new P(1); var q = new Q(2); return opaque(p) + opaque(q); }
  export function run() { return inner(); }
`;
/** (1+1) + (2+10) */
const TWO_CLASS_VALUE = 14;

async function build(src: string, env: Record<string, string> = {}) {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    const result = await compile(src, {
      fileName: "axes.mjs",
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    return result;
  } finally {
    for (const [k, v] of saved) {
      // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Compile with the IR inliner off, so `call $__dc_*` edges survive. */
const buildNoInline = (src: string) => build(src, { JS2WASM_IR_INLINE: "0" });

/**
 * A resolved view of one module's WAT. Call targets print as numeric indices
 * (`call 206`), so every body is returned with those rewritten to `call $name`.
 */
function readWat(wat: string) {
  const lines = wat.split("\n");
  const funcNames: string[] = [];
  const declLine = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const fn = lines[i]!.match(/^\s*\(func \$(\S+)/);
    if (fn) {
      funcNames.push(fn[1]!);
      declLine.set(fn[1]!, i);
    }
  }
  const bodyAt = (name: string): string => {
    const out: string[] = [];
    for (let i = declLine.get(name)! + 1; i < lines.length; i++) {
      if (/^\s*\(func \$/.test(lines[i]!)) break;
      out.push(lines[i]!.trim());
    }
    return out
      .join("\n")
      .replace(/\b(return_call|call) (\d+)\b/g, (_m, op, idx) => `${op} $${funcNames[Number(idx)] ?? idx}`);
  };
  const names = (): string[] => funcNames;
  const body = (name: string): string => (declLine.has(name) ? bodyAt(name) : "");
  /** Reserved direct-call trampolines. `__dc_self_*` is a different mechanism. */
  const trampolines = (): string[] => funcNames.filter((n) => n.startsWith("__dc_") && !n.startsWith("__dc_self_"));
  /** Every function that emits a `call $__dc_…`, excluding trampolines themselves. */
  const callersOfTrampolines = (): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const n of funcNames) {
      if (n.startsWith("__dc_")) continue;
      const hits = [...new Set([...bodyAt(n).matchAll(/call \$(__dc_[^\s)]+)/g)].map((m) => m[1]!))];
      if (hits.length > 0) out.set(n, hits);
    }
    return out;
  };
  /** Generic lifted bodies: `N` such that the twin `N__typed_this` also exists. */
  const genericLiftedBodies = (): string[] =>
    funcNames.filter((n) => !/__typed_this$/.test(n) && declLine.has(`${n}__typed_this`));
  return {
    names,
    body,
    trampolines,
    callersOfTrampolines,
    genericLiftedBodies,
  };
}

/**
 * The dynamic ladder `compileCallablePropertyCall` falls through to — what a
 * de-devirtualized site emits instead. Measured on the reintroduced regression:
 * `inner` grew `local $__fsd_recv_*` / `$__fsd_args_*` and a
 * `call $__extern_method_call`.
 */
const DYNAMIC_LADDER = /call \$__extern_method_call|\$__fsd_recv|\$__fsd_args|call \$__fsd_/;

const runOf = async (r: { binary: Uint8Array }): Promise<number> =>
  (
    (await WebAssembly.instantiate(r.binary, {})).instance.exports as {
      run(): number;
    }
  ).run();

describe("#4780 — devirtualization admission routes have a structural floor", () => {
  describe("shipped default flags", () => {
    it("route (c): the method axis reserves a trampoline and its call site carries no dynamic ladder", async () => {
      // The exact pair that flipped on `ad543a660e`: the trampoline vanished
      // and `inner` grew the `__fsd_*` / `__extern_method_call` ladder.
      const { wat } = await build(METHOD_AXIS);
      const m = readWat(wat!);
      expect(m.trampolines(), "route (c) reserved no trampoline at all").toContain("__dc_P_inc_0_g");
      expect(m.body("inner"), "the call site fell back to the dynamic ladder").not.toMatch(DYNAMIC_LADDER);
    });

    it("route (c) still computes the same value", async () => {
      expect(await runOf(await build(METHOD_AXIS))).toBe(METHOD_AXIS_VALUE);
    });

    it("an UNPROVABLE receiver still declines — the pins above are not vacuous", async () => {
      // Two classes reach `opaque`'s parameter, so no single approved class can
      // be proven. Devirtualizing here would be unsound, not fast.
      const { wat, binary } = await build(TWO_CLASS);
      const m = readWat(wat!);
      expect(m.trampolines(), "an unprovable receiver must not devirtualize").toEqual([]);
      expect(m.body("opaque"), "the declined call must keep the dynamic ladder").toMatch(DYNAMIC_LADDER);
      expect(await runOf({ binary })).toBe(TWO_CLASS_VALUE);
    });
  });

  describe("with the IR inliner pinned off — per-route call edges", () => {
    it("route (c): `inner` calls the guarded trampoline directly", async () => {
      const { wat } = await build(METHOD_AXIS, { JS2WASM_IR_INLINE: "0" });
      const m = readWat(wat!);
      // `inner`'s source has no `this`, so this edge can only be route (c).
      expect(m.body("inner")).toMatch(/call \$__dc_P_inc_0_g/);
      expect(m.body("inner")).not.toMatch(DYNAMIC_LADDER);
    });

    it("route (a): a typed twin calls the UNGUARDED trampoline", async () => {
      const { wat } = await buildNoInline(ALL_ROUTES);
      const m = readWat(wat!);
      const twinCallers = [...m.callersOfTrampolines()].filter(([n]) => /__typed_this$/.test(n));
      expect(twinCallers.length, "no typed twin devirtualized its own `this.m()`").toBeGreaterThan(0);
      // Unguarded — no `_g` — is exclusive to route (a).
      expect(twinCallers.flatMap(([, targets]) => targets)).toContain("__dc_P_inc_0");
    });

    it("route (b): a generic lifted body calls the GUARDED trampoline", async () => {
      const { wat } = await buildNoInline(ALL_ROUTES);
      const m = readWat(wat!);
      const generic = new Set(m.genericLiftedBodies());
      const genericCallers = [...m.callersOfTrampolines()].filter(([n]) => generic.has(n));
      expect(genericCallers.length, "no generic lifted body devirtualized its own `this.m()`").toBeGreaterThan(0);
      expect(genericCallers.flatMap(([, targets]) => targets)).toContain("__dc_P_inc_0_g");
    });

    it("all three routes are live in ONE module — the coverage acorn cannot give", async () => {
      // The point of the fixture: acorn devirtualizes almost entirely through
      // (a)/(b), so its census carries no information about (c). This asserts
      // the three are observed together, so a future change that silently
      // retires one of them cannot hide behind the other two.
      const { wat, binary } = await buildNoInline(ALL_ROUTES);
      const m = readWat(wat!);
      const generic = new Set(m.genericLiftedBodies());
      const routes = new Set<string>();
      for (const [caller, targets] of m.callersOfTrampolines()) {
        if (/__typed_this$/.test(caller) && targets.some((t) => !t.endsWith("_g"))) routes.add("a");
        else if (generic.has(caller) && targets.some((t) => t.endsWith("_g"))) routes.add("b");
        else if (caller === "inner" && targets.some((t) => t.endsWith("_g"))) routes.add("c");
      }
      expect([...routes].sort()).toEqual(["a", "b", "c"]);
      expect(await runOf({ binary })).toBe(ALL_ROUTES_VALUE);
    });

    it("every trampoline reaches a typed twin — not a silent legacy degradation", async () => {
      // #3754 point 2: a trampoline whose fill sees a signature disagreement
      // degrades to `__call_m_*` + unbox for EVERY site. That is green (the
      // trampoline exists, the call edge exists) and pointless, so trampoline
      // existence alone is not enough. A guarded trampoline legitimately
      // carries `__call_m_*` in its ELSE arm; what a degraded one lacks is the
      // twin call.
      const { wat } = await buildNoInline(ALL_ROUTES);
      const m = readWat(wat!);
      expect(m.trampolines().length).toBeGreaterThan(0);
      for (const t of m.trampolines()) {
        expect(m.body(t), `${t} degraded to the legacy dispatcher`).toMatch(/call \$\S+__typed_this/);
      }
    });
  });
});
