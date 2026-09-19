using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>
/// 集控端下发的点名设置。每项可空：null 表示集控端这一项不表态，
/// 由本机设置页维护的值兜底，因此关掉全校抽人不必逐台设备写一遍。
/// </summary>
public sealed record RollCallSettingsSnapshot
{
    public bool? Enabled { get; init; }
    public bool? Notify { get; init; }
    public int? SingleSeconds { get; init; }
    public int? MultiSeconds { get; init; }
}

/// <summary>集控端下发的点名内容本地缓存（名单 + 设置）。都是只读下发，不参与入网封条。</summary>
public sealed record RollCallSnapshot
{
    public long Revision { get; init; }
    /// <summary>null 表示生效链上没有指派给这台设备的名单，本机名字表继续生效。</summary>
    public List<string>? Names { get; init; }
    public RollCallSettingsSnapshot Settings { get; init; } = new();
    public DateTime UpdatedAtUtc { get; init; }
}

/// <summary>
/// 点名名单的持久化入口。与设备身份分开存放：身份文件被清空时名单只是丢失缓存，
/// 下一轮轮询会用服务端修订号重新拉全量。
/// </summary>
public sealed class RollCallStore
{
    private static readonly JsonSerializerOptions JsonOptions =
        new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _path;
    private readonly ILogger<RollCallStore> _logger;

    public RollCallStore(PluginPaths paths, ILogger<RollCallStore> logger)
    {
        _path = Path.Combine(paths.Root, "rollcall.json");
        _logger = logger;
        Snapshot = Load();
    }

    public RollCallSnapshot Snapshot { get; private set; }

    /// <summary>生效名单；集控端没给这台设备指派名单时为空，调用方据 <see cref="HasServerRoster"/> 判断。</summary>
    public IReadOnlyList<string> Names => Snapshot.Names ?? [];

    public RollCallSettingsSnapshot Settings => Snapshot.Settings;

    /// <summary>
    /// 集控端是否指派了名单给这台设备。下发的空名单也算数，
    /// 否则“服务端故意清空名单”会被本机名字表顶掉。
    /// 修订号是全局计数（别的设备改名单也会前进），不能拿它证明本机有过名单。
    /// </summary>
    public bool HasServerRoster => Snapshot.Names is not null;

    /// <summary>名单或设置发生变化时触发，供悬浮窗刷新可见状态与标题。</summary>
    public event Action? Changed;

    private RollCallSnapshot Load()
    {
        try
        {
            if (!File.Exists(_path)) return new RollCallSnapshot();
            return JsonSerializer.Deserialize<RollCallSnapshot>(File.ReadAllText(_path), JsonOptions)
                ?? new RollCallSnapshot();
        }
        catch (Exception exception)
        {
            _logger.LogWarning(exception, "Failed to read the persisted roll-call roster; starting empty.");
            return new RollCallSnapshot();
        }
    }

    /// <summary>
    /// 采纳服务端下发的点名内容。修订号一致即空操作：服务端只在设备手上的修订过期时
    /// 才回带整份名单与设置，因此这里收到的一定是新的那一份。
    /// </summary>
    public async Task<bool> ApplyAsync(long revision, IReadOnlyList<string>? names,
        RemoteRollCallSettings? settings, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        var changed = false;
        try
        {
            if (revision == Snapshot.Revision) return false;
            var snapshot = new RollCallSnapshot
            {
                Revision = revision,
                Names = names is null ? null : [.. names],
                Settings = new RollCallSettingsSnapshot
                {
                    Enabled = settings?.Enabled,
                    Notify = settings?.Notify,
                    SingleSeconds = settings?.SingleSeconds,
                    MultiSeconds = settings?.MultiSeconds,
                },
                UpdatedAtUtc = DateTime.UtcNow,
            };
            var directory = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            var temporary = _path + ".tmp";
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(snapshot, JsonOptions), cancellationToken);
            File.Move(temporary, _path, true);
            Snapshot = snapshot;
            changed = true;
        }
        catch (Exception exception)
        {
            // 写盘失败不影响本次运行：内存中的名单仍然可用，下次轮询会重试。
            _logger.LogWarning(exception, "Failed to persist the roll-call roster.");
        }
        finally { _gate.Release(); }
        if (changed) Changed?.Invoke();
        return changed;
    }
}