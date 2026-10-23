/* Drafts stay separate from issued ledgers. No API keys are captured. */
(() => {
  'use strict';
  const key='311banchi_document_drafts_v1';
  const ids=['docNumber','docDate','deadline','customerCompany','customerDept','customerPerson','customerZip','customerAddress','customerBuilding','customerInvoiceNo','subject','cargo','notes'];
  const clone=v=>JSON.parse(JSON.stringify(v));
  let ready=false,paused=false,pendingRestore=false,timer,lastSaved='',failure='';
  const node=id=>document.getElementById(id);
  const current=()=>({type:docType,fields:Object.fromEntries(ids.map(id=>[id,node(id).value])),routes:clone(routes),items:clone(items),extraBanks:clone(extraBanks),autoInvoiceDeadline});
  const read=()=>{const raw=localStorage.getItem(key);if(!raw)return {version:1,drafts:{}};const d=JSON.parse(raw);if(d.version!==1||!d.drafts||typeof d.drafts!=='object')throw Error('下書きの形式が正しくありません。元データは上書きしていません。');return d;};
  function ledgerState(){
    const state=current(),f=state.fields,type=state.type;
    const matches=(type==='quote'?getQuoteLedger():getInvoiceLedger()).filter(row=>(type==='quote'?row.quoteNumber:row.invoiceNumber)===f.docNumber.trim());
    if(!matches.length)return ['台帳未登録（下書きだけではPDF・台帳への保存は完了しません）',false];
    if(matches.length>1)return ['番号重複：台帳を確認してください',false];
    const row=matches[0],map={customer:'customerCompany',subject:'subject',deadline:'deadline',dept:'customerDept',person:'customerPerson',zip:'customerZip',address:'customerAddress',building:'customerBuilding',invoiceNo:'customerInvoiceNo',cargo:'cargo',notes:'notes'};
    const same=Object.entries(map).every(([a,b])=>String(row[a]??'')===String(f[b]??'')) && (type==='quote'?row.quoteDate:row.invoiceDate)===f.docDate && JSON.stringify(row.items||[])===JSON.stringify(state.items) && JSON.stringify(row.routes||[])===JSON.stringify(state.routes) && JSON.stringify(row.extraBanks||[])===JSON.stringify(state.extraBanks);
    if(!same)return ['登録後に変更あり／番号重複の可能性（現在の内容は台帳未保存）',false];
    return ['台帳登録済み：'+(row.documentUpdatedAt?new Date(row.documentUpdatedAt).toLocaleString('ja-JP'):'保存日時不明')+(row.pdfRevision===row.documentRevision&&row.pdfRevision?' ／ 保存先PDF確認済み':' ／ 保存先PDFは未確認'),true];
  }
  function display(){if(!ready)return;const [text,ok]=ledgerState();node('banchiLedgerState').textContent='現在の書類 '+node('docNumber').value+'：'+text;node('banchiLedgerState').style.color=ok?'#166534':'#9a3412';node('banchiDraftState').textContent=failure?'下書き保存失敗：'+failure:pendingRestore?'保存済みの下書きがあります。「下書きを戻す」で再開できます。':lastSaved?'下書き自動保存済み：'+new Date(lastSaved).toLocaleString('ja-JP')+'（このブラウザ／バックアップ対象）':'入力内容を下書きとして自動保存します。';node('banchiDraftState').style.color=failure?'#b91c1c':'#334155';}
  function save(){
    if(!ready||paused||pendingRestore)return;
    try{const state=current(),data=read();state.savedAt=new Date().toISOString();data.drafts[state.type]=state;data.activeType=state.type;const raw=JSON.stringify(data);localStorage.setItem(key,raw);if(localStorage.getItem(key)!==raw)throw Error('保存後の内容を確認できませんでした。');lastSaved=state.savedAt;failure='';window.queueBanchiBackup?.();}
    catch(error){failure=error.message;}
    display();
  }
  window.banchiDraftChanged=()=>{if(!ready||paused)return;display();clearTimeout(timer);timer=setTimeout(save,350);};
  window.banchiDraftExport=()=>read();
  window.banchiDraftImport=data=>{if(!data)return;if(data.version!==1||!data.drafts||typeof data.drafts!=='object')throw Error('下書きの形式が正しくありません。');const raw=JSON.stringify(data);localStorage.setItem(key,raw);if(localStorage.getItem(key)!==raw)throw Error('下書きの復元確認に失敗しました。');pendingRestore=Object.keys(data.drafts).length>0;display();};
  function apply(state){
    if(!['quote','invoice'].includes(state.type)||!state.fields||!Array.isArray(state.items)||!Array.isArray(state.routes)||!Array.isArray(state.extraBanks))throw Error('下書きの内容を読み込めません。');
    paused=true;try{setDocType(state.type);for(const id of ids)node(id).value=String(state.fields[id]??'');routes=clone(state.routes);items=clone(state.items);extraBanks=clone(state.extraBanks);autoInvoiceDeadline=!!state.autoInvoiceDeadline;renderRoutes();renderItems();renderExtraBanks();updatePreview();pendingRestore=false;lastSaved=state.savedAt;failure='';}finally{paused=false;}
  }
  window.banchiFlushDraft=save;
  window.banchiRestoreDraft=()=>{
    try{const data=read(),state=data.drafts[data.activeType]||data.drafts[docType];if(!state){alert('保存済みの下書きがありません。');return;}
      if(!['quote','invoice'].includes(state.type)||!state.fields||!Array.isArray(state.items)||!Array.isArray(state.routes)||!Array.isArray(state.extraBanks))throw Error('下書きの内容を読み込めません。');
      if(!confirm('保存日時：'+new Date(state.savedAt).toLocaleString('ja-JP')+'\n'+(state.type==='quote'?'見積書':'請求書')+' '+(state.fields.subject||'件名未入力')+'\n現在の入力をこの下書きに戻しますか？'))return;
      apply(state);
    }catch(error){failure=error.message;}finally{paused=false;display();}
  };
  window.banchiStartDraft=()=>{
    if(!confirm('現在の入力を下書きとして保存します。以前の同じ種類の下書きは置き換わります。よろしいですか？'))return;
    pendingRestore=false;save();
  };
  function init(){ready=true;
    const originalSave=window.banchiSaveCurrentDocument;
    window.banchiSaveCurrentDocument=function(...args){const row=originalSave(...args);if(row){try{const data=read();data.lastRegistered={number:row.quoteNumber||row.invoiceNumber,subject:row.subject,savedAt:new Date().toISOString()};localStorage.setItem(key,JSON.stringify(data));node('banchiLastRegistered').textContent='直近の台帳保存：'+data.lastRegistered.number+' ／ '+data.lastRegistered.subject+'（PDFの保存結果は上のPDF欄で確認）';}catch(error){failure=error.message;}display();}return row;};
    try{const data=read();if(data.lastRegistered)node('banchiLastRegistered').textContent='直近の台帳保存：'+data.lastRegistered.number+' ／ '+data.lastRegistered.subject+'（PDFの保存結果は上のPDF欄で確認）';pendingRestore=Object.keys(data.drafts).length>0;const state=data.drafts[data.activeType];if(state)apply(state);}catch(error){failure=error.message;pendingRestore=true;}display();
    document.addEventListener('input',window.banchiDraftChanged);document.addEventListener('change',window.banchiDraftChanged);document.addEventListener('click',()=>{clearTimeout(timer);timer=setTimeout(()=>{if(!pendingRestore)save();else display();},350);});
    setInterval(display,2000);
    window.addEventListener('pagehide',save);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')save();});window.addEventListener('storage',event=>{if(event.key===key){pendingRestore=true;lastSaved='';display();}});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
