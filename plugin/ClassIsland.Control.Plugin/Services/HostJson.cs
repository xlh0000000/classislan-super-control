using System.Text.Json;
using ClassIsland.Core.Converters;
using ClassIsland.Shared.JsonConverters;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>
/// 宿主模型（Profile / ComponentProfile / Workflow）的序列化选项。
///
/// ClassIsland 启动时把 <see cref="ColorHexJsonConverter"/> 等转换器装进全局默认选项，
/// 插件内自建的 <c>new JsonSerializerOptions(JsonSerializerDefaults.Web)</c> 不会继承它们，
/// 于是形如 <c>"ForegroundColor": "#1E90FFFF"</c> 的组件布局会反序列化失败。
/// 这里显式注册同一组转换器，保证下发的配置与宿主自己的配置文件语义一致。
/// </summary>
public static class HostJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        Converters = { new ColorHexJsonConverter(), new GuidEmptyFallbackConverter() },
    };
}