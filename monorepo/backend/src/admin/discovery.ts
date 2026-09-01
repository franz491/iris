import { arch, cpus, freemem, homedir, platform, totalmem } from "node:os";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { spawnSync } from "node:child_process";

export interface Accelerator {
  kind: "cuda" | "rocm" | "vulkan" | "metal" | "cpu";
  available: boolean;
  devices: string[];
  detail: string;
}
export interface DiscoveryReport {
  os: { platform: string; arch: string; cpus: number; cpuModel: string; memoryBytes: number; freeMemoryBytes: number };
  accelerators: Accelerator[];
  executables: string[];
  modelFiles: string[];
}
function executable(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  return null;
}
function scan(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || out.length >= 500) return out;
  try {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) scan(path, depth + 1, out);
      else if ([".gguf", ".safetensors", ".onnx"].includes(extname(entry).toLowerCase())) out.push(path);
      if (out.length >= 500) break;
    }
  } catch {}
  return out;
}
function output(command: string, args: string[]): string {
  if (!executable(command)) return "";
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : "";
}
function hasVulkanRuntime(): boolean {
  try {
    for (const base of ["/usr/share/vulkan/icd.d", "/etc/vulkan/icd.d", join(homedir(), ".local/share/vulkan/icd.d")]) {
      try {
        if (readdirSync(base).some((f) => f.endsWith(".json"))) return true;
      } catch {}
    }
  } catch {}
  return false;
}
function hasRocmRuntime(): boolean {
  try {
    accessSync("/dev/kfd", constants.F_OK);
    return true;
  } catch {}
  try {
    if (statSync("/opt/rocm").isDirectory()) return true;
  } catch {}
  return false;
}
function discoverExecutables(): string[] {
  const exact = [
    "llama",
    "llama-server",
    "llama-cli",
    "audiocpp_server",
    "ik_llama",
    "ollama",
    "python",
    "python3",
    "ffmpeg",
    "sox",
    "whisper-server",
    "whisper-cli",
    "comfyui",
    "nvidia-smi",
    "rocminfo",
    "vulkaninfo",
  ];
  const found = new Set(exact.map(executable).filter((x): x is string => Boolean(x)));
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    try {
      for (const name of readdirSync(dir)) {
        if (/(?:llama|whisper|comfy|tts|ollama)/i.test(name)) {
          const path = join(dir, name);
          try {
            accessSync(path, constants.X_OK);
            found.add(path);
          } catch {}
        }
      }
    } catch {}
  }
  return [...found].sort();
}
export function discover(): DiscoveryReport {
  const cpu = cpus();
  const nvidia = output("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]);
  const rocm = output("rocminfo", []);
  const vulkan = output("vulkaninfo", ["--summary"]);
  const metal = platform() === "darwin";
  const roots = [join(homedir(), ".cache"), ...(process.env.IRIS_MODEL_PATHS ?? "").split(delimiter).filter(Boolean)];
  return {
    os: {
      platform: platform(),
      arch: arch(),
      cpus: cpu.length,
      cpuModel: cpu[0]?.model ?? "unknown",
      memoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
    },
    accelerators: [
      { kind: "cpu", available: true, devices: [cpu[0]?.model ?? "CPU"], detail: `${cpu.length} logical CPUs` },
      {
        kind: "cuda",
        available: Boolean(nvidia),
        devices: nvidia ? nvidia.split("\n") : [],
        detail: nvidia || "nvidia-smi unavailable",
      },
      {
        kind: "rocm",
        available: Boolean(rocm) || hasRocmRuntime(),
        devices: [...rocm.matchAll(/Name:\s+([^\n]+)/g)].map((x) => x[1]).slice(0, 16),
        detail: rocm
          ? "rocminfo probe passed"
          : hasRocmRuntime()
            ? "ROCm runtime detected (rocminfo unavailable or not permitted)"
            : "no ROCm runtime found",
      },
      {
        kind: "vulkan",
        available: Boolean(vulkan) || hasVulkanRuntime(),
        devices: [...vulkan.matchAll(/deviceName\s*=\s*([^\n]+)/g)].map((x) => x[1]),
        detail: vulkan
          ? "vulkaninfo probe passed"
          : hasVulkanRuntime()
            ? "Vulkan ICDs installed (vulkaninfo unavailable)"
            : "no Vulkan loader/ICDs found",
      },
      {
        kind: "metal",
        available: metal,
        devices: metal ? ["Apple Metal"] : [],
        detail: metal ? "available on macOS" : "not macOS",
      },
    ],
    executables: discoverExecutables(),
    modelFiles: [...new Set(roots.flatMap((root) => scan(root)))].slice(0, 500),
  };
}
