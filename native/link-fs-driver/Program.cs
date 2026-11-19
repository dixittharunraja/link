using System;
using System.Text.Json;
using System.Threading;
using Fsp;

namespace Link.FsDriver;

class Program
{
    static int Main(string[] args)
    {
        string driveLetter = "Z:";
        string volumeLabel  = "Phone";
        int    apiPort      = 0;
        string apiToken     = "";
        long   cacheSizeMb  = 512;

        for (int i = 0; i < args.Length - 1; i++)
        {
            switch (args[i])
            {
                case "--drive-letter":  driveLetter = args[++i]; break;
                case "--volume-label":  volumeLabel  = args[++i]; break;
                case "--api-port":      apiPort      = int.Parse(args[++i]); break;
                case "--api-token":     apiToken     = args[++i]; break;
                case "--cache-size-mb": cacheSizeMb  = long.Parse(args[++i]); break;
            }
        }

        if (apiPort == 0 || string.IsNullOrEmpty(apiToken))
        {
            Console.Error.WriteLine("Usage: link-fs-driver --drive-letter Z: --volume-label Label --api-port N --api-token TOKEN [--cache-size-mb N]");
            return 1;
        }

        Console.Error.WriteLine($"[LinkFsDriver] Starting — drive={driveLetter} port={apiPort} cache={cacheSizeMb}MB");

        using var api = new ApiClient(apiPort, apiToken);

        FsRoot[] roots;
        try
        {
            roots = api.Roots();
            if (roots.Length == 0) throw new Exception("No roots returned from device");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[LinkFsDriver] Failed to fetch roots: {ex.Message}");
            return 1;
        }

        Console.Error.WriteLine($"[LinkFsDriver] Roots: {JsonSerializer.Serialize(roots)}");

        var fs   = new LinkFileSystem(api, roots, cacheSizeMb * 1024 * 1024);
        using var host = new FileSystemHost(fs);

        host.Prefix         = null;
        host.FileSystemName = "NTFS";
        host.SectorSize     = 512;
        host.SectorsPerAllocationUnit = 1;
        host.MaxComponentLength       = 255;
        host.FileInfoTimeout          = 10_000;
        host.CaseSensitiveSearch      = false;
        host.CasePreservedNames       = true;
        host.UnicodeOnDisk            = true;
        host.PersistentAcls           = false;
        host.ReparsePoints            = false;
        host.NamedStreams              = false;
        host.PostCleanupWhenModifiedOnly  = true;
        host.PassQueryDirectoryPattern    = true;

        // MountEx(mountPoint, threadCount, securityDescriptor, synchronous, debugFlags)
        int status = host.MountEx(driveLetter, 8, null, false, 0);
        if (status != 0)
        {
            Console.Error.WriteLine($"[LinkFsDriver] Mount failed — NT status 0x{status:X8}");
            return 1;
        }

        Console.Error.WriteLine($"[LinkFsDriver] Mounted on {driveLetter}");
        // The parent app (src-tauri/src/core/mount.rs) waits for this line to know the mount is ready.
        Console.Error.WriteLine("LINK_FS_DRIVER_READY");
        Console.Error.Flush();

        // Block until killed by the parent app (on unmount, or when the app exits).
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }
}
