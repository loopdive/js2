# Pinned Promise comparison evidence, 2026-10-02

The archive contains 31 exact original byte streams, including the reviewed
instrument, manifest, first raw logs, independent exits and full result rows.
Each entry records its relative path, byte length, SHA-256 and base64 payload.
Encoding preserves empty streams and JSON files without terminal newlines;
normal formatting of repository documentation cannot change the recorded bytes.
Full Git archives and extracted trees remain in the original owned run directory;
they are not duplicated here. This is evidence, not a replacement test harness.

Runner handle 9054 (PID 46373) exited 0; all three children are terminal.
Untouched main 2bfe3eddf84d4d27f471eddb91e441709b7f6eff reproduced the two
original 35-second timeouts and six passes. Adding only the reviewed instance
wiring at two fixture sites produced 8/8 passes on that main and candidate
8b37543a10c4e17b3f32731ebd15b25720e7cced, with original assertions intact.
The comparison receipt SHA-256 is
3b712e6e4e46511608b61db2880d66449ebfc63179698c97f04deaf62e8c9255.

The archived HANDOFF is the original pre-execution proposal, retained unchanged;
the reviewed manifest and terminal evidence establish what actually ran.
This diagnoses the fixture wiring gap. It neither edits the permanent fixtures
nor proves full IR equivalence, authorizes retirement, or clears PR5883's
separate 14/33 pop-storage regression failures. The PR remains on hold.
