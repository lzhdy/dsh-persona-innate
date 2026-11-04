/**
 * 指令性内容剥离（O37）：**两层口径**
 *
 * 记忆条目只存事实和事件，不存行为脚本。但"落盘"和"进 prompt"不是同一件事，
 * 两个通道的伤害面不同；用一个口径管两件事，必然在其中一个方向上出错：
 *
 * | 通道 | 风险 | 口径 |
 * |---|---|---|
 * | events 写入（addEvent） | 几乎没有：只是落盘，原始表达本身不进 prompt | 宽 `stripCheck` |
 * | 注入二次校验（buildInjection） | 直接改变模型行为 | 严 `stripMemoryFact` |
 * | thread/attribute 派生（memory-facts） | 直接改变行为（open 槽会注入、属性将来会注入） | 严 `stripMemoryFact` |
 *
 * 一刀切用严口径管写入的实际后果：用户说「你要多关心我」，这条既不进记忆也不进复盘，
 * 系统彻底看不见"他想要什么"——这是功能性损失，与"记忆是基石"的定位冲突。
 * 拆开之后还多一个好处：原话先存下来，由复盘把它翻译成描述性事实
 * （「你要多关心我」→ thread「用户提过希望被更多关心」），那才是记忆该有的形态。
 *
 * 两条口径的边界（v0.7）：
 * - 宽口径只认明显的角色卡/系统指令注入（"告诉用户…"、"当用户提到 X 时你应该…"）；
 * - 严口径额外认"对 AI 的行为要求"（"你要多关心我"、"记得提醒我吃药"），
 *   但仍不拦"用户怎么关心 AI"——「你早点睡吧」是关心，「你要多关心我」是要求。
 */
import type { StripResult } from './types.js';

type Rule = { pattern: RegExp; label: string };

/**
 * 宽口径规则：角色卡 / 系统指令注入形态。
 * 命中即认为整句话是写给模型的脚本，而不是对世界的陈述。
 */
const DIRECTIVE_PATTERNS: Rule[] = [
  { pattern: /告诉用户[^。；;]*/g, label: 'tell-user' },
  { pattern: /告知用户[^。；;]*/g, label: 'tell-user' },
  { pattern: /提醒用户[^。；;]*/g, label: 'tell-user' },
  { pattern: /当用户(提到|问起|说起|提到话题)[^，。；;]*?(你)?(应该|需要|必须|要|请|应|建议)[^。；;]*/g, label: 'when-user-then-act' },
  { pattern: /如果用户[^，。；;]*?(就|请|务必|要|应|建议)[^。；;]*/g, label: 'if-user-then-act' },
  { pattern: /在用户[^，。；;]*?时(要|应该|请|必须|应|建议)[^。；;]*/g, label: 'when-user-act' },
  { pattern: /(你应该|你需要|你必须|一定要|请务必|切记|务必记住)[^。；;]{0,40}(说|告诉|提醒|推荐|建议|避免|不要|阻止)/g, label: 'you-must' },
  { pattern: /(不要|禁止|切勿)(说|告诉|提到|泄露|透露|承认|拒绝)/g, label: 'forbid-say' },
  { pattern: /当[^。；;]*?提到[^。；;]*?时[^。；;]*?说/g, label: 'when-mention-say' },
  { pattern: /(回答|回复)[^。；;]{0,20}时[^。；;]{0,30}(要|应该|请)[^。；;]*/g, label: 'reply-rule' },
];

/**
 * 严口径追加规则：针对 AI 的行为要求（裸祈使句）。**只在落盘之后的通道用**。
 *
 * 原规则表只认"告诉用户…/你应该…说…"这类带转述动词的形态，
 * 于是「你要多关心我」「请你多陪陪我」「记得提醒我吃药」整句放行——
 * 它们不是对世界的描述，而是要求 AI 怎么做，进 prompt 就会变成行为脚本。
 *
 * 判据刻意收窄成"第二人称 + 针对『我』的关怀诉求"，而不是笼统拦 `你应该` / `你要`：
 * 「你早点睡吧」「你也要照顾好自己」是用户在关心 AI，拦掉它们等于把关心当成指令，
 * 那会让记忆系统对用户的善意失明（比漏拦更糟）。
 *
 * label 统一带 `fact:` 前缀：审计时能直接看出是"宽口径"还是"严口径追加"拦下的。
 */
const MEMORY_FACT_PATTERNS: Rule[] = [
  {
    // 情态动词是不可省的判据：「你陪我去医院吧」「我不需要你安慰我」是事件/陈述，
    // 「你要多关心我」「你应该多理解我」才是要求 AI 怎么做。少了情态词一律按事实放行。
    // 动词表带可选的叠词形式（关心关心/陪陪/哄哄），"请多关心关心我"是真实口语形态。
    pattern:
      /(你|您)[^。；;，,]{0,4}?(要|应该|需要|必须|得|也要|得多|可得)[^。；;，,]{0,6}?(关心(?:关心)?|照顾|陪(?:陪)?|陪伴|在乎(?:在乎)?|理解|包容|哄(?:哄)?|安慰|顺着|迁就|体谅|想着)我/g,
    label: 'fact:demand-care-for-me',
  },
  {
    // "记得提醒我吃药"：转述动词 + 我 —— 要求 AI 充当提醒器
    pattern: /(记得|记住|别忘了|不要忘记|别忘记)[^。；;，,]{0,6}?(提醒|叫|喊|告诉|督促|监督)我/g,
    label: 'fact:remember-to-nag-me',
  },
  {
    /*
     * 无主语的裸诉求（"多陪陪我"）。两个约束都是为了不误伤事实陈述：
     * - 必须以句首/分句起始/呼语（你|请|以后…）引导：这样「他每天都会关心我」不会被拦
     *   （前面是"会"，不是呼语），「你不用多关心我」也不会（前面是"用"）。
     * - 必须以句末/标点收尾：「我想多陪陪我妈妈」不会被拦。
     */
    pattern:
      /(^|[，,。；;：:！!？?\s]|你|请|以后|今后|平时|经常|能)((?:多|多多)?陪陪我|(?:多|多多)?关心(?:关心)?我|多在乎我|抱抱我|多哄哄我|哄哄我|顺着我|迁就我)(一点|一些|点儿)?(吗|呢|吧|啊|呀)?(?=[\s，,。；;！!？?…]|$)/g,
    label: 'fact:bare-care-demand',
  },
];

/** 在给定规则表里找第一条命中；lastIndex 复位是因为这些正则带 g 且跨调用复用 */
function matchIn(patterns: readonly Rule[], text: string): StripResult {
  for (const { pattern, label } of patterns) {
    pattern.lastIndex = 0;
    const m = pattern.exec(text);
    if (m) {
      return {
        ok: false,
        matchedPattern: label,
        directive: m[0].slice(0, 80),
      };
    }
  }
  return { ok: true };
}

/**
 * 宽口径：只拦角色卡/系统指令注入。**写入 events 用它**（addEvent）。
 * 这里放行的句子仍可能被注入前的二次校验拦下，那是刻意的分工：
 * 落盘保留原话，进 prompt 才需要干净。
 */
export function stripCheck(text: string): StripResult {
  return matchIn(DIRECTIVE_PATTERNS, text);
}

/**
 * 严口径：宽口径 + "对 AI 的行为要求"。
 * **注入二次校验（buildInjection）与 thread/attribute 派生（memory-facts）用它。**
 */
export function stripMemoryFact(text: string): StripResult {
  const wide = matchIn(DIRECTIVE_PATTERNS, text);
  if (!wide.ok) return wide;
  return matchIn(MEMORY_FACT_PATTERNS, text);
}

/** 供审计的剥离计数 */
export interface StripStats {
  checked: number;
  rejected: number;
  patterns: Record<string, number>;
}

export function createStripStats(): StripStats {
  return { checked: 0, rejected: 0, patterns: {} };
}

export function recordStrip(stats: StripStats, result: StripResult): void {
  stats.checked += 1;
  if (!result.ok) {
    stats.rejected += 1;
    const p = result.matchedPattern ?? 'unknown';
    stats.patterns[p] = (stats.patterns[p] ?? 0) + 1;
  }
}
