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

// 课表上传（贡献者：威廉）：摘要 + 全量快照，以及仅摘要两种形态。
var timetable = JsonSerializer.SerializeToElement(new
{
    name = "高一（3）班",
    timeLayouts = new Dictionary<string, object>
    {
        ["b3f4c5d6-4a5b-4c6d-8e7f-0a1b2c3d4e5f"] = new
        {
            name = "夏秋季作息",
            layouts = new[] { new { startTime = "08:00", endTime = "08:45" } },
        },
    },
    classPlans = new Dictionary<string, object>
    {
        ["a1b2c3d4-1a2b-3c4d-8e6f-7a8b9c0d1e2f"] = new
        {
            name = "周一",
            timeLayoutId = "b3f4c5d6-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
            classes = new[] { new { subjectId = "11111111-2222-3333-8444-555555555555" } },
        },
    },
    subjects = new Dictionary<string, object>
    {
        ["11111111-2222-3333-8444-555555555555"] = new { name = "语文" },
        ["66666666-7777-8888-9999-aaaaaaaaaaaa"] = new { name = "数学" },
    },
    classPlanGroups = new Dictionary<string, object>
    {
        ["9a8b7c6d-5e4f-4a3b-8c2d-1e0f1a2b3c4d"] = new { name = "默认", isGlobal = false },
    },
    selectedClassPlanGroupId = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f1a2b3c4d",
}, ProtocolJson.Options);

Add("poll-request-with-timetable", "poll",
    new PollRequest(deviceId, 4, "2026-09-11T00:00:15.000Z", "0.1.0", "2.1.1.1", "Windows/x64",
        "3f2a1c9d", null, 3, 7, "abc123", 0, Array.Empty<CommandResult>(), null,
        0, "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d", timetable));

Add("poll-request-timetable-digest-only", "poll",
    new PollRequest(deviceId, 5, "2026-09-11T00:00:20.000Z", "0.1.0", "2.1.1.1", "Windows/x64",
        "3f2a1c9d", null, 3, 7, "abc123", 0, Array.Empty<CommandResult>(), null,
        0, "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f"));

// 崩溃上报：随轮询携带本机未处理异常；Id 由客户端生成，服务端据此幂等去重。
Add("poll-request-with-crash-reports", "poll",
    new PollRequest(deviceId, 6, "2026-09-11T00:00:25.000Z", "0.1.0", "2.1.1.1", "Windows/x64",
        "3f2a1c9d", null, 3, 7, "abc123", 0, Array.Empty<CommandResult>(), null,
        0, null, null,
        new List<RemoteCrashReport>
        {
            new("4c1a9f0b7d2e4a5c8f3b1d6e9a0c2f47", "2026-09-11T00:00:21.000Z", "unhandled-exception",
                "System.NullReferenceException", "Object reference not set to an instance of an object.",
                "   at ClassIsland.Controls.MainWindow.OnLoaded(Object sender, RoutedEventArgs e)\n   at Avalonia.Interactivity.RoutedEvent.InvokeHandler(Object sender, RoutedEventArgs e)",
                "UI Thread", "2.1.1.1", "0.1.0", "Windows/x64"),
            new("8d5b2c4e6f7a9b0c1d2e3f4051627384", "2026-09-11T00:00:22.000Z", "unobserved-task",
                "System.Threading.Tasks.TaskCanceledException", "A task was canceled.",
                "   at System.Net.Http.HttpClient.SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)",
                "", "2.1.1.1", "0.1.0", "Windows/x64"),
        }));

// 换行显式写死 LF：默认跟随平台（Windows 是 CRLF），会让同一份向量在两个平台上
// 产生不同字节，从而让 --check 在别的系统上误报“向量已过期”。
var json = JsonSerializer.Serialize(new ContractFile("protocol-v1", vectors),
    new JsonSerializerOptions(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        NewLine = "\n",
    }) + "\n";

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