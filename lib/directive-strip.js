/** 指令性内容形态模式（规则级标记，非语义判断；命中即认为含行为脚本） */
const DIRECTIVE_PATTERNS = [
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
/** 检查文本是否含指令性内容；ok=false 表示应拒绝写入 */
export function stripCheck(text) {
    for (const { pattern, label } of DIRECTIVE_PATTERNS) {
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
export function createStripStats() {
    return { checked: 0, rejected: 0, patterns: {} };
}
export function recordStrip(stats, result) {
    stats.checked += 1;
    if (!result.ok) {
        stats.rejected += 1;
        const p = result.matchedPattern ?? 'unknown';
        stats.patterns[p] = (stats.patterns[p] ?? 0) + 1;
    }
}
//# sourceMappingURL=directive-strip.js.map