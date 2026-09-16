using System.Text.Json;

namespace ClassIsland.Control.Plugin.Services;

public sealed record PluginSettings
{
    public string ServerUrl { get; init; } = "";
    public string EnrollmentToken { get; init; } = "";
    public string DeviceName { get; init; } = Environment.MachineName;
    /// <summary>
    /// 与集控端的连接模式：http 短轮询 / websocket 常驻长连接。
    /// 由集控端指定（随每次响应回带），本机不可自行切换。
    /// </summary>
    public string Transport { get; init; } = "http";

    /// <summary>课表上传：开启后自动采集本机档案并随连接上报到集控端。</summary>
    public bool TimetableUploadEnabled { get; init; } = true;

    /// <summary>点名悬浮窗：是否常驻显示。名单本身由集控端下发，本机不可编辑。</summary>
    public bool RollCallEnabled { get; init; }
    /// <summary>悬浮窗宽度（逻辑像素）。</summary>
    public double RollCallWidth { get; init; } = 260;
    /// <summary>悬浮窗高度（逻辑像素）。</summary>
    public double RollCallHeight { get; init; } = 112;
    /// <summary>悬浮窗底色不透明度（0.2–1）。</summary>
    public double RollCallOpacity { get; init; } = 0.8;
    /// <summary>单人结果的显示秒数。</summary>
    public int RollCallSingleSeconds { get; init; } = 3;
    /// <summary>多人结果的显示秒数（每人递增 1 秒）。</summary>
    public int RollCallMultiSeconds { get; init; } = 6;
    /// <summary>抽中时是否同时拉起 ClassIsland 提醒。</summary>
    public bool RollCallNotify { get; init; } = true;
    /// <summary>悬浮窗上次停靠位置；null 表示右下角默认位置。</summary>
    public double? RollCallX { get; init; }
    public double? RollCallY { get; init; }
}

/// <summary>
/// 持久命令日志条目。prepared 表示副作用可能已经开始，但回执尚未落盘。
/// </summary>
public sealed record CommandJournalEntry(string CommandId, string CapabilityId, string Phase, CommandResult? Result = null);

/// <summary>待执行的解除请求：回执必须先送达服务端，之后才清空本地身份。</summary>
public sealed record PendingRelease(string CommandId, string? Reason = null);

public sealed record AgentState
{
    public string DeviceId { get; init; } = "";
    public long Sequence { get; init; }
    public long PolicyRevision { get; init; }
    /// <summary>服务端下发的单调 desired-state epoch；仅当成功应用后才推进。</summary>
    public long PolicyEpoch { get; init; }
    public string LastPolicyHash { get; init; } = "";
    /// <summary>最近一次策略逐节应用结果，随轮询上报，用于区分 received/applied/failed。</summary>
    public Dictionary<string, string> AppliedSections { get; init; } = [];
    public string DevicePrivateKey { get; init; } = "";
    public string DevicePublicKey { get; init; } = "";
    public string ServerSigningPublicKey { get; init; } = "";
    public string ServerSigningKeyId { get; init; } = "";
    public List<CommandResult> PendingAcknowledgements { get; init; } = [];
    public int DriftCount { get; init; }
    public HashSet<string> CompletedCommands { get; init; } = [];
    public PollRequest? PendingPoll { get; init; }
    /// <summary>集控端已下发解除；等回执被接收后由轮询循环执行。</summary>
    public PendingRelease? PendingRelease { get; init; }
    public List<CommandJournalEntry> Journal { get; init; } = [];
}

/// <summary>
/// 设置与状态的唯一持久化入口，同时是“防解除”的执行点。
///
/// 不变量：一旦设备身份落盘（或存在有效封条），本机就不得再改动服务器地址、
/// 清空设备身份或重新接入；只有控制平面下发 enrollment.release.v1 命令才会解除。
/// 约束在这里强制执行，绕过设置页直接编辑 settings.json/state.json 同样会被折叠回锁定值。
/// </summary>
public sealed class PluginSettingsStore
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly PluginPaths _paths;
    private readonly EnrollmentGuard _guard;
    private string _lockedDeviceId = "";
    private string _lockedServerUrl = "";
    private string _lockedPrivateKey = "";
    private string _lockedPublicKey = "";
    private string _lockedTransport = "http";
    private static readonly JsonSerializerOptions JsonOptions =
        new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly PolicySnapshotStore _snapshots;

    public PluginSettingsStore(PluginPaths paths, EnrollmentGuard guard, PolicySnapshotStore snapshots)
    {
        _paths = paths;
        _guard = guard;
        _snapshots = snapshots;
        Settings = Load<PluginSettings>(paths.Settings);
        _lockedTransport = NormalizeTransport(Settings.Transport);
        State = Load<AgentState>(paths.State);
        RestoreEnrollment();
    }

    public PluginSettings Settings { get; private set; }
    public AgentState State { get; private set; }

    /// <summary>已入网且未被集控端解除：本机不得自行退出或改接其他服务器。</summary>
    public bool IsEnrollmentLocked { get; private set; }

    /// <summary>本次启动的入网状态来自封条恢复，说明本地身份文件曾被清空或篡改。</summary>
    public bool RecoveredFromSeal => _guard.RestoredFromSeal;

    /// <summary>封条签名不可信。</summary>
    public bool SealTampered => _guard.SealTampered;

    public string EnrollmentLockReason { get; private set; } = "";

    public async Task SaveSettingsAsync(PluginSettings value, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var guarded = Guard(value);
            await WriteAtomicAsync(_paths.Settings, guarded, cancellationToken);
            Settings = guarded;
        }
        finally { _gate.Release(); }
    }

    public async Task SaveStateAsync(AgentState value, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var guarded = Guard(value);
            await WriteAtomicAsync(_paths.State, guarded, cancellationToken);
            State = guarded;
            if (guarded.DeviceId.Length > 0) LockAndSeal(guarded);
        }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// 记录集控端下发的解除请求。真正的清除发生在轮询循环确认回执已被服务端接收之后，
    /// 否则设备一清空身份就不再轮询，服务端永远等不到这条命令的终态回执。
    /// </summary>
    public async Task RequestReleaseAsync(string commandId, string? reason, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var state = State with { PendingRelease = new PendingRelease(commandId, reason) };
            await WriteAtomicAsync(_paths.State, state, cancellationToken);
            State = state;
        }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// 仅由集控端响应调用：采纳下发的连接模式，之后本地改写会被折回该值。
    /// 返回是否真的发生了变化。
    /// </summary>
    public async Task<bool> ApplyServerTransportAsync(string? transport, CancellationToken cancellationToken = default)
    {
        var value = NormalizeTransport(transport);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_lockedTransport == value) return false;
            _lockedTransport = value;
            var settings = Settings with { Transport = value };
            await WriteAtomicAsync(_paths.Settings, settings, cancellationToken);
            Settings = settings;
            return true;
        }
        finally { _gate.Release(); }
    }

    private static string NormalizeTransport(string? transport) =>
        transport is "websocket" ? "websocket" : "http";

    /// <summary>
    /// 仅由控制平面的 enrollment.lock.v1 命令调用：用集控端的权威值重建入网锁与封条，
    /// 纠正被本地改写的服务器地址。返回是否真的发生了修复。
    /// </summary>
    public async Task<bool> RepairEnrollmentAsync(string? serverUrl, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (State.DeviceId.Length == 0) return false;
            var changed = false;
            if (!string.IsNullOrWhiteSpace(serverUrl) && serverUrl != _lockedServerUrl)
            {
                _lockedServerUrl = serverUrl;
                changed = true;
            }
            if (Settings.ServerUrl != _lockedServerUrl)
            {
                Settings = Settings with { ServerUrl = _lockedServerUrl };
                await WriteAtomicAsync(_paths.Settings, Settings, cancellationToken);
                changed = true;
            }
            LockAndSeal(State);
            return changed;
        }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// 仅由控制平面的 enrollment.release.v1 命令调用：清空入网身份与封条，回到未接入状态。
    /// 服务器地址与设备名称保留，便于管理员重新下发接入码。
    /// </summary>
    public async Task ReleaseEnrollmentAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var state = State with
            {
                DeviceId = "", DevicePrivateKey = "", DevicePublicKey = "",
                ServerSigningPublicKey = "", ServerSigningKeyId = "",
                Sequence = 0, PolicyRevision = 0, PolicyEpoch = 0, LastPolicyHash = "",
                AppliedSections = [], PendingAcknowledgements = [], CompletedCommands = [],
                Journal = [], PendingPoll = null, PendingRelease = null, DriftCount = 0,
            };
            await WriteAtomicAsync(_paths.State, state, cancellationToken);
            var settings = Settings with { EnrollmentToken = "" };
            await WriteAtomicAsync(_paths.Settings, settings, cancellationToken);
            _guard.Delete();
            _snapshots.Delete();
            State = state;
            Settings = settings;
            IsEnrollmentLocked = false;
            EnrollmentLockReason = "";
        }
        finally { _gate.Release(); }
    }

    private PluginSettings Guard(PluginSettings value)
    {
        if (!IsEnrollmentLocked) return value;
        // 已入网：服务器地址由封条决定，一次性接入码一律不接受，防止改接到其他集控。
        return value with
        {
            ServerUrl = _lockedServerUrl.Length > 0 ? _lockedServerUrl : value.ServerUrl,
            EnrollmentToken = "",
            Transport = _lockedTransport,
        };
    }

    private AgentState Guard(AgentState value)
    {
        if (!IsEnrollmentLocked) return value;
        // 已入网：设备身份不可通过任何本地写入清除或替换。
        return value with
        {
            DeviceId = _lockedDeviceId,
            DevicePrivateKey = _lockedPrivateKey,
            DevicePublicKey = _lockedPublicKey,
        };
    }

    private void RestoreEnrollment()
    {
        // Read() 会遍历全部副本并完成验签；存在副本但无一可信时置 SealTampered。
        var seal = _guard.Read();

        // 封条经设备私钥签名，是入网事实的权威来源：优先据它纠正本地状态。
        if (seal is not null)
        {
            _guard.RestoredFromSeal = State.DeviceId.Length == 0
                || State.DeviceId != seal!.DeviceId
                || State.DevicePrivateKey != seal.DevicePrivateKey
                || string.IsNullOrWhiteSpace(Settings.ServerUrl);
            State = State with
            {
                DeviceId = seal!.DeviceId,
                DevicePrivateKey = seal.DevicePrivateKey,
                DevicePublicKey = seal.DevicePublicKey,
                ServerSigningPublicKey = seal.ServerSigningPublicKey,
                ServerSigningKeyId = seal.ServerSigningKeyId,
            };
            Settings = Settings with
            {
                ServerUrl = seal.ServerUrl,
                DeviceName = string.IsNullOrWhiteSpace(Settings.DeviceName) ? seal.DeviceName : Settings.DeviceName,
            };
            if (_guard.RestoredFromSeal)
            {
                try
                {
                    WriteAtomic(_paths.State, State);
                    WriteAtomic(_paths.Settings, Settings);
                }
                catch { /* 写回失败不影响本次运行：内存中已按封条锁定。 */ }
            }
            // 补齐缺失的镜像副本（升级或某份副本被删除时），保证下次仍能恢复。
            _guard.Write(seal);
            Lock(State.DeviceId, seal.ServerUrl, seal.DevicePrivateKey, seal.DevicePublicKey,
                "已加入集控，需由集控端解除");
            return;
        }

        if (State.DeviceId.Length > 0)
        {
            Lock(State.DeviceId, Settings.ServerUrl, State.DevicePrivateKey, State.DevicePublicKey,
                "已加入集控，需由集控端解除");
            LockAndSeal(State);
        }
    }

    private void LockAndSeal(AgentState state)
    {
        Lock(state.DeviceId, Settings.ServerUrl, state.DevicePrivateKey, state.DevicePublicKey,
            "已加入集控，需由集控端解除");
        if (string.IsNullOrWhiteSpace(state.DevicePrivateKey) || string.IsNullOrWhiteSpace(state.DevicePublicKey))
            return;
        try
        {
            _guard.Write(_guard.Create(state.DeviceId, Settings.ServerUrl, Settings.DeviceName,
                state.DevicePrivateKey, state.DevicePublicKey,
                state.ServerSigningPublicKey, state.ServerSigningKeyId));
        }
        catch { /* 封条写入失败不回滚入网：内存锁仍然生效。 */ }
    }

    private void Lock(string deviceId, string serverUrl, string privateKey, string publicKey, string reason)
    {
        IsEnrollmentLocked = true;
        _lockedDeviceId = deviceId;
        _lockedServerUrl = serverUrl;
        _lockedPrivateKey = privateKey;
        _lockedPublicKey = publicKey;
        EnrollmentLockReason = reason;
    }

    private static T Load<T>(string path) where T : new()
    {
        try { return File.Exists(path) ? JsonSerializer.Deserialize<T>(File.ReadAllText(path), JsonOptions) ?? new T() : new T(); }
        catch { return new T(); }
    }

    private static void WriteAtomic<T>(string path, T value)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(value, JsonOptions));
        File.Move(temporary, path, true);
    }

    private static async Task WriteAtomicAsync<T>(string path, T value, CancellationToken cancellationToken)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        var temporary = path + ".tmp";
        await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(value, JsonOptions), cancellationToken);
        File.Move(temporary, path, true);
    }
}