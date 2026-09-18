using System.Text.Json;
using ClassIsland.Core.Abstractions.Services.Management;
using ClassIsland.Shared.Models.Management;
using Microsoft.Extensions.DependencyInjection;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>
/// 设置锁定：把控制平面策略里的 settings 节映射到宿主自带的 ManagementPolicy，
/// 并把 `page.&lt;页 Id&gt;` 三态键交给 SettingsPagePolicyService 做逐页管控。
///
/// 宿主的 ManagementPolicy 只覆盖 9 个粗粒度开关；设置页逐项的隐藏/只读由注册表操作实现。
/// 策略中不存在 settings 节时回落到“不锁定”，保证撤下策略即可恢复本机可编辑。
/// </summary>
public sealed class SettingsPolicyService(IServiceProvider services, SettingsPagePolicyService pagePolicy, AgentStatus status)
{
    /// <summary>可被集控端锁定的设置项：策略键 → 显示名。</summary>
    public static readonly IReadOnlyList<(string Key, string Label, string Hint)> SettableLocks =
    [
        ("disableProfileEditing", "档案编辑", "课表、时间表、科目等档案整体只读"),
        ("disableProfileClassPlanEditing", "课表编辑", "禁止修改课表"),
        ("disableProfileTimeLayoutEditing", "时间表编辑", "禁止修改时间表"),
        ("disableProfileSubjectsEditing", "科目编辑", "禁止修改科目"),
        ("disableSettingsEditing", "应用设置", "禁止进入应用设置页"),
        ("disableSplashCustomize", "启动画面自定义", "禁止自定义启动画面"),
        ("disableDebugMenu", "调试菜单", "隐藏调试设置页"),
        ("disableEasterEggs", "隐藏彩蛋", "关闭彩蛋入口"),
        ("allowExitManagement", "禁止本机退出集控", "开启后本机无法自行退出，仅集控端可解除"),
    ];

    private IManagementService? Management => services.GetService<IManagementService>();

    /// <summary>宿主是否提供策略接口；不可用时设置锁定降级为“仅展示”。</summary>
    public bool Available => Management is not null;

    /// <summary>不锁定时的基线值。</summary>
    private static bool Baseline(string key) => key == "allowExitManagement";

    /// <summary>
    /// 应用 settings 节。section 为 null（或策略撤下该节）表示回到不锁定。
    /// 返回实际生效的锁定项显示名，供设备端展示与上报。
    /// </summary>
    public IReadOnlyList<string> Apply(JsonElement? section)
    {
        var objectSection = section is { ValueKind: JsonValueKind.Object } element ? element : (JsonElement?)null;
        var active = new List<string>();
        // 逐页管控不依赖 ManagementService：注册表操作在只有旧版宿主策略接口时同样可行。
        active.AddRange(pagePolicy.Apply(ReadPageControls(objectSection)));
        var management = Management;
        if (management is null)
        {
            status.SettingsPolicyApplied(active);
            return active;
        }
        var policy = management.Policy;
        foreach (var (key, label, _) in SettableLocks)
        {
            var value = Baseline(key);
            if (objectSection is { } element2 &&
                element2.TryGetProperty(key, out var property) &&
                property.ValueKind is JsonValueKind.True or JsonValueKind.False)
                value = property.GetBoolean();
            Assign(policy, key, value);
            var locked = key == "allowExitManagement" ? !value : value;
            if (locked) active.Add(label);
        }
        status.SettingsPolicyApplied(active);
        return active;
    }

    /// <summary>从 settings 节解析 `page.&lt;页 Id&gt;` 三态键；无法识别的取值一律按不限制处理。</summary>
    private static IReadOnlyDictionary<string, SettingsPageControl> ReadPageControls(JsonElement? section)
    {
        var controls = new Dictionary<string, SettingsPageControl>();
        if (section is not { } element) return controls;
        foreach (var property in element.EnumerateObject())
        {
            if (!property.Name.StartsWith("page.")) continue;
            if (property.Value.ValueKind != JsonValueKind.String) continue;
            var pageId = property.Name["page.".Length..];
            controls[pageId] = property.Value.GetString() switch
            {
                "hidden" => SettingsPageControl.Hidden,
                "readonly" => SettingsPageControl.ReadOnly,
                _ => SettingsPageControl.None,
            };
        }
        return controls;
    }

    private static void Assign(ManagementPolicy policy, string key, bool value)
    {
        switch (key)
        {
            case "disableProfileEditing": policy.DisableProfileEditing = value; break;
            case "disableProfileClassPlanEditing": policy.DisableProfileClassPlanEditing = value; break;
            case "disableProfileTimeLayoutEditing": policy.DisableProfileTimeLayoutEditing = value; break;
            case "disableProfileSubjectsEditing": policy.DisableProfileSubjectsEditing = value; break;
            case "disableSettingsEditing": policy.DisableSettingsEditing = value; break;
            case "disableSplashCustomize": policy.DisableSplashCustomize = value; break;
            case "disableDebugMenu": policy.DisableDebugMenu = value; break;
            case "disableEasterEggs": policy.DisableEasterEggs = value; break;
            case "allowExitManagement": policy.AllowExitManagement = value; break;
        }
    }
}