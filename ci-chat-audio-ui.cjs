// Run against the real updated renderer and persisted production attachment card.
const assert = require('node:assert/strict');
const {writeFile} = require('node:fs/promises');
const path = require('node:path');
const verifyCard = require('./audio-card-probe.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function verifyChatAudio(view, evidence, seed) {
  const js = (fn, ...args) => view.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
  async function wait(code, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (!await view.executeJavaScript(code)) {
      assert.ok(Date.now() < deadline, label);
      await pause(100);
    }
  }
  async function click(selector) {
    const p = await js(selector => {
      const node = document.querySelector(selector);
      if (!node) throw Error('Missing real action: ' + selector);
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height) throw Error('Action not visible: ' + selector);
      return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
    }, selector);
    view.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});
    view.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});
  }
  const origin = new URL(view.getURL()).origin;
  const url = `${origin}/chat/${encodeURIComponent(seed.session_id)}?dt_workspace=`;
  const message = `[data-chat-message-id="${seed.message_id}"][data-chat-message-role="assistant"]`;
  const player = message + ' audio[controls]';
  const proof = {productionCards:[],selection:{},passed:false,physicalSpeakerOrLoopbackCaptured:false};
  try {
    await view.loadURL(url);
    await wait(`Boolean(document.querySelector(${JSON.stringify(player)})?.offsetHeight)`, 'Persisted production audio card missing');
    await js(selector => document.querySelector(selector).scrollIntoView({block:'center'}), player);
    proof.productionCards.push(await verifyCard(view, {selector:player,expectedUrl:seed.url,expectedSha256:seed.sha256}));
    await writeFile(path.join(evidence,'chat-audio-card.png'), (await view.capturePage()).toPNG());
    // Re-enter through a fresh document: no in-memory event/attachment can supply this card.
    await view.loadURL(origin + '/chat?dt_workspace=');
    await view.loadURL(url);
    await wait(`Boolean(document.querySelector(${JSON.stringify(player)})?.offsetHeight)`, 'Audio missing after reopening history');
    await js(selector => document.querySelector(selector).scrollIntoView({block:'center'}), player);
    proof.productionCards.push(await verifyCard(view, {selector:player,expectedUrl:seed.url,expectedSha256:seed.sha256}));

    await js(() => {
      const q = window.__selectedSpeech = {posts:[],sends:[],plays:[],fault:false};
      const originalFetch = window.fetch.bind(window), originalSend = WebSocket.prototype.send, originalPlay = HTMLMediaElement.prototype.play;
      const armed = new WeakSet();
      window.fetch = async (...args) => {
        const url = String(args[0]);
        if (args[1]?.method === 'POST') {
          q.posts.push({url,body:args[1].body});
          if (url.includes('/api/voice/tts') && q.fault) return new Response(JSON.stringify({detail:'Synthetic QA speech error'}), {status:503,headers:{'Content-Type':'application/json'}});
        }
        return originalFetch(...args);
      };
      WebSocket.prototype.send = function(data) { q.sends.push(typeof data === 'string' ? data : '[binary]'); return originalSend.call(this,data); };
      HTMLMediaElement.prototype.play = function(...args) {
        if (this.src.startsWith('blob:') && !armed.has(this)) {
          armed.add(this);
          const audio = this, r = {events:[],error:null,graphPeak:0,done:false}; q.plays.push(r);
          let context,timer,stream;
          const finish = () => {if(r.done)return;clearInterval(timer);r.finalTime=audio.currentTime;r.duration=audio.duration;r.done=true;stream?.getTracks().forEach(t=>t.stop());if(context)void context.close();};
          for(const type of ['playing','pause','timeupdate','ended','error']) audio.addEventListener(type,async()=>{
            r.events.push({type,time:performance.now(),currentTime:audio.currentTime});
            if(type==='playing'&&!context) {
              try {
                context=new AudioContext();
                const decoded=await context.decodeAudioData(await (await originalFetch(audio.src)).arrayBuffer());
                if(r.done || context.state === "closed") return;
                let peak=0,sum=0,samples=0;
                for(let c=0;c<decoded.numberOfChannels;c++)for(const v of decoded.getChannelData(c)){peak=Math.max(peak,Math.abs(v));sum+=v*v;samples++;}
                r.decoded={duration:decoded.duration,peak,rms:Math.sqrt(sum/samples)};
                stream=audio.captureStream();
                const analyser=context.createAnalyser(),gain=context.createGain();gain.gain.value=0;
                context.createMediaStreamSource(stream).connect(analyser);analyser.connect(gain);gain.connect(context.destination);
                await context.resume();if(r.done) return;const values=new Float32Array(analyser.fftSize);
                timer=setInterval(()=>{analyser.getFloatTimeDomainData(values);for(const v of values)r.graphPeak=Math.max(r.graphPeak,Math.abs(v));},20);
              } catch(e){r.monitorError={name:e.name,message:e.message};}
            }
            if(type==='error'){r.error={code:audio.error?.code,message:audio.error?.message};finish();}
            if(type==='ended'||type==='pause')finish();
          });
        }
        return originalPlay.apply(this,args);
      };
    });
    async function select() {
      await js((selector,text)=>{
        const root=document.querySelector(selector);
        const p=[...root.querySelectorAll('p')].find(p=>p.textContent.trim()===text);
        if(!p)throw Error('Synthetic passage missing from actual chat body');
        p.scrollIntoView({block:'center'});
        const range=document.createRange();range.selectNodeContents(p);
        const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
        p.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      },message,seed.selection_text);
      await wait('Boolean(document.querySelector(\'[role="toolbar"] button[aria-label="朗读"]\'))','Selection toolbar did not expose read aloud');
    }
    const speak = '[role="toolbar"] button[aria-label="朗读"]';
    const stop = '[role="toolbar"] button[aria-label="停止"]';
    await select();
    await click(speak);
    await wait('window.__selectedSpeech.plays.some(p=>p.events.some(e=>e.type==="playing"))','Selected sentence never played',75000);
    await click(stop);
    await wait('Boolean(document.querySelector(\'[role="toolbar"] button[aria-label="朗读"]\'))','Stop did not reset selection action');
    await wait('window.__selectedSpeech.plays[0].events.some(e=>e.type==="pause")','Stop did not pause the actual speech element');
    const stopped = await js(()=>window.__selectedSpeech.plays[0]);
    assert.ok(stopped.events.some(e=>e.type==='pause'),'Stop did not pause the actual speech element');
    proof.selection.stopped=stopped;
    await click(speak);
    await wait('window.__selectedSpeech.plays.length===2 && window.__selectedSpeech.plays[1].events.some(e=>e.type==="ended")','Selected sentence did not finish',90000);
    const result = await js(()=>window.__selectedSpeech);
    const finished=result.plays[1];
    assert.equal(finished.error,null);
    assert.ok(finished.events.some(e=>e.type==='ended')&&finished.finalTime>=finished.duration-0.3,'Selected sentence did not reach the end');
    assert.ok(finished.decoded.rms>0.001 && finished.decoded.peak>0.01 && finished.graphPeak>0.01,'Selected speech was silent');
    assert.equal(result.posts.length,2,'Reading a selection unexpectedly submitted another operation');
    for(const post of result.posts){assert.ok(post.url.includes('/api/voice/tts'));assert.equal(JSON.parse(post.body).text,seed.selection_text);}
    assert.equal(result.sends.length,0,'Reading a selection unexpectedly sent a WebSocket request');
    proof.selection.completed=finished;
    proof.selection.chatRequests=0;
    // Inject only a failure response; the two successful synthesis/playback attempts above were real.
    await js(()=>{window.__selectedSpeech.fault=true;});
    await click(speak);
    await wait('document.body.innerText.includes("Synthetic QA speech error")','Speech error was not shown to the learner');
    await wait('Boolean(document.querySelector(\'[role="toolbar"] button[aria-label="朗读"]\'))','Speech error left the action stuck');
    assert.equal(await js(()=>window.__selectedSpeech.plays.length),2,'Failed synthesis fabricated a playable audio');
    proof.selection.errorShown=true;
    proof.selection.errorInjectedOnly=true;
    await writeFile(path.join(evidence,'chat-selection-read-aloud.png'), (await view.capturePage()).toPNG());
    proof.passed=true;
    return proof;
  } catch(error) {
    proof.failure={message:error.message,audioEvidence:error.audioEvidence};
    await writeFile(path.join(evidence,'chat-audio-failure.png'),(await view.capturePage()).toPNG());
    throw error;
  } finally {
    await writeFile(path.join(evidence,'chat-audio.json'),JSON.stringify(proof,null,2));
    // Remove diagnostic wrappers by leaving the document, even when an assertion fails.
    await view.loadURL(origin + '/chat?dt_workspace=');
  }
};
