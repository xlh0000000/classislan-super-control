using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using ClassIsland.Core;
using ClassIsland.Core.Abstractions.Services;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace ClassIsland.Control.Plugin.Services;

// 贡献者：威廉（课表上传携带与改动唤醒上报 / WebSocket 双态分叉与主动推送唤醒）

public sealed class PollingHostedService(
    PluginSettingsStore store,
    ControlPlaneClient client,
    WebSocketSession session,
    CapabilityCatalog capabilities,
    PolicyApplyService policyApply,
    PolicySnapshotStore snapshots,
    HostOperationService operations,
    TimeOffsetService timeOffset,
    RollCallStore rollCall,
    TimetableSnapshotService timetable,
    CrashReporter crashReporter,
    AgentStatus status,
    IServiceProvider services,
    ILogger<PollingHostedService> logger) : BackgroundService
{
    private static readonly JsonSerializerOptions JsonOptions = ProtocolJson.Options;
    private readonly TaskCompletionSource _appStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
    /// <summary>课表改动唤醒句柄：本机档案变化时提前醒来上报，不等下一次定时轮询。</summary>
    private TaskCompletionSource _changeWake = new(TaskCreationOptions.RunContinuationsAsynchronously);
    /// <summary>实时通道唤醒句柄：集控端主动推送（notify）或长连接断开时提前醒来上报。</summary>
    private TaskCompletionSource _notifyWake = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private DateTime? _lastTimetableChangeUtc;

    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        AppBase.Current.AppStarted += OnAppStarted;
        if (AppBase.Current.MainWindow is not null) _appStarted.TrySetResult();
        try
        {
            await base.StartAsync(cancellationToken);
        }
        catch
        {
            AppBase.Current.AppStarted -= OnAppStarted;
            throw;
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await _appStarted.Task.WaitAsync(stoppingToken);
        // 课表上传：本机档案改动时提前醒来上报（不改变轮询本身的节奏）。
        timetable.Changed += OnTimetableChanged;
        // 崩溃上报：报告一落盘就立刻醒来上报，不等下一个轮询周期。
        crashReporter.Reported += OnCrashReported;
        // 实时模式：集控端主动推送（notify）或长连接断开时提前醒来上报。
        session.Notified += OnSessionWake;
        session.ConnectionLost += OnSessionWake;
        try
        {
            await ExecuteLoopAsync(stoppingToken);
        }
        finally
        {
            timetable.Changed -= OnTimetableChanged;
            crashReporter.Reported -= OnCrashReported;
            session.Notified -= OnSessionWake;
            session.ConnectionLost -= OnSessionWake;
        }
    }

    private void OnTimetableChanged()
    {
        _lastTimetableChangeUtc = DateTime.UtcNow;
        _changeWake.TrySetResult();
    }

    private void OnCrashReported() => _changeWake.TrySetResult();

    private void OnSessionWake() => _notifyWake.TrySetResult();

    private async Task ExecuteLoopAsync(CancellationToken stoppingToken)
    {
        await RecoverJournalAsync(stoppingToken);
        if (!string.IsNullOrWhiteSpace(store.State.DeviceId))
        {
            status.Restore(store.State);
            // 本地策略文件可能被改写或删除：启动时先用服务端签名过的快照恢复设置锁定，
            // 不必等待下一次策略下发（服务端认为设备已是最新时不会再发策略）。
            policyApply.ReapplyPersistedSettingsLocks();
        }
        var failures = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            var nextSeconds = 30;
            try
            {
                // 解除集控的回执已被服务端接收：此刻才真正清除本地身份。
                // 反过来说，只要回执还没送达，设备就仍然保持接入状态。
                if (store.State.PendingRelease is { } release &&
                    !store.State.PendingAcknowledgements.Any(ack => ack.CommandId == release.CommandId))
                {
                    await store.ReleaseEnrollmentAsync(stoppingToken);
                    status.EnrollmentReleased();
                    // 身份已清空：长连接对旧身份毫无意义，立即断开让服务端不再推送。
                    await client.CloseWebSocketAsync();
                    logger.LogInformation("Control plane released this device (command {CommandId}).", release.CommandId);
                    await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
                    continue;
                }
                if (string.IsNullOrWhiteSpace(store.Settings.ServerUrl))
                {
                    await client.CloseWebSocketAsync();
                    status.Waiting("未配置服务器地址，请填写集控地址与一次性接入码");
                    await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
                    continue;
                }
                if (string.IsNullOrWhiteSpace(store.State.DeviceId))
                {
                    // 已由集控端解除接入：保持空闲等待管理员重新下发接入码，不再重试注册。
                    if (string.IsNullOrWhiteSpace(store.Settings.EnrollmentToken))
                    {
                        await client.CloseWebSocketAsync();
                        status.Waiting("未加入集控：请填写一次性接入码");
                        await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
                        continue;
                    }
                    await EnrollAsync(stoppingToken);
                }
                var catalog = capabilities.Detect();
                var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(catalog)))).ToLowerInvariant();
                var state = store.State;
                // 课表上传：开启且宿主可用时每轮带摘要；本机档案有改动时带全量快照。
                var timetableEnabled = store.Settings.TimetableUploadEnabled && timetable.Available;
                var timetableDigest = timetableEnabled ? timetable.Digest : null;
                var timetableSnapshot = timetableEnabled && timetable.IsDirty ? timetable.Snapshot : (JsonElement?)null;
                // 崩溃上报：只带上仍未被服务端确认的报告，确认后才从本地 outbox 移除。
                var crashes = crashReporter.Pending();
                // 重试必须重建正文：服务端会校验时间戳窗口，复用旧正文会让设备永久卡在 401。
                // 仅沿用上一次未确认的序列号，保证不跳号、又不重复占用已入库的序列。
                var request = new PollRequest(
                    state.DeviceId,
                    state.PendingPoll?.Sequence ?? state.Sequence + 1,
                    DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture),
                    "0.1.1",
                    AppBase.AppVersion,
                    $"{AppBase.Current.OperatingSystem}/{AppBase.Current.Platform}",
                    digest,
                    catalog,
                    state.PolicyRevision,
                    state.PolicyEpoch,
                    state.LastPolicyHash,
                    state.DriftCount,
                    state.PendingAcknowledgements.ToArray(),
                    state.AppliedSections,
                    rollCall.Snapshot.Revision,
                    timetableDigest,
                    timetableSnapshot,
                    crashes.Count > 0 ? crashes : null);
                if (request.AppliedSections is null) request = request with { AppliedSections = new Dictionary<string, string>() };
                if (state.PendingPoll?.Sequence != request.Sequence)
                {
                    state = state with { PendingPoll = request };
                    await store.SaveStateAsync(state, stoppingToken);
                }
                status.AttemptStarted();
                // 连接模式由集控端指定：每次都用当前值选择传输，切换后立刻丢弃旧连接。
                var poll = store.Settings.Transport == "websocket"
                    ? await client.PollOverWebSocketAsync(request, stoppingToken)
                    : await client.PollAsync(request, stoppingToken);
                var response = poll.Response;
                if (response.Transport is { Length: > 0 } transport && transport != store.Settings.Transport)
                {
                    await store.ApplyServerTransportAsync(transport, stoppingToken);
                    if (transport != "websocket") await client.CloseWebSocketAsync();
                    else _notifyWake.TrySetResult(); // 切到实时模式：立刻建立常驻连接
                    logger.LogInformation("Control plane switched the transport to {Transport}.", transport);
                }
                // 自动时间偏移：以集控端时间为基准闭环校正宿主时钟；未启用时是空操作。
                timeOffset.ObserveServerTime(response.ServerTimeUtc, HostClock(), poll.RoundTrip);
                // 每日自动偏移：按“今天”重算生效值，跨过零点即自动加一档；未启用时是空操作。
                timeOffset.TickDaily();
                // 点名内容：服务端只在设备手上的修订过期时回带整份（名单 + 设置），落盘后供悬浮窗离线使用。
                if (response.RollCall is { } delivered)
                    await rollCall.ApplyAsync(delivered.Revision, delivered.Names, delivered.Settings, stoppingToken);
                // 课表上传：服务端要求重传时强制下次带全量；接受后清除待重传标记。
                if (timetableEnabled)
                {
                    if (response.TimetableRequired) timetable.ForceRetransmit();
                    else timetable.MarkUploaded();
                    status.TimetableUpdated(timetable.IsDirty
                        ? "课表已采集，等待上传"
                        : $"已上传 · 课表 {timetable.ClassPlansCount} · 时间表 {timetable.TimeLayoutsCount} · 科目 {timetable.SubjectsCount} · 群 {timetable.ClassPlanGroupsCount} · 摘要 {timetable.Digest[..8]}");
                }
                else
                {
                    status.TimetableUpdated(store.Settings.TimetableUploadEnabled
                        ? "宿主未提供档案服务，课表上传不可用"
                        : "课表上传已关闭");
                }
                // 崩溃上报：轮询已被服务端接收（入库发生在响应构建之前），此时才清空本地 outbox。
                if (crashes.Count > 0) crashReporter.Confirm(crashes.Select(report => report.Id));
                status.CrashUpdated(crashReporter.Summary());
                state = state with { PendingPoll = null };
                // 只删除服务端明确回执（accepted/already-recorded）的 ACK；被拒绝的结果必须保留并告警，
                // 否则“管理员已取消但设备实际执行成功”等冲突会被静默丢弃。
                if (response.Acknowledgements is { } receipts)
                {
                    var settled = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var receipt in receipts)
                    {
                        if (receipt.Status is "accepted" or "already-recorded") settled.Add(receipt.CommandId);
                        else logger.LogWarning("Command {CommandId} acknowledgement rejected: {Reason} (server state {State}); keeping result for reconciliation.", receipt.CommandId, receipt.Reason ?? "unknown", receipt.State ?? "unknown");
                    }
                    if (settled.Count > 0)
                    {
                        var kept = state.PendingAcknowledgements.Where(acknowledgement => !settled.Contains(acknowledgement.CommandId)).ToList();
                        if (kept.Count != state.PendingAcknowledgements.Count) state = state with { PendingAcknowledgements = kept };
                    }
                }
                else
                {
                    // 兼容未返回逐条回执的旧服务端；无法确认接收，保守清空并告警。
                    logger.LogWarning("Poll response omitted acknowledgement receipts; clearing the outbox without confirmation (legacy server).");
                    state = state with { PendingAcknowledgements = [] };
                }
                var driftCount = 0;
                if (response.Policy is { } policy && (policy.Epoch != state.PolicyEpoch || policy.Revision > state.PolicyRevision || !CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(policy.DocumentHash), Encoding.ASCII.GetBytes(state.LastPolicyHash))))
                {
                    var canonicalPolicy = Jcs.Canonicalize(policy.Document);
                    var policyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalPolicy))).ToLowerInvariant();
                    if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(policyHash), Encoding.ASCII.GetBytes(policy.DocumentHash)))
                        throw new CryptographicException("Policy document hash is invalid.");
                    var apply = await policyApply.ApplyAsync(policy.Document);
                    driftCount = apply.DriftCount;
                    state = state with { AppliedSections = apply.Sections is null ? new Dictionary<string, string>() : new Dictionary<string, string>(apply.Sections) };
                    if (apply.Applied)
                    {
                        state = state with { PolicyRevision = policy.Revision, PolicyEpoch = policy.Epoch, LastPolicyHash = policy.DocumentHash };
                        status.PolicyApplied(policy.Revision, policy.Epoch, apply.Sections);
                        // 落盘服务端签名过的正文：重启后据此离线恢复设置锁定。
                        snapshots.Save(poll.RawJson, poll.ServerKeyId, poll.ServerSignature);
                    }
                    else
                    {
                        logger.LogWarning("Policy R{Revision} (epoch {Epoch}) failed to apply: {Error}", policy.Revision, policy.Epoch, apply.Error);
                        status.PolicyFailed(apply.Error ?? "策略应用失败");
                    }
                }
                foreach (var envelope in response.Commands)
                {
                    if (state.CompletedCommands.Contains(envelope.CommandId)) continue;
                    // 先落盘“即将执行”，再产生任何副作用。若执行中崩溃，恢复流程会补发回执。
                    state = state with { Journal = [.. state.Journal, new CommandJournalEntry(envelope.CommandId, envelope.CapabilityId, "prepared")] };
                    await store.SaveStateAsync(state, stoppingToken);
                    var pendingState = state;
                    var result = await operations.ExecuteAsync(
                        new RemoteCommand(envelope.CommandId, envelope.CapabilityId, envelope.Payload, envelope.ExpiresAtUtc, envelope.SchemaVersion, envelope.NotBeforeUtc),
                        async terminating =>
                        {
                            var acknowledged = pendingState with { Journal = pendingState.Journal.Where(entry => entry.CommandId != envelope.CommandId).ToList() };
                            acknowledged.PendingAcknowledgements.Add(terminating);
                            acknowledged.CompletedCommands.Add(envelope.CommandId);
                            await store.SaveStateAsync(acknowledged, stoppingToken);
                        });
                    // 命令可能改变入网状态（如解除集控）；必须以存储中的最新状态为基准继续写入，
                    // 否则本轮的收尾写入会把刚清空的身份又写回去。
                    var latest = store.State;
                    state = latest with
                    {
                        Journal = latest.Journal.Where(entry => entry.CommandId != envelope.CommandId).ToList(),
                        PendingAcknowledgements = [.. latest.PendingAcknowledgements, result],
                    };
                    if (result.State is "succeeded" or "failed" or "conflict" or "unsupported" or "expired")
                        state = state with { CompletedCommands = [.. state.CompletedCommands, envelope.CommandId] };
                }
                // 本轮内被集控端解除接入：不再推进序列号，避免下次接入时序列跳号。
                state = store.State.DeviceId.Length == 0
                    ? state with { Sequence = 0, DriftCount = 0 }
                    : state with { Sequence = state.Sequence + 1, DriftCount = driftCount };
                await store.SaveStateAsync(state, stoppingToken);
                // 实时模式的定时只是兜底（上限 60 秒）：集控端 notify 会随时唤醒，不必按 HTTP 轮询的 30 秒上限赶点。
                nextSeconds = Math.Clamp(response.NextPollSeconds, 5, store.Settings.Transport == "websocket" ? 60 : 30);
                if (driftCount > 0) nextSeconds = Math.Min(nextSeconds, 15);
                status.AttemptSucceeded();
                failures = 0;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (HttpRequestException exception) when (exception.StatusCode == System.Net.HttpStatusCode.Conflict)
            {
                // 序列被占用：说明该正文此前已被服务端接收、只是响应丢失。对齐本地序列后立刻重试。
                var current = store.State;
                if (exception is SequenceConflictException { ServerSequence: var serverSequence } &&
                    serverSequence > current.Sequence)
                {
                    // 本地状态被清空或重建：直接跳到服务端权威序列，避免逐号追赶。
                    await store.SaveStateAsync(current with { Sequence = serverSequence, PendingPoll = null }, stoppingToken);
                    logger.LogWarning("Local sequence {Local} is behind the server; aligned to {Server}.", current.Sequence, serverSequence);
                }
                else if (current.PendingPoll is { } pending)
                {
                    await store.SaveStateAsync(current with { Sequence = pending.Sequence, PendingPoll = null }, stoppingToken);
                    logger.LogWarning("Poll sequence {Sequence} was already recorded by the server; aligned local sequence.", pending.Sequence);
                }
                status.AttemptFailed("同步序列已对齐，正在重新同步…");
                failures = 0;
                nextSeconds = 5;
            }
            catch (Exception exception)
            {
                status.AttemptFailed(exception.Message);
                failures++;
                // 实时模式退避到 60 秒封顶：长连接失败时 ConnectionLost 会立即唤醒重连，无需按 HTTP 指数退避干等。
                var backoffCap = store.Settings.Transport == "websocket" ? 60 : 600;
                nextSeconds = Math.Min(backoffCap, (int)Math.Pow(2, Math.Min(failures, 8)));
                logger.LogWarning(exception, "ClassIsland Control polling failed; retrying in {Delay}s", nextSeconds);
            }
            var wake = _changeWake;
            _changeWake = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var notifyWake = _notifyWake;
            _notifyWake = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var jitter = Random.Shared.NextDouble() * .4 + .8;
            // 本机课表刚改动：最多等 5 秒就醒来上报，其余情况按服务端节奏休眠。
            var changedRecently = _lastTimetableChangeUtc is { } at && DateTime.UtcNow - at < TimeSpan.FromSeconds(5);
            var delay = TimeSpan.FromSeconds((changedRecently ? Math.Min(nextSeconds, 5) : nextSeconds) * jitter);
            // 实时模式：集控端主动推送（notify）或长连接断开时立即醒来，不必等完整个定时。
            await Task.WhenAny(wake.Task, notifyWake.Task, Task.Delay(delay, stoppingToken));
        }
    }

    /// <summary>
    /// 崩溃恢复：日志中仍为 prepared 的命令表示“副作用可能已发生，但回执未送达”，
    /// 统一补发终态回执，确保服务端不会无限重投。
    /// </summary>
    private async Task RecoverJournalAsync(CancellationToken cancellationToken)
    {
        var state = store.State;
        if (state.Journal.Count == 0) return;
        foreach (var entry in state.Journal)
        {
            var result = entry.Result ?? new CommandResult(entry.CommandId, "failed", new { error = "execution-interrupted-before-ack", recovered = true });
            state.PendingAcknowledgements.Add(result);
            state.CompletedCommands.Add(entry.CommandId);
        }
        logger.LogWarning("Recovered {Count} interrupted command(s) from the persistent journal.", state.Journal.Count);
        await store.SaveStateAsync(state with { Journal = [] }, cancellationToken);
    }

    private async Task EnrollAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(store.Settings.EnrollmentToken)) throw new InvalidOperationException("Enrollment token is required.");
        var publicKeyJwk = await EnsureEnrollmentKeyAsync(store.State, cancellationToken);
        var response = await client.EnrollAsync(new EnrollmentRequest(store.Settings.EnrollmentToken, store.Settings.DeviceName, publicKeyJwk, null, "0.1.1", AppBase.AppVersion, $"{AppBase.Current.OperatingSystem}/{AppBase.Current.Platform}"), cancellationToken);
        await store.SaveStateAsync(store.State with
        {
            DeviceId = response.DeviceId,
            ServerSigningPublicKey = response.ServerSigningPublicKey,
            ServerSigningKeyId = response.ServerSigningKeyId
        }, cancellationToken);
        await store.SaveSettingsAsync(store.Settings with { EnrollmentToken = "" }, cancellationToken);
        status.Enrolled(response.DeviceId);
    }

    /// <summary>
    /// 注册前先持久化设备密钥，并在重试时复用同一身份。
    /// 这样注册响应即使丢失，重试也会命中服务端的幂等接入，而不是重复消费令牌或产生孤儿设备。
    /// </summary>
    private async Task<Dictionary<string, object>> EnsureEnrollmentKeyAsync(AgentState state, CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(state.DevicePrivateKey) && !string.IsNullOrWhiteSpace(state.DevicePublicKey))
        {
            using var persisted = ECDsa.Create();
            persisted.ImportPkcs8PrivateKey(Convert.FromBase64String(state.DevicePrivateKey), out _);
            return BuildPublicJwk(persisted.ExportParameters(false));
        }
        using var generated = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        await store.SaveStateAsync(state with
        {
            DevicePrivateKey = Convert.ToBase64String(generated.ExportPkcs8PrivateKey()),
            DevicePublicKey = Convert.ToBase64String(generated.ExportSubjectPublicKeyInfo())
        }, cancellationToken);
        return BuildPublicJwk(generated.ExportParameters(false));
    }

    private static Dictionary<string, object> BuildPublicJwk(ECParameters parameters) => new()
    {
        ["kty"] = "EC",
        ["crv"] = "P-256",
        ["x"] = Base64Url(parameters.Q.X!),
        ["y"] = Base64Url(parameters.Q.Y!)
    };
    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>宿主当前显示的本地时间；IExactTimeService 不可用时回落到系统时间。</summary>
    private DateTime HostClock() =>
        services.GetService<IExactTimeService>()?.GetCurrentLocalDateTime() ?? DateTime.Now;

    private void OnAppStarted(object? sender, EventArgs e) => _appStarted.TrySetResult();

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        AppBase.Current.AppStarted -= OnAppStarted;
        timetable.Changed -= OnTimetableChanged;
        crashReporter.Reported -= OnCrashReported;
        session.Notified -= OnSessionWake;
        session.ConnectionLost -= OnSessionWake;
        await client.CloseWebSocketAsync();
        await base.StopAsync(cancellationToken);
    }
}