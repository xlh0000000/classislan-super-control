using System.Text.Json;
using System.Text.Json.Serialization;
using Avalonia.Media;
using Avalonia.Threading;
using ClassIsland.Core;
using ClassIsland.Core.Abstractions.Services;
using ClassIsland.Core.Abstractions.Services.SpeechService;
using ClassIsland.Core.Models.Automation;
using ClassIsland.Core.Models.Components;
using ClassIsland.Shared.Models.Profile;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace ClassIsland.Control.Plugin.Services;

public sealed record RemoteCommand(
    string CommandId,
    string CapabilityId,
    JsonElement Payload,
    DateTime ExpiresAtUtc,
    int SchemaVersion = 1,
    DateTime NotBeforeUtc = default);

public sealed class HostOperationService(
    IServiceProvider services,
    PluginSettingsStore store,
    SettingsPolicyService settingsPolicy,
    TimeOffsetService timeOffset,
    TimetableSnapshotService timetableSnapshot)
{
    public const int SupportedSchemaVersion = 1;

    private RemoteNotificationProvider Notifications => services.GetServices<IHostedService>().OfType<RemoteNotificationProvider>().Single();
    private static readonly JsonSerializerOptions JsonOptions = HostJson.Options;

    /// <summary>
    /// 执行设备命令。onTerminating 会在进程被命令终止前调用，用于先持久化回执，避免 ACK 丢失。
    /// </summary>
    public async Task<CommandResult> ExecuteAsync(RemoteCommand command, Func<CommandResult, Task>? onTerminating = null)
    {
        if (command.SchemaVersion != SupportedSchemaVersion)
            return new(command.CommandId, "unsupported", new { error = "unsupported-schema-version", command.SchemaVersion });
        var now = DateTime.UtcNow;
        if (command.NotBeforeUtc != default && command.NotBeforeUtc - now > TimeSpan.FromMinutes(5))
            return new(command.CommandId, "conflict", new { error = "not-before", notBeforeUtc = command.NotBeforeUtc });
        if (command.ExpiresAtUtc <= now) return new(command.CommandId, "expired");
        try
        {
            return command.CapabilityId switch
            {
                "app.lifecycle.v1" => await Lifecycle(command, onTerminating),
                "app.window.basic.volatile.v1" => await Window(command),
                "profile.readwrite.persist.v1" => await ApplyProfile(command),
                "components.layout.persist.v1" => await ApplyComponents(command),
                "automation.workflow.persist.v1" => await ApplyAutomation(command),
                "lessons.state.read.v1" => LessonsState(command),
                "weather.read-refresh.v1" => await RefreshWeather(command),
                "theme.app.transient.v1" => await ApplyTheme(command),
                "exact-time.read-sync.v1" => await SyncExactTime(command),
                "uri.navigate.v1" => Navigate(command),
                "notification.own-provider.send.v1" => await Notify(command),
                "speech.queue.v1" => Speech(command),
                "tutorial.control.v1" => await Tutorial(command),
                "theme.xaml.enabled.persist.v1" => await ApplyXamlThemes(command),
                "plugins.inventory.read.v1" => PluginInventory(command),
                "enrollment.release.v1" => await ReleaseEnrollment(command),
                "time.offset.persist.v1" => TimeOffsetCommand(command),
                "enrollment.lock.v1" => await ReconcileEnrollmentLock(command),
                "settings.policy.persist.v1" => SettingsPolicy(command),
                "timetable.upload.v1" => TimetableUpload(command),
                _ => new(command.CommandId, "unsupported", new { command.CapabilityId }),
            };
        }
        catch (Exception exception)
        {
            return new(command.CommandId, "failed", new { error = exception.Message });
        }
    }

    private static async Task<CommandResult> Lifecycle(RemoteCommand command, Func<CommandResult, Task>? onTerminating)
    {
        var action = command.Payload.GetProperty("action").GetString();
        if (action is not ("restart" or "stop")) throw new InvalidOperationException("Unsupported lifecycle action.");
        var result = new CommandResult(command.CommandId, "succeeded", new { action });
        // 进程会在下一步终止，必须先落盘回执，否则 ACK 永远不会到达服务端。
        if (onTerminating is not null) await onTerminating(result);
        await Dispatcher.UIThread.InvokeAsync(() =>
        {
            if (action == "restart") AppBase.Current.Restart(true);
            else AppBase.Current.Stop();
        });
        return result;
    }

    private static async Task<CommandResult> Window(RemoteCommand command)
    {
        var action = command.Payload.GetProperty("action").GetString();
        await Dispatcher.UIThread.InvokeAsync(() =>
        {
            var window = AppBase.Current.MainWindow ?? throw new InvalidOperationException("Main window is not ready.");
            if (action == "show") { window.Show(); window.Activate(); }
            else if (action == "hide") window.Hide();
            else throw new InvalidOperationException("Unsupported window action.");
        });
        return new(command.CommandId, "succeeded");
    }

    private async Task<CommandResult> ApplyProfile(RemoteCommand command)
    {
        var service = services.GetRequiredService<IProfileService>();
        var incoming = command.Payload.GetProperty("profile").Deserialize<Profile>(JsonOptions) ?? throw new InvalidOperationException("Profile is invalid.");
        await Dispatcher.UIThread.InvokeAsync(() =>
        {
            // 公开 API 没有整体替换或变更通知，只能对现有实例的公开成员逐项合并，
            // 否则主界面缓存的旧 Profile 引用不会刷新。
            var current = service.Profile;
            current.Name = incoming.Name;
            current.IsOverlayClassPlanEnabled = incoming.IsOverlayClassPlanEnabled;
            current.OverlayClassPlanId = incoming.OverlayClassPlanId;
            current.SelectedClassPlanGroupId = incoming.SelectedClassPlanGroupId;
            current.IsTempClassPlanGroupEnabled = incoming.IsTempClassPlanGroupEnabled;
            current.TempClassPlanGroupType = incoming.TempClassPlanGroupType;
            ReplaceContents<Guid, TimeLayout>(current.TimeLayouts, incoming.TimeLayouts);
            ReplaceContents<Guid, ClassPlan>(current.ClassPlans, incoming.ClassPlans);
            ReplaceContents<Guid, Subject>(current.Subjects, incoming.Subjects);
            ReplaceContents<Guid, ClassPlanGroup>(current.ClassPlanGroups, incoming.ClassPlanGroups);
            ReplaceContents<DateTime, OrderedSchedule>(current.OrderedSchedules, incoming.OrderedSchedules);
            service.SaveProfile();
        });
        return new(command.CommandId, "succeeded");
    }

    private async Task<CommandResult> ApplyComponents(RemoteCommand command)
    {
        var service = services.GetRequiredService<IComponentsService>();
        var profile = command.Payload.GetProperty("components").Deserialize<ComponentProfile>(JsonOptions)
            ?? throw new InvalidOperationException("Component profile is invalid.");
        await Dispatcher.UIThread.InvokeAsync(() =>
        {
            // 原位替换 Lines，保留宿主与 ComponentsService 已挂在旧集合上的自动保存钩子。
            service.CurrentComponents.Lines.Clear();
            foreach (var line in profile.Lines) service.CurrentComponents.Lines.Add(line);
            service.SaveConfig();
        });
        return new(command.CommandId, "succeeded");
    }

    private async Task<CommandResult> ApplyAutomation(RemoteCommand command)
    {
        var service = services.GetRequiredService<IAutomationService>();
        var workflows = command.Payload.GetProperty("workflows").Deserialize<List<Workflow>>(JsonOptions)
            ?? throw new InvalidOperationException("Automation workflow list is invalid.");
        await Dispatcher.UIThread.InvokeAsync(() =>
        {
            // 集合变更会触发工作流的 Unload/Load，必须在 UI 线程原位替换，不能整体赋值。
            service.Workflows.Clear();
            foreach (var workflow in workflows) service.Workflows.Add(workflow);
            service.SaveConfig("ClassIsland Control command");
        });
        return new(command.CommandId, "succeeded");
    }

    private CommandResult LessonsState(RemoteCommand command)
    {
        var service = services.GetRequiredService<ILessonsService>();
        return new(command.CommandId, "succeeded", new
        {
            isTimerRunning = service.IsTimerRunning,
            isClassPlanLoaded = service.IsClassPlanLoaded,
            isClassPlanEnabled = service.IsClassPlanEnabled,
            isLessonConfirmed = service.IsLessonConfirmed,
            currentState = service.CurrentState.ToString(),
            currentSelectedIndex = service.CurrentSelectedIndex,
            currentSubject = service.CurrentSubject?.Name,
            nextClassSubject = service.NextClassSubject?.Name,
            currentClassPlan = service.CurrentClassPlan?.Name,
            onClassLeftSeconds = (int)service.OnClassLeftTime.TotalSeconds,
            onBreakingTimeLeftSeconds = (int)service.OnBreakingTimeLeftTime.TotalSeconds,
        });
    }

    private async Task<CommandResult> RefreshWeather(RemoteCommand command)
    {
        var service = services.GetRequiredService<IWeatherService>();
        Func<Task> query = service.QueryWeatherAsync;
        await Dispatcher.UIThread.InvokeAsync(query);
        return new(command.CommandId, "succeeded");
    }

    private async Task<CommandResult> ApplyTheme(RemoteCommand command)
    {
        var mode = command.Payload.GetProperty("mode").GetInt32();
        Color? color = null;
        if (command.Payload.TryGetProperty("primary", out var primary) &&
            Color.TryParse(primary.GetString(), out var parsed)) color = parsed;
        var service = services.GetRequiredService<IThemeService>();
        await Dispatcher.UIThread.InvokeAsync(() => service.SetTheme(mode, color));
        return new(command.CommandId, "succeeded");
    }

    /// <summary>
    /// 一次性时间偏移：与策略 time 节共用同一套语义（auto 优先，其次固定秒数）。
    /// </summary>
    private CommandResult TimeOffsetCommand(RemoteCommand command)
    {
        if (!timeOffset.Available)
            return new(command.CommandId, "unsupported", new { error = "host-settings-unavailable" });
        var auto = command.Payload.TryGetProperty("auto", out var autoValue) && autoValue.ValueKind == JsonValueKind.True;
        double? offset = command.Payload.TryGetProperty("offsetSeconds", out var offsetValue)
                         && offsetValue.ValueKind == JsonValueKind.Number
                         && offsetValue.TryGetDouble(out var parsed)
            ? parsed
            : null;
        if (!auto && offset is null)
            return new(command.CommandId, "conflict", new { error = "missing-offset-seconds" });
        timeOffset.ApplyValues(auto, offset);
        return new(command.CommandId, "succeeded", new { auto, offsetSeconds = offset });
    }

    private async Task<CommandResult> SyncExactTime(RemoteCommand command)
    {
        var service = services.GetRequiredService<IExactTimeService>();
        // 校时是阻塞式网络调用，放在后台线程，避免冻结 UI 线程。
        await Task.Run(() => service.Sync());
        return new(command.CommandId, "succeeded");
    }

    private CommandResult Navigate(RemoteCommand command)
    {
        var value = command.Payload.GetProperty("uri").GetString() ?? throw new InvalidOperationException("URI is required.");
        var uri = new Uri(value, UriKind.Absolute);
        if (uri.Scheme != IUriNavigationService.UriScheme) throw new InvalidOperationException("Only classisland: URIs are allowed.");
        services.GetRequiredService<IUriNavigationService>().NavigateWrapped(uri, out var error);
        if (error is not null) throw error;
        return new(command.CommandId, "succeeded");
    }

    private CommandResult Speech(RemoteCommand command)
    {
        var service = services.GetRequiredService<ISpeechService>();
        var action = command.Payload.GetProperty("action").GetString();
        if (action == "clear") service.ClearSpeechQueue();
        else if (action == "enqueue") service.EnqueueSpeechQueue(command.Payload.GetProperty("text").GetString() ?? "");
        else throw new InvalidOperationException("Unsupported speech action.");
        return new(command.CommandId, "succeeded");
    }

    private async Task<CommandResult> Tutorial(RemoteCommand command)
    {
        var service = services.GetRequiredService<ITutorialService>();
        var action = command.Payload.GetProperty("action").GetString();
        await Dispatcher.UIThread.InvokeAsync(() =>
        {
            if (action == "stop") service.StopTutorial();
            else if (action == "skip") service.SkipTutorial();
            else if (action == "reset") service.ResetTutorialCompletedState();
            else if (action == "begin") service.BeginTutorial(command.Payload.GetProperty("path").GetString() ?? "");
            else throw new InvalidOperationException("Unsupported tutorial action.");
        });
        return new(command.CommandId, "succeeded");
    }

    private async Task<CommandResult> ApplyXamlThemes(RemoteCommand command)
    {
        var service = services.GetRequiredService<IXamlThemeService>();
        var enabled = command.Payload.GetProperty("enabled").Deserialize<List<string>>(JsonOptions) ?? [];
        await Dispatcher.UIThread.InvokeAsync(() =>
        {
            service.EnabledThemes.Clear();
            foreach (var id in enabled) service.EnabledThemes.Add(id);
        });
        return new(command.CommandId, "succeeded");
    }

    private static CommandResult PluginInventory(RemoteCommand command) =>
        new(command.CommandId, "succeeded", new
        {
            plugins = IPluginService.LoadedPlugins.Select(plugin => new { plugin.Manifest.Id, plugin.Manifest.Name, plugin.Manifest.Version }).ToArray()
        });

    private async Task<CommandResult> Notify(RemoteCommand command)
    {
        var title = command.Payload.GetProperty("title").GetString() ?? "远程通知";
        var content = command.Payload.GetProperty("content").GetString() ?? "";
        await Dispatcher.UIThread.InvokeAsync(() => Notifications.Send(title, content));
        return new(command.CommandId, "succeeded");
    }

    /// <summary>
    /// 入网锁定对账：用集控端给出的服务器地址重建身份锁与封条，
    /// 修复本地配置文件被改写（例如被改接到其他集控）的设备。
    /// </summary>
    private async Task<CommandResult> ReconcileEnrollmentLock(RemoteCommand command)
    {
        if (string.IsNullOrWhiteSpace(store.State.DeviceId))
            return new(command.CommandId, "succeeded", new { locked = false, reason = "not-enrolled" });
        var serverUrl = command.Payload.TryGetProperty("serverUrl", out var value) ? value.GetString() : null;
        if (!string.IsNullOrWhiteSpace(serverUrl) &&
            (!Uri.TryCreate(serverUrl, UriKind.Absolute, out var uri) ||
             (uri.Scheme != Uri.UriSchemeHttps && uri.Host is not ("localhost" or "127.0.0.1"))))
            throw new InvalidOperationException("Control plane address must use HTTPS.");
        var repaired = await store.RepairEnrollmentAsync(serverUrl);
        return new(command.CommandId, "succeeded", new { locked = true, repaired });
    }

    /// <summary>
    /// 解除集控：这是唯一能清除设备入网身份的路径，必须由集控端显式下发。
    /// payload 需携带本设备 ID，避免误投的解除命令让另一台设备掉线。
    /// </summary>
    private async Task<CommandResult> ReleaseEnrollment(RemoteCommand command)
    {
        var current = store.State.DeviceId;
        if (string.IsNullOrWhiteSpace(current))
            return new(command.CommandId, "succeeded", new { released = false, reason = "not-enrolled" });
        var target = command.Payload.TryGetProperty("deviceId", out var deviceId) ? deviceId.GetString() : null;
        if (string.IsNullOrWhiteSpace(target))
            throw new InvalidOperationException("Release command must carry the target device id.");
        if (!string.Equals(target, current, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Release target does not match this device.");
        var reason = command.Payload.TryGetProperty("reason", out var value) ? value.GetString() : null;
        // 先登记解除，等轮询循环确认回执送达后才真正清空身份。
        await store.RequestReleaseAsync(command.CommandId, reason);
        return new(command.CommandId, "succeeded", new { released = true, pendingAcknowledgement = true, reason });
    }

    /// <summary>按控制平面下发的 settings 节锁定/解锁宿主设置项。</summary>
    private CommandResult SettingsPolicy(RemoteCommand command)
    {
        if (!settingsPolicy.Available)
            return new(command.CommandId, "unsupported", new { error = "host-policy-unavailable" });
        var applied = settingsPolicy.Apply(command.Payload);
        return new(command.CommandId, "succeeded", new { applied });
    }

    /// <summary>
    /// 课表上报（贡献者：威廉）：课表上传本质是客户端主动上报，本分支供集控端主动催收——
    /// 下发 report-now 命令强制下一次轮询携带全量课表快照，并回读当前摘要与各类计数用于对账。
    /// </summary>
    private CommandResult TimetableUpload(RemoteCommand command)
    {
        var action = command.Payload.TryGetProperty("action", out var value) ? value.GetString() : null;
        if (action != "report-now")
            throw new InvalidOperationException("Unsupported timetable action.");
        timetableSnapshot.ForceRetransmit();
        return new(command.CommandId, "succeeded", new
        {
            digest = timetableSnapshot.Digest,
            subjectsCount = timetableSnapshot.SubjectsCount,
            timeLayoutsCount = timetableSnapshot.TimeLayoutsCount,
            classPlansCount = timetableSnapshot.ClassPlansCount,
            classPlanGroupsCount = timetableSnapshot.ClassPlanGroupsCount,
        });
    }

    private static void ReplaceContents<TKey, TValue>(IDictionary<TKey, TValue> target, IDictionary<TKey, TValue> source) where TKey : notnull
    {
        target.Clear();
        foreach (var pair in source) target.Add(pair.Key, pair.Value);
    }
}