// Orchestrator — 跑全部 scenarios + 生成报告。
//
// 用法:
//   npm run test:e2e-mock         # 默认 RULE_CHECK_ENABLED 内部强制 = true
//   tsx scripts/e2e-mock-test/run-all.ts --scenario s02-huawei-cooldown-drop
//   tsx scripts/e2e-mock-test/run-all.ts --no-llm   # diagnostic:gate 关,只跑 RAAS mock 路径

import { config } from 'dotenv';
import { resolve } from 'node:path';

// 在 import 任何业务模块之前先注入 env
config({ path: resolve(process.cwd(), '.env.local') });
// 强制本测试用的 env 覆盖(测试期间不污染生产 .env.local 默认值)
process.env.RAAS_API_BASE_URL = process.env.RAAS_API_BASE_URL_OVERRIDE ?? 'http://localhost:3001';
process.env.AGENT_API_KEY = process.env.AGENT_API_KEY ?? 'test-agent-key';

// Neo4j:测试默认连 isolated Docker(端口 7688,不动 production Neo4j)。
// 启动:scripts/e2e-mock-test/start-test-neo4j.sh
process.env.RAAS_LINKS_NEO4J_URI = 'bolt://localhost:7688';
process.env.RAAS_LINKS_NEO4J_USER = 'neo4j';
process.env.RAAS_LINKS_NEO4J_PASSWORD = 'testpassword123';
process.env.RAAS_LINKS_NEO4J_DATABASE = 'neo4j';

// 测试期间默认开 gate + 默认 POC 路径(跟 plan §1 一致)
if (!process.env.RULE_CHECK_ENABLED) process.env.RULE_CHECK_ENABLED = 'true';
if (!process.env.RULE_CHECK_PROMPT_SOURCE) process.env.RULE_CHECK_PROMPT_SOURCE = 'poc';
if (!process.env.RULE_CHECK_PARTIAL_RESUME) process.env.RULE_CHECK_PARTIAL_RESUME = 'true';
if (!process.env.RULE_CHECK_AUGMENT_RESUME) process.env.RULE_CHECK_AUGMENT_RESUME = 'true';

import { randomUUID } from 'node:crypto';

import { Neo4jInstanceWriter } from './neo4j-instance-writer';
import {
  startMockRaasServer,
  setActiveScenario,
  clearSeenCalls,
} from './mock-raas-server';
import { runOneScenario } from './pipeline-driver';
import { SCENARIOS, type Scenario } from './fixtures/scenarios';
import {
  ensureOutputDir,
  writeScenarioReport,
  writeSummaryReport,
} from './reporter';
import { verifyScenario, summaryLine } from './verifier';

interface CliArgs {
  scenario?: string;
  no_llm: boolean;
  llm_mode: 'real' | 'stub';
  output_dir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    no_llm: false,
    // 默认 stub —— 当前 partner LAN LLM gateway 从这边不可达,先用 stub
    // 把 pipeline / Neo4j / augmentation 验通。gateway 恢复后用 --llm=real。
    llm_mode: 'stub',
    output_dir: resolve(process.cwd(), 'scripts/e2e-mock-test/output'),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scenario') out.scenario = argv[++i];
    else if (a === '--no-llm') out.no_llm = true;
    else if (a === '--llm-real' || a === '--llm=real') out.llm_mode = 'real';
    else if (a === '--llm-stub' || a === '--llm=stub') out.llm_mode = 'stub';
    else if (a === '--output-dir') out.output_dir = argv[++i] ?? out.output_dir;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const run_id = `run_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 6)}`;
  // eslint-disable-next-line no-console
  console.log(`\n[e2e] run_id=${run_id} no_llm=${args.no_llm}\n`);

  // 1. Start mock RAAS server
  const server = await startMockRaasServer(3001);
  // eslint-disable-next-line no-console
  console.log(`[e2e] mock RAAS server listening on :${server.port}`);

  // 2. Neo4j connect
  const neo4j = Neo4jInstanceWriter.fromEnv();
  const ping = await neo4j.ping();
  if (!ping.ok) {
    // eslint-disable-next-line no-console
    console.error(`[e2e] Neo4j ping failed: ${ping.error}`);
    await server.close();
    await neo4j.close();
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`[e2e] Neo4j connected: ${ping.serverInfo}`);

  // 3. 清掉本 run_id 的旧 audit(reruns 用)
  await neo4j.clearTestRun(run_id);

  // 4. 选 scenarios
  const targets: Scenario[] = args.scenario
    ? SCENARIOS.filter((s) => s.id === args.scenario)
    : SCENARIOS;
  if (targets.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`[e2e] no scenarios match --scenario=${args.scenario}`);
    await server.close();
    await neo4j.close();
    process.exit(1);
  }

  // 5. Output dir
  const output_dir = ensureOutputDir({ output_dir: args.output_dir, run_id });
  // eslint-disable-next-line no-console
  console.log(`[e2e] reports → ${output_dir}\n`);

  // 6. Run loop
  const collected: Array<{
    result: Awaited<ReturnType<typeof runOneScenario>>;
    verification: ReturnType<typeof verifyScenario>;
  }> = [];

  for (const scenario of targets) {
    // eslint-disable-next-line no-console
    console.log(`[e2e] running ${scenario.id} ...`);
    clearSeenCalls();
    setActiveScenario({ candidate_id: scenario.candidate_id, jd_id: scenario.jd_id });

    const result = await runOneScenario({
      scenario,
      run_id,
      neo4j,
      rule_check_enabled: !args.no_llm,
      llm_mode: args.llm_mode,
    });

    const verification = verifyScenario(result);
    collected.push({ result, verification });

    const reportPath = writeScenarioReport({
      result,
      verification,
      output_dir,
    });
    // eslint-disable-next-line no-console
    console.log(`         ${summaryLine(result, verification)} → ${reportPath}`);
  }

  // 7. Summary
  const summaryPath = writeSummaryReport({
    results: collected,
    output_dir,
    run_id,
  });
  // eslint-disable-next-line no-console
  console.log(`\n[e2e] summary → ${summaryPath}`);

  // 8. Teardown
  await server.close();
  await neo4j.close();

  // 9. Exit code 反映通过率
  const failedCount = collected.filter((r) => !r.verification.overall_passed).length;
  // eslint-disable-next-line no-console
  console.log(
    `\n[e2e] FINAL: ${collected.length - failedCount}/${collected.length} passed\n`,
  );
  process.exit(failedCount === 0 ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[e2e] FATAL:', err);
  process.exit(2);
});
