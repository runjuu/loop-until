# loop-until

Run Codex CLI prompts in a loop until a judged condition is met.

`loop-until` is useful for workflows where one Codex pass checks the current state
and later prompts repair it. Each loop starts a fresh Codex chat, while prompts
inside that loop continue in the same chat.

## Usage

```sh
loop-until [options] <prompt...> --until <condition> [prompt...]
```

The `--until` marker is placed after the step that should be judged:

```sh
loop-until \
  "Please review my uncommitted changes" \
  --until "there are no actionable findings" \
  "Propose the best fix" \
  "Apply the fix"
```

In this example:

1. `loop-until` starts a new Codex chat and sends the review prompt.
2. A separate read-only judge checks whether the review output satisfies
   `there are no actionable findings`.
3. If the condition is satisfied, the command exits with code `0`.
4. Otherwise, the fix prompts are sent to the same Codex chat.
5. The next loop starts again with a fresh Codex chat.

## Examples

Run tests until they pass:

```sh
loop-until \
  "Run the test suite" \
  --until "all tests pass" \
  "Diagnose the failures" \
  "Apply the smallest fix"
```

Judge after multiple setup/check steps:

```sh
loop-until \
  "Build the project" \
  "Run the smoke test" \
  --until "the build succeeds and the smoke test passes" \
  "Fix the failure"
```

Only repeat the checked step:

```sh
loop-until \
  --max-loops 3 \
  "Check whether the release branch is ready" \
  --until "the branch is ready to release"
```

## Options

- `--until <condition>`: required completion condition for the preceding step.
- `--max-loops <n>`: maximum loop iterations. Defaults to `10`.
- `--max <n>`: alias for `--max-loops`.
- `--cwd <dir>`: working directory forwarded to `codex exec`.
- `--model <model>`: model forwarded to Codex.
- `--sandbox <mode>`: sandbox mode forwarded to worker Codex calls.
- `--approval <policy>`: approval policy forwarded to worker Codex calls.
- `--json`: emit `loop-until` progress events as JSONL.
- `-h`, `--help`: show CLI help.

## Exit Codes

- `0`: the judge reported that the condition was satisfied.
- `1`: execution failed or `--max-loops` was reached without satisfying the condition.
- `2`: the command line arguments were invalid.

## How Judging Works

After the checkpoint step, `loop-until` runs a separate Codex judge call with a
strict output schema:

```json
{
  "done": true,
  "reason": "The review reported no actionable findings."
}
```

The judge is run with a read-only sandbox and `never` approval policy. It should
only evaluate the checkpoint output against the `--until` condition.

## Development

Run tests with:

```sh
npm test
```

Run the CLI locally with:

```sh
node bin/loop-until.js --help
```
