using ClassIsland.Core;
using ClassIsland.Core.Abstractions.Services;
using ClassIsland.Core.Abstractions.Services.Management;
using ClassIsland.Core.Abstractions.Services.SpeechService;
using Microsoft.Extensions.DependencyInjection;

namespace ClassIsland.Control.Plugin.Services;

// 贡献者：威廉（timetable.upload.v1 能力声明）

public sealed class CapabilityCatalog(IServiceProvider services, TimeOffsetService timeOffset)
{
    public IReadOnlyList<CapabilityDescriptor> Detect()
    {
        var capabilities = new List<CapabilityDescriptor>
        {
            new("app.lifecycle.v1", "apply", 1),
            new("app.window.basic.volatile.v1", "volatile", 1),
            // 入网后本机不可自行解除，只有控制平面下发 enrollment.release.v1 才能解除。
            new("enrollment.lock.v1", "reconcile-lock", 1),
            new("enrollment.release.v1", "apply", 1),
        };
        AddIf<IManagementService>("settings.policy.persist.v1", "persist");
        AddIf<IProfileService>("profile.readwrite.persist.v1", "persist");
        // 课表上传：读取本机档案生成快照上报；IProfileService 不可用时自动不声明。
        AddIf<IProfileService>("timetable.upload.v1", "read");
        AddIf<ILessonsService>("lessons.state.read.v1", "read");
        AddIf<IComponentsService>("components.layout.persist.v1", "persist");
        AddIf<IAutomationService>("automation.workflow.persist.v1", "persist");
        AddIf<IWeatherService>("weather.read-refresh.v1", "apply");
        AddIf<IThemeService>("theme.app.transient.v1", "volatile");
        AddIf<IExactTimeService>("exact-time.read-sync.v1", "apply");
        // 时间偏移读写的唯一入口是宿主 SettingsService，公开 SDK 不导出它：
        // 反射桥解析成功才对外声明该能力，避免服务端下发永不生效的任务。
        if (timeOffset.Available) capabilities.Add(new("time.offset.persist.v1", "persist", 1));
        AddIf<IUriNavigationService>("uri.navigate.v1", "apply");
        AddIf<ISpeechService>("speech.queue.v1", "apply");
        AddIf<ITutorialService>("tutorial.control.v1", "apply");
        AddIf<IXamlThemeService>("theme.xaml.enabled.persist.v1", "persist");
        if (IPluginService.LoadedPlugins.Count >= 0) capabilities.Add(new("plugins.inventory.read.v1", "read", 1));
        capabilities.Add(new("notification.own-provider.send.v1", "apply", 1));
        return capabilities;

        void AddIf<T>(string id, string mode) where T : class
        {
            if (services.GetService<T>() is not null) capabilities.Add(new(id, mode, 1));
        }
    }
}
