// Entry points of link-vcam-mf.dll. The DLL plays two roles:
//
//  * A COM server that Windows' Frame Server loads to get the camera's frames (DllGetClassObject,
//    DllRegisterServer): this is what makes "Link Virtual Camera" exist for Media Foundation apps.
//  * A small control library Link itself loads (the lvc* exports): it creates the camera with
//    MFCreateVirtualCamera and feeds it pictures.

#include <mutex>
#include <string>
#include <vector>

#include "feed.h"
#include "source.h"

static HMODULE g_module = nullptr;

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_module = module;
        DisableThreadLibraryCalls(module);
    }
    return TRUE;
}

// ---------------------------------------------------------------------------------------------
// COM server
// ---------------------------------------------------------------------------------------------

namespace {

class ClassFactory final : public IClassFactory {
public:
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IClassFactory) {
            *ppv = static_cast<IClassFactory*>(this);
            return S_OK;  // a static object: no reference counting
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return 2; }
    ULONG STDMETHODCALLTYPE Release() override { return 1; }
    STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** result) override {
        if (!result) return E_POINTER;
        *result = nullptr;
        if (outer) return CLASS_E_NOAGGREGATION;
        // Frame Server has started Media Foundation by now; this makes sure for any other host.
        static std::once_flag once;
        std::call_once(once, [] { MFStartup(MF_VERSION, MFSTARTUP_LITE); });
        return CreateLinkActivator(riid, result);
    }
    STDMETHODIMP LockServer(BOOL) override { return S_OK; }
};

ClassFactory g_factory;

}  // namespace

STDAPI DllCanUnloadNow() { return LiveObjectCount() == 0 ? S_OK : S_FALSE; }

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, LPVOID* ppv) {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (clsid != CLSID_LinkVirtualCamera) return CLASS_E_CLASSNOTAVAILABLE;
    return g_factory.QueryInterface(riid, ppv);
}

static std::wstring ClsidString() {
    wchar_t* text = nullptr;
    StringFromCLSID(CLSID_LinkVirtualCamera, &text);
    std::wstring result = text ? text : L"";
    CoTaskMemFree(text);
    return result;
}

// Frame Server runs the camera under another account, so the registration has to be machine-wide
// (HKLM, which needs administrator rights): regsvr32 link-vcam-mf.dll
STDAPI DllRegisterServer() {
    wchar_t path[MAX_PATH];
    if (!GetModuleFileNameW(g_module, path, MAX_PATH)) return HRESULT_FROM_WIN32(GetLastError());
    std::wstring key = L"Software\\Classes\\CLSID\\" + ClsidString();

    HKEY clsid = nullptr;
    LSTATUS status = RegCreateKeyExW(HKEY_LOCAL_MACHINE, key.c_str(), 0, nullptr, 0, KEY_WRITE, nullptr, &clsid, nullptr);
    if (status != ERROR_SUCCESS) return HRESULT_FROM_WIN32(status);
    RegSetValueExW(clsid, nullptr, 0, REG_SZ, (const BYTE*)kCameraName, (DWORD)sizeof(kCameraName));
    RegCloseKey(clsid);

    HKEY server = nullptr;
    status = RegCreateKeyExW(HKEY_LOCAL_MACHINE, (key + L"\\InprocServer32").c_str(), 0, nullptr, 0, KEY_WRITE, nullptr, &server, nullptr);
    if (status != ERROR_SUCCESS) return HRESULT_FROM_WIN32(status);
    RegSetValueExW(server, nullptr, 0, REG_SZ, (const BYTE*)path, (DWORD)((wcslen(path) + 1) * sizeof(wchar_t)));
    static const wchar_t kModel[] = L"Both";
    RegSetValueExW(server, L"ThreadingModel", 0, REG_SZ, (const BYTE*)kModel, (DWORD)sizeof(kModel));
    RegCloseKey(server);
    return S_OK;
}

STDAPI DllUnregisterServer() {
    std::wstring key = L"Software\\Classes\\CLSID\\" + ClsidString();
    LSTATUS status = RegDeleteTreeW(HKEY_LOCAL_MACHINE, key.c_str());
    return status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND ? S_OK : HRESULT_FROM_WIN32(status);
}

// ---------------------------------------------------------------------------------------------
// Control library for Link
// ---------------------------------------------------------------------------------------------

namespace {
std::mutex g_controlLock;
IMFVirtualCamera* g_camera = nullptr;
bool g_mfStarted = false;
}  // namespace

// Creates the camera and starts serving frames to it. Returns an HRESULT: 0 on success.
extern "C" int __cdecl lvcStart() {
    std::lock_guard<std::mutex> guard(g_controlLock);
    if (g_camera) return S_OK;

    HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    (void)com;  // RPC_E_CHANGED_MODE just means the thread is already set up
    HRESULT hr = MFStartup(MF_VERSION);
    if (FAILED(hr)) return hr;
    g_mfStarted = true;

    hr = AppFeedStart();
    if (SUCCEEDED(hr)) {
        std::wstring clsid = ClsidString();
        // Session lifetime: the camera exists only while Link runs, like a camera plugged in.
        hr = MFCreateVirtualCamera(MFVirtualCameraType_SoftwareCameraSource, MFVirtualCameraLifetime_Session,
                                   MFVirtualCameraAccess_CurrentUser, kCameraName, clsid.c_str(), nullptr, 0, &g_camera);
        Trace(L"MFCreateVirtualCamera: 0x%08X", (unsigned)hr);
        if (SUCCEEDED(hr)) {
            hr = g_camera->Start(nullptr);
            Trace(L"IMFVirtualCamera::Start: 0x%08X", (unsigned)hr);
        }
    }
    if (FAILED(hr)) {
        if (g_camera) {
            g_camera->Remove();
            g_camera->Release();
            g_camera = nullptr;
        }
        AppFeedStop();
        MFShutdown();
        g_mfStarted = false;
    }
    return hr;
}

extern "C" void __cdecl lvcStop() {
    std::lock_guard<std::mutex> guard(g_controlLock);
    if (g_camera) {
        g_camera->Remove();
        g_camera->Release();
        g_camera = nullptr;
    }
    AppFeedStop();
    if (g_mfStarted) {
        MFShutdown();
        g_mfStarted = false;
    }
}

// Starts only the frame pipe, without creating the camera. For tests that load the media source directly.
extern "C" int __cdecl lvcStartFeedOnly() { return AppFeedStart(); }

// True while an app (through Windows' Frame Server) is using the camera.
extern "C" int __cdecl lvcIsConnected() { return AppFeedConnected() ? 1 : 0; }

// Sends one picture: top-down 24-bit BGR, exactly kWidth x kHeight. Returns an HRESULT.
extern "C" int __cdecl lvcSendFrameBgr(const uint8_t* bgr, int width, int height) {
    if (!bgr || width != (int)kWidth || height != (int)kHeight) return E_INVALIDARG;
    if (!AppFeedConnected()) return S_FALSE;  // nobody is looking: skip the conversion
    static thread_local std::vector<uint8_t> nv12(kFrameBytes);
    BgrToNv12(bgr, nv12.data());
    AppFeedSubmit(nv12.data());
    return S_OK;
}
