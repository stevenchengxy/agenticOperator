// 往本地镜像 raas_mirror 种下「陈思这条 run」的读侧数据,这样 partner-pg(同事
// 192.168.1.102)宕机时,AO 透明兜底到本地也能把 rule-check 跑通:
//   - client(a5f6029a → 腾讯)          → resolveClientName 解析出腾讯
//   - client_department(44cd4ad4 → CDG) → resolveDepartmentBg 兜底解析出 CDG(关键!)
//   - job_requisition + specification    → getRequirementDetail 取得 JR
//
// 这是「开发态演示种子」。正常开发流程应是 partner-pg 活着时跑 sync 把读侧表
// 同步过来;此脚本是 partner-pg 已宕、又想本地验证时的手动兜底。
// 跑:`npm run raas-mirror:seed-demo`

import { Pool } from 'pg';
import { REAL_ANCHORS } from '../server/inngest/agents/__fixtures__/real-run-chensiying';

const SPEC_ID = `spec-sim-${REAL_ANCHORS.job_requisition_id}`;

async function main() {
  const url = process.env.RAAS_MIRROR_PG_URL;
  if (!url) {
    console.error('[seed] RAAS_MIRROR_PG_URL 未配置');
    process.exit(1);
  }
  const m = new Pool({ connectionString: url, connectionTimeoutMillis: 5_000 });

  await m.query(
    `INSERT INTO client (client_id, client_name, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, updated_at = NOW()`,
    [REAL_ANCHORS.client_id, '腾讯'],
  );

  await m.query(
    `INSERT INTO client_department (client_department_id, client_id, dept_name, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (client_department_id) DO UPDATE SET dept_name = EXCLUDED.dept_name, updated_at = NOW()`,
    [REAL_ANCHORS.client_department_id, REAL_ANCHORS.client_id, 'CDG'],
  );

  await m.query(
    `INSERT INTO job_requisition_specification (job_requisition_specification_id, sd_org_name, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (job_requisition_specification_id) DO UPDATE SET sd_org_name = EXCLUDED.sd_org_name, updated_at = NOW()`,
    [SPEC_ID, 'Technology'],
  );

  await m.query(
    `INSERT INTO job_requisition
       (job_requisition_id, client_id, client_department_id, job_requisition_specification_id,
        client_job_title, job_responsibility, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (job_requisition_id) DO UPDATE SET
       client_id = EXCLUDED.client_id,
       client_department_id = EXCLUDED.client_department_id,
       job_requisition_specification_id = EXCLUDED.job_requisition_specification_id,
       client_job_title = EXCLUDED.client_job_title,
       job_responsibility = EXCLUDED.job_responsibility,
       updated_at = NOW()`,
    [
      REAL_ANCHORS.job_requisition_id,
      REAL_ANCHORS.client_id,
      REAL_ANCHORS.client_department_id,
      SPEC_ID,
      '测试岗位',
      '行政文秘相关职责:公文写作、会议组织、商务接待、档案管理',
    ],
  );

  console.log(`✓ 已种 4 行读侧数据到 raas_mirror(run ${REAL_ANCHORS.job_requisition_id})`);
  console.log(`  client a5f6029a→腾讯 · client_department 44cd4ad4→CDG · JR + spec(sd_org_name=Technology)`);
  console.log('  现在 partner-pg 宕机时,rule-check 兜底读本地也能解析出 client=腾讯 / bg=CDG → 抓取 10-42');
  await m.end();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed] FAIL:', e);
    process.exit(1);
  });
