#!/usr/bin/env node
// build/tools/skills-index.mjs —— 把两份技能目录收成一张索引
//
// 来源（2026-11-25 下载解压到 ~/.allbot/dot/skills-catalog/src/）：
//   openai/skills  →  skills-main/skills/.curated/<名字>/SKILL.md      （44 条）
//   openai/plugins →  plugins-main/plugins/<厂商>/skills/<名字>/SKILL.md（540 条）
//
// 每个 SKILL.md 开头是 YAML frontmatter，只有 name / description 两个键可信，正文是做法。
// 产物：~/.allbot/dot/skills/index.json —— [{ id, name, description, path, source, plugin, bytes }]
//
// 用法：
//   node build/tools/skills-index.mjs            # 重建索引
//   node build/tools/skills-index.mjs --stats    # 只打印统计，不写文件

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

const DOT = join(homedir(), ".allbot", "dot");
const CATALOG = join(DOT, "skills-catalog", "src");
const OUT_DIR = join(DOT, "skills");
const OUT = join(OUT_DIR, "index.json");
const statsOnly = process.argv.includes("--stats");

/** 只认 SKILL.md；YAML frontmatter 里取 name 和 description（支持折行续写）。 */
function parseSkill(file) {
  const text = readFileSync(file, "utf8");
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const head = text.slice(3, end);
  const fields = {};
  let currentKey = null;
  for (const rawLine of head.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line === "") continue;
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m !== null) {
      currentKey = m[1];
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      fields[currentKey] = value;
      continue;
    }
    // 续行：YAML 里折行的长描述
    if (currentKey !== null && /^\s+/.test(rawLine)) {
      fields[currentKey] = `${fields[currentKey]} ${line.trim()}`.trim();
    }
  }
  const name = fields["name"] ?? basename(dirname(file));
  const description = (fields["description"] ?? "").replace(/\s+/g, " ").trim();
  if (description === "") return null;
  return { name, description };
}

function walk(dir, out, filter) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out, filter);
    else if (filter(abs)) out.push(abs);
  }
  return out;
}

const entries = [];
const skipped = [];

// 1) openai/skills：目录名就是 id
for (const file of walk(join(CATALOG, "skills-main"), [], (p) => basename(p) === "SKILL.md")) {
  const parsed = parseSkill(file);
  if (parsed === null) {
    skipped.push(file);
    continue;
  }
  entries.push({
    id: `skills/${basename(dirname(file))}`,
    name: parsed.name,
    description: parsed.description,
    path: file,
    source: "openai/skills",
    plugin: null,
    bytes: statSync(file).size,
  });
}

// 2) openai/plugins：id 带厂商前缀，插件名记在 plugin 字段
for (const file of walk(join(CATALOG, "plugins", "plugins-main"), [], (p) => basename(p) === "SKILL.md")) {
  const parsed = parseSkill(file);
  // plugins/<厂商>/skills/<技能>/SKILL.md → 厂商 = 上三级目录名
  const parts = file.split(/[\\/]/);
  const idx = parts.lastIndexOf("plugins");
  const vendor = idx >= 0 ? parts[idx + 1] : "unknown";
  if (parsed === null) {
    skipped.push(file);
    continue;
  }
  entries.push({
    id: `plugins/${vendor}/${basename(dirname(file))}`,
    name: parsed.name,
    description: parsed.description,
    path: file,
    source: "openai/plugins",
    plugin: vendor,
    bytes: statSync(file).size,
  });
}

entries.sort((a, b) => a.id.localeCompare(b.id));

if (!statsOnly) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({ built_at: new Date().toISOString(), count: entries.length, skills: entries }, null, 1),
    "utf8",
  );
}

const bySource = {};
for (const e of entries) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
const totalBytes = entries.reduce((n, e) => n + e.bytes, 0);
console.log(`技能 ${entries.length} 条（${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join("，")}）`);
console.log(`SKILL.md 合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB；跳过的（没 frontmatter/没描述）${skipped.length} 条`);
if (skipped.length > 0) console.log(`  例：${skipped.slice(0, 3).join(" | ")}`);
console.log(statsOnly ? "（--stats：没写文件）" : `已写 ${OUT}`);
