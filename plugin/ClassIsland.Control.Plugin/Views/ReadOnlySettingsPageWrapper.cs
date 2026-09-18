using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using ClassIsland.Core.Abstractions.Controls;
using Microsoft.Extensions.DependencyInjection;

namespace ClassIsland.Control.Plugin.Views;

/// <summary>
/// 只读管控的包装设置页：内嵌真页并整块禁用交互，顶部给出锁定提示。
///
/// 不通过 [SettingsPage] 特性注册——Plugin.Initialize 为每个可管控页面按
/// `classisland-control.ro.&lt;页 Id&gt;` 键注册本类的瞬实例；策略命中只读时，
/// 注册表条目被替换为该键的克隆，宿主的 GetKeyedService 就会构造这里。
/// 真页通过原始键从 DI 取（注册表移除不影响 DI 登记），首次 Loaded 时挂上；
/// Tag 由宿主在取得页面后写入，因此挂接动作排队到 Loaded 之后执行。
/// </summary>
public sealed class ReadOnlySettingsPageWrapper(IServiceProvider services) : SettingsPageBase
{
    private ContentControl? _host;
    private string? _attachedKey;

    private void Build()
    {
        if (_host is not null) return;
        var banner = new TextBlock
        {
            Text = "此设置项已由集控端设为只读",
            Margin = new Thickness(0, 0, 0, 8),
            Opacity = 0.75,
            FontSize = 13,
            HorizontalAlignment = HorizontalAlignment.Left,
        };
        _host = new ContentControl { HorizontalAlignment = HorizontalAlignment.Stretch };
        var panel = new DockPanel();
        DockPanel.SetDock(banner, Dock.Top);
        panel.Children.Add(banner);
        panel.Children.Add(_host);
        Content = panel;
    }

    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        Build();
        // Tag 在 Loaded 之后才由宿主写入，排队到本轮布局完成再挂真页。
        Dispatcher.UIThread.Post(AttachControlledPage);
    }

    private void AttachControlledPage()
    {
        Build();
        if (Tag is not string key || key == _attachedKey) return;
        _attachedKey = key;
        var originalId = key.StartsWith(Services.SettingsPagePolicyService.WrapperPrefix)
            ? key[Services.SettingsPagePolicyService.WrapperPrefix.Length..]
            : key;
        var page = services.GetKeyedService<SettingsPageBase>(originalId);
        if (page is null)
        {
            _host!.Content = new TextBlock
            {
                Text = "该设置页在当前宿主版本中不存在。",
                Margin = new Thickness(0, 12, 0, 0),
                Opacity = 0.6,
            };
            return;
        }
        page.IsEnabled = false;
        _host!.Content = page;
    }
}
