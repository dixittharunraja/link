#include "feed.h"

#include <sddl.h>

#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <thread>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------------------------
// Debug log (development only)
// ---------------------------------------------------------------------------------------------

void Trace(const wchar_t* format, ...) {
    static const wchar_t kDir[] = L"C:\\ProgramData\\LinkVcamDebug";
    if (GetFileAttributesW(kDir) == INVALID_FILE_ATTRIBUTES) return;  // not a development machine
    wchar_t line[512];
    va_list args;
    va_start(args, format);
    _vsnwprintf_s(line, _countof(line), _TRUNCATE, format, args);
    va_end(args);
    wchar_t path[MAX_PATH];
    swprintf_s(path, L"%s\\vcam-%lu.log", kDir, GetCurrentProcessId());
    HANDLE file = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return;
    SYSTEMTIME t;
    GetLocalTime(&t);
    wchar_t out[640];
    int n = swprintf_s(out, L"%02d:%02d:%02d.%03d %s\r\n", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, line);
    char utf8[1400];
    int bytes = WideCharToMultiByte(CP_UTF8, 0, out, n, utf8, sizeof(utf8), nullptr, nullptr);
    DWORD written;
    WriteFile(file, utf8, bytes, &written, nullptr);
    CloseHandle(file);
}

// ---------------------------------------------------------------------------------------------
// BGR -> NV12
// ---------------------------------------------------------------------------------------------

void BgrToNv12(const uint8_t* bgr, uint8_t* nv12) {
    uint8_t* yPlane = nv12;
    uint8_t* uvPlane = nv12 + kWidth * kHeight;
    // BT.601, limited range. Chroma is the average of each 2x2 block.
    for (UINT32 y = 0; y < kHeight; y += 2) {
        const uint8_t* row0 = bgr + y * kWidth * 3;
        const uint8_t* row1 = row0 + kWidth * 3;
        uint8_t* y0 = yPlane + y * kWidth;
        uint8_t* y1 = y0 + kWidth;
        uint8_t* uv = uvPlane + (y / 2) * kWidth;
        for (UINT32 x = 0; x < kWidth; x += 2) {
            int sumR = 0, sumG = 0, sumB = 0;
            for (int dy = 0; dy < 2; ++dy) {
                const uint8_t* row = dy == 0 ? row0 : row1;
                uint8_t* out = dy == 0 ? y0 : y1;
                for (int dx = 0; dx < 2; ++dx) {
                    const uint8_t* p = row + (x + dx) * 3;
                    int b = p[0], g = p[1], r = p[2];
                    out[x + dx] = (uint8_t)(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
                    sumR += r;
                    sumG += g;
                    sumB += b;
                }
            }
            int r = sumR >> 2, g = sumG >> 2, b = sumB >> 2;
            uv[x] = (uint8_t)(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
            uv[x + 1] = (uint8_t)(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
        }
    }
}

static void FillBlack(uint8_t* nv12) {
    memset(nv12, 16, kWidth * kHeight);
    memset(nv12 + kWidth * kHeight, 128, kWidth * kHeight / 2);
}

// ---------------------------------------------------------------------------------------------
// Link's side: the pipe server
// ---------------------------------------------------------------------------------------------

namespace {

constexpr DWORD kMessageBytes = sizeof(FrameHeader) + kFrameBytes;

struct AppPipe {
    HANDLE pipe = INVALID_HANDLE_VALUE;
    HANDLE stop = nullptr;
    HANDLE frameReady = nullptr;
    std::thread thread;
    std::mutex lock;
    std::vector<uint8_t> latest;
    UINT32 sequence = 0;
    std::atomic<bool> connected{false};
};

AppPipe* g_app = nullptr;
std::mutex g_appLock;

// The pipe may be opened by the camera source (Frame Server runs as LOCAL SERVICE) and by nobody
// else: SYSTEM and administrators for housekeeping, and this user, who owns the pipe.
bool BuildPipeSecurity(SECURITY_ATTRIBUTES* sa, PSECURITY_DESCRIPTOR* descriptor) {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    std::vector<uint8_t> buffer(size);
    bool ok = GetTokenInformation(token, TokenUser, buffer.data(), size, &size) != FALSE;
    CloseHandle(token);
    if (!ok) return false;
    LPWSTR sid = nullptr;
    if (!ConvertSidToStringSidW(((TOKEN_USER*)buffer.data())->User.Sid, &sid)) return false;
    // LS may only read; the owner may do everything.
    std::wstring sddl = L"D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GR;;;LS)(A;;GA;;;";
    sddl += sid;
    sddl += L")";
    LocalFree(sid);
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, descriptor, nullptr)) return false;
    sa->nLength = sizeof(*sa);
    sa->lpSecurityDescriptor = *descriptor;
    sa->bInheritHandle = FALSE;
    return true;
}

void ServePipe(AppPipe* p) {
    HANDLE evConnect = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HANDLE evRead = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HANDLE evWrite = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    std::vector<uint8_t> message(kMessageBytes);
    bool stopping = false;

    while (!stopping) {
        // Wait for the camera source to connect.
        OVERLAPPED connect{};
        connect.hEvent = evConnect;
        ResetEvent(evConnect);
        BOOL ok = ConnectNamedPipe(p->pipe, &connect);
        DWORD error = ok ? 0 : GetLastError();
        if (!ok && error == ERROR_IO_PENDING) {
            HANDLE waits[2] = {p->stop, evConnect};
            if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) == WAIT_OBJECT_0) {
                CancelIoEx(p->pipe, &connect);
                DWORD ignored;
                GetOverlappedResult(p->pipe, &connect, &ignored, TRUE);
                break;
            }
        } else if (!ok && error != ERROR_PIPE_CONNECTED) {
            Trace(L"ConnectNamedPipe failed: %lu", error);
            break;
        }
        p->connected = true;
        Trace(L"source connected");

        // A pending read on the otherwise silent pipe is how a disconnect is noticed.
        OVERLAPPED read{};
        read.hEvent = evRead;
        ResetEvent(evRead);
        uint8_t one;
        bool broken = false;
        if (!ReadFile(p->pipe, &one, 1, nullptr, &read) && GetLastError() != ERROR_IO_PENDING) broken = true;

        while (!broken && !stopping) {
            HANDLE waits[3] = {p->stop, evRead, p->frameReady};
            DWORD r = WaitForMultipleObjects(3, waits, FALSE, INFINITE);
            if (r == WAIT_OBJECT_0) {
                stopping = true;
            } else if (r == WAIT_OBJECT_0 + 1) {
                broken = true;
            } else {
                FrameHeader header{kFrameMagic, kWidth, kHeight, 0};
                {
                    std::lock_guard<std::mutex> guard(p->lock);
                    header.sequence = p->sequence;
                    memcpy(message.data() + sizeof(header), p->latest.data(), kFrameBytes);
                }
                memcpy(message.data(), &header, sizeof(header));
                OVERLAPPED write{};
                write.hEvent = evWrite;
                ResetEvent(evWrite);
                if (!WriteFile(p->pipe, message.data(), kMessageBytes, nullptr, &write)) {
                    if (GetLastError() != ERROR_IO_PENDING) {
                        broken = true;
                        continue;
                    }
                    HANDLE writeWaits[3] = {p->stop, evRead, evWrite};
                    DWORD w = WaitForMultipleObjects(3, writeWaits, FALSE, INFINITE);
                    if (w != WAIT_OBJECT_0 + 2) {
                        stopping = (w == WAIT_OBJECT_0);
                        broken = !stopping;
                        CancelIoEx(p->pipe, &write);
                    }
                    DWORD written;
                    if (!GetOverlappedResult(p->pipe, &write, &written, TRUE) && !stopping) broken = true;
                }
            }
        }

        CancelIoEx(p->pipe, nullptr);
        DWORD ignored;
        GetOverlappedResult(p->pipe, &read, &ignored, TRUE);
        p->connected = false;
        DisconnectNamedPipe(p->pipe);
        Trace(L"source disconnected");
    }

    CloseHandle(evConnect);
    CloseHandle(evRead);
    CloseHandle(evWrite);
}

}  // namespace

HRESULT AppFeedStart() {
    std::lock_guard<std::mutex> guard(g_appLock);
    if (g_app) return S_OK;

    SECURITY_ATTRIBUTES sa{};
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!BuildPipeSecurity(&sa, &descriptor)) return HRESULT_FROM_WIN32(GetLastError());

    auto* p = new AppPipe();
    p->pipe = CreateNamedPipeW(kPipeName, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                               PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4 * kMessageBytes, 4096, 0, &sa);
    DWORD error = GetLastError();
    LocalFree(descriptor);
    if (p->pipe == INVALID_HANDLE_VALUE) {
        delete p;
        return HRESULT_FROM_WIN32(error);
    }
    p->stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    p->frameReady = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    p->latest.resize(kFrameBytes);
    FillBlack(p->latest.data());
    p->thread = std::thread(ServePipe, p);
    g_app = p;
    return S_OK;
}

void AppFeedStop() {
    AppPipe* p;
    {
        std::lock_guard<std::mutex> guard(g_appLock);
        p = g_app;
        g_app = nullptr;
    }
    if (!p) return;
    SetEvent(p->stop);
    p->thread.join();
    CloseHandle(p->pipe);
    CloseHandle(p->stop);
    CloseHandle(p->frameReady);
    delete p;
}

bool AppFeedConnected() {
    std::lock_guard<std::mutex> guard(g_appLock);
    return g_app && g_app->connected;
}

void AppFeedSubmit(const uint8_t* nv12) {
    std::lock_guard<std::mutex> guard(g_appLock);
    if (!g_app || !g_app->connected) return;  // nobody is looking: skip the copy
    {
        std::lock_guard<std::mutex> frame(g_app->lock);
        memcpy(g_app->latest.data(), nv12, kFrameBytes);
        ++g_app->sequence;
    }
    SetEvent(g_app->frameReady);
}

// ---------------------------------------------------------------------------------------------
// The camera source's side: the pipe client
// ---------------------------------------------------------------------------------------------

struct SourceFeed::Impl {
    std::mutex lock;
    int users = 0;
    HANDLE stop = nullptr;
    std::thread thread;
    std::vector<uint8_t> latest;
    std::atomic<bool> connected{false};
};

SourceFeed::SourceFeed() : impl_(new Impl()) {
    impl_->latest.resize(kFrameBytes);
    FillBlack(impl_->latest.data());
}

SourceFeed& SourceFeed::Get() {
    static SourceFeed feed;
    return feed;
}

void SourceFeed::Acquire() {
    std::lock_guard<std::mutex> guard(impl_->lock);
    if (impl_->users++ == 0) {
        impl_->stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        impl_->thread = std::thread([this] { Run(); });
    }
}

void SourceFeed::Release() {
    std::thread worker;
    {
        std::lock_guard<std::mutex> guard(impl_->lock);
        if (impl_->users == 0 || --impl_->users > 0) return;
        SetEvent(impl_->stop);
        worker = std::move(impl_->thread);
    }
    worker.join();
    CloseHandle(impl_->stop);
    impl_->stop = nullptr;
}

void SourceFeed::CopyLatest(uint8_t* dst) {
    std::lock_guard<std::mutex> guard(impl_->lock);
    memcpy(dst, impl_->latest.data(), kFrameBytes);
}

bool SourceFeed::Connected() const { return impl_->connected; }

namespace {

// Reads exactly `total` bytes, giving up early when `stop` is signalled or the pipe breaks.
bool ReadExact(HANDLE pipe, HANDLE stop, HANDLE event, uint8_t* dst, DWORD total) {
    DWORD got = 0;
    while (got < total) {
        OVERLAPPED ov{};
        ov.hEvent = event;
        ResetEvent(event);
        DWORD n = 0;
        if (!ReadFile(pipe, dst + got, total - got, &n, &ov)) {
            if (GetLastError() != ERROR_IO_PENDING) return false;
            HANDLE waits[2] = {stop, event};
            if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) == WAIT_OBJECT_0) {
                CancelIoEx(pipe, &ov);
                GetOverlappedResult(pipe, &ov, &n, TRUE);
                return false;
            }
            if (!GetOverlappedResult(pipe, &ov, &n, FALSE)) return false;
        }
        if (n == 0) return false;
        got += n;
    }
    return true;
}

}  // namespace

void SourceFeed::Run() {
    HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    std::vector<uint8_t> frame(kFrameBytes);
    while (WaitForSingleObject(impl_->stop, 0) != WAIT_OBJECT_0) {
        HANDLE pipe = CreateFileW(kPipeName, GENERIC_READ, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
        if (pipe == INVALID_HANDLE_VALUE) {
            // Link is not running (or is not serving the camera): show black and keep trying.
            if (WaitForSingleObject(impl_->stop, 500) == WAIT_OBJECT_0) break;
            continue;
        }
        impl_->connected = true;
        Trace(L"connected to Link");
        for (;;) {
            FrameHeader header;
            if (!ReadExact(pipe, impl_->stop, event, (uint8_t*)&header, sizeof(header))) break;
            if (header.magic != kFrameMagic || header.width != kWidth || header.height != kHeight) break;
            if (!ReadExact(pipe, impl_->stop, event, frame.data(), kFrameBytes)) break;
            std::lock_guard<std::mutex> guard(impl_->lock);
            memcpy(impl_->latest.data(), frame.data(), kFrameBytes);
        }
        CloseHandle(pipe);
        impl_->connected = false;
        {
            // The picture goes black when Link goes away instead of freezing on the last frame.
            std::lock_guard<std::mutex> guard(impl_->lock);
            FillBlack(impl_->latest.data());
        }
        Trace(L"disconnected from Link");
    }
    CloseHandle(event);
}
