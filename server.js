const http=require('http');
const {LUMI_PERSONALITY}=require('./personality');
const PORT=Number(process.env.LUMI_BRAIN_PORT||8787);
const API_KEY=process.env.LUMI_AI_API_KEY||'';
const API_URL=process.env.LUMI_AI_API_URL||'';
const MODEL=process.env.LUMI_AI_MODEL||'';
const allowed=new Set(['happy','shy','surprised','playful','angry','sad']);
function send(res,status,obj){res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,OPTIONS'});res.end(JSON.stringify(obj))}
function parseJsonText(text){text=String(text||'').trim().replace(/^```json\s*/i,'').replace(/```$/,'').trim();return JSON.parse(text)}
const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS')return send(res,204,{});
  if(req.url!=='/lumi/chat'||req.method!=='POST')return send(res,404,{error:'Not found'});
  if(!API_KEY||!API_URL||!MODEL)return send(res,503,{error:'Brain is not configured. Set LUMI_AI_API_KEY, LUMI_AI_API_URL and LUMI_AI_MODEL outside the project files.'});
  let raw='';req.on('data',c=>{raw+=c;if(raw.length>50000)req.destroy()});
  req.on('end',async()=>{try{
    const body=JSON.parse(raw||'{}'); const message=String(body.message||'').trim();
    if(!message)return send(res,400,{error:'Message is required'});
    const hist=Array.isArray(body.history)?body.history.slice(-12).filter(x=>x&&['user','assistant'].includes(x.role)&&typeof x.content==='string'):[];
    const upstream=await fetch(API_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+API_KEY},body:JSON.stringify({model:MODEL,messages:[{role:'system',content:LUMI_PERSONALITY},...hist,{role:'user',content:message}],temperature:.85})});
    if(!upstream.ok){const t=await upstream.text();throw new Error('AI provider error '+upstream.status+': '+t.slice(0,180))}
    const json=await upstream.json();
    const text=json?.choices?.[0]?.message?.content;
    const out=parseJsonText(text);
    if(typeof out.reply!=='string'||!allowed.has(out.emotion))throw new Error('AI returned an invalid Lumi response');
    return send(res,200,{reply:out.reply.trim(),emotion:out.emotion});
  }catch(e){return send(res,500,{error:e.message||'Brain error'})}})
});
server.listen(PORT,'127.0.0.1',()=>console.log('Lumi Brain ready on http://127.0.0.1:'+PORT));
