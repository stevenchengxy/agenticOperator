// scripts/test-rule-check-only.ts
//
// 直接 emit 一条 RULE_CHECK_REQUESTED 给 ruleCheckAgent 跑,绕过
// resumeParser + matchResume(那两个需要 RAAS 在线,但当前 RAAS 192.168.1.105:3001
// 不可达)。 验证 ruleCheckAgent 在隔离环境能跑完一次 runRuleCheck + emit
// RULE_CHECK_PASSED / RULE_CHECK_FAILED。
//
// 跑法:
//   npx tsx --env-file=.env.local scripts/test-rule-check-only.ts

import { inngest } from '../server/inngest/client';

(async () => {
  const eventId = `local-rc-${Date.now()}`;

  const result = await inngest.send({
    name: 'RULE_CHECK_REQUESTED',
    data: {
      upload_id: 'TEST-UPLOAD-001',
      candidate_id: 'C-TEST-001',
      resume_id: 'R-TEST-001',
      employee_id: 'EMP_TEST',
      job_requisition_id: 'JR-TEST-001',
      client_id: 'CLI_TENCENT',
      job_requisition: {
        job_requisition_id: 'JR-TEST-001',
        client_id: 'CLI_TENCENT',
        client_job_title: '高级前端工程师',
        client_business_group: 'IEG',
        work_city: '深圳',
        salary_range: '30-50K',
        work_years: 3,
        degree_requirement: '本科',
        must_have_skills: ['React', 'TypeScript'],
        nice_to_have_skills: ['Next.js'],
        job_responsibility: '负责前端产品开发与维护',
        job_requirement: '3年以上前端开发经验',
      },
      parsed_resume: {
        name: '张测试',
        gender: '男',
        current_location: '深圳',
        highest_acquired_degree: '本科',
        work_years: 4,
        skills: ['React', 'TypeScript', 'Node.js'],
        experience: [
          {
            title: '前端工程师',
            company: '腾讯',
            startDate: '2022-01',
            endDate: 'present',
            description: '负责小程序前端开发',
          },
        ],
        education: [
          {
            degree: '本科',
            field: '计算机',
            institution: '深圳大学',
            graduationYear: '2021',
          },
        ],
      },
      runtime_context: {
        upload_id: 'TEST-UPLOAD-001',
        candidate_id: 'C-TEST-001',
        resume_id: 'R-TEST-001',
        employee_id: 'EMP_TEST',
        filename: 'test.pdf',
        received_at: new Date().toISOString(),
        trace_id: `trace-${eventId}`,
      },
      trace_id: `trace-${eventId}`,
    },
  });

  console.log(`[test-rule-check] ✅ sent RULE_CHECK_REQUESTED`);
  console.log(`  inngest event ids: ${JSON.stringify(result.ids)}`);
  console.log('');
  console.log('观察:');
  console.log('  1. http://localhost:8288/stream 看事件流');
  console.log('     应该看到 RULE_CHECK_PASSED 或 RULE_CHECK_FAILED');
  console.log('  2. tail -f lib/rule-check/logs/$(date +%Y-%m-%d).log');
})();
