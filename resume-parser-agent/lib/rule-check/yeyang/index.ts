// 叶洋 v4 prompt adapter — vendored slim copy for resume-parser-agent.
//
// 来源:agenticOperator/lib/ontology-gen/v4/ (主仓,端口 3002)。
// 这里 vendor 了 4 个最小文件 — 它们都是纯字符串/纯函数,无网络/Neo4j/
// 重 lib 依赖,跨 Next.js 项目硬拷贝最简单。主仓改了这里手动同步:
//
//   主仓 generated/v4/match-resume.action-object.ts
//     → match-resume-snapshot.ts
//   主仓 generated/v4/action-object-v4.types.ts
//     → action-object-v4.types.ts
//   主仓 lib/ontology-gen/v4/runtime-input.types.ts
//     → runtime-input.types.ts
//   主仓 lib/ontology-gen/v4/fill-runtime-input.ts(slim 版,只支持 matchResume)
//     → fill-runtime-input.ts
//
// 重新生成主仓 snapshot 后:`npm run gen:v4-snapshot`(主仓),然后 cp 过来。

export { matchResumeActionObject } from './match-resume-snapshot';
export { fillRuntimeInput } from './fill-runtime-input';
export type {
  MatchResumeRuntimeInput,
  RuntimeClient,
  RuntimeJob,
  RuntimeResume,
} from './runtime-input.types';
export type { ActionObjectV4, ActionObjectMetaV4 } from './action-object-v4.types';
