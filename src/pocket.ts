/**
 * 口袋视图（pocket）—— 让 agent 在运行时"看自己口袋里有哪些工具"。
 *
 * 设计取向（这个项目最核心的一条，宁愿少功能也不要违背）：
 * **不加配置项、不建声明式清单、不写权限表。**
 * 所有信息都在调用那一刻从 dsh 的实时工具注册表算出来：
 * - 「当前有什么」= `ctx.tools.schemas(exec.agent)` 的投影；
 * - 「掉了什么」= 上一次真实看到的名字与本轮对比（ledger 只记名字+日期，不记权限）；
 * - 「什么不好使」= 进程内观测到的最近一次 tool/result 失败。
 * 于是插件卸载 / 工具注销后，东西自然消失，不需要任何清理逻辑；
 * 而"配置文件里写一份工具表"这种做法在这里是错的——它会与注册表分叉，
 * 分叉之后 agent 会以为自己有实际上没有的工具（或反之），比不知道更糟。
 *
 * 本模块是纯函数：不 import 任何 dsh 包，只复用 `./time.js` 的日期串口径，
 * 因此可以在 `node --test` 里直接跑，不必启动宿主。
 */
import { localDateString } from './time.js';

/** 模型面可见的工具投影（dsh-tools `ToolSchema` 的最小结构面） */
export interface PocketTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 见过即记：工具名 -> 最后一次见到的本地日期 `yyyy-mm-dd` */
export interface PocketLedger {
  seen: Record<string, string>;
}

/** 一次调用失败的留痕（进程内，不落盘：它记的是"工具健康"，可丢） */
export interface PocketFailure {
  name: string;
  at: number;
  reason: string;
}

/** 一句话说明的默认长度上限 */
const DEFAULT_SUMMARY_MAX = 48;
/** 缺席条目在 ledger 里保留的自然日数（超过就当"往事"，不再声称"掉了"） */
const DEFAULT_KEEP_DAYS = 45;
/** 仅用于把 `yyyy-mm-dd` 往前推 N 天；不用它算两个日期相差几天 */
const MS_PER_DAY = 86_400_000;
/** `yyyy-mm-dd` 的形状（只承认这个形状，比较才有意义） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 字典序比较（不用 localeCompare：换语言/换环境结果会变，测试就不确定了） */
function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 把 `yyyy-mm-dd` 按自然日平移 `days` 天（可为负）。
 *
 * 为什么用 UTC 系列 getter：这里做的是**日历日加减**，不是"两个时刻相差几天"。
 * 用本地日期会碰到夏令时（某天 23 小时/25 小时），UTC 下每天的毫秒数才是恒定的。
 * 非法日期原样返回：调用方据此不剪枝，而不是把整个 ledger 清空。
 */
function shiftDate(date: string, days: number): string {
  if (!DATE_RE.test(date)) return date;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * MS_PER_DAY);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * 取描述的第一条非空行，去掉结尾句号，过长截断。
 *
 * 工具描述是写给模型看的整段文字（常常三五行，含用法与反例），
 * 口袋视图只需要"它大致是干什么的"，所以压缩成一句话。
 *
 * @param description - 原始描述
 * @param max - 截断长度上限（不含省略号），默认 48
 * @returns 单行摘要；入参为空或全是空白时返回 `''`
 */
export function firstLine(description: string, max: number = DEFAULT_SUMMARY_MAX): string {
  if (!description || typeof description !== 'string') return '';
  let line = '';
  for (const raw of description.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed) {
      line = trimmed;
      break;
    }
  }
  if (!line) return '';
  // 去掉结尾句号（中英两种）；连续多个也一并去掉
  line = line.replace(/[。.]+$/, '').trimEnd();
  if (!line) return '';
  if (line.length > max) {
    // 先截断再 trimEnd：避免"空格 + …"这种尾巴
    line = `${line.slice(0, max).trimEnd()}…`;
  }
  return line;
}

/**
 * 取 JSON Schema 里的参数名，按对象自身键序（= 声明顺序，稳定可读）。
 *
 * @param parameters - 参数 JSON Schema 对象
 * @returns 参数名数组；没有 `properties`、或它不是对象时返回 `[]`
 */
export function paramNames(parameters: Record<string, unknown>): string[] {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return [];
  const props = (parameters as { properties?: unknown }).properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  return Object.keys(props as Record<string, unknown>);
}

/**
 * 按名字前缀分组（`persona_recall` → `persona`）。
 *
 * 阈值不是审美问题：真实注册表里有几十个工具，其中大量是单件前缀
 * （`bash`、`read_file`、`web_search`…）。如果每个前缀都成组，
 * 输出会退化成"每组一个工具"，比不分组更难扫。
 * 所以只有「前缀长度 >= 3 且该前缀下 >= 2 个工具」才单独成组，其余归 `other`。
 *
 * 排序完全确定：成员数降序 → 组名升序；组内名字字典序。
 *
 * @param tools - 工具列表（同名只算一次）
 * @returns 分组结果
 */
export function groupTools(tools: PocketTool[]): { group: string; names: string[] }[] {
  const byPrefix = new Map<string, Set<string>>();
  for (const tool of tools ?? []) {
    if (!tool || typeof tool.name !== 'string') continue;
    const name = tool.name;
    if (!name) continue;
    const prefix = name.split('_')[0] ?? '';
    let bucket = byPrefix.get(prefix);
    if (!bucket) {
      bucket = new Set<string>();
      byPrefix.set(prefix, bucket);
    }
    bucket.add(name); // Set 天然去重，且保留首次出现顺序
  }

  const groups = new Map<string, string[]>();
  const rest: string[] = [];
  for (const [prefix, names] of byPrefix) {
    const list = [...names];
    if (prefix.length >= 3 && list.length >= 2) {
      groups.set(prefix, list);
    } else {
      rest.push(...list);
    }
  }
  // 散件统一进 other；若恰好已有一个叫 other 的真前缀组，就并进去（不留两个 other）
  if (rest.length) {
    const prev = groups.get('other') ?? [];
    groups.set('other', [...new Set([...prev, ...rest])]);
  }

  return [...groups.entries()]
    .map(([group, names]) => ({ group, names: [...names].sort(cmpStr) }))
    .sort((a, b) => (b.names.length - a.names.length) || cmpStr(a.group, b.group));
}

/**
 * 更新 ledger：本轮见到的写今天，**没见到的必须保留**。
 *
 * 保留缺席条目是整个机制的前提：只有留着"上次见过它"，
 * 下一轮才有东西可比，才可能说出"它掉了"。
 * 保留期（默认 45 天）到了才剪，避免半年前的工具一直被报"掉了"。
 *
 * @param ledger - 上一版 ledger
 * @param presentNames - 本轮真实看到的工具名
 * @param today - 今天的本地日期串 `yyyy-mm-dd`
 * @param keepDays - 保留天数（自然日）
 * @returns 新版 ledger（不改入参）
 */
export function updateLedger(
  ledger: PocketLedger,
  presentNames: string[],
  today: string,
  keepDays: number = DEFAULT_KEEP_DAYS,
): PocketLedger {
  const seen: Record<string, string> = {};
  const prev = ledger?.seen && typeof ledger.seen === 'object' ? ledger.seen : {};
  for (const [name, lastSeen] of Object.entries(prev)) {
    if (!name) continue;
    // 形状不对的条目直接丢弃：它既不能比较也不能展示，留着只会污染输出
    if (typeof lastSeen !== 'string' || !DATE_RE.test(lastSeen)) continue;
    seen[name] = lastSeen;
  }
  for (const name of presentNames ?? []) {
    if (typeof name !== 'string' || !name) continue;
    seen[name] = today;
  }
  const cutoff = shiftDate(today, -keepDays);
  for (const [name, lastSeen] of Object.entries(seen)) {
    if (lastSeen < cutoff) delete seen[name];
  }
  return { seen };
}

/**
 * 算"上次见过、现在不在"的条目。
 *
 * @param ledger - 上一版 ledger（用**旧版**：新版里 present 已被刷新成今天）
 * @param presentNames - 本轮真实看到的工具名
 * @param today - 今天的本地日期串
 * @param keepDays - 保留天数；超期条目不再报"掉了"
 * @returns 按 `lastSeen` 倒序（最近掉的在前），同日按名字升序保证确定性
 */
export function missingTools(
  ledger: PocketLedger,
  presentNames: string[],
  today: string,
  keepDays: number = DEFAULT_KEEP_DAYS,
): { name: string; lastSeen: string }[] {
  const present = new Set((presentNames ?? []).filter((n) => typeof n === 'string' && n));
  const cutoff = shiftDate(today, -keepDays);
  const out: { name: string; lastSeen: string }[] = [];
  const seen = ledger?.seen && typeof ledger.seen === 'object' ? ledger.seen : {};
  for (const [name, lastSeen] of Object.entries(seen)) {
    if (!name || present.has(name)) continue;
    if (typeof lastSeen !== 'string' || !DATE_RE.test(lastSeen)) continue;
    if (lastSeen < cutoff) continue;
    out.push({ name, lastSeen });
  }
  out.sort((a, b) => (a.lastSeen === b.lastSeen ? cmpStr(a.name, b.name) : a.lastSeen < b.lastSeen ? 1 : -1));
  return out;
}

/** 失败时刻格式化：本地 `yyyy-mm-dd HH:mm`（日期部分复用 time.ts 的唯一口径，不自己拼） */
function formatTimestamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${localDateString(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 渲染口袋视图（中文纯文本，块之间空一行，空块整块省略）。
 *
 * 三块的分工是刻意的：
 * - 【口袋】当前能用什么（正向能力，先给结论）；
 * - 【掉了】上次见过、现在不在（"我是不是记错了？"的答案）；
 * - 【不好使】还在、但最近失败过（"能不能用"和"用起来顺不顺"是两件事）。
 *
 * @param input.tools - 当前可见工具
 * @param input.missing - 缺席工具
 * @param input.failures - 最近失败
 * @param input.detail - 逐工具展示（带参数与一句话说明）
 * @param input.group - 只看某个名字前缀（对三块同时生效）
 * @returns 渲染文本
 */
export function renderPocket(input: {
  tools: PocketTool[];
  missing: { name: string; lastSeen: string }[];
  failures: PocketFailure[];
  detail?: boolean;
  group?: string;
}): string {
  const detail = input?.detail === true;
  const prefix = typeof input?.group === 'string' ? input.group.trim() : '';
  const hit = (name: string): boolean => !prefix || name.startsWith(prefix);

  const tools = (input?.tools ?? []).filter((t) => !!t && typeof t.name === 'string' && !!t.name && hit(t.name));
  const missing = (input?.missing ?? []).filter((m) => !!m && typeof m.name === 'string' && !!m.name && hit(m.name));
  const failures = (input?.failures ?? []).filter((f) => !!f && typeof f.name === 'string' && !!f.name && hit(f.name));

  const blocks: string[] = [];

  const head = `【口袋】当前 ${tools.length} 件`;
  const grouped = groupTools(tools);
  const pocketLines: string[] = [];
  if (detail) {
    // 详情模式下仍按分组顺序铺开：相关的工具挨在一起，比纯字典序更好扫
    const byName = new Map(tools.map((t) => [t.name, t] as const));
    for (const g of grouped) {
      for (const name of g.names) {
        const tool = byName.get(name);
        if (!tool) continue;
        const params = paramNames(tool.parameters).join(',');
        const summary = firstLine(typeof tool.description === 'string' ? tool.description : '');
        pocketLines.push(summary ? `- ${name}(${params}) ${summary}` : `- ${name}(${params})`);
      }
    }
  } else {
    for (const g of grouped) {
      pocketLines.push(`${g.group} (${g.names.length}): ${g.names.join(', ')}`);
    }
  }
  blocks.push([head, ...pocketLines].join('\n'));

  if (missing.length) {
    blocks.push(
      [
        '【掉了】上次见过、现在不在（可能是插件没加载或被限制）',
        ...missing.map((m) => `- ${m.name} 上次见到 ${m.lastSeen}`),
      ].join('\n'),
    );
  }

  if (failures.length) {
    blocks.push(
      [
        '【不好使】工具还在，但最近调用失败过',
        ...failures.map((f) => {
          const reason = typeof f.reason === 'string' && f.reason.trim() ? f.reason.trim() : '调用失败';
          return `- ${f.name} ${formatTimestamp(f.at)} ${reason}`;
        }),
      ].join('\n'),
    );
  }

  return blocks.join('\n\n');
}
