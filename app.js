const TIME_LIMIT_SEC = 60*60;
const PASS_THRESHOLD = 0.70;

let API_BASE = "";
let TOKEN = "";                  // /api/session で受け取る署名トークン（無状態）
let PLAN = [];                   // 40問の {id, chapter} リスト
let BANK = {};                   // {chapterId: [問題…]}（正解なし・静的CDN）
let QUESTIONS = [];              // 実際に出す40問（optionsはシャッフル）
let INDEX = 0;
let ANSWERS = {};                // {id:[displayIndex...]}
let CORRECT_FLAGS = {};          // {id:true/false}（即時判定のためフロント側に最小保存）
let TIMER = TIME_LIMIT_SEC;
let TICK = null;

const $ = (id)=>document.getElementById(id);
const setTimer = (s)=>{ const m=Math.floor(s/60),r=s%60; $("timer").textContent=`${String(m).padStart(2,"0")}:${String(r).padStart(2,"0")}`; };
const shuffle = (arr)=>{ const a=arr.slice(); for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; };

// --- 比率→40問配分（端数は比率大の章から配る）
function allocateByRatio(chapters, totalTarget){
  const base = chapters.map(c=>({id:c.id, ratio:c.ratio, want:c.ratio*totalTarget}));
  base.forEach(b=> b.take = Math.floor(b.want));
  let rest = totalTarget - base.reduce((s,b)=>s+b.take,0);
  base.sort((a,b)=> b.ratio - a.ratio);
  for(let i=0; i<base.length && rest>0; i++, rest--) base[i].take++;
  return base.map(b=>({id:b.id, count:b.take}));
}

async function fetchJSON(url){ const r=await fetch(url,{cache:"no-store"}); if(!r.ok) throw new Error(url); return r.json(); }

// 章の shard から必要数をランダム抽出（正解なしの問題本文）
async function sampleFromChapter(root, chap, need){
  if(need<=0) return [];
  // 必要分が満たせるまで shard を読み込む
  const pool = [];
  for(const shard of chap.shards){
    const data = await fetchJSON(`${root}/${shard}`);
    pool.push(...data);
    if(pool.length >= need) break;
  }
  return shuffle(pool).slice(0, need);
}

async function buildPlanAndQuestions(){
  // 1) manifest取得
  const root = "./questions/v1";
  const manifest = await fetchJSON(`${root}/manifest.json`);
  const alloc = allocateByRatio(manifest.chapters, manifest.total_target); // 40問
  // 2) 章ごとに必要数をサンプリング
  const chosen = [];
  for(const a of alloc){
    const chap = manifest.chapters.find(c=>c.id===a.id);
    const items = await sampleFromChapter(root, chap, a.count);
    chosen.push(...items.map(it=>({ id: it.id, chapterId: a.id, raw: it })));
  }
  // 3) シャッフル＆表示用整形（各問の選択肢もシャッフルし、元→表示マップを保持）
  const shuffled = shuffle(chosen).map(x=>{
    const map = x.raw.options.map((_,i)=>i);
    const order = shuffle(map);
    return {
      id: x.id,
      chapter: x.raw.chapter,
      type: x.raw.type,
      text: x.raw.text,
      options: order.map(i=>x.raw.options[i]),
      _perm: order,                   // 表示→元インデックスの写像
      explanation: x.raw.explanation  // ※正解はない。解説は正解公開後に表示
    };
  });
  QUESTIONS = shuffled;
  PLAN = QUESTIONS.map(q=>({id:q.id})); // サーバにはIDのみ送る（40問）
}

// Workerに「この40問で受験します」と宣言 → 署名トークンを受領（無状態）
async function openSession(){
  const res = await fetch(`${API_BASE}/session`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ plan: PLAN, ttl_sec: 5400 }) // 90分など
  });
  if(!res.ok) throw new Error("セッション開始失敗");
  const data = await res.json();
  TOKEN = data.token; // HMAC署名済みJWT風トークン
}

// 1問分の即時検証
async function verifyOne(q, picksDisplay){
  const picksOrig = (picksDisplay||[]).map(i => q._perm[i]); // 表示→元
  const res = await fetch(`${API_BASE}/verify`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ token: TOKEN, qid: q.id, picks: picksOrig })
  });
  if(!res.ok) throw new Error("検証失敗");
  return res.json(); // {ok, explanation} など
}

function renderQuestion(){
  const q = QUESTIONS[INDEX]; if(!q) return;
  $("qnum").textContent = INDEX+1; $("qtotal").textContent = QUESTIONS.length;
  $("qtext").textContent = q.text;
  $("qmeta").textContent = `${q.chapter} / ${q.type==="multi"?"（複数選択）":"（単一選択）"}`;
  const form = $("qform"); form.innerHTML = "";
  const sel = new Set(ANSWERS[q.id]||[]);
  const inputType = q.type==="multi" ? "checkbox" : "radio";
  q.options.forEach((opt,i)=>{
    const lab = document.createElement("label"); lab.className="option";
    const ip = document.createElement("input");
    ip.type = inputType; ip.name="opt"; ip.value=i; ip.checked=sel.has(i);
    ip.addEventListener("change", ()=>{
      if(inputType==="radio"){ ANSWERS[q.id] = [i]; form.querySelectorAll('input[name="opt"]').forEach(n=>{ if(n!==ip) n.checked=false; }); }
      else{ ip.checked ? sel.add(i) : sel.delete(i); ANSWERS[q.id] = [...sel].sort((a,b)=>a-b); }
    });
    const span = document.createElement("span"); span.textContent = opt;
    lab.appendChild(ip); lab.appendChild(span); form.appendChild(lab);
  });
  $("instant").classList.add("hidden"); $("instant").innerHTML = "";
}

async function instantCheck(){
  const q = QUESTIONS[INDEX];
  const picks = ANSWERS[q.id] || [];
  const r = await verifyOne(q, picks);   // {ok:true/false, explanation:"..."}
  CORRECT_FLAGS[q.id] = !!r.ok;
  const box = $("instant"); box.classList.remove("hidden");
  box.innerHTML = `<div>${r.ok ? "⭕ 正解" : "❌ 不正解"}</div><div>${r.explanation||""}</div>`;
}

function toNext(){ if(INDEX<QUESTIONS.length-1){ INDEX++; renderQuestion(); } }
function toPrev(){ if(INDEX>0){ INDEX--; renderQuestion(); } }

function summaryLocal(){
  // サーバ蓄積しない。手元の CORRECT_FLAGS 集計でOK。
  const total = QUESTIONS.length;
  const correct = QUESTIONS.filter(q=>CORRECT_FLAGS[q.id]).length;
  const pct = total ? Math.round((correct/total)*100) : 0;
  const pass = pct >= (PASS_THRESHOLD*100);
  $("exam").classList.add("hidden");
  $("result").classList.remove("hidden");
  $("scoreLine").textContent = `スコア: ${correct}/${total} (${pct}%) → ${pass ? "合格":"不合格"}`;

  const detail = $("detail"); detail.innerHTML = "";
  QUESTIONS.forEach((q,i)=>{
    const you = (ANSWERS[q.id]||[]).map(di=> q.options[di]);
    const row = document.createElement("div"); row.className="panel";
    row.innerHTML = `<div>Q${i+1}: ${q.text}</div>
                     <div>あなたの回答: ${you.join(", ")||"未回答"}</div>
                     <div>解説: ${q.explanation||""}</div>`;
    detail.appendChild(row);
  });
}

document.addEventListener("DOMContentLoaded", async ()=>{
  $("startBtn").addEventListener("click", async ()=>{
    try{
      // 置き換え前: API_BASE = $("apiBase").value.replace(/\/+$/,"") + "/api";
      API_BASE = $("apiBase").value.replace(/\/+$/,"");
      if (!/\/api$/.test(API_BASE)) API_BASE += "/api";
      await buildPlanAndQuestions();       // 比率→40問抽出（静的CDNのみ）
      await openSession();                 // 署名トークン取得（無状態）
      INDEX=0; ANSWERS={}; CORRECT_FLAGS={}; TIMER=TIME_LIMIT_SEC; setTimer(TIMER);
      $("config").classList.add("hidden"); $("exam").classList.remove("hidden"); renderQuestion();
      clearInterval(TICK);
      TICK = setInterval(()=>{ TIMER--; setTimer(TIMER); if(TIMER<=0) summaryLocal(); }, 1000);
    }catch(e){ alert("開始できません"); }
  });
  $("nextBtn").addEventListener("click", toNext);
  $("prevBtn").addEventListener("click", toPrev);
  $("finishBtn").addEventListener("click", summaryLocal);
  $("qform")?.addEventListener?.("submit", e=>e.preventDefault());
  // 即時チェックは「次へ」押下前に任意のタイミングで
  document.addEventListener("keydown",(e)=>{ if(e.key==="Enter") instantCheck(); });
  // クリックボタンが欲しければ次の1行をUIに追加（省略可）
  // <button type="button" onclick="instantCheck()" class="btn">この問題を判定</button>
});
