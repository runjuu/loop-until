# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

`loop-until` is a TypeScript CLI package that runs Codex CLI prompts in a loop
until a separate judge prompt reports that a completion condition is satisfied.
The package is CommonJS at runtime and publishes the compiled `dist/` output plus
the executable wrapper in `bin/`.

## Repository Layout

- `src/index.ts`: main implementation, including CLI parsing, loop orchestration,
  Codex process spawning, JSONL event handling, output formatting, and exports
  used by tests.
- `bin/loop-until.js`: Node executable wrapper that loads `dist/index.js`.
- `test/loop-until.test.ts`: Vitest coverage for parsing, loop behavior, Codex
  argument construction, output streaming, colors, and missing-Codex handling.
- `.github/workflows/npm-publish.yml`: npm Trusted Publisher release workflow.
- `dist/`: generated build output. Do not edit generated files by hand.

## Commands

- Install dependencies: `npm install`
- Build: `npm run build`
- Type-check: `npm run typecheck`
- Test: `npm test`
- Run local CLI after building: `node bin/loop-until.js --help`

`npm test` is the normal verification command. It runs both TypeScript
type-checking and Vitest.

This project uses the TypeScript native preview compiler via the `tsgo`
executable from `@typescript/native-preview`. Prefer the npm scripts above for
normal work. When invoking `tsgo` directly, use:

- Build source output: `npx tsgo -p tsconfig.json`
- Type-check source without emit: `npx tsgo -p tsconfig.json --noEmit`
- Type-check tests: `npx tsgo -p tsconfig.test.json`

## Implementation Notes

- Keep changes focused in `src/index.ts` unless the CLI wrapper, tests, docs, or
  workflow files specifically need updates.
- Preserve the existing no-dependency runtime shape. The CLI currently relies on
  Node built-ins and dev dependencies only.
- Keep parsing strict and test any new option with both normal and error cases.
- Worker Codex calls and judge Codex calls intentionally use separate option
  paths. If changing forwarded flags, update tests for start, resume, and judge
  calls.
- Judge execution must remain read-only with `-a never` unless the project
  explicitly changes its safety model.
- Human-readable output and JSONL output are both public behavior. Add or update
  tests when changing emitted events, text formatting, color behavior, or stderr
  forwarding.
- Generated temporary files are written under a temporary root and should be
  cleaned up unless `keepTmpRoot` is set for tests or diagnostics.

## Style

- Use strict TypeScript and keep exported helpers intentional; tests import some
  internals from `src/index.ts`.
- Prefer small pure helpers for parsing, formatting, and Codex JSONL handling.
- Keep comments sparse and useful. Most code should be clear from names and
  focused helper functions.
- Use ASCII in source and docs unless there is a concrete reason not to.

## Git And Release Notes

- The `main` branch may be ahead of `origin/main`; check `git status --short
  --branch` before assuming remote state.
- Releases are driven by `v*` tags. The GitHub workflow verifies that the tag
  matches `package.json` version, runs `npm ci`, tests, builds, runs `npm pack
  --dry-run`, and publishes to npm.
- To release a new version, use `npm version patch`, `npm version minor`, or
  `npm version major` as appropriate. This updates `package.json` and
  `package-lock.json`, creates a commit, and creates the matching `v*` tag.
- Push the release with `git push --follow-tags`. The pushed tag starts the npm
  publish workflow. Do not create a release tag whose version differs from
  `package.json`.
- Before releasing, run `npm test` locally and make sure the working tree only
  contains intended release changes.
