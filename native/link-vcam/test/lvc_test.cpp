// Test program for the Link Windows 11 virtual camera (not shipped).
//
//   lvc-test list           the cameras Media Foundation and DirectShow each see
//   lvc-test feed [secs]    start the camera and feed it a moving picture
//   lvc-test read [frames]  open "Link Virtual Camera" like an app does and check the frames change

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dshow.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#pragma comment(lib, "strmiids.lib")

static const wchar_t kName[] = L"Link Virtual Camera";
constexpr int kW = 1280, kH = 720;

static int ListMediaFoundation() {
    IMFAttributes* attrs = nullptr;
    MFCreateAttributes(&attrs, 1);
    attrs->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
    IMFActivate** devices = nullptr;
    UINT32 count = 0;
    HRESULT hr = MFEnumDeviceSources(attrs, &devices, &count);
    attrs->Release();
    if (FAILED(hr)) {
        printf("MFEnumDeviceSources failed: 0x%08X\n", (unsigned)hr);
        return -1;
    }
    int found = -1;
    printf("Media Foundation cameras (%u):\n", count);
    for (UINT32 i = 0; i < count; ++i) {
        wchar_t* name = nullptr;
        UINT32 length = 0;
        devices[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &length);
        wprintf(L"  - %s\n", name);
        if (name && wcsncmp(name, kName, wcslen(kName)) == 0) found = (int)i;  // Windows appends " (Windows Virtual Camera)"
        CoTaskMemFree(name);
        devices[i]->Release();
    }
    CoTaskMemFree(devices);
    return found;
}

static void ListDirectShow() {
    ICreateDevEnum* devEnum = nullptr;
    if (FAILED(CoCreateInstance(CLSID_SystemDeviceEnum, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&devEnum)))) return;
    IEnumMoniker* monikers = nullptr;
    if (devEnum->CreateClassEnumerator(CLSID_VideoInputDeviceCategory, &monikers, 0) != S_OK) {
        printf("DirectShow cameras: none\n");
        devEnum->Release();
        return;
    }
    printf("DirectShow cameras:\n");
    IMoniker* moniker = nullptr;
    while (monikers->Next(1, &moniker, nullptr) == S_OK) {
        IPropertyBag* bag = nullptr;
        if (SUCCEEDED(moniker->BindToStorage(nullptr, nullptr, IID_PPV_ARGS(&bag)))) {
            VARIANT name;
            VariantInit(&name);
            if (SUCCEEDED(bag->Read(L"FriendlyName", &name, nullptr))) wprintf(L"  - %s\n", name.bstrVal);
            VariantClear(&name);
            bag->Release();
        }
        moniker->Release();
    }
    monikers->Release();
    devEnum->Release();
}

typedef int(__cdecl* StartFn)();
typedef void(__cdecl* StopFn)();
typedef int(__cdecl* ConnectedFn)();
typedef int(__cdecl* SendFn)(const unsigned char*, int, int);

static int Feed(int seconds) {
    wchar_t path[MAX_PATH];
    GetModuleFileNameW(nullptr, path, MAX_PATH);
    wchar_t* slash = wcsrchr(path, L'\\');
    wcscpy_s(slash + 1, MAX_PATH - (slash + 1 - path), L"link-vcam-mf.dll");
    HMODULE dll = LoadLibraryW(path);
    if (!dll) {
        printf("cannot load the DLL: %lu\n", GetLastError());
        return 1;
    }
    auto start = (StartFn)GetProcAddress(dll, "lvcStart");
    auto stop = (StopFn)GetProcAddress(dll, "lvcStop");
    auto connected = (ConnectedFn)GetProcAddress(dll, "lvcIsConnected");
    auto send = (SendFn)GetProcAddress(dll, "lvcSendFrameBgr");
    int hr = start();
    printf("lvcStart: 0x%08X\n", (unsigned)hr);
    if (hr < 0) return 2;

    std::vector<unsigned char> frame((size_t)kW * kH * 3);
    DWORD t0 = GetTickCount();
    int shown = -1;
    for (int n = 0; GetTickCount() - t0 < (DWORD)seconds * 1000; ++n) {
        // A moving picture: horizontal brightness bars that scroll, with a colour that cycles.
        unsigned char tint = (unsigned char)((n * 4) & 0xFF);
        for (int y = 0; y < kH; ++y) {
            unsigned char* row = frame.data() + (size_t)y * kW * 3;
            for (int x = 0; x < kW; ++x) {
                unsigned char bar = (unsigned char)(((x + n * 8) / 160 % 2) ? 200 : 60);
                row[x * 3 + 0] = tint;
                row[x * 3 + 1] = bar;
                row[x * 3 + 2] = (unsigned char)(255 - tint);
            }
        }
        send(frame.data(), kW, kH);
        int sec = (int)((GetTickCount() - t0) / 1000);
        if (sec != shown) {
            shown = sec;
            printf("  t=%ds connected=%d\n", sec, connected());
            fflush(stdout);
        }
        Sleep(33);
    }
    stop();
    printf("stopped\n");
    return 0;
}

// Reads frames from a media source the way an app's source reader does, and checks they change.
static int ReadFromSource(IMFMediaSource* source, int frames) {
    HRESULT hr = S_OK;
    IMFAttributes* readerAttrs = nullptr;
    MFCreateAttributes(&readerAttrs, 1);
    readerAttrs->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);
    IMFSourceReader* reader = nullptr;
    hr = MFCreateSourceReaderFromMediaSource(source, readerAttrs, &reader);
    printf("MFCreateSourceReaderFromMediaSource: 0x%08X\n", (unsigned)hr);
    if (FAILED(hr)) return 5;

    // Ask for RGB32 like a typical app would, so the check reads plain pixels.
    IMFMediaType* want = nullptr;
    MFCreateMediaType(&want);
    want->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    want->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    hr = reader->SetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, want);
    printf("SetCurrentMediaType RGB32: 0x%08X\n", (unsigned)hr);

    int got = 0, changed = 0;
    double previous = -1;
    for (int i = 0; i < frames + 20 && got < frames; ++i) {
        DWORD flags = 0;
        IMFSample* sample = nullptr;
        hr = reader->ReadSample((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, nullptr, &flags, nullptr, &sample);
        if (FAILED(hr)) {
            printf("ReadSample failed: 0x%08X\n", (unsigned)hr);
            break;
        }
        if (!sample) continue;
        IMFMediaBuffer* buffer = nullptr;
        sample->ConvertToContiguousBuffer(&buffer);
        BYTE* data = nullptr;
        DWORD length = 0;
        buffer->Lock(&data, nullptr, &length);
        // Average of one row of pixels near the top (the test picture changes colour and bars over time).
        double sum = 0;
        for (int x = 0; x < 256; ++x) sum += data[(size_t)x * 4 + 1] + data[(size_t)x * 4 + 0] * 2;
        buffer->Unlock();
        if (previous >= 0 && sum != previous) ++changed;
        previous = sum;
        if (got % 10 == 0) printf("  frame %d: %lu bytes, probe=%.0f\n", got, (unsigned long)length, sum);
        ++got;
        buffer->Release();
        sample->Release();
    }
    printf("read %d frames, %d differed from the previous one\n", got, changed);
    reader->Release();
    source->Shutdown();
    source->Release();
    return got > 0 && changed > 0 ? 0 : 6;
}

// Through Windows: the camera as an app finds it, by name, via Frame Server.
static int Read(int frames) {
    int index = ListMediaFoundation();
    if (index < 0) {
        printf("\"%ls\" is not listed by Media Foundation.\n", kName);
        return 3;
    }
    IMFAttributes* attrs = nullptr;
    MFCreateAttributes(&attrs, 1);
    attrs->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
    IMFActivate** devices = nullptr;
    UINT32 count = 0;
    MFEnumDeviceSources(attrs, &devices, &count);
    attrs->Release();
    IMFMediaSource* source = nullptr;
    HRESULT hr = devices[index]->ActivateObject(IID_PPV_ARGS(&source));
    printf("ActivateObject: 0x%08X\n", (unsigned)hr);
    if (FAILED(hr)) return 4;
    return ReadFromSource(source, frames);
}

// Without Windows' camera service or any registration: the DLL's factory makes the source in this
// process, a thread feeds it pictures through the real pipe, and frames are read back.
static int Direct(int frames) {
    wchar_t path[MAX_PATH];
    GetModuleFileNameW(nullptr, path, MAX_PATH);
    wchar_t* slash = wcsrchr(path, L'\\');
    wcscpy_s(slash + 1, MAX_PATH - (slash + 1 - path), L"link-vcam-mf.dll");
    HMODULE dll = LoadLibraryW(path);
    if (!dll) {
        printf("cannot load the DLL: %lu\n", GetLastError());
        return 1;
    }
    typedef HRESULT(STDAPICALLTYPE * GetClassObjectFn)(REFCLSID, REFIID, LPVOID*);
    auto getFactory = (GetClassObjectFn)GetProcAddress(dll, "DllGetClassObject");
    auto startFeed = (StartFn)GetProcAddress(dll, "lvcStartFeedOnly");
    auto send = (SendFn)GetProcAddress(dll, "lvcSendFrameBgr");
    auto stop = (StopFn)GetProcAddress(dll, "lvcStop");
    int hr = startFeed();
    printf("lvcStartFeedOnly: 0x%08X\n", (unsigned)hr);
    if (hr < 0) return 2;

    volatile bool running = true;
    HANDLE sender = CreateThread(nullptr, 0, [](LPVOID arg) -> DWORD {
        volatile bool* flag = (volatile bool*)arg;
        HMODULE self = GetModuleHandleW(L"link-vcam-mf.dll");
        auto sendFrame = (SendFn)GetProcAddress(self, "lvcSendFrameBgr");
        std::vector<unsigned char> frame((size_t)kW * kH * 3);
        for (int n = 0; *flag; ++n) {
            unsigned char tint = (unsigned char)((n * 7) & 0xFF);
            for (int y = 0; y < kH; ++y) {
                unsigned char* row = frame.data() + (size_t)y * kW * 3;
                for (int x = 0; x < kW; ++x) {
                    row[x * 3 + 0] = tint;
                    row[x * 3 + 1] = (unsigned char)(((x + n * 8) / 160 % 2) ? 200 : 60);
                    row[x * 3 + 2] = (unsigned char)(255 - tint);
                }
            }
            sendFrame(frame.data(), kW, kH);
            Sleep(33);
        }
        return 0;
    }, (LPVOID)&running, 0, nullptr);
    (void)send;

    // The camera's frames come from the pipe only once a client has connected, so the source must be
    // started (by the reader) before pictures flow; the sender thread simply keeps offering them.
    IClassFactory* factory = nullptr;
    static const GUID kClsid = {0xb4f5e2a1, 0x6c3d, 0x4e89, {0xa1, 0x7b, 0x5d, 0x2c, 0x9e, 0x8f, 0x1a, 0x30}};
    HRESULT result = getFactory(kClsid, IID_PPV_ARGS(&factory));
    printf("DllGetClassObject: 0x%08X\n", (unsigned)result);
    if (FAILED(result)) return 3;
    IMFActivate* activator = nullptr;
    result = factory->CreateInstance(nullptr, IID_PPV_ARGS(&activator));
    printf("CreateInstance(IMFActivate): 0x%08X\n", (unsigned)result);
    if (FAILED(result)) return 4;
    IMFMediaSource* source = nullptr;
    result = activator->ActivateObject(IID_PPV_ARGS(&source));
    printf("ActivateObject: 0x%08X\n", (unsigned)result);
    if (FAILED(result)) return 5;

    int code = ReadFromSource(source, frames);
    running = false;
    WaitForSingleObject(sender, 2000);
    CloseHandle(sender);
    activator->Release();
    factory->Release();
    stop();
    return code;
}

int wmain(int argc, wchar_t** argv) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION);
    std::wstring command = argc > 1 ? argv[1] : L"list";
    int result = 0;
    if (command == L"list") {
        ListMediaFoundation();
        ListDirectShow();
    } else if (command == L"feed") {
        result = Feed(argc > 2 ? _wtoi(argv[2]) : 20);
    } else if (command == L"read") {
        result = Read(argc > 2 ? _wtoi(argv[2]) : 60);
    } else if (command == L"direct") {
        result = Direct(argc > 2 ? _wtoi(argv[2]) : 60);
    } else {
        printf("usage: lvc-test list | feed [seconds] | read [frames]\n");
        result = 1;
    }
    MFShutdown();
    return result;
}
