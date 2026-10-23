/* 311BANCHI public app: no credentials or ledger data are sent to GitHub. */
(() => {
  'use strict';
  const folderName='311BANCHI_自動バックアップ';
  const pattern=/^311BANCHI_(?:自動バックアップ|会計バックアップ)_\d{8}\.json$/;
  let directory=null, timer=null, chain=Promise.resolve(), warned=false;
  const message=(text,failed=false)=>{
    const node=document.getElementById('banchiBackupStatus');
    if(node){node.textContent=text;node.style.color=failed?'#b91c1c':'#166534';}
    if(failed&&!warned){warned=true;alert('バックアップ未完了：'+text);}
  };
  function db(){return new Promise((resolve,reject)=>{
    const request=indexedDB.open('311banchi-public-cloud-backup',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('settings');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });}
  async function remember(handle){const connection=await db();try{await new Promise((resolve,reject)=>{
    const transaction=connection.transaction('settings','readwrite');transaction.objectStore('settings').put(handle,'directory');
    transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error||Error('保存先の記憶に失敗しました。'));
  });}finally{connection.close();}}
  async function recall(){const connection=await db();try{return await new Promise((resolve,reject)=>{
    const request=connection.transaction('settings','readonly').objectStore('settings').get('directory');
    request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);
  });}finally{connection.close();}}
  function data(){return {version:'2.1',exportDate:new Date().toISOString(),
    quoteNumber:localStorage.getItem('311banchi_quote_number')||initialLastNumbers.quote,
    invoiceNumber:localStorage.getItem('311banchi_invoice_number')||initialLastNumbers.invoice,
    drafts:window.banchiDraftExport?.(),ledger:getInvoiceLedger(),quoteLedger:getQuoteLedger(),clientMaster:getClientMaster()};}
  const empty=value=>['ledger','quoteLedger','clientMaster'].every(key=>Array.isArray(value[key])&&!value[key].length); // Empty ledgers never overwrite an existing recovery backup, even with drafts.
  function validate(value){
    if(!['ledger','quoteLedger','clientMaster'].every(key=>Array.isArray(value[key]))||!Number.isFinite(Date.parse(value.exportDate)))throw Error('バックアップの内容または保存日時が正しくありません。復元・上書きはしていません。');
    return value;
  }
  async function latest(handle){
    const candidates=[];
    for await(const [name,entry] of handle.entries()){
      if(entry.kind==='file'&&pattern.test(name)){
        const file=await entry.getFile();const value=validate(JSON.parse((await file.text()).replace(/^\uFEFF/,'')));
        candidates.push({file,value,time:Date.parse(value.exportDate)});
      }
    }
    candidates.sort((a,b)=>b.time-a.time||b.file.lastModified-a.file.lastModified);
    return candidates[0]||null;
  }
  async function write(handle,name,text){const file=await handle.getFileHandle(name,{create:true});const writable=await file.createWritable();await writable.write(text);await writable.close();if(await (await file.getFile()).text()!==text)throw Error('保存した内容を確認できませんでした。');}
  function save(){
    chain=chain.catch(()=>{}).then(async()=>{
      try{
        if(!directory){message('未設定：上の「Google Drive保存先を設定」を押してください。');return;}
        if(await directory.queryPermission({mode:'readwrite'})!=='granted')throw Error('保存許可が必要です。「Google Drive保存先を設定」を押してください。');
        const value=validate(data());
        if(empty(value)){message('台帳が空のため、復元用のバックアップを上書きしていません。');return;}
        const now=new Date();const key=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now).replaceAll('-','');
        const name='311BANCHI_自動バックアップ_'+key+'.json';
        // Preserve the previous valid daily contents before replacement.
        try{const old=await directory.getFileHandle(name);const text=await (await old.getFile()).text();validate(JSON.parse(text.replace(/^\uFEFF/,'')));await write(directory,'311BANCHI_上書き前.json',text);}catch(error){if(error.name!=='NotFoundError')throw error;}
        await write(directory,name,JSON.stringify(value,null,2));
        warned=false;
        message('台帳JSON 保存・内容確認済み：'+now.toLocaleString('ja-JP')+' ／ '+directory.name+'（PDFは別欄で確認／クラウド同期完了はDriveで確認）');
        window.banchiRetryDocuments?.();
      }catch(error){message(error.message,true);}
    });
    return chain;
  }
  window.queueBanchiBackup=()=>{clearTimeout(timer);timer=setTimeout(save,2000);};
  window.banchiGetBackupDirectory=async()=>{
    directory=directory||await recall();
    if(!directory)throw Error('Google Driveの保存先が未設定です。上の設定ボタンを押してください。');
    if(await directory.queryPermission({mode:'readwrite'})!=='granted')throw Error('Google Driveへの保存許可が必要です。上の設定ボタンを押してください。');
    return directory;
  };
  window.banchiSetupBackup=async()=>{
    try{
      if(!window.showDirectoryPicker)throw Error('ChromeまたはEdgeで開いてください。');
      const saved=directory||await recall();
      if(saved&&await saved.requestPermission({mode:'readwrite'})==='granted')directory=saved;
      else{
        const selected=await window.showDirectoryPicker({id:'311banchi-public-drive',mode:'readwrite'});
        directory=selected.name===folderName?selected:await selected.getDirectoryHandle(folderName,{create:true});
        if(await directory.requestPermission({mode:'readwrite'})!=='granted')throw Error('保存が許可されませんでした。');
        await remember(directory);
      }
      await save();
      window.banchiRetryDocuments?.();
    }catch(error){if(error.name!=='AbortError')message(error.message,true);}
  };
  window.banchiRestoreLatest=async()=>{
    try{
      directory=directory||await recall();if(!directory)throw Error('先にGoogle Driveの保存先を設定してください。空の台帳で既存バックアップを上書きすることはありません。');
      if(await directory.requestPermission({mode:'readwrite'})!=='granted')throw Error('バックアップの読取許可がありません。');
      await chain;
      const entry=await latest(directory);if(!entry)throw Error('バックアップファイルが見つかりません。');
      importBackupJSON({target:{files:[entry.file],value:''}});
    }catch(error){message(error.message,true);}
  };
  async function init(){
    try{
      directory=await recall();
      if(!directory){message('未設定：上の「Google Drive保存先を設定」を押してください。');return;}
      await save();
    }catch(error){message('保存先を確認できません：'+error.message,true);}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
  setInterval(save,15*60*1000);
})();
