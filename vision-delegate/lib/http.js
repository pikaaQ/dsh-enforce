// dsh-vision-delegate — 路由用的 Node (req,res) 小工具
//
// 官方 `ctx.webServer.register({ kind:'exact', path, handler })` 的 handler 是
// **Node 风格 `(req, res)`** 且必须自己 `res.end()`（与 dsh-turing-balance 的
// /turing-balance 相同）。写成 `(request) => new Response(...)` 不会被发送，
// 请求会一直挂住——这个坑在上一版插件里已经踩过一次。

export function respond(res, status, payload, headOnly = false) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(headOnly ? void 0 : body);
}

/** 读请求 body（带大小上限；解析失败按 `{}` 处理）。 */
export function readJsonBody(req, limit = 8192) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve({});
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/** 从 `req.url` 的 query 里取会话 id（`?session=<id>`）；没有/解析失败返回 undefined。 */
export function sessionIdOf(req, fallbackPath = "/vision-delegate") {
  try {
    const url = new URL(req?.url ?? fallbackPath, "http://localhost");
    const raw = url.searchParams.get("session");
    return raw === null || raw === "" ? void 0 : raw;
  } catch {
    return void 0;
  }
}
