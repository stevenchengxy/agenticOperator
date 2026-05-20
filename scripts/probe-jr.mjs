// Analyze: what does "HSM 发布的 JR" mean in the schema?
// Compare:
//   A) spec.hsm_employee_id  →  HSM is "the spec's HSM" (current matching)
//   B) jp.recruiter_id       →  HSM is the posting's recruiter (current matching, OR-ed)
//   C) jp.published_by / jp.status='published'  →  HSM actually pushed it live
//   D) other published-marker fields
import { config } from 'dotenv';
config({ path: '/Users/yuhancheng/Desktop/agenticOperator/.env.local' });
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.RAAS_POSTGRES_URL });

// Inspect schemas of the 3 tables involved
for (const t of ['job_requisition', 'job_requisition_specification', 'job_posting']) {
  const c = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [t]);
  console.log(`\n=== ${t} ===`);
  for (const r of c.rows) console.log(`  ${r.column_name.padEnd(36)} ${r.data_type}`);
}

const HSM = '0000023911';

// Counts under each interpretation
console.log('\n=== count rows under each interpretation (HSM = 0000023911) ===');
const q1 = await pool.query(`SELECT COUNT(DISTINCT spec.job_requisition_specification_id) AS n FROM job_requisition_specification spec WHERE spec.hsm_employee_id = $1`, [HSM]);
console.log(`  A) spec.hsm_employee_id = HSM           : ${q1.rows[0].n} specs`);

const q2 = await pool.query(`SELECT COUNT(DISTINCT jr.job_requisition_id) AS n
  FROM job_requisition jr
  JOIN job_requisition_specification spec ON spec.job_requisition_specification_id = jr.job_requisition_specification_id
  WHERE spec.hsm_employee_id = $1`, [HSM]);
console.log(`  A.1) JRs whose spec.hsm = HSM            : ${q2.rows[0].n} JRs (incl. unpublished)`);

const q3 = await pool.query(`SELECT COUNT(*) AS n FROM job_posting WHERE recruiter_id = $1`, [HSM]);
console.log(`  B) job_posting.recruiter_id = HSM        : ${q3.rows[0].n} postings`);

const q4 = await pool.query(`SELECT COUNT(DISTINCT jp.job_requisition_id) AS n
  FROM job_posting jp
  JOIN job_requisition jr ON jr.job_requisition_id = jp.job_requisition_id
  JOIN job_requisition_specification spec ON spec.job_requisition_specification_id = jr.job_requisition_specification_id
  WHERE spec.hsm_employee_id = $1 OR jp.recruiter_id = $1`, [HSM]);
console.log(`  CURRENT) [spec.hsm OR jp.recruiter] + has JP : ${q4.rows[0].n} distinct JRs`);

// Show a sample of postings for this HSM to spot the relevant status / publisher fields
console.log('\n=== sample job_postings (where spec.hsm OR jp.recruiter = HSM) ===');
const samp = await pool.query(`SELECT jp.*
  FROM job_posting jp
  LEFT JOIN job_requisition jr ON jr.job_requisition_id = jp.job_requisition_id
  LEFT JOIN job_requisition_specification spec ON spec.job_requisition_specification_id = jr.job_requisition_specification_id
  WHERE spec.hsm_employee_id = $1 OR jp.recruiter_id = $1
  ORDER BY jp.updated_at DESC NULLS LAST
  LIMIT 5`, [HSM]);
for (const r of samp.rows) console.log(' ', JSON.stringify(r).slice(0, 500));

// distinct status values on job_posting
console.log('\n=== job_posting status distinct ===');
const stat = await pool.query(`SELECT status, COUNT(*) AS n FROM job_posting GROUP BY status ORDER BY n DESC LIMIT 20`);
for (const r of stat.rows) console.log(`  status=${(r.status??'<null>').padEnd(20)} ${r.n}`);

await pool.end();
