param(
  [Parameter(Position = 0)] [string]$Action = "capture",
  # Endpoint id from the "list-devices" action. Empty means the system default, which is both the
  # old behaviour and the right fallback if a chosen device is later unplugged.
  [Parameter(Position = 1)] [string]$DeviceId = ""
)

# WASAPI loopback capture for Audio Sink — the same audio Windows is currently playing through
# the default render endpoint. Writes raw PCM straight to stdout as an uninterpreted binary
# stream. Same COM-interop approach as
# audio-endpoint-volume.ps1 (PowerShell can't call vtable-only COM interfaces directly, so every
# real COM call happens inside compiled C# via Add-Type; PowerShell just invokes one static
# method). No new binary, no bundled dependency — this is the built-in Windows Core Audio API,
# unchanged since Vista.
#
# Output contract (consumed by audio-sink-server.ts):
#   1. One line of UTF-8 JSON describing the captured format, newline-terminated:
#        {"sampleRate":48000,"channels":2,"bitsPerSample":32,"isFloat":true}
#      48kHz is requested explicitly (via the engine's own resampler) whenever the mixer is set to
#      something else, because two things downstream depend on it: Opus accepts only
#      8/12/16/24/48kHz, and Android's low-latency AudioTrack path requires the stream rate to
#      match the device's native output rate. If the driver refuses the conversion this falls back
#      to the native mix rate, so the reported rate here is authoritative either way — the caller
#      reads this line once, then treats everything after it as raw interleaved PCM samples in
#      that format, forever, until the process is killed.
#   2. Continuous raw PCM bytes, no framing/chunk headers — the caller does its own chunking for
#      the network relay. This script's only job is "give me bytes + tell me their shape."
#
# Stopping: no in-band stop signal. The host (Node's child_process) kills this process when the
# Audio Sink session ends — simplest possible contract, and correct since there's nothing to
# flush/clean up on our side beyond releasing COM objects, which process exit does for free.

$csharp = @"
using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Threading;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public struct WAVEFORMATEX {
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out uint pdwState);
}

// Method order in these declarations IS the COM vtable order — entries must stay in the exact
// sequence the interface defines, and nothing may be omitted before a method that is used.
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection {
    int GetCount(out uint pcDevices);
    int Item(uint nDevice, out IMMDevice ppDevice);
}

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
    int GetCount(out uint cProps);
    int GetAt(uint iProp, out PROPERTYKEY pkey);
    int GetValue(ref PROPERTYKEY key, IntPtr pv);
    int SetValue(ref PROPERTYKEY key, IntPtr propvar);
    int Commit();
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY {
    public Guid fmtid;
    public int pid;
}

[Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient {
    int Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
    int GetBufferSize(out uint pNumBufferFrames);
    int GetStreamLatency(out long phnsLatency);
    int GetCurrentPadding(out uint pNumPaddingFrames);
    int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr ppClosestMatch);
    int GetMixFormat(out IntPtr ppDeviceFormat);
    int GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr eventHandle);
    int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
}

[Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioCaptureClient {
    int GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);
    int ReleaseBuffer(uint numFramesRead);
    int GetNextPacketSize(out uint pNumFramesInNextPacket);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

public class LoopbackCapture {
    private const int AUDCLNT_SHAREMODE_SHARED = 0;
    private const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    // Let the Windows audio engine resample for us, rather than forwarding whatever rate the
    // mixer happens to be set to. Needed because a 44.1kHz mix rate costs us twice over: Opus
    // only accepts 8/12/16/24/48kHz so the session silently falls back to raw PCM, and the phone
    // skips its native low-latency AudioTrack path whenever the stream rate doesn't match the
    // device's own output rate (which is 48kHz on essentially every Android device).
    private const int AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = unchecked((int)0x80000000);
    private const int AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
    private const uint TARGET_SAMPLE_RATE = 48000;
    private const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    private static readonly Guid IID_IAudioClient = typeof(IAudioClient).GUID;
    private static readonly Guid IID_IAudioCaptureClient = typeof(IAudioCaptureClient).GUID;

    // PKEY_Device_FriendlyName — the human-readable endpoint name shown in Windows' own sound
    // settings ("Speakers (Realtek Audio)"), which is what makes a device list recognisable.
    private static readonly PROPERTYKEY PKEY_DEVICE_FRIENDLY_NAME = MakeKey(
        new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 14);

    private static PROPERTYKEY MakeKey(Guid fmtid, int pid) {
        PROPERTYKEY k = new PROPERTYKEY();
        k.fmtid = fmtid;
        k.pid = pid;
        return k;
    }

    private static string GetFriendlyName(IMMDevice dev) {
        IntPtr pStore;
        if (dev.OpenPropertyStore(0 /* STGM_READ */, out pStore) != 0 || pStore == IntPtr.Zero) return null;
        try {
            var store = (IPropertyStore)Marshal.GetObjectForIUnknown(pStore);
            // PROPVARIANT is 16 bytes on x86 and 24 on x64; allocating the larger size is safe on
            // both. For a string property the payload is an LPWSTR pointer at offset 8.
            IntPtr pv = Marshal.AllocCoTaskMem(32);
            try {
                for (int i = 0; i < 32; i++) Marshal.WriteByte(pv, i, 0);
                var key = PKEY_DEVICE_FRIENDLY_NAME;
                if (store.GetValue(ref key, pv) != 0) return null;
                IntPtr strPtr = Marshal.ReadIntPtr(pv, 8);
                return strPtr == IntPtr.Zero ? null : Marshal.PtrToStringUni(strPtr);
            } finally {
                Marshal.FreeCoTaskMem(pv);
            }
        } catch {
            return null;
        } finally {
            Marshal.Release(pStore);
        }
    }

    private static string JsonEscape(string s) {
        if (s == null) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    /** Prints every active playback endpoint as one line of JSON, so the app can offer the same
     *  device picker Windows itself does instead of being locked to the system default. */
    public static void ListDevices() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        string defaultId = null;
        try {
            IMMDevice def;
            if (enumerator.GetDefaultAudioEndpoint(0, 1, out def) == 0 && def != null) {
                def.GetId(out defaultId);
            }
        } catch {}

        IntPtr pCollection;
        // eRender = 0, DEVICE_STATE_ACTIVE = 1 — unplugged/disabled endpoints can't be captured.
        if (enumerator.EnumAudioEndpoints(0, 1, out pCollection) != 0 || pCollection == IntPtr.Zero) {
            Console.Out.Write("[]\n");
            return;
        }
        var collection = (IMMDeviceCollection)Marshal.GetObjectForIUnknown(pCollection);
        uint count;
        collection.GetCount(out count);

        var sb = new System.Text.StringBuilder();
        sb.Append('[');
        bool first = true;
        for (uint i = 0; i < count; i++) {
            IMMDevice dev;
            if (collection.Item(i, out dev) != 0 || dev == null) continue;
            string id;
            if (dev.GetId(out id) != 0 || id == null) continue;
            string name = GetFriendlyName(dev);
            if (name == null) name = "Unknown device";
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"id\":\"").Append(JsonEscape(id))
              .Append("\",\"name\":\"").Append(JsonEscape(name))
              .Append("\",\"isDefault\":").Append(id == defaultId ? "true" : "false").Append('}');
        }
        sb.Append("]\n");
        Console.Out.Write(sb.ToString());
        Console.Out.Flush();
    }

    public static void Run(string deviceId) {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice device = null;
        int hr = 0;

        // An explicitly chosen endpoint that has since been unplugged must not silently capture
        // something else — but falling back to the default is right when nothing was chosen.
        if (!string.IsNullOrEmpty(deviceId)) {
            hr = enumerator.GetDevice(deviceId, out device);
            if (hr != 0 || device == null) {
                Console.Error.WriteLine("Selected playback device is unavailable (hr=" + hr + ") — falling back to system default");
                device = null;
            }
        }
        if (device == null) {
            // eRender = 0 (dataFlow); eMultimedia = 1 (role) — same default-endpoint role already
            // used elsewhere in this app (audio-endpoint-volume.ps1), kept consistent rather than
            // picking a new one.
            hr = enumerator.GetDefaultAudioEndpoint(0, 1, out device);
        }
        if (hr != 0 || device == null) {
            Console.Error.WriteLine("No playback device found (hr=" + hr + ")");
            Environment.Exit(1);
        }

        object clientObj;
        var iidClient = IID_IAudioClient;
        hr = device.Activate(ref iidClient, 23 /* CLSCTX_ALL */, IntPtr.Zero, out clientObj);
        if (hr != 0) {
            Console.Error.WriteLine("Activate(IAudioClient) failed (hr=" + hr + ")");
            Environment.Exit(1);
        }
        var client = (IAudioClient)clientObj;

        IntPtr pFormat;
        hr = client.GetMixFormat(out pFormat);
        if (hr != 0 || pFormat == IntPtr.Zero) {
            Console.Error.WriteLine("GetMixFormat failed (hr=" + hr + ")");
            Environment.Exit(1);
        }
        WAVEFORMATEX fmt = (WAVEFORMATEX)Marshal.PtrToStructure(pFormat, typeof(WAVEFORMATEX));
        // WAVE_FORMAT_EXTENSIBLE (0xFFFE) is what the shared-mode mix format almost always is on
        // modern Windows; the sub-format (float vs int) lives past the fixed WAVEFORMATEX header
        // in WAVEFORMATEXTENSIBLE, but wBitsPerSample/nChannels/nSamplesPerSec are already
        // correct either way, and the Windows audio engine's shared-mode mix is always 32-bit
        // IEEE float in practice — that's what we report and it has held true since the shared-
        // mode mixer was introduced. No format conversion is attempted; we forward exactly what
        // the engine hands us.
        bool isFloat = fmt.wBitsPerSample == 32;

        // 40ms buffer (in 100ns units) — was 100ms; tightened since this feature is
        // latency-sensitive and the tighter 3ms poll loop below no longer needs as much slack
        // against underrun.
        long bufferDuration = 400000;

        // Prefer capturing at 48kHz regardless of the mixer's configured rate. AUTOCONVERTPCM puts
        // the engine's own resampler in the path, which is both better quality and cheaper than
        // anything we'd hand-roll here. Only attempted when the rate actually differs, and any
        // failure falls straight back to the native mix format — some driver/loopback combinations
        // reject the conversion flags, and a working session at 44.1kHz beats no session at all.
        // Kept separate from pFormat, which may be swapped to the converted format below. The
        // silent render stream further down must stay on the engine's NATIVE mix format — it's an
        // ordinary render client with no conversion flags, so handing it 48kHz on a 44.1kHz mixer
        // would fail and we'd silently lose the mixer-clock keepalive it exists to provide.
        IntPtr pMixFormat = pFormat;

        IntPtr pConverted = IntPtr.Zero;
        if (fmt.nSamplesPerSec != TARGET_SAMPLE_RATE) {
            int formatBytes = 18 + fmt.cbSize; // WAVEFORMATEX header + any EXTENSIBLE tail
            pConverted = Marshal.AllocHGlobal(formatBytes);
            byte[] raw = new byte[formatBytes];
            Marshal.Copy(pFormat, raw, 0, formatBytes);
            Marshal.Copy(raw, 0, pConverted, formatBytes);

            WAVEFORMATEX want = (WAVEFORMATEX)Marshal.PtrToStructure(pConverted, typeof(WAVEFORMATEX));
            want.nSamplesPerSec = TARGET_SAMPLE_RATE;
            // nBlockAlign (channels x bytes-per-sample) is rate-independent; only the byte rate moves.
            want.nAvgBytesPerSec = TARGET_SAMPLE_RATE * want.nBlockAlign;
            Marshal.StructureToPtr(want, pConverted, false);

            int convFlags = AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
            if (client.Initialize(AUDCLNT_SHAREMODE_SHARED, convFlags, bufferDuration, 0, pConverted, IntPtr.Zero) == 0) {
                Console.Error.WriteLine("Capturing at " + TARGET_SAMPLE_RATE + "Hz (engine-resampled from " + fmt.nSamplesPerSec + "Hz)");
                pFormat = pConverted;
                fmt = want;
            } else {
                // Initialize() failing leaves the client unusable, so re-Activate a fresh one
                // before the native-format attempt below.
                Marshal.FreeHGlobal(pConverted);
                pConverted = IntPtr.Zero;
                Console.Error.WriteLine("48kHz conversion unavailable — falling back to native " + fmt.nSamplesPerSec + "Hz");
                object retryObj;
                var iidRetry = IID_IAudioClient;
                if (device.Activate(ref iidRetry, 23, IntPtr.Zero, out retryObj) != 0 || retryObj == null) {
                    Console.Error.WriteLine("Re-Activate(IAudioClient) failed after conversion attempt");
                    Environment.Exit(1);
                }
                client = (IAudioClient)retryObj;
            }
        }

        if (pConverted == IntPtr.Zero) {
            hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, bufferDuration, 0, pFormat, IntPtr.Zero);
            if (hr != 0) {
                Console.Error.WriteLine("IAudioClient.Initialize failed (hr=" + hr + ")");
                Environment.Exit(1);
            }
        }

        // WASAPI shared-mode mixer goes idle / stops generating clock ticks when no render stream
        // is active. Activating a silent render client on the same playback device keeps the mixer
        // clock running continuously, so WASAPI loopback immediately captures audio regardless of
        // whether sound was playing when the session started, or if sound starts/stops later.
        IAudioClient dummyRenderClient = null;
        try {
            object dummyObj;
            if (device.Activate(ref iidClient, 23, IntPtr.Zero, out dummyObj) == 0 && dummyObj != null) {
                dummyRenderClient = (IAudioClient)dummyObj;
                if (dummyRenderClient.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, bufferDuration, 0, pMixFormat, IntPtr.Zero) == 0) {
                    dummyRenderClient.Start();
                }
            }
        } catch {
            // Ignore if dummy render activation fails — proceed with standard loopback
        }

        object captureObj;
        var iidCapture = IID_IAudioCaptureClient;
        hr = client.GetService(ref iidCapture, out captureObj);
        if (hr != 0) {
            Console.Error.WriteLine("GetService(IAudioCaptureClient) failed (hr=" + hr + ")");
            Environment.Exit(1);
        }
        var captureClient = (IAudioCaptureClient)captureObj;

        Stream stdout = Console.OpenStandardOutput();
        // Header line written as raw UTF-8 bytes directly to the underlying stream — bypassing
        // PowerShell's own text pipeline entirely (Write-Output/Write-Host can re-encode or
        // mangle bytes headed to a redirected stdout). Everything this process ever writes goes
        // through this same raw Stream, header and audio alike, so nothing downstream of here
        // can corrupt it.
        string header = "{\"sampleRate\":" + fmt.nSamplesPerSec +
                         ",\"channels\":" + fmt.nChannels +
                         ",\"bitsPerSample\":" + fmt.wBitsPerSample +
                         ",\"isFloat\":" + (isFloat ? "true" : "false") + "}\n";
        byte[] headerBytes = System.Text.Encoding.UTF8.GetBytes(header);
        stdout.Write(headerBytes, 0, headerBytes.Length);
        stdout.Flush();

        client.Start();

        try {
            while (true) {
                uint packetSize;
                captureClient.GetNextPacketSize(out packetSize);
                if (packetSize == 0) {
                    // Was 10ms — tightened for latency; still cheap enough on CPU for a
                    // background capture loop.
                    Thread.Sleep(3);
                    continue;
                }

                IntPtr pData;
                uint numFrames;
                uint flags;
                ulong devPos, qpcPos;
                hr = captureClient.GetBuffer(out pData, out numFrames, out flags, out devPos, out qpcPos);
                if (hr != 0) {
                    Thread.Sleep(10);
                    continue;
                }

                int bytesPerFrame = fmt.nChannels * (fmt.wBitsPerSample / 8);
                int byteCount = (int)numFrames * bytesPerFrame;
                if (byteCount <= 0) {
                    captureClient.ReleaseBuffer(numFrames);
                    continue;
                }

                byte[] buffer = new byte[byteCount];
                if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
                    Array.Clear(buffer, 0, byteCount);
                } else {
                    Marshal.Copy(pData, buffer, 0, byteCount);
                }
                stdout.Write(buffer, 0, byteCount);
                stdout.Flush();
                captureClient.ReleaseBuffer(numFrames);
            }
        } finally {
            try { client.Stop(); } catch {}
            try { if (dummyRenderClient != null) dummyRenderClient.Stop(); } catch {}
        }
    }
}
"@

Add-Type -TypeDefinition $csharp -Language CSharp

if ($Action -eq "list-devices") {
    [LoopbackCapture]::ListDevices()
} elseif ($Action -eq "capture") {
    [LoopbackCapture]::Run($DeviceId)
}
