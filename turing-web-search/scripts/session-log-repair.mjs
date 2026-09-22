// dsh-turing-web-search — session-log repair tool (one-off, run with the SAME
// node that runs dsh, e.g. D:\nodejs\node.exe — a node with native node:zlib
// Zstandard support).
//
// Problem: the plugin's earlier host half appended a custom event type
// ("web/turing-search-request") into the durable session log via
// session.append(). The dsh-session read path refuses to interpret any log
// containing an event type outside the harness build's known catalog unless
// the event envelope carries `ignorable: true`. Because Session.append in this
// build can never write that marker, those logs became unloadable and every
// affected session shows "history unavailable / SessionFormatUnsupportedError".
//
// This tool decodes the JSONL.zstd artifacts exactly the way the JSONL
// persistence backend does (concatenated independent Zstandard frames, each
// frame holding JSONL records, first record = session header), adds
// `ignorable: true` to the envelope of every event whose type is outside the
// harness's known-event catalog (they are informational plugin records; loss
// cannot change reconstruction), and re-encodes header frame + body frame.
// Seq numbers and all event data are preserved bit-for-bit in JSON semantics,
// so appends made later by the live backend still line up.
//
// Usage:
//   node session-log-repair.mjs scan [sessionsRoot]
//   node session-log-repair.mjs repair [sessionsRoot] [--dry] [--types a,b]
//
// Default sessionsRoot: %USERPROFILE%\.dsh\sessions (override via DSH_SESSIONS_ROOT).
//
// Known catalog below is the verbatim list from
// @deepseek-ai/dsh-session/lib/types/known-event-types.js of the harness
// build this tool was written against; a type outside this set is treated as
// an unknown/plugin-authored event and gets the ignorable marker.

import { readFileSync, writeFileSync, renameSync, statSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdCompressSync, zstdDecompressSync, constants } from "node:zlib";

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 (28 B5 2F FD little-endian)
const CHECKSUM_FLAG = constants.ZSTD_c_checksumFlag; // 201
const KNOWN_SESSION_EVENT_TYPES = new Set([
	"agent-preset/selected",
	"agent/inbox/spliced",
	"approval/asked",
	"approval/decided",
	"approval/policy",
	"assistant/chunk",
	"assistant/message",
	"command/done",
	"command/run",
	"compaction/end",
	"compaction/prune",
	"compaction/start",
	"compaction/summary",
	"feedback/record",
	"goal/change",
	"hook/invoked",
	"hook/result",
	"llm/retry",
	"llm/retry-started",
	"permission/preset",
	"plan/mode",
	"request/context",
	"request/header",
	"sandbox/mode",
	"schedule/change",
	"session/end-seed",
	"session/title",
	"session/title-llm-request",
	"step/end",
	"step/start",
	"subagent/descriptor",
	"team/member",
	"team/message/delivered",
	"team/message/queued",
	"team/task",
	"todo/write",
	"tool-workflow/agent-end",
	"tool-workflow/agent-start",
	"tool-workflow/run-end",
	"tool-workflow/run-start",
	"tool/call",
	"tool/code-dispatch",
	"tool/code-dispatch-start",
	"tool/result",
	"turn/end",
	"turn/start",
	"user/message",
	"web/deepseek-search-llm-request"
]);
const CHUNK_ROW_TYPES = new Set(["text-chunks", "reasoning-chunks", "tool-call-chunks"]);

/** Structural Zstandard frame scan — mirrors the JSONL backend's scanZstdFrames. */
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	let tornStart;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) { tornStart ??= start; break; }
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
		offset += 4;
		if (offset === buffer.length) { tornStart ??= start; break; }
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) { tornStart ??= start; break; }
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) { tornStart ??= start; break; }
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) { tornStart ??= start; break; }
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (tornStart !== void 0) break;
		if (checksum) {
			if (buffer.length - offset < 4) { tornStart ??= start; break; }
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames, tornStart };
}

/** Decode one complete log artifact into { headerLine, rows (parsed), tornBytes }. */
function decodeLog(buffer) {
	const { frames, tornStart } = scanZstdFrames(buffer);
	const plainParts = [];
	for (const frame of frames) {
		plainParts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
	}
	const plain = Buffer.concat(plainParts);
	const text = plain.toString("utf8");
	const lines = text.split("\n");
	const headerLine = lines[0];
	if (headerLine.length === 0) throw new Error("empty or header-less session log");
	const rows = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.length === 0) {
			// Only the final trailing newline may produce an empty segment.
			if (i !== lines.length - 1) throw new Error(`unexpected blank JSONL row at line ${i + 1}`);
			continue;
		}
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(`unparsable committed event at line ${i + 1}: ${error.message}`);
		}
		rows.push(parsed);
	}
	return { headerLine, rows, tornBytes: tornStart === void 0 ? 0 : buffer.length - tornStart };
}

function classifyRows(rows) {
	const stats = { total: rows.length, unknown: new Map(), markerNeeded: 0 };
	for (const row of rows) {
		if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
		const type = row.type;
		if (typeof type !== "string") continue;
		if (KNOWN_SESSION_EVENT_TYPES.has(type) || CHUNK_ROW_TYPES.has(type)) continue;
		stats.unknown.set(type, (stats.unknown.get(type) ?? 0) + 1);
		if (row.ignorable !== true) stats.markerNeeded += 1;
	}
	return stats;
}

function listLogs(root) {
	const found = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			if (error.code === "ENOENT" || error.code === "EACCES") return;
			throw error;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name === "session.jsonl.zstd") found.push(full);
		}
	};
	walk(root);
	return found;
}

function rowTexts(rows) {
	return rows.map((row) => JSON.stringify(row));
}

function encodeArtifact(headerLine, rowLines) {
	const header = `${headerLine}\n`;
	const body = rowLines.length > 0 ? `${rowLines.join("\n")}\n` : "";
	const headerFrame = zstdCompressSync(header, { params: { [CHECKSUM_FLAG]: 1 } });
	const bodyFrame = zstdCompressSync(body, { params: { [CHECKSUM_FLAG]: 1 } });
	return Buffer.concat([headerFrame, bodyFrame]);
}

function main() {
	const [mode = "scan", rootArg, ...rest] = process.argv.slice(2);
	const root = resolve(rootArg ?? process.env.DSH_SESSIONS_ROOT ?? join(process.env.USERPROFILE, ".dsh", "sessions"));
	const dry = rest.includes("--dry");
	let onlyTypes;
	const onlyIndex = rest.indexOf("--types");
	if (onlyIndex !== -1 && rest[onlyIndex + 1] !== void 0) onlyTypes = new Set(rest[onlyIndex + 1].split(",").filter(Boolean));
	if (!["scan", "verify", "repair"].includes(mode)) {
		console.error(`usage: node session-log-repair.mjs <scan|verify|repair> [sessionsRoot] [--dry] [--types a,b]`);
		process.exit(2);
	}
	if (!existsSync(root)) {
		console.error(`sessions root not found: ${root}`);
		process.exit(1);
	}
	const logs = listLogs(root);
	console.error(`[${mode}] scanning ${logs.length} session.jsonl.zstd under ${root}`);
	const report = { scanned: [], affected: [] };
	let repaired = 0;
	let failed = 0;
	for (const path of logs) {
		let buffer;
		let beforeStat;
		try {
			beforeStat = statSync(path);
			buffer = readFileSync(path);
		} catch (error) {
			console.error(`[skip] cannot read ${path}: ${error.message}`);
			failed += 1;
			continue;
		}
		let decoded;
		try {
			decoded = decodeLog(buffer);
		} catch (error) {
			console.error(`[skip] decode failed for ${path}: ${error.message}`);
			failed += 1;
			continue;
		}
		const stats = classifyRows(decoded.rows);
		const entry = { path, headerId: null, total: stats.total, unknown: [...stats.unknown.entries()], markerNeeded: stats.markerNeeded, tornBytes: decoded.tornBytes };
		try {
			const header = JSON.parse(decoded.headerLine);
			entry.headerId = header?.id ?? null;
		} catch {}
		report.scanned.push(entry);
		if (stats.markerNeeded === 0) {
			console.log(`[ok]     ${entry.headerId ?? basename(dirname(path))}  (${stats.total} events, no unknown types)`);
			continue;
		}
		const types = [...stats.unknown.keys()];
		if (onlyTypes !== void 0) {
			const selected = types.filter((t) => onlyTypes.has(t));
			if (selected.length === 0 || selected.length !== types.length) {
				console.log(`[skip]   ${entry.headerId ?? basename(dirname(path))}  unknown types ${types.join(",")} not fully covered by --types`);
				continue;
			}
		}
		report.affected.push(entry);
		console.log(`[HIT]    ${entry.headerId ?? basename(dirname(path))}  ${stats.total} events; unknown: ${[...stats.unknown.entries()].map(([t, n]) => `${t}×${n}`).join(", ")}; needs marker on ${stats.markerNeeded}`);
		if (mode === "scan") continue;
		const changed = decoded.rows.map((row) => {
			if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
			if (typeof row.type !== "string") return row;
			if (KNOWN_SESSION_EVENT_TYPES.has(row.type) || CHUNK_ROW_TYPES.has(row.type)) return row;
			if (row.ignorable === true) return row;
			return { ...row, ignorable: true };
		});
		const next = encodeArtifact(decoded.headerLine, rowTexts(changed));
		if (mode === "verify") {
			let check;
			try {
				check = decodeLog(next);
			} catch (error) {
				console.error(`[VERIFY-FAIL] ${path}: re-encoded artifact does not decode: ${error.message}`);
				failed += 1;
				continue;
			}
			const stats2 = classifyRows(check.rows);
			let seq = -1;
			let contiguous = true;
			for (const row of check.rows) {
				if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
				if (CHUNK_ROW_TYPES.has(row.type)) {
					const members = row.data?.texts ?? row.data?.args;
					if (!Array.isArray(members) || members.length === 0 || !Number.isSafeInteger(row.seq0)) { contiguous = false; break; }
					if (row.seq0 !== seq + 1) { contiguous = false; break; }
					seq = row.seq0 + members.length - 1;
				} else {
					if (typeof row.seq !== "number" || row.seq !== seq + 1) { contiguous = false; break; }
					seq = row.seq;
				}
			}
			const expanded = check.rows.length;
			if (check.headerLine !== decoded.headerLine || expanded !== changed.length || stats2.markerNeeded !== 0 || !contiguous) {
				console.error(`[VERIFY-FAIL] ${path}: headerEqual=${check.headerLine === decoded.headerLine} rows=${expanded}/${changed.length} remainingUnknown=${stats2.markerNeeded} contiguous=${contiguous}`);
				failed += 1;
				continue;
			}
			console.log(`[verify-ok] ${path} (${expanded} rows, header unchanged, marker on unknown types, seq contiguous)`);
			continue;
		}
		if (dry) {
			console.log(`[dry]    would repair ${path}`);
			continue;
		}
		// Guard against racing a live backend append: refuse if the file changed since we read it.
		try {
			const afterStat = statSync(path);
			if (afterStat.size !== beforeStat.size || afterStat.mtimeMs !== beforeStat.mtimeMs) {
				console.error(`[skip]   ${path} changed while reading (live session?); close it and re-run`);
				failed += 1;
				continue;
			}
		} catch (error) {
			console.error(`[skip]   ${path}: ${error.message}`);
			failed += 1;
			continue;
		}
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const backup = `${path}.bak-${stamp}`;
		try {
			writeFileSync(backup, buffer);
			writeFileSync(`${path}.new`, next);
			renameSync(`${path}.new`, path);
		} catch (error) {
			console.error(`[FAIL]   ${path}: ${error.message}`);
			failed += 1;
			continue;
		}
		repaired += 1;
		console.log(`[repaired] ${path}\n          backup: ${backup}`);
	}
	console.log(`[done] scanned ${report.scanned.length}, affected ${report.affected.length}, repaired ${repaired}, failed/skipped ${failed}`);
}

const isEntry = process.argv[1] !== void 0 && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) main();

export { CHUNK_ROW_TYPES, KNOWN_SESSION_EVENT_TYPES, classifyRows, decodeLog, encodeArtifact, listLogs, rowTexts, scanZstdFrames };
