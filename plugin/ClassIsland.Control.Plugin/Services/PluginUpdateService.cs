using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Avalonia.Threading;
using ClassIsland.Core;
using ClassIsland.Core.Abstractions.Services;
using ClassIsland.Shared.Enums;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>
/// 插件静默自升级：拿到下载机会 → 下载并校验 → 私有暂存 → 等没课时重启。
///
/// 为什么等重启而不是立刻重启：宿主要求插件在下次启动时才换目录，而上课途中重启会把
/// 当前课节的提醒与投屏打断；因此暂存完成后不动，等 <see cref="IsIdleWindowOpen"/> 才动手。
///
/// 为什么先暂存在自己的配置目录、决定重启那一刻才挪进宿主的安装目录：
/// 宿主启动时会无条件安装 <c>Cache/PluginPackages</c> 里所有 <c>*.cipx</c>（见 PluginService.ProcessPluginsInstall），
/// 提前放进去等于把「什么时候生效」交给下一次无关的重启，管理员取消升级指令也就再也撤不回来。
///
/// 校验分三层，缺一层都可能装进错的东西：摘要（服务端签名响应里给的 SHA-256）、
/// 大小（与凭据声明逐字节相等，由下载层把住）、以及包内 manifest 的 Id 与 Version
/// ——最后这层是为了防止一个 id 写错的包让宿主去覆盖另一个插件的目录。
/// </summary>
public sealed class PluginUpdateService(
    PluginPaths paths,
    ControlPlaneClient client,
    ThisPlugin plugin,
    IServiceProvider services,
    ILogger<PluginUpdateService> logger)
{
    /// <summary>同一版本连撞这么多次就安静下来，等管理员换目标或人工介入。</summary>
    private const int MaxAttempts = 3;
    private static readonly TimeSpan RetryDelay = TimeSpan.FromMinutes(10);
    /// <summary>距下一节课不足这么久就不重启：宿主重启加解包要时间，不能让升级吃掉上课提醒。</summary>
    private static readonly TimeSpan MinimumLeadTime = TimeSpan.FromMinutes(2);
    private static readonly Regex VersionPattern = new(@"^\d+\.\d+\.\d+\.\d+$", RegexOptions.CultureInvariant);

    private DateTime _retryAfterUtc;

    /// <summary>本轮要随轮询上报的进度；没有升级动作时两个字段整体省略，旧服务端与旧向量都不受影响。</summary>
    public static (string? State, string? Version) Report(PluginUpdateProgress progress) =>
        progress.State.Length == 0 ? (null, null) : (progress.State, progress.Version);

    /// <summary>
    /// 每轮开始前把落盘的进度对一遍磁盘事实：暂存记录说有事，包却已经不在，
    /// 那就是上一次安装没成或包被删了——报一次失败，让服务端重新给下载机会。
    /// </summary>
    public PluginUpdateProgress Reconcile(PluginUpdateProgress progress)
    {
        if (progress.State != "staged") return progress;
        // 重启回来了而且版本已经是那一份：这就是「真换成了新版本」的确认，只报一次。
        if (progress.Version == plugin.Version) return progress with { State = "applied" };
        return File.Exists(PendingPath(progress.Version)) ? progress : Failed(progress);
    }

    /// <summary>
    /// 处理服务端这一轮回带的下载机会，返回新的进度（落盘由调用方与本轮其他状态一起写，避免互相覆盖）。
    /// </summary>
    public async Task<PluginUpdateProgress> HandleOfferAsync(RemotePluginUpdate? offer, PluginUpdateProgress progress, CancellationToken cancellationToken)
    {
        if (offer is null)
        {
            // 彻底没有下载机会 = 集控端不再要求本机升级（取消或目标已等于本机版本）：
            // 私有暂存删掉，别让这份包在某次无关的重启里被宿主装上。
            if (progress.State != "staged") return progress;
            TryDelete(PendingPath(progress.Version));
            return progress with { State = "", Version = "", Attempts = 0 };
        }
        if (offer.Version == plugin.Version) return progress;
        if (string.IsNullOrEmpty(offer.Token))
        {
            // 目标没变，且我们报的正是这一版：继续等空闲窗口，不重复下载。
            return progress;
        }
        if (progress.Version != offer.Version)
        {
            // 换了目标：上一版留着的包没用了，次数也从新目标重新开始计。
            progress = progress with { Version = offer.Version, Attempts = 0 };
            PrunePendingExcept(offer.Version);
        }
        if (progress.State == "staged" && progress.Version == offer.Version) return progress;
        if (progress.Attempts >= MaxAttempts) return progress;
        if (DateTime.UtcNow < _retryAfterUtc) return progress;
        try
        {
            await StageAsync(offer, cancellationToken);
            _retryAfterUtc = DateTime.MinValue;
            logger.LogInformation("Control plane plugin update {Version} staged; waiting for a free window.", offer.Version);
            return new PluginUpdateProgress("staged", offer.Version, 0);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Failed to stage control plane plugin update {Version}.", offer.Version);
            _retryAfterUtc = DateTime.UtcNow + RetryDelay;
            return Failed(progress);
        }
    }

    /// <summary>本轮已被服务端接收：一次性的 applied/failed 回报清成空，避免界面上一直挂着旧结论。</summary>
    public static PluginUpdateProgress Settle(PluginUpdateProgress progress) => progress.State switch
    {
        "applied" => new PluginUpdateProgress(),
        "failed" => progress with { State = "" },
        _ => progress,
    };

    /// <summary>
    /// 设备端设置页上的一句话。重点是「这台机器待会儿会不会自己重启」——
    /// 自动重启不该在讲课中途凭空发生，至少要坐在机器前的人看得见。
    /// </summary>
    public string Describe(PluginUpdateProgress progress) => progress.State switch
    {
        "staged" => $"新版本 {progress.Version} 已就位，等待没课时重启",
        "applied" => $"已升级到 {progress.Version}",
        "failed" => $"升级到 {progress.Version} 失败，稍后自动重试",
        // 失败回报清成空之后仍要留个交代：这一版已经不再自动重试，等管理员处理。
        _ when progress.Attempts >= MaxAttempts && progress.Version.Length > 0 && progress.Version != plugin.Version
            => $"升级到 {progress.Version} 多次失败，已暂停，请检查集控端",
        _ => "",
    };

    /// <summary>有包在等、且现在没课：把包交给宿主的安装目录并重启，返回是否已触发重启。</summary>
    public async Task<bool> RestartIfIdleAsync(PluginUpdateProgress progress, CancellationToken cancellationToken)
    {
        if (progress.State != "staged" || cancellationToken.IsCancellationRequested) return false;
        if (!VersionPattern.IsMatch(progress.Version)) return false;
        if (!IsIdleWindowOpen()) return false;
        var pending = PendingPath(progress.Version);
        // Reconcile 每轮都会把「记录说有事、包却不在」纠正成 failed，这里只是不再对不存在的文件动手。
        if (!File.Exists(pending)) return false;
        // 挪进安装目录与重启之间没有回头路：这一步之后，最迟下次启动该版本就会生效。
        var target = Path.Combine(HostPackageFolder(), $"{progress.Version}.cipx");
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.Move(pending, target, true);
        logger.LogInformation("Restarting the host to install plugin update {Version}.", progress.Version);
        await Dispatcher.UIThread.InvokeAsync(() => AppBase.Current.Restart(true));
        return true;
    }

    private async Task StageAsync(RemotePluginUpdate offer, CancellationToken cancellationToken)
    {
        if (!VersionPattern.IsMatch(offer.Version)) throw new InvalidOperationException($"凭据里的版本号不是四段数字：{offer.Version}");
        var temp = Path.Combine(paths.Root, $"update-{offer.Version}.download.tmp");
        try
        {
            Directory.CreateDirectory(paths.Root);
            var digest = await client.DownloadPluginReleaseAsync(offer, temp, cancellationToken);
            if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(digest),
                    Encoding.ASCII.GetBytes(offer.Sha256)))
                throw new CryptographicException("插件包摘要与集控端声明的不一致。");
            VerifyPackage(temp, offer.Version);
            File.Move(temp, PendingPath(offer.Version), true);
        }
        finally
        {
            TryDelete(temp);
        }
    }

    /// <summary>核对包内 manifest：只允许安装「同一个 Id、正是目标 Version」的那一份。</summary>
    private void VerifyPackage(string packagePath, string expectedVersion)
    {
        using var archive = ZipFile.OpenRead(packagePath);
        var entry = archive.Entries.FirstOrDefault(x =>
            string.Equals(x.FullName.Replace('\\', '/'), "manifest.yml", StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidDataException("包根目录里没有 manifest.yml。");
        using var reader = new StreamReader(entry.Open(), Encoding.UTF8);
        string? id = null;
        string? version = null;
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            // 与宿主一样只认根级标量：缩进行属于别的节点，# 之后是注释。
            if (line.Length == 0 || char.IsWhiteSpace(line[0]) || line[0] == '#') continue;
            id ??= ReadScalar(line, "id");
            version ??= ReadScalar(line, "version");
        }
        if (id != plugin.Id) throw new InvalidDataException($"包里的插件标识是 {id ?? "空"}，不是本插件 {plugin.Id}。");
        if (version != expectedVersion) throw new InvalidDataException($"包里的版本是 {version ?? "空"}，与凭据声明的 {expectedVersion} 不符。");
    }

    private static string? ReadScalar(string line, string key)
    {
        if (!line.StartsWith(key + ":", StringComparison.Ordinal)) return null;
        var value = line[(key.Length + 1)..].Split('#')[0].Trim();
        if (value.Length >= 2 && (value[0] == '"' || value[0] == '\'') && value[^1] == value[0]) value = value[1..^1];
        return value.Length == 0 ? null : value;
    }

    /// <summary>
    /// 现在是不是「没课」的窗口：上课中、正在预告上课都不动；课间要看还剩多少时间，
    /// 太短就不够宿主重启加解包。取不到课程服务时一律不重启，宁可让包多等一天。
    /// </summary>
    private bool IsIdleWindowOpen()
    {
        var lessons = services.GetService<ILessonsService>();
        if (lessons is null) return false;
        if (lessons.CurrentState is TimeState.OnClass or TimeState.PrepareOnClass) return false;
        var leftForNextClass = lessons.OnClassLeftTime;
        return leftForNextClass <= TimeSpan.Zero || leftForNextClass >= MinimumLeadTime;
    }

    private PluginUpdateProgress Failed(PluginUpdateProgress progress) => progress with { State = "failed", Attempts = progress.Attempts + 1 };

    private string PendingPath(string version) => Path.Combine(paths.Root, $"update-{version}.cipx");

    /// <summary>清掉除目标版本以外的暂存包：换过目标的机器不该留着旧版本等着被装。</summary>
    private void PrunePendingExcept(string version)
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(paths.Root, "update-*.cipx"))
            {
                var name = Path.GetFileNameWithoutExtension(file)["update-".Length..];
                if (name == version) continue;
                TryDelete(file);
            }
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Could not prune staged plugin packages.");
        }
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException) { /* 删不掉也只是多留一份包，安装时会被覆盖。 */ }
    }

    /// <summary>
    /// 宿主的插件包目录。宿主把这段路径放在应用程序集的 PluginService 里（插件引用不到），
    /// 但它的算法就是「缓存目录 + PluginPackages」，而缓存目录由 Core 的 CommonDirectories 给出，
    /// 因此在这里按同一规则拼出来即可。
    /// </summary>
    private static string HostPackageFolder() => Path.Combine(CommonDirectories.AppCacheFolderPath, "PluginPackages");
}
