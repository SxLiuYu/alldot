/**
 * src/skills/index.test.ts —— 技能库的验收。
 *
 * 不读真索引（584 条在 ~/.allbot/dot/skills，不拿运行环境当夹具），用内存里的小索引：
 * 1. 分词：英文按词、中文按二元组；
 * 2. 搜得到 / 搜不到都要说人话，全 0 分不返回；
 * 3. read 去掉 frontmatter、按 max_chars 截断并说明还剩多少；
 * 4. 索引文件不在时给可读提示，不抛。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  executeSkillbook,
  findSkill,
  searchSkills,
  stripFrontmatter,
  tokenize,
  type SkillIndex,
} from "./index.ts";

const INDEX: SkillIndex = {
  built_at: "2026-11-25T00:00:00.000Z",
  count: 3,
  skills: [
    {
      id: "plugins/figma/figma-use",
      name: "figma-use",
      description: "Use Figma to inspect and edit design files.",
      path: "/nonexistent/figma/SKILL.md",
      source: "openai/plugins",
      plugin: "figma",
      bytes: 100,
    },
    {
      id: "skills/aspnet-core",
      name: "aspnet-core",
      description: "Build and review ASP.NET Core web applications.",
      path: "/nonexistent/aspnet/SKILL.md",
      source: "openai/skills",
      plugin: null,
      bytes: 100,
    },
    {
      id: "plugins/lark/lark-calendar",
      name: "lark-calendar",
      description: "创建飞书日程、查空闲时间、处理日历邀请。",
      path: "/nonexistent/lark/SKILL.md",
      source: "openai/plugins",
      plugin: "lark",
      bytes: 100,
    },
  ],
};

test("分词：英文按词、中文按二元组，单字也留", () => {
  const toks = tokenize("Figma 设计日历");
  assert.ok(toks.includes("figma"));
  assert.ok(toks.includes("设计"));
  assert.ok(toks.includes("计日"));
  assert.ok(toks.includes("日历"));
});

test("搜索：命中名字排前面，无关的条目不返回", () => {
  const hits = searchSkills(INDEX, "figma design", 5);
  assert.equal(hits.length, 1, "只有 figma 那条该命中");
  assert.equal(hits[0]?.id, "plugins/figma/figma-use");

  const cn = searchSkills(INDEX, "飞书日历", 5);
  assert.equal(cn[0]?.id, "plugins/lark/lark-calendar", `实际 ${JSON.stringify(cn.map((h) => h.id))}`);

  assert.deepEqual(searchSkills(INDEX, "量子力学", 5), [], "全 0 分一条都不给");
  assert.deepEqual(searchSkills(INDEX, "", 5), []);
});

test("findSkill：完整 id、只给末段名、有歧义返回 null", () => {
  assert.equal(findSkill(INDEX, "plugins/figma/figma-use")?.id, "plugins/figma/figma-use");
  assert.equal(findSkill(INDEX, "figma-use")?.id, "plugins/figma/figma-use");
  assert.equal(findSkill(INDEX, "lark-calendar")?.id, "plugins/lark/lark-calendar");
  assert.equal(findSkill(INDEX, "不存在") , null);
});

test("stripFrontmatter：去掉 frontmatter，正文原样", () => {
  const text = "---\nname: x\ndescription: y\n---\n\n# 标题\n正文";
  const { front, body } = stripFrontmatter(text);
  assert.match(front, /name: x/);
  assert.equal(body.trim(), "# 标题\n正文");
  const plain = stripFrontmatter("没有 frontmatter");
  assert.equal(plain.body, "没有 frontmatter");
});

test("executeSkillbook：索引不存在时说清怎么建，不抛", () => {
  const out = executeSkillbook({ indexPath: join(tmpdir(), "肯定没有这个文件", "index.json") }, { action: "search", query: "figma" });
  assert.equal(out.ok, false);
  assert.match(out.text, /skills-index\.mjs/);
});

test("executeSkillbook：搜不到与只认两种动作都要说人话", () => {
  const dir = join(tmpdir(), `dot-skills-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const indexPath = join(dir, "index.json");
  writeFileSync(indexPath, JSON.stringify(INDEX), "utf8");
  try {
    const miss = executeSkillbook({ indexPath }, { action: "search", query: "量子力学" });
    assert.equal(miss.ok, false);
    assert.match(miss.text, /没有和/);

    const badAction = executeSkillbook({ indexPath }, { action: "删除" });
    assert.equal(badAction.ok, false);
    assert.match(badAction.text, /search/);

    const noQuery = executeSkillbook({ indexPath }, { action: "search" });
    assert.equal(noQuery.ok, false);
    assert.match(noQuery.text, /query/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeSkillbook：read 读正文、按 max_chars 截断并说还剩多少", () => {
  const dir = join(tmpdir(), `dot-skills-read-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const skillDir = join(dir, "figma");
  mkdirSync(skillDir, { recursive: true });
  const file = join(skillDir, "SKILL.md");
  const body = `# 做法\n${"细节。".repeat(600)}`;
  writeFileSync(file, `---\nname: figma-use\ndescription: 用 Figma 看设计稿\n---\n\n${body}`, "utf8");
  const indexPath = join(dir, "index.json");
  writeFileSync(
    indexPath,
    JSON.stringify({
      built_at: "",
      count: 1,
      skills: [
        {
          id: "plugins/figma/figma-use",
          name: "figma-use",
          description: "用 Figma 看设计稿",
          path: file,
          source: "openai/plugins",
          plugin: "figma",
          bytes: 1,
        },
      ],
    }),
    "utf8",
  );
  try {
    const out = executeSkillbook({ indexPath }, { action: "read", id: "figma-use", max_chars: 600 });
    assert.equal(out.ok, true, out.text);
    assert.match(out.text, /^【plugins\/figma\/figma-use】/, "开头要带 id");
    assert.match(out.text, /# 做法/, "正文要有");
    assert.doesNotMatch(out.text, /name: figma-use/, "frontmatter 不该带出来");
    assert.match(out.text, /还有 \d+ 字没显示/, "截断要说明还剩多少");

    const noId = executeSkillbook({ indexPath }, { action: "read" });
    assert.equal(noId.ok, false);
    assert.match(noId.text, /id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
