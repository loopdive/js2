// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1928 — source-position remapping for pre-parse rewrites.
 *
 * Diagnostics are computed by the TS checker against the *rewritten* source
 * (timer shim prepended, imports replaced by `declare` stubs, CJS `require`
 * rewritten, `define` substitutions), so a reported `(line, column)` is wrong
 * — often by several lines — whenever any pre-parse rewrite fires. There is no
 * way to recover the user's position from the processed source alone.
 *
 * A `PositionMap` records the character-level edits a rewriter applied (each in
 * the coordinate space of the text it consumed) and translates an offset in the
 * *output* text back to an offset in the *input* text. Rewriters run in a
 * pipeline (define → CJS → eval/super → imports+shim), so the maps compose:
 * `outer.compose(inner)` yields a map from the outermost output straight back
 * to the original source.
 *
 * Mapping policy (matches the issue's pragmatic guidance):
 *   - An offset OUTSIDE every edited span maps back by the net length delta of
 *     all edits that ended before it — exact.
 *   - An offset INSIDE a replaced span (e.g. within an injected `declare`
 *     stub, which has no user-source counterpart) maps to the START of the
 *     original replaced span. Diagnostics rarely point inside an injected stub;
 *     anchoring at the original statement is the correct, stable fallback.
 */

/**
 * One text edit, in the coordinate space of the INPUT this rewriter consumed:
 * the half-open span `[origStart, origEnd)` was replaced by text of length
 * `newLength`. A pure prepend is `origStart = origEnd = 0` with `newLength` =
 * the prepended length.
 */
export interface SourceEdit {
  readonly origStart: number;
  readonly origEnd: number;
  readonly newLength: number;
  /** Compiler producer metadata for generated declarations in replacement text. */
  readonly compilerOrigins?: readonly CompilerSourceOriginSpan[];
}

export type CompilerSourceProducer =
  | "timer-shim"
  | "node-path-prelude"
  | "node-path-binding"
  | "import-wrapper"
  | "eval-super-rewrite"
  | "process-stdin-prelude"
  | "iterator-statics-prelude";

export interface CompilerSourceOrigin {
  readonly producer: CompilerSourceProducer;
  /** Producer-owned semantic role, independent of a parsed display name. */
  readonly role: string;
}

/** Half-open span relative to one edit's generated output text. */
export interface CompilerSourceOriginSpan {
  readonly start: number;
  readonly end: number;
  readonly origin: CompilerSourceOrigin;
}

export class PositionMap {
  /**
   * A single-stage map is described by its edit list; a composed map is a
   * chain `outer → inner` translated by function composition (apply `outer`'s
   * single-stage transform, then defer to `inner`). Keeping composition as
   * function composition (rather than flattening two edit lists into one)
   * avoids the interleaving-delta correctness traps of merging transforms.
   */
  private readonly edits: readonly SourceEdit[];
  private readonly inner?: PositionMap;

  constructor(edits: readonly SourceEdit[], inner?: PositionMap) {
    this.edits = [...edits].sort((a, b) => a.origStart - b.origStart);
    this.inner = inner;
  }

  /** Identity map — output offsets equal input offsets. */
  static identity(): PositionMap {
    return new PositionMap([]);
  }

  /** Apply only THIS stage's single transform (output → its direct input). */
  private toDirectInputOffset(outOffset: number): number {
    // Walk edits in input order, tracking the cumulative (output − input)
    // delta. Each edit contributes `newLength` to the output and
    // `(origEnd − origStart)` to the input.
    let delta = 0;
    for (const e of this.edits) {
      const outEditStart = e.origStart + delta;
      const outEditEnd = outEditStart + e.newLength;
      if (outOffset < outEditStart) {
        // Before this edit's output span — only earlier deltas apply.
        break;
      }
      if (outOffset < outEditEnd) {
        // Inside the replacement text → anchor at the original span start.
        return e.origStart;
      }
      delta += e.newLength - (e.origEnd - e.origStart);
    }
    return Math.max(0, outOffset - delta);
  }

  /**
   * Translate an offset in this map's OUTPUT text all the way back to the
   * ORIGINAL source: apply this stage, then defer to the earlier stage(s).
   */
  toInputOffset(outOffset: number): number {
    const direct = this.toDirectInputOffset(outOffset);
    return this.inner ? this.inner.toInputOffset(direct) : direct;
  }

  /**
   * Return compiler-owned provenance for an OUTPUT offset, if any.
   *
   * Tagged replacement text wins at the stage that generated it. Untagged
   * later replacements recurse through their original anchor, so provenance
   * from an earlier compiler insertion survives composition. Pure insertion
   * gaps intentionally have no input provenance.
   */
  compilerOriginAtOutputOffset(outOffset: number): CompilerSourceOrigin | undefined {
    if (!Number.isSafeInteger(outOffset) || outOffset < 0) return undefined;
    let delta = 0;
    for (const edit of this.edits) {
      const outEditStart = edit.origStart + delta;
      const outEditEnd = outEditStart + edit.newLength;
      if (outOffset < outEditStart) break;
      if (outOffset < outEditEnd) {
        const relative = outOffset - outEditStart;
        const tagged = edit.compilerOrigins
          ?.filter((span) => relative >= span.start && relative < span.end)
          .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
        if (tagged) return tagged.origin;
        if (edit.origStart === edit.origEnd) return undefined;
        return this.inner?.compilerOriginAtOutputOffset(edit.origStart);
      }
      delta += edit.newLength - (edit.origEnd - edit.origStart);
    }
    const direct = this.toDirectInputOffset(outOffset);
    return this.inner?.compilerOriginAtOutputOffset(direct);
  }

  /**
   * Compose with the map of an EARLIER pipeline stage. `this` maps
   * stage-N-output → stage-N-input; `inner` maps stage-N-input (== stage-(N−1)
   * output) → original. The result maps stage-N-output → original.
   */
  compose(inner: PositionMap): PositionMap {
    if (inner.isIdentity) return this;
    if (this.isIdentity) return inner;
    return new PositionMap(this.edits, this.inner ? this.inner.compose(inner) : inner);
  }

  /** True when this is the identity (no edits and no earlier stage). */
  get isIdentity(): boolean {
    return this.edits.length === 0 && (this.inner?.isIdentity ?? true);
  }
}
