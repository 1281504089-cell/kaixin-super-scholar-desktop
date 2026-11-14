param([string]$OutputDirectory, [switch]$StartAudioServices)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$result = [ordered]@{ imageOS=$env:ImageOS; imageVersion=$env:ImageVersion; platform='windows'; serviceChanges=@() }
function Services { @(Get-Service AudioSrv,AudioEndpointBuilder | ForEach-Object { @{name=$_.Name;status=[string]$_.Status;startType=[string]$_.StartType} }) }
$result.servicesBefore = Services
if ($StartAudioServices) {
  foreach ($name in @('AudioEndpointBuilder','AudioSrv')) {
    try { Start-Service $name; $result.serviceChanges += @{name=$name;started=$true} }
    catch { $result.serviceChanges += @{name=$name;error=$_.Exception.Message;hresult=$_.Exception.HResult} }
  }
}
$result.servicesAfter = Services
try { $result.soundDevices = @(Get-CimInstance Win32_SoundDevice | Select-Object Name,Status,ConfigManagerErrorCode) }
catch { $result.soundDeviceError = $_.Exception.Message }
try { $result.audioEndpoints = @(Get-PnpDevice -Class AudioEndpoint -PresentOnly | Select-Object FriendlyName,Status,InstanceId) }
catch { $result.endpointError = $_.Exception.Message }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinAudioProbe {
  [StructLayout(LayoutKind.Sequential, Pack=2)] public struct Format {
    public ushort tag, channels; public uint sampleRate, bytesPerSecond; public ushort align, bits, extra;
  }
  [DllImport("winmm.dll")] public static extern uint waveOutGetNumDevs();
  [DllImport("winmm.dll")] public static extern uint waveOutOpen(out IntPtr handle, uint device, ref Format format, IntPtr callback, IntPtr instance, uint flags);
  public static uint QueryMapper() {
    var f = new Format {tag=1,channels=1,sampleRate=22050,bytesPerSecond=44100,align=2,bits=16,extra=0};
    IntPtr handle; return waveOutOpen(out handle,0xffffffff,ref f,IntPtr.Zero,IntPtr.Zero,1);
  }
}
'@
$result.waveOutDeviceCount = [WinAudioProbe]::waveOutGetNumDevs()
$result.waveMapperFormatQueryCode = [WinAudioProbe]::QueryMapper()
$synth = $null
try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voices = @($synth.GetInstalledVoices() | ForEach-Object { @{name=$_.VoiceInfo.Name;culture=$_.VoiceInfo.Culture.Name;enabled=$_.Enabled} })
  $result.sapiVoices = $voices
  $voice = $voices | Where-Object { $_.enabled -and $_.culture -like 'en-*' } | Select-Object -First 1
  if (-not $voice) { throw 'No enabled English SAPI voice; no language substitution attempted.' }
  $synth.SelectVoice($voice.name)
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
  $file = Join-Path $OutputDirectory 'windows-sapi-spoken.wav'
  $synth.SetOutputToWaveFile($file,$format)
  $synth.Speak('This is an English listening test. Two plus three equals five.')
  $synth.Dispose(); $synth=$null
  $result.sapiGeneration = @{ generated=$true;file=$file;voice=$voice;source='Windows System.Speech, real PCM output';text='This is an English listening test. Two plus three equals five.' }
} catch { $result.sapiGeneration = @{generated=$false;error=$_.Exception.Message;hresult=$_.Exception.HResult;innerError=[string]$_.Exception.InnerException} }
finally { if ($synth) { $synth.Dispose() } }
$result | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 (Join-Path $OutputDirectory 'windows-environment.json')
$result | ConvertTo-Json -Depth 12
