/**
 * 数据目录解析（P1：固定绝对路径，消除 cwd 相对路径漂移）。
 *
 * 口径对齐 @deepseek-ai/dsh-home-paths 0.2.1-rc.5 的 resolveDshHome：
 * 优先级 显式配置 > $DSH_HOME > ~/.dsh；空/空白 $DSH_HOME 视为未设置，绝不解析到 cwd。
 *
 * dsh-home-paths 是纯 ESM 且本插件 apply 为同步构造，因此：
 * - 异步预热官方包（成功则以官方 resolveDshHome 为准）；
 * - 同步内置等价逻辑兜底，保证路径在任何环境下都可预测、不崩溃。
 * 两者规则一致，解析结果相同。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const DSH_HOME_DIR_NAME = '.dsh';
const DSH_HOME_ENV = 'DSH_HOME';
const DATA_SUBDIR = 'persona-innate';
/**
 * 展开 ~ / ~/ 前缀（Unix 习惯）。Windows 上 ~ 不是有效前缀，直接跳过不处理也不崩溃。
 */
function expandHomePath(p) {
    if (process.platform === 'win32')
        return p;
    if (p === '~')
        return homedir();
    if (p.startsWith('~/'))
        return join(homedir(), p.slice(2));
    return p;
}
/**
 * 内置等价 DSH home 解析（与 dsh-home-paths.resolveDshHome 同口径，同步）。
 */
function fallbackDshHome() {
    const fromEnv = process.env[DSH_HOME_ENV];
    const root = typeof fromEnv === 'string' && fromEnv.trim().length > 0
        ? fromEnv
        : join(homedir(), DSH_HOME_DIR_NAME);
    return resolve(expandHomePath(root));
}
/** 官方包异步预热结果：null=尚未就绪或不可用（用内置兜底）。 */
let officialDshHome = null;
let officialSettled = false;
async function preloadOfficial() {
    if (officialSettled)
        return;
    officialSettled = true;
    try {
        // 宿主 DSH 提供该包；本地无此包时类型声明缺失，运行时解析失败会走 catch 兜底。
        // 用运行时字符串导入：无论本机是否装了该 peer 包都能编译（装了也不会触发
        // "unused @ts-expect-error"）。
        const specifier = '@deepseek-ai/dsh-home-paths'.toString();
        const mod = (await import(specifier));
        if (typeof mod?.resolveDshHome === 'function') {
            officialDshHome = resolve(mod.resolveDshHome());
        }
    }
    catch {
        officialDshHome = null; // 不可用：保持内置兜底，不抛出
    }
}
void preloadOfficial();
/** 同步取得 DSH home：显式 env > 官方包预热结果 > 内置兜底 */
function resolveDshHomeSync() {
    // 显式 DSH_HOME 始终优先：官方包在模块加载时就解析并缓存了 home，
    // 之后再改 env（宿主切换 home / 测试注入）不应被旧缓存覆盖。
    const fromEnv = process.env[DSH_HOME_ENV];
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
        return resolve(expandHomePath(fromEnv.trim()));
    }
    return officialDshHome ?? fallbackDshHome();
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
export function resolveDataDir(configured, warn) {
    if (configured !== undefined && configured !== null && configured.trim().length > 0) {
        return { root: resolve(expandHomePath(configured.trim())), source: 'explicit' };
    }
    if (configured === '') {
        warn('config.dataDir 为空字符串（语义无效），已回退到默认 DSH home 路径');
        return { root: join(resolveDshHomeSync(), DATA_SUBDIR), source: 'empty-fallback' };
    }
    return { root: join(resolveDshHomeSync(), DATA_SUBDIR), source: 'auto' };
}
//# sourceMappingURL=paths.js.map