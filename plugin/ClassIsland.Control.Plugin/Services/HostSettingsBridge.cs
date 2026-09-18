using System.Reflection;
using ClassIsland.Shared;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>
/// 宿主 <c>SettingsService</c> 的反射桥。
///
/// 时间偏移的唯一真相是宿主的 <c>Settings.TimeOffsetSeconds</c>，而它属于应用程序集
/// <c>ClassIsland</c>，不在公开插件 SDK（Core/Shared）的导出范围内。宿主的
/// <see cref="IAppHost.Host"/> 暴露了自身服务容器，因此这里按类型名解析一次、缓存属性
/// 访问器，宿主结构变化或服务缺失时优雅降级为“不可用”，而不是让插件加载失败。
/// </summary>
public sealed class HostSettingsBridge
{
    private static readonly string[] CandidateTypeNames =
    [
        "ClassIsland.Services.SettingsService, ClassIsland",
        "ClassIsland.Services.SettingsService",
    ];

    private readonly object _gate = new();
    private bool _resolved;
    private object? _service;
    private PropertyInfo? _settingsProperty;
    private PropertyInfo? _offsetProperty;
    private PropertyInfo? _autoAdjustProperty;
    private MethodInfo? _saveMethod;

    /// <summary>宿主是否提供可读写的时间偏移；false 时相关能力一律不对外声明。</summary>
    public bool Available { get { EnsureResolved(); return _offsetProperty is not null; } }

    /// <summary>宿主是否暴露“自动时间偏移”开关；策略接管每日偏移时需要关掉它避免双重累加。</summary>
    public bool SupportsAutoAdjust { get { EnsureResolved(); return _autoAdjustProperty is not null; } }

    /// <summary>读取宿主自动时间偏移开关；不可用时返回 null。</summary>
    public bool? ReadTimeAutoAdjustEnabled()
    {
        EnsureResolved();
        if (_autoAdjustProperty is null) return null;
        try
        {
            var settings = _settingsProperty?.GetValue(_service);
            return settings is null ? null : (bool)_autoAdjustProperty.GetValue(settings)!;
        }
        catch (Exception) { return null; }
    }

    /// <summary>写入宿主自动时间偏移开关并落盘；值一致时跳过。</summary>
    public bool WriteTimeAutoAdjustEnabled(bool value, string reason)
    {
        EnsureResolved();
        if (_autoAdjustProperty is null) return false;
        try
        {
            var settings = _settingsProperty?.GetValue(_service);
            if (settings is null) return false;
            if ((bool)_autoAdjustProperty.GetValue(settings)! == value) return false;
            _autoAdjustProperty.SetValue(settings, value);
            _saveMethod?.Invoke(_service, [reason]);
            return true;
        }
        catch (Exception) { return false; }
    }

    /// <summary>读取宿主当前的时间偏移（秒）；不可用时返回 null。</summary>
    public double? ReadTimeOffsetSeconds()
    {
        EnsureResolved();
        if (_offsetProperty is null) return null;
        try
        {
            var settings = _settingsProperty?.GetValue(_service);
            return settings is null ? null : (double)_offsetProperty.GetValue(settings)!;
        }
        catch (Exception) { return null; }
    }

    /// <summary>
    /// 写入宿主时间偏移并落盘。值与当前一致时不写入，避免每次轮询都触发宿主保存。
    /// </summary>
    public bool WriteTimeOffsetSeconds(double seconds, string reason)
    {
        EnsureResolved();
        if (_offsetProperty is null) return false;
        try
        {
            var settings = _settingsProperty?.GetValue(_service);
            if (settings is null) return false;
            var current = (double)_offsetProperty.GetValue(settings)!;
            if (Math.Abs(current - seconds) < 0.0005) return false;
            _offsetProperty.SetValue(settings, seconds);
            _saveMethod?.Invoke(_service, [reason]);
            return true;
        }
        catch (Exception) { return false; }
    }

    private void EnsureResolved()
    {
        if (_resolved) return;
        lock (_gate)
        {
            if (_resolved) return;
            _resolved = true;
            try
            {
                var provider = IAppHost.Host?.Services;
                if (provider is null) return;
                var type = ResolveServiceType();
                if (type is null) return;
                _service = provider.GetService(type);
                if (_service is null) return;
                _settingsProperty = type.GetProperty("Settings");
                var settings = _settingsProperty?.GetValue(_service);
                if (settings is null) return;
                var offset = settings.GetType().GetProperty("TimeOffsetSeconds");
                if (offset is null || offset.PropertyType != typeof(double) || !offset.CanWrite) return;
                _offsetProperty = offset;
                var autoAdjust = settings.GetType().GetProperty("IsTimeAutoAdjustEnabled");
                if (autoAdjust is not null && autoAdjust.PropertyType == typeof(bool) && autoAdjust.CanWrite)
                    _autoAdjustProperty = autoAdjust;
                _saveMethod = type.GetMethod("SaveSettings", [typeof(string)]) ?? type.GetMethod("SaveSettings", Type.EmptyTypes);
            }
            catch (Exception)
            {
                _service = null;
                _settingsProperty = null;
                _offsetProperty = null;
                _autoAdjustProperty = null;
                _saveMethod = null;
            }
        }
    }

    private static Type? ResolveServiceType()
    {
        foreach (var name in CandidateTypeNames)
        {
            var type = Type.GetType(name, throwOnError: false);
            if (type is not null) return type;
        }
        // 单文件发布或程序集被重命名时按简单名兜底。
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            var type = assembly.GetType("ClassIsland.Services.SettingsService", throwOnError: false);
            if (type is not null) return type;
        }
        return null;
    }
}