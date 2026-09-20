using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.VisualTree;
using ClassIsland.Control.Plugin.Services;

namespace ClassIsland.Control.Plugin.Views;

// 贡献者：威廉（抽人悬浮窗：真毛玻璃浓度映射 + 多人菜单纯数字 + DWM 圆角裁剪）

/// <summary>
/// 常驻的点名悬浮窗：长方形、背景高斯模糊、整窗可拖（鼠标与 Windows 触摸同一套
/// 指针事件）。窗口只负责交互，抽人逻辑在 <see cref="RollCallService"/> 里。
/// </summary>
public partial class RollCallWindow : Window
{
    private bool _dragging;
    private PixelPoint _originAtPress;
    private PixelPoint _pointerAtPress;

    /// <summary>“多人”自绘按钮面的常态与悬停底色（亚克力恒为浅色，不跟随主题）。</summary>
    private static readonly IBrush MultiFace = new SolidColorBrush(Color.Parse("#F2252820"));
    private static readonly IBrush MultiFaceHover = new SolidColorBrush(Color.Parse("#F24B4A3B"));

    public RollCallWindow()
    {
        InitializeComponent();
        // 面是自绘的，悬停反馈也自己给，避免主题在浅色亚克力上换出浅底色。
        MultiButton.PointerEntered += (_, _) => MultiShell.Background = MultiFaceHover;
        MultiButton.PointerExited += (_, _) => MultiShell.Background = MultiFace;
        AddHandler(PointerPressedEvent, OnPointerPressed, RoutingStrategies.Tunnel);
        AddHandler(PointerMovedEvent, OnPointerMoved, RoutingStrategies.Tunnel);
        AddHandler(PointerReleasedEvent, OnPointerReleased, RoutingStrategies.Tunnel);
    }

    /// <summary>点击“抽人”。</summary>
    public event Action? SingleRequested;

    /// <summary>点击“多人”并选定人数。</summary>
    public event Action<int>? MultiRequested;

    /// <summary>拖动结束：回传逻辑坐标，供设置持久化。</summary>
    public event Action<double, double>? DragCompleted;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    private const int DwmwaWindowCornerPreference = 33;

    /// <summary>
    /// Win11 起让 DWM 给无边框窗口裁圆角。亚克力铺满整窗，圆角由系统裁剪，
    /// 卡片外才不会露出矩形的模糊底层；Win10 不支持该属性时保持方角并完全铺满。
    /// </summary>
    protected override void OnOpened(EventArgs e)
    {
        base.OnOpened(e);
        if (TryGetPlatformHandle() is not { } handle) return;
        var preference = 2; // DWMWCP_ROUND
        var cornered = DwmSetWindowAttribute(handle.Handle, DwmwaWindowCornerPreference, ref preference, sizeof(int)) == 0;
        Shell.CornerRadius = cornered ? new CornerRadius(8) : new CornerRadius(0);
    }

    /// <summary>结果展示期间禁用两个抽人按钮，结束后恢复；供 <see cref="RollCallService"/> 调用。</summary>
    public void SetButtonsEnabled(bool enabled)
    {
        SingleButton.IsEnabled = enabled;
        MultiButton.IsEnabled = enabled;
        // 字色是显式指定的，不会跟随主题的禁用态变淡；用整体透明度表达禁用。
        SingleButton.Opacity = enabled ? 1 : 0.55;
        MultiButton.Opacity = enabled ? 1 : 0.55;
    }

    /// <summary>悬浮窗被用户收起（关闭手势折算为隐藏）。</summary>
    public event Action? Dismissed;

    public double Scaling => (Screens.ScreenFromWindow(this) ?? Screens.Primary)?.Scaling is { } value && value > 0
        ? value
        : 1;

    /// <summary>把设置页的尺寸与底色不透明度应用到窗口。</summary>
    public void ApplySettings(PluginSettings settings)
    {
        Width = Math.Clamp(settings.RollCallWidth, 50, 1280);
        Height = Math.Clamp(settings.RollCallHeight, 20, 640);
        ApplyLayoutScale();
        // 真毛玻璃观感：设置值压缩到磨砂层 0.15–0.55、白色 tint 0.05–0.3，
        // 背景内容透过模糊层而不是被白雾盖住；纯实底留给不支持亚克力的回退色。
        var opacity = Math.Clamp(settings.RollCallOpacity, 0.2, 1);
        if (Shell.Material is { } material)
        {
            material.MaterialOpacity = Math.Clamp(opacity * 0.55, 0.15, 0.55);
            material.TintOpacity = Math.Clamp(opacity * 0.25, 0.05, 0.3);
        }
    }

    /// <summary>
    /// 边距、间隔与字号跟着窗口尺寸缩：12/8/16 那套是给默认大小用的，
    /// 窗口收到 50×20 时若不动它们，两颗按钮里只剩裁掉的字。
    /// 常态尺寸下取到的是上限，观感与原来一致。
    /// </summary>
    private void ApplyLayoutScale()
    {
        var x = Math.Clamp(Width / 20, 1, 12);
        var y = Math.Clamp(Height / 8, 1, 12);
        var spacing = Math.Clamp(x, 2, 8);
        Layout.Margin = new Thickness(x, y, x, y);
        Layout.ColumnSpacing = spacing;
        // 一个字约占 1 号字高的宽度、一行约 1.45 倍，两个字的按钮要装下就得同时让宽和高。
        var font = Math.Clamp(Math.Min((Width - 2 * x - spacing) / 4.4, (Height - 2 * y) / 1.45), 7, 16);
        SingleText.FontSize = font;
        MultiText.FontSize = font;
        MultiShell.CornerRadius = new CornerRadius(Math.Clamp(font / 2, 2, 8));
    }

    /// <summary>
    /// 首次显示时定位：优先用上次拖动保存的位置，其次停在工作区右下角。
    /// 两种情况都会夹回工作区，避免换分辨率或多显示器后窗口跑到屏幕外。
    /// </summary>
    public void PlaceAt(double? savedX, double? savedY)
    {
        if ((Screens.ScreenFromWindow(this) ?? Screens.Primary) is not { } screen) return;
        var scaling = screen.Scaling > 0 ? screen.Scaling : 1;
        var width = (int)Math.Round(Width * scaling);
        var height = (int)Math.Round(Height * scaling);
        var area = screen.WorkingArea;
        var x = savedX is { } sx ? (int)Math.Round(sx * scaling) : area.Right - width - 24;
        var y = savedY is { } sy ? (int)Math.Round(sy * scaling) : area.Bottom - height - 24;
        Position = new PixelPoint(
            Math.Clamp(x, area.X, Math.Max(area.X, area.Right - width)),
            Math.Clamp(y, area.Y, Math.Max(area.Y, area.Bottom - height)));
    }

    /// <summary>
    /// 悬浮窗只能由设置页的开关收起：用户按 Alt+F4 之类的关闭手势一律折算成隐藏，
    /// 只有系统关机或应用退出才真正关闭，避免误触后再也找不回窗口。
    /// </summary>
    protected override void OnClosing(WindowClosingEventArgs e)
    {
        base.OnClosing(e);
        if (e.CloseReason is WindowCloseReason.OSShutdown or WindowCloseReason.ApplicationShutdown) return;
        e.Cancel = true;
        Hide();
        Dismissed?.Invoke();
    }

    private void SingleButton_OnClick(object? sender, RoutedEventArgs e) => SingleRequested?.Invoke();

    /// <summary>“多人”不是输入框，而是 2–6 人的下拉选项（纯数字，不放多余文字）。</summary>
    private void MultiButton_OnClick(object? sender, RoutedEventArgs e)
    {
        var flyout = new MenuFlyout();
        for (var count = 2; count <= 6; count++)
        {
            var item = new MenuItem { Header = $"{count}", Tag = count };
            var picked = count;
            item.Click += (_, _) => MultiRequested?.Invoke(picked);
            flyout.Items.Add(item);
        }
        flyout.ShowAt(MultiButton);
    }

    private void OnPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (IsInteractive(e.Source)) return;
        var point = e.GetCurrentPoint(this);
        if (!point.Properties.IsLeftButtonPressed && e.Pointer.Type != PointerType.Touch) return;
        _dragging = true;
        _originAtPress = Position;
        _pointerAtPress = this.PointToScreen(e.GetPosition(this));
        e.Pointer.Capture(this);
        e.Handled = true;
    }

    private void OnPointerMoved(object? sender, PointerEventArgs e)
    {
        if (!_dragging) return;
        // PointToScreen 返回指针的真实屏幕坐标，与窗口当前位置无关，
        // 因此“按下时窗口位置 + 指针位移”可以稳定跟随，不会因窗口移动而抖动。
        var current = this.PointToScreen(e.GetPosition(this));
        Position = new PixelPoint(
            _originAtPress.X + (current.X - _pointerAtPress.X),
            _originAtPress.Y + (current.Y - _pointerAtPress.Y));
        e.Handled = true;
    }

    private void OnPointerReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (!_dragging) return;
        _dragging = false;
        e.Pointer.Capture(null);
        var scaling = Scaling;
        DragCompleted?.Invoke(Position.X / scaling, Position.Y / scaling);
        e.Handled = true;
    }

    /// <summary>按钮、文本框等自身要处理指针的控件不参与拖动。</summary>
    private static bool IsInteractive(object? source)
    {
        var visual = source as Visual;
        while (visual is not null and not RollCallWindow)
        {
            if (visual is Button or TextBox or MenuItem) return true;
            visual = visual.GetVisualParent();
        }
        return false;
    }
}