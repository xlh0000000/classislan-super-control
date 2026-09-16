using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.VisualTree;
using ClassIsland.Control.Plugin.Services;

namespace ClassIsland.Control.Plugin.Views;

/// <summary>
/// 常驻的点名悬浮窗：长方形、背景高斯模糊、整窗可拖（鼠标与 Windows 触摸同一套
/// 指针事件）。窗口只负责交互，抽人逻辑在 <see cref="RollCallService"/> 里。
/// </summary>
public partial class RollCallWindow : Window
{
    private bool _dragging;
    private PixelPoint _originAtPress;
    private PixelPoint _pointerAtPress;

    public RollCallWindow()
    {
        InitializeComponent();
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

    /// <summary>悬浮窗被用户收起（关闭手势折算为隐藏）。</summary>
    public event Action? Dismissed;

    public double Scaling => (Screens.ScreenFromWindow(this) ?? Screens.Primary)?.Scaling is { } value && value > 0
        ? value
        : 1;

    /// <summary>把设置页的尺寸与底色不透明度应用到窗口。</summary>
    public void ApplySettings(PluginSettings settings)
    {
        Width = Math.Clamp(settings.RollCallWidth, 180, 900);
        Height = Math.Clamp(settings.RollCallHeight, 84, 460);
        // 磨砂浓度由亚克力材质决定：MaterialOpacity 是磨砂层自身，TintOpacity 是白色调。
        var opacity = Math.Clamp(settings.RollCallOpacity, 0.2, 1);
        if (Shell.Material is { } material)
        {
            material.MaterialOpacity = opacity;
            material.TintOpacity = Math.Clamp(opacity * 0.6, 0.15, 0.9);
        }
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

    /// <summary>“多人”不是输入框，而是 2–6 人的下拉选项。</summary>
    private void MultiButton_OnClick(object? sender, RoutedEventArgs e)
    {
        var flyout = new MenuFlyout();
        for (var count = 2; count <= 6; count++)
        {
            var item = new MenuItem { Header = $"{count} 人", Tag = count };
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