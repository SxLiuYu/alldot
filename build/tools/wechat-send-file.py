"""微信发文件：把指定文件通过剪贴板粘进当前会话发出去。

为什么要切桌面：文字可以 PostMessage，文件不行——文件走剪贴板 CF_HDROP，
必须真实的前台窗口接 Ctrl+V才会被微信当成附件。所以这条会切一次虚拟桌面、
屏幕会闪一下，只在发安装包这种一次性动作上用。

用法：
  python -I wechat-send-file.py "C:\\path\\to\\app.apk"

输出最后一行是 {"ok": true/false, "detail": "..."}。
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import sys
import time

MCP_DIR = os.environ.get("WECHAT_MCP_DIR", r"D:/项目/wechat-mcp")
sys.path.insert(0, MCP_DIR)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CF_HDROP = 15
GMEM_MOVEABLE = 0x0002


class DROPFILES(ctypes.Structure):
    _fields_ = [
        ("pFiles", wt.DWORD),
        ("pt", wt.POINT),
        ("fNC", wt.BOOL),
        ("fWide", wt.BOOL),
    ]


def out(ok: bool, detail: str) -> None:
    print(json.dumps({"ok": ok, "detail": detail}, ensure_ascii=False), flush=True)


def set_clipboard_files(paths):
    """把文件列表放进剪贴板（CF_HDROP）。Text 剪贴板对微信无效，必须是文件格式。"""
    names = ("\0".join(paths) + "\0\0").encode("utf-16-le")
    df = DROPFILES()
    df.pFiles = ctypes.sizeof(DROPFILES)
    df.fWide = True
    size = ctypes.sizeof(DROPFILES) + len(names)
    h = ctypes.windll.kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
    if not h:
        raise OSError("GlobalAlloc 失败")
    p = ctypes.windll.kernel32.GlobalLock(h)
    ctypes.memmove(p, ctypes.byref(df), ctypes.sizeof(DROPFILES))
    ctypes.memmove(p + ctypes.sizeof(DROPFILES), names, len(names))
    ctypes.windll.kernel32.GlobalUnlock(h)
    if not ctypes.windll.user32.OpenClipboard(None):
        raise OSError("OpenClipboard 失败")
    try:
        ctypes.windll.user32.EmptyClipboard()
        if not ctypes.windll.user32.SetClipboardData(CF_HDROP, h):
            raise OSError("SetClipboardData 失败")
    finally:
        ctypes.windll.user32.CloseClipboard()


def main() -> int:
    if len(sys.argv) < 2:
        out(False, "要给文件路径")
        return 2
    path = os.path.abspath(sys.argv[1])
    if not os.path.isfile(path):
        out(False, f"没有这个文件：{path}")
        return 2

    import wechat_mcp as W

    _, before = W.split()
    if not before:
        out(False, "当前没有打开的会话，先让人打开一个会话")
        return 3

    set_clipboard_files([path])
    W.go_to_wechat()
    h = W.wechat_handle()
    W._force_foreground(h)
    time.sleep(0.8)
    W._combo(W.VK_CTRL, 0x56)  # Ctrl+V
    # 大文件粘贴后微信要读一遍才出附件卡片，等够再回车
    time.sleep(6.0)
    W.send_key_to_window(h, W.VK_RETURN)
    out(True, "已粘贴并回车，传输要几十秒")
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as e:  # noqa: BLE001
        out(False, f"失败：{type(e).__name__}: {e}")
        code = 4
    sys.stdout.flush()
    os._exit(code)
