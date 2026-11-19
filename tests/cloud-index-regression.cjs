const assert=require('node:assert/strict');
const {fixture,server}=require('./fixtures.cjs');
(async()=>{
const f=fixture(),S=f.store,payload=S.backupPayload(),srv=server(f,payload);
const remote={...payload,customers:[...payload.customers,{id:'new-device-customer',name:'測試雲端新增客',visits:0,totalSpend:0}]};
srv.versions.set('v-new',{name:'projects/test/documents/Backups/v-new',createTime:'2026-10-14T00:00:00.000Z',updateTime:'2026-10-14T00:00:00.000Z',fields:{content:{stringValue:JSON.stringify(remote)},parentVersion:{stringValue:'legacy:base'}}});
const fetchFixture=f.ctx.fetch,requests=[];
f.ctx.fetch=async(raw,opt={})=>{
 const u=new URL(raw);requests.push([u.pathname,opt.method||'GET',u.searchParams.toString()]);
 if(u.searchParams.has('orderBy'))return {ok:false,status:400,json:async()=>({error:{message:'The query requires an index. You can create it here: https://console.firebase.google.com/example'}})};
 return fetchFixture(raw,opt);
};
const cloudBefore=JSON.stringify([...srv.versions]),localBefore=JSON.stringify(S.all());
const downloaded=await S.cloudDownload(S.all().settings);
assert.ok(downloaded.customers.some(c=>c.id==='new-device-customer'));
assert.equal(JSON.stringify(S.all()),localBefore,'download cannot change local data before confirmation');
assert.equal(JSON.stringify([...srv.versions]),cloudBefore);
await S.restore(downloaded);
assert.ok(S.all().customers.some(c=>c.id==='new-device-customer'));
assert.equal(srv.writes.length,0,'restore itself cannot upload');
await S.cloudSync(true);
assert.equal(JSON.stringify(srv.versions.get('v-new').fields.content.stringValue),JSON.stringify(JSON.stringify(remote)),'sync cannot overwrite the restored version');
const listing=requests.filter(([path])=>path.endsWith('/Backups'));assert.ok(listing.length>0);
assert.ok(listing.every(([,verb,q])=>verb==='GET'&&!new URLSearchParams(q).has('orderBy')));
console.log('PASS restore and sync work when descending-name queries require an index; cloud untouched');
})().catch(e=>{console.error(e);process.exitCode=1});
