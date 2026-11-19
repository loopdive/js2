// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7398 — the Prepared requirement planners restored the program's allocation registry from the same snapshot many
// times per compile (52 at every size of the #7365 prelude-shaped program), and each full restore copied and
// re-validated every site. `restoredAllocRegistry` restores and validates a snapshot that can no longer change once
// (#7354 Perf settled verdict) and hands out a frozen resolve-only view; a snapshot that can still change is fully
// restored at every use.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { asAllocSiteId } from "../src/ir/core/nodes.js";
import { freezePreparedIrValue } from "../src/ir/program/data.js";
import { restoredAllocRegistry, type AllocSiteResolver } from "../src/ir/program/alloc-registry-restore.js";

afterEach(() => vi.restoreAllMocks());

const f64 = { kind: "val", val: { kind: "f64" } } as const;

function snapshot() {
  const registry = new AllocSiteRegistry();
  const a = registry.fresh("object", f64 as never);
  const b = registry.fresh("array", f64 as never);
  registry.fresh("object", f64 as never);
  const retired = registry.fresh("object", f64 as never);
  registry.alias(b, a);
  registry.retire(retired);
  return registry.captureSnapshot();
}

const resolved = (registry: AllocSiteResolver) => [0, 1, 2, 3, 4].map((id) => registry.resolve(asAllocSiteId(id)));

describe("#7398 one validated restore per unchangeable allocation snapshot", () => {
  it("restores a frozen snapshot once and resolves as the full restore does", () => {
    const frozen = freezePreparedIrValue(snapshot());
    const full = vi.spyOn(AllocSiteRegistry, "fromSnapshot");
    const views = Array.from({ length: 5 }, () => restoredAllocRegistry(frozen));
    expect(full).toHaveBeenCalledTimes(1);
    full.mockRestore();
    const reference = resolved(AllocSiteRegistry.fromSnapshot(frozen));
    for (const view of views) expect(resolved(view)).toEqual(reference);
  });

  it("hands out a frozen resolve-only view, so the shared restore cannot be changed", () => {
    const view = restoredAllocRegistry(freezePreparedIrValue(snapshot()));
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.keys(view)).toEqual(["resolve"]);
    expect(Object.isFrozen(view.resolve(asAllocSiteId(0)))).toBe(true);
  });

  it("fully restores and re-validates a snapshot that can still change, at every use", () => {
    const open = snapshot();
    const full = vi.spyOn(AllocSiteRegistry, "fromSnapshot");
    for (let count = 0; count < 3; count++) restoredAllocRegistry(open);
    expect(full).toHaveBeenCalledTimes(3);
    (open as { size: number }).size += 1;
    expect(() => restoredAllocRegistry(open)).toThrow();
  });

  it("re-validates a settled snapshot after a shared prototype gains a field", () => {
    const frozen = freezePreparedIrValue(snapshot());
    restoredAllocRegistry(frozen);
    const full = vi.spyOn(AllocSiteRegistry, "fromSnapshot");
    const prototype = Object.prototype as { allocProbe7398?: unknown };
    prototype.allocProbe7398 = 1;
    try {
      restoredAllocRegistry(frozen);
      expect(full).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(prototype, "allocProbe7398");
    }
  });
});
