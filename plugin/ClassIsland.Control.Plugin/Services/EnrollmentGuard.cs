using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>
/// 入网身份封条。它是入网状态的权威副本，保存在独立的 identity.seal.json 中。
/// 与 state.json 的区别：state.json 是运行时工作状态（序列号、策略修订、待确认回执），
/// 可以被重写；封条只承载“本机已属于哪个集控、用什么身份签名”这一事实，并由设备私钥签名。
/// 因此清空或篡改 state.json / settings.json 都不会让设备脱离集控，只会被启动流程纠正回来。
/// 为防止“删除插件配置目录”或“卸载后重装插件”把设备拉出集控，封条会同时写入多个位置
/// （插件配置目录、配置根下的隐藏目录、本机应用数据目录），任一副本验签通过即可恢复入网身份。
/// </summary>
public sealed record EnrollmentSeal(
    string DeviceId = "",
    string ServerUrl = "",
    string DeviceName = "",
    string DevicePrivateKey = "",
    string DevicePublicKey = "",
    string ServerSigningPublicKey = "",
    string ServerSigningKeyId = "",
    string Signature = "")
{
    [JsonIgnore]
    public bool HasIdentity => DeviceId.Length > 0 && DevicePrivateKey.Length > 0;

    public string SignedPayload() => string.Join('\n',
        DeviceId, ServerUrl, DeviceName, DevicePrivateKey,
        DevicePublicKey, ServerSigningPublicKey, ServerSigningKeyId);
}

/// <summary>封条文件的读写与签名校验。所有成员都可安全地在启动路径上同步调用。</summary>
public sealed class EnrollmentGuard(PluginPaths paths)
{
    private static readonly JsonSerializerOptions JsonOptions =
        new(JsonSerializerDefaults.Web) { WriteIndented = true };

    /// <summary>本次启动是否用封条恢复了被清空/篡改的入网状态。</summary>
    public bool RestoredFromSeal { get; internal set; }

    /// <summary>封条存在但签名不可信：文件被改动过，拒绝采信。</summary>
    public bool SealTampered { get; internal set; }

    public string SealError { get; internal set; } = "";

    /// <summary>实际采信的那份封条所在路径，便于诊断。</summary>
    public string SourcePath { get; private set; } = "";

    /// <summary>遍历所有副本，返回第一个签名有效的封条。</summary>
    public EnrollmentSeal? Read()
    {
        var present = false;
        foreach (var path in paths.SealCopies())
        {
            var seal = ReadFile(path);
            if (seal is null) continue;
            present = true;
            if (!Verify(seal)) continue;
            SourcePath = path;
            SealTampered = false;
            return seal;
        }
        if (present) SealTampered = true;
        return null;
    }

    private EnrollmentSeal? ReadFile(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            var seal = JsonSerializer.Deserialize<EnrollmentSeal>(File.ReadAllText(path), JsonOptions);
            return seal is { } value && value.HasIdentity ? value : null;
        }
        catch (Exception exception)
        {
            SealError = exception.Message;
            return null;
        }
    }

    public bool Verify(EnrollmentSeal seal)
    {
        if (string.IsNullOrWhiteSpace(seal.Signature) || string.IsNullOrWhiteSpace(seal.DevicePublicKey))
            return false;
        try
        {
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(seal.DevicePublicKey), out _);
            return key.VerifyData(
                Encoding.UTF8.GetBytes(seal.SignedPayload()),
                Convert.FromBase64String(seal.Signature),
                HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch (Exception exception)
        {
            SealError = exception.Message;
            return false;
        }
    }

    public EnrollmentSeal Create(
        string deviceId, string serverUrl, string deviceName,
        string devicePrivateKey, string devicePublicKey,
        string serverSigningPublicKey, string serverSigningKeyId)
    {
        using var key = ECDsa.Create();
        key.ImportPkcs8PrivateKey(Convert.FromBase64String(devicePrivateKey), out _);
        var unsigned = new EnrollmentSeal(deviceId, serverUrl, deviceName, devicePrivateKey,
            devicePublicKey, serverSigningPublicKey, serverSigningKeyId);
        var signature = key.SignData(Encoding.UTF8.GetBytes(unsigned.SignedPayload()),
            HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return unsigned with { Signature = Convert.ToBase64String(signature) };
    }

    /// <summary>写入全部副本；单份失败不影响其余副本（磁盘只读等场景下尽力而为）。</summary>
    public void Write(EnrollmentSeal seal)
    {
        foreach (var path in paths.SealCopies()) WriteFile(path, seal);
    }

    /// <summary>删除全部副本（仅由集控端下发的解除命令调用）。</summary>
    public void Delete()
    {
        foreach (var path in paths.SealCopies())
        {
            foreach (var candidate in new[] { path, path + ".tmp" })
            {
                try { if (File.Exists(candidate)) File.Delete(candidate); }
                catch { /* 解除失败不阻塞：内存中的锁已释放，下次启动状态一致。 */ }
            }
        }
    }

    private static void WriteFile(string path, EnrollmentSeal seal)
    {
        try
        {
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            var temporary = path + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(seal, JsonOptions));
            File.Move(temporary, path, true);
        }
        catch { /* 副本写失败不阻塞：主副本或其余副本仍然有效。 */ }
    }
}