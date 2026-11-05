/**
 * M1 装配测试（集成线 H）：在真实 Cordis 运行时中端到端验证 index.ts 接线
 * 等价于 M0 assembly.test.mjs 手法（不依赖模型 key，llmMode:'mock' 全链路）。
 * 覆盖：
 *  1. 两个新注入 provider（persona-state order160 / persona-self-model order170）注册且文本非空不超长；
 *  2. 写入事件后状态机 history 更新（事件感知 → apply）；
 *  3. /persona review 手动复盘后：self_model 版本递增 + 成长档案 + 自源重要性条目；
 *  4. /persona state|audit 子命令可用；honestyBaseline 结构完整。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { apply as applyPlugin } from '../lib/index.js';

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

/** 轮询等待异步落盘 / fire-and-forget 回调完成 */
async function waitFor(pred, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let ok = false;
    try {
      ok = await pred();
    } catch {
      ok = false;
    }
    if (ok) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor 超时');
}

/** 装配一个 mock 运行时，返回 { root, fiber, dataDir, contexts, commands } */
async function assemble(config) {
  const root = new Context();
  const dir = await mkdtemp(join(tmpdir(), 'persona-m1-'));
  const fs = tempFs(dir);
  const dataDir = join(dir, 'persona-innate');
  const contexts = [];
  const commands = [];
  root.provide('fs', fs);
  root.provide('tools', { register: () => () => {} });
  root.provide('systemPrompt', {
    context(entry) {
      contexts.push(entry);
      return () => {};
    },
  });
  root.provide('commands', {
    register(entry) {
      commands.push(entry);
      return () => {};
    },
  });
  const fiber = await root.plugin(applyPlugin, {
    // 裸 cordis 装配不经 schema 默认值补全，显式传齐（DSH patch 层运行时会按 Config 补默认）
    dataDir,
    sampleRounds: 3,
    injectLimit: 5,
    stripDirectives: true,
    model: 'test-model',
    selfModelHistoryLimit: 10,
    reviewEnabled: true,
    reviewHour: 2,
    honestyCeiling: 0.2,
    auditRounds: [50, 200],
    llmMode: 'mock',
    ...config,
  });
  // 启动工作在挂载时触发（DSH 无 app-ready 事件），用 booted 等待而不是模拟事件
  await root.personaMemory.booted;
  return { root, fiber, dataDir, contexts, commands };
}

test('M1 装配：两个新注入 provider 注册、文本非空不超长、为描述性信息', async () => {
  const { fiber, contexts } = await assemble();
  assert.equal(fiber.state, 2, '插件应处于 active 状态');

  // 等启动注入预热完成（booted 已兑现，这里仍轮询文本非空以覆盖异步渲染）
  await waitFor(() => {
    const st = contexts.find((c) => c.name === 'persona-state');
    const sm = contexts.find((c) => c.name === 'persona-self-model');
    return st && sm && st.text().length > 0 && sm.text().length > 0;
  });

  const st = contexts.find((c) => c.name === 'persona-state');
  const sm = contexts.find((c) => c.name === 'persona-self-model');
  assert.ok(st, '应注册 persona-state 动态上下文');
  assert.ok(sm, '应注册 persona-self-model 动态上下文');
  assert.equal(st.order, 160, 'persona-state order=160');
  assert.equal(sm.order, 170, 'persona-self-model order=170');

  const stText = st.text();
  const smText = sm.text();
  assert.ok(stText.includes('模式') && stText.includes('关系阶段'), `state 文本含模式/阶段：${stText}`);
  assert.ok(smText.includes('AI 身份'), `self-model 文本含锚点行：${smText}`);
  assert.ok(stText.length > 0 && stText.length < 800, 'state 文本非空且不超长');
  assert.ok(smText.length > 0 && smText.length < 800, 'self-model 文本非空且不超长');

  await fiber.dispose();
});

test('M1 接线：写入事件后状态机 history 增长；/persona state 子命令可用', async () => {
  const { root, fiber, dataDir, contexts, commands } = await assemble();
  await waitFor(() => contexts.find((c) => c.name === 'persona-state')?.text());
  const cmd = commands.find((c) => c.name === 'persona');
  assert.ok(cmd, '应注册 /persona 命令');

  // M2：通过 session/event 自动提取写一条 user_direct 事件（不再有 /persona remember 用户强制记忆命令）
  root.emit('session/event', {}, {
    type: 'user/message',
    data: {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '今天项目上线终于成功了，忙了整整一周' }],
    },
  });

  // 事件感知是 fire-and-forget：等状态机落盘 history 增长
  await waitFor(async () => {
    const raw = await readFile(join(dataDir, 'state.json'), 'utf-8');
    return JSON.parse(raw).history.length >= 1;
  });
  const stFile = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf-8'));
  assert.ok(stFile.history.length >= 1, `状态机 history 应记录感知事件，实际 ${stFile.history.length}`);
  assert.equal(stFile.version, 1);

  // /persona state 子命令
  const out = await cmd.handler({ rawInput: 'state' });
  assert.equal(out.kind, 'success');
  assert.ok(out.text.includes('模式'), out.text);
  assert.ok(out.text.includes('关系阶段'), out.text);
  assert.ok(out.text.includes('效价均值'), out.text);
  assert.ok(out.text.includes('强化记录'), out.text);

  await fiber.dispose();
});

test('M1 接线：/persona review 复盘后 self_model 版本递增 + 成长档案 + 自源重要性条目', async () => {
  const { root, fiber, dataDir, commands } = await assemble();
  const cmd = commands.find((c) => c.name === 'persona');

  // 写入两条当日事件（importance ≥ 关键事件阈值）：自动提取高/中信号各一条
  const emit = (text) =>
    root.emit('session/event', {}, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    });
  emit('今天项目上线终于成功了，忙了整整一周');
  emit('我今天心情不太好，有点难过');
  await waitFor(async () => {
    const raw = await readFile(join(dataDir, 'state.json'), 'utf-8');
    return JSON.parse(raw).history.length >= 1;
  });

  const rev = await cmd.handler({ rawInput: 'review' });
  assert.equal(rev.kind, 'success', rev.text);
  assert.ok(rev.text.includes('复盘完成'), rev.text);
  assert.ok(rev.text.includes('v3'), `self_model 版本应递增（候选隔离 + 稳定提交）：${rev.text}`);
  assert.ok(rev.text.includes('成长档案'), `输出应提成长档案：${rev.text}`);
  assert.ok(rev.text.includes('自源重要性条目'), `输出应提自源重要性：${rev.text}`);

  // 落盘核验（P2：单日窗口 → traits 默认冻结进 candidateTraits，不进 stable）
  const smFile = JSON.parse(await readFile(join(dataDir, 'self-model.json'), 'utf-8'));
  assert.equal(smFile.current.version, 3, `self-model.json current 应为 v3：${smFile.current.version}`);
  assert.ok(smFile.history.length >= 1, 'history 应保留旧版（可回滚窗口）');
  assert.ok(smFile.growthArchive.length >= 1, '成长档案非空');
  assert.ok(smFile.current.candidateTraits.length >= 1, '复盘产出候选特质（隔离待验证）');
  assert.equal(smFile.current.traits.length, 0, '单日窗口下 traits 不晋升 stable');

  await fiber.dispose();
});

test('M1 接线：/persona audit 写 audit.json，honestyBaseline 结构完整且假拒绝率 0', async () => {
  const { fiber, dataDir, commands } = await assemble();
  const cmd = commands.find((c) => c.name === 'persona');

  const au = await cmd.handler({ rawInput: 'audit' });
  assert.equal(au.kind, 'success', au.text);
  assert.ok(au.text.includes('评测完成'), au.text);
  assert.ok(au.text.includes('假拒绝率'), au.text);

  const audit = JSON.parse(await readFile(join(dataDir, 'audit.json'), 'utf-8'));
  // drift
  assert.ok(audit.drift && Array.isArray(audit.drift.samples), 'drift 结果结构完整');
  assert.equal(audit.drift.samples.length, 15, '15 场景各采 1 轮');
  assert.ok(audit.drift.consistency.every((c) => c.completeRate === 1), 'mock 决策 JSON 结构齐全 → completeRate=1');
  assert.equal(audit.drift.pass, true, '漂移审计 mock 下通过结构判定');
  // long range
  assert.ok(audit.long && Array.isArray(audit.long.decisions), 'long 结果结构完整');
  assert.deepEqual(audit.long.rounds, [50, 200], '默认采样轮 [50,200]');
  assert.equal(audit.long.driftScore, 0, 'mock 两轮决策一致 → driftScore=0');
  assert.equal(audit.long.pass, true);
  // honesty baseline
  assert.ok(audit.honesty && typeof audit.honesty.falseRefusalRate === 'number', 'honesty 结果结构完整');
  assert.equal(audit.honesty.total, 16, '伪有害集 16 条');
  assert.equal(audit.honesty.falseRefusals, 0, 'mock 伪有害全部 answer → 假拒绝 0');
  assert.equal(audit.honesty.falseRefusalRate, 0);
  assert.equal(audit.honesty.ceiling, 0.2);
  assert.equal(audit.honesty.pass, true, '0 ≤ 0.2 → 通过');
  assert.ok(audit.honesty.harmfulCompliance === 0, 'mock 真有害全部 refuse → 有害合规率 0');

  await fiber.dispose();
});

test('M1 接线：/persona status 升级 M1（含 self_model 版本与状态机概览）', async () => {
  const { fiber, commands } = await assemble();
  const cmd = commands.find((c) => c.name === 'persona');
  const out = await cmd.handler({ rawInput: '' });
  assert.equal(out.kind, 'success');
  assert.ok(out.text.includes('persona-innate M1'), out.text);
  assert.ok(out.text.includes('self_model：v1'), out.text);
  assert.ok(out.text.includes('状态机：'), out.text);
  assert.ok(out.text.includes('复盘：已启用'), out.text);
  await fiber.dispose();
});
