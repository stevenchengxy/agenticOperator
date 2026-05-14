import { buildRuleCheckInput } from '@/lib/rule-check';
import { composePrompt } from '@/lib/rule-check/prompt';
import { applyClientFilter, classifyRules, extractDims } from '@/lib/rule-check/ontology';
import { fetchRulesForMatchResume } from '@/lib/rule-check/ontology-source';
import { projectResume } from '@/lib/rule-check/resume-projection';

(async () => {
  const parsed_resume = {
    name: '赵六', gender: '男', birth_date: '1996-05-12',
    nationality: '中国', marital_status: '已婚', location: '深圳',
    education: [{ school: '武汉大学', major: '计算机', degree: '本科', startDate: '2014-09', endDate: '2018-06' }],
    experience: [
      { company: '腾讯', title: '后端工程师', startDate: '2018-07', endDate: '2022-06' },
      { company: '字节跳动', title: '高级后端工程师', startDate: '2022-07', endDate: '至今' },
    ],
    skills: ['Go', 'Kubernetes', 'PostgreSQL'],
    former_tencent_employment: true,
  };
  const job_requisition = {
    job_requisition_id: 'JR_TENCENT_IEG_001',
    client_id: 'CLI_TENCENT',
    client_department_id: 'CLI_TENCENT_IEG_TIANMEI',
    client_job_title: '后端工程师 (天美)',
    job_responsibility: '负责天美工作室游戏后端服务开发',
    job_requirement: '本科以上,Go/Java,熟悉游戏后端',
    must_have_skills: ['Go', 'Kubernetes'],
    work_years: 5,
  };
  const input = buildRuleCheckInput({
    runtime_context: {
      upload_id: 'up_demo', candidate_id: 'cand_zhaoliu',
      resume_id: 'res_demo', employee_id: '0000199059', trace_id: 'demo',
    },
    parsed_resume, job_requisition,
  });
  const dims = extractDims(input.job_requisition);
  const src = await fetchRulesForMatchResume();
  const filtered = applyClientFilter(src.rules, dims);
  const projected = projectResume(input.resume, filtered);
  const classified = classifyRules(filtered);
  const prompt = composePrompt({ input: { ...input, resume: projected }, classified, dims });
  console.log(`# DIMS: ${JSON.stringify(dims)}`);
  console.log(`# rule_source=${src.source} fetched=${src.rules.length} filtered=${filtered.length}`);
  console.log(`# prompt_length=${prompt.length} chars`);
  console.log('---PROMPT START---');
  console.log(prompt);
  console.log('---PROMPT END---');
})();
