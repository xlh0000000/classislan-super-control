<div align="center">

# ClassIsland Control Plugin

**ClassIsland Control 的设备端插件**

![.NET](https://img.shields.io/badge/.NET-10-512BD4?logo=dotnet&logoColor=white)
![ClassIsland](https://img.shields.io/badge/ClassIsland-2.1.0.1-2563eb)
![Plugin SDK](https://img.shields.io/badge/Plugin%20SDK-2.1.0.1-2563eb)

</div>

只使用 `ClassIsland.PluginSdk` 的公开类型，不反射或依赖 `ClassIsland.Services.*`。

## 🎲 点名悬浮窗

常驻长方形悬浮窗，背景高斯模糊，整窗可拖动（鼠标与 Windows 触摸共用同一套指针事件）。

| 按钮 | 行为 |
| --- | --- |
| 抽人 | 抽 1 人，屏幕中央弹出名字框，默认 3 秒后淡出 |
| 多人 | 下拉选 2–6 人，停留时长为「多人基准秒数 + 每多一人 1 秒」 |

抽中后同时经插件的提醒提供方拉起 ClassIsland 提醒（可关）。

名单只由集控端下发（本地缓存 `rollcall.json`，按轮询的 `rollCallRevision` 决定何时重新拉取），设备端不可编辑。窗口宽高、不透明度、停留时长与窗口位置在「设置 → 点名 → 点名悬浮窗」调整。

## 🧯 崩溃上报

未处理异常（UI 线程、未观察的任务异常、宿主异常退出）写入本地 outbox（`crash-outbox.json`），随轮询上报，服务端确认接收后才清空，断网期间的崩溃不会丢。设置页显示待上报与已上报条数；归组与统计在集控端完成。

## 🛡 接入约束

设备完成接入后本机不提供取消接入或改接其他集控的入口：写入层把服务器地址、设备身份与密钥折回锁定值，连接方式也由集控端下发。仅集控端下发解除命令、且终态回执被接收后，设备才清除身份与封条副本。