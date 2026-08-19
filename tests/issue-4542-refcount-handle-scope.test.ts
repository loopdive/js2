// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4542 — refcount discipline for the linear lane's boxed tier.
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT.
//
// The issue's headline acceptance criteria are heap measurements: a stress
// fixture whose heap stays flat over iterations, the same under throw and early
// return, plus differential execution against Node. Those need the pinned
// QuickJS artifact linked in, and they live in
// `tests/issue-4542-refcount-heap-stress.test.ts`, gated on the artifact being
// present.
//
// This file asserts the discipline itself, on the EMITTED SEQUENCE, which needs
// no engine: that a dup/free lands at each required point on each path out of a
// scope; that every path releases exactly once (checked by an independent
// balance verifier, not by re-reading the pass's own bookkeeping); that a
// `consumes` import gets no extra release; that an import with no ownership
// annotation is a refusal rather than a default; and — the negative half — that
// the harness FAILS on a deliberately broken program, so a green result means
// something.

import { describe, expect, it } from "vitest";
import type { ExternCImportSpec, ExternCValType } from "../src/codegen-linear/c-abi.js";
import {
  type HandleFunction,
  type HandleStmt,
  type RefcountRuntime,
  OwnershipAnnotationError,
  HandleScopeError,
  countCalls,
  flattenInstrs,
  formatHandleStmts,
  insertHandleScopes,
  lowerHandleFunction,
  pinnedShimImports,
  requireOwnershipAnnotations,
  resolveImportOwnership,
  verifyRefcountBalance,
  walk,
} from "../src/codegen-linear/refcount/index.js";

// ── The import table under test ─────────────────────────────────────────
// Shapes are the QuickJS ones this tier will actually call.

const PTR: ExternCValType = { address: "ptr" };
const HANDLE: ExternCValType = { address: "handle" };
const I32: ExternCValType = { kind: "i32" };

const IMPORTS: ExternCImportSpec[] = [
  // JSValue JS_GetPropertyStr(JSContext *, JSValue, const char *) -> +1
  {
    module: "qjs",
    name: "get_prop",
    params: [PTR, HANDLE, PTR],
    results: [HANDLE],
    ownership: { args: "borrows", result: "owned" },
  },
  // JSValue JS_NewObject(JSContext *) -> +1
  {
    module: "qjs",
    name: "new_object",
    params: [PTR],
    results: [HANDLE],
    ownership: { args: "borrows", result: "owned" },
  },
  // int JS_SetPropertyStr(JSContext *, JSValue, const char *, JSValue val)
  // — takes the reference to `val` on every outcome, including failure.
  {
    module: "qjs",
    name: "set_prop",
    params: [PTR, HANDLE, PTR, HANDLE],
    results: [I32],
    ownership: {
      args: ["borrows", "borrows", "borrows", "consumes"],
      result: "none",
    },
  },
  // A borrowed accessor: exposes an interior handle without a reference.
  {
    module: "qjs",
    name: "peek_slot",
    params: [PTR, HANDLE],
    results: [HANDLE],
    ownership: {
      args: "borrows",
      result: "borrowed",
      throws: false,
      releasesContainerSlots: false,
    },
  },
  // A pure read that cannot throw and cannot drop anything.
  {
    module: "qjs",
    name: "read_len",
    params: [PTR, HANDLE],
    results: [I32],
    ownership: {
      args: "borrows",
      result: "none",
      throws: false,
      releasesContainerSlots: false,
    },
  },
  // A call into user code: borrows, can throw, can write container slots.
  {
    module: "qjs",
    name: "call_fn",
    params: [PTR, HANDLE],
    results: [I32],
    ownership: { args: "borrows", result: "none" },
  },
  // Not an engine import at all — no JSValue crosses this boundary.
  { module: "cpeer", name: "c_double", params: [I32], results: [I32] },
];

const TABLE = requireOwnershipAnnotations(IMPORTS);

// Handle ids used throughout: h1 is the (borrowed) receiver parameter.
const RECV = 1;

function fn(body: HandleStmt[], overrides: Partial<HandleFunction> = {}): HandleFunction {
  return {
    name: "f",
    params: [{ id: RECV, ownership: "borrowed", name: "this" }],
    result: "none",
    body,
    ...overrides,
  };
}

const getProp = (dest: number, binding?: boolean): HandleStmt => ({
  kind: "call",
  callee: "get_prop",
  args: [null, RECV, null],
  dest,
  binding,
});
const peek = (dest: number, binding?: boolean): HandleStmt => ({
  kind: "call",
  callee: "peek_slot",
  args: [null, RECV],
  dest,
  binding,
});
const callFn = (h: number = RECV): HandleStmt => ({
  kind: "call",
  callee: "call_fn",
  args: [null, h],
});
const readLen = (h: number = RECV): HandleStmt => ({
  kind: "call",
  callee: "read_len",
  args: [null, h],
});
const setProp = (target: number, value: number): HandleStmt => ({
  kind: "call",
  callee: "set_prop",
  args: [null, target, null, value],
});

/** Run the pass and assert it produced a balanced program on every path. */
function pass(func: HandleFunction): HandleFunction {
  const result = insertHandleScopes(func, TABLE);
  expect(result.diagnostics).toEqual([]);
  const findings = verifyRefcountBalance(result.func, TABLE);
  expect(findings.map((f) => `${f.kind}: ${f.message}`)).toEqual([]);
  return result.func;
}

const frees = (body: readonly HandleStmt[]) => [...walk(body)].filter((s) => s.kind === "free");
const dups = (body: readonly HandleStmt[]) => [...walk(body)].filter((s) => s.kind === "dup");
const cleanups = (body: readonly HandleStmt[]) => [...walk(body)].filter((s) => s.kind === "cleanup");

// ════════════════════════════════════════════════════════════════════════
describe("#4542 — ownership annotations are required, never defaulted", () => {
  it("an import carrying handles with no annotation is a refusal", () => {
    const spec: ExternCImportSpec = {
      module: "qjs",
      name: "mystery",
      params: [PTR, HANDLE],
      results: [I32],
    };
    expect(() => resolveImportOwnership(spec)).toThrow(OwnershipAnnotationError);
    expect(() => resolveImportOwnership(spec)).toThrow(/no ownership annotation/);
    // The refusal must say WHY there is no default, or the next reader adds one.
    expect(() => resolveImportOwnership(spec)).toThrow(/no default/);
  });

  it("the borrows/consumes shorthand is refused on a handle-RETURNING import", () => {
    // The shorthand states only what happens to the arguments. Accepting it
    // here would silently pick a result ownership, which is the exact class of
    // wrong default the field exists to prevent.
    const spec: ExternCImportSpec = {
      module: "qjs",
      name: "returns_handle",
      params: [PTR],
      results: [HANDLE],
      ownership: "borrows",
    };
    expect(() => resolveImportOwnership(spec)).toThrow(/cannot be used here/);
  });

  it("an import with no JSValue in its signature needs no annotation", () => {
    // Scope refinement recorded in ownership.ts: nothing is owned, so there is
    // nothing an annotation could say, and demanding one trains people to write
    // one without thinking.
    const resolved = resolveImportOwnership({
      module: "cpeer",
      name: "c_double",
      params: [I32],
      results: [I32],
    });
    expect(resolved.result).toBe("none");
    expect(resolved.throws).toBe(false);
    expect(resolved.args).toEqual(["borrows"]);
  });

  it("a positional args array must cover every parameter", () => {
    const spec: ExternCImportSpec = {
      module: "qjs",
      name: "short_array",
      params: [PTR, HANDLE, HANDLE],
      results: [I32],
      // Intent was "the second handle is consumed"; a short array shifts it.
      ownership: { args: ["borrows", "consumes"], result: "none" },
    };
    expect(() => resolveImportOwnership(spec)).toThrow(/must cover every position/);
  });

  it("'consumes' on a non-handle parameter is refused", () => {
    const spec: ExternCImportSpec = {
      module: "qjs",
      name: "bad_consume",
      params: [PTR, I32],
      results: [I32],
      ownership: { args: ["borrows", "consumes"], result: "none" },
    };
    expect(() => resolveImportOwnership(spec)).toThrow(/is not a handle/);
  });

  it("a declared result ownership must agree with the signature", () => {
    expect(() =>
      resolveImportOwnership({
        module: "qjs",
        name: "no_result",
        params: [PTR, HANDLE],
        results: [I32],
        ownership: { args: "borrows", result: "owned" },
      }),
    ).toThrow(/returns no handle/);
    expect(() =>
      resolveImportOwnership({
        module: "qjs",
        name: "has_result",
        params: [PTR],
        results: [HANDLE],
        ownership: { args: "borrows", result: "none" },
      }),
    ).toThrow(/returns a handle-typed result/);
  });

  it("only the two SAFETY axes are derived, and only toward the conservative value", () => {
    const resolved = resolveImportOwnership({
      module: "qjs",
      name: "shorthand",
      params: [PTR, HANDLE],
      results: [I32],
      ownership: "consumes",
    });
    expect(resolved.args).toEqual(["borrows", "consumes"]); // the ptr is not a handle
    expect(resolved.throws).toBe(true); // an extra cleanup handler, never a missed one
    expect(resolved.releasesContainerSlots).toBe(true); // keep the pair, never elide wrongly
  });

  it("the pass refuses a callee that is not in the table", () => {
    expect(() => insertHandleScopes(fn([{ kind: "call", callee: "unknown", args: [] }]), TABLE)).toThrow(
      HandleScopeError,
    );
    expect(() => insertHandleScopes(fn([{ kind: "call", callee: "unknown", args: [] }]), TABLE)).toThrow(
      /no ownership annotation/,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("#4542 — normal path: acquire owns, scope releases", () => {
  it("an owned result acquired with nothing after it needs no cleanup region", () => {
    const out = pass(fn([getProp(2)]));
    expect(formatHandleStmts(out.body)).toEqual(["call get_prop(_, h1, _) -> h2", "free h2 (scope-exit)"]);
    expect(cleanups(out.body)).toHaveLength(0);
  });

  it("a throwing call AFTER the acquisition opens a cleanup region for it", () => {
    const out = pass(fn([getProp(2), callFn()]));
    expect(formatHandleStmts(out.body)).toEqual([
      "call get_prop(_, h1, _) -> h2",
      "cleanup h2 {",
      "  call call_fn(_, h1)",
      "} unwind {",
      "  free h2 (unwind)",
      "}",
      "free h2 (scope-exit)",
    ]);
  });

  it("a NON-throwing call after the acquisition opens no region", () => {
    const out = pass(fn([getProp(2), readLen()]));
    expect(cleanups(out.body)).toHaveLength(0);
    expect(frees(out.body)).toHaveLength(1);
  });

  it("two acquisitions nest their regions and release in reverse order", () => {
    const out = pass(fn([getProp(2), getProp(3), callFn()]));
    const text = formatHandleStmts(out.body);
    // h3's region is INSIDE h2's, so a throw at call_fn frees h3 then h2 —
    // and a throw at the second get_prop frees only h2, which is the whole
    // reason the regions are per-handle rather than per-scope.
    expect(text).toEqual([
      "call get_prop(_, h1, _) -> h2",
      "cleanup h2 {",
      "  call get_prop(_, h1, _) -> h3",
      "  cleanup h3 {",
      "    call call_fn(_, h1)",
      "  } unwind {",
      "    free h3 (unwind)",
      "  }",
      "  free h3 (scope-exit)",
      "} unwind {",
      "  free h2 (unwind)",
      "}",
      "free h2 (scope-exit)",
    ]);
  });

  it("a borrowed result read through immediately costs no refcount traffic", () => {
    const out = pass(fn([peek(2), { kind: "use", value: 2 }]));
    expect(dups(out.body)).toHaveLength(0);
    expect(frees(out.body)).toHaveLength(0);
  });

  it("a borrowed result RETAINED as a binding is duplicated first", () => {
    // The elision safety condition applied at the point the reference is made:
    // the proposed owner is a container slot, and any engine call in the region
    // can invalidate it. So we take a reference of our own.
    const out = pass(fn([peek(2, true), callFn()]));
    expect(formatHandleStmts(out.body)).toEqual([
      "call peek_slot(_, h1) -> h2 [binding]",
      // The dup produces a NEW handle (h3): the pinned shim boxes the
      // duplicated JSValue into its own cell, so the owned copy is a distinct
      // resource with its own single release. h2 stays a borrow and is never
      // freed by us.
      "dup h2 -> h3 (retain-borrowed)",
      "cleanup h3 {",
      "  call call_fn(_, h1)",
      "} unwind {",
      "  free h3 (unwind)",
      "}",
      "free h3 (scope-exit)",
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("#4542 — every exit edge releases", () => {
  it("an early return releases every frame, innermost first", () => {
    const out = pass(fn([getProp(2), { kind: "scope", body: [getProp(3), { kind: "return" }] }, callFn()]));
    const returnPath = formatHandleStmts(out.body).join("\n");
    expect(returnPath).toContain("free h3 (return)");
    expect(returnPath).toContain("free h2 (return)");
    expect(returnPath.indexOf("free h3 (return)")).toBeLessThan(returnPath.indexOf("free h2 (return)"));
  });

  it("break releases the frames it leaves, and only those", () => {
    const out = pass(
      fn([
        getProp(2),
        {
          kind: "block",
          label: "B",
          body: [getProp(3), { kind: "if", then: [{ kind: "break", label: "B" }] }, { kind: "use", value: 3 }],
        },
        callFn(),
      ]),
    );
    const text = formatHandleStmts(out.body).join("\n");
    // h3 lives in the block; h2 lives outside it and must SURVIVE the break.
    expect(text).toContain("free h3 (break)");
    expect(text).not.toContain("free h2 (break)");
  });

  it("continue releases the loop body's frame, once per iteration", () => {
    const out = pass(
      fn([
        {
          kind: "loop",
          label: "L",
          body: [getProp(2), { kind: "use", value: 2 }, { kind: "continue", label: "L" }],
        },
      ]),
    );
    expect(formatHandleStmts(out.body)).toEqual([
      "loop L {",
      "  call get_prop(_, h1, _) -> h2",
      "  use h2",
      "  free h2 (continue)",
      "  continue L",
      "}",
    ]);
    // The static analogue of the flat-heap fixture: reference counts at the
    // back edge equal those on entry, so repeating cannot grow the held set.
    expect(verifyRefcountBalance(out, TABLE)).toEqual([]);
  });

  it("an explicit throw hands one reference to the exception and lets the handlers release", () => {
    const out = pass(fn([getProp(2), getProp(3), { kind: "throw", value: 3 }]));
    const text = formatHandleStmts(out.body).join("\n");
    expect(text).toContain("dup h3 -> h4 (throw-transfer)");
    expect(text).toContain("throw h4");
    // NO explicit frees at the throw. The enclosing cleanup regions are the one
    // unwind path; emitting frees here as well would double-release.
    expect(text).not.toContain("free h3 (return)");
    expect(text).toContain("free h3 (unwind)");
    expect(text).toContain("free h2 (unwind)");
  });

  it("the unwind path is covered for a throw raised INSIDE a nested region", () => {
    const out = pass(
      fn([
        getProp(2),
        {
          kind: "block",
          label: "B",
          body: [getProp(3), { kind: "if", then: [callFn()], else: [readLen()] }],
        },
      ]),
    );
    // Both handles must be released on the exceptional path, in reverse order,
    // through two nested handlers.
    const findings = verifyRefcountBalance(out, TABLE);
    expect(findings).toEqual([]);
    const text = formatHandleStmts(out.body).join("\n");
    expect(text).toContain("free h3 (unwind)");
    expect(text).toContain("free h2 (unwind)");
  });

  it("an owned result transfers exactly one reference to the caller", () => {
    const out = pass(fn([getProp(2), { kind: "return", value: 2 }], { result: "owned" }));
    expect(formatHandleStmts(out.body)).toEqual([
      "call get_prop(_, h1, _) -> h2",
      "dup h2 -> h3 (return-transfer)",
      "free h2 (return)",
      "return h3",
    ]);
    // The dup/free pair is deliberate uniformity, not an oversight: for a
    // BORROWED return value the dup is load-bearing. It is recorded as an
    // elision candidate rather than special-cased here (elision is #4542's
    // explicit non-goal).
    const { elisionCandidates } = insertHandleScopes(
      fn([getProp(2), { kind: "return", value: 2 }], {
        result: "owned",
      }),
      TABLE,
    );
    expect(elisionCandidates.some((c) => c.reason === "return-transfer" && c.handle === 2)).toBe(true);
  });

  it("returning an owned handle from a frame that does not transfer is a diagnostic", () => {
    const result = insertHandleScopes(fn([getProp(2), { kind: "return", value: 2 }]), TABLE);
    expect(result.diagnostics.map((d) => d.severity)).toEqual(["error"]);
    expect(result.diagnostics[0].message).toMatch(/result ownership is 'none'/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("#4542 — consumes vs borrows", () => {
  it("a consumes-annotated import gets exactly one dup and NO extra release", () => {
    const out = pass(fn([getProp(2), setProp(RECV, 2)]));
    const text = formatHandleStmts(out.body).join("\n");
    expect(text).toContain("dup h2 -> h3 (consume-arg)");
    // The callee receives the COPY, never the frame's own handle — which is
    // what leaves the frame's release valid.
    expect(text).toContain("call set_prop(_, h1, _, h3)");
    // Exactly one dup and one normal-path free: acquire +1, dup +1, callee -1,
    // scope free -1. A second free here would be the double-free the issue
    // names as the expensive direction.
    expect(dups(out.body)).toHaveLength(1);
    expect(frees(out.body).filter((f) => f.kind === "free" && f.reason !== "unwind")).toHaveLength(1);
  });

  it("a borrows-annotated import gets no refcount traffic of its own", () => {
    const out = pass(fn([getProp(2), callFn(2)]));
    // The only traffic is the acquisition's own release.
    expect(dups(out.body)).toHaveLength(0);
    expect(frees(out.body).filter((f) => f.kind === "free" && f.reason === "scope-exit")).toHaveLength(1);
  });

  it("consuming a BORROWED handle duplicates it — we cannot give away what we do not hold", () => {
    const out = pass(fn([peek(2), setProp(RECV, 2)]));
    const text = formatHandleStmts(out.body).join("\n");
    expect(text).toContain("dup h2 -> h3 (consume-arg-borrowed)");
    // And no free: the dup's reference is the one the callee takes.
    expect(frees(out.body)).toHaveLength(0);
  });

  it("an owned parameter is released by the frame that receives it", () => {
    const func: HandleFunction = {
      name: "takes_ownership",
      params: [{ id: RECV, ownership: "owned" }],
      result: "none",
      body: [callFn()],
    };
    const out = pass(func);
    const text = formatHandleStmts(out.body).join("\n");
    expect(text).toContain("free h1 (unwind)");
    expect(text).toContain("free h1 (scope-exit)");
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("#4542 — no refcount traffic on typed-only paths", () => {
  it("a body with no handle traffic emits no dup, free, or cleanup", () => {
    const func: HandleFunction = {
      name: "typed_only",
      params: [],
      result: "none",
      body: [
        { kind: "opaque", throws: false, note: "i32 arithmetic" },
        { kind: "call", callee: "c_double", args: [null] },
        {
          kind: "loop",
          label: "L",
          body: [
            { kind: "opaque", throws: false },
            { kind: "continue", label: "L" },
          ],
        },
      ],
    };
    const out = pass(func);
    expect(dups(out.body)).toHaveLength(0);
    expect(frees(out.body)).toHaveLength(0);
    expect(cleanups(out.body)).toHaveLength(0);
  });

  it("and the lowered instruction stream contains no call to dup or free", () => {
    const func: HandleFunction = {
      name: "typed_only",
      params: [],
      result: "none",
      body: [{ kind: "call", callee: "c_double", args: [null] }],
    };
    const out = pass(func);
    const rt = runtime(new Map());
    const instrs = lowerHandleFunction(out, rt);
    expect(countCalls(instrs, rt.dupFuncIdx)).toBe(0);
    expect(countCalls(instrs, rt.freeFuncIdx)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// The negative half: the harness must SEE the bug class it guards.
describe("#4542 — the verifier catches the bugs it exists to catch", () => {
  it("catches a missing release (the leak direction)", () => {
    // Hand-written, deliberately wrong: the acquisition is never released.
    const broken = fn([getProp(2), { kind: "use", value: 2 }]);
    const findings = verifyRefcountBalance(broken, TABLE);
    expect(findings.map((f) => f.kind)).toContain("leak");
    expect(findings.find((f) => f.kind === "leak")?.handle).toBe(2);
  });

  it("catches a double free (the use-after-free direction)", () => {
    const broken = fn([
      getProp(2),
      { kind: "free", value: 2, reason: "scope-exit" },
      { kind: "free", value: 2, reason: "scope-exit" },
    ]);
    const findings = verifyRefcountBalance(broken, TABLE);
    expect(findings.map((f) => f.kind)).toContain("over-release");
  });

  it("catches a release that is missing only on the EXCEPTIONAL path", () => {
    // The normal path is perfectly balanced. This is the shape hand-written
    // discipline actually gets wrong, and the reason cleanup regions exist.
    const broken = fn([getProp(2), callFn(), { kind: "free", value: 2, reason: "scope-exit" }]);
    const findings = verifyRefcountBalance(broken, TABLE);
    const leak = findings.find((f) => f.kind === "leak");
    expect(leak).toBeDefined();
    expect(leak?.path).toBe("unwind");
  });

  it("catches a use after the last reference was released", () => {
    const broken = fn([getProp(2), { kind: "free", value: 2, reason: "scope-exit" }, { kind: "use", value: 2 }]);
    const findings = verifyRefcountBalance(broken, TABLE);
    expect(findings.map((f) => f.kind)).toContain("use-after-free");
  });

  it("catches a loop that grows the held set — the flat-heap property, statically", () => {
    const broken = fn([
      {
        kind: "loop",
        label: "L",
        body: [getProp(2), { kind: "continue", label: "L" }],
      },
    ]);
    const findings = verifyRefcountBalance(broken, TABLE);
    const drift = findings.find((f) => f.kind === "loop-drift");
    expect(drift).toBeDefined();
    expect(drift?.message).toMatch(/back edge/);
  });

  it("catches giving away a reference we do not hold", () => {
    const broken = fn([peek(2), setProp(RECV, 2)]); // no dup before the consume
    const findings = verifyRefcountBalance(broken, TABLE);
    expect(findings.map((f) => f.kind)).toContain("consumed-unowned");
  });

  it("reports an exhausted path budget rather than quietly returning clean", () => {
    const findings = verifyRefcountBalance(pass(fn([getProp(2), callFn(), callFn(), callFn()])), TABLE, {
      maxPaths: 2,
    });
    expect(findings.map((f) => f.kind)).toContain("path-budget-exhausted");
  });
});

// ════════════════════════════════════════════════════════════════════════
function runtime(handleLocal: Map<number, number>): RefcountRuntime {
  return {
    dupFuncIdx: 10,
    freeFuncIdx: 11,
    calleeFuncIdx: new Map([
      ["get_prop", 20],
      ["new_object", 21],
      ["set_prop", 22],
      ["peek_slot", 23],
      ["read_len", 24],
      ["call_fn", 25],
      ["c_double", 26],
    ]),
    calleeReturnsValue: new Map([
      ["set_prop", true],
      ["read_len", true],
      ["call_fn", true],
      ["c_double", true],
    ]),
    handleLocal,
    emitContext: () => [{ op: "global.get", index: 0 }],
    throwTagIdx: 0,
  };
}

describe("#4542 — lowering to Wasm", () => {
  it("a cleanup region becomes try / catch_all / rethrow around the release", () => {
    const out = pass(fn([getProp(2), callFn()]));
    const rt = runtime(
      new Map([
        [1, 0],
        [2, 1],
      ]),
    );
    const instrs = lowerHandleFunction(out, rt);

    const tryInstr = instrs.find((i) => i.op === "try");
    expect(tryInstr).toBeDefined();
    if (tryInstr?.op !== "try") throw new Error("unreachable");
    expect(tryInstr.catchAll).toBeDefined();
    // The handler releases, then re-raises: an inner handler adds a release to
    // the exception, it does not swallow it.
    expect(tryInstr.catchAll?.some((i) => i.op === "call" && i.funcIdx === rt.freeFuncIdx)).toBe(true);
    expect(tryInstr.catchAll?.at(-1)).toEqual({ op: "rethrow", depth: 0 });
    // One release on the normal path, one on the unwind path — never both on
    // the same path.
    expect(countCalls(instrs, rt.freeFuncIdx)).toBe(2);
  });

  it("break out of a loop nested in a cleanup region computes the right br depth", () => {
    const out = pass(
      fn([
        getProp(2),
        {
          kind: "loop",
          label: "L",
          body: [callFn(), { kind: "break", label: "L" }],
        },
      ]),
    );
    const rt = runtime(
      new Map([
        [1, 0],
        [2, 1],
      ]),
    );
    const instrs = lowerHandleFunction(out, rt);

    // Shape: try { block { loop { try { call } catch_all{...} ; br ? } } }
    // From inside the loop, the enclosing labels are (innermost first): the
    // loop, the block. `break L` targets the block => depth 1.
    const brs = [...flattenInstrs(instrs)].filter((i) => i.op === "br");
    expect(brs).toHaveLength(1);
    expect(brs[0]).toEqual({ op: "br", depth: 1 });
  });

  it("a handle with no assigned local is a loud failure, not a bad index", () => {
    const out = pass(fn([getProp(2)]));
    expect(() => lowerHandleFunction(out, runtime(new Map([[1, 0]])))).toThrow(/no Wasm local assigned to handle h2/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// End-to-end against the REAL pinned-shim ABI, not a fixture table. Under
// that ABI nothing unwinds by itself (an error comes back as a sentinel
// handle), so the exceptional path is created by our OWN exception check —
// which is the shape #4541's lowering will emit, and the one worth proving.
describe("#4542 — the pinned shim's ABI, end to end", () => {
  const SHIM = requireOwnershipAnnotations(pinnedShimImports());

  const OBJ = 1;
  const shimFn = (body: HandleStmt[], result: "none" | "owned" = "none"): HandleFunction => ({
    name: "read_prop",
    params: [{ id: OBJ, ownership: "borrowed", name: "obj" }],
    result,
    body,
  });
  const readProp = (dest: number): HandleStmt => ({
    kind: "call",
    callee: "qjs_get_prop_str",
    args: [null, OBJ, null],
    dest,
  });
  const isException = (h: number): HandleStmt => ({
    kind: "call",
    callee: "qjs_is_exception",
    args: [h],
  });
  const toF64 = (h: number): HandleStmt => ({
    kind: "call",
    callee: "qjs_to_f64",
    args: [null, h],
  });

  function shimPass(func: HandleFunction): HandleFunction {
    const result = insertHandleScopes(func, SHIM);
    expect(result.diagnostics).toEqual([]);
    expect(verifyRefcountBalance(result.func, SHIM, { maxLoopIterations: 3 })).toEqual([]);
    return result.func;
  }

  it("a property read in a loop releases once per iteration on every path", () => {
    const out = shimPass(
      shimFn([
        {
          kind: "loop",
          label: "L",
          body: [
            readProp(10),
            isException(10),
            { kind: "if", then: [{ kind: "throw", value: 10 }] },
            toF64(10),
            { kind: "continue", label: "L" },
          ],
        },
      ]),
    );
    expect(formatHandleStmts(out.body)).toEqual([
      "loop L {",
      "  call qjs_get_prop_str(_, h1, _) -> h10",
      "  cleanup h10 {",
      "    call qjs_is_exception(h10)",
      "    if {",
      // The sentinel handle IS an owned handle. It is handed to the exception
      // with its own reference; the cleanup releases the frame's.
      "      dup h10 -> h11 (throw-transfer)",
      "      throw h11",
      "    }",
      "    call qjs_to_f64(_, h10)",
      "    free h10 (continue)",
      "    continue L",
      "  } unwind {",
      "    free h10 (unwind)",
      "  }",
      "}",
    ]);
  });

  it("the loop's held set is stationary across iterations — flat, statically", () => {
    const out = shimPass(
      shimFn([
        {
          kind: "loop",
          label: "L",
          body: [readProp(10), toF64(10), { kind: "continue", label: "L" }],
        },
      ]),
    );
    // The engine-free half of the flat-heap criterion. It cannot see the
    // engine's own accounting, so it is a necessary condition, not the fixture.
    expect(verifyRefcountBalance(out, SHIM, { maxLoopIterations: 4 })).toEqual([]);
    expect(frees(out.body)).toHaveLength(1);
  });

  it("an early return out of nested scopes releases every frame it leaves", () => {
    const out = shimPass(
      shimFn(
        [
          readProp(10),
          {
            kind: "scope",
            body: [readProp(11), { kind: "if", then: [{ kind: "return", value: 11 }] }, toF64(11)],
          },
          toF64(10),
        ],
        "owned",
      ),
    );
    const text = formatHandleStmts(out.body).join("\n");
    expect(text).toContain("dup h11 -> h12 (return-transfer)");
    expect(text).toContain("free h11 (return)");
    expect(text).toContain("free h10 (return)");
    expect(text.indexOf("free h11 (return)")).toBeLessThan(text.indexOf("free h10 (return)"));
    expect(text).toContain("return h12");
  });

  it("the pass REFUSES a shim wrapper it has no annotation for", () => {
    // The compile-error criterion, arriving where the missing fact is used.
    expect(() => insertHandleScopes(shimFn([{ kind: "call", callee: "qjs_not_declared", args: [] }]), SHIM)).toThrow(
      /no ownership annotation for callee 'qjs_not_declared'/,
    );
  });
});
