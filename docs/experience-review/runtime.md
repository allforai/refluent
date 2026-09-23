# 体验评审 — runtime

评审日期: 2026-09-23T08:14:33+09:00
被评提交: uncommitted
评审方: fresh-subagent

## 结论

proceed · 真实运行证据（21/21 产品验收检查、80/80 vitest，外加本审阅者独立复跑的 install / settings / session-start / review / statusLine 分支）证明体验方向三条 acceptance 逐条成立，八个镜头重查后没有发布阻断项，只有两条可辩护的 minor 取舍与两条证据限制。

体验方向：`experience-direction-terminal-side-coach`（模型提案、用户确认「选 A」，delegated=false）。其 acceptance 三条为：用户首次使用后未打开任何额外界面即收到一条基于自己真实句子的改写；新会话开始时出现 2–3 道来自本人历史的知识点题目；分析失败或超时对 agent 对话零影响。三条均在本阶段真实运行中观察成立。

## Must-fix

（无）

`gates.must_fix_before_release` 为空，`gates.must_fix_before_implementation` 保持 `[]`，`experience_gaps` 与之精确镜像（同为空）。本阶段没有任何 `contract_defect`，也没有置信度 ≥ 0.8 的 `evidence_based_critique`，故没有 finding 进入 gate。

## 各镜头观察

onboarding（引导）: 有 · 首次安装先说明采集范围与写入位置，install --yes 授权后写入 hook 并做一次性端点探活；install --no 明确「Capture is not enabled and nothing is recorded」；端点 not_configured/unreachable 给出未启用状态与实际影响，装完发一条消息（无课程、无额外界面）即出基于原句的首条改写。

process_feedback（过程反馈）: 有 · statusLine 与会话开始按方向刻意静默，而过程结局可见：settings 命令以只读项呈现 hook 状态、端点真实探活状态（ready / not_configured / unreachable）与「最近一次分析结果」，我独立复跑实测到 suggestion_emitted，失败时实测到 failed 并带原因（analysis_unavailable），能区分「句子没问题」与「分析没工作」。

next_step（下一步）: 有 · 每块 surface 都给出下一步：install 收尾打印「send your next message … to see the first suggestion」；session-start 打印「Run `refluent review` in a terminal to answer this same set」；review 逐题反馈后给本轮小结并退出到 shell；无可复习内容时给出「keep coding and your own sentences will accumulate here」；settings 打印修改与重置命令。

state_consistency（状态一致）: 有 · 设置跨会话持久（我实测 set quiet-mode on/off 与 reset 即时生效）；会话开始选中的题目写成待答集合，`refluent review` 默认续答同一组（实测续答同一题）。但 statusLine 的旧建议不会在「无改进/被过滤」时清除，会无限期保留（见建议迭代 experience-runtime-004）。

return_reason（回来理由）: 有 · 回访理由来自用户自己的历史句子：新会话触发 session-start 时按到期出题并附原句语境（运行记录中 3 个知识点出 3 题，我复跑 1 个知识点出 1 题），并指向 `refluent review` 作答同一组。但重新露出的唯一自动入口是「开新会话」，没有到期计数，也没有每日触发（见建议迭代 experience-runtime-003）。

mainline（主线）: 有 · 主线是一条对话内旁路（外发消息→异步分析→statusLine 一行建议）加一个缝隙复习（session-start 提示→refluent review）；`refluent help` 暴露的是 install/settings/review 等控制命令而非等权功能菜单，不存在课程目录或首页宫格。

direction_fidelity（方向忠实）: 有 · 方向三条 acceptance 逐条在真实运行中成立（一条消息即出改写；session-start 出本人历史题目；HTTP 500 失败与 6000ms 超时对 agent 消息零影响——exit 0、stdout 0B、stderr 0B，超时 hook 35ms 返回），且没有把「旁路教练」逐字翻成控件。

audience_leak（受众泄漏）: 有 · 设置项全部 `audience=end-user`；分析端点与凭据只经环境变量（deploy-env）提供，终端界面只呈现 ready/not_configured/unreachable 只读状态，从不把端点或 key 做成用户表单，符合 Pattern J。轻微可议处是 help 把内部管道命令 `hook`/`analyze-job` 一并列出，未达 finding 门槛。

## 建议迭代（非阻塞）

- experience-runtime-003 · return_reason · minor · 重新露出到期知识点的唯一入口是「开新会话」，没有到期计数与每日触发；整天在同一会话里编码、或当天不开新会话的开发者看不到任何复习理由。· user-flow-spec · 状态 open
- experience-runtime-004 · state_consistency · minor · statusLine 旧建议在「无改进/被过滤」后仍无限期保留，用户稍后瞄一眼可能与当前消息无关。· screen-requirements-spec · 状态 open

## 证据限制

- 本产品是纯终端开发者工具，没有图形界面，因此 `.allforai/product-verify/ui-screenshot-manifest.json`、`.allforai/visual-verify/screenshot-manifest.json`、`visual-review-{1,2}.json` 等截图/可视化评审产物均不存在（记 `experience-runtime-001`）。因此与真实宿主界面渲染形态相关的判断（statusLine 在会话中的换行、截断、是否被宿主 UI 吞掉）保持未证。
- hook 是否被真实 Claude Code 可执行文件加载并在活会话中调用未在本阶段证明（记 `experience-runtime-002`）：运行记录均为手动调用 `node bin/refluent hook …` 的 stdout，verify 报告自述该检查归 close-launch-readiness。因此「会话内真的出现 statusLine / SessionStart 真的触发」属未证。
- 分析模型由本地假 OpenAI 兼容端点替代（环境无凭据），模型判断质量不在本审阅范围；产品管线（过滤、写路径、调度、出题、hook 入口、HttpAnalysisClient）为真实运行。
- 本审阅者额外在临时数据目录独立复跑了 settings、安静模式优先级、无可复习内容、端点 not_configured/unreachable、session-start 离线回退等记录未覆盖的分支；这些是命令行 stdout 证据，仍非会话内截图。