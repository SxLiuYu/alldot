// build/ui/AlldotUi.cs —— alldot 的 Windows 界面程序（单文件 exe 的宿主）。
//
// 为什么是这个形状（2026-11-25 用户要求「做成 windows exe，html 嵌入到 exe 里，内存占用小」）：
//   * 页面不落盘：page.html 作为资源编进 exe，运行时 NavigateToString 直接从内存显示；
//   * 不开 HTTP 端口：页面与宿主用 WebView2 的 postMessage 通信（比本地开服务少一层暴露面，
//     也少一个端口冲突源）；
//   * 内存最省的一档：不背 Chromium（Electron），用系统已装的 WebView2 运行时；
//   * 不引第三方库：账本用 Windows 自带的 winsqlite3.dll 只读打开，写操作走网关已有的桥接口，
//     所以不必改 build/dot-core 里任何东西。
//
// 编译（见 build-exe.ps1）：
//   csc /target:winexe /platform:x64 /resource:page.html /resource:WebView2Loader.dll
//       /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll
//       /r:System.Web.Extensions.dll /r:System.Net.Http.dll AlldotUi.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Alldot
{
    internal static class Paths
    {
        public static string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        public static string DotDir = Path.Combine(Home, ".allbot", "dot");
        public static string Ledger = Path.Combine(DotDir, "ledger", "dot.db");
        public static string AllbotJson = Path.Combine(Home, ".allbot", "allbot.json");
        public static string BridgeToken = Path.Combine(DotDir, "bridge-token");
        public static string Gateway = "http://127.0.0.1:18789";
        // 注意：GetFolderPath 在个别启动方式下会返回空串（那就是当前目录），所以先读环境变量兜底。
        public static string LocalApp = ResolveLocalApp();
        public static string LogFile = Path.Combine(LocalApp, "ui.log");

        private static string ResolveLocalApp()
        {
            string root = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (string.IsNullOrEmpty(root)) root = Path.Combine(Home, "AppData", "Local");
            return Path.Combine(root, "alldot");
        }

        /// <summary>在三个候选位置里挑一个真能写的（用户目录 → 系统临时目录 → exe 同目录）。</summary>
        public static string WritableDir(string leaf)
        {
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath) ?? ".";
            string[] candidates = new string[]
            {
                Path.Combine(LocalApp, leaf),
                Path.Combine(Path.GetTempPath(), "alldot", leaf),
                Path.Combine(exeDir, leaf),
            };
            var errors = new StringBuilder();
            foreach (string dir in candidates)
            {
                try
                {
                    Directory.CreateDirectory(dir);
                    string probe = Path.Combine(dir, ".write-probe");
                    File.WriteAllText(probe, "ok");
                    File.Delete(probe);
                    return dir;
                }
                catch (Exception ex)
                {
                    errors.Append(dir).Append(" → ").Append(ex.Message).Append('\n');
                }
            }
            throw new InvalidOperationException("没有一个目录能写：\n" + errors);
        }

        public static void Log(string msg)
        {
            string line = DateTime.Now.ToString("HH:mm:ss.fff") + "  " + msg + Environment.NewLine;
            // 三个落点依次试：用户本地目录（正常情况）→ exe 同目录（被沙箱/权限拦住时）→ 系统临时目录
            string[] candidates = new string[]
            {
                LogFile,
                Path.Combine(Path.GetDirectoryName(Application.ExecutablePath) ?? ".", "ui.log"),
                Path.Combine(Path.GetTempPath(), "alldot-ui.log"),
            };
            foreach (string file in candidates)
            {
                try
                {
                    string dir = Path.GetDirectoryName(file);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    File.AppendAllText(file, line, Encoding.UTF8);
                    return;
                }
                catch { }
            }
        }
    }

    internal static class Native
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool SetDllDirectory(string lpPathName);
    }

    /// <summary>winsqlite3 的最小封装：够读账本用。类型映射与 node:sqlite 一致。</summary>
    internal sealed class Db : IDisposable
    {
        private const string DLL = "winsqlite3.dll";
        private const int SQLITE_OK = 0;
        private const int SQLITE_ROW = 100;
        private const int SQLITE_DONE = 101;
        private const int OPEN_READONLY = 0x00000001;
        private static readonly IntPtr TRANSIENT = new IntPtr(-1);

        [DllImport(DLL)] private static extern int sqlite3_open_v2(byte[] filename, out IntPtr db, int flags, IntPtr vfs);
        [DllImport(DLL)] private static extern int sqlite3_close(IntPtr db);
        [DllImport(DLL)] private static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int nBytes, out IntPtr stmt, IntPtr tail);
        [DllImport(DLL)] private static extern int sqlite3_step(IntPtr stmt);
        [DllImport(DLL)] private static extern int sqlite3_finalize(IntPtr stmt);
        [DllImport(DLL)] private static extern int sqlite3_column_count(IntPtr stmt);
        [DllImport(DLL)] private static extern IntPtr sqlite3_column_name(IntPtr stmt, int i);
        [DllImport(DLL)] private static extern int sqlite3_column_type(IntPtr stmt, int i);
        [DllImport(DLL)] private static extern IntPtr sqlite3_column_text(IntPtr stmt, int i);
        [DllImport(DLL)] private static extern int sqlite3_column_bytes(IntPtr stmt, int i);
        [DllImport(DLL)] private static extern long sqlite3_column_int64(IntPtr stmt, int i);
        [DllImport(DLL)] private static extern double sqlite3_column_double(IntPtr stmt, int i);
        [DllImport(DLL)] private static extern int sqlite3_bind_text(IntPtr stmt, int i, byte[] val, int n, IntPtr destructor);
        [DllImport(DLL)] private static extern int sqlite3_bind_int64(IntPtr stmt, int i, long val);
        [DllImport(DLL)] private static extern int sqlite3_bind_null(IntPtr stmt, int i);
        [DllImport(DLL)] private static extern IntPtr sqlite3_errmsg(IntPtr db);

        private IntPtr handle;
        private string path;

        public Db(string file)
        {
            path = file;
            handle = IntPtr.Zero;
        }

        private IntPtr Open()
        {
            if (handle != IntPtr.Zero) return handle;
            IntPtr h;
            byte[] name = Utf8(path);
            int rc = sqlite3_open_v2(name, out h, OPEN_READONLY, IntPtr.Zero);
            if (rc != SQLITE_OK && h != IntPtr.Zero) sqlite3_close(h);
            if (rc != SQLITE_OK) throw new InvalidOperationException("账本打不开（" + path + "），sqlite 返回 " + rc);
            handle = h;
            return handle;
        }

        private static byte[] Utf8(string s) { return Encoding.UTF8.GetBytes(s + "\0"); }

        private static string Text(IntPtr stmt, int col)
        {
            IntPtr p = sqlite3_column_text(stmt, col);
            if (p == IntPtr.Zero) return null;
            int n = sqlite3_column_bytes(stmt, col);
            if (n <= 0) return "";
            byte[] buf = new byte[n];
            Marshal.Copy(p, buf, 0, n);
            return Encoding.UTF8.GetString(buf);
        }

        public List<Dictionary<string, object>> Query(string sql, params object[] args)
        {
            var rows = new List<Dictionary<string, object>>();
            IntPtr db = Open();
            IntPtr stmt;
            int rc = sqlite3_prepare_v2(db, Utf8(sql), -1, out stmt, IntPtr.Zero);
            if (rc != SQLITE_OK) throw new InvalidOperationException("SQL 准备失败：" + Marshal.PtrToStringAnsi(sqlite3_errmsg(db)));
            try
            {
                for (int i = 0; i < args.Length; i++)
                {
                    object a = args[i];
                    if (a == null) sqlite3_bind_null(stmt, i + 1);
                    else if (a is string) { byte[] b = Encoding.UTF8.GetBytes((string)a); sqlite3_bind_text(stmt, i + 1, b, b.Length, TRANSIENT); }
                    else if (a is int || a is long) sqlite3_bind_int64(stmt, i + 1, Convert.ToInt64(a));
                    else sqlite3_bind_text(stmt, i + 1, Encoding.UTF8.GetBytes(a.ToString()), -1, TRANSIENT);
                }
                while (sqlite3_step(stmt) == SQLITE_ROW)
                {
                    int cols = sqlite3_column_count(stmt);
                    var row = new Dictionary<string, object>(cols);
                    for (int c = 0; c < cols; c++)
                    {
                        string name = Marshal.PtrToStringAnsi(sqlite3_column_name(stmt, c));
                        int type = sqlite3_column_type(stmt, c);
                        object v;
                        if (type == 1) v = sqlite3_column_int64(stmt, c);
                        else if (type == 2) v = sqlite3_column_double(stmt, c);
                        // type==4 是 BLOB：账本的 artifacts.content 就是 BLOB（存的 UTF-8 文本）。
                        // 以前一律当成 null，所以界面永远拿不到某一步的结果正文。
                        else if (type == 3 || type == 4) v = Text(stmt, c);
                        else v = null;
                        row[name] = v;
                    }
                    rows.Add(row);
                }
            }
            finally
            {
                sqlite3_finalize(stmt);
            }
            return rows;
        }

        public Dictionary<string, object> One(string sql, params object[] args)
        {
            var rows = Query(sql, args);
            return rows.Count > 0 ? rows[0] : null;
        }

        public void Dispose()
        {
            if (handle != IntPtr.Zero) { sqlite3_close(handle); handle = IntPtr.Zero; }
        }
    }

    internal sealed class ApiResult
    {
        public int Status;
        public object Body;
        public ApiResult(int status, object body) { Status = status; Body = body; }
    }

    /// <summary>页面的所有接口都在这里。读走账本（只读），写走网关桥（下单/审批/取消）。</summary>
    internal sealed partial class Api : IDisposable
    {
        private static readonly Dictionary<string, string> StateLabel = new Dictionary<string, string>
        {
            { "queued", "排队中" }, { "running", "在跑" }, { "awaiting_approval", "等批准" },
            { "paused", "暂停" }, { "done", "做完" }, { "failed", "失败" }, { "cancelled", "已取消" }
        };

        private readonly Db db;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };

        private readonly string settingsFile;
        private readonly string autoLogFile;

        public Api()
        {
            db = new Db(Paths.Ledger);
            string state;
            try { state = Paths.WritableDir("state"); }
            catch { state = Path.GetTempPath(); }
            settingsFile = Path.Combine(state, "ui-settings.json");
            autoLogFile = Path.Combine(state, "auto-approve.log");
            LoadSettings();
        }

        public string Serialize(object value) { return json.Serialize(value); }

        private static Dictionary<string, object> Map()
        {
            return new Dictionary<string, object>(StringComparer.Ordinal);
        }

        private static object Safe(string error) { return new Dictionary<string, object> { { "message", error } }; }

        private object TaskRow(Dictionary<string, object> row)
        {
            string id = Str(row, "id");
            Dictionary<string, object> steps = db.One("select count(*) c from steps where task_id = ?", id);
            Dictionary<string, object> bad = db.One("select count(*) c from steps where task_id = ? and status in ('failed','interrupted')", id);
            var m = Map();
            m["id"] = id;
            m["intent"] = Str(row, "intent");
            m["state"] = Str(row, "state");
            string st = Str(row, "state");
            m["stateLabel"] = StateLabel.ContainsKey(st ?? "") ? StateLabel[st] : st;
            m["stateReason"] = Str(row, "state_reason");
            m["profile"] = Str(row, "profile");
            m["spentTokens"] = Num(row, "spent_tokens");
            m["budgetTokens"] = Num(row, "budget_tokens");
            m["steps"] = steps == null ? 0 : Num(steps, "c");
            m["badSteps"] = bad == null ? 0 : Num(bad, "c");
            m["createdAt"] = Str(row, "created_at");
            m["updatedAt"] = Str(row, "updated_at");
            return m;
        }

        private static string Str(Dictionary<string, object> row, string key)
        {
            object v;
            if (row == null || !row.TryGetValue(key, out v) || v == null) return null;
            return v as string ?? v.ToString();
        }

        private static long Num(Dictionary<string, object> row, string key)
        {
            object v;
            if (row == null || !row.TryGetValue(key, out v) || v == null) return 0;
            try { return Convert.ToInt64(v); } catch { return 0; }
        }

        private static object JsonOrNull(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            try { return new JavaScriptSerializer().DeserializeObject(text); }
            catch { return new Dictionary<string, object> { { "raw", text.Length > 600 ? text.Substring(0, 600) : text } }; }
        }

        public ApiResult Ping()
        {
            var m = Map();
            m["ok"] = true;
            m["version"] = "0.1.0-exe";
            m["ledgerPath"] = Paths.Ledger;
            return new ApiResult(200, m);
        }

        public ApiResult Overview()
        {
            var m = Map();
            m["ok"] = true;
            m["version"] = "0.1.0-exe";
            m["now"] = DateTime.UtcNow.ToString("o");
            m["ledgerPath"] = Paths.Ledger;

            var counts = new List<object>();
            foreach (var r in db.Query("select state, count(*) c from tasks group by state"))
            {
                var c = Map();
                c["state"] = Str(r, "state");
                string st = Str(r, "state");
                c["label"] = StateLabel.ContainsKey(st ?? "") ? StateLabel[st] : st;
                c["count"] = Num(r, "c");
                counts.Add(c);
            }
            m["counts"] = counts;

            var pa = db.One("select count(*) c from approvals where status = 'pending'");
            m["pendingApprovals"] = pa == null ? 0 : Num(pa, "c");

            string today = DateTime.UtcNow.ToString("yyyy-MM-dd");
            var spend = db.One("select coalesce(sum(input_tokens + output_tokens), 0) t from spend_ledger where created_at >= ?", today);
            m["spendToday"] = spend == null ? 0 : Num(spend, "t");

            var last = db.One("select ts, type from events order by seq desc limit 1");
            var le = Map();
            le["ts"] = Str(last, "ts");
            le["type"] = Str(last, "type");
            m["lastEvent"] = le;

            var recent = new List<object>();
            foreach (var r in db.Query("select id, intent, state, state_reason, profile, spent_tokens, budget_tokens, created_at, updated_at from tasks order by created_at desc limit 6"))
                recent.Add(TaskRow(r));
            m["recent"] = recent;
            return new ApiResult(200, m);
        }

        public ApiResult Tasks(string limitRaw)
        {
            int limit = 100;
            int.TryParse(limitRaw, out limit);
            if (limit < 1) limit = 100;
            if (limit > 300) limit = 300;
            var list = new List<object>();
            foreach (var r in db.Query("select id, intent, state, state_reason, profile, spent_tokens, budget_tokens, created_at, updated_at from tasks order by created_at desc limit ?", limit))
                list.Add(TaskRow(r));
            var m = Map();
            m["ok"] = true;
            m["tasks"] = list;
            return new ApiResult(200, m);
        }

        public ApiResult TaskDetail(string id)
        {
            var row = db.One("select * from tasks where id = ?", id);
            if (row == null)
            {
                var miss = Map();
                miss["ok"] = false;
                miss["error"] = "task_not_found";
                miss["message"] = "账本里没有 " + id;
                return new ApiResult(404, miss);
            }
            var m = Map();
            m["ok"] = true;
            m["task"] = TaskRow(row);
            m["declared"] = Str(row, "declared_json");
            m["restated"] = Str(row, "restated");
            m["source"] = Str(row, "source");

            var steps = new List<object>();
            foreach (var s in db.Query("select seq, tool, kind, tier, status, error, started_at, ended_at, run_epoch, result_ref from steps where task_id = ? order by seq asc", id))
            {
                var step = Map();
                foreach (var kv in s) step[kv.Key] = kv.Value;
                // 2026-11-26 加：把这一步的结果正文带出来（截 400 字），界面才能回「结果在这」，
                // 而不是只回一句「做完了。」（审计 G4）。
                string refHash = Str(s, "result_ref");
                if (!string.IsNullOrEmpty(refHash))
                {
                    var art = db.One("select content from artifacts where hash = ?", refHash);
                    string text = art == null ? null : Convert.ToString(art["content"]);
                    if (!string.IsNullOrEmpty(text)) step["result"] = text.Length > 400 ? text.Substring(0, 400) + "…" : text;
                }
                steps.Add(step);
            }
            m["steps"] = steps;

            var events = new List<object>();
            foreach (var ev in db.Query("select seq, ts, type, payload_json from events where task_id = ? order by seq desc limit 60", id))
            {
                var e = Map();
                e["seq"] = Num(ev, "seq");
                e["ts"] = Str(ev, "ts");
                e["type"] = Str(ev, "type");
                e["payload"] = JsonOrNull(Str(ev, "payload_json"));
                events.Add(e);
            }
            m["events"] = events;

            var approvals = new List<object>();
            foreach (var a in db.Query("select id, kind, tier, title, status, detail_json, created_at, decided_at from approvals where task_id = ? order by created_at desc", id))
            {
                var o = Map();
                o["id"] = Str(a, "id");
                o["kind"] = Str(a, "kind");
                o["tier"] = Num(a, "tier");
                o["title"] = Str(a, "title");
                o["status"] = Str(a, "status");
                o["detail"] = JsonOrNull(Str(a, "detail_json"));
                o["created_at"] = Str(a, "created_at");
                o["decided_at"] = Str(a, "decided_at");
                approvals.Add(o);
            }
            m["approvals"] = approvals;

            var snaps = new List<object>();
            foreach (var s in db.Query("select id, kind, ref, created_at from snapshots where task_id = ? order by created_at desc limit 20", id))
            {
                var o = Map();
                o["id"] = Str(s, "id");
                o["kind"] = Str(s, "kind");
                o["ref"] = Str(s, "ref");
                o["created_at"] = Str(s, "created_at");
                snaps.Add(o);
            }
            m["snapshots"] = snaps;

            var miles = new List<object>();
            foreach (var s in db.Query("select seq, title, done_when, state, summary from milestones where task_id = ? order by seq asc", id))
                miles.Add(s);
            m["milestones"] = miles;
            return new ApiResult(200, m);
        }

        public ApiResult Approvals()
        {
            var pending = new List<object>();
            foreach (var a in db.Query("select id, task_id, kind, tier, title, detail_json, created_at from approvals where status = 'pending' order by created_at asc limit 50"))
            {
                var o = Map();
                o["id"] = Str(a, "id");
                o["task_id"] = Str(a, "task_id");
                o["kind"] = Str(a, "kind");
                o["tier"] = Num(a, "tier");
                o["title"] = Str(a, "title");
                o["detail"] = JsonOrNull(Str(a, "detail_json"));
                o["created_at"] = Str(a, "created_at");
                o["advice"] = AdviceFor(Str(a, "id"));
                pending.Add(o);
            }
            var recent = new List<object>();
            foreach (var a in db.Query("select id, task_id, kind, title, status, decided_by, decided_at, decision_note from approvals where status != 'pending' order by coalesce(decided_at, created_at) desc limit 20"))
                recent.Add(a);

            var m = Map();
            m["ok"] = true;
            m["pending"] = pending;
            m["recent"] = recent;
            return new ApiResult(200, m);
        }

        public ApiResult Health()
        {
            var m = Map();
            m["ok"] = true;
            m["stepStates"] = db.Query("select status, count(*) c from steps group by status order by c desc");
            m["taskStates"] = db.Query("select state, count(*) c from tasks group by state order by c desc");
            m["toolFails"] = db.Query("select tool, count(*) c from steps where status = 'failed' group by tool order by c desc limit 10");
            m["errors"] = db.Query("select tool, substr(coalesce(error,'(无详情)'), 1, 160) e, count(*) c from steps where status = 'failed' group by tool, e order by c desc limit 10");
            m["spend"] = db.Query("select model, count(*) runs, coalesce(sum(input_tokens),0) i, coalesce(sum(output_tokens),0) o from spend_ledger group by model order by (i+o) desc limit 10");
            m["workers"] = db.Query("select status, count(*) c from workers group by status order by c desc");

            var proposals = new List<object>();
            foreach (var p in db.Query("select seq, ts, payload_json from events where type in ('self_proposal','self_proposal_applied','self_proposal_rejected') order by seq desc limit 30"))
            {
                var o = Map();
                o["seq"] = Num(p, "seq");
                o["ts"] = Str(p, "ts");
                o["payload"] = JsonOrNull(Str(p, "payload_json"));
                proposals.Add(o);
            }
            m["proposals"] = proposals;
            return new ApiResult(200, m);
        }

        public ApiResult SelfItems()
        {
            var items = new List<object>();
            foreach (var p in db.Query("select seq, ts, type, payload_json from events where type like 'self_%' order by seq desc limit 60"))
            {
                var o = Map();
                o["seq"] = Num(p, "seq");
                o["ts"] = Str(p, "ts");
                o["type"] = Str(p, "type");
                o["payload"] = JsonOrNull(Str(p, "payload_json"));
                items.Add(o);
            }
            var m = Map();
            m["ok"] = true;
            m["items"] = items;
            return new ApiResult(200, m);
        }

        // ---------- 写：全部转发给网关的桥，令牌不出本进程 ----------

        private Dictionary<string, string> Tokens()
        {
            var t = new Dictionary<string, string>();
            try
            {
                var all = json.DeserializeObject(File.ReadAllText(Paths.AllbotJson, Encoding.UTF8)) as Dictionary<string, object>;
                object gw;
                if (all != null && all.TryGetValue("gateway", out gw))
                {
                    var g = gw as Dictionary<string, object>;
                    object auth;
                    if (g != null && g.TryGetValue("auth", out auth))
                    {
                        var a = auth as Dictionary<string, object>;
                        object tok;
                        if (a != null && a.TryGetValue("token", out tok) && tok != null) t["gw"] = tok.ToString();
                    }
                }
            }
            catch (Exception ex) { Paths.Log("读 allbot.json 失败：" + ex.Message); }
            try { t["bridge"] = File.ReadAllText(Paths.BridgeToken, Encoding.UTF8).Trim(); }
            catch { t["bridge"] = ""; }
            return t;
        }

        public async Task<ApiResult> CreateTaskAsync(Dictionary<string, object> body)
        {
            string intent = Str2(body, "intent");
            string workspace = Str2(body, "workspace");
            object profile;
            string prof = body != null && body.TryGetValue("profile", out profile) && profile != null ? profile.ToString() : "balanced";

            if (string.IsNullOrEmpty(intent) || intent.Trim() == "")
            {
                var bad = Map();
                bad["ok"] = false;
                bad["error"] = "bad_intent";
                bad["message"] = "要做什么？先写一句话。";
                return new ApiResult(400, bad);
            }
            var payload = Map();
            payload["intent"] = intent.Trim();
            payload["profile"] = prof;
            if (!string.IsNullOrEmpty(workspace) && workspace.Trim() != "")
            {
                var declared = Map();
                declared["workspace"] = workspace.Trim();
                payload["declared"] = declared;
            }
            return await BridgeAsync("POST", "/tasks", payload);
        }

        public async Task<ApiResult> DecideAsync(string id, string decision)
        {
            var payload = Map();
            payload["decision"] = decision == "rejected" ? "rejected" : "approved";
            return await BridgeAsync("POST", "/approvals/" + Uri.EscapeDataString(id) + "/decide", payload);
        }

        public async Task<ApiResult> CancelAsync(string id)
        {
            var payload = Map();
            payload["reason"] = "cancelled_from_ui";
            return await BridgeAsync("POST", "/tasks/" + Uri.EscapeDataString(id) + "/cancel", payload);
        }

        /// <summary>
        /// <summary>
        /// 自动同意档位：读桥的 /settings（0=关，1..4=这个档位及以下不用人点）。
        /// 真正的开关在 dot-core 里（approvals.auto_approve_max_tier），改完 20 秒生效、不用重启网关；
        /// 以前这个开关只在 exe 开着时有效，现在关了 exe 也照样生效。
        /// </summary>
        public async Task<ApiResult> AutoApproveGetAsync()
        {
            return await BridgeAsync("GET", "/settings", null);
        }

        public async Task<ApiResult> AutoApproveSetAsync(Dictionary<string, object> body)
        {
            object raw;
            int tier;
            if (!body.TryGetValue("auto_approve_max_tier", out raw) || raw == null)
            {
                var bad = Map();
                bad["ok"] = false;
                bad["error"] = "bad_value";
                bad["message"] = "缺 auto_approve_max_tier（0..4）";
                return new ApiResult(400, bad);
            }
            try { tier = System.Convert.ToInt32(raw); }
            catch (Exception)
            {
                var bad2 = Map();
                bad2["ok"] = false;
                bad2["error"] = "bad_value";
                bad2["message"] = "auto_approve_max_tier 要是 0..4 的数字";
                return new ApiResult(400, bad2);
            }
            if (tier < 0 || tier > 4)
            {
                var bad3 = Map();
                bad3["ok"] = false;
                bad3["error"] = "out_of_range";
                bad3["message"] = "只接受 0..4：5 档（身份/钱）和 6 档（危险）永远要人点";
                return new ApiResult(400, bad3);
            }
            var payload = Map();
            payload["auto_approve_max_tier"] = tier;
            return await BridgeAsync("POST", "/settings", payload);
        }

        /// 用户反馈：对话里点「不对 / 对了」时写一条 user_feedback 进账本。
        /// 它不改任务状态，只是证据——自我优化提案时会连同失败样本一起读。
        /// </summary>
        public async Task<ApiResult> FeedbackAsync(Dictionary<string, object> body)
        {
            string taskId = Str2(body, "task_id");
            string verdict = Str2(body, "verdict");
            string note = Str2(body, "note");
            if (string.IsNullOrEmpty(taskId) || (verdict != "good" && verdict != "bad"))
            {
                var bad = Map();
                bad["ok"] = false;
                bad["error"] = "bad_feedback";
                bad["message"] = "反馈要带 task_id 和 verdict（good / bad）";
                return new ApiResult(400, bad);
            }
            var payload = Map();
            payload["task_id"] = taskId;
            payload["verdict"] = verdict;
            payload["note"] = note;
            return await BridgeAsync("POST", "/feedback", payload);
        }

        /// <summary>
        /// 待部署的自我优化补丁清单。读的是桥（补丁在仓库里，不进口 UI 读）。
        /// </summary>
        public async Task<ApiResult> PatchesAsync()
        {
            return await BridgeAsync("GET", "/patches", null);
        }

        /// <summary>
        /// 部署一条补丁。危险动作，界面上必须二次确认；真正干活在 dot-core 的
        /// src/selfimprove/deploy.ts（备份 → 打补丁 → 全量测试 → 失败回滚）。
        /// </summary>
        public async Task<ApiResult> DeployAsync(Dictionary<string, object> body)
        {
            string patchId = Str2(body, "patch_id");
            if (string.IsNullOrEmpty(patchId))
            {
                var bad = Map();
                bad["ok"] = false;
                bad["error"] = "bad_patch_id";
                bad["message"] = "缺 patch_id";
                return new ApiResult(400, bad);
            }
            var payload = Map();
            payload["patch_id"] = patchId;
            return await BridgeAsync("POST", "/deploy", payload);
        }

        /// <summary>自检用：只打桥的健康检查，确认令牌能过、网关活着，不产生任何任务。</summary>
        public async Task<ApiResult> HealthProbeAsync()
        {
            return await BridgeAsync("GET", "/health", null);
        }

        private async Task<ApiResult> BridgeAsync(string method, string path, Dictionary<string, object> body)
        {
            var t = Tokens();
            string gw = t.ContainsKey("gw") ? t["gw"] : "";
            string bt = t.ContainsKey("bridge") ? t["bridge"] : "";
            if (gw == "" || bt == "")
            {
                var no = Map();
                no["ok"] = false;
                no["error"] = "no_credentials";
                no["message"] = "读不到本机令牌（allbot.json / bridge-token），下单审批都做不了。";
                return new ApiResult(500, no);
            }
            try
            {
                var req = new HttpRequestMessage(new HttpMethod(method), Paths.Gateway + "/dot/bridge/v1" + path);
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", gw);
                req.Headers.Add("x-dot-bridge-token", bt);
                if (body != null)
                {
                    string bodyText = json.Serialize(body);
                    req.Content = new StringContent(bodyText, Encoding.UTF8, "application/json");
                }

                var res = await http.SendAsync(req);
                string text = await res.Content.ReadAsStringAsync();
                object parsed;
                try { parsed = json.DeserializeObject(text); }
                catch { var o = Map(); o["ok"] = false; o["error"] = "bad_gateway_body"; o["message"] = text.Length > 400 ? text.Substring(0, 400) : text; parsed = o; }
                return new ApiResult((int)res.StatusCode, parsed);
            }
            catch (Exception ex)
            {
                Paths.Log("桥调用失败 " + method + " " + path + "：" + ex.Message);
                var down = Map();
                down["ok"] = false;
                down["error"] = "gateway_unreachable";
                down["message"] = "连不上网关 " + Paths.Gateway + "（" + ex.Message + "）。网关没起来时下单和审批都做不了；只读页面不受影响。";
                return new ApiResult(502, down);
            }
        }

        private static string Str2(Dictionary<string, object> body, string key)
        {
            object v;
            if (body == null || !body.TryGetValue(key, out v) || v == null) return "";
            return v.ToString();
        }

        public void Dispose()
        {
            http.Dispose();
            db.Dispose();
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly WebView2 view = new WebView2();
        private readonly Api api = new Api();
        private readonly System.Windows.Forms.Timer autoTimer = new System.Windows.Forms.Timer();
        private string bridgeDir;

        public MainForm()
        {
            Text = "alldot";
            Width = 1280;
            Height = 860;
            MinimumSize = new Size(900, 600);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(15, 17, 21);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            view.Dock = DockStyle.Fill;
            Controls.Add(view);

            // 每 8 秒看一次账本：有第 4 档以内的批单、且用户开了「不用每次点」，就替他同意并留痕。
            autoTimer.Interval = 8000;
            autoTimer.Tick += async (s, e) =>
            {
                try { await api.AutoApprovePendingAsync(); }
                catch (Exception ex) { Paths.Log("自动同意循环出错：" + ex.Message); }
            };
            autoTimer.Start();

            Load += OnLoaded;
        }

        private async void OnLoaded(object sender, EventArgs e)
        {
            try
            {
                // 不假设某个固定目录可写：逐个试，真写进去一个探针文件才算数。
                // （成因：用管理员权限建过的目录，普通权限进程写不进，表现为「访问被拒绝」。）
                bridgeDir = PickWritableDir("bin");
                Paths.Log("加载器目录：" + bridgeDir);
                Extract("WebView2Loader.dll", Path.Combine(bridgeDir, "WebView2Loader.dll"));
                Native.SetDllDirectory(bridgeDir);

                string dataDir = PickWritableDir("webview2");
                // 这条页面很轻：不需要 GPU 合成、扩展、同步、后台网络这些。关掉能少起进程、少占内存。
                var options = new CoreWebView2EnvironmentOptions(
                    "--disable-gpu --disable-gpu-compositing --disable-extensions --disable-sync " +
                    "--disable-background-networking --disable-component-update --disable-default-apps " +
                    "--no-first-run --no-default-browser-check --renderer-process-limit=1 --process-per-site " +
                    "--disable-features=Translate,MediaRouter,OptimizationHints,msWebOOUI,msPdfOOUI");
                var env = await CoreWebView2Environment.CreateAsync(null, dataDir, options);
                await view.EnsureCoreWebView2Async(env);

                var core = view.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDevToolsEnabled = true;
                core.Settings.IsZoomControlEnabled = true;
                core.WebMessageReceived += OnWebMessage;

                string html = ReadResource("page.html");
                core.NavigateToString(html);
                Paths.Log("界面已加载（page.html " + html.Length + " 字节）");
            }
            catch (Exception ex)
            {
                Paths.Log("初始化失败：" + ex);
                MessageBox.Show("界面起不来：" + ex.Message + "\n\n详情见 " + Paths.LogFile,
                    "alldot", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private async void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            int status = 500;
            object body;
            try
            {
                var msg = new JavaScriptSerializer().DeserializeObject(e.WebMessageAsJson) as Dictionary<string, object>;
                string path = msg.ContainsKey("path") ? Convert.ToString(msg["path"]) : "";
                string method = msg.ContainsKey("method") ? Convert.ToString(msg["method"]) : "GET";
                object rawBody;
                var payload = msg.TryGetValue("body", out rawBody) ? rawBody as Dictionary<string, object> : null;

                ApiResult r = await Dispatch(method, path, payload);
                status = r.Status;
                body = r.Body;
            }
            catch (Exception ex)
            {
                Paths.Log("处理页面请求出错：" + ex);
                body = new Dictionary<string, object> { { "ok", false }, { "error", "host_error" }, { "message", ex.Message } };
            }

            try
            {
                var reply = new Dictionary<string, object>();
                // 回包里的 id 原样带回去，页面按 id 找到等它的那一次调用
                var parsed = new JavaScriptSerializer().DeserializeObject(e.WebMessageAsJson) as Dictionary<string, object>;
                object id2;
                reply["type"] = "result";
                reply["id"] = parsed != null && parsed.TryGetValue("id", out id2) ? id2 : null;
                reply["status"] = status;
                reply["body"] = body;
                view.CoreWebView2.PostWebMessageAsJson(new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(reply));
            }
            catch (Exception ex)
            {
                Paths.Log("回包失败：" + ex.Message);
            }
        }

        private async Task<ApiResult> Dispatch(string method, string path, Dictionary<string, object> body)
        {
            try
            {
                if (method == "GET" && path == "/api/ping") return api.Ping();
                if (method == "GET" && path == "/api/settings") return api.Settings();
                if (method == "POST" && path == "/api/settings") return api.SaveSettings(body);
                if (method == "GET" && path == "/api/autolog") return api.AutoLog();
                if (method == "GET" && path == "/api/overview") return api.Overview();
                if (method == "GET" && path == "/api/approvals") return api.Approvals();
                if (method == "GET" && path == "/api/health") return api.Health();
                if (method == "GET" && path == "/api/self") return api.SelfItems();

                if (method == "GET" && path == "/api/tasks") return api.Tasks(null);
                if (method == "GET" && path.StartsWith("/api/tasks?"))
                {
                    string q = path.Substring("/api/tasks?".Length);
                    string limit = null;
                    foreach (string part in q.Split('&'))
                    {
                        if (part.StartsWith("limit=")) limit = part.Substring(6);
                    }
                    return api.Tasks(limit);
                }

                if (method == "GET" && path.StartsWith("/api/tasks/"))
                    return api.TaskDetail(Uri.UnescapeDataString(path.Substring("/api/tasks/".Length)));

                if (method == "POST" && path == "/api/tasks") return await api.CreateTaskAsync(body);

                if (method == "POST" && path == "/api/feedback") return await api.FeedbackAsync(body);
                if (method == "GET" && path == "/api/autoapprove") return await api.AutoApproveGetAsync();
                if (method == "POST" && path == "/api/autoapprove") return await api.AutoApproveSetAsync(body);

                if (method == "GET" && path == "/api/patches") return await api.PatchesAsync();

                if (method == "POST" && path == "/api/deploy") return await api.DeployAsync(body);

                if (method == "POST" && path.StartsWith("/api/approvals/") && path.EndsWith("/decide"))
                {
                    string id = path.Substring("/api/approvals/".Length);
                    id = id.Substring(0, id.Length - "/decide".Length);
                    object dec;
                    string decision = body != null && body.TryGetValue("decision", out dec) ? Convert.ToString(dec) : "approved";
                    return await api.DecideAsync(Uri.UnescapeDataString(id), decision);
                }

                if (method == "POST" && path.StartsWith("/api/tasks/") && path.EndsWith("/cancel"))
                {
                    string id = path.Substring("/api/tasks/".Length);
                    id = id.Substring(0, id.Length - "/cancel".Length);
                    return await api.CancelAsync(Uri.UnescapeDataString(id));
                }

                return new ApiResult(404, new Dictionary<string, object> { { "ok", false }, { "error", "not_found" }, { "message", "没有这个地址：" + path } });
            }
            catch (Exception ex)
            {
                Paths.Log("接口 " + path + " 出错：" + ex);
                return new ApiResult(500, new Dictionary<string, object> { { "ok", false }, { "error", "api_error" }, { "message", ex.Message } });
            }
        }

        /// <summary>在三个候选位置里挑一个真能写的（用户目录 → 系统临时目录 → exe 同目录）。</summary>
        private static string PickWritableDir(string leaf)
        {
            return Paths.WritableDir(leaf);
        }

        private static string ReadResource(string name)
        {
            var asm = Assembly.GetExecutingAssembly();
            using (var s = asm.GetManifestResourceStream(name))
            {
                if (s == null) throw new InvalidOperationException("exe 里没有资源 " + name);
                using (var r = new StreamReader(s, Encoding.UTF8)) return r.ReadToEnd();
            }
        }

        private static void Extract(string resource, string target)
        {
            byte[] want;
            var asm = Assembly.GetExecutingAssembly();
            using (var s = asm.GetManifestResourceStream(resource))
            {
                if (s == null) throw new InvalidOperationException("exe 里没有资源 " + resource);
                using (var ms = new MemoryStream())
                {
                    s.CopyTo(ms);
                    want = ms.ToArray();
                }
            }
            if (File.Exists(target))
            {
                var have = File.ReadAllBytes(target);
                if (have.Length == want.Length)
                {
                    bool same = true;
                    for (int i = 0; i < have.Length; i++) { if (have[i] != want[i]) { same = false; break; } }
                    if (same) return;
                }
            }
            File.WriteAllBytes(target, want);
        }
    }

    internal static class Program
    {
        /// <summary>
        /// WebView2 的两个托管程序集也编进 exe 了，CLR 在磁盘上找不到它们，靠这里从内存补上。
        /// 必须先于任何用到 WebView2 类型的代码执行，所以放在静态构造函数里。
        /// </summary>
        static Program()
        {
            AppDomain.CurrentDomain.AssemblyResolve += ResolveEmbedded;
        }

        private static Assembly ResolveEmbedded(object sender, ResolveEventArgs e)
        {
            string simple;
            try { simple = new AssemblyName(e.Name).Name; }
            catch { return null; }
            if (simple == null || !simple.StartsWith("Microsoft.Web.WebView2", StringComparison.Ordinal)) return null;
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(simple + ".dll"))
            {
                if (s == null) return null;
                var buf = new byte[s.Length];
                int read = 0;
                while (read < buf.Length)
                {
                    int n = s.Read(buf, read, buf.Length - read);
                    if (n <= 0) break;
                    read += n;
                }
                Paths.Log("从 exe 内加载程序集：" + simple);
                return Assembly.Load(buf);
            }
        }

        private static string Check(string name, bool ok, string detail)
        {
            return (ok ? "  [通过] " : "  [没过] ") + name + " —— " + detail;
        }

        private static bool BoolOf(Dictionary<string, object> o, string key)
        {
            object v;
            return o != null && o.TryGetValue(key, out v) && v is bool && (bool)v;
        }

        private static string StrOf(Dictionary<string, object> o, string key)
        {
            object v;
            return o != null && o.TryGetValue(key, out v) && v != null ? v.ToString() : "";
        }

        private static int RunSelfTest()
        {
            var sb = new StringBuilder();
            int bad = 0;
            using (var api = new Api())
            {
                var ping = api.Ping().Body as Dictionary<string, object>;
                bool pingOk = BoolOf(ping, "ok");
                sb.AppendLine(Check("本地接口", pingOk, "版本 " + StrOf(ping, "version")));
                if (!pingOk) bad++;

                var ov = api.Overview().Body as Dictionary<string, object>;
                bool ovOk = BoolOf(ov, "ok");
                sb.AppendLine(Check("读账本概览", ovOk, "账本 " + StrOf(ov, "ledgerPath")));
                if (!ovOk) bad++;

                var tasks = api.Tasks(null).Body as Dictionary<string, object>;
                object list = null;
                if (tasks != null) tasks.TryGetValue("tasks", out list);
                var taskList = list as List<object>;
                sb.AppendLine(Check("读任务列表", taskList != null, "任务 " + (taskList == null ? 0 : taskList.Count) + " 条"));
                if (taskList == null) bad++;

                var appr = api.Approvals().Body as Dictionary<string, object>;
                bool apprOk = BoolOf(appr, "ok");
                sb.AppendLine(Check("读审批", apprOk, apprOk ? "读到待批列表" : "读不到"));
                if (!apprOk) bad++;

                var health = api.Health().Body as Dictionary<string, object>;
                bool healthOk = BoolOf(health, "ok");
                sb.AppendLine(Check("读体检", healthOk, healthOk ? "读到步/任务/花费分布" : "读不到"));
                if (!healthOk) bad++;

                var hp = api.HealthProbeAsync().GetAwaiter().GetResult();
                var hpBody = hp.Body as Dictionary<string, object>;
                bool bridgeOk = hp.Status == 200 && BoolOf(hpBody, "ok");
                sb.AppendLine(Check("网关桥（连通 + 令牌）", bridgeOk, "HTTP " + hp.Status));
                if (!bridgeOk) bad++;

                var st = api.Settings().Body as Dictionary<string, object>;
                sb.AppendLine(Check("设置项", BoolOf(st, "ok"), "自动同意=" + (BoolOf(st, "autoApprove") ? "开" : "关")));

                // 自动同意的真身在 dot-core（关了 exe 也生效）；这里验的是「exe 能不能读到它」
                var aa = api.AutoApproveGetAsync().GetAwaiter().GetResult();
                var aaBody = aa.Body as Dictionary<string, object>;
                bool aaOk = aa.Status == 200 && BoolOf(aaBody, "ok");
                string aaVal = "?";
                object aaRaw = null;
                if (aaBody != null && aaBody.TryGetValue("auto_approve_max_tier", out aaRaw) && aaRaw != null)
                {
                    aaVal = aaRaw.ToString();
                }
                sb.AppendLine(Check("自动同意（dot-core）", aaOk, aaOk ? "当前 " + aaVal + " 档（0=关）" : "HTTP " + aa.Status));
                if (!aaOk) bad++;

                // 2026-11-26 加：「过程」页要有结果正文（审计 G4）。以前 artifacts.content 是 BLOB、
                // 一律读成 null，界面只能回一句「做完了。」。这里挑最近的单子确认详情能读出 result。
                string detailMsg = "没有可查的任务";
                bool detailOk = false;
                int scanned = 0, withResult = 0;
                if (taskList != null)
                {
                    foreach (var item in taskList)
                    {
                        if (scanned >= 10) break;
                        string tid = StrOf(item as Dictionary<string, object>, "id");
                        if (string.IsNullOrEmpty(tid)) continue;
                        scanned++;
                        var det = api.TaskDetail(tid).Body as Dictionary<string, object>;
                        if (!BoolOf(det, "ok")) continue;
                        detailOk = true;
                        object rawSteps;
                        var stepList = det.TryGetValue("steps", out rawSteps) ? rawSteps as List<object> : null;
                        if (stepList == null) continue;
                        bool hit = false;
                        foreach (var s in stepList)
                        {
                            object res;
                            var sd = s as Dictionary<string, object>;
                            if (sd != null && sd.TryGetValue("result", out res) && res != null) { hit = true; break; }
                        }
                        if (hit) { withResult++; break; }
                    }
                    detailMsg = "查了 " + scanned + " 单，带结果正文 " + withResult + " 单";
                }
                sb.AppendLine(Check("读任务详情（含结果正文）", detailOk && withResult > 0, detailMsg));
                if (!(detailOk && withResult > 0)) bad++;
            }

            string text = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  alldot 自检" + Environment.NewLine +
                          sb.ToString() +
                          (bad == 0 ? "结论：全部通过" : "结论：有 " + bad + " 项没过") + Environment.NewLine;
            try { File.WriteAllText(Path.Combine(Paths.WritableDir("state"), "selftest.txt"), text, Encoding.UTF8); }
            catch (Exception ex) { text += "（自检结果写文件失败：" + ex.Message + "）" + Environment.NewLine; }
            Paths.Log(text.Replace(Environment.NewLine, " | "));
            return bad == 0 ? 0 : 1;
        }

        [STAThread]
        private static void Main(string[] args)
        {
            // --selftest：不开窗口，只把「读账本 + 打桥」两件事做一遍，结果写文件、按成败给退出码。
            // 用途：换机器/换版本后一条命令验这套东西还通不通，不用靠点界面。
            if (args != null && args.Length > 0 && args[0] == "--selftest")
            {
                Environment.Exit(RunSelfTest());
                return;
            }

            // --judge-test：只验审批裁判（硬规则 + 模型），不碰账本、不改任何批单
            if (args != null && args.Length > 0 && args[0] == "--judge-test")
            {
                string report;
                using (var probe = new Api()) report = probe.JudgeSelfTestAsync().GetAwaiter().GetResult();
                Console.WriteLine(report);
                Environment.Exit(0);
                return;
            }

            bool isNew;
            using (var mutex = new Mutex(true, "alldot-ui-single-instance", out isNew))
            {
                if (!isNew)
                {
                    MessageBox.Show("alldot 界面已经开着了，看任务栏。", "alldot", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Paths.Log("启动，账本：" + Paths.Ledger);
                try
                {
                    Application.Run(new MainForm());
                }
                catch (Exception ex)
                {
                    Paths.Log("崩了：" + ex);
                    MessageBox.Show("程序崩了：" + ex.Message, "alldot", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                GC.KeepAlive(mutex);
            }
        }
    }
}
