using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Threading;

namespace ClassIsland.Control.Plugin.Views;

// 贡献者：威廉（点名结果窗：DWM 圆角裁剪 + 亚克力铺满整窗）

/// <summary>
/// 屏幕中央的名字框：显示抽中的姓名，到点淡出后自动关闭。
/// 多人结果用更小的字号排布，并把窗口留在屏幕上的时间交给调用方决定。
/// </summary>
public partial class RollCallResultWindow : Window
{
    private readonly DispatcherTimer _timer = new();
    private bool _dismissing;
    private int _seconds = 3;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    private const int DwmwaWindowCornerPreference = 33;

    public RollCallResultWindow()
    {
        InitializeComponent();
    }

    public void ShowResult(IReadOnlyList<string> names, int seconds)
    {
        var fontSize = names.Count switch
        {
            1 => 58d,
            2 => 46d,
            _ => 38d,
        };
        NameList.Children.Clear();
        foreach (var name in names)
            NameList.Children.Add(new TextBlock
            {
                Text = name,
                FontSize = fontSize,
                FontWeight = FontWeight.SemiBold,
                Foreground = new SolidColorBrush(Color.Parse("#111827")),
                Margin = new Thickness(16, 0),
                VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center,
            });
        _seconds = Math.Max(1, seconds);
    }

    /// <summary>窗口真正显示出来后再起动画与计时：未上屏时动画时钟不会推进。</summary>
    protected override void OnOpened(EventArgs e)
    {
        base.OnOpened(e);
        // 与抽人悬浮窗同一套 DWM 圆角：亚克力铺满整窗，圆角由系统裁剪，不露第二层。
        if (TryGetPlatformHandle() is { } handle)
        {
            var preference = 2; // DWMWCP_ROUND
            var cornered = DwmSetWindowAttribute(handle.Handle, DwmwaWindowCornerPreference, ref preference, sizeof(int)) == 0;
            Card.CornerRadius = cornered ? new CornerRadius(8) : new CornerRadius(0);
        }
        _ = FadeAsync(0, 1, 200);
        _timer.Interval = TimeSpan.FromSeconds(_seconds);
        _timer.Tick += OnTimerTick;
        _timer.Start();
    }

    /// <summary>提前关闭（被下一次点名替换时使用）。</summary>
    public void DismissImmediately()
    {
        _timer.Stop();
        _dismissing = true;
        Close();
    }

    private void OnTimerTick(object? sender, EventArgs e)
    {
        _timer.Stop();
        _ = DismissAsync();
    }

    private async Task DismissAsync()
    {
        if (_dismissing) return;
        _dismissing = true;
        await FadeAsync(1, 0, 220);
        Close();
    }

    /// <summary>
    /// 手动补间不透明度。不使用 Avalonia 的 Animation.RunAsync：其动画时钟在
    /// ShowActivated=False 的悬浮窗上可能不推进，名字会永远停在透明、窗口却还在。
    /// Task.Delay 只依赖线程池计时，必定推进；淡入失败也能落到目标值。
    /// </summary>
    private async Task FadeAsync(double from, double to, int milliseconds)
    {
        Card.Opacity = from;
        var steps = Math.Max(1, milliseconds / 20);
        for (var step = 1; step <= steps; step++)
        {
            await Task.Delay(20);
            Card.Opacity = Math.Clamp(from + (to - from) * step / steps, 0d, 1d);
        }
    }
}