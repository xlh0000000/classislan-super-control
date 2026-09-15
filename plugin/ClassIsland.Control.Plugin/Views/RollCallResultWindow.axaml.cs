using Avalonia;
using Avalonia.Animation;
using Avalonia.Animation.Easings;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Styling;
using Avalonia.Threading;

namespace ClassIsland.Control.Plugin.Views;

/// <summary>
/// 屏幕中央的名字框：显示抽中的姓名，到点淡出后自动关闭。
/// 多人结果用更小的字号排布，并把窗口留在屏幕上的时间交给调用方决定。
/// </summary>
public partial class RollCallResultWindow : Window
{
    private readonly DispatcherTimer _timer = new();
    private bool _dismissing;
    private int _seconds = 3;

    public RollCallResultWindow()
    {
        InitializeComponent();
    }

    public void ShowResult(IReadOnlyList<string> names, int seconds)
    {
        KickerText.Text = names.Count > 1 ? $"点名 · {names.Count} 人" : "点名";
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

    private async Task FadeAsync(double from, double to, int milliseconds)
    {
        try
        {
            var animation = new Animation
            {
                Duration = TimeSpan.FromMilliseconds(milliseconds),
                Easing = new CubicEaseOut(),
                Children =
                {
                    new KeyFrame { Cue = new Cue(0d), Setters = { new Setter(OpacityProperty, from) } },
                    new KeyFrame { Cue = new Cue(1d), Setters = { new Setter(OpacityProperty, to) } },
                },
            };
            await animation.RunAsync(Card);
        }
        catch { /* 动画失败不应阻止名字框显示或关闭。 */ }
    }
}