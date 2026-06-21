---
id: 2526
title: "Native Messaging example host writes each frame's length prefix and body as SEPARATE fd_writes → streaming receivers misalign (64 MiB test fails where ComponentizeJS works)"
status: done
sprint: 64
created: 2026-06-20
updated: 2026-06-20
completed: 2026-06-20
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: examples
language_feature: native-messaging
goal: correctness
related: [2521, 1530]
---

## Resolution (2026-06-20)

Fixed in `examples/native-messaging/nm_js2wasm.ts`: `emitRun` and the ≤1 MiB echo
path now build `[len4][body]` in one buffer and write it with a **single**
`process.stdout.write` (one `fd_write`); removed `writeLength`. Verified via the
`runWasiRaw` capture — `fd_write` calls dropped from **6 → 3** for a 2 MiB input
(one per frame; sizes `1048575, 1048575, 15` = 4 + body), matching ComponentizeJS's
atomic framing; frames still valid JSON; output byte-identical. Test:
`tests/issue-2526-atomic-frame-writes.test.ts` (asserts no bare 4-byte write, one
write per frame). The browser "Native host has exited" mode below is still
unreproduced — the atomic write *may* resolve it (misframing could make Chrome
reject+kill); to be confirmed with the reporter.

## Problem (reproduced via direct comparison)

The Native Messaging example host (`examples/native-messaging/nm_js2wasm.ts`)
writes each output frame as **two separate `process.stdout.write` calls** — the
4-byte little-endian length prefix (`writeLength`) and then the frame body
(`emitRun`, and the ≤1 MiB echo path). Each `process.stdout.write` lowers to one
`fd_write`, so every frame is **two `fd_write` syscalls**.

On a real pipe (Chrome native messaging, or the reporter's deno harness) those
two writes can be split or coalesced on a boundary that is NOT the frame
boundary, so a streaming reader that reads the 4-byte header from the start of a
stream chunk misaligns — it reads a subsequent length from mid-stream and then
`JSON.parse`s garbage. The reporter's standalone run fails with
`Unexpected non-whitespace character after JSON at position 1048571`
(loopdive/js2#389).

**Decisive evidence — same harness, ComponentizeJS works, we fail.** Ran both
hosts on an identical 2 MiB framed input and compared the output byte stream and
`fd_write` granularity:

| host | frame sizes | fd_write pattern |
|------|-------------|------------------|
| **js2wasm** | 1048571, 1048571, 11 | **6 writes**: `4, 1048571, 4, 1048571, 4, 11` (length SEPARATE from body) |
| **ComponentizeJS** | 1048566, 1048566, 21 | each frame's length+body written **atomically** |

Both produce individually-valid JSON frames; the only material difference is the
**non-atomic write**. ComponentizeJS, read by the reporter's exact harness,
reassembles cleanly (out=13421760); js2wasm trips the parse error.

## Fix

Write each frame's length prefix and body in a **single `process.stdout.write`**
(one buffer `[len4][body]`, one `fd_write`), in both:
- `emitRun` (the >1 MiB re-chunk path), and
- the `declaredLen <= FRAME_CHUNK` verbatim-echo path.

This matches ComponentizeJS's atomic framing and is the standard-robust way to
emit length-prefixed frames over a pipe.

## Acceptance

- The example host emits exactly **one** `fd_write` per frame (verify via the
  `runWasiRaw` capture: write-call sizes equal the framed-message sizes, no bare
  4-byte writes).
- The reporter's `nm_standalone_test.js` 64 MiB sequence reassembles cleanly
  (out == totalMessageLength), matching ComponentizeJS.

## Caveat / honesty

I could **not** reproduce the reporter's `Unexpected non-whitespace` error on my
own deno 2.8.3 / wasmtime 44 (it succeeded with the current 2-writes host — the
misalignment is stream-chunking-sensitive and depends on deno/wasmtime/pipe
buffering). The fix above is the confirmed structural difference vs the
known-working ComponentizeJS host and the standard-robust approach, but final
confirmation should be **with the reporter** on their versions.

## Separate, still-unreproduced: browser "Native host has exited"

In Chrome (screenshot in #389), the 64 MiB `port.postMessage` ends with `n=0`
(zero bytes received) and `{message: 'Native host has exited.'}` — the host
**process terminates**. Not reproduced under deno/wasmtime (the host processes
64 MiB cleanly there, exit 0). Candidate causes to investigate (needs the host's
stderr from the Chrome run, or a Chrome repro): a frame at exactly the 1 MiB
host→extension cap (`MAX_RUN + 2 = FRAME_CHUNK = 1048576`), a pipe-backpressure
deadlock on the large bidirectional exchange, or a runtime trap surfacing only
under Chrome's stdio. Track here; the atomic-write fix may or may not address it.

## Notes

Found while re-investigating loopdive/js2#389 after the reporter's screenshots
(which I had initially skipped). Corrects an earlier mis-diagnosis that framed
this as purely a receiver-side reassembly issue — it is host-side: our non-atomic
frame writes, where ComponentizeJS writes atomically. Pairs with #2521 (the
re-chunk continuation-marker / reassembly contract).
