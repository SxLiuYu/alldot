"""微信推送 helper：从 stdin 读 {"text": "...", "marker": "..."}，写进当前会话并发出去。

为什么不调 wx_send：wx_send 会切虚拟桌面、抢焦点（为了用真实鼠标点会话）。
这条通道只发「当前已打开的那个会话」，所以只需要
  UIA ValuePattern.SetValue 写输入框 + PostMessage WM_KEYDOWN(VK_RETURN) 发送，
两样都不要求窗口可见——实测微信在别的虚拟桌面也能发出去，你的屏幕不会闪。

安全阀：发之前用最近几条消息里的标记文字确认当前会话对不对（默认 "alldot"），
对不上就不发，返回 ok=false 说明原因。宁可漏推一条，也不要把审批内容发到别人那里。
"""
import json
import os
import sys
import time

MCP_DIR = os.environ.get("WECHAT_MCP_DIR", r"D:/项目/wechat-mcp")
sys.path.insert(0, MCP_DIR)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def out(ok: bool, detail: str) -> None:
    print(json.dumps({"ok": ok, "detail": detail}, ensure_ascii=False), flush=True)


def main() -> int:
    # 必须读字节再按 UTF-8 解：Windows 上 sys.stdin 走管道时默认按 cp936 解，
    # 中文会直接炸在解码阶段（而且 -I 隔离模式下改不了默认编码）。
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
    except Exception as e:  # noqa: BLE001
        out(False, f"输入不是 JSON：{type(e).__name__}: {e}")
        return 2

    text = str(payload.get("text") or "").strip()
    marker = str(payload.get("marker") or "alldot").strip()
    if text == "":
        out(False, "text 为空")
        return 2

    try:
        import gc

        # comtypes 的 COM 指针在 __del__ 里 Release 有概率踩空（access violation
        # 0xC0000374），进程当场崩、连结果都打不出来。这是一次性进程，干脆不回收。
        gc.disable()
        import wechat_mcp as W
    except Exception as e:  # noqa: BLE001
        out(False, f"加载 wechat_mcp 失败（{MCP_DIR}）：{e}")
        return 2

    try:
        h = W.wechat_handle()
        _, msgs = W.split()
    except Exception as e:  # noqa: BLE001
        out(False, f"读不到微信：{type(e).__name__}: {e}")
        return 2

    recent = " ".join(((m.get("name") or "") + (m.get("text") or "")) for m in msgs[-8:])
    # 标记支持多个（用 | 隔开），任一命中就算对上：
    # 只认一个字面词太脆——推送内容本身一般不含「alldot」，用户一换词就永远发不出去。
    markers = [m.strip() for m in marker.split("|") if m.strip() != ""]
    if markers and not any(m in recent for m in markers):
        out(False, f"当前会话里没有标记「{marker}」，没发（避免发错人）")
        return 3

    try:
        W.set_input_text(text)
        time.sleep(0.25)
        staged = W.read_input_text()
        if staged.strip() == "":
            out(False, "输入框没写进去，没发")
            return 4
        W.send_key_to_window(h, W.VK_RETURN)
        time.sleep(0.8)
    except Exception as e:  # noqa: BLE001
        out(False, f"发送失败：{type(e).__name__}: {e}")
        return 4

    out(True, "已发（不切桌面）")
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except BaseException as e:  # noqa: BLE001 — 兜底：宁可回一条失败原因，也不要静默崩掉
        out(False, f"崩了：{type(e).__name__}: {e}")
        code = 5
    sys.stdout.flush()
    # 直接退：COM 对象析构时 comtypes 会报 access violation，看着吓人但不影响结果。
    os._exit(code)
