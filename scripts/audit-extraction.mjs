#!/usr/bin/env node
/**
 * 提取命中率审计（ISS-053 的证据脚本，可重跑）
 *
 * 它回答一个问题：**用户说过的每一句话，到底有多少变成了记忆？**
 *
 * 做法：拿 raw_turns 里的真实用户原文，按生产链路原样复算一遍提取器，
 * 逐条给出「命中 / 去重 / 丢弃」，并与 events 层对账。
 *
 * 生产链路的唯一依据（改这里之前先读 `src/index.ts:1075` handleUserMessage）：
 *   cand = extractStyleFeedback(text) ?? extractCandidate(text)
 *   if (!cand) return;                        ← 静默丢弃，无日志无计数
 *   dedup：同一 key 10 分钟内只写一次（`index.ts:1072` dedupWindowMs）
 *
 * 用法（必须先 `npm run build`，脚本读 lib/ 的编译产物）：
 *   node scripts/audit-extraction.mjs
 *   node scripts/audit-extraction.mjs --data "C:/Users/x/.dsh/persona-innate" --month 2026-11
 *   node scripts/audit-extraction.mjs --json        # 机器可读，便于做趋势
 *
 * 退出码：0 命中率达标；1 数据目录或 raw_turns 不存在；2 命中率低于 50%（当基线守门用，
 *         脚本报告本身是一次正常执行）。基线：2026-11-06 实测 13.5%（见 ISS-053）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DATA = argOf('data', path.join(os.homedir(), '.dsh', 'persona-innate'));
const MONTH = argOf('month', new Date().toISOString().slice(0, 7));
const AS_JSON = process.argv.includes('--json');
const DEDUP_MS = 10 * 60 * 1000;

const rawPath = path.join(DATA, 'raw-turns', `${MONTH}.jsonl`);
const eventsPath = path.join(DATA, 'events', `${MONTH}.jsonl`);

if (!fs.existsSync(rawPath)) {
  console.error(`raw_turns 不存在：${rawPath}`);
  console.error('（P1 于 0.5.5 上线后才有原文落盘；更早的月份没有可审计的原文）');
  process.exit(1);
}

const ex = await import(`file:///${path.join(REPO, 'lib', 'extract.js').replace(/\\/g, '/')}`);

const readJsonl = (p) =>
  fs.existsSync(p)
    ? fs
        .readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];

const rows = readJsonl(rawPath);
const events = readJsonl(eventsPath);

/** 运行时上下文注入不是用户说的话，必须排除，否则分母虚高 */
const isRuntimeContext = (t) => t.startsWith('Current runtime context');

const userRows = rows.filter((r) => r.speaker === 'user' && !isRuntimeContext(r.raw_text || ''));
const userEvents = events.filter((e) => e.provenance === 'user_direct');

const dedup = new Map();
const out = [];

for (const [i, r] of userRows.entries()) {
  const text = r.raw_text || '';
  const cand = ex.extractStyleFeedback(text) ?? ex.extractCandidate(text);
  const t = Date.parse(r.asserted_at || r.ingested_at || '') || 0;

  let status = 'DROP';
  if (cand) {
    const key = ex.dedupKey(cand);
    const last = dedup.get(key);
    status = last !== undefined && t - last < DEDUP_MS ? 'DEDUP' : 'HIT';
    if (status === 'HIT') dedup.set(key, t);
  }

  out.push({
    n: i + 1,
    time: (r.asserted_at || '').slice(11, 16),
    status,
    topic: cand?.topic ?? '',
    importance: cand?.importance ?? null,
    text: text.replace(/\s+/g, ' ').slice(0, 60),
  });
}

const hit = out.filter((x) => x.status === 'HIT');
const dropped = out.filter((x) => x.status === 'DROP');
const deduped = out.filter((x) => x.status === 'DEDUP');
const rate = userRows.length ? (hit.length / userRows.length) * 100 : 0;

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        month: MONTH,
        rawTurns: rows.length,
        userMessages: userRows.length,
        hit: hit.length,
        deduped: deduped.length,
        dropped: dropped.length,
        hitRate: Number(rate.toFixed(1)),
        userEventsInStore: userEvents.length,
        rows: out,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`数据目录：${DATA}`);
  console.log(`月份：${MONTH}｜原文 ${rows.length} 条（用户 ${userRows.length} 条）`);
  console.log(`事件库：user_direct ${userEvents.length} 条`);
  console.log('');
  console.log(
    `命中 ${hit.length}｜去重丢弃 ${deduped.length}｜规则未命中 ${dropped.length}｜命中率 ${rate.toFixed(1)}%`,
  );
  console.log('');
  console.log('  #  时间   状态  重要性  内容');
  for (const r of out) {
    const flag = r.status === 'HIT' ? '命中' : r.status === 'DEDUP' ? '去重' : '丢弃';
    console.log(
      ` ${String(r.n).padStart(2)}  ${r.time}  ${flag}  ${String(r.importance ?? '').padEnd(5)}  ${r.text}`,
    );
  }
  console.log('');
  console.log('--- 未命中清单（这些内容永远进不了记忆）---');
  for (const r of dropped) console.log(` ${String(r.n).padStart(2)}  ${r.time}  ${r.text}`);
}

// 命中率低于 50% 时给出非零退出码，便于 CI 里当基线守门（当前实测 13.5%）
process.exit(rate < 50 ? 2 : 0);
