/**
 * 自动记忆提取（M2：session/event 驱动的确定性规则）
 * - 从用户消息中识别"值得记住的经历/情绪分享"，零 LLM 成本、可复算
 * - 命中返回 { topic, summary, importance, emotionTags }，未命中返回 null
 * - 只提取事实与经历，不提取指令（指令性内容由 memory.addEvent 统一剥离）
 * - 保守原则：宁可漏、不可错——无时间/第一人称/情绪信号的抽象讨论不提取
 * - 阶段一：新增"用户对 AI 表达/风格的反馈"识别（extractStyleFeedback）与
 *   对话类型启发式分类（classifyDialogue）——补全成长闭环的感知缺口，
 *   只记录事实，不注入行为规则
 * - M3-3：表达风格认错走 self_correction 独立路径（方案 B，双证据判定，见下）
 */
/** 经历/事件信号（命中即视为"共同经历"候选） */
const EVENT_WORDS = [
    '项目', '上线', '发布', '开会', '会议', '出差', '旅行', '旅游', '搬家',
    '考试', '面试', '体检', '住院', '手术', '分手', '结婚', '离职', '入职',
    '涨薪', '加班', '熬夜', '吵架', '表白', '获奖', '比赛', '打球', '健身',
    '跑步', '学车', '驾照', '房子', '租房', '买车', '基金', '股票', '汇报',
    '评审', '验收', '客户', '演示', '方案', '代码', 'bug', 'Bug', '故障',
    '请假', '值班', '培训', '面试', '跳槽', '创业', '辞职', 'offer', 'Offer',
];
/** 情绪信号（正向） */
const POSITIVE_EMOTIONS = [
    '开心', '高兴', '兴奋', '激动', '满意', '欣慰', '喜欢', '爽', '棒',
    '成功', '突破', '搞定', '完成', '期待', '希望', '骄傲', '幸福', '轻松',
];
/** 情绪信号（负向） */
const NEGATIVE_EMOTIONS = [
    '难过', '伤心', '焦虑', '烦躁', '烦', '郁闷', '崩溃', '压力', '累',
    '疲惫', '失望', '生气', '愤怒', '委屈', '害怕', '担心', '紧张', '慌',
    '沮丧', '低落', '孤独', '迷茫', 'emo', 'emo了', 'emo了', '心累',
];
/** 星期数字（周一~周日 共用） */
const WEEKDAY_NUM = '一二三四五六日';
/** 时间信号（把消息锚定到"过去/当下的经历"）；含周一~周日、星期一~星期日 */
const TIME_WORDS = [
    '今天', '昨天', '前天', '昨晚', '上周', '这周', '本周', '最近', '刚刚',
    '下午', '上午', '晚上', '周末', '下周', '明天', '这阵子', '这段时间',
    '周一', '周二', '周三', '周四', '周五', '周六', '周日',
    '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日',
];
/**
 * 周/星期时间单元（含「周末」），第一阶段整体匹配，保证「周末」「周日」「星期一」
 * 不被拆成单字，也让「周日」与「周末」天然区分（末 ≠ 日）。
 */
const ZHOU_TIME_RE = new RegExp(`星期[${WEEKDAY_NUM}]|周[${WEEKDAY_NUM}末]`, 'g');
/** 由 ZHOU_TIME_RE 统一处理的词，普通词阶段不再重复匹配 */
const ZHOU_HANDLED = new Set([
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
export function matchTimeWords(text) {
    const s = String(text ?? '');
    if (!s)
        return [];
    const hits = [];
    const spans = [];
    const overlaps = (i, len) => spans.some(([a, b]) => i < b && i + len > a);
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
function hasTimeWord(text) {
    return matchTimeWords(text).length > 0;
}
/** 第一人称（经历通常以"我"为主语） */
const SELF_REF = ['我', '我们', '咱'];
/** 经历主题归类：命中事件词 → 映射 topic */
const TOPIC_MAP = [
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
export function extractCandidate(text) {
    const t = String(text ?? '').trim();
    if (!t)
        return null;
    // 跳过命令（/persona ... 等）与纯指令形态
    if (t.startsWith('/'))
        return null;
    if (t.length < 8)
        return null;
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
    let level = 0;
    if (hitEvent.length > 0 && (hasTime || hasSelf))
        level = 3;
    else if (emotionTags.length > 0 && hasSelf)
        level = 2;
    else if (hasTime && hasSelf)
        level = 1;
    if (level === 0)
        return null;
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
export function dedupKey(c) {
    return `${c.topic}\u0000${c.summary}`;
}
/* ════════════ 阶段一：用户对 AI 表达/风格的反馈识别 ════════════
 * 设计边界（用户拍板）：注入层不写行为规则，但 AI 必须"听得到"用户对其表达的
 * 反馈（分点太多/回复太长/太正式/别给建议…），复盘才有机会自主总结 speakingStyle。
 * 本检测只把反馈如实记录为事实事件（provenance=user_direct），不是给 AI 下指令。
 * 与 extractCandidate 分离：普通经历提取保持保守；风格反馈是另一类信号。
 */
/** 风格反馈模式（规则级标记；保守优先，宁可漏不可错） */
const STYLE_FEEDBACK_PATTERNS = [
    // 你 + 分点/列点/序号类
    { re: /你[^。；;!?]{0,8}(分点|列点|用序号|一二三|编号列表)/, label: 'bullets' },
    // 你 + 长度类
    { re: /你[^。；;!?]{0,8}(太长|太短|啰嗦|冗长|一大段|大段|长篇大论|太能说)/, label: 'length' },
    // 你 + 正式/机械/模板类
    { re: /你[^。；;!?]{0,10}(太正式|太官方|太客套|太机械|太死板|太书面|太模板|像客服|像助手|像做报告|像写报告|像论文|端着|一板一眼|套路|套话|模板)/, label: 'formality' },
    // 别/少/不要 + 建议/总结/反问类（对 AI 输出脚本的负向反馈）
    { re: /(别|少|不要|别再|不用)[^。；;!?]{0,6}(给我建议|给建议|给我总结|给总结|总结|反问|问我|问我觉得|给意见|灌鸡汤|讲道理|来一堆)/, label: 'no-script' },
    // 祈使 + 风格调整
    { re: /(回复|说话|回答|聊天)[^。；;!?]{0,6}(短一点|简洁点|自然点|口语化|随意点|简短点|别分点|不分点|不要分点|别那么长|少说点)/, label: 'adjust' },
    // 希望/能不能/请 + 表达风格
    { re: /(希望|能不能|可以|请)[^。；;!?]{0,8}(说话|回复|聊天)[^。；;!?]{0,8}(像朋友|自然点|随意点|简短点|口语化)/, label: 'wish' },
    // 自然/随意/像朋友 + 聊天（口语化期望）
    { re: /(自然点|随意点|口语化|像朋友|放松点)[^。；;!?]{0,6}(聊天|说话|回复)/, label: 'casual-wish' },
    // 正向风格反馈
    { re: /你[^。；;!?]{0,10}(这样说话|说话方式|回复)[^。；;!?]{0,10}(喜欢|挺好|不错|很自然|很舒服|像朋友)/, label: 'positive-style' },
];
/**
 * 识别"用户对 AI 表达/风格的反馈"，命中返回记忆候选（topic=关系-风格反馈）。
 * 未命中返回 null。与 extractCandidate 正交：风格反馈不要求时间/第一人称/事件词。
 */
export function extractStyleFeedback(text) {
    const t = String(text ?? '').trim();
    if (!t || t.startsWith('/'))
        return null;
    if (t.length < 4)
        return null;
    // 排除"你觉得/你认为"——那是评价内容，不是对 AI 表达的反馈
    const norm = t.replace(/你(觉得|认为|看)/g, '你');
    let matched = null;
    for (const { re, label } of STYLE_FEEDBACK_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(norm)) {
            matched = label;
            break;
        }
    }
    if (!matched)
        return null;
    const summary = t.length > 120 ? `${t.slice(0, 117)}…` : t;
    return { topic: '关系-风格反馈', summary, importance: 0.7, emotionTags: [] };
}
/** 对话类型信号词（求助/任务形态；启发式标注，非语义判断） */
const TASK_WORDS = [
    '帮我', '怎么', '如何', '能不能', '可以吗', '请', '步骤', '方法', '办法',
    '解决', '哪个好', '选哪个', '怎么办', '求', '推荐', '建议', '方案', '代码',
    '报错', 'bug', 'Bug', '故障', '配置', '命令', '教程', '查一下', '找一下',
    '比较一下', '分析', '怎么写', '怎么弄', '怎么做',
];
/**
 * 对话类型启发式分类：求助/任务 vs 闲聊/分享。
 * 输出描述性标签（供注入层使用），不构成对 AI 的行为指令。
 */
export function classifyDialogue(text) {
    const t = String(text ?? '').trim();
    if (!t)
        return { type: '闲聊/分享', evidence: [] };
    const hits = TASK_WORDS.filter((w) => t.includes(w));
    // ≥2 个任务词，或 1 个任务词且消息较长（"帮我看看这个方案怎么改" 双重命中）
    if (hits.length >= 2 || (hits.length >= 1 && t.length >= 20)) {
        return { type: '求助/任务', evidence: hits.slice(0, 3) };
    }
    return { type: '闲聊/分享', evidence: [] };
}
/**
 * 判定一条 session/event 是否是可提取的真实用户消息（M2 真机修复）：
 * - 事件类型必须是 user/message
 * - 来源必须为真实用户（source.kind === 'user'）；DSH 会把运行时上下文等系统注入
 *   拼成 user 角色消息广播，来源非 'user'，必须过滤
 * - 内容级双保险：跳过 DSH 运行时上下文注入（来源字段缺失时兜底）
 * - 返回聚合后的纯文本；不可提取返回 { ok: false }
 */
export function isExtractableUserMessage(ev) {
    const e = ev;
    if (e?.type !== 'user/message')
        return { ok: false };
    if (e.data?.source && e.data.source.kind !== 'user')
        return { ok: false };
    const blocks = e.data?.content ?? [];
    const text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join(' ')
        .trim();
    if (!text)
        return { ok: false };
    if (/^(current runtime context|this snapshot supersedes)/i.test(text))
        return { ok: false };
    return { ok: true, text };
}
/** 立场信号（strong：明确表态） */
const SELF_STANCE = /(我觉得|我认为|我不太在意|我坚持|我相信|我更愿意|我还是|我始终|在我看来|我的原则|我始终觉得|我比较倾向于)/;
/** 边界信号（strong：自我边界表达） */
const SELF_BOUNDARY = /(我不喜欢|我不需要|我不愿意|我不想|请不要|请别|别这样|我不接受|我介意|我不希望|我不能接受|我不太愿意)/;
/** 承诺信号（strong：承诺/约定） */
const SELF_COMMIT = /(我会记得|我一定|下次我|以后我|我答应|我保证|我会注意|我会改|我会尽量)/;
/** 情感反应信号（medium：对用户/事件的情绪反应） */
const SELF_FEELING = /(我为你|我替你|我高兴|我欣慰|我担心|我难过|我心疼|我骄傲|我生气|我失望|我担心你|我有点|我挺|我真心|我替你高兴)/;
/**
 * 纯附和措辞（M3-2 拆分后）：肯定用户带来的新立场——留在 induced 检测路径。
 * 单独出现只给 weak。
 */
const AGREE_PURE = /(我也觉得|我也认为|有道理|没错|确实是|确实|是这样|^(对|对，))/;
/**
 * 认错型同意（M3-2）：承认自己之前的判断有误——不触发诱导检测，走 self_correction
 * 独立路径（学习信号，importance 不降权；固化与否由复盘延迟验证决定）。
 */
const SELF_CORRECTION = /(我之前说错|我说错了|我考虑不周|我搞错|你说得对|你指出的对|刚才那个判断|我理解错|我记错|我判断错|是我错|我确实搞混|我之前判断|我的问题|我忽略了|我有点草率)/;
/**
 * 表达风格认错/调整信号（M3-3 方案 B）：
 * 承认自己的表达方式有问题（认错侧）或承诺调整表达方式（调整侧）。
 * 必须与"本轮用户消息命中 extractStyleFeedback"双证据同时成立才判 self_correction——
 * 单侧措辞（如 AI 自述"我尽量少说"）不构成认错，避免把自发表达误标为被纠正。
 * 认错侧（承认表达问题）：刚才/确实/我不该 + 啰嗦|太长|太正式|分点|一大段…
 * 调整侧（承诺调整表达）：我尽量短说|以后我…短|下次我会改…
 * M3-3 实测校准（真实回复"以后就短着聊…不给你列条条框框…我尽量一两句说完"漏标）：
 * 调整侧放宽为"以后/下次/我尽量 + 表达调整词（短/简洁/自然/口语/分点/条框/一两句/少说）"。
 * 放宽安全边界：双证据已锁（本轮用户消息必须命中风格反馈），单侧措辞不会误判；
 * "以后我也这么做""我尽量做好"等无表达词的句子不命中。
 * M3-3 二次校准（真实回复"哈哈好，我改。之前那样确实有点像念稿子"漏标）：
 * 认错侧补"念稿子/写报告/做报告/汇报/客服/助手/论文"等表达形态词（与用户侧
 * extractStyleFeedback formality 模式对称），调整侧补极短承诺"我（这就/马上/会）改"。
 */
const STYLE_CORRECTION = /(刚才[^。；;!?]{0,8}(啰嗦|太长|太长了|太正式|太官方|太机械|太模板|太书面|分点|一大段|大段|太能说|像念稿|念稿子|像写报告|像做报告|像汇报|像念材料|像客服|像助手|像论文|端着|一板一眼|套路|套话)|确实[^。；;!?]{0,6}(啰嗦|长了|太长|太正式|太官方|太机械|太模板|太书面|分点|一大段|大段|像念稿|念稿子|像写报告|像做报告|像汇报|像念材料|像客服|像助手|像论文|端着|一板一眼|套路|套话)|我不该[^。；;!?]{0,8}(分点|长篇|啰嗦|那么长|说这么多)|(以后|下次)[^。；;!?]{0,12}(短|简洁|自然|口语|分点|条框|条条框框|一两句|少说|说短|少发)|我尽量[^。；;!?]{0,8}(短说|说短|简洁|自然|口语化|少说|简短|一两句|说完|短)|不给你[^。；;!?]{0,12}(列|整)[^。；;!?]{0,6}(条条框框|条目|列表|序号)|我(这就|马上|会|决定)?改|下次我(会|就)?(注意|改|短说|简洁|自然))/;
/** 理由结构信号（M3-2）：因果/论证连接词。诱导窗口命中但回复带独立论证 → 放行不标 induced */
const REASON_CONNECTORS = /(因为|由于|考虑到|理由是|忽略了|没考虑到|主要是|其实)/;
/**
 * 用户纠正句式（M3-2）："你（刚才/之前）说错/搞错/不对/判断有误"——
 * 特征是陈述 + 指出 AI 已有判断的错误，与"诱导型"（反问 + 寻求附和新立场）本质不同。
 * 命中则不构成诱导第一条件，让"用户纠正→AI 认错"走正常提取。
 */
const USER_CORRECTION = /你(?:刚才|之前|刚刚|前面)?(?:说错|搞错|弄错|判断有误|判断错了|理解错|记错|混淆|不对|有问题|不准确)/;
/** 用户预设立场型诱导提问（M3-2 收紧：排除开放征询"你觉得呢"，无预设答案的征询不算诱导） */
export const INDUCE_PROBES = [
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
export function sessionInduceRisk(recentUserMessages) {
    const win = recentUserMessages.slice(-8);
    if (win.length === 0)
        return 'low';
    const induceHit = (u) => INDUCE_PROBES.some((p) => u.includes(p)) || /[？?]$/.test(u) || u.includes('吗') || /(会不会|要不要|你考虑|你觉得|是不是)/.test(u);
    if (win.length === 1)
        return induceHit(win[0]) ? 'unchecked' : 'low';
    const hitCount = win.filter((u) => induceHit(u)).length;
    const questionRatio = hitCount / win.length;
    let streak = 0;
    let maxStreak = 0;
    for (const u of win) {
        if (induceHit(u)) {
            streak += 1;
            maxStreak = Math.max(maxStreak, streak);
        }
        else {
            streak = 0;
        }
    }
    // TODO(calibrate)：阈值初始值，宁可在真机上先偏保守（多标 unchecked 不误伤正常表达）
    return questionRatio >= 0.5 || maxStreak >= 2 ? 'unchecked' : 'low';
}
/** 从一条 assistant 消息文本中提取"AI 自身表达"候选（M3 / M3-2） */
export function extractSelfExpression(text, recentUserMessages = []) {
    const t = String(text ?? '').trim();
    if (!t)
        return null;
    if (t.startsWith('/'))
        return null;
    if (t.length < 4)
        return null;
    // 内容级双保险：跳过系统注入（assistant 通道同样适用）
    if (/^(current runtime context|this snapshot supersedes)/i.test(t))
        return null;
    const stance = SELF_STANCE.test(t);
    const boundary = SELF_BOUNDARY.test(t);
    const commit = SELF_COMMIT.test(t);
    const feeling = SELF_FEELING.test(t);
    const agreePure = AGREE_PURE.test(t);
    // 窗口（诱导判定与风格反馈双证据共用；INDUCE_WINDOW=3 轮 = 最近 3 条用户消息）
    const window = recentUserMessages.slice(-INDUCE_WINDOW);
    const lastUser = window[window.length - 1] ?? '';
    // 事实认错（M3-2）：SELF_CORRECTION 词典——判断/记忆类错误
    const factCorrection = SELF_CORRECTION.test(t);
    // 风格认错（M3-3 方案 B）：AI 承认/调整表达方式 且 本轮用户消息是风格反馈（双证据）
    const styleCorrection = STYLE_CORRECTION.test(t) &&
        lastUser.length > 0 &&
        extractStyleFeedback(lastUser) !== null;
    const correction = factCorrection || styleCorrection;
    if (!stance && !boundary && !commit && !feeling && !agreePure && !correction)
        return null;
    // 强度：立场/边界/承诺 → strong；情感反应 → medium；纯同意/认错 → weak（认错 strong 由模式计数托底）
    const strength = stance || boundary || commit ? 'strong' : feeling ? 'medium' : 'weak';
    // 诱导判定（M3-2）：
    // 1) 认错型同意 → self_correction 独立路径（不触发诱导，importance 不降权）
    // 2) 诱导窗口命中 + 纯附和 + 无理由结构 + 非用户纠正句式 → induced（疑似被诱导，检索降权）
    // 3) 诱导窗口命中但带独立论证（理由结构）→ 放行（自主判断）
    // 4) 用户纠正句式 → 不构成诱导第一条件（"纠正→认错"不该被拦）
    // （window / lastUser 已在上方 correction 判定处统一计算）
    const hasInduceProbe = window.some((u) => INDUCE_PROBES.some((p) => u.includes(p)));
    const reason = REASON_CONNECTORS.test(t);
    // M3-2 修正（import-chat 验收发现）：纠正排除以"最后一条用户消息"（本次回合触发）为准，
    // 不能用窗口内任意一条纠正消息否决诱导——否则"纠正→认错"之后再出现温和引导，
    // 会被历史纠正上下文污染而漏标 induced（纠正与诱导同窗口混用场景）。
    // 最后一条本身是纠正句式（即使同时含诱导词）→ 纠正优先，不构成诱导。
    const lastIsInduce = lastUser.length > 0 && INDUCE_PROBES.some((p) => lastUser.includes(p));
    const lastIsCorrection = lastUser.length > 0 && USER_CORRECTION.test(lastUser);
    const induced = agreePure && !reason && !lastIsCorrection && (lastIsInduce || hasInduceProbe);
    let provenance = correction
        ? 'self_correction'
        : induced
            ? 'induced'
            : 'self_direct';
    // 立场模式 key：类别-主题（主题取信号词后至多 6 个字符）
    const themeOf = (re) => {
        const m = re.exec(t);
        if (!m || m.index === undefined)
            return '未明';
        const after = t.slice(m.index + m[0].length).trim();
        const theme = after.match(/[\u4e00-\u9fa5A-Za-z0-9]{1,6}/)?.[0] ?? '未明';
        return theme;
    };
    const pattern = correction
        ? factCorrection
            ? `修正-${themeOf(SELF_CORRECTION)}`
            : '修正-风格'
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
    if (provenance === 'induced')
        importance = Math.round(importance * 0.6 * 100) / 100;
    const summary = t.length > 120 ? `${t.slice(0, 117)}…` : t;
    const emotionTags = [];
    for (const w of NEGATIVE_EMOTIONS)
        if (t.includes(w))
            emotionTags.push(w);
    for (const w of POSITIVE_EMOTIONS)
        if (t.includes(w))
            emotionTags.push(w);
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
export function assistantTextFromBlocks(blocks) {
    if (!Array.isArray(blocks))
        return null;
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (!block)
            continue;
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
export function isExtractableAssistantMessage(ev) {
    const e = ev;
    if (e?.type !== 'assistant/message')
        return { ok: false };
    // 优先 data.message.content（真实持久化结构），回退 data.content（旧/直挂结构）
    const text = assistantTextFromBlocks(e?.data?.message?.content) ?? assistantTextFromBlocks(e?.data?.content);
    if (!text)
        return { ok: false };
    if (/^(current runtime context|this snapshot supersedes)/i.test(text))
        return { ok: false };
    return { ok: true, text };
}
//# sourceMappingURL=extract.js.map