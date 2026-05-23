'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const test = require('node:test');
const { parseArgs, runLoop } = require('../index');

test('parses --until after the first prompt', () => {
  const parsed = parseArgs(['Review changes', '--until', 'no findings', 'Apply fix']);

  assert.deepEqual(parsed.beforePrompts, ['Review changes']);
  assert.deepEqual(parsed.afterPrompts, ['Apply fix']);
  assert.equal(parsed.condition, 'no findings');
  assert.equal(parsed.options.maxLoops, 10);
});

test('parses --until after multiple prompts and supports final checkpoint', () => {
  const afterTwo = parseArgs(['Build', 'Smoke test', '--until', 'all green', 'Fix']);
  assert.deepEqual(afterTwo.beforePrompts, ['Build', 'Smoke test']);
  assert.deepEqual(afterTwo.afterPrompts, ['Fix']);

  const finalCheckpoint = parseArgs(['Build', '--until', 'build succeeds', '--max=3']);
  assert.deepEqual(finalCheckpoint.beforePrompts, ['Build']);
  assert.deepEqual(finalCheckpoint.afterPrompts, []);
  assert.equal(finalCheckpoint.options.maxLoops, 3);
});

test('rejects missing duplicated or first-position --until', () => {
  assert.throws(() => parseArgs(['Review']), /Missing required --until/);
  assert.throws(() => parseArgs(['--until', 'done', 'Review']), /after at least one prompt/);
  assert.throws(
    () => parseArgs(['Review', '--until', 'done', 'Fix', '--until', 'done again']),
    /exactly one --until/
  );
});

test('stops before post-until prompts when judge returns done', async () => {
  const fake = createFakeCodex([{ done: true, reason: 'clean' }]);
  const parsed = parseArgs(['Review', '--until', 'no findings', 'Fix']);
  const result = await runLoop(parsed, {
    runCodex: fake.runCodex,
    stdout: sink(),
    stderr: sink(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'done');
  assert.deepEqual(fake.workerPrompts(), ['Review']);
});

test('continues post-until prompts in the same chat then starts a fresh chat', async () => {
  const fake = createFakeCodex([
    { done: false, reason: 'findings remain' },
    { done: true, reason: 'clean' },
  ]);
  const parsed = parseArgs(['Review', '--until', 'no findings', 'Plan fix', 'Apply fix']);
  const result = await runLoop(parsed, {
    runCodex: fake.runCodex,
    stdout: sink(),
    stderr: sink(),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(fake.workerPrompts(), ['Review', 'Plan fix', 'Apply fix', 'Review']);

  const workerCalls = fake.calls.filter((call) => !call.args.includes('--output-schema'));
  assert.equal(workerCalls[0].sessionId, 'session-1');
  assert.equal(workerCalls[1].resumedSessionId, 'session-1');
  assert.equal(workerCalls[2].resumedSessionId, 'session-1');
  assert.equal(workerCalls[3].sessionId, 'session-2');
});

test('runs multiple pre-until prompts in one chat before judging', async () => {
  const fake = createFakeCodex([{ done: true, reason: 'passed' }]);
  const parsed = parseArgs(['Build', 'Smoke test', '--until', 'all green', 'Fix']);
  const result = await runLoop(parsed, {
    runCodex: fake.runCodex,
    stdout: sink(),
    stderr: sink(),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(fake.workerPrompts(), ['Build', 'Smoke test']);

  const workerCalls = fake.calls.filter((call) => !call.args.includes('--output-schema'));
  assert.equal(workerCalls[0].sessionId, 'session-1');
  assert.equal(workerCalls[1].resumedSessionId, 'session-1');
});

test('returns non-zero when max loops is reached', async () => {
  const fake = createFakeCodex([
    { done: false, reason: 'not yet' },
    { done: false, reason: 'still not' },
  ]);
  const parsed = parseArgs(['Review', '--until', 'clean', '--max-loops', '2']);
  const result = await runLoop(parsed, {
    runCodex: fake.runCodex,
    stdout: sink(),
    stderr: sink(),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.status, 'max_loops');
  assert.deepEqual(fake.workerPrompts(), ['Review', 'Review']);
});

test('forwards configured codex options to worker and judge calls', async () => {
  const fake = createFakeCodex([{ done: true, reason: 'clean' }]);
  const parsed = parseArgs([
    '--cwd',
    '/tmp/example',
    '--model',
    'test-model',
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

  assert.deepEqual(fake.calls[0].args.slice(0, 3), ['-a', 'never', 'exec']);
  assert.equal(optionValue(fake.calls[0].args, '-m'), 'test-model');
  assert.equal(optionValue(fake.calls[0].args, '-C'), '/tmp/example');
  assert.equal(optionValue(fake.calls[0].args, '-s'), 'read-only');

  const judgeCall = fake.calls.find((call) => call.args.includes('--output-schema'));
  assert.deepEqual(judgeCall.args.slice(0, 3), ['-a', 'never', 'exec']);
  assert.equal(optionValue(judgeCall.args, '-m'), 'test-model');
  assert.equal(optionValue(judgeCall.args, '-C'), '/tmp/example');
  assert.equal(optionValue(judgeCall.args, '-s'), 'read-only');
});

function createFakeCodex(judgeVerdicts) {
  const calls = [];
  let sessionCounter = 0;
  let judgeCounter = 0;

  async function runCodex(args) {
    const outputPath = optionValue(args, '-o');
    const isJudge = args.includes('--output-schema');
    const execIndex = args.indexOf('exec');
    const isResume = args[execIndex + 1] === 'resume';
    const prompt = args[args.length - 1];
    const call = { args, prompt };
    calls.push(call);

    if (isJudge) {
      const verdict = judgeVerdicts[judgeCounter] || {
        done: false,
        reason: 'default fake verdict',
      };
      judgeCounter += 1;
      await fs.writeFile(outputPath, JSON.stringify(verdict));
      return {
        code: 0,
        stdout: `${JSON.stringify({ type: 'session.started', session_id: `judge-${judgeCounter}` })}\n`,
        stderr: '',
      };
    }

    if (isResume) {
      call.resumedSessionId = args[args.length - 2];
      await fs.writeFile(outputPath, `output for ${prompt}`);
      return {
        code: 0,
        stdout: `${JSON.stringify({ type: 'session.resumed', session_id: call.resumedSessionId })}\n`,
        stderr: '',
      };
    }

    sessionCounter += 1;
    call.sessionId = `session-${sessionCounter}`;
    await fs.writeFile(outputPath, `output for ${prompt}`);
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

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return args[index + 1];
}

function sink() {
  return {
    write() {},
  };
}
