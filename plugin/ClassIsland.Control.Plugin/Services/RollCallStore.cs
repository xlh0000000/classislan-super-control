using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>集控端下发的点名名单本地缓存。名单是只读下发内容，不参与入网封条。</summary>
public sealed record RollCallSnapshot
{
    public long Revision { get; init; }
    public List<string> Names { get; init; } = [];
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

    public IReadOnlyList<string> Names => Snapshot.Names;

    /// <summary>
    /// 集控端是否已经下发过名单。下发的空名单也算数（修订号 > 0），
    /// 否则“服务端故意清空名单”会被本机名字表顶掉。
    /// </summary>
    public bool HasServerRoster => Snapshot.Revision > 0 || Snapshot.Names.Count > 0;

    /// <summary>名单发生变化时触发，供悬浮窗刷新标题。</summary>
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
    /// 采纳服务端下发的名单。修订号一致即空操作，
    /// 因此“服务端只回带变化”与“每轮都回带”两种策略都能正确工作。
    /// </summary>
    public async Task<bool> ApplyAsync(long revision, IReadOnlyList<string> names, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        var changed = false;
        try
        {
            if (revision == Snapshot.Revision && names.SequenceEqual(Snapshot.Names, StringComparer.Ordinal))
                return false;
            var snapshot = new RollCallSnapshot
            {
                Revision = revision,
                Names = [.. names],
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