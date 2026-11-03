/**
 * M2 自动记忆提取测试
 * - 确定性规则命中/不命中
 * - 信号分级（importance）
 * - 主题归类
 * - 命令/指令形态跳过
 * - 去重键
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidate, dedupKey, isExtractableUserMessage } from '../lib/extract.js';

/** 构造一条 session/event 形状的用户消息 */
function userMsg(text, sourceKind = 'user') {
  return {
    type: 'user/message',
    data: {
      role: 'user',
      source: { kind: sourceKind },
      content: [{ type: 'text', text }],
    },
  };
}

test('跳过命令消息', () => {
  assert.equal(extractCandidate('/persona remember 今天很开心'), null);
  assert.equal(extractCandidate('/persona state'), null);
});

test('跳过过短消息与无信号抽象讨论', () => {
  assert.equal(extractCandidate('嗯嗯'), null);
  assert.equal(extractCandidate('你觉得AI未来会怎样发展'), null);
  // 指令形态（无经历/情绪/时间信号）
  assert.equal(extractCandidate('你以后说话要更温柔一些'), null);
  assert.equal(extractCandidate('你要叫我老板'), null);
});

test('高信号：经历 + 时间/第一人称 → importance 0.8 并归类', () => {
  const c = extractCandidate('今天项目上线总算完成了，忙了整整一周');
  assert.ok(c);
  assert.equal(c.importance, 0.8);
  assert.equal(c.topic, '工作-事件');
  assert.ok(c.summary.includes('项目上线'));
});

test('中信号：情绪 + 第一人称 → importance 0.7', () => {
  const c = extractCandidate('我今天心情不太好，因为一些事有点难过');
  assert.ok(c);
  assert.equal(c.importance, 0.7);
  assert.equal(c.topic, '情感-分享');
  assert.ok(c.emotionTags.includes('难过'));
});

test('事件词优先：含方案等事件词时按工作事件 0.8', () => {
  const c = extractCandidate('我最近有点焦虑，因为月底要交一个很重要的方案');
  assert.ok(c);
  assert.equal(c.importance, 0.8);
  assert.equal(c.topic, '工作-事件');
});

test('低信号：时间 + 第一人称 → importance 0.6', () => {
  const c = extractCandidate('昨天晚上我出门散了会儿步');
  assert.ok(c);
  assert.equal(c.importance, 0.6);
});

test('偏好信号：喜欢 + 第一人称 → 心情-分享', () => {
  const c = extractCandidate('我喜欢完全超越人类的另一种存在，因为未知的事物总是让我着迷');
  assert.ok(c);
  assert.equal(c.importance, 0.7);
  assert.equal(c.topic, '心情-分享');
  assert.ok(c.emotionTags.includes('喜欢'));
});

test('健康/关系等主题归类', () => {
  assert.equal(extractCandidate('我爸上周住院了，做了个手术')?.topic, '健康-事件');
  assert.equal(extractCandidate('今天面试通过了，拿到了offer')?.topic, '职业-变动');
});

test('去重键：同主题同摘要同键，不同摘要异键', () => {
  const a = extractCandidate('今天项目上线总算完成了，忙了整整一周');
  const b = extractCandidate('今天项目上线总算完成了，忙了整整一周');
  const c = extractCandidate('今天项目上线失败了，要回滚');
  assert.equal(dedupKey(a), dedupKey(b));
  assert.notEqual(dedupKey(a), dedupKey(c));
});

test('超长摘要截断到 120 字', () => {
  const long = `今天我${'很长的经历细节'.repeat(30)}`;
  const c = extractCandidate(long);
  assert.ok(c);
  assert.ok(c.summary.length <= 120);
});

test('isExtractableUserMessage：真实用户消息可提取', () => {
  const r = isExtractableUserMessage(userMsg('今天项目上线总算完成了'));
  assert.ok(r.ok);
  assert.equal(r.text, '今天项目上线总算完成了');
});

test('isExtractableUserMessage：非 user/message 类型跳过', () => {
  assert.equal(isExtractableUserMessage({ type: 'assistant/message', data: {} }).ok, false);
  assert.equal(isExtractableUserMessage({ type: 'tool/result', data: {} }).ok, false);
});

test('isExtractableUserMessage：系统注入的 user 角色消息（source 非 user）跳过', () => {
  const runtimeCtx = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots. Current working directory: "/ho…"';
  assert.equal(isExtractableUserMessage(userMsg(runtimeCtx, 'system-prompt')).ok, false);
  assert.equal(isExtractableUserMessage(userMsg(runtimeCtx, 'unknown')).ok, false);
});

test('isExtractableUserMessage：来源字段缺失但文本特征命中运行时上下文 → 跳过', () => {
  const r = isExtractableUserMessage({
    type: 'user/message',
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier snapshots.' }],
    },
  });
  assert.equal(r.ok, false);
});

test('isExtractableUserMessage：空内容跳过', () => {
  assert.equal(isExtractableUserMessage(userMsg('   ')).ok, false);
  assert.equal(isExtractableUserMessage({ type: 'user/message', data: {} }).ok, false);
});
