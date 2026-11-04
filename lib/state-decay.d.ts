/**
 * 情绪衰减接线（v0.7）
 *
 * 为什么需要这个模块：PersonaStateMachine.decay(dtMs) 早就实现了（半衰回基线 + 波动放宽），
 * 但全仓唯一调用点是评测门面 stateFacade——真实会话链路从不调用它。
 * 后果是效价只被事件推高、永不复原：本机实测 36 分钟内 valence −0.03 → 0.53，
 * 11 次更新里 10 次上升、一次没回落。情绪带上棘轮，模型会系统性偏向亢奋/多话，
 * 直接污染观察期的风格指标。
 *
 * 本模块只回答"什么时候衰减"，不改"怎么算"：
 * 半衰期、基线、弛豫参数全部留在 state.ts，本轮不碰。
 * 单独成文件而不是塞进 index.ts：index.ts 的 apply() 是 cordis 闭包，无法单测；
 * 接线的判断逻辑放在这里，测试就能用真实 PersonaStateMachine 走装配级断言。
 */
import type { StateMachineLike } from './types.js';
/**
 * 触发衰减的最小空闲时间（毫秒）。
 * 小于 1 分钟不衰减：每轮感知都会写一次 state.json，而 1 分钟内的衰减量
 * （半衰 24h 下约 0.05%）远小于噪声，写盘成本却落在对话热路径上。TODO(calibrate)
 */
export declare const DECAY_MIN_INTERVAL_MS = 60000;
export interface DecayOutcome {
    /** 是否真的执行了 decay */
    decayed: boolean;
    /** 距上次更新的时间差（毫秒；时间为负/不可解析时为 0） */
    dtMs: number;
    /** 未衰减时的原因（可观测，便于解释"为什么这轮没衰减"） */
    reason?: 'snapshot-failed' | 'invalid-updatedAt' | 'below-min-interval';
}
/**
 * 按"距上次状态更新"的空闲时长衰减一次。
 *
 * 时间基准取 state.updatedAt（state.ts 每次 apply/decay 都会刷新它）：
 * 不用进程内存里的时间戳，因为 DSH 每次启动都是一个新进程，
 * 内存基准会让"关机 8 小时再启动"这段衰减整个丢掉。
 *
 * 失败一律降级为"不衰减"：衰减是修正项，不该让一次读盘失败打断对话主链路。
 */
export declare function decayForIdleGap(state: Pick<StateMachineLike, 'decay' | 'snapshot'>, opts?: {
    now?: number;
    minIntervalMs?: number;
}): Promise<DecayOutcome>;
/**
 * 串行队列（不引新依赖）。
 *
 * perceiveEvent 由三处钩子以 void 调用（刻意不阻塞对话），同一会话里两轮可能几乎同时到达。
 * "衰减 → 应用"是一段读-改-写：并发执行会把同一段 dt 衰减两次，或让后写完的那次
 * 覆盖掉前一次的事件更新。用一条 Promise 链把它们排队，调用点的 void 语义不变。
 */
export declare function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T>;
//# sourceMappingURL=state-decay.d.ts.map