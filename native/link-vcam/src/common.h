#pragma once

// Shared definitions for the Link Windows 11 virtual camera (a Media Foundation virtual camera:
// the kind Store apps such as WhatsApp and the Windows Camera app can see, which DirectShow
// cameras are not).

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <unknwn.h>
#include <initguid.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <mfobjects.h>
#include <mfvirtualcamera.h>
#include <evr.h>
#include <ks.h>
#include <ksmedia.h>
#include <ksproxy.h>
#include <wrl/client.h>

#include <cstdint>

// The COM class Windows' Frame Server creates to get frames from this camera.
// {B4F5E2A1-6C3D-4E89-A17B-5D2C9E8F1A30}
DEFINE_GUID(CLSID_LinkVirtualCamera, 0xb4f5e2a1, 0x6c3d, 0x4e89, 0xa1, 0x7b, 0x5d, 0x2c, 0x9e, 0x8f, 0x1a, 0x30);

constexpr wchar_t kCameraName[] = L"Link Virtual Camera";
constexpr wchar_t kPipeName[] = L"\\\\.\\pipe\\LinkVirtualCamera";

constexpr UINT32 kWidth = 1280;
constexpr UINT32 kHeight = 720;
constexpr UINT32 kFps = 30;
// NV12: a full-size luma plane, then a half-height plane of interleaved U and V.
constexpr UINT32 kFrameBytes = kWidth * kHeight * 3 / 2;

// Frames travel from Link to the media source over a named pipe: one FrameHeader, then kFrameBytes
// of NV12 pixels. The source runs inside a Windows service (Frame Server), a different process,
// session and account from Link, which rules out plain shared memory.
struct FrameHeader {
    UINT32 magic;
    UINT32 width;
    UINT32 height;
    UINT32 sequence;
};
constexpr UINT32 kFrameMagic = 0x4C564346;  // "LVCF"

// Writes a line to the debug log when C:\ProgramData\LinkVcamDebug exists (development only).
void Trace(const wchar_t* format, ...);
