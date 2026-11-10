'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { collectVotesFromResult, createApplication } = require('./server');

// 数据库只有 a 票时仍提供 b: 0，避免前端收到不完整的统计结构。
test('缺失的选项补零，并将计数字符串转为数字', () => {
  const result = { rows: [{ vote: 'a', count: '3' }] };
  assert.deepEqual(collectVotesFromResult(result), { a: 3, b: 0 });
});

// 两个选项都有记录时应保留各自票数，供结果页计算百分比。
test('保留两个选项的实际票数', () => {
  const result = { rows: [
    { vote: 'a', count: '2' },
    { vote: 'b', count: '5' },
  ] };
  assert.deepEqual(collectVotesFromResult(result), { a: 2, b: 5 });
});

// 注入假的连接池，只启动临时 HTTP 端口；避免测试启动真实数据库轮询。
async function openTestApplication(t, pool) {
  const application = createApplication({ pool });

  // 每个测试结束后释放 Socket.IO 和 HTTP 端口，防止进程无法退出。
  t.after(() => new Promise((resolve) => application.io.close(resolve)));
  const listening = once(application.server, 'listening');
  application.server.listen(0, '127.0.0.1');
  await listening;

  // 端口 0 让系统分配空闲端口，避免和 Docker 发布的端口冲突。
  return `http://127.0.0.1:${application.server.address().port}`;
}

// 存活检查独立于数据库，数据库不可用时也应确认应用还能处理 HTTP。
test('healthz 返回 200 且不查询数据库', async (t) => {
  const pool = { query: mock.fn(async () => { throw new Error('数据库不可用'); }) };
  const baseUrl = await openTestApplication(t, pool);
  const response = await fetch(`${baseUrl}/healthz`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(pool.query.mock.callCount(), 0);
});

// 就绪检查通过简单 SQL 验证数据库连接，并检查调用次数和查询内容。
test('数据库查询成功时 readyz 返回 200', async (t) => {
  const pool = { query: mock.fn(async () => ({ rows: [] })) };
  const baseUrl = await openTestApplication(t, pool);
  const response = await fetch(`${baseUrl}/readyz`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ready' });
  assert.equal(pool.query.mock.callCount(), 1);
  assert.deepEqual(pool.query.mock.calls[0].arguments, ['SELECT 1']);
});

// 用拒绝的 Promise 稳定模拟数据库故障，验证接口会转换为 503 响应。
test('数据库查询失败时 readyz 返回 503', async (t) => {
  const pool = { query: mock.fn(async () => { throw new Error('数据库不可用'); }) };
  const baseUrl = await openTestApplication(t, pool);
  const response = await fetch(`${baseUrl}/readyz`);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'not-ready' });
  assert.equal(pool.query.mock.callCount(), 1);
});
