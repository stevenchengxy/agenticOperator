// 智能体值班工作台 — companion platform (standalone, zero-dependency Node server).
//
// ONE platform for ALL runnable domains' event-pushing: it mirrors AO's 人工待办
// across domains, lets an operator INJECT a case (seed a scenario) and RESOLVE a
// human gate. A domain switcher flips between 能源调度 (energy) and 费控 (cost
// control). On a gate click it posts to AO's unified /api/human-decision, which
// records the decision and emits the resume event that wakes the suspended agent.
// No DB, no auth — demo only. It proxies AO server-side (no CORS).
//
// Run:  node companion/server.mjs    (AO must be on :3002, Inngest on :8288)
// Open: http://localhost:4180

import { createServer } from "node:http";

const PORT = Number(process.env.COMPANION_PORT ?? 4180);
const AO = (process.env.AO_BASE ?? "http://localhost:3002").replace(/\/$/, "");

// All runnable domains served by this console. Gate labels + decision verbs must
// match server/inngest/human-decision.ts (GATE_DECISIONS) and each domain's gates.
const DOMAINS = [
  {
    id: process.env.ENERGY_DOMAIN_ID ?? "能源调度-v1",
    ns: "energy",
    label: "能源调度",
    scenarios: [
      { id: "happy", label: "happy 全自动" },
      { id: "manual-review", label: "manual-review 闸口①" },
      { id: "risk-redline", label: "risk-redline 闸口②" },
      { id: "finalize-confirm", label: "finalize-confirm 闸口③" },
    ],
    gates: {
      manualConfirm: { label: "人工确认闸口①", decisions: ["采纳", "退回", "否决", "暂缓"] },
      handleFloodControl: { label: "风险处置·防洪", decisions: ["放行", "暂缓", "上报"] },
      handleGridSecurity: { label: "风险处置·电网", decisions: ["放行", "暂缓", "上报"] },
      handleEquipmentFault: { label: "风险处置·设备", decisions: ["放行", "暂缓", "上报"] },
      handleRenewableCurtailment: { label: "风险处置·消纳", decisions: ["放行", "暂缓", "上报"] },
      finalizePlan: { label: "计划定版封口闸口③", decisions: ["确认封口", "不通过"] },
    },
  },
  {
    id: process.env.COST_CONTROL_DOMAIN_ID ?? "费控-v1",
    ns: "feikong",
    label: "费控",
    scenarios: [
      { id: "happy", label: "happy 直通自动核准" },
      { id: "deduction", label: "deduction 核减→人工复核" },
      { id: "risk-split", label: "risk-split 拆分 T4/L3" },
      { id: "risk-private", label: "risk-private 私购 T7/L4" },
    ],
    gates: {
      manualReview: { label: "人工复核闸口", decisions: ["确认核准", "降额", "退回", "驳回"] },
      disposeRiskEvent: { label: "风险处置闸口", decisions: ["放行", "暂缓", "上报"] },
    },
  },
];

const byId = (id) => DOMAINS.find((d) => d.id === id) ?? DOMAINS[0];

async function aoJson(path, init) {
  const res = await fetch(`${AO}${path}`, init);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 400) } };
  }
}

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    // The domain catalog the UI renders tabs / buttons / gate labels from.
    if (req.method === "GET" && url.pathname === "/api/config") {
      send(res, 200, { ok: true, domains: DOMAINS });
      return;
    }
    // Mirror AO's 人工待办 for the requested domain.
    if (req.method === "GET" && url.pathname === "/api/todos") {
      const dom = byId(url.searchParams.get("domain") ?? "");
      const { body } = await aoJson(`/api/notifications?needsHuman=1&limit=50&domain=${encodeURIComponent(dom.id)}`);
      const todos = (body?.notifications ?? [])
        .filter((n) => n?.anchors?.gate && dom.gates[n.anchors.gate])
        .map((n) => ({
          id: n.id,
          ts: n.ts,
          gate: n.anchors.gate,
          gateLabel: dom.gates[n.anchors.gate]?.label ?? n.anchors.gate,
          caseId: n.anchors.caseId ?? n.runId,
          dsNo: n.anchors.dsNo ?? "",
          title: n.title,
          body: n.body,
          anchors: n.anchors,
          decisions: dom.gates[n.anchors.gate]?.decisions ?? [],
        }));
      send(res, 200, { ok: true, domain: dom.id, count: todos.length, todos });
      return;
    }
    // Forward an operator decision to AO's unified human-decision endpoint.
    if (req.method === "POST" && url.pathname === "/api/decide") {
      const payload = await readJson(req);
      const dom = byId(payload.domain ?? "");
      const r = await aoJson(`/api/human-decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, domain: dom.id }),
      });
      send(res, r.status, r.body);
      return;
    }
    // Inject / seed a case for the requested domain (demo seeding).
    if (req.method === "POST" && url.pathname === "/api/seed") {
      const { domain, scenario } = await readJson(req);
      const dom = byId(domain ?? "");
      const r = await aoJson(`/api/ontology-generator/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domainId: dom.id, scenario }),
      });
      send(res, r.status, r.body);
      return;
    }
    send(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    send(res, 502, { ok: false, error: `companion proxy error: ${String(e)}` });
  }
});

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

server.listen(PORT, () => {
  console.log(`智能体值班工作台 (companion) → http://localhost:${PORT}  ·  proxying AO at ${AO}  ·  domains: ${DOMAINS.map((d) => d.label).join(" / ")}`);
});

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>智能体值班工作台 · 人工待办</title>
<style>
  :root{--bg:#0d1117;--card:#161b22;--line:#30363d;--ink:#e6edf3;--ink2:#9da7b3;--accent:#3b82f6;--ok:#16a34a;--warn:#d97706;--err:#dc2626;}
  *{box-sizing:border-box} body{margin:0;font:14px/1.5 -apple-system,"PingFang SC",Segoe UI,sans-serif;background:var(--bg);color:var(--ink);}
  header{padding:16px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  header h1{font-size:17px;margin:0;font-weight:600} header .sub{color:var(--ink2);font-size:12px}
  .pill{margin-left:auto;font-size:12px;color:var(--ink2)}
  .tabs{display:flex;gap:8px;padding:10px 24px;border-bottom:1px solid var(--line)}
  .tab{background:#21262d;color:var(--ink2);border:1px solid var(--line);border-radius:999px;padding:6px 16px;cursor:pointer;font-size:13px}
  .tab.active{color:#fff;border-color:var(--accent);background:color-mix(in oklch,var(--accent) 24%,#21262d)}
  .seed{display:flex;gap:6px;flex-wrap:wrap;padding:12px 24px;border-bottom:1px solid var(--line);align-items:center}
  .seed button{background:#21262d;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px}
  .seed button:hover{border-color:var(--accent)}
  main{padding:20px 24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
  .card.risk{border-color:color-mix(in oklch,var(--err) 45%,var(--line))}
  .gate{font-size:11px;letter-spacing:.04em;color:var(--accent);font-weight:600}
  .gate.risk{color:var(--err)}
  .title{font-size:15px;font-weight:600;margin:6px 0}
  .body{color:var(--ink2);font-size:13px;white-space:pre-wrap;margin-bottom:10px}
  .meta{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .tag{font-size:11px;background:#21262d;border:1px solid var(--line);border-radius:6px;padding:2px 7px;color:var(--ink2)}
  .row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center}
  input{background:#0d1117;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:7px 9px;font-size:12px;flex:1;min-width:120px}
  .btns{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
  .btn{border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;font-weight:600;color:#fff}
  .btn.yes{background:var(--ok)} .btn.no{background:#30363d} .btn.warn{background:var(--warn)} .btn.danger{background:var(--err)}
  .btn:active{transform:translateY(1px)}
  .empty{color:var(--ink2);padding:40px;text-align:center;grid-column:1/-1}
  .toast{position:fixed;bottom:20px;right:20px;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--ok);padding:12px 16px;border-radius:10px;font-size:13px;max-width:380px;opacity:0;transition:opacity .2s}
  .toast.show{opacity:1}
</style></head>
<body>
<header>
  <div><h1>智能体值班工作台</h1><div class="sub">多业务域 · 人工待办（与 Agentic Operator 实时同步）</div></div>
  <div class="pill" id="pill">同步中…</div>
</header>
<div class="tabs" id="tabs"></div>
<div class="seed" id="seed"></div>
<main id="list"><div class="empty">加载中…</div></main>
<div class="toast" id="toast"></div>
<script>
const POS = new Set(["采纳","放行","确认封口","确认核准"]);
function cls(d){ if(POS.has(d))return"yes"; if(d==="退回"||d==="不通过"||d==="暂缓")return"no"; if(d==="否决"||d==="驳回")return"danger"; return"warn"; }
const state = { domains: [], current: null };

async function boot(){
  const j = await (await fetch('/api/config')).json();
  state.domains = j.domains || [];
  state.current = state.domains[0]?.id;
  renderTabs(); renderSeed(); load(); setInterval(load, 3000);
}
function dom(){ return state.domains.find(d=>d.id===state.current) || state.domains[0]; }
function renderTabs(){
  document.getElementById('tabs').innerHTML = state.domains.map(d=>
    '<div class="tab '+(d.id===state.current?'active':'')+'" onclick="switchTo(\\''+d.id+'\\')">'+d.label+'</div>').join('');
}
function renderSeed(){
  const d = dom(); if(!d) return;
  document.getElementById('seed').innerHTML =
    '<span style="color:var(--ink2);font-size:12px">注入一个'+d.label+'案件：</span>'
    + d.scenarios.map(s=>'<button onclick="seed(\\''+s.id+'\\')">'+s.label+'</button>').join('');
}
function switchTo(id){ state.current=id; renderTabs(); renderSeed(); document.getElementById('list').innerHTML='<div class="empty">加载中…</div>'; load(); }

async function load(){
  const d = dom(); if(!d) return;
  try{
    const j = await (await fetch('/api/todos?domain='+encodeURIComponent(d.id))).json();
    const list = document.getElementById('list');
    document.getElementById('pill').textContent = d.label+' 待办 '+(j.count||0)+' · '+new Date().toLocaleTimeString();
    if(!j.todos || !j.todos.length){ list.innerHTML='<div class="empty">暂无人工待办。点上方按钮注入一个场景，或在 AO 触发该业务域。</div>'; return; }
    list.innerHTML = j.todos.map(t=>{
      const risk = t.gate==='disposeRiskEvent' || t.gate.startsWith('handle');
      const a = t.anchors||{};
      const tags = Object.entries(a).filter(([k])=>!['caseId','gate'].includes(k)).map(([k,v])=>'<span class="tag">'+k+': '+v+'</span>').join('');
      const btns = t.decisions.map(dec=>'<button class="btn '+cls(dec)+'" onclick="decide(this,\\''+t.id+'\\',\\''+t.caseId+'\\',\\''+t.gate+'\\',\\''+dec+'\\')">'+dec+'</button>').join('');
      return '<div class="card '+(risk?'risk':'')+'">'
        +'<div class="gate '+(risk?'risk':'')+'">'+t.gateLabel+'</div>'
        +'<div class="title">'+t.title+'</div>'
        +'<div class="body">'+(t.body||'')+'</div>'
        +'<div class="meta">'+tags+'</div>'
        +'<div class="row"><input id="op-'+t.id+'" placeholder="处置人" value="值班人员"/>'
        +'<input id="rs-'+t.id+'" placeholder="处置意见/理由"/></div>'
        +'<div class="btns">'+btns+'</div></div>';
    }).join('');
  }catch(e){ document.getElementById('pill').textContent='同步失败: '+e; }
}
async function decide(btn,id,caseId,gate,decision){
  const operator = document.getElementById('op-'+id).value || '值班人员';
  const reason = document.getElementById('rs-'+id).value || '';
  btn.parentElement.querySelectorAll('button').forEach(b=>b.disabled=true);
  const r = await fetch('/api/decide',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({domain:state.current,notificationId:id,caseId,gate,decision,reason,operator})});
  const j = await r.json();
  toast(j.ok ? ('已处理：'+decision+' → 已推进 agent 续跑') : ('失败：'+(j.error||'')));
  setTimeout(load, 600);
}
async function seed(scenario){
  const r=await fetch('/api/seed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({domain:state.current,scenario})});
  const j=await r.json();
  toast(j.ok?('已注入 '+scenario+'（案件 '+(j.caseId||'')+'），等待跑到闸口…'):('注入失败：'+(j.error||'')));
  setTimeout(load,4000);
}
function toast(m){ const t=document.getElementById('toast'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3500); }
boot();
</script>
</body></html>`;
