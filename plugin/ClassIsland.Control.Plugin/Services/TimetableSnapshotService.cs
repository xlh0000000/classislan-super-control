using System.Collections.Specialized;
using System.ComponentModel;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ClassIsland.Core.Abstractions.Services;
using ClassIsland.Shared.ComponentModels;
using ClassIsland.Shared.Models.Profile;
using Microsoft.Extensions.DependencyInjection;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>
/// 采集本机 ClassIsland 档案并生成课表快照与摘要（贡献者：威廉）。
///
/// - 快照与 ClassIsland 官方 Profile 模型同构（camelCase，四字典 + name + selectedClassPlanGroupId）；
/// - 摘要为 RFC 8785（JCS）规范形式后的 SHA-256 十六进制小写，与服务端 digest 校验对齐；
/// - 变更自动重传：档案对象属性变化或四个字典的集合变化都会置“待重传”标记，
///   宿主未提供 IProfileService（2.1.0.1 已注册，缺失时）整体静默降级，不报错不上报。
/// </summary>
public sealed class TimetableSnapshotService : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = ProtocolJson.Options;
    private readonly object _gate = new();
    private readonly IProfileService? _profileService;
    private Profile? _profile;
    private bool _dirty = true;
    private string _digest = "";
    private JsonElement _snapshot;
    private int _subjectsCount;
    private int _timeLayoutsCount;
    private int _classPlansCount;
    private int _classPlanGroupsCount;

    public TimetableSnapshotService(IServiceProvider services)
    {
        _profileService = services.GetService<IProfileService>();
    }

    /// <summary>宿主未提供档案服务时为 false，调用方应完全跳过课表字段。</summary>
    public bool Available => _profileService is not null;

    /// <summary>本地档案自上次上报后有改动，下一次轮询应携带全量快照。</summary>
    public bool IsDirty { get { lock (_gate) return _dirty; } }

    /// <summary>档案对象有改动时触发；轮询循环据此提前醒来上报。</summary>
    public event Action? Changed;

    public int SubjectsCount { get { lock (_gate) { CaptureIfDirtyLocked(); return _subjectsCount; } } }
    public int TimeLayoutsCount { get { lock (_gate) { CaptureIfDirtyLocked(); return _timeLayoutsCount; } } }
    public int ClassPlansCount { get { lock (_gate) { CaptureIfDirtyLocked(); return _classPlansCount; } } }
    public int ClassPlanGroupsCount { get { lock (_gate) { CaptureIfDirtyLocked(); return _classPlanGroupsCount; } } }

    /// <summary>当前快照摘要（JCS + SHA-256）。首次访问或档案改动后触发重新采集。</summary>
    public string Digest { get { lock (_gate) { CaptureIfDirtyLocked(); return _digest; } } }

    /// <summary>当前快照本体；每次调用返回独立副本，避免调用方与内部缓存互相改写。</summary>
    public JsonElement Snapshot { get { lock (_gate) { CaptureIfDirtyLocked(); return _snapshot.Clone(); } } }

    /// <summary>服务端要求重传（timetableRequired）时由轮询循环调用，强制下一次携带全量快照。</summary>
    public void ForceRetransmit()
    {
        lock (_gate) _dirty = true;
        Changed?.Invoke();
    }

    /// <summary>全量快照已被服务端接受（响应不再要求重传）后清除待重传标记。</summary>
    public void MarkUploaded()
    {
        lock (_gate) _dirty = false;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_profile is { } profile)
            {
                profile.PropertyChanged -= OnProfilePropertyChanged;
                DetachDictionary(profile.TimeLayouts);
                DetachDictionary(profile.ClassPlans);
                DetachDictionary(profile.Subjects);
                DetachDictionary(profile.ClassPlanGroups);
                _profile = null;
            }
        }
    }

    private void CaptureIfDirtyLocked()
    {
        if (!_dirty || _profileService is null) return;
        var profile = _profileService.Profile;
        // 档案对象被整体替换：换绑事件源，并保持待重传。
        if (!ReferenceEquals(profile, _profile))
        {
            if (_profile is { } previous)
            {
                previous.PropertyChanged -= OnProfilePropertyChanged;
                DetachDictionary(previous.TimeLayouts);
                DetachDictionary(previous.ClassPlans);
                DetachDictionary(previous.Subjects);
                DetachDictionary(previous.ClassPlanGroups);
            }
            Attach(profile);
        }
        var json = JsonSerializer.SerializeToNode(profile, JsonOptions);
        var canonical = Jcs.Canonicalize(json);
        _digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        _snapshot = JsonDocument.Parse(json!.ToJsonString(JsonOptions)).RootElement.Clone();
        _subjectsCount = profile.Subjects.Count;
        _timeLayoutsCount = profile.TimeLayouts.Count;
        _classPlansCount = profile.ClassPlans.Count;
        _classPlanGroupsCount = profile.ClassPlanGroups.Count;
    }

    private void Attach(Profile profile)
    {
        _profile = profile;
        profile.PropertyChanged += OnProfilePropertyChanged;
        AttachDictionary(profile.TimeLayouts);
        AttachDictionary(profile.ClassPlans);
        AttachDictionary(profile.Subjects);
        AttachDictionary(profile.ClassPlanGroups);
    }

    private void AttachDictionary<T>(IEnumerable<KeyValuePair<Guid, T>> dictionary) where T : class
    {
        if (dictionary is INotifyCollectionChanged changed) changed.CollectionChanged += OnCollectionChanged;
        foreach (var (_, item) in dictionary)
        {
            if (item is INotifyPropertyChanged notifier) notifier.PropertyChanged += OnItemPropertyChanged;
        }
    }

    private void DetachDictionary<T>(IEnumerable<KeyValuePair<Guid, T>> dictionary) where T : class
    {
        if (dictionary is INotifyCollectionChanged changed) changed.CollectionChanged -= OnCollectionChanged;
        foreach (var (_, item) in dictionary)
        {
            if (item is INotifyPropertyChanged notifier) notifier.PropertyChanged -= OnItemPropertyChanged;
        }
    }

    private void OnCollectionChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        if (e.OldItems is not null)
        {
            foreach (var item in e.OldItems)
            {
                if (item is INotifyPropertyChanged notifier) notifier.PropertyChanged -= OnItemPropertyChanged;
            }
        }
        if (e.NewItems is not null)
        {
            foreach (var item in e.NewItems)
            {
                if (item is INotifyPropertyChanged notifier) notifier.PropertyChanged += OnItemPropertyChanged;
            }
        }
        MarkDirty();
    }

    private void OnItemPropertyChanged(object? sender, PropertyChangedEventArgs e) => MarkDirty();

    private void OnProfilePropertyChanged(object? sender, PropertyChangedEventArgs e) => MarkDirty();

    private void MarkDirty()
    {
        lock (_gate) _dirty = true;
        Changed?.Invoke();
    }
}
