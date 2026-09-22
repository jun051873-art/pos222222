/* Aether self-use bridge. No credentials, cloud writes or automatic checkout. */
(function(root){
'use strict';
const PREFIX='aether-pos-transfer-v1:',receiptPrefix=PREFIX+'receipt:',packetPrefix=PREFIX+'packet:';
const read=(key,fallback)=>{const s=localStorage.getItem(key);if(s===null)return fallback;try{return JSON.parse(s);}catch{throw Error('資料格式異常，請先備份並停止匯入：'+key);}};
const money=v=>{if(v===null||v===undefined||v==='')throw Error('請填寫金額');const n=Number(v);if(!Number.isFinite(n)||n<0||n>1e7||Math.abs(n*100-Math.round(n*100))>.00001)throw Error('金額需為有效數字，最多兩位小數');return Math.round(n*100);};
const norm=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
const sameName=(list,name)=>{const a=list.filter(x=>norm(x.name)===norm(name));return a.length===1?a[0].id:'';};
function validate(p){if(!p||p.format!=='aether-pos-transfer-1'||!/^aether-[a-f0-9]{64}$/.test(p.id)||typeof p.source!=='string'||!p.source||typeof p.appointmentId!=='string'||!p.appointmentId||!/^\d{4}-\d{2}-\d{2}$/.test(p.date)||!/^\d{2}:\d{2}$/.test(p.time)||typeof p.name!=='string'||!p.name.trim()||!Array.isArray(p.services)||!p.services.length||!Array.isArray(p.methods)||!p.stylist||!Number.isInteger(p.people)||p.people<1)throw Error('預約資料不完整，請回預約表核對');const dt=new Date(p.date+'T'+p.time+':00+08:00');if(!Number.isFinite(dt.getTime())||Number(p.time.slice(0,2))>23||Number(p.time.slice(3))>59)throw Error('日期或時間不正確');money(p.amount);money(p.paid);if(p.paid>p.amount)throw Error('已收款不能超過服務金額');return p;}
const comparable=p=>JSON.stringify([p.source,p.appointmentId,p.date,p.time,p.name,p.stylist,p.services,p.methods,p.amount,p.paid,p.people]);
const packets=()=>Object.keys(localStorage).filter(k=>k.startsWith(packetPrefix)).map(k=>read(k,null)).filter(Boolean).sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
function send(p){validate(p);const old=read(packetPrefix+p.id,null),r=read(receiptPrefix+p.id,null);if(r&&r.status==='posted'){if(old&&comparable(old)!==comparable(p))throw Error('這筆已入帳，內容已變更，請到開單系統核對原單；不會重複新增');return 'posted';}localStorage.setItem(packetPrefix+p.id,JSON.stringify(p));return 'queued';}
const receipt=id=>read(receiptPrefix+id,null);
const storeKey=s=>norm(s.shopID);
function plan(p,rows,method,staff,services,settings,transactions,ack){validate(p);if(!storeKey(settings))throw Error('請先在開單系統設定並核對店號');if(!ack)throw Error('請確認目的店號、項目、人員與原有單據');if(p.people!==1)throw Error('多人預約請先拆成個人單核對，避免服務客次統計失真');if(money(p.amount)!==money(p.paid))throw Error('這筆尚未全額收款；目前開單報表會將全額視為收款，請先在預約表核對');if(!rows.length)throw Error('請選擇服務項目');if(p.methods.length>1)throw Error('多種付款方式尚未核對，請勿直接匯入');if(!['現金','信用卡','街口支付','LINE Pay','轉帳'].includes(method))throw Error('請選擇付款方式');const st=staff.find(x=>x.id===rows[0].stylistId);if(!st)throw Error('請選擇對應人員');
 let total=0;const items=rows.map((r,i)=>{const def=services.find(s=>s.id===r.serviceId);if(!def)throw Error('請為每一列選擇對應服務');if(def.isProduct)throw Error('商品涉及庫存，此入口僅匯入服務；商品請在開單系統另行核對');const price=money(r.amount);total+=price;const cost=Number(def.cost||0);if(!Number.isFinite(cost)||cost<0||cost>100)throw Error(def.name+'的材料費不是0–100%的數值，請先核對服務設定，避免抽成算錯');return {...def,cartId:p.id+'-'+i,price:price/100,discount:0,cost,stylistId:st.id,stylistName:st.name,assistantId:'',assistantName:'',isDesignated:true};});if(total!==money(p.amount))throw Error('各項拆分金額合計必須等於預約金額');
 const exact=transactions.find(t=>t.id===p.id||t.sourceAppointment?.id===p.id);const possible=transactions.filter(t=>t.id!==p.id&&!t.sourceAppointment&&String(t.date||'').slice(0,10)===p.date&&norm(t.customerName)===norm(p.name)&&money(t.total)===total);
 return {exact,possible,order:{id:p.id,date:p.date+'T'+p.time+':00+08:00',items,total:total/100,paymentMethod:method,mainStylistId:st.id,customerId:null,customerName:p.name,customerGender:'未填寫',createdAt:new Date().toISOString(),sourceAppointment:{id:p.id,source:p.source,appointmentId:p.appointmentId,date:p.date,people:p.people,fingerprint:comparable(p)},bridgeShop:storeKey(settings)}};
}
async function post(p,rows,method,ack,linkedId=''){
 if(!navigator.locks)throw Error('此瀏覽器不支援安全匯入鎖定，請使用新版 Chrome／Safari');
 return navigator.locks.request('salon_transactions-write',async()=>{
 const settings=read('salon_settings',{}),tx=read('salon_transactions',[]),staff=read('salon_stylists',[]),services=read('salon_services',[]);if(!Array.isArray(tx))throw Error('單據資料異常');
 if(linkedId){validate(p);if(!ack||!storeKey(settings))throw Error('請先確認店號與原單');const target=tx.find(t=>t.id===linkedId);if(!target||target.sourceAppointment||String(target.date||'').slice(0,10)!==p.date||norm(target.customerName)!==norm(p.name)||money(target.total)!==money(p.amount))throw Error('原單與預約不相符，請重新核對');if(tx.some(t=>t.id===p.id||t.sourceAppointment?.id===p.id)||receipt(p.id)?.status==='posted')throw Error('這筆已經入帳或對應，不會重複處理');const next=tx.map(t=>t.id===linkedId?{...t,sourceAppointment:{id:p.id,source:p.source,appointmentId:p.appointmentId,fingerprint:comparable(p)},bridgeShop:storeKey(settings)}:t);localStorage.setItem(PREFIX+'last-pos-backup',JSON.stringify({at:new Date().toISOString(),transactions:tx}));localStorage.setItem('salon_transactions',JSON.stringify(next));localStorage.setItem(receiptPrefix+p.id,JSON.stringify({status:'posted',orderId:linkedId,shop:settings.shopID}));if(typeof window!=='undefined')window.dispatchEvent(new StorageEvent('salon-local-update',{key:'salon_transactions'}));return {status:'linked',orderId:linkedId,added:0};}
 const result=plan(p,rows,method,staff,services,settings,tx,ack),r=receipt(p.id);
 if(result.exact){if(result.exact.sourceAppointment?.fingerprint!==comparable(p))throw Error('此預約已入帳且內容不同，請查原單，禁止重複新增');localStorage.setItem(receiptPrefix+p.id,JSON.stringify({status:'posted',orderId:result.exact.id,shop:settings.shopID}));return {status:'existing',orderId:result.exact.id,added:0};}
 if(r?.status==='posted')throw Error('此預約曾入帳，但原單目前不在本機。請先還原最新POS備份，不會自動重建');
 const orderId=p.id;if(result.possible.length)throw Error('有同日、同名、同金額的既有單據，請先選擇對應原單，避免重複入帳');const next=[result.order,...tx];
 // One authoritative order write. Receipt can be reconstructed from order metadata after a crash.
 localStorage.setItem(PREFIX+'last-pos-backup',JSON.stringify({at:new Date().toISOString(),transactions:tx}));
 localStorage.setItem('salon_transactions',JSON.stringify(next));
 localStorage.setItem(receiptPrefix+p.id,JSON.stringify({status:'posted',orderId,shop:settings.shopID,at:new Date().toISOString()}));
 if(typeof window!=='undefined')window.dispatchEvent(new StorageEvent('salon-local-update',{key:'salon_transactions'}));return {status:'created',orderId,added:result.order.total};
 });
}
const api={PREFIX,read,money,norm,sameName,validate,packets,send,receipt,plan,post,comparable,storeKey};root.AetherPosBridge=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
