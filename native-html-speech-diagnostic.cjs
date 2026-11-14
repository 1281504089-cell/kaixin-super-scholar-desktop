const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Keep the historical HTML action as a diagnostic; failure text is never playback proof.
module.exports=async function diagnoseHtmlSpeech(frame) {
  await frame.executeJavaScript(`(()=>{
    const d=window.__htmlSpeechDiagnostic={available:typeof speechSynthesis==='object',events:[],status:'',done:false};
    if(!d.available){d.done=true;return;}
    d.original=speechSynthesis.speak;
    speechSynthesis.speak=function(u){
      d.language=u.lang;d.voice=u.voice?{name:u.voice.name,lang:u.voice.lang,local:u.voice.localService}:null;
      for(const type of ['start','end','error'])u.addEventListener(type,e=>{
        d.events.push({type,error:e.error,message:e.message,elapsedTime:e.elapsedTime,charIndex:e.charIndex});
        if(type==='end'||type==='error')d.done=true;
      });
      return d.original.call(this,u);
    };
    speechSynthesis.getVoices();
  })()`,true);
  try {
    await frame.executeJavaScript(`document.querySelector('[data-ks-action="one"]').click()`,true);
    const deadline=Date.now()+15000;
    while(!await frame.executeJavaScript('window.__htmlSpeechDiagnostic.done')&&Date.now()<deadline)await pause(100);
    return await frame.executeJavaScript(`(()=>{
      const d=window.__htmlSpeechDiagnostic;
      return {available:d.available,events:d.events,language:d.language,voice:d.voice,
        timedOut:!d.done,observedStatus:document.querySelector('[data-ks-status]')?.textContent||'',
        localVoices:typeof speechSynthesis==='object'?speechSynthesis.getVoices().filter(v=>v.localService).map(v=>({name:v.name,lang:v.lang})):[],
        nativeEnded:d.events.some(e=>e.type==='end'),physicalSpeakerOrLoopbackCaptured:false};
    })()`);
  }finally {
    await frame.executeJavaScript(`(()=>{const d=window.__htmlSpeechDiagnostic;if(d?.original){speechSynthesis.cancel();speechSynthesis.speak=d.original;}})()`);
  }
};
