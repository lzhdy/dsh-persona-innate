/**
 * P1 raw_turns 原始层测试
 * - 映射纯函数（speakerOf / rawTextOf）四类映射 + 运行时上下文注入跳过 + assistant reasoning 块跳过
 * - buildRawTurn：event_id / content_hash / session_id / asserted_at 的确定性
 * - RawTurnLog：append + list 往返、跨月分片、event_id/content_hash 稳定
 * - 集成：user → assistant → tool 序列三类落库
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { speakerOf, rawTextOf, buildRawTurn } from '../lib/raw-turn.js';
import { RawTurnLog } from '../lib/raw-turn-log.js';
import { JsonStore } from '../lib/store.js';

/* ───────────── 映射纯函数 ───────────── */

test('speakerOf：四类映射 + 其余类型跳过', () => {
  assert.equal(speakerOf('user/message'), 'user');
  assert.equal(speakerOf('assistant/message'), 'assistant');
  assert.equal(speakerOf('system/message'), 'system');
  assert.equal(speakerOf('tool/call'), 'tool');
  assert.equal(speakerOf('tool/result'), 'tool');
  assert.equal(speakerOf('turn/end'), null);
  assert.equal(speakerOf('step/start'), null);
  assert.equal(speakerOf('request/header'), null);
  assert.equal(speakerOf('session/created'), null);
  assert.equal(speakerOf(undefined), null);
  assert.equal(speakerOf(123), null);
});

test('rawTextOf：user/message 提取 text 块 join', () => {
  const ev = {
    type: 'user/message',
    data: {
      source: { kind: 'user' },
      content: [
        { type: 'text', text: '今天' },
        { type: 'text', text: '很开心' },
      ],
    },
  };
  assert.equal(rawTextOf(ev), '今天 很开心');
});

test('rawTextOf：运行时上下文注入（source.kind ≠ user）被跳过', () => {
  const ev = {
    type: 'user/message',
    data: {
      source: { kind: 'runtime-context' },
      content: [{ type: 'text', text: 'current runtime context ...' }],
    },
  };
  assert.equal(rawTextOf(ev), null);
});

test('rawTextOf：user/message 缺 source 字段被跳过（仅 source.kind==="user" 才捕获）', () => {
  const ev = {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'hello' }] },
  };
  assert.equal(rawTextOf(ev), null);
});

test('rawTextOf：assistant 跳过 reasoning/tool_call，从后往前取第一条 text 块', () => {
  const ev = {
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: '内部思考，不该落库' },
          { type: 'text', text: '你好呀' },
          { type: 'tool-call', id: 't1', name: 'search' },
        ],
      },
    },
  };
  assert.equal(rawTextOf(ev), '你好呀');
});

test('rawTextOf：assistant 无 text 块返回 null', () => {
  const ev = {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: '只有思考' }] } },
  };
  assert.equal(rawTextOf(ev), null);
});

test('rawTextOf：system/message 提取 text 块 join', () => {
  const ev = { type: 'system/message', data: { content: [{ type: 'text', text: 'sys' }] } };
  assert.equal(rawTextOf(ev), 'sys');
});

test('rawTextOf：tool/call 与 tool/result 走 JSON.stringify(data)', () => {
  assert.equal(rawTextOf({ type: 'tool/call', data: { callId: 'c1', name: 'search' } }), '{"callId":"c1","name":"search"}');
  assert.equal(rawTextOf({ type: 'tool/result', data: { ok: true } }), '{"ok":true}');
});

test('rawTextOf：非四类事件返回 null', () => {
  assert.equal(rawTextOf({ type: 'turn/end', data: {} }), null);
});

/* ───────────── buildRawTurn 组装 ───────────── */

const FIXED_NOW = new Date('2025-03-10T12:00:00.000Z');
const deps = { makeId: () => 'deadbeef', now: () => FIXED_NOW };

test('buildRawTurn：user 的 event_id 取 data.id，session_id 取 session.id', () => {
  const turn = buildRawTurn(
    { id: 'sess-123' },
    { type: 'user/message', time: 1700000000000, data: { id: 'msg-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
    deps,
  );
  assert.ok(turn);
  assert.equal(turn.event_id, 'msg-1');
  assert.equal(turn.session_id, 'sess-123');
  assert.equal(turn.speaker, 'user');
  assert.equal(turn.raw_text, 'hi');
  assert.equal(turn.turn_id, '');
  assert.equal(turn.asserted_at, new Date(1700000000000).toISOString());
  assert.equal(turn.ingested_at, FIXED_NOW.toISOString());
  assert.equal(turn.content_hash, createHash('sha256').update('hi', 'utf8').digest('hex'));
});

test('buildRawTurn：assistant 的 event_id 取 data.message.id', () => {
  const turn = buildRawTurn(
    { id: 'sess-123' },
    { type: 'assistant/message', time: 1700000001000, data: { message: { id: 'msg-2', content: [{ type: 'text', text: '你好' }] } } },
    deps,
  );
  assert.ok(turn);
  assert.equal(turn.event_id, 'msg-2');
  assert.equal(turn.speaker, 'assistant');
  assert.equal(turn.raw_text, '你好');
});

test('buildRawTurn：无 id 时退化为 rt- + makeId()', () => {
  const turn = buildRawTurn(
    { id: 'sess-123' },
    { type: 'tool/call', data: { callId: 'c1' } },
    deps,
  );
  assert.ok(turn);
  assert.equal(turn.event_id, 'rt-deadbeef');
  assert.equal(turn.speaker, 'tool');
  assert.equal(turn.raw_text, '{"callId":"c1"}');
});

test('buildRawTurn：session 无 id 时显式空串（禁止编造）', () => {
  const turn = buildRawTurn(
    {},
    { type: 'user/message', time: 1700000000000, data: { id: 'msg-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
    deps,
  );
  assert.ok(turn);
  assert.equal(turn.session_id, '');
});

test('buildRawTurn：event.time 缺失时 asserted_at 降级为写入时刻', () => {
  const turn = buildRawTurn(
    { id: 's' },
    { type: 'system/message', data: { content: [{ type: 'text', text: 'sys' }] } },
    deps,
  );
  assert.ok(turn);
  assert.equal(turn.asserted_at, FIXED_NOW.toISOString());
});

test('buildRawTurn：非四类 / 运行时上下文注入返回 null', () => {
  assert.equal(buildRawTurn({ id: 's' }, { type: 'turn/end', data: {} }, deps), null);
  assert.equal(
    buildRawTurn({ id: 's' }, { type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'x' }] } }, deps),
    null,
  );
});

test('buildRawTurn：content_hash 稳定（同 raw_text 同哈希，与 speaker 无关）', () => {
  const a = buildRawTurn({ id: 's' }, { type: 'user/message', data: { id: 'm', source: { kind: 'user' }, content: [{ type: 'text', text: 'same' }] } }, deps);
  const b = buildRawTurn({ id: 's' }, { type: 'assistant/message', data: { message: { id: 'm2', content: [{ type: 'text', text: 'same' }] } } }, deps);
  assert.ok(a && b);
  assert.equal(a.content_hash, b.content_hash);
  assert.equal(a.content_hash, createHash('sha256').update('same', 'utf8').digest('hex'));
});

/* ───────────── RawTurnLog 存储 ───────────── */

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

async function freshStore(prefix = 'persona-rawturn-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { store: new JsonStore(tempFs(dir), dir), root: dir };
}

function turn(overrides = {}) {
  return {
    event_id: 'rt-1',
    session_id: 'sess-1',
    turn_id: '',
    speaker: 'user',
    raw_text: 'hello',
    asserted_at: '2025-03-10T12:00:00.000Z',
    ingested_at: '2025-03-10T12:00:00.000Z',
    content_hash: createHash('sha256').update('hello', 'utf8').digest('hex'),
    ...overrides,
  };
}

test('RawTurnLog：append 后 list() 读回且字段稳定（event_id/content_hash 不变）', async () => {
  const { store } = await freshStore();
  const log = new RawTurnLog(store);

  const t = turn();
  await log.append(t);

  const list = await log.list();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], t);
  assert.equal(list[0].event_id, 'rt-1');
  assert.equal(list[0].content_hash, createHash('sha256').update('hello', 'utf8').digest('hex'));
});

test('RawTurnLog：跨月分片正确（不同 asserted_at 写进各自 YYYY-MM.jsonl）', async () => {
  const { store, root } = await freshStore();
  const log = new RawTurnLog(store);

  await log.append(turn({ event_id: 'rt-jan', asserted_at: '2025-01-15T00:00:00.000Z' }));
  await log.append(turn({ event_id: 'rt-feb', asserted_at: '2025-02-20T00:00:00.000Z' }));

  const list = await log.list();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((t) => t.event_id).sort(), ['rt-feb', 'rt-jan']);

  const jan = await readFile(join(root, 'raw-turns', '2025-01.jsonl'), 'utf-8');
  const feb = await readFile(join(root, 'raw-turns', '2025-02.jsonl'), 'utf-8');
  assert.ok(jan.includes('rt-jan'));
  assert.ok(feb.includes('rt-feb'));

  // manifest 记录两个月（含 listMonths 兜底补入的当前月，与 EventLog 同口径）
  const manifest = JSON.parse(await readFile(join(root, 'raw-turns', 'manifest.json'), 'utf-8'));
  assert.ok(manifest.months.includes('2025-01'), `manifest 应含 2025-01，实际：${manifest.months}`);
  assert.ok(manifest.months.includes('2025-02'), `manifest 应含 2025-02，实际：${manifest.months}`);
  assert.deepEqual(manifest.months, [...manifest.months].sort(), 'manifest 月份应有序');
});

test('RawTurnLog：追加后新实例（重建）仍能从 manifest 读回历史分片', async () => {
  const { store, root } = await freshStore();
  const log = new RawTurnLog(store);
  await log.append(turn({ event_id: 'rt-old', asserted_at: '2025-01-15T00:00:00.000Z' }));

  // 模拟重启：同一 store 上新建 RawTurnLog
  const log2 = new RawTurnLog(store);
  const list = await log2.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].event_id, 'rt-old');
  assert.equal(log2.stats.months >= 1, true);
  void root;
});

/* ───────────── 集成：user → assistant → tool 序列 ───────────── */

test('集成：一段 user → assistant → tool 序列，三类 speaker 全部落 raw_turns', async () => {
  const { store } = await freshStore('persona-rawturn-int-');
  const log = new RawTurnLog(store);
  const session = { id: 'sess-int' };

  const seq = [
    { type: 'user/message', time: 1000, data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我查一下天气' }] } },
    { type: 'assistant/message', time: 2000, data: { message: { id: 'a1', content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '好的，我来查' }] } } },
    { type: 'tool/call', time: 3000, data: { callId: 'c1', name: 'search', arguments: 'weather' } },
    { type: 'tool/result', time: 4000, data: { callId: 'c1', ok: true } },
    { type: 'assistant/message', time: 5000, data: { message: { id: 'a2', content: [{ type: 'text', text: '今天晴' }] } } },
  ];

  for (const ev of seq) {
    const t = buildRawTurn(session, ev, { makeId: () => 'x' });
    if (t) await log.append(t);
  }

  const list = await log.list();
  const bySpeaker = { user: 0, assistant: 0, tool: 0 };
  for (const t of list) bySpeaker[t.speaker] += 1;
  assert.equal(list.length, 5);
  assert.deepEqual(bySpeaker, { user: 1, assistant: 2, tool: 2 });

  // assistant 的 reasoning 块没有混进原文
  const assistantTurns = list.filter((t) => t.speaker === 'assistant');
  assert.ok(assistantTurns.every((t) => !t.raw_text.includes('想')));
  assert.ok(assistantTurns.some((t) => t.raw_text === '好的，我来查'));
});
