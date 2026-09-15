using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>
/// 落盘的服务端响应信封：正文 + 服务端签名头，用于证明其中的策略确实由集控端下发。
/// </summary>
public sealed record PolicyEnvelope(
    string ResponseJson = "",
    string KeyId = "",
    string Signature = "",
    string SavedAtUtc = "");

/// <summary>
/// 服务端签名策略快照。保存最近一次携带策略的轮询正文，并在启动时校验签名后重新施加
/// 设置锁定。这样即使本地用户改写或删除 ClassIsland 自己的 Policy.json，重启后锁定仍会
/// 被恢复；伪造快照则会因签名不匹配而被拒绝（集控端私钥不在本机）。
/// </summary>
public sealed class PolicySnapshotStore(PluginPaths paths)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public void Save(string responseJson, string keyId, string signature)
    {
        if (string.IsNullOrWhiteSpace(responseJson)) return;
        var envelope = new PolicyEnvelope(responseJson, keyId, signature,
            DateTime.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture));
        foreach (var path in paths.SnapshotCopies()) WriteFile(path, envelope);
    }

    /// <summary>删除全部副本（仅由集控端下发的解除命令调用）。</summary>
    public void Delete()
    {
        foreach (var path in paths.SnapshotCopies())
        {
            foreach (var candidate in new[] { path, path + ".tmp" })
            {
                try { if (File.Exists(candidate)) File.Delete(candidate); }
                catch { /* 清理失败不阻塞解除。 */ }
            }
        }
    }

    /// <summary>返回签名有效且最新的一份策略文档；没有可用快照时返回 null。</summary>
    public JsonElement? ReadLatestVerified(string serverPublicKey, string serverKeyId)
    {
        if (string.IsNullOrWhiteSpace(serverPublicKey) || string.IsNullOrWhiteSpace(serverKeyId)) return null;
        PolicyEnvelope? newest = null;
        foreach (var path in paths.SnapshotCopies())
        {
            var envelope = ReadFile(path);
            if (envelope is null || envelope.KeyId != serverKeyId) continue;
            if (!Verify(serverPublicKey, envelope)) continue;
            if (newest is null || string.CompareOrdinal(envelope.SavedAtUtc, newest.SavedAtUtc) > 0)
                newest = envelope;
        }
        if (newest is null) return null;
        try
        {
            using var document = JsonDocument.Parse(newest.ResponseJson);
            if (!document.RootElement.TryGetProperty("policy", out var policy) ||
                policy.ValueKind != JsonValueKind.Object) return null;
            if (!policy.TryGetProperty("document", out var body) ||
                body.ValueKind != JsonValueKind.Object) return null;
            return body.Clone();
        }
        catch (JsonException) { return null; }
    }

    private static bool Verify(string serverPublicKey, PolicyEnvelope envelope)
    {
        if (string.IsNullOrWhiteSpace(envelope.Signature)) return false;
        try
        {
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(serverPublicKey), out _);
            return key.VerifyData(
                Encoding.UTF8.GetBytes(envelope.ResponseJson),
                FromBase64Url(envelope.Signature),
                HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch { return false; }
    }

    private static PolicyEnvelope? ReadFile(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            return JsonSerializer.Deserialize<PolicyEnvelope>(File.ReadAllText(path), JsonOptions);
        }
        catch { return null; }
    }

    private static void WriteFile(string path, PolicyEnvelope envelope)
    {
        try
        {
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            var temporary = path + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(envelope, JsonOptions));
            File.Move(temporary, path, true);
        }
        catch { /* 单份快照写失败不阻塞同步。 */ }
    }

    private static byte[] FromBase64Url(string value)
    {
        var base64 = value.Replace('-', '+').Replace('_', '/');
        base64 += new string('=', (4 - base64.Length % 4) % 4);
        return Convert.FromBase64String(base64);
    }
}