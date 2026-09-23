# 体验评审 — design

评审日期: 2026-09-23T06:36:00+09:00
被评提交: uncommitted
评审方: fresh-subagent

## 结论

proceed · 上一轮两条 must-fix 已被当前规格真正修掉，重查八个镜头没有新的 must-fix 级缺陷，剩余三处是可辩护的设计取舍（minor），不阻塞实现。

体验方向：`experience-direction-terminal-side-coach`（模型提案、用户确认「选 A」，delegated=false）。其 acceptance 三条为：用户首次使用后未打开任何额外界面即收到一条基于自己真实句子的改写；新会话开始时出现 2–3 道来自本人历史的知识点题目；分析失败或超时对 agent 对话零影响。

## Must-fix

（无）

上一轮的两条 must-fix 本轮已判定解决，不再进入 gate：

- experience-003 · 会话开始提示承诺「到 refluent review 作答本次这几道题」，而 review 只按调度另选一组 → 已解决：会话开始选中的 2–3 道题写入本地待答集合，`refluent review` 默认续答同一组；未答完的保留供下次继续。承接规格：`job-story-spec` 的 job-session-start-review、`user-flow-spec` 的 flow-session-start-review session-2 / flow-on-demand-review review-1 与 review-alt-pending、`screen-requirements-spec` 的 screen-session-start-questions 与 screen-review-session。
- experience-004 · 分析端点状态只做存在性检查、失败完全不可见，承诺的本地日志没有任何可达界面 → 已解决：设置命令新增只读项「分析端点状态」（ready / not_configured / unreachable，来自一次性真实探活）与「最近一次分析结果」（结局 + 时间 + 失败原因，区分「句子没有问题」与「分析一直没工作」），失败细节写本地日志并由前者查看。承接规格：`permissions-notifications-settings-spec` 的 setting-analysis-endpoint-status / setting-analysis-last-result、`screen-requirements-spec` 的 screen-settings、`user-flow-spec` 的 flow-silent-degradation degrade-3。

## 各镜头观察

onboarding（引导）: 有 · 首次安装由 screen-hook-setup 与 flow-first-run-setup 覆盖：授权前先说明采集范围，端点缺失或不可达都给出未启用状态与恢复命令，装完下一条消息即出第一条改写，无需完成任何课程。

process_feedback（过程反馈）: 有 · 五块 surface 各自定义 empty/loading/success/error；statusLine 与会话开始刻意静默，而失败与「没有改进项」的可见性补在设置命令的只读项（端点探活结果 + 最近一次分析结果），用户能区分「句子没问题」与「分析没工作」。

next_step（下一步）: 有 · 每条流程都有 exit_conditions 与后续动作：安装→下一条消息、会话开始→refluent review 或跳过、复习→本轮小结回 shell、设置→即时生效且可恢复默认。

state_consistency（状态一致）: 有 · 设置与复习状态都落在 data-settings / data-review-state 并跨会话持久，会话开始选中的题目写成待答集合供 refluent review 续答同一组；待答集合在多会话间的替换语义与 statusLine 旧建议的清除时机是两处未定的边角（见 experience-009）。

return_reason（回来理由）: 有 · 回访理由来自用户自己前几天的句子，每次新会话出 2–3 道待答题目；learning-loop 同时写明的「每日调度」触发没有对应的调度面，长时间不重开会话的用户缺一个到期入口（见 experience-007）。

mainline（主线）: 有 · 主线是对话内旁路（外发消息→异步分析→statusLine 一行建议）加缝隙复习（会话开始→refluent review），CLI 命令只是控制面，不是等权功能菜单。

direction_fidelity（方向忠实）: 有 · 方向三条 acceptance 各由具名流程兑现（setup-4 的首条改写、session-2 的 2–3 道历史题、flow-silent-degradation 的零影响），且没有把「旁路教练」逐字翻成控件。

audience_leak（受众泄漏）: 有 · 设置规格每一项都标 audience=end-user 且不带 provisioning，没有 operator/developer 项落在 end-user CLI 上；分析端点值留在环境变量，界面只呈现 ready / not_configured / unreachable 只读状态。

## 建议迭代（非阻塞）

- experience-007 · return_reason · minor · learning-loop 写明「会话开始或每日调度」两种复习触发，但设计只落地会话开始一种：整天不重开会话的用户没有到期入口。· user-flow-spec / job-story-spec · 状态 open
- experience-008 · state_consistency · minor · 同一个「模型不可用」状态在 refluent review（离线作答已有题目）与会话开始（整批静默跳过）给出不同承诺，连不需要生成的中译英/重写原句题也不给。· screen-requirements-spec · 状态 open
- experience-009 · state_consistency · minor · statusLine 建议的清除时机有两种读法：empty 态把「无问题」列为回到默认内容的时机，secondary action 又说只有新建议才替换旧建议。· screen-requirements-spec · 状态 open

## 证据限制

- 本阶段只有设计规格，没有截图、视觉评审或运行报告；判断只能核到「规格是否自洽、是否给实现者留下不可判定的点」，不能核到界面是否真的这样呈现。产品级效果由下游 review-experience-runtime（在 implement-refluent-cli 与验证节点之后）核对。
- 三处属性（端点探活是否真实、最近一次分析结果是否反映真实后台结局、statusLine 实际渲染）设计期不可验证，仅核对其规格自洽且可被实现。
- 无 design 阶段适用的可选证据缺失，本轮没有 insufficient_evidence 类 finding。