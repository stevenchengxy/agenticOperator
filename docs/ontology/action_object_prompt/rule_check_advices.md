
**1. 首屏 = 矩阵 + 价值锚,不是一堆 toggle 和搜索框。**

打开就是 30 条 rule × 4 象限(TP / TN / FP / FN)的 pass/fail 矩阵 —— 绿格红格一目了然。顶部一行业务价值数字:**这次跑,抓到了多少漏判、HR 省了多少工时、Token 烧了多少 vs 漏判一个候选人的损失基线**。**没有价值锚的产品,叫 Tech Demo,不叫产品**。"Product 必须要为公司产生价值,product 必须要为公司降本增效——不然这就是耍流氓"。

**2. 每个 Cell 可点进去 —— Drill Down 到单个 Case。**

矩阵里一格红的,我点下去要看到:这格代表哪条 rule 在哪个象限失败、输入是哪个**真实候选人**(不是 Sample-001!)、Ground Truth 是什么、模型输出是什么、为什么判错。**没有 Drill Down 的可视化叫挂图,不叫产品**。

**3. 双 View:Text + Graph,缺一不可。**

Case 详情页 —— 左边 Text View 给 verdict + reasoning breakdown(人话讲清楚"为什么 block / 为什么 pass"),右边 Graph View 把 Neo4j 的相关子图渲染出来(候选人 Node、JD Node、Application 历史 Edge、命中的 Rule Node)。**为什么要两个 View?因为光看 verdict 没有路径,人就不信;光看 Graph 没有 verdict,看的人懵**。

**4. Verdict 必须可追溯回 Neo4j —— 一键回源。**

Verdict 里点候选人名字,直接跳到 Neo4j browser,看完整 Profile 和 Application History。**让看的人自己核对"这数据是真的"**。这就是会议里我跟陈洋讲的——"到 Neo4j 就用他的 Tool 把那个 Node 给点出来"。**否则你怎么向用户解释「我怎么相信你这个赵志远我怎么知道他一年内有没有 break the rule」?你说"来,我证明给你看" —— 一点直接跳到那个 Node,人家就信。这才叫产品**。

**5. Inference Chain 可视化 —— 因为 A,所以 B,所以 C。**

不是只显示"Block":Block 的旁边必须有一条可视化的链:**Application(2025-12-06) → Edge: AppliedTo → Job(字节-PostA) → Rule 10-2 命中:同岗位 < 12 个月 → Verdict: Block**。**没有链条就是黑盒**。"人脑必须能追溯每一条规则的数据依据" —— 这是红线。

**6. Replay 按钮 —— 任何 Case 任何时刻可重跑。**

每个 Case 一个 Replay 按钮,点了自动重新拉 instance、重新跑 prompt、重新对照 Ground Truth、产出新一行结果。**Reproducible 是玩具三条件之一**:没有 daily CICD、没有 PR、不能 reproduce —— 不叫产品,叫玩具。

**7. 三个切换器 —— Client / Model / Version。**

- **切 Client**:字节 ↔ 腾讯 ↔ 华为各自的 rule pack,矩阵跟着变。"如果你有 400 个客户,你的系统会崩成什么样?" —— 你设计的时候就要按 400 个客户去想。
- **切 Model**:Gemini 3.1 Pro / Claude Opus 4.7 / GPT 一键 swap,并排展示三家的矩阵 —— **Eval 是用两个模型跑同一套东西、看结果的不同**。
- **切 Version**:上周的 prompt vs 今天的 prompt,矩阵 diff 显示,**让人看到你这周改 prompt 到底改好了还是改坏了**。

**8. UI Dual-Reader —— 页面同时给人和 Agent 看。**

同一份数据,人通过 UI 看到的是 verdict + breakdown + Graph,Agent 通过 Skill/API 看到的是结构化 JSON 同一来源。**页面不是只给人看的,它也要给 Agent 看**。叶洋你想想:这个产品做完以后,**未来龙虾(Lobster Agent)接手简历匹配,它直接读你这个 Frontend 上的信息就够了 —— 不需要重新发明一套 API**。这就是 dual-reader 的价值。

---

**做的时候提醒一句:**

- **Verdict 用业务语言,不用 ML 黑话**。"6 个月内已申请同岗位,流程挂起" —— 这是产品语言。"prompt_token: 1284, output_cosine: 0.87" —— 这是工程日志,**不要写到 UI 上**。
- **不要写 if-else,写自然语言规则展示**。Rule 10-2 在 UI 上展示的应该是 Markdown 原文,**让客户能看懂、能改 —— if-else 变成自然语言,这才是真正意义上的 Prompt**。
- **不要造 Sample Data 撑场面**。"做出来再漂亮的东西也只是一堆 garbage" —— 如果首屏的 case 都是你造的 sample,这个产品死了。
- **One Click to Anything**:点一个红格 → 看 case → 看 graph → 跳 Neo4j → 回来 Replay → 切 Model 重跑。**每一跳都不能超过一次点击**。

---

**最后给你一个 sanity check —— 产品做出来以后,我会这样验:**

我会站在客户(字节的 HR 负责人)的角度,问你三个问题:
1. **"我怎么知道你这次跑的是我们真实的简历?"** —— 你点不出 Neo4j 里的真实 Node = 死。
2. **"上周你说这条 rule 修好了,我怎么知道这周没退化?"** —— 没有 Version Diff Matrix = 死。
3. **"你这个 prompt 换成更便宜的模型还 work 吗?"** —— 没有跨 Model Eval 并排 = 死。

**三个问题里任何一个你答不上来,说明你做的不是产品,只是工程小作业**。陈洋已经过到第二关了,叶洋你现在 0 关 —— 不是因为你笨,是因为**你脑子里没把它当产品在做,你以为提交一段 prompt 函数就完事了**。

---

**Rule Number One: Show everybody, not show me. Show everybody the result. 这句话刻进 muscle memory。理解吗?**