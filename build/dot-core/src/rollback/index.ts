/**
 * src/rollback/index.ts —— 「退回第 X 步/第 X 个里程碑」的整条链（A.11）。
 *
 * 顺序（A.11 定死的那五步）：
 *   a) 先给现在拍一份（label=pre-rollback，force 不复用）——回退本身要可撤；
 *   b) 找该里程碑结束时的那份快照，找不到就停，不硬来；
 *   c) 把该里程碑之后已结束的步骤标 rolled_back（走 ledger.endStep，不新造状态、不写裸 SQL）；
 *   d) 按快照整目录还原；
 *   e) 里程碑标回 active、之后的里程碑标 pending（不删行）、tasks.plan_version+1、写一条决定。
 *
 * 「可撤」的准确含义：**只撤文件**。拿 pre-rollback 那份再 restoreSnapshot 能把工作区
 * 放回回退前，但账本（步骤的 rolled_back、plan_version、里程碑状态、decisions）没有
 * 对应接口可以退，本模块也不假装能退，摘要与决定里都写明了这一点。
 *
 * 已知边界（不在本模块硬撑）：
 *   - 快照根必须在工作区外：在工作区内的话，还原的「清单外新文件要删」会把快照副本
 *     删光，pre-rollback 随之作废。入口用 assertSnapshotsRootOutside 挡住。
 *   - 文件系统动作不参与 SQLite 事务：c/d 之间崩了会留下「步骤已标回退、文件没还原」。
 *     这是方案的取舍（快照是最坏情况的底），重跑一次 rollbackToMilestone 会再拍一份
 *     pre-rollback 再还原，结果一致。
 *   - updateMilestone 用 COALESCE 更新，清不掉 ended_at：里程碑回到 active 后
 *     表里仍保留上一次的 ended_at。见 build/记录 的待办，不是这里能单独改的。
 */

import { relative, resolve } from "node:path";

import {
  LedgerError,
  endStep,
  getMilestone,
  getTask,
  listMilestones,
  listSnapshots,
  listSteps,
  recordDecision,
  setTaskState,
  updateMilestone,
  type LedgerDb,
  type MilestoneRow,
  type StepRow,
  type TaskState,
} from "../ledger/index.ts";
import {
  isRelInside,
  readDirSnapshotRecord,
  snapshotDir,
  type DirSnapshotRecord,
} from "./fs-snapshot.ts";
import { describeRestore, restoreSnapshot, restoredPaths, type RestoreReport } from "./restore.ts";

/** 可以被「回退」的已结束状态：还没开始的 pending/started 不改（它们本来就等于没做）。 */
const ENDED_BEFORE_ROLLBACK: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "interrupted",
  "skipped",
]);

export interface RollbackOptions {
  taskId: string;
  milestoneId: string;
  /** 声明过的工作区（快照源与还原目标）。 */
  workspace: string;
  /** 快照根目录（与 hands 用的同一个，入口传入）。 */
  snapshotsRoot: string;
}

export interface RollbackResult {
  taskId: string;
  milestone: { id: string; seq: number; title: string };
  /** 回退前那份存档（撤销这次回退就用它）。 */
  preRollbackSnapshotId: string;
  /** 实际用来还原的那份里程碑快照。 */
  restoredSnapshotId: string;
  /** 被写回（新增+覆盖）的文件，相对快照根。 */
  restored: string[];
  /** 被删掉的、那之后新建的文件。 */
  deleted: string[];
  /** 被标成 rolled_back 的步骤号。 */
  stepsRolledBack: string[];
  planVersion: number;
  decisionId: string;
  /** 给模型/人看的中文摘要（≤1200 字）。 */
  summary: string;
}

const SUMMARY_LIMIT = 1200;

function clip(text: string, limit = SUMMARY_LIMIT): string {
  if (text.length <= limit) return text;
  const marker = "…（摘要过长已截断，完整清单看账本 snapshots/decisions）";
  return `${text.slice(0, limit - marker.length)}${marker}`;
}

function preview(paths: string[], n = 5): string {
  if (paths.length === 0) return "无";
  const head = paths.slice(0, n).join("、");
  return paths.length > n ? `${head} 等 ${paths.length} 个` : head;
}

/**
 * 快照根必须在工作区之外。放在里面的话，还原的「清单外新文件要删」会把快照副本
 * 当成新建文件删掉，pre-rollback 存档随之作废——「回退可撤」直接失效。
 * 产品默认的 <dotDir>/snapshots 通常在工作区外，但那是惯例不是约束，所以这里硬拦。
 */
function assertSnapshotsRootOutside(workspace: string, snapshotsRoot: string): void {
  const ws = resolve(workspace);
  const sn = resolve(snapshotsRoot);
  if (isRelInside(relative(ws, sn))) {
    throw new LedgerError(
      "snapshots_root_inside_workspace",
      `快照根 ${sn} 在声明的工作区 ${ws} 之内：回退还原会把快照副本当成「那之后新建的文件」删掉，撤回也就作废了。把快照根挪到工作区外（产品默认 <dotDir>/snapshots）`,
    );
  }
}

/**
 * 该里程碑之后的步骤：分到更靠后里程碑的按里程碑算（即使 seq 有出入），
 * 没分里程碑的按 seq 与分界（该里程碑及更早里程碑里最大的步号）比。
 */
function stepsAfterMilestone(
  milestones: MilestoneRow[],
  target: MilestoneRow,
  steps: StepRow[],
): StepRow[] {
  const seqOf = new Map<string, number>();
  for (const m of milestones) seqOf.set(m.id, Number(m.seq));

  let boundary = 0;
  for (const s of steps) {
    if (s.milestone_id === null || s.milestone_id === undefined) continue;
    const seq = seqOf.get(s.milestone_id);
    if (seq !== undefined && seq <= Number(target.seq)) boundary = Math.max(boundary, Number(s.seq));
  }

  return steps.filter((s) => {
    if (s.status === "rolled_back") return false;
    if (!ENDED_BEFORE_ROLLBACK.has(s.status)) return false;
    if (s.milestone_id !== null && s.milestone_id !== undefined) {
      const seq = seqOf.get(s.milestone_id);
      if (seq !== undefined) return seq > Number(target.seq);
    }
    return Number(s.seq) > boundary;
  });
}

/** 找该里程碑「结束时」那份可用快照：同 task + 同 milestone 的 copy，最新的一条。 */
function findMilestoneSnapshot(
  db: LedgerDb,
  taskId: string,
  milestoneId: string,
): { id: string; record: DirSnapshotRecord } | null {
  for (const row of listSnapshots(db, taskId)) {
    if (row.kind !== "copy") continue;
    if (row.milestone_id !== milestoneId) continue;
    const record = readDirSnapshotRecord(row);
    if (record === null) continue;
    return { id: row.id, record };
  }
  return null;
}

export function rollbackToMilestone(db: LedgerDb, opts: RollbackOptions): RollbackResult {
  // 第 0 步（早于任何写）：快照根不许在工作区里，否则还原会连自己的存档一起删。
  assertSnapshotsRootOutside(opts.workspace, opts.snapshotsRoot);

  const task = getTask(db, opts.taskId);
  if (task === null) throw new LedgerError("task_not_found", `找不到任务 ${opts.taskId}`);

  const target = getMilestone(db, opts.milestoneId);
  if (target === null || String(target.task_id) !== opts.taskId) {
    throw new LedgerError(
      "milestone_not_found",
      `任务 ${opts.taskId} 下没有里程碑 ${opts.milestoneId}（不能跨任务回退）`,
    );
  }
  const milestones = listMilestones(db, opts.taskId);

  // b) 先找目标快照（只读）。放在拍 pre-rollback 之前：找不到就不该在快照根里留垃圾。
  const targetSnap = findMilestoneSnapshot(db, opts.taskId, opts.milestoneId);
  if (targetSnap === null) {
    throw new LedgerError(
      "milestone_snapshot_missing",
      `里程碑 ${target.seq}「${target.title}」没有可用的整目录快照，不能回退。先在该里程碑收尾时拍快照（snapshotDir），再退回。`,
    );
  }

  // a) 回退前先存档，保证这次回退可撤。
  const pre = snapshotDir(
    { db, snapshotsRoot: opts.snapshotsRoot },
    {
      taskId: opts.taskId,
      // 故意不挂 milestone_id：否则下一次查「里程碑结束快照」会挑到这份存档。
      milestoneId: null,
      sourcePath: opts.workspace,
      label: "pre-rollback",
      force: true,
    },
  );

  // c) 之后的已结束步骤 → rolled_back（走账本函数，事件和链一起写）。
  const stepsRolledBack: string[] = [];
  for (const step of stepsAfterMilestone(milestones, target, listSteps(db, opts.taskId))) {
    const out = endStep(db, step.id, {
      status: "rolled_back",
      error: `按用户要求退回里程碑 ${target.seq}`,
    });
    if (out.applied) stepsRolledBack.push(step.id);
  }

  // d) 真还原。
  const report: RestoreReport = restoreSnapshot(db, {
    snapshotId: targetSnap.id,
    workspace: opts.workspace,
  });

  // e) 里程碑与任务账。
  updateMilestone(db, opts.milestoneId, { state: "active" });
  for (const m of milestones) {
    if (Number(m.seq) > Number(target.seq)) updateMilestone(db, m.id, { state: "pending" });
  }
  const nextVersion = Number(task.plan_version) + 1;
  setTaskState(db, opts.taskId, task.state as TaskState, {
    plan_version: nextVersion,
    reason: `rolled_back_to_milestone_${target.seq}`,
  });

  const decision = recordDecision(db, {
    task_id: opts.taskId,
    question: `按你的要求退回里程碑 ${target.seq}「${target.title}」？`,
    answer:
      `已退回：文件按里程碑 ${target.seq} 的快照还原（覆盖 ${report.overwritten.length}、` +
      `新增 ${report.added.length}、删除 ${report.deleted.length}），` +
      `${stepsRolledBack.length} 步标成 rolled_back，计划版本升到 ${nextVersion}。` +
      `回退前的存档是 ${pre.snapshot.id}：它只能把文件放回去，账本（步骤状态、计划版本、里程碑）不会跟着回退。`,
    decided_by: "dsbot",
  });

  const summary = clip(
    [
      `已退回里程碑 ${target.seq}「${target.title}」。`,
      `- ${describeRestore(report)}`,
      `- 恢复的文件：${preview(restoredPaths(report))}`,
      `- 删掉的新增文件：${preview(report.deleted)}`,
      `- 标成 rolled_back 的步骤：${stepsRolledBack.length} 个`,
      `- 里程碑 ${target.seq} 重新设为进行中；它之后的里程碑退回待办（行保留）；计划版本 ${task.plan_version} → ${nextVersion}`,
      `- 回退前的存档快照：${pre.snapshot.id}（能撤的是文件：拿它还原可回到回退前的内容；账本状态不回退）`,
      `- 决定已记入账本：${decision.id}`,
    ].join("\n"),
  );

  return {
    taskId: opts.taskId,
    milestone: { id: target.id, seq: Number(target.seq), title: String(target.title) },
    preRollbackSnapshotId: pre.snapshot.id,
    restoredSnapshotId: targetSnap.id,
    restored: restoredPaths(report),
    deleted: report.deleted,
    stepsRolledBack,
    planVersion: nextVersion,
    decisionId: decision.id,
    summary,
  };
}

export {
  snapshotDir,
  readDirSnapshotRecord,
  scanTree,
  SNAPSHOT_MAX_FILE_BYTES,
  SNAPSHOT_MAX_TOTAL_BYTES,
  type DirSnapshotRecord,
  type SnapshotDirDeps,
  type SnapshotDirRequest,
  type SnapshotDirResult,
  type SnapshotFileEntry,
  type SnapshotSkip,
} from "./fs-snapshot.ts";

export {
  restoreSnapshot,
  restoredPaths,
  describeRestore,
  type RestoreOptions,
  type RestoreReport,
} from "./restore.ts";
