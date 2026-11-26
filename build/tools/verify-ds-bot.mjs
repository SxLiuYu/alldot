#!/usr/bin/env node
/**
 * 转发脚本：方案 B.11（dot-合并方案-v2-定稿.md:892）与附录 C（:915）写的
 * 验收命令是 build/tools/verify-ds-bot.mjs，B.1（:758）写的是
 * build/patches/ds-bot/verify.mjs。两边都可用，这里只转发参数，逻辑在后者。
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const TARGET = join(dirname(fileURLToPath(import.meta.url)), "..", "patches", "ds-bot", "verify.mjs");
const { main } = await import(pathToFileURL(TARGET).href);
main();
