using System.Text.Encodings.Web;
using System.Text.Json;
using ClassIsland.Control.Plugin.Services;

// 用插件真实的协议 DTO 与真实的 System.Text.Json 选项生成 C#→TypeScript 字节契约向量。
// 这些字节会被 tests/protocol-contract.test.ts 直接送入服务端 Zod schema，
// 从而把“C# 实际写出的线上报文”与“服务端接受的形状”绑在一起。
var outPath = "shared/protocol-vectors.json";
var check = false;
for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--out" when i + 1 < args.Length:
            outPath = args[++i];
            break;
        case "--check":
            check = true;
            break;
    }
}

var deviceId = "2e64dbad-e2f3-49f3-9629-1bb4681fffb6";
var commandId = "9b6a1f3c-2f8e-4c1e-8f7a-6d5b4c3a2e10";
var otherCommandId = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

var vectors = new List<ContractVector>();
void Add(string name, string schema, object payload) =>
    vectors.Add(new ContractVector(name, schema, JsonSerializer.Serialize(payload, ProtocolJson.Options)));

var jwk = new Dictionary<string, object>
{
    ["kty"] = "EC",
    ["crv"] = "P-256",
    ["x"] = "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
    ["y"] = "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
};

Add("enrollment-request-null-thumbprint", "enroll",
    new EnrollmentRequest("CLASSISLAND-ENROLL-TOKEN-0123456789abcdef", "教室主机", jwk, null, "0.1.0", "2.1.1.1", "Windows/x64"));

Add("poll-request-empty", "poll",
    new PollRequest(deviceId, 1, "2026-09-11T00:00:00.000Z", "0.1.0", "2.1.1.1", "Windows/x64",
        "3f2a1c9d", new List<CapabilityDescriptor> { new("app.lifecycle.v1", "apply", 1) },
        0, 0, "", 0, Array.Empty<CommandResult>(), null));

Add("poll-request-null-capabilities-and-acks", "poll",
    new PollRequest(deviceId, 2, "2026-09-11T00:00:05.000Z", "0.1.0", "2.1.1.1", "Windows/x64",
        "3f2a1c9d", null, 3, 7, "abc123", 0, Array.Empty<CommandResult>(), null));

Add("poll-request-with-ack-results", "poll",
    new PollRequest(deviceId, 3, "2026-09-11T00:00:10.000Z", "0.1.0", "2.1.1.1", "Windows/x64",
        "3f2a1c9d", new List<CapabilityDescriptor> { new("app.lifecycle.v1", "apply", 1) },
        3, 7, "abc123", 0,
        new List<CommandResult>
        {
            new(commandId, "succeeded"),
            new(otherCommandId, "failed", new { error = "policy-conflict", attempt = 2 }),
        },
        new Dictionary<string, string> { ["theme"] = "applied", ["weather"] = "failed" }));

var json = JsonSerializer.Serialize(new ContractFile("protocol-v1", vectors),
    new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }) + "\n";

if (check)
{
    var existing = File.Exists(outPath) ? File.ReadAllText(outPath) : "";
    if (existing != json)
    {
        Console.Error.WriteLine($"协议契约向量已过期：{outPath} 与当前 C# 序列化输出不一致。请运行 npm run protocol:vectors 重新生成。");
        return 1;
    }
    Console.WriteLine($"{vectors.Count} 条 C#→TS 协议契约向量与已提交文件一致");
    return 0;
}

File.WriteAllText(outPath, json, new System.Text.UTF8Encoding(false));
Console.WriteLine($"写入 {outPath}：{vectors.Count} 条 C#→TS 协议契约向量");
return 0;

internal sealed record ContractVector(string Name, string Schema, string Json);
internal sealed record ContractFile(string Version, List<ContractVector> Vectors);