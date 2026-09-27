#!/bin/bash
# Captures audio via PulseAudio/PipeWire, prefixed with a JSON header matching the Windows
# audio-capture.ps1 output contract (one JSON line, then raw PCM forever).
# Usage: ./audio-capture.sh <device_name>
DEVICE=$1

if [ -z "$DEVICE" ]; then
    echo "Error: Device name required" >&2
    exit 1
fi

if [ "$DEVICE" = "@DEFAULT_SINK@.monitor" ]; then
    DEFAULT_SINK=$(pactl get-default-sink 2>/dev/null || echo "")
    if [ -n "$DEFAULT_SINK" ]; then
        DEVICE="${DEFAULT_SINK}.monitor"
    fi
elif [ "$DEVICE" = "@DEFAULT_SOURCE@" ]; then
    DEFAULT_SOURCE=$(pactl get-default-source 2>/dev/null || echo "")
    if [ -n "$DEFAULT_SOURCE" ]; then
        DEVICE="${DEFAULT_SOURCE}"
    fi
fi

echo '{"sampleRate":48000,"channels":2,"bitsPerSample":16,"isFloat":false}'
exec parec --format=s16le --rate=48000 --channels=2 -d "$DEVICE"
