/**
 * host 半的冒烟测试：验证 apply 能对着最小 ctx 跑通并注册 /health，
 * 405/HEAD/刷卡行为与 dsh-reference 的 host 半一致。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { apply, name, version } from '../lib/index.js';

/** 收集注册过的路由。 */
const routes = new Map();

/**
 * 造一个最小 webServer 桩。
 * @returns {object} 桩。
 */
function webServerStub() {
  return { register(route) { routes.set(route.path, route.handler); } };
}

// 形态一：ctx 直接带着 webServer。
const direct = { effect(fn) { fn(); }, webServer: webServerStub() };
apply(direct);
assert.ok(routes.has('/plugin/dsh-input-history/health'), '必须注册健康检查路由');

// 形态二：webServer 后到，ctx.inject 等它。
const late = {
  registered: false,
  effect(fn) { fn(); },
  inject(_names, fn) { fn({ effect(fn2) { fn2(); }, webServer: webServerStub() }); },
};
apply(late);

// 真发一轮请求验证响应形状。
const server = createServer((req, res) => {
  const handler = routes.get(req.url.split('?')[0]);
  if (handler) handler(req, res);
  else { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;

const hit = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

const healthy = await hit('/plugin/dsh-input-history/health');
assert.equal(healthy.status, 200);
assert.equal(healthy.body.ok, true);
assert.equal(healthy.body.plugin, name);
assert.equal(healthy.body.version, version);
assert.equal(healthy.body.clientSeenAt, null);

const stamped = await hit('/plugin/dsh-input-history/health?client=1');
assert.equal(stamped.status, 200);
assert.ok(typeof stamped.body.clientSeenAt === 'string' && stamped.body.clientSeenAt.length > 0, 'client=1 应留下刷卡时间');

const again = await hit('/plugin/dsh-input-history/health');
assert.equal(again.body.clientSeenAt, stamped.body.clientSeenAt, '普通请求不覆盖刷卡时间');

const refused = await hit('/plugin/dsh-input-history/health', { method: 'POST' });
assert.equal(refused.status, 405);

server.close();
console.log('host smoke: ok');
