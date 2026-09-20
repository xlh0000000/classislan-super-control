using Avalonia;
using Avalonia.Controls;

namespace ClassIsland.Control.Plugin.Views.Controls;

/// <summary>
/// 设置页的一行：左侧标题（Content）与说明，右侧操作区（Footer）。
/// 宿主到 2.1.1 才加入 FASettingsExpanderItem，这里自带一份，让插件在更早的宿主上也能打开设置页。
/// </summary>
public partial class SettingRow : UserControl
{
    public static readonly StyledProperty<string?> DescriptionProperty =
        AvaloniaProperty.Register<SettingRow, string?>(nameof(Description));

    public static readonly StyledProperty<object?> FooterProperty =
        AvaloniaProperty.Register<SettingRow, object?>(nameof(Footer));

    public SettingRow()
    {
        InitializeComponent();
    }

    public string? Description
    {
        get => GetValue(DescriptionProperty);
        set => SetValue(DescriptionProperty, value);
    }

    public object? Footer
    {
        get => GetValue(FooterProperty);
        set => SetValue(FooterProperty, value);
    }
}
