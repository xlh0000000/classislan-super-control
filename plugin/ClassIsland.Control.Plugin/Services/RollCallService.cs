using System.Security.Cryptography;
using Avalonia.Threading;
using ClassIsland.Control.Plugin.Views;
using ClassIsland.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>
/// 点名悬浮窗的编排：窗口生命周期、抽人/多人抽人、结果展示与 ClassIsland 提醒。
/// 名单优先用集控端下发的（<see cref="RollCallStore"/>），还没收到时回落到
/// 设置页维护的本机名字表，所以没连集控也能点名。
/// </summary>
public sealed class RollCallService : BackgroundService
{
    private readonly PluginSettingsStore _store;
    private readonly RollCallStore _roster;
    private readonly IServiceProvider _services;
    private readonly ILogger<RollCallService> _logger;
    private readonly TaskCompletionSource _appStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private AppBase? _app;
    private RollCallWindow? _window;
    private RollCallResultWindow? _result;

    public RollCallService(
        PluginSettingsStore store,
        RollCallStore roster,
        IServiceProvider services,
        ILogger<RollCallService> logger)
    {
        _store = store;
        _roster = roster;
        _services = services;
        _logger = logger;
    }

    public RollCallStore Roster => _roster;

    /// <summary>
    /// 生效的名单：集控端指派过就用指派的（下发空名单也算数），
    /// 否则回落到设置页维护的本机名字表，没连集控也能点名。
    /// </summary>
    public IReadOnlyList<string> EffectiveNames =>
        _roster.HasServerRoster ? _roster.Names : _store.Settings.RollCallLocalNames;

    /// <summary>当前生效的是本机名字表（集控端没给这台设备指派名单）。</summary>
    public bool UsingLocalNames => !_roster.HasServerRoster;

    /// <summary>
    /// 生效的悬浮窗开关：集控端表过态就以它为准（关掉即整个窗口不见），
    /// 没表态时回到设置页的本机开关。
    /// </summary>
    public bool EffectiveEnabled => _roster.Settings.Enabled ?? _store.Settings.RollCallEnabled;

    /// <summary>生效的抽中提醒开关，取值顺序同上。</summary>
    public bool EffectiveNotify => _roster.Settings.Notify ?? _store.Settings.RollCallNotify;

    /// <summary>生效的单人结果秒数。</summary>
    public int EffectiveSingleSeconds =>
        Math.Clamp(_roster.Settings.SingleSeconds ?? _store.Settings.RollCallSingleSeconds, 1, 120);

    /// <summary>生效的多人结果基准秒数（2 人停留时长，每多一人再加 1 秒）。</summary>
    public int EffectiveMultiSeconds =>
        Math.Clamp(_roster.Settings.MultiSeconds ?? _store.Settings.RollCallMultiSeconds, 2, 300);

    /// <summary>悬浮窗当前是否可见。设置页据此渲染开关，避免和真实状态不一致。</summary>
    public bool IsVisible => _window is { IsVisible: true };

    /// <summary>悬浮窗显示/隐藏状态发生变化。</summary>
    public event Action? StateChanged;

    public override Task StartAsync(CancellationToken cancellationToken)
    {
        _app = AppBase.Current;
        _app.AppStarted += OnAppStarted;
        if (_app.MainWindow is not null) _appStarted.TrySetResult();
        return base.StartAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await _appStarted.Task.WaitAsync(stoppingToken);
        ApplyVisibility();
        // 集控端把开关关掉时要立刻收窗，不能等到下次启动。
        _roster.Changed += ApplyVisibility;
        // 悬浮窗常驻运行，等到宿主停止即可；这里只负责维持事件订阅。
        try { await Task.Delay(Timeout.Infinite, stoppingToken); }
        catch (OperationCanceledException) { }
        finally { _roster.Changed -= ApplyVisibility; }
    }

    /// <summary>按生效开关显示或隐藏悬浮窗：集控端表过态时本机说了不算。</summary>
    public void ApplyVisibility()
    {
        if (EffectiveEnabled) Show();
        else Hide();
    }

    public override Task StopAsync(CancellationToken cancellationToken)
    {
        if (_app is not null) _app.AppStarted -= OnAppStarted;
        Dispatcher.UIThread.Post(() =>
        {
            _result?.DismissImmediately();
            _window?.Close();
            _window = null;
        });
        return base.StopAsync(cancellationToken);
    }

    /// <summary>显示悬浮窗（设置页与启动时调用）。</summary>
    public void Show() => Dispatcher.UIThread.Post(ShowCore);

    /// <summary>隐藏悬浮窗；窗口实例保留，可再次显示。</summary>
    public void Hide() => Dispatcher.UIThread.Post(HideCore);

    /// <summary>设置页改动尺寸/不透明度后立即生效。</summary>
    public void ReapplySettings() =>
        Dispatcher.UIThread.Post(() => _window?.ApplySettings(_store.Settings));

    /// <summary>把悬浮窗挪回工作区右下角的默认位置。</summary>
    public void ResetPosition() => Dispatcher.UIThread.Post(() => _window?.PlaceAt(null, null));

    private void ShowCore()
    {
        if (_window is not null)
        {
            if (!_window.IsVisible) _window.Show();
            _window.Activate();
            return;
        }
        var window = new RollCallWindow();
        window.SingleRequested += () => Draw(1);
        window.MultiRequested += Draw;
        window.DragCompleted += OnWindowMoved;
        window.Dismissed += () => StateChanged?.Invoke();
        window.Closed += (_, _) =>
        {
            // 只有系统关机/应用退出才会走到这里（关闭手势已在窗口里折算成隐藏）。
            _window = null;
            StateChanged?.Invoke();
        };
        window.ApplySettings(_store.Settings);
        window.PlaceAt(_store.Settings.RollCallX, _store.Settings.RollCallY);
        _window = window;
        window.Show();
        StateChanged?.Invoke();
    }

    private void HideCore()
    {
        if (_window is null) return;
        _window.Hide();
        StateChanged?.Invoke();
    }

    /// <summary>抽人；人数为 1 时是“抽人”，2–6 时是“多人”。</summary>
    private void Draw(int count) => Dispatcher.UIThread.Post(() => DrawCore(count));

    private void DrawCore(int count)
    {
        // 上次抽人的结果还在展示（含淡出）：禁止继续抽人，按钮同时被禁用，
        // 避免连点把名字一闪而过地替换掉。
        if (_result is not null) return;
        var names = EffectiveNames;
        if (names.Count == 0)
        {
            Notify("点名", _roster.HasServerRoster
                ? "集控端下发的名单是空的。"
                : "还没有名单：在点名设置里填本机名单，或等集控端下发。");
            return;
        }
        var take = Math.Clamp(count, 1, names.Count);
        var picked = Pick(names, take);
        // 多人显示更久：以多人基准秒数为起点，每多抽一个人再多显示 1 秒。
        var seconds = take == 1 ? EffectiveSingleSeconds : EffectiveMultiSeconds + (take - 2);

        var window = new RollCallResultWindow();
        window.ShowResult(picked, seconds);
        window.Closed += (_, _) =>
        {
            if (ReferenceEquals(_result, window)) _result = null;
            // 展示结束：恢复悬浮窗上的抽人按钮。
            _window?.SetButtonsEnabled(true);
        };
        _result = window;
        // 展示期间禁用抽人按钮，结束（窗口关闭）后恢复。
        _window?.SetButtonsEnabled(false);
        window.Show();

        // 提醒跟着同一个秒数走：否则提醒还挂在屏幕上，悬浮窗却已经可以再抽了。
        if (EffectiveNotify) Notify("点名", string.Join("、", picked), seconds);
    }

    /// <summary>部分洗牌抽人：同一轮内不会重复抽到同一个人。</summary>
    private static List<string> Pick(IReadOnlyList<string> names, int count)
    {
        var pool = names.ToList();
        for (var index = 0; index < count; index++)
        {
            var swap = RandomNumberGenerator.GetInt32(index, pool.Count);
            (pool[index], pool[swap]) = (pool[swap], pool[index]);
        }
        return pool.Take(count).ToList();
    }

    /// <summary>拉起 ClassIsland 提醒。提醒主机不是线程安全的，因此始终在 UI 线程调用。</summary>
    private void Notify(string title, string content, int? seconds = null)
    {
        try
        {
            // 提醒提供方以 IHostedService 注册；取的是宿主已创建的同一实例，不会重复注册。
            var provider = _services.GetServices<IHostedService>().OfType<RemoteNotificationProvider>().FirstOrDefault();
            if (provider is null)
            {
                _logger.LogWarning("The roll-call notification provider is unavailable.");
                return;
            }
            provider.Send(title, content, seconds is { } value ? TimeSpan.FromSeconds(value) : null);
        }
        catch (Exception exception)
        {
            _logger.LogWarning(exception, "Failed to raise the roll-call notification.");
        }
    }

    private void OnWindowMoved(double x, double y) => _ = SavePositionAsync(x, y);

    private async Task SavePositionAsync(double x, double y)
    {
        try
        {
            await _store.SaveSettingsAsync(_store.Settings with { RollCallX = x, RollCallY = y });
        }
        catch (Exception exception)
        {
            _logger.LogWarning(exception, "Failed to persist the roll-call window position.");
        }
    }

    private void OnAppStarted(object? sender, EventArgs e) => _appStarted.TrySetResult();
}