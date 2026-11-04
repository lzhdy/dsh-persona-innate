/**
 * events 层并发安全：`EventLog.load()` 的首次加载必须"只有一份"
 *
 * 背景（v0.7 复盘游标改造时发现的既有缺陷，不是新引入的）：
 * `append()` 的写法是
 *     const list = await this.load();  ...  list.push(event)
 * 因为它把事件 push 进"load 返回的那个数组"，所以 load 必须给所有并发调用者**同一个数组**。
 * 原实现是 `if (cache) return cache; ... this.cache = events; return events;`——
 * 两个并发的首次 load 各扫一份空目录、各自给 cache 赋值，后赋值的那个会让另一次 append
 * 刚 push 进去的数组变成孤儿：**事件在磁盘上、进程内却看不见**，直到进程重启。
 *
 * 触发场景很日常：用户连发两条消息（两个 handleUserMessage 并发），
 * 之后 /persona review 会报"还没有可复盘的记忆事件"——实测 25 次真实装配里 1 次。
 * 注入同理：那一轮 inject 会漏掉刚记下的事。
 *
 * 这两个用例分别锁住"机制"（同一数组）与"后果"（事件必须可见）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/store.js';
import { EventLog } from '../lib/event-log.js';

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
  const dir = await mkdtemp(join(tmpdir(), 'persona-evlog-'));
  return new JsonStore(tempFs(dir), dir);
}

function ev(id, iso = new Date().toISOString()) {
  return {
    id,
    time: iso,
    topic: '用户-分享',
    summary: `事件 ${id}`,
    emotionTags: [],
    importance: 0.6,
    provenance: 'user_direct',
    lastRetrieved: null,
  };
}

test('v0.7-C7: 并发的首次 load() 必须返回同一个数组（否则 append 会 push 进孤儿数组）', async () => {
  const store = await freshStore();
  const log = new EventLog(store);

  // 三个"同时"到达的首次加载：注入刷新、复盘、事件写入各一个
  const [a, b, c] = await Promise.all([log.load(), log.load(), log.load()]);
  assert.equal(a, b, '并发首次加载必须共享同一份数组');
  assert.equal(a, c, '并发首次加载必须共享同一份数组');
  assert.equal(a, log.cache, '缓存与返回值必须是同一引用');
});

test('v0.7-C8: 首次加载进行中写入的事件，必须立刻在 list() 里可见（不是重启后）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-evlog-race-'));
  const base = tempFs(root);
  // 让读通道卡住：模拟"扫描已开始、但还没扫完"的那一小段窗口
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const gated = {
    ...base,
    async readText(path) {
      await gate;
      return base.readText(path);
    },
  };
  const store = new JsonStore(gated, root);
  const log = new EventLog(store);

  const firstLoad = log.load(); // 扫描开始（此时磁盘为空）
  const appended = log.append(ev('ev_race')); // 并发到达的写入
  release(); // 放开读通道，让两个 await 依次落地

  await Promise.all([firstLoad, appended]);

  const visible = await log.list();
  assert.equal(visible.length, 1, `磁盘写成功的事件必须在进程内可见，实际 ${visible.length} 条`);
  assert.equal(visible[0].id, 'ev_race');

  // 而且真的落盘了（不是只在内存里）
  const raw = await readFile(join(root, 'events', `${new Date().toISOString().slice(0, 7)}.jsonl`), 'utf-8');
  assert.ok(raw.includes('ev_race'), `事件应已写入分片，实际：${raw}`);
});
