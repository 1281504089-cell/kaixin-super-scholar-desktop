const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');

function pcm16Stats(bytes) {
  assert.ok(bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE', 'Expected a real WAVE container');
  assert.ok(bytes.readUInt32LE(4) + 8 <= bytes.length, 'Truncated WAVE container');
  let format, data;
  for (let offset=12; offset+8<=bytes.length;) {
    const size=bytes.readUInt32LE(offset+4), end=offset+8+size;
    assert.ok(end<=bytes.length, 'Truncated WAVE chunk');
    const name=bytes.toString('ascii',offset,offset+4);
    if(name==='fmt ') {
      assert.ok(size>=16);
      format={encoding:bytes.readUInt16LE(offset+8),channels:bytes.readUInt16LE(offset+10),sampleRate:bytes.readUInt32LE(offset+12),bits:bytes.readUInt16LE(offset+22)};
    }
    if(name==='data') data=bytes.subarray(offset+8,end);
    offset=end+(size%2);
  }
  assert.ok(format && data, 'Missing WAVE format or samples');
  assert.equal(format.encoding,1,'Expected PCM, not a compressed or mislabeled container');
  assert.equal(format.bits,16); assert.ok(format.channels>0 && format.channels<=2);
  assert.ok(format.sampleRate>=8000 && format.sampleRate<=96000);
  assert.equal(data.length%(2*format.channels),0);
  let peak=0,sum=0,nonzero=0;
  for(let i=0;i<data.length;i+=2){const value=data.readInt16LE(i)/32768;peak=Math.max(peak,Math.abs(value));sum+=value*value;if(Math.abs(value)>0.001)nonzero++;}
  const samples=data.length/2,duration=samples/format.channels/format.sampleRate,rms=Math.sqrt(sum/samples);
  assert.ok(duration>=0.5 && duration<=120,'Invalid speech duration');
  assert.ok(peak>0.01 && rms>0.001 && nonzero/samples>0.01,'Silent or near-silent audio is not a passing fixture');
  return {...format,duration,samples,peak,rms,nonzeroFraction:nonzero/samples,sha256:createHash('sha256').update(bytes).digest('hex')};
}

function assertPlayback(result) {
  assert.equal(result.playResolved,true,'audio.play() did not resolve');
  assert.equal(result.error,null,`Media failure: ${JSON.stringify(result.error)}`);
  assert.ok(result.events.some(e=>e.type==='playing'),'No native playing event');
  assert.ok(result.events.some(e=>e.type==='ended'),'No native ended event');
  assert.ok(result.finalTime>=0.5 && result.finalTime>=result.duration-0.3,'Playback did not reach the end');
  assert.ok(result.decoded.rms>0.001 && result.decoded.peak>0.01,'Decoder returned silence');
  assert.ok(result.graphPeak>0.01,'Playback graph remained silent');
}
module.exports={pcm16Stats,assertPlayback};
