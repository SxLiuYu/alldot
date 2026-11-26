/**
 * gate.test.ts —— src/gate 的四组必测 + 六档判定边界。
 * 测试入口固定：node build/tools/run-tests.mjs --only gate
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

import { migrate } from "../ledger/index.ts";
import { createTask, makeTempDb, countRows } from "../ledger/test-helpers.ts";
import {
  classifySideEffect,
  createApproval,
  decideApproval,
  execArgVerdict,
  isProtectedApp,
  judgeTier,
  sweepExpired,
  verifyIdempotent,
} from "./index.ts";

// ────────────────────────────────────────────────────────────────────────────
// 1. 三档同一动作不同参数落在不同档
// ────────────────────────────────────────────────────────────────────────────

test("同一动作 exec：git status=1、node build.js=2、python -c=4", () => {
  const read = judgeTier({ tool: "exec", action: "exec", args: { command: "git status" } });
  const write = judgeTier({
    tool: "exec",
    action: "exec",
    args: { command: "node build.js" },
    inWorkspace: true,
  });
  const execCode = judgeTier({
    tool: "exec",
    action: "exec",
    args: { command: "python -c \"import os; os.system('whoami')\"" },
  });

  assert.equal(read.tier, 1);
  assert.equal(read.rule, "exec_readonly");
  assert.equal(read.handling, "allow");
  assert.equal(read.sideEffect, "safe");

  assert.equal(write.tier, 2);
  assert.equal(write.rule, "exec_workspace_write");
  assert.equal(write.handling, "snapshot");
  assert.equal(write.sideEffect, "replayable");

  assert.equal(execCode.tier, 4);
  assert.equal(execCode.handling, "ask");
  assert.equal(execCode.sideEffect, "unknown");
  assert.ok(execCode.exec?.markers.includes("-c"), `markers=${JSON.stringify(execCode.exec?.markers)}`);
});

test("同一动作浏览器：fill=3、submit=4", () => {
  const fill = judgeTier({ tool: "logged_browser", action: "fill", args: { field: "search" } });
  const submit = judgeTier({ tool: "logged_browser", action: "submit", args: { field: "search" } });
  assert.equal(fill.tier, 3);
  assert.equal(submit.tier, 4);
  assert.equal(submit.rule, "irreversible");
});

test("判定顺序：身份与钱=5、受保护程序=6、DENY=6、拿不准=4", () => {
  assert.equal(judgeTier({ tool: "desktop", action: "click", args: { flags: ["password"] } }).tier, 5);
  assert.equal(judgeTier({ tool: "desktop", action: "click", app: "C:/Program Files/Tencent/Weixin/Weixin.exe" }).tier, 6);
  assert.equal(judgeTier({ tool: "some_new_tool", action: "go", denyTools: ["some_new_tool"] }).tier, 6);
  assert.equal(judgeTier({ tool: "mystery", action: "frobnicate" }).tier, 4);
});

test("改 dot 自己（配置/账本/db）→ 6 档直接拒，不落 2 档快照放行", () => {
  const config = judgeTier({
    tool: "write",
    action: "edit",
    args: { path: "C:/Users/1/.allbot/dot/config.json" },
    inWorkspace: true,
  });
  assert.equal(config.tier, 6);
  assert.equal(config.rule, "dot_self");
  assert.equal(config.handling, "deny");

  const ledger = judgeTier({
    tool: "edit",
    action: "write",
    args: { target: "C:/Users/1/.allbot/dot/ledger.db" },
    inWorkspace: true,
  });
  assert.equal(ledger.tier, 6);
  assert.equal(ledger.rule, "dot_self");
  assert.equal(ledger.handling, "deny");

  const allbotJson = judgeTier({
    tool: "edit",
    args: { path: "C:/Users/1/.allbot/allbot.json" },
    inWorkspace: true,
  });
  assert.equal(allbotJson.tier, 6);
});

test("exec 正文里的危险/身份词先于命令白名单生效：rm -rf、del /f → 6；密码 → 5", () => {
  for (const command of ["rm -rf build", "del /f /q data.db"]) {
    const verdict = judgeTier({ tool: "exec", action: "exec", args: { command }, inWorkspace: true });
    assert.equal(verdict.tier, 6, `${command}: ${verdict.rule}`);
    assert.equal(verdict.handling, "deny");
  }
  const password = judgeTier({
    tool: "exec",
    action: "exec",
    args: { command: "python read_password.py" },
    inWorkspace: true,
  });
  assert.equal(password.tier, 5);
  assert.equal(password.rule, "identity_money");
});

// ────────────────────────────────────────────────────────────────────────────
// 回归（错一）：5.6 档 2 写明「本地 git 提交」放行＋快照，不可逆关键词不许抢在
// git 子命令前面；push 方案没定档，落 4 档并在理由里注明。
// ────────────────────────────────────────────────────────────────────────────

test("git 本地提交/打 tag 落 2 档（5.6 档 2）；push 未定档落 4 档并注明", () => {
  const commit = judgeTier({
    tool: "exec",
    action: "exec",
    args: { command: "git commit -m 'wip'" },
    inWorkspace: true,
  });
  assert.equal(commit.tier, 2, `git commit → ${commit.tier}/${commit.rule}`);
  assert.equal(commit.rule, "git_local");
  assert.equal(commit.handling, "snapshot");
  assert.equal(commit.sideEffect, "replayable");

  const tag = judgeTier({
    tool: "exec",
    action: "exec",
    args: { command: "git tag -a v1 -m 'x'" },
    inWorkspace: true,
  });
  assert.equal(tag.tier, 2, `git tag → ${tag.tier}/${tag.rule}`);
  assert.equal(tag.rule, "git_local");

  // checkout 曾被 HUMAN_ONLY_RE 的 checkout（电商下单）抓成 5 档。
  const checkout = judgeTier({
    tool: "exec",
    action: "exec",
    args: { command: "git checkout main" },
    inWorkspace: true,
  });
  assert.equal(checkout.tier, 2, `git checkout → ${checkout.tier}/${checkout.rule}`);

  const push = judgeTier({
    tool: "exec",
    action: "exec",
    args: { command: "git push origin main" },
    inWorkspace: true,
  });
  assert.equal(push.tier, 4);
  assert.equal(push.rule, "git_push");
  assert.equal(push.handling, "ask");
  assert.match(push.reason, /没给 push 定档|待拍板/, push.reason);

  // 第 2 档仍要工作区证据。
  const noWorkspace = judgeTier({ tool: "exec", action: "exec", args: { command: "git commit -m x" } });
  assert.equal(noWorkspace.tier, 4);
  assert.equal(noWorkspace.rule, "workspace_unknown");

  // 带执行性语法的 git 命令不走这条：链式命令不许搭便车。
  const chained = judgeTier({
    tool: "exec",
    action: "exec",
    args: { command: "git commit -m x && rm -rf build" },
    inWorkspace: true,
  });
  assert.equal(chained.tier, 6, `链式 → ${chained.tier}/${chained.rule}`);

  const withSyntax = judgeTier({
    tool: "exec",
    action: "exec",
    args: { command: "git -c core.pager=cat commit -m x" },
    inWorkspace: true,
  });
  assert.equal(withSyntax.tier, 4);
});

// ────────────────────────────────────────────────────────────────────────────
// 回归（错二）：关键词带词边界；路径与文件名不参与行动词判定。
// ────────────────────────────────────────────────────────────────────────────

test("文件名不误判：skill.ts / killer.txt / commit.md / token.ts / border.css 落 2 档", () => {
  for (const path of ["skill.ts", "killer.txt", "commit.md", "token.ts", "border.css"]) {
    const verdict = judgeTier({ tool: "write", action: "write", args: { path }, inWorkspace: true });
    assert.equal(verdict.tier, 2, `${path} → ${verdict.tier}/${verdict.rule}`);
    assert.equal(verdict.rule, "workspace_write");
    assert.equal(verdict.handling, "snapshot");
  }

  // 命令里以文件参数出现时同样不误判：读 token.ts 是只读。
  const cat = judgeTier({ tool: "exec", action: "exec", args: { command: "cat token.ts" }, inWorkspace: true });
  assert.equal(cat.tier, 1, `cat token.ts → ${cat.tier}/${cat.rule}`);
  assert.equal(cat.rule, "exec_readonly");

  // dot 的源码路径不再算「改这套系统自己」；配置与账本仍然 6 档。
  const source = judgeTier({
    tool: "write",
    action: "write",
    args: { path: "build/dot-core/src/gate/x.ts" },
    inWorkspace: true,
  });
  assert.equal(source.tier, 2, `dot-core 源码 → ${source.tier}/${source.rule}`);
  const dotConfig = judgeTier({
    tool: "write",
    action: "write",
    args: { path: "C:/Users/1/.allbot/dot/config.json" },
    inWorkspace: true,
  });
  assert.equal(dotConfig.tier, 6);
  assert.equal(dotConfig.rule, "dot_self");
});

test("词边界只削掉误判，不削掉真动作：delete/kill/submit/删除 仍然命中", () => {
  assert.equal(judgeTier({ tool: "write", action: "delete", args: { path: "a.txt" }, inWorkspace: true }).tier, 6);
  assert.equal(judgeTier({ tool: "desktop", action: "click", args: { flags: ["kill"] } }).tier, 6);
  assert.equal(
    judgeTier({ tool: "write", action: "write", args: { path: "a.txt", intent: "删除" }, inWorkspace: true }).tier,
    6,
  );
  assert.equal(judgeTier({ tool: "logged_browser", action: "submit" }).tier, 4);
  // 中文按子串：长中文动作串里的关键词照样命中。
  assert.equal(
    judgeTier({ tool: "write", action: "删除文件", args: { path: "a.txt" }, inWorkspace: true }).tier,
    6,
  );
  // 身份词在文件名里仍是证据（read_password.py → 5）。
  const password = judgeTier({
    tool: "exec",
    action: "exec",
    args: { command: "python read_password.py" },
    inWorkspace: true,
  });
  assert.equal(password.tier, 5);
  assert.equal(password.rule, "identity_money");
  // classifySideEffect 与 judge 共用词表后，中文动作也能被识别（旧 \b…\b 包中文从不命中）。
  assert.equal(classifySideEffect("write", { action: "删除" }), "unknown");
});

// ────────────────────────────────────────────────────────────────────────────
// 复审回归：git 不能绕过「改 dot 自己」；inWorkspace=false 的 git 命令按超范围
// 记裁判；会丢本地工作的 git 子命令不跟「本地提交」一起自动放行。
// ────────────────────────────────────────────────────────────────────────────

const DOT_CFG = "C:/Users/1/.allbot/dot/config.json";

test("只读碰 dot 路径放行（5.6 档 1），写仍然 6 档；git 目标落在 dot 自己时也 6 档", () => {
  for (const input of [
    { tool: "read", action: "read", args: { path: DOT_CFG } },
    { tool: "read", action: "read", args: { path: "C:/Users/1/.allbot/dot/ledger.db" } },
    { tool: "exec", action: "exec", args: { command: `cat ${DOT_CFG}` }, inWorkspace: true },
    { tool: "exec", action: "exec", args: { command: "ls C:/Users/1/.allbot/dot" }, inWorkspace: true },
    { tool: "read", action: "read", args: { path: "C:/Users/1/.dsh/bot/memory/team/MEMORY.md" } },
  ]) {
    const verdict = judgeTier(input);
    assert.equal(verdict.tier, 1, `${input.tool} ${JSON.stringify(input.args)} → ${verdict.tier}/${verdict.rule}`);
    assert.equal(verdict.handling, "allow");
  }

  // 写、以及 git 的写类子命令，目标落在 dot 自己 → 6 档，不会被「本地 git 操作」放行。
  for (const command of [
    `git checkout -- ${DOT_CFG}`,
    `git restore ${DOT_CFG}`,
    `git add ${DOT_CFG}`,
    `git commit ${DOT_CFG} -m x`,
  ]) {
    const verdict = judgeTier({ tool: "exec", action: "exec", args: { command }, inWorkspace: true });
    assert.equal(verdict.tier, 6, `${command} → ${verdict.tier}/${verdict.rule}`);
    assert.equal(verdict.rule, "dot_self");
    assert.equal(verdict.handling, "deny");
  }
  const relWrite = judgeTier({
    tool: "write",
    action: "write",
    args: { path: ".allbot/dot/config.json" },
    inWorkspace: true,
  });
  assert.equal(relWrite.tier, 6);
  assert.equal(relWrite.rule, "dot_self");
  // 只是名字里带 dot 的普通文件不算改 dot 自己。
  const plain = judgeTier({ tool: "write", action: "write", args: { path: "dot-config.json" }, inWorkspace: true });
  assert.equal(plain.tier, 2, `dot-config.json → ${plain.tier}/${plain.rule}`);
});

test("inWorkspace=false 的 git 命令一律 4 档超范围并记裁判，checkout 不再掉到 5 档", () => {
  for (const command of ["git checkout main", "git commit -m x", "git push", "git status"]) {
    const verdict = judgeTier({ tool: "exec", action: "exec", args: { command }, inWorkspace: false });
    assert.equal(verdict.tier, 4, `${command} → ${verdict.tier}/${verdict.rule}`);
    assert.equal(verdict.rule, "out_of_scope_or_budget");
    assert.equal(verdict.judgeNeeded, true);
  }
});

test("会丢本地工作的 git 子命令落 4 档，不跟本地提交一起自动放行", () => {
  for (const command of ["git reset --hard HEAD~3", "git clean -fd", "git branch -D main", "git stash drop", "git tag -d v1"]) {
    const verdict = judgeTier({ tool: "exec", action: "exec", args: { command }, inWorkspace: true });
    assert.equal(verdict.tier, 4, `${command} → ${verdict.tier}/${verdict.rule}`);
    assert.equal(verdict.rule, "git_destructive");
    assert.equal(verdict.handling, "ask");
  }
  // 同族但不动历史的仍然 2 档：建分支、暂存、普通提交。
  for (const command of ["git branch feature/x", "git stash", "git commit -m 'remove old files'"]) {
    const verdict = judgeTier({ tool: "exec", action: "exec", args: { command }, inWorkspace: true });
    assert.equal(verdict.tier, 2, `${command} → ${verdict.tier}/${verdict.rule}`);
    assert.equal(verdict.rule, "git_local");
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 2. side_effect 与受保护程序
// ────────────────────────────────────────────────────────────────────────────

test("classifySideEffect：只读 safe、工作区内写 replayable、exec/提交 unknown", () => {
  assert.equal(classifySideEffect("read", { action: "read" }), "safe");
  assert.equal(classifySideEffect("write", { action: "write" }), "replayable");
  assert.equal(classifySideEffect("logged_browser", { action: "fill", reversible: true }), "replayable");
  assert.equal(classifySideEffect("exec", { action: "exec", argv: ["git", "status"] }), "unknown");
  assert.equal(classifySideEffect("logged_browser", { action: "submit" }), "unknown");
  assert.equal(classifySideEffect("read", { action: "read", side_effect: "unknown" }), "unknown");
});

test("isProtectedApp：大小写、路径、扩展名不敏感；额外名单生效；普通程序不误伤", () => {
  assert.equal(isProtectedApp("Weixin"), true);
  assert.equal(isProtectedApp("C:/Program Files/Tencent/Weixin/Weixin.exe"), true);
  assert.equal(isProtectedApp("wechat.exe"), true);
  assert.equal(isProtectedApp("Notepad", ["notepad"]), true);
  assert.equal(isProtectedApp("notepad++"), false);
  assert.equal(isProtectedApp(""), false);
});

// ────────────────────────────────────────────────────────────────────────────
// 3. execArgVerdict：python -c 这类写法问到 4 档，判不清拒
// ────────────────────────────────────────────────────────────────────────────

test("execArgVerdict：python -c / node --eval / pwsh -Command 全部 4 档且 refuseIfUnclear", () => {
  const py = execArgVerdict("python", ["-c", "print(1)"]);
  const nodeEval = execArgVerdict("node", ["--eval", "process.exit(0)"]);
  const ps = execArgVerdict("pwsh", ["-Command", "Get-ChildItem"]);

  for (const verdict of [py, nodeEval, ps]) {
    assert.equal(verdict.tier, 4);
    assert.equal(verdict.executableSyntax, true);
    assert.equal(verdict.refuseIfUnclear, true);
    assert.equal(verdict.decision, "ask_executable_syntax");
  }
  assert.ok(py.markers.includes("-c"));
  assert.ok(nodeEval.markers.includes("--eval"));
  assert.ok(ps.markers.includes("-Command"), JSON.stringify(ps.markers));
});

test("execArgVerdict：管道、&&、重定向、反引号同样 4 档", () => {
  const cases = [
    "python -c 'x' | cat",
    "git status && git push",
    "node build.js > out.txt",
    "node `whoami`",
    "python -c \"$(whoami)\"",
  ];
  for (const command of cases) {
    const verdict = execArgVerdict("", command);
    assert.equal(verdict.tier, 4, `${command}: ${JSON.stringify(verdict)}`);
    assert.equal(verdict.refuseIfUnclear, true);
    assert.ok(verdict.markers.length > 0, `${command} 没抓到标记`);
  }
});

test("execArgVerdict：白名单+干净参数才给 1/2 档；名单外程序 4 档", () => {
  assert.equal(execArgVerdict("git", ["status"]).tier, 1);
  assert.equal(execArgVerdict("node", ["build", "x.js"]).tier, 2);
  const unknown = execArgVerdict("curl", ["http://example.test"]);
  assert.equal(unknown.tier, 4);
  assert.equal(unknown.decision, "ask_non_whitelist");
  assert.equal(unknown.refuseIfUnclear, true);
});

// ────────────────────────────────────────────────────────────────────────────
// 4. 审批状态机：幂等、条件更新、TTL
// ────────────────────────────────────────────────────────────────────────────

test("同一动作重发不产生第二条审批（参数键序不同也算同一动作）", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    createTask(t.db, { id: "t-idem" });
    const base = {
      taskId: "t-idem",
      tool: "desktop",
      tier: 4 as const,
      title: "要点一次确认按钮",
      detail: { question: "同意吗？", options: ["同意", "拒绝"] },
    };
    const first = verifyIdempotent(t.db, { ...base, args: { b: 2, a: 1 } });
    const second = verifyIdempotent(t.db, { ...base, args: { a: 1, b: 2 } });

    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.approval.id, first.approval.id);
    assert.equal(countRows(t.db, "approvals"), 1);

    // createApproval 同样复用，不走 verify 也只批一次。
    const third = createApproval(t.db, { ...base, args: { a: 1, b: 2 } });
    assert.equal(third.reused, true);
    assert.equal(third.approval.id, first.approval.id);
    assert.equal(countRows(t.db, "approvals"), 1);
  } finally {
    t.cleanup();
  }
});

test("并发两次 decide 只有一次成功（两个连接各决一次）", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    createTask(t.db, { id: "t-race" });
    const { approval } = createApproval(t.db, {
      taskId: "t-race",
      tool: "logged_browser",
      tier: 4,
      title: "提交表单",
      args: { form: "checkout" },
    });

    const run = (decision: "approved" | "rejected"): Promise<{ ok?: boolean; error?: string }> =>
      new Promise((resolve) => {
        const worker = new Worker(new URL("./decide-worker.mjs", import.meta.url), {
          workerData: { path: t.path, id: approval.id, decision },
        });
        worker.once("message", (msg: { ok?: boolean; error?: string }) => resolve(msg));
        worker.once("error", (err: Error) => resolve({ error: String(err) }));
      });

    const [a, b] = await Promise.all([run("approved"), run("rejected")]);
    assert.equal(a.error, undefined, a.error);
    assert.equal(b.error, undefined, b.error);
    assert.equal(Number(a.ok) + Number(b.ok), 1, `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);

    const row = t.db.prepare("SELECT status, decided_by FROM approvals WHERE id = ?").get(approval.id) as {
      status: string;
      decided_by: string;
    };
    assert.ok(row.status === "approved" || row.status === "rejected");
    assert.equal(row.decided_by, "dsbot");

    // 对同一单再决一次仍失败：条件更新 WHERE status='pending' 幂等。
    assert.equal(decideApproval(t.db, approval.id, { decision: "approved" }), false);
  } finally {
    t.cleanup();
  }
});

test("TTL 到期：超 24h 的 pending 标 expired，新的同动作可再建单", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    createTask(t.db, { id: "t-ttl" });
    const old = new Date(Date.now() - 25 * 3_600_000);
    const req = {
      taskId: "t-ttl",
      tool: "logged_browser",
      tier: 4 as const,
      title: "提交表单",
      args: { form: "checkout" },
      ttlMs: 24 * 3_600_000,
      now: old,
    };
    const expired = createApproval(t.db, req);
    const fresh = createApproval(t.db, {
      ...req,
      args: { form: "other" },
      now: new Date(),
      subjectKey: "still-fresh",
    });

    assert.equal(sweepExpired(t.db, new Date()), 1);
    assert.equal(t.db.prepare("SELECT status FROM approvals WHERE id = ?").get(expired.approval.id)?.["status"], "expired");
    assert.equal(t.db.prepare("SELECT status FROM approvals WHERE id = ?").get(fresh.approval.id)?.["status"], "pending");

    // expired 不再占用 subject_key：同一动作重发会建新单。
    const again = verifyIdempotent(t.db, req);
    assert.equal(again.reused, false);
    assert.notEqual(again.approval.id, expired.approval.id);
    assert.equal(countRows(t.db, "approvals"), 3);
  } finally {
    t.cleanup();
  }
});

// 受保护程序从 exec 的 program 认，不再靠同时传的 app 字段。
test("受保护程序判定在 exec 白名单之前：Weixin 作为 program 不带 app 也直接 6 档", () => {
  const verdict = judgeTier({
    tool: "exec",
    action: "exec",
    args: { program: "C:/Program Files/Tencent/Weixin/Weixin.exe", argv: ["--version"] },
  });
  assert.equal(verdict.tier, 6);
  assert.equal(verdict.rule, "protected_app");
  assert.equal(verdict.handling, "deny");
});

test("工作区：核对不了落 4 档 workspace_unknown；证明在外落 4 档超范围并记裁判；在里面才 2 档", () => {
  const unknown = judgeTier({ tool: "write", action: "write", args: { path: "src/a.ts" } });
  assert.equal(unknown.tier, 4);
  assert.equal(unknown.rule, "workspace_unknown");
  assert.equal(unknown.handling, "ask");
  assert.equal(unknown.judgeNeeded, false);

  const known = judgeTier({
    tool: "write",
    action: "write",
    workspace: "C:/Users/1/Documents/研究/dot",
    args: { path: "src/a.ts" },
  });
  assert.equal(known.tier, 2);
  assert.equal(known.rule, "workspace_write");

  // B.9：超声明范围 → 4 问＋记裁判出场（旧断言把它写成 workspace_unknown 且不记裁判）。
  const outside = judgeTier({
    tool: "write",
    action: "write",
    workspace: "C:/Users/1/Documents/研究/dot",
    args: { path: "C:/Windows/System32/drivers/etc/hosts" },
  });
  assert.equal(outside.tier, 4);
  assert.equal(outside.rule, "out_of_scope_or_budget");
  assert.equal(outside.judgeNeeded, true);

  // exec 的目标同样按超范围处理。
  const execOutside = judgeTier({
    tool: "exec",
    action: "exec",
    workspace: "C:/Users/1/Documents/研究/dot",
    args: { command: "node C:/Windows/System32/x.js" },
  });
  assert.equal(execOutside.tier, 4);
  assert.equal(execOutside.rule, "out_of_scope_or_budget");
  assert.equal(execOutside.judgeNeeded, true);

  const execUnknown = judgeTier({ tool: "exec", action: "exec", args: { command: "node build.js" } });
  assert.equal(execUnknown.tier, 4);
  assert.equal(execUnknown.rule, "workspace_unknown");
  assert.equal(execUnknown.judgeNeeded, false);
});
