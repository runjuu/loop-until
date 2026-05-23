import { writeFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { parseArgs, runLoop } from '../src/index';

type ParsedRunArgs = Extract<ReturnType<typeof parseArgs>, { beforePrompts: string[] }>;

interface JudgeVerdict {
  done: boolean;
  reason: string;
}

interface FakeCall {
  args: string[];
  prompt: string;
  sessionId?: string;
  resumedSessionId?: string;
}

interface CodexResult {
  code: number;
  stdout: string;
  stderr: string;
  stderrStreamed?: boolean;
}

function parseRunArgs(argv: string[]): ParsedRunArgs {
  const parsed = parseArgs(argv);
  if ('help' in parsed || 'version' in parsed) {
    throw new Error('Expected runnable arguments.');
  }
  return parsed;
}

describe('loop-until', () => {
  test('parses --until after the first prompt', () => {
    const parsed = parseRunArgs(['Review changes', '--until', 'no findings', 'Apply fix']);

    expect(parsed.beforePrompts).toEqual(['Review changes']);
    expect(parsed.afterPrompts).toEqual(['Apply fix']);
    expect(parsed.condition).toBe('no findings');
    expect(parsed.options.maxLoops).toBe(10);
    expect(parsed.options.model).toBe('gpt-5.5');
    expect(parsed.options.reasoningEffort).toBe('xhigh');
    expect(parsed.options.untilModel).toBe('gpt-5.4-mini');
    expect(parsed.options.untilReasoningEffort).toBe('high');
  });

  test('parses --until after multiple prompts and supports final checkpoint', () => {
    const afterTwo = parseRunArgs(['Build', 'Smoke test', '--until', 'all green', 'Fix']);
    expect(afterTwo.beforePrompts).toEqual(['Build', 'Smoke test']);
    expect(afterTwo.afterPrompts).toEqual(['Fix']);

    const finalCheckpoint = parseRunArgs(['Build', '--until', 'build succeeds', '--max=3']);
    expect(finalCheckpoint.beforePrompts).toEqual(['Build']);
    expect(finalCheckpoint.afterPrompts).toEqual([]);
    expect(finalCheckpoint.options.maxLoops).toBe(3);
  });

  test('rejects missing duplicated or first-position --until', () => {
    expect(() => parseArgs(['Review'])).toThrow(/Missing required --until/);
    expect(() => parseArgs(['--until', 'done', 'Review'])).toThrow(/after at least one prompt/);
    expect(() =>
      parseArgs(['Review', '--until', 'done', 'Fix', '--until', 'done again'])
    ).toThrow(/exactly one --until/);
  });

  test('stops before post-until prompts when judge returns done', async () => {
    const fake = createFakeCodex([{ done: true, reason: 'clean' }]);
    const parsed = parseRunArgs(['Review', '--until', 'no findings', 'Fix']);
    const result = await runLoop(parsed, {
      runCodex: fake.runCodex,
      stdout: sink(),
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('done');
    expect(fake.workerPrompts()).toEqual(['Review']);
  });

  test('continues post-until prompts in the same chat then starts a fresh chat', async () => {
    const fake = createFakeCodex([
      { done: false, reason: 'findings remain' },
      { done: true, reason: 'clean' },
    ]);
    const parsed = parseRunArgs(['Review', '--until', 'no findings', 'Plan fix', 'Apply fix']);
    const result = await runLoop(parsed, {
      runCodex: fake.runCodex,
      stdout: sink(),
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(fake.workerPrompts()).toEqual(['Review', 'Plan fix', 'Apply fix', 'Review']);

    const workerCalls = fake.calls.filter((call) => !call.args.includes('--output-schema'));
    expect(workerCalls[0].sessionId).toBe('session-1');
    expect(workerCalls[1].resumedSessionId).toBe('session-1');
    expect(workerCalls[2].resumedSessionId).toBe('session-1');
    expect(workerCalls[3].sessionId).toBe('session-2');
  });

  test('runs multiple pre-until prompts in one chat before judging', async () => {
    const fake = createFakeCodex([{ done: true, reason: 'passed' }]);
    const parsed = parseRunArgs(['Build', 'Smoke test', '--until', 'all green', 'Fix']);
    const result = await runLoop(parsed, {
      runCodex: fake.runCodex,
      stdout: sink(),
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(fake.workerPrompts()).toEqual(['Build', 'Smoke test']);

    const workerCalls = fake.calls.filter((call) => !call.args.includes('--output-schema'));
    expect(workerCalls[0].sessionId).toBe('session-1');
    expect(workerCalls[1].resumedSessionId).toBe('session-1');
  });

  test('returns non-zero when max loops is reached', async () => {
    const fake = createFakeCodex([
      { done: false, reason: 'not yet' },
      { done: false, reason: 'still not' },
    ]);
    const parsed = parseRunArgs(['Review', '--until', 'clean', '--max-loops', '2']);
    const result = await runLoop(parsed, {
      runCodex: fake.runCodex,
      stdout: sink(),
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.status).toBe('max_loops');
    expect(fake.workerPrompts()).toEqual(['Review', 'Review']);
  });

  test('forwards configured worker options and default judge options', async () => {
    const fake = createFakeCodex([{ done: true, reason: 'clean' }]);
    const parsed = parseRunArgs([
      '--cwd',
      '/tmp/example',
      '--model',
      'test-model',
      '--reasoning-effort',
      'low',
      '--sandbox',
      'read-only',
      '--approval',
      'never',
      'Review',
      '--until',
      'clean',
    ]);
    await runLoop(parsed, {
      runCodex: fake.runCodex,
      stdout: sink(),
      stderr: sink(),
    });

    expect(fake.calls[0].args.slice(0, 3)).toEqual(['-a', 'never', 'exec']);
    expect(optionValue(fake.calls[0].args, '-m')).toBe('test-model');
    expect(configValue(fake.calls[0].args, 'model_reasoning_effort')).toBe('"low"');
    expect(optionValue(fake.calls[0].args, '-C')).toBe('/tmp/example');
    expect(optionValue(fake.calls[0].args, '-s')).toBe('read-only');

    const judgeCall = fake.calls.find((call) => call.args.includes('--output-schema'));
    expect(judgeCall).toBeDefined();
    expect(judgeCall?.args.slice(0, 3)).toEqual(['-a', 'never', 'exec']);
    expect(optionValue(judgeCall?.args ?? [], '-m')).toBe('gpt-5.4-mini');
    expect(configValue(judgeCall?.args ?? [], 'model_reasoning_effort')).toBe('"high"');
    expect(optionValue(judgeCall?.args ?? [], '-C')).toBe('/tmp/example');
    expect(optionValue(judgeCall?.args ?? [], '-s')).toBe('read-only');
  });

  test('supports independent judge model and reasoning effort', async () => {
    const fake = createFakeCodex([{ done: true, reason: 'clean' }]);
    const parsed = parseRunArgs([
      '--model',
      'worker-model',
      '--reasoning-effort',
      'medium',
      '--until-model',
      'judge-model',
      '--until-reasoning-effort',
      'xhigh',
      'Review',
      '--until',
      'clean',
    ]);

    await runLoop(parsed, {
      runCodex: fake.runCodex,
      stdout: sink(),
      stderr: sink(),
    });

    const workerCall = fake.calls.find((call) => !call.args.includes('--output-schema'));
    const judgeCall = fake.calls.find((call) => call.args.includes('--output-schema'));

    expect(workerCall).toBeDefined();
    expect(optionValue(workerCall?.args ?? [], '-m')).toBe('worker-model');
    expect(configValue(workerCall?.args ?? [], 'model_reasoning_effort')).toBe('"medium"');

    expect(judgeCall).toBeDefined();
    expect(optionValue(judgeCall?.args ?? [], '-m')).toBe('judge-model');
    expect(configValue(judgeCall?.args ?? [], 'model_reasoning_effort')).toBe('"xhigh"');
  });

  test('forwards cwd and sandbox to resumed worker calls', async () => {
    const fake = createFakeCodex([
      { done: false, reason: 'findings remain' },
      { done: true, reason: 'clean' },
    ]);
    const parsed = parseRunArgs([
      '--cwd',
      '/tmp/example',
      '--sandbox',
      'read-only',
      'Review',
      '--until',
      'clean',
      'Fix',
    ]);

    await runLoop(parsed, {
      runCodex: fake.runCodex,
      stdout: sink(),
      stderr: sink(),
    });

    const workerCalls = fake.calls.filter((call) => !call.args.includes('--output-schema'));
    const resumedCall = workerCalls.find((call) => call.resumedSessionId === 'session-1');
    expect(resumedCall).toBeDefined();
    expect(optionValue(resumedCall?.args ?? [], '-C')).toBe('/tmp/example');
    expect(optionValue(resumedCall?.args ?? [], '-s')).toBe('read-only');

    const execIndex = resumedCall?.args.indexOf('exec') ?? -1;
    expect(resumedCall?.args.indexOf('-C')).toBeLessThan(execIndex);
    expect(resumedCall?.args.indexOf('-s')).toBeLessThan(execIndex);
  });

  test('prints worker output and forwards codex stderr', async () => {
    const stdout = collectWrites();
    const stderr = collectWrites();
    let callCount = 0;

    const parsed = parseRunArgs(['Review', '--until', 'clean']);
    const result = await runLoop(parsed, {
      async runCodex(args) {
        callCount += 1;
        const outputPath = optionValue(args, '-o');
        const isJudge = args.includes('--output-schema');

        if (isJudge) {
          await writeFile(outputPath, JSON.stringify({ done: true, reason: 'clean' }));
          return {
            code: 0,
            stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'judge-session' })}\n`,
            stderr: 'judge stderr\n',
          };
        }

        await writeFile(outputPath, 'worker final output');
        return {
          code: 0,
          stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'worker-session' })}\n`,
          stderr: 'worker stderr',
        };
      },
      stdout,
      stderr,
    });

    expect(result.exitCode).toBe(0);
    expect(callCount).toBe(2);
    expect(stdout.text()).toContain('== Loop 1/10 ==\n');
    expect(stdout.text()).toContain('-- Step 1/1: Review --\n');
    expect(stdout.text()).toContain('-- Codex worker step 1 output --\n    worker final output\n');
    expect(stdout.text()).toContain('-- Codex judge output --\n    {\n      "done": true,\n      "reason": "clean"\n    }\n');
    expect(stderr.text()).toBe('worker stderr\njudge stderr\n');
  });

  test('emits codex output events in json mode', async () => {
    const fake = createFakeCodex([{ done: true, reason: 'clean' }]);
    const stdout = collectWrites();
    const parsed = parseRunArgs(['--json', 'Review', '--until', 'clean']);

    await runLoop(parsed, {
      runCodex: fake.runCodex,
      stdout,
      stderr: sink(),
    });

    const events = stdout
      .text()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; role?: string; output?: string });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'codex_output',
        role: 'worker',
        output: 'output for Review',
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'codex_output',
        role: 'judge',
        output: '{"done":true,"reason":"clean"}',
      })
    );
  });

  test('streams live codex json events while the process is running', async () => {
    const stdout = collectWrites();
    const stderr = collectWrites();
    const parsed = parseRunArgs(['Review', '--until', 'clean']);

    await runLoop(parsed, {
      async runCodex(args, context) {
        const outputPath = optionValue(args, '-o');
        const isJudge = args.includes('--output-schema');
        const threadId = isJudge ? 'judge-session' : 'worker-session';
        const finalOutput = isJudge ? '{"done":true,"reason":"clean"}' : 'live worker output';
        const events = [
          { type: 'thread.started', thread_id: threadId },
          { type: 'turn.started' },
          {
            type: 'item.started',
            item: {
              type: 'command_execution',
              command: '/bin/zsh -lc git status --short',
            },
          },
          {
            type: 'item.completed',
            item: {
              type: 'command_execution',
              command: '/bin/zsh -lc git status --short',
              aggregated_output: ' M src/index.ts\n',
              exit_code: 0,
            },
          },
          {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: finalOutput,
            },
          },
        ]
          .map((event) => JSON.stringify(event))
          .join('\n')
          .concat('\n');

        context.onStdoutChunk?.(events.slice(0, 25));
        context.onStdoutChunk?.(events.slice(25));
        context.onStderrChunk?.(`${isJudge ? 'judge' : 'worker'} live stderr\n`);
        await writeFile(outputPath, finalOutput);

        return {
          code: 0,
          stdout: events,
          stderr: `${isJudge ? 'judge' : 'worker'} live stderr\n`,
          stderrStreamed: true,
        };
      },
      stdout,
      stderr,
    });

    const output = stdout.text();
    expect(output).toContain('[worker step 1] thread started: worker-session');
    expect(output).toContain('[worker step 1] running command: /bin/zsh -lc git status --short');
    expect(output).toContain('[worker step 1] command completed: /bin/zsh -lc git status --short (exit 0)');
    expect(output).toContain('     M src/index.ts\n');
    expect(output).toContain('-- Codex worker step 1 output --\n    live worker output\n');
    expect(countOccurrences(output, '-- Codex worker step 1 output --')).toBe(1);
    expect(output).toContain('-- Codex judge output --\n    {\n      "done": true,\n      "reason": "clean"\n    }\n');
    expect(countOccurrences(output, '-- Codex judge output --')).toBe(1);
    expect(stderr.text()).toBe('worker live stderr\njudge live stderr\n');
  });

  test('colors only loop-until lifecycle lines when stdout is a TTY', async () => {
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;

    try {
      const fake = createFakeCodex([{ done: true, reason: 'clean' }]);
      const stdout = collectWrites({ isTTY: true });
      const parsed = parseRunArgs(['Review', '--until', 'clean']);

      await runLoop(parsed, {
        runCodex: fake.runCodex,
        stdout,
        stderr: sink(),
      });

      const output = stdout.text();
      expect(output).toContain('\u001B[1;36m== Loop 1/10 ==\u001B[0m\n');
      expect(output).toContain('\u001B[1;34m-- Step 1/1: Review --\u001B[0m\n');
      expect(output).toContain('\u001B[33m-- Judge: checking completion condition --\u001B[0m\n');
      expect(output).toContain('\u001B[33m-- Judge: done=true - clean --\u001B[0m\n');
      expect(output).toContain('\u001B[32m== Done after loop 1 ==\u001B[0m\n');

      const codexLines = output
        .split('\n')
        .filter((line) => line.includes('Codex') || line.includes('output for Review') || line.includes('"done"'));
      expect(codexLines.every((line) => !hasAnsi(line))).toBe(true);

      const maxFake = createFakeCodex([{ done: false, reason: 'not yet' }]);
      const maxStdout = collectWrites({ isTTY: true });
      await runLoop(parseRunArgs(['Review', '--until', 'clean', '--max-loops', '1']), {
        runCodex: maxFake.runCodex,
        stdout: maxStdout,
        stderr: sink(),
      });
      expect(maxStdout.text()).toContain('\u001B[31m== Reached --max-loops=1 ==\u001B[0m\n');
    } finally {
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });

  test('does not color human output when stdout is not a TTY or NO_COLOR is set', async () => {
    const fake = createFakeCodex([
      { done: true, reason: 'clean' },
      { done: true, reason: 'clean' },
    ]);
    const parsed = parseRunArgs(['Review', '--until', 'clean']);

    const pipedStdout = collectWrites();
    await runLoop(parsed, {
      runCodex: fake.runCodex,
      stdout: pipedStdout,
      stderr: sink(),
    });
    expect(hasAnsi(pipedStdout.text())).toBe(false);

    const previousNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      const noColorStdout = collectWrites({ isTTY: true });
      await runLoop(parsed, {
        runCodex: fake.runCodex,
        stdout: noColorStdout,
        stderr: sink(),
      });
      expect(hasAnsi(noColorStdout.text())).toBe(false);
    } finally {
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });
});

function createFakeCodex(judgeVerdicts: JudgeVerdict[]) {
  const calls: FakeCall[] = [];
  let sessionCounter = 0;
  let judgeCounter = 0;

  async function runCodex(args: string[]): Promise<CodexResult> {
    const outputPath = optionValue(args, '-o');
    const isJudge = args.includes('--output-schema');
    const execIndex = args.indexOf('exec');
    const isResume = args[execIndex + 1] === 'resume';
    const prompt = args[args.length - 1];
    const call: FakeCall = { args, prompt };
    calls.push(call);

    if (isJudge) {
      const verdict = judgeVerdicts[judgeCounter] ?? {
        done: false,
        reason: 'default fake verdict',
      };
      judgeCounter += 1;
      await writeFile(outputPath, JSON.stringify(verdict));
      return {
        code: 0,
        stdout: `${JSON.stringify({ type: 'session.started', session_id: `judge-${judgeCounter}` })}\n`,
        stderr: '',
      };
    }

    if (isResume) {
      call.resumedSessionId = args[args.length - 2];
      await writeFile(outputPath, `output for ${prompt}`);
      return {
        code: 0,
        stdout: `${JSON.stringify({ type: 'session.resumed', session_id: call.resumedSessionId })}\n`,
        stderr: '',
      };
    }

    sessionCounter += 1;
    call.sessionId = `session-${sessionCounter}`;
    await writeFile(outputPath, `output for ${prompt}`);
    return {
      code: 0,
      stdout: `${JSON.stringify({ type: 'session.started', session_id: call.sessionId })}\n`,
      stderr: '',
    };
  }

  return {
    calls,
    runCodex,
    workerPrompts() {
      return calls
        .filter((call) => !call.args.includes('--output-schema'))
        .map((call) => call.prompt);
    },
  };
}

function optionValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  expect(index, `missing ${flag}`).not.toBe(-1);
  return args[index + 1];
}

function configValue(args: string[], key: string): string {
  const prefix = `${key}=`;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-c' && args[index + 1]?.startsWith(prefix)) {
      return args[index + 1].slice(prefix.length);
    }
  }
  throw new Error(`missing -c ${key}`);
}

function sink() {
  return {
    write() {},
  };
}

function collectWrites(options: { isTTY?: boolean } = {}) {
  const chunks: string[] = [];
  return {
    isTTY: options.isTTY,
    write(chunk: string) {
      chunks.push(chunk);
    },
    text() {
      return chunks.join('');
    },
  };
}

function countOccurrences(text: string, search: string): number {
  return text.split(search).length - 1;
}

function hasAnsi(text: string): boolean {
  return /\u001B\[[0-9;]*m/.test(text);
}
