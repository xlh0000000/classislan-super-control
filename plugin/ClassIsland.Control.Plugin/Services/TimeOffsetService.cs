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
}

/// <summary>
/// 云端分组调控的时间偏移执行者。
///
/// 策略文档的 <c>time</c> 节有两种形态：
/// <list type="bullet">
/// <item><c>offsetSeconds</c>：固定偏移秒数，直接写入宿主 <c>Settings.TimeOffsetSeconds</c>；</item>
/// <item><c>auto</c>：设备在每次成功轮询后用集控端时间对自己的时钟做闭环校正。</item>
/// </list>
/// 该节被撤下时恢复接管前的本机偏移，避免“策略撤销后时间仍被改过”。
///
/// 自动校准以宿主自己的时钟为准做闭环：读取宿主显示的本地时间，与服务端时间求差，
/// 再把差值累加到当前偏移上。这样无论宿主的基准是系统时间还是 NTP，都收敛到同一目标，
/// 且不依赖任何未公开的宿主内部状态。
/// </summary>
public sealed class TimeOffsetService(
    HostSettingsBridge bridge,
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
        ApplyValues(auto, offset);
    }

    /// <summary>一次性命令入口：<c>time.offset.persist.v1</c> 与策略共用同一套语义。</summary>
    public void ApplyValues(bool auto, double? offsetSeconds)
    {
        if (!Available)
        {
            status.TimeOffsetApplied("宿主未提供时间偏移设置");
            return;
        }
        if (auto)
        {
            CaptureBaseline();
            lock (_gate) _mode = TimeOffsetMode.Auto;
            status.TimeOffsetApplied("自动对齐集控端时钟");
            return;
        }
        if (offsetSeconds is { } seconds)
        {
            CaptureBaseline();
            var value = Clamp(Math.Round(seconds, 3));
            lock (_gate)
            {
                _mode = TimeOffsetMode.Fixed;
            }
            bridge.WriteTimeOffsetSeconds(value, "ClassIsland Control 策略下发时间偏移");
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
        if (!bridge.WriteTimeOffsetSeconds(target, "ClassIsland Control 自动时间偏移")) return;
        status.TimeOffsetApplied($"自动对齐集控端时钟（{Format(target)}）");
        logger.LogInformation("Applied automatic time offset {OffsetSeconds}s from the control plane clock.", target);
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
        if (baseline is { } value)
            bridge.WriteTimeOffsetSeconds(value, "ClassIsland Control 恢复本机时间偏移");
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