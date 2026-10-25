/**
 * dsh-input-history —— host 半。
 *
 * 整个功能发生在浏览器侧（读会话视图快照、接管输入框按键、写草稿），因此这一半
 * 不碰模型、不碰会话日志、不碰任何状态，只提供一个可选的健康检查端点，方便安装
 * 后确认插件确实被装载。形状与 dsh-reference 的 host 半一致。
 *
 * 依赖保持为可选：组合里没有 webServer 时插件照常加载，只是少了 /health。
 */

/** cordis 插件名。 */
export const name = 'dsh-input-history';

/** 不强制注入任何服务；webServer 在 apply 里按可选依赖解析。 */
export const inject = [];

/** 插件版本，健康检查里回显。 */
export const version = '0.1.0';

/** 最近一次浏览器半上报的时间戳；用来确认客户端 bundle 真的跑起来了。 */
let lastClientAt;

/**
 * 装载 host 半。
 * @param {object} ctx cordis host 上下文。
 */
export function apply(ctx) {
  const register = (scoped) => {
    if (typeof scoped.effect !== 'function' || typeof scoped.webServer?.register !== 'function') return;
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: '/plugin/dsh-input-history/health',
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405, { allow: 'GET, HEAD' });
              res.end();
              return;
            }
            // 浏览器半装载后打一次卡，让「插件是否真的跑起来」可以从服务端确认。
            if (typeof req.url === 'string' && req.url.includes('client=1')) lastClientAt = new Date().toISOString();
            const body = JSON.stringify({
              ok: true,
              plugin: name,
              version,
              clientSeenAt: lastClientAt ?? null,
            });
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(body),
            });
            if (req.method === 'HEAD') res.end();
            else res.end(body);
          },
        }),
      'dsh-input-history: health route',
    );
  };

  // webServer 可能在 apply 之后才就绪，用 inject 等它，而不是抢跑。
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], register);
  else register(ctx);
}
