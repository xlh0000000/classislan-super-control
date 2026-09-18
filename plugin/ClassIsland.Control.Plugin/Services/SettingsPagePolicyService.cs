using System.Reflection;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ClassIsland.Core.Attributes;
using ClassIsland.Core.Services.Registry;
using Microsoft.Extensions.Logging;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>设置页大项的管控强度。</summary>
public enum SettingsPageControl
{
    /// <summary>不限制。</summary>
    None,
    /// <summary>可见但不可编辑（只读包装页）。</summary>
    ReadOnly,
    /// <summary>从导航与深链中整体隐藏。</summary>
    Hidden,
}

/// <summary>
/// 设置页逐项管控：把 settings 节的 <c>page.&lt;宿主页面 Id&gt;</c> 三态落到宿主设置窗口。
///
/// 宿主自身只有整片的 DisableSettingsEditing，没有逐页开关，因此这里直接操作公开可变的
/// <see cref="SettingsWindowRegistryService.Registered"/>：
/// - hidden：移除页条目——导航不出现，<c>classisland://app/settings/&lt;id&gt;</c> 深链同样查不到页；
/// - readonly：换成包装条目的克隆（Id 指向插件的只读包装页，真页以 IsEnabled=false 嵌在其中）。
///
/// 设置窗口是懒加载单例且导航只在构造时生成，所以已存在的窗口实例要在每次应用后反射调用其
/// 私有的 BuildNavigationMenuItems 重建；当前正停在被管控页上时同步改选目标页。
/// 宿主结构对不上（页面 Id 不存在、窗口类型缺失）时逐项静默降级，绝不让策略应用失败。
/// </summary>
public sealed class SettingsPagePolicyService(ILogger<SettingsPagePolicyService> logger)
{
    /// <summary>包装条目的 Id 前缀；包装页据此反推要内嵌的真页 Id。</summary>
    public const string WrapperPrefix = "classisland-control.ro.";

    /// <summary>可逐页管控的大设置项（Id 为宿主 SettingsPageInfo.Id）。与 shared/schemas.ts 的
    /// settingsPageFields 由 parity 测试对齐；集控页不列入，锁掉会把自己锁死。</summary>
    public static readonly IReadOnlyList<(string Id, string Label)> ManagedPages =
    [
        ("general", "基本"),
        ("clock", "时钟"),
        ("storage", "存储"),
        ("privacy", "隐私"),
        ("refreshing", "翻新与迎新"),
        ("advanced", "高级"),
        ("components", "组件"),
        ("appearance", "外观"),
        ("notification", "提醒"),
        ("window", "窗口"),
        ("weather", "天气"),
        ("automation", "自动化"),
        ("update", "更新"),
        ("classisland.plugins", "插件"),
        ("classisland.themes", "主题"),
    ];

    public static string WrapperId(string pageId) => WrapperPrefix + pageId;

    // 首次应用前抓取的原生条目快照：宿主升级新增/删除页时以当时的 Registered 为准。
    private readonly Dictionary<string, SettingsPageInfo> _originals = new();
    private bool _snapshotted;
    private WeakReference<Window>? _windowRef;

    /// <summary>应用逐页管控，返回生效条目的显示文案（如“时钟（隐藏）”）。</summary>
    public IReadOnlyList<string> Apply(IReadOnlyDictionary<string, SettingsPageControl> controls)
    {
        var active = new List<string>();
        Dispatcher.UIThread.Invoke(() =>
        {
            EnsureSnapshot();
            foreach (var (pageId, label) in ManagedPages)
            {
                var control = controls.TryGetValue(pageId, out var value) ? value : SettingsPageControl.None;
                if (!_originals.TryGetValue(pageId, out var original)) continue;
                // None 也要换：上一轮的只读/隐藏必须在这里还原为原生条目。
                SwapEntry(pageId, original, control);
                if (control != SettingsPageControl.None)
                    active.Add(control == SettingsPageControl.Hidden ? $"{label}（隐藏）" : $"{label}（只读）");
            }
            ReconcileOpenWindow(controls);
        });
        return active;
    }

    private void EnsureSnapshot()
    {
        if (_snapshotted) return;
        _snapshotted = true;
        foreach (var (pageId, _) in ManagedPages)
        {
            var info = SettingsWindowRegistryService.Registered.FirstOrDefault(x => x.Id == pageId);
            if (info is not null) _originals[pageId] = info;
        }
        // 策略可能在宿主注册完成前就被恢复应用；注册表当时还不全时，等下次应用再抓。
        if (_originals.Count == 0) _snapshotted = false;
    }

    /// <summary>把注册表里该页的当前条目（原生或包装）替换为目标形态，保持原有位置。</summary>
    private void SwapEntry(string pageId, SettingsPageInfo original, SettingsPageControl control)
    {
        var registry = SettingsWindowRegistryService.Registered;
        var current = registry.FirstOrDefault(x => x.Id == pageId || x.Id == WrapperId(pageId));
        var index = current is not null ? registry.IndexOf(current) : -1;
        SettingsPageInfo? desired = control switch
        {
            SettingsPageControl.Hidden => null,
            SettingsPageControl.ReadOnly => CreateWrapperInfo(original),
            _ => original,
        };
        if (current is null && desired is null) return;
        if (current is not null)
        {
            if (desired is null) registry.RemoveAt(index);
            else if (!Equals(current, desired)) registry[index] = desired;
            return;
        }
        if (desired is not null)
        {
            // 之前被隐藏导致位置丢失：按快照顺序就近插回（前邻之后，否则表头）。
            var insertAt = 0;
            foreach (var (otherId, _) in ManagedPages)
            {
                if (otherId == pageId) break;
                if (_originals.TryGetValue(otherId, out var other))
                {
                    var live = registry.FirstOrDefault(x => Equals(x, other) || x.Id == WrapperId(otherId));
                    if (live is not null) insertAt = registry.IndexOf(live) + 1;
                }
            }
            registry.Insert(Math.Min(insertAt, registry.Count), desired);
        }
    }

    /// <summary>克隆原生条目，只把 Id 换成包装页；名称、图标、分组、类别全部照抄。</summary>
    private static SettingsPageInfo? CreateWrapperInfo(SettingsPageInfo original)
    {
        try
        {
            var clone = new SettingsPageInfo(
                WrapperId(original.Id), original.Name,
                ReadIconExpression(original, "_unSelectedIconExpression", "UnSelectedIconGlyph", "\uef27"),
                ReadIconExpression(original, "_selectedIconExpression", "SelectedIconGlyph", "\uef26"),
                false, original.Category);
            CopyNonPublicProperty(original, clone, nameof(SettingsPageInfo.GroupId));
            CopyNonPublicProperty(original, clone, nameof(SettingsPageInfo.UseFullWidth));
            CopyNonPublicProperty(original, clone, nameof(SettingsPageInfo.HidePageTitle));
            return clone;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>图标表达式在 2.1.1 是私有字段、在 master 上是公开属性；两种宿主形状都能取到。</summary>
    private static string ReadIconExpression(SettingsPageInfo info, string fieldName, string propertyName, string fallback)
    {
        try
        {
            var type = typeof(SettingsPageInfo);
            if (type.GetField(fieldName, BindingFlags.Instance | BindingFlags.NonPublic)?.GetValue(info) is string field)
                return field;
            if (type.GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public)?.GetValue(info) is string property)
                return property;
        }
        catch (Exception)
        {
            // 取不到图标就退回默认字形，管控本身不能因此失败。
        }
        return fallback;
    }

    private static void CopyNonPublicProperty(SettingsPageInfo from, SettingsPageInfo to, string name)
    {
        var property = typeof(SettingsPageInfo).GetProperty(name,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        property?.SetValue(to, property.GetValue(from));
    }

    private void ReconcileOpenWindow(IReadOnlyDictionary<string, SettingsPageControl> controls)
    {
        var window = ResolveSettingsWindow();
        if (window is null) return;
        try
        {
            window.GetType()
                .GetMethod("BuildNavigationMenuItems", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)
                ?.Invoke(window, null);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Failed to rebuild the settings navigation after a policy change.");
        }

        try
        {
            var viewModel = window.GetType().GetProperty("ViewModel",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(window);
            var selectedProperty = viewModel?.GetType().GetProperty("SelectedPageInfo");
            var selected = selectedProperty?.GetValue(viewModel) as SettingsPageInfo;
            if (selected is null) return;
            // 当前停留的页刚被管控：导航到对应形态（只读→包装页，隐藏→关于页）。
            if (controls.TryGetValue(selected.Id, out var control) && control != SettingsPageControl.None)
            {
                SettingsPageInfo? target = control == SettingsPageControl.ReadOnly
                    ? SettingsWindowRegistryService.Registered.FirstOrDefault(x => x.Id == WrapperId(selected.Id))
                    : SettingsWindowRegistryService.Registered.FirstOrDefault(x => x.Id == "about");
                if (target is not null) selectedProperty!.SetValue(viewModel, target);
            }
            else if (!SettingsWindowRegistryService.Registered.Contains(selected) &&
                     SettingsWindowRegistryService.Registered.FirstOrDefault(x => x.Id == "about") is { } about)
            {
                // 条目可能在窗口构建后被别处移除：兜底跳关于页，避免停留幽灵页。
                selectedProperty!.SetValue(viewModel, about);
            }
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Failed to redirect the settings window after a policy change.");
        }
    }

    private Window? ResolveSettingsWindow()
    {
        if (_windowRef is not null && _windowRef.TryGetTarget(out var cached) && cached is not null)
            return cached;
        if (Avalonia.Application.Current?.ApplicationLifetime is not IClassicDesktopStyleApplicationLifetime desktop)
            return null;
        var window = desktop.Windows.FirstOrDefault(w => w.GetType().FullName == "ClassIsland.Views.SettingsWindowNew");
        if (window is not null) _windowRef = new WeakReference<Window>(window);
        return window;
    }
}
