/**
 * Tooling workloads: what the static checks cost.
 *
 * These belong in the same gate as the runtime ones because they are the same
 * promise. "Ordinary development does not require a persistent compiler" is an
 * invariant, and it is only true while a typecheck stays under a second and the
 * template check stays in the seconds. A regression here is felt on every edit,
 * which makes it more expensive than a regression in a 10,000-row render.
 *
 * The binaries are invoked directly rather than through `npm run`, because a
 * measurement of `npm` starting is not a measurement of the checker. Exit status is
 * checked before the timing counts: a typecheck that failed is fast for the wrong
 * reason.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** @import { BenchmarkSample, NodeWorkloadContext, WorkloadSpec } from '../types.js' */

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number, output: string, ms: number }>}
 */
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? -1, output, ms: performance.now() - started });
    });
  });
}

/**
 * @param {NodeWorkloadContext} context
 * @param {{ command: string, args: readonly string[] }} tool
 * @returns {Promise<BenchmarkSample[]>}
 */
async function repeatTool(context, tool) {
  /** @type {BenchmarkSample[]} */
  const samples = [];
  const command = tool.command.startsWith('node_modules')
    ? join(context.repo, tool.command)
    : tool.command;

  for (let index = 0; index < context.warmup + context.samples; index += 1) {
    const result = await run(command, tool.args, context.repo);
    /** @type {BenchmarkSample} */
    const sample =
      result.code === 0
        ? { ok: true, duration: result.ms }
        : {
            ok: false,
            detail: `${tool.command} exited ${String(result.code)}: ${result.output.trim().split('\n').slice(-3).join(' | ')}`,
          };
    if (index >= context.warmup || !sample.ok) samples.push(sample);
    if (!sample.ok) break;
  }
  return samples;
}

/** @type {WorkloadSpec[]} */
export const TOOLING_WORKLOADS = [
  {
    id: 'tooling/typecheck',
    suite: 'tooling',
    title: 'Whole-project typecheck',
    driver: 'node',
    samples: { local: 5, ci: 3 },
    warmup: { local: 1, ci: 1 },
    run: (context) =>
      repeatTool(context, { command: 'node_modules/tsgo/bin/tsc', args: ['--noEmit'] }),
  },
  {
    id: 'tooling/template-check',
    suite: 'tooling',
    title: 'Static template checking for every application',
    driver: 'node',
    samples: { local: 5, ci: 3 },
    warmup: { local: 1, ci: 1 },
    run: (context) =>
      repeatTool(context, { command: process.execPath, args: ['cli/checks/template-check.mjs'] }),
  },
  {
    id: 'tooling/verify',
    suite: 'tooling',
    title: 'Architecture, integrity and dependency verification',
    driver: 'node',
    samples: { local: 5, ci: 3 },
    warmup: { local: 1, ci: 1 },
    run: (context) =>
      repeatTool(context, { command: process.execPath, args: ['tools/checks/verify-deps.mjs'] }),
  },
  {
    id: 'tooling/lint',
    suite: 'tooling',
    title: 'Type-aware lint',
    driver: 'node',
    samples: { local: 3, ci: 2 },
    warmup: { local: 1, ci: 1 },
    run: (context) => repeatTool(context, { command: 'node_modules/.bin/eslint', args: ['.'] }),
  },
];
