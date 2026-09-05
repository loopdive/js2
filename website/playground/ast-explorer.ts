// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// AST explorer panel — parses the editor's source with ACORN COMPILED TO WASM
// BY js2wasm, and renders the resulting tree.
//
// The parser is not a JS copy of acorn: `website/public/acorn/acorn.wasm` is the
// pinned acorn 8.16.0 tarball run through this compiler (see
// scripts/build-acorn-wasm.mjs). So the panel doubles as a live demonstration
// that the compiler handles a real 230 KB parser graph, in the visitor's own
// browser, on their own input.
//
// Two things about the compiled module are load-bearing here:
//
//   1. It is a JS-HOST build, so it needs an import object. The compile emitted
//      an adapter manifest describing that import plan; we ship it as JSON and
//      hand it to `buildCompiledAdapterImports`. (The CLI's generated
//      `.imports.js` helper does the same thing, but its `from "js2wasm"`
//      specifier cannot resolve from a statically-served file — and the
//      playground already has the runtime loaded, so we call it directly.)
//   2. `exports.parse` returns an opaque WasmGC handle. `wrapExports` is what
//      walks that node graph back into plain JS objects; without it every AST
//      node inspects as `{}`.

import { buildCompiledAdapterImports, instantiateWasm, wrapExports } from "../../src/runtime.js";

export interface AstRange {
  start: number;
  end: number;
}

interface AcornOptions {
  ecmaVersion: number;
  sourceType: "module" | "script";
}

interface AcornMeta {
  acornVersion: string;
  wasmBytes: number;
  sourceBytes: number;
  compileMs: number;
  generatedAt: string;
}

type AstNode = Record<string, unknown>;

/** Where a rendered subtree came from, so the header can say so honestly. */
export type AstSourceKind = "editor" | "compiled-js";

// Fields every node carries; shown as the range badge rather than as children.
const RANGE_KEYS = new Set(["start", "end", "loc", "range", "sourceFile"]);

// Rendered inline next to the node type when present and primitive — the bits
// that identify a node at a glance (`Identifier foo`, `BinaryExpression +`).
const SUMMARY_KEYS = ["name", "value", "operator", "kind", "raw"];

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

// The artifacts live in the site's public root (`/acorn/…`). The playground
// itself is served one level down — `/playground/index.html` in the built site
// AND under the dev server, whose root is website/ — so the sibling-relative
// form is the hit in both, and is tried first so the common path costs no 404.
// The rest cover a playground mounted at some other depth.
function assetCandidates(file: string): string[] {
  const here = window.location.href;
  return [
    new URL(`../acorn/${file}`, here).toString(),
    new URL(`acorn/${file}`, here).toString(),
    `/acorn/${file}`,
    `/playground/acorn/${file}`,
  ];
}

async function fetchFirst(file: string): Promise<Response> {
  const tried: string[] = [];
  for (const url of assetCandidates(file)) {
    tried.push(url);
    try {
      const resp = await fetch(url);
      if (resp.ok) return resp;
    } catch {
      // next candidate
    }
  }
  throw new Error(`could not load ${file} (tried ${tried.join(", ")})`);
}

export class AstExplorer {
  readonly element: HTMLElement;

  /** Hovering a node asks the host to highlight that source range. */
  onNodeHover: ((range: AstRange | null) => void) | null = null;
  /** Clicking a node asks the host to reveal + select that source range. */
  onNodeSelect: ((range: AstRange) => void) | null = null;

  private headerEl: HTMLElement;
  private treeEl: HTMLElement;
  private statusEl: HTMLElement;
  private ecmaSelect: HTMLSelectElement;
  private sourceTypeSelect: HTMLSelectElement;

  private parse: ((src: string, opts: AcornOptions) => AstNode) | null = null;
  private meta: AcornMeta | null = null;
  private loading: Promise<void> | null = null;

  /**
   * Whether the rendered tree came from the editor's own text. Only then do a
   * node's ranges refer to what the user typed, so the host checks this before
   * mapping a hovered node back into the editor.
   */
  showsEditorSource = true;

  private pendingSources: { editorCode: string; compiledJs: string } | null = null;
  private lastRendered: { code: string; kind: AstSourceKind; options: AcornOptions } | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.id = "ast-panel";
    this.element.innerHTML = `
      <div class="ast-toolbar">
        <span class="ast-title">AST</span>
        <label class="ast-field">ecmaVersion
          <select class="ast-ecma">
            <option value="2025">2025</option>
            <option value="2022" selected>2022</option>
            <option value="2020">2020</option>
            <option value="2017">2017</option>
            <option value="5">5</option>
          </select>
        </label>
        <label class="ast-field">sourceType
          <select class="ast-source-type">
            <option value="module" selected>module</option>
            <option value="script">script</option>
          </select>
        </label>
        <span class="ast-header"></span>
      </div>
      <div class="ast-status"></div>
      <div class="ast-tree" role="tree"></div>
    `;
    this.headerEl = this.element.querySelector(".ast-header")!;
    this.statusEl = this.element.querySelector(".ast-status")!;
    this.treeEl = this.element.querySelector(".ast-tree")!;
    this.ecmaSelect = this.element.querySelector(".ast-ecma")!;
    this.sourceTypeSelect = this.element.querySelector(".ast-source-type")!;

    const reparse = () => {
      if (this.pendingSources) return; // nothing parsed yet; load() will replay
      const last = this.lastRendered;
      if (!last) return;
      // Re-render THIS source under the new options, without re-running the
      // editor-vs-compiled-JS choice: the reader picked a tree, changing
      // ecmaVersion should not silently switch which program they are looking at.
      this.lastRendered = null;
      this.renderSource(last.code, last.kind);
    };
    this.ecmaSelect.addEventListener("change", reparse);
    this.sourceTypeSelect.addEventListener("change", reparse);

    // Leaving the tree clears any highlight the last hovered row asked for.
    this.treeEl.addEventListener("mouseleave", () => this.onNodeHover?.(null));
  }

  private options(): AcornOptions {
    return {
      ecmaVersion: Number(this.ecmaSelect.value),
      sourceType: this.sourceTypeSelect.value === "script" ? "script" : "module",
    };
  }

  /**
   * Fetch + instantiate the compiled parser. Idempotent and safe to call from
   * several places: the first call owns the work, later ones await it.
   */
  async load(): Promise<void> {
    if (this.parse) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      this.setStatus("Loading acorn.wasm …", "info");
      const [wasmResp, manifestResp, metaResp] = await Promise.all([
        fetchFirst("acorn.wasm"),
        fetchFirst("acorn.manifest.json"),
        fetchFirst("meta.json"),
      ]);
      const [bytes, manifest, meta] = await Promise.all([
        wasmResp.arrayBuffer(),
        manifestResp.json(),
        metaResp.json() as Promise<AcornMeta>,
      ]);

      const imports = buildCompiledAdapterImports(manifest);
      const { instance } = await instantiateWasm(
        bytes,
        imports.env,
        imports.string_constants,
        imports.string_constants16,
      );
      // Exports-backed capabilities (closure wrapping, struct reads) need the
      // instance handed back before anything is called.
      imports.setInstance?.(instance);

      const exports = wrapExports(instance, {
        signatures: manifest.exportSignatures,
        boundaryPolicies: manifest.exportBoundaries,
      });
      if (typeof exports.parse !== "function") {
        throw new Error("compiled acorn exposes no callable `parse`");
      }
      this.parse = exports.parse as (src: string, opts: AcornOptions) => AstNode;
      this.meta = meta;
      this.setStatus("", "info");
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }

    if (this.pendingSources) {
      const { editorCode, compiledJs } = this.pendingSources;
      this.pendingSources = null;
      this.setSources(editorCode, compiledJs);
    }
  }

  /**
   * Parse and render the current program.
   *
   * acorn parses JavaScript and the editor holds TypeScript, so the editor text
   * is tried first — most playground examples are annotation-free enough to
   * parse, and only that case can map a node back to what the user typed. When
   * the annotations trip it, fall back to the compiled JS output rather than
   * showing a parse error for source that compiled fine. The header says which
   * one is on screen.
   *
   * Both sources are taken together (rather than as two host calls) so a call
   * that arrives before the parser has loaded can replay the same decision
   * afterwards instead of replaying only the branch it happened to try first.
   */
  setSources(editorCode: string, compiledJs: string): void {
    if (!this.parse) {
      this.pendingSources = { editorCode, compiledJs };
      return;
    }
    if (this.renderSource(editorCode, "editor")) {
      this.showsEditorSource = true;
      return;
    }
    if (compiledJs.trim() && this.renderSource(compiledJs, "compiled-js")) {
      this.showsEditorSource = false;
      return;
    }
    // Neither parsed: renderSource already put the editor error on screen, and
    // that is the one the reader can act on.
    this.showsEditorSource = true;
  }

  /** Parse + render one candidate. Returns false (and shows why) on a parse error. */
  private renderSource(code: string, kind: AstSourceKind): boolean {
    const options = this.options();
    const last = this.lastRendered;
    if (
      last &&
      last.code === code &&
      last.kind === kind &&
      last.options.ecmaVersion === options.ecmaVersion &&
      last.options.sourceType === options.sourceType
    ) {
      return true;
    }

    let ast: AstNode;
    const t0 = performance.now();
    try {
      ast = this.parse(code, options);
    } catch (error) {
      this.lastRendered = null;
      this.treeEl.replaceChildren();
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`Parse error: ${message}`, "error");
      this.renderHeader(null);
      return false;
    }
    const parseMs = performance.now() - t0;

    this.lastRendered = { code, kind, options };
    this.setStatus("", "info");
    this.renderHeader({ parseMs, kind, nodeCount: countNodes(ast) });

    this.treeEl.replaceChildren(this.renderNode(ast, null, 0, true));
    return true;
  }

  /** Drop the rendered tree — used when the editor is empty or a compile failed. */
  clear(message: string): void {
    this.lastRendered = null;
    this.treeEl.replaceChildren();
    this.renderHeader(null);
    this.setStatus(message, "info");
  }

  private setStatus(text: string, tone: "info" | "error"): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("ast-status-error", tone === "error");
    this.statusEl.style.display = text ? "" : "none";
  }

  private renderHeader(stats: { parseMs: number; kind: AstSourceKind; nodeCount: number } | null): void {
    if (!this.meta) {
      this.headerEl.textContent = "";
      return;
    }
    const kb = (this.meta.wasmBytes / 1024).toFixed(0);
    const parts = [`acorn ${this.meta.acornVersion} → wasm (${kb} KB)`];
    if (stats) {
      parts.push(`${stats.nodeCount} nodes in ${stats.parseMs.toFixed(1)} ms`);
      parts.push(stats.kind === "editor" ? "from the editor" : "from the compiled JS output");
    }
    this.headerEl.textContent = parts.join(" · ");
    this.headerEl.title =
      `acorn ${this.meta.acornVersion} compiled by js2wasm on ${this.meta.generatedAt.slice(0, 10)} ` +
      `(${this.meta.sourceBytes} bytes of JS → ${this.meta.wasmBytes} bytes of Wasm in ` +
      `${(this.meta.compileMs / 1000).toFixed(1)}s). Parsing runs entirely in Wasm in this tab.`;
  }

  /**
   * One row plus its lazily-built children. Subtrees materialize on first
   * expand: a large file is tens of thousands of nodes, and building all of
   * them up front is what makes an AST view feel broken.
   */
  private renderNode(node: AstNode, label: string | null, depth: number, expanded: boolean): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "ast-node";

    const row = document.createElement("div");
    row.className = "ast-row";
    row.style.paddingLeft = `${depth * 14 + 6}px`;

    const childEntries = collectChildren(node);
    const twisty = document.createElement("span");
    twisty.className = "ast-twisty";
    twisty.textContent = childEntries.length ? (expanded ? "▾" : "▸") : "";
    row.appendChild(twisty);

    if (label !== null) {
      const key = document.createElement("span");
      key.className = "ast-key";
      key.textContent = `${label}:`;
      row.appendChild(key);
    }

    const type = document.createElement("span");
    type.className = "ast-type";
    type.textContent = String(node.type);
    row.appendChild(type);

    const summary = summarize(node);
    if (summary) {
      const sum = document.createElement("span");
      sum.className = "ast-summary";
      sum.textContent = summary;
      row.appendChild(sum);
    }

    const range = rangeOf(node);
    if (range) {
      const badge = document.createElement("span");
      badge.className = "ast-range";
      badge.textContent = `${range.start}–${range.end}`;
      row.appendChild(badge);
    }

    const childrenEl = document.createElement("div");
    childrenEl.className = "ast-children";
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      for (const [key, value] of childEntries) {
        if (Array.isArray(value)) {
          for (const [i, item] of value.entries()) {
            if (isNode(item)) childrenEl.appendChild(this.renderNode(item, `${key}[${i}]`, depth + 1, false));
            else childrenEl.appendChild(renderLeaf(`${key}[${i}]`, item, depth + 1));
          }
        } else if (isNode(value)) {
          childrenEl.appendChild(this.renderNode(value, key, depth + 1, false));
        } else {
          childrenEl.appendChild(renderLeaf(key, value, depth + 1));
        }
      }
    };

    const setExpanded = (next: boolean) => {
      if (!childEntries.length) return;
      if (next) build();
      childrenEl.style.display = next ? "" : "none";
      twisty.textContent = next ? "▾" : "▸";
    };

    if (expanded) {
      build();
    } else {
      childrenEl.style.display = "none";
    }

    row.addEventListener("click", (event) => {
      event.stopPropagation();
      setExpanded(childrenEl.style.display === "none");
      if (range) this.onNodeSelect?.(range);
    });
    row.addEventListener("mouseenter", () => this.onNodeHover?.(range));

    wrapper.appendChild(row);
    wrapper.appendChild(childrenEl);
    return wrapper;
  }
}

function rangeOf(node: AstNode): AstRange | null {
  const { start, end } = node;
  if (typeof start === "number" && typeof end === "number") return { start, end };
  return null;
}

function collectChildren(node: AstNode): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || RANGE_KEYS.has(key)) continue;
    if (value === undefined) continue;
    // Primitives already shown inline next to the type would just repeat.
    if (SUMMARY_KEYS.includes(key) && isPrimitive(value)) continue;
    out.push([key, value]);
  }
  return out;
}

function isPrimitive(value: unknown): boolean {
  return value === null || (typeof value !== "object" && typeof value !== "function");
}

function summarize(node: AstNode): string {
  for (const key of SUMMARY_KEYS) {
    const value = node[key];
    if (value === undefined || !isPrimitive(value)) continue;
    if (key === "raw" && typeof node.value !== "undefined") continue;
    return typeof value === "string" ? value : String(value);
  }
  return "";
}

function renderLeaf(label: string, value: unknown, depth: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "ast-row ast-leaf";
  row.style.paddingLeft = `${depth * 14 + 6}px`;

  const twisty = document.createElement("span");
  twisty.className = "ast-twisty";
  row.appendChild(twisty);

  const key = document.createElement("span");
  key.className = "ast-key";
  key.textContent = `${label}:`;
  row.appendChild(key);

  const val = document.createElement("span");
  val.className = "ast-value";
  // Booleans cross the Wasm boundary as i32 0/1 — a known marshalling quirk of
  // the compiled parser (the same one tests/dogfood/acorn-corpus.mjs classifies
  // as QUIRK rather than a real divergence). Showing the raw 0/1 would read as
  // a parser bug, so name the field's own shape instead of guessing: only the
  // literal numbers are ambiguous, and acorn's flag fields are exactly these.
  val.textContent = value === null ? "null" : Array.isArray(value) ? `[${value.length}]` : String(value);
  row.appendChild(val);
  return row;
}

function countNodes(root: AstNode): number {
  let n = 0;
  const stack: unknown[] = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
    } else if (isNode(cur)) {
      n++;
      for (const [key, value] of Object.entries(cur)) {
        if (key === "type" || RANGE_KEYS.has(key)) continue;
        if (value && typeof value === "object") stack.push(value);
      }
    }
  }
  return n;
}
