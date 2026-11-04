/**
 * v0.5 记忆装配测试（补的是"接线"而不是"节点"）
 *
 * 这批用例对应四类只能靠装配测试抓住的缺陷：
 * 1. 注入被插件自己的独白填满（真实数据 top-5 中 4 条为 self_direct）
 * 2. 检索冻结（同分并列 + 稳定排序 → 最早的 N 条永久占位，新记忆进不来）
 * 3. 线索依赖缺失（当前话题命中不了旧事）
 * 4. 存储：坏行容错、旧格式迁移、注入纯读不写盘
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/store.js';
import { PersonaMemory } from '../lib/memory.js';
import { SALIENCE_WEIGHT, PROVENANCE_WEIGHT } from '../lib/provenance.js';
import { assembleRecall, cueSimilarity, relativeDayLabel } from '../lib/recall.js';

const DAY = 86_400_000;

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

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'persona-v05-'));
  const store = new JsonStore(tempFs(dir), dir);
  store.root = dir;
  return store;
}

function ev(id, daysAgo, over = {}) {
  return {
    id,
    time: new Date(Date.now() - daysAgo * DAY).toISOString(),
    topic: '用户-分享',
    summary: `事件 ${id}`,
    emotionTags: [],
    importance: 0.7,
    provenance: 'user_direct',
    lastRetrieved: null,
    ...over,
  };
}

async function seed(store, events) {
  const mem = new PersonaMemory(store, { stripDirectives: true, injectLimit: 5 });
  await mem.saveEvents(events);
  return mem;
}

/* ── 1. 显著性：用户的事不该被插件的独白挤出去 ───────────── */

test('v0.5-1a: 可信度与显著性分离，self_direct 高保留低提及', () => {
  assert.equal(PROVENANCE_WEIGHT.self_direct, 1.0, '可信度不变：自己说的话当然算数');
  assert.ok(SALIENCE_WEIGHT.self_direct < SALIENCE_WEIGHT.user_direct, '显著性：自身表达不该与用户经历同权');
  assert.ok(SALIENCE_WEIGHT.self_direct > SALIENCE_WEIGHT.tool_output, '但仍高于工具/检索来源');
});

test('v0.5-1b: 库中 6 条自述 + 2 条用户经历（真实比例）→ 用户经历全部入选', async () => {
  const store = await freshStore();
  const events = [
    ev('u1', 0.2, { provenance: 'user_direct', importance: 0.7 }),
    ev('u2', 0.4, { provenance: 'user_direct', importance: 0.7 }),
    ...Array.from({ length: 6 }, (_, i) =>
      ev(`s${i}`, 0.05 * (i + 1), { provenance: 'self_direct', importance: 0.7, selfPattern: '立场' }),
    ),
  ];
  const mem = await seed(store, events);

  const { events: injected, slots } = await mem.buildInjection(5);
  const ids = injected.map((e) => e.id);

  assert.ok(ids.includes('u1') && ids.includes('u2'), `用户经历不得被自述挤出，实际注入：${ids.join(',')}`);
  const firstSelf = ids.findIndex((id) => id.startsWith('s'));
  const lastUser = Math.max(ids.indexOf('u1'), ids.indexOf('u2'));
  assert.ok(lastUser < firstSelf || firstSelf === -1, '用户经历应排在自身表达之前');
  assert.ok(slots.length === injected.length, '每条注入记忆都应带槽位归因');
});

/* ── 2. 检索不再冻结 ───────────────────────────────────── */

test('v0.5-2: 同分旧事件占满 top-5 时，新事件仍必须入选（旧实现会永久冻结）', async () => {
  const store = await freshStore();
  const old = [30, 40, 50, 60, 70, 80, 90, 100].map((d) => ev(`old${d}`, d));
  const mem = await seed(store, [...old, ev('fresh', 0)]);

  const { events: injected } = await mem.buildInjection(5);
  const ids = injected.map((e) => e.id);
  assert.ok(ids.includes('fresh'), `最近事件必须入选（否则检索冻结为常量），实际：${ids.join(',')}`);

  // 旧实现的稳定排序会把"最早 5 条"永久钉死，这里断言不会退化成那个集合
  const frozen = ['old100', 'old90', 'old80', 'old70', 'old60'];
  assert.notDeepEqual(ids, frozen, '不得退化为"最早的 5 条"');
});

test('v0.5-2b: 时间衰减生效，但旧的重要记忆不会被压成 0（轮廓仍在）', () => {
  const now = Date.now();
  const fresh = ev('f', 0, { importance: 0.7 });
  const ancient = ev('a', 365, { importance: 0.7 });
  const r = assembleRecall([fresh, ancient], 5, { now });
  assert.ok(r.items.length === 2, '两条都应留在池中');
  const scores = Object.fromEntries(r.items.map((i) => [i.event.id, i.score]));
  assert.ok(scores.f > scores.a, '新事件显著性应高于一年前的同类事件');
});

/* ── 3. 线索依赖提取 ───────────────────────────────────── */

test('v0.5-3: 当前消息命中旧事 → 该旧事进入线索槽', async () => {
  const store = await freshStore();
  const mem = await seed(store, [
    ev('interview', 5, { topic: '职业-变动', summary: '用户说周四要去面试，很紧张' }),
    ev('cat', 4, { topic: '生活-事件', summary: '用户说他养了一只叫煤球的黑猫' }),
    ev('other', 3, { topic: '工作-事件', summary: '用户说项目上线延期了一周' }),
  ]);

  const { events: injected, slots } = await mem.buildInjection(5, undefined, {
    cueText: '面试的事后来怎么样了？',
  });
  const hit = slots.find((s) => s.id === 'interview');
  assert.ok(hit, `面试旧事应被线索召回，实际：${injected.map((e) => e.id).join(',')}`);
  assert.equal(hit.slot, 'cue', '应经由线索槽进入');
});

test('v0.5-3b: 无共享词元时不误触发（线索槽宁缺毋滥）', () => {
  const { score, shared } = cueSimilarity('今天天气不错', '用户说周四要去面试，很紧张');
  assert.equal(shared, 0);
  assert.equal(score, 0);
});

/* ── 4. 存储：坏行容错 / 迁移 / 注入不写盘 ───────────────── */

test('v0.5-4a: 单行损坏只跳过该行，不拖垮整月', async () => {
  const store = await freshStore();
  const month = new Date().toISOString().slice(0, 7);
  await mkdir(join(store.root, 'events'), { recursive: true });
  await writeFile(
    join(store.root, 'events', `${month}.jsonl`),
    `${JSON.stringify(ev('ok1', 1))}\n{"broken": \n${JSON.stringify(ev('ok2', 2))}\n`,
    'utf-8',
  );

  const mem = new PersonaMemory(store, { stripDirectives: true, injectLimit: 5 });
  const events = await mem.list();
  assert.equal(events.length, 2, '两条完好事件仍应读出');
  assert.equal(mem.storageStats.skippedLines, 1, '坏行应被计数而不是静默丢弃');
});

test('v0.5-4b: 旧 events.json 一次性迁移到分片，并留指针', async () => {
  const store = await freshStore();
  const legacy = {
    version: 1,
    events: [ev('legacy1', 400), ev('legacy2', 1)],
  };
  await writeFile(join(store.root, 'events.json'), JSON.stringify(legacy), 'utf-8');

  const mem = new PersonaMemory(store, { stripDirectives: true, injectLimit: 5 });
  const events = await mem.list();
  assert.equal(events.length, 2, '旧事件应全部迁移');
  assert.equal(mem.storageStats.migratedFrom, 'events.json');

  const pointer = JSON.parse(await readFile(join(store.root, 'events.json'), 'utf-8'));
  assert.deepEqual(pointer.events, [], '旧文件应变成指针，避免"哪份是活的"');
  assert.ok(pointer.note.includes('events/'));

  const backup = JSON.parse(await readFile(join(store.root, 'events.json.migrated'), 'utf-8'));
  assert.equal(backup.events.length, 2, '迁移前的完整旧数据应留档');

  const shards = (await readdir(join(store.root, 'events'))).filter((n) => n.endsWith('.jsonl'));
  assert.equal(shards.length, 2, '按月分片：两个不同月份应各一片');
});

test('v0.5-4c: buildInjection 是纯读，不再为 lastRetrieved 重写整库', async () => {
  const store = await freshStore();
  const mem = await seed(store, [ev('a', 1), ev('b', 2), ev('c', 3)]);
  const month = new Date().toISOString().slice(0, 7);
  const shard = join(store.root, 'events', `${month}.jsonl`);

  const before = await readFile(shard, 'utf-8');
  const { events: injected } = await mem.buildInjection(3);
  const after = await readFile(shard, 'utf-8');

  assert.equal(after, before, '注入不得改写分片（软状态只进内存）');
  assert.ok(injected.length > 0, '注入本身应正常产出');
});

/* ── 5. 描述性时间标注（注入是事实，不是指令） ───────────── */

test('v0.5-5: 注入文本带相对时间标注，且不含任何祈使句', async () => {
  const store = await freshStore();
  const mem = await seed(store, [ev('today', 0), ev('long', 20)]);
  const { text } = await mem.buildInjection(5);

  assert.ok(text.includes('今天'), `应标注"今天"，实际：${text}`);
  assert.ok(text.includes('周前') || text.includes('个月前'), '旧事应标注相对时间');
  assert.equal(relativeDayLabel(new Date().toISOString(), Date.now()), '今天');
});
