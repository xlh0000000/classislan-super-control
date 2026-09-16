namespace ClassIsland.Control.Plugin.Services;

// 贡献者：威廉（课表上传状态）

/// <summary>设备端连接状态：供设置页展示是否已加入集控。所有成员线程安全。</summary>
public sealed class AgentStatus
{
    private readonly object _gate = new();
    private string _deviceId = "";
    private string _lastError = "";
    private string _policyError = "";
    private string _note = "";
    private DateTimeOffset? _lastSuccessAt;
    private long _policyRevision;
    private long _policyEpoch;
    private Dictionary<string, string> _appliedSections = [];
    private IReadOnlyList<string> _lockSummary = [];
    private string _timeOffsetSummary = "";
    private string _timetableSummary = "";
    private bool _syncing;
    private bool _locked;

    public event Action? Changed;

    public string DeviceId { get { lock (_gate) return _deviceId; } }
    public string LastError { get { lock (_gate) return _lastError; } }
    public string PolicyError { get { lock (_gate) return _policyError; } }
    /// <summary>未接入时的说明文案（如“集控端已解除接入”）。</summary>
    public string Note { get { lock (_gate) return _note; } }
    public DateTimeOffset? LastSuccessAt { get { lock (_gate) return _lastSuccessAt; } }
    public bool Syncing { get { lock (_gate) return _syncing; } }
    public bool IsEnrolled { get { lock (_gate) return _deviceId.Length > 0; } }
    public bool Online { get { lock (_gate) return _lastSuccessAt is { } at && DateTimeOffset.UtcNow - at < TimeSpan.FromSeconds(90); } }
    public long PolicyRevision { get { lock (_gate) return _policyRevision; } }
    /// <summary>已入网且未被集控端解除：本机不提供任何退出集控的入口。</summary>
    public bool Locked { get { lock (_gate) return _locked; } }
    /// <summary>当前生效的设置锁定项显示名，供设置页展示。</summary>
    public IReadOnlyList<string> LockSummary { get { lock (_gate) return _lockSummary.ToArray(); } }
    /// <summary>集控端下发的时间偏移说明；空串表示未接管本机时间偏移。</summary>
    public string TimeOffsetSummary { get { lock (_gate) return _timeOffsetSummary; } }
    /// <summary>课表上传状态说明；空串表示课表上传未开启或宿主不可用。</summary>
    public string TimetableSummary { get { lock (_gate) return _timetableSummary; } }
    public long PolicyEpoch { get { lock (_gate) return _policyEpoch; } }
    public IReadOnlyDictionary<string, string> AppliedSections { get { lock (_gate) return new Dictionary<string, string>(_appliedSections); } }

    public void Enrolled(string deviceId)
    {
        lock (_gate)
        {
            _deviceId = deviceId;
            _locked = deviceId.Length > 0;
            _lastError = "";
            _policyError = "";
            _note = "";
        }
        Changed?.Invoke();
    }

    /// <summary>集控端下发解除命令后调用：回到未接入状态并允许本地重新配置。</summary>
    public void EnrollmentReleased()
    {
        lock (_gate)
        {
            _deviceId = "";
            _locked = false;
            _lastSuccessAt = null;
            _policyRevision = 0;
            _policyEpoch = 0;
            _appliedSections = [];
            _lockSummary = [];
            _timeOffsetSummary = "";
            _timetableSummary = "";
            _policyError = "";
            _lastError = "";
            _note = "集控端已解除接入，可重新配置";
        }
        Changed?.Invoke();
    }

    /// <summary>等待人工配置：既不是错误也不是同步中。</summary>
    public void Waiting(string note)
    {
        lock (_gate)
        {
            _syncing = false;
            _lastError = "";
            _note = note;
        }
        Changed?.Invoke();
    }

    /// <summary>集控端下发的设置锁定项已应用到宿主。</summary>
    public void SettingsPolicyApplied(IReadOnlyList<string> labels)
    {
        lock (_gate) _lockSummary = labels.ToArray();
        Changed?.Invoke();
    }

    /// <summary>集控端下发的时间偏移已应用到宿主。</summary>
    public void TimeOffsetApplied(string summary)
    {
        lock (_gate) _timeOffsetSummary = summary;
        Changed?.Invoke();
    }

    /// <summary>记录课表上传状态（已上传内容概览或降级原因）。</summary>
    public void TimetableUpdated(string summary)
    {
        lock (_gate) _timetableSummary = summary;
        Changed?.Invoke();
    }

    /// <summary>启动时用持久化状态回填，避免设置页在首次轮询前显示“尚未收到策略”。</summary>
    public void Restore(AgentState state)
    {
        lock (_gate)
        {
            _deviceId = state.DeviceId;
            _locked = state.DeviceId.Length > 0;
            _policyRevision = state.PolicyRevision;
            _policyEpoch = state.PolicyEpoch;
            _appliedSections = new Dictionary<string, string>(state.AppliedSections);
        }
        Changed?.Invoke();
    }

    public void AttemptStarted()
    {
        lock (_gate) _syncing = true;
        Changed?.Invoke();
    }

    public void AttemptSucceeded()
    {
        lock (_gate) { _syncing = false; _lastSuccessAt = DateTimeOffset.UtcNow; _lastError = ""; }
        Changed?.Invoke();
    }

    public void AttemptFailed(string error)
    {
        lock (_gate) { _syncing = false; _lastError = error; _note = ""; }
        Changed?.Invoke();
    }

    /// <summary>策略已成功应用到本机；同步记录修订号与逐节结果供设置页展示。</summary>
    public void PolicyApplied(long revision, long epoch, IReadOnlyDictionary<string, string>? sections)
    {
        lock (_gate)
        {
            _policyRevision = revision;
            _policyEpoch = epoch;
            _appliedSections = sections is null ? [] : new Dictionary<string, string>(sections);
            _policyError = "";
        }
        Changed?.Invoke();
    }

    /// <summary>策略校验通过但应用失败；与网络错误分开记录，避免被下一次轮询成功覆盖。</summary>
    public void PolicyFailed(string error)
    {
        lock (_gate) _policyError = error;
        Changed?.Invoke();
    }
}