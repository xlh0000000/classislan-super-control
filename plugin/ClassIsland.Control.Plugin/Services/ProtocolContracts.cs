using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>
/// 控制平面线上协议 DTO 的唯一来源。tools/ProtocolVectors 直接编译本文件，
/// 用真实的 System.Text.Json 输出生成 C#→TypeScript 字节契约向量；
/// 因此这里的字段形状与序列化选项一旦变动，契约测试会立即给出可复现的失败。
///
/// 关键约定：DefaultIgnoreCondition = WhenWritingNull。可空字段（如
/// keyThumbprint、capabilities、appliedSections）为空时必须整段省略，
/// 因为服务端 Zod 的 .optional() 只接受“缺省”，不接受显式 null。
/// </summary>
public static class ProtocolJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

public sealed record CapabilityDescriptor(string Id, string Mode, int SchemaVersion);

public sealed record CommandResult(string CommandId, string State, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] object? Result = null);

public sealed record EnrollmentRequest(string Token, string Name, Dictionary<string, object> PublicKeyJwk, string? KeyThumbprint, string PluginVersion, string AppVersion, string Platform);
public sealed record EnrollmentResponse(string DeviceId, int PollIntervalSeconds, DateTime ServerTimeUtc, string ServerSigningPublicKey, string ServerSigningKeyId);
public sealed record PollRequest(string DeviceId, long Sequence, string TimestampUtc, string PluginVersion, string AppVersion, string Platform, string CapabilityDigest, IReadOnlyList<CapabilityDescriptor>? Capabilities, long PolicyRevision, long PolicyEpoch, string PolicyHash, int DriftCount, IReadOnlyList<CommandResult> Acknowledgements, IReadOnlyDictionary<string, string>? AppliedSections, long RollCallRevision = 0);
public sealed record PollResponse(DateTime ServerTimeUtc, int NextPollSeconds, string? Transport, RemotePolicy? Policy, List<RemoteCommandEnvelope> Commands, List<AckReceipt>? Acknowledgements = null, RemoteRollCall? RollCall = null);
/// <summary>WebSocket 传输的消息封装；信封与响应正文与 HTTP 轮询逐字节同源。</summary>
public sealed record WebSocketPollMessage(string Type, JsonElement Envelope);
public sealed record WebSocketPollResult(string Type, string KeyId, string Signature, string Body);
public sealed record WebSocketError(string Type, int StatusCode, string Message, long? LastSequence = null);
/// <summary>服务端对单条 ACK 的回执：accepted/already-recorded 表示结果已被接收，rejected 表示必须保留并处理。</summary>
public sealed record AckReceipt(string CommandId, string Status, string? Reason = null, string? State = null);
public sealed record RemotePolicy(long Revision, long Epoch, JsonElement Document, Dictionary<string, JsonElement>? Locks, string DocumentHash);
/// <summary>云端下发的点名名单；仅在设备手上的修订过期时出现。</summary>
public sealed record RemoteRollCall(long Revision, IReadOnlyList<string> Names);
public sealed record RemoteCommandEnvelope(string CommandId, string CapabilityId, int SchemaVersion, JsonElement Payload, DateTime NotBeforeUtc, DateTime ExpiresAtUtc, int MaxAttempts = 1);