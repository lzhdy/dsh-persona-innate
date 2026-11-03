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
import { extractCandidate, dedupKey, isExtractableUserMessage, isExtractableAssistantMessage, matchTimeWords } from '../lib/extract.js';

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

/** 构造一条真实 DSH 形状的 assistant 消息（表达内容在 data.message.content） */
function assistantMessage(content, extra = {}) {
  return { type: 'assistant/message', data: { message: { content }, ...extra } };
}

test('isExtractableAssistantMessage：真实结构 data.message.content 可提取', () => {
  const r = isExtractableAssistantMessage(
    assistantMessage([{ type: 'text', text: '我倾向于把休息当成投资，而不是成本。' }]),
  );
  assert.ok(r.ok);
  assert.equal(r.text, '我倾向于把休息当成投资，而不是成本。');
});

test('isExtractableAssistantMessage：reasoning+text 混合只取最后一条 text', () => {
  const r = isExtractableAssistantMessage(
    assistantMessage([
      { type: 'reasoning', text: '先分析用户的状态，区分累和透支……' },
      { type: 'text', text: '你现在更像透支，而不是普通的累。' },
    ]),
  );
  assert.ok(r.ok);
  assert.equal(r.text, '你现在更像透支，而不是普通的累。');
});

test('isExtractableAssistantMessage：从后往前取最后一条 text，跳过尾部 tool_call', () => {
  const r = isExtractableAssistantMessage(
    assistantMessage([
      { type: 'text', text: '第一条表达。' },
      { type: 'tool_call', text: '调用工具' },
      { type: 'thinking', text: '内部思考' },
    ]),
  );
  assert.ok(r.ok);
  assert.equal(r.text, '第一条表达。');
});

test('isExtractableAssistantMessage：type 缺失的文本块按 text 处理', () => {
  const r = isExtractableAssistantMessage(
    assistantMessage([{ text: '没有 type 字段的表达。' }]),
  );
  assert.ok(r.ok);
  assert.equal(r.text, '没有 type 字段的表达。');
});

test('isExtractableAssistantMessage：兼容旧结构 data.content 回退', () => {
  const r = isExtractableAssistantMessage({
    type: 'assistant/message',
    data: { content: [{ type: 'text', text: '回退路径的表达。' }] },
  });
  assert.ok(r.ok);
  assert.equal(r.text, '回退路径的表达。');
});

test('isExtractableAssistantMessage：非 assistant/message 或无 text 跳过', () => {
  assert.equal(isExtractableAssistantMessage({ type: 'user/message', data: {} }).ok, false);
  assert.equal(
    isExtractableAssistantMessage(
      assistantMessage([{ type: 'reasoning', text: '只有推理没有表达。' }]),
    ).ok,
    false,
  );
  assert.equal(isExtractableAssistantMessage({ type: 'assistant/message', data: {} }).ok, false);
});

test('isExtractableAssistantMessage：系统注入文本跳过', () => {
  const r = isExtractableAssistantMessage(
    assistantMessage([
      { type: 'text', text: 'Current runtime context. This snapshot supersedes earlier snapshots.' },
    ]),
  );
  assert.equal(r.ok, false);
});

/* ════════════ P2：星期/时间词召回（最长优先 + 词边界锚定） ════════════ */

test('matchTimeWords：「周末」整体命中、不被拆', () => {
  assert.deepEqual(matchTimeWords('周末'), ['周末']);
  assert.deepEqual(matchTimeWords('周末愉快'), ['周末']);
});

test('matchTimeWords：「周日」命中周日、不误判为周末前缀', () => {
  const hits = matchTimeWords('周日');
  assert.deepEqual(hits, ['周日']);
  assert.equal(hits.includes('周末'), false);
});

test('matchTimeWords：「下周一」命中周一、而非下周', () => {
  const hits = matchTimeWords('下周一');
  assert.deepEqual(hits, ['周一']);
  assert.equal(hits.includes('下周'), false);
});

test('matchTimeWords：星期一~星期日整体识别、不降级为周X', () => {
  assert.deepEqual(matchTimeWords('星期一'), ['星期一']);
  assert.deepEqual(matchTimeWords('星期日'), ['星期日']);
  assert.deepEqual(matchTimeWords('这周三'), ['周三']);
  assert.deepEqual(matchTimeWords('下周末'), ['周末']);
});

test('matchTimeWords：周一~周日 全部可召回', () => {
  const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  for (const d of days) assert.deepEqual(matchTimeWords(`我${d}去上班`), [d]);
});

test('matchTimeWords：普通时间词带数字不被词边界误伤', () => {
  assert.deepEqual(matchTimeWords('下午三点'), ['下午']);
  assert.deepEqual(matchTimeWords('晚上七点见面'), ['晚上']);
});

test('matchTimeWords：多个时间词按位置返回；无时间词返回空数组', () => {
  assert.deepEqual(matchTimeWords('周六和周日'), ['周六', '周日']);
  assert.deepEqual(matchTimeWords('这是一段没有任何时间信号的抽象讨论文字'), []);
});

test('extractCandidate：含星期词的经历分享可被提取', () => {
  const cand = extractCandidate('我下周一打算去医院做个全面体检，提前预约好了');
  assert.ok(cand);
  assert.equal(cand.topic, '健康-事件');
});
