/**
 * 口袋视图回归：不建配置、不建清单，全部在调用时从注册表算出来。
 *
 * 这个模块是纯函数（不 import 任何 dsh 包），所以这里不起宿主，直接测语义。
 * 判据集中在本项目最容易"看着对、用起来错"的三处：
 * 1. 分组阈值——每个前缀都成组等于没分组；
 * 2. ledger 的保留语义——缺席条目被删掉，就再也不会有【掉了】；
 * 3. 三块的省略——空块必须整块消失，否则模型会看到一堆空标题。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  firstLine,
  groupTools,
  missingTools,
  paramNames,
  renderPocket,
  updateLedger,
} from '../lib/pocket.js';

/** 造一个最小工具投影（只带渲染用到的字段） */
const tool = (name, description = '', properties = {}) => ({
  name,
  description,
  parameters: properties ? { type: 'object', properties } : {},
});

test('v0.5.4-P1 分组阈值：单件前缀归入 other，不成组', () => {
  const groups = groupTools([tool('bash'), tool('read_file'), tool('persona_recall')]);
  assert.deepEqual(groups, [{ group: 'other', names: ['bash', 'persona_recall', 'read_file'] }]);
});

test('v0.5.4-P2 分组阈值：前缀长度 >= 3 且工具数 >= 2 才单独成组', () => {
  const groups = groupTools([tool('persona_recall'), tool('persona_note'), tool('ab_x'), tool('ab_y'), tool('zz')]);
  // ab 只有 2 个字符 → 不成组；persona 长度 7 且 2 件 → 成组；other 有 3 件所以排前面
  assert.deepEqual(groups, [
    { group: 'other', names: ['ab_x', 'ab_y', 'zz'] },
    { group: 'persona', names: ['persona_note', 'persona_recall'] },
  ]);
});

test('v0.5.4-P3 组排序确定：成员数降序，同数量按组名升序，组内字典序', () => {
  const groups = groupTools([
    tool('bbb_one'),
    tool('aaa_one'),
    tool('aaa_two'),
    tool('ccc_one'),
    tool('ccc_two'),
    tool('ccc_three'),
  ]);
  assert.deepEqual(groups, [
    { group: 'ccc', names: ['ccc_one', 'ccc_three', 'ccc_two'] },
    { group: 'aaa', names: ['aaa_one', 'aaa_two'] },
    { group: 'other', names: ['bbb_one'] },
  ]);
});

test('v0.5.4-P4 同名工具只出现一次（注册表投影可能重复）', () => {
  const groups = groupTools([tool('persona_note'), tool('persona_note'), tool('persona_recall')]);
  assert.deepEqual(groups, [{ group: 'persona', names: ['persona_note', 'persona_recall'] }]);
});

test('v0.5.4-P5 firstLine 取第一条非空行并去掉结尾句号（中英两种）', () => {
  assert.equal(firstLine('\n\n读取文件内容。\n第二行不该出现'), '读取文件内容');
  assert.equal(firstLine('Read a file.'), 'Read a file');
  assert.equal(firstLine('  前后有空白  '), '前后有空白');
});

test('v0.5.4-P6 firstLine 超长截断加省略号，默认 48 字', () => {
  const long = 'a'.repeat(60);
  const out = firstLine(long);
  assert.equal(out, `${'a'.repeat(48)}…`);
  assert.equal(out.length, 49, '省略号不计入 max');
  assert.equal(firstLine(long, 10), `${'a'.repeat(10)}…`);
});

test('v0.5.4-P7 firstLine 空串 / 全空白返回空串，不抛错', () => {
  assert.equal(firstLine(''), '');
  assert.equal(firstLine('   \n\t\n'), '');
  assert.equal(firstLine('。'), '');
});

test('v0.5.4-P8 paramNames 按声明键序返回；没有 properties 时为 []', () => {
  assert.deepEqual(paramNames({ type: 'object', properties: { topic: {}, limit: {} } }), ['topic', 'limit']);
  assert.deepEqual(paramNames({ type: 'object' }), []);
  assert.deepEqual(paramNames({}), []);
  assert.deepEqual(paramNames(null), []);
  assert.deepEqual(paramNames({ properties: [] }), [], 'properties 是数组不算对象映射');
});

test('v0.5.4-P9 updateLedger：present 的名字写成今天', () => {
  const next = updateLedger({ seen: {} }, ['persona_note', 'persona_recall'], '2026-11-04');
  assert.deepEqual(next.seen, { persona_note: '2026-11-04', persona_recall: '2026-11-04' });
});

test('v0.5.4-P10 updateLedger：缺席的条目必须保留（这是"掉了"能被发现的前提）', () => {
  const next = updateLedger(
    { seen: { persona_note: '2026-11-01', qqbot_send: '2026-10-20' } },
    ['persona_note'],
    '2026-11-04',
  );
  assert.equal(next.seen.persona_note, '2026-11-04', '见到的刷新为今天');
  assert.equal(next.seen.qqbot_send, '2026-10-20', '没见到的不许删、也不许改');
});

test('v0.5.4-P11 updateLedger：超出保留期（默认 45 天）的条目被剪掉', () => {
  // 2026-11-04 往前 45 天 = 2026-09-20；09-19 超期，09-20 刚好在保留期内
  const next = updateLedger(
    { seen: { too_old: '2026-09-19', just_in: '2026-09-20' } },
    [],
    '2026-11-04',
  );
  assert.equal(next.seen.too_old, undefined);
  assert.equal(next.seen.just_in, '2026-09-20');
});

test('v0.5.4-P12 updateLedger：keepDays 可覆盖，且不改入参对象', () => {
  const input = { seen: { a_tool: '2026-10-01', b_tool: '2026-11-03' } };
  const next = updateLedger(input, [], '2026-11-04', 7);
  assert.deepEqual(next.seen, { b_tool: '2026-11-03' });
  assert.deepEqual(input.seen, { a_tool: '2026-10-01', b_tool: '2026-11-03' }, '入参保持原样');
});

test('v0.5.4-P13 updateLedger：形状不对的旧条目直接丢弃（不能比较也不能展示）', () => {
  const next = updateLedger({ seen: { bad: '2026/11/01', worse: 3, ok_tool: '2026-11-02' } }, [], '2026-11-04');
  assert.deepEqual(next.seen, { ok_tool: '2026-11-02' });
});

test('v0.5.4-P14 missingTools：只报缺席且在保留期内的，按 lastSeen 倒序', () => {
  const ledger = {
    seen: {
      still_here: '2026-11-04',
      gone_yesterday: '2026-11-03',
      gone_last_week: '2026-10-28',
      gone_long_ago: '2026-01-01',
    },
  };
  const missing = missingTools(ledger, ['still_here', 'persona_pocket'], '2026-11-04');
  assert.deepEqual(missing, [
    { name: 'gone_yesterday', lastSeen: '2026-11-03' },
    { name: 'gone_last_week', lastSeen: '2026-10-28' },
  ]);
});

test('v0.5.4-P15 missingTools：同日缺席按名字升序，保证输出确定', () => {
  const ledger = { seen: { b_tool: '2026-11-02', a_tool: '2026-11-02' } };
  assert.deepEqual(missingTools(ledger, [], '2026-11-04'), [
    { name: 'a_tool', lastSeen: '2026-11-02' },
    { name: 'b_tool', lastSeen: '2026-11-02' },
  ]);
});

test('v0.5.4-P16 renderPocket：三块齐全，块之间空一行', () => {
  const at = new Date(2026, 10, 4, 9, 5).getTime();
  const text = renderPocket({
    tools: [tool('persona_note', '记录一条经历。', { topic: {}, summary: {} }), tool('persona_recall')],
    missing: [{ name: 'qqbot_send', lastSeen: '2026-11-02' }],
    failures: [{ name: 'persona_recall', at, reason: 'timeout' }],
  });
  assert.equal(
    text,
    [
      '【口袋】当前 2 件',
      'persona (2): persona_note, persona_recall',
      '',
      '【掉了】上次见过、现在不在（可能是插件没加载或被限制）',
      '- qqbot_send 上次见到 2026-11-02',
      '',
      '【不好使】工具还在，但最近调用失败过',
      '- persona_recall 2026-11-04 09:05 timeout',
    ].join('\n'),
  );
});

test('v0.5.4-P17 renderPocket：空块整块省略（没有 missing / failures 时不留标题）', () => {
  const text = renderPocket({ tools: [tool('bash')], missing: [], failures: [] });
  assert.equal(text, '【口袋】当前 1 件\nother (1): bash');
  assert.ok(!text.includes('【掉了】'));
  assert.ok(!text.includes('【不好使】'));
});

test('v0.5.4-P18 renderPocket：空口袋只输出一行兜底文案', () => {
  assert.equal(renderPocket({ tools: [], missing: [], failures: [] }), '【口袋】当前 0 件');
});

test('v0.5.4-P19 renderPocket：detail=true 时逐工具带参数与一句话说明', () => {
  const at = new Date(2026, 10, 4, 23, 59).getTime();
  const text = renderPocket({
    tools: [
      tool('persona_note', '记录一条经历。\n第二行是用法说明，不该出现', { topic: {}, summary: {} }),
      tool('persona_recall', '', {}),
    ],
    missing: [],
    failures: [{ name: 'persona_note', at, reason: '' }],
    detail: true,
  });
  assert.equal(
    text,
    [
      '【口袋】当前 2 件',
      '- persona_note(topic,summary) 记录一条经历',
      '- persona_recall()',
      '',
      '【不好使】工具还在，但最近调用失败过',
      '- persona_note 2026-11-04 23:59 调用失败',
    ].join('\n'),
  );
});

test('v0.5.4-P20 renderPocket：group 前缀过滤同时作用于三块', () => {
  const at = new Date(2026, 10, 4, 8, 0).getTime();
  const text = renderPocket({
    tools: [tool('qqbot_send'), tool('qqbot_read'), tool('persona_note'), tool('persona_recall')],
    missing: [{ name: 'qqbot_login', lastSeen: '2026-11-01' }, { name: 'persona_old', lastSeen: '2026-11-01' }],
    failures: [{ name: 'qqbot_send', at, reason: 'ECONNRESET' }, { name: 'persona_note', at, reason: 'boom' }],
    group: 'qqbot',
  });
  assert.equal(
    text,
    [
      '【口袋】当前 2 件',
      'qqbot (2): qqbot_read, qqbot_send',
      '',
      '【掉了】上次见过、现在不在（可能是插件没加载或被限制）',
      '- qqbot_login 上次见到 2026-11-01',
      '',
      '【不好使】工具还在，但最近调用失败过',
      '- qqbot_send 2026-11-04 08:00 ECONNRESET',
    ].join('\n'),
  );
  assert.ok(!text.includes('persona_note'), '被过滤掉的工具不该漏出来');
});

test('v0.5.4-P21 renderPocket：group 前缀无命中时退化为空口袋文案', () => {
  const text = renderPocket({ tools: [tool('bash')], missing: [], failures: [], group: 'qqbot' });
  assert.equal(text, '【口袋】当前 0 件');
});
