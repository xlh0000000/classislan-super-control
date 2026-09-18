using System.Text.Json;
using Avalonia.Threading;
using ClassIsland.Core.Abstractions.Services;
using ClassIsland.Core.Models.Automation;
using ClassIsland.Core.Models.Components;
using ClassIsland.Shared.Models.Profile;
using Microsoft.Extensions.DependencyInjection;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>
/// 策略应用结果。Sections 为逐节状态（applied/failed/skipped），随轮询上报，
/// 使服务端能够区分“已下发/已尝试/真正生效”，而不是只依赖一个漂移计数。
/// </summary>
public sealed record PolicyApplyResult(bool Applied, int DriftCount, string? Error = null, IReadOnlyDictionary<string, string>? Sections = null);

public sealed class PolicyApplyService(
    IServiceProvider services,
    SettingsPolicyService settingsPolicy,
    TimeOffsetService timeOffset,
    PluginSettingsStore store,
    PolicySnapshotStore snapshots)
{
    private static readonly JsonSerializerOptions JsonOptions = HostJson.Options;

    /// <summary>
    /// 应用策略文档。注意：服务端下发的 locks 是“服务端层间合并锁”，
    /// 客户端不承诺硬锁，靠周期性上报 applied hash 由服务端做软锁对账。
    /// </summary>
    public async Task<PolicyApplyResult> ApplyAsync(JsonElement document)
    {
        var sections = new Dictionary<string, string>();
        string? current = null;
        try
        {
            var drift = 0;
            await Dispatcher.UIThread.InvokeAsync(() =>
            {
                if (document.TryGetProperty("profile", out var profileJson) && services.GetService<IProfileService>() is { } profileService)
                {
                    current = "profile";
                    var incoming = profileJson.Deserialize<Profile>(JsonOptions) ?? throw new InvalidOperationException("Invalid profile policy.");
                    // 公开 API 不支持整体替换且没有变更通知，必须对现有实例逐项合并，否则主界面不会刷新。
                    var currentProfile = profileService.Profile;
                    currentProfile.Name = incoming.Name;
                    currentProfile.IsOverlayClassPlanEnabled = incoming.IsOverlayClassPlanEnabled;
                    currentProfile.OverlayClassPlanId = incoming.OverlayClassPlanId;
                    currentProfile.SelectedClassPlanGroupId = incoming.SelectedClassPlanGroupId;
                    currentProfile.IsTempClassPlanGroupEnabled = incoming.IsTempClassPlanGroupEnabled;
                    currentProfile.TempClassPlanGroupType = incoming.TempClassPlanGroupType;
                    ReplaceContents<Guid, TimeLayout>(currentProfile.TimeLayouts, incoming.TimeLayouts);
                    ReplaceContents<Guid, ClassPlan>(currentProfile.ClassPlans, incoming.ClassPlans);
                    ReplaceContents<Guid, Subject>(currentProfile.Subjects, incoming.Subjects);
                    ReplaceContents<Guid, ClassPlanGroup>(currentProfile.ClassPlanGroups, incoming.ClassPlanGroups);
                    ReplaceContents<DateTime, OrderedSchedule>(currentProfile.OrderedSchedules, incoming.OrderedSchedules);
                    profileService.SaveProfile();
                    sections["profile"] = "applied";
                }
                if (document.TryGetProperty("components", out var componentsJson) && services.GetService<IComponentsService>() is { } componentsService)
                {
                    current = "components";
                    var components = componentsJson.Deserialize<ComponentProfile>(JsonOptions) ?? throw new InvalidOperationException("Invalid components policy.");
                    componentsService.CurrentComponents.Lines.Clear();
                    foreach (var line in components.Lines) componentsService.CurrentComponents.Lines.Add(line);
                    componentsService.SaveConfig();
                    sections["components"] = "applied";
                }
                if (document.TryGetProperty("automation", out var automationJson) && services.GetService<IAutomationService>() is { } automationService)
                {
                    current = "automation";
                    // 自动化节点兼容两种形态：裸数组（宿主文件原样）与配置库文档 { "workflows": [...] }。
                    List<Workflow>? workflows = automationJson.ValueKind switch
                    {
                        JsonValueKind.Array => automationJson.Deserialize<List<Workflow>>(JsonOptions),
                        JsonValueKind.Object when automationJson.TryGetProperty("workflows", out var nested) && nested.ValueKind == JsonValueKind.Array
                            => nested.Deserialize<List<Workflow>>(JsonOptions),
                        JsonValueKind.Object => [],
                        _ => null,
                    };
                    if (workflows is null) throw new InvalidOperationException("Invalid automation policy.");
                    automationService.Workflows.Clear();
                    foreach (var workflow in workflows) automationService.Workflows.Add(workflow);
                    automationService.SaveConfig("ClassIsland Control policy");
                    sections["automation"] = "applied";
                }
                if (settingsPolicy.Available)
                {
                    current = "settings";
                    // settings 节缺失表示“不锁定”：撤下策略即恢复本机可编辑。
                    settingsPolicy.Apply(document.TryGetProperty("settings", out var settingsJson) ? settingsJson : null);
                    sections["settings"] = "applied";
                }
                if (timeOffset.Available)
                {
                    current = "time";
                    // time 节缺失表示“不再调控”：恢复接管前的本机时间偏移。
                    timeOffset.Apply(document.TryGetProperty("time", out var timeJson) ? timeJson : null);
                    sections["time"] = "applied";
                }
                if (document.TryGetProperty("theme", out var themeJson) && services.GetService<IThemeService>() is { } themeService)
                {
                    current = "theme";
                    var mode = themeJson.TryGetProperty("mode", out var modeJson) ? modeJson.GetInt32() : themeService.CurrentRealThemeMode;
                    themeService.SetTheme(mode, null);
                    sections["theme"] = "applied";
                }
            });
            return new(true, drift, null, sections);
        }
        catch (Exception exception)
        {
            if (current is not null) sections[current] = "failed";
            return new(false, 1, exception.Message, sections);
        }
    }

    /// <summary>
    /// 启动时用服务端签名过的策略快照重新施加设置锁定。
    /// 本地改写/删除 ClassIsland 自己的 Policy.json 后重启无法解锁：快照签名由集控端私钥生成，
    /// 本机无法伪造。返回本次是否用到了快照。
    /// </summary>
    public bool ReapplyPersistedSettingsLocks()
    {
        if (!settingsPolicy.Available) return false;
        var state = store.State;
        var document = snapshots.ReadLatestVerified(state.ServerSigningPublicKey, state.ServerSigningKeyId);
        if (document is not { } value) return false;
        settingsPolicy.Apply(value.TryGetProperty("settings", out var section) ? section : null);
        // 时间偏移同样来自服务端签名的快照：本地改写 Settings.json 后重启会被折回。
        timeOffset.Apply(value.TryGetProperty("time", out var timeSection) ? timeSection : null);
        return true;
    }

    private static void ReplaceContents<TKey, TValue>(IDictionary<TKey, TValue> target, IDictionary<TKey, TValue> source) where TKey : notnull
    {
        target.Clear();
        foreach (var pair in source) target.Add(pair.Key, pair.Value);
    }
}