using System.Globalization;
using System.Text.Json;
using Avalonia.Threading;
using ClassIsland.Core;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>
/// 客户端崩溃上报：捕获本机未处理异常写入本地 outbox，随轮询上报到集控端。
///
/// 不变量：报告只在服务端确认接收（该轮轮询成功返回）后才从 outbox 移除，
/// 因此断网或服务端故障期间的崩溃不会丢失，重传也不会产生重复记录。
/// 所有入口都不允许向外抛异常：统计崩溃的功能本身不能再制造崩溃。
/// </summary>
public sealed class CrashReporter
{
    /// <summary>本地 outbox 上限：超出后丢弃最旧的报告，避免长期离线撑爆磁盘。</summary>
    private const int OutboxLimit = 100;
    /// <summary>单轮上报条数上限，与服务端 poll schema 的 .max(20) 对齐。</summary>
    private const int BatchLimit = 20;
    private const int MaxStackTrace = 8000;
    private const string PluginVersion = "0.1.6";

    private static readonly JsonSerializerOptions JsonOptions =
        new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly object _gate = new();
    private readonly string _outboxPath;
    private readonly string _appVersion;
    private readonly string _platform;
    private List<RemoteCrashReport> _outbox;
    private int _confirmed;
    private int _installed;

    public CrashReporter(PluginPaths paths)
    {
        _outboxPath = Path.Combine(paths.Root, "crash-outbox.json");
        _appVersion = Trim(SafeProbe(() => AppBase.AppVersion), 32);
        _platform = Trim(SafeProbe(() => $"{AppBase.Current.OperatingSystem}/{AppBase.Current.Platform}"), 80);
        _outbox = Load();
    }

    /// <summary>有新报告落盘时触发：轮询循环据此立刻上报，不等下一个定时。</summary>
    public event Action? Reported;

    /// <summary>本机尚未被服务端确认的崩溃条数。</summary>
    public int PendingCount { get { lock (_gate) return _outbox.Count; } }

    /// <summary>本次运行中已被服务端确认接收的崩溃条数。</summary>
    public int ConfirmedCount { get { lock (_gate) return _confirmed; } }

    /// <summary>绑定进程级异常钩子；重复调用是空操作。</summary>
    public void Install()
    {
        if (Interlocked.Exchange(ref _installed, 1) == 1) return;
        AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;
        // host-exit：只在异常退出码时上报，正常关机不产生噪音。
        AppDomain.CurrentDomain.ProcessExit += OnProcessExit;
        TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;
        try { Dispatcher.UIThread.UnhandledException += OnUiThreadException; }
        catch (Exception error) { Trace(error); }
    }

    /// <summary>本轮要上报的报告：最旧的优先，最多 BatchLimit 条。</summary>
    public IReadOnlyList<RemoteCrashReport> Pending()
    {
        lock (_gate) return _outbox.Take(BatchLimit).ToArray();
    }

    /// <summary>服务端已接收：把这批报告从 outbox 移除并落盘。</summary>
    public void Confirm(IEnumerable<string> ids)
    {
        var settled = new HashSet<string>(ids, StringComparer.Ordinal);
        if (settled.Count == 0) return;
        try
        {
            lock (_gate)
            {
                var removed = _outbox.RemoveAll(report => settled.Contains(report.Id));
                if (removed == 0) return;
                _confirmed += removed;
                PersistLocked();
            }
        }
        catch (Exception error) { Trace(error); }
    }

    /// <summary>设置页展示用的上报概览。</summary>
    public string Summary()
    {
        lock (_gate)
        {
            if (_outbox.Count > 0) return $"待上报 {_outbox.Count} 条 · 已上报 {_confirmed} 条";
            return _confirmed > 0 ? $"已上报 {_confirmed} 条" : "本机无崩溃记录";
        }
    }

    /// <summary>记录一条崩溃报告；任何失败都被吞掉，绝不影响宿主。</summary>
    public void Record(string kind, Exception? exception, string note = "")
    {
        try
        {
            var type = exception?.GetType().FullName ?? "";
            var report = new RemoteCrashReport(
                Guid.NewGuid().ToString("N"),
                DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
                kind,
                Trim(type, 200) is { Length: > 0 } trimmed ? trimmed : "UnknownException",
                Trim(exception?.Message ?? note, 1000),
                Trim(exception?.ToString() ?? note, MaxStackTrace),
                Trim(Thread.CurrentThread.Name ?? "", 60),
                _appVersion,
                PluginVersion,
                _platform);
            lock (_gate)
            {
                _outbox.Add(report);
                if (_outbox.Count > OutboxLimit) _outbox.RemoveRange(0, _outbox.Count - OutboxLimit);
                PersistLocked();
            }
            // 报告已落盘：立刻唤醒轮询，避免崩溃信息要等满一个轮询周期。
            Reported?.Invoke();
        }
        catch (Exception error) { Trace(error); }
    }

    private void OnUnhandledException(object sender, UnhandledExceptionEventArgs e) =>
        Record("unhandled-exception", e.ExceptionObject as Exception,
            e.IsTerminating ? "进程即将终止" : "未处理异常");

    private void OnUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e) =>
        Record("unobserved-task", e.Exception);

    private void OnUiThreadException(object? sender, DispatcherUnhandledExceptionEventArgs e) =>
        Record("ui-thread", e.Exception);

    private void OnProcessExit(object? sender, EventArgs e)
    {
        var code = Environment.ExitCode;
        if (code == 0) return;
        Record("host-exit", null, $"宿主以退出码 {code} 结束");
    }

    private List<RemoteCrashReport> Load()
    {
        try
        {
            if (!File.Exists(_outboxPath)) return [];
            var reports = JsonSerializer.Deserialize<List<RemoteCrashReport>>(
                File.ReadAllText(_outboxPath), JsonOptions);
            return reports?.Where(report => !string.IsNullOrWhiteSpace(report.Id)).TakeLast(OutboxLimit).ToList() ?? [];
        }
        catch (Exception error)
        {
            Trace(error);
            return [];
        }
    }

    /// <summary>调用方必须持有 _gate。写盘失败只丢弃异常：内存中的报告仍会随下次轮询上报。</summary>
    private void PersistLocked()
    {
        try
        {
            var directory = Path.GetDirectoryName(_outboxPath);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            var temporary = _outboxPath + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(_outbox, JsonOptions));
            File.Move(temporary, _outboxPath, true);
        }
        catch (Exception error) { Trace(error); }
    }

    private static string Trim(string? value, int max) =>
        string.IsNullOrEmpty(value) ? "" : value.Length <= max ? value : value[..max];

    private static string SafeProbe(Func<string?> probe)
    {
        try { return probe() ?? ""; }
        catch { return ""; }
    }

    private static void Trace(Exception error) =>
        Console.Error.WriteLine($"[crash-reporter] {error.Message}");
}