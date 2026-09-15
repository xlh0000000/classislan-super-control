using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClassIsland.Control.Plugin.Services;


/// <summary>
/// 服务端拒绝设备请求序列（409）并附带其权威序列。
/// 本地状态被清空或重建时据此一次性对齐，避免从 1 开始逐号追赶。
/// </summary>
public sealed class SequenceConflictException(string message, long serverSequence)
    : HttpRequestException(message, null, System.Net.HttpStatusCode.Conflict)
{
    public long ServerSequence { get; } = serverSequence;
}

/// <summary>
/// 一次轮询的完整结果：反序列化后的响应正文，以及原始正文与服务端签名头。
/// 原始正文与签名会被落盘为策略快照，供启动时离线恢复设置锁定。
/// </summary>
public sealed record PollResult(
    PollResponse Response,
    string RawJson,
    string ServerKeyId,
    string ServerSignature,
    TimeSpan RoundTrip);

/// <summary>
/// 集控端客户端。HTTP 轮询与 WebSocket 长连接共用同一份签名信封、同一份响应校验，
/// 只是承载连接不同；因此两种传输的序列、重放、命令与策略语义完全一致。
/// </summary>
public sealed class ControlPlaneClient(HttpClient httpClient, PluginSettingsStore store)
{
    private static readonly JsonSerializerOptions JsonOptions = ProtocolJson.Options;
    private const string PollPath = "/api/v1/agent/poll";
    private const string WebSocketPath = "/api/v1/agent/ws";
    private const int MaxWebSocketResponseBytes = 512 * 1024;
    private static readonly TimeSpan PollTimeout = TimeSpan.FromSeconds(45);

    private readonly SemaphoreSlim _socketGate = new(1, 1);
    private ClientWebSocket? _socket;

    public async Task<EnrollmentResponse> EnrollAsync(EnrollmentRequest request, CancellationToken cancellationToken)
    {
        using var response = await SendAsync(HttpMethod.Post, "/api/v1/agent/enroll", JsonSerializer.Serialize(request, JsonOptions), cancellationToken, null);
        var enrollment = await response.Content.ReadFromJsonAsync<EnrollmentResponse>(JsonOptions, cancellationToken)
            ?? throw new InvalidOperationException("Enrollment response was empty.");
        var publicKey = Convert.FromBase64String(enrollment.ServerSigningPublicKey);
        var keyId = Convert.ToHexString(SHA256.HashData(publicKey)).ToLowerInvariant();
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(keyId), Encoding.ASCII.GetBytes(enrollment.ServerSigningKeyId)))
            throw new CryptographicException("Server signing key identifier is invalid.");
        if (!string.IsNullOrWhiteSpace(store.State.ServerSigningKeyId) && store.State.ServerSigningKeyId != keyId)
            throw new CryptographicException("Server signing identity changed. Reset the device identity only after verifying the new fingerprint.");
        return enrollment;
    }

    public async Task<PollResult> PollAsync(PollRequest requestBody, CancellationToken cancellationToken)
    {
        var signed = SignPoll(requestBody);
        var startedAt = DateTime.UtcNow;
        using var response = await SendAsync(HttpMethod.Post, PollPath, signed.BodyJson, cancellationToken,
            new(requestBody.DeviceId, requestBody.Sequence, signed.Timestamp, signed.Signature));
        var responseJson = await response.Content.ReadAsStringAsync(cancellationToken);
        var roundTrip = DateTime.UtcNow - startedAt;
        var (keyId, serverSignature) = VerifyServerSignature(
            response.Headers.TryGetValues("x-server-key-id", out var keyIds) ? keyIds.Single() : null,
            response.Headers.TryGetValues("x-server-signature", out var signatures) ? signatures.Single() : null,
            responseJson);
        var parsed = JsonSerializer.Deserialize<PollResponse>(responseJson, JsonOptions)
            ?? throw new InvalidOperationException("Poll response was empty.");
        return new PollResult(parsed, responseJson, keyId, serverSignature, roundTrip);
    }

    /// <summary>
    /// 在常驻长连接上提交一次轮询。连接断开或服务端拒绝时立即释放连接，
    /// 下一次调用重新建立，避免复用已关闭的套接字。
    /// </summary>
    public async Task<PollResult> PollOverWebSocketAsync(PollRequest requestBody, CancellationToken cancellationToken)
    {
        var signed = SignPoll(requestBody);
        await _socketGate.WaitAsync(cancellationToken);
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(PollTimeout);
            var socket = await EnsureSocketAsync(timeout.Token);
            using var envelope = JsonDocument.Parse(signed.BodyJson);
            var payload = JsonSerializer.SerializeToUtf8Bytes(
                new WebSocketPollMessage("poll", envelope.RootElement.Clone()), JsonOptions);
            var startedAt = DateTime.UtcNow;
            await socket.SendAsync(payload, WebSocketMessageType.Text, true, timeout.Token);
            var reply = await ReceiveTextAsync(socket, timeout.Token);
            return ReadWebSocketReply(reply, DateTime.UtcNow - startedAt);
        }
        catch
        {
            // 任何失败都不保留连接状态：下一次轮询重新握手并重新校验服务端身份。
            await ResetSocketAsync();
            throw;
        }
        finally { _socketGate.Release(); }
    }

    /// <summary>断开并丢弃长连接，供轮询循环在传输方式切换或退出时调用。</summary>
    public async Task CloseWebSocketAsync()
    {
        await _socketGate.WaitAsync();
        try { await ResetSocketAsync(); }
        finally { _socketGate.Release(); }
    }

    private PollResult ReadWebSocketReply(string reply, TimeSpan roundTrip)
    {
        string? type;
        JsonElement root;
        try
        {
            using var document = JsonDocument.Parse(reply);
            root = document.RootElement.Clone();
            type = root.TryGetProperty("type", out var typeValue) ? typeValue.GetString() : null;
        }
        catch (JsonException)
        {
            throw new HttpRequestException("长连接响应不是有效 JSON。");
        }
        if (type == "error")
        {
            var statusCode = root.TryGetProperty("statusCode", out var codeValue) && codeValue.TryGetInt32(out var code) ? code : 500;
            var message = root.TryGetProperty("message", out var messageValue) ? messageValue.GetString() ?? "" : "";
            var lastSequence = root.TryGetProperty("lastSequence", out var sequenceValue)
                               && sequenceValue.ValueKind == JsonValueKind.Number
                               && sequenceValue.TryGetInt64(out var sequence)
                ? sequence
                : (long?)null;
            var status = (System.Net.HttpStatusCode)statusCode;
            if (status is System.Net.HttpStatusCode.Conflict && lastSequence is { } authoritative)
                throw new SequenceConflictException($"服务端返回 409：{message}", authoritative);
            throw new HttpRequestException($"服务端返回 {statusCode}：{message}", null, status);
        }
        if (type != "poll-result")
            throw new HttpRequestException("长连接响应缺少轮询结果。");
        var body = root.TryGetProperty("body", out var bodyValue) ? bodyValue.GetString() : null;
        var keyId = root.TryGetProperty("keyId", out var keyIdValue) ? keyIdValue.GetString() : null;
        var signature = root.TryGetProperty("signature", out var signatureValue) ? signatureValue.GetString() : null;
        if (string.IsNullOrEmpty(body))
            throw new HttpRequestException("长连接响应的正文为空。");
        var verified = VerifyServerSignature(keyId, signature, body);
        var parsed = JsonSerializer.Deserialize<PollResponse>(body, JsonOptions)
            ?? throw new InvalidOperationException("Poll response was empty.");
        return new PollResult(parsed, body, verified.KeyId, verified.Signature, roundTrip);
    }

    private async Task<ClientWebSocket> EnsureSocketAsync(CancellationToken cancellationToken)
    {
        if (_socket is { State: WebSocketState.Open } open) return open;
        await ResetSocketAsync();
        var httpUri = new Uri(ResolveServerUri(), WebSocketPath);
        var builder = new UriBuilder(httpUri)
        {
            Scheme = httpUri.Scheme == Uri.UriSchemeHttps ? "wss" : "ws",
        };
        var socket = new ClientWebSocket();
        try
        {
            await socket.ConnectAsync(builder.Uri, cancellationToken);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
        _socket = socket;
        return socket;
    }

    private async Task ResetSocketAsync()
    {
        var socket = _socket;
        _socket = null;
        if (socket is null) return;
        try
        {
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "reconnect", CancellationToken.None);
        }
        catch (Exception) { /* 关闭失败同样只需丢弃连接。 */ }
        socket.Dispose();
    }

    private static async Task<string> ReceiveTextAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[16 * 1024];
        using var payload = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
                throw new HttpRequestException("长连接已被服务端关闭。");
            if (result.MessageType != WebSocketMessageType.Text)
                throw new HttpRequestException("长连接返回了非文本消息。");
            payload.Write(buffer, 0, result.Count);
            if (payload.Length > MaxWebSocketResponseBytes)
                throw new HttpRequestException("长连接响应超过大小限制。");
            if (result.EndOfMessage) break;
        }
        return Encoding.UTF8.GetString(payload.ToArray());
    }

    /// <summary>
    /// 生成轮询签名信封：正文化为 JCS 规范形式后取摘要，再对
    /// <c>POST /api/v1/agent/poll</c> 的请求行做 ECDSA P-256 签名。
    /// </summary>
    private SignedPoll SignPoll(PollRequest requestBody)
    {
        if (string.IsNullOrWhiteSpace(store.State.DevicePrivateKey)) throw new InvalidOperationException("Device signing identity is not available.");
        var canonicalBody = Jcs.Canonicalize(JsonSerializer.SerializeToNode(requestBody, JsonOptions));
        var bodyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalBody))).ToLowerInvariant();
        var timestamp = requestBody.TimestampUtc;
        var signaturePayload = string.Join('\n', "POST", PollPath, requestBody.DeviceId, requestBody.Sequence, timestamp, bodyHash);
        using var key = ECDsa.Create();
        key.ImportPkcs8PrivateKey(Convert.FromBase64String(store.State.DevicePrivateKey), out _);
        var signature = Base64Url(key.SignData(Encoding.UTF8.GetBytes(signaturePayload), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
        var signedNode = JsonNode.Parse(canonicalBody)!.AsObject();
        signedNode["signedBodyHash"] = bodyHash;
        signedNode["signature"] = signature;
        return new SignedPoll(signedNode.ToJsonString(JsonOptions), timestamp, signature);
    }

    private (string KeyId, string Signature) VerifyServerSignature(string? keyId, string? signature, string responseJson)
    {
        if (string.IsNullOrWhiteSpace(keyId)) throw new CryptographicException("Server response key identifier is missing.");
        if (string.IsNullOrWhiteSpace(signature)) throw new CryptographicException("Server response signature is missing.");
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(store.State.ServerSigningKeyId),
                Encoding.ASCII.GetBytes(keyId)))
            throw new CryptographicException("Server signing key identifier changed.");
        using var serverKey = ECDsa.Create();
        serverKey.ImportSubjectPublicKeyInfo(Convert.FromBase64String(store.State.ServerSigningPublicKey), out _);
        if (!serverKey.VerifyData(
                Encoding.UTF8.GetBytes(responseJson),
                FromBase64Url(signature),
                HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
            throw new CryptographicException("Server response signature is invalid.");
        return (keyId, signature);
    }

    private Uri ResolveServerUri()
    {
        var baseUri = new Uri(store.Settings.ServerUrl, UriKind.Absolute);
        if (baseUri.Scheme != Uri.UriSchemeHttps && baseUri.Host is not ("localhost" or "127.0.0.1")) throw new InvalidOperationException("Public control planes must use HTTPS.");
        return baseUri;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string bodyJson, CancellationToken cancellationToken, SignedHeaders? signed)
    {
        using var request = new HttpRequestMessage(method, new Uri(ResolveServerUri(), path)) { Content = new StringContent(bodyJson, Encoding.UTF8, "application/json") };
        if (signed is not null)
        {
            request.Headers.Add("x-device-id", signed.DeviceId);
            request.Headers.Add("x-device-sequence", signed.Sequence.ToString());
            request.Headers.Add("x-device-timestamp", signed.Timestamp);
            request.Headers.Add("x-device-signature", signed.Signature);
        }
        var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var detail = await response.Content.ReadAsStringAsync(cancellationToken);
            var statusCode = response.StatusCode;
            response.Dispose();
            if (statusCode == System.Net.HttpStatusCode.Conflict && TryReadLastSequence(detail) is { } serverSequence)
                throw new SequenceConflictException($"服务端返回 409：{ExtractMessage(detail)}", serverSequence);
            throw new HttpRequestException($"服务端返回 {(int)statusCode}：{ExtractMessage(detail)}", null, statusCode);
        }
        return response;
    }

    /// <summary>把服务端的错误正文提炼成一行可读原因，避免界面上只显示裸状态码。</summary>
    private static string ExtractMessage(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return "无响应正文";
        try
        {
            if (JsonNode.Parse(body) is JsonObject json)
            {
                var message = json["statusMessage"]?.GetValue<string>() ?? json["message"]?.GetValue<string>();
                if (!string.IsNullOrWhiteSpace(message)) return message;
            }
        }
        catch (JsonException) { }
        var trimmed = body.Trim();
        return trimmed.Length > 200 ? trimmed[..200] : trimmed;
    }

    /// <summary>从 409 正文里取出服务端权威序列；缺失或格式不符时返回 null。</summary>
    private static long? TryReadLastSequence(string body)
    {
        try
        {
            if (JsonNode.Parse(body) is not JsonObject json) return null;
            var node = json["data"]?["lastSequence"] ?? json["lastSequence"];
            return node is null ? null : node.GetValue<long>();
        }
        catch (Exception) { return null; }
    }

    private static byte[] FromBase64Url(string value)
    {
        var base64 = value.Replace('-', '+').Replace('_', '/');
        base64 += new string('=', (4 - base64.Length % 4) % 4);
        return Convert.FromBase64String(base64);
    }
    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private sealed record SignedHeaders(string DeviceId, long Sequence, string Timestamp, string Signature);
    private sealed record SignedPoll(string BodyJson, string Timestamp, string Signature);
}