// build/installer/Setup.cs —— alldot 安装向导（C# WinForms 单文件）。
//
// 编译：powershell -ExecutionPolicy Bypass -File compile-installer.ps1
// 产出：setup.exe（约 150 KB），双击运行，引导用户完成安装。
//
// 功能：
//   1. 欢迎页 + 许可确认
//   2. 模型配置（API 地址 / Key / 模型名）
//   3. 安装目录选择
//   4. 安装（复制文件 / 创建快捷方式 / 注册自启）
//   5. 完成（可选启动）

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace AlldotInstaller
{
    public class SetupForm : Form
    {
        private Panel _content;
        private Button _btnNext, _btnBack, _btnCancel;
        private int _step = 0;
        private string _installDir;
        private string _modelUrl, _apiKey, _modelName, _workspace;

        // 各页的控件引用
        private TextBox _txtInstallDir, _txtModelUrl, _txtApiKey, _txtModel, _txtWorkspace;
        private CheckBox _chkLaunch;
        private Label _lblStatus;
        private ProgressBar _progress;

        public SetupForm()
        {
            Text = "alldot 安装向导";
            Size = new Size(600, 480);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9F);
            _installDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "alldot");
            _modelUrl = "https://api.deepseek.com/v1";
            _apiKey = "";
            _modelName = "deepseek-chat";
            _workspace = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "alldot-workspace");
            BuildUI();
            ShowStep(0);
        }

        private void BuildUI()
        {
            // 顶部标题
            var lblTitle = new Label
            {
                Text = "alldot 个人 AI 助手",
                Font = new Font("Microsoft YaHei UI", 18F, FontStyle.Bold),
                ForeColor = Color.FromArgb(41, 128, 185),
                Location = new Point(30, 15),
                AutoSize = true,
            };
            Controls.Add(lblTitle);

            var lblSub = new Label
            {
                Text = "安装向导",
                Font = new Font("Microsoft YaHei UI", 10F),
                ForeColor = Color.Gray,
                Location = new Point(32, 50),
                AutoSize = true,
            };
            Controls.Add(lblSub);

            // 内容区
            _content = new Panel
            {
                Location = new Point(30, 80),
                Size = new Size(525, 280),
                BorderStyle = BorderStyle.FixedSingle,
            };
            Controls.Add(_content);

            // 按钮区
            _btnBack = new Button { Text = "上一步", Location = new Point(290, 385), Size = new Size(90, 32), Enabled = false };
            _btnNext = new Button { Text = "下一步", Location = new Point(390, 385), Size = new Size(90, 32) };
            _btnCancel = new Button { Text = "取消", Location = new Point(485, 385), Size = new Size(65, 32) };
            _btnBack.Click += (s, e) => ShowStep(_step - 1);
            _btnNext.Click += (s, e) => NextStep();
            _btnCancel.Click += (s, e) => Close();
            Controls.Add(_btnBack);
            Controls.Add(_btnNext);
            Controls.Add(_btnCancel);
        }

        private void ShowStep(int step)
        {
            _step = Math.Max(0, Math.Min(step, 4));
            _content.Controls.Clear();
            _btnBack.Enabled = _step > 0 && _step < 4;
            _btnNext.Text = _step == 3 ? "安装" : _step == 4 ? "完成" : "下一步";

            switch (_step)
            {
                case 0: BuildWelcome(); break;
                case 1: BuildModelConfig(); break;
                case 2: BuildInstallDir(); break;
                case 3: BuildInstalling(); break;
                case 4: BuildFinish(); break;
            }
        }

        private void NextStep()
        {
            if (_step == 1) { CollectModelConfig(); }
            if (_step == 2) { CollectInstallDir(); }
            if (_step == 3) { DoInstall(); return; }
            if (_step == 4) { Close(); return; }
            ShowStep(_step + 1);
        }

        private void BuildWelcome()
        {
            var lbl = new Label
            {
                Text = "欢迎使用 alldot 安装向导\n\n" +
                       "alldot 是一个个人 AI 助手，可以帮你处理文件、\n" +
                       "浏览器、桌面操作等日常任务。\n\n" +
                       "安装前需要准备：\n" +
                       "  • 一个 LLM API Key（DeepSeek、OpenAI 等）\n" +
                       "  • 大约 200 MB 的磁盘空间\n\n" +
                       "点击「下一步」开始安装。",
                Location = new Point(20, 20),
                Size = new Size(480, 220),
                Font = new Font("Microsoft YaHei UI", 10.5F),
            };
            _content.Controls.Add(lbl);
        }

        private void BuildModelConfig()
        {
            AddLabel("模型配置", 15, 10, 12F, FontStyle.Bold);
            AddLabel("alldot 需要一个 LLM 接口。支持任何 OpenAI 兼容接口。", 15, 40);

            AddLabel("API 地址：", 15, 75);
            _txtModelUrl = AddTextBox(_modelUrl, 15, 100, 490);

            AddLabel("API Key：", 15, 135);
            _txtApiKey = AddTextBox(_apiKey, 15, 160, 490);
            _txtApiKey.UseSystemPasswordChar = true;

            AddLabel("模型名：", 15, 195);
            _txtModel = AddTextBox(_modelName, 15, 220, 240);

            AddLabel("常用：DeepSeek=deepseek-chat，OpenAI=gpt-4o-mini", 270, 222, 8.5F, FontStyle.Regular, Color.Gray);
        }

        private void BuildInstallDir()
        {
            AddLabel("安装位置", 15, 10, 12F, FontStyle.Bold);
            AddLabel("选择 alldot 的安装目录：", 15, 45);

            _txtInstallDir = AddTextBox(_installDir, 15, 75, 420);
            var btnBrowse = new Button { Text = "浏览...", Location = new Point(445, 73), Size = new Size(65, 26) };
            btnBrowse.Click += (s, e) =>
            {
                using (var dlg = new FolderBrowserDialog())
                {
                    if (dlg.ShowDialog() == DialogResult.OK) _txtInstallDir.Text = dlg.SelectedPath;
                }
            };
            _content.Controls.Add(btnBrowse);

            AddLabel("工作目录（存放任务文件的地方）：", 15, 120);
            _txtWorkspace = AddTextBox(_workspace, 15, 148, 490);

            AddLabel("(estimated 200 MB)", 15, 195, 9F, FontStyle.Regular, Color.Gray);
        }

        private void BuildInstalling()
        {
            AddLabel("正在安装...", 15, 15, 12F, FontStyle.Bold);
            _lblStatus = AddLabel("准备中...", 15, 50);
            _progress = new ProgressBar
            {
                Location = new Point(15, 85),
                Size = new Size(490, 25),
                Style = ProgressBarStyle.Marquee,
            };
            _content.Controls.Add(_progress);
        }

        private void BuildFinish()
        {
            AddLabel("安装完成！", 15, 15, 14F, FontStyle.Bold, Color.Green);
            AddLabel("alldot installed to:\n" + _installDir + "\n\n" +
                     "桌面和开始菜单已创建快捷方式。\n" +
                     "已配置开机自动启动。\n\n", 15, 55);

            _chkLaunch = new CheckBox
            {
                Text = "立即启动 alldot",
                Location = new Point(15, 185),
                Checked = true,
                AutoSize = true,
            };
            _content.Controls.Add(_chkLaunch);
        }

        private async void DoInstall()
        {
            _btnNext.Enabled = false;
            _btnBack.Enabled = false;
            _btnCancel.Enabled = false;

            try
            {
                // 写配置
                UpdateStatus("写入配置文件...");
                WriteConfigs();

                // 复制文件
                UpdateStatus("复制程序文件...");
                await Task.Run(() => CopyAppFiles());

                // 创建快捷方式
                UpdateStatus("创建快捷方式...");
                CreateShortcuts();

                // 注册自启
                UpdateStatus("注册开机自启...");
                RegisterAutoStart();

                UpdateStatus("安装完成！");
                _progress.Style = ProgressBarStyle.Continuous;
                _progress.Value = 100;
                ShowStep(4);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Setup failed: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                ShowStep(3);
            }
            finally
            {
                _btnNext.Enabled = true;
                _btnCancel.Enabled = true;
            }
        }

        private void UpdateStatus(string msg)
        {
            if (_lblStatus.InvokeRequired)
                _lblStatus.Invoke(new Action(() => _lblStatus.Text = msg));
            else
                _lblStatus.Text = msg;
            Application.DoEvents();
        }

        private void CollectModelConfig()
        {
            _modelUrl = _txtModelUrl.Text.Trim();
            _apiKey = _txtApiKey.Text.Trim();
            _modelName = _txtModel.Text.Trim();
            if (string.IsNullOrEmpty(_modelUrl)) _modelUrl = "https://api.deepseek.com/v1";
            if (string.IsNullOrEmpty(_modelName)) _modelName = "deepseek-chat";

            if (string.IsNullOrEmpty(_apiKey))
            {
                MessageBox.Show("请填写 API Key。如果不填，alldot 将无法调用模型。", "提示",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void CollectInstallDir()
        {
            _installDir = _txtInstallDir.Text.Trim();
            _workspace = _txtWorkspace.Text.Trim();
            if (string.IsNullOrEmpty(_installDir))
                _installDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "alldot");
            if (string.IsNullOrEmpty(_workspace))
                _workspace = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "alldot-workspace");
        }

        private void WriteConfigs()
        {
            var homeDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var allbotDir = Path.Combine(homeDir, ".allbot");
            var dotDir = Path.Combine(allbotDir, "dot");
            Directory.CreateDirectory(allbotDir);
            Directory.CreateDirectory(dotDir);
            Directory.CreateDirectory(_workspace);

            // allbot.json — 模型配置
            var allbotJson = "{\n" +
                "  \"models\": {\n" +
                "    \"providers\": {\n" +
                "      \"local\": {\n" +
                "        \"baseUrl\": \"" + _modelUrl + "\",\n" +
                "        \"apiKey\": \"" + _apiKey + "\",\n" +
                "        \"model\": \"" + _modelName + "\"\n" +
                "      }\n" +
                "    }\n" +
                "  }\n" +
                "}";
            File.WriteAllText(Path.Combine(allbotDir, "allbot.json"), allbotJson, Encoding.UTF8);

            // config.json — dot-core 配置
            var dotJson = "{\n" +
                "  \"budget\": { \"tokens\": 2000000 },\n" +
                "  \"approvals\": { \"auto_approve_max_tier\": 1 },\n" +
                "  \"workspace\": \"" + _workspace.Replace("\\", "\\\\") + "\"\n" +
                "}";
            File.WriteAllText(Path.Combine(dotDir, "config.json"), dotJson, Encoding.UTF8);
        }

        private void CopyAppFiles()
        {
            // 从安装包的 app/ 复制到安装目录
            var srcApp = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app");
            var dstApp = Path.Combine(_installDir, "app");

            if (!Directory.Exists(srcApp))
            {
                // 如果 app/ 不在安装包里（开发模式），从项目目录复制
                var devSrc = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "..");
                if (Directory.Exists(Path.Combine(devSrc, "dot-core")))
                    srcApp = devSrc;
                else
                    throw new DirectoryNotFoundException("App folder not found: " + srcApp);
            }

            CopyDirectory(srcApp, dstApp);
        }

        private static void CopyDirectory(string src, string dst)
        {
            Directory.CreateDirectory(dst);
            foreach (var file in Directory.GetFiles(src))
            {
                var name = Path.GetFileName(file);
                if (name.EndsWith(".log") || name.EndsWith(".tmp")) continue;
                File.Copy(file, Path.Combine(dst, name), true);
            }
            foreach (var dir in Directory.GetDirectories(src))
            {
                var name = Path.GetFileName(dir);
                if (name == "node_modules" || name == ".git") continue;
                CopyDirectory(dir, Path.Combine(dst, name));
            }
        }

        private void CreateShortcuts()
        {
            var uiExe = Path.Combine(_installDir, "app", "ui", "alldot-ui.exe");
            if (!File.Exists(uiExe)) return;

            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
            var startMenu = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "alldot");
            Directory.CreateDirectory(startMenu);

            CreateShortcut(Path.Combine(desktop, "alldot.lnk"), uiExe, _installDir);
            CreateShortcut(Path.Combine(startMenu, "alldot.lnk"), uiExe, _installDir);
            CreateShortcut(Path.Combine(startMenu, "卸载 alldot.lnk"), Assembly.GetExecutingAssembly().Location, _installDir);
        }

        private static void CreateShortcut(string path, string target, string workDir)
        {
            // Use PowerShell to create shortcut (avoid COM dependency)
            var ps = string.Format(@"
$WshShell = New-Object -ComObject WScript.Shell
$shortcut = $WshShell.CreateShortcut('{0}')
$shortcut.TargetPath = '{1}'
$shortcut.WorkingDirectory = '{2}'
$shortcut.Save()", path, target, workDir);
            Process.Start(new ProcessStartInfo
            {
                FileName = "powershell",
                Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"" + ps.Replace("\"", "\\\"") + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
            }).WaitForExit(10000);
        }

        private void RegisterAutoStart()
        {
            var dotUp = Path.Combine(_installDir, "app", "tools", "dot-up.ps1");
            if (!File.Exists(dotUp)) return;

            var ps = "schtasks /Create /TN \"alldot\" /TR \"powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File `\"" + dotUp + "`\"\" /SC ONLOGON /F";
            Process.Start(new ProcessStartInfo
            {
                FileName = "powershell",
                Arguments = "-NoProfile -Command \"" + ps.Replace("\"", "\\\"") + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
            }).WaitForExit(10000);
        }

        private Label AddLabel(string text, int x, int y, float size = 9.5F,
            FontStyle style = FontStyle.Regular, Color? color = null)
        {
            var lbl = new Label
            {
                Text = text,
                Location = new Point(x, y),
                AutoSize = true,
                Font = new Font("Microsoft YaHei UI", size, style),
                ForeColor = color ?? Color.Black,
            };
            _content.Controls.Add(lbl);
            return lbl;
        }

        private TextBox AddTextBox(string text, int x, int y, int width)
        {
            var txt = new TextBox
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(width, 25),
                Font = new Font("Microsoft YaHei UI", 9.5F),
            };
            _content.Controls.Add(txt);
            return txt;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_step == 3 && _btnNext.Enabled == false)
            {
                if (MessageBox.Show("正在安装，确定要取消吗？", "确认",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.No)
                {
                    e.Cancel = true;
                }
            }
        }
    }

    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            // 卸载模式
            if (args.Length > 0 && args[0] == "--uninstall")
            {
                Uninstall();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
        }

        static void Uninstall()
        {
            var result = MessageBox.Show(
                "确定要卸载 alldot 吗？\n\n所有程序文件将被删除，但你的任务数据会保留。",
                "卸载 alldot", MessageBoxButtons.YesNo, MessageBoxIcon.Question);

            if (result != DialogResult.Yes) return;

            var installDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "alldot");

            // 停服务
            try
            {
                Process.Start("schtasks", "/End /TN \"alldot\"").WaitForExit(5000);
                Process.Start("schtasks", "/Delete /TN \"alldot\" /F").WaitForExit(5000);
            }
            catch { }

            // 删文件
            try
            {
                if (Directory.Exists(installDir))
                    Directory.Delete(installDir, true);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Delete failed: " + ex.Message, "Info", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }

            // 删快捷方式
            try
            {
                var desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Desktop), "alldot.lnk");
                var startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "alldot");
                if (File.Exists(desktop)) File.Delete(desktop);
                if (Directory.Exists(startMenu)) Directory.Delete(startMenu, true);
            }
            catch { }

            MessageBox.Show("alldot 已卸载。任务数据保留在 ~/.allbot/dot/ 目录。", "卸载完成",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
}
