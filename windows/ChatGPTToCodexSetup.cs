using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Management;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class ChatGPTToCodexSetup
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm(args));
    }
}

internal sealed class SetupForm : Form
{
    private const string Marker = "CHATGPT2CODEX_SETUP_PAYLOAD_V1";
    private readonly string[] args;
    private readonly Label title;
    private readonly Label detail;
    private readonly ProgressBar progress;
    private readonly Button closeButton;
    private readonly bool autoClose;

    internal SetupForm(string[] args)
    {
        this.args = args;
        autoClose = HasArg("/NoLaunch") || HasArg("--no-launch") || HasArg("/Quiet") || HasArg("/Silent") || HasArg("--quiet") || HasArg("--silent");
        Text = "JK Setup";
        Width = 520;
        Height = 220;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        SetWindowIcon(this);

        title = new Label();
        title.Text = "Installing JK";
        title.Font = new System.Drawing.Font("Segoe UI", 13, System.Drawing.FontStyle.Bold);
        title.SetBounds(22, 18, 460, 28);

        detail = new Label();
        detail.Text = "Preparing installer...";
        detail.SetBounds(24, 62, 455, 42);

        progress = new ProgressBar();
        progress.Style = ProgressBarStyle.Marquee;
        progress.Minimum = 0;
        progress.Maximum = 100;
        progress.SetBounds(24, 112, 455, 18);

        closeButton = new Button();
        closeButton.Text = "Close";
        closeButton.Enabled = false;
        closeButton.SetBounds(390, 145, 90, 28);
        closeButton.Click += delegate { Close(); };

        Controls.Add(title);
        Controls.Add(detail);
        Controls.Add(progress);
        Controls.Add(closeButton);

        Shown += delegate { ThreadPool.QueueUserWorkItem(delegate { Install(); }); };
    }

    private bool HasArg(string value)
    {
        foreach (var arg in args)
        {
            if (string.Equals(arg, value, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private void SetDetail(string text)
    {
        BeginInvoke((Action)delegate { detail.Text = text; });
    }

    private void SetProgress(int value)
    {
        BeginInvoke((Action)delegate
        {
            progress.Style = ProgressBarStyle.Continuous;
            progress.Value = Math.Max(progress.Minimum, Math.Min(progress.Maximum, value));
        });
    }

    private void Finish(string titleText, string detailText, bool ok)
    {
        BeginInvoke((Action)delegate
        {
            title.Text = titleText;
            detail.Text = detailText;
            progress.Style = ProgressBarStyle.Blocks;
            progress.Value = ok ? 100 : 0;
            closeButton.Enabled = true;
            Environment.ExitCode = ok ? 0 : 1;
            if (autoClose) Close();
        });
    }

    private void Install()
    {
        try
        {
            var installDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "JK");
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            EnsureChildPath(installDir, localAppData);

            SetDetail("Stopping JK if it is running...");
            RunHidden("taskkill.exe", "/im JK.exe /t /f", true);
            RunHidden("taskkill.exe", "/im chatgpt2codex.exe /t /f", true);
            StopInstalledProcessTrees(installDir);

            SetDetail("Extracting application files...");
            var tempRoot = Path.Combine(Path.GetTempPath(), "chatgpt2codex-setup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempRoot);
            var zipPath = Path.Combine(tempRoot, "payload.zip");
            try
            {
                SetProgress(5);
                ExtractPayload(zipPath);
                SetProgress(20);
                if (Directory.Exists(installDir)) DeleteDirectoryWithRetries(installDir);
                Directory.CreateDirectory(installDir);
                ExpandZip(zipPath, installDir);
            }
            finally
            {
                try { Directory.Delete(tempRoot, true); } catch { }
            }

            SetDetail("Creating shortcuts...");
            SetProgress(95);
            RemoveLegacyShortcutsAndStartup();
            var exe = Path.Combine(installDir, "JK.exe");
            if (!File.Exists(exe)) throw new InvalidOperationException("Installed JK.exe was not found.");
            var icon = Path.Combine(installDir, "JK.ico");
            if (!File.Exists(icon)) icon = exe;
            CreateShortcut(
                Path.Combine(GetProgramsFolder(), "JK.lnk"),
                exe,
                installDir,
                icon);
            CreateShortcut(
                Path.Combine(GetDesktopFolder(), "JK.lnk"),
                exe,
                installDir,
                icon);

            if (!HasArg("/NoLaunch") && !HasArg("--no-launch"))
            {
                SetDetail("Launching JK...");
                Process.Start(new ProcessStartInfo
                {
                    FileName = exe,
                    WorkingDirectory = installDir,
                    UseShellExecute = true
                });
            }

            Finish("Installation complete", "JK is installed and ready to use.", true);
        }
        catch (Exception ex)
        {
            Finish("Installation failed", ex.Message, false);
        }
    }

    private static void RemoveLegacyShortcutsAndStartup()
    {
        DeleteFileIfExists(Path.Combine(GetProgramsFolder(), "JK.lnk"));
        DeleteFileIfExists(Path.Combine(GetDesktopFolder(), "JK.lnk"));
        DeleteFileIfExists(Path.Combine(GetProgramsFolder(), "ChatGPT To Codex.lnk"));
        DeleteFileIfExists(Path.Combine(GetDesktopFolder(), "ChatGPT To Codex.lnk"));

        try
        {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Run",
                true))
            {
                if (key != null)
                {
                    key.DeleteValue("JK", false);
                    key.DeleteValue("ChatGPT To Codex", false);
                }
            }
        }
        catch
        {
            // Best-effort legacy cleanup; install should still continue.
        }
    }

    private static void DeleteFileIfExists(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // Best-effort legacy cleanup; install should still continue.
        }
    }

    private static void EnsureChildPath(string child, string parent)
    {
        var fullChild = Path.GetFullPath(child).TrimEnd('\\');
        var fullParent = Path.GetFullPath(parent).TrimEnd('\\');
        if (!string.Equals(fullChild, fullParent, StringComparison.OrdinalIgnoreCase) &&
            !fullChild.StartsWith(fullParent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Refusing to install outside LocalAppData.");
        }
    }

    private static void RunHidden(string fileName, string arguments, bool ignoreFailure)
    {
        var process = Process.Start(new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            CreateNoWindow = true,
            UseShellExecute = false
        });
        if (process == null) return;
        process.WaitForExit();
        if (!ignoreFailure && process.ExitCode != 0)
        {
            throw new InvalidOperationException(fileName + " failed with exit code " + process.ExitCode + ".");
        }
    }

    private static string GetProgramsFolder()
    {
        var folder = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        if (!string.IsNullOrEmpty(folder)) return folder;
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        if (!string.IsNullOrEmpty(appData)) return Path.Combine(appData, "Microsoft", "Windows", "Start Menu", "Programs");
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "AppData",
            "Roaming",
            "Microsoft",
            "Windows",
            "Start Menu",
            "Programs");
    }

    private static string GetDesktopFolder()
    {
        var folder = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (!string.IsNullOrEmpty(folder)) return folder;
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Desktop");
    }

    private static bool PathUnder(string value, string parent)
    {
        if (string.IsNullOrEmpty(value)) return false;
        try
        {
            var fullValue = Path.GetFullPath(value.Trim('"')).TrimEnd('\\');
            var fullParent = Path.GetFullPath(parent).TrimEnd('\\');
            return string.Equals(fullValue, fullParent, StringComparison.OrdinalIgnoreCase) ||
                fullValue.StartsWith(fullParent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static void StopInstalledProcessTrees(string installDir)
    {
        try
        {
            using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process"))
            using (var processes = searcher.Get())
            {
                foreach (ManagementObject process in processes)
                {
                    var pidObj = process["ProcessId"];
                    if (pidObj == null) continue;
                    var pid = Convert.ToInt32(pidObj);
                    if (pid == Process.GetCurrentProcess().Id) continue;

                    var exe = process["ExecutablePath"] as string;
                    var commandLine = process["CommandLine"] as string;
                    if (PathUnder(exe, installDir) ||
                        (!string.IsNullOrEmpty(commandLine) &&
                         commandLine.IndexOf(installDir, StringComparison.OrdinalIgnoreCase) >= 0))
                    {
                        RunHidden("taskkill.exe", "/pid " + pid + " /t /f", true);
                    }
                }
            }
        }
        catch
        {
            // Best-effort cleanup. Directory deletion reports any remaining lock.
        }
    }

    private static void DeleteDirectoryWithRetries(string dir)
    {
        Exception last = null;
        for (var i = 0; i < 20; i++)
        {
            try
            {
                Directory.Delete(dir, true);
                return;
            }
            catch (Exception ex)
            {
                last = ex;
                Thread.Sleep(250);
            }
        }
        throw new IOException("Could not replace the existing install directory: " + (last == null ? "unknown error" : last.Message), last);
    }

    private void ExpandZip(string zipPath, string destDir)
    {
        using (var archive = ZipFile.OpenRead(zipPath))
        {
            var total = archive.Entries.Count;
            var done = 0;
            foreach (var entry in archive.Entries)
            {
                var relativePath = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                if (relativePath.Trim().Length == 0) continue;

                var destinationPath = Path.GetFullPath(Path.Combine(destDir, relativePath));
                EnsureChildPath(destinationPath, destDir);

                if (entry.Name.Length == 0)
                {
                    Directory.CreateDirectory(destinationPath);
                }
                else
                {
                    var parent = Path.GetDirectoryName(destinationPath);
                    if (parent != null) Directory.CreateDirectory(parent);
                    entry.ExtractToFile(destinationPath, true);
                }

                done++;
                if (done == total || done % 10 == 0)
                {
                    SetDetail("Extracting application files... " + done + " / " + total);
                    SetProgress(20 + (int)((long)done * 70 / Math.Max(1, total)));
                }
            }
        }
    }

    private static void ExtractPayload(string zipPath)
    {
        var exePath = Application.ExecutablePath;
        var markerBytes = Encoding.ASCII.GetBytes(Marker);
        using (var input = File.OpenRead(exePath))
        using (var reader = new BinaryReader(input))
        {
            var footerLength = markerBytes.Length + sizeof(long);
            if (input.Length < footerLength) throw new InvalidOperationException("Installer payload is missing.");
            input.Seek(-footerLength, SeekOrigin.End);
            var foundMarker = reader.ReadBytes(markerBytes.Length);
            for (var i = 0; i < markerBytes.Length; i++)
            {
                if (foundMarker[i] != markerBytes[i]) throw new InvalidOperationException("Installer payload marker is invalid.");
            }

            var payloadLength = reader.ReadInt64();
            if (payloadLength <= 0 || payloadLength > input.Length - footerLength)
            {
                throw new InvalidOperationException("Installer payload length is invalid.");
            }

            var payloadStart = input.Length - footerLength - payloadLength;
            input.Seek(payloadStart, SeekOrigin.Begin);
            using (var output = File.Create(zipPath))
            {
                var buffer = new byte[1024 * 1024];
                long remaining = payloadLength;
                while (remaining > 0)
                {
                    var read = input.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                    if (read <= 0) throw new EndOfStreamException();
                    output.Write(buffer, 0, read);
                    remaining -= read;
                }
            }
        }
    }

    private static void SetWindowIcon(Form form)
    {
        try
        {
            var icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (icon != null) form.Icon = icon;
        }
        catch
        {
            // The executable icon resource is optional at runtime.
        }
    }

    private static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory, string iconPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath));
        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) return;
        dynamic shell = Activator.CreateInstance(shellType);
        dynamic shortcut = shell.CreateShortcut(shortcutPath);
        shortcut.TargetPath = targetPath;
        shortcut.WorkingDirectory = workingDirectory;
        shortcut.Description = "Start JK";
        shortcut.IconLocation = iconPath + ",0";
        shortcut.Save();
    }
}
