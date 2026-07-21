import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({
    neo4j_browser_base: process.env.NEO4J_BROWSER_BASE ?? null,
  });
}
