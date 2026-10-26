/* Startup recovery only. No farm commands, user data or automatic reloads. */
(()=>{
 'use strict';
 let ready=false,failed=false;
 function fail(){
  if(ready)return;
  failed=true;
  const title=document.querySelector('#boot-title'),status=document.querySelector('#boot-status');
  if(title)title.textContent='页面暂时未能打开';
  if(status)status.textContent='页面资源未能完整加载，请检查网络后重新加载。';
 }
 const timeout=setTimeout(fail,15000);
 window.FarmBoot=Object.freeze({
  fail,
  ready(){ready=true;clearTimeout(timeout);},
 });
 window.addEventListener('error',event=>{
  if(event.target?.tagName==='SCRIPT'||event.error)fail();
 },true);
 window.addEventListener('unhandledrejection',()=>{if(!ready)fail();});
 document.addEventListener('DOMContentLoaded',()=>{if(failed||!ready)fail();});
})();
