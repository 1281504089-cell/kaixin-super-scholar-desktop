"""Replace only the launcher and included signed core in a verified installer copy."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from urllib.request import Request, urlopen


def prepare_candidate(root, target, install, resources, downloads, evidence, lock):
    batch = json.loads((root / 'attachment-batch.json').read_text())
    manifest = batch['manifests'][target]
    assert manifest['baseRuntimeId'] == json.loads((resources / 'seed/runtime.json').read_text())['runtimeId']
    for name, row in batch['shell_files'].items():
        assert hashlib.sha256((resources / 'app' / name).read_bytes()).hexdigest() == row['sha256'], 'Reuse only the published launcher'
    shutil.copytree(resources / 'update', root / 'prior-update')
    core = resources / 'update'
    for file in core.iterdir():
        file.unlink()
    asset = batch['core_asset']
    request = Request(asset['browser_download_url'], headers={'User-Agent': 'Kaixin-native-release'})
    archive = core / manifest['archive']
    with urlopen(request, timeout=60) as response, archive.open('xb') as output:
        shutil.copyfileobj(response, output, 8 * 1024**2)
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest['sha256']
    (core / 'runtime.json').write_text(json.dumps(manifest, indent=2))
    pkg = json.loads((resources / 'app/package.json').read_text())
    pkg['kaixinLauncherBuild'] = batch['launcher_build']
    (resources / 'app/package.json').write_text(json.dumps(pkg, ensure_ascii=False, indent=2))

    # A small throwaway Electron copy tests proxies; the distributable never contains the probe.
    probe = root / ('network-probe-' + target + ('.app' if target.startswith('macos-') else ''))
    source_app = resources.parent.parent if target.startswith('macos-') else install
    shutil.copytree(source_app, probe, ignore=lambda directory, names:
                    [name for name in names if name in {'seed', 'update'}] if Path(directory) == resources else [], symlinks=True)
    probe_resources = probe / 'Contents/Resources' if target.startswith('macos-') else probe / 'resources'
    probe_pkg = probe_resources / 'app/package.json'
    value = json.loads(probe_pkg.read_text())
    value['main'] = 'src/proxy-smoke.cjs'
    probe_pkg.write_text(json.dumps(value, ensure_ascii=False))
    shutil.copyfile(root / 'ci-proxy-smoke.cjs', probe_resources / 'app/src/proxy-smoke.cjs')
    proxy_home = root / ('proxy-home-' + target)
    proxy_home.mkdir()
    if target.startswith('macos-'):
        subprocess.run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', str(probe)], check=True)
        probe_exe = probe / 'Contents/MacOS/开心动力超级学霸'
    else:
        probe_exe = probe / '开心动力超级学霸.exe'
    subprocess.run([str(probe_exe)], check=True, timeout=300, env={**os.environ,
                   'KX_PROXY_HOME': str(proxy_home), 'KX_BASE_MANIFEST': str(resources / 'seed/runtime.json'),
                   'KX_PROXY_RESULT': str(evidence / 'network.json')})
    shutil.rmtree(probe)
    shutil.rmtree(proxy_home)
    test_root = root / ('launcher-tests-' + target)
    shutil.copytree(resources / 'app/src', test_root / 'src')
    shutil.copytree(root / 'fetchfix-tests', test_root / 'test')
    subprocess.run(['node', '--test', *[str(p) for p in (test_root / 'test').glob('*.test.mjs')]], check=True)

    out = root / ('candidate-' + target)
    out.mkdir()
    if target.startswith('macos-'):
        app = resources.parent.parent
        subprocess.run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', str(app)], check=True)
        subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
        shutil.rmtree(downloads)
        (install / 'Applications').symlink_to('/Applications')
        stem = 'Kaixin-Super-Scholar-MacOS-' + ('Intel' if target == 'macos-x64' else 'Apple-Silicon') + '-v1.7.1-20261114-audio'
        image = out / (stem + '.dmg')
        subprocess.run(['/usr/bin/hdiutil', 'create', '-volname', '开心动力超级学霸', '-srcfolder', str(install),
                        '-fs', 'APFS', '-format', 'ULFO', str(image)], check=True)
        subprocess.run(['/usr/bin/hdiutil', 'verify', str(image)], check=True)
        subprocess.run(['/usr/bin/hdiutil', 'segment', '-segmentSize', '1900m', '-o', str(out / (stem + '-part.dmg')), str(image)], check=True)
        image.unlink()
        shutil.rmtree(app)
        mount = root / ('candidate-mount-' + target)
        mount.mkdir()
        subprocess.run(['/usr/bin/hdiutil', 'attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', str(mount),
                        str(out / (stem + '-part.dmg'))], check=True)
        try:
            subprocess.run(['/usr/bin/ditto', str(mount / app.name), str(app)], check=True)
        finally:
            subprocess.run(['/usr/bin/hdiutil', 'detach', str(mount)], check=True)
    else:
        parts = []
        for row in lock['targets'][target]['files']:
            if '-Runtime.' in row['name']:
                file = downloads / row['name']
                shutil.move(file, out / file.name)
                parts.append({'file': file.name, 'bytes': row['bytes'], 'sha256': row['sha256']})
        base = json.loads((resources / 'seed/runtime.json').read_text())
        parts_file = out / 'installer-parts.json'
        parts_file.write_text(json.dumps({'sha256': base['sha256'], 'parts': sorted(parts, key=lambda row: row['file'])}))
        setup = out / 'Kaixin-Super-Scholar-Windows-v1.7.1-Setup.exe'
        # An installed copy has an uninstaller; it is generated again by NSIS.
        (install / 'Uninstall 开心动力超级学霸.exe').unlink(missing_ok=True)
        nsis = Path(os.environ['ProgramFiles(x86)']) / 'NSIS/makensis.exe'
        subprocess.run([str(nsis), '/INPUTCHARSET', 'UTF8', '-DSOURCE=' + str(install), '-DOUTFILE=' + str(setup),
                        '-DICON=' + str(resources / 'app/assets/icon.ico'), '-DVERSION=1.7.1', '-DFILEVERSION=1.7.1.0',
                        '-DPARTS_MANIFEST=' + str(parts_file), '-DARCHIVE_NAME=' + base['archive'],
                        str(root / 'fetchfix-windows/installer.nsi')], check=True)
        shutil.rmtree(install)
        install.mkdir()
        result = subprocess.run('"' + str(setup) + '" /S /D=' + str(install), timeout=900)
        assert result.returncode == 0
        parts_file.unlink()
        shutil.rmtree(downloads)
    return out, batch
