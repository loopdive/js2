# Colored reporter transport: preserved controls and failure

Required quality job113462828513 on PR6593 publication6900bb7 failed step48.
It got past the generated-report custody guard, then rejected prefixed evidence
envelopes. Its full public job log is retained; later steps were not evaluated.
The ephemeral CI child archive was not downloaded and is not claimed here.

Parent ran the unchanged hook/source/test/fixture/config pins at actual local
HEAD `1a0584f07f69914482c91e9a82e00ac54aada092`, source tree953f74f8:

- `FORCE_COLOR=1` with inherited `NO_COLOR=1`: parent exit0, strict child exit0,
  reporter36/36,38 complete plain envelopes, raw archive run-enYXb9.
- `env -u NO_COLOR FORCE_COLOR=1`: parent exit1, strict child exit0, reporter
  36/36,38 prefixed envelopes, raw archive run-dA6Luk. Every measured prefix is
  hex `1b5b32326d1b5b33396d` (ESC[22m followed by ESC[39m).

Installed Vitest's reporter writes a colored header ending with a newline,
followed by console content. Color closing escapes land after that newline,
before the JSON. Installed tinyrainbow2.0.0 enables color on FORCE_COLOR or CI
presence unless NO_COLOR is present; FORCE_COLOR="0" alone is insufficient.
Full original bytes, reporters, custody, receipts and errors are retained under
separate control/failure prefixes. No malformed epoch is repaired in place.

The diagnostic attribution JSON records exact prefix bytes and36/36 plus the
strict parent failure. Removing only those measured transport bytes for an
offline attribution comparison yields all36 complete observation graphs and
completion equal to the plain control, without filtering graph fields. This is
NOT production parser tolerance or retroactive acceptance of malformed input.
The production parser still rejects every prefix/truncation violation.

The finite implementation must pin plain output in the child's environment,
not strip logs or weaken receipt validation. Candidate acceptance is not claimed
by this original-failure/control record. All earlier archives remain unchanged.

## Later repaired candidate, separate from the original controls

Executed runner SHA256:
`3a154510e5f1280cb7dc71f2a89bae77386ba109990fecb71d586531d9c75e54`.
Sol6.1 Medium added only a production child-color helper and finite controls;
104 controls passed in worker and parent runs. The helper sets child NO_COLOR=1
and removes FORCE_COLOR without mutating the parent environment. Strict parser,
diagnostics, warnings, input pins, command and worker flags are unchanged.

Actual candidate invocation was the formerly failing outer environment:
`env -u NO_COLOR FORCE_COLOR=1`, the independent manifest, and
`pnpm run test:changed-root`. Execution HEAD1a0584/source953f74f8 with pending
runner bytes, not a later publication commit. Parent/child exit0;36 passed,
zero failures/skips/todo;22,322ms child time and44,273,883 stdout bytes.
All38 envelopes begin with the JSON opener and all36 complete observation
graphs plus completion exactly equal repaired-v3 without filtering fields.
Different execution provenance is retained separately. Full before/after input
and raw generated-report custody remains equal.

Candidate files use the `candidate-` prefix; executed source is retained as
`executed-candidate-runner.mjs.gz`. The original two experiments and actual CI
failure are immutable, not relabeled as this candidate. Replay from repo root:

```text
node plan/log/6915-linear-append-20261007/colorless-transport-20261008/compare.mjs
```

It verifies exact populations, complete graph equality, plain raw transport,
strict receipt and frozen custody. It does not infer actual repaired CI success,
native array/Unicode support, performance, main delivery or legacy retirement.
