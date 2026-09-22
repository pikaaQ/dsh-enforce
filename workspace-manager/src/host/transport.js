// dsh-workspace-manager — RPC 通道注册（版本自适应）
//
// 为什么要这一层：
//   0.1.1 的 `connection.rpc.handle(channel, handler)` 可以正常使用——它内部走
//   `owner.effect(() => owner.webServer.register(route))`，而 `owner` 就是
//   `dsh-client-connection` 自己的 context，那一版该插件 `inject = ["webServer"]`，读得到。
//   0.1.5 把该插件的 inject 改成 `["credentials"]`（webServer 被移出），`register()` 却仍在读
//   `owner.webServer` —— 于是**任何调用方**都会拿到
//   `cannot get property "webServer" without inject`，并让整个插件树加载失败（dsh web 起不来）。
//   实测证据：隔离实例用 0.1.5-rc.2 冷启动即报
//   `plugin tree failed to load: failed to apply loader entry dsh-workspace-manager`；
//   0.1.5 全树没有任何官方代码调用 `rpc.handle`（只有 `rpc.intercept/call/open`），
//   所以这个回归没有官方使用者踩到。
//
// 因此这里：**优先走官方通道**（0.1.1 行为完全不变），官方通道不可用时退回
// "自己往 webServer 注册一条 prefix 路由"：
//   - 信封与状态码逐条复刻官方 `rpcFetchHandler`（404/415/400/200/gateway/bad-request/500）；
//   - 信任栅栏直接复用官方的 `connection.requestRejection(req)`——它 0.1.5 才有，
//     而退回路径也只会在 0.1.5+ 触发，于是两个版本用的是**同一套栅栏语义**，
//     不需要在本插件里重写任何安全判定（重写栅栏才是真正的风险）。
//   - 若连 `requestRejection` 也没有（既没有官方通道也没有官方栅栏），加载期直接报错
//     fail-loud，绝不静默注册一条没有栅栏的路由。

/** 官方 `CHANNEL_PATTERN`（两版逐字相同）：只允许一条简单路径段。 */
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
/** 官方 `ENDPOINT_SEGMENT_PATTERN`（两版逐字相同）：method 名允许的字符。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
/** 官方 `INVALID_REQUEST_RPC_ID`：rpcId 不可用时的占位值。 */
const INVALID_REQUEST_RPC_ID = 'invalid-request'

/**
 * 复刻官方 `endpointFromPath`：从 `<channel>/<method>` 里取出 method 名，
 * 并拒绝空段、`.`、`..` 以及不合规字符（防路径穿越）。
 * @param channel - RPC 通道前缀（如 `/dsh-workspace-manager`）。
 * @param pathname - 请求路径。
 * @returns method 名；不匹配时返回 `undefined`。
 */
export function endpointFromPath(channel, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) return undefined
  return endpoint
}

/** 读取并缓冲请求体（官方通道声明的 `requestBodyMode: 'buffered'` 语义）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 与官方 `fullResponse` 相同的信封。 */
const fullResponse = (rpcId, result) => ({ type: 'server-response', rpcId, result })
/** 与官方 `errorResponse` 相同的错误信封。 */
const errorResponse = (rpcId, error) => fullResponse(rpcId, { ok: false, error })
const badRequest = (rpcId, message) => errorResponse(rpcId, { code: 'gateway/bad-request', message, details: { issues: [] } })

/** 写出纯文本响应（对齐官方 `new Response(text, { status })`）。 */
function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain;charset=utf-8' })
  res.end(text)
}

/** 写出 JSON 响应（对齐官方 `Response.json`）。 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * 构造自建的 node-http 路由（prefix），行为对齐官方 RPC 通道。
 *
 * 判定顺序与官方一致：**先过信任栅栏**，再判 method/endpoint（404）、content-type（415）、
 * JSON 可解析（400）、信封合法性与 method 一致性（200 + `gateway/bad-request` 信封）。
 * @param ctx - 宿主 context（需要 `connection.requestRejection`）。
 * @param channel - RPC 通道前缀。
 * @param handler - `(endpoint, payload) => Promise<result>`，与本插件原 handler 契约一致。
 * @returns webserver 路由对象。
 */
export function createNodeRoute(ctx, channel, handler) {
  if (typeof ctx.connection?.requestRejection !== 'function') {
    throw new Error(
      'dsh-workspace-manager: 这个 DSH 版本既不能用 connection.rpc.handle，'
      + '也没有 connection.requestRejection 可以复用信任栅栏；拒绝注册一条没有栅栏的 RPC 路由',
    )
  }
  return {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        sendText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== 'POST') {
        sendText(res, 404, 'not found')
        return
      }
      let pathname
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      } catch {
        sendText(res, 404, 'not found')
        return
      }
      const endpoint = endpointFromPath(channel, pathname)
      if (endpoint === undefined) {
        sendText(res, 404, 'not found')
        return
      }
      const contentType = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        sendText(res, 415, 'content type must be application/json')
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        sendText(res, 400, 'body is not JSON')
        return
      }
      const rpcId = typeof body?.rpcId === 'string' && body.rpcId !== '' ? body.rpcId : INVALID_REQUEST_RPC_ID
      const payload = body?.payload === undefined ? {} : body.payload
      const envelopeOk = body !== null
        && typeof body === 'object'
        && body.type === 'client-request'
        && typeof body.method === 'string'
        && typeof payload === 'object'
        && payload !== null
        && !Array.isArray(payload)
      if (!envelopeOk) {
        sendJson(res, 200, badRequest(rpcId, 'invalid client-request message'))
        return
      }
      if (body.method !== endpoint) {
        sendJson(res, 200, badRequest(rpcId, `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`))
        return
      }
      try {
        sendJson(res, 200, fullResponse(rpcId, await handler(endpoint, payload)))
      } catch (error) {
        sendText(res, 500, `handler failure: ${String(error)}`)
      }
    },
  }
}

/**
 * 注册本插件的 RPC 通道：优先官方通道，失败退回自建路由。
 * @param ctx - 宿主 context（需要 `connection`，退回路径还需要 `webServer`）。
 * @param channel - RPC 通道前缀。
 * @param handler - `(endpoint, payload) => Promise<result>`。
 * @returns `{ via, dispose }`：`via` 记录实际走的是哪条路（启动时可据此写日志/断言）。
 */
export function registerRpcChannel(ctx, channel, handler) {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`dsh-workspace-manager: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
  try {
    const dispose = ctx.connection.rpc.handle(channel, handler, { authority: 'trusted-host' })
    if (typeof dispose !== 'function') throw new Error('connection.rpc.handle returned no disposer')
    return { via: 'connection', dispose }
  } catch (error) {
    const route = createNodeRoute(ctx, channel, handler)
    const dispose = ctx.webServer.register(route)
    ctx.logger?.warn?.(
      `dsh-workspace-manager: connection.rpc.handle 不可用（${String(error?.message ?? error)}），`
      + `已退回自建 prefix 路由 ${channel}（信封与信任栅栏与官方通道一致）`,
    )
    return { via: 'webServer', dispose }
  }
}
