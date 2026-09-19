// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6628 (#5383 S41) — `fillApplyClosure`'s #6420 "route a positive peer-owned
// callable before the local closure dispatcher" front-guard
// (`src/codegen/object-runtime.ts`, the `standaloneLinkBoundaryPeerIndex(ctx,
// "callableKind")` bridge) queries the LINKED PROVIDER "is this externref
// callable?" for EVERY value ever passed into `__apply_closure` — including a
// closure that is 100% LOCAL to the CONSUMER and has never crossed the link
// boundary. Under `canonicalRuntimeTypes` (on for every linked consumer) a
// local closure's WASM struct shape is canonically IDENTICAL to the
// provider's own closure/Proxy shapes, so the provider's `__is_callable`
// (a bare structural `ref.test`, no ownership check) answers "yes, callable"
// for a value it has never seen. `__apply_closure` then hijacks the call
// through `__js2wasm_link_apply` — the PROVIDER's own apply terminal — which
// cannot run a CONSUMER-owned closure and silently answers null instead of
// invoking it.
//
// S40 (#6627) reduced #5383's `Proxy get trap is not callable` bucket to this
// 9-line repro and named the two suspects
// (`ensureProxyRuntime`/`emitStandaloneLinkReverseLocalTerminals`) without
// pinning down the mechanism. S41 traced it past both of those (their
// generated IR is byte-for-byte structurally correct in both builds) into
// `fillApplyClosure`'s peer-callable-kind front-guard instead — the ACTUAL
// divergence is nothing to do with the reverse-peer terminals or funcIdx
// shifting; it is a pure classification miss that predates and is unrelated
// to `Reflect`, `Temporal`, or the reverse channel. Any dynamically-invoked
// closure (Proxy trap, `.map(fn)`, `.call()`, …) in a linked standalone
// consumer was equally exposed — Proxy traps just happen to be #5383's
// bucket that surfaced it.
//
// Fix (`src/codegen/object-runtime.ts`): gate the peer callable-kind query on
// `fn` NOT already matching one of THIS module's own locally-registered
// closure base-wrapper shapes (`collectClosureBaseWrapperTypeIdxs`,
// `src/codegen/closure-classifier.ts`) — mirroring the `ref.test`-first
// pattern the adjacent proxyApply/boundaryCallableKind guards already use.
//
// Host-free (`hostBridge: "off"`), standalone only. Every probe answers a
// NUMBER for the same reason `tests/issue-6605-*.test.ts` does: a standalone
// module's string is a WasmGC array the host cannot decode.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/**
 * Compile `consumerBody` as a standalone module LINKED to a trivial,
 * never-called provider package — the exact S40 repro condition ("provider
 * content irrelevant, not even called"). Returns the exported functions.
 */
async function linked(consumerBody: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6628-"));
  const packageRoot = join(root, "node_modules", "ns6628");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6628", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), `export const NS = Object.freeze({ noop() { return 1; } });\n`);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6628";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((e) => e.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6628")!;
  const field = artifact.exportBoundaries!.NS!.field;
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      [consumerEntry]: `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\n${consumerBody}`,
    },
    consumerEntry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
      ...STANDALONE,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  return instance.exports as unknown as Record<string, () => unknown>;
}

/** Same body, compiled standalone with NO link at all (the control baseline). */
async function unlinked(consumerBody: string): Promise<Record<string, () => unknown>> {
  const result = await compileMulti({ "/__main.js": consumerBody }, "/__main.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...STANDALONE,
  } as never);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  return instance.exports as unknown as Record<string, () => unknown>;
}

describe("#6628 — a local closure must not be routed to the linked peer's apply terminal", () => {
  it("fix-witness: S40's 9-line Proxy get-trap repro (base tree: -2, fixed: 1)", async () => {
    const body = `
      var options = new Proxy({ overflow: "reject" }, {
        get(target, key, receiver) { return target[key]; },
      });
      export function probeToString() {
        var v = String(options.overflow);
        return v === "reject" ? 1 : -2;
      }
    `;
    const exports = await linked(body);
    expect(exports.probeToString!()).toBe(1);
  });

  it("fix-witness: a get trap that NEVER reads target/key still actually RUNS (base tree: trap never invoked, side effect count stays 0)", async () => {
    const body = `
      var count = 0;
      var options = new Proxy({ overflow: "reject" }, {
        get(target, key, receiver) { count = count + 1; return "TRAP_RAN"; },
      });
      export function probe() { var v = options.overflow; return count; }
    `;
    const exports = await linked(body);
    expect(exports.probe!()).toBe(1);
  });

  it("fix-witness: the trap's own return value (not the peer's null) reaches the caller (base tree: dereferencing a null pointer on .length)", async () => {
    const body = `
      var options = new Proxy({ overflow: "reject" }, {
        get(target, key, receiver) { return "TRAP_RAN"; },
      });
      export function probe() {
        var v = options.overflow;
        return typeof v === "string" ? v.length : -99;
      }
    `;
    const exports = await linked(body);
    expect(exports.probe!()).toBe(8); // "TRAP_RAN".length
  });

  it("control: the SAME Proxy repro compiled UNLINKED is and remains correct", async () => {
    const body = `
      var options = new Proxy({ overflow: "reject" }, {
        get(target, key, receiver) { return target[key]; },
      });
      export function probeToString() {
        var v = String(options.overflow);
        return v === "reject" ? 1 : -2;
      }
    `;
    const exports = await unlinked(body);
    expect(exports.probeToString!()).toBe(1);
  });

  it("control: a linked consumer with NO Proxy/dynamic closure call at all is unaffected", async () => {
    const body = `
      export function probe() { return 1 + 41; }
    `;
    const exports = await linked(body);
    expect(exports.probe!()).toBe(42);
  });

  it("control: a linked consumer's OWN dynamic .map(fn) callback (a different __apply_closure caller) also actually runs", async () => {
    const body = `
      export function probe() {
        var a = [1, 2, 3];
        var b = a.map(function (x) { return x * 2; });
        return b[0] + b[1] + b[2];
      }
    `;
    const exports = await linked(body);
    expect(exports.probe!()).toBe(12);
  });

  it("control: a Proxy handler with NO get trap still forwards to the target correctly (trap-absent path unaffected)", async () => {
    const body = `
      var options = new Proxy({ overflow: "reject" }, {});
      export function probe() {
        return options.overflow === "reject" ? 1 : -2;
      }
    `;
    const exports = await linked(body);
    expect(exports.probe!()).toBe(1);
  });
});
