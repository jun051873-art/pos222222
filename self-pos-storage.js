/* Versioned, lossless local storage codec. Legacy plain JSON remains readable. */
(function(root){
'use strict';
const MARK='salon-local-gzip-v1:',MAX=32*1024*1024;
function parse(raw){
 if(!raw.startsWith(MARK))return JSON.parse(raw);
 if(!root.fflate)throw Error('本機解壓縮元件未載入，請重新整理；不要清除網站資料');
 const envelope=JSON.parse(raw.slice(MARK.length));
 if(!Number.isSafeInteger(envelope.bytes)||envelope.bytes<1||envelope.bytes>MAX)throw Error('本機壓縮資料大小異常，請保留資料並聯絡支援');
 const zip=Uint8Array.from(atob(envelope.data),c=>c.charCodeAt(0));
 const out=root.fflate.gunzipSync(zip,{out:new Uint8Array(envelope.bytes)});
 return JSON.parse(root.fflate.strFromU8(out));
}
function stringify(value){
 const raw=JSON.stringify(value);if(raw.length<32768||!root.fflate)return raw;
 const bytes=root.fflate.strToU8(raw);if(bytes.length>MAX)throw Error('本機單筆資料過大，請先下載備份並聯絡支援');
 const zip=root.fflate.gzipSync(bytes,{level:1});let binary='';
 for(let i=0;i<zip.length;i+=8192)binary+=String.fromCharCode(...zip.subarray(i,i+8192));
 const packed=MARK+JSON.stringify({bytes:bytes.length,data:btoa(binary)});
 if(packed.length>=raw.length)return raw;
 if(JSON.stringify(parse(packed))!==raw)throw Error('本機壓縮核對失敗，未寫入資料');
 return packed;
}
root.SalonStorageCodec={parse,stringify};
})(typeof window!=='undefined'?window:globalThis);
