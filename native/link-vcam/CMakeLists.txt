cmake_minimum_required(VERSION 3.20)
project(link_vcam CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# The DLL is loaded by a Windows service on machines without the Visual C++ runtime installed for
# it, so the runtime is linked in.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_library(link-vcam-mf SHARED
    src/dllmain.cpp
    src/source.cpp
    src/feed.cpp
    link-vcam-mf.def)
set_target_properties(link-vcam-mf PROPERTIES PREFIX "")
target_compile_definitions(link-vcam-mf PRIVATE UNICODE _UNICODE _WIN32_WINNT=0x0A00)
target_compile_options(link-vcam-mf PRIVATE /W4 /permissive- /EHsc)
target_link_libraries(link-vcam-mf PRIVATE mfplat mf mfuuid mfsensorgroup ole32 uuid advapi32)

# A test program: starts the camera, feeds it a moving picture, and reads it back like an app would.
add_executable(lvc-test test/lvc_test.cpp)
target_compile_definitions(lvc-test PRIVATE UNICODE _UNICODE)
target_link_libraries(lvc-test PRIVATE mfplat mf mfuuid mfreadwrite ole32 oleaut32 strmiids uuid)
