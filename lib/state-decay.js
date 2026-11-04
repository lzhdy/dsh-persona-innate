/**
 * 触发衰减的最小空闲时间（毫秒）。
 * 小于 1 分钟不衰减：每轮感知都会写一次 state.json，而 1 分钟内的衰减量
 * （半衰 24h 下约 0.05%）远小于噪声，写盘成本却落在对话热路径上。TODO(calibrate)
 */
export const DECAY_MIN_INTERVAL_MS = 60_000;
/**
 * 按"距上次状态更新"的空闲时长衰减一次。
 *
 * 时间基准取 state.updatedAt（state.ts 每次 apply/decay 都会刷新它）：
 * 不用进程内存里的时间戳，因为 DSH 每次启动都是一个新进程，
 * 内存基准会让"关机 8 小时再启动"这段衰减整个丢掉。
 *
 * 失败一律降级为"不衰减"：衰减是修正项，不该让一次读盘失败打断对话主链路。
 */
export async function decayForIdleGap(state, opts = {}) {
    const now = opts.now ?? Date.now();
    const minInterval = opts.minIntervalMs ?? DECAY_MIN_INTERVAL_MS;
    let updatedAt;
    try {
        const snap = await state.snapshot();
        updatedAt = typeof snap?.state?.updatedAt === 'string' ? snap.state.updatedAt : '';
    }
    catch {
        return { decayed: false, dtMs: 0, reason: 'snapshot-failed' };
    }
    const lastAt = Date.parse(updatedAt);
    if (!Number.isFinite(lastAt))
        return { decayed: false, dtMs: 0, reason: 'invalid-updatedAt' };
    const dt = now - lastAt;
    if (!(dt >= minInterval))
        return { decayed: false, dtMs: Math.max(0, dt), reason: 'below-min-interval' };
    await state.decay(dt);
    return { decayed: true, dtMs: dt };
}
/**
 * 串行队列（不引新依赖）。
 *
 * perceiveEvent 由三处钩子以 void 调用（刻意不阻塞对话），同一会话里两轮可能几乎同时到达。
 * "衰减 → 应用"是一段读-改-写：并发执行会把同一段 dt 衰减两次，或让后写完的那次
 * 覆盖掉前一次的事件更新。用一条 Promise 链把它们排队，调用点的 void 语义不变。
 */
export function createSerialQueue() {
    let chain = Promise.resolve();
    return (task) => {
        const run = chain.then(task, task);
        chain = run.then(() => undefined, () => undefined);
        return run;
    };
}
//# sourceMappingURL=state-decay.js.map