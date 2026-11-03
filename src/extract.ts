/**
 * 自动记忆提取（M2：session/event 驱动的确定性规则）
 * - 从用户消息中识别"值得记住的经历/情绪分享"，零 LLM 成本、可复算
 * - 命中返回 { topic, summary, importance, emotionTags }，未命中返回 null
 * - 只提取事实与经历，不提取指令（指令性内容由 memory.addEvent 统一剥离）
 * - 保守原则：宁可漏、不可错——无时间/第一人称/情绪信号的抽象讨论不提取
 */

export interface ExtractCandidate {
  topic: string;
  summary: string;
  importance: number;
  emotionTags: string[];
}

/** 经历/事件信号（命中即视为"共同经历"候选） */
const EVENT_WORDS = [
  '项目', '上线', '发布', '开会', '会议', '出差', '旅行', '旅游', '搬家',
  '考试', '面试', '体检', '住院', '手术', '分手', '结婚', '离职', '入职',
  '涨薪', '加班', '熬夜', '吵架', '表白', '获奖', '比赛', '打球', '健身',
  '跑步', '学车', '驾照', '房子', '租房', '买车', '基金', '股票', '汇报',
  '评审', '验收', '客户', '演示', '方案', '代码', 'bug', 'Bug', '故障',
  '请假', '值班', '培训', '面试', '跳槽', '创业', '辞职', 'offer', 'Offer',
] as const;

/** 情绪信号（正向） */
const POSITIVE_EMOTIONS = [
  '开心', '高兴', '兴奋', '激动', '满意', '欣慰', '喜欢', '爽', '棒',
  '成功', '突破', '搞定', '完成', '期待', '希望', '骄傲', '幸福', '轻松',
] as const;

/** 情绪信号（负向） */
const NEGATIVE_EMOTIONS = [
  '难过', '伤心', '焦虑', '烦躁', '烦', '郁闷', '崩溃', '压力', '累',
  '疲惫', '失望', '生气', '愤怒', '委屈', '害怕', '担心', '紧张', '慌',
  '沮丧', '低落', '孤独', '迷茫', 'emo', 'emo了', 'emo了', '心累',
] as const;

/** 星期数字（周一~周日 共用） */
const WEEKDAY_NUM = '一二三四五六日';

/** 时间信号（把消息锚定到"过去/当下的经历"）；含周一~周日、星期一~星期日 */
const TIME_WORDS = [
  '今天', '昨天', '前天', '昨晚', '上周', '这周', '本周', '最近', '刚刚',
  '下午', '上午', '晚上', '周末', '下周', '明天', '这阵子', '这段时间',
  '周一', '周二', '周三', '周四', '周五', '周六', '周日',
  '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日',
] as const;

/**
 * 周/星期时间单元（含「周末」），第一阶段整体匹配，保证「周末」「周日」「星期一」
 * 不被拆成单字，也让「周日」与「周末」天然区分（末 ≠ 日）。
 */
const ZHOU_TIME_RE = new RegExp(`星期[${WEEKDAY_NUM}]|周[${WEEKDAY_NUM}末]`, 'g');

/** 由 ZHOU_TIME_RE 统一处理的词，普通词阶段不再重复匹配 */
const ZHOU_HANDLED = new Set<string>([
  '周末',
  ...TIME_WORDS.filter((w) => w.startsWith('周') && w !== '周末'),
  ...TIME_WORDS.filter((w) => w.startsWith('星期')),
]);

/** 普通时间词（周/星期/周末之外），按长度降序（最长优先，不依赖手工数组顺序） */
const OTHER_TIME_SORTED = [...new Set(TIME_WORDS)]
  .filter((w) => !ZHOU_HANDLED.has(w))
  .sort((a, b) => b.length - a.length);

/**
 * 提取文本中出现的全部时间信号词。
 * 规则：
 * 1. 先用 ZHOU_TIME_RE 整体识别星期/周末词并记录字符区间；
 * 2. 再用最长优先匹配普通时间词，跳过与已命中区间重叠的位置（词边界锚定），
 *    因此「下周一」命中「周一」而非「下周」，「周末」整体命中、不被拆。
 * 返回命中词数组（按出现位置），无命中返回空数组。
 */
export function matchTimeWords(text: string): string[] {
  const s = String(text ?? '');
  if (!s) return [];
  const hits: string[] = [];
  const spans: Array<[number, number]> = [];
  const overlaps = (i: number, len: number) =>
    spans.some(([a, b]) => i < b && i + len > a);

  // 阶段 1：星期/周末整体匹配
  for (const m of s.matchAll(new RegExp(ZHOU_TIME_RE.source, 'g'))) {
    const i = m.index ?? 0;
    if (!overlaps(i, m[0].length)) {
      hits.push(m[0]);
      spans.push([i, i + m[0].length]);
    }
  }

  // 阶段 2：普通时间词，最长优先 + 区间边界
  for (const w of OTHER_TIME_SORTED) {
    let idx = s.indexOf(w);
    while (idx !== -1) {
      if (!overlaps(idx, w.length)) {
        hits.push(w);
        spans.push([idx, idx + w.length]);
      }
      idx = s.indexOf(w, idx + 1);
    }
  }
  // 按出现位置排序后返回
  return hits
    .map((word, k) => ({ word, pos: spans[k][0] }))
    .sort((x, y) => x.pos - y.pos)
    .map((x) => x.word);
}

/** 文本是否含时间信号（词边界锚定，替代朴素 includes） */
function hasTimeWord(text: string): boolean {
  return matchTimeWords(text).length > 0;
}

/** 第一人称（经历通常以"我"为主语） */
const SELF_REF = ['我', '我们', '咱'];

/** 经历主题归类：命中事件词 → 映射 topic */
const TOPIC_MAP: Array<[RegExp, string]> = [
  [/项目|上线|发布|汇报|评审|验收|客户|演示|方案|代码|bug|Bug|故障|加班|开会|会议|出差|培训|请假|值班/i, '工作-事件'],
  [/面试|offer|Offer|跳槽|离职|入职|辞职|创业|涨薪/, '职业-变动'],
  [/考试|比赛|获奖|学车|驾照/, '学习-经历'],
  [/体检|住院|手术|生病/, '健康-事件'],
  [/旅行|旅游|搬家|租房|房子|买车|周末/, '生活-事件'],
  [/分手|结婚|表白|吵架/, '关系-事件'],
  [/基金|股票/, '理财-经历'],
];

/**
 * 从一条用户消息文本中提取记忆候选。
 * 返回 null 表示不值得记录（命令、过短、纯抽象讨论）。
 */
export function extractCandidate(text: string): ExtractCandidate | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // 跳过命令（/persona ... 等）与纯指令形态
  if (t.startsWith('/')) return null;
  if (t.length < 8) return null;

  const hasSelf = SELF_REF.some((w) => t.includes(w));
  const hasTime = hasTimeWord(t);
  const hitEvent = EVENT_WORDS.filter((w) => t.includes(w));
  const posTags = POSITIVE_EMOTIONS.filter((w) => t.includes(w));
  const negTags = NEGATIVE_EMOTIONS.filter((w) => t.includes(w));
  const emotionTags = [...posTags, ...negTags];

  // 信号判定：
  // 高：事件词 +（时间 或 第一人称）
  // 中：情绪词 + 第一人称（情绪分享也是重要经历）
  // 低：时间 + 第一人称（日常经历）
  let level: 0 | 1 | 2 | 3 = 0;
  if (hitEvent.length > 0 && (hasTime || hasSelf)) level = 3;
  else if (emotionTags.length > 0 && hasSelf) level = 2;
  else if (hasTime && hasSelf) level = 1;
  if (level === 0) return null;

  const importance = level === 3 ? 0.8 : level === 2 ? 0.7 : 0.6;

  // 主题归类：优先事件词映射，其次情绪映射，兜底"用户-分享"
  let topic = '用户-分享';
  for (const [re, label] of TOPIC_MAP) {
    if (re.test(t)) {
      topic = label;
      break;
    }
  }
  if (topic === '用户-分享' && emotionTags.length > 0) {
    topic = negTags.length > 0 ? '情感-分享' : '心情-分享';
  }

  // 摘要：保留原文事实（截断防过长）；剥离检查由 addEvent 统一执行
  const summary = t.length > 120 ? `${t.slice(0, 117)}…` : t;
  return { topic, summary, importance, emotionTags };
}

/** 去重键：topic + summary（用于短窗口去重） */
export function dedupKey(c: ExtractCandidate): string {
  return `${c.topic}\u0000${c.summary}`;
}

/**
 * 判定一条 session/event 是否是可提取的真实用户消息（M2 真机修复）：
 * - 事件类型必须是 user/message
 * - 来源必须为真实用户（source.kind === 'user'）；DSH 会把运行时上下文等系统注入
 *   拼成 user 角色消息广播，来源非 'user'，必须过滤
 * - 内容级双保险：跳过 DSH 运行时上下文注入（来源字段缺失时兜底）
 * - 返回聚合后的纯文本；不可提取返回 { ok: false }
 */
export function isExtractableUserMessage(ev: unknown): { ok: true; text: string } | { ok: false } {
  const e = ev as {
    type?: string;
    data?: {
      role?: string;
      content?: readonly { type?: string; text?: string }[];
      source?: { kind?: string };
    };
  };
  if (e?.type !== 'user/message') return { ok: false };
  if (e.data?.source && e.data.source.kind !== 'user') return { ok: false };
  const blocks = e.data?.content ?? [];
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .trim();
  if (!text) return { ok: false };
  if (/^(current runtime context|this snapshot supersedes)/i.test(text)) return { ok: false };
  return { ok: true, text };
}

/* ════════════ M3：AI 自身表达提取（assistant 通道，记忆架构口径修正） ════════════
 * 设计文档 events 情景层 = "双方表达摘要"：不止用户经历，AI 自己的立场/情感反应/
 * 承诺/边界表达也应沉淀为记忆（provenance: self_direct），复盘"观察自己的行为与表达"
 * 与 self_model 自身证据才成立。
 * 保守原则（用户拍板）：
 * - 只收明确的立场/情感反应/承诺/边界，宁缺毋滥
 * - 单次表达只进 events 作情景记忆；只有跨情境反复模式（≥3 次）才允许进入强化回路
 * - 诱导检测：前 N 轮用户预设立场型提问 + 本消息纯附和（无理由结构）→ 标记 induced
 *   （疑似被诱导：检索降权、不进强化；语义=待复核，非已确认）
 * M3-2 修正：
 * - 同意措辞拆两类：纯附和（AGREE_PURE，留在 induced 路径）vs 认错型（SELF_CORRECTION，
 *   走 self_correction 独立路径，不触发诱导、importance 不降权、由复盘延迟验证决定固化）
 * - 用户纠正句式（USER_CORRECTION）在诱导匹配前排除：纠正型用户消息不构成诱导第一条件，
 *   避免"用户纠正→AI 认错"被当作污染拦下（设计文档明确鼓励从负面反馈学习）
 * - 理由结构（REASON_CONNECTORS）：诱导窗口命中但回复带独立论证 → 放行不标 induced
 */

/** M3 自身表达候选 */
export interface SelfExpressionCandidate {
  provenance: 'self_direct' | 'induced' | 'self_correction';
  strength: 'weak' | 'medium' | 'strong';
  /** 立场模式 key（跨事件计数用，如 '立场-纪念日'、'边界-隐私'、'修正-*'） */
  pattern: string;
  summary: string;
  importance: number;
  emotionTags: string[];
}

/** 立场信号（strong：明确表态） */
const SELF_STANCE =
  /(我觉得|我认为|我不太在意|我坚持|我相信|我更愿意|我还是|我始终|在我看来|我的原则|我始终觉得|我比较倾向于)/;
/** 边界信号（strong：自我边界表达） */
const SELF_BOUNDARY = /(我不喜欢|我不需要|我不愿意|我不想|请不要|请别|别这样|我不接受|我介意|我不希望|我不能接受|我不太愿意)/;
/** 承诺信号（strong：承诺/约定） */
const SELF_COMMIT = /(我会记得|我一定|下次我|以后我|我答应|我保证|我会注意|我会改|我会尽量)/;
/** 情感反应信号（medium：对用户/事件的情绪反应） */
const SELF_FEELING =
  /(我为你|我替你|我高兴|我欣慰|我担心|我难过|我心疼|我骄傲|我生气|我失望|我担心你|我有点|我挺|我真心|我替你高兴)/;

/**
 * 纯附和措辞（M3-2 拆分后）：肯定用户带来的新立场——留在 induced 检测路径。
 * 单独出现只给 weak。
 */
const AGREE_PURE = /(我也觉得|我也认为|有道理|没错|确实是|确实|是这样|^(对|对，))/;

/**
 * 认错型同意（M3-2）：承认自己之前的判断有误——不触发诱导检测，走 self_correction
 * 独立路径（学习信号，importance 不降权；固化与否由复盘延迟验证决定）。
 */
const SELF_CORRECTION =
  /(我之前说错|我说错了|我考虑不周|我搞错|你说得对|你指出的对|刚才那个判断|我理解错|我记错|我判断错|是我错|我确实搞混|我之前判断|我的问题|我忽略了|我有点草率)/;

/** 理由结构信号（M3-2）：因果/论证连接词。诱导窗口命中但回复带独立论证 → 放行不标 induced */
const REASON_CONNECTORS = /(因为|由于|考虑到|理由是|忽略了|没考虑到|主要是|其实)/;

/**
 * 用户纠正句式（M3-2）："你（刚才/之前）说错/搞错/不对/判断有误"——
 * 特征是陈述 + 指出 AI 已有判断的错误，与"诱导型"（反问 + 寻求附和新立场）本质不同。
 * 命中则不构成诱导第一条件，让"用户纠正→AI 认错"走正常提取。
 */
const USER_CORRECTION =
  /你(?:刚才|之前|刚刚|前面)?(?:说错|搞错|弄错|判断有误|判断错了|理解错|记错|混淆|不对|有问题|不准确)/;

/** 用户预设立场型诱导提问（M3-2 收紧：排除开放征询"你觉得呢"，无预设答案的征询不算诱导） */
export const INDUCE_PROBES: readonly string[] = [
  '你是不是', '你不觉得', '难道', '对吧', '应该吧', '为什么不', '难道你不',
  '难道不是', '你该不会', '你不会是', '是不是觉得',
];

/** 诱导检测窗口：按"用户-助手往返轮次"计（每轮恰 1 条用户消息，slice(-N) 即最近 N 轮） */
export const INDUCE_WINDOW = 3;

/**
 * 会话级诱导结构判定（M3-2 串联放大修复）：不依赖单句措辞，看会话结构——
 * 近窗口内问句比例 + 连续施压轮数。高密度 → 该会话产出的 self_direct 表达标记
 * inductionRisk='unchecked'（不参与 3 次固化门槛合并计数，须 ≥5 且跨会话）。
 * 对"换措辞、多轮铺垫、AI 主动复述"类绕过更鲁棒。阈值待校准。
 */
export function sessionInduceRisk(recentUserMessages: readonly string[]): 'low' | 'unchecked' {
  const win = recentUserMessages.slice(-8);
  if (win.length === 0) return 'low';
  const induceHit = (u: string) =>
    INDUCE_PROBES.some((p) => u.includes(p)) || /[？?]$/.test(u) || u.includes('吗') || /(会不会|要不要|你考虑|你觉得|是不是)/.test(u);
  if (win.length === 1) return induceHit(win[0]) ? 'unchecked' : 'low';
  const hitCount = win.filter((u) => induceHit(u)).length;
  const questionRatio = hitCount / win.length;
  let streak = 0;
  let maxStreak = 0;
  for (const u of win) {
    if (induceHit(u)) {
      streak += 1;
      maxStreak = Math.max(maxStreak, streak);
    } else {
      streak = 0;
    }
  }
  // TODO(calibrate)：阈值初始值，宁可在真机上先偏保守（多标 unchecked 不误伤正常表达）
  return questionRatio >= 0.5 || maxStreak >= 2 ? 'unchecked' : 'low';
}

/** 从一条 assistant 消息文本中提取"AI 自身表达"候选（M3 / M3-2） */
export function extractSelfExpression(
  text: string,
  recentUserMessages: readonly string[] = [],
): SelfExpressionCandidate | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (t.startsWith('/')) return null;
  if (t.length < 4) return null;
  // 内容级双保险：跳过系统注入（assistant 通道同样适用）
  if (/^(current runtime context|this snapshot supersedes)/i.test(t)) return null;

  const stance = SELF_STANCE.test(t);
  const boundary = SELF_BOUNDARY.test(t);
  const commit = SELF_COMMIT.test(t);
  const feeling = SELF_FEELING.test(t);
  const agreePure = AGREE_PURE.test(t);
  const correction = SELF_CORRECTION.test(t);
  if (!stance && !boundary && !commit && !feeling && !agreePure && !correction) return null;

  // 强度：立场/边界/承诺 → strong；情感反应 → medium；纯同意/认错 → weak（认错 strong 由模式计数托底）
  const strength = stance || boundary || commit ? 'strong' : feeling ? 'medium' : 'weak';

  // 诱导判定（M3-2）：
  // 1) 认错型同意 → self_correction 独立路径（不触发诱导，importance 不降权）
  // 2) 诱导窗口命中 + 纯附和 + 无理由结构 + 非用户纠正句式 → induced（疑似被诱导，检索降权）
  // 3) 诱导窗口命中但带独立论证（理由结构）→ 放行（自主判断）
  // 4) 用户纠正句式 → 不构成诱导第一条件（"纠正→认错"不该被拦）
  const window = recentUserMessages.slice(-INDUCE_WINDOW);
  const hasInduceProbe = window.some((u) => INDUCE_PROBES.some((p) => u.includes(p)));
  const reason = REASON_CONNECTORS.test(t);
  // M3-2 修正（import-chat 验收发现）：纠正排除以"最后一条用户消息"（本次回合触发）为准，
  // 不能用窗口内任意一条纠正消息否决诱导——否则"纠正→认错"之后再出现温和引导，
  // 会被历史纠正上下文污染而漏标 induced（纠正与诱导同窗口混用场景）。
  // 最后一条本身是纠正句式（即使同时含诱导词）→ 纠正优先，不构成诱导。
  const lastUser = window[window.length - 1] ?? '';
  const lastIsInduce = lastUser.length > 0 && INDUCE_PROBES.some((p) => lastUser.includes(p));
  const lastIsCorrection = lastUser.length > 0 && USER_CORRECTION.test(lastUser);
  const induced =
    agreePure && !reason && !lastIsCorrection && (lastIsInduce || hasInduceProbe);

  let provenance: SelfExpressionCandidate['provenance'] = correction
    ? 'self_correction'
    : induced
      ? 'induced'
      : 'self_direct';

  // 立场模式 key：类别-主题（主题取信号词后至多 6 个字符）
  const themeOf = (re: RegExp): string => {
    const m = re.exec(t);
    if (!m || m.index === undefined) return '未明';
    const after = t.slice(m.index + m[0].length).trim();
    const theme = after.match(/[\u4e00-\u9fa5A-Za-z0-9]{1,6}/)?.[0] ?? '未明';
    return theme;
  };
  const pattern = correction
    ? `修正-${themeOf(SELF_CORRECTION)}`
    : stance
      ? `立场-${themeOf(SELF_STANCE)}`
      : boundary
        ? `边界-${themeOf(SELF_BOUNDARY)}`
        : commit
          ? `承诺-${themeOf(SELF_COMMIT)}`
          : feeling
            ? '情感-反应'
            : '附和';

  // 重要性：strong 0.7 / medium 0.6 / weak 0.5；
  // induced 检索降权（×0.6）；self_correction 不降权（学习信号，保留优先级独立于检索权重）
  let importance = strength === 'strong' ? 0.7 : strength === 'medium' ? 0.6 : 0.5;
  if (provenance === 'induced') importance = Math.round(importance * 0.6 * 100) / 100;

  const summary = t.length > 120 ? `${t.slice(0, 117)}…` : t;
  const emotionTags: string[] = [];
  for (const w of NEGATIVE_EMOTIONS) if (t.includes(w)) emotionTags.push(w);
  for (const w of POSITIVE_EMOTIONS) if (t.includes(w)) emotionTags.push(w);

  return {
    provenance,
    strength,
    pattern,
    summary,
    importance,
    emotionTags: [...new Set(emotionTags)],
  };
}

/**
 * 从 assistant content 块数组【从后往前】取最后一条 type==='text'（或 type undefined）的文本，
 * 跳过 reasoning / tool_call / thinking 等非表达块——与 import-chat 的 assistantMessageText 同口径。
 * 未来格式在尾部加入工具调用也不会把工具调用当成 AI 的表达。
 */
function assistantTextFromBlocks(
  blocks: readonly { type?: string; text?: string }[] | undefined,
): string | null {
  if (!Array.isArray(blocks)) return null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!block) continue;
    const type = block.type;
    const text = block.text;
    if (typeof text === 'string' && text.trim() && (type === 'text' || type === undefined)) {
      return text.trim();
    }
  }
  return null;
}

/**
 * 判定一条 session/event 是否为可提取的真实 assistant 消息（M3；P0 修正事件路径）。
 * 真实 DSH 事件的表达内容在 data.message.content，兼容旧/直挂结构 data.content。
 */
export function isExtractableAssistantMessage(ev: unknown): { ok: true; text: string } | { ok: false } {
  const e = ev as {
    type?: string;
    data?: {
      message?: { content?: readonly { type?: string; text?: string }[] };
      content?: readonly { type?: string; text?: string }[];
      source?: { kind?: string };
    };
  };
  if (e?.type !== 'assistant/message') return { ok: false };
  // 优先 data.message.content（真实持久化结构），回退 data.content（旧/直挂结构）
  const text =
    assistantTextFromBlocks(e?.data?.message?.content) ?? assistantTextFromBlocks(e?.data?.content);
  if (!text) return { ok: false };
  if (/^(current runtime context|this snapshot supersedes)/i.test(text)) return { ok: false };
  return { ok: true, text };
}
