const {app,BrowserWindow}=require('electron');
const {readFile,writeFile,mkdir}=require('node:fs/promises');
const {createServer}=require('node:http');
const path=require('node:path');
const {pcm16Stats,assertPlayback}=require('./audio-checks.cjs');
const assert=require('node:assert/strict');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const out=path.resolve(process.env.KX_AUDIO_EVIDENCE||'audio-evidence');
app.setPath('userData',path.join(out,'isolated-profile'));
app.commandLine.appendSwitch('enable-logging','stderr');
app.commandLine.appendSwitch('vmodule','*audio*=2,*speech*=2');
function renderer() {
  window.results={player:{events:[],error:null,playResolved:false,graphPeak:0,done:false},speech:{events:[],done:false}};
  const audio=document.querySelector('audio'),result=window.results.player;
  let analyser,context,timer;
  for(const type of ['loadstart','loadedmetadata','canplay','play','playing','waiting','stalled','timeupdate','ended','pause','error']) audio.addEventListener(type,()=>{
    result.events.push({type,time:performance.now(),currentTime:audio.currentTime,readyState:audio.readyState,networkState:audio.networkState});
    if(type==='error') {result.error={code:audio.error?.code,message:audio.error?.message};finish();}
    if(type==='ended')finish();
  });
  function finish(){clearInterval(timer);result.finalTime=audio.currentTime;result.duration=audio.duration;result.done=true;document.querySelector('#status').textContent=JSON.stringify(result);}
  document.querySelector('#play').onclick=async()=>{
    try {
      context=new AudioContext();
      const buffer=await context.decodeAudioData(await (await fetch('/speech.wav')).arrayBuffer());
      let peak=0,sum=0,samples=0;
      for(let c=0;c<buffer.numberOfChannels;c++)for(const v of buffer.getChannelData(c)){peak=Math.max(peak,Math.abs(v));sum+=v*v;samples++;}
      result.decoded={sampleRate:buffer.sampleRate,duration:buffer.duration,channels:buffer.numberOfChannels,peak,rms:Math.sqrt(sum/samples)};
      analyser=context.createAnalyser();analyser.fftSize=2048;
      context.createMediaElementSource(audio).connect(analyser);analyser.connect(context.destination);
      await context.resume();result.audioContextState=context.state;
      const values=new Float32Array(analyser.fftSize);
      timer=setInterval(()=>{analyser.getFloatTimeDomainData(values);for(const v of values)result.graphPeak=Math.max(result.graphPeak,Math.abs(v));},20);
      await audio.play();result.playResolved=true;
    }catch(e){result.error={name:e.name,code:e.code,message:e.message};finish();}
  };
  document.querySelector('#speech').onclick=()=>{
    const s=window.results.speech; s.localVoices=speechSynthesis.getVoices().filter(v=>v.localService).map(v=>({name:v.name,lang:v.lang}));
    const u=new SpeechSynthesisUtterance('This is an English listening test.');u.lang='en-US';
    const voice=speechSynthesis.getVoices().find(v=>v.localService&&v.lang.startsWith('en'));if(voice)u.voice=voice;
    s.selectedVoice=voice?{name:voice.name,lang:voice.lang}:null;
    for(const type of ['start','end','error'])u.addEventListener(type,e=>{s.events.push({type,error:e.error,message:e.message,elapsedTime:e.elapsedTime,charIndex:e.charIndex,time:performance.now()});if(type==='end'||type==='error')s.done=true;});
    window.currentUtterance=u;speechSynthesis.speak(u);
  };
  speechSynthesis.getVoices();
}
async function click(contents,selector) {
  const p=await contents.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  contents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});contents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});
}
app.whenReady().then(async()=>{
  await mkdir(out,{recursive:true});
  const fixture=JSON.parse(await readFile(path.join(__dirname,'spoken-fixture.json'),'utf8'));
  const bytes=process.env.KX_AUDIO_FILE?await readFile(process.env.KX_AUDIO_FILE):Buffer.from(fixture.base64,'base64');
  const stats=pcm16Stats(bytes);
  const report={platform:process.platform,arch:process.arch,electron:process.versions.electron,chromium:process.versions.chrome,fixture:stats,
    source:process.env.KX_AUDIO_FILE||fixture.generator,synthesizedNotOriginal:true,physicalSpeakerOrLoopbackCaptured:false,passed:false};
  let server,window;
  try {
    server=createServer((req,res)=>{
      if(req.url==='/speech.wav'){res.setHeader('Content-Type','audio/wav');res.setHeader('Content-Length',bytes.length);res.end(bytes);return;}
      res.setHeader('Content-Type','text/html;charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>Native audio diagnostic</title><h1>真实语音文件播放探针</h1><button id="play" style="padding:16px">播放真实语音文件</button><audio controls src="/speech.wav"></audio><button id="speech" style="padding:16px">系统朗读诊断</button><pre id="status"></pre><script>(${renderer.toString()})();</script>`);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    window=new BrowserWindow({width:1100,height:760,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    window.webContents.on('console-message',(_event,_level,message)=>console.log('renderer:',message));
    await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
    await click(window.webContents,'#play');
    const deadline=Date.now()+20000;
    while(!await window.webContents.executeJavaScript('window.results.player.done')&&Date.now()<deadline)await pause(100);
    report.player=await window.webContents.executeJavaScript('window.results.player');
    await click(window.webContents,'#speech');
    const speechDeadline=Date.now()+15000;
    while(!await window.webContents.executeJavaScript('window.results.speech.done')&&Date.now()<speechDeadline)await pause(100);
    report.speech=await window.webContents.executeJavaScript('window.results.speech');
    report.speech.timeout=!report.speech.done;
    try { report.environment=JSON.parse((await readFile(path.join(out,'windows-environment.json'),'utf8')).replace(/^\uFEFF/,'')); } catch {}
    await writeFile(path.join(out,'native-player.png'),(await window.webContents.capturePage()).toPNG());
    assertPlayback(report.player);report.mediaPipelinePassed=true;
    if(process.platform==='win32') {
      assert.ok(report.environment,'Missing actual Windows audio inventory');
      assert.ok(report.environment.waveOutDeviceCount>0 && report.environment.waveMapperFormatQueryCode===0,'No usable Windows output device; playback events alone are not an environment pass');
    }
    report.passed=true;
  }catch(e){report.failure={name:e.name,message:e.message,stack:e.stack};process.exitCode=1;}
  finally {
    await writeFile(path.join(out,'native-audio-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
    window?.destroy();server?.close();app.exit(report.passed?0:1);
  }
}).catch(e=>{console.error(e);app.exit(1);});
