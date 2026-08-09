// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3146 — standalone `Iterator.zip / zipKeyed / concat / from` source-prelude
 * injection.
 *
 * The four ES2025+ Iterator static helpers used to hard-CE standalone through
 * the `__get_builtin` dynamic-shape refusal (#1472 Phase B) — the largest
 * in-scope builtin-CALL-surface bucket of the #2984 triage (~99 records).
 * Rather than hand-emitting the (intricate) IteratorZip / IteratorCloseAll
 * close-ordering machinery as raw `Instr[]`, this module follows the #2632
 * `process.stdin` Readable model: the helpers are written as ORDINARY
 * TypeScript, prepended as a source prelude, and `Iterator.zip` (etc.)
 * references are REWRITTEN to the prelude functions. The prelude flows through
 * the normal pipeline (closures, objects, try/catch all already work
 * standalone), with a {@link PositionMap} so diagnostics still report the
 * user's original line/column.
 *
 * The prelude drives EVERY source iterable through the native iterator
 * runtime (`iterator-native.ts` — GetIterator ladder, `.next()` stepping,
 * `.return()`-forwarding IteratorClose) via four compiler intrinsics
 * recognized in `codegen/iterator-statics-native.ts`:
 *   - `__j2w_iter_rec(o)`   → native `__iterator(o)` (GetIteratorFlattenable-ish)
 *   - `__j2w_iter_step(rec)`→ native `__iterator_next(rec)`; returns done (0/1)
 *                             and parks the step value in a scratch global
 *   - `__j2w_iter_value()`  → reads the parked step value
 *   - `__j2w_iter_close(rec)`→ native `__iterator_return(rec)` (forwards to the
 *                             user iterator's `return` method, receiver-correct)
 *
 * DIALECT NOTE (probed 2026-07-12, see issue #3146 Test Results): the prelude
 * deliberately restricts itself to the standalone-safe subset —
 *   - mutable state lives in OBJECT FIELDS, never in closure-captured locals
 *     mutated by a callee that can throw (capture write-back is lost on abrupt
 *     exit);
 *   - methods are invoked DIRECTLY (`w.step()`), never extracted + `.call`;
 *   - arrays grow only via `.push()` (index-write growth traps), and elements
 *     read back out of an `any[]` are used for METHOD CALLS / passed along as
 *     values, never naked data-property reads (closed-struct field reads
 *     through a boxed element trap).
 *
 * Injection is import-scoped + host-free-target-only: it fires ONLY when the
 * program references `Iterator.<helper>` under `--target standalone|wasi`
 * (JS-host mode keeps the runtime.ts polyfills, #1464). Byte-identical
 * otherwise. The prelude is inserted AFTER any leading directive prologue so
 * a test's `"use strict"` stays a directive.
 */
import { PositionMap, type CompilerSourceOriginSpan } from "./position-map.js";
import { ts } from "./ts-api.js";

const { forEachChild } = ts;

/** The four rewritten helpers: `Iterator.zip` → `__js2wasm_Iterator_zip`, … */
const HELPERS = ["zip", "zipKeyed", "concat", "from"] as const;

const ITERATOR_PRELUDE_FUNCTION_ROLES: Readonly<Record<string, string>> = {
  __j2wIterWrap: "wrapped-source",
  __j2wIterCloseRev: "reverse-close",
  __j2wIterCloseAll: "close-all",
  __j2wIterReadMode: "read-mode",
  __j2wIterRequireObject: "require-object",
  __j2wIterZipCore: "zip-core",
  __js2wasm_Iterator_zip: "zip",
  __js2wasm_Iterator_zipKeyed: "zip-keyed",
  __js2wasm_Iterator_concat: "concat",
  __js2wasm_Iterator_from: "from",
};

function iteratorPreludeOrigins(prelude: string): CompilerSourceOriginSpan[] {
  const sf = ts.createSourceFile("__iterator_prelude_origins__.ts", prelude, ts.ScriptTarget.Latest, true);
  const origins: CompilerSourceOriginSpan[] = [];
  for (const statement of sf.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.body || !statement.name) continue;
    const role = ITERATOR_PRELUDE_FUNCTION_ROLES[statement.name.text];
    if (!role) throw new Error(`missing compiler provenance role for iterator helper ${statement.name.text}`);
    origins.push({
      start: statement.getStart(sf),
      end: statement.end,
      origin: { producer: "iterator-statics-prelude", role },
    });
  }
  return origins;
}

export interface IteratorStaticsPreludeResult {
  /** Transformed source (prelude inserted + accesses rewritten), or the input unchanged. */
  source: string;
  /** Output→input position map (identity when nothing was injected). */
  positionMap: PositionMap;
  /** True when the prelude was injected. */
  injected: boolean;
}

/**
 * Find `Iterator.zip` / `Iterator.zipKeyed` / `Iterator.concat` /
 * `Iterator.from` property-access spans whose receiver is the GLOBAL
 * `Iterator` identifier. Conservative shadow guard: a program that declares
 * its own top-level `Iterator` binding is never rewritten (same policy as the
 * stdin/timer shims).
 */
function findIteratorHelperAccesses(sf: ts.SourceFile): { start: number; end: number; name: string }[] {
  let userDeclaresIterator = false;
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === "Iterator") userDeclaresIterator = true;
      }
    } else if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name?.text === "Iterator") {
      // The test262 runner prepends a MINIMAL %Iterator% shim —
      // `function Iterator(this: any): void {}` — solely so
      // `Iterator.prototype` / `class X extends Iterator` bind (see
      // needsIteratorBinding in tests/test262-runner.ts). That shim carries no
      // static helpers, so it must NOT suppress the zip/zipKeyed/concat/from
      // rewrite: an EMPTY-BODY function declaration named `Iterator` is
      // treated as the shim, not a user binding. Any Iterator declaration
      // with an actual body (or a class / variable) still blocks the rewrite —
      // the user owns that name.
      const isEmptyShimFn =
        ts.isFunctionDeclaration(stmt) && stmt.body !== undefined && stmt.body.statements.length === 0;
      if (!isEmptyShimFn) userDeclaresIterator = true;
    }
  }
  if (userDeclaresIterator) return [];

  const spans: { start: number; end: number; name: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      (HELPERS as readonly string[]).includes(node.name.text) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Iterator"
    ) {
      spans.push({ start: node.getStart(sf), end: node.end, name: node.name.text });
    }
    forEachChild(node, visit);
  };
  forEachChild(sf, visit);
  return spans;
}

/**
 * Offset just past the leading directive prologue (`"use strict";` and
 * friends) so the prelude insertion never demotes a directive to a plain
 * string expression.
 */
function directivePrologueEnd(sf: ts.SourceFile): number {
  let end = 0;
  for (const stmt of sf.statements) {
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
      end = stmt.end;
      continue;
    }
    break;
  }
  return end;
}

/**
 * #3146 — inject the standalone Iterator-statics prelude when the program
 * references `Iterator.zip|zipKeyed|concat|from`. Byte-neutral (identity map,
 * unchanged source) otherwise. The caller decides target gating; this
 * function injects whenever a helper access is present.
 */
export function injectIteratorStaticsPrelude(source: string): IteratorStaticsPreludeResult {
  // Cheap pre-check before paying for a parse.
  if (!source.includes("Iterator")) {
    return { source, positionMap: PositionMap.identity(), injected: false };
  }
  let mentionsHelper = false;
  for (const h of HELPERS) {
    if (source.includes(h)) {
      mentionsHelper = true;
      break;
    }
  }
  if (!mentionsHelper) {
    return { source, positionMap: PositionMap.identity(), injected: false };
  }

  const sf = ts.createSourceFile("__iter_statics_scan__.ts", source, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const accesses = findIteratorHelperAccesses(sf);
  if (accesses.length === 0) {
    return { source, positionMap: PositionMap.identity(), injected: false };
  }

  const prelude = ITERATOR_STATICS_PRELUDE;
  const insertAt = directivePrologueEnd(sf);

  // Edits in INPUT coordinates: the prelude insertion plus each
  // `Iterator.<helper>` → `__js2wasm_Iterator_<helper>` replacement.
  const edits = [
    {
      origStart: insertAt,
      origEnd: insertAt,
      newLength: prelude.length,
      compilerOrigins: iteratorPreludeOrigins(prelude),
    },
    ...accesses.map((a) => ({
      origStart: a.start,
      origEnd: a.end,
      newLength: `__js2wasm_Iterator_${a.name}`.length,
    })),
  ];
  const positionMap = new PositionMap(edits);

  // Apply replacements last-first so earlier offsets stay valid, then insert
  // the prelude at the directive-prologue boundary.
  let body = source;
  const sorted = [...accesses].sort((a, b) => b.start - a.start);
  for (const a of sorted) {
    body = body.substring(0, a.start) + `__js2wasm_Iterator_${a.name}` + body.substring(a.end);
  }
  body = body.substring(0, insertAt) + prelude + body.substring(insertAt);

  return { source: body, positionMap, injected: true };
}

/**
 * The prelude library. All functions/objects stay inside the probed
 * standalone-safe dialect (see the module doc). Spec references: ES2026
 * §27.1.2 (Iterator.concat / Iterator.from), the joint-iteration proposal
 * (Iterator.zip / Iterator.zipKeyed), §7.4.9 IteratorClose, IteratorCloseAll.
 *
 * The leading/trailing newlines keep the prelude self-delimiting when
 * inserted mid-source (after a directive prologue).
 */
const ITERATOR_STATICS_PRELUDE = `
declare function __j2w_iter_rec(o: any): any;
declare function __j2w_iter_step(rec: any): number;
declare function __j2w_iter_value(): any;
declare function __j2w_iter_close(rec: any): void;

// One wrapped source iterator: native rec + open flag + longest-mode padding +
// zipKeyed key + linked-chain next pointer. ALL mutable state lives in fields
// (abrupt-exit-safe) and ALL consumers go through methods. The wrappers form a
// LINKED CHAIN (head captured by the result-iterator methods) instead of an
// array on purpose: element reads of a closure-CAPTURED any[] silently lose
// method dispatch on this backend (probed 2026-07-12), while direct method
// calls on chained objects are reliable.
function __j2wIterWrap(o: any): any {
  return {
    rec: __j2w_iter_rec(o),
    open: 1,
    pad: undefined as any,
    key: undefined as any,
    nxt: undefined as any,
    isOpen(): number {
      return this.open;
    },
    step(): number {
      let d: number = 0;
      try {
        d = __j2w_iter_step(this.rec);
      } catch (e) {
        // IteratorStepValue abrupt (7.4.7) -> [[Done]] = true (never close it).
        this.open = 0;
        throw e;
      }
      if (d === 1) this.open = 0;
      return d;
    },
    close(): void {
      if (this.open === 1) {
        this.open = 0;
        __j2w_iter_close(this.rec);
      }
    },
    markDone(): void {
      this.open = 0;
    },
    setPad(v: any): void {
      this.pad = v;
    },
    getPad(): any {
      return this.pad;
    },
    setKey(k: any): void {
      this.key = k;
    },
    getKey(): any {
      return this.key;
    },
    setNext(w: any): void {
      this.nxt = w;
    },
    getNext(): any {
      return this.nxt;
    },
  };
}

// Reverse-order close of the chain starting at w (IteratorCloseAll order: the
// LAST wrapper closes first). Returns an open {has, err} marker with the
// first abrupt completion of the close sequence; every close still runs.
function __j2wIterCloseRev(w: any): any {
  if (w === undefined) return { has: 0, err: undefined as any };
  const later: any = __j2wIterCloseRev(w.getNext());
  let has: number = later.has;
  let err: any = later.err;
  try {
    w.close();
  } catch (e) {
    if (has === 0) {
      has = 1;
      err = e;
    }
  }
  return { has: has, err: err };
}

// IteratorCloseAll (joint-iteration): close every still-open wrapper from
// head in REVERSE chain order, threading the completion - an incoming throw
// completion wins over any close-method throw; otherwise the first close
// throw (in close order) becomes the completion. Throws the final abrupt
// completion; returns normally when everything closed cleanly.
function __j2wIterCloseAll(head: any, hasPrimary: number, primary: any): void {
  const m: any = __j2wIterCloseRev(head);
  if (hasPrimary === 1) throw primary;
  if (m.has === 1) throw m.err;
}

// mode codes: 0 = shortest, 1 = longest, 2 = strict.
function __j2wIterReadMode(options: any): number {
  if (options === undefined) return 0;
  if (options === null || typeof options !== "object") {
    throw new TypeError("Iterator.zip: options must be an object");
  }
  const m: any = options.mode;
  if (m === undefined || m === "shortest") return 0;
  if (m === "longest") return 1;
  if (m === "strict") return 2;
  throw new TypeError("Iterator.zip: invalid mode");
}

// GetIteratorFlattenable(item, reject-strings) input guard shared by
// zip/zipKeyed inner sources (strings/primitives -> TypeError).
function __j2wIterRequireObject(item: any, what: string): void {
  if (item === null || item === undefined || typeof item !== "object") {
    throw new TypeError(what);
  }
}

// The IteratorZip abstract closure (joint-iteration) over the wrapper chain.
// keyed=0 -> yield arrays; keyed=1 -> yield {key: value} objects built from
// each wrapper's key.
function __j2wIterZipCore(head: any, mode: number, keyed: number): any {
  const st: any = { done: 0 };
  // NOTE: the result iterator is a PLAIN OBJECT (no computed [Symbol.iterator]
  // key in the literal - that would pre-shape it into a closed struct, and
  // same-shaped closed literals share one struct type whose name-keyed
  // __call_next/__call_return dispatch collapses onto the LAST-compiled body,
  // misrouting zip/concat/from between each other; #1557/#1989 fork only
  // ToPrimitive methods). As an open object its methods are PER-INSTANCE
  // closure properties driven by the #3119 OBJ arms - always correct. The
  // @@iterator self-reference is installed post-hoc below (the #3119 lane),
  // which also admits the result to the Array.from drain.
  const res: any = {
    next(): any {
      if (st.done === 1) return { done: true, value: undefined };
      let anyOpen: number = 0;
      let scan: any = head;
      while (scan !== undefined) {
        if (scan.isOpen() === 1) anyOpen = 1;
        scan = scan.getNext();
      }
      if (anyOpen === 0) {
        st.done = 1;
        return { done: true, value: undefined };
      }
      const results: any[] = [];
      const keyedOut: any = {};
      let w: any = head;
      let i: number = 0;
      while (w !== undefined) {
        let v: any = undefined;
        if (w.isOpen() === 0) {
          // exhausted in an earlier round - longest-mode padding slot
          v = w.getPad();
        } else {
          let d: number = 0;
          try {
            d = w.step();
          } catch (e) {
            st.done = 1;
            __j2wIterCloseAll(head, 1, e);
          }
          if (d === 1) {
            if (mode === 0) {
              // shortest: close the rest, done.
              st.done = 1;
              __j2wIterCloseAll(head, 0, undefined);
              return { done: true, value: undefined };
            }
            if (mode === 2) {
              // strict
              if (i !== 0) {
                st.done = 1;
                __j2wIterCloseAll(head, 1, new TypeError("Iterator.zip strict mode: length mismatch"));
              }
              // i === 0: every remaining iterator must also be done.
              let wk: any = head.getNext();
              while (wk !== undefined) {
                let dk: number = 0;
                try {
                  dk = wk.step();
                } catch (e2) {
                  st.done = 1;
                  __j2wIterCloseAll(head, 1, e2);
                }
                if (dk === 0) {
                  st.done = 1;
                  __j2wIterCloseAll(head, 1, new TypeError("Iterator.zip strict mode: length mismatch"));
                }
                wk = wk.getNext();
              }
              st.done = 1;
              return { done: true, value: undefined };
            }
            // longest: if EVERYTHING is now exhausted, end without a result.
            let stillOpen: number = 0;
            let scan2: any = head;
            while (scan2 !== undefined) {
              if (scan2.isOpen() === 1) stillOpen = 1;
              scan2 = scan2.getNext();
            }
            if (stillOpen === 0) {
              st.done = 1;
              return { done: true, value: undefined };
            }
            v = w.getPad();
          } else {
            v = __j2w_iter_value();
          }
        }
        if (keyed === 1) {
          keyedOut[w.getKey() as string] = v;
        } else {
          results.push(v);
        }
        w = w.getNext();
        i = i + 1;
      }
      if (keyed === 1) {
        return { done: false, value: keyedOut };
      }
      return { done: false, value: results };
    },
    // Zero-arg on purpose - the closed-struct __call_return dispatcher
    // (IteratorClose forwarding) calls return methods with the receiver only.
    return(): any {
      if (st.done === 0) {
        st.done = 1;
        __j2wIterCloseAll(head, 0, undefined);
      }
      return { done: true, value: undefined };
    },
  };
  res[Symbol.iterator] = function (): any {
    return res;
  };
  return res;
}

function __js2wasm_Iterator_zip(iterables: any, options?: any): any {
  __j2wIterRequireObject(iterables, "Iterator.zip: iterables must be an object");
  const mode: number = __j2wIterReadMode(options);
  let paddingOption: any = undefined;
  if (mode === 1) {
    paddingOption = options.padding;
    if (paddingOption !== undefined && (paddingOption === null || typeof paddingOption !== "object")) {
      throw new TypeError("Iterator.zip: padding must be an object");
    }
  }
  // Collect the inner iterators into the wrapper chain (closing everything
  // already opened - plus the outer iterables iterator - on abrupt).
  let head: any = undefined;
  let tail: any = undefined;
  const outer: any = __j2wIterWrap(iterables);
  while (true) {
    let d: number = 0;
    try {
      d = outer.step();
    } catch (e) {
      __j2wIterCloseAll(head, 1, e);
    }
    if (d === 1) break;
    const item: any = __j2w_iter_value();
    if (item === null || item === undefined || typeof item !== "object") {
      try {
        outer.close();
      } catch (e2) {}
      __j2wIterCloseAll(head, 1, new TypeError("Iterator.zip: iterables must yield objects"));
    }
    let w: any = undefined;
    try {
      w = __j2wIterWrap(item);
    } catch (e) {
      try {
        outer.close();
      } catch (e2) {}
      __j2wIterCloseAll(head, 1, e);
    }
    if (head === undefined) {
      head = w;
    } else {
      tail.setNext(w);
    }
    tail = w;
  }
  // longest-mode padding: undefined-fill (the wrapper default), or drain the
  // padding iterable one entry per zipped iterator (closing it on excess).
  if (mode === 1 && paddingOption !== undefined) {
    const pw: any = __j2wIterWrap(paddingOption);
    let exhausted: number = 0;
    let w: any = head;
    while (w !== undefined) {
      let v: any = undefined;
      if (exhausted === 0) {
        let d: number = 0;
        try {
          d = pw.step();
        } catch (e) {
          __j2wIterCloseAll(head, 1, e);
        }
        if (d === 1) {
          exhausted = 1;
        } else {
          v = __j2w_iter_value();
        }
      }
      w.setPad(v);
      w = w.getNext();
    }
    if (exhausted === 0) {
      try {
        pw.close();
      } catch (e) {
        __j2wIterCloseAll(head, 1, e);
      }
    }
  }
  return __j2wIterZipCore(head, mode, 0);
}

function __js2wasm_Iterator_zipKeyed(iterables: any, options?: any): any {
  __j2wIterRequireObject(iterables, "Iterator.zipKeyed: iterables must be an object");
  const mode: number = __j2wIterReadMode(options);
  let paddingOption: any = undefined;
  if (mode === 1) {
    paddingOption = options.padding;
    if (paddingOption !== undefined && (paddingOption === null || typeof paddingOption !== "object")) {
      throw new TypeError("Iterator.zipKeyed: padding must be an object");
    }
  }
  let head: any = undefined;
  let tail: any = undefined;
  const allKeys: any = Object.keys(iterables);
  for (const k of allKeys) {
    const value: any = iterables[k as string];
    if (value === undefined) continue;
    if (value === null || typeof value !== "object") {
      __j2wIterCloseAll(head, 1, new TypeError("Iterator.zipKeyed: values must be objects"));
    }
    let w: any = undefined;
    try {
      w = __j2wIterWrap(value);
    } catch (e) {
      __j2wIterCloseAll(head, 1, e);
    }
    w.setKey(k);
    if (mode === 1 && paddingOption !== undefined) {
      let pv: any = undefined;
      try {
        pv = paddingOption[k as string];
      } catch (e) {
        __j2wIterCloseAll(head, 1, e);
      }
      w.setPad(pv);
    }
    if (head === undefined) {
      head = w;
    } else {
      tail.setNext(w);
    }
    tail = w;
  }
  return __j2wIterZipCore(head, mode, 1);
}

function __js2wasm_Iterator_concat(...items: any[]): any {
  for (let i = 0; i < items.length; i++) {
    const it: any = items[i];
    if (it === null || it === undefined || typeof it !== "object") {
      throw new TypeError("Iterator.concat: argument is not an object");
    }
  }
  const st: any = { idx: 0, cur: undefined as any, done: 0 };
  // Open-object result on purpose - see the __j2wIterZipCore note.
  const res: any = {
    next(): any {
      if (st.done === 1) return { done: true, value: undefined };
      while (true) {
        if (st.cur === undefined) {
          if (st.idx >= items.length) {
            st.done = 1;
            return { done: true, value: undefined };
          }
          st.cur = __j2wIterWrap(items[st.idx]);
          st.idx = st.idx + 1;
        }
        const w: any = st.cur;
        let d: number = 0;
        try {
          d = w.step();
        } catch (e) {
          st.cur = undefined;
          st.done = 1;
          throw e;
        }
        if (d === 1) {
          st.cur = undefined;
          continue;
        }
        return { done: false, value: __j2w_iter_value() };
      }
    },
    return(): any {
      if (st.done === 0) {
        st.done = 1;
        const w: any = st.cur;
        st.cur = undefined;
        if (w !== undefined) w.close();
      }
      return { done: true, value: undefined };
    },
  };
  res[Symbol.iterator] = function (): any {
    return res;
  };
  return res;
}

function __js2wasm_Iterator_from(O: any): any {
  const t: string = typeof O;
  if (O === null || O === undefined || (t !== "object" && t !== "string" && t !== "function")) {
    throw new TypeError("Iterator.from: source is not an object or string");
  }
  const w: any = __j2wIterWrap(O);
  // Open-object result on purpose - see the __j2wIterZipCore note.
  const res: any = {
    next(): any {
      if (w.isOpen() === 0) return { done: true, value: undefined };
      const d: number = w.step();
      if (d === 1) return { done: true, value: undefined };
      return { done: false, value: __j2w_iter_value() };
    },
    return(): any {
      w.close();
      return { done: true, value: undefined };
    },
  };
  res[Symbol.iterator] = function (): any {
    return res;
  };
  return res;
}
`;
