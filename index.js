/**
 * dsh-feynman-deck —— DSH 宿主端插件：注册 feynman_research 工具。
 *
 * 这个插件只在「Feynman 研究模式」这个 preset 里挂载（见同目录 cordis.patch.yml）。
 * 它做的事情就是：模型说「跑 feynman 的某个工作流」，插件去调用外部 feynman 命令，
 * 把结果和产物清单还回去。真正的科研编排逻辑在 feynman 自己那边，这里不重写。
 *
 * 契约提醒（改这个文件时不要踩）：
 *   1. `name` 必须与 cordis.patch.yml 里的 `id` 一致，否则宿主下发的 config 会静默失效。
 *   2. `inject` 里写的是依赖的宿主 Service 名；这里只依赖 `tools`（工具注册表）。
 *   3. 定义的参数表（parameters）和输出表（output.schema）用的是 DSH 自己的
 *      简化 schema 写法，不是标准 JSON Schema：对象节点必须写明 additionalProperties，
 *      「必填」写在每个属性里（required: true），没有顶层的 required 数组。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import {
  DEFAULT_MODEL,
  FEYNMAN_WORKFLOWS,
  clip,
  defaultFeynmanHome,
  diffArtifacts,
  runFeynman,
  snapshotArtifacts,
} from './lib/feynman.js';

/** 与 cordis.patch.yml 里的插件 id 保持一致。 */
export const name = 'feynman-research';

/** 只依赖工具注册表这一个宿主能力。 */
export const inject = ['tools'];

/**
 * 插件配置。宿主可以在 cordis.patch.yml 里按字段覆盖。
 * 这些值同时也是「不覆盖时的默认行为」。
 */
export const Config = z.object({
  /** feynman 主目录的基准目录；真正的家在它的 .feynman 子目录里。留空用 defaultFeynmanHome()。 */
  feynmanHome: z.string().default(''),
  /** 手工指定 feynman 命令的绝对路径；留空则自动搜索。 */
  feynmanBin: z.string().default(''),
  /** 传给 feynman 的模型，形如 cpa/deepseek-v4.1-flash；留空用 DEFAULT_MODEL。 */
  model: z.string().default(''),
  /** 单次运行的上限毫秒数；默认 30 分钟。 */
  timeoutMs: z.number().step(1).min(1000).max(86400000).default(1800000),
  /** 返回给模型的标准输出/标准错误各截断到多少字符。 */
  maxOutputChars: z.number().step(1).min(1000).max(4000000).default(80000),
});

function formatResult(value) {
  const lines = [];
  if (value.ok) {
    lines.push(`feynman 工作流「${value.workflow}」执行成功（退出码 0）。`);
  } else if (value.timedOut) {
    lines.push(`feynman 工作流「${value.workflow}」超时被终止，未跑完。`);
  } else {
    lines.push(`feynman 工作流「${value.workflow}」退出码为 ${value.exitCode}，未成功。`);
  }
  lines.push(`工作目录：${value.cwd}`);
  lines.push(`耗时：${(value.durationMs / 1000).toFixed(1)} 秒`);
  if (value.artifacts.length > 0) {
    lines.push('本次新增或改动的文件：');
    for (const file of value.artifacts) lines.push(`  - ${file}`);
  } else {
    lines.push('本次没有新增或改动文件。');
  }
  if (value.stdout.trim()) {
    lines.push('', '--- feynman 输出 ---', value.stdout.trim());
  }
  if (value.stderr.trim()) {
    lines.push('', '--- feynman 错误输出 ---', value.stderr.trim());
  }
  return lines.join('\n');
}

export function apply(ctx, config = {}) {
  const settings = {
    feynmanHome: config.feynmanHome || defaultFeynmanHome(),
    feynmanBin: config.feynmanBin || '',
    model: config.model || DEFAULT_MODEL,
    timeoutMs: config.timeoutMs ?? 1800000,
    maxOutputChars: config.maxOutputChars ?? 80000,
  };

  const tool = defineTool({
    name: 'feynman_research',
    description: [
      '运行 Feynman 的一个科研工作流，并返回它的报告与产物文件清单。',
      'Feynman 是一个独立的外部研究代理（命令行工具 feynman），它自己会去检索文献、读 PDF、跑分析和写文件，',
      '所以这个工具相当于把一件研究工作外包出去，一次调用可能跑几分钟到几十分钟。',
      '适用场景：用户要查文献、做综述、深挖某个科学问题、比较几篇论文、复现某篇论文的结果、',
      '审查论文或代码、把长文摘要成结构化笔记、把论文方法写成可执行的实验步骤。',
      `可选的工作流（workflow 参数）：${FEYNMAN_WORKFLOWS.join('、')}。`,
      '注意两件事：第一，必须传 cwd，也就是产物落地的目录，Feynman 会在里面读写文件；',
      '第二，Feynman 是另一个代理，它看不到本次对话的上下文，所以 input 要写成自洽的完整交代，不能只写「上面那篇」。',
    ].join(''),
    parameters: {
      workflow: {
        type: 'string',
        enum: FEYNMAN_WORKFLOWS,
        required: true,
        description: '要运行的 feynman 工作流名字。',
      },
      input: {
        type: 'string',
        description: '工作流的输入，例如研究题目、论文标题或待处理的文件路径。log 这类工作流不需要输入。',
      },
      cwd: {
        type: 'string',
        required: true,
        description: '绝对路径。Feynman 在这个目录里读写文件，产物会落在这里。',
      },
      model: {
        type: 'string',
        description: `覆盖本次使用的模型，形如 cpa/deepseek-v4.1-flash。留空则用插件配置里的模型（默认 ${DEFAULT_MODEL}）。`,
      },
      timeoutMs: {
        type: 'integer',
        description: '本次运行的上限毫秒数；留空则用插件配置的值（默认 1800000，即 30 分钟）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: '退出码为 0 且没有超时。' },
          workflow: { type: 'string', required: true, description: '实际运行的工作流名字。' },
          exitCode: { type: 'integer', required: true, description: 'feynman 命令的退出码；拿不到时是 -1。' },
          timedOut: { type: 'boolean', required: true, description: '是否因为超时被终止。' },
          durationMs: { type: 'integer', required: true, description: '本次运行耗时毫秒数。' },
          cwd: { type: 'string', required: true, description: '产物目录。' },
          artifacts: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: '本次新增或改动过的文件，相对 cwd 的路径。',
          },
          stdout: { type: 'string', required: true, description: 'feynman 的标准输出（可能被截断）。' },
          stderr: { type: 'string', required: true, description: 'feynman 的标准错误（可能被截断）。' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: formatResult(value) }];
      },
    },
    // 工具自身的超时要比子进程的超时宽一点，避免子进程还没来得及收尾就被外层掐断。
    timeoutMs: settings.timeoutMs + 60000,
    // 一次调用会拉起一个重型研究代理，不适合和其他工具并发跑。
    isConcurrencySafe: () => false,

    async execute(args, exec) {
      const workflow = String(args?.workflow ?? '');
      if (!FEYNMAN_WORKFLOWS.includes(workflow)) {
        throw new Error(`不认识的工作流「${workflow}」。可选：${FEYNMAN_WORKFLOWS.join('、')}。`);
      }

      const rawCwd = String(args?.cwd ?? '').trim();
      if (!rawCwd) {
        throw new Error('cwd 是必填项：请给出 Feynman 读写文件的绝对目录。');
      }
      const cwd = path.resolve(rawCwd);
      fs.mkdirSync(cwd, { recursive: true });
      if (!fs.statSync(cwd).isDirectory()) {
        throw new Error(`cwd 不是一个目录：${cwd}`);
      }

      const before = snapshotArtifacts(cwd);
      const result = await runFeynman({
        workflow,
        input: typeof args?.input === 'string' ? args.input : '',
        cwd,
        model: typeof args?.model === 'string' && args.model ? args.model : settings.model,
        timeoutMs: Number.isFinite(args?.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : settings.timeoutMs,
        feynmanHome: settings.feynmanHome,
        feynmanBin: settings.feynmanBin,
        signal: exec?.signal,
      });
      const artifacts = diffArtifacts(before, snapshotArtifacts(cwd));

      return {
        ok: result.exitCode === 0 && !result.timedOut,
        workflow,
        exitCode: result.exitCode ?? -1,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        cwd,
        artifacts,
        stdout: clip(result.stdout, settings.maxOutputChars),
        stderr: clip(result.stderr, settings.maxOutputChars),
      };
    },
  });

  ctx.effect(() => ctx.tools.register(tool));
}
