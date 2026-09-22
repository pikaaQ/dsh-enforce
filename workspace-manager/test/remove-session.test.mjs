// dsh-workspace-manager — 「会话清点 / 彻底移除」离线测试
//
// 全部在 mkdtemp 出来的临时 home 上跑，绝不触碰真实 $DSH_HOME。
// 运行：node --test test/remove-session.test.mjs

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
	isSafeSessionId,
	projectKeyOf,
	removeSessionFiles,
	SessionRemovalError,
	sessionInventory,
} from '../src/host/remove-session.js'

/** 造一个带四类痕迹的 home：工件、投影缓存、旧移动插件的备份、以及内容寻址附件。 */
function fixtureHome() {
	const home = mkdtempSync(join(tmpdir(), 'dswm-remove-'))
	const write = (relative, content) => {
		const file = join(home, relative)
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, content)
	}
	write('sessions/--E-work-alpha--/s-alpha/session.jsonl.zstd', 'a'.repeat(100))
	write('sessions/--E-work-beta--/s-beta/session.jsonl.zstd', 'b'.repeat(50))
	write('sessions/--E-work-beta--/s-gamma/session.jsonl.zstd', 'c'.repeat(25))
	write('sessions/--E-orphan--/s-lonely/session.jsonl.zstd', 'd'.repeat(10))
	write('storages/session_projcache/sessions/s-lonely.json', '{}')
	write('session-workspace-backups/s-lonely/session.jsonl.zstd', 'e'.repeat(5))
	// 内容寻址存储可能被别的会话共用 —— 任何删除都不得碰它。
	write('attachments/v1/objects/ab/cdef', 'shared')
	return home
}

const workspaces = [
	{ workspaceId: 'ws-alpha', path: 'E:/work/alpha' },
	{ workspaceId: 'ws-beta', path: 'E:/work/beta' },
]

test('projectKeyOf 与 dsh-workspace 的项目键一致', () => {
	assert.equal(projectKeyOf('E:\\JavaScript\\dsh-enforce'), '--E-JavaScript-dsh-enforce--')
	assert.equal(projectKeyOf('E:/work/alpha'), '--E-work-alpha--')
	assert.equal(projectKeyOf('/home/u/proj'), '--home-u-proj--')
	assert.equal(projectKeyOf('E:\\tmp\\work_hour'), '--E-tmp-work_hour--')
})

test('isSafeSessionId 只接受能安全当目录名的 id', () => {
	for (const good of ['8f858265-7a5f-4858-a7b5-6669a7af945d', 'session-2f1f7f4c-5196-4163-9a49-a2f45760f640', 'a.b_c-1']) {
		assert.equal(isSafeSessionId(good), true, good)
	}
	for (const bad of ['../evil', 'a/b', '..', '.', '', 'a b', '-lead', '.hidden', 'x\\y']) {
		assert.equal(isSafeSessionId(bad), false, JSON.stringify(bad))
	}
})

test('sessionInventory 把会话按项目键归组，未分组的 workspaceId 为 null', async () => {
	const home = fixtureHome()
	try {
		const inventory = await sessionInventory(home, workspaces)
		assert.equal(inventory.sessionsRoot, join(home, 'sessions'))
		assert.deepEqual(inventory.sessions.map((row) => row.id).sort(), ['s-alpha', 's-beta', 's-gamma', 's-lonely'])
		assert.equal(inventory.sessions.find((row) => row.id === 's-alpha').workspaceId, 'ws-alpha')
		assert.equal(inventory.sessions.find((row) => row.id === 's-gamma').workspaceId, 'ws-beta')
		assert.equal(inventory.sessions.find((row) => row.id === 's-lonely').workspaceId, null)
		assert.deepEqual(inventory.totals, { sessions: 4, bytes: 185, ungrouped: 1, ungroupedBytes: 10 })
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
})

test('removeSessionFiles 删掉工件、投影缓存与旧移动备份，并收掉空的项目目录', async () => {
	const home = fixtureHome()
	try {
		const report = await removeSessionFiles(home, 's-lonely')
		assert.equal(report.sessionId, 's-lonely')
		// 工件 10 B + 投影缓存 2 B（`{}`）+ 旧移动备份 5 B
		assert.equal(report.bytes, 17)
		assert.deepEqual(report.removed.map((entry) => entry.kind).sort(), ['artifact', 'legacy-move-backup', 'projection-cache'])
		assert.equal(existsSync(join(home, 'sessions', '--E-orphan--', 's-lonely')), false)
		assert.equal(existsSync(join(home, 'storages', 'session_projcache', 'sessions', 's-lonely.json')), false)
		assert.equal(existsSync(join(home, 'session-workspace-backups', 's-lonely')), false)
		assert.equal(existsSync(join(home, 'sessions', '--E-orphan--')), false, '空的项目目录应被收掉')
		assert.deepEqual(report.prunedProjects, [join(home, 'sessions', '--E-orphan--')])
		// 别人的东西一个都不能少。
		assert.equal(existsSync(join(home, 'attachments', 'v1', 'objects', 'ab', 'cdef')), true)
		assert.equal(existsSync(join(home, 'sessions', '--E-work-alpha--', 's-alpha')), true)
		assert.equal(existsSync(join(home, 'sessions', '--E-work-beta--', 's-gamma')), true)
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
})

test('项目目录里还有别的会话时不会被 prune', async () => {
	const home = fixtureHome()
	try {
		await removeSessionFiles(home, 's-beta')
		assert.equal(existsSync(join(home, 'sessions', '--E-work-beta--', 's-beta')), false)
		assert.equal(existsSync(join(home, 'sessions', '--E-work-beta--')), true)
		assert.equal(existsSync(join(home, 'sessions', '--E-work-beta--', 's-gamma')), true)
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
})

test('找不到工件时明确报 session-not-found，且不做任何猜测性删除', async () => {
	const home = fixtureHome()
	try {
		await assert.rejects(
			() => removeSessionFiles(home, 's-does-not-exist'),
			(error) => error instanceof SessionRemovalError && error.code === 'session-not-found',
		)
		assert.equal(existsSync(join(home, 'sessions', '--E-work-alpha--', 's-alpha')), true)
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
})

test('不安全的 id 一律 bad-request，且磁盘内容不被触碰（含穿越尝试）', async () => {
	const home = fixtureHome()
	try {
		for (const bad of ['../evil', 'a/b', '..', '.', '', '-lead', 's-lonely/../s-alpha']) {
			await assert.rejects(
				() => removeSessionFiles(home, bad),
				(error) => error instanceof SessionRemovalError && error.code === 'bad-request',
				`${JSON.stringify(bad)} 应被拒绝`,
			)
		}
		assert.equal(existsSync(join(home, 'sessions', '--E-orphan--', 's-lonely')), true)
		assert.equal(existsSync(join(home, 'sessions', '--E-work-alpha--', 's-alpha')), true)
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
})

test('删两次第二次报 session-not-found（幂等、无残留）', async () => {
	const home = fixtureHome()
	try {
		await removeSessionFiles(home, 's-lonely')
		await assert.rejects(
			() => removeSessionFiles(home, 's-lonely'),
			(error) => error instanceof SessionRemovalError && error.code === 'session-not-found',
		)
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
})

test('includeLegacyBackups=false 时保留旧移动备份（调用方按需选择）', async () => {
	const home = fixtureHome()
	try {
		const report = await removeSessionFiles(home, 's-lonely', { includeLegacyBackups: false })
		assert.equal(report.bytes, 12)
		assert.equal(existsSync(join(home, 'session-workspace-backups', 's-lonely')), true)
		assert.equal(existsSync(join(home, 'sessions', '--E-orphan--', 's-lonely')), false)
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
})
