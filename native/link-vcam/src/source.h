#pragma once
#include "common.h"

// Creates the camera's activator, the object Windows' Frame Server asks the class factory for.
// `result` receives it as IMFActivate.
HRESULT CreateLinkActivator(REFIID riid, void** result);

// Counts live COM objects of this DLL, for DllCanUnloadNow.
long LiveObjectCount();
