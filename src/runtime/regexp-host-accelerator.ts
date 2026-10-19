// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6978) Host side of the `regexp` host accelerator: runs the native regime's
 * registered RegExp programs on the JS engine's RegExp. See
 * `src/codegen/helpers/host-regexp-search.ts` for the Wasm side and the
 * protocol. State is per instance (keyed by the binder's instance state).
 *
 * `__regexp_host_exec` answers -2 (hand me the subject first), -1 (unknown
 * program — run the native VM), 0 (no match) or 1 (match; captures readable
 * through `__regexp_host_capture(slot)`, unmatched / scratch slots read -1).
 */

// Flag bits of `$NativeRegExp.flags` (src/codegen/regex/bytecode.ts RE_FLAG_*);
// only the bits that change what a pattern matches are forwarded. g/y/d are
// supplied per search (start index + sticky), so they never come from here.
const MATCH_FLAG_BITS: ReadonlyArray<readonly [number, string]> = [
  [2, "i"],
  [4, "m"],
  [8, "s"],
  [16, "u"],
  [128, "v"],
];

interface HostRegExpProgram {
  readonly scanning: RegExp;
  readonly sticky: RegExp;
}

interface HostRegExpState {
  readonly programs: WeakMap<object, HostRegExpProgram>;
  subjectData: object | undefined;
  subjectOff: number;
  subjectLen: number;
  subject: string;
  captures: number[];
}

const states = new WeakMap<object, HostRegExpState>();
const detachedOwner = {};

function stateFor(owner: object | undefined): HostRegExpState {
  const key = owner ?? detachedOwner;
  let state = states.get(key);
  if (state === undefined) {
    state = {
      programs: new WeakMap(),
      subjectData: undefined,
      subjectOff: 0,
      subjectLen: 0,
      subject: "",
      captures: [],
    };
    states.set(key, state);
  }
  return state;
}

/** Flag string the host compiles a program with (exported for the unit test). */
export function hostRegExpMatchFlags(bits: number): string {
  return MATCH_FLAG_BITS.filter(([bit]) => (bits & bit) !== 0)
    .map(([, flag]) => flag)
    .join("");
}

function register(state: HostRegExpState, prog: unknown, source: unknown, bits: number): void {
  if (prog === null || typeof prog !== "object" || typeof source !== "string") return;
  const flags = hostRegExpMatchFlags(bits);
  try {
    state.programs.set(prog, { scanning: new RegExp(source, `${flags}dg`), sticky: new RegExp(source, `${flags}dy`) });
  } catch {
    // A pattern the host rejects stays on the native VM (which reports it).
  }
}

function exec(
  state: HostRegExpState,
  prog: unknown,
  data: unknown,
  off: number,
  len: number,
  start: number,
  sticky: number,
): number {
  const program = prog !== null && typeof prog === "object" ? state.programs.get(prog) : undefined;
  if (program === undefined) return -1;
  if (state.subjectData !== data || state.subjectOff !== off || state.subjectLen !== len) return -2;
  const re = sticky !== 0 ? program.sticky : program.scanning;
  re.lastIndex = start < 0 ? 0 : start;
  const match = re.exec(state.subject);
  if (match === null) return 0;
  const captures: number[] = [];
  for (const pair of match.indices ?? []) {
    captures.push(pair === undefined ? -1 : pair[0], pair === undefined ? -1 : pair[1]);
  }
  state.captures = captures;
  return 1;
}

/** Resolve an `env.__regexp_host_*` import, or `undefined` for any other name. */
export function resolveRegExpHostImport(name: string, owner: object | undefined): Function | undefined {
  if (!name.startsWith("__regexp_host_")) return undefined;
  const state = stateFor(owner);
  switch (name) {
    case "__regexp_host_register":
      return (prog: unknown, source: unknown, bits: number): void => register(state, prog, source, bits);
    case "__regexp_host_exec":
      return (prog: unknown, data: unknown, off: number, len: number, start: number, sticky: number): number =>
        exec(state, prog, data, off, len, start, sticky);
    case "__regexp_host_subject":
      return (data: unknown, off: number, len: number, subject: unknown): void => {
        state.subjectData = data !== null && typeof data === "object" ? data : undefined;
        state.subjectOff = off;
        state.subjectLen = len;
        state.subject = typeof subject === "string" ? subject : "";
      };
    case "__regexp_host_capture":
      return (slot: number): number => state.captures[slot] ?? -1;
    default:
      return undefined;
  }
}
