// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#4415) One shared encoder for names. `new TextEncoder()` per `name()` call
 * allocated one object per import, export, function name and custom-section
 * key in the module.
 */
const NAME_ENCODER = new TextEncoder();

export class WasmEncoder {
  /**
   * (#4415) A growable `Uint8Array`, not `number[]`.
   *
   * This was a boxed JS array pushed one byte at a time, with `finish()`
   * copying the whole thing into a `Uint8Array`. A CPU profile of 40
   * steady-state test262 compiles put `byte()` at **5.1% of total compile
   * time** — the largest non-GC entry — with the garbage collector at 10.2%,
   * fed largely by this array's repeated growth and the boxed elements.
   *
   * `section()` makes it worse than linear: it encodes into a sub-encoder,
   * finishes it, then copied the result back one byte at a time, so nested
   * sections re-copied their payload per level. `bytes()` is now a bulk
   * `set()`.
   */
  private buf = new Uint8Array(1024);
  private len = 0;

  private ensure(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b: number): void {
    if (this.len === this.buf.length) this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }

  bytes(bs: number[] | Uint8Array): void {
    this.ensure(bs.length);
    if (bs instanceof Uint8Array) {
      this.buf.set(bs, this.len);
      this.len += bs.length;
      return;
    }
    for (const b of bs) this.buf[this.len++] = b & 0xff;
  }

  /** Unsigned LEB128 */
  u32(value: number): void {
    // #1858 P0.6: this encoder is the last line of defense before bytes hit the
    // wasm binary. Previously a value >= 2^32 silently truncated and a negative
    // value (e.g. -1 from a stale/underflowed index) encoded as 0xFFFFFFFF —
    // plausible-but-wrong bytes that produce an invalid module caught (if at
    // all) only at instantiation. Fail loud on out-of-range input instead.
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`u32 out of range: ${value}`);
    }
    do {
      let b = value & 0x7f;
      value >>>= 7;
      if (value !== 0) b |= 0x80;
      this.byte(b);
    } while (value !== 0);
  }

  /** Signed LEB128 */
  i32(value: number): void {
    let more = true;
    while (more) {
      let b = value & 0x7f;
      value >>= 7;
      if ((value === 0 && (b & 0x40) === 0) || (value === -1 && (b & 0x40) !== 0)) {
        more = false;
      } else {
        b |= 0x80;
      }
      this.byte(b);
    }
  }

  /** Signed LEB128 i64 — truncate to 64 bits to prevent overflow */
  i64(value: bigint): void {
    value = BigInt.asIntN(64, value);
    let more = true;
    while (more) {
      let b = Number(value & 0x7fn);
      value >>= 7n;
      if ((value === 0n && (b & 0x40) === 0) || (value === -1n && (b & 0x40) !== 0)) {
        more = false;
      } else {
        b |= 0x80;
      }
      this.byte(b);
    }
  }

  /** IEEE 754 f64 little-endian */
  f64(value: number): void {
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = value;
    this.bytes(new Uint8Array(buf));
  }

  /** IEEE 754 f32 little-endian */
  f32(value: number): void {
    const buf = new ArrayBuffer(4);
    new Float32Array(buf)[0] = value;
    this.bytes(new Uint8Array(buf));
  }

  /** v128 constant — 16 bytes little-endian */
  v128(bytes: Uint8Array): void {
    if (bytes.length !== 16) throw new Error("v128 must be exactly 16 bytes");
    this.bytes(bytes);
  }

  /** UTF-8 string with length prefix */
  name(s: string): void {
    const encoded = NAME_ENCODER.encode(s);
    this.u32(encoded.length);
    this.bytes(encoded);
  }

  /** Section: id + length-prefixed content */
  section(id: number, content: (enc: WasmEncoder) => void): void {
    const sub = new WasmEncoder();
    content(sub);
    const data = sub.finish();
    this.byte(id);
    this.u32(data.length);
    this.bytes(data);
  }

  /** Vector: u32 count + items */
  vector<T>(items: T[], encode: (item: T, enc: WasmEncoder) => void): void {
    this.u32(items.length);
    for (const item of items) encode(item, this);
  }

  /** Get current buffer length */
  get length(): number {
    return this.len;
  }

  /** Get current write position (alias for length, used by relocation tracking) */
  get position(): number {
    return this.len;
  }

  /**
   * A COPY of the bytes written so far. Deliberately `slice`, not `subarray`:
   * the previous implementation returned a fresh array, and callers (notably
   * `section()`) keep using the encoder afterwards, so a view would alias.
   */
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
