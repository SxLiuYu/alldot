#!/usr/bin/env node
// S0-5 冒烟：电脑手三关之「标准控件 + 连点」，以及 UIA 快照探针。
//
// 验收口径来自 dot-合并方案-v2-定稿.md：
//   * 第 7 节第 0 步表 S0-5（文件 :368）：记事本能开能打字能保存；
//     连点 20 次成功 19 次；「成功」= 每次点击后控件状态可验证地变了，
//     不是工具自己说点了就算。
//   * 附录 C（文件 :905-907）：--app notepad --clicks 20 / --app <exe 全路径> --probe。
//   * 第 2 步表（文件 :423,431）：--save 时 20 次点 + 存盘全过。
//   * 微信读不到控件按设计进 human_only 名单（文件 :368，非阻塞项）。
//
// Windows-MCP 0.8.8 的 streamable-http 端点为 /mcp/（server 源码 __main__.py:1084），
// 工具名与参数按本机安装源码核对：
//   App(mode, name, executable, args, cwd)      tools/app.py:89-98
//   Snapshot()                                  tools/snapshot.py:37-59
//   Click(loc, label, button, clicks)           tools/input.py:238-256
//   Type(text, loc, label, clear, ...)          tools/input.py:270-297
//   Shortcut(shortcut)                          tools/input.py:418-420
// UI Tree 行格式见 tree/views.py:76-85、141-154（(x,y) controltype "name" [action: ...]）。
// control_type 取 UIA 本地化类型（tree/service.py:755-783，uia/controls.py:667-669
// 直返 CurrentLocalizedControlType），中文系统上是「编辑/按钮/菜单项目」，
// 所以解析必须收 Unicode 字母；只认 [A-Za-z]+ 会把整棵树解析成空。
//
// 另：Type 内部开头就 uia.Click(x,y)（desktop/service.py:767-781），
// 所以连点的成功判据必须在 Type 之前的快照里独立采集；
// 打字后的 value 只能证明 Type 落字，不能证明 Click 点中了。
//
// 纯 Node 24 内置模块，无 npm 依赖。服务不在时绝不假装跑过：退出码 2。

import { createConnection } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8000/mcp/';
const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_CLICKS = 20;
const DEFAULT_THRESHOLD = 19;

// 每轮打入一个定长唯一标记，证明 Type 真的把字写进了控件。
// 它只证明打字，不证明 Click 点中（Type 自带 uia.Click，见 desktop/service.py:767-781）。
const TOKEN_RE = /A(\d{2})/g;
const tokenFor = (i) => `A${String(i).padStart(2, '0')}`;

function parseArgs(argv) {
  const out = {
    app: null,
    clicks: DEFAULT_CLICKS,
    threshold: DEFAULT_THRESHOLD,
    probe: false,
    save: false,
    endpoint: DEFAULT_ENDPOINT,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--probe') out.probe = true;
    else if (a === '--save') out.save = true;
    else if (a === '--app') out.app = argv[++i] ?? null;
    else if (a === '--clicks') out.clicks = Number(argv[++i]);
    else if (a === '--threshold') out.threshold = Number(argv[++i]);
    else if (a === '--mcp-url') out.endpoint = argv[++i] ?? DEFAULT_ENDPOINT;
    else throw new Error(`未知参数：${a}`);
  }
  if (!Number.isInteger(out.clicks) || out.clicks < 1) throw new Error('--clicks 必须是正整数');
  if (!Number.isInteger(out.threshold) || out.threshold < 0) throw new Error('--threshold 必须是非负整数');
  if (out.threshold > out.clicks) out.threshold = out.clicks;
  return out;
}

function usage() {
  return [
    '用法：',
    '  node build/tools/smoke/S0-5.mjs --app notepad --clicks 20 [--save]',
    '  node build/tools/smoke/S0-5.mjs --app "C:/Program Files/Tencent/Weixin/Weixin.exe" --probe',
    '',
    '退出码：0=验收通过或按设计降级为 human_only；1=验收不过；2=Windows-MCP 未启动。',
  ].join('\n');
}

// ---- 预检：端口 + MCP initialize。不通过一律 exit 2。----

function tcpProbe(host, port, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    let settled = false;
    const done = (ok, err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ok, err });
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true, null));
    sock.on('timeout', () => done(false, `TCP ${host}:${port} 连接超时 ${timeoutMs}ms`));
    sock.on('error', (e) => done(false, `${host}:${port} ${e.code || e.message}`));
  });
}

function failPreflight(reason, endpoint) {
  const msg = `Windows-MCP 未启动（${reason}）`;
  console.error(msg);
  console.log(JSON.stringify({
    script: 'S0-5',
    error: msg,
    preflight: { ok: false, endpoint, reason },
    verdict: 'NOT_RUN',
    pass: false,
  }, null, 2));
  process.exit(2);
}

// ---- 最小 MCP streamable-http 客户端 ----

function parseRpcPayload(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (t.startsWith('{')) return JSON.parse(t);
  const dataLines = [];
  for (const line of t.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s/, ''));
  }
  if (!dataLines.length) throw new Error(`无法解析 MCP 响应：${t.slice(0, 200)}`);
  return JSON.parse(dataLines.join('\n'));
}

class McpClient {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.sessionId = null;
    this.nextId = 1;
    this.protocolVersion = null;
  }

  async rpc(method, params, { notification = false, timeout = 20000 } = {}) {
    const body = {
      jsonrpc: '2.0',
      method,
      ...(notification ? {} : { id: this.nextId++ }),
      ...(params && Object.keys(params).length ? { params } : {}),
    };
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      throw new Error(`${method} 请求失败：${e.name === 'TimeoutError' ? `超时 ${timeout}ms` : e.message}`);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} HTTP ${res.status}：${text.slice(0, 300)}`);
    const payload = parseRpcPayload(text);
    if (!payload) return null;
    if (payload.error) throw new Error(`${method} JSON-RPC 错误：${JSON.stringify(payload.error)}`);
    return payload.result ?? null;
  }

  async initialize(timeout = 10000) {
    const r = await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dot-S0-5-smoke', version: '1.0.0' },
    }, { timeout });
    this.protocolVersion = r?.protocolVersion ?? PROTOCOL_VERSION;
    await this.rpc('notifications/initialized', {}, { notification: true, timeout });
    return r;
  }

  async call(name, args = {}, timeout = 25000) {
    const r = await this.rpc('tools/call', { name, arguments: args }, { timeout });
    if (!r) return { text: '', structured: null, raw: null };
    const parts = (r.content || []).filter((c) => c?.type === 'text').map((c) => c.text);
    let text = parts.join('\n');
    if (!text && r.structuredContent) text = JSON.stringify(r.structuredContent);
    if (r.isError) throw new Error(`工具 ${name} 返回错误：${text.slice(0, 500) || JSON.stringify(r).slice(0, 500)}`);
    return { text, structured: r.structuredContent ?? null, raw: r };
  }
}

// ---- 快照文本解析 ----

// 控件类型词允许中文：本机 UIA 本地化类型是「编辑/按钮/菜单项目」，
// 用 \p{L} 而不是 [A-Za-z]（tree/service.py:755-783、uia/controls.py:667-669）。
const CONTROL_WORD = '[\\p{L}][\\p{L}\\p{N}]*';

// 带坐标的可交互控件：tree/views.py:76-85 的 (x,y) controltype "name" [action: ...]
function parseControls(text) {
  const out = [];
  const re = new RegExp(`\\(\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*\\)\\s+(${CONTROL_WORD})\\s+"([^"]*)"`, 'gu');
  for (const m of String(text).matchAll(re)) {
    out.push({ x: Number(m[1]), y: Number(m[2]), type: m[3], name: m[4] });
  }
  return out;
}

// 当前获得焦点的控件：metadata 里的 [focused] 由 tree/views.py:23-26 渲染。
function parseFocused(text) {
  const re = new RegExp(`\\(\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*\\)\\s+(${CONTROL_WORD})\\s+"([^"]*)"[^\\n]*\\[focused\\]`, 'gu');
  for (const m of String(text).matchAll(re)) {
    return { x: Number(m[1]), y: Number(m[2]), type: m[3], name: m[4] };
  }
  return null;
}

// named controls：UI Tree 里有名字的控件；排除 window/desktop 这两类容器。
function parseNamedControls(text) {
  const out = [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${CONTROL_WORD})\\s+"([^"]+)"`, 'gu');
  for (const m of String(text).matchAll(re)) {
    const type = m[1].toLowerCase();
    if (type === 'window' || type === 'desktop') continue;
    out.push({ type: m[1], name: m[2] });
  }
  return out;
}

// 编辑框：英文 Edit 与中文「编辑」都认（本地化类型不可假定为英文）。
function isEditControl(c) {
  if (!c) return false;
  const t = String(c.type).toLowerCase();
  if (t === 'window' || t === 'desktop') return false;
  return t.includes('edit') || /编辑|文本|输入框|文本框/.test(String(c.type))
    || /文本编辑器|编辑框|文本框/.test(String(c.name));
}

function findEdit(controls) {
  return controls.find(isEditControl) || null;
}

function findFileNameBox(controls) {
  return findEdit(controls)
    || controls.find((c) => /文件名|file\s*name/i.test(String(c.name)))
    || controls.find((c) => /combobox|组合框|下拉/.test(String(c.type).toLowerCase()))
    || null;
}

function sameLoc(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y);
}

// 菜单展开会让 UI Tree 多出具名控件。用 (x,y)+类型+名字当身份，
// 与位置无关；这样点击的「控件状态可验证地变了」不依赖焦点是否落到菜单项上。
function controlKeys(text) {
  return new Set(parseControls(text).map((c) => `${c.x},${c.y}|${c.type}|${c.name}`));
}

function newControlsAfter(beforeText, afterText) {
  const before = controlKeys(beforeText);
  return [...controlKeys(afterText)].filter((k) => !before.has(k));
}

// 字数证据仅作辅助；打字阶段的种子串在快照里可见是主证据。
function readCharCount(text) {
  const nums = [];
  for (const m of String(text).matchAll(/(\d+)\s*(?:characters?|个字符)/gi)) nums.push(Number(m[1]));
  for (const m of String(text).matchAll(/Ln\s*\d+\s*,\s*Col\s*\d+\s*\((\d+)\s*(?:characters?)?\)/gi)) nums.push(Number(m[1]));
  for (const m of String(text).matchAll(/第\s*\d+\s*行[，,]\s*第\s*\d+\s*列\s*[（(](\d+)/g)) nums.push(Number(m[1]));
  for (const m of String(text).matchAll(/value:"((?:[^"\\]|\\.)*)"/g)) nums.push(m[1].length);
  return nums.length ? Math.max(...nums) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launchArgs(app) {
  const looksLikePath = /[\\/]|\.exe$/i.test(app);
  return looksLikePath
    ? { mode: 'launch_executable', executable: app }
    : { mode: 'launch', name: app };
}

// ---- probe：一次 UIA 快照，统计 named controls ----

async function runProbe(client, opts, result) {
  if (!opts.app) throw new Error('--probe 需要 --app <exe 全路径>');
  const args = launchArgs(opts.app);
  const opened = await client.call('App', args, 30000);
  result.open = { ok: true, tool: 'App', args, toolText: opened.text.slice(0, 200) };
  await sleep(2500); // 给程序窗口和 UIA 树一点就绪时间

  const snap = await client.call('Snapshot', {}, 45000);
  const named = parseNamedControls(snap.text);
  const interactive = parseControls(snap.text);
  const namedInteractive = interactive.filter((c) => c.name.trim() !== '');
  const nonEmpty = named.filter((c) => c.name.trim() !== '');

  result.snapshot = {
    ok: true,
    chars: snap.text.length,
    hasUiTree: /UI Tree:/.test(snap.text),
  };
  result.namedControls = nonEmpty.length;
  result.interactiveControls = interactive.length;
  result.namedInteractiveControls = namedInteractive.length;
  result.sampleControls = nonEmpty.slice(0, 12).map((c) => `${c.type} "${c.name}"`);

  if (nonEmpty.length > 0) {
    result.verdict = 'PASS';
    result.humanOnly = false;
    result.pass = true;
    result.note = '快照读到具名控件，标准控件关通过。';
  } else {
    result.verdict = 'human_only';
    result.humanOnly = true;
    result.pass = false;
    result.note = '快照 named controls = 0：按方案第 7 节 S0-5，该程序应进 desktop.human_only_apps 名单，走人机接力，非阻塞项。';
    console.error('提示：named controls = 0，判为该进 human_only 名单（非阻塞项）。');
  }
  return 0;
}

// ---- clicks：打开、打字、保存、20 次可验证点击 ----

async function runClicks(client, opts, result) {
  if (!opts.app) throw new Error('--clicks 需要 --app notepad');
  const args = launchArgs(opts.app);
  const opened = await client.call('App', args, 30000);
  result.open = { ok: true, tool: 'App', args, toolText: opened.text.slice(0, 200) };
  await sleep(1800);

  const snap = await client.call('Snapshot', {}, 45000);
  const edit = findEdit(parseControls(snap.text));
  if (!edit) {
    result.verdict = 'FAIL';
    result.pass = false;
    result.error = '快照里找不到记事本编辑框（本地化类型「编辑」或英文 Edit 均可），无法做可验证点击';
    result.snapshotHead = snap.text.slice(0, 600);
    return 1;
  }
  const loc = [edit.x, edit.y];
  result.edit = { control: edit.type, name: edit.name, loc };

  // 连点证据必须与 Type 自带的 uia.Click 隔离（desktop/service.py:767-781）。
  // 做法：每轮先 Type 到编辑框（焦点落在编辑框、菜单关闭），拍 pre 快照确认；
  // 再单独 Click 一个无害菜单项，拍 post 快照，只有焦点从编辑框移到该菜单项
  // （控件状态可验证地变了）才算这一轮点击成功。菜单项随后会被下一次 Type
  // 自带的点击关掉，不留累积状态。Click 工具自报的 "clicked at" 不计分。
  const menuTarget = parseControls(snap.text).find(
    (c) => /菜单项目|menu\s*item/i.test(String(c.type)) && c.name !== '系统',
  ) || null;
  if (!menuTarget) {
    result.verdict = 'FAIL';
    result.pass = false;
    result.error = '快照里找不到可点且无害的菜单项，无法把 Click 的效果从 Type 自带的点击里分离出来';
    result.snapshotHead = snap.text.slice(0, 600);
    return 1;
  }
  result.clickTarget = { control: menuTarget.type, name: menuTarget.name, loc: [menuTarget.x, menuTarget.y] };

  // 打字：先清空再写种子文本，clear=true 是 Type 工具的参数（input.py:274）。
  const seed = 'S0-5 seed';
  await client.call('Type', { text: seed, loc, clear: true, caret_position: 'end' }, 30000);
  const afterSeed = await client.call('Snapshot', {}, 45000);
  result.seed = {
    ok: afterSeed.text.includes(seed),
    text: seed,
    charCount: readCharCount(afterSeed.text),
    evidence: afterSeed.text.includes(seed) ? 'snap 文本里出现种子串' : 'snap 文本里未出现种子串',
  };
  if (!result.seed.ok) {
    result.verdict = 'FAIL';
    result.pass = false;
    result.error = '打字阶段失败：快照里看不到种子文本';
    return 1;
  }

  const items = [];
  let successes = 0;
  for (let i = 1; i <= opts.clicks; i++) {
    const token = tokenFor(i);
    let clickText = '';
    let ok = false;
    let focusBefore = null;
    let focusAfter = null;
    let menuExpanded = false;
    let typed = false;
    let charCount = null;
    let err = null;
    try {
      // 打字先做：Type 自带 uia.Click 会把焦点拉回编辑框并关掉菜单（desktop/service.py:767-781）。
      // pre 快照必须在 Click 之前拍，才能证明 Click 之前焦点确实在编辑框。
      await client.call('Type', { text: token, loc, clear: false, caret_position: 'end' }, 30000);
      const pre = await client.call('Snapshot', {}, 45000);
      focusBefore = parseFocused(pre.text);
      typed = pre.text.includes(token);

      // 只点无害菜单项。Click 工具自报的 "clicked at" 只记录，不计分。
      const clicked = await client.call('Click', { loc: [menuTarget.x, menuTarget.y], button: 'left', clicks: 1 }, 30000);
      clickText = clicked.text.slice(0, 120);
      const post = await client.call('Snapshot', {}, 45000);
      focusAfter = parseFocused(post.text);
      charCount = readCharCount(post.text);
      menuExpanded = newControlsAfter(pre.text, post.text).length > 0;
      // 成功 = 打字先落在控件上，且 Click 之后控件状态可验证地变了：
      // 焦点从编辑框移到目标菜单项，或菜单展开多出具名控件。
      // 两种变化都只能由这一次 Click 造成（Type 的点击发生在 pre 之前）。
      const focusMoved = Boolean(focusAfter)
        && focusAfter.x === menuTarget.x
        && focusAfter.y === menuTarget.y
        && !isEditControl(focusAfter);
      ok = typed
        && isEditControl(focusBefore)
        && sameLoc(focusBefore, { x: edit.x, y: edit.y })
        && (focusMoved || menuExpanded);
    } catch (e) {
      err = e.message;
    }
    if (ok) successes++;
    items.push({
      i, ok, token, typed, menuExpanded,
      focusBefore: focusBefore ? `${focusBefore.type} "${focusBefore.name}" (${focusBefore.x},${focusBefore.y})` : null,
      focusAfter: focusAfter ? `${focusAfter.type} "${focusAfter.name}" (${focusAfter.x},${focusAfter.y})` : null,
      charCount, clickToolText: clickText, error: err,
    });
  }

  // 打字阶段证据单列：种子串是否已在编辑框里（每轮 pre 快照继续累计证据）。
  result.seed = {
    ok: Boolean(afterSeed) && afterSeed.text.includes(seed),
    text: seed,
    charCount: readCharCount(afterSeed.text),
    evidence: afterSeed.text.includes(seed) ? 'snap 文本里出现种子串' : 'snap 文本里未出现种子串',
  };
  if (!result.seed.ok) {
    result.verdict = 'FAIL';
    result.pass = false;
    result.error = '打字阶段失败：快照里看不到种子文本';
    return 1;
  }

  result.clicks = {
    total: opts.clicks,
    threshold: opts.threshold,
    successes,
    pass: successes >= opts.threshold,
    criterion: '每轮先 Type 写唯一标记并在 Click 之前拍 pre 快照（焦点须在编辑框），再单独 Click 无害菜单项并拍 post 快照；只有焦点移到目标菜单项或菜单展开多出具名控件才算成功。Type 内部的 uia.Click 发生在 pre 之前，不能冒充这一轮点击；Click 工具自报的 "clicked at" 也不计分',
    items,
  };

  // 保存：Win11 notepad 的 Ctrl+Shift+S 强制走「另存为」；写进临时目录，
  // 不动用户的正式文件。savePath 存在且内容含种子串 = 存盘有据。
  // --save 只决定是否把存盘纳入 PASS；所有模式都尝试存盘并记录证据。
  const savePath = path.join(os.tmpdir(), `dot-s0-5-${Date.now()}-${process.pid}.txt`);
  const save = { attempted: true, path: savePath, dialog: false, ok: false };
  try {
    await client.call('Shortcut', { shortcut: 'ctrl+shift+s' }, 30000);
    await sleep(900);
    let s = await client.call('Snapshot', {}, 45000);
    if (!/另存为|Save As/i.test(s.text)) {
      await client.call('Shortcut', { shortcut: 'ctrl+s' }, 30000);
      await sleep(900);
      s = await client.call('Snapshot', {}, 45000);
    }
    save.dialog = /另存为|Save As/i.test(s.text);
    if (save.dialog) {
      // 文件名框在本机是本地化类型（如「 combobox / 编辑」），findFileNameBox 两者都认。
      const dlgEdit = findFileNameBox(parseControls(s.text));
      if (!dlgEdit) {
        save.error = '保存对话框里找不到文件名输入框';
        save.evidence = save.error;
      } else {
        save.fileNameBox = { control: dlgEdit.type, name: dlgEdit.name, loc: [dlgEdit.x, dlgEdit.y] };
        await client.call('Click', { loc: [dlgEdit.x, dlgEdit.y], button: 'left', clicks: 1 }, 30000);
        await client.call('Type', { text: savePath, loc: [dlgEdit.x, dlgEdit.y], clear: true }, 30000);
        await client.call('Shortcut', { shortcut: 'enter' }, 30000);
        await sleep(1200);
      }
    }
    save.fileExists = existsSync(savePath);
    if (save.fileExists) {
      const content = readFileSync(savePath, 'utf8');
      save.bytes = Buffer.byteLength(content);
      save.containsSeed = content.includes(seed);
      save.ok = save.containsSeed;
      save.evidence = save.ok
        ? '临时文件已落盘且含种子文本'
        : '临时文件已落盘但不含种子文本';
    } else {
      save.evidence = save.dialog
        ? '走了另存为对话框但临时文件未出现'
        : '未出现另存为对话框且临时文件未出现（记事本可能保存到已有关联文件，存盘无据）';
    }
  } catch (e) {
    save.error = e.message;
    save.evidence = save.error;
  }
  result.save = save;

  const passClicks = result.clicks.pass;
  // 带 --save：存盘必须成立；不带 --save：只验连点，存盘证据照常输出但不挡 PASS。
  const passSave = opts.save ? save.ok : true;
  result.pass = passClicks && passSave;
  result.verdict = result.pass ? 'PASS' : 'FAIL';
  if (!passClicks) result.error = `连点 ${successes}/${opts.clicks}，低于阈值 ${opts.threshold}`;
  else if (!passSave) result.error = `保存未通过：${save.error || save.evidence}`;
  return result.pass ? 0 : 1;
}

// ---- main ----

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error(usage());
    process.exit(1);
  }
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  if (!opts.app) {
    console.error('缺少 --app');
    console.error(usage());
    return 1;
  }

  const result = {
    script: 'S0-5',
    mode: opts.probe ? 'probe' : 'clicks',
    app: opts.app,
    endpoint: opts.endpoint,
    preflight: { ok: false },
  };

  let url;
  try {
    url = new URL(opts.endpoint);
  } catch {
    failPreflight(`--mcp-url 不是合法 URL：${opts.endpoint}`, opts.endpoint);
  }
  const host = url.hostname || '127.0.0.1';
  const port = Number(url.port || 80);

  const tcp = await tcpProbe(host, port);
  if (!tcp.ok) failPreflight(tcp.err, opts.endpoint);
  result.preflight.tcp = 'ok';

  const client = new McpClient(opts.endpoint);
  try {
    await client.initialize();
  } catch (e) {
    failPreflight(`端口可连但 MCP initialize 失败：${e.message}`, opts.endpoint);
  }
  result.preflight.ok = true;
  result.preflight.initialize = 'ok';
  result.preflight.protocolVersion = client.protocolVersion;
  result.preflight.session = Boolean(client.sessionId);

  let code;
  try {
    code = opts.probe
      ? await runProbe(client, opts, result)
      : await runClicks(client, opts, result);
  } catch (e) {
    result.verdict = 'FAIL';
    result.pass = false;
    result.error = e.message;
    code = 1;
  }
  result.exitCode = code;
  console.log(JSON.stringify(result, null, 2));
  return code;
}

main().then((code) => {
  process.exitCode = code;
}).catch((e) => {
  console.error(`S0-5 未捕获错误：${e.stack || e.message}`);
  process.exitCode = 1;
});
