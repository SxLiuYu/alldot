// build/ui/AlldotJudge.cs —— 智能审批：先过**硬规则**，再让本机模型判断这一单该不该自动同意。
//
// 为什么单独一个文件：主文件已经一千行，审批这块是一套完整策略（规则 → 模型 → 留痕 → 缓存），
// 拆出来才好读、好改。Api 类在主文件里声明为 partial。
//
// 三档（settings.mode）：
//   off    全都要人批（默认）
//   tier4  机械：第 4 档以内一律自动同意（不问内容）
//   smart  智能：硬规则能过 → 再问模型；模型说「允许」且把握 ≥ 0.8 才自动批
//
// 硬规则（模型不能推翻）：
//   * 第 5 档（要人亲自做的高危动作）→ 永远问人
//   * 标题/详情/意图里出现删除、格式化、卸载、注册表、关机、shell 这类字眼 → 永远问人
//   * 动作目标不在这单允许的文件夹里 → 永远问人
// 模型说「别批」或拿不准 → **不自动拒绝**，留在界面上把理由显示给人，批还是人批。

using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;

namespace Alldot
{
    internal sealed class JudgeResult
    {
        public string Verdict;      // allow | ask | deny
        public string Why;
        public double Confidence;
        public string Source;       // rule | model | fallback
        public string At;
    }

    internal sealed partial class Api
    {
        private const string JudgeModelDefault = "deepseek-v4.1-flash";
        /** 判一次最多等这么久；超时就当「拿不准」，留给人。 */
        private static readonly TimeSpan JudgeTimeout = TimeSpan.FromSeconds(40);
        /** 自动同意的把握门槛。 */
        private const double AutoApproveConfidence = 0.8;

        private string mode = "off";
        private readonly Dictionary<string, JudgeResult> advice = new Dictionary<string, JudgeResult>();

        // ---------- 设置 ----------

        private static string NormalizeMode(string raw)
        {
            if (raw == "tier4" || raw == "smart") return raw;
            return "off";
        }

        private void LoadSettings()
        {
            try
            {
                if (File.Exists(settingsFile))
                {
                    var o = json.DeserializeObject(File.ReadAllText(settingsFile, Encoding.UTF8)) as Dictionary<string, object>;
                    object v;
                    if (o != null && o.TryGetValue("mode", out v) && v is string) mode = NormalizeMode((string)v);
                    else if (o != null && o.TryGetValue("autoApprove", out v) && v is bool && (bool)v) mode = "tier4"; // 旧版本兼容
                }
            }
            catch (Exception ex) { Paths.Log("读设置失败：" + ex.Message); }

            try
            {
                string file = Path.Combine(Path.GetDirectoryName(settingsFile) ?? ".", "judge-cache.json");
                if (!File.Exists(file)) return;
                var o = json.DeserializeObject(File.ReadAllText(file, Encoding.UTF8)) as Dictionary<string, object>;
                if (o == null) return;
                foreach (var kv in o)
                {
                    var d = kv.Value as Dictionary<string, object>;
                    if (d == null) continue;
                    var r = new JudgeResult();
                    r.Verdict = Text(d, "verdict");
                    r.Why = Text(d, "why");
                    r.Confidence = Number(d, "confidence");
                    r.Source = Text(d, "source");
                    r.At = Text(d, "at");
                    advice[kv.Key] = r;
                }
            }
            catch (Exception ex) { Paths.Log("读审批建议缓存失败：" + ex.Message); }
        }

        private static string Text(Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) && v != null ? v.ToString() : "";
        }

        private static double Number(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return 0;
            try { return Convert.ToDouble(v); } catch { return 0; }
        }

        public ApiResult Settings()
        {
            var m = Map();
            m["ok"] = true;
            m["mode"] = mode;
            m["autoApprove"] = mode == "tier4";
            m["settingsFile"] = settingsFile;
            if (mode == "off")
                m["rule"] = "关着：每一张都要你点。开了之后第 4 档以内可以自动同意，第 5 档永远问你。";
            else if (mode == "tier4")
                m["rule"] = "机械：第 4 档以内一律自动同意（不看内容）；第 5 档永远问你。";
            else
                m["rule"] = "智能：先过硬规则（第 5 档、高危动作、越界路径一律问你），再让模型看这一单该不该批；只有它说「允许」且把握 ≥ 0.8 才自动同意，其余留给你并附上理由。";
            return new ApiResult(200, m);
        }

        public ApiResult SaveSettings(Dictionary<string, object> body)
        {
            object v;
            if (body != null && body.TryGetValue("mode", out v) && v is string)
            {
                mode = NormalizeMode((string)v);
                PersistSettings();
            }
            else if (body != null && body.TryGetValue("autoApprove", out v) && v is bool)
            {
                mode = (bool)v ? "tier4" : "off";
                PersistSettings();
            }
            return Settings();
        }

        private void PersistSettings()
        {
            try
            {
                var o = new Dictionary<string, object>();
                o["mode"] = mode;
                o["updatedAt"] = DateTime.UtcNow.ToString("o");
                File.WriteAllText(settingsFile, json.Serialize(o), Encoding.UTF8);
                Paths.Log("审批模式：" + mode);
            }
            catch (Exception ex) { Paths.Log("写设置失败：" + ex.Message); }
        }

        // ---------- 留痕 ----------

        public ApiResult AutoLog()
        {
            var lines = new List<object>();
            try
            {
                if (File.Exists(autoLogFile))
                {
                    string[] all = File.ReadAllLines(autoLogFile, Encoding.UTF8);
                    int from = Math.Max(0, all.Length - 40);
                    for (int i = all.Length - 1; i >= from; i--) if (all[i].Trim() != "") lines.Add(all[i]);
                }
            }
            catch { }
            var m = Map();
            m["ok"] = true;
            m["mode"] = mode;
            m["lines"] = lines;
            return new ApiResult(200, m);
        }

        private void AppendAutoLog(string line)
        {
            try
            {
                File.AppendAllText(autoLogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        /** 页面上给每张待批单附一句「智能审批建议」；没有就返回 null。 */
        public object AdviceFor(string approvalId)
        {
            JudgeResult r;
            if (approvalId == null || !advice.TryGetValue(approvalId, out r)) return null;
            var m = Map();
            m["verdict"] = r.Verdict;
            m["why"] = r.Why;
            m["confidence"] = r.Confidence;
            m["source"] = r.Source;
            m["at"] = r.At;
            return m;
        }

        // ---------- 主循环：定时调 ----------

        public async Task<int> AutoApprovePendingAsync()
        {
            if (mode == "off") return 0;
            var rows = db.Query("select id, task_id, tier, title, detail_json from approvals where status = 'pending' order by created_at asc limit 20");
            int approved = 0;
            int judgedThisTick = 0;

            foreach (var row in rows)
            {
                string id = Str(row, "id");
                if (string.IsNullOrEmpty(id)) continue;
                long tier = Num(row, "tier");

                if (mode == "tier4")
                {
                    if (tier > 4) continue;
                    if (await ApproveAndLog(id, row, "机械：第 4 档以内")) approved++;
                    continue;
                }

                JudgeResult jr;
                if (!advice.TryGetValue(id, out jr))
                {
                    if (judgedThisTick >= 3) continue;   // 一轮最多判三张，别把模型池打满
                    jr = await JudgeAsync(row);
                    judgedThisTick++;
                    advice[id] = jr;
                    SaveAdvice();
                    Paths.Log("智能审批建议 " + id + " → " + jr.Verdict + "（" + jr.Confidence.ToString("0.##") + "）：" + jr.Why);
                }

                if (jr.Verdict == "allow" && jr.Confidence >= AutoApproveConfidence)
                {
                    if (await ApproveAndLog(id, row, "智能：" + jr.Why)) approved++;
                }
            }
            return approved;
        }

        private async Task<bool> ApproveAndLog(string id, Dictionary<string, object> row, string why)
        {
            var res = await DecideAsync(id, "approved");
            var body = res.Body as Dictionary<string, object>;
            object v;
            bool ok = body != null && body.TryGetValue("ok", out v) && v is bool && (bool)v;
            if (!ok) return false;
            AppendAutoLog("自动同意  第" + Num(row, "tier") + "档  " + Str(row, "title") + "  （任务 " + Str(row, "task_id") + "）  依据：" + why);
            Paths.Log("自动同意批单 " + id + "：" + why);
            return true;
        }

        private void SaveAdvice()
        {
            try
            {
                var o = new Dictionary<string, object>();
                foreach (var kv in advice)
                {
                    var d = new Dictionary<string, object>();
                    d["verdict"] = kv.Value.Verdict;
                    d["why"] = kv.Value.Why;
                    d["confidence"] = kv.Value.Confidence;
                    d["source"] = kv.Value.Source;
                    d["at"] = kv.Value.At;
                    o[kv.Key] = d;
                }
                string file = Path.Combine(Path.GetDirectoryName(settingsFile) ?? ".", "judge-cache.json");
                File.WriteAllText(file, json.Serialize(o), Encoding.UTF8);
            }
            catch (Exception ex) { Paths.Log("写审批建议缓存失败：" + ex.Message); }
        }

        // ---------- 判断 ----------

        private async Task<JudgeResult> JudgeAsync(Dictionary<string, object> row)
        {
            long tier = Num(row, "tier");
            string title = Str(row, "title") ?? "";
            string detailRaw = Str(row, "detail_json") ?? "";
            string taskId = Str(row, "task_id") ?? "";

            var task = db.One("select intent, declared_json from tasks where id = ?", taskId);
            string intent = task == null ? "" : (Str(task, "intent") ?? "");
            string declared = task == null ? "" : (Str(task, "declared_json") ?? "");
            string workspace = WorkspaceOf(declared);
            string action = FindKey(detailRaw, "action");
            if (action == "") action = FindKey(detailRaw, "tool");
            string target = FindKey(detailRaw, "path");
            if (target == "") target = FindKey(detailRaw, "target");

            return await JudgeCore(intent, workspace, action, target, tier, title, detailRaw);
        }

        /** 判断的本体：不碰账本，只按给定上下文过规则、再问模型。 */
        private async Task<JudgeResult> JudgeCore(string intent, string workspace, string action, string target, long tier, string title, string detailRaw)
        {
            // 硬规则一：第 5 档永远问人
            if (tier >= 5) return Rule("ask", "第 5 档是要人亲自做的高危动作，必须你决定");

            // 硬规则二：高危字眼
            string hay = (title + " " + detailRaw + " " + intent).ToLowerInvariant();
            string[] danger = new string[]
            {
                "删除", "格式化", "清空", "卸载", "注册表", "regedit", "del ", "rmdir", "remove-item",
                "format ", "shutdown", "reboot", "powershell", "cmd /c", "cmd.exe", "curl ", "wget ",
                "set-executionpolicy", "net user", "schtasks", "sc create",
            };
            foreach (string d in danger)
                if (hay.Contains(d)) return Rule("ask", "含高危动作字样「" + d.Trim() + "」，必须你决定");

            // 硬规则三：目标越界
            if (workspace != "" && target != "" && !Inside(target, workspace))
                return Rule("ask", "目标 " + target + " 不在这一单允许的文件夹 " + workspace + " 里");

            // 硬规则过完了，才问模型
            string content = await CallJudgeModel(intent, workspace, action, target, tier, title, detailRaw);
            if (content == null)
                return Rule("ask", "本机模型没给出判断（读不到 key 或超时），留给你");

            JudgeResult parsed = ParseJudgement(content);
            if (parsed != null) return parsed;

            // 模型没按 JSON 回：宁可当作拿不准
            return new JudgeResult
            {
                Verdict = "ask",
                Why = "模型没按格式回答，按拿不准处理：" + Shorten(content, 120),
                Confidence = 0.3,
                Source = "fallback",
                At = DateTime.UtcNow.ToString("o"),
            };
        }

        private static JudgeResult Rule(string verdict, string why)
        {
            return new JudgeResult
            {
                Verdict = verdict,
                Why = why,
                Confidence = 1,
                Source = "rule",
                At = DateTime.UtcNow.ToString("o"),
            };
        }

        /** 把动作写成模型一眼看懂的日常说法（别丢原始名，括号带上）。 */
        private static string Describe(string action)
        {
            string a = (action ?? "").ToLowerInvariant();
            string plain = "做一步操作";
            if (a.Contains("mkdir")) plain = "新建文件夹";
            else if (a.Contains("write")) plain = "写文件";
            else if (a.Contains("list")) plain = "看目录里有什么";
            else if (a.Contains("click")) plain = "在屏幕上点击";
            else if (a.Contains("type")) plain = "打字输入";
            return plain + "（" + (action == "" ? "未知" : action) + "）";
        }

        private static string Shorten(string s, int n)
        {
            if (string.IsNullOrEmpty(s)) return "";
            s = s.Replace("\r", " ").Replace("\n", " ").Trim();
            return s.Length <= n ? s : s.Substring(0, n) + "…";
        }

        /**
         * 从模型回复里抽判断。实测四个模型的键名各不相同（verdict / 同意 / auto_approve / approve），
         * 有的还包在代码块里，所以这里做宽容解析：布尔字段优先，其次看 verdict/结论 这类字符串。
         * 抽不出就返回 null（上层按「拿不准」处理，留给人）。
         */
        private JudgeResult ParseJudgement(string content)
        {
            if (string.IsNullOrEmpty(content)) return null;
            string text = content.Replace("```json", " ").Replace("```", " ");
            int a = text.IndexOf('{');
            if (a < 0) return null;
            int b = text.LastIndexOf('}');

            // 模型经常少写最后的 }，或者后面紧跟一句话。三种候选逐个试，能解析就用。
            Dictionary<string, object> o = null;
            string[] candidates = new string[]
            {
                b > a ? text.Substring(a, b - a + 1) : "",
                text.Substring(a) + "}",
                text.Substring(a).Trim() + "}",
            };
            foreach (string cand in candidates)
            {
                if (string.IsNullOrEmpty(cand)) continue;
                try { o = json.DeserializeObject(cand) as Dictionary<string, object>; } catch { o = null; }
                if (o != null) break;
            }
            if (o == null) return null;

            string why = FirstText(o, new string[] { "why", "reason", "理由", "说明", "原因" });
            double conf = FirstNumber(o, new string[] { "confidence", "把握", "置信度", "确信度" });

            string verdict = "";
            bool? flag = FirstBool(o, new string[] { "auto_approve", "approve", "allow", "approved", "同意", "自动同意", "可以自动同意" });
            if (flag.HasValue) verdict = flag.Value ? "allow" : "ask";
            else verdict = NormalizeVerdict(FirstText(o, new string[] { "verdict", "结论", "decision", "决定" }));

            // 布尔说同意、但理由里写着「拒绝/不应/需确认」的，按拿不准处理，不替用户做主
            if (verdict == "allow" && NormalizeVerdict(why) == "deny") verdict = "ask";
            if (verdict == "") return null;
            if (conf <= 0) conf = verdict == "allow" ? 0.85 : 0.9;

            var r = new JudgeResult();
            r.Verdict = verdict;
            r.Why = why == "" ? "（模型没写理由）" : why;
            r.Confidence = conf;
            r.Source = "model";
            r.At = DateTime.UtcNow.ToString("o");
            return r;
        }

        private static string NormalizeVerdict(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return "";
            string t = raw.ToLowerInvariant();
            if (t.Contains("deny") || t.Contains("拒绝") || t.Contains("不应") || t.Contains("不要")
                || t.Contains("不批准") || t.Contains("不建议") || t == "false") return "deny";
            if (t.Contains("ask") || t.Contains("问") || t.Contains("确认") || t.Contains("拿不准") || t.Contains("人工")) return "ask";
            if (t.Contains("allow") || t.Contains("允许") || t.Contains("同意") || t.Contains("approve") || t == "true") return "allow";
            return "";
        }

        private static string FirstText(Dictionary<string, object> o, string[] keys)
        {
            foreach (string k in keys)
            {
                object v;
                if (o.TryGetValue(k, out v) && v is string && ((string)v).Trim() != "") return ((string)v).Trim();
            }
            return "";
        }

        private static double FirstNumber(Dictionary<string, object> o, string[] keys)
        {
            foreach (string k in keys)
            {
                object v;
                if (!o.TryGetValue(k, out v) || v == null) continue;
                try { return Convert.ToDouble(v); } catch { }
            }
            return 0;
        }

        private static bool? FirstBool(Dictionary<string, object> o, string[] keys)
        {
            foreach (string k in keys)
            {
                object v;
                if (!o.TryGetValue(k, out v) || v == null) continue;
                if (v is bool) return (bool)v;
                string sv = v.ToString().Trim().ToLowerInvariant();
                if (sv == "true" || sv == "是" || sv == "同意" || sv == "允许" || sv == "yes") return true;
                if (sv == "false" || sv == "否" || sv == "拒绝" || sv == "不要" || sv == "no") return false;
            }
            return null;
        }

        private async Task<string> CallJudgeModel(string intent, string workspace, string action, string target, long tier, string title, string detailRaw)
        {
            var ep = ModelEndpoint();
            if (ep == null) return null;

            string system =
                "你是本地助手的审批裁判，只做判断，不执行任何命令。\n" +
                "用户的授权：在他指定的文件夹里新建文件夹、写新文件，是已经同意的常规操作，可以直接放行，不用再问。\n" +
                "你只需要发现例外：会覆盖或删除已有内容、目标超出那个文件夹、动作看不懂、可能联网或装软件或改系统设置。\n" +
                "只输出一行 JSON，禁止解释段落、禁止 markdown、禁止代码块标记、禁止输出命令。\n" +
                "格式：{\"verdict\":\"allow|ask|deny\",\"why\":\"一句中文理由\",\"confidence\":0.0到1.0}\n";

            string user =
                "任务意图：" + intent + "\n" +
                "允许它动手的文件夹：" + (workspace == "" ? "（没声明）" : workspace) + "\n" +
                "这一步：" + Describe(action) + "，目标=" + (target == "" ? "未知" : target) + "\n" +
                "标题：" + title + "\n" +
                "详情：" + Shorten(detailRaw, 800) +
                "\n按上面的政策：这一步该放行（allow）还是留给人（ask）？只回一行 JSON，不要给命令。";

            var payload = new Dictionary<string, object>();
            payload["model"] = Environment.GetEnvironmentVariable("ALLDOT_JUDGE_MODEL") ?? JudgeModelDefault;
            payload["temperature"] = 0;
            var messages = new List<object>();
            messages.Add(new Dictionary<string, object> { { "role", "system" }, { "content", system } });
            messages.Add(new Dictionary<string, object> { { "role", "user" }, { "content", user } });
            payload["messages"] = messages;

            try
            {
                using (var cts = new System.Threading.CancellationTokenSource(JudgeTimeout))
                {
                    var req = new HttpRequestMessage(HttpMethod.Post, ep["baseUrl"] + "/chat/completions");
                    req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", ep["apiKey"]);
                    req.Content = new StringContent(json.Serialize(payload), Encoding.UTF8, "application/json");
                    var res = await http.SendAsync(req, cts.Token);
                    string text = await res.Content.ReadAsStringAsync();
                    if (!res.IsSuccessStatusCode)
                    {
                        Paths.Log("审批裁判调用失败 HTTP " + (int)res.StatusCode + "：" + Shorten(text, 200));
                        return null;
                    }
                    var o = json.DeserializeObject(text) as Dictionary<string, object>;
                    if (o == null) return null;
                    object choicesObj;
                    if (!o.TryGetValue("choices", out choicesObj)) return null;
                    var choices = choicesObj as System.Collections.IList;
                    if (choices == null || choices.Count == 0) return null;
                    var first = choices[0] as Dictionary<string, object>;
                    if (first == null) return null;
                    object msgObj;
                    if (!first.TryGetValue("message", out msgObj)) return null;
                    var msg = msgObj as Dictionary<string, object>;
                    return msg == null ? null : Text(msg, "content");
                }
            }
            catch (Exception ex)
            {
                Paths.Log("审批裁判调用异常：" + ex.Message);
                return null;
            }
        }

        /** 模型池的地址与 key：与工人用的是同一处（allbot.json 的 models.providers.local）。 */
        private Dictionary<string, string> ModelEndpoint()
        {
            try
            {
                var o = json.DeserializeObject(File.ReadAllText(Paths.AllbotJson, Encoding.UTF8)) as Dictionary<string, object>;
                if (o == null) return null;
                object modelsObj;
                if (!o.TryGetValue("models", out modelsObj)) return null;
                var models = modelsObj as Dictionary<string, object>;
                if (models == null) return null;
                object provObj;
                if (!models.TryGetValue("providers", out provObj)) return null;
                var providers = provObj as Dictionary<string, object>;
                if (providers == null) return null;
                object localObj;
                if (!providers.TryGetValue("local", out localObj)) return null;
                var local = localObj as Dictionary<string, object>;
                if (local == null) return null;

                string baseUrl = Text(local, "baseUrl");
                if (baseUrl == "") baseUrl = "http://127.0.0.1:3065/v1";
                string apiKey = Text(local, "apiKey");
                if (apiKey == "" || apiKey == "local") return null;
                var ep = new Dictionary<string, string>();
                ep["baseUrl"] = baseUrl.TrimEnd('/');
                ep["apiKey"] = apiKey;
                return ep;
            }
            catch (Exception ex)
            {
                Paths.Log("读模型池配置失败：" + ex.Message);
                return null;
            }
        }

        /** --judge-test 用：四个固定用例走一遍，看规则和模型各自怎么判。 */
        public async Task<string> JudgeSelfTestAsync()
        {
            var sb = new StringBuilder();
            string ws = "C:/Users/1/Documents/练习";
            string intent = "在练习文件夹里建一个叫 验收 的文件夹";

            var cases = new List<string[]>();
            cases.Add(new string[] { "1 正常：工作区内建目录", intent, ws, "files/mkdir", "C:/Users/1/Documents/练习/验收", "2", "工作区文件动作需要批准：mkdir 验收" });
            cases.Add(new string[] { "2 越界：目标在允许文件夹外", intent, ws, "files/write", "C:/Windows/System32/x.txt", "2", "工作区文件动作需要批准：write" });
            cases.Add(new string[] { "3 高危字眼：标题含删除", "清理临时文件", ws, "files/list", "C:/Users/1/Documents/练习", "4", "这一步要删除旧文件，需要批准" });
            cases.Add(new string[] { "4 第5档：永远问人", intent, ws, "desktop/click", "微信", "5", "要在屏幕上点击" });
            cases.Add(new string[] { "5 覆盖已有文件：模型该说别批", intent, ws, "files/write", "C:/Users/1/Documents/练习/周报.md", "2", "文件已存在，这一步会覆盖它" });

            foreach (var c in cases)
            {
                long tier = 0;
                long.TryParse(c[5], out tier);
                var r = await JudgeCore(c[1], c[2], c[3], c[4], tier, c[6], c[6]);
                sb.AppendLine(c[0] + " → " + r.Verdict + "（把握 " + r.Confidence.ToString("0.##") + "，来源 " + r.Source + "）");
                sb.AppendLine("    理由：" + r.Why);
            }
            string text = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  审批裁判自检" + Environment.NewLine + sb.ToString();
            try { File.WriteAllText(Path.Combine(Paths.WritableDir("state"), "judge-test.txt"), text, Encoding.UTF8); } catch { }
            Paths.Log(text.Replace(Environment.NewLine, " | "));
            return text;
        }

        // ---------- 路径与字段小工具 ----------

        private static string WorkspaceOf(string declaredJson)
        {
            if (string.IsNullOrEmpty(declaredJson)) return "";
            foreach (string key in new string[] { "workspace", "root", "workdir", "dir" })
            {
                string v = FindKey(declaredJson, key);
                if (v != "") return v;
            }
            return "";
        }

        /** 在任意层级的 JSON 里找第一个叫 key 的字符串值；找不到返回空串。 */
        private static string FindKey(string jsonText, string key)
        {
            if (string.IsNullOrEmpty(jsonText)) return "";
            int at = jsonText.IndexOf("\"" + key + "\"", StringComparison.OrdinalIgnoreCase);
            while (at >= 0)
            {
                int colon = jsonText.IndexOf(':', at);
                if (colon < 0) return "";
                int i = colon + 1;
                while (i < jsonText.Length && char.IsWhiteSpace(jsonText[i])) i++;
                if (i < jsonText.Length && jsonText[i] == '"')
                {
                    int end = jsonText.IndexOf('"', i + 1);
                    if (end > i) return jsonText.Substring(i + 1, end - i - 1);
                }
                at = jsonText.IndexOf("\"" + key + "\"", at + 1, StringComparison.OrdinalIgnoreCase);
            }
            return "";
        }

        private static bool Inside(string target, string workspace)
        {
            string t = target.Replace('\\', '/').TrimEnd('/').ToLowerInvariant();
            string w = workspace.Replace('\\', '/').TrimEnd('/').ToLowerInvariant();
            if (w == "") return false;
            if (t == w) return true;
            return t.StartsWith(w + "/", StringComparison.Ordinal);
        }
    }
}
