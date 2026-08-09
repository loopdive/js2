// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2632 Phase 3 — `process.stdin` faithful Node `Readable` source-prelude
 * injection (string/Buffer chunks).
 *
 * `process.stdin` is, in Node, an async **Readable** stream: `.on('data'|'end'|
 * 'readable')`, `.read([size])` (returns a `size`-byte chunk / all available, or
 * `null` on short in paused mode), `.pause()`/`.resume()`, flowing vs paused
 * modes, EOF. The #2632 Phase-2 fd-readiness reactor + Phase-3 reactor-tick
 * reader hook (`async-scheduler.ts`) provide the substrate; the four internal
 * intrinsics expose it:
 *   - `__wasiStdinReadByte()`  — next buffered byte, or -1 when none buffered.
 *   - `__wasiStdinAvailable()` — buffered+unread byte count.
 *   - `__wasiStdinEof()`       — 1 once fd0 hit EOF AND the internal buffer drained.
 *   - `__wasiStdinSetReader(cb)` — register a reactor-tick "pump" hook.
 * Any of those calls activates `needsStdinReactor` in `codegen/index.ts`, which
 * wires the run-loop fd0 reactor automatically — no new codegen.
 *
 * Rather than special-case `process.stdin.*` in the call-expression compiler (the
 * way the synchronous `process.std{out,err}.write` path is lowered in
 * `node-fs-api.ts`), Phase 3 compiles the WHOLE Readable surface as ordinary TS:
 * a library `__Readable` class riding on the four intrinsics is **prepended** as
 * a source prelude, and `process.stdin` references are **rewritten** to a
 * `__js2wasm_stdin()` singleton accessor. This mirrors the #1501 timer-shim
 * prepend and the #1279 CJS-require rewrite — both pre-parse source transforms
 * with a {@link PositionMap} so diagnostics still report the user's line/column.
 *
 * The injection is **import-scoped**: it fires ONLY when the program references
 * `process.stdin` AND `target === "wasi"`. A program that never touches
 * `process.stdin` is byte-identical (the scan early-returns, the position map is
 * identity, and no prelude text is prepended). This matches the import-scoped
 * `.d.ts` injection in `checker/index.ts` (#2624) — codegen-level here, type-level
 * there; both inject only the surface the program actually touches.
 */
import { PositionMap, type CompilerSourceOriginSpan } from "./position-map.js";
import { ts } from "./ts-api.js";

const { forEachChild } = ts;

/** The singleton accessor that `process.stdin` rewrites to. */
const STDIN_ACCESSOR = "__js2wasm_stdin()";

const STDIN_CLASS_MEMBER_ROLES: Readonly<Record<string, string>> = {
  buf: "byte-buffer",
  head: "buffer-head",
  tail: "buffer-tail",
  dataCbs: "data-listeners",
  endCbs: "end-listeners",
  readableCbs: "readable-listeners",
  closeCbs: "close-listeners",
  flowing: "flowing-state",
  paused: "paused-state",
  ended: "ended-state",
  armed: "armed-state",
  eofReadableFired: "eof-readable-state",
  destroyed: "destroyed-state",
  avail: "available-bytes",
  ensure: "ensure-capacity",
  slice: "materialize-slice",
  drainBytes: "drain-bytes",
  emitChunk: "emit-chunk",
  pump: "pump",
  arm: "arm-reader",
  on: "register-listener",
  read: "read",
  setEncoding: "set-encoding",
  pause: "pause",
  resume: "resume",
  destroy: "destroy",
};

function stdinPreludeOrigins(prelude: string): CompilerSourceOriginSpan[] {
  const sf = ts.createSourceFile("__stdin_prelude_origins__.ts", prelude, ts.ScriptTarget.Latest, true);
  const origins: CompilerSourceOriginSpan[] = [];
  for (const statement of sf.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text === "__Js2wasmReadable") {
      origins.push({
        start: statement.getStart(sf),
        end: statement.end,
        origin: { producer: "process-stdin-prelude", role: "readable-class" },
      });
      for (const member of statement.members) {
        const name = member.name && ts.isIdentifier(member.name) ? member.name.text : undefined;
        const role = name ? STDIN_CLASS_MEMBER_ROLES[name] : undefined;
        if (!role)
          throw new Error(`missing compiler provenance role for process.stdin class member ${name ?? "<unnamed>"}`);
        origins.push({
          start: member.getStart(sf),
          end: member.end,
          origin: { producer: "process-stdin-prelude", role: `readable-${role}` },
        });
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.body && statement.name?.text === "__js2wasm_stdin") {
      origins.push({
        start: statement.getStart(sf),
        end: statement.end,
        origin: { producer: "process-stdin-prelude", role: "singleton-accessor" },
      });
    }
  }
  return origins;
}

export interface StdinPreludeResult {
  /** The transformed source (prelude prepended + `process.stdin` rewritten), or the input unchanged. */
  source: string;
  /** Output→input position map (identity when nothing was injected). */
  positionMap: PositionMap;
  /** True when the prelude was injected (the program references `process.stdin`). */
  injected: boolean;
}

/**
 * Detect `process.stdin` property-access sites in `source` and return their
 * `[start, end)` spans (the span of the `process.stdin` sub-expression, NOT the
 * outer `.on(...)`/`.read(...)`). A bare `process` identifier shadowed by a local
 * binding is NOT rewritten — we only rewrite an access whose receiver is the
 * global `process` (best-effort: skip when a local `process` declaration exists,
 * matching the conservative shadow check the timer shim and the node-emu scan
 * use).
 */
function findStdinAccesses(sf: ts.SourceFile): { start: number; end: number }[] {
  // Conservative shadow guard: if the program declares its own top-level
  // `process` (function / variable / class / import binding), do not rewrite —
  // the user owns that name. (`process.stdin` member access through a user
  // `process` is then their responsibility, exactly as for the timer shim.)
  let userDeclaresProcess = false;
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === "process") userDeclaresProcess = true;
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === "process") {
      userDeclaresProcess = true;
    } else if (ts.isClassDeclaration(stmt) && stmt.name?.text === "process") {
      userDeclaresProcess = true;
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const clause = stmt.importClause;
      if (clause.name?.text === "process") userDeclaresProcess = true;
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings) && clause.namedBindings.name.text === "process") {
          userDeclaresProcess = true;
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            if (el.name.text === "process") userDeclaresProcess = true;
          }
        }
      }
    }
  }
  if (userDeclaresProcess) return [];

  const spans: { start: number; end: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "stdin" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process"
    ) {
      // Span of `process.stdin` (getStart skips leading trivia; .end is the end
      // of the `.stdin` name). The outer `.on(...)`/`.read(...)` call wraps this.
      spans.push({ start: node.getStart(sf), end: node.end });
    }
    forEachChild(node, visit);
  };
  forEachChild(sf, visit);
  return spans;
}

/**
 * #2632 Phase 3 — inject the faithful `process.stdin` Readable prelude when the
 * program references `process.stdin`. Byte-neutral (identity map, unchanged
 * source) otherwise. Only the caller decides WASI gating; this function injects
 * whenever a `process.stdin` access is present.
 */
export function injectProcessStdinPrelude(source: string): StdinPreludeResult {
  // Cheap pre-check: skip the parse entirely if the literal text never appears.
  if (!source.includes("process") || !source.includes("stdin")) {
    return { source, positionMap: PositionMap.identity(), injected: false };
  }

  const sf = ts.createSourceFile("__stdin_scan__.ts", source, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const accesses = findStdinAccesses(sf);
  if (accesses.length === 0) {
    return { source, positionMap: PositionMap.identity(), injected: false };
  }

  const prelude = STDIN_READABLE_PRELUDE;

  // Edits, in INPUT coordinates: the prepend (offset 0, empty original span) plus
  // each `process.stdin` → `__js2wasm_stdin()` replacement. The PositionMap takes
  // them in input coordinates; it sorts internally.
  const edits = [
    {
      origStart: 0,
      origEnd: 0,
      newLength: prelude.length,
      compilerOrigins: stdinPreludeOrigins(prelude),
    },
    ...accesses.map((a) => ({ origStart: a.start, origEnd: a.end, newLength: STDIN_ACCESSOR.length })),
  ];
  const positionMap = new PositionMap(edits);

  // Apply the `process.stdin` replacements to the user source, last-first so
  // earlier offsets stay valid, then prepend the prelude.
  let body = source;
  const sorted = [...accesses].sort((a, b) => b.start - a.start);
  for (const a of sorted) {
    body = body.substring(0, a.start) + STDIN_ACCESSOR + body.substring(a.end);
  }

  return { source: prelude + body, positionMap, injected: true };
}

/**
 * The faithful string-chunk Readable library + the `__js2wasm_stdin()` singleton.
 *
 * Mirrors the byte-chunk `__Readable` proven end-to-end in
 * `tests/issue-2632-phase3-stdin-readable.test.ts`, but builds **string** chunks
 * (the Node-default representation for a stream without an explicit encoding is a
 * Buffer; in standalone Wasm we model the chunk as a JS string built via
 * `String.fromCharCode` over the buffered bytes — the natural js2wasm string
 * value). The #2641 native-string finalize-shift fix makes a string-building
 * class method compile to valid Wasm under `--target wasi`.
 *
 * Semantics (faithful to Node's Readable):
 *   - flowing mode (`.on('data')` / `.resume()`): each tick the reactor calls the
 *     pump, which drains newly buffered bytes into the chunk and, when not paused,
 *     emits the accumulated chunk as a single `'data'` event (one chunk per tick).
 *   - paused mode (default, or after `.pause()`): bytes accumulate in `chunk`;
 *     `.read([size])` returns a `size`-char substring (or all available when
 *     `size` is omitted), or **`null`** when fewer than `size` chars are buffered
 *     and EOF has not been reached. At EOF the remainder is returned, then `null`.
 *   - `'readable'` fires each tick that newly buffered bytes arrived.
 *   - `'end'` fires once fd0 is at EOF AND the stream's own buffer is fully
 *     delivered (a paused stream withholds bytes, so EOF alone is not end-of-read).
 *
 * The leading newline keeps the user's first line at line 2+ of the rewritten
 * source; the PositionMap restores the user's true line/column for diagnostics.
 */
const STDIN_READABLE_PRELUDE = `declare function __wasiStdinReadByte(): number;
declare function __wasiStdinAvailable(): number;
declare function __wasiStdinEof(): boolean;
declare function __wasiStdinSetReader(cb: () => void): void;
declare function __wasiStdinStop(): void;

class __Js2wasmReadable {
  // #2777 — accumulate drained bytes in an amortized-growth byte buffer instead
  // of building each 'data' chunk via per-byte string concatenation. Building the
  // chunk by \`this.chunk = this.chunk + String.fromCharCode(b)\` made a large
  // frame's read side quadratic (the consumer then re-flattened the growing
  // cons-rope on every charCodeAt/substring), which SIGKILLed nm_js2wasm_node_process at
  // multi-MiB. The bytes now live in \`buf[head..tail)\`; the chunk STRING the
  // Node 'data' contract delivers is materialised ONCE per emit/read from that
  // slice (a single flatten), so consumers receive a FLAT string and their
  // charCodeAt/substring over it is O(1)/O(k), not a re-flatten per access.
  private buf: Uint8Array = new Uint8Array(64);
  private head: number = 0;
  private tail: number = 0;
  private dataCbs: ((c: string) => void)[] = [];
  private endCbs: (() => void)[] = [];
  private readableCbs: (() => void)[] = [];
  private closeCbs: (() => void)[] = [];
  private flowing: boolean = false;
  private paused: boolean = false;
  private ended: boolean = false;
  private armed: boolean = false;
  private eofReadableFired: boolean = false;
  private destroyed: boolean = false;

  // Buffered byte count.
  private avail(): number { return this.tail - this.head; }

  // Ensure room for \`extra\` more bytes at \`tail\`: first reclaim any consumed
  // prefix (head > 0), then amortized-double the backing array until it fits.
  private ensure(extra: number): void {
    if (this.tail + extra <= this.buf.length) { return; }
    if (this.head > 0) {
      const m = this.tail - this.head;
      let i = 0;
      while (i < m) { this.buf[i] = this.buf[this.head + i]; i = i + 1; }
      this.head = 0;
      this.tail = m;
      if (this.tail + extra <= this.buf.length) { return; }
    }
    let cap = this.buf.length;
    if (cap < 16) { cap = 16; }
    while (cap < this.tail + extra) { cap = cap * 2; }
    const nb = new Uint8Array(cap);
    let j = 0;
    while (j < this.tail) { nb[j] = this.buf[j]; j = j + 1; }
    this.buf = nb;
  }

  // Materialise buf[start..end) as a FLAT string (one char per byte). The
  // trailing substring(0, len) forces a SINGLE flatten of the cons-rope built by
  // the per-byte concat, so the delivered chunk is flat — a consumer's
  // charCodeAt/substring over it is then O(1)/O(k), never a re-flatten per call.
  private slice(start: number, end: number): string {
    let s = "";
    let i = start;
    while (i < end) { s = s + String.fromCharCode(this.buf[i]); i = i + 1; }
    return s.substring(0, end - start);
  }

  // Append all currently-buffered stdin bytes into \`buf\` — O(n), no string ops.
  private drainBytes(): number {
    let n = 0;
    let b = __wasiStdinReadByte();
    while (b >= 0) {
      this.ensure(1);
      this.buf[this.tail] = b;
      this.tail = this.tail + 1;
      n = n + 1;
      b = __wasiStdinReadByte();
    }
    return n;
  }

  private emitChunk(): void {
    if (this.tail <= this.head) { return; }
    const out = this.slice(this.head, this.tail);
    this.head = 0;
    this.tail = 0;
    for (let i = 0; i < this.dataCbs.length; i = i + 1) { this.dataCbs[i](out); }
  }

  private pump(): void {
    // A destroyed stream emits no further 'readable'/'data'/'end' (Node parity)
    // and stops draining; the reactor's fd0 subscription was already dropped.
    if (this.destroyed) { return; }
    const got = this.drainBytes();
    const atEof = __wasiStdinEof();
    // 'readable' fires when new bytes arrived OR when the stream has just reached
    // EOF with bytes still buffered (Node emits a final 'readable' at end-of-
    // stream so the consumer can read the last partial chunk before 'end').
    const eofFlush = atEof && !this.eofReadableFired && this.avail() > 0;
    if (got > 0 || eofFlush) {
      if (eofFlush) { this.eofReadableFired = true; }
      for (let i = 0; i < this.readableCbs.length; i = i + 1) { this.readableCbs[i](); }
    }
    if (this.flowing && !this.paused) { this.emitChunk(); }
    // 'end' only after fd EOF AND the stream's own buffer is fully delivered
    // (a paused stream withholds bytes in this.chunk, so EOF alone is not the
    // end of the readable side -- matches Node).
    if (atEof && this.avail() === 0 && !this.ended) {
      this.ended = true;
      for (let i = 0; i < this.endCbs.length; i = i + 1) { this.endCbs[i](); }
    }
  }

  private arm(): void {
    if (this.armed) { return; }
    this.armed = true;
    __wasiStdinSetReader(() => { this.pump(); });
  }

  // #2752 — the callback parameter is a UNION of the 'data' shape ((c: string)
  // => void) and the param-less shape (() => void), NOT \`any\`. This is
  // load-bearing for TYPE-STRIPPED consumers (\`bun build\`/esbuild/tsc → .js):
  // a stripped \`.on("data", (chunk) => …)\` arrow has an UNTYPED param, and an
  // \`any\` \`cb\` would give it no contextual type, so \`chunk\` lowers as
  // externref. Its closure-struct shape ((externref) => void) then differs from
  // the \`((c: string) => void)[]\` slot it is stored in, and the call site in
  // \`emitChunk\` (a \`ref.cast\` to the (string)=>void closure struct) nulls the
  // mismatched value and TRAPS with a null reference. Typing \`cb\` as the union
  // makes TypeScript CONTEXTUALLY type the untyped \`chunk\` as \`string\` (the
  // 'data' member of the union), so the arrow lowers as a (string)=>void
  // closure that matches the slot — for BOTH the typed (direct .ts) and untyped
  // (transpiled .js) consumer callback. The \`() => void\` end/readable/close
  // callbacks remain assignable (the param-less union member). This only takes
  // effect because the injected prelude is now parsed under the TS grammar even
  // for a \`.js\` user file (the \`forceTsGrammar\` parse fix). The per-event
  // \`as\` casts narrow the union to the concrete slot element type.
  on(event: string, cb: ((c: string) => void) | (() => void)): __Js2wasmReadable {
    if (event === "data") { this.dataCbs.push(cb as (c: string) => void); this.flowing = true; this.arm(); }
    else if (event === "end") { this.endCbs.push(cb as () => void); this.arm(); }
    else if (event === "readable") { this.readableCbs.push(cb as () => void); this.arm(); }
    else if (event === "close") { this.closeCbs.push(cb as () => void); }
    return this;
  }

  // read([size]): returns a string chunk of up to size chars, or null when fewer
  // than size are buffered and EOF has not been reached (paused-mode semantics).
  read(size?: number): string | null {
    if (this.destroyed) { return null; }
    // Pull any freshly-ready bytes so a paused .read() sees the latest buffer.
    this.drainBytes();
    const avail = this.avail();
    if (size === undefined || size < 0) {
      if (avail === 0) { return null; }
      const all = this.slice(this.head, this.tail);
      this.head = 0;
      this.tail = 0;
      return all;
    }
    if (avail < size) {
      if (__wasiStdinEof() && avail > 0) {
        const rest = this.slice(this.head, this.tail);
        this.head = 0;
        this.tail = 0;
        return rest;
      }
      return null;
    }
    const out = this.slice(this.head, this.head + size);
    this.head = this.head + size;
    if (this.head >= this.tail) { this.head = 0; this.tail = 0; }
    return out;
  }

  // setEncoding(encoding): faithful Node Readable surface. In Node a stream with
  // NO explicit encoding delivers raw \`Buffer\` 'data' chunks; calling
  // \`setEncoding("latin1")\` (or "utf8", etc.) switches it to deliver decoded
  // STRING chunks instead. This prelude has no Buffer mode — it ALWAYS materialises
  // each chunk as a one-char-per-byte (latin1-equivalent) string via
  // \`String.fromCharCode\` — so under standalone Wasm \`setEncoding\` is a faithful
  // no-op that simply returns \`this\`. Exposing it lets a single source call
  // \`process.stdin.setEncoding("latin1")\` so the SAME program runs under REAL node
  // (where it switches the real stream to latin1 string chunks, so byte-reading
  // consumers like \`charCodeAt\` work) AND compiles to Wasm unchanged (#2834).
  setEncoding(encoding?: string): __Js2wasmReadable { return this; }

  pause(): __Js2wasmReadable { this.paused = true; return this; }

  resume(): __Js2wasmReadable {
    this.paused = false;
    this.flowing = true;
    this.arm();
    // Flush any bytes withheld while paused immediately (the reactor may already
    // be at EOF and not call the hook again).
    this.pump();
    return this;
  }

  // destroy(): tear the stream down NOW. Unlike .pause() (which leaves stdin
  // subscribed so the process stays alive while data listeners remain), destroy
  // drops the fd0 reactor subscription via __wasiStdinStop(), so the run loop's
  // 'pending' test falls through and _start returns cleanly EVEN THOUGH stdin
  // never reached EOF. This is the in-band / programmatic shutdown escape hatch
  // (#2735): without it the reactor's only exit is stdin EOF, which hangs when
  // the peer keeps the pipe open (the real Native-Messaging case). Emits 'close'
  // once, then suppresses all further events (Node parity).
  destroy(): __Js2wasmReadable {
    if (this.destroyed) { return this; }
    this.destroyed = true;
    __wasiStdinStop();
    for (let i = 0; i < this.closeCbs.length; i = i + 1) { this.closeCbs[i](); }
    return this;
  }
}

let __js2wasmStdinSingleton: __Js2wasmReadable | null = null;
function __js2wasm_stdin(): __Js2wasmReadable {
  if (__js2wasmStdinSingleton === null) { __js2wasmStdinSingleton = new __Js2wasmReadable(); }
  return __js2wasmStdinSingleton;
}
`;
