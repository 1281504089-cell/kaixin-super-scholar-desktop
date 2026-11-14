const assert=require('node:assert/strict');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Observe the existing production <audio>; do not replace it or its source.
async function arm(selector,expectedUrl) {
  const audio=document.querySelector(selector);
  if(!(audio instanceof HTMLAudioElement)||!audio.controls||!audio.getBoundingClientRect().height)throw Error('Missing visible production audio controls');
  if(new URL(audio.currentSrc||audio.src,location.href).href!==new URL(expectedUrl,location.href).href)throw Error('Wrong production audio source');
  const result=window.__nativeAudioCard={events:[],error:null,done:false,graphPeak:0,controlClickIssued:false,source:audio.currentSrc||audio.src};
  const response=await fetch(result.source);
  if(!response.ok)throw Error('Audio HTTP '+response.status);
  const bytes=await response.arrayBuffer();
  if(!bytes.byteLength||bytes.byteLength>20*1024**2)throw Error('Invalid QA audio byte size');
  result.bytes=bytes.byteLength;
  result.sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
  const context=new AudioContext();
  const decoded=await context.decodeAudioData(bytes.slice(0));
  let peak=0,sum=0,samples=0;
  for(let c=0;c<decoded.numberOfChannels;c++)for(const v of decoded.getChannelData(c)){peak=Math.max(peak,Math.abs(v));sum+=v*v;samples++;}
  result.decoded={duration:decoded.duration,sampleRate:decoded.sampleRate,channels:decoded.numberOfChannels,peak,rms:Math.sqrt(sum/samples)};
  let timer,stream;
  const finish=()=>{clearInterval(timer);result.finalTime=audio.currentTime;result.duration=audio.duration;result.done=true;stream?.getTracks().forEach(t=>t.stop());void context.close();};
  for(const type of ['play','playing','timeupdate','pause','waiting','stalled','ended','error'])audio.addEventListener(type,async()=>{
    result.events.push({type,time:performance.now(),currentTime:audio.currentTime,readyState:audio.readyState,networkState:audio.networkState});
    if(type==='playing'&&!timer){
      try {
        // The monitoring branch is muted to avoid duplicate sound; the original
        // production element remains unmuted and keeps its normal output path.
        stream=audio.captureStream();
        const analyser=context.createAnalyser(),gain=context.createGain();gain.gain.value=0;
        context.createMediaStreamSource(stream).connect(analyser);analyser.connect(gain);gain.connect(context.destination);
        await context.resume();const values=new Float32Array(analyser.fftSize);
        timer=setInterval(()=>{analyser.getFloatTimeDomainData(values);for(const v of values)result.graphPeak=Math.max(result.graphPeak,Math.abs(v));},20);
      }catch(e){result.monitorError={name:e.name,message:e.message};}
    }
    if(type==='error'){result.error={code:audio.error?.code,message:audio.error?.message};finish();}
    if(type==='ended')finish();
  });
  const r=audio.getBoundingClientRect();
  return {x:Math.round(r.left+Math.min(26,r.width/5)),y:Math.round(r.top+r.height/2)};
}

module.exports=async function verifyProductionAudioCard(contents,{selector,expectedUrl,expectedSha256,timeoutMs=25000}) {
  assert.match(expectedSha256,/^[a-f0-9]{64}$/);
  const point=await contents.executeJavaScript(`(${arm.toString()})(${JSON.stringify(selector)},${JSON.stringify(expectedUrl)})`,true);
  contents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  contents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  await contents.executeJavaScript('window.__nativeAudioCard.controlClickIssued=true');
  const deadline=Date.now()+timeoutMs;
  while(!await contents.executeJavaScript('window.__nativeAudioCard.done')&&Date.now()<deadline)await pause(100);
  const result=await contents.executeJavaScript('window.__nativeAudioCard');
  assert.equal(result.sha256,expectedSha256,'Saved/generated audio bytes differ');
  assert.equal(result.error,null,JSON.stringify(result.error));
  assert.ok(result.events.some(e=>e.type==='playing')&&result.events.some(e=>e.type==='ended'),'Actual production control did not play to completion');
  assert.ok(result.finalTime>=result.duration-0.3&&result.finalTime>=0.5);
  assert.ok(result.decoded.rms>0.001&&result.decoded.peak>0.01,'Silent decode');
  assert.ok(result.graphPeak>0.01,`Production playback capture was silent: ${JSON.stringify(result.monitorError)}`);
  return {...result,productionElementObserved:true,physicalSpeakerOrLoopbackCaptured:false};
};
