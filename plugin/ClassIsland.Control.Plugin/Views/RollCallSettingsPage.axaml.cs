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
/// 名单优先用集控端下发的，没收到时用本页维护的本机名字表；
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
        LocalNamesBox.Text = string.Join(Environment.NewLine, settings.RollCallLocalNames);
        _loading = false;

        EnableSwitch.IsCheckedChanged += OnChanged;
        NotifySwitch.IsCheckedChanged += OnChanged;
        WidthBox.ValueChanged += OnChanged;
        HeightBox.ValueChanged += OnChanged;
        OpacityBox.ValueChanged += OnChanged;
        SingleBox.ValueChanged += OnChanged;
        MultiBox.ValueChanged += OnChanged;
        LocalNamesBox.LostFocus += OnLocalNamesChanged;
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
        // 光标还没移出输入框就直接切页时补一次保存，避免改完名字丢内容。
        _ = SaveLocalNamesAsync();
        base.OnDetachedFromVisualTree(e);
    }

    private void OnStateChanged() => Dispatcher.UIThread.Post(RenderRoster);

    private void RenderRoster()
    {
        if (_service.Roster.HasServerRoster)
        {
            var count = _service.Roster.Names.Count;
            RosterText.Text = count > 0
                ? $"已同步 {count} 人 · R{_service.Roster.Snapshot.Revision}"
                : "下发的名单为空";
            RosterSourceText.Text = "点名用的是集控端名单，本机名单已让位。";
        }
        else
        {
            // 还没收到集控端名单：本机名单就是点名用的那份。
            var local = ReadLocalNames().Count;
            RosterText.Text = "还没收到";
            RosterSourceText.Text = local > 0
                ? $"点名用的是下面这份本机名单（{local} 人）。"
                : "还没收到集控端名单：先在这里填本机名单，就能点名。";
        }
        if (_loading) return;
        _loading = true;
        EnableSwitch.IsChecked = _service.IsVisible;
        _loading = false;
    }

    /// <summary>本机名字表：按行拆分、去空白、去重，保持用户填写的先后顺序。</summary>
    private List<string> ReadLocalNames()
    {
        var lines = (LocalNamesBox.Text ?? string.Empty)
            .Split(new[] { (char)13, (char)10 }, StringSplitOptions.RemoveEmptyEntries);
        var names = new List<string>();
        foreach (var line in lines)
        {
            var name = line.Trim();
            if (name.Length > 0 && !names.Contains(name, StringComparer.Ordinal)) names.Add(name);
        }
        return names;
    }

    private async void OnLocalNamesChanged(object? sender, RoutedEventArgs e) => await SaveLocalNamesAsync();

    /// <summary>把本机名字表落盘；没收到集控端名单时，点名就用它。</summary>
    private async Task SaveLocalNamesAsync()
    {
        var names = ReadLocalNames();
        if (names.SequenceEqual(_store.Settings.RollCallLocalNames, StringComparer.Ordinal)) return;
        try
        {
            await _store.SaveSettingsAsync(_store.Settings with { RollCallLocalNames = names });
        }
        catch { /* 保存失败不影响本次点名，下次改动会重试。 */ }
        RenderRoster();
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
            RollCallSingleSeconds = (int)(SingleBox.Value ?? 6m),
            RollCallMultiSeconds = (int)(MultiBox.Value ?? 10m),
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