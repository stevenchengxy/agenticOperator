// 供给本地 RAAS 镜像库(开发态读取兜底用)。
//   1. 在本地 AO Postgres 容器(5433)里建 database `raas_mirror`(若不存在)
//   2. 应用 scripts/sql/raas-mirror-schema.sql(raas_v4 全量表,已剥离外键)
//
// 这个库只在**开发**时用:partner-pg(同事 192.168.1.102)连不上时,AO 透明
// 兜底到这里读/写(见 lib/partner-pg/client.ts + RAAS_MIRROR_PG_URL)。
// 生产部署不设 RAAS_MIRROR_PG_URL → 这个库不存在、兜底不触发、行为与现在一致。
//
// 跑:`npm run raas-mirror:up`
// schema 重生成(raas schema 变了之后):
//   1) cp raas_v4/backend/prisma/schema.prisma /tmp/s.prisma;删掉 datasource 里 url= 行
//   2) npx prisma migrate diff --from-empty --to-schema /tmp/s.prisma --script > /tmp/d.sql
//   3) 剥离 `-- AddForeignKey` + `ALTER TABLE ... FOREIGN KEY` 行 → scripts/sql/raas-mirror-schema.sql

import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const mirrorUrl = process.env.RAAS_MIRROR_PG_URL;
if (!mirrorUrl) {
  console.error('[raas-mirror] RAAS_MIRROR_PG_URL 未配置(见 .env.local 7b 节)。');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, 'sql', 'raas-mirror-schema.sql');

async function main() {
  const u = new URL(mirrorUrl as string);
  const dbName = u.pathname.replace(/^\//, '');
  if (!dbName) throw new Error('RAAS_MIRROR_PG_URL 缺 database 名');

  // 1) 连到同容器的 `ao` 库做 admin,建 raas_mirror(CREATE DATABASE 不能在事务里,
  //    pg 单语句执行即可)。
  const adminUrl = new URL(mirrorUrl as string);
  adminUrl.pathname = '/ao';
  const admin = new Pool({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5_000 });
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    console.log(`✓ 已建 database ${dbName}`);
  } else {
    console.log(`· database ${dbName} 已存在`);
  }
  await admin.end();

  // 2) 应用 schema(幂等:CREATE TABLE 已存在会报错,所以先看是否空库)
  const mirror = new Pool({ connectionString: mirrorUrl as string, connectionTimeoutMillis: 5_000 });
  const before = await mirror.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
  );
  if (before.rows[0].n > 0) {
    console.log(`· ${dbName} 已有 ${before.rows[0].n} 张表 — 跳过建表(要重建请先 drop database)`);
    await mirror.end();
    return;
  }
  const sql = readFileSync(schemaPath, 'utf8');
  await mirror.query(sql);
  const after = await mirror.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
  );
  console.log(`✓ 已对 ${dbName} 应用 schema:${after.rows[0].n} 张表(无外键)`);
  await mirror.end();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[raas-mirror] 供给失败:', e);
    process.exit(1);
  });
