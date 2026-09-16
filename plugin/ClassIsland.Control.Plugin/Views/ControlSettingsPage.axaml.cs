using System.Linq;
using Avalonia.Media;
using Avalonia.Threading;
using ClassIsland.Control.Plugin.Services;
using ClassIsland.Core.Abstractions.Controls;
using ClassIsland.Core.Attributes;
using ClassIsland.Core.Enums.SettingsWindow;
using ClassIsland.Shared;

namespace ClassIsland.Control.Plugin.Views;

// 贡献者：威廉（课表上传开关与状态、http(s) 放行）

// 归入“关于”类别：策略锁定“应用设置”时本页仍需可达，否则设备状态与锁定项将无处查看。
[SettingsPageInfo("classisland-control.connection", "ClassIsland 集控", "\uedc7", "\uedc6", SettingsPageCategory.About)]
public partial class ControlSettingsPage : SettingsPageBase
{
    private static readonly IBrush Muted = new SolidColorBrush(Color.Parse("#737C74"));
    private static readonly IBrush Good = new SolidColorBrush(Color.Parse("#3F7358"));
    private static readonly IBrush Warning = new SolidColorBrush(Color.Parse("#9A712E"));
    private static readonly IBrush Critical = new SolidColorBrush(Color.Parse("#8C3040"));

    private readonly PluginSettingsStore _store;
    private readonly AgentStatus _status;
    private bool _loading;

    [Obsolete("Only used by the XAML loader.")]
    public ControlSettingsPage() : this(IAppHost.GetService<PluginSettingsStore>(), IAppHost.GetService<AgentStatus>())
    {
    }

    public ControlSettingsPage(PluginSettingsStore store, AgentStatus status)
    {
        _store = store;
        _status = status;
        InitializeComponent();
        ServerUrlBox.Text = store.Settings.ServerUrl;
        DeviceNameBox.Text = store.Settings.DeviceName;
        _loading = true;
        TimetableUploadSwitch.IsChecked = store.Settings.TimetableUploadEnabled;
        _loading = false;
        TimetableUploadSwitch.IsCheckedChanged += OnTimetableToggleChanged;
        RenderStatus();
    }

    protected override void OnAttachedToVisualTree(Avalonia.VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        _status.Changed += OnStatusChanged;
        RenderStatus();
    }

    protected override void OnDetachedFromVisualTree(Avalonia.VisualTreeAttachmentEventArgs e)
    {
        _status.Changed -= OnStatusChanged;
        base.OnDetachedFromVisualTree(e);
    }

    private void OnStatusChanged() => Dispatcher.UIThread.Post(RenderStatus);

    private void RenderStatus()
    {
        var (text, brush) = Describe();
        StatusText.Text = text;
        StatusDot.Fill = brush;

        var enrolled = _status.IsEnrolled;
        DetailPanel.IsVisible = enrolled;
        ManagedNotice.IsOpen = enrolled && _status.Locked;
        ConnectPanel.IsVisible = !enrolled;
        if (!enrolled)
        {
            LockPanel.IsVisible = false;
            return;
        }

        DeviceIdText.Text = _status.DeviceId;
        TransportText.Text = _store.Settings.Transport == "websocket" ? "WebSocket 长连接" : "HTTP 轮询";
        TimeOffsetText.Text = _status.TimeOffsetSummary.Length > 0 ? _status.TimeOffsetSummary : "跟随本机设置";
        ServerText.Text = _store.Settings.ServerUrl;
        LastSyncText.Text = _status.LastSuccessAt is { } at
            ? $"{at.ToLocalTime():yyyy-MM-dd HH:mm:ss}"
            : "尚未成功同步";
        var sections = _status.AppliedSections;
        PolicyText.Text = _status.PolicyRevision == 0 && sections.Count == 0
            ? "尚未收到策略"
            : $"R{_status.PolicyRevision} · epoch {_status.PolicyEpoch}" +
              (sections.Count == 0 ? "" : " · " + string.Join("，", sections.Select(pair => $"{pair.Key}:{pair.Value}")));
        var locks = _status.LockSummary;
        LockPanel.IsVisible = locks.Count > 0;
        LockText.Text = string.Join("、", locks);
        var error = _status.PolicyError.Length > 0 ? _status.PolicyError : _status.LastError;
        if (error.Length == 0 && _store.SealTampered) error = "检测到本地集控身份文件被改动，已拒绝该改动并使用原身份。";
        if (error.Length == 0 && _store.RecoveredFromSeal) error = "本地集控身份曾被清空，已按入网封条恢复接入。";
        ErrorBar.Message = error;
        ErrorBar.IsOpen = error.Length > 0;
        TimetableStatusText.Text = !enrolled
            ? "未加入集控"
            : _status.TimetableSummary.Length > 0 ? _status.TimetableSummary : "尚未同步";
    }

    private async void OnTimetableToggleChanged(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        if (_loading) return;
        try
        {
            await _store.SaveSettingsAsync(_store.Settings with { TimetableUploadEnabled = TimetableUploadSwitch.IsChecked == true });
        }
        catch { /* 保存失败不影响本次切换；下次改动会重试。 */ }
        RenderStatus();
    }

    private (string Text, IBrush Brush) Describe()
    {
        if (_status.IsEnrolled)
        {
            var id = _status.DeviceId.Length > 8 ? _status.DeviceId[..8] : _status.DeviceId;
            if (_status.PolicyError.Length > 0) return ($"已加入集控 · {id} · 策略应用失败", Critical);
            if (_status.LastError.Length > 0) return ($"已加入集控 · {id} · 同步失败", Critical);
            if (_status.Online) return ($"已加入集控 · {id} · 同步正常", Good);
            return ($"已加入集控 · {id} · 等待同步", Warning);
        }
        if (_status.LastError.Length > 0) return ($"接入失败 · {Trim(_status.LastError)}", Critical);
        if (_status.Syncing) return ("正在接入…", Warning);
        if (_status.Note.Length > 0) return (_status.Note, Muted);
        return ("未加入集控", Muted);
    }

    private static string Trim(string value) => value.Length > 48 ? value[..48] + "…" : value;

    private async void SaveButton_OnClick(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        try
        {
            // 逻辑层兜底：即使 UI 被绕过，已入网设备也不能改接其他集控或重新接入。
            if (_store.IsEnrollmentLocked || _status.Locked)
            {
                StatusText.Text = "已加入集控：需由集控端解除后才能更改接入信息";
                StatusDot.Fill = Critical;
                return;
            }
            if (!Uri.TryCreate(ServerUrlBox.Text, UriKind.Absolute, out var uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            {
                StatusText.Text = "地址无效，请输入 http:// 或 https:// 开头的集控地址";
                StatusDot.Fill = Critical;
                return;
            }
            // 以当前设置为基线做增量修改：已入网的设备其余设置（含点名悬浮窗）不会被这里抹掉。
            await _store.SaveSettingsAsync(_store.Settings with
            {
                ServerUrl = uri.ToString(),
                DeviceName = string.IsNullOrWhiteSpace(DeviceNameBox.Text) ? Environment.MachineName : DeviceNameBox.Text.Trim(),
                EnrollmentToken = string.IsNullOrWhiteSpace(EnrollmentTokenBox.Text) ? _store.Settings.EnrollmentToken : EnrollmentTokenBox.Text.Trim(),
            });
            EnrollmentTokenBox.Text = "";
            RenderStatus();
        }
        catch (Exception exception)
        {
            StatusText.Text = "保存失败 · " + Trim(exception.Message);
            StatusDot.Fill = Critical;
        }
    }
}