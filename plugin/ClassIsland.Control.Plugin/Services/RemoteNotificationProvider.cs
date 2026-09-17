using ClassIsland.Core.Attributes;
using ClassIsland.Core.Abstractions.Services.NotificationProviders;
using ClassIsland.Core.Models.Notification;

namespace ClassIsland.Control.Plugin.Services;

[NotificationProviderInfo("fcb1d3bc-bcc7-43d9-b850-7f56b8f55f7b", "ClassIsland 集控", "lucide()", "显示来自已认证控制平面的提醒")]
public sealed class RemoteNotificationProvider : NotificationProviderBase
{
    /// <summary>
    /// 拉起一条提醒。<paramref name="duration"/> 给了就让遮罩与浮层都用这个时长，
    /// 提醒和名字框、抽人按钮的拦截窗口在同一时刻结束。
    /// </summary>
    public void Send(string title, string content, TimeSpan? duration = null)
    {
        // ClassIsland 的展示时长挂在通知内容上，请求本身没有时长开关。
        var mask = NotificationContent.CreateTwoIconsMask(title, hasRightIcon: false);
        NotificationContent? overlay = null;
        if (!string.IsNullOrWhiteSpace(content))
            overlay = NotificationContent.CreateSimpleTextContent(content);
        if (duration is { } value)
        {
            mask.Duration = value;
            if (overlay is not null) overlay.Duration = value;
        }
        ShowNotification(new NotificationRequest { MaskContent = mask, OverlayContent = overlay });
    }
}
