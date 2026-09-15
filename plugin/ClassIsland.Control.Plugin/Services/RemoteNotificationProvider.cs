using ClassIsland.Core.Attributes;
using ClassIsland.Core.Abstractions.Services.NotificationProviders;
using ClassIsland.Core.Models.Notification;

namespace ClassIsland.Control.Plugin.Services;

[NotificationProviderInfo("fcb1d3bc-bcc7-43d9-b850-7f56b8f55f7b", "ClassIsland 集控", "lucide()", "显示来自已认证控制平面的提醒")]
public sealed class RemoteNotificationProvider : NotificationProviderBase
{
    public void Send(string title, string content)
    {
        ShowNotification(new NotificationRequest
        {
            MaskContent = NotificationContent.CreateTwoIconsMask(title, hasRightIcon: false),
            OverlayContent = string.IsNullOrWhiteSpace(content)
                ? null
                : NotificationContent.CreateSimpleTextContent(content),
        });
    }
}
