/**
 * src/bridge/access.test.ts —— 手机接入方式的验收：默认零回归、三种模式监听地址、
 * 来源判定。不连真网卡，只测纯函数。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ACCESS,
  accessDescription,
  hostForAccess,
  isAddressAllowed,
  isLanAddress,
  type AccessConfig,
} from "./access.ts";

const modeAccess = (mode: AccessConfig["mode"], cidrs: string[] = []): AccessConfig => ({
  mode,
  host: hostForAccess(mode),
  allowed_cidrs: cidrs,
});

test("默认 loopback：只放本机，手机 LAN 地址被拒", () => {
  assert.equal(DEFAULT_ACCESS.mode, "loopback");
  assert.equal(DEFAULT_ACCESS.host, "127.0.0.1");
  assert.equal(isAddressAllowed("127.0.0.1", DEFAULT_ACCESS), true);
  assert.equal(isAddressAllowed("::1", DEFAULT_ACCESS), true);
  assert.equal(isAddressAllowed("192.168.1.23", DEFAULT_ACCESS), false);
  assert.equal(isAddressAllowed("10.0.0.5", DEFAULT_ACCESS), false);
});

test("三种手机模式都监听 0.0.0.0，loopback 仍 127.0.0.1", () => {
  assert.equal(hostForAccess("lan"), "0.0.0.0");
  assert.equal(hostForAccess("tunnel"), "0.0.0.0");
  assert.equal(hostForAccess("relay"), "0.0.0.0");
  assert.equal(hostForAccess("loopback"), "127.0.0.1");
});

test("LAN 模式：私网手机能连，公网地址被拒", () => {
  const lan = modeAccess("lan");
  assert.equal(isAddressAllowed("192.168.1.23", lan), true);
  assert.equal(isAddressAllowed("10.0.0.5", lan), true);
  assert.equal(isAddressAllowed("172.16.2.3", lan), true);
  assert.equal(isAddressAllowed("169.254.3.4", lan), true); // 手机热点
  assert.equal(isAddressAllowed("8.8.8.8", lan), false);
  assert.equal(isAddressAllowed("123.57.107.21", lan), false);
  assert.equal(isAddressAllowed("::ffff:192.168.1.23", lan), true);
});

test("额外 CIDR 放行：非私网地址也能按 CIDR 放行", () => {
  const relay = modeAccess("relay", ["10.88.0.0/16", "123.57.107.0/24"]);
  assert.equal(isAddressAllowed("10.88.0.98", relay), true);
  assert.equal(isAddressAllowed("123.57.107.21", relay), true); // 配了 CIDR 的公网地址
  assert.equal(isAddressAllowed("123.58.1.1", relay), false); // 没配的公网地址
  assert.equal(isAddressAllowed("192.168.1.23", relay), true); // LAN 默认仍放行
});

test("isLanAddress 不认公网与畸形地址", () => {
  assert.equal(isLanAddress("8.8.8.8"), false);
  assert.equal(isLanAddress("not-an-ip"), false);
  assert.equal(isLanAddress(undefined), false);
  assert.equal(isLanAddress("172.32.0.1"), false); // 超出 172.16-31
});

test("接入说明能区分四种模式", () => {
  assert.match(accessDescription(DEFAULT_ACCESS), /仅本机/);
  assert.match(accessDescription(modeAccess("lan")), /局域网/);
  assert.match(accessDescription(modeAccess("tunnel")), /内网穿透/);
  assert.match(accessDescription(modeAccess("relay")), /中继/);
});
