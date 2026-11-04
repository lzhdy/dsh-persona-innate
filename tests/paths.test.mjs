import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveDataDir } from '../lib/paths.js';

const SUBDIR = join('.dsh', 'persona-innate');
const warnings = [];
const warn = (m) => warnings.push(m);

test('undefined / null（未配置）→ 自动定位默认 home，source=auto', () => {
  const a = resolveDataDir(undefined, warn);
  const b = resolveDataDir(null, warn);
  assert.equal(a.source, 'auto');
  assert.equal(b.source, 'auto');
  assert.ok(a.root.endsWith(SUBDIR), a.root);
  assert.equal(a.root, b.root);
});

test('空字符串（显式无效）→ warn 并回退，source=empty-fallback', () => {
  warnings.length = 0;
  const r = resolveDataDir('', warn);
  assert.equal(r.source, 'empty-fallback');
  assert.ok(r.root.endsWith(SUBDIR));
  assert.equal(warnings.length, 1);
});

test('显式绝对路径 → 尊重，source=explicit', () => {
  const input = '/var/data/my-persona';
  const r = resolveDataDir(input, warn);
  assert.equal(r.source, 'explicit');
  // win32 下 resolve() 会把 POSIX 绝对路径映射到当前盘符（C:\var\...），这是平台语义，
  // 断言的是"显式路径被尊重且归一化"，不是"resolve 是恒等函数"。
  assert.equal(r.root, process.platform === 'win32' ? resolve(input) : input);
});

test('显式路径支持 ~/ 展开（非 win32）', () => {
  if (process.platform === 'win32') return;
  const r = resolveDataDir('~/custom/persona', warn);
  assert.equal(r.source, 'explicit');
  assert.equal(r.root, join(homedir(), 'custom/persona'));
});

test('$DSH_HOME 环境变量：自动路径落到该 home 下', () => {
  const prev = process.env.DSH_HOME;
  const fakeHome = '/tmp/fake-dsh-home';
  process.env.DSH_HOME = fakeHome;
  try {
    const r = resolveDataDir(undefined, warn);
    // 期望值同样按平台语义归一化（win32 → C:\tmp\fake-dsh-home）
    assert.equal(r.root, join(process.platform === 'win32' ? resolve(fakeHome) : fakeHome, 'persona-innate'));
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('空白 $DSH_HOME 不解析到 cwd，回退 ~/.dsh', () => {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = '   ';
  try {
    const r = resolveDataDir(undefined, warn);
    assert.equal(r.root, join(homedir(), '.dsh', 'persona-innate'));
    assert.ok(!r.root.startsWith(process.cwd()));
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});
