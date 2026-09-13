// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Physical import and exception-tag registration without source collection. */
import type { Import, TagDef } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { buildStrictHostImportError, isHostImportAllowed } from "../host-import-allowlist.js";
import { addFuncType } from "./types.js";
import { appendPhysicalImport } from "../../wasm/physical/module-reservations.js";

/**
 * Register a physical import without loading source-collection code. This
 * narrow surface is used by PreparedIrProgram consumption and remains
 * independent of the high-level registry module.
 */
export function addImport(ctx: CodegenContext, module: string, name: string, desc: Import["desc"]): Import | undefined {
  if (ctx.indexSpaceFrozen) {
    throw new Error(
      `import space frozen (#1984): '${module}.${name}' added after finalize — ` +
        `this producer must register its import before the freeze point or refuse loudly`,
    );
  }
  if (ctx.strictNoHostImports) {
    const decision = isHostImportAllowed(module, name, ctx.linkedNamespaces);
    if (!decision.allowed) {
      const message = buildStrictHostImportError(module, name);
      ctx.errors.push({ message, line: 0, column: 0, severity: "degrade" });
      if (desc.kind === "func") {
        const recorded = (ctx.mod.strictDroppedHostImports ??= []);
        if (!recorded.some((d) => d.module === module && d.name === name)) {
          recorded.push({ module, name });
        }
      }
      return undefined;
    }
  }
  appendPhysicalImport(ctx.mod, module, name, desc);
  if (desc.kind === "func") {
    ctx.funcMap.set(name, ctx.numImportFuncs);
    ctx.numImportFuncs++;
  }
  if (desc.kind === "global") {
    ctx.numImportGlobals++;
  }
  return ctx.mod.imports[ctx.mod.imports.length - 1]!;
}

/**
 * (#5383 S2m) The standalone wasm→wasm twin of `sharedExnTag`.
 *
 * A wasm exception is caught by TAG IDENTITY. Two separately compiled
 * standalone modules each DEFINE their own `__exn`, so a `throw` inside the
 * linked Temporal provider matched no handler in the consumer: the consumer's
 * own `try { NS.f() } catch (e) { … }` never ran and the raw
 * `WebAssembly.Exception` escaped to the embedder (measured on both trees in
 * S2l). For every test262 row that asserts `throws RangeError` that is fatal —
 * the negative half of the corpus cannot be scored at all.
 *
 * The JS-host lane answers this with `sharedExnTag`: a JS-owned
 * `WebAssembly.Tag` imported as `env.__exn` by every module of the graph
 * (#5226). That needs a host, so it is explicitly OFF for standalone/wasi.
 *
 * The host-free answer needs no new ABI, because both halves already exist:
 * every module already EXPORTS its tag as `__exn_tag` (`codegen/index.ts`), and
 * `instantiateLinkedProviders` already publishes each provider's whole export
 * record under its namespace on the consumer's import object. So a CONSUMER
 * imports `<provider-namespace>.__exn_tag` and uses it as its own tag — one
 * tag for the graph, resolved by the linker that is already there, with no
 * `env` import and therefore no #2961 leak (the namespace is in
 * `linkedNamespaces`, which `isHostImportAllowed` already admits).
 *
 * Direction is deliberate and one-way: the PROVIDER keeps its module-defined
 * tag and exports it. Importing in the other direction would make the provider
 * depend on its consumer, which the linker instantiates second.
 *
 * Degrades silently to a module-local tag when there is no peer, or when the
 * index space is already frozen (#1984) — that is exactly today's behaviour, so
 * a module that first throws after the freeze is no worse off than before.
 * {@link reserveLinkedExnTag} exists to make that window practically empty.
 */
function peerExnTagNamespace(ctx: CodegenContext): string | undefined {
  if (!ctx.standalone || ctx.exportsConsumedByWasm === true) return undefined;
  const namespaces = [...ctx.linkedNamespaces].filter((name) => name.startsWith("js2wasm:npm:")).sort();
  return namespaces[0];
}

/**
 * Register the peer tag import ahead of the index-space freeze, for a
 * standalone consumer that links a provider. No-op everywhere else, and no-op
 * when the tag is already decided — so calling it early costs a module with no
 * peer exactly nothing.
 */
export function reserveLinkedExnTag(ctx: CodegenContext): void {
  if (ctx.exnTagIdx >= 0 || ctx.indexSpaceFrozen) return;
  if (peerExnTagNamespace(ctx) === undefined) return;
  ensureExnTag(ctx);
}

/** Lazily register the shared, peer-imported, or module-local exception tag. */
export function ensureExnTag(ctx: CodegenContext): number {
  if (ctx.exnTagIdx >= 0) return ctx.exnTagIdx;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], []);
  if (ctx.sharedExnTag) {
    ctx.exnTagIdx = ctx.mod.imports.filter((imp) => imp.desc.kind === "tag").length;
    addImport(ctx, "env", "__exn", { kind: "tag", typeIdx });
    return ctx.exnTagIdx;
  }
  const peer = ctx.indexSpaceFrozen ? undefined : peerExnTagNamespace(ctx);
  if (peer !== undefined) {
    const absolute = ctx.mod.imports.filter((imp) => imp.desc.kind === "tag").length;
    if (addImport(ctx, peer, "__exn_tag", { kind: "tag", typeIdx }) !== undefined) {
      ctx.exnTagIdx = absolute;
      ctx.exnTagImported = true;
      return ctx.exnTagIdx;
    }
  }
  const tagDef: TagDef = { name: "__exn", typeIdx };
  ctx.exnTagIdx = ctx.mod.tags.length;
  ctx.mod.tags.push(tagDef);
  return ctx.exnTagIdx;
}
