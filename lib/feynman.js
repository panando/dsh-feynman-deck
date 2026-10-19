/**
 * lib/feynman.js —— 与 feynman 命令行打交道的全部公共逻辑。
 *
 * 这一层刻意不依赖 DSH 的任何接口，所以它既能被 DSH 插件（index.js）调用，
 * 也能被 scripts/run.mjs 当成普通模块单独跑，方便脱离 DSH 排错。
 *
 * 三件事：
 *   1. 找到 feynman 命令，并算出「用哪个 node、跑哪个 js 文件」。
 *   2. 准备一个与用户日常用的 ~/.feynman 隔离的主目录（首次运行时初始化）。
 *   3. 执行一次工作流，把输出、退出码、新增/改动的文件收集起来。
 *
 * 关于 feynman 主目录的一个关键事实：环境变量 FEYNMAN_HOME 在 feynman 内部
 * 被当作「基准目录」，真正的家是 <FEYNMAN_HOME>/.feynman。所以下面所有函数
 * 收到的 home 参数都是「基准目录」，函数内部再拼 .feynman。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** feynman 提供的全部研究工作流，用 `/<名字> <输入>` 的形式展开。 */
export const FEYNMAN_WORKFLOWS = [
  'audit',
  'autoresearch',
  'compare',
  'deepresearch',
  'draft',
  'lit',
  'recipe',
  'replicate',
  'review',
  'summarize',
  'log',
];

/** 每个工作流做什么，供工具描述和 skill 文档引用。 */
export const FEYNMAN_WORKFLOW_NOTES = {
  deepresearch: '围绕一个题目做深度检索，产出带引用的一页纸报告',
  lit: '给定论文或主题做文献综述',
  compare: '比较若干篇论文的方法与结论',
  draft: '把已有材料写成论文草稿',
  recipe: '把论文的方法写成可执行的训练或实验步骤',
  replicate: '复现一篇论文的结果',
  audit: '审查一份研究产物的严谨性',
  autoresearch: '自动跑一轮选题到结论的研究',
  review: '评审一份手稿或研究方案',
  summarize: '把长文按窗口切分后分层摘要',
  log: '读取历史会话记录，产出结构化笔记',
};

/** 本地网关里可用的默认模型；feynman 自带的默认 minimax 在本机不通。 */
export const DEFAULT_MODEL = 'cpa/deepseek-v4.1-flash';

/** feynman 主目录的默认位置：与 DSH 桌面 profile 放在一起，和 ~/.feynman 分开。 */
export function defaultFeynmanHome() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE || 'desktop';
  return path.join(dshHome, 'profiles', profile, 'feynman-home');
}

function isExecutable(target) {
  try {
    fs.accessSync(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function versionParts(name) {
  return name.split('.').map((piece) => Number.parseInt(piece, 10) || 0);
}

/** 版本号从大到小排序，用来优先挑最新装的 node。 */
function compareVersionsDesc(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return r - l;
  }
  return 0;
}

/** 按优先级列出所有可能藏着 feynman 的位置。 */
export function candidateFeynmanPaths() {
  const found = [];
  if (process.env.FEYNMAN_BIN) found.push(process.env.FEYNMAN_BIN);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) found.push(path.join(dir, 'feynman'));
  }
  const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmRoot)) {
    const versions = fs.readdirSync(nvmRoot).sort(compareVersionsDesc);
    for (const version of versions) found.push(path.join(nvmRoot, version, 'bin', 'feynman'));
  }
  found.push(path.join(os.homedir(), '.bun', 'bin', 'feynman'));
  found.push('/opt/homebrew/bin/feynman');
  found.push('/usr/local/bin/feynman');
  return found;
}

/** 按优先级列出所有可能藏着 node 的位置。 */
export function candidateNodePaths() {
  const found = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) found.push(path.join(dir, 'node'));
  }
  const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmRoot)) {
    const versions = fs.readdirSync(nvmRoot).sort(compareVersionsDesc);
    for (const version of versions) found.push(path.join(nvmRoot, version, 'bin', 'node'));
  }
  found.push('/opt/homebrew/bin/node');
  found.push('/usr/local/bin/node');
  found.push('/usr/bin/node');
  return found;
}

function firstExecutable(list) {
  for (const item of list) {
    if (item && isExecutable(item)) return item;
  }
  return null;
}

/**
 * 定位 feynman 命令。
 *
 * 为什么不能只靠 PATH：从访达启动的 DSH 主进程，PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
 * 而 feynman 装在用户自己的 nvm 目录里，PATH 里根本没有它。
 */
export function resolveFeynmanBin(explicit) {
  if (explicit) return isExecutable(explicit) ? explicit : null;
  return firstExecutable(candidateFeynmanPaths());
}

/**
 * 把「feynman 命令」换算成「用哪个 node 跑哪个 js 文件」。
 *
 * 为什么不能直接执行 feynman 命令：它的头部写的是 `#!/usr/bin/env node`，
 * 在最小 PATH 下这个 shebang 找不到 node。所以先解出它真正指向的 js 文件，
 * 再用同目录下的 node 显式执行。
 * 如果解出来的不是一个 js 文件（例如某些安装方式是 shell 包装脚本），
 * 就退回直接执行，并把 node 所在目录塞进 PATH 让 shebang 能找到 node。
 */
export function resolveLauncher(binPath) {
  let real = binPath;
  try {
    real = fs.realpathSync(binPath);
  } catch {
    real = binPath;
  }
  const siblingNode = path.join(path.dirname(binPath), 'node');
  const nodeBin = isExecutable(siblingNode) ? siblingNode : firstExecutable(candidateNodePaths());
  if (/\.(?:js|mjs|cjs)$/i.test(real)) {
    return { mode: 'node-entry', nodeBin, entry: real, command: binPath };
  }
  return { mode: 'direct', nodeBin, entry: null, command: binPath };
}

/**
 * 保证 feynman 主目录已经初始化好，返回它的实际路径（<基准目录>/.feynman）。
 *
 * 首次运行时做三件事：
 *   1. 建出 agent/、sessions/、memory/ 骨架。
 *   2. 从用户日常的 ~/.feynman/agent/models.json 复制模型配置（里面有本地网关地址和密钥）。
 *   3. 写出 settings.json，并做两处改写：删掉 packages 里所有 `npm:` 开头的条目
 *      （实测会让 feynman 启动时去装 npm 包并失败），把默认模型指到本机可用的那个。
 * 已经初始化过的主目录一律不动，避免覆盖用户之后的调整。
 */
export function ensureFeynmanHome(homeBase) {
  const home = path.join(homeBase, '.feynman');
  const agentDir = path.join(home, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'memory'), { recursive: true });

  const legacyAgentDir = path.join(os.homedir(), '.feynman', 'agent');

  const modelsTarget = path.join(agentDir, 'models.json');
  if (!fs.existsSync(modelsTarget)) {
    const source = path.join(legacyAgentDir, 'models.json');
    if (fs.existsSync(source)) fs.copyFileSync(source, modelsTarget);
  }

  const settingsTarget = path.join(agentDir, 'settings.json');
  if (!fs.existsSync(settingsTarget)) {
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(path.join(legacyAgentDir, 'settings.json'), 'utf8'));
    } catch {
      settings = {};
    }
    if (Array.isArray(settings.packages)) {
      settings.packages = settings.packages.filter((item) => !String(item).startsWith('npm:'));
    }
    settings.defaultProvider = 'cpa';
    settings.defaultModel = 'deepseek-v4.1-flash';
    fs.writeFileSync(settingsTarget, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  return home;
}

const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '.cache',
  '.next',
]);

/**
 * 记录一棵目录树下每个文件的位置与修改时间，用于比较「跑之前 / 跑之后」。
 * 只用于发现产物，不追求完整，所以目录深度和文件数都有上限。
 */
export function snapshotArtifacts(root, limit = 4000) {
  const snapshot = new Map();
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && snapshot.size < limit) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= 8 || SKIPPED_DIRS.has(entry.name)) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          snapshot.set(path.relative(root, full), `${stat.mtimeMs}:${stat.size}`);
        } catch {
          /* 读不到就跳过，不影响主流程 */
        }
      }
    }
  }
  return snapshot;
}

/** 比较两次快照，返回新增或改动过的文件（相对路径，已排序）。 */
export function diffArtifacts(before, after) {
  const changed = [];
  for (const [relative, signature] of after) {
    if (before.get(relative) !== signature) changed.push(relative);
  }
  return changed.sort();
}

/** 把过长的文本截断，避免一次工具结果把上下文撐爆。 */
export function clip(text, maxChars) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  const head = value.slice(0, Math.floor(maxChars / 2));
  const tail = value.slice(-Math.floor(maxChars / 2));
  return `${head}\n\n…（中间省略 ${value.length - maxChars} 个字符）…\n\n${tail}`;
}

/**
 * 执行一次 feynman 工作流。
 *
 * @param {object} options
 * @param {string} options.workflow  工作流名字（FEYNMAN_WORKFLOWS 之一）
 * @param {string} [options.input]   工作流输入；log 这类不需要输入
 * @param {string} options.cwd       产物目录，也是 feynman 的工作目录
 * @param {string} [options.model]   模型，形如 cpa/deepseek-v4.1-flash
 * @param {number} [options.timeoutMs] 超时，超时先 SIGTERM 再 SIGKILL
 * @param {string} options.feynmanHome 主目录基准目录
 * @param {string} [options.feynmanBin] 手工指定 feynman 命令
 * @param {AbortSignal} [options.signal] 外部取消信号
 * @returns {Promise<object>} 结果对象；退出码非 0 不算异常，照常返回
 */
export function runFeynman(options) {
  const {
    workflow,
    input = '',
    cwd,
    model,
    timeoutMs = 1800000,
    feynmanHome,
    feynmanBin,
    signal,
  } = options;

  return new Promise((resolve, reject) => {
    const command = resolveFeynmanBin(feynmanBin);
    if (!command) {
      reject(
        new Error(
          '找不到 feynman 命令。请先执行 `npm install -g @companion-ai/feynman`，或在插件配置里设置 feynmanBin。',
        ),
      );
      return;
    }

    const launcher = resolveLauncher(command);
    const home = ensureFeynmanHome(feynmanHome);
    const trimmed = String(input ?? '').trim();
    const prompt = trimmed ? `/${workflow} ${trimmed}` : `/${workflow}`;

    const args = [];
    if (launcher.mode === 'node-entry') args.push(launcher.entry);
    args.push('--no-session');
    if (model) args.push('--model', model);
    args.push('--prompt', prompt);

    const commandDir = launcher.nodeBin ? path.dirname(launcher.nodeBin) : path.dirname(command);
    const env = {
      ...process.env,
      FEYNMAN_HOME: feynmanHome,
      npm_config_cache: path.join(home, 'npm-cache'),
      PATH: [commandDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(
        path.delimiter,
      ),
    };

    const executable = launcher.mode === 'node-entry' ? launcher.nodeBin : command;
    const startedAt = Date.now();
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(payload);
    };

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已经退出 */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已经退出 */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退出 */
        }
      }, 10000);
    }, timeoutMs);
    let killTimer = null;

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (exitCode, closeSignal) => {
      finish({
        exitCode,
        closeSignal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        prompt,
        home,
        command,
        launcherMode: launcher.mode,
      });
    });
  });
}
