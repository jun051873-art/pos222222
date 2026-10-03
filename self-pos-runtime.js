/* Standalone POS: durable local transactions, recoverable drafts and explicit cloud backup. */
(function(root){
'use strict';
const PREFIX='pos222222:', B=root.AetherPosBridge,codec=root.SalonStorageCodec||JSON;
const DATA={services:'salon_services',stylists:'salon_stylists',customers:'salon_customers',transactions:'salon_transactions',inventoryLogs:'salon_inventory_logs',expenses:'salon_expenses',settings:'salon_settings',pendingOrders:'salon_pending_orders'};
const DRAFT=PREFIX+'draft', cache=new Map(), listeners=new Map(),downloadVersions=new WeakMap();
let sequence=Promise.resolve(), revision=0, cloudBusy=false, cloudTimer, cloudState={state:'idle',message:'本機資料保存；雲端尚未檢查'};
const emit=key=>{for(const f of listeners.get(key)||[])f();};
function read(key,fallback){const raw=localStorage.getItem(key);const old=cache.get(key);if(old&&old.raw===raw)return old.value;let value=raw===null?fallback:codec.parse(raw);cache.set(key,{raw,value});return value;}
function publish(keys){for(const key of keys){cache.delete(key);emit(key);}if(keys.some(k=>Object.values(DATA).includes(k))){revision++;root.dispatchEvent(new Event('pos-data-saved'));scheduleCloud();}}
function subscribe(key,fn){if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key).add(fn);return()=>listeners.get(key).delete(fn);}
function all(){return Object.fromEntries(Object.entries(DATA).map(([name,key])=>[name,read(key,name==='settings'?{}:[])]));}
function atomic(after){
 B.recover();const encoded=Object.entries(after).map(([k,v])=>[k,codec.stringify(v)]).filter(([k,v])=>localStorage.getItem(k)!==v);if(!encoded.length)return;
 const changed=encoded.map(([k])=>[k,after[k]]),journalKey=B.PREFIX+'journal',journal=codec.stringify({after:Object.fromEntries(changed)});
 // Reserve enough space for both the journal and every growing value before
 // changing authoritative data. Other apps sharing this origin are untouched.
 const reserveKey=PREFIX+'space-check';const growth=journal.length+journalKey.length+encoded.reduce((n,[k,v])=>n+Math.max(0,v.length-(localStorage.getItem(k)?.length||0)+k.length),0);
 try{localStorage.setItem(reserveKey,' '.repeat(growth));}catch(e){throw Error(e.name==='QuotaExceededError'?'手機／瀏覽器本機儲存空間不足，尚未開始寫入；請先下載本機備份。不要重置或清除網站資料。':e.message);}finally{localStorage.removeItem(reserveKey);}
 // Prepare the complete redo record before any authoritative value changes.
 localStorage.setItem(journalKey,journal);
 try{for(const [key,value]of encoded)localStorage.setItem(key,value);localStorage.removeItem(B.PREFIX+'journal');}
 catch(e){throw Error('儲存未完成，請保留此畫面並重試；系統已保留復原紀錄。');}
 publish(changed.map(([key])=>key));
}
function transaction(build){const run=()=>new Promise(resolve=>setTimeout(resolve,0)).then(()=>{const work=()=>{B.recover();return build(all());};return navigator.locks?navigator.locks.request('salon_transactions-write',work):work();});const result=sequence.then(run);sequence=result.catch(()=>{});return result;}
function set(key,next,expected){return transaction(()=>{const prev=read(key,expected);if(typeof next!=='function'&&JSON.stringify(prev)!==JSON.stringify(expected))throw Error('資料剛在另一個分頁更新，請重新核對再儲存。');atomic({[key]:typeof next==='function'?next(prev):next});});}
const id=()=>crypto.randomUUID();
function money(v){const n=Number(v);if(v===''||v===null||!Number.isFinite(n)||n<0||n>10000000)throw Error('金額必須為 0 至 10,000,000 的有效數字');return Math.round(n*100)/100;}
function dateTime(value){const d=new Date(value);if(!Number.isFinite(d.getTime()))return '';const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(d);return parts.replace(' ','T');}
function day(value){if(/^\d{4}-\d{2}-\d{2}$/.test(value||''))return value;return dateTime(value).slice(0,10);}
function itemAmount(item){return money(item.price)-money(item.discount||0);}
function itemCost(item,amount){const cost=money(item.cost||0);return item.isProduct||item.costMode==='fixed'||(!item.costMode&&cost>100)?cost:amount*cost/100;}
function draftSave(value){localStorage.setItem(DRAFT,codec.stringify(value));}
function draftRead(){return read(DRAFT,null);}
function customerTotals(tx,customers){return customers.map(c=>{const orders=tx.filter(t=>String(t.customerId)===String(c.id));return {...c,visits:orders.length,totalSpend:Math.round(orders.reduce((n,t)=>n+Number(t.total||0),0)*100)/100};});}
async function checkout(input){return transaction(d=>{
 const existing=d.transactions.find(t=>t.id===input.id);if(existing){const lines=items=>JSON.stringify(items.map(i=>[String(i.id),Number(i.price),Number(i.discount||0),String(i.stylistId)]));if(lines(existing.items)!==lines(input.items)||String(existing.customerId||'')!==String(input.customerId||'')||existing.paymentMethod!==input.paymentMethod||dateTime(existing.date)!==dateTime(input.date.length===16?input.date+':00+08:00':input.date))throw Error('此草稿已在另一個分頁完成，內容與目前畫面不同；請先查單，未重複入帳');return existing;}
 if(!input.items.length)throw Error('請先加入服務或商品');if(!input.stylistId)throw Error('請選擇設計師');
 const st=d.stylists.find(s=>String(s.id)===String(input.stylistId));if(!st)throw Error('設計師資料已變更，請重新選擇');
 const settings=d.settings;const items=input.items.map(i=>{const price=money(i.price),discount=money(i.discount||0);money(i.cost||0);if(discount>price)throw Error('折扣不能大於售價');const person=d.stylists.find(s=>String(s.id)===String(i.stylistId));if(!person)throw Error('項目設計師已停用或刪除，請重新選擇');const rate=person.useGlobalCommission?Number(settings.commissionRates?.[i.category]||0):Number(person.commissionRate||0);if(!Number.isFinite(rate)||rate<0||rate>100)throw Error('抽成比例需在0至100之間，請先核對人員或分類設定');return {...i,price,discount,stylistId:person.id,stylistName:person.name,commissionRate:rate,deductCost:!!settings.deductCostBeforeCommission};});
 const needed={};for(const i of items)if(i.isProduct)needed[i.id]=(needed[i.id]||0)+1;
 const services=d.services.map(s=>{if(!needed[s.id])return s;const stock=Number(s.stock);if(!Number.isInteger(stock)||stock<needed[s.id])throw Error(s.name+'庫存不足，請重新核對');delete needed[s.id];return {...s,stock:stock-items.filter(i=>i.isProduct&&String(i.id)===String(s.id)).length};});
 if(Object.keys(needed).length)throw Error('有商品已刪除，請重新核對');
 const customer=input.customerId?d.customers.find(c=>String(c.id)===String(input.customerId)):null;if(input.customerId&&!customer)throw Error('顧客資料已變更，請重新選擇');
 if(!dateTime(input.date))throw Error('請填寫正確日期');
 const order={id:input.id,date:input.date.length===16?input.date+':00+08:00':input.date,createdAt:new Date().toISOString(),items,total:Math.round(items.reduce((n,i)=>n+itemAmount(i),0)*100)/100,paymentMethod:input.paymentMethod,mainStylistId:st.id,customerId:customer?.id||null,customerName:customer?.name||input.customerName||'散客',customerGender:customer?.gender||input.gender||'未填寫'};
 const tx=[order,...d.transactions];const logs=items.filter(i=>i.isProduct).map(i=>({id:id(),date:order.date,type:'銷售',itemId:i.id,itemName:i.name,qty:1,cost:i.cost,note:'訂單 #'+order.id.slice(0,8),operator:st.name}));
 const customers=customer?d.customers.map(c=>c.id===customer.id?{...c,visits:Number(c.visits||0)+1,totalSpend:money(Number(c.totalSpend||0)+order.total)}:c):d.customers;
 atomic({salon_transactions:tx,salon_services:services,salon_customers:customers,salon_inventory_logs:[...logs,...d.inventoryLogs],salon_pending_orders:d.pendingOrders.filter(o=>o.id!==input.pendingId),[DRAFT]:null});return order;
});}
async function savePending(draft,note,pendingId){return transaction(d=>{const existing=d.pendingOrders.find(o=>o.id===pendingId);const p={...draft,id:existing?.id||id(),time:existing?.time||new Date().toISOString(),note,custName:draft.selectedCustomer?.name||draft.adHocCustomerName||'散客'};atomic({salon_pending_orders:[...d.pendingOrders.filter(o=>o.id!==p.id),p],[DRAFT]:null});return p;});}
async function inventory(input){return transaction(d=>{
 const product=d.services.find(s=>s.id===input.id);if(!product)throw Error('商品已變更，請重新核對');const qty=Number(input.qty);if(!Number.isInteger(qty)||qty<=0)throw Error('數量需為大於0的整數');
 let stock=Number(product.stock||0),type,expense=null,cost=Number(product.cost||0),note=input.note||'';
 if(input.action==='restock'){stock+=qty;cost=money(input.cost);type='進貨';note='廠商：'+(input.supplier||'未指定')+'；'+note;}
 else if(input.action==='internal'){stock-=qty;type='領用';if(input.internalUseType==='designer'&&!d.stylists.some(s=>s.id===input.staffId))throw Error('請選擇領用人員');expense={id:id(),date:day(new Date()),type:'自領料(成本)',amount:money(cost*qty),note:product.name+' × '+qty+' '+note,relatedStaffId:input.internalUseType==='designer'?input.staffId:''};}
 else if(input.action==='adjust'){stock+=input.adjustType==='inc'?qty:-qty;type=input.adjustType==='inc'?'盤點+':'盤點-';}else throw Error('不支援的庫存操作');
 if(stock<0)throw Error('庫存不足，未扣除任何數量');
 const log={id:id(),date:new Date().toISOString(),type,itemId:product.id,itemName:product.name,qty,cost,note,operator:input.staffId||'店內'};
 atomic({salon_services:d.services.map(s=>s.id===product.id?{...s,stock,cost}:s),salon_inventory_logs:[log,...d.inventoryLogs],...(expense?{salon_expenses:[...d.expenses,expense]}:{})});
});}
async function reviseOrder(updated,remove=false){return transaction(d=>{const old=d.transactions.find(t=>t.id===updated.id);if(!old)throw Error('找不到原單');if(old.sourceAppointment)throw Error('轉入單請先核對來源再更正');
 if(updated.expectedVersion&&updated.expectedVersion!==JSON.stringify(old))throw Error('這筆單據已在其他分頁修改，請重新開啟原單');
 const items=remove?[]:updated.items.map(i=>{money(i.price);money(i.discount||0);if(itemAmount(i)<0)throw Error('折扣不能超過售價');const person=d.stylists.find(s=>String(s.id)===String(updated.mainStylistId));if(!person)throw Error('請選擇有效設計師');return {...i,stylistId:person.id,stylistName:person.name,commissionRate:old.mainStylistId===updated.mainStylistId?i.commissionRate:(person.useGlobalCommission?Number(d.settings.commissionRates?.[i.category]||0):Number(person.commissionRate||0))};});
 if(!remove&&!items.length)throw Error('訂單至少保留一個項目；取消整單請使用刪除');
 const delta={};for(const i of old.items||[])if(i.isProduct)delta[i.id]=(delta[i.id]||0)+1;for(const i of items)if(i.isProduct)delta[i.id]=(delta[i.id]||0)-1;
 const services=d.services.map(s=>{if(!delta[s.id])return s;const stock=Number(s.stock||0)+delta[s.id];if(stock<0)throw Error(s.name+'庫存不足');return {...s,stock};});
 if(Object.keys(delta).some(k=>delta[k]&&!d.services.some(s=>String(s.id)===k)))throw Error('原單商品已刪除，請先恢復商品再處理庫存');
 const {expectedVersion,...fields}=updated;const order={...fields,mainStylistId:items[0]?.stylistId||updated.mainStylistId,items,total:Math.round(items.reduce((n,i)=>n+itemAmount(i),0)*100)/100};const tx=remove?d.transactions.filter(t=>t.id!==old.id):d.transactions.map(t=>t.id===old.id?order:t);
 const customers=d.customers.map(c=>{let visits=Number(c.visits||0),total=Number(c.totalSpend||0);if(c.id===old.customerId){visits--;total-=Number(old.total||0);}if(!remove&&c.id===order.customerId){visits++;total+=order.total;}return {...c,visits:Math.max(0,visits),totalSpend:Math.max(0,Math.round(total*100)/100)};});
 const logs=Object.entries(delta).filter(([,q])=>q).map(([key,q])=>({id:id(),date:new Date().toISOString(),type:q>0?'退單回補':'訂單更正',itemId:key,itemName:d.services.find(s=>String(s.id)===key)?.name,qty:Math.abs(q),note:'訂單 #'+old.id.slice(0,8),operator:'訂單管理'}));
 atomic({salon_transactions:tx,salon_customers:customers,salon_services:services,salon_inventory_logs:[...logs,...d.inventoryLogs],[PREFIX+'last-order-change']:{before:old,at:new Date().toISOString(),removed:remove}});return order;
});}
function backupPayload(){return {...all(),draft:draftRead(),lastUpdated:new Date().toISOString(),format:'salon-pos-backup-v2'};}
function validateBackup(data){if(!data||!Array.isArray(data.transactions)||!Array.isArray(data.customers)||!Array.isArray(data.services)||!data.settings)throw Error('不是完整的 POS 備份，未覆蓋任何資料');for(const key of ['transactions','customers','services','stylists','expenses','inventoryLogs','pendingOrders'])if(data[key]!==undefined&&!Array.isArray(data[key]))throw Error(key+'資料格式錯誤');for(const c of data.customers)if(!c.id||!(c.name||c.Name||'').trim())throw Error('備份包含不完整顧客資料，請先修復');return data;}
async function restore(data){validateBackup(data);return transaction(()=>{
 // Compact only this POS's existing values, replacing each with equivalent data.
 // This also reclaims oversized snapshots left by a previous failed restore.
 for(const key of [...Object.values(DATA),DRAFT,PREFIX+'before-restore']){const raw=localStorage.getItem(key);if(raw){const packed=codec.stringify(codec.parse(raw));if(packed.length<raw.length)localStorage.setItem(key,packed);}}
 const after={[PREFIX+'before-restore']:backupPayload()};for(const [name,key]of Object.entries(DATA))after[key]=data[name]??(name==='settings'?{}:[]);after[DRAFT]=data.draft||null;
 // Restoring another device's preferences must not enable uploads from this device.
 const downloaded=downloadVersions.get(data);
 after[DATA.settings]={...after[DATA.settings],...(downloaded?.settings||{}),autoCloudBackup:false};
 if(downloaded)after[cloudMetaKey(downloaded.settings)]={at:new Date().toISOString(),updateTime:downloaded.updateTime,confirmed:true};
 atomic(after);
 }).catch(e=>{if(e.name==='QuotaExceededError')throw Error('手機／瀏覽器本機儲存空間不足，還原未完成；請先下載本機備份，不要重置或清除網站資料。');throw e;});}
const cloudSubscribe=f=>subscribe(PREFIX+'cloud',f);
function status(state,message,extra={}){cloudState={state,message,...extra};emit(PREFIX+'cloud');}
function cloudURL(settings){if(!settings.shopID?.trim()||!settings.syncToken?.trim())throw Error('請先設定店號與同步金鑰');return 'https://firestore.googleapis.com/v1/projects/salonpos-system/databases/(default)/documents/SalonPOS/'+encodeURIComponent(settings.shopID.trim())+'/Tokens/'+encodeURIComponent(settings.syncToken.trim());}
function cloudMetaKey(settings){return PREFIX+'cloud:'+settings.shopID.trim()+':'+settings.syncToken.trim();}
function protectCloud(local,remote){
 for(const [key,label]of Object.entries({transactions:'訂單',customers:'顧客',expenses:'支出',inventoryLogs:'庫存紀錄',services:'服務與商品',stylists:'人員'})){
  const here=local[key]||[],there=remote[key]||[];
  if(here.length<there.length)throw Error('防誤覆蓋：本機'+label+' '+here.length+' 筆，少於雲端 '+there.length+' 筆，已停止上傳。請先下載恢復雲端資料');
  const ids=new Set(here.filter(r=>r?.id!==undefined&&r.id!==null).map(r=>String(r.id)));
  if(there.some(r=>r?.id!==undefined&&r.id!==null&&!ids.has(String(r.id))))throw Error('防誤覆蓋：本機缺少雲端原有的'+label+'，即使總筆數較多也不能覆蓋。請先下載恢復雲端資料');
 }
}
async function responseJSON(r){let data;try{data=await r.json();}catch{throw Error('雲端回應格式異常');}if(!r.ok)throw Error(r.status===403?'雲端權限拒絕存取，請檢查 Firebase 規則':data.error?.message||'雲端連線失敗 ('+r.status+')');return data;}
const CLOUD_LIMIT=900000,MAX_BACKUP_BYTES=32*1024*1024;
async function digest(bytes){if(!root.crypto?.subtle)throw Error('此瀏覽器無法驗證壓縮備份，請使用更新的瀏覽器；本機資料未變更');return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
function toBase64(bytes){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
async function unpackCloud(content){
 const envelope=JSON.parse(content);if(envelope?.format!=='salon-pos-gzip-v1')return validateBackup(envelope);
 if(!Number.isSafeInteger(envelope.rawBytes)||envelope.rawBytes<1||envelope.rawBytes>MAX_BACKUP_BYTES||typeof envelope.data!=='string'||!/^[a-f0-9]{64}$/.test(envelope.sha256||''))throw Error('壓縮備份格式異常，未還原任何資料');
 if(!root.fflate)throw Error('備份解壓縮元件未載入，請重新整理');
 let bytes;try{const zipped=Uint8Array.from(atob(envelope.data),c=>c.charCodeAt(0));await new Promise(r=>setTimeout(r,0));bytes=root.fflate.gunzipSync(zipped,{out:new Uint8Array(envelope.rawBytes)});}catch{throw Error('雲端備份解壓縮失敗，未還原任何資料');}
 if(bytes.length!==envelope.rawBytes||await digest(bytes)!==envelope.sha256)throw Error('雲端備份完整性檢查失敗，未還原任何資料');
 return validateBackup(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
}
async function packCloud(payload){
 const text=JSON.stringify(payload),bytes=new TextEncoder().encode(text);if(bytes.length<=CLOUD_LIMIT)return {content:text,rawBytes:bytes.length,storedBytes:bytes.length};
 if(bytes.length>MAX_BACKUP_BYTES)throw Error('備份超過目前可處理大小，請先下載本機備份並聯絡管理者調整雲端儲存');
 if(!root.fflate)throw Error('備份壓縮元件未載入，請重新整理後再試');
 status('saving','資料較多，正在壓縮備份；本機可繼續開單');
 let zipped;if(root.CompressionStream){const stream=new Blob([bytes]).stream().pipeThrough(new root.CompressionStream('gzip'));zipped=new Uint8Array(await new Response(stream).arrayBuffer());}else{await new Promise(r=>setTimeout(r,0));zipped=root.fflate.gzipSync(bytes);}
 const content=JSON.stringify({format:'salon-pos-gzip-v1',rawBytes:bytes.length,sha256:await digest(bytes),data:toBase64(zipped)}),storedBytes=new TextEncoder().encode(content).length;
 if(storedBytes>CLOUD_LIMIT)throw Error('壓縮後仍有 '+Math.ceil(storedBytes/1024)+' KB，超過目前單筆備份安全容量（879 KB）；請先下載本機備份，再調整雲端儲存方式。這不是帳號總容量已滿');
 if(JSON.stringify(await unpackCloud(content))!==text)throw Error('備份壓縮驗證失敗，未上傳雲端');
 return {content,rawBytes:bytes.length,storedBytes};
}
async function cloudBackup(settings,manual=false){if(cloudBusy)throw Error('雲端備份處理中，請稍候');clearTimeout(cloudTimer);const startRevision=revision;cloudBusy=true;status('saving','雲端備份中，本機可繼續開單');try{
 const url=cloudURL(settings),metaKey=cloudMetaKey(settings);const meta=read(metaKey,{});
 if(!manual&&(!meta.updateTime||meta.confirmed===false))throw Error('請先手動完成一次雲端備份，再開啟自動備份');
 const r=await fetch(url);let current=null;if(r.status!==404)current=await responseJSON(r);
 if(current&&meta.updateTime&&current.updateTime!==meta.updateTime)throw Error('雲端已被其他裝置更新，請先核對，未覆蓋備份');
 if(!manual&&current&&!meta.updateTime)throw Error('請先核對既有雲端資料');
 const payload=backupPayload();payload.settings={...payload.settings,...settings};if(current)protectCloud(payload,await unpackCloud(current.fields?.content?.stringValue));const {content,rawBytes,storedBytes}=await packCloud(payload);
 const precondition=current?'&currentDocument.updateTime='+encodeURIComponent(current.updateTime):'&currentDocument.exists=false';
 const saved=await responseJSON(await fetch(url+'?updateMask.fieldPaths=content'+precondition,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:{content:{stringValue:content}}})}));
 if(saved.fields?.content?.stringValue!==content)throw Error('雲端回傳內容不符，尚未確認備份成功');
 // Keep the write receipt if the verification GET fails, so a manual retry can
 // safely compare against our own write without disabling conflict detection.
 if(!saved.updateTime)throw Error('雲端未提供備份版本，尚未確認成功');
 localStorage.setItem(metaKey,JSON.stringify({updateTime:saved.updateTime,confirmed:false}));
 const checked=await responseJSON(await fetch(url,{cache:'no-store'}));if(checked.updateTime!==saved.updateTime||checked.fields?.content?.stringValue!==content)throw Error('上傳後的雲端讀回核對不符，請核對其他裝置，尚未確認備份成功');await unpackCloud(checked.fields.content.stringValue);
 const at=new Date().toISOString();localStorage.setItem(metaKey,JSON.stringify({at,updateTime:saved.updateTime}));const sizeInfo=rawBytes>storedBytes?'（'+Math.ceil(rawBytes/1024)+' → '+Math.ceil(storedBytes/1024)+' KB）':'';status('saved','雲端備份成功'+sizeInfo+' · '+dateTime(at).replace('T',' '),{at,rawBytes,storedBytes});return saved;
 }catch(e){status('error',e.message);throw e;}finally{cloudBusy=false;if(revision!==startRevision&&read(DATA.settings,{}).autoCloudBackup)scheduleCloud();}}
async function cloudDownload(settings){const document=await responseJSON(await fetch(cloudURL(settings),{cache:'no-store'}));const data=await unpackCloud(document.fields?.content?.stringValue);if(!document.updateTime)throw Error('雲端未提供版本，請稍後再試');downloadVersions.set(data,{settings:{shopID:settings.shopID.trim(),syncToken:settings.syncToken.trim()},updateTime:document.updateTime});return data;}
function scheduleCloud(){clearTimeout(cloudTimer);const settings=read(DATA.settings,{});if(!settings.autoCloudBackup){status('pending','資料已存本機；雲端需手動備份');return;}status('pending','資料已存本機，等待背景備份');cloudTimer=setTimeout(()=>cloudBackup(read(DATA.settings,{})).catch(()=>{}),4000);}
root.addEventListener?.('storage',e=>{if(e.key){cache.delete(e.key);emit(e.key);}else for(const key of listeners.keys()){cache.delete(key);emit(key);}});
root.addEventListener?.('salon-local-update',e=>{cache.delete(e.key);emit(e.key);});
root.addEventListener?.('online',()=>{if(read(DATA.settings,{}).autoCloudBackup)scheduleCloud();});
Object.assign(root,{SalonStore:{DATA,DRAFT,PREFIX,read,subscribe,set,all,atomic,transaction,checkout,savePending,inventory,reviseOrder,money,day,dateTime,itemCost,draftSave,draftRead,backupPayload,validateBackup,restore,cloudBackup,cloudDownload,cloudSubscribe,cloudSnapshot:()=>cloudState}});
})(window);
