param(
  [Parameter(Position = 0)] [string]$Action,
  [Parameter(Position = 1)] [string]$DeviceId,
  [Parameter(Position = 2)] [string]$Value
)

# Windows master-volume control via the Core Audio IAudioEndpointVolume COM interface. PowerShell
# can't call vtable-only COM interfaces directly (it only does IDispatch-style late binding), so
# every actual COM call has to happen inside compiled C# — PowerShell just invokes plain static
# methods that return primitives.
$csharp = @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

[StructLayout(LayoutKind.Sequential)]
public struct PropertyKey {
    public Guid fmtid;
    public uint pid;
    public PropertyKey(Guid guid, uint id) {
        fmtid = guid;
        pid = id;
    }
}

[StructLayout(LayoutKind.Explicit)]
public struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerVal;
}

[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
    int GetCount(out uint cProps);
    int GetAt(uint iProp, out PropertyKey pkey);
    int GetValue(ref PropertyKey key, out PropVariant pv);
    int SetValue(ref PropertyKey key, ref PropVariant pv);
    int Commit();
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
    int NotImpl1();
    int NotImpl2();
    int GetChannelCount(out int pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
    int GetMute(out bool pbMute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out uint pdwState);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection {
    int GetCount(out uint pcDevices);
    int Item(uint nDevice, out IMMDevice ppDevice);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

public class AudioEndpointVolumeHelper {
    [DllImport("ole32.dll")]
    public static extern int PropVariantClear(ref PropVariant pvar);

    private static string GetFriendlyName(IMMDevice device) {
        IPropertyStore store;
        if (device.OpenPropertyStore(0, out store) == 0) {
            var key = new PropertyKey(new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 14);
            PropVariant pv;
            if (store.GetValue(ref key, out pv) == 0) {
                string name = null;
                if (pv.vt == 31) { // VT_LPWSTR
                    name = Marshal.PtrToStringUni(pv.pointerVal);
                }
                PropVariantClear(ref pv);
                return name;
            }
        }
        return null;
    }

    private static IAudioEndpointVolume GetVolumeObject(IMMDevice device) {
        var epvId = typeof(IAudioEndpointVolume).GUID;
        object epvObj;
        if (device.Activate(ref epvId, 23, IntPtr.Zero, out epvObj) == 0) {
            return (IAudioEndpointVolume)epvObj;
        }
        return null;
    }

    private static IMMDevice FindDevice(string deviceId) {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        if (string.IsNullOrEmpty(deviceId) || deviceId == "default") {
            IMMDevice dev;
            if (enumerator.GetDefaultAudioEndpoint(0, 1, out dev) == 0) {
                return dev;
            }
            return null;
        }
        IMMDevice target;
        if (enumerator.GetDevice(deviceId, out target) == 0) {
            return target;
        }
        return null;
    }

    public static string GetState() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDeviceCollection collection;
        // eRender = 0, DEVICE_STATE_ACTIVE = 1
        if (enumerator.EnumAudioEndpoints(0, 1, out collection) != 0) {
            return "[]";
        }
        uint count;
        collection.GetCount(out count);
        var list = new List<string>();

        IMMDevice defaultDev = null;
        string defaultId = "";
        if (enumerator.GetDefaultAudioEndpoint(0, 1, out defaultDev) == 0 && defaultDev != null) {
            defaultDev.GetId(out defaultId);
        }

        for (uint i = 0; i < count; i++) {
            IMMDevice dev;
            if (collection.Item(i, out dev) == 0 && dev != null) {
                string id;
                dev.GetId(out id);
                string name = GetFriendlyName(dev) ?? "Unknown Device";
                var volObj = GetVolumeObject(dev);
                if (volObj != null) {
                    float level;
                    volObj.GetMasterVolumeLevelScalar(out level);
                    bool muted;
                    volObj.GetMute(out muted);
                    int pct = (int)Math.Round(level * 100);

                    string safeId = id.Replace(@"\", @"\\");
                    string safeName = name.Replace(@"\", @"\\").Replace("\"", "\\\"");
                    
                    list.Add("{\"id\":\"" + safeId + "\",\"name\":\"" + safeName + "\",\"volume\":" + pct + ",\"muted\":" + (muted ? "true" : "false") + "}");
                }
            }
        }
        return "[" + string.Join(",", list.ToArray()) + "]";
    }

    public static void SetVolume(string deviceId, double pct) {
        var dev = FindDevice(deviceId);
        if (dev == null) return;
        var vol = GetVolumeObject(dev);
        if (vol == null) return;
        vol.SetMasterVolumeLevelScalar((float)(pct / 100.0), Guid.Empty);
    }

    public static void SetMute(string deviceId, bool muted) {
        var dev = FindDevice(deviceId);
        if (dev == null) return;
        var vol = GetVolumeObject(dev);
        if (vol == null) return;
        vol.SetMute(muted, Guid.Empty);
    }
}
"@

Add-Type -TypeDefinition $csharp -Language CSharp

if ($Action) {
    if ($Action -eq 'get') {
        [AudioEndpointVolumeHelper]::GetState()
    } elseif ($Action -eq 'set-volume') {
        [AudioEndpointVolumeHelper]::SetVolume($DeviceId, [double]$Value)
        "ok"
    } elseif ($Action -eq 'set-mute') {
        [AudioEndpointVolumeHelper]::SetMute($DeviceId, [bool]::Parse($Value))
        "ok"
    }
} else {
    # Interactive REPL Loop Mode
    while ($line = [Console]::In.ReadLine()) {
        if ($null -eq $line) { break }
        $parts = $line.Split('|')
        $cmd = $parts[0]
        if ($cmd -eq 'get') {
            [AudioEndpointVolumeHelper]::GetState()
        } elseif ($cmd -eq 'set-volume') {
            $devId = $parts[1]
            $val = $parts[2]
            [AudioEndpointVolumeHelper]::SetVolume($devId, [double]$val)
            "ok"
        } elseif ($cmd -eq 'set-mute') {
            $devId = $parts[1]
            $val = $parts[2]
            [AudioEndpointVolumeHelper]::SetMute($devId, [bool]::Parse($val))
            "ok"
        }
    }
}
