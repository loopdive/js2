# Advisory append-command checkpoint

The starting published HEAD is
`9222d9a0342ea2828d3448e3d8828c5b329c293c`, canonical main
`8452732f0b88c14c5c7634ece58f83240970ea4c`. A/root released only the advisory
step's shell command in comments6067224039 and6068998929. The adopted full plan,
exact claim and unchanged ownership boundaries are recorded in issue6915.

Sol6.1 Medium changes only `.github/workflows/ci.yml`'s named advisory command.
The exact append filename invokes the existing provenance parent; every other
filename receives the old Vitest argv. Parent errors remain raw step failures.
All workflow bytes outside the command, and the parent itself, remain unchanged.
The current workflow SHA256 is
`7ca805dddf26b1312bd669abd4948715da65e1706afb41b1ee0dd5137d678bcf`.

Replay the isolated controls from the repository root:

```sh
node plan/log/6915-linear-append-20261007/advisory-command-20261008/dispatch-controls.mjs
node scripts/hooks/run-linear-append-provenance.mjs --self-test
```

The dispatch replay includes one positive observation of the unchanged old
direct caller and eight candidate cases: exact append success/failure, another
file success/failure, suffix and prefix near-matches, empty input, and quoted
shell-looking input. Static assertions preserve both outer workflow regions,
the original else command, shell syntax and the unchanged production-parent
hash. Parent observed all eight candidate cases and all104 existing parent
controls passing. Recorder functions exercise dispatch, not production tests;
there is no claim of compiler execution or new production graph qualification.

`previous-CI-run-37826025179.json` is the actual terminal SUCCESS metadata for
the starting9222d9 epoch, not the future command candidate. The unmodified raw
required quality log is retained in
`previous-quality-job-113478995304.log.gz`; decoded length178626 bytes, SHA256
`26b293641d998406852b9a6f8b83362aeb5668dd228f42ab261c8d60b7abb16c`.
It records actual merge checkout e433e26, one selected append test and genuine
parent archive `.tmp/6915-ci/run-9IKxJE`. CI child graphs/receipt were not publicly
uploaded: this log is not independently inspected CI graph equality. Previous
local complete-graph equality and every original failed epoch remain preserved
in their separate packets.

Actual supported-event advisory execution and required quality must be verified
on the newly published candidate. Its HEAD/provenance cannot be substituted into
old receipts. The intentional push-event refusal, absent durable CI graph
upload, native array/Unicode dependencies and legacy-retirement proof remain
unresolved. No selector, policy, source, fixture, pin, event-identity, upload,
HOLD or queue mutation is part of this checkpoint. A retains final integration.
