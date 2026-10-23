(() => {
  'use strict';
  let work=Promise.resolve(), warned=false;
  const pending=new Set();
  let pdfWork=Promise.resolve();
  const pdfJobs=new Map();
  const clone=value=>JSON.parse(JSON.stringify(value));
  const identity=(type,row)=>type==='invoice'?row.invoiceNumber:row.quoteNumber;
  const ledger=type=>type==='invoice'?getInvoiceLedger():getQuoteLedger();
  const persist=(type,rows)=>type==='invoice'?saveInvoiceLedger(rows):saveQuoteLedger(rows);
  const cleanName=value=>String(value||'案件名なし').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,90);
  function status(error){
    const node=document.getElementById('banchiPdfStatus');if(!node)return;
    const rows=[...getInvoiceLedger(),...getQuoteLedger()].filter(row=>row.documentHtml);
    const ready=rows.filter(row=>row.pdfRevision===row.documentRevision).length;
    node.textContent=error?'【PDF保存未完了】'+error:'明細・PDF保存：'+ready+' / '+rows.length+'件確認済み（この機能で保存した書類）';
    node.style.color=error||ready<rows.length?'#b91c1c':'#166534';
    if(error&&!warned){warned=true;alert('PDFはまだGoogle Driveに保存できていません：'+error);}
  }
  window.banchiSnapshotFields=()=>{
    updatePreview();
    const value=id=>document.getElementById(id).value;
    return {detailVersion:1,documentRevision:crypto.randomUUID(),documentUpdatedAt:new Date().toISOString(),
      dept:value('customerDept'),person:value('customerPerson'),zip:value('customerZip'),address:value('customerAddress'),building:value('customerBuilding'),invoiceNo:value('customerInvoiceNo'),cargo:value('cargo'),notes:value('notes'),
      routes:clone(routes),items:clone(items),extraBanks:clone(extraBanks),
      documentHtml:document.getElementById('documentPreview').innerHTML,
      documentStyles:[...document.querySelectorAll('style')].map(node=>node.textContent).join('\n')};
  };
  function safeMarkup(html){
    const template=document.createElement('template');template.innerHTML=html;
    template.content.querySelectorAll('script,iframe,object,embed,link,meta,base,form,input,button,textarea,select,img,video,audio').forEach(node=>node.remove());
    template.content.querySelectorAll('*').forEach(node=>{for(const attribute of [...node.attributes])if(/^on/i.test(attribute.name)||['src','href','srcdoc','action','formaction'].includes(attribute.name))node.removeAttribute(attribute.name);else if(attribute.name==='style'&&/url\s*\(|expression\s*\(/i.test(attribute.value))node.removeAttribute('style');});
    return template.innerHTML;
  }
  async function buildPdf(row){
    if(!row.documentHtml||!Array.isArray(row.items)||!row.items.length)throw Error('明細が保存されていない書類のPDFは作成できません。');
    if(typeof html2pdf!=='function')throw Error('PDF生成ライブラリを読み込めませんでした。再読み込みして再試行してください。');
    const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-same-origin');
    frame.style.cssText='position:fixed;left:-20000px;top:0;width:1200px;height:1600px;border:0;';document.body.append(frame);
    try{
      const target=frame.contentDocument;
      const style=target.createElement('style');style.textContent=String(row.documentStyles||'').replace(/@import[^;]+;/gi,'').replace(/url\s*\([^)]*\)/gi,'none')+'\nhtml,body{margin:0;padding:0;background:white;width:297mm;}#printArea{width:297mm;height:auto!important;min-height:209mm;overflow:visible!important;box-shadow:none;margin:0;padding:10mm 15mm;box-sizing:border-box;}tr{break-inside:avoid;}';target.head.append(style);
      const page=target.createElement('div');page.id='printArea';page.className='document';page.style.cssText='width:297mm;height:auto;min-height:209mm;overflow:visible;box-shadow:none;margin:0;padding:10mm 15mm;box-sizing:border-box;';page.innerHTML=safeMarkup(row.documentHtml);target.body.append(page);
      await target.fonts.ready;
      const blob=await html2pdf().set({margin:0,image:{type:'jpeg',quality:0.97},html2canvas:{scale:2,backgroundColor:'#ffffff',logging:false},jsPDF:{unit:'mm',format:'a4',orientation:'landscape',compress:true},pagebreak:{mode:['css','legacy'],avoid:['tr','.bottom-grid','.doc-footer']}}).from(page).outputPdf('blob');
      if(blob.size<1000||(await blob.slice(0,5).text())!=='%PDF-')throw Error('作成したPDFを確認できませんでした。');
      return blob;
    }finally{frame.remove();}
  }
  function pdf(row){
    const key=row.documentRevision;
    if(pdfJobs.has(key))return pdfJobs.get(key);
    const job=pdfWork.catch(()=>{}).then(()=>buildPdf(row));pdfWork=job;
    pdfJobs.set(key,job);job.then(()=>pdfJobs.delete(key),()=>pdfJobs.delete(key));return job;
  }
  async function binaryWrite(directory,name,blob){
    const handle=await directory.getFileHandle(name,{create:true});const writable=await handle.createWritable();await writable.write(blob);await writable.close();
    const source=new Uint8Array(await blob.arrayBuffer()),saved=new Uint8Array(await (await handle.getFile()).arrayBuffer());
    if(source.length!==saved.length||source.some((byte,index)=>byte!==saved[index]))throw Error('PDF保存後の内容が一致しません。');
  }
  window.banchiQueueDocument=(type,input)=>{
    const row=clone(input), key=type+':'+identity(type,row)+':'+row.documentRevision;
    if(!row.documentHtml||pending.has(key))return work;
    pending.add(key);status();
    work=work.catch(()=>{}).then(async()=>{
      try{
        const directory=await window.banchiGetBackupDirectory();
        const root=await directory.getDirectoryHandle('PDF',{create:true});
        const folder=await root.getDirectoryHandle(type==='invoice'?'請求書':'見積書',{create:true});
        const name=cleanName(row.subject)+'_'+cleanName(identity(type,row))+'_'+row.documentRevision+'.pdf';
        const blob=await pdf(row);await binaryWrite(folder,name,blob);
        // Record success only for the exact revision whose bytes were saved.
        const rows=ledger(type),index=rows.findIndex(value=>identity(type,value)===identity(type,row));
        if(index>=0&&rows[index].documentRevision===row.documentRevision){rows[index].pdfRevision=row.documentRevision;rows[index].pdfFile=name;rows[index].pdfSavedAt=new Date().toISOString();persist(type,rows);if(type==='invoice')showInvoiceLedger();else showQuoteLedger();}
        warned=false;status();
      }catch(error){status(error.message);}finally{pending.delete(key);}
    });
    return work;
  };
  window.banchiRetryDocuments=()=>{
    for(const type of ['invoice','quote'])for(const row of ledger(type))if(row.documentHtml&&row.pdfRevision!==row.documentRevision)window.banchiQueueDocument(type,row);
    status();
  };
  window.banchiSaveCurrentDocument=()=>{
    const type=docType;if(!['invoice','quote'].includes(type))return;
    const value=id=>document.getElementById(id).value.trim();
    const number=value('docNumber'),date=value('docDate');
    if(!number||!date||!value('customerCompany')||!value('subject')){status('書類番号・日付・取引先・件名を入力してください。');return;}
    const rows=ledger(type),index=rows.findIndex(row=>identity(type,row)===number),old=index<0?{}:rows[index];
    const row={...old,...window.banchiSnapshotFields(),customer:value('customerCompany'),subject:value('subject'),deadline:value('deadline'),amount:getTotals().total};
    if(type==='invoice'){row.invoiceNumber=number;row.invoiceDate=date;row.freeeStatus=old.freeeStatus||'未登録';row.paymentStatus=old.paymentStatus||'未入金';}
    else{row.quoteNumber=number;row.quoteDate=date;row.status=old.status||'検討中';}
    if(index<0)rows.unshift(row);else rows[index]=row;persist(type,rows);showInvoiceLedger();showQuoteLedger();window.banchiQueueDocument(type,row);return row;
  };
  window.banchiOpenPdf=async(type,index)=>{
    const row=ledger(type)[index];if(!row?.pdfFile){alert('この書類のPDFはまだ保存されていません。');return;}
    const popup=window.open('about:blank','_blank');
    try{const directory=await window.banchiGetBackupDirectory();const root=await directory.getDirectoryHandle('PDF');const folder=await root.getDirectoryHandle(type==='invoice'?'請求書':'見積書');const file=await (await folder.getFileHandle(row.pdfFile)).getFile();const url=URL.createObjectURL(file);if(popup)popup.location=url;else{const link=document.createElement('a');link.href=url;link.download=row.pdfFile;link.click();}setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(error){popup?.close();status(error.message);}
  };
  window.banchiLoadInvoice=index=>{
    const row=getInvoiceLedger()[index];if(!row?.documentHtml||!Array.isArray(row.items)){alert('この過去の請求書には明細データがありません。');return;}
    setDocType('invoice');
    for(const [id,key] of Object.entries({customerCompany:'customer',customerDept:'dept',customerPerson:'person',customerZip:'zip',customerAddress:'address',customerBuilding:'building',customerInvoiceNo:'invoiceNo',subject:'subject',cargo:'cargo',notes:'notes',docNumber:'invoiceNumber',docDate:'invoiceDate',deadline:'deadline'}))document.getElementById(id).value=row[key]||'';
    routes=clone(row.routes||[]);items=clone(row.items);extraBanks=clone(row.extraBanks||[]);autoInvoiceDeadline=false;renderRoutes();renderItems();renderExtraBanks();updatePreview();window.scrollTo({top:0,behavior:'smooth'});
  };
  window.banchiDownloadCurrentPdf=async()=>{try{const row=window.banchiSaveCurrentDocument();if(!row)throw Error('必要な入力を確認してください。');const blob=await pdf(row);const link=document.createElement('a');const url=URL.createObjectURL(blob);link.href=url;link.download=cleanName(row.subject)+'_'+cleanName(identity(docType,row))+'.pdf';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(error){status(error.message);}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{status();window.banchiRetryDocuments();},{once:true});else{status();window.banchiRetryDocuments();}
})();
