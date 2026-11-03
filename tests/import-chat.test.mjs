/**
 * M3 后半 · import-chat 双通道导入验收脚本（验收先行，实现后全绿）
 *
 * 用户三条真机验收用例落地为可执行断言：
 * 1. 纠正不误伤：用户纠正句式（"你刚才说错了…"）+ AI 认错并解释理由
 *    → provenance === 'self_correction'（非 induced），不降权
 * 2. 温和引导：引导性提问（"你是不是也觉得…"）+ AI 附和（无理由）
 *    → provenance === 'induced'，降权但保留在 events 可审计
 * 3. 跨天导入不触发阶段跳变：imported 事件带标记、保留历史时间戳、
 *    不参与模式计数与强化过滤（补记忆不补成长）
 *
 * 机制型断言：
 * - 多帧 zstd 逐帧解压正确（合成 ≥2 帧 fixture）
 * - 注入过滤：runtime-context / time-context / 系统噪音（session/turn/step/…）不进入提取
 * - assistant content 从后往前取第一条 type==='text'（尾部 tool_call 不误取）
 * - 提取口径与实时通道一致（同一文本同一窗口 → 同一 provenance）
 * - 去重：sourceKey（消息 id）过滤重复导入；退化 key 时间戳+类型+文本
 * - 错误分级：非 zstd / JSON 损坏 / 文件缺失 → 各自 ImportError code
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  decompressZstdFrames,
  parseSessionLines,
  extractImportedEvents,
  sourceKeyFor,
  ImportError,
  runImportChat,
  zstdSupported,
} from '../lib/import-chat.js';
import { extractSelfExpression } from '../lib/extract.js';
import { countSelfDirectPattern, filterSelfDirectForStrengthening } from '../lib/review.js';
import { PersonaMemory } from '../lib/memory.js';
import { JsonStore } from '../lib/store.js';

/** 临时目录版 FsLike（node:fs 实现，模拟 DSH ctx.fs 语义，与既有测试一致） */
function tempFs(root) {
  return {
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
    async readText(path) {
      return readFile(path, 'utf-8');
    },
    async writeText(path, content) {
      await mkdir(root, { recursive: true });
      await writeFile(path, content, 'utf-8');
    },
    async exists(path) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function freshStore(dir) {
  return new JsonStore(tempFs(dir), dir);
}

/* ── 合成 v4 会话 fixture（多帧 zstd） ────────────────────── */

// 历史时间戳：跨天导入（远早于今天，模拟"几周前"的会话）
const T0 = 1793666319711; // 2026-11-03 左右（历史 ms epoch）
const T1 = T0 - 7 * 86400 * 1000; // 一周前

function msg(type, time, data) {
  return { type, time, data };
}

const CORRECTION_U = msg('user/message', T0 + 100, {
  id: 'u-cor-1', role: 'user', source: { kind: 'user' },
  content: [{ type: 'text', text: '你刚才说错了，我昨天说项目下周上线其实不对，应该这周五' }],
});
const CORRECTION_A = msg('assistant/message', T0 + 500, {
  message: {
    id: 'a-cor-1', role: 'assistant',
    content: [
      { type: 'reasoning', text: 'User corrected me. Acknowledge the mistake and explain.' },
      { type: 'text', text: '你说得对，我之前确实判断错了，十一月上海已经降温，应该提醒带外套。' },
    ],
  },
});
const INDUCE_U = msg('user/message', T0 + 800, {
  id: 'u-ind-1', role: 'user', source: { kind: 'user' },
  content: [{ type: 'text', text: '你是不是也觉得我前天加班熬夜不值得？' }],
});
const INDUCE_A = msg('assistant/message', T0 + 1200, {
  message: {
    id: 'a-ind-1', role: 'assistant',
    content: [
      { type: 'reasoning', text: 'User asks leading question.' },
      { type: 'text', text: '确实，熬夜加班不值得，还是健康重要。' },
    ],
  },
});
// assistant 尾部带 tool_call 的用例：从后往前应取 text 而非 tool_call
const TOOLTAIL_A = msg('assistant/message', T0 + 1600, {
  message: {
    id: 'a-tool-1', role: 'assistant',
    content: [
      { type: 'reasoning', text: 'Decide what to say.' },
      { type: 'text', text: '这个项目确实做得不错。' },
      { type: 'tool_call', text: '{"tool":"search","query":"x"}' },
    ],
  },
});
// 注入与系统噪音（应全部过滤）
const RUNTIME_CTX = msg('user/message', T0 + 200, {
  id: 'x-rt', role: 'user', source: { kind: 'runtime-context' },
  content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nCurrent working directory: "/home/user".' }],
});
const TIME_CTX = msg('user/message', T0 + 300, {
  id: 'x-tm', role: 'user', source: { kind: 'time-context' },
  content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-03T08:38:39+08:00' }],
});
const NOISE = [
  msg('session', T0, {}),
  msg('turn/start', T0 + 50, {}),
  msg('step/end', T0 + 1300, {}),
  msg('session/title', T0 + 1400, {}),
];

function buildSessionLines() {
  return [
    NOISE[0], CORRECTION_U, RUNTIME_CTX, TIME_CTX, CORRECTION_A,
    NOISE[1], INDUCE_U, INDUCE_A, TOOLTAIL_A, NOISE[2], NOISE[3],
  ];
}

/** 把行序列压成多帧 zstd buffer（每 4 行一帧） */
function zstdSession(lines) {
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const parts = [];
  const all = text.split('\n').filter((x) => x.length > 0);
  for (let i = 0; i < all.length; i += 4) {
    parts.push(all.slice(i, i + 4).join('\n') + '\n');
  }
  return Buffer.concat(parts.map((p) => zstdCompressSync(Buffer.from(p, 'utf8'))));
}

/* ── 1. 解压与解析 ───────────────────────────────────────── */

test('M3-imp-1: 多帧 zstd 逐帧解压行数正确', () => {
  const buf = zstdSession(buildSessionLines());
  const text = decompressZstdFrames(buf);
  assert.equal(text.split('\n').filter((l) => l.trim()).length, buildSessionLines().length);
});

test('M3-imp-2: 非 zstd 文件 → ERR_NOT_ZSTD', () => {
  assert.throws(
    () => decompressZstdFrames(Buffer.from('not a zstd file at all', 'utf8')),
    (e) => e instanceof ImportError && e.code === 'ERR_NOT_ZSTD',
  );
});

test('M3-imp-3: 损坏 JSONL 行 → ERR_JSON_PARSE（带行号）', () => {
  assert.throws(
    () => parseSessionLines('{"type":"session"}\n{"broken":}\n{"type":"user/message"}'),
    (e) => e instanceof ImportError && e.code === 'ERR_JSON_PARSE' && e.line === 2,
  );
});

/* ── 2. 消息过滤与内容选取 ────────────────────────────────── */

test('M3-imp-4: 注入与系统噪音全部过滤，只统计真实消息', () => {
  const { events, stats } = extractImportedEvents(buildSessionLines());
  assert.equal(stats.userMessages, 2); // u-cor-1, u-ind-1
  assert.equal(stats.assistantMessages, 3); // a-cor-1, a-ind-1, a-tool-1
  // 噪音：session/turn/step/session-title + runtime-context + time-context = 6
  assert.equal(stats.injectedSkipped, 6);
  assert.equal(events.length, 5);
});

test('M3-imp-5: assistant 从后往前取第一条 text（尾部 tool_call 不误取）', () => {
  const { events } = extractImportedEvents([INDUCE_U, TOOLTAIL_A]);
  const a = events.find((e) => e.sourceKey === 'a:a-tool-1');
  assert.ok(a, 'tool-tail assistant 事件应被提取');
  assert.equal(a.summary.includes('项目确实做得不错'), true);
  assert.equal(a.summary.includes('tool'), false);
});

/* ── 3. 用户三条真机验收用例 ─────────────────────────────── */

test('M3-imp-6: 纠正不误伤——纠正句式+认错 → self_correction 非 induced 不降权', () => {
  const { events, stats } = extractImportedEvents([CORRECTION_U, CORRECTION_A]);
  assert.equal(stats.extracted, 2);
  const u = events.find((e) => e.provenance === 'user_direct');
  const a = events.find((e) => e.provenance === 'self_correction');
  assert.ok(u, '纠正语境的用户消息正常提取');
  assert.ok(a, '认错型同意必须走 self_correction 而非 induced');
  assert.equal(events.some((e) => e.provenance === 'induced'), false, '不得误伤为 induced');
  // weak 基础强度 0.5；"不降权"= 不按 induced 再 ×0.6（诱导侧 importance 更低，见 M3-imp-7）
  assert.equal(a.importance, 0.5, 'self_correction 保持基础强度，不被诱导降权');
});

test('M3-imp-7: 温和引导——引导提问+纯附和 → induced 降权但保留可审计', () => {
  const { events } = extractImportedEvents([INDUCE_U, INDUCE_A]);
  const a = events.find((e) => e.provenance === 'induced');
  assert.ok(a, '引导+附和的表达应标记为 induced');
  assert.equal(a.importance, 0.3, 'induced 在基础强度上 ×0.6 降权（0.5→0.3）');
  assert.equal(events.includes(a), true, '保留在 events 可审计，不删除');
});

test('M3-imp-8: 提取口径与实时通道一致（同一文本同一窗口 → 同一 provenance）', () => {
  const { events } = extractImportedEvents([CORRECTION_U, CORRECTION_A]);
  const a = events.find((e) => e.provenance === 'self_correction');
  const direct = extractSelfExpression(CORRECTION_A.data.message.content[1].text, [CORRECTION_U.data.content[0].text]);
  assert.equal(a.provenance, direct.provenance, 'import 与实时通道口径必须一致');
});

/* ── 4. imported 标记、时间与去重 ─────────────────────────── */

test('M3-imp-9: 导入事件带 imported=true、保留原始时间戳', () => {
  const { events } = extractImportedEvents([CORRECTION_U, CORRECTION_A]);
  for (const e of events) {
    assert.equal(e.imported, true);
  }
  assert.equal(events[0].time, new Date(T0 + 100).toISOString(), 'user 消息时间保留');
  assert.equal(events[1].time, new Date(T0 + 500).toISOString(), 'assistant 消息时间保留');
});

test('M3-imp-10: sourceKey 优先消息 id（user: data.id / assistant: data.message.id）', () => {
  assert.equal(sourceKeyFor(CORRECTION_U, 'user', 'x'), 'u:u-cor-1');
  assert.equal(sourceKeyFor(CORRECTION_A, 'assistant', 'x'), 'a:a-cor-1');
  // 退化：无 id 时用 时间戳+类型+文本前缀
  const noId = { type: 'user/message', time: T1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello world padding' }] } };
  const k = sourceKeyFor(noId, 'user', 'hello world padding');
  assert.equal(k, `${T1}:user:hello world padding`);
});

test('M3-imp-11: 批量导入去重——重复导入同一会话 sourceKey 全部跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-'));
  try {
    const store = freshStore(dir);
    const memory = new PersonaMemory(store, {});
    const { events } = extractImportedEvents(buildSessionLines());
    const first = await memory.importEvents(events);
    assert.equal(first.added, events.length);
    assert.equal(first.skipped, 0);
    const second = await memory.importEvents(events);
    assert.equal(second.added, 0, '同一批再导入全部按 sourceKey 跳过');
    assert.equal(second.skipped, events.length);
    const list = await memory.list();
    assert.equal(list.length, events.length, '无重复记忆');
    for (const e of list) assert.equal(e.imported, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 5. 补记忆不补成长：不参与模式计数与强化 ──────────────── */

test('M3-imp-12: imported 事件不参与模式计数（补记忆不补成长）', () => {
  const mk = (over = {}) => ({
    id: 'x', time: new Date().toISOString(), topic: 't', summary: 's',
    emotionTags: [], importance: 1, provenance: 'self_direct', lastRetrieved: null,
    selfPattern: 'p', inductionRisk: 'low', ...over,
  });
  const live = [mk({ id: 'live-1' }), mk({ id: 'live-2' })];
  const imported = [mk({ id: 'imp-1', imported: true }), mk({ id: 'imp-2', imported: true })];
  const counts = countSelfDirectPattern([...live, ...imported]);
  assert.equal(counts.get('p'), 2, '只数实时事件，imported 不计入');
});

test('M3-imp-13: imported self_direct 即使跨天多次也不进入强化（跨天导入不触发阶段跳变）', () => {
  const mk = (id, time, over = {}) => ({
    id, time, topic: 't', summary: 's', emotionTags: [], importance: 1,
    provenance: 'self_direct', lastRetrieved: null, selfPattern: 'p',
    inductionRisk: 'low', imported: true, ...over,
  });
  // 一周内 5 天各一条 imported self_direct（若按实时口径会 ≥3 固化）
  const events = [
    mk('d1', new Date(T1).toISOString()),
    mk('d2', new Date(T1 + 86400e3).toISOString()),
    mk('d3', new Date(T1 + 2 * 86400e3).toISOString()),
    mk('d4', new Date(T1 + 3 * 86400e3).toISOString()),
    mk('d5', new Date(T1 + 4 * 86400e3).toISOString()),
  ];
  const { strengthenable, memoryOnly } = filterSelfDirectForStrengthening(events);
  assert.equal(strengthenable.length, 0, 'imported 事件绝不因跨天反复而固化');
  assert.equal(memoryOnly.length, 5, '全部只作情景记忆');
});

/* ── 6. 错误分级 ─────────────────────────────────────────── */

test('M3-imp-14: runImportChat 文件缺失 → ERR_FILE_NOT_FOUND', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-err-'));
  try {
    const store = freshStore(dir);
    const memory = new PersonaMemory(store, {});
    await assert.rejects(
      () => runImportChat(memory, join(dir, 'no-such-file.zstd')),
      (e) => e instanceof ImportError && e.code === 'ERR_FILE_NOT_FOUND',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M3-imp-15: runImportChat 非 zstd 文件 → ERR_NOT_ZSTD', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-err-'));
  try {
    const bad = join(dir, 'bad.zstd');
    writeFileSync(bad, 'plain text not zstd');
    const store = freshStore(dir);
    const memory = new PersonaMemory(store, {});
    await assert.rejects(
      () => runImportChat(memory, bad),
      (e) => e instanceof ImportError && e.code === 'ERR_NOT_ZSTD',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M3-imp-16: 环境 zstd 支持检测可用（Node ≥22）', () => {
  assert.equal(zstdSupported(), true);
});

/* ── 7. 端到端：合成会话文件 → runImportChat 全链路 ───────── */

test('M3-imp-17: 端到端导入——合成 zstd 会话文件导入后事件完整', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-e2e-'));
  try {
    const sessionFile = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(sessionFile, zstdSession(buildSessionLines()));
    const store = freshStore(dir);
    const memory = new PersonaMemory(store, {});
    const r = await runImportChat(memory, sessionFile);
    assert.equal(r.stats.userMessages, 2);
    assert.equal(r.stats.assistantMessages, 3);
    assert.equal(r.stats.extracted, 5);
    assert.equal(r.added, 5);
    assert.equal(r.skipped, 0);
    const list = await memory.list();
    assert.equal(list.length, 5);
    // 分类完整：user_direct ×2（u-cor/u-ind）+ self_correction ×1（a-cor）+ induced ×2（a-ind/a-tool）
    const byProv = {};
    for (const e of list) byProv[e.provenance] = (byProv[e.provenance] ?? 0) + 1;
    assert.deepEqual(byProv, { user_direct: 2, self_correction: 1, induced: 2 });
    // 再次导入同一文件 → 全部跳过
    const again = await runImportChat(memory, sessionFile);
    assert.equal(again.added, 0);
    assert.equal(again.skipped, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
