# 体验评审 — runtime（refluent 设计修复 · attempt-4）

评审日期: 2026-09-23T22:15:12+09:00
被评提交: uncommitted
评审方: fresh-subagent（第 4 次尝试，未参与任何被审产物编写）
范围: 仅 Task 1–9 改变的终端表面

## 结论

proceed · 三条重点（-011 / -012 / -013）均已真正消解，六个回归项（-002 / -003 / -004 / -006 / -007 / -008）经审阅者自己复跑后仍为已消解；把同一类的全文复查扩到 app-design 规格与概念、product-concept 生效 revision、docs、src、hooks、bin 之后，生效条文里未再出现与已确认 Task 1/2/3/8 相反的描述，`must_fix_before_release` 与 `quality_gaps` 均为空，故本节点判 passed（COMPLETED_WITH_LIMITS：仍无截图类证据，如实记为证据限制）。

（体验方向为产品概念中已确认的 `experience-direction-terminal-side-coach` revision 2，非委托选定。）

## Must-fix

（无）`must_fix_before_release` 为空：SessionStart 到期条数通知、statusLine 包装/过期/失败提示、uninstall 恢复、review 三态评分、过滤文本后果均未发现发布阻断级体验缺陷。`quality_gaps` 与 `code_gaps` 也均为空。

## 本轮重点与回归确认（审阅者自己的证据）

- experience-runtime-fixes-011（分析失败只给用户一行提示）· 已真正消解：user-flow-spec 的 instant-alt-no-issue / instant-err-analysis / degrade-2.validation_rules[1] / degrade-3.system_response，以及同类的 degrade-3.validation_rules[0] 与 permissions 的 notif-statusline-suggestion.denial_or_silence_behavior，全部与 job-silent-degradation / screen-statusline-suggestion 同一口径；审阅者在临时库上制造一次真实分析失败后跑 statusline hook，实际输出「WRAPPED-USER-STATUSLINE」+「refluent: analysis unavailable (run `refluent settings`)」。
- experience-runtime-fixes-012（不再预设会话开始出题）· 已真正消解：`job-on-demand-review.situation` 现为「题目在 `refluent review` 里呈现，会话开始只提示到期条数。」；按「会话开始.*题目」全文复查生效条文 0 命中。
- experience-runtime-fixes-013（settings 文案）· 已真正消解：审阅者自己运行真实 `node bin/refluent settings`，末行为「Quiet mode overrides statusLine suggestions and the session-start notice.」。
- -002 · 仍已消解：审阅者自己跑 session-start，stdout 解析键只有 `['systemMessage']`，值为「refluent: 1 review item(s) from your own sentences are due. Run `refluent review` in a terminal.」，不含原句；调用后 `review_questions` 计数为 0。
- -003 · 仍已消解：job / screen / user-flow / permissions 四处失败口径一致，运行期由 statusline hook 真实打印该提示。
- -004 · 仍已消解：审阅者在新临时数据目录上复跑真实 `refluent review`：避开目标 = 「1 answered, 0 correct.」；答对 = 「1 answered, 1 correct.」；语法点无模型 = 「1 answered, 0 correct, 1 not graded.」且提示「your schedule is unchanged」。
- -006 · 仍已消解：隔离 HOME 与临时 settings.json 后复跑：install 后 hook status = installed_not_loaded 且 capture = on — hook installed；跑过一次 capture hook 后 = installed_and_loaded。生效条文里已无 hook_loaded。
- -007 · 仍已消解：REFLUENT_DATA_DIR 未设、HOME 指向临时目录、cwd 指向另一个临时仓库时，install 打印「data directory : <HOME>/.refluent」；只有 HOME 侧出现 .refluent，那个临时仓库目录前后不变。
- -008 · 仍已消解：learning-loop revision 2 的 business rule 为「Reviews are surfaced by a due-count notice at session start (no question text, no model call, and nothing injected into the agent context), or on a daily schedule.」。

## 推荐迭代（不阻断）

- experience-runtime-fixes-015 · 状态一致 · `src/review.ts` 中 `pendingQuestions` 的注释仍写「The pending set left by the last session-start teaser」，而现状是只有 `refluent review` 会写入 `status='pending'` 的题目行、SessionStart 只数到期条数（审阅者实跑 session-start 后该表仍 0 行）。只影响内部可读性、不出现在任何用户可见表面，故记 note 而非 code_gap。所属产物 src/review.ts，状态 open。
- experience-runtime-fixes-014 · 方向忠实 · 过滤把路径/标识符替换成 `[code]`，原句可读性可能下降；仍无终端捕获展示占位符实际呈现。note。
- experience-runtime-fixes-010 · 引导 · 终端工具没有截图清单与可视化评审，窄终端下的换行/截断未被核对。证据限制。

## 同类全文复查（分析失败 / 会话开始 / hook 加载状态 / 仓库内数据目录）

- 「分析失败时 statusLine 保持默认或完全不提示」：生效条文 0 命中；只剩两处粗粒度摘要（screen-statusline-suggestion 的主操作列表把「分析失败」列在 keep-default 触发器里、surface-statusline 的一句话描述），二者不复述「近期失败」子分支但不与 `states.error` 矛盾。
- 「会话开始出题（题面 / 2–3 道 / 跳过控件）」：生效条文与文案 0 命中（剩余命中是否定句「不存在题目生成失败的路径」）。
- 「把 hook 未加载当采集启用或安装成败条件」：0 命中（剩余两处是真·健康报告：hook_seen_at 始终为空的持久未执行、hook 接口失效）。
- 「仓库内数据目录」：0 命中（唯一命中是明写「绝不在仓库工作树内」）。
- 「待答题目归属」：1 命中，`src/review.ts` 的注释，见推荐迭代 -015。
- 历史记录类产物仍带旧说法，按技能读法不作为当下判断：product-concept.json 的 revision 1（superseded）与 `experience_proposals[0]`（round 1 提案记录）仍写「新会话开始时出现 2–3 道来自本人历史的知识点题目」；`docs/experience-review/design.md` 与 `runtime.md` 是先前 stage 的评审记录（runtime.md 评审于 2026-09-23T08:14，早于 Task 1–9 落地）。改它们等于改写历史，本轮仅披露，不要求修复。

## 各镜头观察

onboarding（引导）: 有 · 隔离复跑的 install --yes 打印真实 data directory、hook 位置、只采集外发消息、保留并包装用户原 statusLine，并说明端点未配置的影响与下一步；发一条消息即出现基于原句的改写，无需额外界面。
process_feedback（过程反馈）: 有 · settings 以只读项呈现真实加载状态（installed_not_loaded → installed_and_loaded）、capture 的实际原因与最近一次分析结局；statusLine 在近期失败且无新内容时打印分析不可用提示；review 逐题给出 incorrect / correct / ungraded，小结把未判分单列。
next_step（下一步）: 有 · install 收尾指向下一条消息与 `refluent settings`；SessionStart 通知给出「Run `refluent review` in a terminal」；review 给本轮小结；uninstall 说明知识点保留与如何删除。
state_consistency（状态一致）: 有 · 上一轮「同一个分析失败状态两种读法」已消解：job / screen / user-flow / permissions 与运行期一致；生效条文里只剩粗粒度摘要未复述子分支，不构成相反条文。
return_reason（回来理由）: 有 · 回来理由来自用户自己的历史句子：会话开始显示到期条数并指向 `refluent review`；自动入口仍只有开新会话（既有建议迭代 experience-007 / experience-runtime-003，Task 1–9 未涉及）。
mainline（主线）: 有 · 一条对话内旁路（外发消息→异步分析→statusLine 一行建议）加一个缝隙复习（SessionStart 通知→refluent review），不是功能菜单或等权宫格。
direction_fidelity（方向忠实）: 有 · 方向 revision 2 三条 acceptance 均成立：真实 TUI 的改写行、只含 systemMessage 的到期条数通知（审阅者自己的 session-start 输出亦然）、失败/超时对 agent 消息零影响；未见逐字翻成控件。
audience_leak（受众泄漏）: 有 · 面向用户文本只出现用户自己的到期条数与自述状态；端点/凭据只作 not_configured/unreachable 只读状态；真实会话里 agent 上下文无 refluent 内容，符合 Pattern J。

## 证据限制

- 无截图清单与可视化评审产物（终端工具没有图形界面）：窄终端下的换行/截断、宿主 UI 对通知的排版未被核对，记为 insufficient_evidence，不伪造、不升级为阻断项。
- 分析模型由本地桩/假端点替代：模型判断质量不在本审阅范围。
- 被评文件均为未提交状态（仓库只有一个初始提交）；本仓库工作树里有一个空的 `.refluent/`（创建于 2026-09-23 03:49，早于 Task 1 修复，已被 .gitignore 忽略），不是本轮行为产生的。
- 审阅者自己的复跑证据见 `.allforai/app-design/qa/experience-quality-critique-runtime-fixes-evidence/`：`settings-output-attempt4.txt`、`review-feedback-runs-attempt4.txt`、`live-temp-store-ab-attempt4.txt`、`class-rescan-attempt4.txt`。