/* Standalone POS: durable local transactions, recoverable drafts and explicit cloud backup. */
(function(root){
'use strict';
const PREFIX='pos222222:', B=root.AetherPosBridge,codec=root.SalonStorageCodec||JSON;
const DATA={services:'salon_services',stylists:'salon_stylists',customers:'salon_customers',transactions:'salon_transactions',inventoryLogs:'salon_inventory_logs',expenses:'salon_expenses',settings:'salon_settings',pendingOrders:'salon_pending_orders',walletEntries:'salon_wallet_entries',businessEvents:'salon_business_events'};
const DRAFT=PREFIX+'draft', cache=new Map(), listeners=new Map(),downloadVersions=new WeakMap();
let sequence=Promise.resolve(), revision=0, cloudBusy=false, syncBusy=false, syncApplying=false, cloudTimer, cloudState={state:'idle',message:'本機資料保存；雲端尚未檢查'};
const emit=key=>{for(const f of listeners.get(key)||[])f();};
function read(key,fallback){const raw=localStorage.getItem(key);const old=cache.get(key);if(old&&old.raw===raw)return old.value;let value=raw===null?fallback:codec.parse(raw);cache.set(key,{raw,value});return value;}
function publish(keys){for(const key of keys){cache.delete(key);emit(key);}if(keys.some(k=>Object.values(DATA).includes(k))){revision++;root.dispatchEvent(new Event('pos-data-saved'));if(!syncApplying)scheduleCloud();}}
function subscribe(key,fn){if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key).add(fn);return()=>listeners.get(key).delete(fn);}
function customerRecord(c){return {...c,name:c.name||c.Name||'',phone:c.phone||c.Phone||'',visits:Number(c.visits??c.Visits??0),totalSpend:Number(c.totalSpend??c.TotalSpend??0)};}
function all(){return Object.fromEntries(Object.entries(DATA).map(([name,key])=>{const value=read(key,name==='settings'?{}:[]);return [name,name==='settings'?(value&&typeof value==='object'&&!Array.isArray(value)?value:{}):(Array.isArray(value)?value:[])];}));}
function atomic(after){
 B.recover();if(!syncApplying)accessCheckWrite(all(),after);if(after[DATA.businessEvents]||all().businessEvents.length)validateBusiness({...all(),...Object.fromEntries(Object.entries(DATA).filter(([,k])=>k in after).map(([n,k])=>[n,after[k]]))});const encoded=Object.entries(after).filter(([k,v])=>{const entry=cache.get(k);return !entry||entry.value!==v||entry.raw!==localStorage.getItem(k);}).map(([k,v])=>[k,codec.stringify(v)]).filter(([k,v])=>localStorage.getItem(k)!==v);if(!encoded.length)return;
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
function set(key,next,expected){return transaction(()=>{const prev=read(key,expected);if(typeof next!=='function'&&JSON.stringify(prev)!==JSON.stringify(expected))throw Error('資料剛在另一個分頁更新，請重新核對再儲存。');let value=typeof next==='function'?next(prev):next;if(['salon_services','salon_customers','salon_stylists','salon_expenses'].includes(key)&&Array.isArray(prev)&&Array.isArray(value)){const ids=new Set(value.map(x=>String(x.id)));value=[...value,...prev.filter(x=>!ids.has(String(x.id))).map(x=>({...x,archived:true,archivedAt:x.archivedAt||new Date().toISOString()}))];}atomic({[key]:value});});}
const id=()=>crypto.randomUUID();
function money(v){const n=Number(v);if(v===''||v===null||!Number.isFinite(n)||n<0||n>10000000)throw Error('金額必須為 0 至 10,000,000 的有效數字');return Math.round(n*100)/100;}
let taipeiDateTime;
function dateTime(value){const d=new Date(value);if(!Number.isFinite(d.getTime()))return '';taipeiDateTime??=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});return taipeiDateTime.format(d).replace(' ','T');}
function day(value){if(/^\d{4}-\d{2}-\d{2}$/.test(value||''))return value;return dateTime(value).slice(0,10);}
function itemAmount(item){return money(item.price)-money(item.discount||0);}
function itemCost(item,amount){const cost=money(item.cost||0);return item.isProduct||item.costMode==='fixed'||(!item.costMode&&cost>100)?cost:amount*cost/100;}
function draftSave(value){accessRequire('pos');localStorage.setItem(DRAFT,codec.stringify(value));}
function draftRead(){return read(DRAFT,null);}
function customerTotals(tx,customers){return customers.map(c=>{const orders=tx.filter(t=>String(t.customerId)===String(c.id));return {...c,visits:orders.length,totalSpend:Math.round(orders.reduce((n,t)=>n+Number(t.total||0),0)*100)/100};});}
async function checkout(input){return transaction(d=>{
 const existing=d.transactions.find(t=>t.id===input.id);if(existing){const lines=items=>JSON.stringify(items.map(i=>[String(i.id),Number(i.price),Number(i.discount||0),String(i.stylistId)]));if(lines(existing.items)!==lines(input.items)||String(existing.customerId||'')!==String(input.customerId||'')||existing.paymentMethod!==input.paymentMethod||dateTime(existing.date)!==dateTime(input.date.length===16?input.date+':00+08:00':input.date))throw Error('此草稿已在另一個分頁完成，內容與目前畫面不同；請先查單，未重複入帳');return existing;}
 if(!input.items.length)throw Error('請先加入服務或商品');if(!input.stylistId)throw Error('請選擇設計師');
 d.customers=d.customers.map(customerRecord);const st=d.stylists.find(s=>!s.archived&&String(s.id)===String(input.stylistId));if(!st)throw Error('設計師資料已變更，請重新選擇');
 const settings=d.settings;const items=input.items.map(i=>{const price=money(i.price),discount=money(i.discount||0);money(i.cost||0);if(discount>price)throw Error('折扣不能大於售價');const person=d.stylists.find(s=>!s.archived&&String(s.id)===String(i.stylistId));if(!person)throw Error('項目設計師已停用或刪除，請重新選擇');const rate=i.commissionOverride!==undefined&&i.commissionOverride!==''?Number(i.commissionOverride):i.isProduct&&person.productCommissionRate!==undefined?Number(person.productCommissionRate):person.useGlobalCommission?Number(settings.commissionRates?.[i.category]||0):Number(person.commissionRate||0);if(!Number.isFinite(rate)||rate<0||rate>100)throw Error('抽成比例需在0至100之間，請先核對人員或分類設定');return {...i,price,discount,stylistId:person.id,stylistName:person.name,commissionRate:rate,commissionModel:'net-v2',assistantFee:i.assistantId&&!i.isProduct&&String(i.assistantId)!==String(i.stylistId)?(i.assistantFeeMode==='percent'?money(round((price-discount)*money(i.assistantFeeValue||0)/100)):money(i.assistantFeeValue??settings.assistantFee??0)):0,deductCost:!!settings.deductCostBeforeCommission};});
 for(const item of items){if(item.helpers!==undefined){item.helpers=helperSnapshot(item,d);item.assistantFee=round(item.helpers.reduce((n,h)=>n+h.amount,0));item.assistantId='';item.assistantName='';}}
 const needed={};for(const i of items)if(i.isProduct)needed[i.id]=(needed[i.id]||0)+1;
 const services=d.services.map(s=>{if(!needed[s.id])return s;if(s.archived)throw Error('商品已停用，請移除後重新選擇');const stock=Number(s.stock);if(!Number.isInteger(stock)||stock<needed[s.id])throw Error(s.name+'庫存不足，請重新核對');delete needed[s.id];return {...s,stock:stock-items.filter(i=>i.isProduct&&String(i.id)===String(s.id)).length};});
 if(Object.keys(needed).length)throw Error('有商品已刪除，請重新核對');
 const customer=input.customerId?d.customers.find(c=>!c.archived&&String(c.id)===String(input.customerId)):null;if(input.customerId&&!customer)throw Error('顧客資料已變更，請重新選擇');
 if(!dateTime(input.date))throw Error('請填寫正確日期');
 const order={id:input.id,date:input.date.length===16?input.date+':00+08:00':input.date,createdAt:new Date().toISOString(),items,total:Math.round(items.reduce((n,i)=>n+itemAmount(i),0)*100)/100,paymentMethod:input.paymentMethod,mainStylistId:st.id,customerId:customer?.id||null,customerName:customer?.name||input.customerName||'散客',customerGender:customer?.gender||input.gender||'未填寫'};
 order.receipt={amount:order.total,date:order.createdAt,method:order.paymentMethod};
 let walletEntries=d.walletEntries;if(input.paymentMethod==='儲值金'){requireWalletOwner(d.settings);if(!customer)throw Error('儲值扣款請先選擇會員');if(walletBalance(customer.id,d.walletEntries)<order.total)throw Error('儲值餘額不足，未完成結帳');order.walletPaid=order.total;const parts=walletParts(customer.id,d.walletEntries);const bonus=settings.walletBonusFirst?Math.min(parts.bonus,order.total):round(order.total-Math.min(parts.principal,order.total)),principal=round(order.total-bonus);walletEntries=[...d.walletEntries,{id:'debit:'+order.id,customerId:customer.id,date:order.createdAt,amount:-order.total,principal:-principal,bonus:-bonus,kind:'consume',orderId:order.id}];}
 const tx=[order,...d.transactions];const logs=items.filter(i=>i.isProduct).map(i=>({id:id(),date:order.date,type:'銷售',itemId:i.id,itemName:i.name,qty:1,cost:i.cost,note:'訂單 #'+order.id.slice(0,8),operator:st.name}));
 const customers=customer?d.customers.map(c=>c.id===customer.id?{...c,visits:Number(c.visits||0)+1,totalSpend:money(Number(c.totalSpend||0)+order.total)}:c):d.customers;
 atomic({salon_wallet_entries:walletEntries,salon_transactions:tx,salon_services:services,salon_customers:customers,salon_inventory_logs:[...logs,...d.inventoryLogs],salon_pending_orders:d.pendingOrders.filter(o=>o.id!==input.pendingId),[DRAFT]:null});return order;
});}
async function savePending(draft,note,pendingId){return transaction(d=>{const existing=d.pendingOrders.find(o=>o.id===pendingId);const p={...draft,id:existing?.id||id(),time:existing?.time||new Date().toISOString(),note,custName:draft.selectedCustomer?.name||draft.adHocCustomerName||'散客'};atomic({salon_pending_orders:[...d.pendingOrders.filter(o=>o.id!==p.id),p],[DRAFT]:null});return p;});}
async function inventory(input){return transaction(d=>{
 const product=d.services.find(s=>s.id===input.id);if(!product)throw Error('商品已變更，請重新核對');const qty=Number(input.qty);if(!Number.isInteger(qty)||qty<=0)throw Error('數量需為大於0的整數');
 let stock=Number(product.stock||0),type,expense=null,cost=Number(product.cost||0),note=input.note||'';
 if(input.action==='restock'){stock+=qty;cost=money(input.cost);type='進貨';if(input.recordPayment)expense={id:id(),date:day(new Date()),type:'進貨付款',amount:money(cost*qty),note:product.name+' × '+qty+'；'+(input.supplier||''),inventoryPurchase:true};note='廠商：'+(input.supplier||'未指定')+'；'+note;}
 else if(input.action==='internal'){stock-=qty;type='領用';if(input.internalUseType==='designer'&&!d.stylists.some(s=>s.id===input.staffId))throw Error('請選擇領用人員');expense={id:id(),date:day(new Date()),type:'自領料(成本)',amount:money(cost*qty),note:product.name+' × '+qty+' '+note,relatedStaffId:input.internalUseType==='designer'?input.staffId:'',staffCharge:input.internalUseType==='designer'};}
 else if(input.action==='adjust'){stock+=input.adjustType==='inc'?qty:-qty;type=input.adjustType==='inc'?'盤點+':'盤點-';}else throw Error('不支援的庫存操作');
 if(stock<0)throw Error('庫存不足，未扣除任何數量');
 const log={id:id(),date:new Date().toISOString(),type,itemId:product.id,itemName:product.name,qty,cost,note,operator:input.staffId||'店內'};
 atomic({salon_services:d.services.map(s=>s.id===product.id?{...s,stock,cost}:s),salon_inventory_logs:[log,...d.inventoryLogs],...(expense?{salon_expenses:[...d.expenses,expense]}:{})});
});}
async function reviseOrder(updated,remove=false){if(updated.businessAction)return businessOrder(updated);return transaction(d=>{const old=d.transactions.find(t=>t.id===updated.id);if(!old)throw Error('找不到原單');if(old.voided)throw Error('此單已作廢，不能重複處理');d.customers=d.customers.map(customerRecord);if(old.sourceAppointment)throw Error('轉入單請先核對來源再更正');
 assertSalaryOpen(d,old);if(old.businessVersion)throw Error('此單已啟用新帳本，請使用訂單收退款入口');
 if(old.walletPaid&&!remove)throw Error('儲值付款單請先作廢退回餘額，再重新開單，避免金額不一致');if(old.walletPaid)requireWalletOwner(d.settings);
 if(updated.expectedVersion&&updated.expectedVersion!==JSON.stringify(old))throw Error('這筆單據已在其他分頁修改，請重新開啟原單');
 const items=remove?[]:updated.items.map((i,index)=>{money(i.price);money(i.discount||0);if(itemAmount(i)<0)throw Error('折扣不能超過售價');const person=d.stylists.find(s=>String(s.id)===String(String(old.mainStylistId)!==String(updated.mainStylistId)?updated.mainStylistId:i.stylistId));if(!person)throw Error('請選擇有效設計師');return {...i,stylistId:person.id,stylistName:person.name,commissionRate:String(person.id)===String((old.items.find(o=>i.cartId&&o.cartId===i.cartId)||old.items[index]||i).stylistId)?i.commissionRate:(person.useGlobalCommission?Number(d.settings.commissionRates?.[i.category]||0):Number(person.commissionRate||0))};});
 if(!remove&&!items.length)throw Error('訂單至少保留一個項目；取消整單請使用作廢');
 const delta={};for(const i of old.items||[])if(i.isProduct)delta[i.id]=(delta[i.id]||0)+1;for(const i of items)if(i.isProduct)delta[i.id]=(delta[i.id]||0)-1;
 const services=d.services.map(s=>{if(!delta[s.id])return s;const stock=Number(s.stock||0)+delta[s.id];if(stock<0)throw Error(s.name+'庫存不足');return {...s,stock};});
 if(Object.keys(delta).some(k=>delta[k]&&!d.services.some(s=>String(s.id)===k)))throw Error('原單商品已刪除，請先恢復商品再處理庫存');
 const {expectedVersion,...fields}=updated;const order={...fields,mainStylistId:updated.mainStylistId,items,total:Math.round(items.reduce((n,i)=>n+itemAmount(i),0)*100)/100};const tx=d.transactions.map(t=>t.id!==old.id?t:remove?{...old,voided:true,voidReason:updated.voidReason||'取消交易',voidedAt:new Date().toISOString(),history:[...(old.history||[]),{at:new Date().toISOString(),action:'作廢',total:old.total}]}:{...order,history:[...(old.history||[]),{at:new Date().toISOString(),action:'修改',before:{...old,history:undefined}}]});
 const customers=d.customers.map(c=>{let visits=Number(c.visits||0),total=Number(c.totalSpend||0);if(c.id===old.customerId){visits--;total-=Number(old.total||0);}if(!remove&&c.id===order.customerId){visits++;total+=order.total;}return {...c,visits:Math.max(0,visits),totalSpend:Math.max(0,Math.round(total*100)/100)};});
 const logs=Object.entries(delta).filter(([,q])=>q).map(([key,q])=>({id:id(),date:new Date().toISOString(),type:q>0?'退單回補':'訂單更正',itemId:key,itemName:d.services.find(s=>String(s.id)===key)?.name,qty:Math.abs(q),note:'訂單 #'+old.id.slice(0,8),operator:'訂單管理'}));
 atomic({...(old.walletPaid?{salon_wallet_entries:[...d.walletEntries,{id:'refund:'+old.id,customerId:old.customerId,date:new Date().toISOString(),amount:old.walletPaid,principal:-(d.walletEntries.find(e=>e.kind==='consume'&&same(e.orderId,old.id))?.principal??-old.walletPaid),bonus:-(d.walletEntries.find(e=>e.kind==='consume'&&same(e.orderId,old.id))?.bonus||0),kind:'refund',orderId:old.id}]}:{}),salon_transactions:tx,salon_customers:customers,salon_services:services,salon_inventory_logs:[...logs,...d.inventoryLogs],[PREFIX+'last-order-change']:{before:old,at:new Date().toISOString(),removed:remove}});return order;
});}
function backupPayload(){return {...all(),draft:draftRead(),lastUpdated:new Date().toISOString(),format:'salon-pos-backup-v2'};}
function validateBackup(data){
 if(!data||typeof data.settings!=='object'||Array.isArray(data.settings)||!data.settings)throw Error('不是完整的 POS 備份，未覆蓋任何資料');
 for(const key of ['transactions','customers','services','stylists'])if(!Array.isArray(data[key]))throw Error('備份缺少 '+key+'，未覆蓋任何資料');
 for(const key of ['transactions','customers','services','stylists','expenses','inventoryLogs','pendingOrders','walletEntries','businessEvents']){if(data[key]!==undefined&&!Array.isArray(data[key]))throw Error(key+'資料格式錯誤');const ids=new Set();for(const row of data[key]||[]){if(!row||row.id===undefined||row.id===null||String(row.id)===''||ids.has(String(row.id)))throw Error(key+' 包含缺少或重複的識別碼');ids.add(String(row.id));}}
 for(const e of data.walletEntries||[]){if(!e.customerId||!Number.isFinite(Number(e.amount))||!['topup','consume','refund'].includes(e.kind)||!dateTime(e.date))throw Error('儲值紀錄不完整');}
 for(const c of data.customers){if(typeof(c.name||c.Name)!=='string'||!(c.name||c.Name).trim())throw Error('備份包含不完整顧客資料');const n=customerRecord(c);money(n.totalSpend);if(!Number.isInteger(n.visits)||n.visits<0)throw Error('顧客累積次數格式錯誤');}
 for(const t of data.transactions){if(!dateTime(t.date)||!Array.isArray(t.items)||!t.items.length)throw Error('備份訂單缺少日期或明細，未覆蓋任何資料');money(t.total);for(const i of t.items){if(!i||!Number.isFinite(Number(i.price)))throw Error('訂單明細金額不完整');if(itemAmount(i)<0)throw Error('訂單折扣超過售價');money(i.cost||0);}}
 for(const e of data.expenses||[]){money(e.amount);if(!dateTime(e.date))throw Error('支出日期不完整');}
 validateBusiness(data);return data;
}
async function restore(data){validateBackup(data);return transaction(()=>{
 const current=all();for(const entry of current.businessEvents){if(!(data.businessEvents||[]).some(e=>e.id===entry.id&&equivalent(e,entry)))throw Error('備份缺少或變更既有營運帳本，已停止還原');}const existingWallet=current.walletEntries;for(const entry of existingWallet){if(!(data.walletEntries||[]).some(e=>e.id===entry.id&&equivalent(e,entry)))throw Error('此備份缺少已發生的儲值紀錄，為防止重複花用，禁止還原。請使用包含最新儲值紀錄的完整備份');}
 // Compact only this POS's existing values, replacing each with equivalent data.
 // This also reclaims oversized snapshots left by a previous failed restore.
 for(const key of [...Object.values(DATA),DRAFT,PREFIX+'before-restore']){const raw=localStorage.getItem(key);if(raw){const packed=codec.stringify(codec.parse(raw));if(packed.length<raw.length)localStorage.setItem(key,packed);}}
 const after={[PREFIX+'before-restore']:backupPayload()};for(const [name,key]of Object.entries(DATA))after[key]=data[name]??(name==='settings'?{}:[]);after[DATA.customers]=data.customers.map(customerRecord);after[DRAFT]=data.draft||null;
 // Restoring another device's preferences must not enable uploads from this device.
 const downloaded=downloadVersions.get(data);
 after[DATA.settings]={...after[DATA.settings],...(downloaded?.settings||{}),autoCloudBackup:false,autoSync:false};
 if(downloaded)after[syncBaseKey(downloaded.settings)]=data;
 if(downloaded)after[cloudMetaKey(downloaded.settings)]={at:new Date().toISOString(),updateTime:downloaded.updateTime,confirmed:true,versionId:downloaded.versionId};
 atomic(after);
 }).catch(e=>{if(e.name==='QuotaExceededError')throw Error('手機／瀏覽器本機儲存空間不足，還原未完成；請先下載本機備份，不要重置或清除網站資料。');throw e;});}
const cloudSubscribe=f=>subscribe(PREFIX+'cloud',f);
function status(state,message,extra={}){cloudState={state,message,...extra};emit(PREFIX+'cloud');}
function cloudURL(settings){if(!settings.shopID?.trim()||!settings.syncToken?.trim())throw Error('請先設定店號與同步金鑰');return 'https://firestore.googleapis.com/v1/projects/salonpos-system/databases/(default)/documents/SalonPOS/'+encodeURIComponent(settings.shopID.trim())+'/Tokens/'+encodeURIComponent(settings.syncToken.trim());}
function cloudMetaKey(settings){return PREFIX+'cloud:'+settings.shopID.trim()+':'+settings.syncToken.trim();}
function protectCloud(local,remote){
 for(const [key,label]of Object.entries({transactions:'訂單',customers:'顧客',expenses:'支出',inventoryLogs:'庫存紀錄',walletEntries:'儲值紀錄',businessEvents:'營運帳本',services:'服務與商品',stylists:'人員'})){
  const here=local[key]||[],there=remote[key]||[];
  if(here.length<there.length)throw Error('防誤覆蓋：本機'+label+' '+here.length+' 筆，少於雲端 '+there.length+' 筆，已停止上傳。請先下載恢復雲端資料');
  const ids=new Set(here.filter(r=>r?.id!==undefined&&r.id!==null).map(r=>String(r.id)));
  if(['businessEvents','walletEntries'].includes(key)&&there.some(r=>!here.some(h=>String(h.id)===String(r.id)&&equivalent(h,r))))throw Error('防誤覆蓋：既有帳本紀錄不能變更');
  if(there.some(r=>r?.id!==undefined&&r.id!==null&&!ids.has(String(r.id))))throw Error('防誤覆蓋：本機缺少雲端原有的'+label+'，即使總筆數較多也不能覆蓋。請先下載恢復雲端資料');
 }
}
async function cloudFetch(url,options={}){if(!root.AbortController)return fetch(url,options);const controller=new root.AbortController(),timer=setTimeout(()=>controller.abort(),25000);try{return await fetch(url,{...options,signal:controller.signal});}catch(e){if(e.name==='AbortError')throw Error('雲端連線逾時，本機資料仍保留；請重試');throw e;}finally{clearTimeout(timer);}}
async function responseJSON(r){let data;try{data=await r.json();}catch{throw Error('雲端回應格式異常');}if(!r.ok){const message=data.error?.message||'';throw Error(r.status===403?'雲端權限拒絕存取，請檢查 Firebase 規則':/requires an index/i.test(message)?'雲端查詢缺少索引，暫停操作；本機與既有備份未被覆蓋。請更新網頁後重試':message||'雲端連線失敗 ('+r.status+')');}return data;}
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
// Version documents are create-only. Never PATCH or DELETE the legacy document.
function needsBusinessProtocol(data){return !!(data.businessEvents?.length||data.settings?.access?.enabled||data.walletEntries?.some(e=>e.bonus)||data.transactions?.some(t=>t.items?.some(i=>i.helpers?.length)));}
async function businessCloudGate(settings,required=false){const r=await cloudFetch(cloudURL(settings)+'/Backups/business-protocol-v3',{cache:'no-store'});if(r.status===404){if(required)throw Error('營運帳本已存本機；雲端尚未啟用新版防護，暫停上傳。請先驗證後台規則及所有裝置升級，不會改寫舊備份');return null;}if(r.status===403)throw Error('雲端版本防護權限尚未開通，已停止操作');const doc=await responseJSON(r);let control;try{control=JSON.parse(doc.fields.content.stringValue);}catch{throw Error('雲端版本防護設定不完整');}if(control.schema!==3||control.rulesVersion!==3||!doc.createTime)throw Error('雲端版本防護尚未完成');return doc;}

async function cloudVersions(settings){
 const base=cloudURL(settings),result=[];let token='';const seen=new Set();
 do{const r=await cloudFetch(base+'/Backups?pageSize=100&mask.fieldPaths=parentVersion&mask.fieldPaths=kind&mask.fieldPaths=mergedVersions&mask.fieldPaths=businessSchema'+(token?'&pageToken='+encodeURIComponent(token):''),{cache:'no-store'});
 if(r.status===403)throw Error('雲端版本備份權限尚未開通，已停止操作；不會改用覆蓋舊備份。請管理者設定 Backups 的讀取與新增權限');
 const page=await responseJSON(r);if(!Array.isArray(page.documents)&&page.documents!==undefined)throw Error('版本清單格式異常，已停止操作');
 for(const doc of page.documents||[]){if((doc.name?.endsWith('/wallet-owner-v1')||doc.name?.endsWith('/business-protocol-v3')))continue;if(!doc.name||!doc.createTime||!doc.updateTime)throw Error('版本清單缺少時間，已停止操作');result.push({...doc,versionId:doc.name.split('/').pop()});}
 token=page.nextPageToken||'';if(token&&seen.has(token))throw Error('版本清單讀取不完整，已停止操作');seen.add(token);
 }while(token);
 return result.sort((a,b)=>b.createTime.localeCompare(a.createTime)||b.name.localeCompare(a.name));
}
async function cloudHead(settings){
 const base=cloudURL(settings);
 // Only read legacy metadata when checking a versioned shop. The legacy payload
 // is needed only when no versioned backup exists or when explicitly restoring it.
 const [legacy,gate,versions]=await Promise.all([
   cloudFetch(base+'?mask.fieldPaths=kind',{cache:'no-store'}).then(r=>r.status===404?null:responseJSON(r)),
   businessCloudGate(settings),cloudVersions(settings)
 ]);
 if(gate&&versions.some(v=>v.createTime>gate.createTime&&v.fields?.kind?.stringValue!=='legacy-snapshot'&&v.fields?.businessSchema?.integerValue!=='3'))throw Error('防護啟用後仍有舊版寫入，請核對後台規則；已停止同步，保留全部版本');const latest=versions.find(v=>v.fields?.kind?.stringValue!=='legacy-snapshot');
 // Older application versions can still write the legacy record until backend rules are locked.
 if(legacy&&latest&&legacy.updateTime>latest.createTime)throw Error('偵測到舊版裝置更新原始備份，已停止操作。所有版本仍保留，請先核對後台資料');
 if(!latest){const document=legacy?await responseJSON(await cloudFetch(base,{cache:'no-store'})):null;if(document&&document.updateTime!==legacy.updateTime)throw Error('原始備份在讀取時發生變更，請稍後再試');return {document,versionId:'legacy',versions,gate};}
 const document=await responseJSON(await cloudFetch(base+'/Backups/'+encodeURIComponent(latest.versionId),{cache:'no-store'}));
 if(document.updateTime!==latest.updateTime)throw Error('備份版本在讀取時發生變更，已停止操作');
 return {document,versionId:latest.versionId,versions,gate};
}
async function cloudBackup(settings,manual=false,mergeParents=[]){if(cloudBusy)throw Error('雲端備份處理中，請稍候');clearTimeout(cloudTimer);const startRevision=revision;cloudBusy=true;status('saving','雲端備份中，本機可繼續開單');try{
 const url=cloudURL(settings),metaKey=cloudMetaKey(settings);const meta=read(metaKey,{});
 if(!manual&&(!meta.updateTime||meta.confirmed===false))throw Error('請先手動完成一次雲端備份，再開啟自動備份');
 const head=await cloudHead(settings),current=head.document;if(versionTips(head.versions).length>1&&!mergeParents.length)throw Error('多台裝置有不同的新版本，請使用安全同步合併；所有版本仍保留');
 if(current&&meta.updateTime&&current.updateTime!==meta.updateTime)throw Error('雲端已被其他裝置更新，請先核對，未覆蓋備份');
 if(!manual&&current&&!meta.updateTime)throw Error('請先核對既有雲端資料');
 const payload=backupPayload();if(!head.gate&&needsBusinessProtocol(payload))await businessCloudGate(settings,true);payload.settings={...payload.settings,...settings};if(current)protectCloud(payload,await unpackCloud(current.fields?.content?.stringValue));const {content,rawBytes,storedBytes}=await packCloud(payload);
 // Preserve an exact copy of the original record as well; it is never used as a new upload head.
 if(current&&head.versionId==='legacy'&&!head.versions.some(v=>v.versionId==='legacy-original')){
 const archiveURL=url+'/Backups/legacy-original';const archiveFields={...current.fields,kind:{stringValue:'legacy-snapshot'}};
 const archiveResponse=await cloudFetch(archiveURL+'?currentDocument.exists=false',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:archiveFields})});
 if(!archiveResponse.ok&&archiveResponse.status!==409)await responseJSON(archiveResponse);
 const archived=await responseJSON(await cloudFetch(archiveURL,{cache:'no-store'}));
 if(archived.fields?.content?.stringValue!==current.fields?.content?.stringValue)throw Error('原始備份保留副本與目前內容不同，已停止新增；既有資料未覆寫');
 }
 const versionId='v-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+id(),versionURL=url+'/Backups/'+encodeURIComponent(versionId);const precondition='&currentDocument.exists=false';
 const saved=await responseJSON(await cloudFetch(versionURL+'?updateMask.fieldPaths=content&updateMask.fieldPaths=parentVersion&updateMask.fieldPaths=mergedVersions&updateMask.fieldPaths=businessSchema'+precondition,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:{businessSchema:{integerValue:'3'},mergedVersions:{arrayValue:{values:mergeParents.map(stringValue=>({stringValue}))}},content:{stringValue:content},parentVersion:{stringValue:current?head.versionId+':'+current.updateTime:'none'}}})}));
 if(saved.fields?.content?.stringValue!==content)throw Error('雲端回傳內容不符，尚未確認備份成功');
 // Keep the write receipt if the verification GET fails, so a manual retry can
 // safely compare against our own write without disabling conflict detection.
 if(!saved.updateTime)throw Error('雲端未提供備份版本，尚未確認成功');
 localStorage.setItem(metaKey,JSON.stringify({updateTime:saved.updateTime,versionId,confirmed:false}));
 const checked=await responseJSON(await cloudFetch(versionURL,{cache:'no-store'}));if(checked.updateTime!==saved.updateTime||checked.fields?.content?.stringValue!==content)throw Error('上傳後的雲端讀回核對不符，請核對其他裝置，尚未確認備份成功');await unpackCloud(checked.fields.content.stringValue);
 const at=new Date().toISOString();atomic({[syncBaseKey(settings)]:payload,[metaKey]:{at,updateTime:saved.updateTime,versionId,confirmed:true}});const sizeInfo=rawBytes>storedBytes?'（'+Math.ceil(rawBytes/1024)+' → '+Math.ceil(storedBytes/1024)+' KB）':'';status('saved','雲端新版本已保存，舊版本保留'+sizeInfo+' · '+dateTime(at).replace('T',' '),{at,rawBytes,storedBytes});return saved;
 }catch(e){status('error',e.message);throw e;}finally{cloudBusy=false;if(revision!==startRevision&&read(DATA.settings,{}).autoCloudBackup)scheduleCloud();}}
async function cloudDownload(settings,versionId){
 const head=await cloudHead(settings);let document=head.document,selected=head.versionId;
 if(versionId&&versionId!==head.versionId){if(versionId==='legacy'){const r=await cloudFetch(cloudURL(settings),{cache:'no-store'});document=await responseJSON(r);}else{if(!head.versions.some(v=>v.versionId===versionId))throw Error('找不到指定備份版本');document=await responseJSON(await cloudFetch(cloudURL(settings)+'/Backups/'+encodeURIComponent(versionId),{cache:'no-store'}));}selected=versionId;}
 if(!document)throw Error('尚無雲端備份，未變更本機資料');const data=await unpackCloud(document.fields?.content?.stringValue);if(!document.updateTime)throw Error('雲端未提供版本，請稍後再試');
 downloadVersions.set(data,{settings:{shopID:settings.shopID.trim(),syncToken:settings.syncToken.trim()},updateTime:document.updateTime,versionId:selected});return data;
}

// Three-way merge: a conflicting edit is never resolved by timestamp alone.
const equivalent=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const deviceKeys=['autoSync','autoCloudBackup','autoBackup','shopID','syncToken'];
function mergeValue(base,local,remote,path){
 if(equivalent(local,remote))return local;if(equivalent(local,base))return remote;if(equivalent(remote,base))return local;
 if(base&&local&&remote&&![base,local,remote].some(Array.isArray)&&[base,local,remote].every(x=>typeof x==='object')){const out={};for(const k of new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)]))out[k]=mergeValue(base[k],local[k],remote[k],path+'.'+k);return out;}
 throw Error('同步暫停：'+path+' 在兩台裝置都被修改。兩邊資料及雲端版本仍保留，請先核對；未以新資料蓋掉舊資料');
}
function mergeData(base,local,remote){
 const out={...remote};
 for(const key of Object.keys(DATA).filter(k=>k!=='settings')){
 const b=new Map((base?.[key]||[]).map(r=>[String(r.id),r])),l=new Map((local[key]||[]).map(r=>[String(r.id),r])),r=new Map((remote[key]||[]).map(r=>[String(r.id),r]));out[key]=[];
 for(const k of new Set([...r.keys(),...l.keys(),...b.keys()])){let bv=b.get(k),lv=l.get(k),rv=r.get(k),v;if(key==='customers'){if(bv)bv=customerRecord(bv);if(lv)lv=customerRecord(lv);if(rv)rv=customerRecord(rv);}
 if(key==='services'&&bv?.isProduct&&lv&&rv&&lv.stock!==bv.stock&&rv.stock!==bv.stock&&!equivalent(local.transactions,remote.transactions))throw Error('同步暫停：同一商品在兩台裝置異動庫存，請核對');
 if(bv&&['businessEvents','walletEntries'].includes(key)&&((lv&&!equivalent(lv,bv))||(rv&&!equivalent(rv,bv))))throw Error('同步暫停：既有帳本不可修改');
 if(equivalent(lv,rv)){v=lv;}else if(!bv){if(lv&&rv&&!equivalent(lv,rv))throw Error('同步暫停：'+key+' 有同一識別碼的不同內容，請先核對');v=lv||rv;}
 else if(key==='customers'&&lv&&rv){const counts={};for(const f of ['visits','totalSpend']){const aliases={visits:'Visits',totalSpend:'TotalSpend'};counts[f]=Math.round((Number(lv[f]??lv[aliases[f]]??0)+Number(rv[f]??rv[aliases[f]]??0)-Number(bv[f]??bv[aliases[f]]??0))*100)/100;}
 const strip=x=>Object.fromEntries(Object.entries(customerRecord(x)).filter(([f])=>!['visits','totalSpend','Visits','TotalSpend'].includes(f)));v={...mergeValue(strip(bv),strip(lv),strip(rv),key+'.'+k),...counts};}
 else if(['transactions','walletEntries','businessEvents','services'].includes(key)&&lv&&rv&&!equivalent(lv,rv)&&!equivalent(lv,bv)&&!equivalent(rv,bv))throw Error('同步暫停：同一筆單據、庫存或儲值有雙方修改，請核對後再同步');
 else v=mergeValue(bv,lv,rv,key+'.'+k);
 if(v)out[key].push(v);else if(key!=='pendingOrders'&&bv)throw Error('同步暫停：不允許移除既有紀錄，請使用封存或作廢');
 }
 }
 if(base){const totals=tx=>{const map=new Map();for(const t of tx||[]){if(t.voided||!t.customerId)continue;const k=String(t.customerId),v=map.get(k)||{visits:0,totalSpend:0};v.visits++;v.totalSpend+=Number(t.total||0);map.set(k,v);}return map;},before=totals(base.transactions),after=totals(out.transactions),byCustomer=new Map((base.customers||[]).map(c=>[String(c.id),customerRecord(c)]));out.customers=out.customers.map(c=>{const original=byCustomer.get(String(c.id));if(!original)return c;const old=before.get(String(c.id))||{visits:0,totalSpend:0},next=after.get(String(c.id))||{visits:0,totalSpend:0};return {...c,visits:original.visits+next.visits-old.visits,totalSpend:Math.round((original.totalSpend+next.totalSpend-old.totalSpend)*100)/100};});}
 const strip=x=>Object.fromEntries(Object.entries(x||{}).filter(([k])=>!deviceKeys.includes(k)));
 out.settings=base?mergeValue(strip(base.settings),strip(local.settings),strip(remote.settings),'設定'):{...strip(remote.settings)};
 for(const k of deviceKeys)if(local.settings[k]!==undefined)out.settings[k]=local.settings[k];
 out.draft=local.draft;validateBackup(out);return out;
}
function versionTips(versions){const consumed=new Set();for(const v of versions){const p=v.fields?.parentVersion?.stringValue;if(p)consumed.add(p.split(':')[0]);for(const a of v.fields?.mergedVersions?.arrayValue?.values||[])consumed.add(a.stringValue);}return versions.filter(v=>v.fields?.kind?.stringValue!=='legacy-snapshot'&&!consumed.has(v.versionId));}
let lastProbe='',lastProbeScope='',lastFullCheck=0,lastSyncRevision=-1;
async function cloudProbe(settings){
 // Default document listing needs no custom descending-name index. Read every
 // metadata page so a new branch beyond the first page cannot be missed.
 const versions=await cloudVersions(settings);return JSON.stringify(versions.map(d=>[d.name,d.updateTime]));
}
function syncBaseKey(settings){return cloudMetaKey(settings)+':base';}
function dataEqual(a,b){const clean=x=>Object.fromEntries(Object.entries(x||{}).filter(([k])=>!deviceKeys.includes(k)));return Object.keys(DATA).every(k=>equivalent(k==='settings'?clean(a[k]):a[k]??[],k==='settings'?clean(b[k]):b[k]??[]));}
function interactionBusy(){return !!(root.document?.querySelector('[data-pos-modal],.style-overlay')||/^(INPUT|TEXTAREA|SELECT)$/.test(root.document?.activeElement?.tagName)||draftRead()?.cart?.length);}
async function cloudSync(force=false){
 let settings=read(DATA.settings,{});if(syncBusy||cloudBusy)return;if(settings.autoSync===false&&!force){status('idle','已存本機 · 自動同步已關閉');return;}if(!settings.shopID||!settings.syncToken){status('idle','本機模式 · 請先設定雲端連線');return;}
 if(root.navigator.onLine===false){status('pending','離線可開單 · 連線後自動同步');return;}
 if(interactionBusy()){status('pending','本機已保存 · 操作完成後同步');return;}
 syncBusy=true;const start=revision;status('checking','正在檢查雲端版本');
 try{
 const scope=cloudMetaKey(settings),probe=await cloudProbe(settings);if(!force&&scope===lastProbeScope&&probe===lastProbe&&revision===lastSyncRevision&&Date.now()-lastFullCheck<600000){status('saved','已同步 · '+dateTime(new Date()).slice(11));return;}
 const head=await cloudHead(settings);const local=backupPayload(),baseKey=syncBaseKey(settings);let base=read(baseKey,null),remote=head.document?await unpackCloud(head.document.fields.content.stringValue):null;
 const meta=read(cloudMetaKey(settings),{});if(!base&&meta.versionId&&head.document){try{base=await cloudDownload(settings,meta.versionId);}catch(e){throw Error('無法讀取上次同步基準，已暫停：'+e.message);}}
 const tips=versionTips(head.versions);
 if(tips.length>1){const parents=new Set(tips.map(v=>v.fields?.parentVersion?.stringValue));if(parents.size!==1)throw Error('多台裝置產生不同版本分支，已保留所有資料，請管理者核對後合併');const parent=[...parents][0]?.split(':')[0];if(!parent||parent==='none')throw Error('初次備份有多台裝置同時建立，請先核對版本');const common=await cloudDownload(settings,parent);let aggregate=common;for(const tip of tips){const data=await cloudDownload(settings,tip.versionId);aggregate=mergeData(common,aggregate,data);}remote=aggregate;}
 let merged;
 if(!remote)merged=local;
 else if(!base&&!local.transactions.length&&!local.customers.length&&!local.expenses.length&&!local.inventoryLogs.length&&!local.walletEntries.length&&!local.businessEvents.length)merged={...remote,settings:{...remote.settings,...Object.fromEntries(deviceKeys.filter(k=>settings[k]!==undefined).map(k=>[k,settings[k]]))},draft:local.draft};
 else merged=mergeData(base,local,remote);
 merged.settings={...merged.settings,autoSync:settings.autoSync??true,autoCloudBackup:settings.autoCloudBackup??false,autoBackup:settings.autoBackup??false,shopID:settings.shopID,syncToken:settings.syncToken};
 if(revision!==start||interactionBusy()) {status('pending','操作中 · 下一輪再同步');return;}
 const needUpload=!remote||!dataEqual(merged,remote)||tips.length>1;
 // Reserve and commit local changes plus recovery snapshot and receipt together.
 await transaction(()=>{if(revision!==start||interactionBusy())throw Error('本機正在更新，稍後自動重試');const after={};if(!dataEqual(local,merged)){after[PREFIX+'before-sync']=local;for(const [k,key]of Object.entries(DATA))after[key]=merged[k]??[];}
 if(remote){after[baseKey]=remote;after[cloudMetaKey(settings)]={confirmed:true,versionId:head.versionId,updateTime:head.document.updateTime};}
 syncApplying=true;try{atomic(after);}finally{syncApplying=false;}});
 // cloudBackup verifies its read-back and atomically saves the confirmed sync base.
 if(needUpload)await cloudBackup(read(DATA.settings,{}),true,tips.map(v=>v.versionId));
 lastProbe=probe;lastProbeScope=scope;lastFullCheck=Date.now();lastSyncRevision=revision;
 status('saved','已同步 · '+dateTime(new Date()).slice(11),{at:new Date().toISOString()});
 }catch(e){status('error',e.message);throw e;}finally{syncBusy=false;}
}
function startSync(){let stopped=false,timer;const tick=()=>{if(stopped)return;if(root.document?.visibilityState!=='hidden')cloudSync().catch(()=>{});timer=setTimeout(tick,60000);};timer=setTimeout(tick,1000);const wake=()=>{if(root.document?.visibilityState!=='hidden')cloudSync().catch(()=>{});};root.addEventListener('online',wake);root.document?.addEventListener('visibilitychange',wake);return()=>{stopped=true;clearTimeout(timer);root.removeEventListener?.('online',wake);root.document?.removeEventListener('visibilitychange',wake);};}
function walletOwnerId(){let key=PREFIX+'wallet-device',v=localStorage.getItem(key);if(!v){v=id();localStorage.setItem(key,v);}return v;}
function requireWalletOwner(settings){if(!settings.walletDeviceId||settings.walletDeviceId!==walletOwnerId())throw Error('儲值扣款僅限指定收銀裝置，其他裝置可查看；避免兩台離線重複扣款');}
async function claimWalletDevice(){const settings=read(DATA.settings,{}),owner=walletOwnerId();if(!settings.shopID||!settings.syncToken)throw Error('請先連接雲端，再指定唯一儲值收銀裝置');const url=cloudURL(settings)+'/Backups/wallet-owner-v1';let response=await cloudFetch(url,{cache:'no-store'});if(response.status===404){const create=await cloudFetch(url+'?currentDocument.exists=false',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:{kind:{stringValue:'legacy-snapshot'},content:{stringValue:JSON.stringify({format:'salon-wallet-owner-v1',owner})}}})});if(!create.ok&&create.status!==409)await responseJSON(create);response=await cloudFetch(url,{cache:'no-store'});}const doc=await responseJSON(response);if(JSON.parse(doc.fields.content.stringValue).owner!==owner)throw Error('雲端已指定另一台儲值收銀裝置，這台僅能查看餘額');return transaction(d=>atomic({[DATA.settings]:{...d.settings,walletDeviceId:owner}}));}
function walletAdjust(input){return transaction(d=>{requireWalletOwner(d.settings);const existing=d.walletEntries.find(e=>e.id===input.id);if(existing)return existing;if(!d.customers.some(c=>!c.archived&&same(c.id,input.customerId)))throw Error('請選擇有效會員');const amount=money(input.amount),reason=reasonText(input.reason);if(!amount)throw Error('金額需大於零');if(!['withdraw','bonus'].includes(input.kind))throw Error('不支援的儲值異動');const parts=walletParts(input.customerId,d.walletEntries);if(input.kind==='withdraw'&&amount>parts.principal)throw Error('只能退回剩餘本金，贈送金不能兌換現金');const principal=input.kind==='withdraw'?-amount:0,bonus=input.kind==='bonus'?amount:0;const entry={id:input.id||id(),kind:input.kind,customerId:input.customerId,date:validDay(input.date)+'T12:00:00+08:00',amount:round(principal+bonus),principal,bonus,paymentMethod:input.kind==='withdraw'?reasonText(input.method):'贈送',note:reason};atomic({[DATA.walletEntries]:[...d.walletEntries,entry]});return entry;});}

function walletBalance(customerId,entries=all().walletEntries){return Math.round(entries.filter(e=>String(e.customerId)===String(customerId)).reduce((n,e)=>n+Number(e.amount||0),0)*100)/100;}
function walletTopup(input){return transaction(d=>{requireWalletOwner(d.settings);const existing=d.walletEntries.find(e=>e.id===input.id);if(existing)return existing;if(!d.customers.some(c=>!c.archived&&String(c.id)===String(input.customerId)))throw Error('請選擇有效會員');const amount=money(input.amount);if(!amount)throw Error('儲值金額需大於零');const bonus=money(input.bonus||0);const entry={id:input.id||id(),customerId:input.customerId,date:new Date().toISOString(),amount:round(amount+bonus),principal:amount,bonus,kind:'topup',paymentMethod:input.paymentMethod||'現金',note:input.note||''};atomic({[DATA.walletEntries]:[...d.walletEntries,entry]});return entry;});}
function lineFinancials(item,settings={},staff={}){const amount=Number(item.price||0)-Number(item.discount||0),cost=itemCost(item,amount),assistant=Number(item.assistantFee||0),net=amount-cost-(item.isProduct?0:assistant);const rate=Number(item.commissionRate??(staff.useGlobalCommission?settings.commissionRates?.[item.category]:staff.commissionRate)??0);const base=item.commissionModel==='net-v2'?net:amount-((item.deductCost??settings.deductCostBeforeCommission)?cost:0);return {amount,cost,assistant,net,commission:Math.round(Math.max(0,base)*rate/100)};}
function financials(tx,expenses,staff,settings,monthly){const rows=staff.map(s=>({...s,serviceRevenue:0,productRevenue:0,realRevenue:0,materialCost:0,assistantCost:0,serviceCommission:0,productCommission:0,assistantCommission:0,visits:0})),byId=new Map(rows.map(s=>[String(s.id),s]));let revenue=0,cost=0,serviceRevenue=0,realRevenue=0;
 for(const t of tx.filter(t=>!t.voided)){revenue+=Number(t.total||0);const seen=new Set();for(const item of t.items||[]){const person=byId.get(String(item.stylistId)),f=lineFinancials(item,settings,person||{});cost+=f.cost;if(!item.isProduct){serviceRevenue+=f.amount;realRevenue+=f.net;}if(person){if(item.isProduct){person.productRevenue+=f.amount;person.productCommission+=f.commission;}else{person.serviceRevenue+=f.amount;person.realRevenue+=f.net;person.materialCost+=f.cost;person.assistantCost+=f.assistant;person.serviceCommission+=f.commission;}seen.add(String(person.id));}if(Array.isArray(item.helpers)){for(const h of item.helpers){const assistant=byId.get(String(h.id));if(assistant)assistant.assistantCommission+=Number(h.amount||0);}}else{const assistant=byId.get(String(item.assistantId));if(assistant)assistant.assistantCommission+=f.assistant;}}for(const k of seen)byId.get(k).visits++;}
 for(const s of rows){s.advanceTotal=expenses.filter(e=>!e.archived&&e.type==='員工借支'&&String(e.staffId||e.relatedStaffId)===String(s.id)).reduce((n,e)=>n+Number(e.amount||0),0);s.totalCommission=s.serviceCommission+s.productCommission+s.assistantCommission;s.fixedPay=monthly?Number(s.baseSalary||0)+Number(s.positionBonus||0)+Number(s.attendanceBonus||0):0;s.totalSalary=s.fixedPay+s.totalCommission-s.advanceTotal;}
 const cashExpense=expenses.filter(e=>!e.archived).reduce((n,e)=>n+Number(e.amount||0),0),operatingExpense=expenses.filter(e=>!e.archived&&!e.inventoryPurchase&&!['進貨付款','員工借支','薪資發放'].includes(e.type)).reduce((n,e)=>n+Number(e.amount||0),0),salaryCost=rows.reduce((n,s)=>n+s.totalSalary+s.advanceTotal,0);return {rows,revenue,cost,serviceRevenue,realRevenue,cashExpense,operatingExpense,salaryCost,profit:revenue-cost-operatingExpense-salaryCost};}

// Business integration: append-only events; no production cloud migration on load.
const round=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const same=(a,b)=>String(a)===String(b);
function signed(v){if(v===''||v==null||!Number.isFinite(Number(v))||Math.abs(Number(v))>10000000)throw Error('金額格式錯誤');return round(v);}
function reasonText(v){if(!String(v||'').trim())throw Error('請填寫原因或說明');return String(v).trim();}
function validDay(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(v||'')||new Date(v+'T12:00:00Z').toISOString().slice(0,10)!==v)throw Error('日期不正確');return v;}
function monthBounds(m){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(m||''))throw Error('請選擇月份');return {from:m+'-01',to:new Date(Date.UTC(Number(m.slice(0,4)),Number(m.slice(5)),0)).toISOString().slice(0,10)};}
function orderReceipt(o){if(o.receipt)return o.receipt;const first=(o.history||[]).find(h=>h.before)?.before||o;return {amount:Number(first.total||0),date:first.createdAt||first.date,method:first.paymentMethod,estimated:true};}
function businessDue(o,events=all().businessEvents){const paid=Number(orderReceipt(o).amount)+events.filter(e=>e.kind==='settlement'&&same(e.orderId,o.id)).reduce((n,e)=>n+Number(e.amount),0);return round((o.voided?0:Number(o.total))-paid+(o.walletRefunded||0));}
function vipDiscount(customer,item,settings=all().settings){if(!customer||item.isProduct&&!settings.vipIncludeProducts)return 0;const tiers=(settings.vipTiers||[]).filter(t=>!t.disabled&&Number(customer.totalSpend||0)>=Number(t.threshold||0)).sort((a,b)=>Number(b.threshold)-Number(a.threshold));const tier=customer.vipTierId==='none'?null:customer.vipTierId?(settings.vipTiers||[]).find(t=>t.id===customer.vipTierId&&!t.disabled):tiers[0];if(!tier)return 0;const pct=money(tier.discountPercent);if(pct>100)throw Error('會員優惠百分比錯誤');return round(Number(item.price)*pct/100);}
function walletParts(customerId,entries=all().walletEntries){let principal=0,bonus=0;for(const e of entries.filter(e=>same(e.customerId,customerId))){principal+=Number(e.principal??e.amount);bonus+=Number(e.bonus||0);}return {principal:round(principal),bonus:round(bonus),total:round(principal+bonus)};}
function appendEvent(d,event,extra={}){atomic({...extra,[DATA.businessEvents]:[...d.businessEvents,event]});return event;}
function checkExpected(o,expected){if(!o||!expected||JSON.stringify(o)!==expected)throw Error('訂單已變更，請關閉後重新核對');}
function assertSalaryOpen(d,o){const month=day(o.date).slice(0,7),people=new Set((o.items||[]).flatMap(i=>[String(i.stylistId),String(i.assistantId),...(i.helpers||[]).map(h=>String(h.id))]));if(d.settings.payrollLocks?.[month]||activeSalaries(d).some(e=>e.month===month&&people.has(String(e.staffId))))throw Error('此月份薪資已鎖定／結算，不能直接改動原單；請先由管理者核對');}
function businessOrder(input){return transaction(d=>{
 const duplicate=d.businessEvents.find(e=>e.id===input.operationId);if(duplicate)return duplicate;
 if(!input.operationId)throw Error('缺少操作識別碼');const old=d.transactions.find(t=>same(t.id,input.id));checkExpected(old,input.expectedVersion);if(old.voided)throw Error('已作廢單據不能重複修改');if(old.sourceAppointment)throw Error('預約轉入單請先核對來源，暫不更正');assertSalaryOpen(d,old);
 const action=input.businessAction,reason=reasonText(input.reason),now=new Date().toISOString();let items=JSON.parse(JSON.stringify(old.items)),returns=[];
 const targetStaff=input.mainStylistId||old.mainStylistId;
 if(action==='edit'){
  if(old.walletPaid)throw Error('儲值訂單請以退貨或作廢處理，不可直接改價');
  items=input.items.map((i,n)=>{const original=old.items.find((x,k)=>(x.cartId||old.id+'-line-'+k)===(i.cartId||old.id+'-line-'+n));if(!original)throw Error('更正時不能新增未知項目');const person=d.stylists.find(s=>same(s.id,same(targetStaff,old.mainStylistId)?i.stylistId:targetStaff));if(!person)throw Error('請選擇有效人員');const price=money(i.price),discount=money(i.discount||0);if(discount>price)throw Error('折扣不能大於售價');return {...original,cartId:i.cartId,price,discount,stylistId:person.id,stylistName:person.name,commissionRate:same(person.id,original.stylistId)?original.commissionRate:(person.useGlobalCommission?Number(d.settings.commissionRates?.[i.category]||0):Number(person.commissionRate||0))};});
  if(!items.length)throw Error('整單取消請使用作廢');if(new Set(items.map(i=>i.cartId)).size!==items.length)throw Error('項目重複');
  // Deleting products must use explicit return flow, not an implicit stock increase.
  if(old.items.filter(i=>i.isProduct).length!==items.filter(i=>i.isProduct).length)throw Error('刪除商品請使用部分商品退貨，選擇回庫或報廢');
 }else if(action==='return'){
  const selected=new Set(input.lineIds||[]);if(!selected.size)throw Error('請勾選退貨商品');
  returns=old.items.map((i,n)=>({...i,lineId:i.cartId||old.id+'-line-'+n})).filter(i=>selected.has(i.lineId));
  if(returns.length!==selected.size||returns.some(i=>!i.isProduct))throw Error('只能選擇原單尚未退貨的商品');
  items=old.items.filter((i,n)=>!selected.has(i.cartId||old.id+'-line-'+n));if(!items.length)throw Error('全部項目退回請使用整單作廢');
 }else if(action==='void'){returns=old.items.filter(i=>i.isProduct);items=[];}else throw Error('不支援的單據操作');
 const total=round(items.reduce((n,i)=>n+itemAmount(i),0));let next={...old,receipt:orderReceipt(old),businessVersion:1,items:action==='void'?old.items:items,total:action==='void'?old.total:total};
 if(action==='edit'){for(const i of next.items){const edited=input.items.find(x=>x.cartId===i.cartId);if(edited?.helpers!==undefined){i.helpers=helperSnapshot({...i,helpers:edited.helpers},d);i.assistantFee=round(i.helpers.reduce((n,h)=>n+h.amount,0));i.assistantId='';i.assistantName='';}}if(!dateTime(input.date))throw Error('日期不正確');next.date=input.date;next.mainStylistId=targetStaff;next.customerName=input.customerName||old.customerName;if(input.customerId!==old.customerId){if(!d.customers.some(c=>same(c.id,input.customerId)&&!c.archived))throw Error('會員資料無效');next.customerId=input.customerId;}assertSalaryOpen(d,next);}
 if(action==='void')Object.assign(next,{voided:true,voidReason:reason,voidedAt:now});
 const delta=action==='void'?-Number(old.total):total-Number(old.total);
 let services=d.services,logs=d.inventoryLogs;
 if(returns.length){const quantities={};returns.forEach(i=>quantities[i.id]=(quantities[i.id]||0)+1);if(input.returnStock){for(const k of Object.keys(quantities))if(!services.some(p=>same(p.id,k)))throw Error('原商品已不存在，無法回庫');services=services.map(p=>quantities[p.id]?{...p,stock:Number(p.stock||0)+quantities[p.id]}:p);}
 logs=[...returns.map(i=>({id:id(),date:now,type:input.returnStock?'退貨回庫':'退貨報廢',itemId:i.id,itemName:i.name,qty:1,cost:itemCost(i,itemAmount(i)),orderId:old.id,note:reason,operator:'訂單管理'})),...logs];}
 const customers=d.customers.map(customerRecord).map(c=>{let amount=c.totalSpend,visits=c.visits;if(same(c.id,old.customerId)){amount-=Number(old.total);visits--;}if(action!=='void'&&same(c.id,next.customerId)){amount+=total;visits++;}return {...c,totalSpend:Math.max(0,round(amount)),visits:Math.max(0,visits)};});
 next.history=[...(old.history||[]),{at:now,action:action==='edit'?'修改':action==='return'?'商品退貨':'作廢',reason,before:{...old,history:undefined},afterTotal:action==='void'?0:total}];
 const event={id:input.operationId,kind:'orderChange',orderId:old.id,date:now,action,reason,amount:delta,returnedCost:round(returns.reduce((n,i)=>n+itemCost(i,itemAmount(i)),0)),returnStock:!!input.returnStock,lineIds:input.lineIds||[]};
 appendEvent(d,event,{[DATA.transactions]:d.transactions.map(t=>same(t.id,old.id)?next:t),[DATA.customers]:customers,[DATA.services]:services,[DATA.inventoryLogs]:logs});return next;
});}
function settleOrder(input){return transaction(d=>{
 const previous=d.businessEvents.find(e=>e.id===input.id);if(previous)return previous;
 const o=d.transactions.find(t=>same(t.id,input.orderId));checkExpected(o,input.expectedVersion);const due=businessDue(o,d.businessEvents);if(!due||signed(input.amount)!==due)throw Error('待補收／退款金額已變更，請重新核對');const reason=reasonText(input.reason),date=validDay(input.date);let wallets=d.walletEntries,method=input.method;
 if(o.receipt?.estimated&&input.confirmLegacy!==true)throw Error('舊單缺少實際收款快照，請先核對原款已收取');
 if(o.paymentMethod==='儲值金'){
  requireWalletOwner(d.settings);if(due>0)throw Error('儲值訂單不可另外補收，請重新開單');method='儲值金';
  const debit=wallets.find(e=>e.kind==='consume'&&same(e.orderId,o.id));if(!debit)throw Error('找不到原儲值扣款紀錄，請核對');const prior=wallets.filter(e=>e.kind==='refund'&&same(e.orderId,o.id));
  const bonusLeft=round(-Number(debit.bonus||0)-prior.reduce((n,e)=>n+Number(e.bonus||0),0)),principalLeft=round(-Number(debit.principal??debit.amount)-prior.reduce((n,e)=>n+Number(e.principal??e.amount),0));if(-due>round(bonusLeft+principalLeft))throw Error('退款超過原儲值扣款');const bonus=Math.min(-due,bonusLeft),principal=round(-due-bonus);
  wallets=[...wallets,{id:'refund:'+input.id,kind:'refund',orderId:o.id,customerId:o.customerId,date:date+'T12:00:00+08:00',amount:-due,principal,bonus}];
 }else if(!method||method==='儲值金')throw Error('請選擇實際收退款方式');
 const event={id:input.id||id(),kind:'settlement',orderId:o.id,amount:due,date:date+'T12:00:00+08:00',method,reason,version:JSON.stringify(o)};
 return appendEvent(d,event,{[DATA.walletEntries]:wallets});
});}
function recordWork(input){return transaction(d=>{
 if(d.businessEvents.some(e=>e.id===input.id))return;const person=d.stylists.find(s=>same(s.id,input.staffId)&&!s.archived);if(!person)throw Error('請選擇人員');const date=validDay(input.date),hours=Number(input.hours),rate=money(input.rate);if(!Number.isFinite(hours)||hours<=0||hours>24)throw Error('工時需大於0且不超過24小時');
 if(activeSalaries(d).some(e=>same(e.staffId,person.id)&&e.month===date.slice(0,7)))throw Error('本月已結算，不能再登記工時');
 return appendEvent(d,{id:input.id||id(),kind:'work',staffId:person.id,date,hours,rate,amount:round(hours*rate),reason:input.reason||'工時登記'});
});}
function salarySources(d,staffId,month){return d.transactions.filter(t=>!t.voided&&day(t.date).startsWith(month)&&(t.items||[]).some(i=>same(i.stylistId,staffId)||same(i.assistantId,staffId)||(i.helpers||[]).some(h=>same(h.id,staffId)))).map(t=>JSON.stringify({id:t.id,date:t.date,items:t.items})).sort();}
function salaryDraft(staffId,month,d=all()){
 const bounds=monthBounds(month),person=d.stylists.find(s=>same(s.id,staffId));if(!person)throw Error('找不到人員');
 const tx=d.transactions.filter(t=>!t.voided&&day(t.date)>=bounds.from&&day(t.date)<=bounds.to),rows=financials(tx,[],d.stylists,d.settings,true).rows;
 const oldLock=d.settings.payrollLocks?.[month]?.rows?.find(s=>same(s.id,staffId)),base=oldLock||rows.find(s=>same(s.id,staffId));
 const salaries=[...activeSalaries(d),...d.businessEvents.filter(e=>e.kind==='legacyPayroll')],usedAdvances=new Set(salaries.flatMap(e=>e.advanceIds||[])),usedCharges=new Set(salaries.flatMap(e=>e.chargeIds||[]));
 const advances=d.expenses.filter(e=>!e.archived&&e.type==='員工借支'&&same(e.staffId||e.relatedStaffId,staffId)&&day(e.date)<=bounds.to&&!usedAdvances.has(String(e.id)));
 const charges=d.expenses.filter(e=>!e.archived&&e.staffCharge&&same(e.relatedStaffId,staffId)&&day(e.date)<=bounds.to&&!usedCharges.has(String(e.id)));
 const work=d.businessEvents.filter(e=>e.kind==='work'&&same(e.staffId,staffId)&&day(e.date).startsWith(month));
 const fixed=oldLock?Number(base.fixedPay??(Number(base.baseSalary||0)+Number(base.positionBonus||0)+Number(base.attendanceBonus||0))):person.salaryMode==='hourly'?work.reduce((n,e)=>n+e.amount,0):person.salaryMode==='commission'?0:Number(base.fixedPay||0);
 const gross=round(fixed+Number(base.serviceCommission||0)+Number(base.productCommission||0)+Number(base.assistantCommission||0)),advance=oldLock?Number(base.advanceTotal||0):round(advances.reduce((n,e)=>n+Number(e.amount),0)),charge=round(charges.reduce((n,e)=>n+Number(e.amount),0));
 return {sourceOrders:salarySources(d,staffId,month),sourceExpenses:[...advances,...charges].map(e=>JSON.stringify(e)).sort(),staffId:person.id,name:person.name,month,fixed,gross,advance,charge,net:round(gross-advance-charge),serviceCommission:base.serviceCommission||0,productCommission:base.productCommission||0,assistantCommission:base.assistantCommission||0,serviceRevenue:base.serviceRevenue||0,realRevenue:base.realRevenue,advanceIds:advances.map(e=>String(e.id)),chargeIds:charges.map(e=>String(e.id)),workIds:work.map(e=>e.id),legacyLock:!!oldLock};
}
function saveSalary(input){return transaction(d=>{
 if(activeSalaries(d).some(e=>e.month===input.month&&same(e.staffId,input.staffId)))throw Error('此人員本月已結算');if(d.settings.payrollLocks?.[input.month])throw Error('此月為舊薪資結算，請先完成舊帳銜接，不可重複發薪');assertLegacyReconciled(d,input.staffId,input.month);const key='salary:'+input.month+':'+input.staffId+':'+d.businessEvents.filter(e=>e.kind==='salary'&&e.month===input.month&&same(e.staffId,input.staffId)).length;const draft=salaryDraft(input.staffId,input.month,d);if(JSON.stringify(draft)!==input.expected)throw Error('薪資資料已變更，請重新試算');const adjustment=signed(input.adjustment||0);if(adjustment)reasonText(input.reason);
 return appendEvent(d,{...draft,id:key,kind:'salary',date:new Date().toISOString(),adjustment,reason:input.reason||'核對結算',net:round(draft.net+adjustment)});
});}
function paySalary(input){return transaction(d=>{const slip=d.businessEvents.find(e=>e.id===input.salaryId&&e.kind==='salary');if(!slip||!activeSalaries(d).some(e=>e.id===slip.id))throw Error('請先確認有效薪資條');const key='salary-pay:'+slip.id;if(d.businessEvents.some(e=>e.id===key))return;const date=validDay(input.date),method=reasonText(input.method);if(slip.net<0)throw Error('薪資為負數，請先核對更正');return appendEvent(d,{id:key,kind:'salaryPay',salaryId:slip.id,staffId:slip.staffId,date,amount:slip.net,method,reason:'薪資實際付款'}, {[DATA.expenses]:[...d.expenses,{id:key,date,amount:slip.net,type:'薪資發放',staffId:slip.staffId,salaryEventId:key,paymentMethod:method,note:slip.month+' '+slip.name}]});});}
function correctSalary(input){return transaction(d=>{if(d.businessEvents.some(e=>e.id===input.id))return;const slip=d.businessEvents.find(e=>e.id===input.salaryId&&e.kind==='salary');if(!slip||!d.businessEvents.some(e=>e.kind==='salaryPay'&&e.salaryId===slip.id))throw Error('本次更正限已付薪資');const amount=signed(input.amount);if(!amount)throw Error('請填補發正數或收回負數');const date=validDay(input.date),reason=reasonText(input.reason);return appendEvent(d,{id:input.id||id(),kind:'salaryCorrection',salaryId:slip.id,staffId:slip.staffId,date,amount,method:reasonText(input.method),reason});});}
function businessCash(d=all(),from='',to='9999-12-31'){
 const rows=[];for(const o of d.transactions){if(o.paymentMethod==='儲值金'||o.voided&&!o.receipt)continue;const r=orderReceipt(o);rows.push({id:'receipt:'+o.id,date:r.date,amount:r.amount,method:r.method,reason:'訂單收款',estimated:!!r.estimated,orderId:o.id});}
 for(const e of d.businessEvents)if(e.kind==='settlement'&&e.method!=='儲值金')rows.push(e);else if(e.kind==='salaryCorrection')rows.push({...e,amount:-e.amount,reason:'薪資更正 · '+e.reason});
 for(const e of d.walletEntries)if(['topup','withdraw'].includes(e.kind))rows.push({id:e.id,date:e.date,amount:e.principal??e.amount,method:e.paymentMethod,reason:e.kind==='withdraw'?'儲值本金退款':'儲值本金收款'});
 for(const e of d.expenses)if(!e.archived)rows.push({id:'expense:'+e.id,date:e.date,amount:-e.amount,reason:e.type,method:e.paymentMethod||'未記錄'});
 return rows.filter(e=>day(e.date)>=from&&day(e.date)<=to).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
}
function monthlyBusiness(month,d=all()){
 const {from,to}=monthBounds(month),tx=d.transactions.filter(t=>!t.voided&&day(t.date)>=from&&day(t.date)<=to),expenses=d.expenses.filter(e=>day(e.date)>=from&&day(e.date)<=to&&!e.archived);
 const f=financials(tx,expenses,d.stylists,d.settings,true);let salaryCost=0;
 for(const s of d.stylists){const saved=activeSalaries(d).find(e=>same(e.staffId,s.id)&&e.month===month);salaryCost+=saved?saved.gross+saved.adjustment:salaryDraft(s.id,month,d).gross;}
 const corrections=d.businessEvents.filter(e=>e.kind==='salaryCorrection'&&day(e.date).startsWith(month)).reduce((n,e)=>n+e.amount,0);salaryCost+=corrections;
 const loss=d.businessEvents.filter(e=>e.kind==='orderChange'&&!e.returnStock&&day(e.date).startsWith(month)).reduce((n,e)=>n+Number(e.returnedCost||0),0);
 const stockLoss=d.inventoryLogs.filter(e=>e.type==='盤點-'&&day(e.date).startsWith(month)).reduce((n,e)=>n+Number(e.cost||0)*Number(e.qty||0),0);
 const operating=expenses.filter(e=>!e.inventoryPurchase&&!e.salaryEventId&&!['進貨付款','員工借支','薪資發放'].includes(e.type)).reduce((n,e)=>n+Number(e.amount),0);
 const gift=d.walletEntries.filter(e=>e.kind==='consume'&&tx.some(t=>same(t.id,e.orderId))).reduce((n,e)=>{const refunded=d.walletEntries.filter(r=>r.kind==='refund'&&same(r.orderId,e.orderId)).reduce((a,r)=>a+Number(r.bonus||0),0);return n+Math.max(0,-Number(e.bonus||0)-refunded);},0);
 const cash=businessCash(d,from,to);return {...f,salaryCost:round(salaryCost),loss:round(loss+stockLoss),gift:round(gift),operatingExpense:round(operating),profit:round(f.revenue-f.cost-salaryCost-operating-loss-stockLoss-gift),cash:round(cash.reduce((n,e)=>n+Number(e.amount),0)),cashRows:cash,estimated:cash.some(e=>e.estimated)};
}
function validateBusiness(data){
 validateAccess(data.settings||{});
 const events=data.businessEvents||[],kinds=new Set(['orderChange','settlement','work','salary','salaryPay','salaryCorrection','salaryCancel','legacyPayroll']);
 for(const e of events){if(!kinds.has(e.kind)||!dateTime(e.date))throw Error('營運帳本種類或日期不完整');if(e.amount!==undefined)signed(e.amount);if(['orderChange','settlement'].includes(e.kind)&&!(data.transactions||[]).some(t=>same(t.id,e.orderId)))throw Error('營運帳本找不到原單');if(e.kind==='salary')for(const k of ['gross','net','advance','charge','adjustment'])signed(e[k]);}
 const cancelled=new Set(events.filter(e=>e.kind==='salaryCancel').map(e=>e.salaryId));if(cancelled.size!==events.filter(e=>e.kind==='salaryCancel').length)throw Error('薪資重複撤回');for(const e of events.filter(e=>e.kind==='salaryCancel')){if(!events.some(x=>x.id===e.salaryId&&x.kind==='salary')||events.some(x=>x.salaryId===e.salaryId&&x.kind==='salaryPay'))throw Error('已付或不存在的薪資不可撤回');}for(const slip of activeSalaries(data)){if(slip.sourceOrders&&JSON.stringify(slip.sourceOrders)!==JSON.stringify(salarySources(data,slip.staffId,slip.month)))throw Error('薪資確認後原單發生變更，請先撤回未付薪資再核對');if(slip.sourceExpenses){const current=(data.expenses||[]).filter(e=>(slip.advanceIds||[]).includes(String(e.id))||(slip.chargeIds||[]).includes(String(e.id))).map(e=>JSON.stringify(e)).sort();if(JSON.stringify(current)!==JSON.stringify(slip.sourceExpenses))throw Error('已抵扣借支或領料發生變更，請先核對薪資');}if((slip.workIds||[]).some(id=>!events.some(e=>e.kind==='work'&&e.id===id))||events.some(e=>e.kind==='work'&&same(e.staffId,slip.staffId)&&day(e.date).startsWith(slip.month)&&!(slip.workIds||[]).includes(e.id)))throw Error('薪資確認後工時發生變更，請重新核對');}const pays=new Set(),slips=new Set(),used=new Set();for(const e of events){if((e.kind==='salary'&&!cancelled.has(e.id))||e.kind==='legacyPayroll'){const key=e.month+':'+e.staffId;if(slips.has(key))throw Error('同人同月重複薪資結算');slips.add(key);for(const a of [...(e.advanceIds||[]),...(e.chargeIds||[])]){if(used.has(a))throw Error('借支或領料重複抵扣');used.add(a);}}if(e.kind==='salaryPay'){if(pays.has(e.salaryId))throw Error('薪資重複付款');pays.add(e.salaryId);const slip=events.find(s=>s.id===e.salaryId&&s.kind==='salary');if(!slip||slip.net!==e.amount)throw Error('薪資付款與結算不符');}}
 for(const t of data.transactions||[]){const due=businessDue(t,events);if(t.voided&&due>0.009)throw Error('退款超過已收金額');const versions=new Set();for(const e of events.filter(e=>e.kind==='settlement'&&same(e.orderId,t.id))){if(versions.has(e.version))throw Error('同一版訂單重複收退款');versions.add(e.version);}}
 const customers=new Set((data.walletEntries||[]).map(e=>String(e.customerId)));for(const c of customers){const p=walletParts(c,data.walletEntries);if(p.principal<-.009||p.bonus<-.009)throw Error('儲值本金或贈送金不能負值');}
 for(const e of data.walletEntries||[])if((e.principal!==undefined||e.bonus!==undefined)&&round(Number(e.principal||0)+Number(e.bonus||0))!==round(e.amount))throw Error('儲值本金與贈送金合計不符');
 return data;
}


function helperSnapshot(item,d){
 if(!Array.isArray(item.helpers))throw Error('協助分配格式錯誤');if(item.isProduct&&item.helpers.length)throw Error('商品不分配服務協助費');const seen=new Set();
 return item.helpers.map(h=>{const staff=d.stylists.find(s=>!s.archived&&same(s.id,h.id));if(!staff||same(staff.id,item.stylistId)||seen.has(String(staff.id)))throw Error('協助人員不可重複、停用或與主設計師相同');seen.add(String(staff.id));const amount=money(h.amount);return {id:staff.id,name:staff.name,amount};});
}
function activeSalaries(d=all()){const cancelled=new Set(d.businessEvents.filter(e=>e.kind==='salaryCancel').map(e=>e.salaryId));return d.businessEvents.filter(e=>e.kind==='salary'&&!cancelled.has(e.id));}
function cancelSalary(input){return transaction(d=>{const existing=d.businessEvents.find(e=>e.kind==='salaryCancel'&&e.salaryId===input.salaryId);if(existing)return existing;const salary=activeSalaries(d).find(e=>e.id===input.salaryId);if(!salary)throw Error('找不到有效薪資條');if(d.businessEvents.some(e=>e.kind==='salaryPay'&&e.salaryId===salary.id))throw Error('已付款薪資請以補發／收回更正');return appendEvent(d,{id:'cancel:'+salary.id,kind:'salaryCancel',salaryId:salary.id,staffId:salary.staffId,date:new Date().toISOString(),reason:reasonText(input.reason)});});}
function assertLegacyReconciled(d,staffId,month){for(const [m,lock] of Object.entries(d.settings.payrollLocks||{})){if(m<=month&&lock.rows?.some(s=>same(s.id,staffId))&&!d.businessEvents.some(e=>e.kind==='legacyPayroll'&&e.month===m&&same(e.staffId,staffId)))throw Error(m+' 舊薪資尚未銜接，請先核對已抵扣借支');}}
function reconcileLegacyPayroll(input){return transaction(d=>{const key='legacy-payroll:'+input.month+':'+input.staffId;if(d.businessEvents.some(e=>e.id===key))return;const lock=d.settings.payrollLocks?.[input.month],row=lock?.rows?.find(s=>same(s.id,input.staffId));if(!row||JSON.stringify(row)!==input.expected)throw Error('舊薪資資料已變更');const selected=new Set(input.advanceIds||[]),advances=d.expenses.filter(e=>selected.has(String(e.id)));if(advances.length!==selected.size||advances.some(e=>e.archived||e.type!=='員工借支'||!same(e.staffId||e.relatedStaffId,input.staffId)||day(e.date)>monthBounds(input.month).to))throw Error('借支選擇無效');if(round(advances.reduce((n,e)=>n+Number(e.amount),0))!==round(row.advanceTotal||0))throw Error('勾選借支合計必須等於舊結算借支');return appendEvent(d,{id:key,kind:'legacyPayroll',staffId:input.staffId,month:input.month,date:new Date().toISOString(),advanceIds:[...selected],chargeIds:[],reason:reasonText(input.reason),snapshot:row});});}

// Local shared-device controls. These do not replace server authentication.
const ACCESS_PERMISSIONS={pos:'收銀開單',orders:'查單與退款',customers:'顧客資料',wallet:'會員儲值',inventory:'庫存管理',report:'營運報表',salary:'全部薪資管理',ownSalary:'查看自己的薪資',staff:'人員管理',settings:'店家設定',backup:'備份與還原'};
let accessSession=null,accessTouched=0,accessFailures=0,accessUntil=0;
const accessNotify=()=>emit(PREFIX+'access');
function accessSettings(){const raw=localStorage.getItem(DATA.settings);return raw?codec.parse(raw):{};}
function accessCurrent(){const a=accessSettings().access;if(!a?.enabled)return null;const account=a.accounts?.find(x=>x.id===accessSession?.id&&!x.disabled&&x.hash===accessSession.hash);if(!account||Date.now()-accessTouched>15*60000)return null;return account;}
function accessAllowed(permission){if(!accessSettings().access?.enabled)return true;const a=accessCurrent();return !!a&&(a.role==='owner'||a.permissions.includes(permission));}
function accessRequire(permission){if(!accessAllowed(permission))throw Error('此帳號沒有「'+(ACCESS_PERMISSIONS[permission]||permission)+'」權限，請由店主登入處理');}
function accessLock(){accessSession=null;accessNotify();}
function accessTouch(){if(accessCurrent())accessTouched=Date.now();else if(accessSession)accessLock();}
async function accessHash(pin,salt){if(!/^\d{6,12}$/.test(pin))throw Error('PIN 請使用6至12位數字');if(!root.crypto?.subtle)throw Error('此瀏覽器不支援安全PIN，請更新瀏覽器');const enc=new TextEncoder(),key=await crypto.subtle.importKey('raw',enc.encode(pin),'PBKDF2',false,['deriveBits']);const bytes=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:210000,salt:enc.encode(salt)},key,256);return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
async function accessLogin(accountId,pin){if(Date.now()<accessUntil)throw Error('錯誤次數過多，請一分鐘後重試');const account=all().settings.access?.accounts?.find(a=>a.id===accountId&&!a.disabled);let correct=false;try{correct=!!account&&await accessHash(pin,account.salt)===account.hash;}catch{}if(!correct){if(++accessFailures>=5){accessUntil=Date.now()+60000;accessFailures=0;}throw Error('帳號或PIN不正確');}if(!all().settings.access.accounts.some(a=>a.id===account.id&&!a.disabled&&a.hash===account.hash))throw Error('帳號已更新，請重新登入');accessSession={id:account.id,hash:account.hash};accessTouched=Date.now();accessFailures=0;accessNotify();return {id:account.id,name:account.name,role:account.role};}
function validateAccess(settings){const a=settings.access;if(!a)return;if(!Array.isArray(a.accounts)||new Set(a.accounts.map(x=>x.id)).size!==a.accounts.length||a.accounts.some(x=>!x.id||!x.name||!x.salt||!/^[a-f0-9]{64}$/.test(x.hash)||!['owner','staff'].includes(x.role)||!Array.isArray(x.permissions)||x.permissions.some(p=>!ACCESS_PERMISSIONS[p])))throw Error('帳號權限資料格式錯誤');if(a.enabled&&!a.accounts.some(x=>x.role==='owner'&&!x.disabled))throw Error('至少需要一個可登入的店主帳號');}
async function accessAccount(input){const before=JSON.stringify(all().settings.access||null),wasEnabled=all().settings.access?.enabled;if(wasEnabled&&accessCurrent()?.role!=='owner')throw Error('只有店主可以管理帳號');const salt=input.pin?crypto.randomUUID():null,hash=input.pin?await accessHash(input.pin,salt):null;let created;await transaction(d=>{if(JSON.stringify(d.settings.access||null)!==before)throw Error('帳號資料已變更，請重新核對');if(wasEnabled&&accessCurrent()?.role!=='owner')throw Error('請重新登入店主');const accounts=d.settings.access?.accounts||[],old=accounts.find(a=>a.id===input.id);if(!old&&!hash)throw Error('建立帳號需要PIN');const account={...old,id:old?.id||id(),name:reasonText(input.name||old?.name),role:old?.role||(wasEnabled?'staff':'owner'),staffId:input.staffId??old?.staffId??'',permissions:input.permissions??old?.permissions??[],disabled:input.disabled??old?.disabled??false,...(hash?{salt,hash}:{})};if(account.permissions.includes('ownSalary')&&!d.stylists.some(s=>same(s.id,account.staffId)))throw Error('查看個人薪資需指定對應人員');const access={enabled:true,accounts:old?accounts.map(a=>a.id===old.id?account:a):[...accounts,account]};validateAccess({access});atomic({[DATA.settings]:{...d.settings,access}});created=account;});if(!wasEnabled||accessSession?.id===created.id){accessSession={id:created.id,hash:created.hash};accessTouched=Date.now();}accessNotify();return created;}
function accessCheckWrite(d,after){const nextSettings=after[DATA.settings];if(nextSettings){validateAccess(nextSettings);if(d.settings.access?.enabled&&JSON.stringify(nextSettings.access)!==JSON.stringify(d.settings.access)&&accessCurrent()?.role!=='owner')throw Error('只有店主可以更改帳號權限');}if(!d.settings.access?.enabled)return;
 const changed=k=>k in after&&JSON.stringify(after[k])!==JSON.stringify(d[Object.keys(DATA).find(n=>DATA[n]===k)]);
 const newEvents=(after[DATA.businessEvents]||[]).filter(e=>!d.businessEvents.some(x=>x.id===e.id));let action='';if(newEvents.length){action=newEvents.every(e=>['orderChange','settlement'].includes(e.kind))?'orders':'salary';accessRequire(action);}
 const newOrders=(after[DATA.transactions]||[]).filter(t=>!d.transactions.some(o=>o.id===t.id));if(changed(DATA.transactions)&&!action){action=newOrders.length?'pos':'orders';accessRequire(action);}
 for(const [key,permission]of [[DATA.customers,'customers'],[DATA.services,'inventory'],[DATA.inventoryLogs,'inventory'],[DATA.walletEntries,'wallet'],[DATA.expenses,'report'],[DATA.stylists,'staff'],[DATA.settings,'settings'],[DATA.pendingOrders,'pos']]){if(changed(key)&&!(['pos','orders'].includes(action)&&[DATA.customers,DATA.services,DATA.inventoryLogs,DATA.walletEntries].includes(key))&&!(action==='salary'&&key===DATA.expenses))accessRequire(permission);}
}
root.SalonAccess={permissions:ACCESS_PERMISSIONS,current:accessCurrent,allowed:accessAllowed,require:accessRequire,login:accessLogin,lock:accessLock,touch:accessTouch,account:accessAccount,subscribe:fn=>subscribe(PREFIX+'access',fn)};

function scheduleCloud(){clearTimeout(cloudTimer);const settings=read(DATA.settings,{});if(settings.autoSync!==false&&settings.shopID&&settings.syncToken){status('pending','已存本機 · 等待安全同步');cloudTimer=setTimeout(()=>cloudSync().catch(()=>{}),4000);return;}if(!settings.autoCloudBackup){status('pending','已存本機 · 自動同步已關閉');return;}status('pending','資料已存本機，等待背景備份');cloudTimer=setTimeout(()=>cloudBackup(read(DATA.settings,{})).catch(()=>{}),4000);}
root.addEventListener?.('storage',e=>{if(e.key){cache.delete(e.key);emit(e.key);}else for(const key of listeners.keys()){cache.delete(key);emit(key);}});
root.addEventListener?.('salon-local-update',e=>{cache.delete(e.key);emit(e.key);});
root.addEventListener?.('online',()=>{scheduleCloud();});
Object.assign(root,{SalonStore:{DATA,DRAFT,PREFIX,read,subscribe,set,all,atomic,transaction,checkout,savePending,inventory,reviseOrder,money,day,dateTime,itemCost,draftSave,draftRead,backupPayload:()=>{accessRequire('backup');return backupPayload();},validateBackup,restore:data=>{accessRequire('backup');return restore(data);},cloudBackup,cloudDownload,cloudVersions,cloudSync,startSync,mergeData,versionTips,financials,lineFinancials,walletBalance,walletTopup,walletAdjust,walletOwnerId,claimWalletDevice,helperSnapshot,activeSalaries,cancelSalary,reconcileLegacyPayroll,vipDiscount,businessOrder,settleOrder,businessDue,orderReceipt,businessCash,recordWork,saveSalary,paySalary,correctSalary,salaryDraft,monthlyBusiness,walletParts,validateBusiness,cloudSubscribe,cloudSnapshot:()=>cloudState}});
})(window);
