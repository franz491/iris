import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  renameSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path, { join } from "node:path";
import { platform } from "node:os";
import { dataFile } from "../db/sqlite.js";
import { discover } from "./discovery.js";

export type AudioBuildBackend = "cpu" | "cuda" | "vulkan" | "hip" | "metal";
const installRoot = () => dataFile("software/audio.cpp");
const llamaRoot = () => dataFile("software/llama.cpp");
const comfyRoot = () => dataFile("software/ComfyUI");
const OWNER = "iris-managed-installer-v1";
const revisions = {
  audio: () => process.env.IRIS_AUDIO_REVISION ?? process.env.IRIS_AUDIO_CPP_REVISION,
  llama: () => process.env.IRIS_LLAMA_CPP_REVISION,
  comfy: () => process.env.IRIS_COMFYUI_REVISION,
};
const origins = {
  audio: "https://github.com/0xShug0/audio.cpp",
  llama: "https://github.com/ggml-org/llama.cpp",
  comfy: "https://github.com/comfyanonymous/ComfyUI",
} as const;
const AUDIO_MAIN_API = "https://api.github.com/repos/0xShug0/audio.cpp/commits/main";
const COMFY_MAIN_API = "https://api.github.com/repos/comfyanonymous/ComfyUI/commits/main";
export function validateImmutableRevision(value: string | undefined, name: string): string {
  if (!value || !/^[0-9a-f]{40}$/i.test(value))
    throw new Error(
      `Managed ${name} installation is unavailable: set IRIS_${name.toUpperCase()}_REVISION to a 40-character immutable commit SHA.`,
    );
  return value.toLowerCase();
}
function immutableRevision(name: keyof typeof revisions) {
  return validateImmutableRevision(revisions[name](), name);
}
/** Resolve the revision selected for audio installation. The network result is
 * validated as a full SHA and bounded; callers must retain it and echo it back
 * when installing, preventing a moving `main` from becoming a TOCTOU bug. */
export async function resolveAudioRevision(fetchImpl: typeof fetch = fetch): Promise<string> {
  const configured = revisions.audio();
  if (configured) return validateImmutableRevision(configured, "audio");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(AUDIO_MAIN_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Iris-managed-installer" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Unable to resolve audio.cpp main revision (HTTP ${response.status})`);
    const text = await response.text();
    if (text.length > 64 * 1024) throw new Error("Unable to resolve audio.cpp main revision: response too large");
    const sha = (JSON.parse(text) as { sha?: unknown }).sha;
    if (typeof sha !== "string") throw new Error("Unable to resolve audio.cpp main revision: missing SHA");
    return validateImmutableRevision(sha, "audio");
  } finally {
    clearTimeout(timer);
  }
}
/** Resolve ComfyUI main to an immutable commit before installation. */
export async function resolveComfyUiRevision(fetchImpl: typeof fetch = fetch): Promise<string> {
  const configured = revisions.comfy();
  if (configured) return validateImmutableRevision(configured, "comfyui");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(COMFY_MAIN_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Iris-managed-installer" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Unable to resolve ComfyUI main revision (HTTP ${response.status})`);
    const text = await response.text();
    if (text.length > 64 * 1024) throw new Error("Unable to resolve ComfyUI main revision: response too large");
    const sha = (JSON.parse(text) as { sha?: unknown }).sha;
    if (typeof sha !== "string") throw new Error("Unable to resolve ComfyUI main revision: missing SHA");
    return validateImmutableRevision(sha, "comfyui");
  } finally {
    clearTimeout(timer);
  }
}
export function validOwnership(root: string, source: string, revision: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(root, ".iris-managed.json"), "utf8"));
    return (
      value?.owner === OWNER &&
      value?.source === source &&
      value?.revision === revision &&
      typeof value?.createdAt === "string"
    );
  } catch {
    return false;
  }
}
function markOwned(root: string, source: string, revision: string) {
  writeFileSync(
    join(root, ".iris-managed.json"),
    JSON.stringify({ owner: OWNER, source, revision, createdAt: new Date().toISOString() }, null, 2) + "\n",
    { mode: 0o600 },
  );
}
export function requireHashLockedRequirements(root: string) {
  const file = join(root, "requirements.txt");
  if (!existsSync(file)) throw new Error("ComfyUI installation is unavailable: requirements.txt is missing.");
  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length === 0 || lines.some((line) => !line.includes("--hash=sha256:")))
    throw new Error(
      "ComfyUI installation is unavailable: requirements.txt must contain sha256 hashes for every dependency.",
    );
}
const buildDirectory = (backend: AudioBuildBackend) =>
  platform() === "darwin" ? `macos-${backend}-release` : `linux-${backend}-release`;
export const audioCppBinary = (backend: AudioBuildBackend) =>
  join(installRoot(), "build", buildDirectory(backend), "bin", "audiocpp_server");
const llamaCppBinaries = () => [
  join(llamaRoot(), "build", "bin", "llama"),
  join(llamaRoot(), "build", "bin", "llama-server"),
];
export const llamaCppBinary = () => llamaCppBinaries().find(existsSync) ?? llamaCppBinaries()[1];
export const llamaCppArgumentsPrefix = (binary: string) => (binary.endsWith("/llama") ? ["serve"] : []);
export const comfyUiPython = () => join(comfyRoot(), ".venv", "bin", "python");
function executable(name: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":"))
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {}
  return false;
}
function commandSucceeds(command: string, args: string[]): boolean {
  return executable(command) && spawnSync(command, args, { stdio: "ignore" }).status === 0;
}
function vulkanBuildRequirements(): { available: boolean; missing: string[] } {
  if (platform() !== "linux") return { available: executable("glslc"), missing: executable("glslc") ? [] : ["glslc"] };
  const pkgConfig = commandSucceeds("pkg-config", ["--exists", "vulkan"]);
  const headers = existsSync("/usr/include/vulkan/vulkan.h") || existsSync("/usr/local/include/vulkan/vulkan.h");
  const loader =
    pkgConfig ||
    [
      "/usr/lib/libvulkan.so",
      "/usr/lib64/libvulkan.so",
      "/usr/lib/x86_64-linux-gnu/libvulkan.so",
      "/usr/local/lib/libvulkan.so",
    ].some(existsSync);
  const shader = executable("glslc");
  const spirvHeaders = [
    "/usr/include/spirv/unified1/spirv.hpp",
    "/usr/include/spirv-headers/spirv.hpp",
    "/usr/include/spirv.hpp",
    "/usr/local/include/spirv/unified1/spirv.hpp",
  ].some(existsSync);
  const missing = [
    ...(!headers ? ["Vulkan headers (install libvulkan-dev)"] : []),
    ...(!loader ? ["Vulkan loader development library (install libvulkan-dev)"] : []),
    ...(!shader ? ["glslc (install glslc)"] : []),
    ...(!spirvHeaders ? ["SPIR-V headers (install spirv-headers)"] : []),
  ];
  return { available: missing.length === 0, missing };
}
function availability() {
  const report = discover();
  const accel = (kind: string) => report.accelerators.find((x) => x.kind === kind)?.available ?? false;
  const common =
    executable("git") && executable("cmake") && (executable("c++") || executable("g++") || platform() === "darwin");
  const vulkanBuild = vulkanBuildRequirements();
  return {
    cpu: {
      available: common,
      reason: common
        ? "Portable and compatible; uses system CPU and RAM."
        : "Build requirements missing: install Git, CMake, and a C++ compiler (for example: git, cmake, build-essential).",
    },
    cuda: {
      available: common && accel("cuda") && executable("nvcc"),
      reason: !accel("cuda")
        ? "No usable NVIDIA GPU/driver was detected (nvidia-smi must work)."
        : !executable("nvcc")
          ? "NVIDIA runtime detected, but nvcc is missing. Install the NVIDIA CUDA Toolkit."
          : !common
            ? "CUDA detected, but Git, CMake, and a C++ compiler are required."
            : "Fastest on supported NVIDIA GPUs; uses VRAM and may compete with LLM GPU settings.",
    },
    vulkan: {
      available: common && accel("vulkan") && vulkanBuild.available,
      reason: !accel("vulkan")
        ? "No usable Vulkan device or ICD was detected."
        : !common
          ? "A Vulkan device was detected, but Git, CMake, and a C++ compiler are required."
          : !vulkanBuild.available
            ? `Vulkan runtime detected, but build requirements are missing: ${vulkanBuild.missing.join(", ")}.`
            : "Portable GPU acceleration; uses VRAM and may compete with LLM GPU settings.",
    },
    hip: {
      available:
        common &&
        accel("rocm") &&
        (executable("hipconfig") || existsSync("/opt/rocm/bin/hipconfig")) &&
        (executable("hipcc") || existsSync("/opt/rocm/bin/hipcc")),
      reason: !accel("rocm")
        ? "No usable AMD GPU/ROCm runtime was detected (/dev/kfd or /opt/rocm is required)."
        : !(executable("hipconfig") || existsSync("/opt/rocm/bin/hipconfig")) ||
            !(executable("hipcc") || existsSync("/opt/rocm/bin/hipcc"))
          ? "ROCm runtime detected, but the HIP build toolchain is missing. Install the ROCm HIP SDK (for example rocm-hip-sdk from the AMD ROCm repository)."
          : !common
            ? "ROCm/HIP detected, but Git, CMake, and a C++ compiler are required."
            : "Faster on supported AMD GPUs; uses VRAM and may compete with LLM GPU settings.",
    },
    metal: {
      available:
        common &&
        accel("metal") &&
        commandSucceeds("xcrun", ["--find", "metal"]) &&
        commandSucceeds("xcrun", ["--find", "metallib"]),
      reason: !accel("metal")
        ? "Metal builds are available only on a compatible macOS host."
        : !commandSucceeds("xcrun", ["--find", "metal"]) || !commandSucceeds("xcrun", ["--find", "metallib"])
          ? "Metal hardware detected, but the Metal compiler toolchain is missing. Install Xcode Command Line Tools and the Metal Toolchain."
          : !common
            ? "Metal detected, but Git and CMake are required."
            : "Fastest on Apple Silicon; shares unified memory with LLM workloads.",
    },
  } as const;
}
export function softwareStatus() {
  const choices = availability();
  return {
    llamaCpp: {
      source: "https://github.com/ggml-org/llama.cpp",
      root: llamaRoot(),
      installed: llamaCppBinaries().some(existsSync),
      binary: llamaCppBinary(),
      argumentsPrefix: llamaCppArgumentsPrefix(llamaCppBinary()),
      choices: Object.entries(choices)
        .filter(([x]) => x !== "metal" || platform() === "darwin")
        .map(([backend, value]) => ({ backend, ...value })),
    },
    audioCpp: {
      source: "https://github.com/0xShug0/audio.cpp",
      root: installRoot(),
      choices: Object.entries(choices).map(([backend, value]) => ({
        backend,
        ...value,
        installed: existsSync(audioCppBinary(backend as AudioBuildBackend)),
        binary: audioCppBinary(backend as AudioBuildBackend),
      })),
    },
    comfyUi: {
      source: "https://github.com/comfyanonymous/ComfyUI",
      root: comfyRoot(),
      installed: existsSync(comfyUiPython()),
      executable: comfyUiPython(),
    },
  };
}
export type InstallLog = (text: string) => void;
export type InstallOptions = { signal?: AbortSignal };
export type InstallerDeps = {
  run: (
    command: string,
    args: string[],
    cwd: string | undefined,
    onLog: InstallLog,
    options: InstallOptions,
  ) => Promise<void>;
  head?: (root: string) => string;
  exists: (path: string) => boolean;
  isSymlink?: (path: string) => boolean;
  mkdir: (path: string, options: { recursive: boolean }) => void;
  stage: (root: string) => string;
  rename: (from: string, to: string) => void;
  remove: (path: string) => void;
};
const shown = (value: string) => (/^[a-zA-Z0-9_./:=,+-]+$/.test(value) ? value : JSON.stringify(value));
function childEnvironment() {
  const keep = ["PATH", "HOME", "USER", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec", "LANG", "LC_ALL"];
  return Object.fromEntries(keep.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])));
}
export function runManaged(
  command: string,
  args: string[],
  cwd: string | undefined,
  onLog: InstallLog = () => {},
  options: InstallOptions = {},
): Promise<void> {
  onLog(`\n$ ${[command, ...args].map(shown).join(" ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let finished = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: string) => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
      escalation = setTimeout(() => {
        try {
          if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      }, 5000);
      onLog(reason + "\n");
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      if (escalation) clearTimeout(escalation);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => terminate(command + " timed out after 30 minutes"), 30 * 60 * 1000);
    const abort = () => terminate(command + " cancelled");
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const capture = (chunk: Buffer) => {
      const text = chunk.toString().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
      output = (output + text).slice(-2000);
      onLog(text.slice(0, 2000));
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      clearTimeout(timer);
      finish(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      finish(code === 0 ? undefined : new Error(command + " failed (" + code + "): " + output.slice(-1000)));
    });
  });
}
export async function prepareManaged(
  root: string,
  source: string,
  revision: string,
  onLog: InstallLog = () => {},
  options: InstallOptions = {},
  deps: Partial<InstallerDeps> = {},
): Promise<void> {
  const d = {
    run: runManaged,
    head: (p: string) => spawnSync("git", ["rev-parse", "HEAD"], { cwd: p, encoding: "utf8" }).stdout,
    exists: existsSync,
    isSymlink: (p: string) => {
      try {
        return lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    },
    mkdir: (p: string, o: { recursive: boolean }) => mkdirSync(p, o),
    stage: (p: string) => mkdtempSync(join(p + ".staging-", "")),
    rename: renameSync,
    remove: (p: string) => rmSync(p, { recursive: true, force: true }),
    ...deps,
  };
  d.mkdir(join(root, ".."), { recursive: true });
  const preExisting = d.exists(root);
  // Never let a managed install follow an attacker-created symlink into an
  // unrelated directory, even when its ownership manifest looks valid.
  if (preExisting && hasSymlinkComponent(root, d.exists, d.isSymlink))
    throw new Error("Refusing to modify symlinked managed installation: " + root);
  if (preExisting && !validOwnership(root, source, revision))
    throw new Error("Refusing to modify unowned or mismatched installation: " + root);
  const staging = preExisting ? root : d.stage(root);
  try {
    if (!preExisting) await d.run("git", ["clone", "--no-checkout", source, staging], undefined, onLog, options);
    if (!d.exists(join(staging, ".git"))) throw new Error("managed clone did not produce a git repository");
    await d.run("git", ["fetch", "--depth", "1", "origin", revision], staging, onLog, options);
    await d.run("git", ["checkout", "--detach", "--force", revision], staging, onLog, options);
    const head = d.head(staging).trim().toLowerCase();
    if (head !== revision.toLowerCase())
      throw new Error("Managed installation HEAD did not match the requested immutable revision");
    if (!preExisting) {
      if (d.exists(root)) throw new Error("managed installation destination appeared during staging");
      d.rename(staging, root);
    }
    if (!validOwnership(root, source, revision)) markOwned(root, source, revision);
  } catch (error) {
    if (!preExisting) d.remove(staging);
    throw error;
  }
}

function hasSymlinkComponent(
  input: string,
  exists: (path: string) => boolean,
  isSymlink?: (path: string) => boolean,
): boolean {
  if (!isSymlink) return false;
  const resolved = path.resolve(input);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const relative = path.relative(parsed.root, resolved);
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    if (exists(current) && isSymlink(current)) return true;
  }
  return false;
}
async function prepare(root: string, source: string, revision: string, onLog: InstallLog, options: InstallOptions) {
  return prepareManaged(root, source, revision, onLog, options);
}
export async function installAudioCpp(
  backend: AudioBuildBackend,
  onLog: InstallLog = () => {},
  options: InstallOptions & { revision?: string } = {},
) {
  const choice = availability()[backend];
  if (!choice?.available) throw new Error(choice?.reason ?? "Unsupported build backend");
  const root = installRoot();
  // The UI confirms a resolved SHA; use that exact value so a moving `main`
  // cannot change between preview and install. Direct callers still get the
  // latest configured/main revision when no confirmation is supplied.
  const revision = options.revision
    ? validateImmutableRevision(options.revision, "audio")
    : await resolveAudioRevision();
  await prepare(root, origins.audio, revision, onLog, options);
  if (platform() === "linux")
    await runManaged(
      "bash",
      [
        "scripts/build_linux.sh",
        "--backend",
        backend,
        "--model-set",
        "full",
        "--deployment-build",
        "--target",
        "audiocpp_server",
      ],
      root,
      onLog,
      options,
    );
  else if (platform() === "darwin" && backend === "metal")
    await runManaged(
      "bash",
      ["scripts/build_metal.sh", "--model-set", "full", "--deployment-build", "--target", "audiocpp_server"],
      root,
      onLog,
      options,
    );
  else if (platform() === "darwin" && backend === "cpu")
    await runManaged(
      "cmake",
      [
        "-S",
        ".",
        "-B",
        `build/${buildDirectory(backend)}`,
        "-DCMAKE_BUILD_TYPE=Release",
        "-DENGINE_ENABLE_METAL=OFF",
        "-DAUDIOCPP_MODEL_SET=full",
        "-DAUDIOCPP_DEPLOYMENT_BUILD=ON",
      ],
      root,
      onLog,
      options,
    ).then(() =>
      runManaged(
        "cmake",
        ["--build", `build/${buildDirectory(backend)}`, "--parallel", "--target", "audiocpp_server"],
        root,
        onLog,
        options,
      ),
    );
  else throw new Error("This platform/backend combination is not supported by the managed installer yet.");
  const binary = audioCppBinary(backend);
  if (!existsSync(binary)) throw new Error(`Build completed but ${binary} was not produced`);
  return { installed: true, backend, binary, status: softwareStatus() };
}

export async function installLlamaCpp(
  backend: AudioBuildBackend,
  onLog: InstallLog = () => {},
  options: InstallOptions = {},
) {
  const choice = availability()[backend];
  if (!choice?.available) throw new Error(choice?.reason ?? "Unsupported build backend");
  const root = llamaRoot();
  const revision = immutableRevision("llama");
  await prepare(root, origins.llama, revision, onLog, options);
  const flags =
    backend === "cuda"
      ? ["-DGGML_CUDA=ON"]
      : backend === "vulkan"
        ? ["-DGGML_VULKAN=ON"]
        : backend === "hip"
          ? ["-DGGML_HIP=ON"]
          : backend === "metal"
            ? ["-DGGML_METAL=ON"]
            : ["-DGGML_CUDA=OFF", "-DGGML_VULKAN=OFF", "-DGGML_METAL=OFF"];
  await runManaged("cmake", ["-S", ".", "-B", "build", "-DCMAKE_BUILD_TYPE=Release", ...flags], root, onLog, options);
  try {
    await runManaged(
      "cmake",
      ["--build", "build", "--config", "Release", "--parallel", "--target", "llama"],
      root,
      onLog,
      options,
    );
  } catch {
    await runManaged(
      "cmake",
      ["--build", "build", "--config", "Release", "--parallel", "--target", "llama-server"],
      root,
      onLog,
      options,
    );
  }
  const binary = llamaCppBinary();
  if (!existsSync(binary)) throw new Error(`Build completed but neither llama nor llama-server was produced`);
  return {
    installed: true,
    backend,
    binary,
    argumentsPrefix: llamaCppArgumentsPrefix(binary),
    status: softwareStatus(),
  };
}

export async function installComfyUi(
  onLog: InstallLog = () => {},
  options: InstallOptions & { revision?: string } = {},
) {
  if (!executable("git") || !executable("python3")) throw new Error("Git and Python 3 are required.");
  const root = comfyRoot();
  const revision = options.revision
    ? validateImmutableRevision(options.revision, "comfyui")
    : await resolveComfyUiRevision();
  await prepare(root, origins.comfy, revision, onLog, options);
  requireHashLockedRequirements(root);
  if (!existsSync(comfyUiPython())) await runManaged("python3", ["-m", "venv", ".venv"], root, onLog, options);
  await runManaged(
    comfyUiPython(),
    ["-m", "pip", "install", "--require-hashes", "-r", "requirements.txt"],
    root,
    onLog,
    options,
  );
  return { installed: true, executable: comfyUiPython(), workingDirectory: root, status: softwareStatus() };
}
