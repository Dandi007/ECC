# ECC Parity (ecc.parity.v1)

Cross-runtime semantic equivalence for the *in-use* ECC hook set: the same
hooks, the same effects, on Claude Code and OpenCode.

## Principle

Hook semantics = trigger × input × effect. Effects are only ever:
file writes, context injection, OS notifications. The semantics live in
machine-readable contracts — not in any runtime's implementation.

```
contracts/            SSoT: per-hook trigger/input/effect + normalize rules
adapter/opencode/     thin event adapter -> spawns the SAME scripts/hooks/*.js
e2e/                  isolated real-runtime double-run + normalize + diff
```

There is exactly ONE hook implementation (`scripts/hooks/*.js`); Claude Code
invokes it natively via hooks.json, OpenCode via the adapter. Gating
(ECC_HOOK_PROFILE / ECC_DISABLED_HOOKS) goes through the same
`run-with-flags.js` on both sides, so the enabled set is config-derived and
never hardcoded.

## Run e2e

```bash
parity/e2e/run.sh parity/e2e/scenarios/basic.json both
```

Requires: official `claude` + `opencode` binaries, and an LLM endpoint
(default: CC Switch proxy at 127.0.0.1:15721; override ECC_PARITY_CCS_URL /
ECC_PARITY_CC_MODEL / ECC_PARITY_OC_MODEL).

Isolation is mandatory and built-in: per-run sandboxed HOME/TMPDIR/XDG dirs,
production server env (OPENCODE_HOST etc.) scrubbed, osascript stubbed.

## Verified facts this design rests on (2026-06-07, opencode 1.16.2)

- OpenCode lifecycle events (session.created/idle, file.edited, ...) do NOT
  fire as plugin hook keys — only via the generic `event` handler.
- Real hook keys: tool.execute.before/after, chat.message, chat.params,
  shell.env. `experimental.session.compacting` is still unverified.
- tool.execute.after provides tool/args/output/metadata; message.updated
  provides per-message token+cache detail (richer than CC hook stdin).
- `transcript_path` has no OC equivalent; the adapter synthesizes a
  CC-shaped JSONL from observed events.
