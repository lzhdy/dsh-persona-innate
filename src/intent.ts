/**
 * P4 意图解析器（规则优先，零 LLM）
 *
 * 注入是每轮热路径，意图判定必须零 I/O、零 LLM。规则按 §1.2 判定顺序排列：
 * history_replay → persona → continue_task → fact_lookup → fuzzy。
 * 只读输入 cueText（当前轮用户消息）+ hasOpenThread（是否有未结 thread），
 * 输出 1–2 个意图（主意图在前，带命中线索词供观测调规则）。
 */

/** 意图枚举（§1.1） */
export type Intent =
  | 'continue_task'   // 继续当前任务 / 未结事项
  | 'fact_lookup'     // 当前偏好 / 属性 / 承诺 / 知识更新
  | 'history_replay'  // 历史回放（当时发生什么 / 谁说过什么 / 原话）
  | 'persona'         // 人格 / 风格 / 自我叙事
  | 'fuzzy';          // 模糊回忆 / 跨事件发现

/** 一次意图命中：意图 + 命中的线索词（观测用） */
export interface IntentHit {
  intent: Intent;
  /** 命中的线索词（观测用，便于调规则） */
  hits: string[];
}

/** 单条判定规则 */
export interface IntentRule {
  intent: Intent;
  words: readonly string[];
}

/**
 * 规则表（§1.2，顺序即优先级）。continue_task 特殊：除命中续接词外，
 * hasOpenThread === true 时也视为命中（默认续接），在 resolveIntent 里单独处理。
 */
export const INTENT_RULES: readonly IntentRule[] = [
  {
    intent: 'history_replay',
    words: [
      '那天', '上次', '之前', '当时', '那时候', '前几天', '昨天', '上周',
      '还记得吗', '曾经', '以前',
      '说过', '提过', '原话', '怎么说的', '当时怎么',
    ],
  },
  {
    intent: 'persona',
    words: [
      '你是什么样', '你觉得自己', '你的性格', '你是谁', '你偏好什么风格',
      '你说话方式', '你记性',
    ],
  },
  {
    intent: 'continue_task',
    words: ['继续', '接着', '上次说到', '那个任务', '进度', '接下来', '回到刚才'],
  },
  {
    intent: 'fact_lookup',
    words: [
      '你喜欢', '你的习惯', '你知道我', '我的生日', '我的名字', '住在哪',
      '记得我', '我常', '我一般',
    ],
  },
];

/**
 * 解析意图（纯函数，无 I/O）。
 *
 * @param cueText 当前轮用户消息（可为空）
 * @param hasOpenThread 是否有未结 thread（facts.loadOpenThreads() 非空）
 * @returns 1–2 个意图（主意图在前）。歧义回退：无任何词命中且有未结 thread →
 *          continue_task；无命中且无未结 → fuzzy。
 */
export function resolveIntent(cueText: string, hasOpenThread: boolean): IntentHit[] {
  const text = String(cueText ?? '').trim();
  const hits: IntentHit[] = [];

  for (const rule of INTENT_RULES) {
    if (rule.intent === 'continue_task') {
      // continue_task 规则：命中续接词 或 hasOpenThread（默认续接）
      const matched = rule.words.filter((w) => text.includes(w));
      if (matched.length > 0 || hasOpenThread) {
        hits.push({ intent: 'continue_task', hits: matched });
      }
      continue;
    }
    const matched = rule.words.filter((w) => text.includes(w));
    if (matched.length > 0) {
      hits.push({ intent: rule.intent, hits: matched });
    }
  }

  // 无任何命中 → 歧义回退（§1.2）
  if (hits.length === 0) {
    return hasOpenThread
      ? [{ intent: 'continue_task', hits: [] }]
      : [{ intent: 'fuzzy', hits: [] }];
  }

  // 去重（同意图只保留第一次命中），最多取前 2 个
  const seen = new Set<Intent>();
  const out: IntentHit[] = [];
  for (const h of hits) {
    if (seen.has(h.intent)) continue;
    seen.add(h.intent);
    out.push(h);
    if (out.length >= 2) break;
  }
  return out;
}
