/**
 * self_model 服务测试（对应 m1-interface-design §2 冻结导出面 + §9 机制）
 * 覆盖：
 * 1) 种子快照含存在论锚点 / 空特质 / 说话方式占位
 * 2) commit 版本递增与 history 截断（N=2 验证）
 * 3) 一致性检查两处抛错（新特质无证据 / 重大转变缺 changeNote）
 * 4) rollback 生效且版本单调（找不到返回 null）
 * 5) appendGrowth 落盘
 * 6) getInjectionSummary 两种形态（null 仅锚点行 / 有值固定四行）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/store.js';
import {
  EXISTENTIAL_ANCHOR,
  DEFAULT_SELF_MODEL_VERSION_LIMIT,
  SelfModelService,
  seedInitialSnapshot,
} from '../lib/self-model.js';

/** 临时目录版 FsLike（与 m0 测试同一份手法，模拟 DSH ctx.fs 语义） */
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
  const dir = await mkdtemp(join(tmpdir(), 'persona-sm-'));
  const store = new JsonStore(tempFs(dir), dir);
  store.root = dir; // 测试直接读落盘文件用
  return store;
}

function readFileRaw(store) {
  return readFile(join(store.root, 'self-model.json'), 'utf-8');
}

test('种子快照：存在论锚点 + 空特质 + 说话方式占位', () => {
  const s = seedInitialSnapshot();
  assert.equal(s.version, 1, '首版版本号为 1');
  assert.equal(s.aiIdentity, EXISTENTIAL_ANCHOR, 'aiIdentity 常驻存在论锚点');
  assert.equal(s.speakingStyle, '（未成形）', '说话方式占位');
  assert.deepEqual(s.traits, [], '种子特质为空');
  assert.deepEqual(s.preferences, [], '种子偏好为空');
  assert.equal(s.relationshipView, '', '种子关系认知为空串');
  assert.equal(s.narrative, '', '种子叙事为空串');
  assert.deepEqual(s.sourceEventIds, [], '种子证据链为空');
  assert.ok(
    s.sourceTraces?.metacognition?.includes(EXISTENTIAL_ANCHOR),
    '种子 sourceTraces.metacognition 记录锚点',
  );
});

test('常量冻结面：DEFAULT_SELF_MODEL_VERSION_LIMIT = 10', () => {
  assert.equal(DEFAULT_SELF_MODEL_VERSION_LIMIT, 10);
});

test('服务首载自动落盘种子（自我模型始终含锚点）', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store);
  const current = await svc.load();
  assert.ok(current, '首载应返回种子快照');
  assert.equal(current?.version, 1);
  assert.equal(current?.aiIdentity, EXISTENTIAL_ANCHOR);

  const raw = JSON.parse(await readFileRaw(store));
  assert.equal(raw.version, 1, '落盘文件 version=1');
  assert.ok(raw.current, '落盘文件含 current');
  assert.deepEqual(raw.history, [], '种子阶段 history 为空');
  assert.deepEqual(raw.growthArchive, [], '种子阶段成长档案为空');
});

test('commit：版本递增、字段合并、sourceTraces/sourceEventIds 记录，跨实例可读', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store);
  await svc.load(); // 种子 v1

  const v2 = await svc.commitFromSources(
    { traits: ['在意被记住'], speakingStyle: '先复述再回应' },
    ['e-1', 'e-2'],
    ['reflection'],
  );
  assert.equal(v2.version, 2, 'commit 后版本 = max+1');
  assert.deepEqual(v2.traits, ['在意被记住'], '特质按 diff 合并');
  assert.equal(v2.speakingStyle, '先复述再回应', '说话方式按 diff 更新');
  assert.equal(v2.relationshipView, '', '未 diff 的字段保持种子空值');
  assert.deepEqual(v2.sourceEventIds, ['e-1', 'e-2'], '证据链落快照');
  assert.deepEqual(v2.sourceTraces?.reflection, ['e-1', 'e-2'], 'sourceTraces 按来源记录证据');
  assert.equal(v2.aiIdentity, EXISTENTIAL_ANCHOR, '锚点常驻不变');

  // 第二个实例（模拟跨会话）应读到同一 current
  const svcB = new SelfModelService(store);
  const cur = await svcB.load();
  assert.equal(cur?.version, 2);
  assert.ok(cur?.traits.includes('在意被记住'));
});

test('commit：history 截断（N=2 验证）', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store, { historyLimit: 2 });
  await svc.load(); // 种子 v1
  await svc.commitFromSources({ traits: ['t1'] }, ['e1'], ['reflection']); // v2
  await svc.commitFromSources({ traits: ['t2'] }, ['e2'], ['reflection']); // v3
  await svc.commitFromSources({ traits: ['t3'] }, ['e3'], ['reflection']); // v4

  const history = await svc.listHistory();
  assert.equal(history.length, 2, 'history 按 N=2 截断，只保留最近 2 版');
  const versions = history.map((h) => h.version);
  assert.deepEqual(versions, [2, 3], 'history 为被挤下 current 的旧快照 [v2, v3]，v1 已超出窗口被截断');

  const cur = await svc.load();
  assert.equal(cur?.version, 4, 'current 始终为最新提交');
  assert.ok(cur?.traits.includes('t3'));
});

test('一致性检查：新特质缺少事件证据 → 抛错且版本不推进', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store);
  await svc.load(); // 种子 v1

  await assert.rejects(
    () => svc.commitFromSources({ traits: ['新特质X'] }, [], ['reflection']),
    /consistency: 新特质缺少事件证据/,
  );

  const cur = await svc.load();
  assert.equal(cur?.version, 1, '抛错后不得产生新版本');
  assert.deepEqual(cur?.traits, [], '抛错后特质不得写入');

  // 同样 diff 但带证据 → 通过
  const ok = await svc.commitFromSources({ traits: ['新特质X'] }, ['e-9'], ['reflection']);
  assert.equal(ok.version, 2);
  assert.ok(ok.traits.includes('新特质X'));
});

test('一致性检查：叙事重大转变缺少 changeNote → 抛错；带 changeNote 通过', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store);
  await svc.load(); // 种子 v1（narrative=''）

  await assert.rejects(
    () =>
      svc.commitFromSources(
        { narrative: '我们的相处方式发生了根本变化……' },
        ['e1'],
        ['reflection'],
      ),
    /consistency: 重大转变缺少 changeNote/,
  );

  const cur = await svc.load();
  assert.equal(cur?.version, 1, '抛错后版本不推进');

  // 同一叙事 diff 附 changeNote → 通过
  const ok = await svc.commitFromSources(
    { narrative: '我们的相处方式发生了根本变化……' },
    ['e1'],
    ['reflection'],
    '关系阶段跃迁的叙事解释',
  );
  assert.equal(ok.version, 2);
  assert.equal(ok.changeNote, '关系阶段跃迁的叙事解释');
  assert.ok(ok.narrative.includes('根本变化'));
});

test('rollback：找不到返回 null；找到则生成新版本且版本单调', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store, { historyLimit: 5 });
  await svc.load(); // v1 种子
  await svc.commitFromSources({ traits: ['t1'] }, ['e1'], ['reflection']); // v2
  await svc.commitFromSources(
    { traits: ['t2'], narrative: '新叙事：我们开始有默契了。' },
    ['e2'],
    ['reflection'],
    '默契形成的转变',
  ); // v3

  const missing = await svc.rollback(999);
  assert.equal(missing, null, '不存在的版本返回 null');

  const rolled = await svc.rollback(2);
  assert.ok(rolled, '回滚到存在版本应返回新快照');
  assert.equal(rolled?.version, 4, '回滚生成新版本 = max+1，而非覆盖');
  assert.deepEqual(rolled?.traits, ['t1'], '新快照字段取自 v2');
  assert.equal(rolled?.narrative, '', 'v2 无叙事 → 回滚后叙事回到 v2 状态');
  assert.equal(rolled?.changeNote, 'rollback:2', 'changeNote 标注 rollback:vN');
  assert.ok(
    rolled?.sourceTraces?.continuity?.includes('回滚自 v2'),
    'sourceTraces.continuity 注明回滚来源',
  );
  assert.equal(rolled?.aiIdentity, EXISTENTIAL_ANCHOR, '锚点跨版本常驻');

  // 再回滚一次（到 v3），版本严格单调
  const again = await svc.rollback(3);
  assert.equal(again?.version, 5, '版本继续单调递增');
  assert.ok(again?.traits.includes('t2'));

  const history = await svc.listHistory();
  assert.ok(history.some((h) => h.version === 4), '被回滚替换掉的 current 也应进入 history');
});

test('appendGrowth：成长档案落盘并可追加', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store);
  await svc.appendGrowth({
    id: 'g-1',
    date: '2026-11-02',
    stage: 'forming',
    summary: '第一周：说话方式开始收敛',
    narrativeDelta: ['开始有默契'],
    eventRefs: ['e1', 'e2'],
  });
  await svc.appendGrowth({
    id: 'g-2',
    date: '2026-11-03',
    stage: 'shaping',
    summary: '第二周：特质固化',
    narrativeDelta: ['特质 t1 固化'],
    eventRefs: ['e3'],
  });

  const raw = JSON.parse(await readFileRaw(store));
  assert.equal(raw.growthArchive.length, 2, '成长档案只追加');
  assert.equal(raw.growthArchive[0].id, 'g-1');
  assert.equal(raw.growthArchive[1].stage, 'shaping');
});

test('getInjectionSummary：null 仅锚点行；有值为固定四行格式；空值占位', () => {
  const svc = new SelfModelService(null);

  // 形态一：null → 仅锚点行
  const anchorOnly = svc.getInjectionSummary(null);
  assert.equal(anchorOnly, EXISTENTIAL_ANCHOR, 'null 时仅返回锚点行');

  // 形态二：有值 → 固定四行（KV cache 前缀稳定）
  const text = svc.getInjectionSummary({
    version: 3,
    createdAt: new Date().toISOString(),
    traits: ['t1'],
    preferences: ['p1'],
    speakingStyle: '先确认再展开',
    relationshipView: '用户把我当可以倾诉的对象',
    narrative: '第一周我们一起整理了资料。之后第二次对话延续了这个节奏。',
    aiIdentity: EXISTENTIAL_ANCHOR,
    sourceEventIds: ['e1'],
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '【自我模型（摘要）】');
  assert.equal(lines.length, 5, '固定四行内容 + 头部 = 5 行');
  assert.equal(lines[1], '说话方式：先确认再展开');
  assert.equal(lines[2], '叙事：第一周我们一起整理了资料。', '叙事取首句');
  assert.equal(lines[3], '关系认知：用户把我当可以倾诉的对象');
  assert.ok(lines[4].startsWith('AI 身份：'));
  assert.ok(lines[4].includes(EXISTENTIAL_ANCHOR));

  // 空值占位形态
  const empty = svc.getInjectionSummary({
    version: 1,
    createdAt: new Date().toISOString(),
    traits: [],
    preferences: [],
    speakingStyle: '',
    relationshipView: '',
    narrative: '',
    aiIdentity: EXISTENTIAL_ANCHOR,
    sourceEventIds: [],
  });
  const emptyLines = empty.split('\n');
  assert.equal(emptyLines[1], '说话方式：未成形');
  assert.equal(emptyLines[2], '叙事：无');
  assert.equal(emptyLines[3], '关系认知：无');
});
