import React, { useMemo, useRef, useState, useEffect } from "react";
import { Plus, Trash2, Upload, Printer, Save, Download, Send, Paperclip, Image as ImageIcon } from "lucide-react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

/** =============================================
 *  Site de Solicitação de Reembolso
 *  - Formulário completo (empresa, colaborador, itens, anexos)
 *  - Gera recibo (PDF) automaticamente
 *  - Envia e-mail com o PDF (e anexos, se desejar)
 *  - Salvar/Carregar JSON
 *  Requer endpoint: /api/reimbursement/submit (vide instruções no chat)
 *  ============================================= */

// ===== Util: moeda (R$) <-> número (robusto) =====
function parseBRLToNumber(v) {
  try {
    // 1) números: retorna direto se finito
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    // 2) null/undefined: 0
    if (v == null) return 0;
    // 3) Proteção: se não for string, não tenta String(v)
    if (typeof v !== "string") return 0;

    const s = v;
    // 4) Proteções contra strings de cor / lixo
    //    - oklch( ... ) → 0
    //    - se não houver nenhum dígito → 0
    if (/oklch\s*\(/i.test(s)) return 0;
    if (!/[0-9]/.test(s)) return 0;

    // 5) mantém dígitos, vírgula, ponto e sinal
    const cleaned = s.replace(/[^0-9.,+-]/g, "");
    // 6) remove pontos de milhar (1.234,56 -> 1234,56)
    const noThousands = cleaned.replace(/\.(?=\d{3}(\D|$))/g, "");
    // 7) vírgula para ponto
    const normalized = noThousands.replace(/,/g, ".");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : 0;
  } catch {
    // qualquer exceção inesperada volta 0 para não quebrar a UI
    return 0;
  }
}
function formatBRL(n) {
  const num = parseBRLToNumber(n);
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(num);
  } catch {
    return `R$ ${num.toFixed(2).replace(".", ",")}`;
  }
}

// ===== Número por extenso (pt-BR) (essencial) =====
const UNIDADES = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const DEZENAS  = ["", "dez", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const CENTENAS = ["", "cem", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
function tCentena(n){ if(n===0) return ""; if(n===100) return "cem"; const d=n%100, c=Math.floor(n/100); const ct=c?(c===1?"cento":CENTENAS[c]):""; return d? (ct?`${ct} e ${tDezena(d)}`:tDezena(d)) : ct; }
function tDezena(n){ if(n<20) return UNIDADES[n]; const d=Math.floor(n/10), u=n%10; return u? `${DEZENAS[d]} e ${UNIDADES[u]}`: DEZENAS[d]; }
function grupo(n){ return tCentena(n); }
function numeroPorExtenso(n){ n=Math.floor(parseBRLToNumber(n)); if(n===0) return "zero"; const partes=[]; const grupos=[{s:"bilhão",p:"bilhões"},{s:"milhão",p:"milhões"},{s:"mil",p:"mil"},{s:"",p:""}]; const gvals=[]; let r=n; for(let i=0;i<4;i++){ gvals.unshift(r%1000); r=Math.floor(r/1000);} while(gvals.length>1 && gvals[0]===0) gvals.shift(); const start=grupos.length-gvals.length; gvals.forEach((gv,idx)=>{ if(!gv) return; const g=grupos[start+idx]; const txt=grupo(gv); if(g.s){ partes.push(txt+" "+(gv===1?g.s:g.p)); } else partes.push(txt); }); const out = partes.join(" "); return out.startsWith("um mil") ? ("mil" + out.slice("um mil".length)) : out; }
function valorPorExtensoBRL(v){ const valor=Number(parseBRLToNumber(v).toFixed(2)); const r=Math.floor(valor), c=Math.round((valor-r)*100); const rtxt=r===1?"real":"reais", ctxt=c===1?"centavo":"centavos"; const p1=r?`${numeroPorExtenso(r)} ${rtxt}`:"", p2=c?`${numeroPorExtenso(c)} ${ctxt}`:""; return p1&&p2?`${p1} e ${p2}`: (p1||p2||"zero real"); }

// ===== Helpers =====
const readFileAsBase64 = (file) => new Promise((resolve,reject)=>{ const fr=new FileReader(); fr.onload=()=>{ const res=String(fr.result||""); const base64=res.split(",")[1]||res; resolve(base64); }; fr.onerror=()=>reject(fr.error); fr.readAsDataURL(file); });

export default function ReembolsoApp(){
  const printRef = useRef(null);

  // Empresa e colaborador
  const [empresa, setEmpresa] = useState({ nome: "Companhia Brasileira de Energia Renovavel S/A", cnpj: "09.378.010/0005-63", endereco: "Rod MT 100 - lado direito km 20 saindo de Alto Araguaia" });
  const [colab, setColab] = useState({ nome: "ANTONIO MARCOS DA SILVA RIBEIRO", email: "", banco: "Banco do Brasil", agencia: "0512-6", conta: "20.948-1", tipoConta: "Corrente" });
  const [datas, setDatas] = useState({ emissao: "2025-08-31", vencimento: "2025-09-09", local: "ALTO ARAGUAIA - MT"});

  // Itens
  const [itens, setItens] = useState([
    { data: "2025-08-31", descricao: "3 Almoços - Fazenda Graciosa", centro: "Fazenda Graciosa", valor: 85 },
    { data: "2025-08-28", descricao: "Selo mecânico 1 1/4\" - Fazenda Graciosa", centro: "Fazenda Graciosa", valor: 92 },
  ]);
  const total = useMemo(()=> itens.reduce((s, i)=> s + parseBRLToNumber(i.valor), 0), [itens]);
  const totalExtenso = useMemo(()=> valorPorExtensoBRL(total), [total]);

  // Anexos
  const [anexos, setAnexos] = useState([]);
  const fileRef = useRef(null);

  // E-mail
  const [mail, setMail] = useState({ to: "contaspagar@comber.com.br", cc: "", subject: "Solicitação de Reembolso", message: "Prezados,\n\nSegue solicitação de reembolso com recibo em anexo.\n\nAtt." });
  const [enviarAnexos, setEnviarAnexos] = useState(true);
  const [loading, setLoading] = useState(false);

  function addItem(){ setItens(prev=> [...prev, { data: new Date().toISOString().slice(0,10), descricao: "", centro: "", valor: 0 }]); }
  function removeItem(idx){ setItens(prev=> prev.filter((_,i)=> i!==idx)); }
  function updateItem(idx, key, val){ setItens(prev=> prev.map((it,i)=> i===idx? { ...it, [key]: key==="valor"? parseBRLToNumber(val): val } : it)); }

  function onFiles(e){
    const files = Array.from(e.target.files||[]);
    const mapped = files.map((f)=> ({ file:f, name:f.name, size:f.size, type:f.type, url: URL.createObjectURL(f) }));
    setAnexos(prev=> [...prev, ...mapped]);
    e.target.value = "";
  }
  function removeAnexo(idx){ setAnexos(prev => { const arr=[...prev]; arr.splice(idx,1); return arr;}); }

  function salvarJSON(){ const data = { empresa, colab, datas, itens, anexosMeta: anexos.map(a=>({name:a.name,size:a.size,type:a.type})) }; const blob = new Blob([JSON.stringify(data,null,2)], {type:"application/json"}); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `solicitacao-reembolso-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url); }
  function carregarJSON(e){ const file = e.target.files?.[0]; if(!file) return; const reader = new FileReader(); reader.onload = () => { try{ const obj = JSON.parse(String(reader.result)); if(obj.empresa) setEmpresa(obj.empresa); if(obj.colab) setColab(obj.colab); if(obj.datas) setDatas(obj.datas); if(Array.isArray(obj.itens)) setItens(obj.itens); }catch(err){ alert("Arquivo inválido"); } }; reader.readAsText(file); e.target.value = ""; }
  function imprimir(){ window.print(); }

  async function gerarPDF(){ const el = printRef.current; if(!el) return; const canvas = await html2canvas(el, {scale:2, useCORS:true, backgroundColor:"#fff"}); const imgData = canvas.toDataURL("image/png"); const pdf = new jsPDF({orientation:"portrait", unit:"pt", format:"a4"}); const pw = pdf.internal.pageSize.getWidth(); const ph = pdf.internal.pageSize.getHeight(); const r = Math.min(pw/canvas.width, ph/canvas.height); const w = canvas.width*r, h = canvas.height*r; pdf.addImage(imgData, "PNG", (pw-w)/2, 20, w, h); return pdf; }

  async function enviarSolicitacao(){
    try{
      if(!mail.to.trim()){ alert("Informe pelo menos um destinatário."); return; }
      setLoading(true);
      // 1) Gera PDF do recibo
      const pdf = await gerarPDF(); if(!pdf) throw new Error("PDF não gerado");
      const pdfBlob = pdf.output("blob");
      const pdfBuf = await pdfBlob.arrayBuffer();
      const pdfBase64 = btoa(String.fromCharCode(...new Uint8Array(pdfBuf)));

      // 2) Converte anexos (opcional)
      const anexosBase64 = enviarAnexos ? await Promise.all(anexos.map(async a=>({ filename: a.name, content: await readFileAsBase64(a.file), contentType: a.type||"application/octet-stream" }))) : [];

      // 3) Monta payload e envia para API
      const payload = {
        to: mail.to.split(",").map(s=>s.trim()).filter(Boolean),
        cc: mail.cc ? mail.cc.split(",").map(s=>s.trim()).filter(Boolean) : (colab.email? [colab.email] : []),
        subject: mail.subject || `Solicitação de Reembolso - ${colab.nome}`,
        message: mail.message,
        meta: { empresa, colab, datas, total, itens },
        attachments: [ { filename: `recibo-${Date.now()}.pdf`, content: pdfBase64, contentType: "application/pdf" }, ...anexosBase64 ]
      };

      const res = await fetch("/api/reimbursement/submit", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) });
      if(!res.ok) throw new Error(await res.text());
      alert("Solicitação enviada com sucesso! Um e-mail foi disparado com o recibo em anexo.");
    }catch(e){ console.error(e); alert("Não foi possível enviar a solicitação."); }
    finally{ setLoading(false); }
  }

  // Testes rápidos no console (sanity checks)
  useEffect(()=>{
    const ok1 = /R\$/.test(formatBRL(123.45));
    const ok2 = Math.abs(parseBRLToNumber("1.234,56")-1234.56)<1e-9;
    const ok3 = parseBRLToNumber("oklch(0.5 0.2 200)")===0;
    const ok4 = parseBRLToNumber({}) === 0; // objeto não-string deve ser tratado como 0
    const ok5 = parseBRLToNumber(() => {}) === 0; // função também 0
    const ok6 = Math.abs(parseBRLToNumber("R$\u00A01.234,56")-1234.56)<1e-9; // NBSP entre R$ e número
    const ok7 = parseBRLToNumber("abc") === 0; // sem dígitos
    const ok8 = Math.abs(parseBRLToNumber("R$ 12,34")-12.34)<1e-9; // formato simples
    const ok9 = /R\$/.test(formatBRL("oklch(1 2 3)")); // formatação segura para lixo/oklch
    console[ok1&&ok2&&ok3&&ok4&&ok5&&ok6&&ok7&&ok8&&ok9?"log":"error"](
      ok1&&ok2&&ok3&&ok4&&ok5&&ok6&&ok7&&ok8&&ok9?"✅ BRL utils ok":"❌ Verificar utils BRL"
    );
  },[]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 p-4 md:p-8">
      <div className="mx-auto max-w-5xl">
        {/* Barra de ações */}
        <div className="flex flex-wrap gap-2 justify-between items-center mb-4">
          <h1 className="text-2xl font-bold">Solicitação de Reembolso</h1>
          <div className="flex flex-wrap gap-2">
            <button onClick={addItem} className="inline-flex items-center gap-2 rounded-2xl px-4 py-2 shadow-sm bg-white hover:bg-slate-100"><Plus size={18}/> Adicionar item</button>
            <label className="inline-flex items-center gap-2 rounded-2xl px-4 py-2 shadow-sm bg-white hover:bg-slate-100 cursor-pointer">
              <Upload size={18}/> Anexar
              <input type="file" multiple onChange={onFiles} ref={fileRef} className="hidden" accept="image/*,application/pdf" />
            </label>
            <button onClick={salvarJSON} className="inline-flex items-center gap-2 rounded-2xl px-4 py-2 shadow-sm bg-white hover:bg-slate-100"><Save size={18}/> Salvar</button>
            <label className="inline-flex items-center gap-2 rounded-2xl px-4 py-2 shadow-sm bg-white hover:bg-slate-100 cursor-pointer">
              <Download size={18}/> Carregar
              <input type="file" onChange={carregarJSON} className="hidden" accept="application/json" />
            </label>
            <button onClick={imprimir} className="inline-flex items-center gap-2 rounded-2xl px-4 py-2 shadow-sm bg-indigo-600 text-white hover:bg-indigo-700"><Printer size={18}/> Imprimir / PDF</button>
            <button onClick={enviarSolicitacao} disabled={loading} className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2 shadow-sm text-white ${loading?"bg-emerald-400":"bg-emerald-600 hover:bg-emerald-700"}`}>
              <Send size={18}/> {loading?"Enviando...":"Enviar solicitação"}
            </button>
          </div>
        </div>

        {/* Empresa / Colaborador / Datas */}
        <section className="grid md:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold text-lg mb-3">Empresa</h2>
            <div className="grid gap-3">
              <Input label="Nome" value={empresa.nome} onChange={v=>setEmpresa({...empresa, nome:v})} />
              <Input label="CNPJ" value={empresa.cnpj} onChange={v=>setEmpresa({...empresa, cnpj:v})} />
              <Input label="Endereço" value={empresa.endereco} onChange={v=>setEmpresa({...empresa, endereco:v})} />
            </div>
          </div>
          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold text-lg mb-3">Colaborador</h2>
            <div className="grid gap-3">
              <Input label="Nome" value={colab.nome} onChange={v=>setColab({...colab, nome:v})} />
              <Input label="E-mail do colaborador (cópia)" value={colab.email} onChange={v=>setColab({...colab, email:v})} />
              <div className="grid grid-cols-3 gap-3">
                <Input label="Banco" value={colab.banco} onChange={v=>setColab({...colab, banco:v})} />
                <Input label="Agência" value={colab.agencia} onChange={v=>setColab({...colab, agencia:v})} />
                <Input label="Conta" value={colab.conta} onChange={v=>setColab({...colab, conta:v})} />
              </div>
              <Input label="Tipo de Conta" value={colab.tipoConta} onChange={v=>setColab({...colab, tipoConta:v})} />
            </div>
          </div>
          <div className="bg-white rounded-2xl shadow p-4 md:col-span-2">
            <h2 className="font-semibold text-lg mb-3">Datas e Local</h2>
            <div className="grid md:grid-cols-3 gap-3">
              <Input label="Local" value={datas.local} onChange={v=>setDatas({...datas, local:v})} />
              <Input label="Data do Recibo" type="date" value={datas.emissao} onChange={v=>setDatas({...datas, emissao:v})} />
              <Input label="Vencimento" type="date" value={datas.vencimento} onChange={v=>setDatas({...datas, vencimento:v})} />
            </div>
          </div>
        </section>

        {/* Itens */}
        <section className="bg-white rounded-2xl shadow p-4 my-4">
          <h2 className="font-semibold text-lg mb-3">Itens do Reembolso</h2>
          <div className="hidden md:grid grid-cols-12 gap-2 font-semibold text-sm text-slate-600 px-2 py-1 border-b">
            <div className="col-span-2">Data</div>
            <div className="col-span-6">Descrição</div>
            <div className="col-span-3">Centro de Custo</div>
            <div className="col-span-1 text-right">Valor</div>
          </div>
          <div className="space-y-2">
            {itens.map((it, idx)=> (
              <div key={idx} className="grid grid-cols-12 gap-2 items-center px-2">
                <input type="date" className="col-span-12 md:col-span-2 input" value={it.data} onChange={e=>updateItem(idx, "data", e.target.value)} />
                <input type="text" className="col-span-12 md:col-span-6 input" placeholder="Descrição" value={it.descricao} onChange={e=>updateItem(idx, "descricao", e.target.value)} />
                <input type="text" className="col-span-9 md:col-span-3 input" placeholder="Centro de Custo" value={it.centro} onChange={e=>updateItem(idx, "centro", e.target.value)} />
                <div className="col-span-3 md:col-span-1 flex items-center gap-2">
                  <input type="number" step="0.01" className="input text-right" value={it.valor} onChange={e=>updateItem(idx, "valor", e.target.value)} />
                  <button onClick={()=>removeItem(idx)} className="p-2 rounded-xl hover:bg-red-50 text-red-600" title="Remover"><Trash2 size={18}/></button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-end mt-4">
            <div className="text-right bg-slate-100 rounded-2xl px-4 py-2">
              <div className="text-sm text-slate-600">Total</div>
              <div className="text-xl font-bold">{formatBRL(total)}</div>
              <div className="text-xs text-slate-500">({totalExtenso})</div>
            </div>
          </div>
        </section>

        {/* Anexos */}
        <section className="bg-white rounded-2xl shadow p-4 mb-6">
          <h2 className="font-semibold text-lg mb-3">Anexos (fotos, recibos, PDFs)</h2>
          {anexos.length===0 && <p className="text-sm text-slate-500">Nenhum arquivo anexado ainda.</p>}
          <div className="grid md:grid-cols-3 gap-3">
            {anexos.map((a, i)=> (
              <div key={i} className="border rounded-2xl p-3 flex items-start gap-3">
                {a.type?.includes("image") ? <ImageIcon size={18}/> : <Paperclip size={18}/>}
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm font-medium">{a.name}</div>
                  <div className="text-xs text-slate-500">{(a.size/1024).toFixed(0)} KB</div>
                  {a.type?.includes("image") && (
                    <img src={a.url} alt="preview" className="mt-2 rounded-lg max-h-40 object-contain w-full"/>
                  )}
                </div>
                <button className="p-2 rounded-xl hover:bg-red-50 text-red-600" onClick={()=>removeAnexo(i)} title="Remover"><Trash2 size={18}/></button>
              </div>
            ))}
          </div>
          <label className="mt-3 inline-flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={enviarAnexos} onChange={(e)=>setEnviarAnexos(e.target.checked)} />
            Enviar anexos junto com o recibo
          </label>
        </section>

        {/* Configuração de e-mail */}
        <section className="bg-white rounded-2xl shadow p-4 mb-6">
          <h2 className="font-semibold text-lg mb-3">Envio por e-mail</h2>
          <div className="grid md:grid-cols-2 gap-3">
            <Input label="Destinatários (vírgula)" value={mail.to} onChange={v=>setMail({...mail,to:v})}/>
            <Input label="CC (opcional)" value={mail.cc} onChange={v=>setMail({...mail,cc:v})}/>
          </div>
          <div className="grid gap-3 mt-3">
            <Input label="Assunto" value={mail.subject} onChange={v=>setMail({...mail,subject:v})} />
            <label className="text-sm">
              <div className="mb-1 text-slate-600">Mensagem</div>
              <textarea className="input h-24" value={mail.message} onChange={(e)=>setMail({...mail, message:e.target.value})} />
            </label>
          </div>
        </section>

        {/* RECIBO – VISUAL QUE VAI PARA O PDF */}
        <section ref={printRef} className="bg-white rounded-2xl shadow p-6">
          <header className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-xl font-bold">RECIBO DE REEMBOLSO</h2>
              <div className="text-sm text-slate-500">Gerado automaticamente</div>
            </div>
            <div className="text-right text-sm">
              <div><span className="font-semibold">Local:</span> {datas.local}</div>
              <div><span className="font-semibold">Data:</span> {new Date(datas.emissao).toLocaleDateString("pt-BR")}</div>
              <div><span className="font-semibold">Vencimento:</span> {new Date(datas.vencimento).toLocaleDateString("pt-BR")}</div>
            </div>
          </header>

          <div className="rounded-2xl p-3 mb-3 border">
            <div className="grid md:grid-cols-3 gap-3 text-sm">
              <div className="md:col-span-2">
                <div className="font-semibold mb-1">Recebi(emos) de</div>
                <div className="leading-tight"><span className="font-semibold">Empresa: </span>{empresa.nome}</div>
                <div className="leading-tight"><span className="font-semibold">CNPJ: </span>{empresa.cnpj}</div>
                <div className="leading-tight"><span className="font-semibold">Endereço: </span>{empresa.endereco}</div>
              </div>
              <div>
                <div className="font-semibold mb-1">Colaborador</div>
                <div className="leading-tight">{colab.nome}</div>
                <div className="leading-tight text-xs text-slate-600">{colab.banco} • Ag. {colab.agencia} • Cc {colab.conta} ({colab.tipoConta})</div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl p-3 mb-3 text-sm border">
            <div className="mb-1 font-semibold">A importância de</div>
            <div className="text-lg font-bold">{formatBRL(total)}</div>
            <div className="text-xs text-slate-600">({totalExtenso})</div>
          </div>

          <table className="w-full text-sm border rounded-2xl overflow-hidden">
            <thead className="bg-slate-100">
              <tr>
                <th className="text-left p-2 border">Data</th>
                <th className="text-left p-2 border">Descrição</th>
                <th className="text-left p-2 border">Centro de Custo</th>
                <th className="text-right p-2 border">Valor</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((it,idx)=> (
                <tr key={idx}>
                  <td className="p-2 border">{new Date(it.data).toLocaleDateString("pt-BR")}</td>
                  <td className="p-2 border">{it.descricao}</td>
                  <td className="p-2 border">{it.centro}</td>
                  <td className="p-2 border text-right">{formatBRL(it.valor)}</td>
                </tr>
              ))}
              <tr>
                <td className="p-2 border text-right font-semibold" colSpan={3}>Total Reembolso</td>
                <td className="p-2 border text-right font-bold">{formatBRL(total)}</td>
              </tr>
            </tbody>
          </table>

          <div className="grid md:grid-cols-2 gap-6 mt-8">
            <div>
              <div className="h-16 border-b"/>
              <div className="text-center text-sm mt-1">Assinatura do Colaborador</div>
            </div>
            <div>
              <div className="h-16 border-b"/>
              <div className="text-center text-sm mt-1">Assinatura do Gestor Responsável</div>
            </div>
          </div>
        </section>
      </div>

      {/* util: classe input */}
      <style>{`.input{width:100%;border-radius:0.75rem;border:1px solid #cbd5e1;background:#fff;padding:0.5rem 0.75rem;font-size:0.875rem;box-shadow:0 1px 2px rgba(0,0,0,0.03)}.input:focus{outline:none;box-shadow:0 0 0 2px rgba(99,102,241,0.25)}`}</style>
    </div>
  );
}

function Input({label, value, onChange, type="text"}){
  return (
    <label className="text-sm">
      <div className="mb-1 text-slate-600">{label}</div>
      <input type={type} className="input" value={value} onChange={(e)=>onChange(e.target.value)} />
    </label>
  );
}
