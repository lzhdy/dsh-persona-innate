#!/usr/bin/env node
/**
 * dsh-web-search-account 部署脚本（幂等）。
 *
 * 为什么需要它：这个插件不在 profile 的 package.json 依赖里（不走 pnpm，避免整库重装把
 * persona 插件重下来），所以 `dsh plugin` 一类的操作、或 dsh 大版本升级，都可能把它清掉。
 * 清掉后搜索会退回 `WEB_PROVIDER_CREDENTIAL_MISSING`（凭据缺失）。恢复只需再跑一次本脚本。
 *
 * 用法：
 *   node runtime/dsh-web-search-account/deploy.mjs            # 部署 + 检查 patch 条目
 *   node runtime/dsh-web-search-account/deploy.mjs --check    # 只检查，不写盘
 *
 * 它做三件事：
 *   1. 把 package.json / index.js 拷进 <dshHome>/profiles/web/node_modules/dsh-web-search-account/
 *   2. 检查 cordis.patch.yml 是否有 insert 条目与 web.searchProvider 覆盖；缺则补上并备份原文件
 *   3. 打印验证与重启提示
 */

import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK_ONLY = process.argv.includes('--check');

/** 要部署的文件：package.json + 插件自身的 .js（free-search.js 等模块必须一起过去）。 */
const SOURCES = ['package.json', ...(await readdir(HERE)).filter((f) => f.endsWith('.js')).sort()];

const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', 'web');
const patchPath = join(profileDir, 'cordis.patch.yml');
const targetDir = join(profileDir, 'node_modules', 'dsh-web-search-account');

const PATCH_BLOCK = `
# ── web 搜索鉴权：用账号登录态，而不是要求 DEEPSEEK_API_KEY ─────────────
# 现象：她翻口袋看到自己有联网能力，实调 web_search 报
#   WebError: WEB_PROVIDER_CREDENTIAL_MISSING
# 根因：官方 dsh-web-search-deepseek 的 resolveAccountToken 只在
#   「当前会话 provider === 'deepseek-account'」时才用账号令牌；本机默认模型是
#   LM Studio 本地模型（provider = llama-local），于是账号登录着也用不上，回退去要
#   DEEPSEEK_API_KEY，而它从未配置过。
# 处置：本地 provider（node_modules/dsh-web-search-account）复用官方
#   DeepSeekSearchProvider，只把取令牌改成直接问 deepseekAccount 服务要；
#   并把默认通道换成「免模型搜索」（抓 Bing 结果页自己解析，零 token）。
#   不改任何官方文件，官方插件升级不会覆盖。
# 成本：默认 mode=free-first 不花额度；解析不出结果才回退账号通道（一次模型调用）。
#   要恢复官方行为：改成 mode: 'account'；要禁止任何花钱：mode: 'free-only'。
# ⚠ 新增插件必须用 insert: 形式；直接写 - id:/name: 会被当成「覆盖已有条目」并报 entry not found。
- insert:
    - id: web-search-account
      name: 'dsh-web-search-account'
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-search-account
    fetchProvider: http
`;

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

if (!existsSync(profileDir)) fail(`找不到 profile 目录：${profileDir}（dsh 还没初始化过 web profile？）`);
if (!existsSync(patchPath)) fail(`找不到 ${patchPath}`);

let patch = await readFile(patchPath, 'utf8');
const hasInsert = patch.includes("name: 'dsh-web-search-account'") || patch.includes('name: "dsh-web-search-account"');
const hasOverride = /searchProvider:\s*deepseek-search-account/.test(patch);

console.log(`profile：${profileDir}`);
console.log(`patch  ：insert 条目 ${hasInsert ? '已在' : '缺失'}；searchProvider 覆盖 ${hasOverride ? '已在' : '缺失'}`);

if (CHECK_ONLY) {
  const missing = SOURCES.filter((file) => !existsSync(join(targetDir, file)));
  console.log(`部署  ：${missing.length === 0 ? '已就位' : `未就位（缺 ${missing.join(', ')}；运行不带 --check 的脚本即可）`}`);
  process.exit(hasInsert && hasOverride && missing.length === 0 ? 0 : 1);
}

await mkdir(targetDir, { recursive: true });
for (const file of SOURCES) {
  await copyFile(join(HERE, file), join(targetDir, file));
  console.log(`✓ 已写入 ${join(targetDir, file)}`);
}

if (hasInsert && hasOverride) {
  console.log('✓ patch 条目已齐，未改动 cordis.patch.yml');
} else {
  const backup = `${patchPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await copyFile(patchPath, backup);
  if (!patch.endsWith('\n')) patch += '\n';
  // 只补缺的那一半，避免重复插入同一段 YAML。
  if (!hasInsert) {
    await writeFile(patchPath, `${patch}${PATCH_BLOCK}`, 'utf8');
    console.log(`✓ 已追加 insert + web 覆盖（原文件备份：${backup}）`);
  } else if (!hasOverride) {
    await writeFile(
      patchPath,
      `${patch}\n- id: web\n  name: '@deepseek-ai/dsh-web'\n  config:\n    searchProvider: deepseek-search-account\n    fetchProvider: http\n`,
      'utf8',
    );
    console.log(`✓ 已补 searchProvider 覆盖（原文件备份：${backup}）`);
  }
}

console.log(`
下一步：
  1. 重启 dsh（双击桌面 start-dsh-logged.bat；先确认 3080 没在监听）
  2. 验证：node runtime/dsh-web-search-account/deploy.mjs --check
  3. 看证据：cat ~/.dsh/logs/web-search-account.log
     期望看到 {"event":"registered",...,"mode":"free-first","accountToken":"ok"}
     紧跟一条 {"event":"boot-free-search","sources":N}（免费通道自检，不消耗额度）
     之后每次真实搜索是 {"event":"search-free","sources":N,"ms":N}（零 token）
     若出现 {"event":"search-free-empty"} 或 {"event":"search","sources":N}，说明这次走了付费兜底
`);
