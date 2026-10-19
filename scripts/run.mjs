#!/usr/bin/env node
/**
 * scripts/run.mjs —— 脱离 DSH 手工跑一次 feynman 工作流。
 *
 * 用途：装插件之前先确认「命令行这条路」本身是通的；出问题时也用它把
 * 插件逻辑和 DSH 本身分开排查。
 *
 * 用法：
 *   node scripts/run.mjs --workflow log --cwd /tmp/feynman-try
 *   node scripts/run.mjs --workflow deepresearch --input "某个题目" --cwd /tmp/feynman-try
 *
 * 可选参数：--model、--timeout-ms、--home、--bin
 */
import path from 'node:path';
import {
  DEFAULT_MODEL,
  FEYNMAN_WORKFLOWS,
  defaultFeynmanHome,
  diffArtifacts,
  runFeynman,
  snapshotArtifacts,
} from '../lib/feynman.js';

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = value;
      i += 1;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.help || !options.workflow || !options.cwd) {
  console.log('用法: node scripts/run.mjs --workflow <名字> --cwd <目录> [--input "..."] [--model ...] [--timeout-ms N]');
  console.log(`可用工作流: ${FEYNMAN_WORKFLOWS.join(', ')}`);
  process.exit(options.help ? 0 : 1);
}

const cwd = path.resolve(String(options.cwd));
const feynmanHome = options.home ? path.resolve(String(options.home)) : defaultFeynmanHome();

const before = snapshotArtifacts(cwd);
const result = await runFeynman({
  workflow: String(options.workflow),
  input: typeof options.input === 'string' ? options.input : '',
  cwd,
  model: typeof options.model === 'string' ? options.model : DEFAULT_MODEL,
  timeoutMs: options.timeoutMs ? Number(options.timeoutMs) : 1800000,
  feynmanHome,
  feynmanBin: typeof options.bin === 'string' ? options.bin : '',
});
const artifacts = diffArtifacts(before, snapshotArtifacts(cwd));

console.log('---- 摘要 ----');
console.log(`工作流      : ${options.workflow}`);
console.log(`工作目录    : ${cwd}`);
console.log(`feynman 主目录: ${feynmanHome}`);
console.log(`实际使用的主目录: ${result.home}`);
console.log(`退出码      : ${result.exitCode}`);
console.log(`耗时        : ${(result.durationMs / 1000).toFixed(1)} 秒`);
console.log(`超时        : ${result.timedOut}`);
console.log(`新增/改动文件: ${artifacts.length === 0 ? '（无）' : ''}`);
for (const file of artifacts) console.log(`  - ${file}`);
console.log('---- 标准输出 ----');
console.log(result.stdout);
if (result.stderr.trim()) {
  console.log('---- 标准错误 ----');
  console.log(result.stderr);
}

process.exit(result.exitCode === 0 && !result.timedOut ? 0 : 1);
