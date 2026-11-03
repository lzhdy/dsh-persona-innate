/**
 * 自动记忆提取（M2：session/event 驱动的确定性规则）
 * - 从用户消息中识别"值得记住的经历/情绪分享"，零 LLM 成本、可复算
 * - 命中返回 { topic, summary, importance, emotionTags }，未命中返回 null
 * - 只提取事实与经历，不提取指令（指令性内容由 memory.addEvent 统一剥离）
 * - 保守原则：宁可漏、不可错——无时间/第一人称/情绪信号的抽象讨论不提取
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
/** 时间信号（把消息锚定到"过去/当下的经历"） */
const TIME_WORDS = [
    '今天', '昨天', '前天', '昨晚', '上周', '这周', '本周', '最近', '刚刚',
    '下午', '上午', '晚上', '周末', '下周', '明天', '这阵子', '这段时间',
];
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
    const hasTime = TIME_WORDS.some((w) => t.includes(w));
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
//# sourceMappingURL=extract.js.map