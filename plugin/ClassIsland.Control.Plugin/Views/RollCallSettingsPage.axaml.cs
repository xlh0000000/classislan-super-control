using Avalonia.Interactivity;
using Avalonia.Threading;
using ClassIsland.Control.Plugin.Services;
using ClassIsland.Core.Abstractions.Controls;
using ClassIsland.Core.Attributes;
using ClassIsland.Core.Enums.SettingsWindow;
using ClassIsland.Shared;

namespace ClassIsland.Control.Plugin.Views;

/// <summary>
/// 点名悬浮窗的设置页，挂在“点名”二级菜单下。
/// 名单来自集控端，本页只调本机外观与展示节奏；
/// 归入“关于”类别，与接入页一样在集控端锁定“应用设置”时保持可达。
/// </summary>
[SettingsPageInfo("classisland-control.rollcall", "点名悬浮窗", "\uecab", "\uecaa", SettingsPageCategory.About)]
[GroupAttribute("classisland-control.rollcall")]
public partial class RollCallSettingsPage : SettingsPageBase
{
    private readonly PluginSettingsStore _store;
    private readonly RollCallService _service;
    private bool _loading;

    [Obsolete("Only used by the XAML loader.")]
    public RollCallSettingsPage()
        : this(IAppHost.GetService<PluginSettingsStore>(), IAppHost.GetService<RollCallService>())
    {
    }

    public RollCallSettingsPage(PluginSettingsStore store, RollCallService service)
    {
        _store = store;
        _service = service;
        InitializeComponent();

        var settings = store.Settings;
        _loading = true;
        WidthBox.Value = (decimal)settings.RollCallWidth;
        HeightBox.Value = (decimal)settings.RollCallHeight;
        OpacityBox.Value = (decimal)settings.RollCallOpacity;
        SingleBox.Value = settings.RollCallSingleSeconds;
        MultiBox.Value = settings.RollCallMultiSeconds;
        NotifySwitch.IsChecked = settings.RollCallNotify;
        EnableSwitch.IsChecked = _service.IsVisible;
        _loading = false;

        EnableSwitch.IsCheckedChanged += OnChanged;
        NotifySwitch.IsCheckedChanged += OnChanged;
        WidthBox.ValueChanged += OnChanged;
        HeightBox.ValueChanged += OnChanged;
        OpacityBox.ValueChanged += OnChanged;
        SingleBox.ValueChanged += OnChanged;
        MultiBox.ValueChanged += OnChanged;
        RenderRoster();
    }

    protected override void OnAttachedToVisualTree(Avalonia.VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        _service.StateChanged += OnStateChanged;
        _service.Roster.Changed += OnStateChanged;
        RenderRoster();
        // 悬浮窗可能被系统关闭过：以真实可见状态为准刷新开关。
        _loading = true;
        EnableSwitch.IsChecked = _service.IsVisible;
        _loading = false;
    }

    protected override void OnDetachedFromVisualTree(Avalonia.VisualTreeAttachmentEventArgs e)
    {
        _service.StateChanged -= OnStateChanged;
        _service.Roster.Changed -= OnStateChanged;
        base.OnDetachedFromVisualTree(e);
    }

    private void OnStateChanged() => Dispatcher.UIThread.Post(RenderRoster);

    private void RenderRoster()
    {
        var count = _service.Roster.Names.Count;
        var revision = _service.Roster.Snapshot.Revision;
        RosterText.Text = count > 0
            ? $"已同步 {count} 人 · R{revision}"
            : revision > 0 ? "下发的名单为空" : "尚未下发名单";
        if (_loading) return;
        _loading = true;
        EnableSwitch.IsChecked = _service.IsVisible;
        _loading = false;
    }

    private async void OnChanged(object? sender, EventArgs e)
    {
        if (_loading) return;
        var settings = _store.Settings with
        {
            RollCallEnabled = EnableSwitch.IsChecked == true,
            RollCallNotify = NotifySwitch.IsChecked == true,
            RollCallWidth = (double)(WidthBox.Value ?? 260m),
            RollCallHeight = (double)(HeightBox.Value ?? 112m),
            RollCallOpacity = (double)(OpacityBox.Value ?? 0.8m),
            RollCallSingleSeconds = (int)(SingleBox.Value ?? 3m),
            RollCallMultiSeconds = (int)(MultiBox.Value ?? 6m),
        };
        try
        {
            // 立即落盘：外观改动应当马上生效，并在重启后保持。
            await _store.SaveSettingsAsync(settings);
        }
        catch { /* 保存失败不影响本次预览；下次改动会重试。 */ }
        if (settings.RollCallEnabled) _service.Show();
        else _service.Hide();
        _service.ReapplySettings();
    }

    private async void ResetButton_OnClick(object? sender, RoutedEventArgs e)
    {
        try
        {
            await _store.SaveSettingsAsync(_store.Settings with { RollCallX = null, RollCallY = null });
        }
        catch { /* 位置重置失败只影响下次启动的落点。 */ }
        _service.ResetPosition();
    }
}