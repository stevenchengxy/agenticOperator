我来给出一个完整、规范的结构定义，便于您的代码模块直接生成。下面给出 `{{RULES_BY_STEP}}` 的完整结构规范，包括字段映射、格式模板和真实示例。

## 一、字段筛选原则

从原始 JSON 的 rule 对象中，**仅保留 LLM 判断必需的字段**，其余字段（已被代码用于过滤或与判断无关）一律不注入，避免污染 LLM 注意力。

| 源字段                    | 是否注入 | 原因                                                  |
| ------------------------- | -------- | ----------------------------------------------------- |
| `id`                      | ✅       | rule 标识，输出时回填                                 |
| `businessLogicRuleName`   | ✅       | rule 名称，输出时回填                                 |
| `submissionCriteria`      | ✅       | 第一层判断依据                                        |
| `standardizedLogicRule`   | ✅       | 第二层判断依据（核心）                                |
| `applicableClient`        | ❌       | 已被代码用于过滤                                      |
| `applicableDepartment`    | ❌       | 已被代码用于过滤                                      |
| `executor`                | ❌       | 已过滤为 Agent，全部一致                              |
| `businessBackgroundReason`| ⚠️ 可选 | 提供业务意图，有助于边界判断；占 token，建议默认不注入 |
| `relatedEntities`         | ❌       | 与 LLM 判断无关                                       |
| `ruleSource` / `domainId` / `version` | ❌ | 元数据，与判断无关                              |
| `specificScenarioStage`   | ❌       | 已通过 step 归属体现                                  |

step 层级保留：`id`、`name`（或 `displayName`）、`order`、`description`、`condition`。

## 二、推荐格式（Markdown，与 prompt 整体风格一致）

```
### Step <order>: <name>
- step_id: <id>
- enter_condition: <condition>
- description: <description>

#### Rule <rule_id>: <businessLogicRuleName>
- submissionCriteria: <submissionCriteria>
- logic: <standardizedLogicRule>

#### Rule <rule_id>: <businessLogicRuleName>
- submissionCriteria: <submissionCriteria>
- logic: <standardizedLogicRule>

### Step <order>: <name>
- step_id: <id>
- enter_condition: <condition>
- description: <description>

#### Rule <rule_id>: <businessLogicRuleName>
- submissionCriteria: <submissionCriteria>
- logic: <standardizedLogicRule>
```

**关键规则**：
- step 按 `order` 升序排列
- step 内的 rule 按代码过滤后的顺序保持稳定（建议按 rule_id 升序，便于复现）
- 每条 rule 的 `logic` 与 `submissionCriteria` 保持原文，**不要改写或截断**
- 若 step 过滤后 rule 数为 0，整个 step 块**整体省略**（不要保留空 step）
- 若所有 step 都被过滤为空，代码层应直接走兜底逻辑，不调用 LLM

## 三、完整示例（取自您的文件，含 4 个 step）

```
### Step 1: validateRedlineAndBlacklist
- step_id: 10::validateRedlineAndBlacklist
- enter_condition: 已收到简历处理完成事件，候选人记录已创建
- description: 执行红线检测和黑名单校验。检查候选人是否命中公司级或客户级黑名单（如曾被投诉、有不良记录等），检查是否触犯客户明确的红线要求（如竞业限制、特定公司背景限制、高风险离职编码等）。同时从简历的详细工作履历及职责描述中识别腾讯历史从业经历，若存在则暂停推荐并向HSM发起离场原因核实任务。命中硬性红线的候选人直接标记为不匹配并终止流程；需HSM核实的候选人暂停等待反馈后再决定继续或终止。

#### Rule 10-25: 华为荣耀竞对与客户互不挖角红线
- submissionCriteria: 候选人简历已完成解析，工作经历数据已结构化。
- logic: 系统在简历匹配环节，自动检索候选人工作经历中是否包含华为、荣耀及其关联公司的任职记录。若存在此类记录，系统自动计算该段经历的离职日期距当前日期的间隔。若间隔不足3个月，系统立即挂起该候选人的匹配推荐流程，并自动生成一条"竞对互不挖角待确认"待办任务通知招聘专员。若间隔达到3个月及以上，系统正常继续匹配流程。

#### Rule 10-26: OPPO小米竞对与客户互不挖角红线
- submissionCriteria: 候选人简历已完成解析，工作经历数据已结构化。
- logic: 系统在简历匹配环节，自动检索候选人工作经历中是否包含OPPO、小米及其关联公司的任职记录。若存在此类记录，系统自动计算该段经历的离职日期距当前日期的间隔。若间隔不足6个月，系统立即挂起该候选人的匹配推荐流程，并自动生成一条"竞对互不挖角待确认"待办任务通知招聘专员。若间隔达到6个月及以上，系统正常继续匹配流程。

#### Rule 10-38: 腾讯历史从业经历识别与核实触发
- submissionCriteria: 简历的详细工作履历及职责描述中包含腾讯（含腾讯外包）相关工作经历。
- logic: 匹配腾讯岗位简历时，检查候选人的简历的详细工作履历及职责描述是否包含腾讯或腾讯外包的工作经历。若包含,系统自动暂停该候选人的后续推荐动作，并向HSM生成并发送一条核实任务，提示HSM与客户确认该候选人历史腾讯项目的真实离场原因。系统等待HSM的反馈指令：若HSM反馈离场原因为主动离场或非淘汰退场，系统自动解除暂停，继续执行后续推荐流程；若HSM反馈为淘汰退场，系统立即终止推荐。

### Step 2: matchHardRequirements
- step_id: 10::matchHardRequirements
- enter_condition: 红线和黑名单检查通过
- description: 对照招聘岗位的硬性要求进行逐项匹配，包括学历要求（统招/非统招、本科/硕士等）、工作年限、技能证书、年龄范围等。根据澄清阶段确认的逻辑关系（And/Or）计算是否满足硬性条件，不满足则标记为不匹配。

#### Rule 10-5: 简历匹配硬性要求一票否决
- submissionCriteria: N/A
- logic: 系统在简历匹配阶段，自动执行以下操作：(1)读取该岗位需求中的全部硬性要求，包括学历、必备技能、语言要求、性别及年龄等；(2)逐项比对候选人与需求硬性门槛的匹配情况：a）学历：候选人学历等级是否达到JD最低学历要求；b）必备技能：候选人技能列表是否包含JD要求的全部必备技能项；c）语言要求：若招聘需求存在语言要求，候选人语言能力及证书是否满足需指定语言类型与最低标准；d）性别：若招聘需求存在性别要求，候选人性别是否符合；e）年龄：若招聘需求存在年龄范围要求，候选人年龄是否在允许范围内；(3)任一硬性要求不符，系统立即标记该候选人为不匹配记录具体不符合的维度及原因，并终止后续匹配与推荐流程；(4)全部硬性要求比对通过的简历，标进入后续评估环节。

#### Rule 10-21: 岗位年龄红线与隐形门槛判定
- submissionCriteria: 岗位需求中明确设定了年龄上限
- logic: 系统在简历匹配环节，若岗位需求中明确设定了年龄上限，自动读取候选人的出生日期并计算其当前实际年龄。若候选人实际年龄大于该岗位的年龄上限，系统判定为"年龄不匹配"并终止匹配流程。

### Step 3: evaluateBonusAndCheckReflux
- step_id: 10::evaluateBonusAndCheckReflux
- enter_condition: 硬性要求匹配通过
- description: 评估候选人的加分项（如名企背景、项目经历亮点、技能超配等），计算综合匹配得分。从简历的详细工作履历及职责描述中识别回流相关经历（腾讯正编、腾讯外包、友商字节派驻等），区分BPO与非BPO业务类型，按客户和事业群维度执行回流冷冻期拦截。校验候选人利益冲突声明中的亲属关系回避要求。

#### Rule 10-27: 腾讯亲属关系回避规则
- submissionCriteria: 候选人的利益冲突声明
- logic: 自动获取候选人的利益冲突声明，校验候选人的利益冲突声明中是否存在属于以下关系范围的人员：配偶、父母、子女、兄弟姐妹及其配偶、配偶的父母及兄弟姐妹。若上述亲属中任一人为腾讯正式员工、毕业生、实习生或其他外包人员，系统立即挂起推荐流程，并向HSM发送"腾讯亲属关系待确认"系统通知与邮件，通知内容须包含候选人信息及命中的亲属关系与对应人员信息。待HSM确认处理后方可继续推进。

#### Rule 10-32: 岗位冷冻期规则
- submissionCriteria: 系统中存在候选人在目标岗位下的历史推荐记录。
- logic: 系统在简历匹配环节，自动检索候选人在各目标岗位下近3个月内的历史记录。若某岗位下存在"筛选淘汰"、"面试淘汰"或"筛选通过未到面"任一记录，系统自动跳过该岗位，不将候选人匹配至该岗位，继续匹配其他可用岗位。

### Step 4: generateMatchResult
- step_id: 10::generateMatchResult
- enter_condition: 加分项评估和回流检查完成
- description: 调用评分模型或算法，基于硬性要求匹配度、加分项权重、缺失项扣分等维度进行加权计算。汇总匹配结果，结构化匹配报告，包含匹配得分、各维度评分明细、缺失信息列表、风险提示等，并包含推荐建议（面试/直接推荐/淘汰）。根据是否需要内部面试（由客户设置决定）触发不同的后续流程：需要面试则进入内部面试邀约，不需要则直接进入简历优化。

#### Rule 10-39: 腾讯历史从业经历核实结果处理
- submissionCriteria: 系统接收到HSM针对"腾讯历史离场原因核实"任务提交的反馈结果。
- logic: 系统接收并解析HSM提交的离场原因核实结果。若HSM反馈为非淘汰退场，系统自动解除该候选人的推荐暂停状态，恢复并执行后续正常的推荐流程；若HSM反馈为淘汰退场，系统立即终止该候选人当前岗位的推荐流程，并自动将其档案标记为"腾讯-淘汰退场"。
```

## 四、特殊值处理

| 情况                                    | 处理方式                                                |
| --------------------------------------- | ------------------------------------------------------- |
| `submissionCriteria` 为 `"N/A"` 或空    | 原样保留 `N/A`，prompt 已指示 LLM 视为"无前置条件，直接进入第二层判断" |
| `submissionCriteria` / `logic` 含换行符 | 保留原文换行；如需平铺，用空格替换 `\n` 即可，不要截断   |
| `submissionCriteria` / `logic` 含双引号 | Markdown 格式无需转义；若改用 JSON 格式，按 JSON 标准转义 |
| step 描述过长                           | 不要截断；LLM 需要完整 description 才能正确理解 step 边界 |

## 五、可选：JSON 格式（如您的代码偏好结构化输入）

若您倾向纯 JSON（更利于代码生成、跨语言一致性），可改用此格式，prompt 模板中的 `{{RULES_BY_STEP}}` 直接注入此 JSON 字符串：

```json
{
  "steps": [
    {
      "order": 1,
      "step_id": "10::validateRedlineAndBlacklist",
      "name": "validateRedlineAndBlacklist",
      "enter_condition": "已收到简历处理完成事件，候选人记录已创建",
      "description": "执行红线检测和黑名单校验……",
      "rules": [
        {
          "rule_id": "10-25",
          "rule_name": "华为荣耀竞对与客户互不挖角红线",
          "submission_criteria": "候选人简历已完成解析，工作经历数据已结构化。",
          "logic": "系统在简历匹配环节，自动检索……"
        }
      ]
    }
  ]
}
```

**两种格式选择建议**：
- 规则数量 ≤ 30 条 → 用 **Markdown 格式**（更易读、token 利用率更高、与 prompt 风格一致）
- 规则数量 > 30 条或字段会动态扩展 → 用 **JSON 格式**（结构稳定、易于代码维护）

您当前 51 条规则按客户/部门过滤后单次调用通常远少于 30 条，**默认推荐 Markdown 格式**。