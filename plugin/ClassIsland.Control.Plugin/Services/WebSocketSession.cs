using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace ClassIsland.Control.Plugin.Services;

// 贡献者：威廉（WebSocket 常驻会话：常驻连接 / 接收循环 / 心跳应答 / 主动推送唤醒）

/// <summary>
/// 集控端 WebSocket 常驻会话。
///
/// 与 HTTP 轮询共用同一份签名信封与响应校验（见 <see cref="ControlPlaneClient"/>），
/// 本类型只承载“一条常驻长连接 + 独立接收循环”：
///   - 收到服务端 ping 自动回 pong，维持在线判定；
///   - 收到 notify（集控端主动推送）触发 <see cref="Notified"/>，轮询循环据此提前上报；
///   - 收到 poll-result / error 交给当前等待中的轮询调用；
///   - 连接意外断开触发 <see cref="ConnectionLost"/>，轮询循环立即重连，不必等下一次定时。
///
/// 轮询仍是“发一条等一条”，但连接常驻，集控端可在任意时刻唤醒设备，
/// 从而满足“实时通道上客户端主动上报”的需求：上报走 poll，唤醒走 notify。
/// </summary>
public sealed class WebSocketSession(PluginSettingsStore store, ILogger<WebSocketSession> logger) : IAsyncDisposable
{
    private const string WebSocketPath = "/api/v1/agent/ws";
    private const int MaxWebSocketResponseBytes = 512 * 1024;
    private static readonly TimeSpan PollTimeout = TimeSpan.FromSeconds(45);

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private readonly SemaphoreSlim _pollGate = new(1, 1);
    private readonly object _pendingLock = new();
    private ClientWebSocket? _socket;
    private CancellationTokenSource? _loopCts;
    private TaskCompletionSource<string>? _pendingPoll;
    private bool _closing;

    /// <summary>集控端主动推送（notify）到达：轮询循环据此提前醒来上报。</summary>
    public event Action? Notified;
    /// <summary>长连接意外断开：轮询循环据此立即重连，不必等下一次定时。</summary>
    public event Action? ConnectionLost;

    /// <summary>
    /// 在常驻连接上提交一次轮询并等待服务端回复（poll-result / error）。
    /// 连接未建立或已断开时自动重连；回复超时或会话被关闭时抛异常。
    /// </summary>
    public async Task<string> PollAsync(byte[] payload, CancellationToken cancellationToken)
    {
        await _pollGate.WaitAsync(cancellationToken);
        try
        {
            var socket = await EnsureConnectedAsync(cancellationToken);
            var reply = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_pendingLock) _pendingPoll = reply;
            try
            {
                await _sendGate.WaitAsync(cancellationToken);
                try { await socket.SendAsync(payload, WebSocketMessageType.Text, true, cancellationToken); }
                finally { _sendGate.Release(); }
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(PollTimeout);
                return await reply.Task.WaitAsync(timeout.Token);
            }
            catch
            {
                // 回复丢失或超时：丢弃这条连接，下一次轮询重新握手并重新校验服务端身份。
                await ResetSocketAsync();
                throw;
            }
            finally { lock (_pendingLock) _pendingPoll = null; }
        }
        finally { _pollGate.Release(); }
    }

    /// <summary>关闭并丢弃常驻连接，供传输切换或退出时调用。幂等。</summary>
    public async Task CloseAsync()
    {
        _closing = true;
        await _gate.WaitAsync();
        try { await ResetSocketAsync(); }
        finally { _gate.Release(); }
    }

    public async ValueTask DisposeAsync()
    {
        await CloseAsync();
        _gate.Dispose();
        _sendGate.Dispose();
        _pollGate.Dispose();
    }

    private async Task<ClientWebSocket> EnsureConnectedAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
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
            _closing = false;
            _loopCts = new CancellationTokenSource();
            _ = Task.Run(() => ReceiveLoopAsync(socket, _loopCts.Token), CancellationToken.None);
            return socket;
        }
        finally { _gate.Release(); }
    }

    private async Task ResetSocketAsync()
    {
        var socket = _socket;
        _socket = null;
        var loopCts = _loopCts;
        _loopCts = null;
        if (loopCts is not null)
        {
            loopCts.Cancel();
            loopCts.Dispose();
        }
        if (socket is null) return;
        try
        {
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "reconnect", CancellationToken.None);
        }
        catch (Exception) { /* 关闭失败同样只需丢弃连接。 */ }
        socket.Dispose();
    }

    /// <summary>常驻接收循环：读文本帧并按 type 路由（ping 回 pong / notify 唤醒 / poll-result 与 error 交给等待中的轮询）。</summary>
    private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[16 * 1024];
        using var payload = new MemoryStream();
        try
        {
            while (!cancellationToken.IsCancellationRequested &&
                   socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                var result = await socket.ReceiveAsync(buffer, cancellationToken);
                if (result.MessageType == WebSocketMessageType.Close) break;
                if (result.MessageType != WebSocketMessageType.Text) { payload.SetLength(0); continue; }
                payload.Write(buffer, 0, result.Count);
                if (payload.Length > MaxWebSocketResponseBytes) { payload.SetLength(0); continue; }
                if (!result.EndOfMessage) continue;
                var text = Encoding.UTF8.GetString(payload.ToArray());
                payload.SetLength(0);
                await RouteMessageAsync(socket, text);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "WebSocket 接收循环退出。");
        }
        finally
        {
            // 连接已死：通知轮询循环立即重连；主动关闭（CloseAsync）不触发。
            if (!_closing)
            {
                try { ConnectionLost?.Invoke(); }
                catch { /* 回调异常不影响会话状态。 */ }
            }
        }
    }

    private async Task RouteMessageAsync(ClientWebSocket socket, string text)
    {
        string? type;
        try
        {
            using var document = JsonDocument.Parse(text);
            type = document.RootElement.TryGetProperty("type", out var typeValue) ? typeValue.GetString() : null;
        }
        catch (JsonException)
        {
            logger.LogWarning("收到无法解析的 WebSocket 消息。");
            return;
        }
        switch (type)
        {
            case "ping":
                // 服务端空闲心跳：回 pong 维持在线判定。
                await SendPongAsync(socket);
                break;
            case "notify":
                Notified?.Invoke();
                break;
            case "poll-result":
            case "error":
                // 轮询是串行的（一次一个在途请求），服务端只会在应答当前 poll 时发这两类消息。
                lock (_pendingLock)
                {
                    var pending = _pendingPoll;
                    _pendingPoll = null;
                    pending?.TrySetResult(text);
                }
                break;
            default:
                logger.LogWarning("收到未知 WebSocket 消息类型：{Type}。", type ?? "(null)");
                break;
        }
    }

    private async Task SendPongAsync(ClientWebSocket socket)
    {
        try
        {
            var pong = JsonSerializer.SerializeToUtf8Bytes(new { type = "pong" });
            await _sendGate.WaitAsync();
            try { await socket.SendAsync(pong, WebSocketMessageType.Text, true, CancellationToken.None); }
            finally { _sendGate.Release(); }
        }
        catch (Exception exception)
        {
            // 连接可能已被重置；下一轮轮询会重新握手。
            logger.LogDebug(exception, "发送 pong 失败。");
        }
    }

    private Uri ResolveServerUri()
    {
        // 兼容 http(s) 部署：直接使用集控地址，不再强制非本机必须 https。
        return new Uri(store.Settings.ServerUrl, UriKind.Absolute);
    }
}
