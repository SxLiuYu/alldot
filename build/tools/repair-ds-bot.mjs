#!/usr/bin/env node
/**
 * 转发脚本：方案 B.11（dot-合并方案-v2-定稿.md:892）写的是
 * build/tools/repair-ds-bot.mjs，B.1（:758）写的是
 * build/patches/ds-bot/repair.mjs。两边都可用，这里只转发参数。
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const TARGET = join(dirname(fileURLToPath(import.meta.url)), "..", "patches", "ds-bot", "repair.mjs");
const { main } = await import(pathToFileURL(TARGET).href);
main();
