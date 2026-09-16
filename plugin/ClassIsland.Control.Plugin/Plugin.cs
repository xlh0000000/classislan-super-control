using ClassIsland.Control.Plugin.Services;
using ClassIsland.Control.Plugin.Views;
using ClassIsland.Core.Abstractions;
using ClassIsland.Core.Attributes;
using ClassIsland.Core.Extensions.Registry;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace ClassIsland.Control.Plugin;

// 贡献者：威廉（课表上传服务注册 / WebSocket 常驻会话注册）

[PluginEntrance]
public sealed class Plugin : PluginBase
{
    public override void Initialize(HostBuilderContext context, IServiceCollection services)
    {
        var settingsPath = Path.Combine(PluginConfigFolder, "settings.json");
        var statePath = Path.Combine(PluginConfigFolder, "state.json");
        // 入网身份封条：与 state.json 分离，state.json 被清空时据此恢复入网状态。
        var sealPath = Path.Combine(PluginConfigFolder, "identity.seal.json");
        // 策略快照：服务端签名过的最近一次轮询正文，启动时据此恢复设置锁定。
        var snapshotPath = Path.Combine(PluginConfigFolder, "policy.snapshot.json");
        // 镜像目录：插件配置目录被整体删除、或插件被卸载重装后，入网事实仍需可恢复。
        var mirrors = new List<string>();
        var configRoot = Path.GetDirectoryName(PluginConfigFolder);
        if (!string.IsNullOrEmpty(configRoot)) mirrors.Add(Path.Combine(configRoot, ".control-seals"));
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (!string.IsNullOrEmpty(localAppData)) mirrors.Add(Path.Combine(localAppData, "ClassIslandControl"));
        var paths = new PluginPaths(PluginConfigFolder, settingsPath, statePath, sealPath, snapshotPath, mirrors);
        services.AddSingleton(paths);
        // 崩溃上报：异常钩子必须尽早安装，因此在注册阶段就构造单例并挂载。
        var crashReporter = new CrashReporter(paths);
        crashReporter.Install();
        services.AddSingleton(crashReporter);
        services.AddSingleton<EnrollmentGuard>();
        services.AddSingleton<PolicySnapshotStore>();
        services.AddSingleton<PluginSettingsStore>();
        // 点名名单与悬浮窗：名单只由集控端下发，悬浮窗在宿主启动后常驻。
        services.AddSingleton<RollCallStore>();
        // 同时按具体类型注册：设置页要拿到同一个实例，AddHostedService<T> 只按 IHostedService 注册。
        services.AddSingleton<RollCallService>();
        services.AddHostedService(provider => provider.GetRequiredService<RollCallService>());
        services.AddSingleton<SettingsPolicyService>();
        // 宿主设置（时间偏移）的反射桥与执行者；宿主不提供时自动降级为不可用。
        services.AddSingleton<HostSettingsBridge>();
        services.AddSingleton<TimeOffsetService>();
        services.AddSingleton<AgentStatus>();
        services.AddSingleton<CapabilityCatalog>();
        // 课表上传：采集本机档案快照；宿主未提供 IProfileService 时内部静默降级。
        services.AddSingleton<TimetableSnapshotService>();
        services.AddSingleton<PolicyApplyService>();
        services.AddSingleton<HostOperationService>();
        services.AddSingleton(new HttpClient());
        services.AddSingleton<WebSocketSession>();
        services.AddSingleton<ControlPlaneClient>();
        services.AddHostedService<PollingHostedService>();
        // 点名相关设置收进“点名”二级菜单，避免在设置导航里平铺一排页面。
        services.AddSettingsPageGroup("classisland-control.rollcall", "\uecaa", "点名");
        services.AddSettingsPage<RollCallSettingsPage>();
        services.AddSettingsPage<ControlSettingsPage>();
        services.AddNotificationProvider<RemoteNotificationProvider>();
    }
}

public sealed record PluginPaths(
    string Root,
    string Settings,
    string State,
    string Seal,
    string Snapshot,
    IReadOnlyList<string> MirrorFolders)
{
    /// <summary>封条的全部副本：主副本优先，其次是各镜像目录。</summary>
    public IEnumerable<string> SealCopies()
    {
        yield return Seal;
        foreach (var folder in MirrorFolders) yield return Path.Combine(folder, "identity.seal.json");
    }

    /// <summary>策略快照的全部副本，顺序同上。</summary>
    public IEnumerable<string> SnapshotCopies()
    {
        yield return Snapshot;
        foreach (var folder in MirrorFolders) yield return Path.Combine(folder, "policy.snapshot.json");
    }
}
