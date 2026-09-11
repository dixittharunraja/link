using System;
using Nefarius.ViGEm.Client;
using Nefarius.ViGEm.Client.Exceptions;
using Nefarius.ViGEm.Client.Targets;
using Nefarius.ViGEm.Client.Targets.Xbox360;

namespace JoystickHelper
{
    // Persistent stdin/stdout process, spawned and kept alive by
    // desktop/src/core/plugins/joystick.ts, mirroring the shape of touchpad.ts's mouse-helper.cs
    // (a Console.ReadLine() loop dispatching on the first space-delimited token) but talking to
    // ViGEmBus instead of user32.dll, and — unlike mouse-helper.cs — also WRITING to stdout, since
    // rumble/force-feedback state has to flow back out to the caller.
    //
    // Protocol (see joystick.ts for the TypeScript side):
    //   stdin:  plug <padIndex>                                  — attach virtual pad 0-3
    //           unplug <padIndex>                                — detach virtual pad 0-3
    //           report <padIndex> lx ly rx ry lt rt buttons      — full controller state
    //   stdout: ready                                            — ViGEmBus connected OK at startup
    //           error <reason>                                   — ViGEmBus missing/unusable
    //           rumble <padIndex> <large> <small>                — motor state changed (0-255 each)
    public class Program
    {
        private const int MaxPads = 4;

        // Buttons bitmask bit order — mirrors the phone's "js ..." packet exactly (see
        // JoystickOverlay.tsx and LinkPlugin.java's sendJoystickState), chosen to match
        // Xbox360Button's own grouping so there is no remapping table to keep in sync by hand.
        private const int BtnDPadUp = 1 << 0;
        private const int BtnDPadDown = 1 << 1;
        private const int BtnDPadLeft = 1 << 2;
        private const int BtnDPadRight = 1 << 3;
        private const int BtnStart = 1 << 4;
        private const int BtnBack = 1 << 5;
        private const int BtnLeftShoulder = 1 << 6;
        private const int BtnRightShoulder = 1 << 7;
        private const int BtnA = 1 << 8;
        private const int BtnB = 1 << 9;
        private const int BtnX = 1 << 10;
        private const int BtnY = 1 << 11;

        public static void Main()
        {
            ViGEmClient client;
            try
            {
                client = new ViGEmClient();
            }
            catch (VigemBusNotFoundException)
            {
                Console.WriteLine("error driver_not_found");
                return;
            }
            catch (Exception ex)
            {
                Console.WriteLine("error " + ex.GetType().Name);
                return;
            }

            var pads = new IXbox360Controller?[MaxPads];
            Console.WriteLine("ready");

            string? line;
            while ((line = Console.ReadLine()) != null)
            {
                try
                {
                    string[] parts = line.Split(' ');
                    if (parts.Length == 0) continue;
                    string cmd = parts[0];

                    if (cmd == "plug" && parts.Length >= 2)
                    {
                        int idx = int.Parse(parts[1]);
                        if (idx < 0 || idx >= MaxPads) continue;
                        if (pads[idx] != null) continue; // already plugged
                        var pad = client.CreateXbox360Controller();
                        int capturedIdx = idx;
                        pad.FeedbackReceived += (sender, e) =>
                        {
                            Console.WriteLine($"rumble {capturedIdx} {e.LargeMotor} {e.SmallMotor}");
                        };
                        pad.Connect();
                        pads[idx] = pad;
                    }
                    else if (cmd == "unplug" && parts.Length >= 2)
                    {
                        int idx = int.Parse(parts[1]);
                        if (idx < 0 || idx >= MaxPads) continue;
                        var pad = pads[idx];
                        if (pad == null) continue;
                        try { pad.Disconnect(); } catch { /* already gone */ }
                        pads[idx] = null;
                    }
                    else if (cmd == "report" && parts.Length >= 9)
                    {
                        int idx = int.Parse(parts[1]);
                        if (idx < 0 || idx >= MaxPads) continue;
                        var pad = pads[idx];
                        if (pad == null) continue;

                        int lx = Clamp(int.Parse(parts[2]), -1000, 1000);
                        int ly = Clamp(int.Parse(parts[3]), -1000, 1000);
                        int rx = Clamp(int.Parse(parts[4]), -1000, 1000);
                        int ry = Clamp(int.Parse(parts[5]), -1000, 1000);
                        byte lt = (byte)Clamp(int.Parse(parts[6]), 0, 255);
                        byte rt = (byte)Clamp(int.Parse(parts[7]), 0, 255);
                        int buttons = int.Parse(parts[8]);

                        pad.SetAxisValue(Xbox360Axis.LeftThumbX, ToAxisShort(lx));
                        pad.SetAxisValue(Xbox360Axis.LeftThumbY, ToAxisShort(ly));
                        pad.SetAxisValue(Xbox360Axis.RightThumbX, ToAxisShort(rx));
                        pad.SetAxisValue(Xbox360Axis.RightThumbY, ToAxisShort(ry));
                        pad.SetSliderValue(Xbox360Slider.LeftTrigger, lt);
                        pad.SetSliderValue(Xbox360Slider.RightTrigger, rt);

                        pad.SetButtonState(Xbox360Button.Up, (buttons & BtnDPadUp) != 0);
                        pad.SetButtonState(Xbox360Button.Down, (buttons & BtnDPadDown) != 0);
                        pad.SetButtonState(Xbox360Button.Left, (buttons & BtnDPadLeft) != 0);
                        pad.SetButtonState(Xbox360Button.Right, (buttons & BtnDPadRight) != 0);
                        pad.SetButtonState(Xbox360Button.Start, (buttons & BtnStart) != 0);
                        pad.SetButtonState(Xbox360Button.Back, (buttons & BtnBack) != 0);
                        pad.SetButtonState(Xbox360Button.LeftShoulder, (buttons & BtnLeftShoulder) != 0);
                        pad.SetButtonState(Xbox360Button.RightShoulder, (buttons & BtnRightShoulder) != 0);
                        pad.SetButtonState(Xbox360Button.A, (buttons & BtnA) != 0);
                        pad.SetButtonState(Xbox360Button.B, (buttons & BtnB) != 0);
                        pad.SetButtonState(Xbox360Button.X, (buttons & BtnX) != 0);
                        pad.SetButtonState(Xbox360Button.Y, (buttons & BtnY) != 0);

                        pad.SubmitReport();
                    }
                }
                catch
                {
                    // ignore malformed lines, matching mouse-helper.cs's own tolerance
                }
            }

            foreach (var pad in pads)
            {
                try { pad?.Disconnect(); } catch { }
            }
        }

        // Maps the wire protocol's -1000..1000 range onto XInput's native signed 16-bit thumbstick
        // range (-32768..32767) linearly — kept as a single helper so the scale factor lives in
        // exactly one place rather than being repeated for all four axes above.
        private static short ToAxisShort(int v)
        {
            return (short)Math.Round(v * 32.767);
        }

        private static int Clamp(int v, int min, int max) => v < min ? min : (v > max ? max : v);
    }
}
