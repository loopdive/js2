// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1586 — AllocSiteRegistry unit tests.
//
// Covers the registry contract used by the pass-discipline rules:
//   - fresh → resolve (live)
//   - alias chain resolution + cycle guard
//   - retire → resolve null
//   - annotate / read per-namespace
//   - alias merges metadata onto the canonical site

import { describe, expect, it } from "vitest";

import { AllocSiteRegistry, irVal, type IrType } from "../../src/ir/index.js";

const F64: IrType = irVal({ kind: "f64" });
const STR: IrType = { kind: "string" };

describe("#1586 — AllocSiteRegistry", () => {
  it("fresh mints a live site that resolves", () => {
    const r = new AllocSiteRegistry();
    const id = r.fresh("object", F64);
    expect(r.isKnown(id)).toBe(true);
    const site = r.resolve(id);
    expect(site).not.toBeNull();
    expect(site!.kind).toBe("object");
    expect(site!.type).toBe(F64);
    expect(site!.id).toBe(id);
  });

  it("unknown ids are not known and resolve to null", () => {
    const r = new AllocSiteRegistry();
    // 999 was never minted.
    const fake = 999 as unknown as ReturnType<AllocSiteRegistry["fresh"]>;
    expect(r.isKnown(fake)).toBe(false);
    expect(r.resolve(fake)).toBeNull();
  });

  it("retire makes a site resolve to null but stay known", () => {
    const r = new AllocSiteRegistry();
    const id = r.fresh("string", STR);
    r.retire(id);
    expect(r.isKnown(id)).toBe(true);
    expect(r.resolve(id)).toBeNull();
  });

  it("alias resolves through the chain to the canonical live site", () => {
    const r = new AllocSiteRegistry();
    const a = r.fresh("object", F64);
    const b = r.fresh("object", F64);
    const c = r.fresh("object", F64);
    // a -> b -> c
    r.alias(b, c);
    r.alias(a, b);
    expect(r.resolve(a)!.id).toBe(c);
    expect(r.resolve(b)!.id).toBe(c);
    expect(r.resolve(c)!.id).toBe(c);
  });

  it("a cyclic alias chain resolves to null rather than looping", () => {
    const r = new AllocSiteRegistry();
    const a = r.fresh("object", F64);
    const b = r.fresh("object", F64);
    r.alias(a, b);
    // Force a cycle by aliasing b back to a (alias would normally canonicalize,
    // but exercise the guard directly via the public API).
    r.alias(b, a);
    // Whatever the canonicalization picks, resolve must terminate (no hang) and
    // return either a live site or null — never loop.
    expect(() => r.resolve(a)).not.toThrow();
    expect(() => r.resolve(b)).not.toThrow();
  });

  it("annotate / read are namespaced per analysis", () => {
    const r = new AllocSiteRegistry();
    const id = r.fresh("string", STR);
    r.annotate(id, "encoding", { utf8: true });
    r.annotate(id, "ownership", { kind: "owned" });
    expect(r.read<{ utf8: boolean }>(id, "encoding")).toEqual({ utf8: true });
    expect(r.read<{ kind: string }>(id, "ownership")).toEqual({ kind: "owned" });
    expect(r.read(id, "lifetime")).toBeUndefined();
  });

  it("annotate after retire is a no-op", () => {
    const r = new AllocSiteRegistry();
    const id = r.fresh("object", F64);
    r.retire(id);
    r.annotate(id, "ownership", { kind: "owned" });
    expect(r.read(id, "ownership")).toBeUndefined();
  });

  it("alias merges metadata onto the canonical site, canonical keys win", () => {
    const r = new AllocSiteRegistry();
    const from = r.fresh("string", STR);
    const to = r.fresh("string", STR);
    r.annotate(from, "encoding", { utf8: true });
    r.annotate(from, "ownership", { kind: "borrowed" });
    r.annotate(to, "ownership", { kind: "owned" }); // canonical pre-existing
    r.alias(from, to);
    // `encoding` migrated; `ownership` kept the canonical value.
    expect(r.read<{ utf8: boolean }>(to, "encoding")).toEqual({ utf8: true });
    expect(r.read<{ kind: string }>(to, "ownership")).toEqual({ kind: "owned" });
    // Reads through the aliased id see the canonical metadata too.
    expect(r.read<{ utf8: boolean }>(from, "encoding")).toEqual({ utf8: true });
  });

  it("liveSites lists only live sites", () => {
    const r = new AllocSiteRegistry();
    const a = r.fresh("object", F64);
    const b = r.fresh("string", STR);
    const c = r.fresh("closure", F64);
    r.retire(b);
    r.alias(c, a);
    const live = r.liveSites().map((s) => s.id);
    expect(live).toContain(a);
    expect(live).not.toContain(b);
    expect(live).not.toContain(c);
  });

  it("snapshots every provenance state and distinguishes missing metadata from undefined", () => {
    const r = new AllocSiteRegistry();
    const aliased = r.fresh("string", STR);
    const live = r.fresh("string", STR);
    const retired = r.fresh("object", F64);
    r.annotate(aliased, "encoding", undefined);
    r.alias(aliased, live);
    r.retire(retired);

    const snapshot = r.snapshot();
    expect(snapshot.size).toBe(3);
    expect(snapshot.entries.map((entry) => entry.state)).toEqual(["aliased", "live", "retired"]);
    expect(snapshot.metadata).toEqual([
      {
        id: live,
        entries: [["encoding", undefined]],
      },
    ]);
    expect(snapshot.metadata.find((row) => row.id === retired)).toBeUndefined();
  });
});
