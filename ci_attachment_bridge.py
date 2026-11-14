"""Re-use the verified native environment and validate the new earliest-client bridge."""
import hashlib,json,os,shutil,subprocess,tarfile,time
from pathlib import Path

def sha(file):
 with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def prepare_bridge(root,target,resources,home,evidence,batch):
 base=json.loads((resources/'seed/runtime.json').read_text())
 native=home/'runtimes'/base['runtimeId'];stage=root/('bridge-native-'+target)
 shutil.copytree(native,stage,symlinks=True,copy_function=os.link)
 shutil.rmtree(stage/'core');deps=stage/'web/node_modules';held=stage/'native-web-deps';deps.rename(held);shutil.rmtree(stage/'web')
 (stage/'BUILD_COMMIT').unlink(missing_ok=True)
 with tarfile.open(resources/'update'/batch['core_asset']['name']) as archive:archive.extractall(stage,filter='data')
 held.rename(stage/'web/node_modules')
 out=root/('bridge-'+target);out.mkdir()
 archive=out/('kaixin-bridge-20261114-audio-'+target+'.tar.gz')
 with tarfile.open(archive,'w:gz',compresslevel=6) as bundle:
  for file in sorted(stage.iterdir()):
   if file.name not in {'student-seed','SOURCE.tar.gz','installed.json'}:bundle.add(file,arcname=file.name)
 assert archive.stat().st_size<2*1024**3
 unsigned={**{k:batch['manifests'][target][k] for k in ['formatVersion','protocolVersion','platform','arch','coreVersion','commit','builtAt','corePayloadSha256']},'runtimeId':'1.7.1-kaixin-20261114-audio-'+target+'-universal','archive':archive.name,'sha256':sha(archive)}
 unsigned_file=out/('runtime-'+target+'.unsigned.json');unsigned_file.write_text(json.dumps(unsigned,indent=2))
 subprocess.run(['python','bootstrap_source.py','--with-updates'],check=True)
 bridge_home=root/('bridge-profile-'+target)
 subprocess.run(['node','ci-probe-runtime.mjs','seed',str(stage),str(bridge_home),str(resources/'seed/runtime.json'),str(evidence/'bridge-before.json')],check=True,timeout=900)
 subprocess.run(['node','ci-probe-runtime.mjs','bridge',str(stage),str(bridge_home),str(unsigned_file),str(evidence/'bridge-native.json')],check=True,timeout=900)
 proof=json.loads((evidence/'bridge-native.json').read_text());assert all(proof.get(k) for k in ['ready','chat_preserved','task_preserved','saved_key_preserved'])
 ready={'native_run_id':int(os.environ['GITHUB_RUN_ID']),'workflow_commit':os.environ['GITHUB_SHA'],'target':target,'core_commit':batch['core_commit'],'bridge':{'file':archive.name,'bytes':archive.stat().st_size,'sha256':unsigned['sha256']},'native_bridge':proof,'production_signature':'pending maintainer signature','real_keys_used':False}
 receipt=out/('attachment-stage-'+target+'.json');receipt.write_text(json.dumps(ready,indent=2))
 subprocess.run(['gh','release','upload',batch['tag'],str(archive),str(unsigned_file),str(receipt),'--clobber'],check=True)
 shutil.rmtree(stage);shutil.rmtree(bridge_home)
 # Keep this native job alive for the maintainer's signatures, never publish a feed here.
 branch=os.environ['GITHUB_REF_NAME']
 for _ in range(180):
  result=subprocess.run(['gh','api',f'repos/{os.environ["GITHUB_REPOSITORY"]}/contents/attachment-final-manifests.json?ref={branch}','-H','Accept: application/vnd.github.raw+json'],capture_output=True)
  if result.returncode==0:
   final=json.loads(result.stdout)
   if final.get('core_commit')==batch['core_commit']:
    (root/'attachment-final-manifests.json').write_bytes(result.stdout)
    for name,manifest in final['manifests'].items():
     if not name.startswith('runtime-'+target):continue
     file=out/name;file.write_text(json.dumps(manifest,indent=2));subprocess.run(['gh','release','upload',batch['tag'],str(file),'--clobber'],check=True)
    return
  time.sleep(10)
 raise TimeoutError('Maintainer signatures did not arrive; stable feeds left unchanged')
