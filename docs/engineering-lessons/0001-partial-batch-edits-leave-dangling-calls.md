# 0001: A partly-applied batch of edits leaves calls to functions that don't exist

- **Status:** proposed (only the owner adopts a lesson)
- **Date:** 2026-11-25
- **Area:** agent workflow (Claude Code edits in this repo)

## Observed failure
Three times in one session, a batch of parallel edits was partly refused by an edit gate (a PreToolUse hook).
The edits that *call* a new function applied; the edit that *defines* it did not:

1. `lib/ailab-routes.js`: both training paths called `keepRun(rec)`, but `keepRun` was never defined. That code
   runs only when a training job finishes, so `npm run verify` stayed green.
2. `lib/supervisor.js`: `start()` passed `env: childSafeEnv()` before `childSafeEnv` existed. This was caught,
   because a test starts a real program.
3. `public/autopilot.js`: the handlers read `#apTotp`, but the input wasn't rendered, so a live user's
   authenticator code would always have been empty.

## Root cause (verified)
The gate can deny any single edit in a parallel batch while the rest apply. `node --check` and
`scripts/check-imports.mjs` check syntax and imports only, not undefined identifiers. Code that no test reaches
can therefore ship with a call to nothing.

## Correction
Each missing piece was re-applied, and a cross-file grep confirmed every referenced name exists. Item 2 has a
regression test (`test/hardening.test.js` imports `childSafeEnv`).

## Smallest general lesson
When one edit in a batch is refused, re-check that every name the batch *uses* is *defined* before moving on.
Put a new helper's definition in its own edit, ahead of its callers.

## Narrowest enforcing layer (proposal)
A **check**, not a reminder: add an undefined-identifier lint (ESLint `no-undef`, or a small AST pass) to
`npm run verify`, so a call to a function that doesn't exist fails verify even when no test reaches it.
