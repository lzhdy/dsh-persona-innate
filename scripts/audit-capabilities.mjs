#!/usr/bin/env node
/**
 * 能力台账检查器（capability ledger)
 *
 * 为什么需要它：这个项目两次栽在同一类缺陷上——
 *   `retentionPriority()` 写好了没人调、`initiation` 类型和落盘都有但三个
 *   `addEvent` 调用点无一传入、`bypassDecision()` 只有单测。
 *   这类"机制在、但零调用"的东西，读代码和跑测试都发现不了（测试直接调函数）。
 *
 * 所以台账不手工维护：本脚本是唯一真相，`--write` 生成 docs/capability-ledger.md。
 * 规则：
 *   - status=done 的条目，必须至少有一个 witness 在**定义文件之外**被匹配到；
 *   - status=partial / missing 的条目，witness 命中与否都合法（它就是还没接）。
 * 这样"把状态写成 done"本身就是一个要拿代码兑现的承诺。
 *
 * 用法：
 *   node scripts/audit-capabilities.mjs           # 检查，违规时退出码 1
 *   node scripts/audit-capabilities.mjs --write    # 重新生成台账文档
 *   node scripts/audit-capabilities.mjs --json     # 机器可读
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');
const LEDGER = join(ROOT, 'docs', 'capability-ledger.md');

/**
 * @typedef {object} Witness
 * @property {string} label   人读的名字（符号/调用形态）
 * @property {string} pattern 正则源码，用来在源码里找"被使用"的证据
 * @property {string} definedIn 定义所在文件（该文件的定义行不算调用）
 * @property {string[]} [expectIn] 期望出现调用的文件；留空表示"任意其它 src 文件"
 * @property {boolean} [inString] 允许在字符串字面量里匹配（仅限 provider 名这类天生是字符串的标识）
 * @property {string} [symbol] 定义处的符号名（默认从 pattern 里取第一个标识符）
 */

/**
 * @typedef {object} Item
 * @property {string} id
 * @property {string} name
 * @property {string} milestone
 * @property {'done'|'partial'|'missing'} status
 * @property {'any'|'all'} [mode] any=任一 witness 命中即算接线（默认）；all=全部必须命中
 * @property {Witness[]} witnesses
 * @property {string} note
 */

/** 台账条目。新增功能 / 调整功能时，在同一个 commit 里改这里。 @type {Item[]} */
const ITEMS = [
  // ── M0 记忆层 ──────────────────────────────────────────────
  {
    id: 'M0-events',
    name: 'events 记忆（按月分片追加）',
    milestone: 'M0',
    status: 'done',
    witnesses: [
      { label: 'log.append', pattern: 'log\\.append\\(', definedIn: 'event-log.ts', expectIn: ['memory.ts'] },
    ],
    note: 'events/YYYY-MM.jsonl，写入 O(1)',
  },
  {
    id: 'M0-provenance',
    name: 'provenance 显著性权重（提不提）',
    milestone: 'M0',
    status: 'done',
    witnesses: [
      { label: 'SALIENCE_WEIGHT', pattern: 'SALIENCE_WEIGHT', definedIn: 'provenance.ts', expectIn: ['recall.ts'] },
    ],
    note: '七类来源枚举 + 显著性权重已接线（v0.5 起 recall 用 SALIENCE_WEIGHT，不再用 PROVENANCE_WEIGHT）',
  },
  {
    id: 'X-provenance-weight',
    name: 'provenance 可信度权重（能不能当事实）',
    milestone: 'M0 预留',
    status: 'partial',
    witnesses: [
      { label: 'recallScore(...)', pattern: 'recallScore\\(', definedIn: 'provenance.ts', expectIn: [] },
    ],
    note: 'PROVENANCE_WEIGHT 只被 provenance.ts 内的 recallScore() 消费，而 recallScore 生产零调用（唯一调用点 tests/m0.test.mjs:190）。保留原因：它仍是"可信度"口径的规范定义，且 m1-code-api-spec.md 有 API 记录；要么接进留存/归档路径，要么在下次评审时删掉，不要一直挂着当门面',
  },
  {
    id: 'M0-inject-memory',
    name: '每轮记忆注入（五槽装配）',
    milestone: 'M0',
    status: 'done',
    witnesses: [
      { label: 'buildInjection', pattern: '\\.buildInjection\\(', definedIn: 'recall.ts', expectIn: ['index.ts'] },
    ],
    note: 'order 150',
  },
  {
    id: 'M0-innate',
    name: '先天画像采样',
    milestone: 'M0',
    status: 'done',
    witnesses: [
      { label: 'sampleProfileIfNeeded', pattern: 'sampleProfile\\(|sampleProfileIfNeeded\\(', definedIn: 'innate.ts', expectIn: ['index.ts'] },
    ],
    note: '',
  },

  // ── M1 自我模型 / 复盘 / 状态 ───────────────────────────────
  {
    id: 'M1-review',
    name: '每日复盘（游标协议）',
    milestone: 'M1',
    status: 'done',
    witnesses: [
      { label: 'runReviewWithCursor', pattern: 'runReviewWithCursor\\(', definedIn: 'review-cursor.ts', expectIn: ['index.ts'] },
    ],
    note: '0.5.2 修首次死锁；窗口 = 时刻区间',
  },
  {
    id: 'M1-selfmodel',
    name: 'self_model 版本化与历史',
    milestone: 'M1',
    status: 'done',
    witnesses: [
      { label: 'commitFromSources', pattern: 'commitFromSources\\(', definedIn: 'self-model.ts', expectIn: ['review.ts'] },
    ],
    note: '',
  },
  {
    id: 'M1-inject-selfmodel',
    name: '自我模型注入',
    milestone: 'M1',
    status: 'done',
    witnesses: [
      { label: 'persona-self-model provider', pattern: "name: 'persona-self-model'", definedIn: '__none__', expectIn: ['index.ts'], inString: true },
    ],
    note: 'order 170',
  },
  {
    id: 'M1-state',
    name: '状态机（效价×唤醒 + 关系阶段）',
    milestone: 'M1',
    status: 'done',
    // decay 与 snapshot 是两条独立通路，必须都接线才算完成
    mode: 'all',
    witnesses: [
      { label: 'stateMachine.decay', pattern: 'stateMachine\\.decay\\(', definedIn: 'state.ts', expectIn: ['index.ts'] },
      { label: 'stateMachine.snapshot', pattern: 'stateMachine\\.snapshot\\(', definedIn: 'state.ts', expectIn: ['index.ts'] },
    ],
    note: '0.5.0 把 decay 接进会话主链路',
  },
  {
    id: 'M1-state-inject',
    name: '状态注入',
    milestone: 'M1',
    status: 'partial',
    witnesses: [
      { label: 'persona-state provider', pattern: "name: 'persona-state'", definedIn: '__none__', expectIn: ['index.ts'], inString: true },
    ],
    note: '挂在 order 160（表达端），文档要求给评估端/状态机——对象错位未处置',
  },
  {
    id: 'M1-archive',
    name: '成长档案',
    milestone: 'M1',
    status: 'done',
    witnesses: [
      { label: 'selfModel.appendGrowth', pattern: 'appendGrowth\\(', definedIn: 'self-model.ts', expectIn: ['review.ts'] },
    ],
    note: '真正落盘在 review.ts:432 的 appendGrowth；旧 witness 只匹配到 index.ts 里一句日志文案',
  },
  {
    id: 'M1-audit',
    name: '漂移审计（/persona audit）',
    milestone: 'M1',
    status: 'done',
    witnesses: [
      { label: 'runDriftAudit(...)', pattern: 'runDriftAudit\\(', definedIn: 'eval.ts', expectIn: ['index.ts'] },
    ],
    note: '手动命令，非运行时门禁。旧 witness 匹配的是 /^audit$/i 这个无关字面量，改指向 eval.ts:308 定义、index.ts:1311 调用的真实符号',
  },

  // ── M2 动机引擎 ────────────────────────────────────────────
  {
    id: 'M2-motivation',
    name: '动机引擎（主动对话 / 主动提起记忆）',
    milestone: 'M2',
    status: 'missing',
    witnesses: [
      { label: 'motivation', pattern: 'motivation|shouldSpeak|reachOut', definedIn: '__none__', expectIn: [] },
    ],
    note: '文档 §275、里程碑 M2；src 零命中。主动性缺它就无法实施',
  },
  {
    id: 'M2-plateau',
    name: '平台期识别',
    milestone: 'M2',
    status: 'missing',
    witnesses: [{ label: 'plateau', pattern: 'plateau|平台期', definedIn: '__none__', expectIn: [] }],
    note: '验收要求：高频重复互动不误判为推进',
  },
  {
    id: 'M2-downregulate',
    name: '失衡降频（人格自主性审计联动）',
    milestone: 'M2',
    status: 'missing',
    witnesses: [{ label: '降频', pattern: '降频|downregulat|自主性审计', definedIn: '__none__', expectIn: [] }],
    note: '',
  },

  // ── 半接：机制在、但零调用（本项目的高危类）────────────────
  {
    id: 'X-initiation',
    name: 'initiation 责任归因（self/user/external）',
    milestone: 'M0 预留',
    status: 'partial',
    witnesses: [
      { label: 'addEvent 传 initiation', pattern: 'initiation:', definedIn: '__none__', expectIn: ['index.ts'] },
    ],
    note: '类型/落盘/O17 降级复盘都写好了，但 index.ts 三个 addEvent 均未传；责任归因目前靠 provenance 启发式',
  },
  {
    id: 'X-forget',
    name: '遗忘三件套（衰减/压缩/物理删除）',
    milestone: '未排期',
    status: 'partial',
    witnesses: [
      { label: 'retentionPriority(...)', pattern: 'retentionPriority\\(', definedIn: 'memory.ts', expectIn: [] },
    ],
    note: '函数已实现零调用；thread 30 天过期是目前唯一遗忘机制',
  },
  {
    id: 'X-honesty',
    name: '诚实基线（三级旁路）',
    milestone: '未排期',
    status: 'partial',
    witnesses: [
      { label: 'bypassDecision(...)', pattern: 'bypassDecision\\(', definedIn: 'eval.ts', expectIn: [] },
      { label: 'renderUncertainty(...)', pattern: 'renderUncertainty\\(', definedIn: 'eval.ts', expectIn: [] },
    ],
    note: '只有函数与单测，运行时无调用点',
  },
  {
    id: 'X-fact-persist',
    name: 'PersonaFact 落盘',
    milestone: '未排期',
    status: 'missing',
    witnesses: [{ label: 'persistFacts', pattern: 'persistFacts|facts\\.persist', definedIn: '__none__', expectIn: [] }],
    note: '复盘 distillFacts 产出不持久化，注入只读 events 与 thread/attribute',
  },
  {
    id: 'X-attr-inject',
    name: 'attribute 注入消费者',
    milestone: '未排期',
    status: 'partial',
    witnesses: [
      { label: '注入侧读 attributes', pattern: 'attributes', definedIn: '__none__', expectIn: ['recall.ts', 'memory.ts'] },
    ],
    note: 'loadAttributes 只用于复盘合并与 /persona threads，不进注入',
  },
  {
    id: 'X-consistency-gate',
    name: '一致性门禁阻断 commit',
    milestone: '未排期',
    status: 'partial',
    witnesses: [
      { label: 'consistencyCheck', pattern: 'consistencyCheck\\(', definedIn: 'review.ts', expectIn: [] },
    ],
    note: 'review.ts:397 确实调用（旧版按整文件排除同文件调用，误报成零调用）。仍是 partial：只把 selfModel 置 null，facts/threads 照常提交',
  },
  {
    id: 'X-session-isolation',
    name: '多会话上下文隔离',
    milestone: '未排期',
    status: 'partial',
    witnesses: [
      { label: '注入缓存按会话键控', pattern: 'injectedText\\s*=\\s*new Map|sessionId.*injectedText', definedIn: '__none__', expectIn: [] },
    ],
    note: '三个注入缓存是 apply 闭包里的 let（进程级单例）；接 QQ 后会多一个 Agent，共享会被放大',
  },

  // ── M3 及以后 ──────────────────────────────────────────────
  {
    id: 'M3-voice',
    name: '语音',
    milestone: 'M3',
    status: 'missing',
    witnesses: [{ label: 'voice/tts', pattern: '语音|\\bvoice\\b|\\btts\\b', definedIn: '__none__', expectIn: [] }],
    note: '',
  },
  {
    id: 'M3-multiagent',
    name: '多角色隔离（dataDir 按 agent/用户键控）',
    milestone: 'M3',
    status: 'missing',
    witnesses: [{ label: '按用户键控 dataDir', pattern: 'dataDir.*agentId|agentId.*dataDir', definedIn: '__none__', expectIn: [] }],
    note: '当前单实例',
  },
  {
    id: 'M4-body-protocol',
    name: '身体协议（Body Protocol）',
    milestone: 'M4',
    status: 'missing',
    witnesses: [{ label: 'reportBodyEvent', pattern: 'reportBodyEvent|bodyProtocol', definedIn: '__none__', expectIn: [] }],
    note: '文档 §身体 有完整设计；没有任何能力插件能回报经历',
  },
  {
    id: 'M4-permission',
    name: '权限中心',
    milestone: 'M4',
    status: 'missing',
    witnesses: [{ label: 'permissionCenter', pattern: 'permissionCenter|能力开关', definedIn: '__none__', expectIn: [] }],
    note: '',
  },
  {
    id: 'M5-content',
    name: '内容平台（视频/评论）',
    milestone: 'M5',
    status: 'missing',
    witnesses: [{ label: 'browser', pattern: 'browser|浏览器', definedIn: '__none__', expectIn: [] }],
    note: '',
  },
  {
    id: 'M6-im',
    name: '社交 IM（QQ）',
    milestone: 'M6',
    status: 'partial',
    witnesses: [{ label: 'IM 通道', pattern: 'qqbot|qq-bridge|imChannel', definedIn: '__none__', expectIn: [] }],
    note: '2026-11-04 运行期打通：官方 0.5.5 + 私聊 allowlist + 群聊 disabled，QQ 收发正常，persona 四个注入块确实到达 QQ 会话（用 session.v4.jsonl.zstd 逐帧解压验证）。仍是 partial：身体级实现（经历回报/initiation）需自研，见 docs/im-channel-evaluation.md',
  },
  {
    id: 'M7-local-app',
    name: '本地应用插件',
    milestone: 'M7',
    status: 'missing',
    witnesses: [{ label: 'localApp', pattern: 'localApp|本地应用', definedIn: '__none__', expectIn: [] }],
    note: '',
  },
];

/* ── 执行 ─────────────────────────────────────────────────── */

/**
 * 去掉注释与字符串字面量，只留代码骨架。
 *
 * 为什么必须做：这个脚本的第一版有假阳性——`// TODO: 以后要调 retentionPriority()`
 * 这样的注释、或者日志文案里的 `'retentionPriority'`，都会被判成"已接线"。
 * 一个能被注释骗过的检查器，比没有检查器更危险（它给人虚假的安全感）。
 *
 * 保留换行（不删而是填空白），这样行号与原文一一对应，后面按行过滤仍然有效。
 */
function stripCommentsAndStrings(text) {
  const out = text.split('');
  const n = text.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let prevSig = '';
  let i = 0;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '/' && c2 === '/') {
      const nl = text.indexOf('\n', i);
      const to = nl === -1 ? n : nl;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const close = text.indexOf('*/', i + 2);
      const to = close === -1 ? n : close + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === c) break;
        j += 1;
      }
      blank(i, j + 1);
      i = j + 1;
      prevSig = c;
      continue;
    }
    // 正则字面量：靠前一个有效字符判断（`/` 在 `(`、`,`、`=` 等之后才是正则的起点）
    if (c === '/' && ('(,=:[!&|?{};'.includes(prevSig) || prevSig === '')) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        else if (text[j] === '\n') break;
        j += 1;
      }
      blank(i, j + 1);
      i = j + 1;
      prevSig = '/';
      continue;
    }
    if (!/\s/.test(c)) prevSig = c;
    i += 1;
  }
  return out.join('');
}

/** 递归收集 src 下的 .ts（第一版只扫 src 顶层，子目录会被静默跳过） */
async function walk(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), rel)));
    else if (e.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

async function loadSources() {
  const files = await walk(SRC);
  /** @type {Map<string,string>} 原始文本（含注释与字符串） */
  const raw = new Map();
  /** @type {Map<string,string>} 去注释/字符串后的骨架（默认用它，假阳性最少） */
  const bare = new Map();
  for (const f of files) {
    const t = await readFile(join(SRC, ...f.split('/')), 'utf-8');
    raw.set(f, t);
    bare.set(f, stripCommentsAndStrings(t));
  }
  return { raw, bare };
}

/** 纯声明行：import / 类型导出 / interface / type 别名 / declare —— 这些不是"被调用" */
const DECL_ONLY =
  /^\s*(import\b|export\s+type\b|export\s*\{[^}]*\}\s*from\b|export\s*\{|interface\b|type\s+\w+\s*=|declare\b)/;

/**
 * 检查单个 witness 有没有真实的调用点。
 *
 * 与第一版的三处差别（都是被假阳性/假阴性打过脸才改的）：
 *  1. 默认在"去注释去字符串"的骨架上匹配，注释和文案骗不过去；
 *  2. 定义处不再排除整份文件，只排除**定义那一行**——否则同文件内的调用会被漏掉
 *     （`consistencyCheck` 就因此在 review.ts:280 定义、397 调用，却被判成零调用）；
 *  3. `expectIn` 写了不存在的文件直接抛错，不静默跳过。
 */
function checkWitness(w, sources, rawSources) {
  const re = new RegExp(w.pattern);
  // 少数 witness 要匹配的正是字符串字面量（如 provider 名），才允许退回原文
  const map = w.inString ? rawSources : sources;
  if (w.expectIn?.length) {
    for (const f of w.expectIn) {
      if (!map.has(f)) throw new Error(`witness "${w.label}" 的 expectIn 写了不存在的文件: ${f}`);
    }
  }
  const symbol = w.symbol ?? (w.pattern.match(/[A-Za-z_$][\w$]*/) || [null])[0];
  const defLine = symbol
    ? new RegExp(
        `^\\s*(export\\s+)?(default\\s+)?(async\\s+)?(function|const|let|var|class|interface|type|enum)\\s+${symbol}\\b`,
      )
    : null;
  const targets = w.expectIn?.length ? w.expectIn : [...map.keys()];
  /** @type {string[]} */
  const hits = [];
  for (const f of targets) {
    const text = map.get(f);
    if (text === undefined) continue;
    if (!re.test(text)) continue;
    const singleLine = !re.source.includes('\\n');
    const ok =
      !singleLine ||
      text.split('\n').some((line) => {
        if (!new RegExp(w.pattern).test(line)) return false;
        if (DECL_ONLY.test(line)) return false;
        // 只排除"定义那一行"，同文件其它行的调用照常计入
        if (f === w.definedIn && defLine && defLine.test(line)) return false;
        return true;
      });
    if (ok) hits.push(f);
  }
  return hits;
}

const { raw: rawSources, bare: sources } = await loadSources();
const results = ITEMS.map((item) => {
  const witnessResults = item.witnesses.map((w) => ({ w, hits: checkWitness(w, sources, rawSources) }));
  // mode:'all' 用于"多路都必须接线"的能力（例如状态机要同时接 decay 和 snapshot）
  const wired =
    item.mode === 'all'
      ? witnessResults.every((r) => r.hits.length > 0)
      : witnessResults.some((r) => r.hits.length > 0);
  // 只有声明 done 的条目才要求接线成功
  const violation = item.status === 'done' && !wired;
  return { item, witnessResults, wired, violation };
});

const violations = results.filter((r) => r.violation);

const asJson = process.argv.includes('--json');
if (asJson) {
  console.log(
    JSON.stringify(
      results.map((r) => ({
        id: r.item.id,
        name: r.item.name,
        milestone: r.item.milestone,
        status: r.item.status,
        wired: r.wired,
        violation: r.violation,
        witnesses: r.witnessResults.map((x) => ({ label: x.w.label, hits: x.hits })),
      })),
      null,
      2,
    ),
  );
  process.exit(violations.length ? 1 : 0);
}

if (process.argv.includes('--write')) {
  const icon = { done: '✅ 已实现', partial: '🟡 半接', missing: '❌ 零实现' };
  const lines = [];
  lines.push('# 能力台账（capability ledger）');
  lines.push('');
  lines.push('> **本文件由 `node scripts/audit-capabilities.mjs --write` 生成，不要手工编辑。**');
  lines.push('> 唯一真相是脚本里的 `ITEMS` 数组：改功能就在同一个 commit 里改它。');
  lines.push('');
  lines.push('## 为什么要有这个台账');
  lines.push('');
  lines.push('这个项目两次栽在同一类缺陷上：机制写好了、测试全绿，但**没有任何调用点**。');
  lines.push('');
  lines.push('- `retentionPriority()` 实现了，零调用 → 遗忘机制从未生效；');
  lines.push('- `initiation` 字段、落盘、O17 降级复盘全都写了，三个 `addEvent` 调用点无一传入 → 责任归因永远靠启发式；');
  lines.push('- `bypassDecision()` / `renderUncertainty()` 只有单测 → 诚实基线运行时不存在。');
  lines.push('');
  lines.push('这类缺陷的共性是：**测试直接调函数，所以测试通过；真实链路绕开函数，所以线上为零。**');
  lines.push('读代码也看不出——定义和调用长得一样。');
  lines.push('');
  lines.push('因此台账不是文档，是可执行断言：`status=done` 的条目必须在定义文件之外找到调用点，');
  lines.push('否则 `npm run audit` 直接失败。**把状态写成 done 本身就是一个要拿代码兑现的承诺。**');
  lines.push('');
  lines.push('## 当前状态');
  lines.push('');
  lines.push('| 里程碑 | 功能 | 状态 | 接线检查 | 备注 |');
  lines.push('|---|---|---|---|---|');
  for (const r of results) {
    const wiring = r.item.status === 'done' ? (r.wired ? '✅ 有调用点' : '❌ 无调用点') : r.wired ? '有命中（未声明完成）' : '—';
    lines.push(`| ${r.item.milestone} | ${r.item.name} | ${icon[r.item.status]} | ${wiring} | ${r.item.note.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  const done = results.filter((r) => r.item.status === 'done').length;
  const partial = results.filter((r) => r.item.status === 'partial').length;
  const missing = results.filter((r) => r.item.status === 'missing').length;
  lines.push(`合计 ${results.length} 项：已实现 ${done} · 半接 ${partial} · 零实现 ${missing}。`);
  lines.push('');
  lines.push('## 纪律');
  lines.push('');
  lines.push('1. **新增功能**：先在 `ITEMS` 里加一条（`status: missing`），实现并接上线后才改成 `done`。');
  lines.push('2. **调整既有功能**：改了语义就更新同条目的 `note`；从"能用"变成"不能用"要立刻降级 status。');
  lines.push('3. **评审基线**：任何"要不要做/怎么做"的讨论，先跑一次 `npm run audit`，对着台账说，不对着记忆说。');
  lines.push('4. **不允许只加定义不加调用点**：如果暂时不接线，status 必须是 `partial`/`missing`，');
  lines.push('   并且 note 里写清楚"为什么先不接"。');
  await writeFile(LEDGER, lines.join('\n') + '\n', 'utf-8');
  console.log(`已生成 ${LEDGER}`);
  console.log(`合计 ${results.length} 项：已实现 ${done} · 半接 ${partial} · 零实现 ${missing}`);
}

// 无论是否 --write，都打印违规
if (violations.length) {
  console.error('\n❌ 台账违规：以下条目标注 done 但找不到调用点');
  for (const v of violations) {
    console.error(`  - [${v.item.id}] ${v.item.name}`);
    for (const w of v.witnessResults) {
      console.error(`      期望 ${w.w.expectIn?.length ? w.w.expectIn.join('/') : '任意其它 src 文件'} 命中 /${w.w.pattern}/，实际未命中`);
    }
  }
  console.error('\n处理方式：要么补上调用点，要么把 status 降为 partial。不要改 witness 去迁就代码。');
  process.exit(1);
}

if (!process.argv.includes('--write')) {
  const done = results.filter((r) => r.item.status === 'done').length;
  console.log(`台账检查通过：${results.length} 项，其中 ${done} 项声明已实现且都有调用点。`);
}
