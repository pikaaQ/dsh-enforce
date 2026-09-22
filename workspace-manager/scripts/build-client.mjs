// dsh-workspace-manager — 客户端 bundle 构建（零依赖，无 esbuild / 无 JSX 转译）
//
// 输出 lib/client.js，形如内核自己的客户端 bundle：
//   window.__ModuleLoader__.load({ id, factory: (require) => { ...module...; return module.exports } })
//
// 做法：把 src/shared/hidden.js 的纯函数内联（去掉 `export`），再接上
// src/client/body.js。这样"隐藏规则"只有一份实现，宿主侧离线测试与
// 浏览器半区共用，不会漂移。
//
// 运行：node scripts/build-client.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** 把 ESM 源内联进工厂闭包：去掉 `export` 前缀与 `import` 行（共享模块都是单行 import）。 */
const inline = (source) => source
  .replace(/^export\s+(function|const|let|class)\s/gm, '$1 ')
  .replace(/^export\s*\{[^}]*\}\s*$/gm, '')
  .replace(/^\s*import\s.*$/gm, '')

const shared = inline(readFileSync(join(ROOT, 'src', 'shared', 'hidden.js'), 'utf8'))
// 会话树（父→子）的纯规则：宿主级联（src/host/session-tree.js）与设置页的缩进树/子会话计数
// 共用同一份实现，所以"页面上看到几个子会话"与"实际会删掉几个"不可能漂移。
const sessionTree = inline(readFileSync(join(ROOT, 'src', 'shared', 'session-tree.js'), 'utf8'))
const projection = inline(readFileSync(join(ROOT, 'src', 'shared', 'projection.js'), 'utf8'))
const body = readFileSync(join(ROOT, 'src', 'client', 'body.js'), 'utf8')

// 防漂移：工厂闭包里不允许再出现顶层 import/export（浏览器里没有模块解析）。
for (const [name, source] of [['hidden.js', shared], ['session-tree.js', sessionTree], ['projection.js', projection], ['body.js', body]]) {
  const offender = source.split('\n').find((line) => /^\s*(import|export)\s/.test(line))
  if (offender !== undefined) {
    throw new Error(`build-client: ${name} 仍含顶层 ESM 语句，无法内联：${offender.trim()}`)
  }
}

const bundle = `// ${pkg.name} v${pkg.version} — 由 scripts/build-client.mjs 生成，请勿手改。
// 源：src/shared/hidden.js + src/shared/session-tree.js + src/shared/projection.js + src/client/body.js
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

// ── 内联：src/shared/hidden.js ──────────────────────────────────────────────
${shared}
// ── 内联：src/shared/session-tree.js ────────────────────────────────────────
${sessionTree}
// ── 内联：src/shared/projection.js ──────────────────────────────────────────
${projection}
// ── 内联：src/client/body.js ────────────────────────────────────────────────
${body}

    // 内核 loader 取的是**工厂的返回值**（dsh-client-modules: exports: registered(makeRequire(...))），
    // 所以这里必须显式返回 module.exports。
    return module.exports;
  }
});
`

mkdirSync(join(ROOT, 'lib'), { recursive: true })
const target = join(ROOT, 'lib', 'client.js')
writeFileSync(target, bundle)
console.log(`built ${target} (${bundle.length} bytes)`)
