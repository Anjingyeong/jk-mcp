using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

// Exact process-exit subscription is established before every start. No sleeps/polling.
public sealed class SetupTestProcess : IDisposable
{
    private readonly ManualResetEvent exited = new ManualResetEvent(false);
    public readonly Process Process = new Process();
    private readonly Task<string> stdout;
    private readonly Task<string> stderr;
    public string Output { get; private set; }
    public SetupTestProcess(string file, string arguments)
    {
        Process.StartInfo = new ProcessStartInfo(file, arguments) {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        Process.EnableRaisingEvents = true;
        Process.Exited += delegate { exited.Set(); };
        if (!Process.Start()) throw new InvalidOperationException("Process did not start.");
        stdout = Process.StandardOutput.ReadToEndAsync();
        stderr = Process.StandardError.ReadToEndAsync();
    }
    public int WaitForExit(int milliseconds)
    {
        if (!exited.WaitOne(milliseconds)) throw new TimeoutException("Owned process did not exit: " + Process.StartInfo.FileName);
        Process.WaitForExit();
        Output = stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult();
        return Process.ExitCode;
    }
    public void Dispose()
    {
        if (!Process.HasExited) { Process.Kill(); WaitForExit(10000); }
        Process.Dispose();
        exited.Dispose();
    }
}
