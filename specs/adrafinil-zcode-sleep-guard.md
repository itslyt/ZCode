# Adrafinil + ZCode：按需防休眠（合盖可跑）

状态：已在本机落地并实测通过。**纯配置级机制**——不改 fork 源码，因此没有上游同步成本。
配置落在 `~/.zcode/cli/config.json`（user 层钩子），依赖外部 App [Adrafinil](https://github.com/kageroumado/adrafinil)。

本文是**换机恢复手册**：在一台新 Mac 上，照「四、执行清单」逐步做即可复现，不需要读源码。

## 一、要解决的问题

ZCode 跑长任务时合上盖子，macOS 立刻强制休眠：网络断开、任务全死。**重新打开盖子才能恢复。**

现有手段都不够：

| 手段                                       | 为什么不够                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZCode 内置「保持电脑运行」开关             | 用 `powerSaveBlocker("prevent-app-suspension")`，**只能防空闲休眠，防不了合盖**（设置页文案自己就写了"仍可手动睡眠/合盖休眠"）。且它是**全局常开**，不是按需。 |
| `caffeinate` / Amphetamine                 | 用的是公开 `IOPMAssertion`，**打不过合盖休眠**。Amphetamine 的 Closed-Display Mode 在 Apple Silicon 上还要求外接电源（Power Protect）。                  |
| `sudo pmset -a disablesleep 1`             | 有效，但是**全局手动开关**：跑完忘记恢复，笔记本塞进背包会持续发热。                                                                                    |
| 自写 hook 脚本 + `sudoers.d` 免密          | 思路对，但**引用计数极难写对**——多个任务并发时，先结束的那个会把还在跑的任务一起睡掉。                                                                  |

**Adrafinil 的做法**：Menu bar App + 用户级 daemon（引用计数）+ root helper（唯一接触睡眠开关的组件）。
每次 turn 由 hook `acquire`，turn 结束后 `release`，**计数归零才放开睡眠**；合盖期间由 root helper 用
`pmset disablesleep` 兜住。这是唯一能同时满足「合盖保持 + 按需触发 + 自动恢复」的组合。

### 与 ZCode 内置开关的关系

两者互补，**不要互相替代**：

- 内置 `keepAwakeWhileRunning`：全局、常开、只防空闲休眠。默认 `false`，本方案下**建议保持 false**（不需要它）。
- 本方案：按需、防合盖、自动恢复。

## 二、架构与状态所有者

```
ZCode turn 开始 ──UserPromptSubmit hook──▶ adrafinil acquire --tool zcode   ┐
                                                                            ├─▶ Adrafinil daemon（引用计数）
ZCode turn 结束 ──Stop hook──────────────▶ adrafinil release --tool zcode   ┘        │
                                                                                     ▼ XPC
                                                              root helper: setSleepBlocked(Bool)
                                                              （合盖靠 pmset disablesleep）
```

- **唯一状态所有者**：Adrafinil daemon 的断言注册表。ZCode 侧不维护任何状态，hook 只做 acquire/release 转发，天然幂等。
- **key 形状**：`zcode:<session_id>`。acquire 与 release 必须用同一个 `--tool zcode`，否则 release 打到
  `unknown:<id>`，真正的 hold 泄漏（Adrafinil 源码 `ManualHold.sessionKey` 的注释专门警示了这一点）。
- **session_id 来源**：ZCode 在钩子 stdin JSON 里给 `session_id`（`apps/zcode-cli/packages/core/src/hooks/configured-runner-input.ts`）。
  Adrafinil 的 CLI **优先读 stdin**，所以钩子命令不需要 `$SESSION_ID` 位置参数——少一个 shell 展开失败点。
- **并发安全**：每个会话一个独立 key，多任务并发时计数叠加，**不会互相误杀**（这正是自写脚本写不对的地方）。

## 三、已实测确认的关键事实（换机后同样成立）

这几条是本方案的边界，**配置时必须知道**：

| # | 事实                                                                                       | 影响与对策                                                                                                          |
| - | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1 | Adrafinil 内置 9 个 agent（claude-code/codex/cursor/gemini-cli/aider/hermes/opencode/cline/pi），**没有 zcode** | `install-hooks --tool zcode` **报错并 exit 2**（实测）。别用 `... | head` 判断成败——那取到的是 head 的 0，会看成成功。ZCode 侧钩子必须**手配**，见执行清单第 5 步。 |
| 2 | 因第 1 条，运行中断言记录的 `pid` 是 **`-1`**                                              | Adrafinil 的**进程死亡释放**与 **90 秒 CPU 空闲释放对你都不生效**。必须靠 `--ttl` 兜底（见第 4 条与第五节的兜底表）。 |
| 3 | `--ttl` **只认纯秒数**，`1h`/`30m` 会被拒（实测 `ignoring invalid --ttl '1h'`）            | 写 `14400` 而不是 `4h`。                                                                                            |
| 4 | `--ttl` 会被设置项 **`manualHoldMaxHours`（默认 4h）硬夹住**                               | 实测请求 `86400` 实存 `14400`。要更长须改 Adrafinil 设置，改钩子无效。                                              |
| 5 | **重复 acquire 不刷新 TTL**（实测同 key 二次 acquire，`expiresAt` 分毫未变）              | TTL 是「每个 turn 的额度」。单轮连续跑超 4 小时才会中途失效，需调大 `manualHoldMaxHours`。                          |
| 6 | 不带 `--ttl` 时 `expiresAt` 为 **`None`**（无 TTL）                                        | 那样只剩 24h 硬熔断兜底，**不推荐**。始终显式给 `--ttl`。                                                          |
| 7 | `agentWaitingPolicy: grace`（等用户输入时暂缓释放）**对 zcode 无效**                       | 其 `SessionWaitEvaluator` 的 key 前缀硬编码为 `claude-code:`，`zcode:` 开头的 key 被直接跳过。见第六节。            |
| 8 | 钩子进程的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`（桌面 App 从 Finder/Dock 启动时）      | 钩子命令**必须写绝对路径**，不能写 `adrafinil`。同样的坑已记录在 `scripts/hooks/run-todo-closeout.sh` 的注释里。      |
| 9 | 钩子配置在 **CLI 进程创建时**读入（`bootstrap/src/app/create-app.ts` → `runtime-config.ts`） | 改完配置**必须重启 ZCode**才生效，不是热加载。                                                                      |
| 10 | 同一事件下多个钩子条目**顺序全跑**，互不覆盖（`core/src/hooks/runner.ts` 的 `filter`）      | 新增条目不会顶掉已有的 `run-todo-closeout.sh`，放心追加。                                                           |

## 四、执行清单（新机器上照做）

> 下面用 `<REPO>` 指代 ZCode 仓库根目录、`<CLI>` 指代 adrafinil 可执行文件绝对路径。
> 看不清就先跑第 0 步的发现命令，**不要凭记忆填路径**。

### 0. 发现既有环境（先跑，避免重复安装）

```bash
# ZCode 配置在哪、是否已有钩子
python3 -c "import json;d=json.load(open('$HOME/.zcode/cli/config.json'));print(json.dumps(d.get('hooks'),indent=2,ensure_ascii=False))"

# adrafinil 是否已装、装在哪
ls -la /Applications/Adrafinil.app/Contents/Helpers/adrafinil 2>/dev/null || echo "App 未安装"
ls -la "$HOME/.local/bin/adrafinil" /usr/local/bin/adrafinil 2>/dev/null || echo "CLI symlink 不存在"
```

### 1. 安装 Adrafinil（已装则跳过）

```bash
brew install --cask adrafinil
```

或从 [releases](https://github.com/kageroumado/adrafinil/releases/latest) 下 dmg 拖进 `/Applications`。
要求 **macOS 26+**（`sw_vers` 确认）。

### 2. 首次启动 + 授权特权 helper

```bash
open -a Adrafinil
```

菜单栏出现图标后，**首次启动会请求一次管理员授权**——这是注册 root helper 用的，合盖保持依赖它。
**不授权就只能防空闲休眠，防不了合盖**，等于白装。

在 App 里（Settings → General）确认或调整：

| 设置项                    | 建议值 | 说明                                                             |
| ------------------------- | ------ | ---------------------------------------------------------------- |
| `launchAtLogin`           | `true` | 登录自启，否则重启后 hook 调不到 daemon。                        |
| `thermalCutoutEnabled`    | `true` | 内置约 80°C；这是背包里的最后一道保险。                          |
| `lowBatteryCutoutEnabled` | `true` | 低电量（约 20%）放开睡眠。                                       |
| `manualHoldMaxHours`      | `4`    | 同时是 `--ttl` 的硬上限（见第三节第 4 条）。有超长单轮任务再调大。 |
| `idleReleaseEnabled`      | `true` | 对 zcode 无效（见第三节第 2 条），但保留不影响其他 agent。        |

### 3. 确认 CLI 路径

```bash
/Applications/Adrafinil.app/Contents/Helpers/adrafinil version
```

输出 `adrafinil 1.8`（或更高）即可用。**建议直接用这个 bundle 内路径**，而不是 `~/.local/bin/adrafinil`
symlink：官方自己也是这么做的——`CLISymlinker.swift` 的注释说明 symlink 是**异步创建**的，写入钩子时它可能还不存在，
所以钩子里固定烘焙 bundle 路径。直接用 bundle 路径可避开这个时序问题。

```bash
# 这一步的输出就是 <CLI>，填进第 5 步
echo "/Applications/Adrafinil.app/Contents/Helpers/adrafinil"
```

### 4. 备份配置

```bash
cp "$HOME/.zcode/cli/config.json" "$HOME/.zcode/cli/config.json.bak-$(date +%Y%m%d%H%M%S)"
```

### 5. 写入两个钩子

编辑 `~/.zcode/cli/config.json`，在 `hooks.events` 下**追加**（不要替换整个 `events` 对象，会顶掉现有钩子）：

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "UserPromptSubmit": [
        {
          "hooks": [
            {
              "type": "process",
              "command": "<CLI>",
              "args": ["acquire", "--tool", "zcode", "--ttl", "14400"],
              "timeoutMs": 10000,
              "statusMessage": "adrafinil: 保持电脑唤醒"
            }
          ]
        }
      ],
      "Stop": [
        {
          "hooks": [
            {
              "type": "process",
              "command": "<CLI>",
              "args": ["release", "--tool", "zcode"],
              "timeoutMs": 10000,
              "statusMessage": "adrafinil: 恢复休眠"
            }
          ]
        }
      ]
    }
  }
}
```

要点：

- **`hooks.enabled` 必须为 `true`**（默认 `false`）。
- 用 `type: "process"` + `args` 数组，**不要用 shell 拼接**——彻底绕开引号与空格问题。
- `<CLI>` 填绝对路径（第 3 步的输出）。
- 若该事件下已有条目（如 `run-todo-closeout.sh`），**追加为新元素**，保留原有条目。

### 6. 校验 JSON 并确认没破坏现有钩子

```bash
python3 -c "
import json
d=json.load(open('$HOME/.zcode/cli/config.json'))
print('hooks.enabled =', d['hooks'].get('enabled'))
for ev, arr in d['hooks']['events'].items():
    for m in arr:
        for h in m['hooks']:
            print(f'  {ev:18} {h[\"command\"]} {\" \".join(h.get(\"args\", []))}')
"
```

预期看到 4 行：`PostToolUse`/`Stop` 各一条 `run-todo-closeout.sh`（原有），`UserPromptSubmit` 一条 adrafinil acquire，`Stop` 一条 adrafinil release。

### 7. 重启 ZCode

**必须重启**（第三节第 9 条）。钩子配置只在 CLI 进程创建时读入。

### 8. 端到端验证

重启后在 ZCode 里随便发一条消息开始干活，然后在终端看：

```bash
adrafinil status
```

预期在工作期间看到断言（`sess_...` 是你真实的会话 id）：

```
Adrafinil — blocking sleep
  Assertions: 1
    • zcode [zcode:sess_XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX] — 0m 2s
  Helper: connected
```

回答结束后断言消失、回到 `idle`，**这是正确行为**：`Stop` 表示这一轮干完了，没必要继续拦着睡眠。

配对是否正常也可以看事件日志：

```bash
tail -20 "$HOME/Library/Application Support/Adrafinil/events.log"
```

健康的日志是 `acquired` / `released` 成对出现。

### 9. 也可单独验证 CLI 通路（不依赖 ZCode）

```bash
CLI=/Applications/Adrafinil.app/Contents/Helpers/adrafinil
echo '{"session_id":"manual-test","hook_event_name":"UserPromptSubmit"}' | "$CLI" acquire --tool zcode --ttl 14400
adrafinil status                      # 应出现 zcode [zcode:manual-test]
echo '{"session_id":"manual-test"}' | "$CLI" release --tool zcode
adrafinil status                      # 应回到 idle
```

## 五、安全网（漏掉 release 时会发生什么）

因为 `pid=-1`（第三节第 2 条），ZCode 场景下**只剩三道网**，按触发速度排列：

| 兜底                      | 触发条件                              | 对 zcode 是否有效 |
| ------------------------- | ------------------------------------- | ----------------- |
| TTL（我们自己给的 4h）    | 断言年龄 > `--ttl`                    | ✅ 主力            |
| 24h max-age 硬熔断        | 断言年龄 > `maxAssertionAgeHours`(24) | ✅ 最后保险        |
| 热熔断（约 80°C）         | 合盖期间温度超阈值                    | ✅ 与 pid 无关     |
| 低电量熔断（约 20%）      | 电量低于阈值                          | ✅ 与 pid 无关     |
| 进程死亡释放              | 被监视的 pid 退出                     | ❌ `pid=-1`        |
| 90s CPU 空闲释放          | 进程树 CPU 持续空闲                   | ❌ `pid=-1`        |

结论：**最坏情况下（某轮 Stop 没触发）机器会多保持 4 小时不休眠，然后自动放开**，不会无限期挂住。
若你常跑单轮 >4h 的任务，把 `manualHoldMaxHours` 调大，并同步调大钩子里的 `--ttl`。

## 六、已知不生效项（不要误配）

1. **`agentWaitingPolicy` / `agentWaitingGraceMinutes`**：Adrafinil 用它处理「agent 停在提问/权限确认处、不发结束钩子」
   的场景，但 `SessionWaitEvaluator` 里 `keyPrefix` 硬编码为 `claude-code:`，`zcode:` key 被跳过，**对 ZCode 无效**。
   实际影响：ZCode 停在等待输入时，断言可能仍挂着——**这不影响安全**（挂着只是不睡，比睡死好）。
2. **`autoAcquireForKnownAgents` / 进程嗅探**：靠二进制名匹配，`AgentKind` 里没有 zcode，**不会自动识别**。
   本方案不依赖它（走 hook 显式 acquire）。
3. **`adrafinil install-hooks --tool zcode`**：只接受内置 9 个 agent 名，自定义名会被拒。**只能手配 ZCode 侧钩子**。
4. **`--display`**：用于「agent 需要看屏幕」的场景（睡眠会让可访问性树塌掉）。ZCode 的多数工具不需要，未启用。

## 七、排障

| 症状                                   | 先查什么                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `adrafinil status` 一直 `idle`         | 配置是否 `restart` 过（第 7 步）；`hooks.enabled` 是否 `true`；命令是否绝对路径（第三节第 8 条）。        |
| daemon 不在                           | `adrafinil daemon-status`；`launchctl list \| grep adrafin`；App 是否在跑、`launchAtLogin` 是否开了。     |
| `Helper: connected` 显示未连接         | 第 2 步的管理员授权没完成 → 重新 `open -a Adrafinil` 走一遍首启流程。**此时合盖保持无效。**              |
| 断言出现但很快消失（一轮未完）         | 检查是否误加了 TTL 之外的释放逻辑；`pid=-1` 下 CPU 空闲释放不会触发，不会是它。                          |
| 断言长时间不消失                       | `tail "$HOME/Library/Application Support/Adrafinil/events.log"` 看有无配对 `released`；`Stop` 是否被强杀跳过。 |
| 出现 `unknown:...` 形状的断言          | acquire/release 的 `--tool` 不一致。两者都必须 `--tool zcode`。                                          |
| 合盖仍然休眠                           | helper 未连接（见上）；或用了 ZCode 内置「保持电脑运行」开关——它防不了合盖。                            |

## 八、卸载

```bash
# 1. 从 ~/.zcode/cli/config.json 的 hooks.events 里删掉 adrafinil 那两条（保留其他钩子）
# 2. 释放残留断言
adrafinil release --all
# 3. 退出并删除 App
osascript -e 'quit app "Adrafinil"'; rm -rf /Applications/Adrafinil.app "$HOME/.local/bin/adrafinil"
# 4. 清设置与状态（可选）
rm -rf "$HOME/Library/Application Support/Adrafinil"
brew uninstall --cask adrafinil   # 若是 brew 装的
```

`adrafinil release --all` 是**人类命令**（对应菜单栏的强制释放），会在传输失败时返回非零——
与 hook 内部的 `release` 不同（hook 里任何失败都 exit 0，避免阻断 agent 流程）。
