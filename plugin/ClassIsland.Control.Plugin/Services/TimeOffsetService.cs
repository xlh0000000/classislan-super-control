using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>时间偏移的调控方式。</summary>
public enum TimeOffsetMode
{
    /// <summary>不受集控约束，跟随本机设置。</summary>
    Off,
    /// <summary>使用策略给定的固定偏移秒数。</summary>
    Fixed,
    /// <summary>以集控端时钟为准持续自动校准。</summary>
    Auto,
    /// <summary>每日自动偏移：基准偏移 + 每日步长 × 距锚点的整天数（对齐宿主“自动时间偏移”语义）。</summary>
    Daily,
}

/// <summary>
/// 云端分组调控的时间偏移执行者。
///
/// 策略文档的 <c>time</c> 节有三种形态：
/// <list type="bullet">
/// <item><c>offsetSeconds</c>：固定偏移秒数，直接写入宿主 <c>Settings.TimeOffsetSeconds</c>；</item>
/// <item><c>auto</c>：设备在每次成功轮询后用集控端时间对自己的时钟做闭环校正。</item>
/// <item><c>daily</c>：每日自动偏移——生效偏移 = 基准 + secondsPerDay ×（今天 − anchorDate 的整天数），
/// 每天零点随轮询自动跨档。基准取策略的 offsetSeconds，缺省用接管前的本机偏移；
/// anchorDate 缺省取首次生效日（持久化在 state.json，重启不改锚点）。
/// 宿主自身的启动式累加（IsTimeAutoAdjustEnabled）会在接管期间被关闭，撤下后还原。</item>
/// </list>
/// 该节被撤下时恢复接管前的本机偏移，避免“策略撤销后时间仍被改过”。
///
/// 自动校准以宿主自己的时钟为准做闭环：读取宿主显示的本地时间，与服务端时间求差，
/// 再把差值累加到当前偏移上。这样无论宿主的基准是系统时间还是 NTP，都收敛到同一目标，
/// 且不依赖任何未公开的宿主内部状态。
/// </summary>
public sealed class TimeOffsetService(
    HostSettingsBridge bridge,
    PluginSettingsStore store,
    AgentStatus status,
    ILogger<TimeOffsetService> logger)
{
    /// <summary>自动校准的死区：偏差小于该值不动宿主设置，避免每次轮询都触发宿主落盘。</summary>
    public const double AutoDeadbandSeconds = 1.0;

    /// <summary>允许的最大偏移量，与服务端校验保持一致（±24 小时）。</summary>
    public const double MaxOffsetSeconds = 86400;

    private readonly object _gate = new();
    private TimeOffsetMode _mode = TimeOffsetMode.Off;
    private bool _baselineCaptured;
    private double _baselineSeconds;
    private bool _dailyActive;
    private double _dailyBaseSeconds;
    private double _dailySecondsPerDay;
    private DateTime _dailyAnchorDate;
    // 接管期间关掉的宿主自动偏移开关；null 表示没动过，撤下时不用还原。
    private bool? _hostAutoAdjustBaseline;

    public bool Available => bridge.Available;

    public TimeOffsetMode Mode { get { lock (_gate) return _mode; } }

    /// <summary>应用策略中的 <c>time</c> 节；null 表示该节被撤下。</summary>
    public void Apply(JsonElement? section)
    {
        if (!Available) return;
        if (section is not { ValueKind: JsonValueKind.Object } element)
        {
            Restore();
            return;
        }
        var auto = element.TryGetProperty("auto", out var autoValue) && autoValue.ValueKind == JsonValueKind.True;
        double? offset = element.TryGetProperty("offsetSeconds", out var offsetValue)
                          && offsetValue.ValueKind == JsonValueKind.Number
                          && offsetValue.TryGetDouble(out var parsed)
            ? parsed
            : null;
        bool dailyEnabled = false;
        double? secondsPerDay = null;
        string? anchorDate = null;
        if (element.TryGetProperty("daily", out var daily) && daily.ValueKind == JsonValueKind.Object)
        {
            dailyEnabled = daily.TryGetProperty("enabled", out var enabledValue) && enabledValue.ValueKind == JsonValueKind.True;
            if (daily.TryGetProperty("secondsPerDay", out var perDay) && perDay.ValueKind == JsonValueKind.Number &&
                perDay.TryGetDouble(out var perDaySeconds))
                secondsPerDay = perDaySeconds;
            anchorDate = daily.TryGetProperty("anchorDate", out var anchor) && anchor.ValueKind == JsonValueKind.String
                ? anchor.GetString()
                : null;
        }
        ApplyValues(auto, offset, dailyEnabled, secondsPerDay, anchorDate);
    }

    /// <summary>
    /// 一次性命令入口：<c>time.offset.persist.v1</c> 与策略共用同一套语义。
    /// daily 参数缺省表示“本次不下发每日偏移”，若此前生效则由后续策略恢复；auto 优先于 daily。
    /// </summary>
    public void ApplyValues(bool auto, double? offsetSeconds,
        bool dailyEnabled = false, double? secondsPerDay = null, string? anchorDate = null)
    {
        if (!Available)
        {
            status.TimeOffsetApplied("宿主未提供时间偏移设置");
            return;
        }
        if (auto)
        {
            CaptureBaseline();
            DeactivateDaily();
            lock (_gate) _mode = TimeOffsetMode.Auto;
            status.TimeOffsetApplied("自动对齐集控端时钟");
            return;
        }
        if (dailyEnabled && secondsPerDay is { } perDay)
        {
            CaptureBaseline();
            ActivateDaily(perDay, offsetSeconds, anchorDate);
            return;
        }
        if (offsetSeconds is { } seconds)
        {
            CaptureBaseline();
            DeactivateDaily();
            var value = Clamp(Math.Round(seconds, 3));
            lock (_gate) _mode = TimeOffsetMode.Fixed;
            bridge.WriteTimeOffsetSeconds(value, "Classisland Super Control 策略下发时间偏移");
            status.TimeOffsetApplied($"固定偏移 {Format(value)}");
            return;
        }
        Restore();
    }

    /// <summary>
    /// 每次成功轮询后调用：自动模式下用集控端时间闭环校正宿主时钟。
    /// 调用方传入“收到响应时刻的宿主本地时间”与该次轮询的往返耗时，取其中点抵消一半延迟。
    /// </summary>
    public void ObserveServerTime(DateTime serverTimeUtc, DateTime receivedHostLocal, TimeSpan roundTrip)
    {
        if (!Available) return;
        lock (_gate)
        {
            if (_mode != TimeOffsetMode.Auto) return;
        }
        var midpoint = receivedHostLocal - roundTrip / 2;
        var error = (serverTimeUtc.ToLocalTime() - midpoint).TotalSeconds;
        var current = bridge.ReadTimeOffsetSeconds();
        if (current is not { } applied) return;
        var target = Clamp(Math.Round(applied + error, 3));
        if (Math.Abs(target - applied) < AutoDeadbandSeconds) return;
        if (!bridge.WriteTimeOffsetSeconds(target, "Classisland Super Control 自动时间偏移")) return;
        status.TimeOffsetApplied($"自动对齐集控端时钟（{Format(target)}）");
        logger.LogInformation("Applied automatic time offset {OffsetSeconds}s from the control plane clock.", target);
    }

    /// <summary>每次轮询时调用：每日偏移按“今天”重算，跨过零点即自动加一档；非每日模式是空操作。</summary>
    public void TickDaily()
    {
        if (!Available) return;
        lock (_gate)
        {
            if (!_dailyActive) return;
        }
        WriteDailyValue(announce: false);
    }

    private void ActivateDaily(double secondsPerDay, double? baseOffset, string? anchorDate)
    {
        var anchor = ParseAnchor(anchorDate);
        lock (_gate)
        {
            _mode = TimeOffsetMode.Daily;
            _dailyActive = true;
            _dailySecondsPerDay = secondsPerDay;
            _dailyBaseSeconds = Clamp(Math.Round(baseOffset ?? (_baselineCaptured ? _baselineSeconds : 0), 3));
            _dailyAnchorDate = anchor;
        }
        // 宿主的启动式累加与每日接管会双重叠加：接管期间关掉它，撤下时还原。
        if (bridge.SupportsAutoAdjust && bridge.ReadTimeAutoAdjustEnabled() == true)
        {
            _hostAutoAdjustBaseline = true;
            bridge.WriteTimeAutoAdjustEnabled(false, "Classisland Super Control 接管每日自动偏移");
        }
        WriteDailyValue(announce: true);
    }

    private void DeactivateDaily()
    {
        bool wasActive;
        lock (_gate)
        {
            wasActive = _dailyActive;
            _dailyActive = false;
        }
        if (wasActive && _hostAutoAdjustBaseline == true)
        {
            _hostAutoAdjustBaseline = null;
            bridge.WriteTimeAutoAdjustEnabled(true, "Classisland Super Control 交还每日自动偏移开关");
        }
    }

    private void WriteDailyValue(bool announce)
    {
        double baseSeconds;
        double perDay;
        DateTime anchor;
        lock (_gate)
        {
            baseSeconds = _dailyBaseSeconds;
            perDay = _dailySecondsPerDay;
            anchor = _dailyAnchorDate;
        }
        var days = Math.Max(0, (int)Math.Floor((DateTime.Today - anchor.Date).TotalDays));
        var value = Clamp(Math.Round(baseSeconds + perDay * days, 3));
        var written = bridge.WriteTimeOffsetSeconds(value, "Classisland Super Control 每日自动时间偏移");
        if (!written && !announce) return;
        status.TimeOffsetApplied($"每日自动偏移 {Format(perDay)}/天（已计 {days} 天，当前 {Format(value)}）");
        if (written)
            logger.LogInformation("Applied daily time offset {OffsetSeconds}s ({PerDay}s/day, {Days} days).", value, perDay, days);
    }

    /// <summary>解析/初始化锚点日期：策略给定 &gt; 本机持久化 &gt; 今天（并持久化，重启不改锚点）。</summary>
    private DateTime ParseAnchor(string? anchorDate)
    {
        if (TryParse(anchorDate, out var given)) return given;
        var persisted = store.State.TimeDailyAnchorDate;
        if (TryParse(persisted, out var saved)) return saved;
        var today = DateTime.Today;
        _ = PersistAnchor(today.ToString("yyyy-MM-dd"));
        return today;
    }

    private async Task PersistAnchor(string date)
    {
        try { await store.SaveStateAsync(store.State with { TimeDailyAnchorDate = date }); }
        catch (Exception exception) { logger.LogWarning(exception, "Failed to persist the daily time offset anchor."); }
    }

    private static bool TryParse(string? value, out DateTime date)
    {
        date = default;
        return !string.IsNullOrWhiteSpace(value) &&
               DateTime.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date);
    }

    /// <summary>撤下 time 节：恢复接管前的本机偏移，且只回退我们真正改过的部分。</summary>
    private void Restore()
    {
        double? baseline;
        lock (_gate)
        {
            if (_mode == TimeOffsetMode.Off) return;
            _mode = TimeOffsetMode.Off;
            baseline = _baselineCaptured ? _baselineSeconds : null;
        }
        DeactivateDaily();
        if (baseline is { } value)
            bridge.WriteTimeOffsetSeconds(value, "Classisland Super Control 恢复本机时间偏移");
        status.TimeOffsetApplied("跟随本机设置");
    }

    private void CaptureBaseline()
    {
        lock (_gate)
        {
            if (_baselineCaptured) return;
        }
        if (bridge.ReadTimeOffsetSeconds() is not { } current) return;
        lock (_gate)
        {
            if (_baselineCaptured) return;
            _baselineSeconds = current;
            _baselineCaptured = true;
        }
    }

    private static double Clamp(double seconds) => Math.Clamp(seconds, -MaxOffsetSeconds, MaxOffsetSeconds);

    private static string Format(double seconds)
    {
        var sign = seconds >= 0 ? "+" : "-";
        return $"{sign}{Math.Abs(seconds).ToString("0.###", CultureInfo.InvariantCulture)}s";
    }
}
