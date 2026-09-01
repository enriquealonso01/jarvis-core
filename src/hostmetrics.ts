import fsp from "node:fs/promises";
import os from "node:os";
import { JARVIS_ROOT } from "./paths.js";

/**
 * Plan §39 asks the Command Center to show CPU/RAM/disk/I/O.
 *
 * The API runs in a container, so the numbers are chosen to describe the *host*
 * rather than the cgroup: `/proc/meminfo` and `/proc/loadavg` are the host's
 * under Docker's default namespacing, and the disk figure is taken from
 * `/var/lib/jarvis`, which is a host bind mount.
 */
export type HostMetrics = {
  cpu: { load1: number; load5: number; load15: number; cores: number; busy_pct: number };
  memory: { total_bytes: number; available_bytes: number; used_pct: number };
  disk: { total_bytes: number; free_bytes: number; used_pct: number } | null;
  io: { reads: number; writes: number } | null;
  uptime_seconds: number;
};

async function readMeminfo(): Promise<{ total: number; available: number } | null> {
  try {
    const text = await fsp.readFile("/proc/meminfo", "utf8");
    const get = (key: string): number => {
      const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text);
      return m ? Number(m[1]) * 1024 : 0;
    };
    const total = get("MemTotal");
    const available = get("MemAvailable");
    if (!total) return null;
    return { total, available };
  } catch {
    return null;
  }
}

/** Aggregate sectors read/written across real block devices. */
async function readDiskstats(): Promise<{ reads: number; writes: number } | null> {
  try {
    const text = await fsp.readFile("/proc/diskstats", "utf8");
    let reads = 0;
    let writes = 0;
    for (const line of text.split("\n")) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      const name = f[2];
      // Skip partitions and virtual devices; count whole disks only.
      if (/\d$/.test(name) && !/^nvme\w+n\d$/.test(name)) continue;
      if (/^(loop|ram|dm-)/.test(name)) continue;
      reads += Number(f[5]) || 0; // sectors read
      writes += Number(f[9]) || 0; // sectors written
    }
    return { reads, writes };
  } catch {
    return null;
  }
}

export async function hostMetrics(): Promise<HostMetrics> {
  const [load1, load5, load15] = os.loadavg();
  const cores = os.cpus().length || 1;

  const mem = await readMeminfo();
  const total = mem?.total ?? os.totalmem();
  const available = mem?.available ?? os.freemem();

  let disk: HostMetrics["disk"] = null;
  try {
    const st = await fsp.statfs(JARVIS_ROOT);
    const bsize = Number(st.bsize);
    const totalBytes = Number(st.blocks) * bsize;
    const freeBytes = Number(st.bfree) * bsize; // includes root-reserved blocks
    const availBytes = Number(st.bavail) * bsize; // what a normal user can take
    if (totalBytes > 0) {
      const usedBytes = totalBytes - freeBytes;
      disk = {
        total_bytes: totalBytes,
        free_bytes: availBytes,
        // df's convention: reserved blocks are neither used nor available, so
        // counting them as used reports a fuller disk than the box actually is.
        used_pct: Math.ceil((usedBytes / (usedBytes + availBytes)) * 100),
      };
    }
  } catch {
    disk = null;
  }

  return {
    cpu: {
      load1,
      load5,
      load15,
      cores,
      // Load relative to core count, which is the number that means something
      // on a shared VPS. Capped so a spike does not render past 100%.
      busy_pct: Math.min(100, Math.round((load1 / cores) * 100)),
    },
    memory: {
      total_bytes: total,
      available_bytes: available,
      used_pct: total > 0 ? Math.round(((total - available) / total) * 100) : 0,
    },
    disk,
    io: await readDiskstats(),
    uptime_seconds: Math.round(os.uptime()),
  };
}
