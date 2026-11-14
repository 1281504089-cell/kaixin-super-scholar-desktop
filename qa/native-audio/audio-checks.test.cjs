const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {pcm16Stats,assertPlayback}=require('./audio-checks.cjs');
test('real spoken fixture must decode to non-silent PCM and silence/truncation fail',()=>{
  const file=JSON.parse(readFileSync(__dirname+'/spoken-fixture.json'));
  const bytes=Buffer.from(file.base64,'base64');
  const result=pcm16Stats(bytes);assert.equal(result.sha256,file.sha256);
  const silent=Buffer.from(bytes);const marker=silent.indexOf('data');silent.fill(0,marker+8);
  assert.throws(()=>pcm16Stats(silent),/Silent/);
  assert.throws(()=>pcm16Stats(bytes.subarray(0,50)),/Truncated/);
});
test('nonempty success or failure status and partial play do not pass the native gate',()=>{
  assert.throws(()=>assertPlayback({observedStatus:'设备朗读未能播放'}));
  const valid={playResolved:true,error:null,events:[{type:'playing'},{type:'ended'}],duration:2,finalTime:2,decoded:{rms:0.1,peak:0.5},graphPeak:0.5};
  assert.doesNotThrow(()=>assertPlayback(valid));
  for(const patch of [{playResolved:false},{error:{code:3,message:'decode failed'}},{events:[{type:'playing'}]},{graphPeak:0},{finalTime:0.1}])assert.throws(()=>assertPlayback({...valid,...patch}));
});
