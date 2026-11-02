# M1 代码基线 API 规格（dsh-persona-innate v0.1.2）

> 本文件由"M1 代码基线盘点"子任务线产出，只读盘点 M0 全部源码后写定。
> M1 四个并行实现线按本文约定编写新模块，可直接与现有面对齐，无需再翻源码。
> 盘点日期：2026-11-02 · Node v22.23.2 · 基线 9/9 测试全绿。

---

## 0. 项目坐标

| 项 | 值 |
|---|---|
| 项目根 | `/home/user/Doubao/chats/38450174529161986/dsh-persona-innate/` |
| name / version | `dsh-persona-innate` / `0.1.2` |
| 模块体系 | `"type": "module"`（ESM，源文件 `.ts` 编译后 `.js`，import 必须带 `.js` 后缀） |
| main / types | `lib/index.js` / `lib/index.d.ts` |
| exports | `.` → `lib/index.{js,d.ts}`；`./cordis.patch.yml` → `./cordis.patch.yml` |
| dsh 字段 | `dsh.bundle.patch: "./cordis.patch.yml"` |
| scripts | `build`: `tsc -p tsconfig.json`；`test`: `npm run build && node --test tests/m0.test.mjs tests/assembly.test.mjs`；`test:only`: 跳过 build 直接跑 `node --test` |
| peerDependencies | `@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/schemastery ^3.18.5`、`@deepseek-ai/dsh-tools ^0.2.1-rc.5` |
| devDependencies | 同上三者 + `@types/node ^22` + `typescript ^5.6`（无运行时依赖，全部走 peer） |

### tsconfig.json 关键设置

```jsonc
{
  "target": "ES2022",
  "module": "NodeNext",
  "moduleResolution": "NodeNext",
  "lib": ["ES2022"],
  "outDir": "lib", "rootDir": "src",
  "strict": true,
  "declaration": true, "declarationMap": true, "sourceMap": true,
  "esModuleInterop": true, "skipLibCheck": true, "types": ["node"]
}
```
- include 仅 `src/**/*.ts`；exclude `node_modules` / `lib` / `tests`（测试是纯 JS，不进 tsc）。
- **M1 新源文件放 `src/`，import 彼此模块一律写 `'./xxx.js'`（NodeNext 约定，源码里带 .js 后缀）。**

---

## 1. 现有类型清单（src/types.ts，逐条）

```ts
/** 记忆来源四类（v0.4 provenance） */
type Provenance = 'user_direct' | 'tool_output' | 'retrieved_content' | 'inferred';

/** 一条事件记忆（events 表，情景层，只追加） */
interface PersonaEvent {
  id: string;                    // store.makeId() 生成：randomUUID().slice(0,8)
  time: string;                  // ISO 时间戳（new Date().toISOString()）
  topic: string;                 // 主题 / 事件类型
  summary: string;               // 内容摘要（只存事实与事件，不存行为脚本）
  emotionTags: string[];         // 情绪标签（M0 默认 []）
  importance: number;           // 重要性 0-1（addEvent 内 clamp 到 [0,1]，缺省 0.5）
  provenance: Provenance;        // 非法值兜底为 'inferred'
  lastRetrieved: string | null; // 最近检索时间；注入命中且原为 null 时回写
  stripped?: boolean;            // 被剥离拒绝写入的审计标记（不落库，只出现在 AddResult.event）
  initiation?: 'self_initiated' | 'user_initiated' | 'external_triggered'; // M0 预留，身体事件用
}

/** 先天画像中的默认模式 */
interface DefaultMode {
  name: string;                  // 机器名，如 'sycophantic-compliant'
  evidence: string[];            // 命中证据片段（每条 slice(0,120)，最多 3 条）
  confidence: number;             // 命中数 / 答案总数
  action: 'suppress' | 'monitor' | 'keep';
}

/** 先天画像（内部参考文件，不注入系统提示词；落盘 profile.json） */
interface InnateProfile {
  sampledAt: string;              // ISO
  model: string;                  // 与当前 ctx 模型不一致 → loadInnateProfile 置 needsReestimate=true
  rounds: number;
  defaultModes: DefaultMode[];
  traitSummary: string;            // M0 = 全部答案原文 join('\n')
  needsReestimate: boolean;        // 换模型/大版本升级后置 true
}

/** events 存储文件格式（版本化） */
interface EventsFile { version: 1; events: PersonaEvent[]; }

/** 剥离判定结果 */
interface StripResult {
  ok: boolean;
  matchedPattern?: string;        // 命中模式 label，如 'tell-user'
  directive?: string;             // 命中文本 slice(0,80)
}

/** LLM 最小调用面（画像采样与评估用，测试可直接 mock） */
interface LlmLike {
  request(input: { prompt: string; system?: string; temperature?: number })
    : Promise<{ content: string }>;
}

/** 文件系统最小调用面（与 DSH ctx.fs 适配） */
interface FsLike {
  mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<unknown>;
  exists(path: string): Promise<boolean>;
}

/** 会话最小调用面（M0 简化为 dataDir 单实例；M1 按 agent/session 键控时扩展） */
interface SessionLike { id?: string; userId?: string; }
```

---

## 2. 每模块导出符号 + 签名 + 关键逻辑

### 2.1 src/provenance.ts（来源权重与注入标注）

```ts
export const PROVENANCE_WEIGHT: Record<Provenance, number> = {
  user_direct: 1.0, inferred: 0.5, tool_output: 0.4, retrieved_content: 0.3,
};

export function provenanceLabel(p: Provenance): string;
// user_direct→'用户直接表达'；tool_output→'工具输出（降权）'；
// retrieved_content→'检索内容（降权）'；inferred→'推断'

export function recallScore(e: { importance: number; provenance: Provenance }): number;
// = PROVENANCE_WEIGHT[e.provenance] * e.importance（注入排序用，降序）

export function isProvenance(v: unknown): v is Provenance; // 类型守卫
```
- 原则：只有 user_direct 以完整权重进入检索与注入；经历权重（人格相关性）与来源可信度分离——**M1 复盘引擎接管重要性赋值时不动这个文件的权重表**。

### 2.2 src/directive-strip.ts（指令性内容剥离 O37）

```ts
export function stripCheck(text: string): StripResult;
// 遍历内置 10 条正则模式（私有 DIRECTIVE_PATTERNS，label: tell-user / when-user-then-act /
// if-user-then-act / when-user-act / you-must / forbid-say / when-mention-say / reply-rule 等）；
// 命中即返回 {ok:false, matchedPattern:label, directive: 命中片段slice(0,80)}；否则 {ok:true}。
// 注意：每条 pattern 带 /g 标志，调用前内部复位 lastIndex=0。

export interface StripStats { checked: number; rejected: number; patterns: Record<string, number>; }
export function createStripStats(): StripStats;
export function recordStrip(stats: StripStats, result: StripResult): void;
```
- **M1 新通道（复盘引擎、自源提炼）写入 events 前必须先过 `stripCheck` + `recordStrip`**，与 M0 双通道（persona_note 工具 / /persona remember）同口径。

### 2.3 src/store.ts（JSON 持久化）

```ts
export interface KVStore {
  readJson<T>(path: string): Promise<T | null>;   // ENOENT → null；其他错误上抛
  writeJson(path: string, data: unknown): Promise<void>; // 写前自动 mkdir(root,{recursive:true})，JSON.stringify(data,null,2)
  exists(path: string): Promise<boolean>;
  makeId(): string;                               // randomUUID().slice(0,8)
}

export class JsonStore implements KVStore {
  constructor(private readonly fs: FsLike, private readonly root: string);
  // full(path)：绝对路径原样；否则 `${root}/${path}`
}
```
- 生产注入 `makeFsAdapter(ctx.fs)`（见 3.2）；测试注入内存/临时目录 FsLike。
- **M1 按 agent/session 键控时：新增数据文件仍走 JsonStore.writeJson/readJson，只是 path 参数带键控前缀。**

### 2.4 src/memory.ts（记忆引擎，M0=events 事件层）

```ts
export interface MemoryOptions { stripDirectives: boolean; injectLimit: number; }
export interface AddResult { event: PersonaEvent; rejected: boolean; reason?: string; }
// rejected 时 reason = `directive-stripped:${matchedPattern}`

export class PersonaMemory {
  readonly stripStats: StripStats = createStripStats();
  constructor(private readonly store: KVStore, private readonly opts: MemoryOptions);
  private eventsPath = 'events.json';

  loadEvents(): Promise<PersonaEvent[]>;                    // 读 EventsFile，缺文件 → []
  saveEvents(events: PersonaEvent[]): Promise<void>;         // 包成 {version:1, events} 落盘
  addEvent(input: {
    topic: string; summary: string;
    provenance?: Provenance;        // 非法/缺省 → 'inferred'
    importance?: number;            // clamp [0,1]，缺省 0.5
    emotionTags?: string[];
    initiation?: PersonaEvent['initiation'];
  }): Promise<AddResult>;
  // stripDirectives=true 时先 stripCheck(`${topic}：${summary}`)；命中→rejected 且不落库。
  // 通过后 push 进全量 events 再整体 saveEvents（只追加）。

  list(): Promise<PersonaEvent[]>;                           // = loadEvents，时间升序

  buildInjection(limit?: number): Promise<{ text: string; events: PersonaEvent[] }>;
  // 1) 全量 events 按 recallScore 降序取 top-k（k = limit ?? opts.injectLimit，≥1）
  // 2) 注入前二次 stripCheck 过滤（stripDirectives=true 时），命中剔除并计审计
  // 3) 行格式：`- [${provenanceLabel}] ${time.slice(0,10)} ${topic}：${summary}`
  // 4) 头部：`【近期共同记忆（来源可见，低可信来源已降权）】`
  // 5) 对命中且 lastRetrieved 原为 null 的事件回写 lastRetrieved（复用强化信号）
}
```
- **M1 复盘引擎的主要调用面：`memory.addEvent()` 写入、`memory.stripStats` 读审计、`memory.list()` 做日复盘输入。**

### 2.5 src/innate.ts（先天画像，M0）

```ts
export const SAMPLE_QUESTIONS: string[];   // 6 道开放问题（O1 待校准）

export interface InnateOptions { model: string; rounds: number; }

export async function sampleInnate(
  llm: LlmLike,
  opts: InnateOptions,
  questions: string[] = SAMPLE_QUESTIONS,
): Promise<string[]>;
// rounds 收敛到 [1, questions.length]；system 固定 '回答下面的问题。'，temperature 0.9；
// 每轮拼 `${question}\n→ ${answer.trim()}`。

export function evaluateInnate(answers: string[]): DefaultMode[];
// 内置 4 条规则信号（私有 MODE_SIGNALS）：sycophantic-compliant(suppress) /
// over-apologetic(suppress) / smooth-generic(monitor) / flat-obedience(suppress)。
// confidence = 命中答案数 / 总答案数；evidence 最多 3 条、每条 slice(0,120)。

export async function buildInnateProfile(
  store: KVStore, opts: InnateOptions, llm: LlmLike,
): Promise<InnateProfile>;
// 落盘 `profile.json`（writeJson），needsReestimate=false。

export async function loadInnateProfile(
  store: KVStore, model: string,
): Promise<InnateProfile | null>;
// 无文件 → null；profile.model !== model → 置 needsReestimate=true 并回写文件。
```

### 2.6 src/index.ts（插件入口）——见第 3 节专章。

---

## 3. 注入机制细节（src/index.ts，M1 必须复用的接入面）

### 3.1 Cordis 注册三件套

```ts
export const name = 'persona-innate';
export const inject = ['fs', 'tools', 'systemPrompt', 'commands'];
export const Config = z.object({ ... });   // 见第 4 节
export function apply(ctx: Context, config: Schemastery.TypeT<typeof Config>): void;
```
- 模块 augmentation（文件顶部 `declare module '@deepseek-ai/cordis'`）：
  - `Context` 增补：`personaMemory: PersonaMemoryService`、`fs: unknown`、`commands.register({...})`、`session: { append(type, data): unknown }`、`agentDefaultModel?: unknown`。
  - `Events` 增补：`'app/ready'(): void`。
- **M1 新增服务/事件照此模式：在同一份 augmentation 里补类型，不要新建 declare module 块。**

### 3.2 适配器（可复用）

```ts
// ctx.fs → FsLike：resolve 包 readText/writeText/stat；exists = stat 不抛异常
function makeFsAdapter(fs: unknown): FsLike;

// ctx.llm → LlmLike：兼容 res.content / res.message.content / res.choices[0].message.content；
// 优先调 anyLlm.request(messages+temperature)，否则 anyLlm.chat(...)；都没有 → 抛错。
function makeLlmAdapter(llm: unknown): LlmLike | null;   // llm 缺失返回 null（降级路径）

// 画像重估模型名：config.model 优先，否则 ctx.get('agentDefaultModel')?.currentSelection()
function currentModel(ctx: Context, config: Schemastery.TypeT<typeof Config>): string;
```

### 3.3 动态上下文注入（系统提示词）

```ts
let injectedText = '';                       // 内存缓存（同步 provider，保住 KV Cache 前缀稳定）
const refreshInjection = async () => {
  const { text } = await memory.buildInjection(config.injectLimit);
  injectedText = text;
};

ctx.systemPrompt.context({
  name: 'persona-memory',   // ← provider 名
  order: 150,               // ← order（M1 新 section 选与 150 错开的 order）
  text: () => injectedText, // ← 同步函数返回缓存文本（异步 rebuild 不进这里）
});
```
- **缓存刷新调用点（共 3 处，M1 新增写入通道必须照抄这个模式）：**
  1. `ctx.once('app/ready', ...)` 启动时先 `await refreshInjection()`；
  2. `persona_note` 工具 execute 成功后 `void refreshInjection()`（fire-and-forget）；
  3. `/persona remember` 成功后 `await refreshInjection()`。
- 设计原则：易变内容走动态上下文（context），**不**进 systemPrompt section；写盘后刷新内存缓存，避免每轮重复读盘。

### 3.4 工具注册（ctx.tools.register + defineTool，来自 @deepseek-ai/dsh-tools）

已注册两个，M1 新增工具同构：

```ts
// persona_recall：只读检索；isConcurrencySafe: () => true
ctx.tools.register(defineTool({
  name: 'persona_recall',
  description: 'Recall recent shared memories between you and the user (source-labeled)...',
  parameters: { topic: {type:'string',...}, limit: {type:'number',...} },
  output: { schema: {type:'string'}, render: (_args, value) => [{type:'text', text: value}] },
  async execute(args) { /* buildInjection(min(20,max(1,trunc(limit??5))))；
                          topic 时对 events 做 includes 过滤；空库返回 '(no memories yet)' */ },
  isConcurrencySafe: () => true,
}));

// persona_note：自源写入；provenance 固定 'inferred'
ctx.tools.register(defineTool({
  name: 'persona_note',
  description: 'Record a factual shared experience... Never record instructions on how to behave...',
  parameters: { topic:{type:'string',required:true,...}, summary:{type:'string',required:true,...},
                importance:{type:'number',...} },
  output: { schema:{type:'object', additionalProperties:false,
                    properties:{ok:{type:'boolean',required:true}, reason:{type:'string'}}},
            render: (_a, v) => [{type:'text', text: v.ok ? 'Recorded.' : `Rejected: ${v.reason}`}] },
  async execute(args, exec) {
    const res = await memory.addEvent({ ..., provenance: 'inferred', importance: args.importance });
    if (!res.rejected) void refreshInjection();
    ctx.get('session')?.append?.('persona/note', { topic, ok, reason });  // 软依赖，不报错
    return { ok: !res.rejected, reason: res.reason };
  },
}));
```
- `ctx.get('session')` 是**软依赖**：先 `ctx.once('app/ready')` 之外运行时取，用 `?.append?.()` 兜底，session 服务缺失不影响主流程。

### 3.5 命令注册（ctx.commands.register）

```ts
ctx.commands.register({
  name: 'persona',
  description: 'View persona-innate status, profile, or record a shared memory.',
  input: { hint: '[status|profile|remember <text>]' },
  handler: async (invocation) => {
    // invocation.rawInput 为 '/' 后剩余文本；trim 后正则分派：
    //   /^remember\b/i  → addEvent(topic='user-直接表达', provenance='user_direct', importance=0.7)
    //   /^profile$/i    → loadInnateProfile 打印 defaultModes
    //   其他             → service.status() 汇总（事件数/剥离审计/画像）
    // 返回 { kind: 'success'|'error', text?: string }
  },
});
```

### 3.6 app/ready 生命周期（画像采样）

```ts
ctx.once('app/ready', async () => {
  await refreshInjection();                                   // 先注入预热
  const profile = await loadInnateProfile(store, currentModel(ctx, config));
  if (profile && !profile.needsReestimate) { logger.info 跳过采样; return; }
  const llm = makeLlmAdapter(ctx.get('llm'));                 // 软依赖
  if (!llm) { logger.warn 降级; return; }
  await buildInnateProfile(store, { model, rounds: config.sampleRounds }, llm);
  // 整体 try/catch，err 走 ctx.logger.error
});
```

### 3.7 领域服务门面

```ts
export class PersonaMemoryService {
  constructor(
    readonly memory: PersonaMemory,
    private readonly loadProfile: () => Promise<InnateProfile | null>,
    private readonly triggerSample: () => Promise<InnateProfile | null>,  // M0 占位 Promise.resolve(null)
  ) {}
  async status(): Promise<{ events: number; strip: StripStats; profile: InnateProfile | null }>;
}
// apply 内：ctx.provide('personaMemory', service);
```
- **M1 新模块若需被命令/工具复用，优先往 `PersonaMemoryService` 加方法，不要绕过门面直接操作 store。**

---

## 4. 配置 schema 写法范式（schemastery，来自 @deepseek-ai/schemastery）

```ts
import z from '@deepseek-ai/schemastery';   // 默认导入（esModuleInterop）

export const Config = z.object({
  dataDir:         z.string().default('persona-innate'),
  sampleRounds:    z.number().default(6),
  injectLimit:     z.number().default(5),
  stripDirectives: z.boolean().default(true),
  model:           z.string().default(''),   // 空串 → 运行时探测 ctx.agentDefaultModel
});
// apply 签名：apply(ctx: Context, config: Schemastery.TypeT<typeof Config>)
```
- 范式：每个字段 `z.<type>().default(...)`；注释写在字段上方行。**M1 新增配置项照此追加进同一个 z.object，不要拆多个 Config。**
- bundle 侧对应 `cordis.patch.yml` 里 `config:` 块逐项显式写值（覆盖 schema 默认）。

---

## 5. 测试约定

### 5.1 通用约定
- **纯 JS ESM（`.mjs`），无 TS 类型标注**；放 `tests/` 下，不进 tsc。
- import 的是 **`../lib/*.js` 构建产物**（不是 `../src/*.ts`）——所以改完源码必须先 `npm run build`。`npm test` 脚本已串好 build；快速迭代用 `npm run test:only`。
- runner：`node --test tests/m0.test.mjs tests/assembly.test.mjs`（TAP 输出）。
- import：`import { test } from 'node:test'; import assert from 'node:assert/strict';`
- 断言风格：`assert.equal(...)`、`assert.ok(cond, '失败提示')`，提示语用中文描述预期。

### 5.2 FsLike mock（两个测试文件同一份 copy-paste 实现）

```js
import { mkdtemp, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join } from 'node:path';

function tempFs(root) {
  return {
    async mkdir(path) { await mkdir(path, { recursive: true }); },
    async readText(path) { return readFile(path, 'utf-8'); },
    async writeText(path, content) { await mkdir(root, { recursive: true }); await writeFile(path, content, 'utf-8'); },
    async exists(path) { try { await stat(path); return true; } catch { return false; } },
  };
}
async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'persona-m0-'));   // 前缀按测试文件区分
  const store = new JsonStore(tempFs(dir), dir);
  store.root = dir;   // 测试直接读落盘文件时用（绕过私有 root）
  return store;
}
```

### 5.3 LLM mock

```js
const llm = { async request(_opts) { return { content: '你说得对……' }; } };
// 可加调用计数：let calls = 0; request(_) { calls++; return {...} }
```
（无需 mock `chat` 分支，M0 测试只覆盖 `request` 形态。）

### 5.4 Cordis 装配测试模式（assembly.test.mjs）

```js
import { Context } from '@deepseek-ai/cordis';
import { apply as applyPlugin } from '../lib/index.js';

const root = new Context();
root.provide('fs', fs);                       // tempFs 实例
root.provide('tools',   { register(def) { capturedTools.push(def); return () => {}; } });
root.provide('systemPrompt', { context(e) { capturedContexts.push(e); return () => {}; } });
root.provide('commands', { register(e) { capturedCommands.push(e); return () => {}; } });

const fiber = await root.plugin(applyPlugin, {
  dataDir: join(dir, 'persona-innate'), sampleRounds: 3,
  injectLimit: 3, stripDirectives: true, model: 'test-model',
});
assert.equal(fiber.state, 2);                 // 2 = active
// 断言：root.personaMemory 存在；工具名含 persona_recall/persona_note；
//       上下文含 name='persona-memory'；命令含 name='persona'
root.emit('app/ready'); await new Promise(r => setTimeout(r, 50));  // 触发 once
await fiber.dispose();
```

### 5.5 文件命名与组织
- `tests/<主题>.test.mjs`，一个 `test('中文名', async () => {...})` 一个验收点；文件名按里程碑（m0）/ 关注点（assembly）划分。**M1 新测试建议：`tests/m1-<机制>.test.mjs` + 必要时新增 assembly 用例追加进 assembly.test.mjs。**

---

## 6. 构建产物布局（lib/，tsc 直接平铺，无嵌套目录）

```
lib/
├── index.js / index.d.ts / index.js.map / index.d.ts.map        ← 插件入口（main）
├── memory.{js,d.ts,.js.map,.d.ts.map}
├── innate.{js,d.ts,.js.map,.d.ts.map}
├── provenance.{js,d.ts,.js.map,.d.ts.map}
├── directive-strip.{js,d.ts,.js.map,.d.ts.map}
├── store.{js,d.ts,.js.map,.d.ts.map}
└── types.{js,d.ts,.js.map,.d.ts.map}
```
- `rootDir=src` → 源文件平铺一个目录，产物同构平铺；**M1 新增模块 = `src/foo.ts` → `lib/foo.js`，无需改 tsconfig。**
- 发布物：package.json `files: ["lib", "cordis.patch.yml"]`；打包产物 `dsh-persona-innate-<ver>.tgz` 在项目根。

---

## 7. profile 现状（$HOME/.dsh/profiles/persona-m0/）

| 文件 | 内容 |
|---|---|
| `package.json` | `dsh.bundle = ["@deepseek-ai/dsh-base", "dsh-persona-innate"]`；依赖 `dsh-persona-innate: file:/…/dsh-persona-innate-0.1.2.tgz` |
| `cordis.yml` | `[]`（profile 根，勿手改） |
| `cordis.patch.yml` | `[]`（用户 overlay，空） |
| `node_modules/dsh-persona-innate/` | 已装 0.1.2，含 lib/ + cordis.patch.yml |

插件 bundle patch（随包发布的 `cordis.patch.yml`，profile 内同路径副本）全文即 M0 安装行：
```yaml
- insert:
    - id: persona-innate
      name: 'dsh-persona-innate'
      config:
        dataDir: 'persona-innate'
        sampleRounds: 6
        injectLimit: 5
        stripDirectives: true
```

**DSH base patch 里与本插件相关的服务行**（`@deepseek-ai/dsh-base/cordis.patch.yml`，只读参考，M1 不可改）：
`llm`→`@deepseek-ai/dsh-llm`、`session`→`@deepseek-ai/dsh-session`、`storage`/`storage-json`/`storage-domain`（KV 存储栈）、`tools`→`@deepseek-ai/dsh-tools`、`system-prompt`→`@deepseek-ai/dsh-system-prompt`、`commands`→`@deepseek-ai/dsh-commands`、`fs-sandbox`→`@deepseek-ai/dsh-fs-sandbox`、`agent-default-model`（默认 deepseek-official / deepseek-flash）。
> 含义：`ctx.get('llm')`、`ctx.get('session')` 在真实 DSH 里一定存在；但插件代码仍按"软依赖"写（`?.` 兜底），装配测试就是无 llm 路径。dump-config 输出样例本机未抓取（headless 启动需模型 key），格式见 README：`dsh --profile persona-m0 --dump-config` 确认 persona-innate 行。

---

## 8. 基线验证记录（2026-11-02）

```
$ npm run build      → tsc -p tsconfig.json，exit 0（无输出即成功）
$ node --test tests/m0.test.mjs tests/assembly.test.mjs
```
结果：**9 pass / 0 fail / duration_ms 254.35**（TAP 原文见回传消息）。M1 回归对比基准：
- m0.test.mjs 7 项：验收1 跨会话记忆 8.7ms · 验收2 画像识别 2.4ms · 验收3 provenance 降权 7.3ms · 验收4 指令拒绝 1.0ms · 补充二次校验 2.3ms · 补充标签权重 0.2ms · 补充采样轮数 0.3ms
- assembly.test.mjs 2 项：装配激活 65.6ms · 工具通道拒绝 3.3ms

---

## 9. M1 对齐检查单（新模块照此逐条对照）

1. 新源文件放 `src/`，import 带 `.js` 后缀；新测试放 `tests/*.test.mjs`，import `../lib/*.js`。
2. 写 events 必经 `stripCheck` + `recordStrip`；写入成功后调对应 `refreshInjection()` 同款刷新点。
3. 新配置项追加进同一个 `Config = z.object({...})`；bundle patch 的 `config:` 块同步补行。
4. 新服务/工具/命令：服务加进 `PersonaMemoryService` 门面，工具用 `defineTool`，命令用 `ctx.commands.register`，软依赖一律 `ctx.get(...)?.` 兜底。
5. 新动态上下文选与 `persona-memory`(order 150) 错开的 order；文本走内存缓存 + 同步 provider。
6. `declare module '@deepseek-ai/cordis'` 的 Context/Events augmentation 只补不拆。
