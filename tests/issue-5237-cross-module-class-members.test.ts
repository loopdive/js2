// #5237 — a compiled CLASS's members must resolve in the module that READS
// them, not only in the module that declared them.
//
// Reported as a Temporal symptom (`typeof Temporal.PlainDate.prototype.toString`
// is "undefined" through the #4628 provider, and `.from()` results answer
// `undefined` for every field) but nothing about it is Temporal-specific. The
// reduction below uses a throwaway npm package with no Temporal in sight.
//
// THE RULE (measured on base, 2026-08-31):
//
//   The host boundary resolves compiled class members by looking up
//   `__member_kind_<key>` / `__call_get_<key>` / `__class_call_<key>_<n>` in the
//   exports of the module doing the READING. Those exports are emitted by the
//   module that COMPILED the class. Across the #2527 linked-provider seam the
//   two are different modules: the provider binary publishes them, the consumer
//   publishes none, so `_resolveClassMember` misses on every key and the read
//   answers `undefined`.
//
//   A `new`-built instance escapes only by accident: the host proxy minted at
//   construction captures the provider's export slot in its own closure, so its
//   own get-trap keeps working. Anything that reaches the class through a
//   different door — a prototype read, a static factory's return value — does
//   not carry that slot and loses every member.
//
// Base measurements for the assertions below (this branch's merge base, before
// the fix). The single-module control answers the post-fix value for all of
// them on base already — that is what makes this linking-specific.
//
//                     LINKED lane          CONTROL lane (single module)
//   protoNames        ""                 → "label,sum"    "label,sum"
//   staticMadeLabel   THREW "label is
//                      not a function"   → "P1:2"         "P1:2"
//   staticMadeSum     undefined          → 3              3
//   protoCallOnNew    "Pnull:null"       → "P1:2"         "P1:2"
//   protoCallOnMade   "Pnull:null"       → "P1:2"         "P1:2"
//   protoMethodType   "function" already — the VALUE crosses (#5222 landed
//                     that), it just dispatched against the prototype.
//   newLabel / newSum already correct on base (the `new` escape hatch above).
//
// Reported, NOT fixed here: `Object.getOwnPropertyNames(C.prototype)` omits
// "constructor" in BOTH lanes, so it is a general compiled-class gap rather
// than a provider-seam one and the control pins the shared answer.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

/**
 * One provider-side module, used verbatim by BOTH lanes so the only difference
 * between them is whether the linker compiled it separately.
 *
 * `label()` is a plain method, `sum` an accessor, and `make()` a static factory
 * — the three doors the consumer can reach a provider-owned instance through.
 */
const PROVIDER_SOURCE = `
export class Point {
  constructor(x, y) { this.x = x; this.y = y; }
  get sum() { return this.x + this.y; }
  label() { return "P" + this.x + ":" + this.y; }
  static make(x, y) { return new Point(x, y); }
}
`;

const CONSUMER_PROBES = `
export function protoMethodType() { return typeof Point.prototype.label; }
export function protoNames() { return Object.getOwnPropertyNames(Point.prototype).sort().join(","); }
export function newLabel() { return new Point(1, 2).label(); }
export function newSum() { return new Point(1, 2).sum; }
export function staticMadeLabel() { return Point.make(1, 2).label(); }
export function staticMadeSum() { return Point.make(1, 2).sum; }
export function protoCallOnNew() { return Point.prototype.label.call(new Point(1, 2)); }
export function protoCallOnMade() { return Point.prototype.label.call(Point.make(1, 2)); }
`;

/** Every probe's expected answer. Identical for both lanes — that is the point. */
const EXPECTED: Record<string, unknown> = {
  protoMethodType: "function",
  protoNames: "label,sum",
  newLabel: "P1:2",
  newSum: 3,
  staticMadeLabel: "P1:2",
  staticMadeSum: 3,
  protoCallOnNew: "P1:2",
  protoCallOnMade: "P1:2",
};

function readAll(exports: Record<string, unknown>): Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  for (const name of Object.keys(EXPECTED)) {
    try {
      observed[name] = (exports[name] as (() => unknown) | undefined)?.();
    } catch (error) {
      observed[name] = `THREW: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return observed;
}

describe("#5237 — compiled class members resolve against the OWNING module", () => {
  it("a separately linked package keeps its class members", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5237-"));
    const packageRoot = join(root, "node_modules", "cls5237");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "cls5237", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(entry, `import { Point } from "cls5237";\n${CONSUMER_PROBES}`);

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    // Load-bearing: a `bundled` plan would inline the package and silently
    // test the single-module lane twice.
    expect(result.linkPlan?.mode).toBe("separate");

    const { instance } = await instantiateLinkedProject(result);
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });

  it("the single-module control answers identically", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/provider.js": PROVIDER_SOURCE,
        [entry]: `import { Point } from "./provider";\n${CONSUMER_PROBES}`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    // No package edge, so nothing is linked — this is the control.
    expect(result.linkedModules ?? []).toHaveLength(0);

    const imports = result.importObject as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
    const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
    imports.__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });
});
