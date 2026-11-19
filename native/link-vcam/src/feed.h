#pragma once
#include "common.h"

// ---- Link's side: owns the pipe the camera source reads frames from ----

// Creates the pipe and starts serving it. Fails if another instance already owns it.
HRESULT AppFeedStart();
void AppFeedStop();
// True while the camera source (Windows' Frame Server, on behalf of an app) is connected.
bool AppFeedConnected();
// Hands over the newest frame: exactly kFrameBytes of NV12.
void AppFeedSubmit(const uint8_t* nv12);
// Converts a top-down 24-bit BGR picture of kWidth x kHeight into NV12 (kFrameBytes).
void BgrToNv12(const uint8_t* bgr, uint8_t* nv12);

// ---- The camera source's side (inside Frame Server): reads frames from the pipe ----

class SourceFeed {
public:
    static SourceFeed& Get();
    // The reader runs while at least one stream is started.
    void Acquire();
    void Release();
    // Copies the newest frame (black until the first one arrives). kFrameBytes.
    void CopyLatest(uint8_t* dst);
    bool Connected() const;

private:
    SourceFeed();
    void Run();
    struct Impl;
    Impl* impl_;
};
