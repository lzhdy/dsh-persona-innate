/**
 * 用真实数据验证 v0.5 记忆改造（只读真实目录：先复制到临时目录再操作）
 *
 * 用法：node scripts/verify-real-data.mjs [真实数据目录]
 */
import { readFile, writeFile, mkdir, readdir, cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { JsonStore } from '../lib/store.js';
import { PersonaMemory } from '../lib/memory.js';

const REAL = process.argv[2] ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'persona-innate');

const fsAdapter = {
  async mkdir(p, o) { await mkdir(p, o); },
  async readText(p) { return readFile(p, 'utf-8'); },
  async writeText(p, c) { await mkdir(dirname(p), { recursive: true }); await writeFile(p, c, 'utf-8'); },
  async appendText(p, c) { await mkdir(dirname(p), { recursive: true }); await writeFile(p, c, { flag: 'a' }); },
  async rename(a, b) { const { rename } = await import('node:fs/promises'); await rename(a, b); },
  async exists(p) { return existsSync(p); },
};

async function main() {
  console.log('真实数据目录:', REAL);
  if (!existsSync(REAL)) {
    console.error('目录不存在');
    process.exit(1);
  }
  const files = await readdir(REAL);
  console.log('文件:', files.join(', '));

  const legacyRaw = await readFile(join(REAL, 'events.json'), 'utf-8');
  const legacy = JSON.parse(legacyRaw);
  console.log(`\n旧 events.json: ${legacy.events.length} 条, ${(legacyRaw.length / 1024).toFixed(1)} KB`);

  // 复制到临时目录（真实目录保持只读）
  const dir = await mkdtemp(join(tmpdir(), 'persona-verify-'));
  await cp(REAL, dir, { recursive: true });
  console.log('已复制到临时目录:', dir);

  const store = new JsonStore(fsAdapter, dir);
  store.root = dir;

  const mem = new PersonaMemory(store, { stripDirectives: true, injectLimit: 5 });

  console.log('\n=== 1. 迁移 ===');
  const events = await mem.list();
  const st = mem.storageStats;
  console.log(`读回事件: ${events.length} 条`);
  console.log(`migratedFrom: ${st.migratedFrom ?? '(未迁移)'}, legacySkipped: ${st.legacySkipped ?? false}`);
  console.log(`分片月数: ${st.months}, 坏行: ${st.skippedLines}`);
  const shards = (await readdir(join(dir, 'events'))).filter((n) => n.endsWith('.jsonl'));
  console.log('分片文件:', shards.join(', '));
  for (const s of shards) {
    const raw = await readFile(join(dir, 'events', s), 'utf-8');
    console.log(`  ${s}: ${raw.split('\n').filter(Boolean).length} 条, ${(await stat(join(dir, 'events', s))).size} bytes`);
  }
  const pointer = JSON.parse(await readFile(join(dir, 'events.json'), 'utf-8'));
  console.log('旧文件已变指针:', JSON.stringify(pointer).slice(0, 120));

  console.log('\n=== 2. 新注入（无 clueText） ===');
  const inj = await mem.buildInjection(5);
  console.log(inj.text);
  console.log('\n槽位归因:', JSON.stringify(inj.slots, null, 1));

  console.log('\n=== 3. 对比：旧算法 top-5 ===');
  const W = { user_direct: 1.0, self_direct: 1.0, self_correction: 0.6, inferred: 0.5, tool_output: 0.4, retrieved_content: 0.3, induced: 0.3 };
  const old = [...events].sort((a, b) => W[b.provenance] * b.importance - W[a.provenance] * a.importance).slice(0, 5);
  old.forEach((e, i) => console.log(`${i + 1}. [${e.provenance}] score=${(W[e.provenance] * e.importance).toFixed(2)} ${e.summary.slice(0, 40)}`));

  const countBy = (list) => list.reduce((acc, e) => { acc[e.provenance] = (acc[e.provenance] ?? 0) + 1; return acc; }, {});
  console.log('\n旧 top-5 来源分布:', JSON.stringify(countBy(old)));
  console.log('新注入来源分布:', JSON.stringify(countBy(inj.events)));

  console.log('\n=== 4. 写入新事件是否 O(1)（只追加当月分片） ===');
  const month = new Date().toISOString().slice(0, 7);
  const before = (await readFile(join(dir, 'events', `${month}.jsonl`), 'utf-8')).length;
  await mem.addEvent({ topic: '验证', summary: '写入一条测试事件，检查只追加当月分片', provenance: 'user_direct', importance: 0.7 });
  const after = (await readFile(join(dir, 'events', `${month}.jsonl`), 'utf-8')).length;
  console.log(`当月分片从 ${before} → ${after} bytes（增量 ${after - before}）`);

  console.log('\n=== 5. 线索槽：带当前消息的注入 ===');
  const lastUser = events.filter((e) => e.provenance === 'user_direct').slice(-1)[0];
  if (lastUser) {
    const cue = lastUser.summary.slice(0, 20);
    const inj2 = await mem.buildInjection(5, { cueText: cue });
    const hit = inj2.slots.find((s) => s.slot === 'cue');
    console.log(`cue="${cue}" → 线索槽命中: ${hit ? hit.id : '(空)'}`);
  }

  console.log('\n临时目录（可人工检查）:', dir);
}

main().catch((e) => { console.error(e); process.exit(1); });
