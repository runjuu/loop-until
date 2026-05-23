'use strict';

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const DEFAULT_MAX_LOOPS = 10;

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done', 'reason'],
  properties: {
    done: { type: 'boolean' },
    reason: { type: 'string' },
  },
} as const;

type CodexRole = 'worker' | 'judge';

interface LoopOptions {
  maxLoops: number;
  json: boolean;
  cwd?: string;
  model?: string;
  sandbox?: string;
  approval?: string;
}

interface ParsedRunArgs {
  beforePrompts: string[];
  afterPrompts: string[];
  condition: string;
  options: LoopOptions;
}

type ParsedArgs = ParsedRunArgs | { help: true } | { version: true };

interface CodexResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stderrStreamed?: boolean;
}

interface CodexRunContext {
  role: CodexRole;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

type RunCodex = (args: string[], context: CodexRunContext) => Promise<CodexResult>;

interface WritableLike {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

interface RunLoopDependencies {
  runCodex?: RunCodex;
  codexBin?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: WritableLike;
  stderr?: WritableLike;
  tmpRoot?: string;
  keepTmpRoot?: boolean;
}

interface RunLoopResult {
  exitCode: number;
  status: 'done' | 'max_loops';
  loop?: number;
  reason?: string;
  maxLoops?: number;
}

interface JudgeVerdict {
  done: boolean;
  reason: string;
}

type LoopEvent =
  | { type: 'loop_started'; loop: number; maxLoops: number }
  | { type: 'step_started'; loop: number; step: number; totalSteps: number; prompt: string }
  | { type: 'step_finished'; loop: number; step: number; totalSteps: number; output: string }
  | { type: 'codex_output'; loop: number; role: CodexRole; step?: number; output: string }
  | { type: 'codex_event'; loop: number; role: CodexRole; step?: number; message: string; output?: string }
  | { type: 'judge_started'; loop: number; condition: string }
  | { type: 'judge_finished'; loop: number; done: boolean; reason: string }
  | { type: 'done'; loop: number; reason: string }
  | { type: 'max_loops_reached'; maxLoops: number };

interface TranscriptEntry {
  step: number;
  prompt: string;
  output: string;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const options: LoopOptions = {
    maxLoops: DEFAULT_MAX_LOOPS,
    json: false,
  };
  const beforePrompts: string[] = [];
  const afterPrompts: string[] = [];
  let destination = beforePrompts;
  let condition: string | undefined;
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

  if (!sawUntil || condition === undefined) {
    throw new CliUsageError('Missing required --until condition.');
  }

  return {
    beforePrompts,
    afterPrompts,
    condition,
    options,
  };
}

function isValueOption(arg: string, name: string): boolean {
  return arg === name || arg.startsWith(`${name}=`);
}

function readOptionValue(argv: string[], index: number, name: string): { value: string; index: number } {
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

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CliUsageError(`${flag} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${flag} must be a positive integer.`);
  }
  return parsed;
}

async function runLoop(parsed: ParsedRunArgs, dependencies: RunLoopDependencies = {}): Promise<RunLoopResult> {
  const runCodex =
    dependencies.runCodex ??
    createCodexRunner({
      codexBin: dependencies.codexBin,
      env: dependencies.env,
    });
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const emit = createEmitter({
    json: parsed.options.json,
    stdout,
  });
  const tmpRoot =
    dependencies.tmpRoot ??
    (await mkdtemp(path.join(tmpdir(), 'loop-until-')));
  const createdTmpRoot = dependencies.tmpRoot === undefined;
  const schemaPath = path.join(tmpRoot, 'judge.schema.json');
  let outputCounter = 0;

  await writeFile(schemaPath, `${JSON.stringify(JUDGE_SCHEMA, null, 2)}\n`);

  const nextOutputPath = (kind: string): string => {
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

      const transcript: TranscriptEntry[] = [];
      let sessionId: string | undefined;

      for (let index = 0; index < parsed.beforePrompts.length; index += 1) {
        const prompt = parsed.beforePrompts[index];
        const outputPath = nextOutputPath(`loop-${loop}-pre-${index + 1}`);
        const args =
          index === 0
            ? buildWorkerStartArgs(prompt, outputPath, parsed.options)
            : buildWorkerResumeArgs(requireSessionId(sessionId), prompt, outputPath, parsed.options);
        const codexStream = createCodexEventStream({
          emit,
          loop,
          role: 'worker',
          step: index + 1,
          stderr,
        });

        emitStepStarted(emit, loop, index + 1, totalStepCount(parsed), prompt);
        const result = await runCodex(args, {
          role: 'worker',
          onStdoutChunk: codexStream.onStdoutChunk,
          onStderrChunk: codexStream.onStderrChunk,
        });
        ensureCodexSuccess(result, args);
        forwardCodexStderr(result, stderr);

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
        if (!codexStream.didStreamFinalOutput()) {
          emitCodexOutput(emit, loop, 'worker', index + 1, output);
        }
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
      const judgeStream = createCodexEventStream({
        emit,
        loop,
        role: 'judge',
        stderr,
      });
      const judgeResult = await runCodex(judgeArgs, {
        role: 'judge',
        onStdoutChunk: judgeStream.onStdoutChunk,
        onStderrChunk: judgeStream.onStderrChunk,
      });
      ensureCodexSuccess(judgeResult, judgeArgs);
      forwardCodexStderr(judgeResult, stderr);
      const judgeMessage = await readOutputMessage(judgeOutputPath, judgeResult.stdout);
      if (!judgeStream.didStreamFinalOutput()) {
        emitCodexOutput(emit, loop, 'judge', undefined, judgeMessage);
      }
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
        const args = buildWorkerResumeArgs(requireSessionId(sessionId), prompt, outputPath, parsed.options);
        const codexStream = createCodexEventStream({
          emit,
          loop,
          role: 'worker',
          step: stepNumber,
          stderr,
        });

        emitStepStarted(emit, loop, stepNumber, totalStepCount(parsed), prompt);
        const result = await runCodex(args, {
          role: 'worker',
          onStdoutChunk: codexStream.onStdoutChunk,
          onStderrChunk: codexStream.onStderrChunk,
        });
        ensureCodexSuccess(result, args);
        forwardCodexStderr(result, stderr);
        const output = await readOutputMessage(outputPath, result.stdout);
        if (!codexStream.didStreamFinalOutput()) {
          emitCodexOutput(emit, loop, 'worker', stepNumber, output);
        }
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
    if (createdTmpRoot && dependencies.keepTmpRoot !== true) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }
}

function requireSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    throw new Error('Cannot resume Codex because no session id has been captured.');
  }
  return sessionId;
}

function buildWorkerStartArgs(prompt: string, outputPath: string, options: LoopOptions): string[] {
  const args: string[] = [];
  appendIfPresent(args, '-a', options.approval);
  args.push('exec', '--json', '-o', outputPath);
  appendIfPresent(args, '-m', options.model);
  appendIfPresent(args, '-C', options.cwd);
  appendIfPresent(args, '-s', options.sandbox);
  args.push(prompt);
  return args;
}

function buildWorkerResumeArgs(
  sessionId: string,
  prompt: string,
  outputPath: string,
  options: LoopOptions
): string[] {
  const args: string[] = [];
  appendIfPresent(args, '-a', options.approval);
  appendIfPresent(args, '-C', options.cwd);
  appendIfPresent(args, '-s', options.sandbox);
  args.push('exec', 'resume', '--json', '-o', outputPath);
  appendIfPresent(args, '-m', options.model);
  args.push(sessionId, prompt);
  return args;
}

function buildJudgeArgs(prompt: string, outputPath: string, schemaPath: string, options: LoopOptions): string[] {
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

function appendIfPresent(args: string[], flag: string, value: string | undefined): void {
  if (value) {
    args.push(flag, value);
  }
}

function buildJudgePrompt({ condition, transcript }: { condition: string; transcript: TranscriptEntry[] }): string {
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

function createCodexEventStream({
  emit,
  loop,
  role,
  step,
  stderr,
}: {
  emit: (event: LoopEvent) => void;
  loop: number;
  role: CodexRole;
  step?: number;
  stderr: WritableLike;
}): {
  onStdoutChunk: (chunk: string) => void;
  onStderrChunk: (chunk: string) => void;
  didStreamFinalOutput: () => boolean;
} {
  let pendingStdout = '';
  let streamedFinalOutput = false;

  return {
    onStdoutChunk(chunk) {
      pendingStdout += chunk;

      while (true) {
        const newlineIndex = pendingStdout.indexOf('\n');
        if (newlineIndex === -1) {
          break;
        }

        const line = pendingStdout.slice(0, newlineIndex);
        pendingStdout = pendingStdout.slice(newlineIndex + 1);
        const event = parseCodexJsonLine(line);
        if (!event) {
          continue;
        }

        const output = codexFinalOutputFromEvent(event);
        if (output !== undefined) {
          streamedFinalOutput = true;
          emitCodexOutput(emit, loop, role, step, output);
          continue;
        }

        const progress = codexProgressFromEvent(event);
        if (progress) {
          emit({
            type: 'codex_event',
            loop,
            role,
            step,
            message: progress.message,
            output: progress.output,
          });
        }
      }
    },
    onStderrChunk(chunk) {
      stderr.write(chunk);
    },
    didStreamFinalOutput() {
      return streamedFinalOutput;
    },
  };
}

function parseCodexJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isObjectRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function codexFinalOutputFromEvent(event: Record<string, unknown>): string | undefined {
  const item = event.item;
  if (!isObjectRecord(item) || item.type !== 'agent_message') {
    return undefined;
  }

  return typeof item.text === 'string' ? item.text : undefined;
}

function codexProgressFromEvent(
  event: Record<string, unknown>
): { message: string; output?: string } | undefined {
  const type = event.type;
  if (type === 'thread.started') {
    const threadId = stringValue(event.thread_id) ?? stringValue(event.session_id);
    return {
      message: threadId ? `thread started: ${threadId}` : 'thread started',
    };
  }

  if (type === 'turn.started') {
    return { message: 'turn started' };
  }

  const item = event.item;
  if (!isObjectRecord(item)) {
    return typeof type === 'string' ? { message: type } : undefined;
  }

  const itemType = stringValue(item.type);
  if (type === 'item.started') {
    if (itemType === 'command_execution') {
      const command = stringValue(item.command);
      return {
        message: command ? `running command: ${command}` : 'running command',
      };
    }
    return itemType ? { message: `${itemType} started` } : undefined;
  }

  if (type === 'item.completed') {
    if (itemType === 'command_execution') {
      const command = stringValue(item.command);
      const exitCode = numberValue(item.exit_code);
      const status = exitCode === undefined ? '' : ` (exit ${exitCode})`;
      const output = stringValue(item.aggregated_output);
      return {
        message: command ? `command completed: ${command}${status}` : `command completed${status}`,
        output: output && output.length > 0 ? output : undefined,
      };
    }
    return itemType ? { message: `${itemType} completed` } : undefined;
  }

  return typeof type === 'string' ? { message: type } : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function createCodexRunner({ codexBin, env }: { codexBin?: string; env?: NodeJS.ProcessEnv } = {}): RunCodex {
  const bin = codexBin ?? process.env.LOOP_UNTIL_CODEX_BIN ?? 'codex';
  const childEnv = env ?? process.env;

  return function runCodex(args: string[], context: CodexRunContext): Promise<CodexResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let stderrStreamed = false;

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        context.onStdoutChunk?.(chunk);
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (context.onStderrChunk) {
          stderrStreamed = true;
          context.onStderrChunk(chunk);
        }
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        resolve({
          code,
          signal,
          stdout,
          stderr,
          stderrStreamed,
        });
      });
    });
  };
}

function ensureCodexSuccess(result: CodexResult, args: string[]): void {
  if (result.code === 0) {
    return;
  }

  const command = ['codex', ...args].join(' ');
  const detail = result.stderr || result.stdout || `exited with code ${String(result.code)}`;
  throw new Error(`${command} failed: ${detail.trim()}`);
}

function forwardCodexStderr(result: CodexResult, stderr: WritableLike): void {
  if (result.stderr.length === 0 || result.stderrStreamed === true) {
    return;
  }
  stderr.write(result.stderr);
  if (!result.stderr.endsWith('\n')) {
    stderr.write('\n');
  }
}

async function readOutputMessage(outputPath: string, stdout: string): Promise<string> {
  try {
    return (await readFile(outputPath, 'utf8')).trim();
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
    return extractLastAssistantMessageFromJsonl(stdout).trim();
  }
}

function extractSessionIdFromJsonl(stdout: string): string | undefined {
  for (const event of parseJsonLines(stdout)) {
    const sessionId = findFirstSessionId(event);
    if (sessionId) {
      return sessionId;
    }
  }
  return undefined;
}

function findFirstSessionId(value: unknown): string | undefined {
  const keys = new Set([
    'session_id',
    'sessionId',
    'conversation_id',
    'conversationId',
    'thread_id',
    'threadId',
  ]);
  const seen = new Set<object>();
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!isObjectRecord(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);

    for (const [key, child] of Object.entries(current)) {
      if (keys.has(key) && typeof child === 'string' && child.trim().length > 0) {
        return child.trim();
      }
      if (isObjectRecord(child)) {
        stack.push(child);
      }
    }
  }

  return undefined;
}

function extractLastAssistantMessageFromJsonl(stdout: string): string {
  let message = '';

  for (const event of parseJsonLines(stdout)) {
    const candidate = findAssistantMessage(event);
    if (candidate) {
      message = candidate;
    }
  }

  return message;
}

function findAssistantMessage(value: unknown): string | undefined {
  if (!isObjectRecord(value)) {
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
    const candidate = findAssistantMessage(child);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function parseJsonLines(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line) as unknown);
    } catch {
      // Codex --json should be JSONL, but keep parsing tolerant for wrapper output.
    }
  }
  return events;
}

function parseJudgeResult(text: string): JudgeVerdict {
  const parsed = parseJsonObject(text);
  if (
    !isObjectRecord(parsed) ||
    typeof parsed.done !== 'boolean' ||
    typeof parsed.reason !== 'string'
  ) {
    throw new Error('Judge did not return JSON with boolean `done` and string `reason` fields.');
  }
  return {
    done: parsed.done,
    reason: parsed.reason,
  };
}

function parseJsonObject(text: string): unknown {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
}

function totalStepCount(parsed: ParsedRunArgs): number {
  return parsed.beforePrompts.length + parsed.afterPrompts.length;
}

function emitStepStarted(
  emit: (event: LoopEvent) => void,
  loop: number,
  step: number,
  totalSteps: number,
  prompt: string
): void {
  emit({
    type: 'step_started',
    loop,
    step,
    totalSteps,
    prompt,
  });
}

function emitStepFinished(
  emit: (event: LoopEvent) => void,
  loop: number,
  step: number,
  totalSteps: number,
  output: string
): void {
  emit({
    type: 'step_finished',
    loop,
    step,
    totalSteps,
    output,
  });
}

function emitCodexOutput(
  emit: (event: LoopEvent) => void,
  loop: number,
  role: CodexRole,
  step: number | undefined,
  output: string
): void {
  emit({
    type: 'codex_output',
    loop,
    role,
    step,
    output,
  });
}

const ANSI = {
  reset: '\u001B[0m',
  boldCyan: '\u001B[1;36m',
  boldBlue: '\u001B[1;34m',
  yellow: '\u001B[33m',
  green: '\u001B[32m',
  red: '\u001B[31m',
} as const;

function createEmitter({ json, stdout }: { json: boolean; stdout: WritableLike }): (event: LoopEvent) => void {
  if (json) {
    return (event) => {
      stdout.write(`${JSON.stringify(event)}\n`);
    };
  }

  const colorEnabled = shouldColor(stdout);

  return (event) => {
    switch (event.type) {
      case 'loop_started':
        stdout.write(formatLoopLine(`== Loop ${event.loop}/${event.maxLoops} ==`, 'boldCyan', colorEnabled));
        break;
      case 'step_started':
        stdout.write(
          formatLoopLine(
            `-- Step ${event.step}/${event.totalSteps}: ${summarize(event.prompt)} --`,
            'boldBlue',
            colorEnabled
          )
        );
        break;
      case 'step_finished':
        break;
      case 'codex_output':
        if (event.output) {
          stdout.write(formatCodexOutputHeader(event));
          stdout.write(formatIndentedBlock(formatDisplayOutput(event.output)));
        }
        break;
      case 'codex_event':
        stdout.write(formatCodexEvent(event));
        if (event.output) {
          stdout.write(formatIndentedBlock(event.output));
        }
        break;
      case 'judge_started':
        stdout.write(formatLoopLine('-- Judge: checking completion condition --', 'yellow', colorEnabled));
        break;
      case 'judge_finished':
        stdout.write(
          formatLoopLine(
            `-- Judge: done=${String(event.done)} - ${event.reason} --`,
            'yellow',
            colorEnabled
          )
        );
        break;
      case 'done':
        stdout.write(formatLoopLine(`== Done after loop ${event.loop} ==`, 'green', colorEnabled));
        break;
      case 'max_loops_reached':
        stdout.write(formatLoopLine(`== Reached --max-loops=${event.maxLoops} ==`, 'red', colorEnabled));
        break;
    }
  };
}

function shouldColor(stdout: WritableLike): boolean {
  return stdout.isTTY === true && !Object.prototype.hasOwnProperty.call(process.env, 'NO_COLOR');
}

function formatLoopLine(text: string, color: keyof typeof ANSI, colorEnabled: boolean): string {
  if (!colorEnabled) {
    return `${text}\n`;
  }
  return `${ANSI[color]}${text}${ANSI.reset}\n`;
}

function formatCodexEvent(event: Extract<LoopEvent, { type: 'codex_event' }>): string {
  return `[${formatCodexRole(event)}] ${event.message}\n`;
}

function formatCodexOutputHeader(event: Extract<LoopEvent, { type: 'codex_output' }>): string {
  return `-- Codex ${formatCodexRole(event)} output --\n`;
}

function formatCodexRole(event: { role: CodexRole; step?: number }): string {
  if (event.role === 'worker' && event.step !== undefined) {
    return `worker step ${event.step}`;
  }
  return event.role;
}

function formatIndentedBlock(text: string): string {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return `${lines.map((line) => `    ${line}`).join('\n')}\n`;
}

function formatDisplayOutput(text: string): string {
  const trimmed = String(text).trim();
  if (!trimmed) {
    return trimmed;
  }

  try {
    return JSON.stringify(JSON.parse(trimmed) as unknown, null, 2);
  } catch {
    return String(text);
  }
}

function summarize(text: string): string {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= 80) {
    return normalized;
  }
  return `${normalized.slice(0, 77)}...`;
}

function helpText(): string {
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

async function main(argv: string[], io: { stdout: WritableLike; stderr: WritableLike } = process): Promise<number> {
  try {
    const parsed = parseArgs(argv);

    if ('help' in parsed) {
      io.stdout.write(helpText());
      return 0;
    }

    if ('version' in parsed) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const manifest = require('../package.json') as { version: string };
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

    io.stderr.write(`loop-until: ${errorMessage(error)}\n`);
    return 1;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export {
  CliUsageError,
  buildJudgePrompt,
  extractSessionIdFromJsonl,
  helpText,
  main,
  parseArgs,
  parseJudgeResult,
  runLoop,
};
