# refluent

[English](README.md)

**用你每天写给 coding agent 的话，顺手把英文写作练好。**

你整天在用英文（或中文）给 Claude Code、Codex、Pi 写指令。refluent 在后台读每一条消息，
发现某句话可以写得更好时，给你一行提示：

```
refluent: Please help me check this code whether has bug. → Please check whether this code has a bug. (语法错误: Keep statement order after "whether".)
```

直接写中文，它会给出地道的英文说法：

```
refluent: 帮我看看这个登录 bug 为什么一直失败 → Can you help me look into why this login bug keeps failing? (中文→英文)
```

每条纠正都会变成一个知识点，之后 `refluent review` 会让你自己把它写出来——不用另找时间背单词，
英文在工作中就记住了。

- **不打扰 agent**：不会往 agent 的上下文里写任何东西；hook 立即返回，分析在后台进行。
- **数据在本地**：你的消息和知识点都存在本机的一个 SQLite 文件里。
- **自带模型**：任何 OpenAI 兼容接口都行，小模型就够用（用 `openai/gpt-4o-mini`，
  每天 200 条消息大约每月 0.03 美元）。

## 适合谁

英语不是母语、尤其是以中文为母语，并且每天大量给 coding agent 写指令的开发者。
问题类别用中文标注（`语法错误`、`中式夹英`、`Chinglish 搭配`、`语域语气`、`中文→英文`），
改写和原因说明是英文。

## 快速开始

需要 **macOS**、**Node.js >= 22**，以及一个 OpenAI 兼容接口的 API key。
下面以 [OpenRouter](https://openrouter.ai) 为例：

```sh
git clone https://github.com/allforai/refluent.git && cd refluent
npm ci && npm run build
npm link                                    # 可选：把 `refluent` 命令加到 PATH

refluent settings set model-endpoint https://openrouter.ai/api/v1
refluent settings set model openai/gpt-4o-mini
refluent settings set model-api-key-env OPENROUTER_API_KEY   # 填的是环境变量的“名字”
refluent install                            # 安装 Claude Code 的 hooks
```

重启 Claude Code，发一条消息就能看到效果。如果没有执行 `npm link`，就在仓库根目录用
`node bin/refluent ...` 运行所有命令。

API key 本身永远不会被保存——refluent 按名字到 Claude Code 传给 hook 的环境里去读，
所以 `OPENROUTER_API_KEY` 必须在 Claude Code 运行的环境里存在。读不到时
`refluent install` 会告诉你。

## 日常使用

对话过程中什么都不用记：

- **你发出的每条消息**都会被采集和过滤。代码、日志、堆栈、单独的命令和很短的指令，
  在发给模型之前就会被去掉。
- **状态栏**最多显示一条建议；如果你自己配置了状态栏，建议会显示在它下面。
  建议 15 分钟后过期。
- **新会话开始时**会告诉你有几条待复习。这条提示只给你看，不会注入 agent 的上下文。
- **`refluent review`** 用你自己写过的句子出题——中译英、改写原句、填空——
  并用同一套流程给你的答案打分。

## 配置

`refluent settings` 会列出所有开关，以及 hook 实际用到的配置：接口地址、模型、
API key 所在的环境变量名，以及上一次分析失败的原因：

```
Analysis model (what the hook really resolves):
  endpoint       : https://openrouter.ai/api/v1 (source: local settings)
  model          : openai/gpt-4o-mini (source: local settings)
  api key        : read from env OPENROUTER_API_KEY
```

```sh
refluent settings set quiet-mode on              # 关闭所有终端输出
refluent settings set statusline-suggestion off  # 状态栏不显示建议
refluent settings set statusline-original off    # 状态栏里不显示你的原句
refluent settings reset                          # 只重置开关，保留模型配置
```

模型相关的键是 `model-endpoint`、`model` 和 `model-api-key-env`，传 `none` 可以清除。
环境变量 `REFLUENT_MODEL_ENDPOINT`、`REFLUENT_MODEL`、`REFLUENT_MODEL_API_KEY`
可以在单次命令中覆盖已保存的值。修改 hook 使用的配置后，需要重启 Claude Code。

失败原因都经过脱敏（`not_configured`、`auth_rejected`、`rate_limited`、`timeout`、
`network_error`、`empty_response`、`invalid_response`、`http_error_<状态码>`），
不会包含接口返回的内容或你的原文。

## 支持的 agent

```sh
refluent install --agent claude-code   # 默认
refluent install --agent codex
refluent install --agent pi
```

`uninstall` 也接受同样的参数。

| | Claude Code | Codex | Pi |
|---|---|---|---|
| 采集方式 | `UserPromptSubmit` hook | `UserPromptSubmit` hook | `before_agent_start` 扩展 |
| 写入位置 | `~/.claude/settings.json` | `$CODEX_HOME/hooks.json` | `~/.pi/agent/extensions/refluent.ts` |
| 建议显示在 | 状态栏（包装原有状态栏，不替换） | —（用 `refluent review` 或浮窗） | Pi 状态栏，占用自己的独立一项 |

- **Claude Code**：`install` 会先征求同意，再合并 hooks、包装你现有的 `statusLine`，
  并在 `settings.json.refluent-backup` 留一份一次性备份。
- **Codex** 从 `CODEX_HOME` 读取 hooks，而不是固定的 `~/.codex`，所以按账号隔离
  home 目录的管理工具也能用。原有 hooks 会保留，文件会先备份。Codex 第一次见到这个 hook
  时会请你确认信任。
- **Pi** 会装一个小扩展，重启 Pi 后生效。因为 Pi 的状态栏是多个扩展共用的，默认不显示你的原句；
  设置 `statusline-original on` 可以加回来。

## 浮窗

不想在每个 agent 窗格里占一行状态栏的话，可以改用一个悬浮在所有应用之上的小窗显示建议。
它不会抢键盘焦点，12 秒后自动淡出——鼠标悬停可以保留，点击查看原句，拖动可以移动位置。

```sh
refluent overlay install     # 需要 Xcode 命令行工具（swiftc）
refluent overlay test        # 显示一条示例，顺便拖到合适的位置
refluent settings set overlay-duration 20   # 6 | 12 | 20 | 30 | 60 秒
refluent overlay uninstall   # 卸载浮窗，恢复状态栏显示
```

当分析因为需要你亲自处理的原因失败时，浮窗也会弹出提示：没有配置模型、API key 被拒绝、
或请求被 HTTP 4xx 拒绝。超时等临时性失败不会打扰你，可以在 `refluent settings` 里查看。

安装浮窗会关闭 `statusline-suggestion`，卸载时会重新打开。

## 数据与隐私

- 消息、过滤后的文本、知识点和设置都存在一个 SQLite 数据库里：
  `~/.refluent/analysis-and-data.sqlite`（可用 `REFLUENT_DATA_DIR` 修改目录）。
  不会往你的代码仓库里写任何东西，也没有服务端副本。
- **分析是远程的**：值得分析的消息，会把*过滤后*的文本发给你配置的接口。
  源代码、日志和报错会先被去掉，或替换成 `[code]` 占位符。
- 删除 `~/.refluent` 即可清除所有本地数据。

## 卸载

```sh
refluent uninstall
```

移除所有 refluent hooks，并恢复你原来的状态栏。知识点会保留；要一并删除，
再删掉 `~/.refluent` 即可。

## 已知限制

- **需要自己的模型接口**：没有配置时，消息照常采集，但不会产生建议；
  `refluent settings` 会说明原因。
- **只针对书面英语**：不涉及口语和发音。
- **单机单用户**：没有账号，不跨设备同步。
- **只支持 macOS**：不支持 Linux 和 Windows。
- **`[code]` 占位符**：如果原句大部分是代码，复习题读起来可能有点怪。
- Claude Code 会把过宽的状态栏用 `…` 截断；refluent 能检测到窗格宽度时，会自动把内容压缩到合适长度。

## 开发

```sh
npm test
npm run typecheck
```

端到端验证、沙箱里测试 hooks、模型对比测试，以及状态栏如何适配窄窗格，
见 [docs/development.md](docs/development.md)（英文）。

## 许可证

[MIT](LICENSE)
