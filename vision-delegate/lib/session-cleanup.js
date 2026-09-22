// dsh-vision-delegate — 临时视觉子会话的清理策略（「完成即删 + 启动补删」）
//
// 问题：每次视觉委派都会 spawn 一个**全新会话**的子代理（`subagents.start("spawn", …)`），
// 而 DSH 内核没有删除会话的 API（`dsh-session-persistence` 只有 create/open/stat/list/flush，
// 官方 session RPC 里也没有删除动词），所以这些临时会话会永久留在
// `$DSH_HOME/sessions/<项目键>/<会话id>/` 里。
//
// 分工（重要）：
//   * **机制**归 `dsh-workspace-manager`：它发布宿主服务 `sessionRemoval`
//     （`ctx.provide('sessionRemoval', …)`），内部是它已经测过的文件级删除。
//     本插件**不**自己删文件、也不自己拼路径。
//   * **策略**归本插件：只有本插件知道哪些会话是自己起的临时视觉子会话、什么时候算完事。
//
// 两件事：
//   1. `track(id)`：spawn 一拿到子会话 id 就把它记进**账本**（落盘），并去服务里登记归属；
//   2. `finish(id)`：子代理跑完（结论已经拿到）**立刻**尽力删掉它；
//      `sweep()`：插件启动时把账本里"上次没清干净"的 id 逐个补删（崩溃/异常退出会留下孤儿）。
//   不做定时器式全盘扫描：删除永远由一个具体的 id 驱动。
//
// 优雅降级：服务不在（没装 workspace-manager、版本不对、`ctx.get` 拿不到）时，视觉功能
// **照常可用**，只是不清理 —— 最多在启动时记一条日志。账本里的 id 原样保留，服务将来
// 出现时再补删。

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** dsh-workspace-manager 发布的宿主服务名（消费方按这个名字 `ctx.get()`；**不要**写进 inject）。 */
export const SESSION_REMOVAL_SERVICE = "sessionRemoval";
/** 本插件在做会话清理时的 owner 标识（服务的白名单键，必须与插件名一致）。 */
export const CLEANUP_OWNER = "dsh-vision-delegate";
/** 账本文件名（沿用本仓库插件的 `dsh-<名字>.state.json` 约定）。 */
export const LEDGER_FILE_NAME = "dsh-vision-delegate.state.json";
export const LEDGER_VERSION = 1;

const isId = (value) => typeof value === "string" && value.trim() !== "";

/** 解析 Harness home（与内核/其它插件一致：DSH_HOME 优先，否则 `~/.dsh`）。 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const configured = env.DSH_HOME;
  return typeof configured === "string" && configured.trim() !== "" ? configured : join(home, ".dsh");
}

/** 账本文件绝对路径。 */
export function defaultLedgerPath(env = process.env, home = homedir()) {
  return join(resolveDshHome(env, home), LEDGER_FILE_NAME);
}

/** 解析账本内容；任何损坏都退化为空账本，绝不抛错阻断启动。 */
export function parseLedger(text) {
  try {
    const parsed = JSON.parse(text);
    const ids = parsed?.pendingSessionIds;
    return { version: LEDGER_VERSION, pendingSessionIds: Array.isArray(ids) ? [...new Set(ids.filter(isId))] : [] };
  } catch {
    return { version: LEDGER_VERSION, pendingSessionIds: [] };
  }
}

/**
 * 原子替换文件，并对 Windows 上的"瞬时占用"做有限重试
 * （杀软/索引器/别的进程短暂持有句柄会报 EPERM/EBUSY/EACCES，重试即可成功）。
 */
async function renameWithRetry(from, to) {
  const retryable = new Set(["EPERM", "EBUSY", "EACCES"]);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 4 || !retryable.has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

/**
 * 打开（或创建）临时会话账本。
 *
 * 同步返回句柄（`apply()` 是同步的），首次异步操作前完成一次读取：
 * `ready` 是这个 Promise；`ids()` 只在 `await ready` 之后才反映磁盘内容。
 *
 * @param options - `{ file?, logger? }`；`file` 默认 {@link defaultLedgerPath}。
 * @returns `{ file, ready, ids, add, remove, debugState }`。
 */
export function openLedger(options = {}) {
  const file = options.file ?? defaultLedgerPath();
  const logger = options.logger;
  let state = { version: LEDGER_VERSION, pendingSessionIds: [] };
  const ready = readFile(file, "utf8").then(
    (text) => {
      state = parseLedger(text);
    },
    (error) => {
      if (error?.code !== "ENOENT") {
        logger?.warn?.("dsh-vision-delegate: 读取临时会话账本失败，按空账本处理：%s", String(error));
      }
    }
  );

  let tail = Promise.resolve();
  /** 串行化所有写操作（读-改-写必须在队列内，否则并发会互相覆盖）。 */
  const enqueue = (operation) => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => {},
      () => {}
    );
    return result;
  };

  async function persist() {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await renameWithRetry(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  /** 只在队列内做"读-改-写"；返回是否真的发生了变化（没变不写盘）。 */
  const mutate = (change) =>
    enqueue(async () => {
      const next = change(state.pendingSessionIds);
      if (next === undefined) return false;
      state = { version: LEDGER_VERSION, pendingSessionIds: next };
      await persist();
      return true;
    });

  return {
    file,
    ready: ready.catch(() => {}),
    /** 当前欠着的 id（副本；调用方应确保 `ready` 已 settle）。 */
    ids() {
      return [...state.pendingSessionIds];
    },
    /** 记下一批"我起的、还没清掉"的 id（幂等）。 */
    async add(ids) {
      await ready;
      const incoming = (Array.isArray(ids) ? ids : [ids]).filter(isId);
      if (incoming.length === 0) return false;
      return mutate((current) => {
        const next = [...current];
        for (const id of incoming) if (!next.includes(id)) next.push(id);
        return next.length === current.length ? undefined : next;
      });
    },
    /** 划掉一批已经清干净的 id（幂等）。 */
    async remove(ids) {
      await ready;
      const outgoing = new Set((Array.isArray(ids) ? ids : [ids]).filter(isId));
      if (outgoing.size === 0) return false;
      return mutate((current) => {
        const next = current.filter((id) => !outgoing.has(id));
        return next.length === current.length ? undefined : next;
      });
    },
    /** 内部状态快照（测试用）。 */
    debugState() {
      return JSON.parse(JSON.stringify(state));
    },
  };
}

/**
 * 从 `subagents.start()` 的返回值里取子会话 id。
 *
 * 官方契约（`dsh-subagent/lib/types/types.d.ts:292-298`）：本地 run 的 `run.id`
 * **就是**已发布的子会话 id；`run.localAgent.session.id` 是同一个值，作为兜底。
 */
export function sessionIdOfRun(run) {
  if (isId(run?.id)) return run.id;
  const fallback = run?.localAgent?.session?.id;
  return isId(fallback) ? fallback : undefined;
}

/**
 * 构造清理器（策略层）。
 * @param options - `{ ctx, ledger, logger?, owner?, serviceName? }`
 * @returns `{ owner, serviceName, service(), available(), track, finish, sweep }`。
 */
export function createSessionReaper({
  ctx,
  ledger,
  logger,
  owner = CLEANUP_OWNER,
  serviceName = SESSION_REMOVAL_SERVICE,
} = {}) {
  /** 探测式获取服务：`ctx.get()` 对未发布的服务返回 undefined（**不抛**）。 */
  const service = () => {
    try {
      return ctx?.get?.(serviceName) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const available = () => typeof service()?.remove === "function";

  /**
   * 记下"这个 id 是我起的"，并把它登记到服务里（白名单 + **父会话指针**）。
   * **先落盘再登记**：任何时刻崩溃，下次启动都能从账本里把它补删。
   * 绝不抛错（清理不是视觉功能的一部分，不能反过来打断它）。
   *
   * `options.parentSessionId` = **发起这次委派的会话 id**（调用方给，通常是 `agent.id`）。
   * 它是 dsh-workspace-manager 的「会话树」唯一的父子关系来源（内核没有这份数据），
   * 所以登记之后，设置页才能把这个视觉子会话显示成主会话的子会话、删主会话时一并处理。
   * 给不出父（拿不到会话 id）时照常登记，只是父未知 —— 不猜、不错认。
   * @param sessionId - 子会话 id（`run.id`）。
   * @param options - `{ parentSessionId? }`。
   * @returns 是否记上了账（false = id 不合法或落账失败）。
   */
  async function track(sessionId, options = {}) {
    if (!isId(sessionId)) return false;
    const parentSessionId = isId(options?.parentSessionId) ? options.parentSessionId : undefined;
    try {
      await ledger.add([sessionId]);
    } catch (error) {
      logger?.warn?.("dsh-vision-delegate: 临时会话 id 落账失败（下次启动可能漏删）：%s", String(error?.message ?? error));
      return false;
    }
    try {
      // 服务面 v2：claim 是**异步**的（父子关系会落盘），这里显式 await（不 await 也不影响进程内的白名单）。
      // 不给父时传 undefined，**不会**抹掉之前记下的父指针（启动补删路径就走这条）。
      await service()?.claim?.(owner, [sessionId], parentSessionId === undefined ? undefined : { parentSessionId });
    } catch {
      /* 登记失败不影响删除：remove 会以结构化错误说明原因 */
    }
    return true;
  }

  /**
   * 完成即删：把一个临时子会话交给服务删除（**尽力**，绝不抛错）。
   * @returns `{ outcome, code?, message? }`：
   *   - `removed` 删掉了（账本已划掉）；
   *   - `absent` 工件早就不在（`session-not-found`，按"已清理"处理，账本已划掉）；
   *   - `foreign` 这个 id 登记在别的 owner 名下（不是我们的，账本划掉、不动磁盘）；
   *   - `kept` 暂时删不掉（活跃/不安全/其它失败）——留在账本里，下次启动再试；
   *   - `no-service` 清理服务不可用——留在账本里；
   *   - `skipped` id 不合法（没记过账）。
   */
  async function finish(sessionId) {
    if (!isId(sessionId)) return { outcome: "skipped" };
    if (!available()) return { outcome: "no-service" };
    try {
      await service().remove(sessionId, { owner });
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "";
      if (code === "session-not-found") {
        await forget([sessionId]);
        return { outcome: "absent", code };
      }
      if (code === "not-claimed") {
        await forget([sessionId]);
        return { outcome: "foreign", code, message: String(error?.message ?? error) };
      }
      return { outcome: "kept", code, message: String(error?.message ?? error) };
    }
    await forget([sessionId]);
    return { outcome: "removed" };
  }

  /** 划账本（失败只告警：下次启动多删一次是幂等的，删不到也只是多一条账）。 */
  async function forget(ids) {
    try {
      await ledger.remove(ids);
    } catch (error) {
      logger?.warn?.("dsh-vision-delegate: 划账本失败（不影响删除结果）：%s", String(error?.message ?? error));
    }
  }

  /**
   * 启动补删：把账本里还没清干净的 id 逐个补删。
   * 服务的内存登记在重启后是空的，所以补删前先按账本重新登记归属。
   * @returns 汇总 `{ attempted, removed, absent, foreign, kept, unavailable, available }`。
   */
  async function sweep() {
    await ledger.ready;
    const pending = ledger.ids();
    const summary = { attempted: 0, removed: [], absent: [], foreign: [], kept: [], unavailable: 0, available: available() };
    if (pending.length === 0) return summary;
    if (!available()) {
      summary.unavailable = pending.length;
      logger?.warn?.(
        "dsh-vision-delegate: 会话清理服务 %s 不可用，%d 个临时视觉子会话暂不清理（装上 dsh-workspace-manager 后会在下次启动补删）",
        serviceName,
        pending.length
      );
      return summary;
    }
    try {
      // 不带父重登记：**不会**抹掉第一次 track 记下的父指针（服务面 v2 的幂等语义）。
      await service()?.claim?.(owner, pending);
    } catch {
      /* 登记失败交给 remove 逐项报错 */
    }
    for (const sessionId of pending) {
      summary.attempted += 1;
      const result = await finish(sessionId);
      // 分类入账（未知/删不掉的都归 kept，下次启动再试）。
      if (result.outcome === "removed" || result.outcome === "absent" || result.outcome === "foreign") {
        summary[result.outcome].push({ id: sessionId, code: result.code });
      } else {
        summary.kept.push({ id: sessionId, code: result.code });
      }
    }
    const cleaned = summary.removed.length + summary.absent.length;
    if (cleaned > 0) {
      logger?.info?.("dsh-vision-delegate: 启动补删清掉了 %d 个临时视觉子会话（删除 %d、已不在 %d）", cleaned, summary.removed.length, summary.absent.length);
    }
    if (summary.kept.length > 0) {
      logger?.warn?.(
        "dsh-vision-delegate: 还有 %d 个临时会话这次没清掉，留待下次启动：%s",
        summary.kept.length,
        summary.kept.map((entry) => `${entry.id}(${entry.code || "unknown"})`).join(", ")
      );
    }
    return summary;
  }

  return { owner, serviceName, service, available, track, finish, sweep };
}
