softcam.dll - DirectShow virtual camera, MIT licensed, see LICENSE.txt.
Source: https://github.com/tshino/softcam (commit d1acde4), built for x64 (Release).
Modified only to rename the camera from "DirectShow Softcam" to "Link Virtual Camera" (the display name,
the stream name and the shared-memory names); no functional change.
Link feeds it frames from a paired phone's camera so other apps can use that phone as a webcam.
The installer registers it with regsvr32; the app registers it on first use when running unpacked.
