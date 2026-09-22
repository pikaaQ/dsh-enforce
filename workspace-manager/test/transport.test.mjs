// 传输层的离线测试：官方通道优先、退回自建路由、以及自建路由对状态码与信封的复刻。
//
// 这些断言对应 `verify-runtime-rpc.mjs` 在真实实例上打的那几项（GET→404、错 content-type→415、
// 伪造跨站 Origin→403、method 与路径不一致→信封级 bad-request），所以退回路径一旦漂移，
// 离线测试与真实运行时验证会同时报警。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createNodeRoute, endpointFromPath, registerRpcChannel } from '../src/host/transport.js'

const CHANNEL = '/dsh-workspace-manager'

/** 造一个够用的 node req（body 在下一个微任务里送达，模拟流式读取）。 */
function fakeRequest({ method = 'POST', url = `${CHANNEL}/state`, headers = {}, body = '', badUrl = false } = {}) {
  const handlers = { data: [], end: [], error: [] }
  const req = {
    method,
    url: badUrl ? '::not a url::' : url,
    headers,
    on(event, listener) {
      handlers[event]?.push(listener)
      return req
    },
  }
  queueMicrotask(() => {
    if (body !== '') for (const listener of handlers.data) listener(Buffer.from(body))
    for (const listener of handlers.end) listener()
  })
  return req
}

/** 造一个够用的 node res，记录状态码与响应体。 */
function fakeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.body = text
    },
  }
}

const request = (overrides) => ({ 'content-type': 'application/json', ...overrides })

/** 跑一次自建路由；`rejection` 模拟官方信任栅栏的返回值。 */
async function invoke({ rejection, handler = async () => ({ ok: true, value: { fine: true } }), headers, ...options } = {}) {
  const warnings = []
  const ctx = {
    connection: { requestRejection: () => rejection },
    logger: { warn: (message) => warnings.push(message) },
  }
  const route = createNodeRoute(ctx, CHANNEL, handler)
  const res = fakeResponse()
  // 默认带上合法 content-type；要测 content-type 分支的用例显式传 headers 覆盖。
  await route.handler(fakeRequest({ headers: request(headers), ...options }), res)
  return { res, warnings, route }
}

const json = (body) => JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'state', payload: {}, ...body })

test('endpointFromPath 复刻官方取法，并挡住路径穿越', () => {
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/state`), 'state')
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/a/b`), 'a/b')
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}`), undefined)
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/`), undefined)
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/../etc`), undefined)
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/a/./b`), undefined)
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/a b`), undefined)
  assert.equal(endpointFromPath('/other', `${CHANNEL}/state`), undefined)
})

test('官方通道可用时优先走官方通道，并带上 authority', () => {
  const calls = []
  const dispose = () => {}
  const ctx = {
    connection: {
      rpc: {
        handle: (...args) => {
          calls.push(args)
          return dispose
        },
      },
    },
  }
  const result = registerRpcChannel(ctx, CHANNEL, async () => ({}))
  assert.equal(result.via, 'connection')
  assert.equal(result.dispose, dispose)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], CHANNEL)
  assert.deepEqual(calls[0][2], { authority: 'trusted-host' })
})

test('官方通道抛错（0.1.5 的 webServer 回归）时退回自建 prefix 路由，并留下告警', () => {
  const registered = []
  const warnings = []
  const ctx = {
    connection: {
      rpc: {
        handle: () => {
          throw new Error('cannot get property "webServer" without inject')
        },
      },
      requestRejection: () => undefined,
    },
    webServer: { register: (route) => { registered.push(route); return () => {} } },
    logger: { warn: (message) => warnings.push(message) },
  }
  const result = registerRpcChannel(ctx, CHANNEL, async () => ({}))
  assert.equal(result.via, 'webServer')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, CHANNEL)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /webServer/)
})

test('两条路都不可用时 fail-loud（绝不注册没有栅栏的路由）', () => {
  const ctx = { connection: { rpc: { handle: () => { throw new Error('boom') } } } }
  assert.throws(() => registerRpcChannel(ctx, CHANNEL, async () => ({})), /requestRejection/)
})

test('非法/保留通道名直接拒绝', () => {
  const ctx = { connection: { rpc: { handle: () => () => {} } } }
  assert.throws(() => registerRpcChannel(ctx, '/api', async () => ({})), /reserved/)
  assert.throws(() => registerRpcChannel(ctx, 'no-slash', async () => ({})), /invalid/)
})

test('栅栏先行：403 / 401 直接返回，不进入业务处理', async () => {
  const first = await invoke({ rejection: 403 })
  assert.equal(first.res.status, 403)
  assert.equal(first.res.body, 'forbidden')
  const second = await invoke({ rejection: 401 })
  assert.equal(second.res.status, 401)
  assert.equal(second.res.body, 'unauthorized')
})

test('非 POST -> 404（与官方通道一致）', async () => {
  const { res } = await invoke({ method: 'GET' })
  assert.equal(res.status, 404)
  assert.equal(res.body, 'not found')
})

test('路径穿越 -> 404', async () => {
  const { res } = await invoke({ url: `${CHANNEL}/../secret`, body: json() })
  assert.equal(res.status, 404)
})

test('content-type 不是 application/json -> 415（带 charset 也算合法）', async () => {
  const bad = await invoke({ headers: { 'content-type': 'text/plain' }, body: json() })
  assert.equal(bad.res.status, 415)
  const good = await invoke({ headers: { 'content-type': 'application/json; charset=utf-8' }, body: json() })
  assert.equal(good.res.status, 200)
})

test('body 不是 JSON -> 400', async () => {
  const { res } = await invoke({ body: 'not json' })
  assert.equal(res.status, 400)
  assert.equal(res.body, 'body is not JSON')
})

test('信封缺 type / method 不是字符串 -> 信封级 bad-request（200 + ok:false）', async () => {
  const missingType = await invoke({ body: JSON.stringify({ rpcId: 'keep-me', method: 'state', payload: {} }) })
  assert.equal(missingType.res.status, 200)
  const first = JSON.parse(missingType.res.body)
  assert.equal(first.type, 'server-response')
  assert.equal(first.rpcId, 'keep-me')
  assert.equal(first.result.ok, false)
  assert.equal(first.result.error.code, 'gateway/bad-request')

  const badMethod = await invoke({ body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 7, payload: {} }) })
  assert.equal(JSON.parse(badMethod.res.body).result.error.code, 'gateway/bad-request')
  assert.equal(JSON.parse(badMethod.res.body).rpcId, 'x')
})

test('method 与路径不一致 -> 信封级 bad-request（点名两边）', async () => {
  const { res } = await invoke({ url: `${CHANNEL}/state`, body: json({ method: 'close' }) })
  const body = JSON.parse(res.body)
  assert.equal(res.status, 200)
  assert.equal(body.result.ok, false)
  assert.match(body.result.error.message, /"close".*"state"/)
})

test('payload 省略时按空对象处理（state 这类无参端点仍可用）', async () => {
  const seen = []
  const { res } = await invoke({
    body: JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'state' }),
    handler: async (endpoint, payload) => {
      seen.push([endpoint, payload])
      return { ok: true, value: {} }
    },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(seen, [['state', {}]])
})

test('成功 -> 官方形状的信封（type/rpcId/result）', async () => {
  const { res } = await invoke({ body: json({ rpcId: 'abc' }) })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'application/json')
  const body = JSON.parse(res.body)
  assert.deepEqual(Object.keys(body).sort(), ['result', 'rpcId', 'type'])
  assert.equal(body.type, 'server-response')
  assert.equal(body.rpcId, 'abc')
  assert.deepEqual(body.result, { ok: true, value: { fine: true } })
})

test('handler 抛错 -> 500 handler failure（与官方通道一致）', async () => {
  const { res } = await invoke({ body: json(), handler: async () => { throw new Error('kaboom') } })
  assert.equal(res.status, 500)
  assert.match(res.body, /handler failure: Error: kaboom/)
})
