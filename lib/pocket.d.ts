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
export declare function firstLine(description: string, max?: number): string;
/**
 * 取 JSON Schema 里的参数名，按对象自身键序（= 声明顺序，稳定可读）。
 *
 * @param parameters - 参数 JSON Schema 对象
 * @returns 参数名数组；没有 `properties`、或它不是对象时返回 `[]`
 */
export declare function paramNames(parameters: Record<string, unknown>): string[];
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
export declare function groupTools(tools: PocketTool[]): {
    group: string;
    names: string[];
}[];
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
export declare function updateLedger(ledger: PocketLedger, presentNames: string[], today: string, keepDays?: number): PocketLedger;
/**
 * 算"上次见过、现在不在"的条目。
 *
 * @param ledger - 上一版 ledger（用**旧版**：新版里 present 已被刷新成今天）
 * @param presentNames - 本轮真实看到的工具名
 * @param today - 今天的本地日期串
 * @param keepDays - 保留天数；超期条目不再报"掉了"
 * @returns 按 `lastSeen` 倒序（最近掉的在前），同日按名字升序保证确定性
 */
export declare function missingTools(ledger: PocketLedger, presentNames: string[], today: string, keepDays?: number): {
    name: string;
    lastSeen: string;
}[];
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
export declare function renderPocket(input: {
    tools: PocketTool[];
    missing: {
        name: string;
        lastSeen: string;
    }[];
    failures: PocketFailure[];
    detail?: boolean;
    group?: string;
}): string;
//# sourceMappingURL=pocket.d.ts.map