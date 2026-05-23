'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MAX_LOOPS = 10;

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done', 'reason'],
  properties: {
    done: { type: 'boolean' },
    reason: { type: 'string' },
  },
};

class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
  }
}

function parseArgs(argv) {
  const options = {
    maxLoops: DEFAULT_MAX_LOOPS,
    json: false,
  };
  const beforePrompts = [];
  const afterPrompts = [];
  let destination = beforePrompts;
  let condition;
  let sawUntil = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }

    if (arg === '--version') {
      return { version: true };
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (isValueOption(arg, '--until')) {
      if (sawUntil) {
        throw new CliUsageError('Expected exactly one --until condition, but found another --until.');
      }
      if (beforePrompts.length === 0) {
        throw new CliUsageError('--until must appear after at least one prompt.');
      }
      const value = readOptionValue(argv, index, '--until');
      condition = value.value;
      index = value.index;
      sawUntil = true;
      destination = afterPrompts;
      continue;
    }

    if (isValueOption(arg, '--max-loops') || isValueOption(arg, '--max')) {
      const flag = arg.startsWith('--max=') || arg === '--max' ? '--max' : '--max-loops';
      const value = readOptionValue(argv, index, flag);
      options.maxLoops = parsePositiveInteger(value.value, flag);
      index = value.index;
      continue;
    }

    if (isValueOption(arg, '--cwd')) {
      const value = readOptionValue(argv, index, '--cwd');
      options.cwd = value.value;
      index = value.index;
      continue;
    }

    if (isValueOption(arg, '--model')) {
      const value = readOptionValue(argv, index, '--model');
      options.model = value.value;
      index = value.index;
      continue;
    }

    if (isValueOption(arg, '--sandbox')) {
      const value = readOptionValue(argv, index, '--sandbox');
      options.sandbox = value.value;
      index = value.index;
      continue;
    }

    if (isValueOption(arg, '--approval')) {
      const value = readOptionValue(argv, index, '--approval');
      options.approval = value.value;
      index = value.index;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }

    destination.push(arg);
  }

  if (!sawUntil) {
    throw new CliUsageError('Missing required --until condition.');
  }

  return {
    beforePrompts,
    afterPrompts,
    condition,
    options,
  };
}

function isValueOption(arg, name) {
  return arg === name || arg.startsWith(`${name}=`);
}

function readOptionValue(argv, index, name) {
  const arg = argv[index];
  if (arg.startsWith(`${name}=`)) {
    const value = arg.slice(name.length + 1);
    if (value.length === 0) {
      throw new CliUsageError(`${name} requires a value.`);
    }
    return { value, index };
  }

  const value = argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new CliUsageError(`${name} requires a value.`);
  }
  return { value, index: index + 1 };
}

function parsePositiveInteger(value, flag) {
  if (!/^\d+$/.test(value)) {
    throw new CliUsageError(`${flag} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${flag} must be a positive integer.`);
  }
  return parsed;
}

async function runLoop(parsed, dependencies = {}) {
  const runCodex =
    dependencies.runCodex ||
    createCodexRunner({
      codexBin: dependencies.codexBin,
      env: dependencies.env,
    });
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const emit = createEmitter({
    json: parsed.options.json,
    stdout,
    stderr,
  });
  const tmpRoot =
    dependencies.tmpRoot ||
    (await fs.mkdtemp(path.join(os.tmpdir(), 'loop-until-')));
  const createdTmpRoot = !dependencies.tmpRoot;
  const schemaPath = path.join(tmpRoot, 'judge.schema.json');
  let outputCounter = 0;

  await fs.writeFile(schemaPath, `${JSON.stringify(JUDGE_SCHEMA, null, 2)}\n`);

  const nextOutputPath = (kind) => {
    outputCounter += 1;
    return path.join(tmpRoot, `${String(outputCounter).padStart(3, '0')}-${kind}.txt`);
  };

  try {
    for (let loop = 1; loop <= parsed.options.maxLoops; loop += 1) {
      emit({
        type: 'loop_started',
        loop,
        maxLoops: parsed.options.maxLoops,
      });

      const transcript = [];
      let sessionId;

      for (let index = 0; index < parsed.beforePrompts.length; index += 1) {
        const prompt = parsed.beforePrompts[index];
        const outputPath = nextOutputPath(`loop-${loop}-pre-${index + 1}`);
        const args =
          index === 0
            ? buildWorkerStartArgs(prompt, outputPath, parsed.options)
            : buildWorkerResumeArgs(sessionId, prompt, outputPath, parsed.options);

        emitStepStarted(emit, loop, index + 1, totalStepCount(parsed), prompt);
        const result = await runCodex(args, { role: 'worker' });
        ensureCodexSuccess(result, args);

        if (index === 0) {
          sessionId = extractSessionIdFromJsonl(result.stdout);
          if (!sessionId) {
            throw new Error('Unable to find a Codex session id in `codex exec --json` output.');
          }
        }

        const output = await readOutputMessage(outputPath, result.stdout);
        transcript.push({
          step: index + 1,
          prompt,
          output,
        });
        emitStepFinished(emit, loop, index + 1, totalStepCount(parsed), output);
      }

      const judgePrompt = buildJudgePrompt({
        condition: parsed.condition,
        transcript,
      });
      const judgeOutputPath = nextOutputPath(`loop-${loop}-judge`);
      const judgeArgs = buildJudgeArgs(judgePrompt, judgeOutputPath, schemaPath, parsed.options);
      emit({
        type: 'judge_started',
        loop,
        condition: parsed.condition,
      });
      const judgeResult = await runCodex(judgeArgs, { role: 'judge' });
      ensureCodexSuccess(judgeResult, judgeArgs);
      const judgeMessage = await readOutputMessage(judgeOutputPath, judgeResult.stdout);
      const verdict = parseJudgeResult(judgeMessage || judgeResult.stdout);
      emit({
        type: 'judge_finished',
        loop,
        done: verdict.done,
        reason: verdict.reason,
      });

      if (verdict.done) {
        emit({
          type: 'done',
          loop,
          reason: verdict.reason,
        });
        return {
          exitCode: 0,
          status: 'done',
          loop,
          reason: verdict.reason,
        };
      }

      for (let index = 0; index < parsed.afterPrompts.length; index += 1) {
        const stepNumber = parsed.beforePrompts.length + index + 1;
        const prompt = parsed.afterPrompts[index];
        const outputPath = nextOutputPath(`loop-${loop}-post-${index + 1}`);
        const args = buildWorkerResumeArgs(sessionId, prompt, outputPath, parsed.options);

        emitStepStarted(emit, loop, stepNumber, totalStepCount(parsed), prompt);
        const result = await runCodex(args, { role: 'worker' });
        ensureCodexSuccess(result, args);
        const output = await readOutputMessage(outputPath, result.stdout);
        emitStepFinished(emit, loop, stepNumber, totalStepCount(parsed), output);
      }
    }

    emit({
      type: 'max_loops_reached',
      maxLoops: parsed.options.maxLoops,
    });
    return {
      exitCode: 1,
      status: 'max_loops',
      maxLoops: parsed.options.maxLoops,
    };
  } finally {
    if (createdTmpRoot && !dependencies.keepTmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  }
}

function buildWorkerStartArgs(prompt, outputPath, options) {
  const args = [];
  appendIfPresent(args, '-a', options.approval);
  args.push('exec', '--json', '-o', outputPath);
  appendIfPresent(args, '-m', options.model);
  appendIfPresent(args, '-C', options.cwd);
  appendIfPresent(args, '-s', options.sandbox);
  args.push(prompt);
  return args;
}

function buildWorkerResumeArgs(sessionId, prompt, outputPath, options) {
  const args = [];
  appendIfPresent(args, '-a', options.approval);
  args.push('exec', 'resume', '--json', '-o', outputPath);
  appendIfPresent(args, '-m', options.model);
  args.push(sessionId, prompt);
  return args;
}

function buildJudgeArgs(prompt, outputPath, schemaPath, options) {
  const args = [
    '-a',
    'never',
    'exec',
    '--json',
    '--output-schema',
    schemaPath,
    '-o',
    outputPath,
    '-s',
    'read-only',
  ];
  appendIfPresent(args, '-m', options.model);
  appendIfPresent(args, '-C', options.cwd);
  args.push(prompt);
  return args;
}

function appendIfPresent(args, flag, value) {
  if (value) {
    args.push(flag, value);
  }
}

function buildJudgePrompt({ condition, transcript }) {
  const transcriptText = transcript
    .map((entry) =>
      [
        `Step ${entry.step} user prompt:`,
        entry.prompt,
        '',
        `Step ${entry.step} assistant final message:`,
        entry.output || '(no final message captured)',
      ].join('\n')
    )
    .join('\n\n---\n\n');

  return [
    'You are the completion judge for loop-until.',
    'Decide whether the stop condition is satisfied by the worker output below.',
    'Do not inspect or modify files. Do not run commands.',
    'Return JSON that matches this shape: {"done": boolean, "reason": string}.',
    '',
    'Stop condition:',
    condition,
    '',
    'Worker output up to the checkpoint:',
    transcriptText,
    '',
    'Set done=true only when the condition is clearly satisfied. If uncertain, set done=false.',
  ].join('\n');
}

function createCodexRunner({ codexBin, env } = {}) {
  const bin = codexBin || process.env.LOOP_UNTIL_CODEX_BIN || 'codex';
  const childEnv = env || process.env;

  return function runCodex(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        resolve({
          code,
          signal,
          stdout,
          stderr,
        });
      });
    });
  };
}

function ensureCodexSuccess(result, args) {
  if (result.code === 0) {
    return;
  }

  const command = ['codex', ...args].join(' ');
  const detail = result.stderr || result.stdout || `exited with code ${result.code}`;
  throw new Error(`${command} failed: ${detail.trim()}`);
}

async function readOutputMessage(outputPath, stdout) {
  try {
    return (await fs.readFile(outputPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return extractLastAssistantMessageFromJsonl(stdout).trim();
  }
}

function extractSessionIdFromJsonl(stdout) {
  for (const event of parseJsonLines(stdout)) {
    const sessionId = findFirstSessionId(event);
    if (sessionId) {
      return sessionId;
    }
  }
  return undefined;
}

function findFirstSessionId(value) {
  const keys = new Set([
    'session_id',
    'sessionId',
    'conversation_id',
    'conversationId',
    'thread_id',
    'threadId',
  ]);
  const seen = new Set();
  const stack = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) {
      continue;
    }
    seen.add(current);

    for (const [key, child] of Object.entries(current)) {
      if (keys.has(key) && typeof child === 'string' && child.trim().length > 0) {
        return child.trim();
      }
      if (child && typeof child === 'object') {
        stack.push(child);
      }
    }
  }

  return undefined;
}

function extractLastAssistantMessageFromJsonl(stdout) {
  let message = '';

  for (const event of parseJsonLines(stdout)) {
    const candidate = findAssistantMessage(event);
    if (candidate) {
      message = candidate;
    }
  }

  return message;
}

function findAssistantMessage(value) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if (typeof value.message === 'string') {
    return value.message;
  }
  if (typeof value.content === 'string') {
    return value.content;
  }
  if (typeof value.text === 'string') {
    return value.text;
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const candidate = findAssistantMessage(child);
      if (candidate) {
        return candidate;
      }
    }
  }

  return undefined;
}

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {
      // Codex --json should be JSONL, but keep parsing tolerant for wrapper output.
    }
  }
  return events;
}

function parseJudgeResult(text) {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed.done !== 'boolean' || typeof parsed.reason !== 'string') {
    throw new Error('Judge did not return JSON with boolean `done` and string `reason` fields.');
  }
  return parsed;
}

function parseJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function totalStepCount(parsed) {
  return parsed.beforePrompts.length + parsed.afterPrompts.length;
}

function emitStepStarted(emit, loop, step, totalSteps, prompt) {
  emit({
    type: 'step_started',
    loop,
    step,
    totalSteps,
    prompt,
  });
}

function emitStepFinished(emit, loop, step, totalSteps, output) {
  emit({
    type: 'step_finished',
    loop,
    step,
    totalSteps,
    output,
  });
}

function createEmitter({ json, stdout }) {
  if (json) {
    return (event) => {
      stdout.write(`${JSON.stringify(event)}\n`);
    };
  }

  return (event) => {
    switch (event.type) {
      case 'loop_started':
        stdout.write(`loop-until: loop ${event.loop}/${event.maxLoops}\n`);
        break;
      case 'step_started':
        stdout.write(
          `loop-until: step ${event.step}/${event.totalSteps}: ${summarize(event.prompt)}\n`
        );
        break;
      case 'step_finished':
        if (event.output) {
          stdout.write(`${event.output}\n`);
        }
        break;
      case 'judge_started':
        stdout.write('loop-until: checking completion condition\n');
        break;
      case 'judge_finished':
        stdout.write(
          `loop-until: judge done=${String(event.done)} - ${event.reason}\n`
        );
        break;
      case 'done':
        stdout.write(`loop-until: done after loop ${event.loop}\n`);
        break;
      case 'max_loops_reached':
        stdout.write(`loop-until: reached --max-loops=${event.maxLoops}\n`);
        break;
      default:
        break;
    }
  };
}

function summarize(text) {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= 80) {
    return normalized;
  }
  return `${normalized.slice(0, 77)}...`;
}

function helpText() {
  return `Usage:
  loop-until [options] <prompt...> --until <condition> [prompt...]

Run Codex prompts in a loop until a judged completion condition is met.

Options:
  --until <condition>     Required. Completion condition for the preceding step.
  --max-loops <n>         Maximum loop iterations. Default: ${DEFAULT_MAX_LOOPS}.
  --max <n>               Alias for --max-loops.
  --cwd <dir>             Forward working directory to codex exec.
  --model <model>         Forward model to codex exec.
  --sandbox <mode>        Forward sandbox mode to the worker codex exec.
  --approval <policy>     Forward approval policy to the worker codex exec.
  --json                  Emit loop-until progress as JSONL.
  -h, --help              Show this help.

Examples:
  loop-until "Please review my uncommitted changes" --until "there are no actionable findings" "Apply the fix"
  loop-until "Run tests" --until "all tests pass" "Fix the failures"
`;
}

async function main(argv, io = process) {
  try {
    const parsed = parseArgs(argv);

    if (parsed.help) {
      io.stdout.write(helpText());
      return 0;
    }

    if (parsed.version) {
      const manifest = require('./package.json');
      io.stdout.write(`${manifest.version}\n`);
      return 0;
    }

    const result = await runLoop(parsed, {
      stdout: io.stdout,
      stderr: io.stderr,
    });
    return result.exitCode;
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr.write(`loop-until: ${error.message}\n\n${helpText()}`);
      return 2;
    }

    io.stderr.write(`loop-until: ${error.message}\n`);
    return 1;
  }
}

module.exports = {
  CliUsageError,
  buildJudgePrompt,
  extractSessionIdFromJsonl,
  helpText,
  main,
  parseArgs,
  parseJudgeResult,
  runLoop,
};
