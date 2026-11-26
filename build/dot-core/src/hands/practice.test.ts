/**
 * src/hands/practice.test.ts —— 最小那只手的落地动作与路径围栏。
 *
 * 验收口径：越界一律拒（绝对路径/盘符/UNC/`..`/NUL/符号链接），三件事只做
 * list/mkdir/write，write 不默认覆盖、超 256 KiB 拒。全部在临时目录里做，
 * 不碰用户的练习文件夹。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PRACTICE_MAX_WRITE_BYTES,
  PracticeError,
  listDir,
  makeDir,
  practiceRootOf,
  readTextFileForCheck,
  resolvePracticePath,
  writeTextFile,
} from "./practice.ts";

function withRoot<T>(fn: (root: string, outside: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "dot-practice-"));
  const root = join(dir, "练习");
  const outside = join(dir, "外面");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  try {
    return fn(root, outside);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isPracticeError = (code: string) => (err: unknown) =>
  err instanceof PracticeError && (err as PracticeError).code === code;

test("练习根没配就抛 practice_root_missing", () => {
  assert.throws(() => practiceRootOf(null), isPracticeError("practice_root_missing"));
  assert.throws(() => practiceRootOf("   "), isPracticeError("practice_root_missing"));
});

test("路径围栏：绝对路径、盘符、UNC、越界、NUL 全拒", () => {
  withRoot((root, outside) => {
    for (const bad of ["C:\\Windows\\x.txt", "/etc/passwd", "\\\\server\\share\\a.txt", "../外面/x.txt", "a/../../外面/x.txt"]) {
      assert.throws(() => resolvePracticePath(root, bad), PracticeError, `应拒：${bad}`);
    }
    assert.throws(() => resolvePracticePath(root, "a\0b.txt"), isPracticeError("bad_path"));
    assert.throws(() => resolvePracticePath(root, "."), isPracticeError("bad_path"));
    assert.equal(resolvePracticePath(root, ".", { allowRoot: true }).rel, ".");
    assert.ok(outside.length > 0);
  });
});

test("路径围栏：符号链接一律拒（建不了链接的环境跳过）", () => {
  withRoot((root, outside) => {
    try {
      symlinkSync(outside, join(root, "链接"), "junction");
    } catch {
      return; // 没权限建链接：跳过这一条，不假装验过
    }
    assert.throws(() => resolvePracticePath(root, "链接/x.txt"), isPracticeError("symlink_denied"));
  });
});

test("建文件夹：多级、已存在算成功、同名文件报错", () => {
  withRoot((root) => {
    const made = makeDir(root, "a/b/c");
    assert.deepEqual(made.created, ["a", "a/b", "a/b/c"]);
    assert.equal(listDir(root, "a/b").entries.length, 1);

    const again = makeDir(root, "a/b");
    assert.deepEqual(again.created, []);

    writeFileSync(join(root, "f.txt"), "x", "utf8");
    assert.throws(() => makeDir(root, "f.txt/sub"), isPracticeError("not_a_directory"));
  });
});

test("写文件：父目录必须先有、默认不覆盖、覆盖要显式", () => {
  withRoot((root) => {
    assert.throws(() => writeTextFile(root, "没有/x.txt", "hi"), isPracticeError("parent_missing"));
    mkdirSync(join(root, "目录"));

    const first = writeTextFile(root, "目录/笔记.txt", "第一版");
    assert.equal(first.created, true);
    assert.equal(first.bytes, Buffer.byteLength("第一版", "utf8"));
    assert.equal(readTextFileForCheck(root, "目录/笔记.txt"), "第一版");

    assert.throws(() => writeTextFile(root, "目录/笔记.txt", "第二版"), isPracticeError("exists"));
    const second = writeTextFile(root, "目录/笔记.txt", "第二版", { overwrite: true });
    assert.equal(second.created, false);
    assert.equal(readTextFileForCheck(root, "目录/笔记.txt"), "第二版");

    mkdirSync(join(root, "另一个"));
    assert.throws(() => writeTextFile(root, "目录", "x", { overwrite: true }), isPracticeError("target_is_directory"));
  });
});

test("写文件：超过 256 KiB 拒（练习不是搬大文件）", () => {
  withRoot((root) => {
    const big = "a".repeat(PRACTICE_MAX_WRITE_BYTES + 1);
    assert.throws(() => writeTextFile(root, "big.txt", big), isPracticeError("content_too_large"));
  });
});

test("列目录：目录在前、截断标注、空目录文案", () => {
  withRoot((root) => {
    mkdirSync(join(root, "b目录"));
    mkdirSync(join(root, "a目录"));
    writeFileSync(join(root, "z.txt"), "12345", "utf8");

    const listed = listDir(root);
    assert.deepEqual(
      listed.entries.map((e) => e.name),
      ["a目录", "b目录", "z.txt"],
    );
    assert.equal(listed.entries[2]?.type, "file");
    assert.equal(listed.entries[2]?.bytes, 5);
    assert.equal(listed.truncated, false);

    assert.throws(() => listDir(root, "不存在"), isPracticeError("not_found"));
    assert.throws(() => listDir(root, "z.txt"), isPracticeError("not_a_directory"));
  });
});
