// The Media Foundation media source behind "Link Virtual Camera".
//
// Windows' Frame Server (a service) loads this DLL, asks the class factory for the activator, and
// from it gets the media source: one live video stream of NV12 frames. The structure follows
// Simon Mourier's VCamSample (MIT, https://github.com/smourier/VCamSample) and Microsoft's
// documentation of MFCreateVirtualCamera; the code here is written for Link and has no
// dependencies beyond the Windows SDK. Frames come from Link over a named pipe (feed.cpp).

#include "source.h"

#include <condition_variable>
#include <chrono>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

#include "feed.h"

using Microsoft::WRL::ComPtr;

static std::atomic<long> g_liveObjects{0};
long LiveObjectCount() { return g_liveObjects; }

// IMFAttributes is thirty methods of pure forwarding; every class here that is an attribute store
// (the activator, the source, the stream) keeps a real store and forwards to it.
#define FORWARD_IMFATTRIBUTES(store)                                                                                           \
    STDMETHODIMP GetItem(REFGUID k, PROPVARIANT* v) override { return store->GetItem(k, v); }                                   \
    STDMETHODIMP GetItemType(REFGUID k, MF_ATTRIBUTE_TYPE* t) override { return store->GetItemType(k, t); }                      \
    STDMETHODIMP CompareItem(REFGUID k, REFPROPVARIANT v, BOOL* r) override { return store->CompareItem(k, v, r); }              \
    STDMETHODIMP Compare(IMFAttributes* o, MF_ATTRIBUTES_MATCH_TYPE t, BOOL* r) override { return store->Compare(o, t, r); }     \
    STDMETHODIMP GetUINT32(REFGUID k, UINT32* v) override { return store->GetUINT32(k, v); }                                     \
    STDMETHODIMP GetUINT64(REFGUID k, UINT64* v) override { return store->GetUINT64(k, v); }                                     \
    STDMETHODIMP GetDouble(REFGUID k, double* v) override { return store->GetDouble(k, v); }                                     \
    STDMETHODIMP GetGUID(REFGUID k, GUID* v) override { return store->GetGUID(k, v); }                                           \
    STDMETHODIMP GetStringLength(REFGUID k, UINT32* n) override { return store->GetStringLength(k, n); }                         \
    STDMETHODIMP GetString(REFGUID k, LPWSTR b, UINT32 s, UINT32* n) override { return store->GetString(k, b, s, n); }           \
    STDMETHODIMP GetAllocatedString(REFGUID k, LPWSTR* b, UINT32* n) override { return store->GetAllocatedString(k, b, n); }     \
    STDMETHODIMP GetBlobSize(REFGUID k, UINT32* n) override { return store->GetBlobSize(k, n); }                                 \
    STDMETHODIMP GetBlob(REFGUID k, UINT8* b, UINT32 s, UINT32* n) override { return store->GetBlob(k, b, s, n); }               \
    STDMETHODIMP GetAllocatedBlob(REFGUID k, UINT8** b, UINT32* n) override { return store->GetAllocatedBlob(k, b, n); }         \
    STDMETHODIMP GetUnknown(REFGUID k, REFIID i, LPVOID* v) override { return store->GetUnknown(k, i, v); }                      \
    STDMETHODIMP SetItem(REFGUID k, REFPROPVARIANT v) override { return store->SetItem(k, v); }                                  \
    STDMETHODIMP DeleteItem(REFGUID k) override { return store->DeleteItem(k); }                                                 \
    STDMETHODIMP DeleteAllItems() override { return store->DeleteAllItems(); }                                                   \
    STDMETHODIMP SetUINT32(REFGUID k, UINT32 v) override { return store->SetUINT32(k, v); }                                      \
    STDMETHODIMP SetUINT64(REFGUID k, UINT64 v) override { return store->SetUINT64(k, v); }                                      \
    STDMETHODIMP SetDouble(REFGUID k, double v) override { return store->SetDouble(k, v); }                                      \
    STDMETHODIMP SetGUID(REFGUID k, REFGUID v) override { return store->SetGUID(k, v); }                                         \
    STDMETHODIMP SetString(REFGUID k, LPCWSTR v) override { return store->SetString(k, v); }                                     \
    STDMETHODIMP SetBlob(REFGUID k, const UINT8* b, UINT32 n) override { return store->SetBlob(k, b, n); }                       \
    STDMETHODIMP SetUnknown(REFGUID k, IUnknown* v) override { return store->SetUnknown(k, v); }                                 \
    STDMETHODIMP LockStore() override { return store->LockStore(); }                                                             \
    STDMETHODIMP UnlockStore() override { return store->UnlockStore(); }                                                         \
    STDMETHODIMP GetCount(UINT32* n) override { return store->GetCount(n); }                                                     \
    STDMETHODIMP GetItemByIndex(UINT32 i, GUID* k, PROPVARIANT* v) override { return store->GetItemByIndex(i, k, v); }           \
    STDMETHODIMP CopyAllItems(IMFAttributes* d) override { return store->CopyAllItems(d); }

#define LVC_REFCOUNT()                                                    \
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }         \
    ULONG STDMETHODCALLTYPE Release() override {                          \
        ULONG r = --refs_;                                                \
        if (r == 0) delete this;                                          \
        return r;                                                         \
    }

#define LVC_UNSUPPORTED_KS()                                                                                                                  \
    STDMETHODIMP KsProperty(PKSPROPERTY, ULONG, LPVOID, ULONG, ULONG*) override { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }         \
    STDMETHODIMP KsMethod(PKSMETHOD, ULONG, LPVOID, ULONG, ULONG*) override { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }             \
    STDMETHODIMP KsEvent(PKSEVENT, ULONG, LPVOID, ULONG, ULONG*) override { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }

// ---------------------------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------------------------

class MediaStream final : public IMFMediaStream2, public IMFAttributes, public IKsControl {
public:
    MediaStream() {
        ++g_liveObjects;
        MFCreateAttributes(&attrs_, 8);
    }

    ~MediaStream() {
        StopWorker();
        --g_liveObjects;
    }

    HRESULT Initialize(IMFMediaSource* source) {
        source_ = source;
        HRESULT hr = S_OK;
        if (SUCCEEDED(hr)) hr = attrs_->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE);
        if (SUCCEEDED(hr)) hr = attrs_->SetUINT32(MF_DEVICESTREAM_STREAM_ID, 0);
        if (SUCCEEDED(hr)) hr = attrs_->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
        if (SUCCEEDED(hr)) hr = attrs_->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, MFFrameSourceTypes_Color);
        if (FAILED(hr)) return hr;
        hr = MFCreateEventQueue(&queue_);
        if (FAILED(hr)) return hr;

        ComPtr<IMFMediaType> type;
        hr = MFCreateMediaType(&type);
        if (FAILED(hr)) return hr;
        type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
        type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        type->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
        MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, kWidth, kHeight);
        type->SetUINT32(MF_MT_DEFAULT_STRIDE, kWidth);
        MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, kFps, 1);
        MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
        type->SetUINT32(MF_MT_AVG_BITRATE, kFrameBytes * 8 * kFps);

        IMFMediaType* types[] = {type.Get()};
        hr = MFCreateStreamDescriptor(0, 1, types, &descriptor_);
        if (FAILED(hr)) return hr;
        ComPtr<IMFMediaTypeHandler> handler;
        hr = descriptor_->GetMediaTypeHandler(&handler);
        if (FAILED(hr)) return hr;
        return handler->SetCurrentMediaType(type.Get());
    }

    MF_STREAM_STATE State() {
        std::lock_guard<std::mutex> guard(lock_);
        return state_;
    }

    HRESULT SetAllocator(IUnknown* allocator) {
        if (!allocator) return E_POINTER;
        ComPtr<IMFVideoSampleAllocatorEx> typed;
        HRESULT hr = allocator->QueryInterface(IID_PPV_ARGS(&typed));
        if (FAILED(hr)) return hr;
        std::lock_guard<std::mutex> guard(lock_);
        allocator_ = typed;
        return S_OK;
    }

    HRESULT StartStream(IMFMediaType* type) {
        ComPtr<IMFMediaType> current(type);
        if (!current) {
            ComPtr<IMFMediaTypeHandler> handler;
            if (!descriptor_ || FAILED(descriptor_->GetMediaTypeHandler(&handler)) || FAILED(handler->GetCurrentMediaType(&current))) {
                return MF_E_SHUTDOWN;
            }
        }
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (!queue_) return MF_E_SHUTDOWN;
            Trace(L"StartStream allocator=%d", allocator_ ? 1 : 0);
            if (allocator_) {
                HRESULT hr = allocator_->InitializeSampleAllocator(10, current.Get());
                if (FAILED(hr)) return hr;
            }
        }
        SourceFeed::Get().Acquire();
        {
            std::lock_guard<std::mutex> guard(lock_);
            running_ = true;
            state_ = MF_STREAM_STATE_RUNNING;
            if (!worker_.joinable()) worker_ = std::thread([this] { Work(); });
        }
        queue_->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr);
        cv_.notify_all();
        Trace(L"stream started");
        return S_OK;
    }

    HRESULT StopStream() {
        bool wasRunning;
        {
            std::lock_guard<std::mutex> guard(lock_);
            wasRunning = state_ != MF_STREAM_STATE_STOPPED;
            running_ = false;
            state_ = MF_STREAM_STATE_STOPPED;
            tokens_.clear();
        }
        cv_.notify_all();
        if (wasRunning) {
            SourceFeed::Get().Release();
            if (allocator_) allocator_->UninitializeSampleAllocator();
            if (queue_) queue_->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr);
            Trace(L"stream stopped");
        }
        return S_OK;
    }

    void ShutdownStream() {
        StopStream();
        StopWorker();
        std::lock_guard<std::mutex> guard(lock_);
        if (queue_) {
            queue_->Shutdown();
            queue_.Reset();
        }
        descriptor_.Reset();
        source_.Reset();
        allocator_.Reset();
    }

    // IUnknown
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        *ppv = nullptr;
        if (riid == IID_IUnknown || riid == IID_IMFMediaEventGenerator || riid == IID_IMFMediaStream || riid == IID_IMFMediaStream2) {
            *ppv = static_cast<IMFMediaStream2*>(this);
        } else if (riid == IID_IMFAttributes) {
            *ppv = static_cast<IMFAttributes*>(this);
        } else if (riid == __uuidof(IKsControl)) {
            *ppv = static_cast<IKsControl*>(this);
        } else {
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }
    LVC_REFCOUNT()

    // IMFMediaEventGenerator
    STDMETHODIMP BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override {
        ComPtr<IMFMediaEventQueue> queue = Queue();
        return queue ? queue->BeginGetEvent(callback, state) : MF_E_SHUTDOWN;
    }
    STDMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) override {
        if (!event) return E_POINTER;
        ComPtr<IMFMediaEventQueue> queue = Queue();
        return queue ? queue->EndGetEvent(result, event) : MF_E_SHUTDOWN;
    }
    STDMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** event) override {
        if (!event) return E_POINTER;
        ComPtr<IMFMediaEventQueue> queue = Queue();
        return queue ? queue->GetEvent(flags, event) : MF_E_SHUTDOWN;
    }
    STDMETHODIMP QueueEvent(MediaEventType type, REFGUID extended, HRESULT status, const PROPVARIANT* value) override {
        ComPtr<IMFMediaEventQueue> queue = Queue();
        return queue ? queue->QueueEventParamVar(type, extended, status, value) : MF_E_SHUTDOWN;
    }

    // IMFMediaStream
    STDMETHODIMP GetMediaSource(IMFMediaSource** source) override {
        if (!source) return E_POINTER;
        *source = nullptr;
        std::lock_guard<std::mutex> guard(lock_);
        if (!source_) return MF_E_SHUTDOWN;
        return source_.CopyTo(source);
    }
    STDMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** descriptor) override {
        if (!descriptor) return E_POINTER;
        *descriptor = nullptr;
        std::lock_guard<std::mutex> guard(lock_);
        if (!descriptor_) return MF_E_SHUTDOWN;
        return descriptor_.CopyTo(descriptor);
    }
    STDMETHODIMP RequestSample(IUnknown* token) override {
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (!queue_) return MF_E_SHUTDOWN;
            if (state_ == MF_STREAM_STATE_STOPPED) return MF_E_INVALIDREQUEST;
            tokens_.push_back(ComPtr<IUnknown>(token));
        }
        cv_.notify_all();
        return S_OK;
    }

    // IMFMediaStream2
    STDMETHODIMP SetStreamState(MF_STREAM_STATE value) override {
        MF_STREAM_STATE current = State();
        if (current == value) return S_OK;
        switch (value) {
            case MF_STREAM_STATE_PAUSED:
                if (current != MF_STREAM_STATE_RUNNING) return MF_E_INVALID_STATE_TRANSITION;
                {
                    std::lock_guard<std::mutex> guard(lock_);
                    running_ = false;
                    state_ = value;
                }
                return S_OK;
            case MF_STREAM_STATE_RUNNING:
                if (current == MF_STREAM_STATE_PAUSED) {
                    std::lock_guard<std::mutex> guard(lock_);
                    running_ = true;
                    state_ = value;
                    cv_.notify_all();
                    return S_OK;
                }
                return StartStream(nullptr);
            case MF_STREAM_STATE_STOPPED:
                return StopStream();
            default:
                return MF_E_INVALID_STATE_TRANSITION;
        }
    }
    STDMETHODIMP GetStreamState(MF_STREAM_STATE* value) override {
        if (!value) return E_POINTER;
        *value = State();
        return S_OK;
    }

    FORWARD_IMFATTRIBUTES(attrs_)
    LVC_UNSUPPORTED_KS()

private:
    ComPtr<IMFMediaEventQueue> Queue() {
        std::lock_guard<std::mutex> guard(lock_);
        return queue_;
    }

    void StopWorker() {
        {
            std::lock_guard<std::mutex> guard(lock_);
            quit_ = true;
        }
        cv_.notify_all();
        if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id()) worker_.join();
    }

    // Answers the pipeline's sample requests at the camera's frame rate. A request is a token; the
    // answer is a sample carrying it. With no new picture the last one is repeated, so an app
    // always has something to show.
    void Work() {
        using Clock = std::chrono::steady_clock;
        const auto period = std::chrono::nanoseconds(1000000000LL / kFps);
        auto next = Clock::now();
        std::unique_lock<std::mutex> lk(lock_);
        while (!quit_) {
            cv_.wait(lk, [&] { return quit_ || (running_ && !tokens_.empty()); });
            if (quit_) break;
            auto now = Clock::now();
            if (next > now) {
                cv_.wait_until(lk, next, [&] { return quit_ || !running_; });
                continue;  // re-evaluate: state may have changed while waiting
            }
            if (now - next > period * 3) next = now;  // fell behind: do not burst to catch up
            next += period;
            ComPtr<IUnknown> token = tokens_.front();
            tokens_.pop_front();
            ComPtr<IMFVideoSampleAllocatorEx> allocator = allocator_;
            ComPtr<IMFMediaEventQueue> queue = queue_;
            lk.unlock();
            Deliver(allocator.Get(), token.Get(), queue.Get());
            lk.lock();
        }
    }

    void Deliver(IMFVideoSampleAllocatorEx* allocator, IUnknown* token, IMFMediaEventQueue* queue) {
        if (!queue) return;
        ComPtr<IMFSample> sample;
        if (allocator) {
            if (FAILED(allocator->AllocateSample(&sample))) return;
        } else {
            ComPtr<IMFMediaBuffer> buffer;
            if (FAILED(MFCreateSample(&sample)) || FAILED(MFCreateMemoryBuffer(kFrameBytes, &buffer)) || FAILED(sample->AddBuffer(buffer.Get()))) return;
        }
        ComPtr<IMFMediaBuffer> buffer;
        if (FAILED(sample->GetBufferByIndex(0, &buffer))) return;
        if (!Fill(buffer.Get())) return;

        sample->SetSampleTime(MFGetSystemTime());
        sample->SetSampleDuration(10000000LL / kFps);
        if (token) sample->SetUnknown(MFSampleExtension_Token, token);
        queue->QueueEventParamUnk(MEMediaSample, GUID_NULL, S_OK, sample.Get());
    }

    bool Fill(IMFMediaBuffer* buffer) {
        std::vector<uint8_t>& frame = frame_;
        frame.resize(kFrameBytes);
        SourceFeed::Get().CopyLatest(frame.data());

        ComPtr<IMF2DBuffer> flat;
        if (SUCCEEDED(buffer->QueryInterface(IID_PPV_ARGS(&flat)))) {
            BYTE* base = nullptr;
            LONG pitch = 0;
            if (FAILED(flat->Lock2D(&base, &pitch)) || pitch <= 0) return false;
            // NV12 in a 2-D buffer: the luma rows, then the chroma rows at the same pitch.
            for (UINT32 y = 0; y < kHeight; ++y) memcpy(base + (size_t)y * pitch, frame.data() + (size_t)y * kWidth, kWidth);
            BYTE* chroma = base + (size_t)pitch * kHeight;
            for (UINT32 y = 0; y < kHeight / 2; ++y) memcpy(chroma + (size_t)y * pitch, frame.data() + kWidth * kHeight + (size_t)y * kWidth, kWidth);
            flat->Unlock2D();
            buffer->SetCurrentLength((DWORD)((size_t)pitch * kHeight * 3 / 2));
            return true;
        }
        BYTE* data = nullptr;
        DWORD maxLength = 0, currentLength = 0;
        if (FAILED(buffer->Lock(&data, &maxLength, &currentLength)) || maxLength < kFrameBytes) return false;
        memcpy(data, frame.data(), kFrameBytes);
        buffer->Unlock();
        buffer->SetCurrentLength(kFrameBytes);
        return true;
    }

    std::atomic<ULONG> refs_{1};
    std::mutex lock_;
    std::condition_variable cv_;
    std::thread worker_;
    bool quit_ = false;
    bool running_ = false;
    MF_STREAM_STATE state_ = MF_STREAM_STATE_STOPPED;
    std::deque<ComPtr<IUnknown>> tokens_;
    std::vector<uint8_t> frame_;
    ComPtr<IMFAttributes> attrs_;
    ComPtr<IMFMediaEventQueue> queue_;
    ComPtr<IMFStreamDescriptor> descriptor_;
    ComPtr<IMFMediaSource> source_;
    ComPtr<IMFVideoSampleAllocatorEx> allocator_;
};

// ---------------------------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------------------------

class MediaSource final : public IMFMediaSourceEx, public IMFAttributes, public IMFGetService, public IKsControl, public IMFSampleAllocatorControl {
public:
    MediaSource() {
        ++g_liveObjects;
        MFCreateAttributes(&attrs_, 8);
    }

    ~MediaSource() {
        if (stream_) stream_->Release();
        --g_liveObjects;
    }

    HRESULT Initialize(IMFAttributes* fromActivator) {
        if (fromActivator) {
            HRESULT hr = fromActivator->CopyAllItems(static_cast<IMFAttributes*>(this));
            if (FAILED(hr)) return hr;
        }

        // Frame Server wants the camera profiles it supports spelled out.
        ComPtr<IMFSensorProfileCollection> collection;
        HRESULT hr = MFCreateSensorProfileCollection(&collection);
        if (FAILED(hr)) return hr;
        ComPtr<IMFSensorProfile> profile;
        hr = MFCreateSensorProfile(KSCAMERAPROFILE_Legacy, 0, nullptr, &profile);
        if (FAILED(hr)) return hr;
        profile->AddProfileFilter(0, L"((RES==;FRT<=30,1;SUT==))");
        collection->AddProfile(profile.Get());
        profile.Reset();
        hr = MFCreateSensorProfile(KSCAMERAPROFILE_HighFrameRate, 0, nullptr, &profile);
        if (FAILED(hr)) return hr;
        profile->AddProfileFilter(0, L"((RES==;FRT>=60,1;SUT==))");
        collection->AddProfile(profile.Get());
        hr = attrs_->SetUnknown(MF_DEVICEMFT_SENSORPROFILE_COLLECTION, collection.Get());
        if (FAILED(hr)) return hr;

        stream_ = new MediaStream();
        hr = stream_->Initialize(this);
        if (FAILED(hr)) return hr;
        ComPtr<IMFStreamDescriptor> descriptor;
        hr = stream_->GetStreamDescriptor(&descriptor);
        if (FAILED(hr)) return hr;
        IMFStreamDescriptor* descriptors[] = {descriptor.Get()};
        hr = MFCreatePresentationDescriptor(1, descriptors, &presentation_);
        if (FAILED(hr)) return hr;
        // A new presentation descriptor has every stream deselected, and clients copy this one: the
        // stream has to start out selected or a source reader would never start it.
        hr = presentation_->SelectStream(0);
        if (FAILED(hr)) return hr;
        return MFCreateEventQueue(&queue_);
    }

    // IUnknown
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        *ppv = nullptr;
        if (riid == IID_IUnknown || riid == IID_IMFMediaEventGenerator || riid == IID_IMFMediaSource || riid == IID_IMFMediaSourceEx) {
            *ppv = static_cast<IMFMediaSourceEx*>(this);
        } else if (riid == IID_IMFAttributes) {
            *ppv = static_cast<IMFAttributes*>(this);
        } else if (riid == IID_IMFGetService) {
            *ppv = static_cast<IMFGetService*>(this);
        } else if (riid == __uuidof(IKsControl)) {
            *ppv = static_cast<IKsControl*>(this);
        } else if (riid == IID_IMFSampleAllocatorControl) {
            *ppv = static_cast<IMFSampleAllocatorControl*>(this);
        } else {
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }
    LVC_REFCOUNT()

    // IMFMediaEventGenerator
    STDMETHODIMP BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override {
        ComPtr<IMFMediaEventQueue> queue = Queue();
        return queue ? queue->BeginGetEvent(callback, state) : MF_E_SHUTDOWN;
    }
    STDMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) override {
        if (!event) return E_POINTER;
        ComPtr<IMFMediaEventQueue> queue = Queue();
        return queue ? queue->EndGetEvent(result, event) : MF_E_SHUTDOWN;
    }
    STDMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** event) override {
        if (!event) return E_POINTER;
        ComPtr<IMFMediaEventQueue> queue = Queue();
        return queue ? queue->GetEvent(flags, event) : MF_E_SHUTDOWN;
    }
    STDMETHODIMP QueueEvent(MediaEventType type, REFGUID extended, HRESULT status, const PROPVARIANT* value) override {
        ComPtr<IMFMediaEventQueue> queue = Queue();
        return queue ? queue->QueueEventParamVar(type, extended, status, value) : MF_E_SHUTDOWN;
    }

    // IMFMediaSource
    STDMETHODIMP CreatePresentationDescriptor(IMFPresentationDescriptor** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        std::lock_guard<std::mutex> guard(lock_);
        if (!presentation_) return MF_E_SHUTDOWN;
        return presentation_->Clone(out);
    }
    STDMETHODIMP GetCharacteristics(DWORD* characteristics) override {
        if (!characteristics) return E_POINTER;
        *characteristics = MFMEDIASOURCE_IS_LIVE;
        return S_OK;
    }
    STDMETHODIMP Pause() override { return MF_E_INVALID_STATE_TRANSITION; }
    STDMETHODIMP Shutdown() override {
        std::lock_guard<std::mutex> guard(lock_);
        if (!queue_) return MF_E_SHUTDOWN;
        queue_->Shutdown();
        queue_.Reset();
        if (stream_) stream_->ShutdownStream();
        presentation_.Reset();
        return S_OK;
    }
    STDMETHODIMP Start(IMFPresentationDescriptor* descriptor, const GUID* timeFormat, const PROPVARIANT* position) override {
        Trace(L"Source::Start");
        if (!descriptor || !position) return E_POINTER;
        if (timeFormat && *timeFormat != GUID_NULL) return E_INVALIDARG;
        std::lock_guard<std::mutex> guard(lock_);
        if (!queue_ || !presentation_) return MF_E_SHUTDOWN;

        DWORD count = 0;
        HRESULT hr = descriptor->GetStreamDescriptorCount(&count);
        Trace(L"Source::Start descriptors=%lu hr=0x%08X", count, (unsigned)hr);
        if (FAILED(hr)) return hr;
        if (count != 1) return E_INVALIDARG;

        ComPtr<IMFStreamDescriptor> requested;
        BOOL selected = FALSE;
        hr = descriptor->GetStreamDescriptorByIndex(0, &selected, &requested);
        if (FAILED(hr)) return hr;

        if (selected) {
            bool wasRunning = stream_->State() != MF_STREAM_STATE_STOPPED;
            presentation_->SelectStream(0);
            queue_->QueueEventParamUnk(wasRunning ? MEUpdatedStream : MENewStream, GUID_NULL, S_OK, static_cast<IMFMediaStream2*>(stream_));
            // The client may have chosen a media type on its copy of the descriptor.
            ComPtr<IMFMediaTypeHandler> handler;
            ComPtr<IMFMediaType> type;
            if (SUCCEEDED(requested->GetMediaTypeHandler(&handler))) handler->GetCurrentMediaType(&type);
            hr = stream_->StartStream(type.Get());
            Trace(L"Source::Start StartStream hr=0x%08X", (unsigned)hr);
        } else {
            presentation_->DeselectStream(0);
            hr = stream_->StopStream();
        }
        if (FAILED(hr)) return hr;

        PROPVARIANT time;
        PropVariantInit(&time);
        time.vt = VT_I8;
        time.hVal.QuadPart = MFGetSystemTime();
        return queue_->QueueEventParamVar(MESourceStarted, GUID_NULL, S_OK, &time);
    }
    STDMETHODIMP Stop() override {
        std::lock_guard<std::mutex> guard(lock_);
        if (!queue_ || !presentation_) return MF_E_SHUTDOWN;
        stream_->StopStream();
        presentation_->DeselectStream(0);
        PROPVARIANT time;
        PropVariantInit(&time);
        time.vt = VT_I8;
        time.hVal.QuadPart = MFGetSystemTime();
        return queue_->QueueEventParamVar(MESourceStopped, GUID_NULL, S_OK, &time);
    }

    // IMFMediaSourceEx
    STDMETHODIMP GetSourceAttributes(IMFAttributes** attributes) override {
        if (!attributes) return E_POINTER;
        return QueryInterface(IID_PPV_ARGS(attributes));
    }
    STDMETHODIMP GetStreamAttributes(DWORD id, IMFAttributes** attributes) override {
        if (!attributes) return E_POINTER;
        *attributes = nullptr;
        if (id != 0 || !stream_) return E_INVALIDARG;
        return stream_->QueryInterface(IID_PPV_ARGS(attributes));
    }
    STDMETHODIMP SetD3DManager(IUnknown* manager) override {
        // Samples are made in system memory, which every client can read; the manager is not used.
        return manager ? S_OK : E_POINTER;
    }

    // IMFGetService
    STDMETHODIMP GetService(REFGUID, REFIID, LPVOID*) override { return MF_E_UNSUPPORTED_SERVICE; }

    // IMFSampleAllocatorControl
    STDMETHODIMP SetDefaultAllocator(DWORD outputStream, IUnknown* allocator) override {
        if (!allocator) return E_POINTER;
        if (outputStream != 0 || !stream_) return E_INVALIDARG;
        return stream_->SetAllocator(allocator);
    }
    STDMETHODIMP GetAllocatorUsage(DWORD outputStream, DWORD* inputStream, MFSampleAllocatorUsage* usage) override {
        if (!inputStream || !usage) return E_POINTER;
        if (outputStream != 0) return E_INVALIDARG;
        *inputStream = outputStream;
        *usage = MFSampleAllocatorUsage_UsesProvidedAllocator;
        return S_OK;
    }

    FORWARD_IMFATTRIBUTES(attrs_)
    LVC_UNSUPPORTED_KS()

private:
    ComPtr<IMFMediaEventQueue> Queue() {
        std::lock_guard<std::mutex> guard(lock_);
        return queue_;
    }

    std::atomic<ULONG> refs_{1};
    std::mutex lock_;
    ComPtr<IMFAttributes> attrs_;
    MediaStream* stream_ = nullptr;  // owned: one reference, released in the destructor
    ComPtr<IMFMediaEventQueue> queue_;
    ComPtr<IMFPresentationDescriptor> presentation_;
};

// ---------------------------------------------------------------------------------------------
// The activator: what the class factory hands Frame Server
// ---------------------------------------------------------------------------------------------

class Activator final : public IMFActivate {
public:
    Activator() {
        ++g_liveObjects;
        MFCreateAttributes(&attrs_, 8);
    }
    ~Activator() {
        if (source_) source_->Release();
        --g_liveObjects;
    }

    HRESULT Initialize() {
        source_ = new MediaSource();
        HRESULT hr = attrs_->SetUINT32(MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES, 1);
        if (SUCCEEDED(hr)) hr = attrs_->SetGUID(MFT_TRANSFORM_CLSID_Attribute, CLSID_LinkVirtualCamera);
        if (SUCCEEDED(hr)) hr = source_->Initialize(this);
        return hr;
    }

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        *ppv = nullptr;
        if (riid == IID_IUnknown || riid == IID_IMFActivate) {
            *ppv = static_cast<IMFActivate*>(this);
        } else if (riid == IID_IMFAttributes) {
            *ppv = static_cast<IMFAttributes*>(this);
        } else {
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }
    LVC_REFCOUNT()

    // IMFActivate
    STDMETHODIMP ActivateObject(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        *ppv = nullptr;
        if (!source_) return MF_E_SHUTDOWN;
        Trace(L"ActivateObject");
        return source_->QueryInterface(riid, ppv);
    }
    STDMETHODIMP ShutdownObject() override { return S_OK; }
    STDMETHODIMP DetachObject() override {
        if (source_) source_->Release();
        source_ = nullptr;
        return S_OK;
    }

    FORWARD_IMFATTRIBUTES(attrs_)

private:
    std::atomic<ULONG> refs_{1};
    ComPtr<IMFAttributes> attrs_;
    MediaSource* source_ = nullptr;  // owned: one reference
};

HRESULT CreateLinkActivator(REFIID riid, void** result) {
    if (!result) return E_POINTER;
    *result = nullptr;
    Activator* activator = new Activator();
    HRESULT hr = activator->Initialize();
    if (SUCCEEDED(hr)) hr = activator->QueryInterface(riid, result);
    activator->Release();
    return hr;
}
