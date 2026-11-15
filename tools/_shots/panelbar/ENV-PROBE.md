# QA 环境能力探针记录（qa-verifier · 2026-11-14）

> 目的：记录「为什么本机真机截图跑不起来」的可复现证据。命令都在本仓库根目录执行。

## 结论（TL;DR）

| 能力 | 结果 | 证据 |
|---|---|---|
| Node 启动子进程（任意 exe，stdio=pipe 或 ignore） | ❌ `spawn EPERM` | `_attempt.mjs` 走 child_process |
| pwsh `Start-Process` 启动 Chrome 157 | ❌ 浏览器自身 FATAL 退出 | `FATAL mojo\public\cpp\platform\platform_channel.cc:112 Check failed: 拒绝访问。(0x5)`，退出码 `0x80000005` |
| pwsh `Start-Process` 启动 Edge 157（同内核） | ❌ 同上（第 187 行） | 退出码 `0xC0000005` |
| WebView2 `msedgewebview2.exe` | ❌ 同上 | 退出码 13 |
| Tabbit Browser（Electron，已被 tabbit-cli 使用） | ❌ 同上 | crashpad `crash_server failed to launch, self-terminating` |
| 系统里其他 WebView2 宿主（GameViewer / magpie） | ✅ 正常运行（沙箱**之外**的进程） | `Get-CimInstance Win32_Process` 可见 |
| DSH 自带 chrome-devtools-mcp / tabbit-cli 直接启动浏览器 | ❌ | `tabbit-cli create` → `{"error":{"code":"BROWSER_LAUNCH_FAILED"}}` |
| 开发静态服务 `node tools/serve.mjs`（PORT=5190） | ✅ | `GET /index.html → 200` |

**判读**：沙箱阻止了子进程继承/创建内核对象与命名管道；Chromium 家族的浏览器都要靠
**命名管道（mojo `platform_channel`）** 在 browser 进程 ↔ 渲染/GPU/网络进程之间通信，所以连
「主进程启动」这一步都过不去，更谈不上 `--remote-debugging-port`。这与页面代码无关，是**执行环境限制**。

## 复现命令

```powershell
# 1) Node 的子进程能力（预期 spawn EPERM）
node -e "require('node:child_process').spawn(process.execPath,['-e','0'],{stdio:'pipe'})"

# 2) 浏览器启动能力（预期 FATAL: mojo platform_channel Check failed）
node tools/_shots/panelbar/_attempt.mjs "http://127.0.0.1:5190/index.html?autostart=1"
$env:CDP_EXE="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"; node tools/_shots/panelbar/_attempt.mjs "http://127.0.0.1:5190/index.html?autostart=1"

# 3) 观察 FATAL 全文（把 stderr 重定向到文件再读）
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  -ArgumentList "--headless=new --no-sandbox --user-data-dir=$env:TEMP\poe-qa-x --remote-debugging-port=9400 about:blank" `
  -RedirectStandardError "$env:TEMP\poe-x.err"
Get-Content "$env:TEMP\poe-x.err"
```

已尝试但**无效**的绕行（均 FATAL 同一行）：`--no-sandbox`、`--headless`(老)、`--no-zygote`、
`--single-process`、`--in-process-gpu`、`--no-startup-window`、`--disable-gpu`、
`--disable-features=NetworkServiceSandbox|NetworkService|StrictSecurity|RendererCodeIntegrity`、
`--no-proxy-server`、`--disable-crash-reporter`、把 chrome.exe 复制到工作区、以**非管理员**权限
`-Verb RunAs` 启动、把启动委托给非祖先进程、启动 Edge / WebView2 / Tabbit。

## 在本机之外（沙箱允许子进程的环境）补跑真机验收

```powershell
# 终端 A：开发服务
$env:PORT="5190"; node tools/serve.mjs

# 终端 B：浏览器（把 DevTools 端口开出来）
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --no-sandbox `
  --disable-crash-reporter --disable-breakpad --window-size=1280,720 `
  --user-data-dir="$env:TEMP\poe-qa-chrome" --remote-debugging-port=9339 --remote-allow-origins=* about:blank

# 终端 C：验收（脚本自己绝不 spawn，只连 DevTools 端口）
node tools/qa-shots.mjs --port=9339 --serve-port=5190
```

产出：`tools/_shots/panelbar/{results.json,REPORT.md}` + `1280x720-*` / `1920x1080-*` 截图。
若还是起不来，`node tools/qa-shots.mjs --launch-plan` 会打印每个候选浏览器的完整命令行。