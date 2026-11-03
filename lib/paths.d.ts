export type DataDirSource = 'auto' | 'explicit' | 'empty-fallback';
export interface DataDirResolution {
    root: string;
    source: DataDirSource;
}
/**
 * 解析数据目录，明确四态语义：
 * - undefined / null（未配置）→ 自动定位 join(dshHome, 'persona-innate')；
 * - 空字符串（显式但无效）→ warn 后回退默认；
 * - 非空显式路径 → 尊重并展开 ~（win32 跳过）。
 *
 * @param configured 配置中的 dataDir（schema 已改为可选，未配置为 undefined）。
 * @param warn 日志告警通道。
 */
export declare function resolveDataDir(configured: string | null | undefined, warn: (msg: string) => void): DataDirResolution;
//# sourceMappingURL=paths.d.ts.map